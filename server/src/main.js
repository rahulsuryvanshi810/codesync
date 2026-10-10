import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3001);
const dataDir = process.env.DATA_DIR ?? path.join(here, '../../data');
const staticDir = process.env.STATIC_DIR ?? path.join(here, '../../client/dist');

const app = createApp({ dataDir, staticDir });
const addr = await app.listen(port);
console.log(`codesync listening on http://localhost:${addr.port} (data: ${dataDir})`);

// Flush every open room to disk before exiting so no edits are lost on deploy.
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log(`${sig} received, saving rooms...`);
    await app.close();
    process.exit(0);
  });
}
