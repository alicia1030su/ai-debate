# AI Debate (AI 代吵架)

Standalone discussion-reading and reply-drafting workbench. It reconstructs a thread, keeps the
owner's position, drafts a persona-styled reply, evaluates it, and **only publishes after a human
approves the exact body**.

This repository is an independent product. It is **not** a plugin, and it does not require DSH,
Cordis, Node.js, Docker or Python at run time.

- Windows: `AI-Debate-windows-x64.exe` — double-click, the browser opens, the service keeps
  running in the background.
- Linux: `ai-debate-linux-x64.tgz` — `install.sh` installs a systemd service on
  `127.0.0.1:17860`.

See `docs/install-windows.md`, `docs/install-linux.md`, `docs/security.md`, `docs/migration.md`,
`docs/architecture.md`.

## Provenance

The debate engine descends from **dsh-ai-debate** (`https://github.com/alicia1030su/dsh-ai-debate`),
released under AGPL-3.0-only. This project keeps the same licence; see `LICENSE` and `NOTICE`.
The original project is the source of the business logic; this repository replaces its host
integration with a standalone runtime and web console.

## Development

```bash
npm install
npm run build          # core typecheck/build + web bundle
npm test               # standalone and migrated core tests
npm start              # run the server from source on 127.0.0.1:17860
```

Packaging:

```bash
npm run package:windows   # dist/AI-Debate-windows-x64.exe (+ .sha256)
npm run package:linux     # dist/ai-debate-linux-x64.tgz (+ .sha256)
```

## Licence

AGPL-3.0-only. See `LICENSE`.
