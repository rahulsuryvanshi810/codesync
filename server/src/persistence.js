import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';

/**
 * Stores each room as a single Yjs state snapshot on disk.
 *
 * Writes are debounced per room (many keystrokes produce one write), and each write
 * goes to a temp file that is renamed over the original, so a crash mid-write never
 * leaves a corrupt snapshot. Swapping this class for Postgres/S3 only needs the same
 * three methods.
 */
export class FilePersistence {
  constructor(dir, { debounceMs = 2000 } = {}) {
    this.dir = dir;
    this.debounceMs = debounceMs;
    this.timers = new Map();
    this.inflight = new Map(); // name -> promise of the latest queued write
    this.seq = 0;
    this.ready = mkdir(dir, { recursive: true });
  }

  file(name) {
    return path.join(this.dir, `${name}.ybin`);
  }

  async load(name, doc) {
    await this.ready;
    try {
      Y.applyUpdate(doc, await readFile(this.file(name)));
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  schedule(name, doc) {
    if (this.timers.has(name)) return;
    this.timers.set(name, setTimeout(() => {
      this.timers.delete(name);
      this.save(name, doc).catch((err) => console.error(`persist ${name} failed:`, err.message));
    }, this.debounceMs));
  }

  /** Writes are chained per room, so two saves of one room never overlap. */
  save(name, doc) {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
    const snapshot = Y.encodeStateAsUpdate(doc); // capture now; the doc may be destroyed next
    const prev = this.inflight.get(name) ?? this.ready;
    const write = prev.catch(() => {}).then(async () => {
      const tmp = `${this.file(name)}.${process.pid}.${++this.seq}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, this.file(name));
    });
    this.inflight.set(name, write);
    write.finally(() => {
      if (this.inflight.get(name) === write) this.inflight.delete(name);
    }).catch(() => {});
    return write;
  }

  /** Waits for every queued write to finish. Call after flushing rooms on shutdown. */
  async close() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await Promise.allSettled(this.inflight.values());
  }
}

/** No-op persistence for tests and ephemeral deployments. */
export class MemoryPersistence {
  constructor() { this.snapshots = new Map(); }
  async load(name, doc) {
    const s = this.snapshots.get(name);
    if (s) Y.applyUpdate(doc, s);
    return Boolean(s);
  }
  schedule(name, doc) { this.snapshots.set(name, Y.encodeStateAsUpdate(doc)); }
  async save(name, doc) { this.snapshots.set(name, Y.encodeStateAsUpdate(doc)); }
  async close() {}
}
