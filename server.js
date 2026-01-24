const http = require("http");
const fs = require("fs");
const path = require("path");
const RAPIER = require("@dimforge/rapier2d-compat");
const { WebSocketServer } = require("ws");
const CONFIG = require("./config.json");
const Protocol = require("./shared/protocol");

const port = process.env.PORT || 3000;
const baseDir = __dirname;

const mimeTypes = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
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

  if (pathname === "/config") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(CONFIG));
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
const ARENA = CONFIG.ARENA;
const WALL = CONFIG.WALL;
const GOAL_HEIGHT = CONFIG.GOAL_HEIGHT;
const SCORE_TO_WIN = CONFIG.SCORE_TO_WIN;
const SCALE = 0.01; // 1px = 0.01m
const RUNNING_TICK_RATE = 60;
const IDLE_TICK_RATE = 10;
const RUNNING_SNAPSHOT_RATE = 30;
const IDLE_SNAPSHOT_RATE = 5;
const FIXED_DT = 1 / RUNNING_TICK_RATE;
const DEBUG_COLLISION = process.env.DEBUG_COLLISION === "1";

const ROOM_EMPTY_TTL_MS = 60 * 1000;
const ROOM_INACTIVE_TTL_MS = 15 * 60 * 1000;

const PADDLE_RADIUS = CONFIG.PADDLE_RADIUS;
const PADDLE_SPEED_PX_PER_FRAME = CONFIG.PADDLE_SPEED_PX_PER_FRAME;
const PADDLE_SPEED_PX_PER_SEC = PADDLE_SPEED_PX_PER_FRAME * RUNNING_TICK_RATE;
const PADDLE_SPEED = PADDLE_SPEED_PX_PER_SEC * SCALE;

const PUCK_RADIUS_PX = CONFIG.PUCK_RADIUS;
const PUCK_RADIUS = PUCK_RADIUS_PX * SCALE;
const PUCK_INITIAL_VX_PX_PER_FRAME = CONFIG.PUCK_INITIAL_VX_PX_PER_FRAME;
const PUCK_INITIAL_VY_PX_PER_FRAME = CONFIG.PUCK_INITIAL_VY_PX_PER_FRAME;
const PUCK_INITIAL_VX_PX_PER_SEC = PUCK_INITIAL_VX_PX_PER_FRAME * RUNNING_TICK_RATE;
const PUCK_INITIAL_VY_PX_PER_SEC = PUCK_INITIAL_VY_PX_PER_FRAME * RUNNING_TICK_RATE;
const PUCK_INITIAL_VX = PUCK_INITIAL_VX_PX_PER_SEC * SCALE;
const PUCK_INITIAL_VY = PUCK_INITIAL_VY_PX_PER_SEC * SCALE;
const MAX_PUCK_SPEED_PX_PER_FRAME = CONFIG.MAX_PUCK_SPEED_PX_PER_FRAME;
const MAX_PUCK_SPEED_PX_PER_SEC = MAX_PUCK_SPEED_PX_PER_FRAME * RUNNING_TICK_RATE;
const MAX_PUCK_SPEED = MAX_PUCK_SPEED_PX_PER_SEC * SCALE;

const toWorld = (value) => value * SCALE;
const toPixel = (value) => value / SCALE;

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

const send = (ws, payload) => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
};

const broadcast = (room, payload) => {
  room.clients.forEach((client) => send(client, payload));
};

const touchRoom = (room) => {
  room.lastActivityAt = Date.now();
};

const expireRoom = (room, reason) => {
  broadcast(room, { type: "room-expired", reason });
  room.clients.forEach((client) => {
    try {
      client.close();
    } catch (error) {
      // ignore close errors
    }
  });
  clearInterval(room.timer);
  if (room.code) {
    rooms.delete(room.code);
  }
};

// 초기 게임 상태
const createState = () => ({
  left: { x: 140, y: 260, r: PADDLE_RADIUS },
  right: { x: 760, y: 260, r: PADDLE_RADIUS },
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

const buildWalls = (world) => {
  const minX = toWorld(WALL);
  const maxX = toWorld(ARENA.width - WALL);
  const minY = toWorld(WALL);
  const maxY = toWorld(ARENA.height - WALL);
  const goalTop = toWorld(ARENA.height / 2 - GOAL_HEIGHT / 2);
  const goalBottom = toWorld(ARENA.height / 2 + GOAL_HEIGHT / 2);

  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const wallFixture = RAPIER.ColliderDesc.segment;

  const createWall = (start, end) => {
    const collider = world.createCollider(wallFixture(start, end), fixed);
    collider.setRestitution(0.98);
    collider.setFriction(0);
    collider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    collider.userData = { type: "wall" };
  };

  createWall(new RAPIER.Vector2(minX, minY), new RAPIER.Vector2(maxX, minY));
  createWall(new RAPIER.Vector2(minX, maxY), new RAPIER.Vector2(maxX, maxY));
  createWall(new RAPIER.Vector2(minX, minY), new RAPIER.Vector2(minX, goalTop));
  createWall(new RAPIER.Vector2(minX, goalBottom), new RAPIER.Vector2(minX, maxY));
  createWall(new RAPIER.Vector2(maxX, minY), new RAPIER.Vector2(maxX, goalTop));
  createWall(new RAPIER.Vector2(maxX, goalBottom), new RAPIER.Vector2(maxX, maxY));
};

// 물리 월드 생성
const createPhysicsWorld = () => {
  const world = new RAPIER.World(new RAPIER.Vector2(0, 0));
  const eventQueue = new RAPIER.EventQueue(true);

  buildWalls(world);

  const leftBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(toWorld(140), toWorld(260))
  );
  const leftCollider = world.createCollider(RAPIER.ColliderDesc.ball(toWorld(PADDLE_RADIUS)), leftBody);
  leftCollider.setRestitution(0.6);
  leftCollider.setFriction(0);
  leftCollider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  leftCollider.userData = { type: "paddle" };

  const rightBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(toWorld(760), toWorld(260))
  );
  const rightCollider = world.createCollider(RAPIER.ColliderDesc.ball(toWorld(PADDLE_RADIUS)), rightBody);
  rightCollider.setRestitution(0.6);
  rightCollider.setFriction(0);
  rightCollider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  rightCollider.userData = { type: "paddle" };

  const puckBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(toWorld(450), toWorld(260)).setCcdEnabled(true)
  );
  const puckCollider = world.createCollider(RAPIER.ColliderDesc.ball(PUCK_RADIUS), puckBody);
  puckCollider.setRestitution(0.95);
  puckCollider.setFriction(0);
  puckCollider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  puckCollider.userData = { type: "puck" };
  puckBody.setLinearDamping(0.01);

  return {
    world,
    eventQueue,
    leftBody,
    rightBody,
    puckBody,
  };
};

// 방 생성
const createRoom = () => {
  const physics = createPhysicsWorld();
  const events = { wall: false, paddle: false, goal: false };
  const tickRate = IDLE_TICK_RATE;
  const snapshotIntervalMs = 1000 / IDLE_SNAPSHOT_RATE;

  return {
    hostId: null,
    clients: new Map(),
    state: createState(),
    inputs: {
      left: { up: false, down: false, left: false, right: false },
      right: { up: false, down: false, left: false, right: false },
    },
    lastSeq: { left: 0, right: 0 },
    lastSnapshotAt: Date.now(),
    lastCollisionLogAt: 0,
    lastActivityAt: Date.now(),
    lastEmptyAt: Date.now(),
    eventLatch: { wall: false, paddle: false, goal: false },
    timer: null,
    tickRate,
    snapshotIntervalMs,
    physics,
    events,
  };
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// 입력을 패들 목표 위치로 변환
const applyPaddleInput = (body, input, side) => {
  const current = body.translation();
  let nextX = current.x;
  let nextY = current.y;

  const step = PADDLE_SPEED * FIXED_DT;
  if (input.left) nextX -= step;
  if (input.right) nextX += step;
  if (input.up) nextY -= step;
  if (input.down) nextY += step;

  const minY = toWorld(WALL);
  const maxY = toWorld(ARENA.height - WALL);
  const minX = toWorld(WALL);
  const maxX = toWorld(ARENA.width - WALL);
  const mid = toWorld(ARENA.width / 2);

  if (side === "left") {
    nextX = clamp(nextX, minX, mid - toWorld(WALL));
  } else {
    nextX = clamp(nextX, mid + toWorld(WALL), maxX);
  }
  nextY = clamp(nextY, minY, maxY);

  body.setNextKinematicTranslation(new RAPIER.Vector2(nextX, nextY));
};

const resetRound = (room, direction) => {
  const { leftBody, rightBody, puckBody } = room.physics;

  leftBody.setTranslation(new RAPIER.Vector2(toWorld(140), toWorld(260)), true);
  rightBody.setTranslation(new RAPIER.Vector2(toWorld(760), toWorld(260)), true);

  puckBody.setTranslation(new RAPIER.Vector2(toWorld(450), toWorld(260)), true);
  const vyPxPerSec = (Math.random() * 2.8 + 2.2) * RUNNING_TICK_RATE * (Math.random() > 0.5 ? 1 : -1);
  puckBody.setLinvel(new RAPIER.Vector2(PUCK_INITIAL_VX * direction, vyPxPerSec * SCALE), true);
};

const syncStateFromBodies = (room) => {
  const { leftBody, rightBody, puckBody } = room.physics;
  const puckVel = puckBody.linvel();
  const leftPos = leftBody.translation();
  const rightPos = rightBody.translation();
  const puckPos = puckBody.translation();

  room.state.left.x = toPixel(leftPos.x);
  room.state.left.y = toPixel(leftPos.y);
  room.state.right.x = toPixel(rightPos.x);
  room.state.right.y = toPixel(rightPos.y);
  room.state.puck.x = toPixel(puckPos.x);
  room.state.puck.y = toPixel(puckPos.y);
  room.state.puck.vx = toPixel(puckVel.x);
  room.state.puck.vy = toPixel(puckVel.y);
};

const consumeCollisionEvents = (room) => {
  const { world, eventQueue } = room.physics;
  const { events } = room;

  eventQueue.drainCollisionEvents((handleA, handleB, started) => {
    if (!started) return;
    const colliderA = world.getCollider(handleA);
    const colliderB = world.getCollider(handleB);
    const typeA = colliderA?.userData?.type;
    const typeB = colliderB?.userData?.type;
    if ((typeA === "puck" && typeB === "paddle") || (typeA === "paddle" && typeB === "puck")) {
      events.paddle = true;
      room.eventLatch.paddle = true;
      if (DEBUG_COLLISION) {
        const now = Date.now();
        if (now - room.lastCollisionLogAt > 200) {
          room.lastCollisionLogAt = now;
          const puck = room.physics.puckBody.translation();
          const left = room.physics.leftBody.translation();
          const right = room.physics.rightBody.translation();
          log.debug(
            `[충돌] room=${room.hostId ?? "-"} puck=(${toPixel(puck.x).toFixed(1)},${toPixel(puck.y).toFixed(
              1
            )}) left=(${toPixel(left.x).toFixed(1)},${toPixel(left.y).toFixed(1)}) right=(${toPixel(
              right.x
            ).toFixed(1)},${toPixel(right.y).toFixed(1)})`
          );
        }
      }
    }
    if ((typeA === "puck" && typeB === "wall") || (typeA === "wall" && typeB === "puck")) {
      events.wall = true;
      room.eventLatch.wall = true;
    }
  });
};

const stepRoom = (room) => {
  const { state, events } = room;
  const { world, leftBody, rightBody, puckBody, eventQueue } = room.physics;

  events.wall = false;
  events.paddle = false;
  events.goal = false;

  if (!state.running) {
    syncStateFromBodies(room);
    return { state, events };
  }

  applyPaddleInput(leftBody, room.inputs.left, "left");
  applyPaddleInput(rightBody, room.inputs.right, "right");

  world.step(eventQueue);
  consumeCollisionEvents(room);

  const puckVel = puckBody.linvel();
  const speed = Math.hypot(puckVel.x, puckVel.y);
  if (speed > MAX_PUCK_SPEED) {
    const scale = MAX_PUCK_SPEED / speed;
    puckBody.setLinvel(new RAPIER.Vector2(puckVel.x * scale, puckVel.y * scale), true);
  }

  const puckPos = puckBody.translation();
  const goalTop = toWorld(ARENA.height / 2 - GOAL_HEIGHT / 2);
  const goalBottom = toWorld(ARENA.height / 2 + GOAL_HEIGHT / 2);
  const minX = toWorld(WALL);
  const maxX = toWorld(ARENA.width - WALL);

  if (puckPos.x - PUCK_RADIUS <= minX && puckPos.y > goalTop && puckPos.y < goalBottom) {
    state.scores.right += 1;
    state.status = "플레이어 2 득점!";
    resetRound(room, 1);
    events.goal = true;
    room.eventLatch.goal = true;
  }

  if (puckPos.x + PUCK_RADIUS >= maxX && puckPos.y > goalTop && puckPos.y < goalBottom) {
    state.scores.left += 1;
    state.status = "플레이어 1 득점!";
    resetRound(room, -1);
    events.goal = true;
    room.eventLatch.goal = true;
  }

  if (state.scores.left >= SCORE_TO_WIN || state.scores.right >= SCORE_TO_WIN) {
    state.running = false;
    state.status = state.scores.left > state.scores.right ? "플레이어 1 승리!" : "플레이어 2 승리!";
  }

  syncStateFromBodies(room);
  return { state, events };
};

const setRoomLoop = (room, tickRate, snapshotRate) => {
  if (room.timer) clearInterval(room.timer);
  room.tickRate = tickRate;
  room.snapshotIntervalMs = 1000 / snapshotRate;
  room.timer = setInterval(() => {
    const { state, events } = stepRoom(room);
    const now = Date.now();
    if (room.clients.size === 0 && now - room.lastEmptyAt > ROOM_EMPTY_TTL_MS) {
      expireRoom(room, "empty");
      return;
    }
    if (
      room.clients.size > 0 &&
      !room.state.running &&
      now - room.lastActivityAt > ROOM_INACTIVE_TTL_MS
    ) {
      expireRoom(room, "inactive");
      return;
    }
    if (now - room.lastSnapshotAt >= room.snapshotIntervalMs) {
      room.lastSnapshotAt = now;
      const latched = room.eventLatch;
      room.eventLatch = { wall: false, paddle: false, goal: false };
      const payload = {
        t: now,
        r: state.running ? 1 : 0,
        s: [state.scores.left, state.scores.right],
        st: state.status,
        l: [state.left.x, state.left.y, state.left.r],
        rt: [state.right.x, state.right.y, state.right.r],
        p: [state.puck.x, state.puck.y, state.puck.r, state.puck.vx, state.puck.vy],
        e: [
          events.wall || latched.wall ? 1 : 0,
          events.paddle || latched.paddle ? 1 : 0,
          events.goal || latched.goal ? 1 : 0,
        ],
        a: [room.lastSeq.left, room.lastSeq.right],
      };
      broadcast(room, { type: "state", payload });
    }
  }, 1000 / tickRate);
};

const updateRoomLoop = (room) => {
  const running = room.state.running;
  const tickRate = running ? RUNNING_TICK_RATE : IDLE_TICK_RATE;
  const snapshotRate = running ? RUNNING_SNAPSHOT_RATE : IDLE_SNAPSHOT_RATE;
  if (room.timer && room.tickRate === tickRate && room.snapshotIntervalMs === 1000 / snapshotRate) {
    return;
  }
  setRoomLoop(room, tickRate, snapshotRate);
};

// 상태 브로드캐스트 루프 보장
const ensureRoomLoop = (room) => {
  if (!room.timer) {
    updateRoomLoop(room);
  }
};

// WebSocket 연결 처리
const attachSocketHandlers = (ws) => {
  const id = nextId++;
  ws.id = id;

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      return;
    }

    if (!Protocol.isClientMessage(message)) {
      log.warn("[ws] invalid client message", message?.type);
      return;
    }

    if (message.type === "ping") {
      const room = rooms.get(ws.roomCode);
      if (room) touchRoom(room);
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
        room.code = roomCode;
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
      touchRoom(room);

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
      touchRoom(room);
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
        updateRoomLoop(room);
      }
      if (message.action === "reset") {
        room.state = createState();
        resetRound(room, 1);
        updateRoomLoop(room);
      }
      touchRoom(room);
    }
  });

  ws.on("close", () => {
    const roomCode = ws.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;

    room.clients.delete(id);

    if (room.hostId === id) {
      broadcast(room, { type: "host-left" });
      room.clients.forEach((client) => {
        try {
          client.close();
        } catch (error) {
          // ignore close errors
        }
      });
      clearInterval(room.timer);
      rooms.delete(roomCode);
      return;
    }

    const host = room.clients.get(room.hostId);
    if (host) send(host, { type: "guest-left" });

    if (room.clients.size === 0) {
      room.lastEmptyAt = Date.now();
    }
  });
};

const startServer = async () => {
  await RAPIER.init({});
  wss.on("connection", attachSocketHandlers);
  server.listen(port, () => {
    log.info(`Server running on http://localhost:${port}`);
  });
};

startServer();
