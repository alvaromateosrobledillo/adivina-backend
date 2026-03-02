const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = Number(process.env.PORT || 4000);
const ROOM_CODE = process.env.ROOM_CODE || "FUTBOL";

const connectedSockets = new Set();
const socketRegistry = new Map();
const connectedPlayers = new Map();

const state = {
  phase: "setup",
  games: [],
  currentGameIndex: 0,
  currentClueIndex: 0,
  buzzes: [],
  winner: null,
  roomCode: ROOM_CODE,
  pausedBy: null,
  registeredSubjects: [],
};

function sortPlayers(players) {
  return [...players].sort((a, b) => a.joinedAt - b.joinedAt);
}

function sortBuzzes(buzzes) {
  return [...buzzes].sort((a, b) => a.time - b.time);
}

function getSessionSnapshot() {
  const players = sortPlayers(connectedPlayers.values());

  return {
    phase: state.phase,
    games: state.games,
    currentGameIndex: state.currentGameIndex,
    currentClueIndex: state.currentClueIndex,
    players,
    connectedPlayersCount: players.length,
    connectedClientsCount: connectedSockets.size,
    buzzes: sortBuzzes(state.buzzes),
    winner: state.winner,
    roomCode: state.roomCode,
    pausedBy: state.pausedBy,
    registeredSubjects: state.registeredSubjects,
    registeredSubjectsCount: state.registeredSubjects.length,
  };
}

function broadcastState() {
  const snapshot = getSessionSnapshot();
  io.emit("session:state", snapshot);
  io.emit("players_count", snapshot.connectedPlayersCount);
  io.emit("game_paused", { paused: snapshot.phase === "paused", by: snapshot.pausedBy });
}

function createGameSafe(game, index) {
  const id = Number.isInteger(game?.id) ? game.id : index + 1;
  const answer = typeof game?.answer === "string" ? game.answer.trim() : "";
  const rawClues = Array.isArray(game?.clues) ? game.clues : [];
  const clues = rawClues
    .map((clue) => {
      const type = clue?.type === "image" ? "image" : "text";
      const content = typeof clue?.content === "string" ? clue.content.trim() : "";
      return { type, content };
    })
    .filter((clue) => clue.content.length > 0);

  return {
    id,
    clues,
    answer,
  };
}

function setGames(games = []) {
  const sanitizedGames = games
    .map((game, index) => createGameSafe(game, index))
    .filter((game) => game.answer.length > 0 && game.clues.length > 0);

  state.games = sanitizedGames;
  state.phase = "setup";
  state.currentGameIndex = 0;
  state.currentClueIndex = 0;
  state.buzzes = [];
  state.winner = null;
  state.pausedBy = null;
}

function openLobby() {
  state.phase = "lobby";
  state.currentGameIndex = 0;
  state.currentClueIndex = 0;
  state.buzzes = [];
  state.winner = null;
  state.pausedBy = null;
}

function startGame() {
  if (state.games.length === 0) {
    return { ok: false, reason: "No hay juegos configurados." };
  }

  if (connectedPlayers.size === 0) {
    return { ok: false, reason: "No hay jugadores conectados." };
  }

  state.phase = "playing";
  state.currentClueIndex = 0;
  state.buzzes = [];
  state.winner = null;
  state.pausedBy = null;
  return { ok: true };
}

function pauseGame(by = null) {
  if (state.phase !== "playing") {
    return { ok: false, reason: "Solo se puede pausar cuando el juego está en curso." };
  }

  state.phase = "paused";
  state.pausedBy = by;
  return { ok: true };
}

function resumeGame() {
  if (state.phase !== "paused") {
    return { ok: false, reason: "El juego no está en pausa." };
  }

  state.phase = "playing";
  state.pausedBy = null;
  return { ok: true };
}

function registerPlayer(socketId, payload = {}) {
  const rawId = typeof payload.playerId === "string" ? payload.playerId.trim() : "";
  const rawName = typeof payload.playerName === "string" ? payload.playerName.trim() : "";

  if (!rawId) {
    return { ok: false, reason: "playerId es obligatorio." };
  }

  if (!rawName) {
    return { ok: false, reason: "playerName es obligatorio." };
  }

  const existingSocketMeta = socketRegistry.get(socketId) || {};
  socketRegistry.set(socketId, {
    ...existingSocketMeta,
    role: "player",
    playerId: rawId,
  });

  connectedPlayers.set(rawId, {
    id: rawId,
    name: rawName,
    joinedAt: Date.now(),
    socketId,
  });

  return { ok: true };
}

function playerBuzz(payload = {}) {
  if (state.phase !== "playing") {
    return { ok: false, reason: "Solo se puede pulsar durante una ronda activa." };
  }

  const playerId = typeof payload.playerId === "string" ? payload.playerId.trim() : "";
  if (!playerId) {
    return { ok: false, reason: "playerId es obligatorio." };
  }

  const player = connectedPlayers.get(playerId);
  if (!player) {
    return { ok: false, reason: "Jugador no registrado o desconectado." };
  }

  const alreadyBuzzed = state.buzzes.some((entry) => entry.playerId === playerId);
  if (alreadyBuzzed) {
    return { ok: false, reason: "Este jugador ya pulsó en esta ronda." };
  }

  state.buzzes.push({
    playerId,
    playerName: player.name,
    time: Date.now(),
  });
  state.phase = "paused";
  state.pausedBy = player.name;
  return { ok: true };
}

function markCorrect(payload = {}) {
  const playerId = typeof payload.playerId === "string" ? payload.playerId.trim() : "";
  if (!playerId) {
    return { ok: false, reason: "playerId es obligatorio." };
  }

  const buzz = state.buzzes.find((entry) => entry.playerId === playerId);
  if (!buzz) {
    return { ok: false, reason: "No existe una pulsación para ese jugador." };
  }

  const currentGame = state.games[state.currentGameIndex];
  state.buzzes = state.buzzes.map((entry) =>
    entry.playerId === playerId ? { ...entry, result: "correct" } : entry
  );
  state.phase = "victory";
  state.winner = {
    playerName: buzz.playerName,
    answer: currentGame?.answer || "",
  };
  state.pausedBy = null;
  return { ok: true };
}

function markWrong(payload = {}) {
  const playerId = typeof payload.playerId === "string" ? payload.playerId.trim() : "";
  if (!playerId) {
    return { ok: false, reason: "playerId es obligatorio." };
  }

  const buzz = state.buzzes.find((entry) => entry.playerId === playerId);
  if (!buzz) {
    return { ok: false, reason: "No existe una pulsación para ese jugador." };
  }

  state.buzzes = state.buzzes.map((entry) =>
    entry.playerId === playerId ? { ...entry, result: "wrong" } : entry
  );
  state.phase = "paused";
  state.pausedBy = null;
  return { ok: true };
}

function nextGame() {
  const nextIndex = state.currentGameIndex + 1;
  state.buzzes = [];
  state.winner = null;
  state.currentClueIndex = 0;
  state.pausedBy = null;

  if (nextIndex >= state.games.length) {
    state.phase = "finished";
    return;
  }

  state.currentGameIndex = nextIndex;
  state.phase = "playing";
}

function syncRegisteredSubjects(payload = {}) {
  const incoming = Array.isArray(payload.items) ? payload.items : [];
  state.registeredSubjects = incoming
    .map((item) => {
      const id = typeof item?.id === "string" ? item.id.trim() : "";
      const name = typeof item?.name === "string" ? item.name.trim() : "";
      if (!id || !name) return null;
      return { id, name };
    })
    .filter(Boolean);
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    connectedClientsCount: connectedSockets.size,
    connectedPlayersCount: connectedPlayers.size,
    phase: state.phase,
  });
});

app.get("/session", (_req, res) => {
  res.json(getSessionSnapshot());
});

io.on("connection", (socket) => {
  connectedSockets.add(socket.id);
  socketRegistry.set(socket.id, { role: "viewer", playerId: null });

  socket.emit("session:state", getSessionSnapshot());
  broadcastState();

  socket.on("session:register-player", (payload, ack) => {
    const result = registerPlayer(socket.id, payload);
    if (!result.ok) {
      if (typeof ack === "function") ack(result);
      socket.emit("session:error", result);
      return;
    }

    if (typeof ack === "function") ack(result);
    broadcastState();
  });

  socket.on("register_player", (payload, ack) => {
    const result = registerPlayer(socket.id, payload);
    if (typeof ack === "function") ack(result);
    if (!result.ok) {
      socket.emit("session:error", result);
      return;
    }
    broadcastState();
  });

  socket.on("session:set-games", (payload = {}, ack) => {
    setGames(payload.games);
    const result = { ok: true };
    if (typeof ack === "function") ack(result);
    broadcastState();
  });

  socket.on("session:open-lobby", (_payload, ack) => {
    openLobby();
    const result = { ok: true };
    if (typeof ack === "function") ack(result);
    broadcastState();
  });

  socket.on("session:start-game", (_payload, ack) => {
    const result = startGame();
    if (typeof ack === "function") ack(result);
    if (!result.ok) {
      socket.emit("session:error", result);
      return;
    }
    broadcastState();
  });

  socket.on("session:buzz", (payload, ack) => {
    const result = playerBuzz(payload);
    if (typeof ack === "function") ack(result);
    if (!result.ok) {
      socket.emit("session:error", result);
      return;
    }
    broadcastState();
  });

  socket.on("session:mark-correct", (payload, ack) => {
    const result = markCorrect(payload);
    if (typeof ack === "function") ack(result);
    if (!result.ok) {
      socket.emit("session:error", result);
      return;
    }
    broadcastState();
  });

  socket.on("session:mark-wrong", (payload, ack) => {
    const result = markWrong(payload);
    if (typeof ack === "function") ack(result);
    if (!result.ok) {
      socket.emit("session:error", result);
      return;
    }
    broadcastState();
  });

  socket.on("session:resume", (_payload, ack) => {
    const result = resumeGame();
    if (typeof ack === "function") ack(result);
    if (!result.ok) {
      socket.emit("session:error", result);
      return;
    }
    broadcastState();
  });

  socket.on("session:pause", (payload, ack) => {
    const by = typeof payload?.by === "string" ? payload.by.trim() : null;
    const result = pauseGame(by);
    if (typeof ack === "function") ack(result);
    if (!result.ok) {
      socket.emit("session:error", result);
      return;
    }
    broadcastState();
  });

  socket.on("session:next-game", (_payload, ack) => {
    nextGame();
    const result = { ok: true };
    if (typeof ack === "function") ack(result);
    broadcastState();
  });

  socket.on("session:sync-registered-subjects", (payload, ack) => {
    syncRegisteredSubjects(payload);
    const result = { ok: true };
    if (typeof ack === "function") ack(result);
    broadcastState();
  });

  socket.on("pause_game", (payload) => {
    const by = typeof payload?.by === "string" ? payload.by : typeof payload === "string" ? payload : null;
    const result = pauseGame(by);
    if (!result.ok) {
      socket.emit("session:error", result);
      return;
    }
    broadcastState();
  });

  socket.on("resume_game", () => {
    const result = resumeGame();
    if (!result.ok) {
      socket.emit("session:error", result);
      return;
    }
    broadcastState();
  });

  socket.on("disconnect", () => {
    connectedSockets.delete(socket.id);

    const meta = socketRegistry.get(socket.id);
    if (meta?.playerId) {
      const currentPlayer = connectedPlayers.get(meta.playerId);
      if (currentPlayer && currentPlayer.socketId === socket.id) {
        connectedPlayers.delete(meta.playerId);
      }
    }

    socketRegistry.delete(socket.id);
    broadcastState();
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
