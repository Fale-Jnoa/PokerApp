import { CardRow } from './Card.jsx';

// Table View: an overhead felt table with every player seated around the rail.
// Seats are laid out on an ellipse and rotated so the viewer always sits at the
// bottom, the way an online poker client does it.

// Ellipse radii as a percentage of the table box: seats ride the rail, bets sit
// just inside it.
const SEAT_RX = 46;
const SEAT_RY = 44;
const BET_RX = 27;
const BET_RY = 26;

function ellipsePoint(angleDeg, rx, ry) {
  const rad = (angleDeg * Math.PI) / 180;
  return { left: `${50 + rx * Math.cos(rad)}%`, top: `${50 + ry * Math.sin(rad)}%` };
}

export default function TableView({ room, playerId }) {
  const players = room.players;
  const meIndex = Math.max(0, players.findIndex((p) => p.id === playerId));
  const n = players.length || 1;

  // 90° is the bottom of the ellipse in screen coordinates (y grows downward),
  // so offsetting by the viewer's seat puts them there and everyone else keeps
  // their real seating order going clockwise.
  const angleFor = (i) => 90 + (((i - meIndex + n) % n) * 360) / n;

  // Only worth breaking the pot out on the felt while pots are still contested.
  const openPots = (room.pots ?? []).filter((pot) => pot.winnerIds === null);

  return (
    <div className="card table-card">
      <div className="felt-wrap">
        <div className="felt">
          <div className="felt-inner" />

          <div className="felt-center">
            {room.useCards && room.communityCards.length > 0 && (
              <CardRow cards={room.communityCards} size="md" className="board" />
            )}
            <div className="pot-label">TOTAL POT</div>
            <div className="pot-amount">{room.pot}</div>
            {room.phase === 'betting' && room.highestBet > 0 && (
              <div className="pot-sub">to match: {room.highestBet}</div>
            )}
            {openPots.length > 1 && (
              <div className="pot-breakdown">
                {openPots.map((pot) => (
                  <span key={pot.id} className="pot-chip">
                    {pot.id === 0 ? 'main' : `side ${pot.id}`} {pot.amount}
                  </span>
                ))}
              </div>
            )}
          </div>

          {players.map((p, i) => {
            const angle = angleFor(i);
            const isTurn = room.currentTurnId === p.id;
            const folded = !p.inHand && room.phase !== 'lobby';
            return (
              <div key={p.id}>
                <div
                  className={[
                    'seat',
                    isTurn ? 'is-turn' : '',
                    p.id === playerId ? 'is-me' : '',
                    folded ? 'is-folded' : '',
                  ].join(' ')}
                  style={ellipsePoint(angle, SEAT_RX, SEAT_RY)}
                >
                  {p.cardCount > 0 && (
                    <CardRow
                      cards={p.holeCards}
                      count={p.cardCount}
                      size="sm"
                      className="seat-cards"
                    />
                  )}
                  <div className="seat-avatar">
                    {initials(p.name)}
                    {!p.connected && <span className="seat-offline" title="offline" />}
                  </div>
                  <div className="seat-plate">
                    <div className="seat-name">{p.name}</div>
                    <div className="seat-stack">{p.stack}</div>
                  </div>
                  <div className="seat-badges">
                    {p.id === room.dealerId && <span className="badge dealer">D</span>}
                    {p.id === room.smallBlindId && <span className="badge blind">SB</span>}
                    {p.id === room.bigBlindId && <span className="badge blind">BB</span>}
                    {p.isAllIn && <span className="badge allin">ALL-IN</span>}
                    {folded && !p.isAllIn && <span className="badge folded">FOLD</span>}
                  </div>
                </div>

                {p.currentBet > 0 && (
                  <div className="seat-bet" style={ellipsePoint(angle, BET_RX, BET_RY)}>
                    <span className="chip" />
                    {p.currentBet}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="table-totals">
        <span>Blinds: <strong>{room.smallBlind}/{room.bigBlind}</strong></span>
        <span>Hand: <strong>#{room.handNumber}</strong></span>
        <span>Players: <strong>{players.length}</strong></span>
      </div>
    </div>
  );
}

function initials(name) {
  const parts = String(name).trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
