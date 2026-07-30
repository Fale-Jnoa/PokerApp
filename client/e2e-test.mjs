// End-to-end test over real Socket.io connections against a running server.
import { io } from 'socket.io-client';

const URL = 'http://localhost:4000';
let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('  ok  -', l); } else { fail++; console.log('  FAIL-', l); } };
const emit = (s, ev, payload) => new Promise((res) => s.emit(ev, payload, res));
const nextState = (s) => new Promise((res) => s.once('room:state', res));
// Waits for a broadcast that actually reflects the change, so an earlier
// in-flight state can't be mistaken for the one we're waiting on.
const stateWhere = (s, pred) => new Promise((res) => {
  const handler = (st) => { if (pred(st)) { s.off('room:state', handler); res(st); } };
  s.on('room:state', handler);
});

const host = io(URL, { transports: ['websocket'] });
const p2 = io(URL, { transports: ['websocket'] });
const p3 = io(URL, { transports: ['websocket'] });
await Promise.all([host, p2, p3].map((s) => new Promise((r) => s.on('connect', r))));

// Phase 1: ping/pong
const pong = await new Promise((res) => { host.once('server:pong', res); host.emit('client:ping', { t: 1 }); });
check('ping/pong works', pong && pong.received.t === 1);

// Phase 2: create + join
const created = await emit(host, 'room:create', { name: 'Alice' });
check('room created with 4-char code', created.ok && created.code.length === 4);
const code = created.code;
const hostId = created.playerId;

const j2 = await emit(p2, 'room:join', { code, name: 'Bob' });
const j3 = await emit(p3, 'room:join', { code, name: 'Cara' });
check('Bob joined', j2.ok);
check('Cara joined', j3.ok);
check('duplicate name rejected', (await emit(p2, 'room:join', { code, name: 'Alice' })).error);
check('bad code rejected', (await emit(p2, 'room:join', { code: 'ZZZZ', name: 'X' })).error);

const socketFor = { [hostId]: host, [j2.playerId]: p2, [j3.playerId]: p3 };
// Take an action and hand back the state the server broadcast for it.
const act = async (sock, action, amount) => {
  const next = stateWhere(host, () => true);
  await emit(sock, 'game:action', { code, action, amount });
  return next;
};
// Check through whatever streets remain until the hand finishes.
const checkDown = async (from) => {
  let st = from;
  for (let guard = 0; guard < 40 && st.phase === 'betting' && st.currentTurnId; guard++) {
    st = await act(socketFor[st.currentTurnId], 'check');
  }
  return st;
};

// The host sets the stack for the players
await emit(host, 'room:setStack', { code, playerId: hostId, stack: 100 });
await emit(host, 'room:setStack', { code, playerId: j2.playerId, stack: 100 });
const afterStacks = await emit(host, 'room:setStack', { code, playerId: j3.playerId, stack: 100 });
check('non-host cannot set stacks', (await emit(p2, 'room:setStack', { code, playerId: hostId, stack: 999 })).error);

// Blinds
check('non-host cannot set blinds', (await emit(p2, 'room:setBlinds', { code, smallBlind: 5, bigBlind: 10 })).error);
check('sb above bb rejected', (await emit(host, 'room:setBlinds', { code, smallBlind: 80, bigBlind: 10 })).error);
const blindState = stateWhere(host, (st) => st.bigBlind === 20);
await emit(host, 'room:setBlinds', { code, smallBlind: 10, bigBlind: 20 });
check('blinds broadcast to clients', (await blindState).smallBlind === 10);

// The betting assertions below are about the actions taken, so turn blinds off
// to keep the pot arithmetic to just those actions. Wait for the resulting
const blindsOff = stateWhere(host, (st) => st.bigBlind === 0);
await emit(host, 'room:setBlinds', { code, smallBlind: 0, bigBlind: 0 });
await blindsOff;

// Start
let statePromise = nextState(host);
const started = await emit(host, 'game:startHand', { code });
check('non-host cannot start', (await emit(p2, 'game:startHand', { code })).error === undefined ? false : true);
let state = await statePromise;
check('hand started, phase betting', state.phase === 'betting');
check('Alice to act first', state.currentTurnId === hostId);
check('button seated on Alice', state.dealerId === hostId);
check('blind seats broadcast', state.smallBlindId === j2.playerId && state.bigBlindId === j3.playerId);

// Alice raises to 30
statePromise = nextState(host);
await emit(host, 'game:action', { code, action: 'raise', amount: 30 });
state = await statePromise;
check('pot 30 after raise', state.pot === 30);
check('turn -> Bob', state.currentTurnId === j2.playerId);
check('minimum next raise is broadcast', state.minRaiseTo === 60);
check('a raise under the minimum is rejected',
  (await emit(p2, 'game:action', { code, action: 'raise', amount: 45 })).error);

// Bob out of turn attempt
check('out-of-turn rejected', (await emit(p3, 'game:action', { code, action: 'call' })).error);

// Bob calls
statePromise = nextState(host);
await emit(p2, 'game:action', { code, action: 'call' });
state = await statePromise;
check('pot 60 after Bob calls', state.pot === 60);
check('turn -> Cara', state.currentTurnId === j3.playerId);

// Cara folds — bets are square, so preflop closes and the flop opens.
statePromise = nextState(host);
await emit(p3, 'game:action', { code, action: 'fold' });
state = await statePromise;
check('preflop closes into the flop', state.street === 'flop' && state.phase === 'betting');
check('street bets reset, pot carries', state.pot === 60 && state.highestBet === 0);
check('flop action opens left of the button', state.currentTurnId === j2.playerId);

// Check it down to showdown.
state = await checkDown(state);
check('checking down ends the hand', state.phase === 'handComplete');
check('hand ended on the river', state.street === 'river');

// Award pot to Alice
statePromise = nextState(host);
await emit(host, 'game:awardPot', { code, winnerId: hostId });
state = await statePromise;
const alice = state.players.find((p) => p.id === hostId);
check('Alice stack 130 after winning pot', alice.stack === 130);
check('phase back to lobby', state.phase === 'lobby');
check('pot reset to 0', state.pot === 0);

// Side pots over the wire: three unequal all-ins build three layers.
for (const [id, stack] of [[hostId, 200], [j2.playerId, 100], [j3.playerId, 300]]) {
  await emit(host, 'room:setStack', { code, playerId: id, stack });
}
statePromise = stateWhere(host, (st) => st.phase === 'betting');
await emit(host, 'game:startHand', { code });
state = await statePromise;
check('button moved to Bob for hand 2', state.dealerId === j2.playerId);

await emit(p2, 'game:action', { code, action: 'allin' });   // Bob in for 100
await emit(p3, 'game:action', { code, action: 'allin' });   // Cara in for 300
statePromise = stateWhere(host, (st) => st.phase === 'handComplete');
await emit(host, 'game:action', { code, action: 'allin' }); // Alice short at 200
state = await statePromise;

check('three pots serialized to clients', state.pots.length === 3);
check('main pot 300, everyone eligible', state.pots[0].amount === 300 && state.pots[0].eligibleIds.length === 3);
check('side pot 200 excludes Bob', state.pots[1].amount === 200 && !state.pots[1].eligibleIds.includes(j2.playerId));
check('top pot 100 auto-awarded to Cara alone',
  state.pots[2].amount === 100 && state.pots[2].winnerIds?.[0] === j3.playerId);
check('contested pots still open', state.pots[0].winnerIds === null && state.pots[1].winnerIds === null);
check('ineligible winner rejected',
  (await emit(host, 'game:awardPot', { code, potId: 1, winnerIds: [j2.playerId] })).error);

statePromise = stateWhere(host, (st) => st.pots.length > 0 && st.pots[0].winnerIds !== null);
await emit(host, 'game:awardPot', { code, potId: 0, winnerIds: [j2.playerId] });
state = await statePromise;
check('hand stays open while a pot is unsettled', state.phase === 'handComplete');

// The manual override: an exact amount to any player, eligibility aside.
check('non-host cannot award an amount',
  (await emit(p2, 'game:awardAmount', { code, potId: 1, playerId: hostId, amount: 10 })).error);
check('cannot overdraw a pot',
  (await emit(host, 'game:awardAmount', { code, potId: 1, playerId: hostId, amount: 201 })).error);

statePromise = stateWhere(host, (st) => st.pots.some((p) => p.id === 1 && p.remaining === 150));
await emit(host, 'game:awardAmount', { code, potId: 1, playerId: j3.playerId, amount: 50 });
state = await statePromise;
check('a partial award leaves the rest in the pot', state.pots[1].remaining === 150);
check('the partial award is recorded', state.pots[1].awards[0].amount === 50);
check('the hand stays open while chips remain', state.phase === 'handComplete');
check('Bob was paid outside the eligibility rules',
  state.players.find((p) => p.id === j3.playerId).stack === 150);

statePromise = stateWhere(host, (st) => st.phase === 'lobby');
await emit(host, 'game:awardPot', { code, potId: 1, winnerIds: [hostId] });
state = await statePromise;
const stackOf = (id) => state.players.find((p) => p.id === id).stack;
check('Alice took what was left of the side pot', stackOf(hostId) === 150);
check('Bob took the main pot', stackOf(j2.playerId) === 300);
check('Cara kept her uncalled chips plus the manual 50', stackOf(j3.playerId) === 150);
check('chips conserved across the hand',
  state.players.reduce((sum, p) => sum + p.stack, 0) === 600);

// A dropped connection must hold the seat and the chips on it.
check('no tokens leak into broadcast state',
  state.players.every((p) => p.token === undefined && p.socketId === undefined));

statePromise = stateWhere(host, (st) => st.players.some((p) => p.name === 'Cara' && !p.connected));
p3.close();
state = await statePromise;
const dropped = state.players.find((p) => p.name === 'Cara');
check('dropped player keeps their seat', Boolean(dropped));
check('dropped player is flagged offline', dropped.connected === false);
check('dropped player keeps their chips', dropped.stack === 150);

// Coming back with the token restores the same seat, on a brand new socket.
const p3b = io(URL, { transports: ['websocket'] });
await new Promise((r) => p3b.on('connect', r));
check('a bad token cannot claim a seat',
  (await emit(p3b, 'room:rejoin', { code, token: 'not-a-real-token' })).error);

const rejoined = await emit(p3b, 'room:rejoin', { code, token: j3.token });
check('the right token reclaims the seat', rejoined.ok === true);
check('the player id is unchanged', rejoined.playerId === j3.playerId);
const reCara = rejoined.state.players.find((p) => p.id === j3.playerId);
check('the seat is online again', reCara.connected === true);
check('chips survived the round trip', reCara.stack === 150);

// Leaving on purpose is different — that really does give up the seat.
statePromise = stateWhere(host, (st) => !st.players.some((p) => p.name === 'Cara'));
await emit(p3b, 'room:leave', {});
state = await statePromise;
check('leaving removes the player', !state.players.some((p) => p.name === 'Cara'));

// ---- Card handling over the wire -------------------------------------------
// Fresh room: the setting is locked after the first hand in the one above.
const cHost = io(URL, { transports: ['websocket'] });
const cP2 = io(URL, { transports: ['websocket'] });
await Promise.all([cHost, cP2].map((s) => new Promise((r) => s.on('connect', r))));

const cRoom = await emit(cHost, 'room:create', { name: 'Dealer' });
const cCode = cRoom.code;
const cJoin = await emit(cP2, 'room:join', { code: cCode, name: 'Player' });
check('room defaults to chips only', cRoom.state.useCards === false);
check('non-host cannot turn dealing on',
  (await emit(cP2, 'room:setCardHandling', { code: cCode, enabled: true })).error);

const cardsOn = stateWhere(cHost, (st) => st.useCards === true);
await emit(cHost, 'room:setCardHandling', { code: cCode, enabled: true });
await cardsOn;

for (const pid of [cRoom.playerId, cJoin.playerId]) {
  await emit(cHost, 'room:setStack', { code: cCode, playerId: pid, stack: 1000 });
}

// Each player's own snapshot must carry their cards and nobody else's.
const hostDealt = stateWhere(cHost, (st) => st.phase === 'betting');
const p2Dealt = stateWhere(cP2, (st) => st.phase === 'betting');
await emit(cHost, 'game:startHand', { code: cCode });
const [hostView, p2View] = await Promise.all([hostDealt, p2Dealt]);

const hostSelf = hostView.players.find((p) => p.id === cRoom.playerId);
const hostSeesOther = hostView.players.find((p) => p.id === cJoin.playerId);
check('the host is dealt two cards', hostSelf.holeCards?.length === 2);
check('the host cannot see the other hand', hostSeesOther.holeCards === null);
check('but knows it holds two cards', hostSeesOther.cardCount === 2);

const p2Self = p2View.players.find((p) => p.id === cJoin.playerId);
const p2SeesHost = p2View.players.find((p) => p.id === cRoom.playerId);
check('the other player sees their own cards', p2Self.holeCards?.length === 2);
check('and cannot see the host hand', p2SeesHost.holeCards === null);
check('the two hands are actually different',
  p2Self.holeCards.join('') !== hostSelf.holeCards.join(''));
check('the setting is locked once a hand has run',
  (await emit(cHost, 'room:setCardHandling', { code: cCode, enabled: false })).error);

// Play it out heads-up and confirm the board and the showdown reveal.
const showdown = stateWhere(cHost, (st) => st.phase === 'handComplete');
await emit(cHost, 'game:action', { code: cCode, action: 'allin' });
await emit(cP2, 'game:action', { code: cCode, action: 'call' });
const shown = await showdown;
check('the board ran out to five cards', shown.communityCards.length === 5);
check('both hands are face up at showdown',
  shown.players.every((p) => p.holeCards?.length === 2));

cHost.close(); cP2.close();
host.close(); p2.close(); p3b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
