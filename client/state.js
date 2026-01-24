window.Game = window.Game || {};

window.Game.State = (() => {
  const { clamp, lerp } = window.Game.Utils;

  const createSnapshotBuffer = (maxSnapshots) => {
    const snapshots = [];

    const push = (state) => {
      snapshots.push(state);
      while (snapshots.length > maxSnapshots) {
        snapshots.shift();
      }
    };

    const sample = (renderTime) => {
      if (snapshots.length === 0) return null;
      if (snapshots.length === 1) return snapshots[0];

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
      const a = older;
      const b = newer;

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
        acks: b.acks,
      };
    };

    return {
      push,
      sample,
      size: () => snapshots.length,
    };
  };

  return { createSnapshotBuffer };
})();
