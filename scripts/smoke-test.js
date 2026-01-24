const http = require("http");
const { spawn } = require("child_process");
const { Client } = require("colyseus.js");

const port = Number(process.env.TEST_PORT || 3100);
const serverProcess = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(port), LOG_LEVEL: "error" },
  stdio: "ignore",
});

const waitForHealth = (retries = 40) =>
  new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(`http://localhost:${port}/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else if (retries <= 0) {
          reject(new Error(`Health check failed: ${res.statusCode}`));
        } else {
          setTimeout(() => attempt(retries - 1), 200);
        }
      });
      req.on("error", () => {
        if (retries <= 0) {
          reject(new Error("Health check connection failed"));
        } else {
          setTimeout(() => attempt(retries - 1), 200);
        }
      });
    };
    attempt();
  });

const waitForPong = async () => {
  const client = new Client(`ws://localhost:${port}`);
  const roomCode = "TEST";
  const room = await client.joinOrCreate("air_hockey", { roomCode });
  room.onMessage("role", () => {});

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Colyseus pong timeout")), 2000);
    room.onMessage("pong", () => {
      clearTimeout(timer);
      resolve();
    });
    room.send("ping", { at: Date.now() });
  });

  room.leave();
};

const shutdown = () =>
  new Promise((resolve) => {
    serverProcess.on("exit", resolve);
    serverProcess.kill();
    setTimeout(resolve, 500).unref();
  });

(async () => {
  try {
    await waitForHealth();
    await waitForPong();
    await shutdown();
    process.exit(0);
  } catch (error) {
    await shutdown();
    console.error(error.message);
    process.exit(1);
  }
})();
