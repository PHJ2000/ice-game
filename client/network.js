window.Game = window.Game || {};

window.Game.Network = (() => {
  const create = ({
    onStatus,
    onOpen,
    onPong,
    onRole,
    onFull,
    onGuestJoined,
    onGuestLeft,
    onHostLeft,
    onRoomExpired,
    onState,
    onGuestInput,
  }) => {
    let socket;

    const send = (data) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(data));
      }
    };

    const connect = () => {
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        return;
      }
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      onStatus("연결 중...");
      socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

      socket.addEventListener("open", () => {
        onStatus("연결됨");
        if (onOpen) onOpen();
      });

      socket.addEventListener("message", (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (error) {
          return;
        }

        if (window.GameProtocol && !window.GameProtocol.isServerMessage(message)) {
          return;
        }

        if (message.type === "pong") {
          onPong(message);
          return;
        }
        if (message.type === "role") {
          onRole(message);
          return;
        }
        if (message.type === "full") {
          onFull();
          return;
        }
        if (message.type === "guest-joined") {
          onGuestJoined();
          return;
        }
        if (message.type === "guest-left") {
          onGuestLeft();
          return;
        }
        if (message.type === "host-left") {
          onHostLeft();
          return;
        }
        if (message.type === "room-expired") {
          onRoomExpired(message.reason);
          return;
        }
        if (message.type === "state") {
          onState(message.payload);
          return;
        }
        if (message.type === "guest-input") {
          onGuestInput();
        }
      });

      socket.addEventListener("close", () => {
        onStatus("연결 종료");
      });

      socket.addEventListener("error", () => {
        onStatus("연결 오류");
      });
    };

    return {
      connect,
      send,
      sendPing: () => {
        const sentAt = performance.now();
        send({ type: "ping", at: sentAt });
      },
      isOpen: () => socket && socket.readyState === WebSocket.OPEN,
    };
  };

  return { create };
})();
