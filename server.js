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

io.on("connection", (socket) => {
  players[socket.id] = {
    x: 0,
    z: 0,
    rotation: 0,
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

  const names = ["Cherry", "Lemon", "Diamond", "Clover", "Seven"];

  const results = Array.from({ length: 3 }, () =>
    names[Math.floor(Math.random() * names.length)]
  );

  let payout = 0;

  if (results.every((name) => name === results[0])) {
    payout = bet * 5;
  } else if (
    results[0] === results[1] ||
    results[1] === results[2] ||
    results[0] === results[2]
  ) {
    payout = Math.floor(bet * 1.5);
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
  socket.on("disconnect", () => {
  const roomCode = playerRooms[socket.id];

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
