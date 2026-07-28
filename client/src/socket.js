import { io } from 'socket.io-client';

// Backend URL is env-var driven so the same build works locally and in production.
// Falls back to localhost for dev when VITE_SERVER_URL is not set.
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';

export const socket = io(SERVER_URL, {
  autoConnect: true,
  transports: ['websocket', 'polling'],
});

// The seat a browser owns, kept across reloads and dropped connections. The
// token is what proves ownership to the server; losing it means losing the
// stack, so it outlives everything else in here.
const SESSION_KEY = 'poker.session';

export function saveSession({ code, token }) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ code, token }));
  } catch {
    // Private browsing with storage disabled — reconnection just won't persist.
  }
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.code && parsed?.token ? parsed : null;
  } catch {
    return null;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    
  }
}

export { SERVER_URL };
