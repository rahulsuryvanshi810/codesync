import { useCallback, useEffect, useState } from 'react';
import Home from './pages/Home.jsx';
import Room from './pages/Room.jsx';
import { loadIdentity, saveIdentity } from './lib/identity.js';

const roomFromPath = (pathname) => /^\/r\/([A-Za-z0-9_-]{4,64})\/?$/.exec(pathname)?.[1] ?? null;

export default function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [user, setUser] = useState(loadIdentity);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to) => {
    window.history.pushState(null, '', to);
    setPath(to);
  }, []);

  const updateUser = useCallback((next) => {
    setUser(next);
    saveIdentity(next);
  }, []);

  const roomId = roomFromPath(path);
  return roomId
    ? <Room key={roomId} roomId={roomId} user={user} onUserChange={updateUser} navigate={navigate} />
    : <Home user={user} onUserChange={updateUser} navigate={navigate} />;
}
