import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { MSG_AWARENESS, MSG_SYNC, awarenessMessage, syncStep1Message, updateMessage } from './protocol.js';

export const ROOM_ID = /^[A-Za-z0-9_-]{4,64}$/;

const TEMPLATES = {
  javascript: `// Welcome to CodeSync! Share this page's URL to code together in real time.
// Press Ctrl+Enter (Cmd+Enter on Mac) to run.

function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

console.log(Array.from({ length: 10 }, (_, i) => fib(i)).join(', '));
`,
};

/** Simple token bucket so one misbehaving client can't flood a room. */
class MessageBudget {
  constructor(perSec, burst) {
    this.perMs = perSec / 1000;
    this.burst = burst;
    this.tokens = burst;
    this.ts = Date.now();
  }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.ts) * this.perMs);
    this.ts = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * One collaborative document plus everyone connected to it.
 *
 * The server holds an authoritative Y.Doc per room. Clients send CRDT updates, the
 * server applies them and relays them to every other client. Because Yjs updates
 * are commutative and idempotent, clients converge to the same text regardless of
 * the order messages arrive in, so no locking or operational transform is needed.
 */
export class Room {
  constructor(name, { persistence, maxClients, onEmpty }) {
    this.name = name;
    this.persistence = persistence;
    this.maxClients = maxClients;
    this.onEmpty = onEmpty;
    this.doc = new Y.Doc({ gc: true });
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null); // the server itself has no presence
    this.conns = new Map(); // ws -> { clientIds: Set<number>, budget: MessageBudget }

    this.doc.on('update', (update, origin) => {
      this.broadcast(updateMessage(update), origin);
      this.persistence.schedule(this.name, this.doc);
    });

    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = [...added, ...updated, ...removed];
      // Remember which awareness client ids belong to which socket, so we can clear
      // that user's cursor when the socket drops without a clean goodbye.
      const conn = this.conns.get(origin);
      if (conn) {
        added.forEach((id) => conn.clientIds.add(id));
        removed.forEach((id) => conn.clientIds.delete(id));
      }
      this.broadcast(awarenessMessage(this.awareness, changed));
    });
  }

  async load() {
    const existed = await this.persistence.load(this.name, this.doc);
    if (!existed) {
      // Seed new rooms with a starter program and default language.
      this.doc.transact(() => {
        this.doc.getText('code').insert(0, TEMPLATES.javascript);
        this.doc.getMap('meta').set('language', 'javascript');
      }, 'seed');
    }
    return this;
  }

  get size() {
    return this.conns.size;
  }

  join(ws) {
    if (this.conns.size >= this.maxClients) {
      ws.close(1013, 'room is full');
      return false;
    }
    this.conns.set(ws, { clientIds: new Set(), budget: new MessageBudget(200, 600) });
    ws.on('message', (data) => this.onMessage(ws, data));
    ws.on('close', () => this.leave(ws));

    // Start the handshake: tell the client what we have; it replies with what we're
    // missing (step 2) and asks for what it's missing (its own step 1).
    this.send(ws, syncStep1Message(this.doc));
    const states = [...this.awareness.getStates().keys()];
    if (states.length) this.send(ws, awarenessMessage(this.awareness, states));
    return true;
  }

  onMessage(ws, data) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    if (!conn.budget.take()) {
      ws.close(1008, 'message rate limit exceeded');
      return;
    }
    try {
      const decoder = decoding.createDecoder(new Uint8Array(data));
      const type = decoding.readVarUint(decoder);
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        // `ws` as the transaction origin lets the update handler skip echoing the
        // change back to its author.
        syncProtocol.readSyncMessage(decoder, enc, this.doc, ws);
        if (encoding.length(enc) > 1) this.send(ws, encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), ws);
      } else {
        throw new Error(`unknown message type ${type}`);
      }
    } catch (err) {
      ws.close(1003, 'malformed message');
    }
  }

  leave(ws) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    this.conns.delete(ws);
    awarenessProtocol.removeAwarenessStates(this.awareness, [...conn.clientIds], null);
    if (this.conns.size === 0) this.onEmpty?.(this);
  }

  broadcast(message, except) {
    for (const ws of this.conns.keys()) if (ws !== except) this.send(ws, message);
  }

  send(ws, message) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(message, (err) => { if (err) ws.terminate(); });
  }

  async flush() {
    await this.persistence.save(this.name, this.doc);
  }

  destroy() {
    this.awareness.destroy();
    this.doc.destroy();
  }
}

/**
 * Creates rooms on first join, and unloads them a short while after the last user
 * leaves (the grace period makes page refreshes cheap).
 */
export class RoomManager {
  constructor({ persistence, maxClientsPerRoom = 20, unloadAfterMs = 30_000 }) {
    this.persistence = persistence;
    this.maxClientsPerRoom = maxClientsPerRoom;
    this.unloadAfterMs = unloadAfterMs;
    this.rooms = new Map(); // name -> Promise<Room>
    this.unloadTimers = new Map();
    this.flushing = new Map(); // name -> Promise of the final save of an unloaded room
  }

  get(name) {
    clearTimeout(this.unloadTimers.get(name));
    this.unloadTimers.delete(name);
    if (!this.rooms.has(name)) {
      // Store the promise, not the room, so two clients joining the same new room
      // at the same instant share one load instead of racing.
      const room = new Room(name, {
        persistence: this.persistence,
        maxClients: this.maxClientsPerRoom,
        onEmpty: (r) => this.scheduleUnload(r),
      });
      // If this room is mid-unload, wait for its final snapshot to hit disk before
      // reloading, otherwise we'd read a stale file and lose the last edits.
      const pending = this.flushing.get(name) ?? Promise.resolve();
      this.rooms.set(name, pending.then(() => room.load()));
    }
    return this.rooms.get(name);
  }

  scheduleUnload(room) {
    if (this.closed) return;
    this.unloadTimers.set(room.name, setTimeout(() => this.unload(room), this.unloadAfterMs));
  }

  async unload(room) {
    this.unloadTimers.delete(room.name);
    if (room.size > 0) return;
    this.rooms.delete(room.name);
    const done = room.flush().finally(() => {
      room.destroy();
      this.flushing.delete(room.name);
    });
    this.flushing.set(room.name, done);
    await done;
  }

  async stats() {
    const rooms = await Promise.all(this.rooms.values());
    return { rooms: rooms.length, clients: rooms.reduce((n, r) => n + r.size, 0) };
  }

  async closeAll() {
    for (const t of this.unloadTimers.values()) clearTimeout(t);
    const rooms = await Promise.all(this.rooms.values());
    this.closed = true;
    await Promise.all(rooms.map(async (r) => {
      // Detach sockets first so their close events don't schedule an unload (and a
      // save) of a room we're about to destroy.
      const sockets = [...r.conns.keys()];
      r.conns.clear();
      for (const ws of sockets) ws.close(1001, 'server shutting down');
      await r.flush();
      r.destroy();
    }));
    this.rooms.clear();
    await Promise.allSettled(this.flushing.values());
    await this.persistence.close?.();
  }
}
