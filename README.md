# AI Debate (AI 代吵架)

Standalone discussion-reading and reply-drafting workbench. It reconstructs a thread, keeps the
owner's position, drafts a persona-styled reply, evaluates it, and **only publishes after a human
approves the exact body**.

This repository is an independent product. It is **not** a plugin, and it does not require DSH,
Cordis, Node.js, Docker or Python at run time.

Download the latest release from
[Releases](https://github.com/alicia1030su/ai-debate/releases/latest). Verify it first:

```bash
sha256sum -c SHA256SUMS.txt          # Linux
certutil -hashfile AI-Debate-windows-x64.exe SHA256   # Windows
```

- **Windows** `AI-Debate-windows-x64.exe` — double-click; the browser opens and the service keeps
  running in the background. `--status`, `--stop`, `--restart`, `--logs` control it.
- **Linux** `ai-debate-linux-x64.tgz` — `sudo ./install.sh` installs a systemd service on
  `127.0.0.1:17860`, restarts it on failure, and keeps data in `/var/lib/ai-debate`.

## 后台挂机

配置一次之后，它可以不看屏幕地工作：

1. 在「自动挂机」页添加要盯的帖子（可多个），设一个轮询间隔。
2. 后台按间隔读取，发现新回复后自动分析上下文、继承主人立场、生成候选、过安全检查。
3. 结果进入「待审核」，你在审批页确认后才手动发表。**后台不会自发任何内容。**

- 首次检查只建立基线，不分析历史楼层。
- **旧回复被改写或删除**：默认每 6 小时回看最近 24 小时（可配 1–168 小时），按内容指纹识别；监控行上另有「补偿扫描」「全量重查」按钮。
- 中断的任务重启后自动恢复；模型调用是否可能重复会被单独标记，不会静默重放；限流按平台要求等待；认证失效会暂停该目标并写明原因。
- 「自动挂机」页有运行状态区：调度心跳、队列占用、最久等待、内存、数据目录占用、最近一次崩溃恢复。
- 详见 `docs/automation-architecture.md` 与 `docs/reliability-v0.2.1.md`。

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
npm test               # every suite: core, server, web, HTTP, monitoring, recovery, paging, upgrade
npm start              # run the server from source on 127.0.0.1:17860
npm run test:soak      # drive the pipeline for two minutes and bound the growth
node scripts/check-platform.mjs --url <thread>   # one read-only real-platform probe
```

Packaging:

```bash
npm run package:windows   # dist/AI-Debate-windows-x64.exe (+ .sha256)
npm run package:linux     # dist/ai-debate-linux-x64.tgz (+ .sha256)
```

## Licence

AGPL-3.0-only. See `LICENSE`.
