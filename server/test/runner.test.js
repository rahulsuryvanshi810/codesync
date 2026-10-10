import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CodeRunner } from '../src/runner.js';
import { startServer } from './helpers.js';

describe('CodeRunner', () => {
  const runner = new CodeRunner({ timeoutMs: 2000, maxOutputBytes: 1024 });

  test('runs JavaScript and captures stdout, stderr and exit code', async () => {
    const r = await runner.run({ language: 'javascript', code: 'console.log(6 * 7); console.error("warn"); process.exit(3)' });
    assert.equal(r.stdout.trim(), '42');
    assert.equal(r.stderr.trim(), 'warn');
    assert.equal(r.exitCode, 3);
    assert.equal(r.timedOut, false);
  });

  test('runs Python and passes stdin', async () => {
    const r = await runner.run({ language: 'python', code: 'name = input()\nprint(f"hi {name}")', stdin: 'rahul\n' });
    assert.equal(r.stdout.trim(), 'hi rahul');
    assert.equal(r.exitCode, 0);
  });

  test('kills infinite loops at the timeout', async () => {
    const r = await runner.run({ language: 'javascript', code: 'while (true) {}' });
    assert.equal(r.timedOut, true);
    assert.ok(r.durationMs < 4000);
  });

  test('caps output size', async () => {
    const r = await runner.run({ language: 'python', code: 'while True: print("x" * 100)' });
    assert.equal(r.truncated, true);
    assert.ok(r.stdout.length <= 1024);
  });

  test('JavaScript cannot write files or spawn processes (permission model)', async () => {
    const r = await runner.run({
      language: 'javascript',
      code: `
        const tryIt = (f) => { try { f(); return 'allowed'; } catch (e) { return e.code; } };
        console.log(tryIt(() => require('fs').writeFileSync('/tmp/pwned', 'x')));
        console.log(tryIt(() => require('child_process').execSync('whoami')));
      `,
    });
    assert.deepEqual(r.stdout.trim().split(/\r?\n/), ['ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED']);
  });

  test('does not leak server environment variables', async () => {
    process.env.CODESYNC_SECRET = 'hunter2';
    const r = await runner.run({ language: 'javascript', code: 'console.log(process.env.CODESYNC_SECRET ?? "none")' });
    delete process.env.CODESYNC_SECRET;
    assert.equal(r.stdout.trim(), 'none');
  });

  test('rejects unknown languages and oversized code', async () => {
    await assert.rejects(runner.run({ language: 'cobol', code: '' }), /unsupported language/);
    await assert.rejects(runner.run({ language: 'python', code: 'x'.repeat(200_000) }), /under/);
  });

  test('limits concurrency and rejects when the queue is full', async () => {
    const small = new CodeRunner({ maxConcurrent: 1, maxQueue: 1, timeoutMs: 2000 });
    const slow = { language: 'javascript', code: 'setTimeout(() => {}, 300)' };
    const results = await Promise.allSettled([small.run(slow), small.run(slow), small.run(slow)]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'rejected']);
    assert.equal(results[2].reason.status, 503);
  });
});

describe('HTTP API', () => {
  let srv;
  before(async () => { srv = await startServer({ runLimit: { limit: 3, windowMs: 60_000 } }); });
  after(async () => { await srv.close(); });

  const run = (body) => fetch(`${srv.http}/api/run`, { method: 'POST', body: JSON.stringify(body) });

  test('GET /api/health reports stats', async () => {
    const r = await (await fetch(`${srv.http}/api/health`)).json();
    assert.equal(r.ok, true);
    assert.deepEqual(r.languages, ['javascript', 'python']);
  });

  test('POST /api/run validates input and rate limits per client', async () => {
    const ok = await run({ language: 'javascript', code: 'console.log("ok")' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).stdout.trim(), 'ok');

    assert.equal((await run({ language: 'brainfuck', code: '+' })).status, 400);
    assert.equal((await fetch(`${srv.http}/api/run`, { method: 'POST', body: '{nope' })).status, 400);
    assert.equal((await run({ language: 'javascript', code: '1' })).status, 429);
  });

  test('unknown API routes return 404 and the client is served for other paths', async () => {
    assert.equal((await fetch(`${srv.http}/api/nope`)).status, 404);
    assert.equal((await fetch(`${srv.http}/r/some-room`)).status, 404); // no staticDir in tests
  });
});
