// 캔버스/DOM 요소
const canvas = document.getElementById("arena");
const ctx = canvas.getContext("2d");
const resetBtn = document.getElementById("resetBtn");
const statusText = document.getElementById("statusText");
const scoreLeftEl = document.getElementById("scoreLeft");
const scoreRightEl = document.getElementById("scoreRight");
const pingValueEl = document.getElementById("pingValue");
const roomInput = document.getElementById("roomInput");
const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const copyLinkBtn = document.getElementById("copyLinkBtn");
const connectionStatus = document.getElementById("connectionStatus");

// 입력/상수
const keys = new Set();
const maxScore = 7;
const inputState = { up: false, down: false, left: false, right: false };

// 게임 상태
const state = {
  left: { x: 140, y: 260, r: 26, speed: 5.5 },
  right: { x: 760, y: 260, r: 26, speed: 5.5 },
  puck: { x: 450, y: 260, r: 16, vx: 4, vy: 2.5 },
  scores: { left: 0, right: 0 },
  running: false,
  status: "스페이스를 누르면 시작!",
};

// 경기장 경계
const bounds = {
  minX: 40,
  maxX: canvas.width - 40,
  minY: 40,
  maxY: canvas.height - 40,
};

// 네트워크/동기화
let socket;
let role = null;
let roomCode = "";
let lastSent = 0;
let targetState = null;
let renderRight = { x: state.right.x, y: state.right.y, r: state.right.r };
// 오디오
let audioReady = false;
let audioContext;
let masterGain;
let bgm;
let lastScoreLeft = 0;
let lastScoreRight = 0;
let lastPingSentAt = 0;
let pingMs = null;
// 락스텝 동기화
const TICK_MS = 50;
let tick = 0;
let tickAccumulator = 0;
let lastFrameTime = performance.now();
let hostInputBuffer = new Map();
let guestInputBuffer = new Map();
let lastHostInput = { up: false, down: false, left: false, right: false };
let lastGuestInput = { up: false, down: false, left: false, right: false };
let targetTick = 0;

// 유틸
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const lerp = (start, end, t) => start + (end - start) * t;
const smoothTo = (current, target, alpha, deadzone = 0.15) => {
  if (Math.abs(target - current) <= deadzone) return target;
  return lerp(current, target, alpha);
};

// 라운드/리셋
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
  tick = 0;
  tickAccumulator = 0;
  lastFrameTime = performance.now();
  hostInputBuffer.clear();
  guestInputBuffer.clear();
  lastHostInput = { up: false, down: false, left: false, right: false };
  lastGuestInput = { up: false, down: false, left: false, right: false };
  targetTick = 0;
  resetRound();
  sendState();
};

// 오디오 초기화/효과음
const initAudio = () => {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioContext.createGain();
    masterGain.gain.value = 0.35;
    masterGain.connect(audioContext.destination);
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
  if (!audioReady) {
    audioReady = true;
    if (!bgm) {
      bgm = new Audio("assets/first_light_particles.wav");
      bgm.loop = true;
      bgm.volume = 0.5;
    }
    bgm.play().catch(() => {});
  }
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
const playGoal = () => playTone(220, 0.22, 0.3);

// 입력 스냅샷 생성
const getInputSnapshot = () => ({
  up: inputState.up,
  down: inputState.down,
  left: inputState.left,
  right: inputState.right,
});

// 입력을 패들에 적용(락스텝)
const applyInputToPaddle = (paddle, input) => {
  if (input.up) paddle.y -= paddle.speed;
  if (input.down) paddle.y += paddle.speed;
  if (input.left) paddle.x -= paddle.speed;
  if (input.right) paddle.x += paddle.speed;
  return paddle;
};

// 락스텝 입력으로 패들 이동(호스트)
const movePaddlesByInputs = (leftInput, rightInput) => {
  const left = applyInputToPaddle(state.left, leftInput);
  const right = applyInputToPaddle(state.right, rightInput);

  left.x = clamp(left.x, bounds.minX, canvas.width / 2 - 40);
  left.y = clamp(left.y, bounds.minY, bounds.maxY);
  right.x = clamp(right.x, canvas.width / 2 + 40, bounds.maxX);
  right.y = clamp(right.y, bounds.minY, bounds.maxY);
};

// 벽 충돌 처리
const handleWallCollision = () => {
  const puck = state.puck;
  let bounced = false;
  if (puck.y - puck.r <= bounds.minY || puck.y + puck.r >= bounds.maxY) {
    puck.vy *= -1;
    bounced = true;
  }
  return bounced;
};

// 좌우 벽 충돌 처리(골문 제외)
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

// 득점 처리
const handleGoal = () => {
  const puck = state.puck;
  const goalHeight = 140;
  const goalTop = canvas.height / 2 - goalHeight / 2;
  const goalBottom = canvas.height / 2 + goalHeight / 2;

  if (puck.x - puck.r <= 20 && puck.y > goalTop && puck.y < goalBottom) {
    state.scores.right += 1;
    scoreRightEl.textContent = state.scores.right.toString();
    state.status = "플레이어 2 득점!";
    resetRound(1);
    return "right";
  }

  if (puck.x + puck.r >= canvas.width - 20 && puck.y > goalTop && puck.y < goalBottom) {
    state.scores.left += 1;
    scoreLeftEl.textContent = state.scores.left.toString();
    state.status = "플레이어 1 득점!";
    resetRound(-1);
    return "left";
  }

  if (state.scores.left >= maxScore || state.scores.right >= maxScore) {
    state.running = false;
    state.status = state.scores.left > state.scores.right ? "플레이어 1 승리!" : "플레이어 2 승리!";
  }
  return null;
};

// 패들 충돌 처리
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

// 퍽 물리 업데이트(호스트)
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

// 렌더링
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

  const rightPaddle = role === "host" ? renderRight : state.right;
  ctx.fillStyle = "#263e59";
  ctx.beginPath();
  ctx.arc(rightPaddle.x, rightPaddle.y, rightPaddle.r, 0, Math.PI * 2);
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

// 원격 상태 적용(게스트)
const applyRemoteState = (payload) => {
  const prevLeft = state.scores.left;
  const prevRight = state.scores.right;

  if (role === "guest") {
    targetState = payload;
    state.scores = payload.scores;
    state.running = payload.running;
    state.status = payload.status;
    if (typeof payload.tick === "number") {
      targetTick = payload.tick + 1;
    }
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

// 메시지 전송
const sendMessage = (data) => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
};

// 핑 측정(왕복 지연)
const sendPing = () => {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  lastPingSentAt = performance.now();
  sendMessage({ type: "ping", at: lastPingSentAt });
};

// 호스트 상태 브로드캐스트
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
      tick,
    },
  });
};

// 게스트 입력 전송
const sendInput = () => {
  if (role !== "guest" || !roomCode) return;
  sendMessage({
    type: "input",
    room: roomCode,
    payload: {
      tick: targetTick,
      input: getInputSnapshot(),
    },
  });
};

// 게임 루프(락스텝)
const loop = (time) => {
  const delta = time - lastFrameTime;
  lastFrameTime = time;
  tickAccumulator += delta;

  if (role === "host") {
    while (tickAccumulator >= TICK_MS) {
      if (!state.running) {
        tickAccumulator = 0;
        break;
      }

      if (!hostInputBuffer.has(tick)) {
        hostInputBuffer.set(tick, getInputSnapshot());
      }

      const hostInput = hostInputBuffer.get(tick) || lastHostInput;
      const guestInput = guestInputBuffer.get(tick);
      const resolvedGuestInput = guestInput || lastGuestInput;

      if (!guestInput) {
        state.status = "입력 지연 - 예측 중...";
      }

      lastHostInput = hostInput;
      if (guestInput) {
        lastGuestInput = guestInput;
      }
      movePaddlesByInputs(hostInput, resolvedGuestInput);
      updatePuck();
      tick += 1;
      tickAccumulator -= TICK_MS;
      state.status = "경기 진행 중!";

      sendState();
      hostInputBuffer.delete(tick - 10);
      guestInputBuffer.delete(tick - 10);
    }

    renderRight.x = smoothTo(renderRight.x, state.right.x, 0.65, 0);
    renderRight.y = smoothTo(renderRight.y, state.right.y, 0.65, 0);
    renderRight.r = state.right.r;
  }

  if (role === "guest" && targetState) {
    state.left = { ...state.left, ...targetState.left };
    state.right = { ...state.right, ...targetState.right };
    state.puck = { ...state.puck, ...targetState.puck };
  }

  draw();
  requestAnimationFrame(loop);
};

// 연결 상태 표시
const setConnectionStatus = (text) => {
  connectionStatus.textContent = text;
};

// WebSocket 연결
const connect = () => {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  setConnectionStatus("연결 중...");
  socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

  socket.addEventListener("open", () => {
    setConnectionStatus("연결됨");
    if (roomCode) {
      sendMessage({ type: "join", room: roomCode });
    }
    sendPing();
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "pong") {
      pingMs = Math.max(0, Math.round(performance.now() - message.at));
      pingValueEl.textContent = `${pingMs}ms`;
      return;
    }
    if (message.type === "role") {
      role = message.role;
      setConnectionStatus(`방 ${message.room} - ${role === "host" ? "호스트" : "게스트"}`);
      statusText.textContent =
        role === "host" ? "게스트 대기 중. 스페이스로 시작!" : "호스트가 시작하면 게임 시작.";
    }

    if (message.type === "full") {
      setConnectionStatus("방이 가득 찼어요");
    }

    if (message.type === "guest-joined") {
      statusText.textContent = "게스트 입장! 스페이스로 시작!";
    }

    if (message.type === "guest-left") {
      statusText.textContent = "게스트가 나갔어요.";
      state.running = false;
    }

    if (message.type === "host-left") {
      statusText.textContent = "호스트가 나갔어요. 새 방을 만들어주세요.";
      state.running = false;
    }

    if (message.type === "guest-input" && role === "host") {
      if (message.payload && typeof message.payload.tick === "number") {
        guestInputBuffer.set(message.payload.tick, message.payload.input);
      }
    }

    if (message.type === "state" && role === "guest") {
      applyRemoteState(message.payload);
    }
  });

  socket.addEventListener("close", () => {
    setConnectionStatus("연결 끊김");
  });

  socket.addEventListener("error", () => {
    setConnectionStatus("연결 오류");
  });
};

// 방 코드 생성/참가
const createRoomCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};

const joinRoom = (code) => {
  const cleaned = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,6}$/.test(cleaned)) {
    statusText.textContent = "방 코드는 4~6자리 영문/숫자만 가능해요.";
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

// 링크 복사
const copyShareLink = async () => {
  if (!roomCode) {
    statusText.textContent = "먼저 방을 만들어주세요.";
    return;
  }
  const url = `${window.location.origin}?room=${roomCode}`;
  try {
    await navigator.clipboard.writeText(url);
    statusText.textContent = "링크를 복사했어요!";
  } catch (error) {
    statusText.textContent = "복사 실패. 주소창 링크를 직접 복사해주세요.";
  }
};

// 키 입력 처리
document.addEventListener("keydown", (event) => {
  initAudio();
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
canvas.addEventListener("click", initAudio);
document.addEventListener("pointerdown", initAudio);

setInterval(sendInput, TICK_MS);
setInterval(sendPing, 1000);

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











