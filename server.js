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
  ".wav": "audio/wav",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = reqUrl.pathname;

  // 헬스 체크는 빠르게 응답
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  // 쿼리스트링은 제거하고 정적 파일만 제공
  const safePath = pathname === "/" ? "/index.html" : pathname;
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

const wss = new WebSocketServer({ server, path: "/ws" });
const rooms = new Map();
let nextId = 1;

const send = (ws, payload) => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
};

const broadcast = (room, payload) => {
  room.clients.forEach((client) => send(client, payload));
};

// 초기 게임 상태
const createState = () => ({
  left: { x: 140, y: 260, r: 26, speed: 6.4 },
  right: { x: 760, y: 260, r: 26, speed: 6.4 },
  puck: { x: 450, y: 260, r: 16, vx: 6.2, vy: 3.6 },
  scores: { left: 0, right: 0 },
  running: false,
  status: "스페이스를 누르면 시작!",
});

const bounds = {
  minX: 40,
  maxX: 900 - 40,
  minY: 40,
  maxY: 520 - 40,
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// 입력을 패들 위치에 반영
const applyInput = (paddle, input, scale = 1) => {
  const speed = paddle.speed * scale;
  if (input.up) paddle.y -= speed;
  if (input.down) paddle.y += speed;
  if (input.left) paddle.x -= speed;
  if (input.right) paddle.x += speed;
  return paddle;
};

// 상하 벽 충돌 처리
const handleWallCollision = (puck) => {
  let wall = false;
  if (puck.y - puck.r <= bounds.minY) {
    puck.y = bounds.minY + puck.r;
    puck.vy = Math.abs(puck.vy);
    wall = true;
  }
  if (puck.y + puck.r >= bounds.maxY) {
    puck.y = bounds.maxY - puck.r;
    puck.vy = -Math.abs(puck.vy);
    wall = true;
  }
  return wall;
};

// 좌우 벽(골라인 제외) 충돌 처리
const handleSideWalls = (puck) => {
  const goalHeight = 140;
  const goalTop = 520 / 2 - goalHeight / 2;
  const goalBottom = 520 / 2 + goalHeight / 2;
  const inGoalY = puck.y > goalTop && puck.y < goalBottom;
  let wall = false;

  if (!inGoalY && puck.x - puck.r <= bounds.minX) {
    puck.x = bounds.minX + puck.r;
    puck.vx = Math.abs(puck.vx);
    wall = true;
  }

  if (!inGoalY && puck.x + puck.r >= bounds.maxX) {
    puck.x = bounds.maxX - puck.r;
    puck.vx = -Math.abs(puck.vx);
    wall = true;
  }

  return wall;
};

// 퍽-패들 충돌 처리
const resolveCollision = (puck, paddle) => {
  const dx = puck.x - paddle.x;
  const dy = puck.y - paddle.y;
  const dist = Math.hypot(dx, dy);
  const minDist = puck.r + paddle.r;

  if (dist < minDist) {
    const angle = Math.atan2(dy, dx);
    puck.x = paddle.x + Math.cos(angle) * minDist;
    puck.y = paddle.y + Math.sin(angle) * minDist;
    const speed = Math.hypot(puck.vx, puck.vy) + 2.2;
    puck.vx = Math.cos(angle) * speed;
    puck.vy = Math.sin(angle) * speed;
    return true;
  }
  return false;
};

// 득점 후 리셋
const resetRound = (state, direction) => {
  state.left.x = 140;
  state.left.y = 260;
  state.right.x = 760;
  state.right.y = 260;
  state.puck.x = 450;
  state.puck.y = 260;
  state.puck.vx = 6.2 * direction;
  state.puck.vy = (Math.random() * 2.8 + 2.2) * (Math.random() > 0.5 ? 1 : -1);
};

// 서버 authoritative 물리 시뮬레이션
const stepRoom = (room) => {
  const state = room.state;
  const events = { wall: false, paddle: false, goal: false };

  if (!state.running) {
    return { state, events };
  }

  applyInput(state.left, room.inputs.left);
  applyInput(state.right, room.inputs.right);

  state.left.x = clamp(state.left.x, bounds.minX, 900 / 2 - 40);
  state.left.y = clamp(state.left.y, bounds.minY, bounds.maxY);
  state.right.x = clamp(state.right.x, 900 / 2 + 40, bounds.maxX);
  state.right.y = clamp(state.right.y, bounds.minY, bounds.maxY);

  const puck = state.puck;
  const steps = 3;
  for (let i = 0; i < steps; i += 1) {
    puck.x += puck.vx / steps;
    puck.y += puck.vy / steps;

    puck.vx *= 0.998;
    puck.vy *= 0.998;

    events.wall = handleWallCollision(puck) || handleSideWalls(puck) || events.wall;
    events.paddle = resolveCollision(puck, state.left) || resolveCollision(puck, state.right) || events.paddle;

    const goalHeight = 140;
    const goalTop = 520 / 2 - goalHeight / 2;
    const goalBottom = 520 / 2 + goalHeight / 2;

    if (puck.x - puck.r <= 20 && puck.y > goalTop && puck.y < goalBottom) {
      state.scores.right += 1;
      state.status = "플레이어 2 득점!";
      resetRound(state, 1);
      events.goal = true;
    }

    if (puck.x + puck.r >= 900 - 20 && puck.y > goalTop && puck.y < goalBottom) {
      state.scores.left += 1;
      state.status = "플레이어 1 득점!";
      resetRound(state, -1);
      events.goal = true;
    }

    if (state.scores.left >= 7 || state.scores.right >= 7) {
      state.running = false;
      state.status = state.scores.left > state.scores.right ? "플레이어 1 승리!" : "플레이어 2 승리!";
    }
  }

  return { state, events };
};

// 고정 틱으로 상태 브로드캐스트
const ensureRoomLoop = (room) => {
  if (room.timer) return;
  room.timer = setInterval(() => {
    const { state, events } = stepRoom(room);
    const payload = {
      left: state.left,
      right: state.right,
      puck: state.puck,
      scores: state.scores,
      running: state.running,
      status: state.status,
      events,
      time: Date.now(),
    };
    broadcast(room, { type: "state", payload });
  }, 16);
};

// WebSocket 연결 처리
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

    if (message.type === "ping") {
      send(ws, { type: "pong", at: message.at });
      return;
    }

    if (message.type === "join") {
      const roomCode = String(message.room || "").toUpperCase();
      if (!roomCode) return;

      let room = rooms.get(roomCode);
      if (!room) {
        room = {
          hostId: id,
          clients: new Map(),
          state: createState(),
          inputs: {
            left: { up: false, down: false, left: false, right: false },
            right: { up: false, down: false, left: false, right: false },
          },
          timer: null,
        };
        rooms.set(roomCode, room);
        ensureRoomLoop(room);
      }

      if (room.clients.size >= 2 && !room.clients.has(id)) {
        send(ws, { type: "full" });
        return;
      }

      room.clients.set(id, ws);
      ws.roomCode = roomCode;
      ws.side = room.hostId === id ? "left" : "right";
      const role = room.hostId === id ? "host" : "guest";
      send(ws, { type: "role", role, room: roomCode, side: ws.side });

      if (role === "guest") {
        const host = room.clients.get(room.hostId);
        if (host) send(host, { type: "guest-joined" });
      }
      return;
    }

    const roomCode = ws.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (message.type === "input" && message.payload && message.payload.input) {
      room.inputs[ws.side] = message.payload.input;
      if (ws.side === "right") {
        const host = room.clients.get(room.hostId);
        if (host) send(host, { type: "guest-input" });
      }
      return;
    }

    if (message.type === "control" && ws.id === room.hostId) {
      if (message.action === "toggle") {
        room.state.running = !room.state.running;
        room.state.status = room.state.running ? "경기 진행 중!" : "일시정지";
      }
      if (message.action === "reset") {
        room.state = createState();
      }
      return;
    }
  });

  ws.on("close", () => {
    const roomCode = ws.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;

    room.clients.delete(id);

    if (room.hostId === id) {
      broadcast(room, { type: "host-left" });
      clearInterval(room.timer);
      rooms.delete(roomCode);
      return;
    }

    const host = room.clients.get(room.hostId);
    if (host) send(host, { type: "guest-left" });

    if (room.clients.size === 0) {
      clearInterval(room.timer);
      rooms.delete(roomCode);
    }
  });
});

server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
