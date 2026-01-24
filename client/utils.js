window.Game = window.Game || {};

window.Game.Utils = {
  clamp: (value, min, max) => Math.min(Math.max(value, min), max),
  lerp: (start, end, t) => start + (end - start) * t,
};
