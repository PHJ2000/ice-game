window.Game = window.Game || {};

window.Game.Input = (() => {
  const create = ({
    onToggle,
    onInput,
    onMove,
    initAudio,
    canvas,
    getPaddlePosition,
    getSide,
    getPaddleRadius,
  }) => {
    const state = { up: false, down: false, left: false, right: false };
    let dirty = false;
    let dragging = false;
    let activePointerId = null;
    let pointerPos = null;

    const setState = (key, value) => {
      if (state[key] !== value) {
        state[key] = value;
        dirty = true;
      }
    };

    const resetState = () => {
      state.up = false;
      state.down = false;
      state.left = false;
      state.right = false;
      dirty = false;
    };

    const getCanvasPosition = (event) => {
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY,
      };
    };

    const applyPointerInput = (pos) => {
      const side = getSide ? getSide() : null;
      if (!side) return;
      const paddle = getPaddlePosition ? getPaddlePosition(side) : null;
      if (!paddle) return;
      const dx = pos.x - paddle.x;
      const dy = pos.y - paddle.y;
      const deadZone = 6;
      setState("left", dx < -deadZone);
      setState("right", dx > deadZone);
      setState("up", dy < -deadZone);
      setState("down", dy > deadZone);
    };

    const handlePointerDown = (event) => {
      initAudio();
      if (!canvas) return;
      const side = getSide ? getSide() : null;
      if (!side) return;
      const paddle = getPaddlePosition ? getPaddlePosition(side) : null;
      if (!paddle) return;
      const pos = getCanvasPosition(event);
      if (!pos) return;
      const radius = getPaddleRadius ? getPaddleRadius() : 0;
      const dx = pos.x - paddle.x;
      const dy = pos.y - paddle.y;
      const withinPaddle = Math.hypot(dx, dy) <= radius + 10;
      if (!withinPaddle) return;

      dragging = true;
      activePointerId = event.pointerId;
      pointerPos = pos;
      canvas.setPointerCapture(activePointerId);
      if (onMove) onMove(pos);
      event.preventDefault();
    };

    const handlePointerMove = (event) => {
      if (!dragging || event.pointerId !== activePointerId) return;
      const pos = getCanvasPosition(event);
      if (!pos) return;
      pointerPos = pos;
      if (onMove) onMove(pos);
    };

    const handlePointerUp = (event) => {
      if (!dragging || event.pointerId !== activePointerId) return;
      dragging = false;
      activePointerId = null;
      pointerPos = null;
      resetState();
      if (onMove) onMove(null);
      event.preventDefault();
    };

    const handleKeyDown = (event) => {
      initAudio();
      const key = event.key.toLowerCase();
      if (event.repeat && ["w", "a", "s", "d"].includes(key)) {
        return;
      }
      if (["w", "a", "s", "d", " "].includes(key)) {
        event.preventDefault();
      }
      if (key === " ") {
        onToggle();
        return;
      }
      if (key === "w") setState("up", true);
      if (key === "s") setState("down", true);
      if (key === "a") setState("left", true);
      if (key === "d") setState("right", true);
      pointerPos = null;
      onInput(true);
    };

    const handleKeyUp = (event) => {
      const key = event.key.toLowerCase();
      if (key === "w") setState("up", false);
      if (key === "s") setState("down", false);
      if (key === "a") setState("left", false);
      if (key === "d") setState("right", false);
      onInput(true);
    };

    const reset = () => {
      dragging = false;
      activePointerId = null;
      resetState();
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    if (canvas) {
      canvas.addEventListener("pointerdown", handlePointerDown);
      canvas.addEventListener("pointermove", handlePointerMove);
      canvas.addEventListener("pointerup", handlePointerUp);
      canvas.addEventListener("pointercancel", handlePointerUp);
    }

    return {
      getState: () => ({ ...state }),
      getPointerPos: () => (pointerPos ? { ...pointerPos } : null),
      isDragging: () => dragging,
      isDirty: () => dirty,
      clearDirty: () => {
        dirty = false;
      },
      reset,
    };
  };

  return { create };
})();
