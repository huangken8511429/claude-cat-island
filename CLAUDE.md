# Claude Cat Monitor

Pixel-art cat dashboard for monitoring Claude Code sessions in real time. Built as a macOS Dynamic Island-style floating widget using Tauri v2.

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite (port 1420)
- **Backend**: Rust (Tauri v2) with macOS-specific APIs (cocoa, objc)
- **Testing**: Vitest + jsdom
- **Bundler**: Tauri bundler (outputs .app + .dmg)

## Project Structure

```
src/              # React frontend
  App.tsx         # Main app — island mode (pill/notification/full), tabs, polling
  types.ts        # Shared TypeScript types
  components/     # UI components (SessionPanel, TokenPanel, SkillPanel, etc.)
  approval/       # Approval queue logic
  utils/          # Sound effects, pill label helpers
src-tauri/        # Rust backend
  src/lib.rs      # Tauri commands (IPC bridge)
  src/claude.rs   # Claude Code session/transcript/stats reader
  src/approval.rs # HTTP-based approval server for Claude Code hooks
  tauri.conf.json # Tauri config (window size, transparency, etc.)
```

## Development

```bash
npm install              # Install frontend deps
npx tauri dev            # Start dev mode (Vite HMR + Rust backend)
npm test                 # Run frontend tests (Vitest)
```

## Build & Install

```bash
npx tauri build          # Build production bundle
```

Build outputs:
- `src-tauri/target/release/bundle/macos/Claude Cat Monitor.app`
- `src-tauri/target/release/bundle/dmg/Claude Cat Monitor_0.1.0_aarch64.dmg`

Install to Applications:
```bash
cp -rf "src-tauri/target/release/bundle/macos/Claude Cat Monitor.app" /Applications/
```

Or open the `.dmg` file and drag to Applications.

## Key Concepts

- **Island Mode**: The app has three display modes — `pill` (compact status bar), `notification` (event toast), and `full` (expanded dashboard with tabs).
- **Polling**: Frontend polls Rust backend via Tauri IPC (`invoke`) for session data, token stats, live stats, and approval states.
- **Approval Server**: A local HTTP server (`tiny_http`) that receives Claude Code `PermissionRequest` hooks and queues them for user approval in the UI.
- **Cat States**: The pixel cat reflects system state — `working`, `idle`, `sleeping`, `done`, `scared` (build failure), `anxious` (approval pending), `sweating` (rate limit).
- **macOS Private API**: Uses `cocoa` crate to set window level (always-on-top status window) and transparent/borderless window.

## Conventions

- Frontend types mirror Rust structs — keep `src/types.ts` and `src-tauri/src/claude.rs` in sync.
- All UI uses pixel-art aesthetic with retro game-inspired design.
- Window is non-resizable, transparent, no decorations — resizing is done programmatically via Tauri window API.
