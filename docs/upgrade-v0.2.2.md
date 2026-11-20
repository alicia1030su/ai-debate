# v0.2.2 覆盖升级说明与验收记录

本文记录 **正式 v0.2.1 Windows Release 附件 → 当前 v0.2.2 构建** 的覆盖升级验收方法、预期迁移、回滚步骤和实际证据。它不替代发布签字；真实附件、当前构建和未覆盖项必须分别阅读。

## 1. 当前状态

- 验收脚本：`test/acceptance/upgrade.ts`
- 主场景：v0.2.1 真实 EXE 通过 HTTP 写出的数据目录，由当前 v0.2.2 构建原地打开。
- 兼容场景：v0.2.0 旧结构回归仍保留；本次未提供 v0.2.0 EXE，因此该场景是 fixture，不宣称真实旧版二进制验证。
- 全局身份自动迁移：**当前产品尚未实现**。脚本明确输出 `identityMigration: "strategy-only"`，不把“旧监控游标和候选仍在”冒充成“全局身份台账已迁移”。详见 §5。

## 2. 前置条件

1. Node.js `>=22.18.0`，Windows 验收机可执行 EXE。
2. 当前工作树已安装依赖，且没有其他服务占用 `17920`、`17921` 端口。
3. 正式 v0.2.1 附件放在：

   ```text
   .tmp-data/v021-real/AI-Debate-windows-x64.exe
   ```

   也可以通过环境变量指定其他路径；环境变量优先于默认路径：

   ```powershell
   $env:AI_DEBATE_V021_BIN = "C:\path\to\AI-Debate-windows-x64.exe"
   ```

4. 可选：用 `AI_DEBATE_V020_BIN` 指定正式 v0.2.0 EXE，把兼容场景也升级为真实旧版二进制验证。
5. 可选：用 `AI_DEBATE_BIN` 指定当前 v0.2.2 EXE；未指定时脚本运行 `dist/ai-debate.cjs`。

脚本会先执行旧附件的 `--version`，记录完整输出和 SHA256。版本输出不含目标版本、文件不存在或执行失败时，脚本降级为 fixture 并明确标记；**指定环境变量但附件不可用时验收失败**。默认附件正在下载/被占用时也会标记为 fixture，并在摘要中输出真实附件未验证的阻塞说明。

## 3. 执行命令

在仓库根目录执行：

```powershell
npm run typecheck
npm run test:upgrade
```

`test:upgrade` 会先构建 core 与当前服务包。真实附件路径已经存在时，无需额外设置环境变量。显式指定附件：

```powershell
$env:AI_DEBATE_V021_BIN = ".tmp-data/v021-real/AI-Debate-windows-x64.exe"
npm run test:upgrade
```

脚本使用临时数据目录，结束后删除。升级前每个文件的路径、字节数和 SHA256 会打印到标准输出；敏感文件只打印哈希，不打印内容。

## 4. 数据来源：哪些由真实旧版写入，哪些离线植入

### 4.1 真实 v0.2.1 EXE 通过 HTTP 写入

- `POST /api/ai-debate/auth/setup`：管理员 `upgrade-owner`。
- `POST /api/ai-debate/settings`：非默认模型、自定义 Loopback 模型地址、`maxFloorPages=42`。
- `POST /api/ai-debate/secrets`：两个明显测试值，分别写入 `AI_DEBATE_LLM_API_KEY` 与 `AI_DEBATE_TIEBA_COOKIE`。
- `POST /api/ai-debate/automation/monitors`：旧监控目标。

旧进程停止后才进行离线植入，避免测试夹具被后台调度覆盖。

### 4.2 必须离线植入的部分

| 文件/字段 | 原因 | 植入内容 |
|---|---|---|
| `state.json` | 真实候选需要平台读取和模型调用 | 一个会话、两条候选、一条批准、一条已确认发表去重记录 |
| `auto-tasks.json` | 待审核/中断任务需要真实流水线历史 | `needs_review`、`completed`、带租约和 `modelCall` 的 `running` 行 |
| `monitors.json` 的 `seen/cursor/lastScan/compensationHours/platformState/changes` | 需要确定性的旧扫描历史 | 三条 seen、两条候选对应指纹、完整扫描记录、36 小时补偿窗口、限流状态 |
| `backups/v021-legacy-*` | 正式旧 manifest 需要独立构造 | `config.json/state.json/jobs.json` 三文件清单，分别使用 `auto:true` 与 `auto:false` |

v0.2.0 fixture 使用 `monitors.json version=1`，不包含 v0.2.1 新增的 cursor/补偿字段；任务行不包含 `modelCall/lease`。因此它验证的是“旧字段保留、新字段补默认值”，而不是 v0.2.1 字段保真。

## 5. 预期迁移

### 5.1 配置、监控、任务与核心台账

| 数据 | 预期 |
|---|---|
| `admin.json` | 不重建、不改写；旧口令直接登录，重复 setup 返回 409 |
| `config.json` | 非默认模型与数值原样保留 |
| `monitors.json` | ID、名称、URL、间隔、启用状态、seen、计数保留；v0.2.1 cursor/lastScan/补偿/platformState/changes 原样保留 |
| v0.2.0 `monitors.json` | 迁移为 `version:2`，`compensationHours` 补 24，不伪造 cursor |
| `auto-tasks.json` | 待审核与终态行保留；v0.2.1 `modelCall` 保留；中断 `running` 行恢复为 `pending`，清除旧租约并记录恢复 |
| 旧候选 | 恢复任务命中核心已有候选后直接进入待审核，不再次调用模型 |
| `state.json` | 会话、候选、批准、去重台账的字节哈希不变 |
| `credentials.json` / `credentials.key` | 同机保留；密文可用原钥解密；设置 API 不回显完整测试值 |
| 二次启动 | 管理员、旧监控、新增监控、任务和核心台账仍在 |
| 损坏恢复 | `auto-tasks.json` 截断时从 `.bak` 恢复，损坏原文另存 `.corrupt-*`，待审核任务不丢 |
| 新增监控 | 迁移后的目录仍可创建新目标 |

### 5.2 v0.2.1 旧备份

`BackupService.list/verify/restore` 接受旧 manifest：

- `auto:true` → `daily`
- `auto:false` → `manual`
- 仅恢复白名单内的 `config.json/state.json/jobs.json`
- 恢复前自动生成 `pre-restore-*` 快照；脚本检查该快照覆盖当时全部现有白名单文件，且自身校验通过
- 同机管理员与凭据密钥不进入备份，也不被恢复操作删除

### 5.3 全局回复身份迁移策略与当前缺口

v0.2.1 没有 `reply-identities.json`。v0.2.2 引入全局身份栅栏，键形如：

```text
stable:<platform>:<threadId>:<postId>
```

正确的迁移策略应是：

1. 从 `monitors.json` 的 `seen` 与 `cursor.fingerprints` 收集平台、帖子、回复 ID 和指纹。
2. 对 `state.json` 中已有候选的回复建立 `state: "candidate"`，带上 `sessionId/candidateId`。
3. 对已结束但没有候选的生成任务建立明确的终态身份；只有 seen、没有候选或任务证据的行标记 `ignored`，原因写 `legacy-seen`，不能留成会被 orphan 恢复重放的 `claimed`。
4. 同一稳定键合并而不是重复插入；迁移必须幂等，二次启动不得再改。
5. v0.2.0 没有稳定指纹时，不把内容哈希伪装成稳定 fallback 身份；继续保留 monitor 级 seen 作为局部栅栏。

**当前实现状态：上述自动迁移尚不存在。** `app.ts` 只调用 `ReplyIdentityStore.load()`，文件不存在时不会从旧监控/任务/核心台账生成身份。本次真实升级因此没有生成 `reply-identities.json`。

现状仍能避免本次验收中的重复生成，因为旧 monitor 的 seen 保留、任务终态保留、核心生成器也会复用会话内已有候选；但删除后重建监控、或未来跨监控复用同一帖子时，缺少全局 candidate 身份仍有重复风险。发布前应由产品负责人决定：补齐自动迁移，或明确接受该限制并记录为已知问题。

## 6. 回滚

### 6.1 升级前

必须停掉 v0.2.1 服务，然后完整复制数据目录。不要只复制 `state.json`：管理员、凭据密钥、监控、任务、会话和备份目录都属于同一份状态。

```powershell
Stop-Service ai-debate
Copy-Item -Recurse -Force "$env:LOCALAPPDATA\ai-debate" "$env:LOCALAPPDATA\ai-debate.pre-v022"
```

### 6.2 回滚步骤

1. 停止 v0.2.2 服务，确认进程退出。
2. 用 v0.2.1 安装包覆盖程序文件。
3. 恢复升级前完整数据目录；若升级过程中产生新文件，不要删除 `.bak`、`.corrupt-*` 或 `backups/`，先把它们另存取证。
4. 重新启动 v0.2.1，检查 `/healthz`、管理员登录、监控列表和待审核任务。

`state.json` 在覆盖升级中不应变化；真正需要回滚 program state 时，优先恢复整目录，而不是手工拼接单个 JSON。

## 7. 本次实际执行证据

执行时间：2026-11-20 22:45（UTC+8，Windows 构建机）。

| 项目 | 实际结果 |
|---|---|
| `npm run typecheck` | 通过，0 错误 |
| `npm run test:upgrade` | **92/92 通过** |
| 旧附件 | 正式 v0.2.1 Windows EXE |
| 旧附件 SHA256 | `cb3b14f0dc52ff5d579e64df5e0e21eff051c62291dcde162d48cda9a16cedcf` |
| 旧附件版本输出 | `AI Debate 0.2.1 (win32-x64)` |
| 当前源码包版本 | `0.2.2` |
| 当前 `dist/ai-debate.cjs` SHA256 | `dcc25bf9e5b1777638617611ff55abeeb37d4578655c72f148beaa0bbef1b607` |
| 真实旧版 HTTP 写入 | setup=200、settings=200、两条 secrets=200、monitor=200 |
| 模型陷阱调用数 | 0（恢复旧任务复用已有候选） |
| v0.2.1 场景核心台账哈希 | `0c7952b50c76dd0870c8142edf1165abf7ace5dd3a94a97032783c1da67c0382` |
| v0.2.1 凭据密文哈希 | `8ea2abe162aaeca946bacbd1add94e98807fce709c7c798506e2857230d8ea86` |
| 全局身份迁移 | `strategy-only`，未生成 `reply-identities.json` |
| v0.2.0 兼容场景 | fixture 通过；未提供真实 v0.2.0 EXE |

证据边界：

- 真实 v0.2.1 附件、管理员、配置、监控和加密凭据由旧 EXE 写出；核心台账、任务行、确定性游标和旧备份 manifest 是离线植入，不能算作旧版自然运行产生。
- 当前侧验证的是源码构建的 `dist/ai-debate.cjs`，不是尚未产出的 v0.2.2 正式 EXE。
- 没有访问真实贴吧，也没有调用真实模型；验证的是升级读写与去重，不是平台连通性或模型质量。
- 备份 `list/verify` 通过 HTTP 验证；`restore` 在脚本中直接调用真实 `BackupService`，并检查预备快照与恢复结果。
