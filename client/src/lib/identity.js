const ADJECTIVES = ['Swift', 'Clever', 'Brave', 'Calm', 'Bright', 'Lucky', 'Bold', 'Quiet', 'Witty', 'Keen'];
const ANIMALS = ['Falcon', 'Otter', 'Panda', 'Tiger', 'Koala', 'Lynx', 'Heron', 'Fox', 'Orca', 'Gecko'];
export const COLORS = ['#f97316', '#22c55e', '#06b6d4', '#a855f7', '#ec4899', '#eab308', '#ef4444', '#3b82f6'];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const KEY = 'codesync:user';

export function loadIdentity() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved?.name && saved?.color) return saved;
  } catch { /* storage unavailable or corrupt: fall through */ }
  const user = { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(COLORS) };
  saveIdentity(user);
  return user;
}

export function saveIdentity(user) {
  try { localStorage.setItem(KEY, JSON.stringify(user)); } catch { /* ignore */ }
}

export function newRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
}

export const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
