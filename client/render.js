window.Game = window.Game || {};

window.Game.Render = (() => {
  const create = (canvas, config) => {
    const ctx = canvas.getContext("2d");
    const { WALL, GOAL_HEIGHT } = config;

    const draw = (renderState, hitFlashUntil) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      ctx.strokeStyle = "#9ecdf1";
      ctx.lineWidth = 4;
      ctx.strokeRect(WALL, WALL, canvas.width - WALL * 2, canvas.height - WALL * 2);

      ctx.beginPath();
      ctx.setLineDash([12, 12]);
      ctx.moveTo(canvas.width / 2, WALL);
      ctx.lineTo(canvas.width / 2, canvas.height - WALL);
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

      const goalTop = canvas.height / 2 - GOAL_HEIGHT / 2;
      const goalWidth = WALL / 2;
      const goalInset = WALL / 2;
      ctx.fillStyle = "rgba(255, 123, 47, 0.15)";
      ctx.fillRect(goalInset, goalTop, goalWidth, GOAL_HEIGHT);
      ctx.fillStyle = "rgba(38, 62, 89, 0.15)";
      ctx.fillRect(canvas.width - WALL, goalTop, goalWidth, GOAL_HEIGHT);
    };

    return { draw };
  };

  return { create };
})();
