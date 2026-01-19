const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const port = process.env.PORT || 3000;
const baseDir = __dirname;

const mimeTypes = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
};

const server = http.createServer((req, res) => {
  const safePath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(baseDir, path.normalize(safePath));

  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();
let nextId = 1;

const send = (ws, payload) => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
};

const broadcast = (room, payload, exceptId) => {
  room.clients.forEach((client, id) => {
    if (id === exceptId) return;
    send(client, payload);
  });
};

wss.on("connection", (ws) => {
  const id = nextId++;
  ws.id = id;

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      return;
    }

    if (message.type === "join") {
      const roomCode = String(message.room || "").toUpperCase();
      if (!roomCode) return;

      let room = rooms.get(roomCode);
      if (!room) {
        room = { hostId: id, clients: new Map() };
        rooms.set(roomCode, room);
      }

      if (room.clients.size >= 2 && !room.clients.has(id)) {
        send(ws, { type: "full" });
        return;
      }

      room.clients.set(id, ws);
      const role = room.hostId === id ? "host" : "guest";
      send(ws, { type: "role", role, room: roomCode });

      if (role === "guest") {
        const host = room.clients.get(room.hostId);
        if (host) {
          send(host, { type: "guest-joined" });
        }
      }
      ws.roomCode = roomCode;
      return;
    }

    const roomCode = ws.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (message.type === "input" && room.hostId !== id) {
      const host = room.clients.get(room.hostId);
      if (host) {
        send(host, { type: "guest-input", payload: message.payload });
      }
    }

    if (message.type === "state" && room.hostId === id) {
      broadcast(room, { type: "state", payload: message.payload }, id);
    }
  });

  ws.on("close", () => {
    const roomCode = ws.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;

    room.clients.delete(id);

    if (room.hostId === id) {
      broadcast(room, { type: "host-left" });
      rooms.delete(roomCode);
      return;
    }

    const host = room.clients.get(room.hostId);
    if (host) {
      send(host, { type: "guest-left" });
    }

    if (room.clients.size === 0) {
      rooms.delete(roomCode);
    }
  });
});

server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
