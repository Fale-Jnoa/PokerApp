import { useEffect, useState, useCallback, useRef } from 'react';
import { socket, saveSession, loadSession, clearSession } from './socket.js';
import JoinScreen from './components/JoinScreen.jsx';
import Room from './components/Room.jsx';

export default function App() {
  const [connected, setConnected] = useState(socket.connected);
  const [room, setRoom] = useState(null); // serialized room state from server
  const [playerId, setPlayerId] = useState(null);
  const [code, setCode] = useState(null);
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState(() => Boolean(loadSession()));

  // Read inside socket callbacks without making them depend on render state.
  const seated = useRef(false);

  const takeSeat = useCallback(({ code, playerId, token, state }) => {
    seated.current = true;
    setCode(code);
    setPlayerId(playerId);
    setRoom(state);
    setError('');
    if (token) saveSession({ code, token });
  }, []);

  useEffect(() => {
    // Socket.io hands out a brand new socket id after a drop, so the seat has
    // to be reclaimed with the token on every (re)connect — not just at boot.
    const onConnect = () => {
      setConnected(true);
      const session = loadSession();
      if (!session) {
        setRestoring(false);
        return;
      }
      socket.emit('room:rejoin', session, (res) => {
        setRestoring(false);
        if (res?.error) {
          // The room is gone or the seat was given away — start clean rather
          // than leaving the player staring at a dead table.
          clearSession();
          if (seated.current) {
            seated.current = false;
            setRoom(null);
            setCode(null);
            setPlayerId(null);
            setError(res.error);
          }
          return;
        }
        takeSeat(res);
      });
    };

    const onDisconnect = () => setConnected(false);
    const onState = (state) => setRoom(state);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('room:state', onState);
    if (socket.connected) onConnect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('room:state', onState);
    };
  }, [takeSeat]);

  const leaveRoom = useCallback(() => {
    // Leaving on purpose gives up the seat, unlike simply losing connection.
    socket.emit('room:leave', {}, () => {
      clearSession();
      window.location.reload();
    });
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>♠ Poker Chip Tracker</h1>
        <span className={`conn ${connected ? 'on' : 'off'}`}>
          {connected ? 'connected' : 'reconnecting…'}
        </span>
      </header>

      {error && <div className="banner error">{error}</div>}

      {!connected && room && (
        <div className="banner warn">
          Connection lost — your seat and chips are held. Reconnecting…
        </div>
      )}

      {restoring ? (
        <div className="card">Rejoining your table…</div>
      ) : !room || !code ? (
        <JoinScreen onJoined={takeSeat} setError={setError} />
      ) : (
        <Room
          room={room}
          code={code}
          playerId={playerId}
          setError={setError}
          onLeave={leaveRoom}
        />
      )}

      <footer className="app-footer">
        Server is the single source of truth · No database · In-memory rooms
      </footer>
    </div>
  );
}
