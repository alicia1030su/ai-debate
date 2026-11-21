# v0.2.2 覆盖升级说明与验收记录

本文记录 **正式 v0.2.1 Windows Release 附件 → v0.2.2 构建** 的覆盖升级验收方法、预期迁移、回滚步骤和实际证据。它不替代发布签字；真实附件、当前构建和未覆盖项必须分别阅读。最终候选已冻结并通过架构复审，连续 24h Soak 正在运行；最终 EXE 改由 CI 打包并复验，当前为 **NO-GO**。计数器修复后的最终源码 bundle 已通过真实 v0.2.1 + v0.2.0 fixture 的 **97/97** 升级验收。

## 1. 当前状态

- 验收脚本：`test/acceptance/upgrade.ts`
- 主场景：v0.2.1 真实 EXE 通过 HTTP 写出的数据目录，由当前 v0.2.2 构建原地打开。
- 兼容场景：v0.2.0 旧结构回归仍保留；本次未提供 v0.2.0 EXE，因此该场景是 fixture，不宣称真实旧版二进制验证。
- 全局身份自动迁移：`packages/server/src/monitor/migrate.ts` 已在 `app.ts` 接到后台引擎启动前；迁移测试 20/20、身份测试 13/13、启动集成 5/5，合计 **38/38**；真实 v0.2.1 升级 **97/97 通过，`identityMigration: "migrated"`，`modelCalls=0`**。详见 §5.3。
- 既有 Windows EXE 均完成于最终修复之前或本地重建被安全守卫阻断，已解除最终资产资格。最终 EXE 由 CI Windows job 打包，再用真实 v0.2.1 附件复验；CI `upgrade-real` 尚未运行，Linux TGZ 尚未构建。

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

### 5.3 全局回复身份迁移实现与接线状态

v0.2.1 没有 `reply-identities.json`。v0.2.2 引入全局身份栅栏，键形如：

```text
stable:<platform>:<threadId>:<postId>
```

`monitor/migrate.ts` 按以下规则重建：

1. 从 `monitors.json` 的 `seen` 与 `cursor.fingerprints` 收集平台、帖子、回复 ID 和指纹；同一 platform+thread 的重复监控合并为同一稳定键。
2. `state.json` 中已有候选的回复建立 `state: "candidate"`，带上 `sessionId/candidateId`，优先级最高。
3. `pending/running/retry_wait/blocked` 任务对应 `claimed`，并回填 `identityKey/identityKeys`；已终态但无候选的任务标 `ignored`。
4. 只有 seen、没有候选或任务证据的回复标 `ignored(legacy-seen)`，不会留成会被 orphan 恢复重放的 `claimed`。
5. 指纹优先用 cursor；缺失时使用 `legacy-<sha256>` 确定性非空值。找不到监控的核心会话使用 `legacy:<platform>:<threadId>` 作为来源标记。
6. 身份台账先原子写入，再一次性回填任务；任务写失败抛错。二次启动只补任务、不覆盖身份台账。`state.json` 损坏、监控/会话上下文冲突、非法候选、未知任务 kind 或多个已批准候选冲突时必须熔断，不得写出不完整身份或回填任务，也不得写迁移完成标记。持久完成标记让同源重启无写入；源变化只做安全增量；完成标记写失败时下一次只补标记。

**接线状态：已完成。** `app.ts` 在监控引擎启动前调用迁移函数；身份文件不存在时原子创建，已存在时不覆盖，旧任务缺 key 时幂等回填。`state.json` 损坏、上下文/候选冲突、未知任务 kind 时迁移熔断，不写半成品或完成标记；身份或监控源台账不可读时，服务与 `/healthz` 保持可用，但自动化与核心/手工分析接口熔断并报告 `identityMigrationError`。身份台账严格校验 `candidateId`，engine 回到核心会话核验。真实 v0.2.1 升级验收为 **97/97，`migrated`，`modelCalls=0`**；startup-migration 另验证二次启动身份与任务文件哈希不变。

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

历史首次执行：2026-11-20 22:45（UTC+8，Windows 构建机），接线前 92/92；严格迁移完成后于 UTC 2026-11-21 复跑，B1–B4 修复候选回归为 **97/97 通过，`identityMigration: "migrated"`，`modelCalls=0`**。

| 项目 | 实际结果 |
|---|---|
| `npm run typecheck` | 通过，0 错误 |
| `npm run test:upgrade` | **97/97 通过** |
| 旧附件 | 正式 v0.2.1 Windows EXE |
| 旧附件 SHA256 | `cb3b14f0dc52ff5d579e64df5e0e21eff051c62291dcde162d48cda9a16cedcf` |
| 旧附件版本输出 | `AI Debate 0.2.1 (win32-x64)` |
| 官方 v0.2.1 Linux TGZ SHA256 | `2b658c70dbcacca3ccb74a5e794b4603132017d8d3d96655815f4f204a5d5f61`（CI 配置校验，尚未本机运行） |
| 当前源码包版本 | `0.2.2` |
| 最终源码 bundle | 已重建；真实 v0.2.1 + v0.2.0 fixture 升级 97/97 通过 |
| 历史 Windows EXE（非最终） | `AI Debate 0.2.2 (win32-x64)`；89,966,592 字节；SHA256 `adfb51128437b159ab05fd3be7377b09438887bbbfc9eaf268d21ded98f8fea2` |
| 最终 Windows EXE | 由 CI 打包并回填 SHA256/大小/版本；本地重建被批量删除安全守卫阻断，未绕过 |
| 真实旧版 HTTP 写入 | setup=200、settings=200、两条 secrets=200、monitor=200 |
| 模型陷阱调用数 | 0（恢复旧任务复用已有候选） |
| v0.2.1 场景核心台账哈希 | `0c7952b50c76dd0870c8142edf1165abf7ace5dd3a94a97032783c1da67c0382` |
| v0.2.1 凭据密文哈希 | `8ea2abe162aaeca946bacbd1add94e98807fce709c7c798506e2857230d8ea86` |
| 全局身份迁移 | **`migrated`**；迁移 20/20、身份 13/13、启动集成 5/5，合计 38/38；真实升级 97/97 |
| v0.2.0 兼容场景 | fixture 通过；未提供真实 v0.2.0 EXE |
| CI `upgrade-real` | 已配置下载并校验真实 v0.2.1/v0.2.0 Linux TGZ；尚未运行 |

证据边界：

- 真实 v0.2.1 附件、管理员、配置、监控和加密凭据由旧 EXE 写出；核心台账、任务行、确定性游标和旧备份 manifest 是离线植入，不能算作旧版自然运行产生。
- 97/97 升级验收使用计数器修复后的最终源码 bundle；旧 EXE 的 standalone 27/27 不能替代最终 EXE 验收。最终 EXE 与升级复验由 CI 完成后回填；CI `upgrade-real` 尚未运行。
- 没有访问真实贴吧，也没有调用真实模型；验证的是升级读写与去重，不是平台连通性或模型质量。
- 备份 `list/verify` 通过 HTTP 验证；`restore` 在脚本中直接调用真实 `BackupService`，并检查预备快照与恢复结果。
