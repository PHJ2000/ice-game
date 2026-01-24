// ĵ����/DOM ���
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
const debugText = document.getElementById("debugText");

// �Է�/���
const inputState = { up: false, down: false, left: false, right: false };
const BASE_BUFFER_MS = 140;
const ARENA = { width: 900, height: 520 };
const BOUNDS = {
  minX: 40,
  maxX: ARENA.width - 40,
  minY: 40,
  maxY: ARENA.height - 40,
};
const PADDLE_SPEED = 6.4;

// ���� ����
const renderState = {
  left: { x: 140, y: 260, r: 26 },
  right: { x: 760, y: 260, r: 26 },
  puck: { x: 450, y: 260, r: 16 },
};

// ��Ʈ��ũ/����ȭ
let socket;
let role = null;
let side = null;
let roomCode = "";
let lastStateAt = 0;
let lastGuestInputAt = 0;
let inputSeq = 0;
let lastInputSentAt = performance.now();
let pendingInputs = [];
const MAX_PENDING_INPUTS = 120;
let lastAckSeq = 0;

// �����
let audioReady = false;
let audioContext;
let masterGain;
let bgm;

// ��
let pingMs = null;

// ������ ����
const snapshots = [];
const MAX_SNAPSHOTS = 20;

// Ŭ���̾�Ʈ ���� ����
const localPaddle = { x: 140, y: 260, r: 26 };
let hasLocalPaddle = false;
let lastLocalUpdateAt = performance.now();

// FPS
let frameCounter = 0;
let fps = 0;
let fpsLastAt = performance.now();
let lastPaddleHitAt = 0;
let lastWallHitAt = 0;
let hitFlashUntil = 0;

// ��ƿ
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const lerp = (start, end, t) => start + (end - start) * t;

// ���� ������ �е鸸 ����ϰ�, ���� ���� ���� ���·� �׸���.

// �е� �Է��� ���� ƽ ������ ����
const applyInputLocal = (paddle, input, dtScale) => {
  const speed = PADDLE_SPEED * dtScale;
  if (input.up) paddle.y -= speed;
  if (input.down) paddle.y += speed;
  if (input.left) paddle.x -= speed;
  if (input.right) paddle.x += speed;
};

// ����� �ʱ�ȭ/ȿ����
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

// �޽��� ����
const sendMessage = (data) => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
};

// �� ����(�պ� ����)
const sendPing = () => {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const sentAt = performance.now();
  sendMessage({ type: "ping", at: sentAt });
};

// �Խ�Ʈ �Է� ����
const sendInput = () => {
  if (!role || !roomCode) return;
  const now = performance.now();
  const dtMs = Math.max(1, now - lastInputSentAt);
  lastInputSentAt = now;
  inputSeq += 1;
  pendingInputs.push({ seq: inputSeq, state: { ...inputState }, dtMs });
  while (pendingInputs.length > MAX_PENDING_INPUTS) {
    pendingInputs.shift();
  }
  sendMessage({
    type: "input",
    room: roomCode,
    payload: { input: { ...inputState }, seq: inputSeq, dtMs },
  });
};

// ������ ����
const pushSnapshot = (payload) => {
  snapshots.push({ time: performance.now(), state: payload });
  while (snapshots.length > MAX_SNAPSHOTS) {
    snapshots.shift();
  }
};

// ������ ���� ����
const sampleState = (renderTime) => {
  if (snapshots.length === 0) return null;
  if (snapshots.length === 1) return snapshots[0].state;

  let older = snapshots[0];
  let newer = snapshots[snapshots.length - 1];
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    if (snapshots[i].time <= renderTime) {
      older = snapshots[i];
      newer = snapshots[i + 1] || snapshots[i];
      break;
    }
  }

  const span = newer.time - older.time || 1;
  const t = clamp((renderTime - older.time) / span, 0, 1);
  const a = older.state;
  const b = newer.state;

  return {
    time: renderTime,
    running: b.running,
    status: b.status,
    scores: b.scores,
    events: b.events,
    left: {
      x: lerp(a.left.x, b.left.x, t),
      y: lerp(a.left.y, b.left.y, t),
      r: b.left.r,
    },
    right: {
      x: lerp(a.right.x, b.right.x, t),
      y: lerp(a.right.y, b.right.y, t),
      r: b.right.r,
    },
    puck: {
      x: lerp(a.puck.x, b.puck.x, t),
      y: lerp(a.puck.y, b.puck.y, t),
      r: b.puck.r,
      vx: b.puck.vx,
      vy: b.puck.vy,
    },
  };
};

// ���� ack ��� �����Ǹ����̼�
const reconcileLocalPaddle = (payload) => {
  if (!side || !payload || !payload.acks) return;
  const ackSeq = payload.acks[side];
  if (!Number.isFinite(ackSeq)) return;
  if (ackSeq <= lastAckSeq) return;
  lastAckSeq = ackSeq;

  const auth = side === "left" ? payload.left : payload.right;
  localPaddle.x = auth.x;
  localPaddle.y = auth.y;
  localPaddle.r = auth.r;

  const remaining = [];
  for (const entry of pendingInputs) {
    if (entry.seq > ackSeq) {
      const dtScale = clamp(entry.dtMs / 16.6667, 0.25, 3);
      applyInputLocal(localPaddle, entry.state, dtScale);
      remaining.push(entry);
    }
  }
  pendingInputs = remaining;

  if (side === "left") {
    localPaddle.x = clamp(localPaddle.x, BOUNDS.minX, ARENA.width / 2 - 40);
  } else {
    localPaddle.x = clamp(localPaddle.x, ARENA.width / 2 + 40, BOUNDS.maxX);
  }
  localPaddle.y = clamp(localPaddle.y, BOUNDS.minY, BOUNDS.maxY);
  hasLocalPaddle = true;
};

// ������
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
  ctx.arc(renderState.left.x, renderState.left.y, renderState.left.r, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#263e59";
  ctx.beginPath();
  ctx.arc(renderState.right.x, renderState.right.y, renderState.right.r, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#10172b";
  ctx.beginPath();
  ctx.arc(renderState.puck.x, renderState.puck.y, renderState.puck.r, 0, Math.PI * 2);
  ctx.fill();

  if (hitFlashUntil > performance.now()) {
    ctx.strokeStyle = "rgba(255, 178, 64, 0.9)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(renderState.puck.x, renderState.puck.y, renderState.puck.r + 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 4;
  }

  const goalHeight = 140;
  const goalTop = canvas.height / 2 - goalHeight / 2;
  ctx.fillStyle = "rgba(255, 123, 47, 0.15)";
  ctx.fillRect(20, goalTop, 20, goalHeight);
  ctx.fillStyle = "rgba(38, 62, 89, 0.15)";
  ctx.fillRect(canvas.width - 40, goalTop, 20, goalHeight);
};

// ���� ���� ǥ��
const setConnectionStatus = (text) => {
  connectionStatus.textContent = text;
};

// WebSocket ����
const connect = () => {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  setConnectionStatus("���� ��...");
  socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

  socket.addEventListener("open", () => {
    setConnectionStatus("�����");
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
      side = message.side;
      inputSeq = 0;
      pendingInputs = [];
      lastInputSentAt = performance.now();
      lastAckSeq = 0;
      hasLocalPaddle = false;
      setConnectionStatus(`�� ${message.room} - ${role === "host" ? "ȣ��Ʈ" : "�Խ�Ʈ"}`);
      statusText.textContent =
        role === "host" ? "�Խ�Ʈ ��� ��. �����̽��� ����!" : "ȣ��Ʈ�� �����ϸ� ���� ����.";
      return;
    }

    if (message.type === "full") {
      setConnectionStatus("���� ���� á���");
      return;
    }

    if (message.type === "guest-joined") {
      statusText.textContent = "�Խ�Ʈ ����! �����̽��� ����!";
      return;
    }

    if (message.type === "guest-left") {
      statusText.textContent = "�Խ�Ʈ�� �������.";
      return;
    }

    if (message.type === "host-left") {
      statusText.textContent = "ȣ��Ʈ�� �������. �� ���� ������ּ���.";
      return;
    }

    if (message.type === "state") {
      lastStateAt = performance.now();
      pushSnapshot(message.payload);
      reconcileLocalPaddle(message.payload);
      scoreLeftEl.textContent = message.payload.scores.left.toString();
      scoreRightEl.textContent = message.payload.scores.right.toString();
      statusText.textContent = message.payload.status;

      if (message.payload.events) {
        if (message.payload.events.wall) {
          lastWallHitAt = performance.now();
          playWall();
        }
        if (message.payload.events.paddle) {
          lastPaddleHitAt = performance.now();
          hitFlashUntil = performance.now() + 200;
          playPaddle();
        }
        if (message.payload.events.goal) playGoal();
      }
    }

    if (message.type === "guest-input" && role === "host") {
      lastGuestInputAt = performance.now();
    }
  });

  socket.addEventListener("close", () => {
    setConnectionStatus("���� ����");
  });

  socket.addEventListener("error", () => {
    setConnectionStatus("���� ����");
  });
};

// �� �ڵ� ����/����
const createRoomCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};

const joinRoom = (code) => {
  const cleaned = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,6}$/.test(cleaned)) {
    statusText.textContent = "�� �ڵ�� 4~6�ڸ� ����/���ڸ� �����ؿ�.";
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

// ��ũ ����
const copyShareLink = async () => {
  if (!roomCode) {
    statusText.textContent = "���� ���� ������ּ���.";
    return;
  }
  const url = `${window.location.origin}?room=${roomCode}`;
  try {
    await navigator.clipboard.writeText(url);
    statusText.textContent = "��ũ�� �����߾��!";
  } catch (error) {
    statusText.textContent = "���� ����. �ּ�â ��ũ�� ���� �������ּ���.";
  }
};

// Ű �Է� ó��
document.addEventListener("keydown", (event) => {
  initAudio();
  const key = event.key.toLowerCase();
  if (["w", "a", "s", "d", " "].includes(key)) {
    event.preventDefault();
  }
  if (key === " ") {
    if (role === "host") {
      sendMessage({ type: "control", action: "toggle", room: roomCode });
    }
    return;
  }
  if (key === "w") inputState.up = true;
  if (key === "s") inputState.down = true;
  if (key === "a") inputState.left = true;
  if (key === "d") inputState.right = true;
  sendInput();
});

document.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  if (key === "w") inputState.up = false;
  if (key === "s") inputState.down = false;
  if (key === "a") inputState.left = false;
  if (key === "d") inputState.right = false;
  sendInput();
});

// ���� ����
const loop = () => {
  const perfNow = performance.now();
  const localDt = Math.min((perfNow - lastLocalUpdateAt) / 16.6667, 3);
  lastLocalUpdateAt = perfNow;
  const renderTime = perfNow - BASE_BUFFER_MS;

  frameCounter += 1;
  if (perfNow - fpsLastAt >= 500) {
    fps = Math.round((frameCounter * 1000) / (perfNow - fpsLastAt));
    frameCounter = 0;
    fpsLastAt = perfNow;
  }

  const sampled = sampleState(renderTime);
  if (sampled) {
    renderState.left = sampled.left;
    renderState.right = sampled.right;
    renderState.puck = sampled.puck;
  }

  // ���� �е� ����: �� �Է��� ��� �ݿ��� �������� Ȯ��
  if (side && sampled && sampled.running) {
    if (!hasLocalPaddle) {
      const base = side === "left" ? sampled.left : sampled.right;
      localPaddle.x = base.x;
      localPaddle.y = base.y;
      localPaddle.r = base.r;
      hasLocalPaddle = true;
    }

    const step = PADDLE_SPEED * localDt;
    if (inputState.up) localPaddle.y -= step;
    if (inputState.down) localPaddle.y += step;
    if (inputState.left) localPaddle.x -= step;
    if (inputState.right) localPaddle.x += step;

    if (side === "left") {
      localPaddle.x = clamp(localPaddle.x, BOUNDS.minX, ARENA.width / 2 - 40);
    } else {
      localPaddle.x = clamp(localPaddle.x, ARENA.width / 2 + 40, BOUNDS.maxX);
    }
    localPaddle.y = clamp(localPaddle.y, BOUNDS.minY, BOUNDS.maxY);

    if (side === "left") {
      renderState.left = { ...renderState.left, x: localPaddle.x, y: localPaddle.y };
    } else {
      renderState.right = { ...renderState.right, x: localPaddle.x, y: localPaddle.y };
    }
  }

  if (sampled && !sampled.running && side) {
    const base = side === "left" ? sampled.left : sampled.right;
    localPaddle.x = base.x;
    localPaddle.y = base.y;
    localPaddle.r = base.r;
    hasLocalPaddle = true;
  }

  draw();

  if (debugText) {
    const wsState = socket && socket.readyState === WebSocket.OPEN ? "�����" : "�̿���";
    const sinceState = lastStateAt ? Math.round(performance.now() - lastStateAt) : "-";
    const sinceGuestInput = lastGuestInputAt ? Math.round(performance.now() - lastGuestInputAt) : "-";
    const paddleAge = lastPaddleHitAt ? Math.round(performance.now() - lastPaddleHitAt) : "-";
    const wallAge = lastWallHitAt ? Math.round(performance.now() - lastWallHitAt) : "-";
    debugText.textContent =
      `����: ${role || "����"} / WS: ${wsState}\n` +
      `FPS: ${fps} / ��: ${pingMs ?? "-"}ms\n` +
      `�Խ�Ʈ �Է� ����: ${sinceGuestInput}ms ��\n` +
      `���� ����: ${sinceState}ms ��\n` +
      `�е� �浹: ${paddleAge}ms �� / �� �浹: ${wallAge}ms ��\n` +
      `������ ����: ${snapshots.length}�� / ����: ${BASE_BUFFER_MS}ms`;
  }

  requestAnimationFrame(loop);
};

resetBtn.addEventListener("click", () => sendMessage({ type: "control", action: "reset", room: roomCode }));
createBtn.addEventListener("click", () => joinRoom(createRoomCode()));
joinBtn.addEventListener("click", () => joinRoom(roomInput.value));
copyLinkBtn.addEventListener("click", copyShareLink);
canvas.addEventListener("click", initAudio);
document.addEventListener("pointerdown", initAudio);

setInterval(sendInput, 16);
setInterval(sendPing, 1000);

const params = new URLSearchParams(window.location.search);
const roomParam = params.get("room");
if (roomParam) {
  roomInput.value = roomParam.toUpperCase();
  joinRoom(roomParam);
} else {
  connect();
}

requestAnimationFrame(loop);
