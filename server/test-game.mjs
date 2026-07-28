// Quick sanity test of the betting engine (not a formal test suite).
import {
  createRoom, addPlayer, removePlayer, startHand, applyAction, awardPot, awardAmount,
  setBlinds, buildPots, minRaiseTo, findBySocket, markDisconnected, reconnectPlayer,
  isAbandoned, foldFor, serializeRoom,
} from './src/game.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  ok  -', label); }
  else { fail++; console.log('  FAIL-', label); }
}

// Player ids are server-generated and opaque now, so seat a table and hand back
// a first-letter -> id map to keep the assertions below readable.
function table(...names) {
  const room = createRoom(`sock-${names[0]}`, names[0]);
  for (const n of names.slice(1)) addPlayer(room, `sock-${n}`, n, 0);
  const id = {};
  room.players.forEach((p, i) => { id[names[i][0]] = p.id; });
  return { room, id, who: (letter) => room.players.find((p) => p.id === id[letter]) };
}

// Everyone left checks through whatever streets remain, so a test can get to
// showdown without spelling out each check.
function checkDown(room) {
  for (let guard = 0; room.phase === 'betting' && guard < 40; guard++) {
    const id = serializeRoom(room).currentTurnId;
    if (!id) break;
    if (applyAction(room, id, 'check').error) break;
  }
}

// Same, but stops as soon as the street rolls over.
function checkDownOneStreet(room) {
  const from = room.street;
  for (let guard = 0; room.phase === 'betting' && room.street === from && guard < 20; guard++) {
    const id = serializeRoom(room).currentTurnId;
    if (!id) break;
    if (applyAction(room, id, 'check').error) break;
  }
}

const { room, id, who } = table('Alice', 'Bob', 'Cara');
room.players.forEach((p) => { p.stack = 100; });
// This block exercises the raw betting engine, so blinds are switched off and
// the numbers below are purely the result of the actions taken.
room.smallBlind = 0;
room.bigBlind = 0;

let r = startHand(room);
check('hand starts', r.ok === true);
check('Alice acts first', serializeRoom(room).currentTurnId === id.A);

// Alice raises to 20
r = applyAction(room, id.A, 'raise', 20);
check('Alice raise ok', r.ok === true);
check('pot = 20', room.pot === 20);
check('highestBet = 20', room.highestBet === 20);
check('turn -> Bob', serializeRoom(room).currentTurnId === id.B);

// Bob cannot check (must call/raise/fold)
r = applyAction(room, id.B, 'check');
check('Bob cannot check facing a bet', !!r.error);

// Bob calls 20
r = applyAction(room, id.B, 'call');
check('Bob call ok', r.ok === true);
check('pot = 40', room.pot === 40);
check('turn -> Cara', serializeRoom(room).currentTurnId === id.C);

// Cara folds
r = applyAction(room, id.C, 'fold');
check('Cara fold ok', r.ok === true);
check('Cara out of hand', who('C').inHand === false);
// Alice(20) and Bob(20) are square, so preflop closes and the flop opens.
check('preflop closes when bets are square', room.street === 'flop');
check('hand carries on past preflop', room.phase === 'betting');
check('postflop action opens left of the button', serializeRoom(room).currentTurnId === id.B);
check('bets reset for the new street', room.players.every((p) => p.currentBet === 0));
check('committed survives the street change', who('A').committed === 20);
check('pot carries over', room.pot === 40);

checkDown(room);
check('checking down the river ends the hand', room.phase === 'handComplete');

// Award pot to Alice
const before = who('A').stack;
r = awardPot(room, id.A);
check('award pot ok', r.ok === true);
check('Alice won 40', who('A').stack === before + 40);
check('pot reset', room.pot === 0);
check('phase back to lobby', room.phase === 'lobby');

// ---- All-in scenario -------------------------------------------------------
room.players.forEach((p) => { p.stack = 50; });
who('C').stack = 30;
// Park the button on Cara so it advances to Alice and she acts first again.
room.dealerId = id.C;
startHand(room);
applyAction(room, id.A, 'raise', 40);        // Alice raises to 40
r = applyAction(room, id.B, 'allin');        // Bob all-in 50 -> new highest 50
check('Bob all-in raises to 50', room.highestBet === 50 && who('B').isAllIn);
r = applyAction(room, id.C, 'allin');        // Cara all-in only 30 (< 50)
check('Cara all-in 30 (short)', who('C').isAllIn && who('C').currentBet === 30);
r = applyAction(room, id.A, 'call');         // Alice calls to 50
check('Alice calls to 50', who('A').currentBet === 50);
check('all-in hand complete', room.phase === 'handComplete');
check('pot = 40+... Alice50+Bob50+Cara30 = 130', room.pot === 130);

// ---- Dealer button + blinds ------------------------------------------------
const { room: t, id: tid, who: tWho } = table('Alice', 'Bob', 'Cara');
t.players.forEach((p) => { p.stack = 1000; });

check('blinds default to 25/50', t.smallBlind === 25 && t.bigBlind === 50);
check('sb above bb rejected', !!setBlinds(t, 100, 50).error);
check('negative blinds rejected', !!setBlinds(t, -5, 50).error);
check('setBlinds ok', setBlinds(t, 25, 50).ok === true);

startHand(t);
let s = serializeRoom(t);
check('button seats on Alice for hand 1', s.dealerId === tid.A);
check('Bob posts the small blind', s.smallBlindId === tid.B);
check('Cara posts the big blind', s.bigBlindId === tid.C);
check('blinds are in the pot', t.pot === 75);
check('Bob committed 25', tWho('B').currentBet === 25);
check('Cara committed 50', tWho('C').currentBet === 50);
check('highest bet is the big blind', t.highestBet === 50);
check('action opens left of the big blind', s.currentTurnId === tid.A);
check('Alice is down 0 before acting', tWho('A').stack === 1000);

applyAction(t, tid.A, 'call');
check('Alice calls the big blind', t.pot === 125);
check('turn -> Bob (small blind)', serializeRoom(t).currentTurnId === tid.B);

applyAction(t, tid.B, 'call');
check('Bob tops up to 50', tWho('B').currentBet === 50);
check('pot 150', t.pot === 150);
check('big blind gets its option', serializeRoom(t).currentTurnId === tid.C);
check('hand not over while BB still has the option', t.phase === 'betting');

applyAction(t, tid.C, 'check');
check('checking the option ends preflop', t.street === 'flop');
check('blinds do not carry into the flop bet', t.highestBet === 0 && t.players.every((p) => p.currentBet === 0));
check('blind money stays in the pot', t.pot === 150);

checkDown(t);
check('hand ends after the river', t.phase === 'handComplete');

awardPot(t, tid.A);
check('blind badges clear once the hand is awarded', t.smallBlindId === null && t.bigBlindId === null);
check('button stays put between hands', t.dealerId === tid.A);

startHand(t);
s = serializeRoom(t);
check('button moves one seat for hand 2', s.dealerId === tid.B);
check('blinds follow the button', s.smallBlindId === tid.C && s.bigBlindId === tid.A);
check('action opens left of the new big blind', s.currentTurnId === tid.B);

// ---- Heads-up: the button posts the small blind and acts first --------------
const { room: hu, id: huid } = table('Alice', 'Bob');
hu.players.forEach((p) => { p.stack = 500; });
startHand(hu);
s = serializeRoom(hu);
check('heads-up button posts the small blind', s.dealerId === huid.A && s.smallBlindId === huid.A);
check('heads-up other seat posts the big blind', s.bigBlindId === huid.B);
check('heads-up button acts first preflop', s.currentTurnId === huid.A);
check('heads-up pot is sb+bb', hu.pot === 75);

// ---- A blind bigger than the stack just puts that player all-in ------------
const { room: sh, id: shid, who: shWho } = table('Alice', 'Bob', 'Cara');
sh.players.forEach((p) => { p.stack = 1000; });
shWho('C').stack = 20; // cannot cover the 50 big blind
startHand(sh);
check('short big blind is all-in for less', shWho('C').isAllIn && shWho('C').currentBet === 20);
check('short blind keeps the full bb as the bet to match', sh.highestBet === 50);
check('short all-in player is skipped in the action', serializeRoom(sh).currentTurnId === shid.A);

// ---- Minimum raise ---------------------------------------------------------
const { room: mr, id: mid, who: mWho } = table('Alice', 'Bob', 'Cara');
mr.players.forEach((p) => { p.stack = 5000; });
setBlinds(mr, 25, 50);
startHand(mr);

check('opening min raise is twice the big blind', minRaiseTo(mr) === 100);
check('a raise under the minimum is rejected', !!applyAction(mr, mid.A, 'raise', 75).error);
check('a raise to exactly the minimum is fine', applyAction(mr, mid.A, 'raise', 100).ok === true);
check('minimum tracks the last raise size', minRaiseTo(mr) === 150);
check('re-raise under the minimum is rejected', !!applyAction(mr, mid.B, 'raise', 120).error);
check('re-raise of the same size is fine', applyAction(mr, mid.B, 'raise', 200).ok === true);
check('a bigger raise raises the bar', minRaiseTo(mr) === 300);

// An all-in short of a full raise must not become the new benchmark.
// Cara has 50 in as the big blind, so a 200 stack reaches exactly 250 — a 50
// bump on a 100 benchmark, which is a raise but not a full one.
mWho('C').stack = 200;
applyAction(mr, mid.C, 'allin');
check('short all-in does not reset the minimum', mr.lastRaiseSize === 100);
check('short all-in still moves the bet', mr.highestBet === 250);
check('minimum re-raise stays a full raise above', minRaiseTo(mr) === 350);

// Postflop the big blind is the floor for an opening bet.
const { room: mb, id: mbid } = table('Alice', 'Bob', 'Cara');
mb.players.forEach((p) => { p.stack = 5000; });
setBlinds(mb, 25, 50);
startHand(mb);
applyAction(mb, mbid.A, 'call');
applyAction(mb, mbid.B, 'call');
applyAction(mb, mbid.C, 'check');
check('flop reached', mb.street === 'flop');
check('minimum opening bet postflop is the big blind', minRaiseTo(mb) === 50);
check('a 1-chip bet is rejected postflop', !!applyAction(mb, mbid.B, 'raise', 1).error);
check('betting the big blind is fine', applyAction(mb, mbid.B, 'raise', 50).ok === true);

// Being short is always allowed — that is what going all-in means.
const { room: sr, id: srid, who: srWho } = table('Alice', 'Bob');
sr.players.forEach((p) => { p.stack = 1000; });
setBlinds(sr, 25, 50);
srWho('A').stack = 80; // less than the 100 minimum raise
startHand(sr);
check('a short stack may raise all-in below the minimum',
  applyAction(sr, srid.A, 'raise', 80).ok === true);
check('the short raiser is all-in', srWho('A').isAllIn);

// ---- Side pot layering (pure math) -----------------------------------------
// buildPots only reads players, so feed it hand-built contributions.
const potsOf = (specs) => buildPots({
  players: specs.map((sp) => ({ id: sp.id, committed: sp.committed, inHand: sp.inHand !== false })),
});
const shape = (pots) => pots.map((p) => `${p.amount}:${p.eligibleIds.join('')}`).join(' | ');
const totalOf = (pots) => pots.reduce((sum, p) => sum + p.amount, 0);

check('everyone matched -> one pot for everyone',
  shape(potsOf([
    { id: 'A', committed: 100 }, { id: 'B', committed: 100 }, { id: 'C', committed: 100 },
  ])) === '300:ABC');

const short = potsOf([
  { id: 'A', committed: 200 }, { id: 'B', committed: 100 }, { id: 'C', committed: 200 },
]);
check('short all-in splits main + side', shape(short) === '300:ABC | 200:AC');
check('short all-in conserves chips', totalOf(short) === 500);

const threeWay = potsOf([
  { id: 'A', committed: 100 }, { id: 'B', committed: 200 }, { id: 'C', committed: 300 },
]);
check('three all-in levels make three pots', shape(threeWay) === '300:ABC | 200:BC | 100:C');
check('three-way conserves chips', totalOf(threeWay) === 600);

const withFolder = potsOf([
  { id: 'A', committed: 200 }, { id: 'B', committed: 100, inHand: false }, { id: 'C', committed: 200 },
]);
check('folded chips fill the pot but win nothing', shape(withFolder) === '500:AC');
check('folded chips are not lost', totalOf(withFolder) === 500);

const uncalled = potsOf([
  { id: 'A', committed: 300 }, { id: 'B', committed: 100 }, { id: 'C', committed: 0, inHand: false },
]);
check('uncalled excess becomes a solo pot', shape(uncalled) === '200:AB | 200:A');
check('uncalled excess conserves chips', totalOf(uncalled) === 400);

const overFolded = potsOf([
  { id: 'A', committed: 100 }, { id: 'B', committed: 300, inHand: false },
]);
check('over-committed folder leaves no orphan chips', totalOf(overFolded) === 400);
check('over-committed folder money rides the last pot', shape(overFolded) === '400:A');

// ---- Side pots end to end --------------------------------------------------
const { room: sp, id: spid, who: spWho } = table('Alice', 'Bob', 'Cara');
sp.smallBlind = 0; sp.bigBlind = 0;
spWho('A').stack = 200;
spWho('B').stack = 100;
spWho('C').stack = 300;
const chipsBefore = 600;

startHand(sp);
applyAction(sp, spid.A, 'allin');   // Alice in for 200
applyAction(sp, spid.B, 'allin');   // Bob can only cover 100
applyAction(sp, spid.C, 'call');    // Cara calls the full 200

check('hand completes with everyone square', sp.phase === 'handComplete');
check('two pots built', sp.pots.length === 2);
check('main pot is 300 with all three eligible', sp.pots[0].amount === 300 && sp.pots[0].eligibleIds.length === 3);
check('side pot is 200 without Bob', sp.pots[1].amount === 200 && !sp.pots[1].eligibleIds.includes(spid.B));
check('pots equal the collected pot', sp.pots[0].amount + sp.pots[1].amount === 500);

check('Bob cannot be given the side pot', !!awardPot(sp, [spid.B], 1).error);
check('awarding the main pot leaves the hand open', awardPot(sp, [spid.B], 0).ok === true && sp.phase === 'handComplete');
check('Bob collected the main pot', spWho('B').stack === 300);
check('side pot still pending', sp.pots[1].remaining === 200);

awardPot(sp, [spid.A], 1);
check('settling the last pot returns to lobby', sp.phase === 'lobby');
check('Alice collected the side pot', spWho('A').stack === 200);
check('Cara is left with her uncommitted chips', spWho('C').stack === 100);
check('no chips created or destroyed',
  sp.players.reduce((sum, p) => sum + p.stack, 0) === chipsBefore);

// ---- Chopped pot, odd chip goes left of the button -------------------------
const { room: chop, id: cid, who: cWho } = table('Alice', 'Bob', 'Cara');
chop.smallBlind = 0; chop.bigBlind = 0;
chop.players.forEach((p) => { p.stack = 100; });
startHand(chop);                    // button on Alice, so Bob sits left of it
applyAction(chop, cid.A, 'raise', 25);
applyAction(chop, cid.B, 'call');
applyAction(chop, cid.C, 'fold');
checkDown(chop);
check('one pot to chop', chop.pots.length === 1 && chop.pots[0].amount === 50);
awardPot(chop, [cid.A, cid.B]);
check('chop splits evenly', cWho('A').stack === 100 && cWho('B').stack === 100);

const { room: odd, id: oid, who: oWho } = table('Alice', 'Bob', 'Cara');
odd.smallBlind = 0; odd.bigBlind = 0;
odd.players.forEach((p) => { p.stack = 100; });
startHand(odd);
applyAction(odd, oid.A, 'raise', 25);
applyAction(odd, oid.B, 'call');
applyAction(odd, oid.C, 'fold');
checkDown(odd);
// Force an indivisible pot. `remaining` is what actually gets paid out.
odd.pots[0].amount = 51;
odd.pots[0].remaining = 51;
awardPot(odd, [oid.A, oid.B]);
check('odd chip goes to the seat left of the button',
  oWho('B').stack === 101 && oWho('A').stack === 100);

// ---- Folding out auto-settles, no host decision needed ---------------------
const { room: walk, id: wid, who: wWho } = table('Alice', 'Bob', 'Cara');
walk.players.forEach((p) => { p.stack = 1000; });
startHand(walk);                     // blinds 25/50, Alice acts first
applyAction(walk, wid.A, 'fold');
applyAction(walk, wid.B, 'fold');
check('folding out settles without the host', walk.phase === 'lobby');
check('last player standing takes the blinds', wWho('C').stack === 1025);
check('table chips unchanged after a walk',
  walk.players.reduce((sum, p) => sum + p.stack, 0) === 3000);
check('summary records the winner',
  walk.lastHandSummary.length === 1 && walk.lastHandSummary[0].amount === 75);

// ---- Betting rounds --------------------------------------------------------
const { room: st, id: stid } = table('Alice', 'Bob', 'Cara');
st.players.forEach((p) => { p.stack = 1000; });
setBlinds(st, 25, 50);

startHand(st);
check('a hand opens on preflop', st.street === 'preflop');
applyAction(st, stid.A, 'call');
applyAction(st, stid.B, 'call');
applyAction(st, stid.C, 'check');
check('preflop -> flop', st.street === 'flop');
check('flop opens with no bet to match', st.highestBet === 0);
check('flop action starts left of the button', serializeRoom(st).currentTurnId === stid.B);
check('everyone committed 50 preflop', st.players.every((p) => p.committed === 50));

// A bet and call on the flop adds to committed without disturbing the pot total.
applyAction(st, stid.B, 'raise', 100);
applyAction(st, stid.C, 'call');
applyAction(st, stid.A, 'call');
check('flop -> turn', st.street === 'turn');
check('committed accumulates across streets', st.players.every((p) => p.committed === 150));
check('pot holds both streets', st.pot === 450);
check('turn action starts left of the button again', serializeRoom(st).currentTurnId === stid.B);

applyAction(st, stid.B, 'check');
applyAction(st, stid.C, 'check');
applyAction(st, stid.A, 'check');
check('turn -> river', st.street === 'river');

applyAction(st, stid.B, 'check');
applyAction(st, stid.C, 'check');
applyAction(st, stid.A, 'check');
check('river ends the hand', st.phase === 'handComplete');
check('no street once the hand is done being bet', st.street === 'river');
check('single pot of 450', st.pots.length === 1 && st.pots[0].amount === 450);

awardPot(st, [stid.A]);
check('street clears back in the lobby', st.street === null && st.phase === 'lobby');
check('chips conserved across four streets',
  st.players.reduce((sum, p) => sum + p.stack, 0) === 3000);

// A raise on a later street reopens the action for everyone else.
const { room: reopen, id: rid } = table('Alice', 'Bob', 'Cara');
reopen.players.forEach((p) => { p.stack = 1000; });
reopen.smallBlind = 0; reopen.bigBlind = 0;
startHand(reopen);
checkDownOneStreet(reopen);
check('checks all round move to the flop', reopen.street === 'flop');
applyAction(reopen, rid.B, 'raise', 40);
applyAction(reopen, rid.C, 'call');
check('a raise keeps the street open for Alice', reopen.street === 'flop');
check('turn comes back to Alice', serializeRoom(reopen).currentTurnId === rid.A);
applyAction(reopen, rid.A, 'fold');
check('street closes once the last player folds out', reopen.street === 'turn');

// Once only one player can still bet, the remaining streets are a formality.
const { room: seal, id: sealid, who: sealWho } = table('Alice', 'Bob');
seal.smallBlind = 0; seal.bigBlind = 0;
sealWho('A').stack = 100;
sealWho('B').stack = 400;
startHand(seal);
applyAction(seal, sealid.A, 'allin');
applyAction(seal, sealid.B, 'call');
check('an all-in call skips straight to showdown', seal.phase === 'handComplete');
check('no further streets are dealt', seal.street === 'preflop');
check('pot is the matched amount', seal.pot === 200);

// ---- Dropped connections keep their seat and chips -------------------------
const { room: dc, id: did, who: dWho } = table('Alice', 'Bob', 'Cara');
dc.players.forEach((p) => { p.stack = 1000; });

check('a player is found by their socket', findBySocket(dc, 'sock-Bob').id === did.B);
check('player id is not the socket id', did.B !== 'sock-Bob');
check('tokens are private to each seat', dWho('A').token !== dWho('B').token);

startHand(dc);
const bobToken = dWho('B').token;
markDisconnected(dc, 'sock-Bob');
check('a dropped player keeps their seat', dc.players.length === 3);
check('a dropped player keeps their chips', dWho('B').stack === 975); // posted the small blind
check('a dropped player is marked offline', dWho('B').connected === false);
check('their socket is released', dWho('B').socketId === null);
check('the room is not abandoned while others are on', isAbandoned(dc) === false);

check('a bad token cannot claim a seat', !!reconnectPlayer(dc, 'not-a-token', 'sock-New').error);
const back = reconnectPlayer(dc, bobToken, 'sock-Bob-2');
check('the right token reclaims the seat', back.ok === true && back.player.id === did.B);
check('reclaiming keeps the same player id', dWho('B').id === did.B);
check('reclaiming restores the connection', dWho('B').connected === true);
check('reclaiming rebinds the new socket', dWho('B').socketId === 'sock-Bob-2');
check('chips survived the round trip', dWho('B').stack === 975);

// The host dropping must not freeze the table.
markDisconnected(dc, 'sock-Alice');
check('host role moves to someone present', dc.hostId !== did.A);
check('the new host is connected', dc.players.find((p) => p.id === dc.hostId).connected === true);
check('only one player is flagged as host', dc.players.filter((p) => p.isHost).length === 1);

// Everyone gone means the room can be reclaimed.
markDisconnected(dc, 'sock-Bob-2');
markDisconnected(dc, 'sock-Cara');
check('a room with nobody on it is abandoned', isAbandoned(dc) === true);

// ---- Host folds for a player who has dropped -------------------------------
const { room: ff, id: ffid, who: ffWho } = table('Alice', 'Bob', 'Cara');
ff.players.forEach((p) => { p.stack = 1000; });
startHand(ff);
check('Alice is to act', serializeRoom(ff).currentTurnId === ffid.A);
check('cannot fold for a player who is still connected', !!foldFor(ff, ffid.A).error);

markDisconnected(ff, 'sock-Alice');
check('cannot fold for someone who is not on turn', !!foldFor(ff, ffid.B).error);
check('folding for the dropped player works', foldFor(ff, ffid.A).ok === true);
check('the dropped player is out of the hand', ffWho('A').inHand === false);
check('the action moved on', serializeRoom(ff).currentTurnId === ffid.B);

// ---- Leaving on purpose actually gives up the seat -------------------------
const { room: lv, id: lvid } = table('Alice', 'Bob', 'Cara');
lv.players.forEach((p) => { p.stack = 1000; });
removePlayer(lv, lvid.C);
check('leaving removes the player', lv.players.length === 2);
check('leaving does not disturb the others', lv.players.every((p) => p.stack === 1000));
check('no token leaks into the broadcast state',
  serializeRoom(lv).players.every((p) => p.token === undefined && p.socketId === undefined));

// ---- Host awards an exact amount to any player -----------------------------
const { room: ma, id: maid, who: maWho } = table('Alice', 'Bob', 'Cara');
ma.smallBlind = 0; ma.bigBlind = 0;
ma.players.forEach((p) => { p.stack = 500; });
startHand(ma);
applyAction(ma, maid.A, 'raise', 100);
applyAction(ma, maid.B, 'call');
applyAction(ma, maid.C, 'call');
checkDown(ma);
check('one pot of 300 at showdown', ma.pots.length === 1 && ma.pots[0].amount === 300);
check('a fresh pot has everything left', ma.pots[0].remaining === 300);

check('cannot award zero', !!awardAmount(ma, maid.A, 0).error);
check('cannot award a negative amount', !!awardAmount(ma, maid.A, -50).error);
check('cannot award more than the pot holds', !!awardAmount(ma, maid.A, 301).error);
check('cannot award to a player who is not at the table', !!awardAmount(ma, 'nobody', 50).error);

check('awarding part of the pot works', awardAmount(ma, maid.A, 175).ok === true);
check('the pot tracks what is left', ma.pots[0].remaining === 125);
check('the recipient got exactly that', maWho('A').stack === 400 + 175);
check('the hand stays open while chips remain', ma.phase === 'handComplete');
check('the felt total drops as chips leave', ma.pot === 125);

// Eligibility is deliberately not enforced here — that is the point of the override.
check('any player can be given chips', awardAmount(ma, maid.C, 125).ok === true);
check('settling the last chips returns to lobby', ma.phase === 'lobby');
check('pots are cleared once settled', ma.pots.length === 0);
check('chips conserved through a manual split',
  ma.players.reduce((sum, p) => sum + p.stack, 0) === 1500);

// The summary records every recipient, not just the last one.
check('summary lists both recipients', ma.lastHandSummary.length === 2);
check('summary amounts add up to the pot',
  ma.lastHandSummary.reduce((sum, e) => sum + e.amount, 0) === 300);

// Manual awards and whole-pot awards mix on the same pot.
const { room: mx, id: mxid, who: mxWho } = table('Alice', 'Bob', 'Cara');
mx.smallBlind = 0; mx.bigBlind = 0;
mx.players.forEach((p) => { p.stack = 500; });
startHand(mx);
applyAction(mx, mxid.A, 'raise', 100);
applyAction(mx, mxid.B, 'call');
applyAction(mx, mxid.C, 'call');
checkDown(mx);
awardAmount(mx, mxid.B, 100);
check('part paid by hand', mx.pots[0].remaining === 200);
check('awarding the rest normally pays only what is left',
  awardPot(mx, [mxid.A]).ok === true);
check('Alice got the remainder, not the whole pot', mxWho('A').stack === 400 + 200);
check('mixed award settles the hand', mx.phase === 'lobby');
check('chips conserved across a mixed award',
  mx.players.reduce((sum, p) => sum + p.stack, 0) === 1500);

// Side pots each keep their own balance.
const { room: msp, id: mspid, who: mspWho } = table('Alice', 'Bob', 'Cara');
msp.smallBlind = 0; msp.bigBlind = 0;
mspWho('A').stack = 200;
mspWho('B').stack = 100;
mspWho('C').stack = 300;
startHand(msp);
applyAction(msp, mspid.A, 'allin');
applyAction(msp, mspid.B, 'allin');
applyAction(msp, mspid.C, 'call');
check('two pots to settle', msp.pots.length === 2);
check('cannot overdraw the main pot', !!awardAmount(msp, mspid.B, 301, 0).error);
awardAmount(msp, mspid.B, 300, 0);
check('main pot emptied by hand', msp.pots[0].remaining === 0);
check('the side pot is untouched', msp.pots[1].remaining === 200);
check('the hand waits on the side pot', msp.phase === 'handComplete');
awardAmount(msp, mspid.A, 200, 1);
check('both pots settled ends the hand', msp.phase === 'lobby');
check('chips conserved across side pots',
  msp.players.reduce((sum, p) => sum + p.stack, 0) === 600);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
