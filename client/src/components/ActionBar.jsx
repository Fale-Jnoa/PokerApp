import { useState } from 'react';

// Your betting controls, pinned under the table. The felt already shows your
// stack and what you have out in front of you, so this only carries what you
// need to decide: what it costs to stay in, and the buttons.
export default function ActionBar({ room, me, emit }) {
  const [raiseTo, setRaiseTo] = useState('');

  if (!me) return null;

  const isMyTurn = room.currentTurnId === me.id && room.phase === 'betting';
  const toCall = Math.max(0, room.highestBet - me.currentBet);
  const canCheck = toCall === 0;

  // The server is the authority on the minimum; mirror it rather than
  // re-deriving the rule here, so the UI can't offer a raise it will reject.
  const minRaise = room.minRaiseTo || room.highestBet + 1;
  const wouldBeAllIn = Number(raiseTo) - me.currentBet >= me.stack;
  const raiseIsLegal =
    raiseTo !== '' &&
    Number(raiseTo) > room.highestBet &&
    Number(raiseTo) - me.currentBet <= me.stack &&
    (Number(raiseTo) >= minRaise || wouldBeAllIn);

  const act = (action, amount) => {
    emit('game:action', { action, amount });
    setRaiseTo('');
  };

  if (room.phase !== 'betting') {
    return (
      <div className="action-bar">
        <p className="hint">
          {room.phase === 'lobby'
            ? 'Waiting for the host to start a hand.'
            : 'Hand complete — waiting for the host to award the pot.'}
        </p>
      </div>
    );
  }

  return (
    <div className={`action-bar${isMyTurn ? ' is-my-turn' : ''}`}>
      <div className="action-status">
        {isMyTurn ? (
          <strong className="your-turn">Your turn</strong>
        ) : (
          <span className="hint">
            {me.inHand && !me.isAllIn
              ? `Waiting for ${turnName(room)}…`
              : 'You are not in the action.'}
          </span>
        )}
        {toCall > 0 && me.inHand && !me.isAllIn && (
          <span className="to-call">to call {toCall}</span>
        )}
      </div>

      <div className="actions">
        <button disabled={!isMyTurn || !canCheck} onClick={() => act('check')}>
          Check
        </button>
        <button
          disabled={!isMyTurn || canCheck || me.stack === 0}
          onClick={() => act('call')}
        >
          Call {toCall > 0 ? toCall : ''}
        </button>
        <button className="danger-soft" disabled={!isMyTurn} onClick={() => act('fold')}>
          Fold
        </button>
        <button
          className="danger"
          disabled={!isMyTurn || me.stack === 0}
          onClick={() => act('allin')}
        >
          All-In ({me.stack})
        </button>
      </div>

      <div className="raise-row">
        <input
          type="number"
          min={minRaise}
          placeholder={`${room.highestBet > 0 ? 'Raise' : 'Bet'} to (min ${minRaise})`}
          value={raiseTo}
          onChange={(e) => setRaiseTo(e.target.value)}
          disabled={!isMyTurn}
        />
        <button
          disabled={!isMyTurn || !raiseIsLegal}
          onClick={() => act('raise', Number(raiseTo))}
        >
          {room.highestBet > 0 ? 'Raise' : 'Bet'}
        </button>
      </div>
    </div>
  );
}

function turnName(room) {
  const p = room.players.find((pl) => pl.id === room.currentTurnId);
  return p ? p.name : 'the next player';
}
