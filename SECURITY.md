# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately through GitHub: **Security → Report a vulnerability** on
[Wehia-TK/omnicli](https://github.com/Wehia-TK/omnicli/security/advisories/new).
Include the affected version or commit, steps to reproduce, and the impact you expect.

You should get a reply within 7 days. Fixes land on `main`, and the advisory is published once a fix is available.

## Supported versions

Only the latest commit on `main` is supported. Use **Pull & restart** in the title bar (or `git pull`) to stay current.

## Threat model

Omni CLI is a local desktop app that starts AI coding agents (Claude Code, Antigravity, Codex, Copilot) on your machine.
Those agents can edit files and run commands, with the permissions you choose. In scope:

- **The Electron shell.** Content shown in the app (AI output, knowledge-base text, repository files, links) must never
  be able to run code or reach the IPC bridge. The renderer is sandboxed, context-isolated and has a strict
  Content-Security-Policy. Navigation and pop-ups are blocked, and the bridge only answers the app's own top-level page.
- **Process launching.** Prompts and other text must never be interpreted by a shell when a CLI is started
  (`src/core/proc.ts`).
- **The local approvals bridge.** It listens on `127.0.0.1` only and requires a random per-launch token.
- **Files Omni CLI writes**: rule files, `.ai-kb/`, MCP configs and skill folders.

Out of scope: what an AI agent does once you grant it permission. In particular, **Bypass** mode and the auto-approve
modes of other CLIs let the agent run anything. Prompt injection hidden in code you ask an agent to read is a risk of
the agents themselves; review untrusted repositories in Plan mode or a worktree.

## Self-update

**Pull & restart** fetches `origin`, then runs `npm install`, `npm run typecheck` and `npm run build` from the pulled
code before restarting. Only point `origin` at a repository you trust: its code and dependency install scripts run on
your machine.

## Verifying changes

```bash
npm run check      # typecheck + unit tests + build
npm run test:e2e   # launches the built app in a throw-away profile and checks the security boundaries
```
