window.Game = window.Game || {};

window.Game.Network = (() => {
  const create = ({
    onStatus,
    onPong,
    onRole,
    onFull,
    onGuestJoined,
    onGuestLeft,
    onHostLeft,
    onState,
    onEvent,
  }) => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const client = new window.Colyseus.Client(`${protocol}://${window.location.host}`);
    let room = null;

    const handleJoinError = (error) => {
      const message = String(error?.message || "");
      if (message.includes("max clients") || message.includes("full")) {
        if (onFull) onFull();
      } else {
        onStatus("연결 실패");
      }
    };

    const join = async (roomCode) => {
      try {
        onStatus("연결 중...");
        if (room) {
          room.leave();
          room = null;
        }
        room = await client.joinOrCreate("air_hockey", { roomCode });
        onStatus("연결됨");

        room.onStateChange((state) => {
          if (onState) onState(state);
        });

        room.onMessage("pong", (message) => {
          if (onPong) onPong(message);
        });

        room.onMessage("role", (message) => {
          if (onRole) onRole(message);
        });

        room.onMessage("guest-joined", () => {
          if (onGuestJoined) onGuestJoined();
        });

        room.onMessage("guest-left", () => {
          if (onGuestLeft) onGuestLeft();
        });

        room.onMessage("host-left", () => {
          if (onHostLeft) onHostLeft();
        });

        room.onMessage("event", (message) => {
          if (onEvent) onEvent(message);
        });

        room.onLeave(() => {
          onStatus("연결 종료");
        });
      } catch (error) {
        handleJoinError(error);
      }
    };

    return {
      join,
      send: (type, payload) => {
        if (!room) return;
        room.send(type, payload);
      },
      sendPing: () => {
        if (!room) return;
        room.send("ping", { at: performance.now() });
      },
      isJoined: () => Boolean(room),
    };
  };

  return { create };
})();
