// server.js
// Einfacher WebSocket-Server für ein 2-Spieler-Blackjack (21) Spiel

const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log("Blackjack (21) WebSocket Server läuft auf Port", PORT);

// Globale IDs
let nextPlayerId = 1;
let nextRoomId = 1;

// Wartender Spieler für Matchmaking
let waitingPlayer = null;

// rooms: Map<roomId, room>
const rooms = new Map();

/**
 * Hilfsfunktionen: Karten-Deck & Blackjack-Logik
 */

function createDeck() {
  const suits = ["H", "D", "C", "S"]; // Herz, Karo, Kreuz, Pik
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
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
  if (rank === "A") return 11;
  if (rank === "K" || rank === "Q" || rank === "J" || rank === "10") return 10;
  return parseInt(rank, 10);
}

function handValue(hand) {
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    total += cardValue(card.rank);
    if (card.rank === "A") aces++;
  }
  // Asse von 11 auf 1 herabsetzen, falls nötig
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function broadcast(room, messageObj) {
  const msg = JSON.stringify(messageObj);
  for (const p of room.players) {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  }
}

function getOpponent(room, player) {
  return room.players[0].id === player.id ? room.players[1] : room.players[0];
}

function safeMode(mode) {
  const allowed = ["chainsaw", "fingers", "shock"];
  return allowed.includes(mode) ? mode : "chainsaw";
}

/**
 * Raum-Erstellung und Runden-Logik
 */

function createRoom(player1, player2) {
  const roomId = nextRoomId++;
  const deck = createDeck();

  const room = {
    id: roomId,
    players: [player1, player2],
    deck,
    hands: {}, // key: playerId -> array of cards
    stood: {}, // key: playerId -> boolean
    currentTurnIndex: 0, // 0 oder 1
    mode: "chainsaw", // default Tortur-Mode (rein kosmetisch für dein Game)
    state: "running" // or "finished"
  };

  rooms.set(roomId, room);
  player1.roomId = roomId;
  player2.roomId = roomId;

  // Anfangskarten austeilen (2 Karten für jeden)
  for (const p of room.players) {
    room.hands[p.id] = [room.deck.pop(), room.deck.pop()];
    room.stood[p.id] = false;
  }

  // Start-Message an beide Spieler
  for (const p of room.players) {
    const opponent = getOpponent(room, p);
    const youHand = room.hands[p.id];
    const oppHandCount = room.hands[opponent.id].length;

    p.ws.send(
      JSON.stringify({
        type: "game_start",
        roomId: room.id,
        you: {
          id: p.id,
          name: p.name
        },
        opponent: {
          id: opponent.id,
          name: opponent.name
        },
        yourHand: youHand,
        opponentCardCount: oppHandCount,
        yourValue: handValue(youHand),
        mode: room.mode,
        currentTurnPlayerId: room.players[room.currentTurnIndex].id
      })
    );
  }

  console.log(
    `Neuer Raum #${room.id} erstellt mit Spielern ${player1.id} und ${player2.id}`
  );
}

function endRound(room, reason, bustedPlayerId = null) {
  room.state = "finished";

  const p1 = room.players[0];
  const p2 = room.players[1];
  const v1 = handValue(room.hands[p1.id]);
  const v2 = handValue(room.hands[p2.id]);

  let winnerId = null;

  if (bustedPlayerId) {
    // Wenn einer über 21 ist, gewinnt der andere
    winnerId = p1.id === bustedPlayerId ? p2.id : p1.id;
  } else {
    // Beide stehen: wer näher an 21 gewinnt, bei Gleichstand: Unentschieden
    const diff1 = v1 > 21 ? Infinity : 21 - v1;
    const diff2 = v2 > 21 ? Infinity : 21 - v2;

    if (diff1 < diff2) {
      winnerId = p1.id;
    } else if (diff2 < diff1) {
      winnerId = p2.id;
    } else {
      winnerId = null; // draw
    }
  }

  broadcast(room, {
    type: "round_end",
    reason, // "bust", "both_stand" etc.
    winnerId,
    values: {
      [p1.id]: v1,
      [p2.id]: v2
    },
    hands: {
      [p1.id]: room.hands[p1.id],
      [p2.id]: room.hands[p2.id]
    }
  });

  console.log(
    `Runde in Raum #${room.id} beendet. Gewinner: ${winnerId ?? "Unentschieden"}`
  );
}

/**
 * WebSocket-Handling
 */

wss.on("connection", (ws) => {
  const player = {
    id: nextPlayerId++,
    ws,
    roomId: null,
    name: null
  };

  console.log("Spieler verbunden:", player.id);

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      console.warn("Ungültiges JSON:", data.toString());
      return;
    }

    handleMessage(player, msg);
  });

  ws.on("close", () => {
    console.log("Spieler getrennt:", player.id);
    handleDisconnect(player);
  });

  // Optional: automatisch "join" auslösen oder auf Client warten, der join schickt
  // Hier: wir warten auf eine "join"-Message vom Client.
});

function handleMessage(player, msg) {
  const type = msg.type;

  switch (type) {
    case "join":
      handleJoin(player, msg);
      break;
    case "set_mode":
      handleSetMode(player, msg);
      break;
    case "hit":
      handleHit(player);
      break;
    case "stand":
      handleStand(player);
      break;
    default:
      console.warn("Unbekannter Nachrichtentyp:", type);
  }
}

function handleJoin(player, msg) {
  // Name optional
  player.name = msg.name || `Player ${player.id}`;

  if (!waitingPlayer) {
    waitingPlayer = player;
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(
        JSON.stringify({
          type: "waiting",
          message: "Warte auf zweiten Spieler..."
        })
      );
    }
  } else {
    // Matchmaking: Zweiter Spieler gefunden
    const p1 = waitingPlayer;
    const p2 = player;
    waitingPlayer = null;
    createRoom(p1, p2);
  }
}

function handleSetMode(player, msg) {
  const room = rooms.get(player.roomId);
  if (!room || room.state !== "running") {
    return;
  }
  // Nur erlaubte Modi
  const mode = safeMode(msg.mode);
  room.mode = mode;

  broadcast(room, {
    type: "mode_update",
    mode
  });

  console.log(`Raum #${room.id} Tortur-Mode gesetzt auf: ${mode}`);
}

function handleHit(player) {
  const room = rooms.get(player.roomId);
  if (!room || room.state !== "running") return;

  const currentPlayer = room.players[room.currentTurnIndex];
  if (currentPlayer.id !== player.id) {
    // Nicht dein Zug
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(
        JSON.stringify({
          type: "error",
          message: "Du bist nicht am Zug."
        })
      );
    }
    return;
  }

  const card = room.deck.pop();
  room.hands[player.id].push(card);

  const newValue = handValue(room.hands[player.id]);

  broadcast(room, {
    type: "hit_result",
    playerId: player.id,
    card,
    newValue
  });

  if (newValue > 21) {
    // Bust -> Runde vorbei
    endRound(room, "bust", player.id);
  }
}

function handleStand(player) {
  const room = rooms.get(player.roomId);
  if (!room || room.state !== "running") return;

  const currentPlayer = room.players[room.currentTurnIndex];
  if (currentPlayer.id !== player.id) {
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(
        JSON.stringify({
          type: "error",
          message: "Du bist nicht am Zug."
        })
      );
    }
    return;
  }

  room.stood[player.id] = true;

  broadcast(room, {
    type: "stand_result",
    playerId: player.id
  });

  const otherPlayer = getOpponent(room, player);

  if (room.stood[otherPlayer.id]) {
    // Beide stehen -> Gewinner ermitteln
    endRound(room, "both_stand");
  } else {
    // Zug an den anderen Spieler
    room.currentTurnIndex = room.currentTurnIndex === 0 ? 1 : 0;
    broadcast(room, {
      type: "turn_change",
      currentTurnPlayerId: room.players[room.currentTurnIndex].id
    });
  }
}

function handleDisconnect(player) {
  // Falls er der wartende Spieler war
  if (waitingPlayer && waitingPlayer.id === player.id) {
    waitingPlayer = null;
  }

  if (player.roomId != null) {
    const room = rooms.get(player.roomId);
    if (room) {
      // Raum als beendet markieren
      room.state = "finished";

      // Gegner informieren
      const opponent = room.players.find((p) => p.id !== player.id);
      if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
        opponent.ws.send(
          JSON.stringify({
            type: "opponent_left",
            message: "Dein Gegner hat die Verbindung verloren."
          })
        );
      }

      rooms.delete(room.id);
      console.log("Raum entfernt wegen Disconnect:", room.id);
    }
  }
}
