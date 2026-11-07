# Omni CLI

<div align="center">

**A centralized desktop workspace for all your AI CLI subscriptions.**

[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue.svg?logo=typescript)](https://www.typescriptlang.org/)
[![Electron](https://img.shields.io/badge/Electron-44-47848F.svg?logo=electron)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg?logo=react)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-38B2AC.svg?logo=tailwind-css)](https://tailwindcss.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![CI](https://github.com/YehiaTarekKhedr/omnicli/actions/workflows/ci.yml/badge.svg)](https://github.com/YehiaTarekKhedr/omnicli/actions/workflows/ci.yml)

</div>

---

## ⚡ Overview

**Omni CLI** is a modern, borderless desktop dashboard designed to orchestrate and manage multiple AI coding CLIs (**Claude Code**, **Google Antigravity**, **OpenAI Codex**, and **GitHub Copilot**) in one unified place across **Windows** and **macOS** (Apple Silicon & Intel).

Instead of wrestling with scattered terminals, hidden rate limits, and disjointed context between different AI tools, Omni CLI provides:
- **Real-time subscription & quota tracking** (5-hour rolling windows, weekly quotas, and model buckets).
- **A shared, persistent Knowledge Base (`.ai-kb/PROJECT_KNOWLEDGE.md`)** that keeps all AI agents aligned.
- **Isolated Git worktree execution** so multiple AI agents can work in parallel on the same repository without collisions.
- **Embedded interactive PTY terminals** (PowerShell on Windows, Zsh/Bash on macOS) with live model and effort level selectors.
- **Cross-platform desktop design** with platform-native titlebars (macOS traffic lights via `hiddenInset` and custom frameless controls on Windows).

---

## ✨ Key Features

### 1. 🎛️ Multi-CLI Cockpit
- Native detection and status checking for **Claude Code** (`claude`), **Antigravity** (`agy`), **Codex** (`codex`), and **Copilot** (`copilot`).
- Model picker with real CLI model catalogs and granular **reasoning effort level** controls (`low`, `medium`, `high`, `xhigh`, `max`).
- Permission mode toggling (`default`, `accept-edits`, `bypass`, `plan`).
- Visual indicators showing CLI authentication status (unauthenticated subscriptions remain disabled/greyed out).
- **Voice input** (mic button in the composer): click, speak, click again to insert. Transcription runs locally with **NVIDIA Parakeet TDT 0.6B** (int8, via sherpa-onnx) — about 1 s per phrase on CPU, the model stays loaded between dictations. It reuses the model and Python venv from an existing Voice Studio install (looked up in `~/Voice Studio/VoiceStudio`, `C:\` / `D:\Voice Studio\VoiceStudio`, or the folder in the `OMNI_VOICE_STUDIO` environment variable); nothing is downloaded. Without it, Windows falls back to the built-in (much less accurate) System.Speech recognizer. Code: `src/core/voice.ts`, `src/renderer/src/lib/recorder.ts`.
- **Team updates (Pull & restart)**: the title-bar update button fetches GitHub in the background and flags commits merged into the branch's upstream (or the remote's default branch, `main`/`master`) that you haven't pulled, listing their commit messages. Pulled code and its `npm install` scripts run on your machine, so keep `origin` pointed at a repository you trust. One click pulls them (fast-forward, or replays your local commits on top when you've diverged — aborting cleanly on conflicts), reinstalls dependencies if needed, typechecks, builds and restarts. **Push** now rebases onto teammates' pushes first and writes every unpushed AI-agent commit message into the auto-commit body, so conventional commits stay visible in history.
- **Single instance**: only one Omni CLI runs at a time — launching it again just focuses the open window. After an in-app update the app restarts itself (the new process waits for the old one to exit, then takes over).

### 2. 📊 Live Usage Limits & Quota Metering
- Tracks live 5-hour rolling window usage, token counts, request counts, and reset countdowns.
- Supports both **live OAuth usage fetching** and intelligent budget estimation heuristics.
- **Claude live limits** come from the same Anthropic endpoint as Claude's own "Plan usage limits" panel (5-hour and weekly %). That endpoint allows only about one request a minute per login, shared with Claude Code itself, so Omni CLI asks at most every 3 minutes (1 minute after a run finishes, 30 s on a manual refresh) and backs off from 2 up to 30 minutes when it is rate limited. The last good reading is kept across restarts and labelled with its age ("updated 4m ago"), and the note says when the next retry is. On macOS the sign-in token is read from the Keychain.
- A token-budget **estimate** never shows a limit as used up: only a real rejection from the provider turns a bar red at 100%.
- Per-model and per-family quota bucket breakdown (e.g. Antigravity Claude vs. Gemini quotas).
- Instant visual warnings before hitting provider rate-limit walls.

#### Multiple accounts per provider (Claude Code & Codex)
- In **Settings → Extra accounts**, add more logins for the same provider (e.g. a second Claude Max or ChatGPT plan) and sign in to each from the built-in terminal. No passwords are stored: each account gets its own isolated config folder (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) holding the CLI's own OAuth login.
- Fallback order: your normal CLI login → extra accounts in the order you set → only then the existing handover to a different provider/model.
- Switching account starts a fresh CLI session (sessions live in the account's config folder) and re-sends task context like a handover. Rate-limit locks are tracked per account and can be cleared individually.
- Copilot and Antigravity aren't supported yet (no confirmed per-account config override).

### 3. 🧠 Unified Cross-AI Knowledge Base
- Bi-directional sync between local storage (`node:sqlite`) and `.ai-kb/PROJECT_KNOWLEDGE.md`.
- Maintains architectural notes, repository graphs, conventions, decisions, and cross-AI handoff logs.
- When an AI hits its quota or you switch tools, the next agent picks up right where the previous one left off without losing context.
- **Optional code graph**: if [graphify](https://pypi.org/project/graphifyy/) is installed (`pip install graphifyy`), *Scan repo* also builds a zero-token code graph (`graphify-out/`) and uses its modules; without it the scan falls back to the folder structure, with no error.

### 4. 🌿 Git Worktrees & Clean Branching
- Choose between **Local** working directory execution or **Git Worktrees**.
- Safe parallel task runs: test risky refactors or prompt experiments in dedicated worktrees.
- Integrated git status controls: branch inspection, dirty file counters, and interactive diff hunk reviews.

### 5. 💻 Embedded Interactive Terminal & Tasks
- High-performance native terminal sessions powered by `@lydell/node-pty` and `@xterm/xterm` (with `@xterm/addon-fit`).
- Support for interactive conversational threads and queued background tasks.
- **Message queue with "Send now"**: while an AI is working, press Enter (or **Queue**) to queue follow-ups that run automatically when the current turn ends. Use **Send now** to interrupt the current run and send right away, from the composer or from any queued message.
- **Live thinking stream**: the model's reasoning steps, including Antigravity's transcript, show up in the session as it runs.
- **Answer vs. build routing**: plain questions get a direct answer with no file edits, and code only changes when you ask for it.
- Skeleton placeholders for the subscription strip, projects, sessions, the live stream, git changes, and the knowledge base while they first load.
- Automated scheduled runs (hourly, daily, weekly) for recurring audits, tests, or repo maintenance.

### 6. 🔌 MCP & Skills Integration
- Unified Model Context Protocol (MCP) server management across supported CLIs.
- Discovers user and project-scoped `SKILL.md` workflows.
- Extensible notifications (support for `ntfy.sh` mobile/desktop push alerts).

---

## 🛠️ Architecture & Tech Stack

```
Omni CLI (Electron App)
├── Main Process (src/main/)
│   ├── Window management (frameless / borderless window)
│   ├── Native IPC bridge
│   └── Auto-updater & notifications
├── Core Engine (src/core/)
│   ├── clis.ts         - CLI detection, quota polling, token calculations
│   ├── projects.ts     - Workspace execution, git worktrees, task runner
│   ├── knowledge.ts    - Markdown & SQLite synchronization (.ai-kb)
│   ├── gitops.ts       - Asynchronous Git status, diffs, branches, and worktrees
│   ├── terminal.ts     - Node-pty session lifecycle management
│   ├── proc.ts         - Shell-free launching of AI CLIs (npm .cmd shims on Windows)
│   └── (main) security.ts - Pure navigation / IPC / open-path rules, unit-tested
│   ├── scheduler.ts    - Background cron & scheduled prompt runner
│   └── db.ts           - Fast embedded persistence via node:sqlite
└── Renderer (src/renderer/)
    ├── React 19 + Tailwind CSS v4
    ├── Lucide React icons & Inter Variable typography
    └── Custom titlebar & native window controls
```

- **Runtime**: [Electron 44](https://www.electronjs.org/) + [Node.js](https://nodejs.org/) (native `node:sqlite`)
- **Bundler**: [electron-vite](https://electron-vite.org/) + [Vite 8](https://vitejs.dev/)
- **UI Framework**: [React 19](https://react.dev/) + [Tailwind CSS v4](https://tailwindcss.com/)
- **Terminal Emulator**: [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty)
- **Language**: [TypeScript 7](https://www.typescriptlang.org/)

---

## 🚀 Getting Started

### Prerequisites

- **Operating System**: Windows 10/11 or macOS 12+ (Apple Silicon M-Series & Intel)
- **Node.js**: `v22.18` or later (the Vite 8 / TypeScript 7 toolchain and the TypeScript unit tests need it; the app itself runs on Electron's bundled Node)
- **npm** or compatible package manager
- **Git**: Installed and available in your system `PATH`
- **Supported AI CLIs** (install whichever you use):
  - [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) (`claude`)
  - [Google Antigravity](https://antigravity.google) (`agy`)
  - [OpenAI Codex](https://github.com/openai/codex) (`codex`)
  - [GitHub Copilot CLI](https://github.com/github/copilot-cli) (`copilot`, installed with `npm install -g @github/copilot`; VS Code's built-in `copilot` launcher is not the CLI and is ignored)

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/YehiaTarekKhedr/omnicli.git
   cd omnicli
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Run it**:
   ```bash
   npm run dev
   ```
   On Windows you can also double-click `Start Omni CLI.bat` (builds once, then launches without a console window).

4. **Add a project**: a fresh install starts empty. Create a project, point it at a local folder, and sign in to whichever CLIs you use (each CLI keeps its own login; Omni CLI never asks for passwords or API keys).

---

## 💻 Development Commands

| Command | Description |
| :--- | :--- |
| `npm run dev` | Starts the app in development mode with hot reload (`electron-vite dev`). |
| `npm run build` | Compiles the main process, preload scripts, and renderer bundle. |
| `npm run typecheck` | Validates TypeScript types across the entire project (`tsc --noEmit`). |
| `npm test` | Unit tests (Node's built-in test runner): IPC/navigation security rules and shell-free CLI launching. |
| `npm run test:e2e` | After `npm run build`: launches the app in a throw-away profile, drives it over the DevTools protocol and checks the security boundaries plus the main API (no AI runs, costs nothing; never touches a running Omni CLI). Add `-- --exe "release/win-unpacked/Omni CLI.exe"` to test a packaged build. |
| `npm run check` | Typecheck + unit tests + build in one go. |
| `npm run dist` | Builds production assets and packages a Windows installer (`.exe`) via `electron-builder`. |
| `npm run dist:mac` | Builds production assets and packages macOS bundles (`.dmg` & `.zip`) via `electron-builder`. |

> [!IMPORTANT]
> **Verification Convention**: Always run `npm run check` (typecheck, unit tests, build) before committing; run `npm run test:e2e` too when touching `src/main`, `src/preload` or process launching. GitHub Actions runs all of this on every push and pull request (`.github/workflows/ci.yml`).

---

## 📁 Project Structure

```
├── .ai-kb/                     # Project knowledge base markdown documents
│   └── PROJECT_KNOWLEDGE.md    # Central context shared across AI CLIs
├── build/                      # Build assets and application icons
├── resources/                  # Static runtime resources
├── src/
│   ├── core/                   # Backend engines (CLIs, accounts, DB, git, knowledge base, PTY)
│   ├── main/                   # Electron main process entry point & IPC handlers
│   ├── preload/                # Context-isolated secure preload bridge
│   ├── renderer/               # React UI components, hooks, styles, and views
│   │   ├── src/
│   │   │   ├── components/     # Modals, terminal, composer, workbench, title bar
│   │   │   ├── lib/            # Markdown renderer, API bindings, date utils
│   │   │   └── App.tsx         # Main UI layout & state orchestrator
│   └── shared/                 # Shared TypeScript interfaces, types, and constants
├── scripts/e2e.mjs             # End-to-end security & API smoke test (npm run test:e2e)
├── test/                       # Unit tests (npm test)
├── .github/workflows/ci.yml    # CI: typecheck, tests, build, audit (Windows + macOS), e2e (Windows)
├── electron.vite.config.ts     # Multi-target Vite build configuration
├── package.json                # Project dependencies and packaging scripts
└── tsconfig.json               # Root TypeScript configuration
```

---

## 🔒 Security & Privacy

> [!WARNING]
> Omni CLI drives AI agents that edit files and run commands in your projects. **Bypass** permission mode (and Antigravity / Copilot runs, which use their own auto-approve flags) let the agent act without asking: only use them on code you trust, ideally in a worktree. Prompts, knowledge-base text and files in a repository you cloned can contain prompt-injection instructions aimed at the agent.

- **Hardened Electron shell**: the UI runs sandboxed with context isolation, no Node integration and a strict Content-Security-Policy (no remote or inline scripts). Only the app's own page can call the IPC bridge (calls from webviews, iframes or navigated-away pages are refused, and API paths can't walk into prototypes). Navigations and pop-ups never load inside the app: web links open in your system browser. The browser-preview `<webview>` is sandboxed and can only load `http(s)` pages with Omni CLI's own element-picker preload.
- **No shell injection**: AI CLIs are started without a shell. On Windows, npm `.cmd` shims are resolved to the underlying script, so quotes, `&`, `%VAR%` or newlines in a prompt are passed through literally and never executed.
- **Approvals bridge**: Claude Code permission prompts reach the app through a loopback-only (`127.0.0.1`) server that requires a random per-launch token.
- **Limited shell access from the UI**: "Open" only opens folders, images and text files, never executables or shortcuts.
- **Tested**: these rules have unit tests (`npm test`) and an end-to-end check against the real app (`npm run test:e2e`), both run in CI.
- **Reporting**: see [SECURITY.md](SECURITY.md) to report a vulnerability privately.
- **Phone notifications are opt-in**: the ntfy topic is empty by default. Use *Settings → Generate* to create a random, unguessable topic. ntfy topics are unauthenticated, so anyone who knows the name can read the messages; use a self-hosted/ACL-protected server for sensitive content.
- **Local-First Architecture**: Your projects, credentials, and knowledge base stay on your machine.
- **Embedded Database**: Local persistent storage runs directly inside Node's embedded `node:sqlite`.
- **Credential Safety**: Authentication relies on the respective CLI tools' existing local login sessions (OAuth tokens and configurations are never stored insecurely or transmitted to third-party servers).

---

## 🤝 Contributing

Issues and pull requests are welcome. Please run `npm run check` (and `npm run test:e2e` for changes to the main process, preload or process launching) before opening a PR, and keep the README in sync with what you change. Report security problems privately as described in [SECURITY.md](SECURITY.md).

---

## 📄 License

Released under the [MIT License](LICENSE).
