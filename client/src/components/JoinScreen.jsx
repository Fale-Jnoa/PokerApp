import { useState } from 'react';
import { socket } from '../socket.js';

// Phase 2: create a room or join one with a short code + display name.
export default function JoinScreen({ onJoined, setError }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const create = () => {
    if (!name.trim()) return setError('Enter a display name first.');
    setBusy(true);
    socket.emit('room:create', { name: name.trim() }, (res) => {
      setBusy(false);
      if (res?.error) return setError(res.error);
      setError('');
      onJoined(res);
    });
  };

  const join = () => {
    if (!name.trim()) return setError('Enter a display name first.');
    if (!code.trim()) return setError('Enter a room code.');
    setBusy(true);
    socket.emit('room:join', { code: code.trim().toUpperCase(), name: name.trim() }, (res) => {
      setBusy(false);
      if (res?.error) return setError(res.error);
      setError('');
      onJoined(res);
    });
  };

  return (
    <div className="card join">
      <label>
        Display name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Alex"
          maxLength={20}
          autoFocus
        />
      </label>

      <div className="join-actions">
        <button className="primary" onClick={create} disabled={busy}>
          Create a room
        </button>
      </div>

      <div className="divider"><span>or join one</span></div>

      <label>
        Room code
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="e.g. 7KQP"
          maxLength={4}
          style={{ textTransform: 'uppercase', letterSpacing: '0.25em' }}
        />
      </label>
      <div className="join-actions">
        <button onClick={join} disabled={busy}>Join room</button>
      </div>
    </div>
  );
}
