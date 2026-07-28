import { useState } from 'react';

// Host-only controls: blinds, starting stacks, start a hand, award the pot.
export default function HostControls({ room, emit }) {
  const funded = room.players.filter((p) => p.stack > 0).length;
  const canStart = funded >= 2;

  return (
    <div className="card host-controls">
      <h3>Host controls</h3>

      {room.phase !== 'betting' && (
        <>
          <BlindSetter room={room} emit={emit} />
          <StackAssigner room={room} emit={emit} />
        </>
      )}

      {room.phase === 'lobby' && (
        <>
          <button
            className="primary wide"
            disabled={!canStart}
            onClick={() => emit('game:startHand', {})}
          >
            Start hand
          </button>
          {!canStart && (
            <p className="hint warn-hint">
              {funded === 0
                ? 'Nobody has chips yet — give players a stack above, then start.'
                : 'Only one player has chips. At least 2 players need a stack to start.'}
            </p>
          )}
        </>
      )}

      {room.phase === 'handComplete' && (
        <PotAwarder room={room} emit={emit} />
      )}

      {room.phase === 'betting' && <StalledTurn room={room} emit={emit} />}
    </div>
  );
}

// A player who has dropped can't act, and the hand can't move on without them.
function StalledTurn({ room, emit }) {
  const toAct = room.players.find((p) => p.id === room.currentTurnId);

  if (!toAct || toAct.connected) {
    return <p className="hint">Hand in progress. Controls return when the round ends.</p>;
  }

  return (
    <div className="stalled">
      <p className="hint warn-hint">
        <strong>{toAct.name}</strong> has dropped and the hand is waiting on them.
        Their chips are safe — they can rejoin and carry on, or you can fold for them.
      </p>
      <button className="wide" onClick={() => emit('game:foldFor', { playerId: toAct.id })}>
        Fold for {toAct.name}
      </button>
    </div>
  );
}

function BlindSetter({ room, emit }) {
  const [sb, setSb] = useState(room.smallBlind);
  const [bb, setBb] = useState(room.bigBlind);
  return (
    <div className="blind-setter">
      <span className="blind-label">Blinds</span>
      <input type="number" min={0} value={sb} onChange={(e) => setSb(e.target.value)} />
      <span className="blind-sep">/</span>
      <input type="number" min={0} value={bb} onChange={(e) => setBb(e.target.value)} />
      <button
        onClick={() => emit('room:setBlinds', { smallBlind: Number(sb), bigBlind: Number(bb) })}
      >
        Set
      </button>
    </div>
  );
}

function StackAssigner({ room, emit }) {
  const [bulk, setBulk] = useState('');

  // Setting everyone one at a time is the slowest part of getting a game going.
  const giveAll = () => {
    const value = Number(bulk);
    if (!Number.isFinite(value) || value < 0) return;
    room.players.forEach((p) => emit('room:setStack', { playerId: p.id, stack: value }));
    setBulk('');
  };

  return (
    <div className="stack-assigner">
      <p className="hint">Set each player's starting stack, then start the hand.</p>

      <div className="stack-row bulk">
        <span className="stack-name">Everyone</span>
        <input
          type="number"
          min={0}
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
          placeholder="e.g. 1000"
        />
        <button onClick={giveAll} disabled={bulk === ''}>Give all</button>
        <span className="stack-current" />
      </div>

      {room.players.map((p) => (
        <StackRow key={p.id} player={p} emit={emit} />
      ))}
    </div>
  );
}

function StackRow({ player, emit }) {
  const [value, setValue] = useState('');
  return (
    <div className="stack-row">
      <span className="stack-name">{player.name}</span>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="0"
      />
      <button
        disabled={value === ''}
        onClick={() => {
          emit('room:setStack', { playerId: player.id, stack: Number(value) });
          setValue('');
        }}
      >
        Set
      </button>
      <span className="stack-current">now: {player.stack}</span>
    </div>
  );
}

function PotAwarder({ room, emit }) {
  const pending = room.pots.filter((pot) => pot.remaining > 0);
  const settled = room.pots.filter((pot) => pot.remaining <= 0);

  return (
    <div className="pot-awarder">
      <p className="hint">
        {pending.length > 1
          ? 'Unequal all-ins split the pot. Award each one to the best hand among its eligible players.'
          : 'Betting round complete. Award the pot to the winner:'}
      </p>

      {settled.map((pot) => (
        <div key={pot.id} className="pot-block is-settled">
          <div className="pot-block-head">
            <span>{potName(pot, room.pots)}</span>
            <strong>{pot.amount}</strong>
          </div>
          <p className="hint">
            {pot.awards.map((a) => `${nameOf(room, a.playerId)} ${a.amount}`).join(' · ')}
          </p>
        </div>
      ))}

      {pending.map((pot) => (
        <PotBlock key={pot.id} pot={pot} room={room} emit={emit} />
      ))}
    </div>
  );
}

function PotBlock({ pot, room, emit }) {
  const [picked, setPicked] = useState([]);
  const [manual, setManual] = useState(false);

  const toggle = (id) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const partlyPaid = pot.remaining < pot.amount;

  return (
    <div className="pot-block">
      <div className="pot-block-head">
        <span>
          {potName(pot, room.pots)}
          {partlyPaid && <span className="pot-paid"> · {pot.amount - pot.remaining} paid out</span>}
        </span>
        <strong>{pot.remaining}</strong>
      </div>

      <div className="award-buttons">
        {pot.eligibleIds.map((id) => (
          <button
            key={id}
            className={picked.includes(id) ? 'picked' : ''}
            onClick={() => toggle(id)}
          >
            {nameOf(room, id)}
          </button>
        ))}
      </div>

      <button
        className="primary wide"
        disabled={picked.length === 0}
        onClick={() => {
          emit('game:awardPot', { potId: pot.id, winnerIds: picked });
          setPicked([]);
        }}
      >
        {picked.length > 1
          ? `Split ${pot.remaining} between ${picked.length}`
          : `Award ${pot.remaining}`}
      </button>

      {manual ? (
        <ManualAward pot={pot} room={room} emit={emit} onDone={() => setManual(false)} />
      ) : (
        <button className="link-ish wide" onClick={() => setManual(true)}>
          Split it by hand instead
        </button>
      )}
    </div>
  );
}

// The escape hatch: an exact amount to any player at the table, for a showdown
// the automatic split can't express. Award repeatedly until the pot is empty.
function ManualAward({ pot, room, emit, onDone }) {
  const [playerId, setPlayerId] = useState(room.players[0]?.id ?? '');
  const [amount, setAmount] = useState('');

  const value = Number(amount);
  const valid = amount !== '' && value > 0 && value <= pot.remaining;

  return (
    <div className="manual-award">
      <p className="hint">
        Hand out an exact amount. Any player can receive chips here, not just
        those eligible for this pot — award as many times as you need.
      </p>
      <div className="manual-row">
        <select value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
          {room.players.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          max={pot.remaining}
          value={amount}
          placeholder={`max ${pot.remaining}`}
          onChange={(e) => setAmount(e.target.value)}
        />
        <button
          disabled={!valid}
          onClick={() => {
            emit('game:awardAmount', { potId: pot.id, playerId, amount: value });
            setAmount('');
          }}
        >
          Give
        </button>
      </div>
      <div className="manual-row-actions">
        <button
          className="ghost"
          disabled={pot.remaining <= 0}
          onClick={() => {
            emit('game:awardAmount', { potId: pot.id, playerId, amount: pot.remaining });
            setAmount('');
          }}
        >
          Give the rest ({pot.remaining})
        </button>
        <button className="ghost" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function potName(pot, pots) {
  if (pots.length === 1) return 'Pot';
  return pot.id === 0 ? 'Main pot' : `Side pot ${pot.id}`;
}

function nameOf(room, id) {
  return room.players.find((p) => p.id === id)?.name ?? 'unknown';
}
