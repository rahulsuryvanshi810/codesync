import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, connectClient, waitFor, synced } from './helpers.js';

describe('real-time sync', () => {
  let srv;
  const clients = [];
  const client = (room) => {
    const c = connectClient(srv.ws, room);
    clients.push(c);
    return c;
  };

  beforeEach(async () => { srv = await startServer(); });
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.provider.destroy());
    await srv.close();
  });

  test('a new room is seeded with a starter program', async () => {
    const a = client('room-seed');
    await synced(a);
    assert.match(a.text.toString(), /Welcome to CodeSync/);
    assert.equal(a.doc.getMap('meta').get('language'), 'javascript');
  });

  test('an edit by one user appears for everyone in the room', async () => {
    const a = client('room-1');
    const b = client('room-1');
    await Promise.all([synced(a), synced(b)]);

    a.text.insert(0, '// hello from A\n');
    await waitFor(() => b.text.toString().startsWith('// hello from A'), { message: 'B to see A' });
  });

  test('rooms are isolated', async () => {
    const a = client('room-a');
    const b = client('room-b');
    await Promise.all([synced(a), synced(b)]);
    a.text.insert(0, 'secret');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!b.text.toString().includes('secret'));
  });

  test('concurrent edits at the same position converge to identical text', async () => {
    const users = ['room-c', 'room-c', 'room-c'].map(client);
    await Promise.all(users.map(synced));
    users.forEach((u) => u.text.delete(0, u.text.length));
    await waitFor(() => users.every((u) => u.text.length === 0), { message: 'clear' });

    // Everyone types at position 0 at the same moment.
    users.forEach((u, i) => {
      for (let k = 0; k < 20; k++) u.text.insert(0, String.fromCharCode(65 + i));
    });

    await waitFor(() => users.every((u) => u.text.length === 60), { message: 'all 60 chars' });
    const [first, ...rest] = users.map((u) => u.text.toString());
    rest.forEach((t) => assert.equal(t, first));
    for (const ch of 'ABC') assert.equal(first.split(ch).length - 1, 20);
  });

  test('edits made while offline merge after reconnecting', async () => {
    const a = client('room-offline');
    const b = client('room-offline');
    await Promise.all([synced(a), synced(b)]);
    a.text.delete(0, a.text.length);
    await waitFor(() => b.text.length === 0);
    a.text.insert(0, 'base');
    await waitFor(() => b.text.toString() === 'base');

    a.provider.disconnect();
    await waitFor(() => a.provider.status === 'disconnected');
    a.text.insert(4, ' +offlineA'); // A edits offline
    b.text.insert(0, 'onlineB+ '); // B keeps editing online

    a.provider.connect();
    const expected = 'onlineB+ base +offlineA';
    await waitFor(() => a.text.toString() === expected && b.text.toString() === expected, { message: 'merge' });
  });

  test('presence: users see each other and cursors vanish when someone leaves', async () => {
    const a = client('room-presence');
    const b = client('room-presence');
    await Promise.all([synced(a), synced(b)]);
    a.awareness.setLocalStateField('user', { name: 'Alice', color: '#f00' });
    b.awareness.setLocalStateField('user', { name: 'Bob', color: '#00f' });

    const names = (c) => [...c.awareness.getStates().values()].map((s) => s.user?.name).filter(Boolean).sort();
    await waitFor(() => names(a).join() === 'Alice,Bob' && names(b).join() === 'Alice,Bob', { message: 'presence' });

    b.provider.destroy();
    await waitFor(() => names(a).join() === 'Alice', { message: 'Bob to leave' });
  });

  test('a late joiner receives the full document and current presence', async () => {
    const a = client('room-late');
    await synced(a);
    a.text.insert(0, 'written before you arrived\n');
    a.awareness.setLocalStateField('user', { name: 'Alice' });
    await new Promise((r) => setTimeout(r, 50));

    const b = client('room-late');
    await synced(b);
    assert.ok(b.text.toString().startsWith('written before you arrived'));
    await waitFor(() => [...b.awareness.getStates().values()].some((s) => s.user?.name === 'Alice'));
  });

  test('rejects invalid room ids at the WebSocket handshake', async () => {
    const ws = new WebSocket(`${srv.ws}/bad!id`);
    const closed = await new Promise((resolve) => {
      ws.onerror = () => resolve('error');
      ws.onopen = () => resolve('open');
    });
    assert.equal(closed, 'error');
  });

  test('enforces the per-room client cap', async () => {
    await srv.close();
    srv = await startServer({ roomOptions: { maxClientsPerRoom: 2 } });
    const a = client('room-full');
    const b = client('room-full');
    await Promise.all([synced(a), synced(b)]);
    const c = client('room-full');
    c.provider.shouldConnect = false; // don't retry in this test
    const ev = await new Promise((resolve) => c.provider.on('close', resolve));
    assert.equal(ev.code, 1013);
  });

  test('closes connections that send garbage', async () => {
    const ws = new WebSocket(`${srv.ws}/room-garbage`);
    ws.binaryType = 'arraybuffer';
    await new Promise((r) => { ws.onopen = r; });
    ws.send(new Uint8Array([99, 1, 2, 3]));
    const ev = await new Promise((r) => { ws.onclose = r; });
    assert.equal(ev.code, 1003);
  });
});

describe('persistence', () => {
  test('documents survive a server restart', async () => {
    const first = await startServer();
    const a = connectClient(first.ws, 'durable-room');
    await synced(a);
    a.text.delete(0, a.text.length);
    a.text.insert(0, 'saved to disk');
    await new Promise((r) => setTimeout(r, 50));
    a.provider.destroy();
    await first.close({ keepData: true }); // close() flushes every open room

    const second = await startServer({ dataDir: first.dataDir });
    const b = connectClient(second.ws, 'durable-room');
    await synced(b);
    assert.equal(b.text.toString(), 'saved to disk');
    b.provider.destroy();
    await second.close();
  });

  test('a room unloaded after everyone leaves reloads with its content', async () => {
    const srv = await startServer({ roomOptions: { unloadAfterMs: 20 } });
    const a = connectClient(srv.ws, 'unload-room');
    await synced(a);
    a.text.insert(0, 'still here ');
    await new Promise((r) => setTimeout(r, 50));
    a.provider.destroy();
    await waitFor(() => srv.app.rooms.rooms.size === 0, { message: 'room unload' });

    const b = connectClient(srv.ws, 'unload-room');
    await synced(b);
    assert.ok(b.text.toString().startsWith('still here '));
    b.provider.destroy();
    await srv.close();
  });
});
