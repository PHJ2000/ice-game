const canvas = document.getElementById("arena");
const ctx = canvas.getContext("2d");
const resetBtn = document.getElementById("resetBtn");
const statusText = document.getElementById("statusText");
const scoreLeftEl = document.getElementById("scoreLeft");
const scoreRightEl = document.getElementById("scoreRight");
const roomInput = document.getElementById("roomInput");
const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const copyLinkBtn = document.getElementById("copyLinkBtn");
const connectionStatus = document.getElementById("connectionStatus");

const keys = new Set();
const maxScore = 7;
const inputState = { up: false, down: false, left: false, right: false };
const guestInput = { up: false, down: false, left: false, right: false };

const state = {
  left: { x: 140, y: 260, r: 26, speed: 5.5 },
  right: { x: 760, y: 260, r: 26, speed: 5.5 },
  puck: { x: 450, y: 260, r: 16, vx: 4, vy: 2.5 },
  scores: { left: 0, right: 0 },
  running: false,
  status: "?ㅽ럹?댁뒪瑜??꾨Ⅴ硫??쒖옉!",
};

const bounds = {
  minX: 40,
  maxX: canvas.width - 40,
  minY: 40,
  maxY: canvas.height - 40,
};

let socket;
let role = null;
let roomCode = "";
let lastSent = 0;
let lastInputSignature = "";
let lastInputSentAt = 0;
let lastSentPos = { x: 0, y: 0 };
let targetState = null;
let targetStateTime = 0;
let guestPos = null;
let guestPosTime = 0;
let audioReady = false;
let audioContext;
let masterGain;
let bgOsc;
let bgGain;
let lastScoreLeft = 0;
let lastScoreRight = 0;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const lerp = (start, end, t) => start + (end - start) * t;
const smoothTo = (current, target, alpha, deadzone = 0.15) => {
  if (Math.abs(target - current) <= deadzone) return target;
  return lerp(current, target, alpha);
};

const resetRound = (direction = 1) => {
  state.left.x = 140;
  state.left.y = 260;
  state.right.x = 760;
  state.right.y = 260;
  state.puck.x = canvas.width / 2;
  state.puck.y = canvas.height / 2;
  state.puck.vx = 4 * direction;
  state.puck.vy = (Math.random() * 2.5 + 1.5) * (Math.random() > 0.5 ? 1 : -1);
};

const resetGame = () => {
  state.scores.left = 0;
  state.scores.right = 0;
  scoreLeftEl.textContent = "0";
  scoreRightEl.textContent = "0";
  state.running = false;
  state.status = "?ㅽ럹?댁뒪瑜??꾨Ⅴ硫??쒖옉!";
  statusText.textContent = state.status;
  resetRound();
  sendState();
};

const initAudio = () => {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioContext.createGain();
    masterGain.gain.value = 0.25;
    masterGain.connect(audioContext.destination);

    bgOsc = audioContext.createOscillator();
    bgGain = audioContext.createGain();
    bgOsc.type = "triangle";
    bgOsc.frequency.value = 110;
    bgGain.gain.value = 0.05;
    bgOsc.connect(bgGain).connect(masterGain);
    bgOsc.start();
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
  audioReady = true;
};

const playTone = (frequency, duration = 0.1, volume = 0.2) => {
  if (!audioReady) return;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.type = "sine";
  osc.frequency.value = frequency;
  gain.gain.value = volume;
  osc.connect(gain).connect(masterGain);
  osc.start();
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + duration);
  osc.stop(audioContext.currentTime + duration);
};

const playWall = () => playTone(360, 0.08, 0.12);
const playPaddle = () => playTone(520, 0.09, 0.18);
const playGoal = () => playTone(220, 0.18, 0.22);

const movePaddles = () => {
  const left = state.left;
  const right = state.right;

  if (inputState.up) left.y -= left.speed;
  if (inputState.down) left.y += left.speed;
  if (inputState.left) left.x -= left.speed;
  if (inputState.right) left.x += left.speed;

  const hasFreshGuestPos = guestPos && performance.now() - guestPosTime < 120;
  if (hasFreshGuestPos) {
    right.x = smoothTo(right.x, guestPos.x, 0.35);
    right.y = smoothTo(right.y, guestPos.y, 0.35);
  } else {
    if (guestInput.up) right.y -= right.speed;
    if (guestInput.down) right.y += right.speed;
    if (guestInput.left) right.x -= right.speed;
    if (guestInput.right) right.x += right.speed;
  }

  left.x = clamp(left.x, bounds.minX, canvas.width / 2 - 40);
  left.y = clamp(left.y, bounds.minY, bounds.maxY);
  right.x = clamp(right.x, canvas.width / 2 + 40, bounds.maxX);
  right.y = clamp(right.y, bounds.minY, bounds.maxY);
};

const moveGuestPaddleLocally = () => {
  const right = state.right;
  if (inputState.up) right.y -= right.speed;
  if (inputState.down) right.y += right.speed;
  if (inputState.left) right.x -= right.speed;
  if (inputState.right) right.x += right.speed;
  right.x = clamp(right.x, canvas.width / 2 + 40, bounds.maxX);
  right.y = clamp(right.y, bounds.minY, bounds.maxY);
};

const handleWallCollision = () => {
  const puck = state.puck;
  let bounced = false;
  if (puck.y - puck.r <= bounds.minY || puck.y + puck.r >= bounds.maxY) {
    puck.vy *= -1;
    bounced = true;
  }
  return bounced;
};

const handleSideWalls = () => {
  const puck = state.puck;
  const goalHeight = 140;
  const goalTop = canvas.height / 2 - goalHeight / 2;
  const goalBottom = canvas.height / 2 + goalHeight / 2;
  const inGoalY = puck.y > goalTop && puck.y < goalBottom;
  let bounced = false;

  if (!inGoalY && puck.x - puck.r <= bounds.minX) {
    puck.vx = Math.abs(puck.vx);
    bounced = true;
  }

  if (!inGoalY && puck.x + puck.r >= bounds.maxX) {
    puck.vx = -Math.abs(puck.vx);
    bounced = true;
  }
  return bounced;
};

const handleGoal = () => {
  const puck = state.puck;
  const goalHeight = 140;
  const goalTop = canvas.height / 2 - goalHeight / 2;
  const goalBottom = canvas.height / 2 + goalHeight / 2;

  if (puck.x - puck.r <= 20 && puck.y > goalTop && puck.y < goalBottom) {
    state.scores.right += 1;
    scoreRightEl.textContent = state.scores.right.toString();
    state.status = "PLAYER 2 ?앹젏!";
    resetRound(1);
    return "right";
  }

  if (puck.x + puck.r >= canvas.width - 20 && puck.y > goalTop && puck.y < goalBottom) {
    state.scores.left += 1;
    scoreLeftEl.textContent = state.scores.left.toString();
    state.status = "PLAYER 1 ?앹젏!";
    resetRound(-1);
    return "left";
  }

  if (state.scores.left >= maxScore || state.scores.right >= maxScore) {
    state.running = false;
    state.status = state.scores.left > state.scores.right ? "PLAYER 1 ?밸━!" : "PLAYER 2 ?밸━!";
  }
  return null;
};

const resolveCollision = (paddle) => {
  const puck = state.puck;
  const dx = puck.x - paddle.x;
  const dy = puck.y - paddle.y;
  const dist = Math.hypot(dx, dy);
  const minDist = puck.r + paddle.r;

  if (dist < minDist) {
    const angle = Math.atan2(dy, dx);
    const targetX = paddle.x + Math.cos(angle) * minDist;
    const targetY = paddle.y + Math.sin(angle) * minDist;
    puck.x = targetX;
    puck.y = targetY;

    const speed = Math.hypot(puck.vx, puck.vy);
    const extra = 0.8;
    puck.vx = Math.cos(angle) * (speed + extra);
    puck.vy = Math.sin(angle) * (speed + extra);
    return true;
  }
  return false;
};

const updatePuck = () => {
  const puck = state.puck;
  puck.x += puck.vx;
  puck.y += puck.vy;

  puck.vx *= 0.995;
  puck.vy *= 0.995;

  const wall = handleWallCollision() || handleSideWalls();
  const hitLeft = resolveCollision(state.left);
  const hitRight = resolveCollision(state.right);
  const goal = handleGoal();
  if (wall) playWall();
  if (hitLeft || hitRight) playPaddle();
  if (goal) playGoal();
};

const draw = () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#9ecdf1";
  ctx.lineWidth = 4;
  ctx.strokeRect(30, 30, canvas.width - 60, canvas.height - 60);

  ctx.beginPath();
  ctx.setLineDash([12, 12]);
  ctx.moveTo(canvas.width / 2, 40);
  ctx.lineTo(canvas.width / 2, canvas.height - 40);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(canvas.width / 2, canvas.height / 2, 70, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "#ff7b2f";
  ctx.beginPath();
  ctx.arc(state.left.x, state.left.y, state.left.r, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#263e59";
  ctx.beginPath();
  ctx.arc(state.right.x, state.right.y, state.right.r, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#10172b";
  ctx.beginPath();
  ctx.arc(state.puck.x, state.puck.y, state.puck.r, 0, Math.PI * 2);
  ctx.fill();

  const goalHeight = 140;
  const goalTop = canvas.height / 2 - goalHeight / 2;
  ctx.fillStyle = "rgba(255, 123, 47, 0.15)";
  ctx.fillRect(20, goalTop, 20, goalHeight);
  ctx.fillStyle = "rgba(38, 62, 89, 0.15)";
  ctx.fillRect(canvas.width - 40, goalTop, 20, goalHeight);
};

const applyRemoteState = (payload) => {
  const prevLeft = state.scores.left;
  const prevRight = state.scores.right;

  if (role === "guest") {
    targetState = payload;
    targetStateTime = performance.now();
    state.scores = payload.scores;
    state.running = payload.running;
    state.status = payload.status;
  } else {
    state.left = { ...state.left, ...payload.left };
    state.right = { ...state.right, ...payload.right };
    state.puck = { ...state.puck, ...payload.puck };
    state.scores = payload.scores;
    state.running = payload.running;
    state.status = payload.status;
  }
  scoreLeftEl.textContent = state.scores.left.toString();
  scoreRightEl.textContent = state.scores.right.toString();
  statusText.textContent = state.status;

  const scored = state.scores.left !== prevLeft || state.scores.right !== prevRight;
  if (scored) playGoal();
  lastScoreLeft = state.scores.left;
  lastScoreRight = state.scores.right;
};
    state.right = { ...state.right, ...payload.right };
    state.puck = { ...state.puck, ...payload.puck };
    state.scores = payload.scores;
    state.running = payload.running;
    state.status = payload.status;
  }
  scoreLeftEl.textContent = state.scores.left.toString();
  scoreRightEl.textContent = state.scores.right.toString();
  statusText.textContent = state.status;
};

const sendMessage = (data) => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
};

const sendState = () => {
  if (role !== "host") return;
  sendMessage({
    type: "state",
    room: roomCode,
    payload: {
      left: state.left,
      right: state.right,
      puck: state.puck,
      scores: state.scores,
      running: state.running,
      status: state.status,
    },
  });
};

const sendInput = () => {
  if (role !== "guest" || !roomCode) return;
  const now = performance.now();
  lastInputSignature = `${inputState.up}${inputState.down}${inputState.left}${inputState.right}`;
  lastInputSentAt = now;
  lastSentPos = { x: state.right.x, y: state.right.y };
  sendMessage({
    type: "input",
    room: roomCode,
    payload: {
      input: inputState,
      pos: { x: state.right.x, y: state.right.y },
    },
  });
};

const loop = (time) => {
  if (role === "host") {
    if (state.running) {
      movePaddles();
      updatePuck();
    }
    if (time - lastSent > 8) {
      sendState();
      lastSent = time;
    }
  }
  if (role === "guest" && state.running) {
    moveGuestPaddleLocally();
    if (targetState) {
      state.left.x = smoothTo(state.left.x, targetState.left.x, 0.28);
      state.left.y = smoothTo(state.left.y, targetState.left.y, 0.28);
      state.puck.vx = targetState.puck.vx;
      state.puck.vy = targetState.puck.vy;
    }

    state.puck.x += state.puck.vx;
    state.puck.y += state.puck.vy;
    const wall = handleWallCollision() || handleSideWalls();
    const hitLeft = resolveCollision(state.left);
    const hitRight = resolveCollision(state.right);
    if (wall) playWall();
    if (hitLeft || hitRight) playPaddle();

    if (targetState) {
      const dx = targetState.puck.x - state.puck.x;
      const dy = targetState.puck.y - state.puck.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 40) {
        state.puck.x = targetState.puck.x;
        state.puck.y = targetState.puck.y;
      } else if (!hitRight) {
        state.puck.x = smoothTo(state.puck.x, targetState.puck.x, 0.25);
        state.puck.y = smoothTo(state.puck.y, targetState.puck.y, 0.25);
      }
    }
  } else if (role === "guest" && targetState) {
    state.left.x = targetState.left.x;
    state.left.y = targetState.left.y;
    state.puck.x = targetState.puck.x;
    state.puck.y = targetState.puck.y;
    state.puck.vx = targetState.puck.vx;
    state.puck.vy = targetState.puck.vy;
  }
  draw();
  requestAnimationFrame(loop);
};

const setConnectionStatus = (text) => {
  connectionStatus.textContent = text;
};

const connect = () => {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.host}`);

  socket.addEventListener("open", () => {
    setConnectionStatus("?쒕쾭 ?곌껐??);
    if (roomCode) {
      sendMessage({ type: "join", room: roomCode });
    }
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "role") {
      role = message.role;
      setConnectionStatus(`諛?${message.room} 쨌 ${role === "host" ? "HOST" : "GUEST"}`);
      statusText.textContent =
        role === "host"
          ? "?곷?媛 ?ㅼ뼱?ㅻ㈃ ?ㅽ럹?댁뒪濡??쒖옉!"
          : "HOST媛 ?쒖옉?섎㈃ 寃쎄린 ?쒖옉!";
    }

    if (message.type === "full") {
      setConnectionStatus("諛⑹씠 媛??李쇱뼱??");
    }

    if (message.type === "guest-joined") {
      statusText.textContent = "?곷? ?낆옣! ?ㅽ럹?댁뒪濡??쒖옉!";
    }

    if (message.type === "guest-left") {
      statusText.textContent = "?곷?媛 ?섍컮?댁슂.";
      state.running = false;
    }

    if (message.type === "host-left") {
      statusText.textContent = "HOST媛 ?섍컮?댁슂. ??諛⑹쓣 留뚮뱾?댁＜?몄슂.";
      state.running = false;
    }

    if (message.type === "guest-input" && role === "host") {
      if (message.payload.input) {
        Object.assign(guestInput, message.payload.input);
      }
      if (message.payload.pos) {
        guestPos = {
          x: clamp(message.payload.pos.x, canvas.width / 2 + 40, bounds.maxX),
          y: clamp(message.payload.pos.y, bounds.minY, bounds.maxY),
        };
        guestPosTime = performance.now();
      }
    }

    if (message.type === "state" && role === "guest") {
      applyRemoteState(message.payload);
    }
  });

  socket.addEventListener("close", () => {
    setConnectionStatus("?곌껐 ?딄?");
  });
};

const createRoomCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};

const joinRoom = (code) => {
  const cleaned = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,6}$/.test(cleaned)) {
    statusText.textContent = "諛?肄붾뱶??4~6?먮━ ?곷Ц/?レ옄留?媛?ν빐.";
    return;
  }
  roomCode = cleaned;
  roomInput.value = roomCode;
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    connect();
    return;
  }
  if (socket.readyState === WebSocket.OPEN) {
    sendMessage({ type: "join", room: roomCode });
  }
};

const copyShareLink = async () => {
  if (!roomCode) {
    statusText.textContent = "癒쇱? 諛⑹쓣 留뚮뱾?댁쨾.";
    return;
  }
  const url = `${window.location.origin}?room=${roomCode}`;
  try {
    await navigator.clipboard.writeText(url);
    statusText.textContent = "留곹겕瑜?蹂듭궗?덉뼱!";
  } catch (error) {
    statusText.textContent = "蹂듭궗 ?ㅽ뙣. 二쇱냼李?留곹겕瑜?吏곸젒 蹂듭궗?댁쨾.";
  }
};

document.addEventListener("keydown", (event) => {
  initAudio();
  const key = event.key.toLowerCase();
  if (["w", "a", "s", "d", " "].includes(key)) {
    event.preventDefault();
  }
  if (key === " ") {
    if (role === "host") {
      state.running = !state.running;
      state.status = state.running ? "寃쎄린 吏꾪뻾 以?" : "?쇱떆?뺤?";
      statusText.textContent = state.status;
      sendState();
    }
    return;
  }
  if (role === "host") {
    if (key === "w") inputState.up = true;
    if (key === "s") inputState.down = true;
    if (key === "a") inputState.left = true;
    if (key === "d") inputState.right = true;
  }

  if (role === "guest") {
    if (key === "w") inputState.up = true;
    if (key === "s") inputState.down = true;
    if (key === "a") inputState.left = true;
    if (key === "d") inputState.right = true;
    sendInput();
  }
});

document.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  if (role === "host") {
    if (key === "w") inputState.up = false;
    if (key === "s") inputState.down = false;
    if (key === "a") inputState.left = false;
    if (key === "d") inputState.right = false;
  }

  if (role === "guest") {
    if (key === "w") inputState.up = false;
    if (key === "s") inputState.down = false;
    if (key === "a") inputState.left = false;
    if (key === "d") inputState.right = false;
    sendInput();
  }
});

resetBtn.addEventListener("click", resetGame);
createBtn.addEventListener("click", () => joinRoom(createRoomCode()));
joinBtn.addEventListener("click", () => joinRoom(roomInput.value));
copyLinkBtn.addEventListener("click", copyShareLink);
canvas.addEventListener("click", initAudio);

setInterval(sendInput, 16);

const params = new URLSearchParams(window.location.search);
const roomParam = params.get("room");
if (roomParam) {
  roomInput.value = roomParam.toUpperCase();
  joinRoom(roomParam);
} else {
  connect();
}

resetGame();
requestAnimationFrame(loop);









