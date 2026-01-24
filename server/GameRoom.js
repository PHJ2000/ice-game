const { Room } = require("@colyseus/core");
const { Schema, MapSchema, defineTypes } = require("@colyseus/schema");
const RAPIER = require("@dimforge/rapier2d-compat");
const CONFIG = require("../config.json");

const rapierReady = RAPIER.init({});

const ARENA = CONFIG.ARENA;
const WALL = CONFIG.WALL;
const GOAL_HEIGHT = CONFIG.GOAL_HEIGHT;
const GOAL_DEPTH = CONFIG.GOAL_DEPTH || 30;
const SCORE_TO_WIN = CONFIG.SCORE_TO_WIN;
const SCALE = 0.01;
const TICK_RATE = 60;
const FIXED_DT = 1 / TICK_RATE;
const DEBUG_COLLISION = process.env.DEBUG_COLLISION === "1";

const PADDLE_RADIUS = CONFIG.PADDLE_RADIUS;
const PADDLE_SPEED_PX_PER_FRAME = CONFIG.PADDLE_SPEED_PX_PER_FRAME;
const PADDLE_SPEED_PX_PER_SEC = PADDLE_SPEED_PX_PER_FRAME * TICK_RATE;
const PADDLE_SPEED = PADDLE_SPEED_PX_PER_SEC * SCALE;

const PUCK_RADIUS_PX = CONFIG.PUCK_RADIUS;
const PUCK_RADIUS = PUCK_RADIUS_PX * SCALE;
const PUCK_INITIAL_VX_PX_PER_FRAME = CONFIG.PUCK_INITIAL_VX_PX_PER_FRAME;
const PUCK_INITIAL_VY_PX_PER_FRAME = CONFIG.PUCK_INITIAL_VY_PX_PER_FRAME;
const PUCK_INITIAL_VX_PX_PER_SEC = PUCK_INITIAL_VX_PX_PER_FRAME * TICK_RATE;
const PUCK_INITIAL_VY_PX_PER_SEC = PUCK_INITIAL_VY_PX_PER_FRAME * TICK_RATE;
const PUCK_INITIAL_VX = PUCK_INITIAL_VX_PX_PER_SEC * SCALE;
const PUCK_INITIAL_VY = PUCK_INITIAL_VY_PX_PER_SEC * SCALE;
const MAX_PUCK_SPEED_PX_PER_FRAME = CONFIG.MAX_PUCK_SPEED_PX_PER_FRAME;
const MAX_PUCK_SPEED_PX_PER_SEC = MAX_PUCK_SPEED_PX_PER_FRAME * TICK_RATE;
const MAX_PUCK_SPEED = MAX_PUCK_SPEED_PX_PER_SEC * SCALE;

const toWorld = (value) => value * SCALE;
const toPixel = (value) => value / SCALE;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

class Player extends Schema {
  constructor() {
    super();
    this.x = 0;
    this.y = 0;
    this.r = PADDLE_RADIUS;
    this.side = "";
  }
}

defineTypes(Player, {
  x: "number",
  y: "number",
  r: "number",
  side: "string",
});

class Puck extends Schema {
  constructor() {
    super();
    this.x = 0;
    this.y = 0;
    this.r = PUCK_RADIUS_PX;
    this.vx = 0;
    this.vy = 0;
  }
}

defineTypes(Puck, {
  x: "number",
  y: "number",
  r: "number",
  vx: "number",
  vy: "number",
});

class GameState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.puck = new Puck();
    this.scoreLeft = 0;
    this.scoreRight = 0;
    this.running = false;
    this.status = "스페이스를 누르면 시작!";
    this.time = Date.now();
    this.leftId = "";
    this.rightId = "";
  }
}

defineTypes(GameState, {
  players: { map: Player },
  puck: Puck,
  scoreLeft: "number",
  scoreRight: "number",
  running: "boolean",
  status: "string",
  time: "number",
  leftId: "string",
  rightId: "string",
});

const buildWalls = (world) => {
  const minX = toWorld(WALL);
  const maxX = toWorld(ARENA.width - WALL);
  const minY = toWorld(WALL);
  const maxY = toWorld(ARENA.height - WALL);
  const goalTop = toWorld(ARENA.height / 2 - GOAL_HEIGHT / 2);
  const goalBottom = toWorld(ARENA.height / 2 + GOAL_HEIGHT / 2);
  const goalDepth = toWorld(Math.min(GOAL_DEPTH, WALL));

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

  // Goal pockets (back + posts)
  createWall(new RAPIER.Vector2(minX - goalDepth, goalTop), new RAPIER.Vector2(minX, goalTop));
  createWall(new RAPIER.Vector2(minX - goalDepth, goalBottom), new RAPIER.Vector2(minX, goalBottom));
  createWall(new RAPIER.Vector2(minX - goalDepth, goalTop), new RAPIER.Vector2(minX - goalDepth, goalBottom));
  createWall(new RAPIER.Vector2(maxX, goalTop), new RAPIER.Vector2(maxX + goalDepth, goalTop));
  createWall(new RAPIER.Vector2(maxX, goalBottom), new RAPIER.Vector2(maxX + goalDepth, goalBottom));
  createWall(new RAPIER.Vector2(maxX + goalDepth, goalTop), new RAPIER.Vector2(maxX + goalDepth, goalBottom));
};

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

const applyPaddleTarget = (body, target, side) => {
  if (!target) return false;
  const minY = toWorld(WALL);
  const maxY = toWorld(ARENA.height - WALL);
  const minX = toWorld(WALL);
  const maxX = toWorld(ARENA.width - WALL);
  const mid = toWorld(ARENA.width / 2);
  const maxDist = Math.max(0.0001, mid - toWorld(WALL) - minX);

  const current = body.translation();
  let nextX = toWorld(target.x);
  let nextY = toWorld(target.y);

  if (side === "left") {
    nextX = clamp(nextX, minX, mid - toWorld(WALL));
  } else {
    nextX = clamp(nextX, mid + toWorld(WALL), maxX);
  }
  nextY = clamp(nextY, minY, maxY);

  const dx = nextX - current.x;
  const dy = nextY - current.y;
  const dist = Math.hypot(dx, dy);
  const distFromGoal = side === "left" ? current.x - minX : maxX - current.x;
  const falloff = Math.min(1, Math.max(0, distFromGoal / maxDist));
  const weight = Math.max(0.25, 1 - Math.pow(falloff, 2));
  const maxStep = PADDLE_SPEED * FIXED_DT * weight;
  if (dist > maxStep) {
    const scale = maxStep / dist;
    nextX = current.x + dx * scale;
    nextY = current.y + dy * scale;
  }

  body.setNextKinematicTranslation(new RAPIER.Vector2(nextX, nextY));
  return true;
};

const resetRound = (room, direction) => {
  const { leftBody, rightBody, puckBody } = room.physics;

  leftBody.setTranslation(new RAPIER.Vector2(toWorld(140), toWorld(260)), true);
  rightBody.setTranslation(new RAPIER.Vector2(toWorld(760), toWorld(260)), true);
  puckBody.setTranslation(new RAPIER.Vector2(toWorld(450), toWorld(260)), true);

  const vyPxPerSec = (Math.random() * 2.8 + 2.2) * TICK_RATE * (Math.random() > 0.5 ? 1 : -1);
  puckBody.setLinvel(new RAPIER.Vector2(PUCK_INITIAL_VX * direction, vyPxPerSec * SCALE), true);
};

const syncStateFromBodies = (room) => {
  const { leftBody, rightBody, puckBody } = room.physics;
  const puckVel = puckBody.linvel();
  const leftPos = leftBody.translation();
  const rightPos = rightBody.translation();
  const puckPos = puckBody.translation();

  const state = room.state;
  const leftPlayer = room.leftId ? state.players.get(room.leftId) : null;
  const rightPlayer = room.rightId ? state.players.get(room.rightId) : null;

  if (leftPlayer) {
    leftPlayer.x = toPixel(leftPos.x);
    leftPlayer.y = toPixel(leftPos.y);
    leftPlayer.r = PADDLE_RADIUS;
  }
  if (rightPlayer) {
    rightPlayer.x = toPixel(rightPos.x);
    rightPlayer.y = toPixel(rightPos.y);
    rightPlayer.r = PADDLE_RADIUS;
  }

  state.puck.x = toPixel(puckPos.x);
  state.puck.y = toPixel(puckPos.y);
  state.puck.r = PUCK_RADIUS_PX;
  state.puck.vx = toPixel(puckVel.x);
  state.puck.vy = toPixel(puckVel.y);
};

const consumeCollisionEvents = (room) => {
  const { world, eventQueue } = room.physics;
  const events = { wall: false, paddle: false, goal: false };

  eventQueue.drainCollisionEvents((handleA, handleB, started) => {
    if (!started) return;
    const colliderA = world.getCollider(handleA);
    const colliderB = world.getCollider(handleB);
    const typeA = colliderA?.userData?.type;
    const typeB = colliderB?.userData?.type;
    if ((typeA === "puck" && typeB === "paddle") || (typeA === "paddle" && typeB === "puck")) {
      events.paddle = true;
      if (DEBUG_COLLISION) {
        const now = Date.now();
        if (now - room.lastCollisionLogAt > 200) {
          room.lastCollisionLogAt = now;
          const puck = room.physics.puckBody.translation();
          const left = room.physics.leftBody.translation();
          const right = room.physics.rightBody.translation();
          console.log(
            `[충돌] room=${room.roomCode} puck=(${toPixel(puck.x).toFixed(1)},${toPixel(puck.y).toFixed(1)}) left=(${toPixel(
              left.x
            ).toFixed(1)},${toPixel(left.y).toFixed(1)}) right=(${toPixel(right.x).toFixed(1)},${toPixel(
              right.y
            ).toFixed(1)})`
          );
        }
      }
    }
    if ((typeA === "puck" && typeB === "wall") || (typeA === "wall" && typeB === "puck")) {
      events.wall = true;
    }
  });

  return events;
};

class GameRoom extends Room {
  async onCreate(options) {
    await rapierReady;
    this.setState(new GameState());
    this.maxClients = 2;
    this.roomCode = String(options?.roomCode || "").toUpperCase();
    this.setMetadata({ roomCode: this.roomCode });

    this.hostId = null;
    this.leftId = null;
    this.rightId = null;
    this.inputs = {
      left: { up: false, down: false, left: false, right: false },
      right: { up: false, down: false, left: false, right: false },
    };
    this.targets = { left: null, right: null };
    this.physics = createPhysicsWorld();
    this.lastCollisionLogAt = 0;

    this.onMessage("input", (client, message) => {
      const side = this.getSide(client.sessionId);
      if (!side || !message) return;
      this.inputs[side] = {
        up: Boolean(message.up),
        down: Boolean(message.down),
        left: Boolean(message.left),
        right: Boolean(message.right),
      };
      this.targets[side] = null;
      this.state.time = Date.now();
    });

    this.onMessage("move", (client, message) => {
      const side = this.getSide(client.sessionId);
      if (!side) return;
      if (!message || !Number.isFinite(message.x) || !Number.isFinite(message.y)) {
        this.targets[side] = null;
        return;
      }
      this.targets[side] = { x: message.x, y: message.y };
      this.state.time = Date.now();
    });

    this.onMessage("control", (client, message) => {
      if (client.sessionId !== this.hostId || !message) return;
      if (message.action === "toggle") {
        this.state.running = !this.state.running;
        if (this.state.running) {
          const dir = Math.random() > 0.5 ? 1 : -1;
          resetRound(this, dir);
          this.state.status = "경기 진행 중!";
        } else {
          this.state.status = "일시정지";
        }
      }
      if (message.action === "reset") {
        this.state.scoreLeft = 0;
        this.state.scoreRight = 0;
        this.state.running = false;
        this.state.status = "스페이스를 누르면 시작!";
        resetRound(this, 1);
      }
    });

    this.onMessage("ping", (client, message) => {
      client.send("pong", { at: message?.at ?? Date.now(), serverTime: Date.now() });
    });

    this.setSimulationInterval(() => this.update(), 1000 / TICK_RATE);
  }

  getSide(sessionId) {
    if (sessionId === this.leftId) return "left";
    if (sessionId === this.rightId) return "right";
    return null;
  }

  onJoin(client) {
    if (!this.hostId) {
      this.hostId = client.sessionId;
    }

    const side = !this.leftId ? "left" : !this.rightId ? "right" : null;
    if (!side) {
      client.leave(1000);
      return;
    }

    if (side === "left") {
      this.leftId = client.sessionId;
      this.state.leftId = client.sessionId;
    } else {
      this.rightId = client.sessionId;
      this.state.rightId = client.sessionId;
    }

    const player = new Player();
    player.side = side;
    player.x = side === "left" ? 140 : 760;
    player.y = 260;
    player.r = PADDLE_RADIUS;
    this.state.players.set(client.sessionId, player);

    const role = side === "left" ? "host" : "guest";
    client.send("role", { role, side, room: this.roomCode });
    if (role === "guest") {
      this.broadcast("guest-joined");
    }
  }

  onLeave(client) {
    const side = this.getSide(client.sessionId);
    if (side === "left") {
      this.leftId = null;
      this.state.leftId = "";
    }
    if (side === "right") {
      this.rightId = null;
      this.state.rightId = "";
    }

    this.state.players.delete(client.sessionId);

    if (client.sessionId === this.hostId) {
      this.broadcast("host-left");
      this.disconnect();
      return;
    }

    if (side === "right") {
      this.broadcast("guest-left");
    }
  }

  update() {
    const { state } = this;
    const { world, eventQueue, leftBody, rightBody, puckBody } = this.physics;

    if (state.running) {
      const leftMoved = applyPaddleTarget(leftBody, this.targets.left, "left");
      const rightMoved = applyPaddleTarget(rightBody, this.targets.right, "right");
      if (!leftMoved) {
        applyPaddleInput(leftBody, this.inputs.left, "left");
      }
      if (!rightMoved) {
        applyPaddleInput(rightBody, this.inputs.right, "right");
      }

      world.step(eventQueue);
      const events = consumeCollisionEvents(this);

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
  const goalDepth = toWorld(Math.min(GOAL_DEPTH, WALL));

  const leftInGoal =
    puckPos.y > goalTop &&
    puckPos.y < goalBottom &&
    puckPos.x - PUCK_RADIUS >= minX - goalDepth &&
    puckPos.x + PUCK_RADIUS <= minX;
  const rightInGoal =
    puckPos.y > goalTop &&
    puckPos.y < goalBottom &&
    puckPos.x - PUCK_RADIUS >= maxX &&
    puckPos.x + PUCK_RADIUS <= maxX + goalDepth;

  if (leftInGoal) {
    state.scoreRight += 1;
    state.status = "플레이어 2 득점!";
    resetRound(this, 1);
    events.goal = true;
  }

  if (rightInGoal) {
    state.scoreLeft += 1;
    state.status = "플레이어 1 득점!";
    resetRound(this, -1);
        events.goal = true;
      }

      if (state.scoreLeft >= SCORE_TO_WIN || state.scoreRight >= SCORE_TO_WIN) {
        state.running = false;
        state.status = state.scoreLeft > state.scoreRight ? "플레이어 1 승리!" : "플레이어 2 승리!";
      }

      if (events.wall || events.paddle || events.goal) {
        this.broadcast("event", events);
      }
    }

    syncStateFromBodies(this);
    state.time = Date.now();
  }
}

module.exports = GameRoom;
