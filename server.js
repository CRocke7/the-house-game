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

io.on("connection", (socket) => {
  players[socket.id] = {
  x: 0,
  z: 0,
  rotation: 0,
  balance: 1000,
  color: ["#36c5f0", "#ff647c", "#ffd166", "#8b80f9"][
    Math.floor(Math.random() * 4)
  ]
};
  socket.emit("currentPlayers", players);
  socket.emit("balanceUpdate", players[socket.id].balance);  
  
  socket.broadcast.emit("playerJoined", {
    id: socket.id,
    player: players[socket.id]
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

    socket.broadcast.emit("playerMoved", {
      id: socket.id,
      player: players[socket.id]
    });
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    io.emit("playerLeft", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`The House server is running on port ${PORT}`);
});
