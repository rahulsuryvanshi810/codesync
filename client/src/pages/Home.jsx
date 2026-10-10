import { useState } from 'react';
import { COLORS, newRoomId } from '../lib/identity.js';

const FEATURES = [
  ['Conflict-free editing', 'Yjs CRDTs merge concurrent edits from any number of people without locks or a central sequencer.'],
  ['Live cursors', 'See where every collaborator is typing and what they have selected, in their color.'],
  ['Works offline', 'Keep typing through a dropped connection. Your edits merge automatically when you reconnect.'],
  ['Shared execution', 'Run JavaScript or Python in a sandbox. Everyone in the room sees the same output.'],
];

export default function Home({ user, onUserChange, navigate }) {
  const [code, setCode] = useState('');
  const join = (e) => {
    e.preventDefault();
    const id = code.trim().replace(/^.*\/r\//, '');
    if (/^[A-Za-z0-9_-]{4,64}$/.test(id)) navigate(`/r/${id}`);
  };

  return (
    <div className="home">
      <div className="hero">
        <div className="brand">&lt;/&gt; CodeSync</div>
        <h1>Code together, <span className="accent">in real time.</span></h1>
        <p className="lede">A collaborative editor for pair programming and mock interviews. Share a link and you're coding together. No sign-up.</p>

        <div className="card">
          <label className="field">
            <span>Your name</span>
            <input value={user.name} maxLength={32} onChange={(e) => onUserChange({ ...user, name: e.target.value || 'Anonymous' })} />
          </label>
          <div className="swatches" role="radiogroup" aria-label="Cursor color">
            {COLORS.map((c) => (
              <button
                type="button"
                key={c}
                role="radio"
                aria-checked={user.color === c}
                aria-label={c}
                className={`swatch${user.color === c ? ' selected' : ''}`}
                style={{ background: c }}
                onClick={() => onUserChange({ ...user, color: c })}
              />
            ))}
          </div>
          <button type="button" className="primary big" onClick={() => navigate(`/r/${newRoomId()}`)}>Create a room</button>
          <form className="join" onSubmit={join}>
            <input placeholder="Room code or link" value={code} onChange={(e) => setCode(e.target.value)} />
            <button type="submit" className="ghost">Join</button>
          </form>
        </div>
      </div>

      <div className="features">
        {FEATURES.map(([title, body]) => (
          <div className="feature" key={title}>
            <h3>{title}</h3>
            <p>{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
