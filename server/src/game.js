// In-memory game state and betting logic

import { randomUUID } from 'node:crypto';
import { buildDeck, shuffle, CARDS_PER_PLAYER, maxSeatsForDeck } from './cards.js';

const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; 

function generateCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

// Players actively in the hand
function activePlayers(room) {
  return room.players.filter((p) => p.inHand);
}

// Players still actively in the hand but have not acted yet
function playersLeftToAct(room) {
  return room.players.filter((p) => p.inHand && !p.isAllIn);
}

// First index after `fromIndex` (walking seating order, wrapping) whose player
// passes `match`. Returns -1 if nobody does.
function nextIndex(room, fromIndex, match) {
  const n = room.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (fromIndex + step) % n;
    if (match(room.players[idx])) return idx;
  }
  return -1;
}

// Room Functions

function createRoom(hostSocketId, hostName) {
  const code = generateCode();
  const room = {
    code,
    hostId: null, // set to the player id of the host below
    players: [],
    pot: 0,
    highestBet: 0, 
    turnIndex: -1, 
    phase: 'lobby', // 'lobby' | 'betting' | 'handComplete'
    lastAggressorIndex: -1,
    handNumber: 0,
    // Dealer button and blinds. Tracked by player id, not index, so seats
    dealerId: null,
    smallBlindId: null,
    bigBlindId: null,
    smallBlind: 25,
    bigBlind: 50,
    lastRaiseSize: 50,
    pots: [],
    lastHandSummary: null, // [{ playerId, name, amount }]
    street: null, // 'preflop' | 'flop' | 'turn' | 'river' while a hand is live
    // Optional in-app dealing. Off by default — the app is a chip tracker for
    // a game played with real cards unless the host says otherwise, and the
    // choice is locked once the first hand is dealt.
    useCards: false,
    deck: [],
    communityCards: [],
    burnedCards: [],
  };
  rooms.set(code, room);

  const host = addPlayer(room, hostSocketId, hostName, 0, true);
  room.hostId = host.id;
  return room;
}

function getRoom(code) {
  return rooms.get(code);
}

function addPlayer(room, socketId, name, startingStack, isHost = false) {
  const player = {
    id: randomUUID(),
    token: randomUUID(),
    socketId,
    name,
    stack: Number(startingStack) || 0,
    currentBet: 0, // amount committed in the current betting round
    committed: 0, // total committed across the whole hand — what side pots are built from
    isHost,
    inHand: false,
    isAllIn: false,
    hasActed: false,
    connected: true,
    holeCards: [], // only ever sent to their owner, until showdown
  };
  room.players.push(player);
  return player;
}

function findBySocket(room, socketId) {
  return room.players.find((p) => p.socketId === socketId) ?? null;
}

// Hand the host role to someone who is actually here, so a dropped host can't
// freeze the table.
function ensureReachableHost(room) {
  const host = room.players.find((p) => p.id === room.hostId);
  if (host?.connected) return;
  const heir = room.players.find((p) => p.connected) ?? room.players[0];
  if (!heir) return;
  for (const p of room.players) p.isHost = p.id === heir.id;
  room.hostId = heir.id;
}

// A dropped connection must never cost anyone their chips, so the seat is kept
// and simply marked offline. They reclaim it with `reconnectPlayer`.
function markDisconnected(room, socketId) {
  const player = findBySocket(room, socketId);
  if (!player) return null;
  player.connected = false;
  player.socketId = null;
  ensureReachableHost(room);
  return player;
}

// A returning browser proves it owns a seat with the token it was issued.
function reconnectPlayer(room, token, socketId) {
  const player = room.players.find((p) => p.token === token);
  if (!player) return { error: 'That seat is no longer in this room.' };
  player.connected = true;
  player.socketId = socketId;
  ensureReachableHost(room);
  return { ok: true, player };
}

// Function to check if no one is currently active in the room 
function isAbandoned(room) {
  return room.players.every((p) => !p.connected);
}

// A player leaving
function removePlayer(room, playerId) {
  const idx = room.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return;
  room.players.splice(idx, 1);

  // Room is closed if empty
  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }

  ensureReachableHost(room);

  // Keep turnIndex sane if a mid-hand player dropped.
  if (room.turnIndex >= room.players.length) {
    room.turnIndex = 0;
  }

  // Someone leaving while pots are still being awarded must not strand chips.
  if (room.phase === 'handComplete' && room.pots.length > 0) {
    for (const pot of room.pots) {
      if (pot.remaining <= 0) continue;
      pot.eligibleIds = pot.eligibleIds.filter((id) => id !== playerId);
      // Everyone who could win this pot has gone so now goes to the next eligible player
      if (pot.eligibleIds.length === 0) {
        const fallback = room.players.filter((p) => p.inHand);
        pot.eligibleIds = (fallback.length > 0 ? fallback : room.players).map((p) => p.id);
      }
      if (pot.eligibleIds.length === 1) payout(room, pot, pot.eligibleIds);
    }
    settleIfDone(room);
  }
}

// Betting Functions

function commitChips(room, player, amount) {
  const pay = Math.min(amount, player.stack);
  if (pay <= 0) return 0;
  player.stack -= pay;
  player.currentBet += pay;
  player.committed += pay;
  room.pot += pay;
  if (player.stack === 0) player.isAllIn = true;
  return pay;
}

const STREETS = ['preflop', 'flop', 'turn', 'river'];

// ---- Dealing (only when the host has turned cards on) -----------------------

const COMMUNITY_COUNT = { flop: 3, turn: 1, river: 1 };

// The host opts in before the first hand and is then locked out — switching
// mid-session would change what a hand means partway through a game.
function setCardHandling(room, enabled) {
  if (room.phase !== 'lobby') {
    return { error: 'Cannot change card dealing mid-hand.' };
  }
  if (room.handNumber > 0) {
    return { error: 'Card dealing can only be set before the first hand.' };
  }
  const want = Boolean(enabled);
  if (want && room.players.length > maxSeatsForDeck()) {
    return { error: `A single deck seats at most ${maxSeatsForDeck()} players.` };
  }
  room.useCards = want;
  return { ok: true };
}

// Two cards each, one at a time, starting left of the button — the order a
// real dealer uses.
function dealHoleCards(room) {
  const dealerIdx = room.players.findIndex((p) => p.id === room.dealerId);
  const n = room.players.length;
  const receivers = [];
  for (let step = 1; step <= n; step++) {
    const p = room.players[(dealerIdx + step) % n];
    if (p.inHand) receivers.push(p);
  }
  for (let round = 0; round < CARDS_PER_PLAYER; round++) {
    for (const p of receivers) p.holeCards.push(room.deck.pop());
  }
}

// Burn one, then turn the street's cards, as at a real table.
function dealStreet(room, street) {
  if (!room.useCards) return;
  const count = COMMUNITY_COUNT[street];
  if (!count) return;
  room.burnedCards.push(room.deck.pop());
  for (let i = 0; i < count; i++) room.communityCards.push(room.deck.pop());
}

// Betting can end before the board is complete — everyone all-in, say. A real
// showdown still needs the rest of the board turned so the winner can be read.
function runOutBoard(room) {
  let next = STREETS[STREETS.indexOf(room.street) + 1];
  while (next) {
    dealStreet(room, next);
    room.street = next;
    next = STREETS[STREETS.indexOf(next) + 1];
  }
}

// Open a new betting round. Bets from the previous street are already in the
// pot, so what resets is the per-round state: what each player owes, and
// whether they have acted yet
function startStreet(room, street) {
  room.street = street;
  dealStreet(room, street);
  room.highestBet = 0;
  room.lastRaiseSize = room.smallBlind; // a fresh street opens at the small blind
  for (const p of room.players) {
    p.currentBet = 0;
    p.hasActed = false;
  }
  // Postflop the action opens with the first live player left of the button
  const dealerIdx = room.players.findIndex((p) => p.id === room.dealerId);
  const firstIdx = nextIndex(room, dealerIdx, (p) => p.inHand && !p.isAllIn);
  room.turnIndex = firstIdx;
  room.lastAggressorIndex = firstIdx;
}

function closeStreet(room) {
  const next = STREETS[STREETS.indexOf(room.street) + 1];
  
  if (!next || playersLeftToAct(room).length <= 1) {
    completeHand(room);
    return;
  }
  startStreet(room, next);
}

// The smallest legal raise-to on this street: the current bet plus the size of
// the last full raise. With no bet yet — every street after preflop — that
// makes the big blind the minimum opening bet.
function minRaiseTo(room) {
  return room.highestBet + Math.max(room.lastRaiseSize, 1);
}

// Put `additional` chips in as a raise: move the bet up, and reopen the action
// for everyone who had already acted. A raise only becomes the new benchmark
// for later raises if it was a full one — an all-in for less doesn't count.
function applyRaise(room, player, additional) {
  const prevHighest = room.highestBet;
  commitChips(room, player, additional);
  room.highestBet = player.currentBet;

  const increment = room.highestBet - prevHighest;
  if (increment >= room.lastRaiseSize) room.lastRaiseSize = increment;

  for (const p of room.players) {
    if (p.id !== player.id && p.inHand && !p.isAllIn) p.hasActed = false;
  }
  room.lastAggressorIndex = room.turnIndex;
}

function startHand(room) {
  const eligible = room.players.filter((p) => p.stack > 0);
  if (eligible.length < 2) {
    return { error: 'Need at least 2 players with chips to start a hand.' };
  }

  room.pot = 0;
  room.highestBet = 0;
  room.lastRaiseSize = room.bigBlind;
  room.phase = 'betting';
  room.street = 'preflop';
  room.handNumber += 1;

  room.pots = [];
  room.lastHandSummary = null;

  for (const p of room.players) {
    p.currentBet = 0;
    p.committed = 0;
    p.hasActed = false;
    p.isAllIn = false;
    p.inHand = p.stack > 0; // players with no chips sit out
    p.holeCards = [];
  }

  room.communityCards = [];
  room.burnedCards = [];
  room.deck = room.useCards ? shuffle(buildDeck()) : [];

  const inHand = (p) => p.inHand;
  const canAct = (p) => p.inHand && !p.isAllIn;

  // Move the button one seat along, or seat it for the very first hand.
  const prevDealerIdx = room.players.findIndex((p) => p.id === room.dealerId);
  const dealerIdx = prevDealerIdx === -1
    ? room.players.findIndex(inHand)
    : nextIndex(room, prevDealerIdx, inHand);
  room.dealerId = room.players[dealerIdx].id;

  // Heads-up, the button posts the small blind. Otherwise the blinds sit to
  // the left of it.
  const headsUp = eligible.length === 2;
  const sbIdx = headsUp ? dealerIdx : nextIndex(room, dealerIdx, inHand);
  const bbIdx = nextIndex(room, sbIdx, inHand);
  room.smallBlindId = room.players[sbIdx].id;
  room.bigBlindId = room.players[bbIdx].id;

  // Cards go out once the button is seated, since dealing starts to its left.
  if (room.useCards) dealHoleCards(room);

  commitChips(room, room.players[sbIdx], room.smallBlind);
  commitChips(room, room.players[bbIdx], room.bigBlind);
  // Others owe the full big blind even if a blind poster was too short to cover it.
  room.highestBet = Math.max(room.bigBlind, ...room.players.map((p) => p.currentBet));

  // Preflop action opens to the left of the big blind — heads-up, that's the
  // button. Blind posters keep hasActed=false, which gives the big blind its
  // option to raise when the action comes back around.
  const firstIdx = headsUp && canAct(room.players[dealerIdx])
    ? dealerIdx
    : nextIndex(room, bbIdx, canAct);

  room.lastAggressorIndex = bbIdx;
  if (firstIdx === -1) {
    // Everyone is all-in from the blinds alone — nothing left to bet.
    completeHand(room);
  } else {
    room.turnIndex = firstIdx;
  }
  return { ok: true };
}

// Advance to the next player who still needs to act. Returns true if the round
// continues, false if the betting round is complete.
function advanceTurn(room) {
  const n = room.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (room.turnIndex + step) % n;
    const p = room.players[idx];
    if (!p.inHand || p.isAllIn) continue;
    // Round is over once we return to a player who has already acted and is
    // square with the highest bet.
    if (p.hasActed && p.currentBet === room.highestBet) continue;
    room.turnIndex = idx;
    return true;
  }
  return false;
}

function isRoundComplete(room) {
  const toAct = playersLeftToAct(room);
  // Everyone still able to act has acted and matched the highest bet.
  return toAct.every((p) => p.hasActed && p.currentBet === room.highestBet);
}

// ---- Side pots -------------------------------------------------------------

// Split what everyone committed into a main pot plus one side pot per all-in
// level. A player can only win chips they were able to cover, so each layer is
// capped at the level that created it and is contested only by the players who
// reached that level. Chips from players who folded still fill the layers they
// paid into — they just aren't eligible to win any of them.
// `remaining` is what still has to be handed out — a pot can be paid out in
// pieces, so it is the authority on whether the pot is settled. `awards` is the
// running record of who has taken what from it.
function makePot(id, amount, eligibleIds) {
  return { id, amount, remaining: amount, eligibleIds, awards: [] };
}

function buildPots(room) {
  const contributors = room.players.filter((p) => p.committed > 0);
  if (contributors.length === 0) return [];

  // Layer boundaries come from the live players: money nobody left in the hand
  // could match isn't contestable, it belongs back with whoever staked it.
  const levels = [...new Set(
    room.players.filter((p) => p.inHand && p.committed > 0).map((p) => p.committed),
  )].sort((a, b) => a - b);

  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const p of contributors) {
      amount += Math.min(Math.max(p.committed - prev, 0), level - prev);
    }
    if (amount > 0) {
      pots.push(makePot(
        pots.length,
        amount,
        room.players.filter((p) => p.inHand && p.committed >= level).map((p) => p.id),
      ));
    }
    prev = level;
  }

  // Everyone still in the hand checked it down without betting — one pot, all of them.
  if (pots.length === 0) {
    const total = contributors.reduce((sum, p) => sum + p.committed, 0);
    if (total > 0) {
      pots.push(makePot(0, total, room.players.filter((p) => p.inHand).map((p) => p.id)));
    }
    return pots;
  }

  // Anything staked above the top live level is dead money from a player who
  // over-committed and then folded. It rides along with the last pot.
  const leftover = contributors.reduce((sum, p) => sum + Math.max(p.committed - prev, 0), 0);
  if (leftover > 0) {
    const last = pots[pots.length - 1];
    last.amount += leftover;
    last.remaining += leftover;
  }

  return pots;
}

// Winners ordered by seat starting left of the button — the convention for
// handing out chips that don't divide evenly in a split pot.
function seatsFromButton(room, ids) {
  const dealerIdx = room.players.findIndex((p) => p.id === room.dealerId);
  const start = dealerIdx === -1 ? -1 : dealerIdx;
  const n = room.players.length;
  const ordered = [];
  for (let step = 1; step <= n; step++) {
    const p = room.players[(start + step + n) % n];
    if (ids.includes(p.id)) ordered.push(p);
  }
  return ordered;
}

// The one place chips leave a pot, keeping the pot's balance, the room total
// and the hand summary in step. Never pays out more than the pot has left.
function grantFromPot(room, pot, player, amount) {
  const take = Math.min(Math.floor(amount), pot.remaining);
  if (take <= 0) return 0;

  pot.remaining -= take;
  player.stack += take;
  room.pot = Math.max(0, room.pot - take);

  const entry = pot.awards.find((a) => a.playerId === player.id);
  if (entry) entry.amount += take;
  else pot.awards.push({ playerId: player.id, amount: take });

  recordPayout(room, player, take);
  return take;
}

// Pay whatever is left in a pot out to its winners, splitting evenly and
// pushing the odd chips to the earliest seat left of the button.
function payout(room, pot, winnerIds) {
  const winners = seatsFromButton(room, winnerIds);
  if (winners.length === 0 || pot.remaining <= 0) return;

  const share = Math.floor(pot.remaining / winners.length);
  let remainder = pot.remaining - share * winners.length;

  for (const w of winners) {
    let take = share;
    if (remainder > 0) { take += 1; remainder -= 1; }
    grantFromPot(room, pot, w, take);
  }
}

function recordPayout(room, player, amount) {
  if (amount <= 0) return;
  if (!room.lastHandSummary) room.lastHandSummary = [];
  const existing = room.lastHandSummary.find((e) => e.playerId === player.id);
  if (existing) existing.amount += amount;
  else room.lastHandSummary.push({ playerId: player.id, name: player.name, amount });
}

// Close out the betting and work out how the pot divides.
function completeHand(room) {
  room.phase = 'handComplete';
  room.turnIndex = -1;
  // A contested showdown needs the whole board, even when the betting stopped
  // early. A hand everyone folded out of never gets there.
  if (room.useCards && activePlayers(room).length > 1) runOutBoard(room);
  room.pots = buildPots(room);

  // A pot with a single eligible player has nothing to decide — an uncalled
  // raise coming back, or everyone folding. Settle it now.
  for (const pot of room.pots) {
    if (pot.eligibleIds.length === 1) payout(room, pot, pot.eligibleIds);
  }
  settleIfDone(room);
}

// Once every pot is empty the hand is over and the table returns to lobby.
function settleIfDone(room) {
  if (room.pots.length > 0 && room.pots.some((p) => p.remaining > 0)) return false;
  room.pot = 0;
  room.highestBet = 0;
  room.turnIndex = -1;
  room.phase = 'lobby';
  room.street = null;
  room.pots = [];
  // The button stays put so it can advance on the next hand; the blind badges
  // belong to the hand that just ended.
  room.smallBlindId = null;
  room.bigBlindId = null;
  room.communityCards = [];
  room.burnedCards = [];
  room.deck = [];
  for (const p of room.players) {
    p.currentBet = 0;
    p.committed = 0;
    p.hasActed = false;
    p.isAllIn = false;
    p.inHand = false;
    p.holeCards = [];
  }
  return true;
}

// Apply an action from `playerId`. Returns { error } or { ok: true }.
function applyAction(room, playerId, action, rawAmount) {
  if (room.phase !== 'betting') {
    return { error: 'No betting round is in progress.' };
  }
  const player = room.players[room.turnIndex];
  if (!player || player.id !== playerId) {
    return { error: 'It is not your turn.' };
  }
  if (!player.inHand || player.isAllIn) {
    return { error: 'You cannot act right now.' };
  }

  const toCall = room.highestBet - player.currentBet;

  switch (action) {
    case 'fold': {
      player.inHand = false;
      player.hasActed = true;
      break;
    }

    case 'check': {
      if (toCall > 0) return { error: 'Cannot check — there is a bet to call.' };
      player.hasActed = true;
      break;
    }

    case 'call': {
      if (toCall <= 0) return { error: 'Nothing to call — you may check instead.' };
      commitChips(room, player, toCall);
      player.hasActed = true;
      break;
    }

    case 'raise': {
      const raiseTo = Number(rawAmount);
      if (!Number.isFinite(raiseTo) || raiseTo <= room.highestBet) {
        return { error: 'Raise must be higher than the current bet.' };
      }
      const additional = raiseTo - player.currentBet;
      if (additional > player.stack) {
        return { error: 'Not enough chips for that raise. Use All-In instead.' };
      }
      // Short of the minimum is only allowed when it puts you all-in.
      const min = minRaiseTo(room);
      if (raiseTo < min && additional < player.stack) {
        return { error: `Raise to at least ${min}.` };
      }
      applyRaise(room, player, additional);
      player.hasActed = true;
      break;
    }

    case 'allin': {
      if (player.stack <= 0) return { error: 'You have no chips to push.' };
      // An all-in that clears the current bet counts as a raise; one that
      // doesn't is just a short call and leaves the bet where it was.
      if (player.currentBet + player.stack > room.highestBet) {
        applyRaise(room, player, player.stack);
      } else {
        commitChips(room, player, player.stack);
      }
      player.hasActed = true;
      break;
    }

    default:
      return { error: `Unknown action: ${action}` };
  }

  // If everyone but one player has folded, the hand is over immediately.
  if (activePlayers(room).length <= 1) {
    completeHand(room);
    return { ok: true };
  }

  // Move the turn along, or close the street out.
  if (isRoundComplete(room) || playersLeftToAct(room).length === 0) {
    closeStreet(room);
  } else {
    advanceTurn(room);
  }
  return { ok: true };
}

// Host awards one pot to one or more winners (several means the hand was
// chopped). Pots are awarded individually; the table returns to the lobby once
// the last one is settled. `potId` defaults to the next unsettled pot, which is
// the whole story in the common case of a single pot.
function awardPot(room, winnerIds, potId) {
  if (room.phase !== 'handComplete') {
    return { error: 'No pot is waiting to be awarded.' };
  }

  const pot = findOpenPot(room, potId);
  if (!pot) return { error: 'Pot not found.' };
  if (pot.remaining <= 0) return { error: 'That pot has already been awarded.' };

  const ids = [...new Set([].concat(winnerIds ?? []))];
  if (ids.length === 0) return { error: 'Pick at least one winner.' };
  for (const id of ids) {
    if (!pot.eligibleIds.includes(id)) {
      return { error: 'That player is not eligible for this pot.' };
    }
    if (!room.players.some((p) => p.id === id)) return { error: 'Winner not found.' };
  }

  payout(room, pot, ids);
  settleIfDone(room);
  return { ok: true };
}

function findOpenPot(room, potId) {
  return potId == null
    ? room.pots.find((p) => p.remaining > 0)
    : room.pots.find((p) => p.id === potId);
}

// Manual override for showdowns the automatic split can't express — a chop on
// terms the app doesn't model, or fixing a misread board. The host names an
// exact number of chips and any player at the table, eligibility aside, so this
// deliberately skips the checks `awardPot` applies. The one hard limit is that
// a pot can never pay out more than it holds.
function awardAmount(room, playerId, amount, potId) {
  if (room.phase !== 'handComplete') {
    return { error: 'No pot is waiting to be awarded.' };
  }
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return { error: 'Player not found.' };

  const value = Math.floor(Number(amount));
  if (!Number.isFinite(value) || value <= 0) {
    return { error: 'Enter an amount above zero.' };
  }

  const pot = findOpenPot(room, potId);
  if (!pot) return { error: 'Pot not found.' };
  if (pot.remaining <= 0) return { error: 'That pot has already been paid out.' };
  if (value > pot.remaining) {
    return { error: `That pot only has ${pot.remaining} left to give.` };
  }

  grantFromPot(room, pot, player, value);
  settleIfDone(room);
  return { ok: true };
}

// An offline player whose turn it is would stall the table indefinitely, so the
// host can fold on their behalf. Deliberately limited to players who are
// actually gone — anyone connected acts for themselves.
function foldFor(room, playerId) {
  if (room.phase !== 'betting') return { error: 'No hand is in progress.' };
  const player = room.players[room.turnIndex];
  if (!player || player.id !== playerId) {
    return { error: 'That player is not the one to act.' };
  }
  if (player.connected) {
    return { error: 'That player is still connected — let them act.' };
  }
  return applyAction(room, playerId, 'fold');
}

// Host sets the blind levels (lobby only — changing them mid-hand would move
// the goalposts on bets already committed).
function setBlinds(room, smallBlind, bigBlind) {
  if (room.phase === 'betting') {
    return { error: 'Cannot change blinds mid-hand.' };
  }
  const sb = Math.floor(Number(smallBlind));
  const bb = Math.floor(Number(bigBlind));
  if (!Number.isFinite(sb) || !Number.isFinite(bb) || sb < 0 || bb < 0) {
    return { error: 'Blinds must be zero or a positive number.' };
  }
  if (sb > bb) {
    return { error: 'The small blind cannot exceed the big blind.' };
  }
  room.smallBlind = sb;
  room.bigBlind = bb;
  return { ok: true };
}

// The snapshot sent to a client after each change. It is built *per viewer*
// because hole cards are private: `viewerId` gets their own cards, and at
// showdown everyone sees the cards of players still in the hand. A hand that
// folded is never exposed. Pass no viewer for a strictly public view.
function serializeRoom(room, viewerId = null) {
  const showdown = room.phase === 'handComplete';
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    street: room.street,
    pot: room.pot,
    highestBet: room.highestBet,
    handNumber: room.handNumber,
    dealerId: room.dealerId,
    smallBlindId: room.smallBlindId,
    bigBlindId: room.bigBlindId,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    // Sent so the client validates against exactly what the server enforces.
    minRaiseTo: room.phase === 'betting' ? minRaiseTo(room) : 0,
    pots: room.pots.map((p) => ({
      id: p.id,
      amount: p.amount,
      remaining: p.remaining,
      eligibleIds: [...p.eligibleIds],
      awards: p.awards.map((a) => ({ ...a })),
      // Everyone who has taken a share, or null if the pot is untouched.
      winnerIds: p.awards.length ? [...new Set(p.awards.map((a) => a.playerId))] : null,
    })),
    lastHandSummary: room.lastHandSummary ? room.lastHandSummary.map((e) => ({ ...e })) : null,
    currentTurnId: room.turnIndex >= 0 ? room.players[room.turnIndex]?.id ?? null : null,
    useCards: room.useCards,
    communityCards: [...room.communityCards],
    players: room.players.map((p) => {
      // Your own cards are always yours to see. At showdown the hands still in
      // play are turned face up; everything else stays face down.
      const visible = (viewerId !== null && p.id === viewerId) || (showdown && p.inHand);
      return {
        id: p.id,
        name: p.name,
        stack: p.stack,
        currentBet: p.currentBet,
        committed: p.committed,
        isHost: p.isHost,
        inHand: p.inHand,
        isAllIn: p.isAllIn,
        hasActed: p.hasActed,
        connected: p.connected,
        cardCount: p.holeCards.length,
        holeCards: visible ? [...p.holeCards] : null,
      };
    }),
  };
}

export {
  rooms,
  createRoom,
  getRoom,
  addPlayer,
  removePlayer,
  startHand,
  applyAction,
  awardPot,
  awardAmount,
  setBlinds,
  setCardHandling,
  buildPots,
  minRaiseTo,
  findBySocket,
  markDisconnected,
  reconnectPlayer,
  isAbandoned,
  foldFor,
  serializeRoom,
};
