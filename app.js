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
  status: "스페이스를 누르면 시작!",
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
let targetState = null;
let targetStateTime = 0;

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
  state.status = "스페이스를 누르면 시작!";
  statusText.textContent = state.status;
  resetRound();
  sendState();
};

const movePaddles = () => {
  const left = state.left;
  const right = state.right;

  if (inputState.up) left.y -= left.speed;
  if (inputState.down) left.y += left.speed;
  if (inputState.left) left.x -= left.speed;
  if (inputState.right) left.x += left.speed;

  if (guestInput.up) right.y -= right.speed;
  if (guestInput.down) right.y += right.speed;
  if (guestInput.left) right.x -= right.speed;
  if (guestInput.right) right.x += right.speed;

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
  if (puck.y - puck.r <= bounds.minY || puck.y + puck.r >= bounds.maxY) {
    puck.vy *= -1;
  }
};

const handleSideWalls = () => {
  const puck = state.puck;
  const goalHeight = 140;
  const goalTop = canvas.height / 2 - goalHeight / 2;
  const goalBottom = canvas.height / 2 + goalHeight / 2;
  const inGoalY = puck.y > goalTop && puck.y < goalBottom;

  if (!inGoalY && puck.x - puck.r <= bounds.minX) {
    puck.vx = Math.abs(puck.vx);
  }

  if (!inGoalY && puck.x + puck.r >= bounds.maxX) {
    puck.vx = -Math.abs(puck.vx);
  }
};

const handleGoal = () => {
  const puck = state.puck;
  const goalHeight = 140;
  const goalTop = canvas.height / 2 - goalHeight / 2;
  const goalBottom = canvas.height / 2 + goalHeight / 2;

  if (puck.x - puck.r <= 20 && puck.y > goalTop && puck.y < goalBottom) {
    state.scores.right += 1;
    scoreRightEl.textContent = state.scores.right.toString();
    state.status = "PLAYER 2 득점!";
    resetRound(1);
  }

  if (puck.x + puck.r >= canvas.width - 20 && puck.y > goalTop && puck.y < goalBottom) {
    state.scores.left += 1;
    scoreLeftEl.textContent = state.scores.left.toString();
    state.status = "PLAYER 1 득점!";
    resetRound(-1);
  }

  if (state.scores.left >= maxScore || state.scores.right >= maxScore) {
    state.running = false;
    state.status = state.scores.left > state.scores.right ? "PLAYER 1 승리!" : "PLAYER 2 승리!";
  }
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
  }
};

const updatePuck = () => {
  const puck = state.puck;
  puck.x += puck.vx;
  puck.y += puck.vy;

  puck.vx *= 0.995;
  puck.vy *= 0.995;

  handleWallCollision();
  handleSideWalls();
  resolveCollision(state.left);
  resolveCollision(state.right);
  handleGoal();
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
  if (role === "guest") {
    targetState = payload;
    targetStateTime = performance.now();
    state.puck.vx = payload.puck.vx;
    state.puck.vy = payload.puck.vy;
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
  const signature = `${inputState.up}${inputState.down}${inputState.left}${inputState.right}`;
  if (signature === lastInputSignature) return;
  lastInputSignature = signature;
  sendMessage({ type: "input", room: roomCode, payload: inputState });
};

const loop = (time) => {
  if (role === "host") {
    if (state.running) {
      movePaddles();
      updatePuck();
    }
    if (time - lastSent > 16) {
      sendState();
      lastSent = time;
    }
  }
  if (role === "guest" && state.running) {
    moveGuestPaddleLocally();
    if (targetState) {
      const since = Math.min((time - targetStateTime) / 1000, 0.15);
      const predictedX = targetState.puck.x + targetState.puck.vx * since * 60;
      const predictedY = targetState.puck.y + targetState.puck.vy * since * 60;
      state.left.x = smoothTo(state.left.x, targetState.left.x, 0.12);
      state.left.y = smoothTo(state.left.y, targetState.left.y, 0.12);
      state.puck.x = smoothTo(state.puck.x, predictedX, 0.16);
      state.puck.y = smoothTo(state.puck.y, predictedY, 0.16);
    }
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
    setConnectionStatus("서버 연결됨");
    if (roomCode) {
      sendMessage({ type: "join", room: roomCode });
    }
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "role") {
      role = message.role;
      setConnectionStatus(`방 ${message.room} · ${role === "host" ? "HOST" : "GUEST"}`);
      statusText.textContent =
        role === "host"
          ? "상대가 들어오면 스페이스로 시작!"
          : "HOST가 시작하면 경기 시작!";
    }

    if (message.type === "full") {
      setConnectionStatus("방이 가득 찼어요.");
    }

    if (message.type === "guest-joined") {
      statusText.textContent = "상대 입장! 스페이스로 시작!";
    }

    if (message.type === "guest-left") {
      statusText.textContent = "상대가 나갔어요.";
      state.running = false;
    }

    if (message.type === "host-left") {
      statusText.textContent = "HOST가 나갔어요. 새 방을 만들어주세요.";
      state.running = false;
    }

    if (message.type === "guest-input" && role === "host") {
      Object.assign(guestInput, message.payload);
    }

    if (message.type === "state" && role === "guest") {
      applyRemoteState(message.payload);
    }
  });

  socket.addEventListener("close", () => {
    setConnectionStatus("연결 끊김");
  });
};

const createRoomCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};

const joinRoom = (code) => {
  const cleaned = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,6}$/.test(cleaned)) {
    statusText.textContent = "방 코드는 4~6자리 영문/숫자만 가능해.";
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
    statusText.textContent = "먼저 방을 만들어줘.";
    return;
  }
  const url = `${window.location.origin}?room=${roomCode}`;
  try {
    await navigator.clipboard.writeText(url);
    statusText.textContent = "링크를 복사했어!";
  } catch (error) {
    statusText.textContent = "복사 실패. 주소창 링크를 직접 복사해줘.";
  }
};

document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (["w", "a", "s", "d", " "].includes(key)) {
    event.preventDefault();
  }
  if (key === " ") {
    if (role === "host") {
      state.running = !state.running;
      state.status = state.running ? "경기 진행 중!" : "일시정지";
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
