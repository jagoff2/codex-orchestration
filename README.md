# Codex MCP Server

Model Context Protocol (MCP) server that exposes the Codex CLI as a recursive tool with an opinionated mission orchestrator, web UI, and safety rails for multi-agent execution.

## Key Capabilities

- **MCP bridge for Codex CLI** – Runs `codex exec` inside MCP tools (`codex.exec`, `codex.cli`, `codex.sessions.*`) so downstream agents can bootstrap Codex sessions or resume prior turns.
- **Mission orchestrator** – Accepts a natural-language goal, generates an agent plan, and executes each specialist sequentially (planner → implementer → tester → doc, etc.). Planning prompts are sanitized into single-line strings to keep Codex CLI invocations shell-safe on Windows.
- **Adaptive iteration loop** – Agents must end replies with `CONTROL_JSON` directives. Testing/QA agents can block hand-off by requesting new iterations (specifying the agent to rerun and optional follow-up verifiers). The orchestrator clones the requested blueprint, injects overrides, and re-queues the workflow automatically.
- **Safety features** –
  - Automatic newline stripping from all prompts to avoid truncated arguments.
  - Explicit timeout policy injected into testing-style agents so every command they run uses a realistic timeout wrapper.
  - Rich debug logging (`[codex-orchestrator] …`) that captures prompt lengths, Codex arguments, and iteration activity.
- **Frontend + server dev workflow** – `npm run dev` launches both the orchestrator API and the optional frontend (see `frontend/`).

## Project Structure

```
bin/                     Thin launcher for the MCP server entry point
frontend/                Optional interface (Vite/React) for interacting with missions
src/
  index.js               MCP server wiring + tool registration
  promptUtils.js         Shared prompt sanitization helper
  server/
    config.js            Runtime configuration + env parsing
    codexRunner.js       Low-level Codex CLI runner with stdout/stderr streaming
    orchestrator.js      Mission planning/execution engine (CONTROL_JSON, iteration)
    index.js             Express/WebSocket server that exposes orchestrator APIs
```

## Prerequisites

- Node.js 18+ (ESM + top-level `await` support)
- A working Codex CLI install (`codex` on `PATH`, or point `CODEX_BIN` to it)
- (Optional) Access to Desktop Commander or another MCP-compatible runner if you want nested tool calls

Run `npm install` at the repo root before continuing.

## Running the Servers

### Orchestrator / API only

```bash
npm run server:dev
```

Starts `src/server/index.js`, which bootstraps the orchestrator, Express server, and WebSocket endpoints. You’ll see debug output such as plan prompt lengths and Codex event streams.

### MCP server (stdio transport)

```bash
npm start
```

This runs `bin/codex-mcp-server.js --stdio`, exposing the MCP tools described in `src/index.js` to any MCP-compatible host (OpenAI desktop app, Desktop Commander, etc.).

### Full stack (orchestrator + frontend dev server)

```bash
npm run dev
```

Uses `concurrently` to start both the orchestrator (`server:dev`) and the frontend Vite dev server (`frontend:dev`). Open the printed frontend URL once both processes are ready.

## Configuration

Environment variables (`.env`, shell, or process manager) control the orchestrator and MCP runner. Relevant options live in `src/server/config.js` and `src/index.js`.

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_BIN` | `codex` | Path to the Codex CLI executable. |
| `CODEX_WORKDIR` | `process.cwd()` | Working directory for Codex invocations. |
| `CODEX_PROFILE` | `gpt-oss-20b-lms` | Profile passed to `codex exec --profile`. |
| `CODEX_ORCHESTRATOR_PLANNING_PROMPT` | (single-line default) | Override the base planning header. Must be single-line to avoid Windows argument truncation. |
| `CODEX_DEBUG` / `DEBUG` | `true` if unset | Enable verbose orchestrator logging (`[codex-orchestrator]`). Set to `0` to disable. |
| `CODEX_MCP_DEBUG` | `0` | Enables extra logging inside the MCP server layer. |
| `PORT` / `HOST` | `4300` / `0.0.0.0` | HTTP server binding for `server:dev`. |

## Mission Lifecycle

1. **Planning** – `buildMissionPlanPrompt` composes a single-line directive emphasizing 2–4 complementary agents that cover planning/design, implementation, testing/QA, and documentation. Codex returns JSON (`mission_summary`, `agents[]`). Blueprints are cached for later iterations.
2. **Execution** – Each agent is invoked with `buildAgentPrompt`, which injects:
   - Mission summary / objective / expertise
   - The agent’s bespoke instructions
   - *Optional* testing timeout policy (only if the agent role/objective/instructions imply “test”, “QA”, “validation”, etc.)
   - A mandatory `CONTROL_JSON` footer describing how to either continue the mission or request an iteration.
3. **Iteration handling** – When an agent returns `CONTROL_JSON: {"action":"request_iteration",…}`, the orchestrator clones the specified agent blueprint, merges override instructions, inserts the agent immediately after the requester, and (optionally) queues a follow-up verifier. Logs record each `iteration:queued` event for auditing.
4. **Completion** – If every agent finishes with `{"action":"continue"}` (and there are no pending insertions), the mission status flips to `completed`. Failures bubble up immediately, tagging the mission with `mission.error`.

## Troubleshooting & Tips

- **“The system cannot find the file specified.”** – Ensure prompts contain no literal newlines or shell metacharacters. All defaults are sanitized, but custom env overrides must remain single-line and avoid `<` / `>` redirection symbols.
- **Tests hang forever** – Confirm the testing agent mentions “test/QA/validate” in its plan fields so it inherits the timeout policy block. Agents are required to wrap commands with a timeout utility; their CONTROL_JSON should request iterations instead of waiting indefinitely.
- **Need more detailed logs?** – Set `CODEX_DEBUG=1` (already default) and inspect the `[codex-orchestrator]` lines for prompt lengths, Codex arguments, and iteration insertions.
- **Frontend won’t start** – Run `npm install` inside `frontend/` as well, or delete `node_modules` and reinstall if dependencies drift.

## Contributing

1. Fork or branch locally.
2. Run `npm test` (if/when tests exist) plus `npm run build:frontend` to ensure the React bundle still compiles.
3. Submit PRs with clear descriptions of planner/orchestrator changes—especially anything that affects CONTROL_JSON semantics or prompt sanitization.

Licensed under the MIT License. See `LICENSE` (or package metadata) for details.
