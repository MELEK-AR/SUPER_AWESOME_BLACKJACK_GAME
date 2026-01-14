// server.js
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
  shuffle(deck);
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function handValue(hand) {
  const sum = hand.reduce((a, c) => a + Number(c), 0);
  return sum > 21 ? 0 : sum;
}

/* ===================== LOBBY HELPERS ===================== */

function buildRoomList() {
  const list = [];
  for (const [roomId, room] of rooms.entries()) {
    list.push({
      roomId,
      players: room.players.map(p => p.name),
      state: room.state,
      mode: "classic"
    });
  }
  return list;
}

function broadcastRoomList() {
  const msg = JSON.stringify({
    type: "room_list",
    rooms: buildRoomList()
  });

  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

/* ===================== ROOM HELPERS ===================== */

function broadcast(room, payload) {
  const msg = JSON.stringify(payload);
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  });
}

function getOpponent(room, player) {
  return room.players.find(p => p.id !== player.id);
}

/* ===================== ROOM HANDLERS ===================== */

function handleCreateRoom(player, msg) {
  if (player.roomId !== null) return;

  const roomId = nextRoomId++;
  const room = {
    id: roomId,
    players: [player],
    state: "waiting",
    deck: null,
    hands: {},
    stood: {},
    currentTurnIndex: 0,
    health: {},
    round: 1,
    rematchVotes: new Set()
  };

  player.roomId = roomId;
  player.name = msg.name || `Player ${player.id}`;
  rooms.set(roomId, room);

  player.ws.send(JSON.stringify({ type: "room_created", roomId }));
  broadcastRoomList();
}

function handleGetRooms(player) {
  player.ws.send(JSON.stringify({
    type: "room_list",
    rooms: buildRoomList()
  }));
}

function handleJoinRoom(player, msg) {
  const room = rooms.get(msg.roomId);
  if (!room || room.state !== "waiting" || room.players.length >= 2) return;

  player.roomId = room.id;
  player.name = msg.name || `Player ${player.id}`;
  room.players.push(player);

  broadcastRoomList();

  if (room.players.length === 2) startGame(room);
}

/* ===================== GAME FLOW ===================== */

function startGame(room) {
  room.state = "running";
  room.deck = createDeck();
  room.hands = {};
  room.stood = {};
  room.currentTurnIndex = 0;
  room.round = 1;
  room.rematchVotes.clear();

  room.players.forEach(p => {
    room.hands[p.id] = [room.deck.pop(), room.deck.pop()];
    room.stood[p.id] = false;
    room.health[p.id] = 7;
  });

  room.players.forEach(p => {
    const opp = getOpponent(room, p);
    p.ws.send(JSON.stringify({
      type: "game_start",
      yourHand: room.hands[p.id],
      yourValue: handValue(room.hands[p.id]),
      opponentCardCount: room.hands[opp.id].length,
      health: { you: room.health[p.id], opponent: room.health[opp.id] },
      round: room.round,
      damage: 1,
      currentTurnPlayerId: room.players[0].id
    }));
  });
}

/* ===================== GAME ACTIONS ===================== */

function handleHit(player) {
  const room = rooms.get(player.roomId);
  
  if (room.players[room.currentTurnIndex].id !== player.id) return;

  const card = room.deck.pop();
  room.hands[player.id].push(card);
  const value = handValue(room.hands[player.id]);

  broadcast(room, {
    type: "hit_result",
    playerId: player.id,
    card,
    newValue: value
  });

  if (value > 21) {
    endRound(room, player.id);
  } else {
    room.currentTurnIndex = 1 - room.currentTurnIndex;
    broadcast(room, {
      type: "turn_change",
      currentTurnPlayerId: room.players[room.currentTurnIndex].id
    });
  }
}

function handleStand(player) {
  const room = rooms.get(player.roomId);

  room.stood[player.id] = true;
  broadcast(room, { type: "stand_result", playerId: player.id });

  const opp = getOpponent(room, player);
  if (room.stood[opp.id]) endRound(room);
  else {
    room.currentTurnIndex = 1 - room.currentTurnIndex;
    broadcast(room, {
      type: "turn_change",
      currentTurnPlayerId: room.players[room.currentTurnIndex].id
    });
  }
}

/* ===================== ROUND END ===================== */

function endRound(room, bustedId = null) {
  if (room.processingRound) return;
  room.processingRound = true;

  const [p1, p2] = room.players;
  const v1 = handValue(room.hands[p1.id]);
  const v2 = handValue(room.hands[p2.id]);

  // Determine winner
  let winnerId = null;
  if (bustedId) winnerId = bustedId === p1.id ? p2.id : p1.id;
  else if (v1 !== v2) winnerId = v1 > v2 ? p1.id : p2.id;

  const damage = Math.min(room.round, 7);
  if (winnerId) {
    const loserId = winnerId === p1.id ? p2.id : p1.id;
    room.health[loserId] = Math.max(0, room.health[loserId] - damage);
  }

  // Broadcast round results
  room.players.forEach(p => {
    const opp = getOpponent(room, p);
    p.ws.send(JSON.stringify({
      type: "round_end",
      winnerId,
      health: { you: room.health[p.id], opponent: room.health[opp.id] }
    }));
  });

  // Check for game over
  const deadPlayer = room.players.find(p => room.health[p.id] <= 0);
  if (deadPlayer) {
    const winner = getOpponent(room, deadPlayer);
    room.players.forEach(p => {
      p.ws.send(JSON.stringify({
        type: "game_over",
        winnerId: winner.id
      }));
    });
    room.processingRound = false; // allow server to accept new games later
    return;
  }

  // Schedule next round
  setTimeout(() => {
    resetForNextRound(room);
    room.processingRound = false; // now the round is unlocked
  }, 1000);
}

/* ===================== RESET FOR NEXT ROUND ===================== */

function resetForNextRound(room) {
  room.state = "running";
  room.round += 1;
  room.deck = createDeck();
  room.hands = {};
  room.stood = {};
  room.currentTurnIndex = 0;

  // Deal new hands
  room.players.forEach(p => {
    room.hands[p.id] = [room.deck.pop(), room.deck.pop()];
    room.stood[p.id] = false;
  });

  // Notify players of new round
  room.players.forEach(p => {
    const opp = getOpponent(room, p);
    p.ws.send(JSON.stringify({
      type: "round_start",
      round: room.round,
      damage: Math.min(room.round, 7),
      yourHand: room.hands[p.id],
      yourValue: handValue(room.hands[p.id]),
      opponentCardCount: room.hands[opp.id].length,
      health: { you: room.health[p.id], opponent: room.health[opp.id] },
      currentTurnPlayerId: room.players[room.currentTurnIndex].id
    }));
  });
}

/* ===================== REMATCH ===================== */

function handleRematch(player) {
  const room = rooms.get(player.roomId);
  if (!room || room.players.length < 2) return;

  room.rematchVotes.add(player.id);

  if (room.rematchVotes.size === room.players.length) {
    room.round = 1;
    room.health = {};
    room.players.forEach(p => room.health[p.id] = 7);

    startGame(room);
  }
}

/* ===================== CONNECTION ===================== */

wss.on("connection", ws => {
  const player = { id: nextPlayerId++, ws, roomId: null, name: null };

  ws.on("message", data => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    try {
      switch (msg.type) {
        case "create_room": handleCreateRoom(player, msg); break;
        case "get_rooms": handleGetRooms(player); break;
        case "join_room": handleJoinRoom(player, msg); break;
        case "rematch": handleRematch(player); break;
        case "hit": handleHit(player); break;
        case "stand": handleStand(player); break;
      }
    } catch (e) {
      console.error("Handler error:", e);
    }
  });

  ws.on("close", () => {
    if (player.roomId !== null) {
      const room = rooms.get(player.roomId);
      if (room) rooms.delete(room.id);
      broadcastRoomList();
    }
  });

  ws.send(JSON.stringify({ type: "welcome", playerId: player.id }));
  broadcastRoomList();
});

/* ===================== START ===================== */

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
