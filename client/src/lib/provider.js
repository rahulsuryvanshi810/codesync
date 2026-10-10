import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

/**
 * Keeps a Y.Doc in sync with a CodeSync room over a WebSocket.
 *
 * - Handshake: on connect both sides exchange state vectors (sync step 1) and reply
 *   with exactly the updates the other side is missing (step 2), so a client that
 *   edited while offline uploads only its diff, not the whole document.
 * - Local edits are sent as incremental updates; remote updates are applied with this
 *   provider as the origin so they're never echoed back.
 * - Reconnects with exponential backoff and jitter. Edits made while disconnected
 *   stay in the local doc and merge on reconnect, because CRDT merges always succeed.
 *
 * Works in the browser and in Node 22+ (global WebSocket), so the server's
 * integration tests use this exact class.
 */
export class WsProvider {
  constructor(serverUrl, room, doc, { awareness, WebSocketImpl = globalThis.WebSocket, connect = true, maxBackoffMs = 10_000 } = {}) {
    this.url = `${serverUrl.replace(/\/$/, '')}/${room}`;
    this.doc = doc;
    this.ownsAwareness = !awareness;
    this.awareness = awareness ?? new awarenessProtocol.Awareness(doc);
    this.WebSocketImpl = WebSocketImpl;
    this.maxBackoffMs = maxBackoffMs;
    this.ws = null;
    this.status = 'disconnected';
    this.synced = false;
    this.attempts = 0;
    this.shouldConnect = false;
    this.listeners = new Map();

    this.onDocUpdate = (update, origin) => {
      if (origin === this) return;
      this.send(encode(MSG_SYNC, (e) => syncProtocol.writeUpdate(e, update)));
    };
    this.onAwarenessUpdate = ({ added, updated, removed }, origin) => {
      if (origin === this) return;
      const changed = [...added, ...updated, ...removed];
      this.send(encode(MSG_AWARENESS, (e) => encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed))));
    };
    doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);

    if (connect) this.connect();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  emit(event, ...args) {
    this.listeners.get(event)?.forEach((fn) => fn(...args));
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  setSynced(synced) {
    if (this.synced === synced) return;
    this.synced = synced;
    this.emit('synced', synced);
  }

  connect() {
    this.shouldConnect = true;
    if (this.ws) return;
    this.setStatus('connecting');
    const ws = new this.WebSocketImpl(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.setStatus('connected');
      this.send(encode(MSG_SYNC, (e) => syncProtocol.writeSyncStep1(e, this.doc)));
      if (this.awareness.getLocalState() !== null) {
        this.send(encode(MSG_AWARENESS, (e) => encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]))));
      }
    };

    ws.onmessage = (event) => this.handleMessage(new Uint8Array(event.data));

    ws.onclose = (event) => {
      this.ws = null;
      this.setSynced(false);
      this.setStatus('disconnected');
      // Everyone else's cursors are stale now; they'll be re-sent after reconnect.
      const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
      awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
      this.emit('close', event);
      if (!this.shouldConnect) return;
      const backoff = Math.min(this.maxBackoffMs, 250 * 2 ** this.attempts) * (0.5 + Math.random() / 2);
      this.attempts++;
      this.reconnectTimer = setTimeout(() => this.connect(), backoff);
    };

    ws.onerror = () => {}; // onclose follows and handles reconnection
  }

  handleMessage(data) {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MSG_SYNC) {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MSG_SYNC);
      const syncType = syncProtocol.readSyncMessage(decoder, reply, this.doc, this);
      if (syncType === syncProtocol.messageYjsSyncStep2) this.setSynced(true);
      if (encoding.length(reply) > 1) this.send(encoding.toUint8Array(reply));
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    }
  }

  send(message) {
    if (this.ws?.readyState === 1) this.ws.send(message);
  }

  disconnect() {
    this.shouldConnect = false;
    clearTimeout(this.reconnectTimer);
    // Tell peers we've left so our cursor disappears immediately.
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'local');
    this.ws?.close();
  }

  destroy() {
    this.disconnect();
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    if (this.ownsAwareness) this.awareness.destroy();
    this.listeners.clear();
  }
}

function encode(type, write) {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, type);
  write(e);
  return encoding.toUint8Array(e);
}
