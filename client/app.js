window.Game = window.Game || {};

(async () => {
  const {
    Config,
    Utils,
    Audio,
    Input,
    Network,
    Render,
    State,
  } = window.Game;

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
    SCORE_TO_WIN,
    BASE_BUFFER_MS,
    PADDLE_SPEED_PX_PER_FRAME,
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

  const renderer = Render.create(canvas, { WALL, GOAL_HEIGHT });

  const renderState = {
    left: { x: 140, y: 260, r: PADDLE_RADIUS },
    right: { x: 760, y: 260, r: PADDLE_RADIUS },
    puck: { x: 450, y: 260, r: PUCK_RADIUS },
  };

  const localPaddle = { x: 140, y: 260, r: PADDLE_RADIUS };
  let hasLocalPaddle = false;
  let lastLocalUpdateAt = performance.now();

  const BOUNDS = {
    minX: WALL,
    maxX: ARENA.width - WALL,
    minY: WALL,
    maxY: ARENA.height - WALL,
  };

  let socketRole = null;
  let socketSide = null;
  let roomCode = "";
  let lastStateAt = 0;
  let lastGuestInputAt = 0;
  let inputSeq = 0;
  let lastInputSentAt = performance.now();
  let pendingInputs = [];
  const MAX_PENDING_INPUTS = 120;
  let lastAckSeq = 0;

  let pingMs = null;
  let serverOffsetMs = null;

  let frameCounter = 0;
  let fps = 0;
  let fpsLastAt = performance.now();
  let lastPaddleHitAt = 0;
  let lastWallHitAt = 0;
  let hitFlashUntil = 0;

  const snapshotBuffer = State.createSnapshotBuffer(20);

  const normalizeStatePayload = (payload) => {
    if (!payload || typeof payload !== "object") return null;

    if (payload.l && payload.p && payload.rt) {
      const events = payload.e || [0, 0, 0];
      const acks = payload.a || [0, 0];
      return {
        time: payload.t ?? Date.now(),
        running: Boolean(payload.r),
        status: payload.st || "",
        scores: { left: payload.s?.[0] ?? 0, right: payload.s?.[1] ?? 0 },
        events: {
          wall: Boolean(events[0]),
          paddle: Boolean(events[1]),
          goal: Boolean(events[2]),
        },
        left: { x: payload.l[0], y: payload.l[1], r: payload.l[2] },
        right: { x: payload.rt[0], y: payload.rt[1], r: payload.rt[2] },
        puck: {
          x: payload.p[0],
          y: payload.p[1],
          r: payload.p[2],
          vx: payload.p[3],
          vy: payload.p[4],
        },
        acks: { left: acks[0], right: acks[1] },
      };
    }

    return {
      time: payload.time ?? Date.now(),
      running: payload.running,
      status: payload.status,
      scores: payload.scores,
      events: payload.events,
      left: payload.left,
      right: payload.right,
      puck: payload.puck,
      acks: payload.acks || { left: 0, right: 0 },
    };
  };

  const pushSnapshot = (payload) => {
    const normalized = normalizeStatePayload(payload);
    if (!normalized) return;

    if (Number.isFinite(normalized.time)) {
      const offsetSample = Date.now() - normalized.time;
      serverOffsetMs =
        serverOffsetMs === null ? offsetSample : Utils.lerp(serverOffsetMs, offsetSample, 0.1);
    }

    snapshotBuffer.push(normalized);
  };

  const reconcileLocalPaddle = (payload) => {
    if (!socketSide || !payload || !payload.acks) return;
    const ackSeq = payload.acks[socketSide];
    if (!Number.isFinite(ackSeq)) return;
    if (ackSeq <= lastAckSeq) return;
    lastAckSeq = ackSeq;

    const auth = socketSide === "left" ? payload.left : payload.right;
    localPaddle.x = auth.x;
    localPaddle.y = auth.y;
    localPaddle.r = auth.r;

    const remaining = [];
    for (const entry of pendingInputs) {
      if (entry.seq > ackSeq) {
        const dtScale = Utils.clamp(entry.dtMs / 16.6667, 0.25, 3);
        const speed = PADDLE_SPEED_PX_PER_FRAME * dtScale;
        if (entry.state.up) localPaddle.y -= speed;
        if (entry.state.down) localPaddle.y += speed;
        if (entry.state.left) localPaddle.x -= speed;
        if (entry.state.right) localPaddle.x += speed;
        remaining.push(entry);
      }
    }
    pendingInputs = remaining;

    if (socketSide === "left") {
      localPaddle.x = Utils.clamp(localPaddle.x, BOUNDS.minX, ARENA.width / 2 - WALL);
    } else {
      localPaddle.x = Utils.clamp(localPaddle.x, ARENA.width / 2 + WALL, BOUNDS.maxX);
    }
    localPaddle.y = Utils.clamp(localPaddle.y, BOUNDS.minY, BOUNDS.maxY);
    hasLocalPaddle = true;
  };

  let input;

  const network = Network.create({
    onStatus: (text) => {
      connectionStatus.textContent = text;
    },
    onOpen: () => {
      if (roomCode) {
        network.send({ type: "join", room: roomCode });
      }
      network.sendPing();
    },
    onPong: (message) => {
      pingMs = Math.max(0, Math.round(performance.now() - message.at));
      pingValueEl.textContent = `${pingMs}ms`;
    },
    onRole: (message) => {
      socketRole = message.role;
      socketSide = message.side;
      inputSeq = 0;
      pendingInputs = [];
      lastInputSentAt = performance.now();
      lastAckSeq = 0;
      if (input) input.reset();
      hasLocalPaddle = false;
      connectionStatus.textContent = `방 ${message.room} - ${socketRole === "host" ? "호스트" : "게스트"}`;
      statusText.textContent =
        socketRole === "host"
          ? "게스트 입장 대기. 스페이스를 눌러 시작!"
          : "호스트가 시작하면 게임이 시작돼요.";
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
    onRoomExpired: () => {
      statusText.textContent = "방이 만료되어 종료됐어요. 새 방을 만들어 주세요.";
    },
    onState: (payload) => {
      lastStateAt = performance.now();
      pushSnapshot(payload);
      const latest = normalizeStatePayload(payload);
      if (latest) {
        reconcileLocalPaddle(latest);
        scoreLeftEl.textContent = latest.scores.left.toString();
        scoreRightEl.textContent = latest.scores.right.toString();
        statusText.textContent = latest.status;
        if (latest.events) {
          if (latest.events.wall) {
            lastWallHitAt = performance.now();
            Audio.playWall();
          }
          if (latest.events.paddle) {
            lastPaddleHitAt = performance.now();
            hitFlashUntil = performance.now() + 200;
            Audio.playPaddle();
          }
          if (latest.events.goal) Audio.playGoal();
        }
      }
    },
    onGuestInput: () => {
      lastGuestInputAt = performance.now();
    },
  });

  const sendInput = (inputState) => {
    if (!socketRole || !roomCode) return;
    const now = performance.now();
    const dtMs = Math.max(1, now - lastInputSentAt);
    lastInputSentAt = now;
    inputSeq += 1;
    pendingInputs.push({ seq: inputSeq, state: { ...inputState }, dtMs });
    while (pendingInputs.length > MAX_PENDING_INPUTS) {
      pendingInputs.shift();
    }
    network.send({
      type: "input",
      room: roomCode,
      payload: { input: { ...inputState }, seq: inputSeq, dtMs },
    });
  };

  const maybeSendInput = (force = false) => {
    if (!socketRole || !roomCode) return;
    const elapsed = performance.now() - lastInputSentAt;
    if (!force && !input.isDirty() && elapsed < INPUT_KEEPALIVE_MS) return;
    sendInput(input.getState());
    input.clearDirty();
  };

  input = Input.create({
    initAudio: Audio.initAudio,
    onToggle: () => {
      if (socketRole === "host") {
        network.send({ type: "control", action: "toggle", room: roomCode });
      }
    },
    onInput: (force) => {
      maybeSendInput(force);
    },
  });

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
    if (!network.isOpen()) {
      network.connect();
      return;
    }
    network.send({ type: "join", room: roomCode });
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
    const localDt = Math.min((perfNow - lastLocalUpdateAt) / 16.6667, 3);
    lastLocalUpdateAt = perfNow;

    const nowMs = Date.now();
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

    if (socketSide && sampled && sampled.running) {
      if (!hasLocalPaddle) {
        const base = socketSide === "left" ? sampled.left : sampled.right;
        localPaddle.x = base.x;
        localPaddle.y = base.y;
        localPaddle.r = base.r;
        hasLocalPaddle = true;
      }

      const step = PADDLE_SPEED_PX_PER_FRAME * localDt;
      const inputState = input.getState();
      if (inputState.up) localPaddle.y -= step;
      if (inputState.down) localPaddle.y += step;
      if (inputState.left) localPaddle.x -= step;
      if (inputState.right) localPaddle.x += step;

      if (socketSide === "left") {
        localPaddle.x = Utils.clamp(localPaddle.x, BOUNDS.minX, ARENA.width / 2 - WALL);
      } else {
        localPaddle.x = Utils.clamp(localPaddle.x, ARENA.width / 2 + WALL, BOUNDS.maxX);
      }
      localPaddle.y = Utils.clamp(localPaddle.y, BOUNDS.minY, BOUNDS.maxY);

      if (socketSide === "left") {
        renderState.left = { ...renderState.left, x: localPaddle.x, y: localPaddle.y };
      } else {
        renderState.right = { ...renderState.right, x: localPaddle.x, y: localPaddle.y };
      }
    }

    if (sampled && !sampled.running && socketSide) {
      const base = socketSide === "left" ? sampled.left : sampled.right;
      localPaddle.x = base.x;
      localPaddle.y = base.y;
      localPaddle.r = base.r;
      hasLocalPaddle = true;
    }

    renderer.draw(renderState, hitFlashUntil);

    if (debugText) {
      const wsState = network.isOpen() ? "연결됨" : "미연결";
      const sinceState = lastStateAt ? Math.round(performance.now() - lastStateAt) : "-";
      const sinceGuestInput = lastGuestInputAt ? Math.round(performance.now() - lastGuestInputAt) : "-";
      const paddleAge = lastPaddleHitAt ? Math.round(performance.now() - lastPaddleHitAt) : "-";
      const wallAge = lastWallHitAt ? Math.round(performance.now() - lastWallHitAt) : "-";
      debugText.textContent =
        `역할: ${socketRole || "없음"} / WS: ${wsState}\n` +
        `FPS: ${fps} / 핑: ${pingMs ?? "-"}ms\n` +
        `게스트 입력 지연: ${sinceGuestInput}ms 전\n` +
        `상태 수신: ${sinceState}ms 전\n` +
        `패들 충돌: ${paddleAge}ms 전 / 벽 충돌: ${wallAge}ms 전\n` +
        `스냅샷 버퍼: ${snapshotBuffer.size()}개 / 지연: ${BASE_BUFFER_MS}ms`;
    }

    requestAnimationFrame(loop);
  };

  resetBtn.addEventListener("click", () => network.send({ type: "control", action: "reset", room: roomCode }));
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
  } else {
    network.connect();
  }

  requestAnimationFrame(loop);
})();
