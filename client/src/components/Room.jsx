import { useState } from 'react';
import { socket } from '../socket.js';
import TableView from './TableView.jsx';
import ActionBar from './ActionBar.jsx';
import HostControls from './HostControls.jsx';

// The table is the only view. The host gets a second screen for running the
// game, but never loses the action bar — being on it must not cost them a turn.
export default function Room({ room, code, playerId, setError, onLeave }) {
  const [screen, setScreen] = useState('table'); // 'table' | 'host'

  const me = room.players.find((p) => p.id === playerId);
  const isHost = room.hostId === playerId;
  const isMyTurn = room.currentTurnId === playerId && room.phase === 'betting';

  // Non-hosts have nowhere else to be, and a demoted host shouldn't be stranded
  // on a screen they can no longer use.
  const view = isHost ? screen : 'table';

  const emit = (event, payload) => {
    socket.emit(event, { code, ...payload }, (res) => {
      if (res?.error) setError(res.error);
      else setError('');
    });
  };

  return (
    <div className="room">
      <div className="room-bar">
        <div className="room-code">
          Room <strong>{code}</strong>
          {isHost && <span className="tag host">host</span>}
        </div>

        {isHost && (
          <div className="view-toggle">
            <button
              className={view === 'table' ? 'active' : ''}
              onClick={() => setScreen('table')}
            >
              Table
              {view !== 'table' && isMyTurn && <span className="turn-pip" aria-label="your turn" />}
            </button>
            <button
              className={view === 'host' ? 'active' : ''}
              onClick={() => setScreen('host')}
            >
              Host
              {view !== 'host' && needsHost(room) && (
                <span className="turn-pip" aria-label="needs the host" />
              )}
            </button>
          </div>
        )}

        <button className="ghost" onClick={onLeave}>Leave</button>
      </div>

      <div className="pot-strip">
        <div>
          <span className="label">Pot</span>
          <span className="value">{room.pot}</span>
        </div>
        <div>
          <span className="label">Round</span>
          <span className="value">{roundLabel(room)}</span>
        </div>
        <div>
          <span className="label">Hand</span>
          <span className="value">#{room.handNumber}</span>
        </div>
      </div>

      {room.lastHandSummary?.length > 0 && room.phase === 'lobby' && (
        <div className="banner result">
          Hand #{room.handNumber}:{' '}
          {room.lastHandSummary.map((e) => `${e.name} won ${e.amount}`).join(' · ')}
        </div>
      )}

      {view === 'table' ? (
        <TableView room={room} playerId={playerId} />
      ) : (
        <HostControls room={room} emit={emit} />
      )}

      {/* Kept on both screens so the host can always act on their turn. */}
      <ActionBar room={room} me={me} emit={emit} />
    </div>
  );
}

// Is there something on the host screen actually waiting on them?
function needsHost(room) {
  if (room.phase === 'handComplete') return true;
  if (room.phase === 'lobby') return room.players.filter((p) => p.stack > 0).length >= 2;
  const toAct = room.players.find((p) => p.id === room.currentTurnId);
  return Boolean(toAct && !toAct.connected);
}

const STREET_LABELS = {
  preflop: 'Pre-flop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
};

// While a hand is live the street is the useful thing to show; otherwise fall
// back to where the room stands.
function roundLabel(room) {
  if (room.phase === 'betting') return STREET_LABELS[room.street] ?? 'Betting';
  if (room.phase === 'handComplete') return 'Showdown';
  return 'Lobby';
}
