window.Game = window.Game || {};

(async () => {
  const { Config, Utils, Audio, Input, Network, Render, State } = window.Game;

  const canvas = document.getElementById("arena");
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
  const rulesText = document.getElementById("rulesText");
  const muteBtn = document.getElementById("muteBtn");

  const config = await Config.load();
  const {
    ARENA,
    WALL,
    GOAL_HEIGHT,
    GOAL_DEPTH,
    SCORE_TO_WIN,
    BASE_BUFFER_MS,
    INPUT_SEND_INTERVAL_MS,
    INPUT_KEEPALIVE_MS,
    PADDLE_RADIUS,
    PUCK_RADIUS,
  } = config;

  if (rulesText) {
    rulesText.textContent = `왼쪽 플레이어: WASD · 오른쪽 플레이어: WASD · 목표 점수 ${SCORE_TO_WIN}점`;
  }

  const setMuteButton = () => {
    if (muteBtn) {
      muteBtn.textContent = Audio.isMuted() ? "음소거 해제" : "음소거";
    }
  };
  setMuteButton();
  if (muteBtn) {
    muteBtn.addEventListener("click", () => {
      Audio.toggleMute();
      setMuteButton();
    });
  }

  const renderer = Render.create(canvas, { WALL, GOAL_HEIGHT, GOAL_DEPTH });

  const renderState = {
    left: { x: 140, y: 260, r: PADDLE_RADIUS },
    right: { x: 760, y: 260, r: PADDLE_RADIUS },
    puck: { x: 450, y: 260, r: PUCK_RADIUS },
  };

  const snapshotBuffer = State.createSnapshotBuffer(20);

  let role = null;
  let side = null;
  let roomCode = "";

  let pingMs = null;
  let serverOffsetMs = null;

  let lastStateAt = 0;
  let frameCounter = 0;
  let fps = 0;
  let fpsLastAt = performance.now();
  let lastPaddleHitAt = 0;
  let lastWallHitAt = 0;
  let hitFlashUntil = 0;
  let lastInputSentAt = performance.now();

  const BOUNDS = {
    minX: WALL,
    maxX: ARENA.width - WALL,
    minY: WALL,
    maxY: ARENA.height - WALL,
  };

  const clampToSide = (pos) => {
    if (!pos || !side) return null;
    const mid = ARENA.width / 2;
    const minX = side === "left" ? BOUNDS.minX : mid;
    const maxX = side === "left" ? mid : BOUNDS.maxX;
    return {
      x: Utils.clamp(pos.x, minX, maxX),
      y: Utils.clamp(pos.y, BOUNDS.minY, BOUNDS.maxY),
    };
  };

  const applyStateSnapshot = (state) => {
    if (!state) return;
    const leftPlayer = state.leftId ? state.players.get(state.leftId) : null;
    const rightPlayer = state.rightId ? state.players.get(state.rightId) : null;
    if (!leftPlayer || !rightPlayer || !state.puck) return;

    const snapshot = {
      time: state.time || Date.now(),
      running: state.running,
      status: state.status,
      scores: { left: state.scoreLeft, right: state.scoreRight },
      left: { x: leftPlayer.x, y: leftPlayer.y, r: leftPlayer.r },
      right: { x: rightPlayer.x, y: rightPlayer.y, r: rightPlayer.r },
      puck: {
        x: state.puck.x,
        y: state.puck.y,
        r: state.puck.r,
        vx: state.puck.vx,
        vy: state.puck.vy,
      },
    };

    const clientNow = performance.timeOrigin + performance.now();
    const offsetSample = clientNow - snapshot.time;
    serverOffsetMs = serverOffsetMs === null ? offsetSample : Utils.lerp(serverOffsetMs, offsetSample, 0.1);

    snapshotBuffer.push(snapshot);
    lastStateAt = performance.now();

    scoreLeftEl.textContent = snapshot.scores.left.toString();
    scoreRightEl.textContent = snapshot.scores.right.toString();
    statusText.textContent = snapshot.status;
  };

  const network = Network.create({
    onStatus: (text) => {
      connectionStatus.textContent = text;
    },
    onPong: (message) => {
      const nowPerf = performance.now();
      const rtt = Math.max(0, nowPerf - message.at);
      pingMs = Math.round(rtt);
      pingValueEl.textContent = `${pingMs}ms`;
      if (Number.isFinite(message.serverTime)) {
        const clientNow = performance.timeOrigin + nowPerf;
        const offsetSample = clientNow - (message.serverTime + rtt / 2);
        serverOffsetMs = serverOffsetMs === null ? offsetSample : Utils.lerp(serverOffsetMs, offsetSample, 0.2);
      }
    },
    onRole: (message) => {
      role = message.role;
      side = message.side;
      connectionStatus.textContent = `방 ${message.room} - ${role === "host" ? "호스트" : "게스트"}`;
      statusText.textContent =
        role === "host" ? "게스트 입장 대기. 스페이스를 눌러 시작!" : "호스트가 시작하면 게임이 시작돼요.";
    },
    onFull: () => {
      connectionStatus.textContent = "방이 가득 찼어요";
    },
    onGuestJoined: () => {
      statusText.textContent = "게스트 입장! 스페이스를 눌러 시작!";
    },
    onGuestLeft: () => {
      statusText.textContent = "게스트가 나갔어요.";
    },
    onHostLeft: () => {
      statusText.textContent = "호스트가 나갔어요. 새 방을 만들어 주세요.";
    },
    onState: (state) => {
      applyStateSnapshot(state);
    },
    onEvent: (events) => {
      if (events.wall) {
        lastWallHitAt = performance.now();
        Audio.playWall();
      }
      if (events.paddle) {
        lastPaddleHitAt = performance.now();
        hitFlashUntil = performance.now() + 200;
        Audio.playPaddle();
      }
      if (events.goal) {
        Audio.playGoal();
        if (events.scorer && events.scorer === side) {
          Audio.playCheer();
        }
      }
    },
  });

  const input = Input.create({
    initAudio: Audio.initAudio,
    canvas,
    getSide: () => side,
    getPaddlePosition: (which) => (which === "left" ? renderState.left : renderState.right),
    getPaddleRadius: () => PADDLE_RADIUS,
    onMove: (pos) => {
      if (!network.isJoined()) return;
      if (!pos) {
        network.send("move", { x: null, y: null });
        return;
      }
      const clamped = clampToSide(pos);
      if (!clamped) return;
      network.send("move", clamped);
    },
    onToggle: () => {
      if (role === "host") {
        network.send("control", { action: "toggle" });
      }
    },
    onInput: (force) => {
      if (force) {
        network.send("move", { x: null, y: null });
      }
      maybeSendInput(force);
    },
  });

  const sendInput = () => {
    if (!network.isJoined()) return;
    network.send("input", input.getState());
    lastInputSentAt = performance.now();
    input.clearDirty();
  };

  const maybeSendInput = (force = false) => {
    if (!network.isJoined()) return;
    const elapsed = performance.now() - lastInputSentAt;
    if (!force && !input.isDirty() && elapsed < INPUT_KEEPALIVE_MS) return;
    sendInput();
  };

  const createRoomCode = () => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  };

  const joinRoom = (code) => {
    const cleaned = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,6}$/.test(cleaned)) {
      statusText.textContent = "방 코드는 4~6자리 영문/숫자만 입력해요.";
      return;
    }
    roomCode = cleaned;
    roomInput.value = roomCode;
    network.join(roomCode);
  };

  const copyShareLink = async () => {
    if (!roomCode) {
      statusText.textContent = "먼저 방을 만들어 주세요.";
      return;
    }
    const url = `${window.location.origin}?room=${roomCode}`;
    try {
      await navigator.clipboard.writeText(url);
      statusText.textContent = "링크를 복사했어요!";
    } catch (error) {
      statusText.textContent = "복사 실패. 주소창 링크를 직접 복사해 주세요.";
    }
  };

  const loop = () => {
    const perfNow = performance.now();
    const nowMs = performance.timeOrigin + perfNow;
    const offset = serverOffsetMs || 0;
    const renderTime = nowMs - offset - BASE_BUFFER_MS;

    frameCounter += 1;
    if (perfNow - fpsLastAt >= 500) {
      fps = Math.round((frameCounter * 1000) / (perfNow - fpsLastAt));
      frameCounter = 0;
      fpsLastAt = perfNow;
    }

    const sampled = snapshotBuffer.sample(renderTime);
    if (sampled) {
      renderState.left = sampled.left;
      renderState.right = sampled.right;
      renderState.puck = sampled.puck;
    }

    renderer.draw(renderState, hitFlashUntil);

    if (debugText) {
      const wsState = network.isJoined() ? "연결됨" : "미연결";
      const sinceState = lastStateAt ? Math.round(performance.now() - lastStateAt) : "-";
      const paddleAge = lastPaddleHitAt ? Math.round(performance.now() - lastPaddleHitAt) : "-";
      const wallAge = lastWallHitAt ? Math.round(performance.now() - lastWallHitAt) : "-";
      debugText.textContent =
        `역할: ${role || "없음"} / WS: ${wsState}\n` +
        `FPS: ${fps} / 핑: ${pingMs ?? "-"}ms\n` +
        `상태 수신: ${sinceState}ms 전\n` +
        `패들 충돌: ${paddleAge}ms 전 / 벽 충돌: ${wallAge}ms 전\n` +
        `스냅샷 버퍼: ${snapshotBuffer.size()}개 / 지연: ${BASE_BUFFER_MS}ms`;
    }

    requestAnimationFrame(loop);
  };

  resetBtn.addEventListener("click", () => network.send("control", { action: "reset" }));
  createBtn.addEventListener("click", () => joinRoom(createRoomCode()));
  joinBtn.addEventListener("click", () => joinRoom(roomInput.value));
  copyLinkBtn.addEventListener("click", copyShareLink);
  canvas.addEventListener("click", Audio.initAudio);
  document.addEventListener("pointerdown", Audio.initAudio);

  setInterval(() => maybeSendInput(), INPUT_SEND_INTERVAL_MS);
  setInterval(() => network.sendPing(), 1000);

  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get("room");
  if (roomParam) {
    roomInput.value = roomParam.toUpperCase();
    joinRoom(roomParam);
  }

  requestAnimationFrame(loop);
})();
