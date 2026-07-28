import http from 'http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import {
  createRoom,
  getRoom,
  addPlayer,
  removePlayer,
  startHand,
  applyAction,
  awardPot,
  awardAmount,
  setBlinds,
  foldFor,
  findBySocket,
  markDisconnected,
  reconnectPlayer,
  isAbandoned,
  rooms,
  serializeRoom,
} from './game.js';

const PORT = process.env.PORT || 4000;
// Comma-separated list of allowed origins, or "*" for any (dev default).
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';
const corsOrigins = CLIENT_ORIGIN === '*' ? '*' : CLIENT_ORIGIN.split(',').map((s) => s.trim());

// How long a room with nobody connected is kept before it is reclaimed. Long
// enough to survive everyone's phones sleeping, short enough not to leak.
const ABANDONED_ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 30 * 60 * 1000);

const app = express();
app.use(cors({ origin: corsOrigins }));

// Simple health check (useful for Render/Vercel and the Phase 1 connection test).
app.get('/', (_req, res) => res.json({ ok: true, service: 'poker-chip-tracker', rooms: undefined }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigins, methods: ['GET', 'POST'] },
});

// Track which room each socket belongs to, for clean disconnect handling.
const socketRoom = new Map(); // socketId -> roomCode

function broadcast(room) {
  io.to(room.code).emit('room:state', serializeRoom(room));
}

// Resolve the acting player from the connection. Player ids are no longer
// socket ids, so every handler has to go through this.
function actor(socket) {
  const code = socketRoom.get(socket.id);
  if (!code) return {};
  const room = getRoom(code);
  if (!room) return {};
  return { room, player: findBySocket(room, socket.id) };
}

// Same, but only for handlers the host may use.
function hostActor(socket) {
  const { room, player } = actor(socket);
  if (!room || !player) return { error: 'You are not in a room.' };
  if (room.hostId !== player.id) return { error: 'Only the host can do that.' };
  return { room, player };
}

io.on('connection', (socket) => {
  // Phase 1: basic connection test. Client can ping, server pongs back.
  socket.emit('server:hello', { message: 'Connected to poker chip tracker server', id: socket.id });
  socket.on('client:ping', (payload) => {
    socket.emit('server:pong', { received: payload ?? null, at: Date.now() });
  });

  // Phase 2: create a room. Creator becomes host.
  socket.on('room:create', ({ name }, ack) => {
    const displayName = (name || '').trim();
    if (!displayName) return ack?.({ error: 'Please enter a display name.' });
    const room = createRoom(socket.id, displayName);
    const host = room.players[0];
    socket.join(room.code);
    socketRoom.set(socket.id, room.code);
    ack?.({
      ok: true,
      code: room.code,
      playerId: host.id,
      token: host.token,
      state: serializeRoom(room),
    });
    broadcast(room);
  });

  // Phase 2: join an existing room by code.
  socket.on('room:join', ({ code, name }, ack) => {
    const roomCode = (code || '').trim().toUpperCase();
    const displayName = (name || '').trim();
    if (!displayName) return ack?.({ error: 'Please enter a display name.' });
    const room = getRoom(roomCode);
    if (!room) return ack?.({ error: 'No room with that code.' });
    if (room.players.some((p) => p.name.toLowerCase() === displayName.toLowerCase())) {
      return ack?.({ error: 'That name is already taken in this room.' });
    }
    const player = addPlayer(room, socket.id, displayName, 0, false);
    socket.join(room.code);
    socketRoom.set(socket.id, room.code);
    ack?.({
      ok: true,
      code: room.code,
      playerId: player.id,
      token: player.token,
      state: serializeRoom(room),
    });
    broadcast(room);
  });

  // Reclaim a seat after a dropped connection, using the token issued on join.
  socket.on('room:rejoin', ({ code, token }, ack) => {
    const room = getRoom((code || '').trim().toUpperCase());
    if (!room) return ack?.({ error: 'That room is no longer running.' });
    const result = reconnectPlayer(room, token, socket.id);
    if (result.error) return ack?.(result);
    socket.join(room.code);
    socketRoom.set(socket.id, room.code);
    ack?.({
      ok: true,
      code: room.code,
      playerId: result.player.id,
      token: result.player.token,
      state: serializeRoom(room),
    });
    broadcast(room);
  });

  // Phase 2: host assigns a starting stack to a player.
  socket.on('room:setStack', ({ playerId, stack }, ack) => {
    const { room, error } = hostActor(socket);
    if (error) return ack?.({ error });
    if (room.phase === 'betting') return ack?.({ error: 'Cannot change stacks mid-hand.' });
    const target = room.players.find((p) => p.id === playerId);
    if (!target) return ack?.({ error: 'Player not found.' });
    const value = Number(stack);
    if (!Number.isFinite(value) || value < 0) return ack?.({ error: 'Invalid stack amount.' });
    target.stack = Math.floor(value);
    ack?.({ ok: true });
    broadcast(room);
  });

  // Host sets the blind levels.
  socket.on('room:setBlinds', ({ smallBlind, bigBlind }, ack) => {
    const { room, error } = hostActor(socket);
    if (error) return ack?.({ error });
    const result = setBlinds(room, smallBlind, bigBlind);
    if (result.error) return ack?.(result);
    ack?.({ ok: true });
    broadcast(room);
  });

  // Phase 3: host starts a betting hand.
  socket.on('game:startHand', (_payload, ack) => {
    const { room, error } = hostActor(socket);
    if (error) return ack?.({ error });
    const result = startHand(room);
    if (result.error) return ack?.(result);
    ack?.({ ok: true });
    broadcast(room);
  });

  // Phase 3: a player takes a betting action.
  socket.on('game:action', ({ action, amount }, ack) => {
    const { room, player } = actor(socket);
    if (!room || !player) return ack?.({ error: 'You are not in a room.' });
    const result = applyAction(room, player.id, action, amount);
    if (result.error) return ack?.(result);
    ack?.({ ok: true });
    broadcast(room);
  });

  // Host folds for a player who has dropped, so the table isn't stuck waiting.
  socket.on('game:foldFor', ({ playerId }, ack) => {
    const { room, error } = hostActor(socket);
    if (error) return ack?.({ error });
    const result = foldFor(room, playerId);
    if (result.error) return ack?.(result);
    ack?.({ ok: true });
    broadcast(room);
  });

  // Host awards a pot. `winnerIds` (several = a chopped pot) or `winnerId` for
  // the single-winner case; `potId` defaults to the next unsettled pot.
  socket.on('game:awardPot', ({ winnerId, winnerIds, potId }, ack) => {
    const { room, error } = hostActor(socket);
    if (error) return ack?.({ error });
    const result = awardPot(room, winnerIds ?? winnerId, potId);
    if (result.error) return ack?.(result);
    ack?.({ ok: true });
    broadcast(room);
  });

  // Host hands an exact amount to any player — the manual override for a
  // showdown the automatic split can't express.
  socket.on('game:awardAmount', ({ playerId, amount, potId }, ack) => {
    const { room, error } = hostActor(socket);
    if (error) return ack?.({ error });
    const result = awardAmount(room, playerId, amount, potId);
    if (result.error) return ack?.(result);
    ack?.({ ok: true });
    broadcast(room);
  });

  // Leaving on purpose gives up the seat for good, unlike a dropped connection.
  socket.on('room:leave', (_payload, ack) => {
    const { room, player } = actor(socket);
    socketRoom.delete(socket.id);
    if (!room || !player) return ack?.({ ok: true });
    socket.leave(room.code);
    removePlayer(room, player.id);
    ack?.({ ok: true });
    const stillThere = getRoom(room.code);
    if (stillThere) broadcast(stillThere);
  });

  socket.on('disconnect', () => {
    const code = socketRoom.get(socket.id);
    socketRoom.delete(socket.id);
    if (!code) return;
    const room = getRoom(code);
    if (!room) return;
    // Keep the seat and its chips — they may just be on a train.
    markDisconnected(room, socket.id);
    broadcast(room);
  });
});

// Reclaim rooms nobody has come back to.
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (!isAbandoned(room)) {
      room.abandonedSince = null;
      continue;
    }
    room.abandonedSince ??= now;
    if (now - room.abandonedSince > ABANDONED_ROOM_TTL_MS) rooms.delete(room.code);
  }
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Poker chip tracker server listening on port ${PORT}`);
});
