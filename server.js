const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 8080;

/* ===================== HTTP ===================== */

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Blackjack (21) WebSocket Server");
});

const wss = new WebSocket.Server({ server });

/* ===================== GLOBAL STATE ===================== */

let nextPlayerId = 1;
let nextRoomId = 1;
const rooms = new Map();

/* ===================== DECK ===================== */

function createDeck() {
  const deck = ["1","2","3","4","5","6","7","8","9","10","11"];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function handValue(hand) {
  const sum = hand.reduce((a, c) => a + Number(c), 0);
  return sum > 21 ? 0 : sum;
}

/* ===================== HELPERS ===================== */

function broadcast(room, payload) {
  const msg = JSON.stringify(payload);
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  });
}

function getOpponent(room, playerId) {
  return room.players.find(p => p.id !== playerId);
}

function randomPlayerId(room) {
  return room.players[Math.floor(Math.random() * room.players.length)].id;
}

function broadcastRoomList() {
  const roomsPayload = Array.from(rooms.values()).map(r => ({
    roomId: r.id,
    players: r.players.map(p => p.name),
    state: r.state === "game_over" ? "waiting" : r.state,
    mode: "classic"
  }));

  const msg = JSON.stringify({ type: "room_list", rooms: roomsPayload });

  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

/* ===================== ROOM HANDLERS ===================== */

function createRoom(player, msg) {
  if (player.roomId) return;

  const room = {
    id: nextRoomId++,
    players: [player],
    state: "waiting",
    deck: [],
    hands: {},
    stood: {},
    health: {},
    round: 1,
    currentTurnPlayerId: null,
    rematchVotes: new Set(),
    processingRound: false
  };

  player.roomId = room.id;
  player.name = msg.name || `Player ${player.id}`;
  rooms.set(room.id, room);

  player.ws.send(JSON.stringify({ type: "room_created", roomId: room.id }));
  broadcastRoomList();
}

function joinRoom(player, msg) {
  const room = rooms.get(msg.roomId);
  if (!room || room.state !== "waiting" || room.players.length >= 2) return;

  player.roomId = room.id;
  player.name = msg.name || `Player ${player.id}`;
  room.players.push(player);

  broadcastRoomList();

  if (room.players.length === 2) startGame(room);
}

function handleLeaveRoom(player) {
  if (player.roomId === null) return;

  const room = rooms.get(player.roomId);
  if (!room) return;

  room.players = room.players.filter(p => p.id !== player.id);
  player.roomId = null;

  if (room.players.length === 0) {
    rooms.delete(room.id);
  } else {
    room.state = "waiting";

    room.players[0].ws.send(JSON.stringify({
      type: "opponent_left"
    }));
  }

  broadcastRoomList();
}

/* ===================== GAME FLOW ===================== */

function startGame(room) {
  room.state = "running";
  room.round = 1;
  room.deck = createDeck();
  room.hands = {};
  room.stood = {};
  room.health = {};
  room.rematchVotes.clear();
  room.processingRound = false;
  room.currentTurnPlayerId = randomPlayerId(room);

  room.players.forEach(p => {
    room.hands[p.id] = [room.deck.pop(), room.deck.pop()];
    room.stood[p.id] = false;
    room.health[p.id] = 7;
  });

  room.players.forEach(p => {
    const opp = getOpponent(room, p.id);
    p.ws.send(JSON.stringify({
      type: "game_start",
      yourHand: room.hands[p.id],
      yourValue: handValue(room.hands[p.id]),
      opponentCardCount: room.hands[opp.id].length,
      health: { you: room.health[p.id], opponent: room.health[opp.id] },
      round: room.round,
      damage: 1,
      currentTurnPlayerId: room.currentTurnPlayerId
    }));
  });
}

/* ===================== ACTIONS ===================== */

function handleHit(player) {
  const room = rooms.get(player.roomId);
  if (!room || room.currentTurnPlayerId !== player.id) return;

  const card = room.deck.pop();
  room.hands[player.id].push(card);
  const value = handValue(room.hands[player.id]);

  broadcast(room, {
    type: "hit_result",
    playerId: player.id,
    card,
    newValue: value
  });

  if (value === 0) endRound(room, player.id);
  else {
    room.currentTurnPlayerId = getOpponent(room, player.id).id;
    broadcast(room, {
      type: "turn_change",
      currentTurnPlayerId: room.currentTurnPlayerId
    });
  }
}

function handleStand(player) {
  const room = rooms.get(player.roomId);
  if (!room) return;

  room.stood[player.id] = true;
  broadcast(room, { type: "stand_result", playerId: player.id });

  const opp = getOpponent(room, player.id);
  if (room.stood[opp.id]) endRound(room);
  else {
    room.currentTurnPlayerId = opp.id;
    broadcast(room, {
      type: "turn_change",
      currentTurnPlayerId: room.currentTurnPlayerId
    });
  }
}

/* ===================== ROUND END ===================== */

function endRound(room, bustedId = null) {
  if (room.processingRound) return;
  room.processingRound = true;

  const [a, b] = room.players;
  const va = handValue(room.hands[a.id]);
  const vb = handValue(room.hands[b.id]);

  let winnerId = null;
  if (bustedId) winnerId = bustedId === a.id ? b.id : a.id;
  else if (va !== vb) winnerId = va > vb ? a.id : b.id;

  const damage = Math.min(room.round, 7);
  if (winnerId) {
    const loser = winnerId === a.id ? b.id : a.id;
    room.health[loser] = Math.max(0, room.health[loser] - damage);
  }

  room.players.forEach(p => {
    const opp = getOpponent(room, p.id);
    p.ws.send(JSON.stringify({
      type: "round_end",
      winnerId,
      health: { you: room.health[p.id], opponent: room.health[opp.id] }
    }));
  });

  const dead = room.players.find(p => room.health[p.id] <= 0);
  if (dead) {
    const winner = getOpponent(room, dead.id);
    broadcast(room, { type: "game_over", winnerId: winner.id });
    room.state = "game_over";
    broadcastRoomList();
    room.processingRound = false;
    return;
  }

  setTimeout(() => resetForNextRound(room), 1000);
}

function resetForNextRound(room) {
  room.round++;
  room.deck = createDeck();
  room.hands = {};
  room.stood = {};
  room.processingRound = false;
  room.currentTurnPlayerId = randomPlayerId(room);

  room.players.forEach(p => {
    room.hands[p.id] = [room.deck.pop(), room.deck.pop()];
    room.stood[p.id] = false;
  });

  room.players.forEach(p => {
    const opp = getOpponent(room, p.id);
    p.ws.send(JSON.stringify({
      type: "round_start",
      round: room.round,
      damage: Math.min(room.round, 7),
      yourHand: room.hands[p.id],
      yourValue: handValue(room.hands[p.id]),
      opponentCardCount: room.hands[opp.id].length,
      health: { you: room.health[p.id], opponent: room.health[opp.id] },
      currentTurnPlayerId: room.currentTurnPlayerId
    }));
  });
}

/* ===================== REMATCH ===================== */

function handleRematch(player) {
  const room = rooms.get(player.roomId);
  if (!room || room.state !== "game_over") return;

  room.rematchVotes.add(player.id);
  if (room.rematchVotes.size === room.players.length) {
    startGame(room);
  }
}

/* ===================== CONNECTION ===================== */

wss.on("connection", ws => {
  const player = { id: nextPlayerId++, ws, roomId: null, name: null};

  ws.send(JSON.stringify({ type: "welcome", playerId: player.id }));
  broadcastRoomList();

  ws.on("message", data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case "create_room": createRoom(player, msg); break;
      case "join_room": joinRoom(player, msg); break;
      case "leave_room": handleLeaveRoom(player); break;
      case "get_rooms": broadcastRoomList(); break;
      case "hit": handleHit(player); break;
      case "stand": handleStand(player); break;
      case "rematch": handleRematch(player); break;
    }
  });

  ws.on("close", () => {
    if (!player.roomId) return;
    const room = rooms.get(player.roomId);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== player.id);
    if (room.players.length === 0) rooms.delete(room.id);
    else room.state = "waiting";

    broadcastRoomList();
  });
});

/* ===================== START ===================== */

server.listen(PORT, () =>
  console.log("Server running on port", PORT)
);
