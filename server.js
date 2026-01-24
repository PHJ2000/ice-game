const http = require("http");
const fs = require("fs");
const path = require("path");
const planck = require("planck-js");
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

// 경기/물리 상수
const ARENA = { width: 900, height: 520 };
const WALL = 40;
const GOAL_HEIGHT = 140;
const SCALE = 0.01; // 1px = 0.01m
const TICK_RATE = 60;
const FIXED_DT = 1 / TICK_RATE;
const SUB_STEPS = 3;

const PADDLE_SPEED_PX_PER_FRAME = 6.4;
const PADDLE_SPEED_PX_PER_SEC = PADDLE_SPEED_PX_PER_FRAME * TICK_RATE;
const PADDLE_SPEED = PADDLE_SPEED_PX_PER_SEC * SCALE;

const PUCK_RADIUS_PX = 16;
const PUCK_RADIUS = PUCK_RADIUS_PX * SCALE;
const PUCK_INITIAL_VX_PX_PER_FRAME = 6.2;
const PUCK_INITIAL_VY_PX_PER_FRAME = 3.6;
const PUCK_INITIAL_VX_PX_PER_SEC = PUCK_INITIAL_VX_PX_PER_FRAME * TICK_RATE;
const PUCK_INITIAL_VY_PX_PER_SEC = PUCK_INITIAL_VY_PX_PER_FRAME * TICK_RATE;
const PUCK_INITIAL_VX = PUCK_INITIAL_VX_PX_PER_SEC * SCALE;
const PUCK_INITIAL_VY = PUCK_INITIAL_VY_PX_PER_SEC * SCALE;

const MAX_PUCK_SPEED_PX_PER_FRAME = 18;
const MAX_PUCK_SPEED_PX_PER_SEC = MAX_PUCK_SPEED_PX_PER_FRAME * TICK_RATE;
const MAX_PUCK_SPEED = MAX_PUCK_SPEED_PX_PER_SEC * SCALE;

const toWorld = (value) => value * SCALE;
const toPixel = (value) => value / SCALE;

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
  left: { x: 140, y: 260, r: 26 },
  right: { x: 760, y: 260, r: 26 },
  puck: {
    x: 450,
    y: 260,
    r: PUCK_RADIUS_PX,
    vx: PUCK_INITIAL_VX_PX_PER_SEC,
    vy: PUCK_INITIAL_VY_PX_PER_SEC,
  },
  scores: { left: 0, right: 0 },
  running: false,
  status: "스페이스를 누르면 시작!",
});

// 물리 월드 생성
const createPhysicsWorld = () => {
  const Vec2 = planck.Vec2;
  const world = planck.World(Vec2(0, 0));

  const wallBody = world.createBody();
  wallBody.setUserData("wall");

  const minX = toWorld(WALL);
  const maxX = toWorld(ARENA.width - WALL);
  const minY = toWorld(WALL);
  const maxY = toWorld(ARENA.height - WALL);

  const goalTop = toWorld(ARENA.height / 2 - GOAL_HEIGHT / 2);
  const goalBottom = toWorld(ARENA.height / 2 + GOAL_HEIGHT / 2);

  const wallFixture = { restitution: 0.98, friction: 0 };
  wallBody.createFixture(planck.Edge(Vec2(minX, minY), Vec2(maxX, minY)), wallFixture);
  wallBody.createFixture(planck.Edge(Vec2(minX, maxY), Vec2(maxX, maxY)), wallFixture);
  wallBody.createFixture(planck.Edge(Vec2(minX, minY), Vec2(minX, goalTop)), wallFixture);
  wallBody.createFixture(planck.Edge(Vec2(minX, goalBottom), Vec2(minX, maxY)), wallFixture);
  wallBody.createFixture(planck.Edge(Vec2(maxX, minY), Vec2(maxX, goalTop)), wallFixture);
  wallBody.createFixture(planck.Edge(Vec2(maxX, goalBottom), Vec2(maxX, maxY)), wallFixture);

  const leftPaddle = world.createBody({
    type: "kinematic",
    position: Vec2(toWorld(140), toWorld(260)),
  });
  leftPaddle.setUserData("paddle");
  leftPaddle.createFixture(planck.Circle(toWorld(26)), { restitution: 0.6, friction: 0 });

  const rightPaddle = world.createBody({
    type: "kinematic",
    position: Vec2(toWorld(760), toWorld(260)),
  });
  rightPaddle.setUserData("paddle");
  rightPaddle.createFixture(planck.Circle(toWorld(26)), { restitution: 0.6, friction: 0 });

  const puck = world.createBody({
    type: "dynamic",
    position: Vec2(toWorld(450), toWorld(260)),
    bullet: true,
  });
  puck.setUserData("puck");
  puck.createFixture(planck.Circle(PUCK_RADIUS), { restitution: 0.95, friction: 0 });
  puck.setLinearDamping(0.005);

  return { world, leftPaddle, rightPaddle, puck };
};

// 방 생성
const createRoom = () => {
  const physics = createPhysicsWorld();
  const events = { wall: false, paddle: false, goal: false };

  physics.world.on("begin-contact", (contact) => {
    const a = contact.getFixtureA().getBody().getUserData();
    const b = contact.getFixtureB().getBody().getUserData();
    if (!a || !b) return;
    if ((a === "puck" && b === "paddle") || (a === "paddle" && b === "puck")) {
      events.paddle = true;
    }
    if ((a === "puck" && b === "wall") || (a === "wall" && b === "puck")) {
      events.wall = true;
    }
  });

  return {
    hostId: null,
    clients: new Map(),
    state: createState(),
    inputs: {
      left: { up: false, down: false, left: false, right: false },
      right: { up: false, down: false, left: false, right: false },
    },
    lastSeq: { left: 0, right: 0 },
    timer: null,
    physics,
    events,
  };
};

// 입력을 패들 속도로 변환
const applyPaddleVelocity = (body, input) => {
  let vx = 0;
  let vy = 0;
  if (input.left) vx -= PADDLE_SPEED;
  if (input.right) vx += PADDLE_SPEED;
  if (input.up) vy -= PADDLE_SPEED;
  if (input.down) vy += PADDLE_SPEED;
  body.setLinearVelocity(planck.Vec2(vx, vy));
};

const clampPaddlePosition = (body, side) => {
  const pos = body.getPosition();
  const minY = toWorld(WALL);
  const maxY = toWorld(ARENA.height - WALL);
  const minX = toWorld(WALL);
  const maxX = toWorld(ARENA.width - WALL);
  const mid = toWorld(ARENA.width / 2);

  let x = pos.x;
  let y = pos.y;

  if (side === "left") {
    x = Math.min(Math.max(x, minX), mid - toWorld(WALL));
  } else {
    x = Math.min(Math.max(x, mid + toWorld(WALL)), maxX);
  }

  y = Math.min(Math.max(y, minY), maxY);

  body.setPosition(planck.Vec2(x, y));
};

const resetRound = (room, direction) => {
  const { leftPaddle, rightPaddle, puck } = room.physics;

  leftPaddle.setPosition(planck.Vec2(toWorld(140), toWorld(260)));
  rightPaddle.setPosition(planck.Vec2(toWorld(760), toWorld(260)));
  leftPaddle.setLinearVelocity(planck.Vec2(0, 0));
  rightPaddle.setLinearVelocity(planck.Vec2(0, 0));

  puck.setPosition(planck.Vec2(toWorld(450), toWorld(260)));
  const vyPxPerSec = (Math.random() * 2.8 + 2.2) * TICK_RATE * (Math.random() > 0.5 ? 1 : -1);
  puck.setLinearVelocity(planck.Vec2(PUCK_INITIAL_VX * direction, vyPxPerSec * SCALE));
};

const syncStateFromBodies = (room) => {
  const { leftPaddle, rightPaddle, puck } = room.physics;
  const puckVel = puck.getLinearVelocity();
  const leftPos = leftPaddle.getPosition();
  const rightPos = rightPaddle.getPosition();
  const puckPos = puck.getPosition();

  room.state.left.x = toPixel(leftPos.x);
  room.state.left.y = toPixel(leftPos.y);
  room.state.right.x = toPixel(rightPos.x);
  room.state.right.y = toPixel(rightPos.y);
  room.state.puck.x = toPixel(puckPos.x);
  room.state.puck.y = toPixel(puckPos.y);
  room.state.puck.vx = toPixel(puckVel.x);
  room.state.puck.vy = toPixel(puckVel.y);
};

const stepRoom = (room) => {
  const { state, events } = room;
  const { world, leftPaddle, rightPaddle, puck } = room.physics;

  events.wall = false;
  events.paddle = false;
  events.goal = false;

  if (!state.running) {
    leftPaddle.setLinearVelocity(planck.Vec2(0, 0));
    rightPaddle.setLinearVelocity(planck.Vec2(0, 0));
    syncStateFromBodies(room);
    return { state, events };
  }

  applyPaddleVelocity(leftPaddle, room.inputs.left);
  applyPaddleVelocity(rightPaddle, room.inputs.right);

  for (let i = 0; i < SUB_STEPS; i += 1) {
    world.step(FIXED_DT / SUB_STEPS, 12, 8);
  }

  clampPaddlePosition(leftPaddle, "left");
  clampPaddlePosition(rightPaddle, "right");

  // 퍽 속도 제한
  const puckVel = puck.getLinearVelocity();
  const speed = Math.hypot(puckVel.x, puckVel.y);
  if (speed > MAX_PUCK_SPEED) {
    const scale = MAX_PUCK_SPEED / speed;
    puck.setLinearVelocity(planck.Vec2(puckVel.x * scale, puckVel.y * scale));
  }

  // 득점 체크
  const puckPos = puck.getPosition();
  const goalTop = toWorld(ARENA.height / 2 - GOAL_HEIGHT / 2);
  const goalBottom = toWorld(ARENA.height / 2 + GOAL_HEIGHT / 2);
  const minX = toWorld(WALL);
  const maxX = toWorld(ARENA.width - WALL);

  if (puckPos.x - PUCK_RADIUS <= minX && puckPos.y > goalTop && puckPos.y < goalBottom) {
    state.scores.right += 1;
    state.status = "플레이어 2 득점!";
    resetRound(room, 1);
    events.goal = true;
  }

  if (puckPos.x + PUCK_RADIUS >= maxX && puckPos.y > goalTop && puckPos.y < goalBottom) {
    state.scores.left += 1;
    state.status = "플레이어 1 득점!";
    resetRound(room, -1);
    events.goal = true;
  }

  if (state.scores.left >= 7 || state.scores.right >= 7) {
    state.running = false;
    state.status = state.scores.left > state.scores.right ? "플레이어 1 승리!" : "플레이어 2 승리!";
  }

  syncStateFromBodies(room);
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
      acks: { left: room.lastSeq.left, right: room.lastSeq.right },
      time: Date.now(),
    };
    broadcast(room, { type: "state", payload });
  }, 1000 / TICK_RATE);
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
        room = createRoom();
        room.hostId = id;
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
      if (typeof message.payload.seq === "number" && message.payload.seq > room.lastSeq[ws.side]) {
        room.lastSeq[ws.side] = message.payload.seq;
      }
      if (ws.side === "right") {
        const host = room.clients.get(room.hostId);
        if (host) send(host, { type: "guest-input" });
      }
      return;
    }

    if (message.type === "control" && ws.id === room.hostId) {
      if (message.action === "toggle") {
        room.state.running = !room.state.running;
        if (room.state.running) {
          const dir = Math.random() > 0.5 ? 1 : -1;
          resetRound(room, dir);
          room.state.status = "경기 진행 중!";
        } else {
          room.state.status = "일시정지";
        }
      }
      if (message.action === "reset") {
        room.state = createState();
        resetRound(room, 1);
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
