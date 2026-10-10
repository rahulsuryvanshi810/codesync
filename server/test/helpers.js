import * as Y from 'yjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/index.js';
import { WsProvider } from '../../client/src/lib/provider.js';

export async function startServer(opts = {}) {
  const dataDir = opts.dataDir ?? await mkdtemp(path.join(tmpdir(), 'codesync-test-'));
  const app = createApp({ dataDir, roomOptions: { unloadAfterMs: 50, ...opts.roomOptions }, ...opts });
  const { port } = await app.listen(0, '127.0.0.1');
  return {
    app,
    dataDir,
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}/ws`,
    async close({ keepData = false } = {}) {
      await app.close();
      if (!keepData) await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** A simulated user: their own Y.Doc connected through the real client provider. */
export function connectClient(wsUrl, room) {
  const doc = new Y.Doc();
  const provider = new WsProvider(wsUrl, room, doc);
  return { doc, provider, text: doc.getText('code'), awareness: provider.awareness };
}

export function waitFor(predicate, { timeoutMs = 3000, message = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${message}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

export const synced = (c) => waitFor(() => c.provider.synced, { message: 'initial sync' });
