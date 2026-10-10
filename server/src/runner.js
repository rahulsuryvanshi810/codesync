import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class RunnerError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let permissionFlag;
/** Node's permission model flag was renamed when it became stable; detect once. */
function nodePermissionFlag() {
  if (permissionFlag === undefined) {
    const probe = spawnSync(process.execPath, ['--permission', '-e', '0']);
    permissionFlag = probe.status === 0 ? '--permission' : '--experimental-permission';
  }
  return permissionFlag;
}

const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

const LANGUAGES = {
  javascript: {
    file: 'main.js',
    image: 'node:22-alpine',
    // Permission model: the script may read only its own directory. File writes,
    // child processes, worker threads and native addons are all denied.
    local: (dir, file) => [process.execPath, [nodePermissionFlag(), `--allow-fs-read=${dir}`, '--max-old-space-size=128', file]],
    docker: ['node', '--max-old-space-size=96', '/code/main.js'],
  },
  python: {
    file: 'main.py',
    image: 'python:3.12-alpine',
    // -I: isolated mode (ignores env vars and user site-packages), -B: no .pyc files.
    local: (dir, file) => [PYTHON, ['-I', '-B', file]],
    docker: ['python', '-I', '-B', '/code/main.py'],
  },
};

/**
 * Executes untrusted snippets with hard limits on time, output size and concurrency.
 *
 * Two isolation levels:
 *   - "process" (default, zero setup): a child process with a minimal environment, a
 *     throwaway working directory and a timeout. JavaScript additionally runs under
 *     Node's permission model. Fine for a demo or trusted users.
 *   - "docker" (CODESYNC_SANDBOX=docker): each run gets a fresh container with no
 *     network, a read-only filesystem, and memory, CPU and PID limits. Use this when
 *     the editor is open to the public.
 */
export class CodeRunner {
  constructor({
    timeoutMs = 5000,
    maxOutputBytes = 64 * 1024,
    maxCodeBytes = 100 * 1024,
    maxConcurrent = 4,
    maxQueue = 16,
    sandbox = process.env.CODESYNC_SANDBOX ?? 'process',
  } = {}) {
    Object.assign(this, { timeoutMs, maxOutputBytes, maxCodeBytes, maxConcurrent, maxQueue, sandbox });
    this.active = 0;
    this.queue = [];
  }

  get languages() {
    return Object.keys(LANGUAGES);
  }

  async run({ language, code, stdin = '' }) {
    const lang = LANGUAGES[language];
    if (!lang) throw new RunnerError(`unsupported language "${language}"`, 400);
    if (typeof code !== 'string' || Buffer.byteLength(code) > this.maxCodeBytes) {
      throw new RunnerError(`code must be a string under ${this.maxCodeBytes} bytes`, 400);
    }
    await this.acquire();
    try {
      return await this.execute(lang, code, String(stdin));
    } finally {
      this.release();
    }
  }

  // Counting semaphore: at most maxConcurrent processes, a bounded wait queue, and
  // fast rejection beyond that so a burst of runs can't fork-bomb the host.
  acquire() {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new RunnerError('runner is busy, try again shortly', 503));
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }

  async execute(lang, code, stdin) {
    const dir = await mkdtemp(path.join(tmpdir(), 'codesync-'));
    const file = path.join(dir, lang.file);
    await writeFile(file, code);

    let cmd;
    let args;
    let containerName;
    if (this.sandbox === 'docker') {
      containerName = `codesync-${randomUUID()}`;
      cmd = 'docker';
      args = [
        'run', '--rm', '-i', '--name', containerName,
        '--network', 'none', '--read-only', '--tmpfs', '/tmp:size=16m',
        '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5', '--pids-limit', '64',
        '--user', '65534:65534', '--security-opt', 'no-new-privileges',
        '-v', `${dir}:/code:ro`, lang.image, ...lang.docker,
      ];
    } else {
      [cmd, args] = lang.local(dir, file);
    }

    const started = performance.now();
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
          cwd: dir,
          windowsHide: true,
          // Don't leak the server's secrets (API keys, DB URLs) into user code.
          env: {
            PATH: process.env.PATH,
            ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
            PYTHONIOENCODING: 'utf-8',
          },
        });

        const out = { stdout: '', stderr: '' };
        let bytes = 0;
        let truncated = false;
        let timedOut = false;

        const kill = () => {
          child.kill('SIGKILL');
          if (containerName) spawn('docker', ['kill', containerName], { stdio: 'ignore' }).on('error', () => {});
        };
        const timer = setTimeout(() => { timedOut = true; kill(); }, this.timeoutMs);

        const collect = (stream) => (chunk) => {
          if (truncated) return;
          const room = this.maxOutputBytes - bytes;
          const text = chunk.toString('utf8');
          if (chunk.length > room) {
            out[stream] += text.slice(0, room);
            truncated = true;
            kill();
          } else {
            out[stream] += text;
          }
          bytes += chunk.length;
        };
        child.stdout.on('data', collect('stdout'));
        child.stderr.on('data', collect('stderr'));
        child.stdin.on('error', () => {}); // process may exit before reading stdin
        child.stdin.end(stdin);

        child.on('error', (err) => {
          clearTimeout(timer);
          reject(new RunnerError(`could not start ${cmd}: ${err.message}`, 500));
        });
        child.on('close', (exitCode) => {
          clearTimeout(timer);
          resolve({
            ...out,
            exitCode,
            timedOut,
            truncated,
            durationMs: Math.round(performance.now() - started),
          });
        });
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
