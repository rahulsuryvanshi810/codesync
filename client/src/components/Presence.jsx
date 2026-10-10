import { initials } from '../lib/identity.js';

export default function Presence({ peers }) {
  const shown = peers.slice(0, 6);
  return (
    <div className="presence" aria-label={`${peers.length} people in this room`}>
      {shown.map((p) => (
        <span key={p.id} className="avatar" style={{ background: p.color }} title={p.self ? `${p.name} (you)` : p.name}>
          {initials(p.name)}
        </span>
      ))}
      {peers.length > shown.length && <span className="avatar more">+{peers.length - shown.length}</span>}
    </div>
  );
}
