export default function OutputPanel({ lastRun, running, stdin, onStdinChange }) {
  return (
    <section className="output">
      <header className="panel-head">
        <span>Output</span>
        {lastRun && (
          <span className="run-meta">
            {lastRun.by} · {lastRun.language} · {lastRun.durationMs} ms ·{' '}
            <span className={lastRun.exitCode === 0 ? 'ok' : 'bad'}>exit {lastRun.exitCode ?? 'killed'}</span>
          </span>
        )}
      </header>

      <div className="output-body">
        {running && <div className="running">▶ {running.by} is running the code…</div>}
        {!running && !lastRun && (
          <div className="placeholder">Press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> or click Run. Everyone in the room sees the result.</div>
        )}
        {lastRun?.error && <pre className="stderr">{lastRun.error}</pre>}
        {lastRun?.stdout && <pre className="stdout">{lastRun.stdout}</pre>}
        {lastRun?.stderr && <pre className="stderr">{lastRun.stderr}</pre>}
        {lastRun?.timedOut && <div className="badge warn">Timed out: execution was stopped after the time limit</div>}
        {lastRun?.truncated && <div className="badge warn">Output truncated</div>}
      </div>

      <label className="stdin">
        <span>stdin (shared)</span>
        <textarea value={stdin ?? ''} onChange={(e) => onStdinChange(e.target.value)} placeholder="Input for your program…" rows={3} spellCheck={false} />
      </label>
    </section>
  );
}
