window.Game = window.Game || {};

window.Game.Config = {
  defaults: {
    ARENA: { width: 900, height: 520 },
    WALL: 40,
    GOAL_HEIGHT: 140,
    SCORE_TO_WIN: 7,
    BASE_BUFFER_MS: 140,
    PADDLE_RADIUS: 26,
    PUCK_RADIUS: 16,
    PADDLE_SPEED_PX_PER_FRAME: 6.8,
    PUCK_INITIAL_VX_PX_PER_FRAME: 6.2,
    PUCK_INITIAL_VY_PX_PER_FRAME: 3.6,
    MAX_PUCK_SPEED_PX_PER_FRAME: 20,
    INPUT_SEND_INTERVAL_MS: 50,
    INPUT_KEEPALIVE_MS: 120,
  },
  async load() {
    try {
      const response = await fetch("/config", { cache: "no-store" });
      if (!response.ok) {
        return { ...this.defaults };
      }
      const data = await response.json();
      return { ...this.defaults, ...data };
    } catch (error) {
      return { ...this.defaults };
    }
  },
};
