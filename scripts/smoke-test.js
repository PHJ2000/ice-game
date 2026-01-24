const http = require("http");
const { spawn } = require("child_process");
const WebSocket = require("ws");

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

const waitForPong = () =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket pong timeout"));
    }, 2000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "ping", at: Date.now() }));
    });
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === "pong") {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      } catch (error) {
        // ignore parse errors
      }
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

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
