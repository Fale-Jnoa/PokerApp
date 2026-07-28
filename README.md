# ♠ Poker Chip Tracker

> No poker chips? No worries!

A real-time, multiplayer **poker chip tracker** — track stacks, bets, and the pot
for an in-person game while you use physical cards. No database: all game state
lives in memory on the server for the life of a room.

- **Frontend:** React + Vite
- **Backend:** Node.js + Express + Socket.io
- **State:** in-memory only (a room exists as long as the server runs)
- The **server is the single source of truth** for stacks, pot, and turn order.
  It validates every action and broadcasts the full room state after each change.

## Project structure

```
Poker-App/
├── server/          # Express + Socket.io backend
│   ├── src/
│   │   ├── index.js # Socket.io wiring + HTTP health checks
│   │   └── game.js  # in-memory rooms + betting engine
│   └── test-game.mjs
├── client/          # React + Vite frontend
│   ├── src/
│   │   ├── App.jsx
│   │   ├── socket.js
│   │   └── components/
│   │       ├── JoinScreen.jsx
│   │       ├── Room.jsx
│   │       ├── TableView.jsx
│   │       ├── ActionBar.jsx
│   │       └── HostControls.jsx
│   └── e2e-test.mjs
├── render.yaml      # backend deploy blueprint (Render)
└── README.md
```

## Running locally

Two terminals.

**1. Server** (port 4000 by default):
```bash
cd server
npm install
cp .env.example .env      # optional; defaults are fine for local dev
npm run dev               # or: npm start
```

**2. Client** (port 5173):
```bash
cd client
npm install
cp .env.example .env      # sets VITE_SERVER_URL=http://localhost:4000
npm run dev
```

Open http://localhost:5173. Create a room, share the 4-character code, and have
others join from their own devices/tabs.

## How a game works

1. **Create / join** — one player creates a room and becomes the **host**;
   others join with the short code and a display name.
2. **Host assigns stacks** — the host sets each player's starting chip stack,
   individually or with **Give all**. *A hand cannot start until at least two
   players have chips* — the Start button stays disabled and says why.
3. **Host sets blinds** — defaults to `25/50`; set both to `0` for no blinds.
4. **Host starts a hand** — the **dealer button** advances one seat each hand,
   the small and big blinds post automatically, and preflop action opens to the
   left of the big blind. The big blind keeps its **option** to raise when the
   action comes back around. Heads-up, the button posts the small blind and acts
   first.
5. **Betting actions** — on your turn: **Check**, **Call**, **Raise** (plain
   number input), **Fold**, or **All-In**. The server validates each action.
   A player too short to cover a blind simply goes all-in for less.
   A **raise must be at least the size of the last full raise** — so the opening
   raise is twice the big blind, and postflop the big blind is the minimum bet.
   Going all-in for less than that is always allowed; it just doesn't raise the
   bar for anyone still to act. The client mirrors `minRaiseTo` straight from
   the server, so the UI can never offer a bet the server would reject.
6. **Four betting rounds** — once bets are square the street advances
   **pre-flop → flop → turn → river**, and the app shows which one you're on.
   Bets clear at each street and go into the pot; postflop the action opens with
   the first live player left of the button. Deal the physical cards yourselves —
   the app only tracks chips. If only one player can still bet (everyone else is
   all-in), the remaining streets are skipped and the hand goes straight to
   showdown.
7. **Hand completes** after the river (or when all but one player folds).
8. **Pots are worked out automatically** (see below) and the **host awards each
   one** to the best hand among its eligible players. The table returns to the
   lobby once the last pot is settled.

### Side pots

When players go all-in for different amounts, the pot splits into a main pot
plus one side pot per all-in level. A player can only win chips they were able
to cover, so each layer is capped at the level that created it and is contested
only by the players who reached it. Chips from players who **folded** still fill
the layers they paid into — they just can't win any of them.

> Alice is in for 200, Bob can only cover 100, Cara calls 200.
> **Main pot 300** (Alice, Bob, Cara) · **Side pot 200** (Alice, Cara — Bob
> couldn't cover it).

Two cases resolve themselves with no host input: a pot only one player is
eligible for (an uncalled raise coming back, or everyone folding out), and a
hand where all but one player folds. Anything genuinely contested is the host's
call, and a pot can be **chopped** between several winners — odd chips go to the
first seat left of the button, per convention.

### Splitting a pot by hand

Real showdowns don't always fit the rules an app can model. Under each pot the
host gets **"Split it by hand instead"**: name an exact number of chips and any
player at the table, and award repeatedly until the pot is empty. This
deliberately **ignores eligibility** — that's the point of an override — but it
can never pay out more than the pot holds, so chips can't be invented. The hand
stays open until every pot is empty, and the pot shows how much has already gone
out. Manual and normal awards mix freely on the same pot.

### The table

One screen for everyone: an overhead felt table with every player seated around
the rail — their stack, chips bet out in front of them, the `D`/`SB`/`BB`
badges, the pot in the middle, and the player to act ringed in gold. Seats
rotate so **you are always at the bottom**. Your betting controls sit in a bar
pinned under the table, showing what it costs to call.

The **host** gets a second screen (a `Table`/`Host` toggle) for running the
game: stacks, blinds, starting hands, and awarding pots. The action bar stays
visible on both, so being on the host screen can never cost the host a turn — and
each tab shows a dot when it needs attention.

## Dropped connections

Phones sleep and wifi drops, so **a lost connection never costs anyone their
chips**. Player identity is deliberately separate from the socket:

- `id` — stable for the life of the room; everything else (turn order, pots,
  the button) refers to a player by this.
- `token` — a private secret issued on join and kept in `localStorage`. It is
  never broadcast; it's what proves a returning browser owns a seat.
- `socketId` — whatever connection they happen to be on right now.

Dropping marks the seat **offline** and keeps the chips. Reconnecting is
automatic: the client re-sends its token on every reconnect, so a backgrounded
phone or a page reload lands back in the same seat. If the **host** drops, the
role passes to someone who is present so the table can keep playing.

Two escape hatches for the cases that would otherwise stall a game:

- If it's an offline player's turn, the host gets a **"Fold for {name}"**
  button. It's deliberately limited to players who are actually gone.
- **Leave** is the explicit way out and really does give up the seat, unlike a
  dropped connection.

Rooms where nobody has been connected for `ROOM_TTL_MS` (default 30 minutes)
are reclaimed.

## Environment variables

**Server** (`server/.env`):

| Var | Purpose | Default |
| --- | --- | --- |
| `PORT` | Port to listen on | `4000` |
| `CLIENT_ORIGIN` | Allowed CORS origin(s), comma-separated, or `*` | `*` |
| `ROOM_TTL_MS` | How long a room with nobody connected is kept | `1800000` (30 min) |

**Client** (`client/.env`):

| Var | Purpose | Default |
| --- | --- | --- |
| `VITE_SERVER_URL` | Backend URL the client connects to | `http://localhost:4000` |

## Deployment (Vercel + Render)

The client and server are separate so they can be deployed independently.

**Backend → Render** (uses `render.yaml`):
- New Web Service from this repo, root directory `server`.
- Build `npm install`, start `npm start`.
- Set `CLIENT_ORIGIN` to your client URL (e.g. `https://your-app.vercel.app`).

**Frontend → Vercel:**
- New project, root directory `client`.
- Set `VITE_SERVER_URL` to your Render backend URL (e.g. `https://your-server.onrender.com`).
- Build `npm run build`, output `dist` (see `client/vercel.json`).

## Tests

Both are quick sanity checks, not formal suites.

```bash
# Betting engine logic (no server needed)
cd server && node test-game.mjs

# Full end-to-end over real Socket.io connections (start the server first)
cd server && npm start &
cd client && node e2e-test.mjs
```

## Notes / scope

Per the original spec, the following are intentionally **left out**: animations,
voice callouts, raise sliders (a plain number input is used instead), and turn
timers.

Two things were added beyond the literal spec, both to make the loop usable —
**Fold** (requested during the build) and a host **"award pot"** control (without
it, chips could never return to the table to start a new hand).
