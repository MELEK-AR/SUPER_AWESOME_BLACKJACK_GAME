// server.js
const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Blackjack (21) WebSocket Server");
});

const wss = new WebSocket.Server({ server });

console.log("Blackjack (21) WebSocket Server running on port", PORT);

let nextPlayerId = 1;
let nextRoomId = 1;

// rooms: Map<roomId, room>
const rooms = new Map();

function createDeck() {
  const suits = ["Hearts", "Diamonds", "Clubs", "Spades"];
  const ranks = ["2","3","4","5","6","7","8","9","10","Jack","Queen","King","Ace"];
  const deck = [];
  for (const s of suits) {
    for (const r of ranks) {
      deck.push({ suit: s, rank: r });
    }
  }
  shuffle(deck);
  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function cardValue(rank) {
  if (rank === "Ace") return 11;
  if (["King","Queen","Jack","10"].includes(rank)) return 10;
  return parseInt(rank, 10);
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

function broadcastRoomList() {
  const roomsPayload = Array.from(rooms.values()).map(r => ({
    roomId: r.id,
    players: r.players.map(p => ({ id: p.id, name: p.name })),
    state: r.state,
    mode: r.mode
  }));

  const msg = JSON.stringify({
    type: "room_list",
    rooms: roomsPayload
  });

  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

function getOpponent(room, player) {
  return room.players.find(p => p.id !== player.id);
}

function handleCreateRoom(player, msg) {
  if (player.roomId != null) return;

  const roomId = nextRoomId++;

  const room = {
    id: roomId,
    players: [player],
    deck: null,
    hands: {},
    stood: {},
    currentTurnIndex: 0,
    state: "waiting",
    mode: "chainsaw"
  };

  player.roomId = roomId;
  player.name = msg.name || `Player ${player.id}`;
  rooms.set(roomId, room);

  player.ws.send(JSON.stringify({
    type: "room_created",
    roomId
  }));

  broadcastRoomList();
}

function handleJoinRoom(player, msg) {
  const room = rooms.get(msg.roomId);
  if (!room || room.state !== "waiting") {
    player.ws.send(JSON.stringify({
      type: "error",
      message: "Room not joinable"
    }));
    return;
  }

  player.roomId = room.id;
  player.name = msg.name || `Player ${player.id}`;
  room.players.push(player);

  // Initialize game
  room.state = "running";
  room.deck = createDeck();

  for (const p of room.players) {
    room.hands[p.id] = [room.deck.pop(), room.deck.pop()];
    room.stood[p.id] = false;
  }

  room.players.forEach(p => {
    const opp = getOpponent(room, p);
    p.ws.send(JSON.stringify({
      type: "game_start",
      roomId: room.id,
      you: { id: p.id, name: p.name },
      opponent: { id: opp.id, name: opp.name },
      yourHand: room.hands[p.id],
      opponentCardCount: room.hands[opp.id].length,
      yourValue: handValue(room.hands[p.id]),
      currentTurnPlayerId: room.players[0].id,
      mode: room.mode
    }));
  });

  broadcastRoomList();
}

function handleHit(player) {
  const room = rooms.get(player.roomId);
  if (!room || room.state !== "running") return;

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

  if (value > 21) endRound(room, "bust", player.id);
}

function handleStand(player) {
  const room = rooms.get(player.roomId);
  if (!room || room.state !== "running") return;

  room.stood[player.id] = true;
  broadcast(room, { type: "stand_result", playerId: player.id });

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
  if (bustedId) winnerId = bustedId === p1.id ? p2.id : p1.id;
  else winnerId = v1 === v2 ? null : v1 > v2 ? p1.id : p2.id;

  broadcast(room, {
    type: "round_end",
    reason,
    winnerId,
    values: { [p1.id]: v1, [p2.id]: v2 },
    hands: room.hands
  });
}

wss.on("connection", (ws) => {
  const player = { id: nextPlayerId++, ws, roomId: null, name: null };

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    handleMessage(player, msg);
  });

  ws.on("close", () => handleDisconnect(player));

  ws.send(JSON.stringify({
    type: "welcome",
    playerId: player.id
  }));

  broadcastRoomList();
});

function handleMessage(player, msg) {
  switch (msg.type) {
    case "create_room": handleCreateRoom(player, msg); break;
    case "join_room": handleJoinRoom(player, msg); break;
    case "hit": handleHit(player); break;
    case "stand": handleStand(player); break;
  }
}

function handleDisconnect(player) {
  if (player.roomId != null) {
    const room = rooms.get(player.roomId);
    if (room) {
      const opp = room.players.find(p => p.id !== player.id);
      if (opp?.ws.readyState === WebSocket.OPEN) {
        opp.ws.send(JSON.stringify({ type: "opponent_left" }));
      }
      rooms.delete(room.id);
    }
  }
  broadcastRoomList();

}

server.listen(PORT, () => {
  console.log("Blackjack (21) WebSocket Server running on port", PORT);
});
