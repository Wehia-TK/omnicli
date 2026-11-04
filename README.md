# Omni CLI

<div align="center">

**A centralized desktop workspace for all your AI CLI subscriptions.**

[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue.svg?logo=typescript)](https://www.typescriptlang.org/)
[![Electron](https://img.shields.io/badge/Electron-44-47848F.svg?logo=electron)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg?logo=react)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-38B2AC.svg?logo=tailwind-css)](https://tailwindcss.com/)
[![License](https://img.shields.io/badge/License-Private-lightgrey.svg)](#)

</div>

---

## ⚡ Overview

**Omni CLI** is a modern, borderless desktop dashboard designed to orchestrate and manage multiple AI coding CLIs (**Claude Code**, **Google Antigravity**, **OpenAI Codex**, and **GitHub Copilot**) in one unified place.

Instead of wrestling with scattered terminals, hidden rate limits, and disjointed context between different AI tools, Omni CLI provides:
- **Real-time subscription & quota tracking** (5-hour rolling windows, weekly quotas, and model buckets).
- **A shared, persistent Knowledge Base (`.ai-kb/PROJECT_KNOWLEDGE.md`)** that keeps all AI agents aligned.
- **Isolated Git worktree execution** so multiple AI agents can work in parallel on the same repository without collisions.
- **Embedded interactive PTY terminals** with live model and effort level selectors.

---

## ✨ Key Features

### 1. 🎛️ Multi-CLI Cockpit
- Native detection and status checking for **Claude Code** (`claude`), **Antigravity** (`agy`), **Codex** (`codex`), and **Copilot** (`copilot`).
- Model picker with real CLI model catalogs and granular **reasoning effort level** controls (`low`, `medium`, `high`, `xhigh`, `max`).
- Permission mode toggling (`default`, `accept-edits`, `bypass`, `plan`).
- Visual indicators showing CLI authentication status (unauthenticated subscriptions remain disabled/greyed out).

### 2. 📊 Live Usage Limits & Quota Metering
- Tracks live 5-hour rolling window usage, token counts, request counts, and reset countdowns.
- Supports both **live OAuth usage fetching** and intelligent budget estimation heuristics.
- Per-model and per-family quota bucket breakdown (e.g. Antigravity Claude vs. Gemini quotas).
- Instant visual warnings before hitting provider rate-limit walls.

### 3. 🧠 Unified Cross-AI Knowledge Base
- Bi-directional sync between local storage (`node:sqlite`) and `.ai-kb/PROJECT_KNOWLEDGE.md`.
- Maintains architectural notes, repository graphs, conventions, decisions, and cross-AI handoff logs.
- When an AI hits its quota or you switch tools, the next agent picks up right where the previous one left off without losing context.

### 4. 🌿 Git Worktrees & Clean Branching
- Choose between **Local** working directory execution or **Git Worktrees**.
- Safe parallel task runs: test risky refactors or prompt experiments in dedicated worktrees.
- Integrated git status controls: branch inspection, dirty file counters, and interactive diff hunk reviews.

### 5. 💻 Embedded Interactive Terminal & Tasks
- High-performance native terminal sessions powered by `@lydell/node-pty` and `@xterm/xterm` (with `@xterm/addon-fit`).
- Support for interactive conversational threads and queued background tasks.
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

- **Node.js**: `v20.x` or later (LTS recommended)
- **npm** or compatible package manager
- **Git**: Installed and available in your system `PATH`
- **Supported AI CLIs** (install whichever you use):
  - [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) (`claude`)
  - [Google Antigravity](https://github.com) (`agy`)
  - [OpenAI Codex](https://github.com/openai) (`codex`)
  - [GitHub Copilot CLI](https://github.com/github/copilot-cli) (`copilot`)

### Installation

1. **Clone the repository**:
   ```bash
   git clone <repo-url>
   cd "Omni CLI"
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

---

## 💻 Development Commands

| Command | Description |
| :--- | :--- |
| `npm run dev` | Starts the app in development mode with hot reload (`electron-vite dev`). |
| `npm run build` | Compiles the main process, preload scripts, and renderer bundle. |
| `npm run typecheck` | Validates TypeScript types across the entire project (`tsc --noEmit`). |
| `npm run dist` | Builds production assets and packages a Windows installer via `electron-builder`. |

> [!IMPORTANT]
> **Verification Convention**: Always run `npm run typecheck && npm run build` before committing changes to ensure type safety and build integrity.

---

## 📁 Project Structure

```
├── .ai-kb/                     # Project knowledge base markdown documents
│   └── PROJECT_KNOWLEDGE.md    # Central context shared across AI CLIs
├── build/                      # Build assets and application icons
├── resources/                  # Static runtime resources
├── src/
│   ├── core/                   # Backend engines (CLIs, DB, git, knowledge base, PTY)
│   ├── main/                   # Electron main process entry point & IPC handlers
│   ├── preload/                # Context-isolated secure preload bridge
│   ├── renderer/               # React UI components, hooks, styles, and views
│   │   ├── src/
│   │   │   ├── components/     # Modals, terminal, composer, workbench, title bar
│   │   │   ├── lib/            # Markdown renderer, API bindings, date utils
│   │   │   └── App.tsx         # Main UI layout & state orchestrator
│   └── shared/                 # Shared TypeScript interfaces, types, and constants
├── electron.vite.config.ts     # Multi-target Vite build configuration
├── package.json                # Project dependencies and packaging scripts
└── tsconfig.json               # Root TypeScript configuration
```

---

## 🔒 Security & Privacy

- **Local-First Architecture**: Your projects, credentials, and knowledge base stay on your machine.
- **Embedded Database**: Local persistent storage runs directly inside Node's embedded `node:sqlite`.
- **Credential Safety**: Authentication relies on the respective CLI tools' existing local login sessions (OAuth tokens and configurations are never stored insecurely or transmitted to third-party servers).
