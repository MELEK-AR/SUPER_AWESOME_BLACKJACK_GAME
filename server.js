// server.js
const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Blackjack (21) WebSocket Server");
});

const wss = new WebSocket.Server({ server });

let nextPlayerId = 1;
let nextRoomId = 1;
const rooms = new Map();

function createDeck() {
  const ranks = ["1","2","3","4","5","6","7","8","9","10","11"];
  const deck = ranks
  shuffle(deck);
  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function handValue(hand) {
  let total = 0;
  let aces = 0;

  for (const c of hand) {
    total += cardValue(c.rank);
    if (c.rank === "Ace") aces++;
  }

  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }

  return total;
}

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
}

function handleJoinRoom(player, msg) {
  const room = rooms.get(msg.roomId);
  if (!room || room.state !== "waiting" || room.players.length >= 2) return;

  player.roomId = room.id;
  player.name = msg.name || `Player ${player.id}`;
  room.players.push(player);

  // INIT GAME
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
      you: { id: p.id, name: p.name },
      opponent: { id: opp.id, name: opp.name },
      yourHand: room.hands[p.id],
      yourValue: handValue(room.hands[p.id]),
      opponentCardCount: room.hands[opp.id].length,
      health: room.health,
      round: room.round,
      damage: 1,
      currentTurnPlayerId: room.players[0].id
    }));
  });
}

function handleHit(player) {
  const room = rooms.get(player.roomId);
  if (!room || room.state !== "running") return;
  if (room.players[room.currentTurnIndex].id !== player.id) return;
  if (room.deck.length === 0) return;

  const card = room.deck.pop();
  room.hands[player.id].push(card);
  const value = handValue(room.hands[player.id]);

  broadcast(room, {
    type: "hit_result",
    playerId: player.id,
    card,
    value
  });

  if (value > 21) {
    endRound(room, "bust", player.id);
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
  if (!room || room.state !== "running") return;
  if (room.players[room.currentTurnIndex].id !== player.id) return;

  room.stood[player.id] = true;
  broadcast(room, { type: "stand", playerId: player.id });

  const opp = getOpponent(room, player);
  if (room.stood[opp.id]) {
    endRound(room, "both_stand");
  } else {
    room.currentTurnIndex = 1 - room.currentTurnIndex;
    broadcast(room, {
      type: "turn_change",
      currentTurnPlayerId: room.players[room.currentTurnIndex].id
    });
  }
}

function endRound(room, reason, bustedId = null) {
  room.state = "finished";

  const [p1, p2] = room.players;
  const v1 = handValue(room.hands[p1.id]);
  const v2 = handValue(room.hands[p2.id]);

  let winnerId = null;

  if (bustedId) {
    winnerId = bustedId === p1.id ? p2.id : p1.id;
  } else if (v1 !== v2) {
    winnerId = v1 > v2 ? p1.id : p2.id;
  }

  const damage = Math.min(room.round, 7);

  if (winnerId) {
    const loserId = winnerId === p1.id ? p2.id : p1.id;
    room.health[loserId] -= damage;
    if (room.health[loserId] < 0) room.health[loserId] = 0;
  }

  broadcast(room, {
    type: "round_end",
    reason,
    winnerId,
    values: { [p1.id]: v1, [p2.id]: v2 },
    health: room.health,
    damage,
    round: room.round
  });

  const dead = Object.entries(room.health).find(([_, hp]) => hp <= 0);
  if (dead) {
    broadcast(room, {
      type: "game_over",
      loserId: Number(dead[0])
    });
    rooms.delete(room.id);
  }
}

function handleRematch(player) {
  const room = rooms.get(player.roomId);
  if (!room || room.state !== "finished") return;

  room.rematchVotes.add(player.id);
  if (room.rematchVotes.size < 2) return;

  room.round++;
  room.state = "running";
  room.rematchVotes.clear();
  room.deck = createDeck();
  room.hands = {};
  room.stood = {};
  room.currentTurnIndex = 0;

  room.players.forEach(p => {
    room.hands[p.id] = [room.deck.pop(), room.deck.pop()];
    room.stood[p.id] = false;
  });

  broadcast(room, {
    type: "rematch_start",
    round: room.round,
    damage: Math.min(room.round, 7),
    health: room.health,
    currentTurnPlayerId: room.players[0].id
  });
}

wss.on("connection", (ws) => {
  const player = { id: nextPlayerId++, ws, roomId: null, name: null };

  ws.on("message", data => {
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(player, msg);
    } catch {}
  });

  ws.on("close", () => {
    if (player.roomId !== null) {
      const room = rooms.get(player.roomId);
      if (room) {
        const opp = room.players.find(p => p.id !== player.id);
        if (opp?.ws.readyState === WebSocket.OPEN) {
          opp.ws.send(JSON.stringify({ type: "opponent_left" }));
        }
        rooms.delete(room.id);
      }
    }
  });

  ws.send(JSON.stringify({ type: "welcome", playerId: player.id }));
});

function handleMessage(player, msg) {
  switch (msg.type) {
    case "create_room": handleCreateRoom(player, msg); break;
    case "join_room": handleJoinRoom(player, msg); break;
    case "hit": handleHit(player); break;
    case "stand": handleStand(player); break;
    case "rematch": handleRematch(player); break;
  }
}

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
