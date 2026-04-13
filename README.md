# Claude Cat Monitor

A macOS Dynamic Island-style floating widget that monitors your Claude Code sessions in real time. A pixel-art cat sits in your menu bar and reacts to what Claude is doing.

## What it does

- **Real-time tool tracking** -- the pill shows exactly what Claude is doing right now (`Read auth.ts`, `Bash npm test`, `Thinking...`)
- **Session awareness** -- monitors all active Claude Code sessions with a per-session count badge
- **Approval queue** -- PermissionRequest hooks surface directly in the UI so you can allow/deny without switching windows
- **Notifications** -- macOS system notifications + sound effects when Claude finishes a task or needs input
- **Token & rate limit dashboard** -- context window usage, 5-hour and 7-day rate limits at a glance

The cat's mood reflects system state: working, idle, sleeping, anxious (approval pending), sweating (rate limit high), scared (build failure).

## Architecture

```
Claude Code CLI
  --> Hook events (stdin JSON)
    --> Python bridge (cat-bridge.py)
      --> Unix domain socket (/tmp/claude-cat-monitor.sock)
        --> Rust backend (Tauri v2)
          --> emit() to React frontend (instant)
          --> + file-based fallback (events.jsonl, 3s polling)
```

Events are pushed in real time via Unix socket. The app also maintains file-based logs as a fallback. The approval flow uses a separate HTTP server (`tiny_http` on port 57000) with a blocking request/response pattern.

## Install

### One-line install (Apple Silicon)

```bash
curl -fsSL https://raw.githubusercontent.com/huangken8511429/claude-cat-island/main/install.sh | bash
```

Or grab the `.zip` / `.dmg` from [Releases](https://github.com/huangken8511429/claude-cat-island/releases) manually.

### Build from source

```bash
git clone https://github.com/huangken8511429/claude-cat-island.git
cd claude-cat-island
npm install
npx tauri build
cp -rf "src-tauri/target/release/bundle/macos/Claude Cat Monitor.app" /Applications/
```

### Prerequisites

- macOS (Apple Silicon for prebuilt, Intel works from source)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed
- Python 3 (pre-installed on macOS)

## Development

```bash
npm install
npx tauri dev       # Vite HMR + Rust backend
npm test            # Vitest (42 tests)
```

## How it works

On first launch the app:

1. Deploys `~/.claude-cat-monitor/bin/cat-bridge.py` (the Python bridge script)
2. Registers hooks in `~/.claude/settings.json` for 10 event types (SessionStart, Stop, PreToolUse, PostToolUse, Notification, etc.)
3. Starts a Unix socket server at `/tmp/claude-cat-monitor.sock`
4. Starts an HTTP approval server at `127.0.0.1:57000`

When Claude Code runs, each hook event fires the bridge script, which pushes JSON to the socket. The Tauri backend emits it to the React frontend instantly.

## Tech stack

- **Frontend**: React 19 + TypeScript + Vite
- **Backend**: Rust (Tauri v2) + macOS private APIs (cocoa, objc)
- **Bridge**: Python 3 (Unix socket client)
- **Testing**: Vitest + jsdom

## Project structure

```
src/                    React frontend
  App.tsx               Main app -- island modes, polling, socket events
  types.ts              Shared TypeScript types
  components/           UI components (SessionPanel, TokenPanel, etc.)
src-tauri/              Rust backend
  src/lib.rs            Tauri commands (IPC bridge)
  src/claude.rs         Session/transcript/stats reader + hook installer
  src/socket.rs         Unix domain socket server
  src/approval.rs       HTTP approval server
  resources/
    cat-bridge.py       Python bridge script (deployed to ~/.claude-cat-monitor/)
```
