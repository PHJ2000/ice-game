const Protocol = (() => {
  const CLIENT_TYPES = {
    PING: "ping",
    JOIN: "join",
    INPUT: "input",
    CONTROL: "control",
  };

  const SERVER_TYPES = {
    PONG: "pong",
    ROLE: "role",
    FULL: "full",
    GUEST_JOINED: "guest-joined",
    GUEST_LEFT: "guest-left",
    HOST_LEFT: "host-left",
    GUEST_INPUT: "guest-input",
    STATE: "state",
    ROOM_EXPIRED: "room-expired",
  };

  const isObject = (value) => value && typeof value === "object";
  const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
  const isString = (value) => typeof value === "string";
  const isBool = (value) => typeof value === "boolean";

  const validateClient = (message) => {
    if (!isObject(message) || !isString(message.type)) return false;
    if (message.type === CLIENT_TYPES.PING) {
      return isNumber(message.at);
    }
    if (message.type === CLIENT_TYPES.JOIN) {
      return isString(message.room);
    }
    if (message.type === CLIENT_TYPES.INPUT) {
      const payload = message.payload;
      const input = payload?.input;
      const hasInputShape =
        isObject(input) &&
        typeof input.up === "boolean" &&
        typeof input.down === "boolean" &&
        typeof input.left === "boolean" &&
        typeof input.right === "boolean";
      return (
        isString(message.room) &&
        isObject(payload) &&
        hasInputShape &&
        isNumber(payload.seq) &&
        isNumber(payload.dtMs)
      );
    }
    if (message.type === CLIENT_TYPES.CONTROL) {
      return isString(message.action) && isString(message.room);
    }
    return false;
  };

  const validateServer = (message) => {
    if (!isObject(message) || !isString(message.type)) return false;
    if (message.type === SERVER_TYPES.PONG) {
      return isNumber(message.at);
    }
    if (message.type === SERVER_TYPES.ROLE) {
      return isString(message.role) && isString(message.side) && isString(message.room);
    }
    if (
      message.type === SERVER_TYPES.FULL ||
      message.type === SERVER_TYPES.GUEST_JOINED ||
      message.type === SERVER_TYPES.GUEST_LEFT ||
      message.type === SERVER_TYPES.HOST_LEFT ||
      message.type === SERVER_TYPES.GUEST_INPUT
    ) {
      return true;
    }
    if (message.type === SERVER_TYPES.ROOM_EXPIRED) {
      return !message.reason || isString(message.reason);
    }
    if (message.type === SERVER_TYPES.STATE) {
      return isObject(message.payload);
    }
    return false;
  };

  return {
    CLIENT_TYPES,
    SERVER_TYPES,
    isClientMessage: validateClient,
    isServerMessage: validateServer,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = Protocol;
}

if (typeof window !== "undefined") {
  window.GameProtocol = Protocol;
}
