# AI Debate v0.2.2 验收报告

> 状态：**最终候选已重新冻结，Soak/持久化架构复审 IS_PASS YES；v0.2.2 CI 全 job 已通过，全新连续 24h Soak 正在运行，最终双平台资产下载复验与正式 Release/Tag/Latest 尚未完成；当前发布判定仍为 NO-GO**。
>
> 未完成门禁：连续 24h Soak 报告、最终 Windows EXE/Linux TGZ 下载复验与 Latest 正式化。本报告不替代最终发布签字。

## 1. 环境与证据口径

- 仓库：`ai-debate`，版本 `0.2.2`。
- 本机：Windows x64，Node.js `22.22.2`；CI 固定 Node.js `22.18.0`。
- 最终候选冻结基线：UTC 2026-11-21 12:03:04；冻结清单见 `.tmp-data/soak-v022-continuous-final-20261121T120304Z/freeze.txt`。
- 最终 `packages/server/src/monitor/engine.ts` SHA256：`5323c87bc66306ba1e825fcf0ab0a5994afd754d05f977c6667f685225307c1c`。
- 最终 `packages/server/test/monitor-engine.test.ts` SHA256：`0c549bd09b0da69e8b1f2179ba9c1b85aef2694fce791e159bfd264db627b47c`。
- 最终 `test/stress/soak-v022.ts` SHA256：`14fddcede38f8bbef023570144d958414fb1e71b70e92b42488f220b5b7f4224`。
- 既有 Windows EXE 构建于最终修复之前，已解除最终资产资格，必须重建；构建、测试与长跑证据不能相互替代。
- 本轮回填只更新六份发布文档，不改动产品代码、测试、工作流或 package 文件，也不把开发期或未完成门禁写成通过。

## 2. 最终候选回归

### 2.1 当前结果

| 项目 | 结果 | 边界 |
|---|---|---|
| Core | **227/227 通过** | 含 HTTP 出网、manual 重定向、DNS 固定、Abort/429 边界 |
| Server | **CI 166/166 通过，fail 0** | 本机历史快照为 164/164，完成于最终 server-only 写序修复前且命令末尾被安全策略附注拦截；最终计数以 CI 为准 |
| B1 四文件定向回归 | **74/74 通过** | 最终 Core 候选 |
| monitor-engine 独立复跑 | **47/47 通过** | 最终写序修复后执行 |
| Web | **12/12 通过** | 自动挂机、备份错误、诊断与未知值展示 |
| standalone | **27/27 通过** | 脚本化端到端 |
| automation | **8/8 通过** | 平台为脚本化 double |
| recovery | **8 项通过** | 崩溃恢复 acceptance |
| paging | **7/7 通过** | 游标/分页 acceptance |
| 真实 v0.2.1 升级 | **97/97 通过，`identityMigration: "migrated"`，`modelCalls=0`** | 真实 v0.2.1 Windows EXE；v0.2.0 仍为 fixture |
| 迁移相关 | **38/38 通过** | migrate 20/20 + identities 13/13 + startup-migration 5/5 |
| 终态身份恢复 | **60/60 通过** | identities 13/13 + monitor-engine 47/47 |
| Soak harness 自测 | **6/6 通过** | soak-v022 4/4 + soak-faults 2/2；不代替 24h |
| 秘密扫描器回归 | **12/12 通过** | 仓库秘密扫描通过，覆盖 235 个受版本控制文件；含 ELF 节偏移迁移基线回归 |
| TypeScript | **`tsc --noEmit` 通过** | B1–B4 修复候选 |
| 差异检查 | **`git diff --check`、`git diff --cached --check` 均通过** | B1–B4 修复候选 |

以上计数对应当前冻结候选。本机 Server 全量 164/164 完成于最后的计数器与发现写序修复之前；修复后已独立复跑 monitor-engine 47/47、standalone 27/27、真实升级 97/97、Soak 自测 6/6、高磁盘故障压力测试、两组故障 Soak 与类型检查。最终 CI 已在提交 `a119b5d0772c77cd62c9058dbeb2e6ee87ac64fb` 上重新执行全量，运行 `44907546464` 的 10 个 job 全部通过。

### 2.2 B1 四文件基线

| 文件 | SHA256 |
|---|---|
| `packages/core/src/net-audit.ts` | `afa3c8a9e959710fd3b0c779591474f469c3842d02ba5f325886a1d9f7bd6190` |
| `packages/core/src/platforms/http.ts` | `959bd9eff06a59a147f1cb98377544cde1127b714a5044bb0a8e29c365febf2e` |
| `packages/core/test/net-audit-egress.test.ts` | `34bbdaf52995219cd0bf56999d6d3d70b797166615bd94d220e5cd16fa9749aa` |
| `packages/core/test/platform-http.test.ts` | `844f2b956d19dff02035cc096ec078b064f3da7aa2318b7cbe2bc532872ab7df` |

## 3. 恢复与 receipt 专项

- 恢复成功后 `jobs.json` 与备份逐字节一致；旧队列 finally 不覆盖恢复结果。
- 成功恢复以退出码 `75` 请求受控重启。
- `run/job-receipts.json` 原子持久化；POSIX 模式 `0600`。
- 恢复任务重启后可经 `GET /api/ai-debate/jobs` 查询，状态为 `succeeded` 并含“备份恢复成功”日志。
- receipt 上限：sidecar `2 MiB`、最多 `50` 条、每条最多 `40` 行日志；单条日志消息 `64 KiB`、`lastError` `256 KiB`。
- 损坏、结构非法或超限 receipt 被安全忽略，原件保留并生成 `.corrupt-*`；任务与诊断接口保持可用。
- receipt 写入失败仍退出 `75`，不覆盖已恢复的 `jobs.json`。
- 恢复失败会回滚 live 文件，恢复队列持久化并真正重启后台引擎；维护队列临时 pause 不持久化，`persistenceSuspended=false`。
- 失败 `lastError` 保留真实 JSON 解析错误，并明确后台引擎已重新启动、队列已恢复运行。

## 4. 身份迁移与 HTTP 出网安全

### 4.1 身份迁移

- `app.ts` 在监控引擎启动前调用 `migrateLegacyReplyIdentities()`。
- 身份文件不存在时创建；已存在时不覆盖新证据；旧任务缺 key 时可幂等回填。
- 身份先写、任务后填；身份写失败时任务不得先被改写。
- `state.json` 损坏、监控/会话上下文冲突、非法候选、未知任务 kind 或多个已批准候选冲突时迁移熔断，不写出不完整身份、不回填任务，也不写迁移完成标记。
- 持久迁移完成标记让同源重启无写入；源变化只做安全增量；完成标记写失败时下次只补标记。
- 身份/监控源台账不可读时，服务与 `/healthz` 保持可用，但自动化与核心/手工分析接口熔断，状态接口报告 `identityMigrationError`。
- 真实 v0.2.1 升级为 **97/97，`migrated`，`modelCalls=0`**；迁移相关测试合计 **38/38**。

### 4.2 HTTP 重定向与出网

- `HttpClient` 使用 `redirect: 'manual'`，最多跟随 5 跳，循环立即停止。
- 每一跳在 `fetch` 前重新执行出网策略；跨域凭据剥离与 `Set-Cookie` 隔离已实现。
- 全模式私网/回环/link-local/metadata 拒绝、HTTPS 降级拒绝与跨域 307/308 正文拒绝已通过 Core 227/227。
- B1 已修复：首次 socket lookup 固定 A/AAAA 地址，后续连接复用固定地址；生产 fetch 使用传入 dispatcher 时，同源重定向不重复解析；新 host 逐跳执行策略校验；出网策略变严时仍重新验证。
- 跨域重定向剥离 `Cookie`/`Authorization`；跨域响应 `Set-Cookie` 进入独立 redirect jar，不污染后续同源请求。
- `EgressBlockedError` 原样传播，不被包装为普通 network 错误，不重试、不发表。
- 精确边界：`isPinned` 仅在至少一次成功通过策略校验的 socket lookup 后返回 `true`；自定义/注入 fetch 若忽略 dispatcher，就不会触发 `PinnedDnsAgent` 的真实 socket lookup，既不能固定地址，也不能依靠 `isPinned` 跳过后续预检。代理/TLS 选项不会继承到固定 Agent；CookieJar 仍无 Domain/Path/Secure/过期属性。

## 5. Soak：历史失败与当前发布阻断

### 5.1 历史长跑（不能作为连续 24h 通过）

- 原状态目录：`.tmp-data/soak-v022-24h/`。
- 启动于 UTC 2026-11-20 13:23:53；19:23Z 与 01:23Z 检查点采到同一停止点，`lastTickAt=2026-11-20T16:38:01.057Z`、`elapsedHours=3.236`。
- 16:38Z 后长跑实际停止，约 9 小时后才从冻结快照恢复；因此墙钟跨度不能当作连续 active 时长。
- 首次连续运行在 1881.156 秒后因 `stuckIdentity=1` 失败，现场为 `stable:faketieba:t016:r4` 的 generate 任务进入 failed/claimed 终态。该事实保留为产品缺陷历史，不以 harness 豁免掩盖。
- 产品侧已修复终态身份占用：active 集合只计真正覆盖工作的状态；failed generate 无候选时收敛为 `ignored`，人工 retry 仍可恢复；已有候选时进入 `needs_review`，不重复调用模型；`markCandidate` 写失败保持 completed/claimed 待对账。
- Soak harness 新增 `authBlockedIdentity` 严格分类：仅任务 `blocked` 且对应 monitor 仍 blocked 时豁免；其他终态仍计入 `stuckIdentity`。harness 自测 6/6，严格短 Soak 的不变量为 0。

### 5.2 B1–B4 修复候选连续 24h Soak：302.081s 失败（历史事实）

- 启动时间：UTC 2026-11-21T06:35:44.646Z；失败时间：**UTC 2026-11-21T06:40:46**。
- 参数：`monitors=1000`、`seed=1`、`kill-every=300`、`seconds=86400`。
- 失败报告：`.tmp-data/soak-v022-final-20261121T063520Z/report.json`；`wallClockSeconds=302.081`。
- 首次 SIGKILL/resume 后 `stuckIdentity=2`、`coreLockTimeouts=3`。
- `lostTasks`、`duplicateCandidates`、`cursorRegressions`、`completedTaskReexecutions`、`unrecordedInterruptions`、`unhandledErrors`、`convergenceLag` 均为 `0`。
- 锁现场：`holderPid=1648`、`holderAt=2026-11-21T06:38:52.092Z`、`holderAgeMs=94623`。
- 当前无 Soak 进程残留；检查点已停止，现场与报告保留。
- **该次连续 24h 未通过。** 两项发布阻断已修复并补确定性回归：
  1. core 锁 release 的瞬时读失败不再泄漏活 PID 锁；同 PID 未注册 token 可作为孤儿回收，release 使用 token CAS，清理诊断不覆盖已成功 persist。
  2. 自动化 session 与 Soak harness 改为 durable-only；dirty 内存候选不再成为身份/审核证据，幽灵候选仅在持久核心明确 absent 时熔断，unavailable 保持等待。
- 架构复审另发现历史幽灵候选写序缺口：identity ignored 必须先于 task failed；任务终态写失败时下一轮仅补任务，不重读核心、不调用模型。
- B1–B4 架构签字前启动的 `.tmp-data/soak-v022-final-20261121T063026Z/` 已停止，不能作为连续 24h 证据。

### 5.3 最终冻结候选预检与连续 24h 运行

- 第一次“最终”长跑 `.tmp-data/soak-v022-continuous-final-20261121T092929Z/` 在约 22 分钟、4 次 SIGKILL/恢复后因最终 EXE 升级验收暴露计数器回归而主动中止；现场与 `ABORTED.txt` 保留，不计通过。恢复既有候选曾错误调用 `noteOutcome('candidate')`，把历史候选数从 2 增加到 3；现仅新生成且持久化的候选计数，恢复/复用不重复计数。
- 第二次长跑 `.tmp-data/soak-v022-continuous-final-20261121T100117Z/` 在 5553.25 秒、18 次 SIGKILL/恢复后因 `lostTasks=1` 失败；其余严格不变量为 0。根因是分析任务入队失败被吞掉后游标仍推进，回复被当作已知并依赖延迟孤儿恢复。现发现顺序改为 identity → analysis task → cursor，任务写失败时游标不推进；现场与 `ABORTED.txt` 保留。
- 60 秒高磁盘故障压力测试通过：4 次 SIGKILL/恢复、实际磁盘写故障 1 次，所有严格不变量为 0；报告 SHA256 `3e7798e8b4307bf28aefdae357f07ae73e6ebd3ff3734c11411ee4a16655cbd9`。
- 冻结清单：`.tmp-data/soak-v022-continuous-final-20261121T120304Z/freeze.txt`。
- 1000 监控、15 秒预检：通过；`generations=2`、`candidates=2`，全部严格不变量为 0；报告 SHA256 `09274cef17918b329f18938147dbec9e5a904e4835a2623dab1a55fdb391cd4f`。
- 40 监控、`kill-every=4`、15 秒预检：通过；2 次 SIGKILL、2 次恢复，全部严格不变量为 0；报告 SHA256 `90b4f1a6ae388abeb97f81381538d204754d73f8638b862c006aacf51c493e26`。
- 全新连续 24h Soak 于 UTC `2026-11-21T12:05:15.222Z` 启动，参数 `monitors=1000`、`seed=1`、`kill-every=300`、`seconds=86400`；状态目录 `.tmp-data/soak-v022-continuous-final-20261121T120304Z/`。当前正在运行，尚未取得最终报告。

## 6. 发布资产、工作流与 CI

- 历史 Windows EXE（89,966,592 字节，SHA256 `adfb5112…`）与计数器修复前本地 EXE（SHA256 `b155127b…`）均不是最终资产。
- 最终 EXE 本地重建被 WorkBuddy 批量删除安全守卫阻断（`packages/core/lib` 276 个文件，超过阈值）；未绕过守卫，最终 Windows/Linux 资产改由 CI 打包 job 产出并复验。
- 最终源码 bundle 的 standalone **27/27**、真实升级 **97/97** 已通过；`verify-release.mjs`、Node 基线秘密扫描、打包后 standalone/launcher 必须在 CI 最终资产上重跑。
- 注册表自启被本机安全策略阻断，**未计通过**。
- v0.2.2 CI 全 job 已通过：运行 `44907546464`，提交 `a119b5d0772c77cd62c9058dbeb2e6ee87ac64fb`；覆盖三平台 Test、真实 v0.2.1/v0.2.0 升级、Windows 打包、Ubuntu 22/24 真实 systemd 生命周期、5 分钟 Soak、Debian 12 兼容与秘密扫描。最终资产下载复验与正式 Release/Tag/Latest **尚未完成**。
- 真实贴吧/微博账号、Debian 12 真实 systemd：**未验证**。

## 7. 已知限制（P2，后续加固）

- `scripts/scan-secrets.mjs` 默认整文件豁免 scanner 与 `test/acceptance/fixtures/README.md`；这两个文件误存真实凭据时不会被默认扫描发现。
- 目录扫描模式对 `>4 MiB` 文件、深度 `>8`、文件数 `>5000` 静默跳过；SEA 二进制通过 `--baseline` 单独差分扫描：PE 只放行同偏移、同字节的 Node 运行时原匹配；ELF 按节名和大小配对，要求至少 99% 可加载代码/静态数据字节与基线一致；只放行已配对节内对应字节也完全相同的运行时原匹配，新增 note、改写或未匹配区域仍全量扫描。
- 模型请求不是 exactly-once；中断重试可能重复计费/调用。
- 租约与实例记录不是分布式锁；不支持多实例。
- manual/pre-restore 备份永不自动删除；长期运行需关注磁盘。
- logrotate 使用 `copytruncate`，极短窗口可能丢少量日志。
- Windows EXE 未代码签名。
- draft 资产核验失败时，guard 会因 release 已存在而阻止同一 workflow 直接重跑；需人工清理 draft 或后续调整 guard 的幂等策略（P2）。

## 8. 发布判定

**当前判定：NO-GO。**

B1–B4 与新增 Soak/持久化阻断均已关闭，**最终架构复审 IS_PASS YES**；该 PASS 只放行冻结候选进入连续 24h Soak，不等于正式发布签字：

1. **B1 DNS 固定：已关闭。** 首次 socket lookup 固定 A/AAAA，后续连接复用；生产 fetch 使用 dispatcher 时同源重定向不重复解析，新 host 逐跳校验，策略变严仍复验。四文件定向 74/74，Core 227/227。
2. **B2 未知任务 kind 熔断：已关闭。** 迁移全量枚举校验任务 kind，未知值熔断且不写 `migration.complete`；migrate 20/20。
3. **B3 身份台账严格校验：已关闭。** 非法 `candidateId` 被拒绝，engine 回到核心会话核验候选证据；identities 13/13、monitor-engine 47/47。
4. **B4 候选/analyze 双台账收敛：已关闭。** `candidateId` 仅作核心 session 提示，candidate 与 completed analyze 执行无模型对账，并在 await 后/finish 前重查 `needs_review` 防止异步竞态；终态身份恢复 60/60。
5. **Core 锁与 durable 读取：已关闭。** 同 PID 孤儿 token 可回收，其他活进程 token 不抢占；持久读等待 writeChain 并持锁读盘，不覆盖 dirty 内存。
6. **幽灵候选与写序：已关闭。** durable absent 才熔断；identity ignored 先于 task failed，反向窗口由 ignored-review pass 无模型补任务；unavailable 保持等待。

以下项目完成前仍不得正式发布：

1. 取得最终冻结候选的连续 24h Soak 报告、墙钟时长、重启/杀死、不变量、峰值与结论。
2. 对 CI 已构建的最终 Windows EXE 与 Linux TGZ 完成下载后 SHA256、版本、秘密扫描与安装/恢复复验。
3. 完成 Tag 驱动 Release 工作流、draft 资产/GitHub digest 复验与 Latest 正式化。
4. 产品负责人确认真实平台、Windows 自启、Debian systemd 等未覆盖项的风险接受。
