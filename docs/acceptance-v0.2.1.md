# v0.2.1 验收记录

本文件只记录**实际执行过**的检查。没跑的、跑不了的、只在模拟环境跑过的，分别标注，不合并成「通过」。

执行时间：2026-11-20（构建机 Windows，Node 22.22.2；CI 为 GitHub Actions）。
被测版本：v0.2.1（package.json 0.2.1）。

## 1. 自动化测试（本机）

| 套件 | 结果 | 说明 |
|---|---|---|
| 核心 `test:core` | 113/113 | 分析、生成、人格、评论链、去宿主化 |
| 服务端 `packages/server/test/**` | 38/38 | 含新增 `reliability.test.ts` 17 项、监控接口、认证、队列、HTTP |
| 前端 `packages/web/test` | 7/7 | jsdom：登录、11 页签、自动挂机页、CSRF 口径、401 回落 |
| HTTP 全流程 `standalone.ts` | 25/25 | 对**打包后的 EXE** 执行 |
| 挂机链路 `automation.ts` | 7/7 | 基线→发现→分析→生成→待审核、429、401、崩溃恢复、并发、去重 |
| 进程级恢复 `recovery.ts` | 8/8 | 真杀进程、重启、状态可读、无遗留 running |
| 分页与游标 `paging.ts` | 7/7 | 尾部读取页数、残页、窗口扫描、预算用尽、指纹稳定 |
| 升级 `upgrade.ts` | 23/23 | 旧目录→新版本，见 §3 |

类型检查 `tsc --noEmit` 0 错误；`scan-secrets` 通过；`assert-no-dsh` 通过。

## 2. 新增的可靠性测试覆盖

`packages/server/test/reliability.test.ts` 直接操作真实临时目录：

1. 写失败不破坏原文件、不改内存
2. 损坏文件先隔离、再从 `.bak` 恢复
3. 无备份时拒绝把损坏文件当空配置
4. 磁盘空间不足拒绝写入（`disk_full`）
5. 备份路径不可写时主写入仍成功
6. 不完整扫描不推进游标
7. 编辑被识别为变化，不是新回复
8. 只有全量扫描能判定删除
9. 同一页重复 id 只算一次
10. 容量上限拒绝新任务且台账不变
11. 卡死任务判定失败、释放槽位、可重试
12. 清理历史不删除 `needs_review`
13. 写入失败时内存不领先磁盘
14. `modelCall` 未完成 → 恢复标记 `interrupted_uncertain`
15. `modelCall` 已完成 → 恢复不标记不确定
16. `claim` 后重启保留 `running`（交给恢复判定）
17. 主文件与备份同时损坏 → 返回不可用而非抛错

## 3. 升级验收（真实旧结构）

执行：`node --experimental-transform-types test/acceptance/upgrade.ts` → **23/23**。

覆盖：

- 新版本能在旧数据目录上启动
- 旧 `config.json` 的值与数值保留（`llmModel=legacy-model`、`maxFloorPages=42`）
- 旧监控目标保留名称、间隔、`discovered` 计数
- 新字段 `compensationHours` 补默认 24
- 旧数据没有完整扫描记录时**不伪造** `lastCompleteScanAt`
- 旧任务（`needs_review` / `completed`）状态不变
- `monitors.json` 升级后写回 `version: 2`
- 升级后可继续新增监控
- 重启后管理员、监控、数据仍在
- 台账损坏时服务仍启动，损坏文件另存为 `.corrupt-*`，原文件不删除

**旧版来源说明**：本机执行时使用的是按 v0.2.0 实际写出的文件结构（管理员、配置、监控、任务行）。

本机**未能**用官方 v0.2.0 二进制生成数据目录：从 Release 下载 87.8 MB 的 EXE 时连接在 40 MB 处中断，两次尝试（API 通道 38 分钟、`gh release download` 15 分钟超时）均未取得完整文件，SHA256 与发布值不符。这一项如实记为「本机未执行」，不计为通过。

CI 的 `upgrade-real` 作业在 GitHub runner 上下载官方 Linux 包（41.7 MB），先用 **v0.2.0 二进制**完成管理员初始化、写入配置、创建监控，再用 v0.2.1 打开同一目录执行同一脚本 → **22/22 项通过**（比夹具路径少一项：真实旧目录里没有「已完成任务」行，脚本明确跳过而不再断言）。日志中的 `旧版来源：真实 v0.2.0 二进制` 与 `旧版二进制写入：setup=200 settings=200 monitor=200` 是该作业使用真旧版的证据。

## 4. Windows 启动器验收

执行：`node --experimental-transform-types --test test/acceptance/windows-launcher.ts` → **1/1 通过**（对 `dist/AI-Debate-windows-x64.exe`）。

逐项：

| 检查 | 结果 |
|---|---|
| 双击（无参数）启动，服务可用 | ✅ |
| 第二次双击报告「已在运行」，不产生第二个实例 | ✅ |
| `taskkill /F` 强杀服务后由守护进程拉起 | ✅ |
| `stop` 干净退出，端口不再应答 | ✅ |
| 停止后重启，配置仍在（`windows-acceptance-model`） | ✅ |
| 开机自启可写 `HKCU\...\Run` 且值带 `--no-browser` | ⚠ 本机无法验证 |

**关于自启**：本构建机的安全策略禁止 `reg.exe` 运行，产品返回可读的 400（「写入注册表失败，可能被安全软件拦截」），测试据此标记为「环境限制，未计为通过」，未伪造成功。在允许 `reg.exe` 的普通 Windows 上，该路径由同一段代码执行。

## 5. Linux 验收（CI，真实 systemd）

本机无法完成（Docker 守护进程未运行、无 Linux 环境），全部在 GitHub runner 上执行。CI 运行 `44689135767`，全部作业通过。

| 作业 | 结果 | 关键输出 |
|---|---|---|
| Package and install (ubuntu-22.04) | ✅ **26/26** | `systemctl 报告服务 active`、`systemd 已 enable`、`服务以独立低权限用户运行（ai-debate）`、`数据目录权限收紧（750）`、`进程被 kill -9 后由 systemd 自动拉起`、`卸载保留用户数据`、`重新安装后历史数据仍在` |
| Package and install (ubuntu-24.04) | ✅ **26/26** | 同上 |
| Debian 12 binary compatibility (no systemd) | ✅ | 安装脚本成功；`--version` 输出 `0.2.1`；`healthz {"ok":true,"version":"0.2.1"}`；`index:200`、`auth:200` |

两个 Ubuntu 作业都在真实 systemd 上执行：先 `systemctl start cron` 证明这个 runner 能真的启动 unit（不是只看 `systemctl status` 的字符串），再安装、启用、跑完整工作流、`kill -9` 验证自动拉起、卸载保留数据、重装保留历史。

Debian 12 作业在自己的日志里打印了限制：`Debian 12 容器没有 init，本作业只验证安装与程序兼容性，不验证 systemd 生命周期`。**Debian 12 的 systemd 生命周期未验证**，不计为通过。

## 6. 后台挂机稳定性

### 6.1 压力测试（本机与 CI）

`node --experimental-transform-types test/stress/soak.ts --seconds=120 --interval-ms=40`：

```json
{
  "wallClockSeconds": 120,
  "iterations": 2441,
  "replies": 120,
  "modelCalls": 119,
  "heapBaselineMb": 19,
  "heapFinalMb": 18,
  "heapGrowthMb": -1,
  "peakLedgerRows": 266,
  "ledgerRowsAtEnd": 266,
  "candidates": 119,
  "duplicateCandidates": 0
}
```

结论：两分钟、2441 次调度后堆没有增长；120 条回复产生 119 个候选（剩下一条是主人自己的发言，被正确过滤），**没有一条回复出现两个候选**；待执行任务峰值远低于容量。

CI 上同一脚本跑 **300 秒 / 7362 次调度**：

```json
{
  "wallClockSeconds": 300,
  "iterations": 7362,
  "replies": 120,
  "modelCalls": 119,
  "heapGrowthMb": 2,
  "peakQueued": 5,
  "peakLedgerRows": 512,
  "candidates": 119,
  "duplicateCandidates": 0
}
```

五分钟、7362 次调度后堆增长 2 MB；候选仍是一比一；待执行任务峰值 5（容量 400）。台账 512 行里 119 行是待审核（受保护、不清理），其余是历史，受保留策略约束。

### 6.2 未执行

- **24 小时墙钟压力测试未跑**。脚本支持 `--seconds=86400`，CI 跑 5 分钟。已测的是压缩时间下的高迭代行为，不等于 24 小时。
- 真实平台长期轮询未跑（无实号凭据）。

## 7. 真实平台只读检查

执行：`node scripts/check-platform.mjs --url https://tieba.baidu.com/p/8899001122`（匿名，无 Cookie）。

结果：

```json
{
  "ok": false,
  "platform": "tieba",
  "authenticated": false,
  "errorCode": "not_found",
  "errorMessage": "帖子 8899001122 没有可读取的楼层，可能已被删除",
  "elapsedMs": 498
}
```

同一网络对 `https://tieba.baidu.com/` 的直连返回 **403**。也就是说，构建网络到贴吧的匿名读取本身被拒绝，无法据此判断适配器正确与否。

**结论：真实平台能力未验证。** 这不是「已知可用但没测」，是「没有证据」。界面上的能力状态保持 `unverified` / `unavailable`，不因本次检查而改变。

## 8. 安全回归

| 检查 | 结果 |
|---|---|
| 未登录访问 `/api/ai-debate/automation/*` | 401（`monitor-api.test.ts`） |
| 跨站 Origin 的写请求 | 403 |
| 非 JSON content-type 的写请求 | 415 |
| `/automation/publish`、`/automation/approve` | 404（后台无发表入口） |
| 凭据不出现在日志 | 脱敏测试（`runtime.test.ts`） |
| 凭据不回显 | `describe` 不含长度/末位 |
| 修改已批准正文后旧批准失效 | 核心既有测试 |
| 非法 URL（内网/未知域） | 400 且不落库 |
| 审计事件 | 登录、监控增删改、暂停/恢复、队列清理/回收/重试、存储损坏/恢复/迁移 |

## 8.5 发布后校验

Release `v0.2.1` 由 tag 触发的工作流发布（annotated tag `531e9637` → commit `ca549cbf`）。发布后的 `verify-assets` 作业在 runner 上**重新下载**了三个附件：

```
AI-Debate-windows-x64.exe: OK      87895040 字节
ai-debate-linux-x64.tgz: OK        41753971 字节
```

`sha256sum -c SHA256SUMS.txt` 通过；TGZ 解包后跑了凭据扫描；GitHub 记录的附件摘要与 `SHA256SUMS.txt` 一致：

```
cb3b14f0dc52ff5d579e64df5e0e21eff051c62291dcde162d48cda9a16cedcf  AI-Debate-windows-x64.exe
2b658c70dbcacca3ccb74a5e794b4603132017d8d3d96655815f4f204a5d5f61  ai-debate-linux-x64.tgz
```

`releases/latest` 返回 `v0.2.1`，`prerelease=false`、`draft=false`；v0.2.0 的三个附件摘要与发布时一致，未被改动。

**这一作业的最后一步在 v0.2.1 首次运行时失败**，原因是 `gh release view --json` 没有 `isLatest` 字段（`Unknown JSON field`）。这是校验脚本的错误，不是附件或产品的问题；同一作业里的下载、校验和、解包扫描都已通过。工作流已改为查询 `/releases/latest`，本文件发布后由 API 复核上面三项。

本机无法直接下载附件（到 GitHub Release 的连接在 40 MB 处中断），因此「重新下载并核对」的证据来自 runner，而不是构建机。

## 9. 未完成的验证（明确列出）

1. 24 小时墙钟压力测试（已跑 5 分钟 CI + 2 分钟本机）。
2. 真实贴吧/微博账号的长期轮询与限流行为。
3. Debian 12 的 systemd 生命周期（只有安装与二进制兼容）。
4. Windows 开机自启的实际注册表写入（本机 `reg.exe` 被策略拦截；CI 的 windows-latest 上该检查会真实执行）。
5. 真实发表：本版本依旧不开放无人值守发表，也未在真实账号上验证发表能力。
