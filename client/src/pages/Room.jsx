import { useCallback, useState } from 'react';
import Editor from '../components/Editor.jsx';
import OutputPanel from '../components/OutputPanel.jsx';
import Presence from '../components/Presence.jsx';
import { useCollab, useYMapValue } from '../lib/useCollab.js';

const LANGUAGES = [
  { id: 'javascript', label: 'JavaScript' },
  { id: 'python', label: 'Python' },
];
const STALE_RUN_MS = 15_000;

export default function Room({ roomId, user, navigate }) {
  const { doc, provider, status, synced, peers } = useCollab(roomId, user);
  const meta = doc?.getMap('meta');
  const language = useYMapValue(meta, 'language') ?? 'javascript';
  const lastRun = useYMapValue(meta, 'lastRun');
  const runningRaw = useYMapValue(meta, 'running');
  const stdin = useYMapValue(meta, 'stdin');
  const [copied, setCopied] = useState(false);

  // If whoever clicked Run disconnected mid-run, don't block the room forever.
  const running = runningRaw && Date.now() - runningRaw.at < STALE_RUN_MS ? runningRaw : null;

  // Run state lives in the shared doc, so every collaborator sees "Alice is running…"
  // and then the same output, and two people can't trigger overlapping runs.
  const run = useCallback(async () => {
    if (!meta) return;
    const current = meta.get('running');
    if (current && Date.now() - current.at < STALE_RUN_MS) return;
    const lang = meta.get('language') ?? 'javascript';
    meta.set('running', { by: user.name, at: Date.now() });
    let result;
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: lang, code: doc.getText('code').toString(), stdin: meta.get('stdin') ?? '' }),
      });
      const body = await res.json();
      result = res.ok ? body : { error: body.error ?? `HTTP ${res.status}`, exitCode: null, durationMs: 0 };
    } catch (err) {
      result = { error: `Could not reach the server: ${err.message}`, exitCode: null, durationMs: 0 };
    }
    doc.transact(() => {
      meta.set('lastRun', { ...result, by: user.name, language: lang, at: Date.now() });
      meta.set('running', null);
    });
  }, [doc, meta, user.name]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked: the URL is visible in the address bar */ }
  };

  return (
    <div className="room">
      <header className="topbar">
        <button type="button" className="logo" onClick={() => navigate('/')}>&lt;/&gt; CodeSync</button>
        <span className="room-id" title="Room code">{roomId}</span>
        <span className={`status ${status}`} title={status}>
          <span className="dot" /> {status === 'connected' ? (synced ? 'Live' : 'Syncing…') : status === 'connecting' ? 'Connecting…' : 'Offline: edits will sync on reconnect'}
        </span>
        <div className="spacer" />
        <Presence peers={peers} />
        <select value={language} onChange={(e) => meta?.set('language', e.target.value)} aria-label="Language">
          {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
        <button type="button" className="ghost" onClick={copyLink}>{copied ? 'Copied!' : 'Invite'}</button>
        <button type="button" className="primary" onClick={run} disabled={!synced || Boolean(running)}>
          {running ? 'Running…' : 'Run ▶'}
        </button>
      </header>

      <main className="workspace">
        <section className="editor-pane">
          {synced && doc
            ? <Editor ytext={doc.getText('code')} awareness={provider.awareness} language={language} onRun={run} />
            : <div className="loading">Loading room…</div>}
        </section>
        <OutputPanel lastRun={lastRun} running={running} stdin={stdin} onStdinChange={(v) => meta?.set('stdin', v)} />
      </main>
    </div>
  );
}
