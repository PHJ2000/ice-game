# Repository Guidelines

## Project Structure & Module Organization
- `server.js`: Node.js HTTP + WebSocket server and game simulation (Rapier physics).
- `client/`: Client-side modules (input, network, render, audio, state).
- `shared/protocol.js`: WebSocket message schema and validation.
- `config.json`: Shared gameplay tuning values.
- `index.html` / `styles.css`: UI layout and styling.
- `assets/`: Audio and static assets.
- `package.json`: Project metadata and scripts.

There is no dedicated `src/` or `tests/` directory in this repo.

## Build, Test, and Development Commands
- `npm install`: Install runtime dependencies.
- `npm start`: Run the server locally on `http://localhost:3000` (default).
- `npm test`: Run a smoke test (health check + WS ping).

The server also exposes a WebSocket at `/ws`. You can override the port with `PORT=4000 npm start`.

## Coding Style & Naming Conventions
- Use 2-space indentation in JS/CSS/HTML to match existing files.
- Prefer descriptive camelCase for variables/functions (`createRoomCode`, `statusText`).
- Keep UI text in Korean to match the product copy.
- Keep comments short and purpose-driven; avoid redundant comments.

No formatter or linter is currently configured.

## Testing Guidelines
There is no automated test suite configured. Validate changes manually:
- Run `npm start`, open the page, and verify room creation/join, input, and scoring.
- Check WebSocket connection status and ping updates in the UI.

Smoke tests live at `scripts/smoke-test.js`.

## Commit & Pull Request Guidelines
Recent commits use short, descriptive messages with occasional type prefixes (e.g., `fix:`), and many are written in Korean. Use concise Korean commit messages going forward, optionally with a type prefix.

When opening PRs:
- Summarize the change and the user impact.
- Include repro steps or screenshots for UI changes.
- Link related issues if available.

## Configuration & Security Notes
- The server serves static files directly from the repository root; avoid exposing sensitive files.
- Keep static asset paths under `assets/` and reference them from `index.html`/`client/app.js`.
