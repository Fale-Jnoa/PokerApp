// A card is a two-character string from the server: rank then suit, e.g. 'Ah'.

const SUIT_GLYPH = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RANK_LABEL = { T: '10' };

export default function Card({ card, size = 'md' }) {
  // No card means face down — someone else's hand, or one not yet turned.
  if (!card) return <span className={`card is-back size-${size}`} aria-label="face down" />;

  const rank = card[0];
  const suit = card[1];
  const red = suit === 'h' || suit === 'd';

  return (
    <span
      className={`card size-${size}${red ? ' is-red' : ''}`}
      aria-label={`${RANK_LABEL[rank] ?? rank} of ${SUIT_NAME[suit] ?? suit}`}
    >
      <span className="card-rank">{RANK_LABEL[rank] ?? rank}</span>
      <span className="card-suit">{SUIT_GLYPH[suit] ?? suit}</span>
    </span>
  );
}

const SUIT_NAME = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };

// A row of cards. Pass `count` to render that many face-down backs instead.
export function CardRow({ cards, count = 0, size = 'md', className = '' }) {
  const items = cards ?? Array.from({ length: count }, () => null);
  if (items.length === 0) return null;
  return (
    <span className={`card-row ${className}`}>
      {items.map((c, i) => <Card key={`${c ?? 'back'}-${i}`} card={c} size={size} />)}
    </span>
  );
}
