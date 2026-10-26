const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const players = {};
const playerRooms = {};
const rooms = new Set();
const recoveryCooldowns = {};
const chairOccupants = {};
const chairPositions = [
  { x: -12, z: -0.6 },
  { x: -10, z: -0.6 },
  { x: -8, z: -0.6 },

  { x: -2, z: 5.4 },
  { x: 0, z: 5.4 },
  { x: 2, z: 5.4 },

  { x: 8, z: -0.6 },
  { x: 10, z: -0.6 },
  { x: 12, z: -0.6 }
];

const blackjackGames = {};

function createBlackjackDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = [
    "A", "2", "3", "4", "5", "6", "7",
    "8", "9", "10", "J", "Q", "K"
  ];

  const deck = [];

  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ rank, suit });
    }
  }

  // Shuffle the deck.
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function blackjackDraw(game) {
  if (game.deck.length === 0) {
    game.deck = createBlackjackDeck();
  }

  return game.deck.pop();
}

function blackjackScore(cards) {
  let total = 0;
  let aces = 0;

  for (const card of cards) {
    if (card.rank === "A") {
      total += 11;
      aces++;
    } else if (["K", "Q", "J"].includes(card.rank)) {
      total += 10;
    } else {
      total += Number(card.rank);
    }
  }

  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }

  return total;
}

function blackjackNatural(cards) {
  return cards.length === 2 && blackjackScore(cards) === 21;
}

function sendBlackjackState(socket, game, revealDealer = false) {
  socket.emit("blackjackState", {
    playerCards: game.playerCards,
    dealerCards: revealDealer
      ? game.dealerCards
      : [game.dealerCards[0], { hidden: true }],
    playerTotal: blackjackScore(game.playerCards),
    dealerTotal: revealDealer
      ? blackjackScore(game.dealerCards)
      : null,
    bet: game.bet,
    phase: game.phase
  });
}

function finishBlackjack(socket, player, game, outcome, payout) {
  player.balance += payout;

  game.phase = "finished";

  socket.emit("balanceUpdate", player.balance);

  socket.emit("blackjackResult", {
    outcome,
    payout,
    net: payout - game.bet,
    playerCards: game.playerCards,
    dealerCards: game.dealerCards,
    playerTotal: blackjackScore(game.playerCards),
    dealerTotal: blackjackScore(game.dealerCards),
    bet: game.bet,
    balance: player.balance
  });

  delete blackjackGames[socket.id];
}
io.on("connection", (socket) => {
  players[socket.id] = {
  x: 0,
  z: 0,
  rotation: 0,
  isSitting: false,
  chairId: null,
  balance: 1000,
    lastRecoveryTime: 0,
    color: ["#36c5f0", "#ff647c", "#ffd166", "#8b80f9"][
      Math.floor(Math.random() * 4)
    ]
  };
  
  socket.emit("balanceUpdate", players[socket.id].balance); 
  socket.on("createRoom", () => {
  let roomCode;

  do {
    roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (rooms.has(roomCode));

  rooms.add(roomCode);
  playerRooms[socket.id] = roomCode;
  socket.join(roomCode);

  socket.emit("roomJoined", roomCode);
});

socket.on("joinRoom", (code) => {
  if (typeof code !== "string") {
    socket.emit("roomError", "Enter a valid room code.");
    return;
  }

  const roomCode = code.trim().toUpperCase();

  if (!rooms.has(roomCode)) {
    socket.emit("roomError", "That room doesn't exist. Check the code and try again.");
    return;
  }

  const existingPlayers = {};

  for (const [id, player] of Object.entries(players)) {
    if (playerRooms[id] === roomCode) {
      existingPlayers[id] = player;
    }
  }

  playerRooms[socket.id] = roomCode;
  socket.join(roomCode);

  socket.emit("currentPlayers", existingPlayers);
  socket.emit("roomJoined", roomCode);

  socket.to(roomCode).emit("playerJoined", {
    id: socket.id,
    player: players[socket.id]
  });
});  

  socket.on("move", (position) => {
    if (!players[socket.id]) return;

    const { x, z, rotation } = position;

    if (
      typeof x !== "number" ||
      typeof z !== "number" ||
      typeof rotation !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(z) ||
      !Number.isFinite(rotation)
    ) return;

    players[socket.id].x = Math.max(-45, Math.min(45, x));
    players[socket.id].z = Math.max(-45, Math.min(45, z));
    players[socket.id].rotation = rotation;

    if (!playerRooms[socket.id]) return;    
    
    socket.to(playerRooms[socket.id]).emit("playerMoved", {
      id: socket.id,
      player: players[socket.id]
    });
  });
  socket.on("sitDown", (chairId) => {
    const player = players[socket.id];
    const roomCode = playerRooms[socket.id];

    if (!player || !roomCode) return;

    if (
      !Number.isInteger(chairId) ||
      chairId < 0 ||
      chairId >= 9
    ) {
      socket.emit("sitError", "That chair is invalid.");
      return;
    }

    const chairKey = `${roomCode}:${chairId}`;
    const occupant = chairOccupants[chairKey];

    if (occupant && occupant !== socket.id) {
      socket.emit("sitError", "That chair is already occupied.");
      return;
    }

    // Release the player's previous chair, if necessary.
    if (player.chairId !== null) {
      const oldKey = `${roomCode}:${player.chairId}`;

      if (chairOccupants[oldKey] === socket.id) {
        delete chairOccupants[oldKey];
      }
    }

    chairOccupants[chairKey] = socket.id;

player.isSitting = true;
player.chairId = chairId;

player.x = chairPositions[chairId].x;
player.z = chairPositions[chairId].z;

socket.emit("sitAccepted", chairId);
    
    io.to(roomCode).emit("playerMoved", {
      id: socket.id,
      player
    });
  });

  socket.on("standUp", () => {
    const player = players[socket.id];
    const roomCode = playerRooms[socket.id];

    if (!player || !roomCode || !player.isSitting) return;

    if (player.chairId !== null) {
      const chairKey = `${roomCode}:${player.chairId}`;

      if (chairOccupants[chairKey] === socket.id) {
        delete chairOccupants[chairKey];
      }
    }

    player.isSitting = false;
    player.chairId = null;

    io.to(roomCode).emit("playerMoved", {
      id: socket.id,
      player
    });
  });
 
  socket.on("slotSpin", (bet) => {
  const player = players[socket.id];

  if (!player) return;

  if (
    typeof bet !== "number" ||
    !Number.isInteger(bet) ||
    bet < 100 ||
    bet > player.balance
  ) {
    socket.emit("slotSpinError", "Bet must be at least $100 and no more than your balance.");
    return;
  }

  player.balance -= bet;

  const symbols = [
  { name: "Cherry", weight: 45 },
  { name: "Lemon", weight: 30 },
  { name: "Clover", weight: 15 },
  { name: "Diamond", weight: 7 },
  { name: "Seven", weight: 3 }
];

function spinReel() {
  const totalWeight = symbols.reduce((sum, symbol) => sum + symbol.weight, 0);
  let roll = Math.random() * totalWeight;

  for (const symbol of symbols) {
    roll -= symbol.weight;
    if (roll < 0) return symbol.name;
  }

  return symbols[0].name;
}

const results = Array.from({ length: 3 }, () => spinReel());
  let payout = 0;

  if (results.every((name) => name === results[0])) {
    payout = bet * 5;
  } else if (
    results[0] === results[1] ||
    results[1] === results[2] ||
    results[0] === results[2]
  ) {
    payout = Math.floor(bet * 2.0 );
  }

  player.balance += payout;

  socket.emit("balanceUpdate", player.balance);
  socket.emit("slotSpinResult", { results, payout, bet });
});  
  socket.on("rouletteSpin", (betData) => {
    const player = players[socket.id];
    if (!player) return;

    if (
      !betData ||
      typeof betData.amount !== "number" ||
      !Number.isInteger(betData.amount) ||
      betData.amount < 10 ||
      betData.amount > player.balance
    ) {
      socket.emit("rouletteSpinError", "Bet must be at least $10 and no more than your balance.");
      return;
    }

    const validTypes = ["red", "black", "odd", "even", "number"];
    if (!validTypes.includes(betData.type)) {
      socket.emit("rouletteSpinError", "Choose a valid roulette bet.");
      return;
    }

    if (
      betData.type === "number" &&
      (!Number.isInteger(betData.number) ||
        betData.number < 0 ||
        betData.number > 36)
    ) {
      socket.emit("rouletteSpinError", "Choose a number from 0 to 36.");
      return;
    }

    const amount = betData.amount;
    const redNumbers = new Set([
      1, 3, 5, 7, 9, 12, 14, 16, 18,
      19, 21, 23, 25, 27, 30, 32, 34, 36
    ]);

    player.balance -= amount;

    const result = Math.floor(Math.random() * 37);
    const color = result === 0
      ? "green"
      : redNumbers.has(result) ? "red" : "black";

    let won = false;

    if (betData.type === "number") {
      won = result === betData.number;
    } else if (betData.type === "red" || betData.type === "black") {
      won = color === betData.type;
    } else if (betData.type === "odd") {
      won = result !== 0 && result % 2 === 1;
    } else if (betData.type === "even") {
      won = result !== 0 && result % 2 === 0;
    }

    const payout = won
      ? amount * (betData.type === "number" ? 36 : 2)
      : 0;

    player.balance += payout;

   socket.emit("balanceUpdate", player.balance);
    socket.emit("rouletteSpinResult", {
  result,
  color,
  won,
  payout,
  net: payout - amount,
  bet: amount,
  type: betData.type
});
  });   
  socket.on("claimRecovery", () => {
  const player = players[socket.id];
  if (!player) return;

  const now = Date.now();
  const cooldown = 24 * 60 * 60 * 1000;
  const lastRecovery = recoveryCooldowns[socket.id] || 0;

  if (player.balance > 0) {
    socket.emit("recoveryMessage", "You can only claim recovery money when your balance is $0.");
    return;
  }

  if (now - lastRecovery < cooldown) {
    const hoursLeft = Math.ceil((cooldown - (now - lastRecovery)) / (60 * 60 * 1000));
    socket.emit("recoveryMessage", `Your next recovery allowance is available in about ${hoursLeft} hour(s).`);
    return;
  }

  player.balance = 500;
  recoveryCooldowns[socket.id] = now;

  socket.emit("balanceUpdate", player.balance);
  socket.emit("recoveryMessage", "Recovery allowance claimed! You received $500.");
}); 

  socket.on("blackjackDeal", (bet) => {
    const player = players[socket.id];

    if (!player) return;

    if (blackjackGames[socket.id]) {
      socket.emit("blackjackError", "Finish your current hand first.");
      return;
    }

    if (
      !Number.isSafeInteger(bet) ||
      bet < 10 ||
      bet > player.balance
    ) {
      socket.emit(
        "blackjackError",
        "Bet must be at least $10 and no more than your balance."
      );
      return;
    }

    player.balance -= bet;

    const game = {
      deck: createBlackjackDeck(),
      playerCards: [],
      dealerCards: [],
      bet,
      phase: "playing"
    };

    blackjackGames[socket.id] = game;

    game.playerCards.push(blackjackDraw(game));
    game.dealerCards.push(blackjackDraw(game));
    game.playerCards.push(blackjackDraw(game));
    game.dealerCards.push(blackjackDraw(game));

    socket.emit("balanceUpdate", player.balance);

    const playerNatural = blackjackNatural(game.playerCards);
    const dealerNatural = blackjackNatural(game.dealerCards);

    if (playerNatural && dealerNatural) {
      finishBlackjack(socket, player, game, "push", bet);
      return;
    }

    if (playerNatural) {
      finishBlackjack(
        socket,
        player,
        game,
        "blackjack",
        bet + Math.floor(bet * 1.5)
      );
      return;
    }

    if (dealerNatural) {
      finishBlackjack(socket, player, game, "dealer_blackjack", 0);
      return;
    }

    sendBlackjackState(socket, game);
  });

  socket.on("blackjackHit", () => {
    const player = players[socket.id];
    const game = blackjackGames[socket.id];

    if (!player || !game || game.phase !== "playing") return;

    game.playerCards.push(blackjackDraw(game));

    const total = blackjackScore(game.playerCards);

    if (total > 21) {
      finishBlackjack(socket, player, game, "bust", 0);
      return;
    }

    sendBlackjackState(socket, game);
  });

  socket.on("blackjackStand", () => {
    const player = players[socket.id];
    const game = blackjackGames[socket.id];

    if (!player || !game || game.phase !== "playing") return;

    game.phase = "dealer";

    while (blackjackScore(game.dealerCards) < 17) {
      game.dealerCards.push(blackjackDraw(game));
    }

    const playerTotal = blackjackScore(game.playerCards);
    const dealerTotal = blackjackScore(game.dealerCards);

    if (dealerTotal > 21) {
      finishBlackjack(socket, player, game, "dealer_bust", game.bet * 2);
    } else if (playerTotal > dealerTotal) {
      finishBlackjack(socket, player, game, "win", game.bet * 2);
    } else if (playerTotal < dealerTotal) {
      finishBlackjack(socket, player, game, "lose", 0);
    } else {
      finishBlackjack(socket, player, game, "push", game.bet);
    }
  });
  
  socket.on("disconnect", () => {
  const roomCode = playerRooms[socket.id];
   if (roomCode) {
    for (const [chairKey, occupantId] of Object.entries(chairOccupants)) {
      if (
        chairKey.startsWith(`${roomCode}:`) &&
        occupantId === socket.id
      ) {
        delete chairOccupants[chairKey];
      }
    }
  }
    
  delete players[socket.id];
  delete playerRooms[socket.id];

  if (roomCode) {
    socket.to(roomCode).emit("playerLeft", socket.id);

    const roomStillExists = Object.values(playerRooms).includes(roomCode);

    if (!roomStillExists) {
      rooms.delete(roomCode);
    }
  }
});
}); // Closes io.on("connection")
const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`The House server is running on port ${PORT}`);
});
