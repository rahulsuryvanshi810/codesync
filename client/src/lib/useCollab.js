import { useEffect, useState, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { WsProvider } from './provider.js';

/** Creates the room's Y.Doc and provider, and tears them down when the room changes. */
export function useCollab(roomId, user) {
  const [collab, setCollab] = useState(null);
  const [status, setStatus] = useState('connecting');
  const [synced, setSynced] = useState(false);
  const [peers, setPeers] = useState([]);

  useEffect(() => {
    const doc = new Y.Doc();
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const provider = new WsProvider(`${proto}://${window.location.host}/ws`, roomId, doc);
    const { awareness } = provider;

    const updatePeers = () => {
      setPeers([...awareness.getStates().entries()]
        .filter(([, s]) => s.user)
        .map(([id, s]) => ({ id, ...s.user, self: id === doc.clientID })));
    };
    awareness.on('change', updatePeers);
    const offs = [provider.on('status', setStatus), provider.on('synced', setSynced)];
    const onUnload = () => provider.disconnect();
    window.addEventListener('beforeunload', onUnload);
    setCollab({ doc, provider });

    return () => {
      window.removeEventListener('beforeunload', onUnload);
      awareness.off('change', updatePeers);
      offs.forEach((off) => off());
      provider.destroy();
      doc.destroy();
    };
  }, [roomId]);

  // Keep our name and color in presence in sync with local edits to the identity.
  useEffect(() => {
    // colorLight is what y-codemirror uses for selection highlights.
    collab?.provider.awareness.setLocalStateField('user', { ...user, colorLight: `${user.color}33` });
  }, [collab, user]);

  return { ...collab, status, synced, peers };
}

/** Subscribes a component to one key of a shared Y.Map. */
export function useYMapValue(ymap, key) {
  return useSyncExternalStore(
    (onChange) => {
      if (!ymap) return () => {};
      const handler = (e) => { if (e.keysChanged.has(key)) onChange(); };
      ymap.observe(handler);
      return () => ymap.unobserve(handler);
    },
    () => ymap?.get(key),
  );
}
