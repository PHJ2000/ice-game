const http = require("http");
const path = require("path");
const express = require("express");
const { Server } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const CONFIG = require("./config.json");
const GameRoom = require("./server/GameRoom");

const port = process.env.PORT || 3000;
const baseDir = __dirname;

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const LOG_THRESHOLD = LOG_LEVELS[LOG_LEVEL] ?? LOG_LEVELS.info;
const log = {
  debug: (...args) => {
    if (LOG_THRESHOLD <= LOG_LEVELS.debug) console.log(...args);
  },
  info: (...args) => {
    if (LOG_THRESHOLD <= LOG_LEVELS.info) console.log(...args);
  },
  warn: (...args) => {
    if (LOG_THRESHOLD <= LOG_LEVELS.warn) console.warn(...args);
  },
  error: (...args) => {
    if (LOG_THRESHOLD <= LOG_LEVELS.error) console.error(...args);
  },
};

const app = express();

app.get("/health", (_req, res) => {
  res.status(200).type("text/plain").send("ok");
});

app.get("/config", (_req, res) => {
  res.set({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.send(JSON.stringify(CONFIG));
});

app.use("/node_modules", express.static(path.join(baseDir, "node_modules")));
app.use(express.static(baseDir));

const server = http.createServer(app);

const gameServer = new Server({ transport: new WebSocketTransport({ server }) });
gameServer.define("air_hockey", GameRoom).filterBy(["roomCode"]);

gameServer.onShutdown(() => log.info("Game server shutting down"));

server.listen(port, () => {
  log.info(`Server running on http://localhost:${port}`);
});
