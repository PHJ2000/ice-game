window.Game = window.Game || {};

window.Game.Input = (() => {
  const create = ({ onToggle, onInput, initAudio }) => {
    const state = { up: false, down: false, left: false, right: false };
    let dirty = false;

    const setState = (key, value) => {
      if (state[key] !== value) {
        state[key] = value;
        dirty = true;
      }
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
      state.up = false;
      state.down = false;
      state.left = false;
      state.right = false;
      dirty = false;
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);

    return {
      getState: () => ({ ...state }),
      isDirty: () => dirty,
      clearDirty: () => {
        dirty = false;
      },
      reset,
    };
  };

  return { create };
})();
