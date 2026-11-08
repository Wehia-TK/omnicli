# Contributing to Omni CLI

Thanks for helping out! Bug reports, ideas, docs fixes and code are all welcome.

## Ground rules

- Be kind: this project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Security problems go through a **private** advisory, never a public issue: see [SECURITY.md](SECURITY.md).
- For anything bigger than a small fix, open an issue first so we can agree on the approach before you spend time on it.

## Setup

You need **Node.js 22.18+**, npm and Git, on Windows 10/11 or macOS 12+.

```bash
git clone https://github.com/Wehia-TK/omnicli.git
cd omnicli
npm install
npm run dev        # app with hot reload
```

You don't need any AI subscription to work on most of the app: the unit and end-to-end tests never start a real AI run.

## Project layout

- `src/main/` — Electron main process, window, IPC and navigation security (`security.ts`)
- `src/preload/` — the context-isolated bridge exposed to the UI
- `src/core/` — everything that does real work: CLI detection and limits, task runner, git, knowledge base, terminal, database
- `src/renderer/` — the React UI
- `src/shared/` — types shared by all of the above
- `test/` — unit tests (`npm test`); `scripts/e2e.mjs` — end-to-end test against the real app

The README has a fuller [architecture overview](README.md#%EF%B8%8F-architecture--tech-stack).

## Before you open a pull request

1. Run the checks:
   ```bash
   npm run check       # typecheck + unit tests + build
   npm run test:e2e    # also run this if you touched src/main, src/preload or how CLIs are launched
   ```
2. Add or update tests for behaviour you change, especially anything security-related (IPC, navigation, file opening, process launching).
3. **Update the README** when you add, change or remove a user-visible feature, command or setting.
4. If you changed the UI noticeably, regenerate the screenshots: `npm run build && npm run screenshots`.
5. Keep the PR focused on one change, and explain *why* in the description.

CI runs the same checks on Windows and macOS for every pull request.

## Commit messages

Short, imperative subject lines describing the change ("Fix Claude live limits backing off too early"). [Conventional Commits](https://www.conventionalcommits.org/) prefixes (`fix:`, `feat:`, `test:` …) are welcome but not required.

## Code style

- TypeScript everywhere, strict types; avoid `any`.
- Follow the patterns already in the file you're editing.
- Never run AI CLIs through a shell, and never widen what the renderer is allowed to do without a test that pins the new rule.

## Reporting bugs

Use the [bug report template](https://github.com/Wehia-TK/omnicli/issues/new/choose) and include your OS, how you installed Omni CLI (installer or source + commit), which CLIs are involved, and the steps to reproduce. Please remove tokens, emails and private paths from logs and screenshots.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
