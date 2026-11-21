# AI Debate v0.2.2 可靠性设计与验收边界

> 范围：存储、后台调度、平台失败处理、备份恢复、常驻部署与长跑验证。
>
> 状态：**最终冻结候选回归通过，B1–B4 与 Soak/持久化架构复审 IS_PASS YES；全新连续 24h Soak 正在运行（NO-GO）**。v0.2.2 CI、最终双平台资产与正式 Release/Tag/Latest 仍须回填。
>
> 证据基线：UTC 2026-11-21 12:03:04 的最终冻结候选；清单见 `.tmp-data/soak-v022-continuous-final-20261121T120304Z/freeze.txt`。

## 1. 可靠性目标与实际保证

v0.2.2 不承诺分布式 exactly-once，也不承诺模型请求永不重复。它保证的是：

1. **状态先落盘再采纳**：监控、后台任务与身份台账写失败时，内存不能领先磁盘。
2. **中断可解释**：进程退出后不遗留 `running`；可能发出过的模型调用标记为“结果不确定”。
3. **重复有围栏**：同一平台+帖子+回复跨监控、跨会话、跨重启只认领一次。
4. **不完整不伪装**：错页、空页、预算耗尽、嵌套截断都有明确状态；不完整扫描不更新“最后一次完整读取”。
5. **失败会降级**：平台认证失败暂停目标；台账写失败停止领取；磁盘不足拒绝大写入。
6. **恢复有退路**：恢复前快照、逐文件校验、失败回滚、受控重启；崩溃中的恢复不自动重跑。
7. **发表不可重试**：后台没有 publish 能力，候选必须等人审批。

## 2. 存储可靠性

### 2.1 原子写

`packages/server/src/atomic.ts` 实现：

```text
open(temp) → 循环写满并拒绝短写 → fsync(file) → 复制 .bak → rename → fsync(dir)
```

- `AtomicWriteError.kind` 区分 `disk_full`、`permission`、`io`。
- rename 前失败不触碰旧文件；rename 后失败会清理临时文件。
- POSIX 刷新目录项；Windows 依赖 NTFS 日志，跳过目录 fsync。
- `.bak` 复制失败不阻止主写入，但会降低下一次损坏时的恢复能力。

### 2.2 损坏恢复

- `readJsonQuarantine()` 先把损坏原文复制为 `.corrupt-*`，不静默覆盖。
- `readJsonWithBackup()` 主文件损坏时尝试 `.bak`，恢复事件写入审计。
- 监控或身份台账主文件与备份都不可用时，保留原文件并进入明确的加载错误状态，不把“坏了”当成“空库”。

### 2.3 空间预检

`assertWritableSpace()` 用 `statfsSync` 检查目标卷可用空间，并保留默认 8 MiB 地板。它不预留空间，其他进程仍可能在检查后占满磁盘，因此原子写的错误处理仍是最后防线。

备份创建按源文件大小的两倍加 manifest 余量估算；恢复按当前/备份较大集合的四倍加 manifest 余量估算，覆盖预备快照、新 live 副本与完整回滚副本。

## 3. 游标、补偿与读取范围

### 3.1 三条不变量

1. **同一回复不在一次扫描内重复计数**：按 post id 去重。
2. **已看到不等于已完整覆盖**：`seen/fingerprints` 可记录部分读取；只有 `complete=true` 才更新 `lastCompleteScanAt`。
3. **不能证明不存在就不判定删除**：只有 `full` 扫描才产生 `deleted`。

`MonitorStore.applyScan()` 将新回复、变化、删除、seen、指纹、游标、扫描记录与计数构造成一个文档，一次原子写入。

### 3.2 指纹与变化

指纹输入为种类、作者 ID、作者名、正文、创建时间与父楼层；不含页内 `order`。因此新增其他回复不会把旧回复误报为编辑。

- 新身份进入分析/生成。
- 已存在身份但指纹变化：记录 `edited`，不重新生成候选。
- 全量读取中消失：记录 `deleted`。
- 补偿读取中重新出现：记录差异，不把历史内容当新回复。

### 3.3 有界读取

| 策略 | 上限 |
|---|---|
| 常规尾部 | 首页 + 末两页 |
| 单轮楼中楼 | 最多 12 楼，每楼最多 3 页 |
| 单轮请求 | 48 次 |
| 补偿窗口 | 最多 8 页；时间窗口 1–168 小时，0 关闭 |
| 全量 | `maxFloorPages`，默认 60 |
| 轮询间隔 | 最低 120 秒 |

顶部楼层不完整会阻止“完整覆盖”声明；楼中楼截断作为单独限制报告，不永久阻塞顶部游标。所有上限与原因都进入任务日志和自动挂机页。

## 4. 全局身份与任务租约

### 4.1 身份先于游标

处理顺序是：

```text
持久化 ReplyIdentityStore.claim()
  → 持久化 MonitorStore.applyScan()
  → 持久化分析任务
```

两种崩溃窗口都可修复：

- claim 成功、游标失败：下轮仍能看到回复，但全局 claim 阻止第二次认领。
- claim 成功、游标成功、任务写入失败：orphan sweep 发现“有身份、无任务”，重新排入分析。

身份状态 `candidate/ignored` 是终态语义，不会被 orphan sweep 重新打开。批量分析覆盖 `identityKeys`，新身份可追加到 pending 批次；已 running 的批次不会被静默扩充。

启动迁移在引擎观察监控前执行：身份文件不存在时从旧 `seen`、游标指纹、任务与核心候选原子重建；已存在时不覆盖新证据；旧任务缺 key 时可幂等回填。身份写失败时任务不得先被改写。`state.json` 损坏、监控/会话上下文冲突、非法候选、未知任务 kind 或多个已批准候选冲突时迁移熔断，不写出不完整身份或回填任务，也不写完成标记。持久完成标记让同源重启无写入，源变化只做安全增量。身份或监控源台账不可读时，服务与 `/healthz` 保持可用，但自动化与核心/手工分析接口熔断并报告 `identityMigrationError`，避免以空身份栅栏重放旧回复。身份台账严格校验 `candidateId`，engine 回到核心会话核验，不能凭伪造字段建立候选证据。

### 4.2 租约与心跳

- claim 持久化随机 token 与过期时间，默认 10 分钟。
- 每个调度 tick 续租 in-flight 任务；错误 token 不能续租。
- 过期任务由 `reapStuck()` 置 `failed` 并释放槽位；有模型调用时标记 `uncertain`。
- 进程重启恢复 `running → pending`、attempts+1、清除旧租约，并保留恢复记录。

这是单实例部署的活性机制，不是分布式互斥。强行删除实例记录启动第二个进程仍可能破坏部署，产品不宣称支持这种用法。

### 4.3 模型调用

生成请求前写 `beginModelCall`；返回后写 `finishModelCall`。进程在请求期间退出时：

- 任务重新排队；
- `lastErrorKind='interrupted_uncertain'`；
- `modelCall.uncertain=true`；
- 状态中心与自动挂机页单独显示。

重试前先检查核心会话是否已有同目标候选；存在则直接进入 `needs_review`，不再调用模型。因此候选记录不重复，但网络请求本身可能重复，文档不承诺 exactly-once。

## 5. 平台失败与贴吧诊断

`classifyFailure()` 将平台与模型错误映射为可执行动作：

| 错误 | 动作 | 重试 |
|---|---|---|
| 429 | 使用平台 `Retry-After`，否则指数退避 + 抖动 | 有上限 |
| 401/403/captcha/permission denied | 暂停监控，写 `blockedReason` | 不自动重试 |
| network/timeout/dns/5xx | 指数退避，15 秒起，上限 30 分钟 | 有上限 |
| `EgressBlockedError` / 出网策略拒绝 | 原样传播，不包装为 network，不重试、不发表 | 不重试 |
| 404/malformed/bad response | 任务失败 | 不重试 |
| context too long/安全拒绝 | 记录策略原因 | 不重试 |
| 台账 `AtomicWriteError` | 停止领取，30 秒冷却后重试 | 由写恢复驱动 |

贴吧适配器额外提供：

- 真实 WAP 分页元数据校验；请求页与返回页不一致、声明有页却为空时标记 `partial`。
- 429 保留 `Retry-After`；401 归为认证失效；403 验证页归为 captcha；5xx 归为网络错误。
- 楼中楼分页通道遇到 403/429/captcha 后冷却 10 分钟，期间改用 WAP 内联楼中楼，并明确报告数量可能少于平台声明。
- `describeDiagnostics()` 只返回 Cookie 名称、认证是否已知、通道状态、最近读取与脱敏错误，不返回 Cookie 值。
- `platform-check` 是只读探测，不推进监控游标。

这些行为由 captured fixtures 与脚本化平台验证；**不等于真实账号验证**。贴吧 `supported` 只表示曾于 2026-10-27 跑通，不表示当前可达。

解析层仍有未闭环风险：楼层/楼中楼选择器为硬编码正则，页面改版可能把空解析误报为删除或未登录；三个真实夹具尚未接入回归。403 验证页已由 `packages/core/test/tieba-403-diagnosis.test.ts` 固定 HTTP 与 fault-classify 的标记一致性，并用真实 `challenge-403.html` 夹具防止回归。

平台 HTTP 使用 manual 逐跳重定向：每一跳在 `fetch` 前重新执行出网策略，最多 5 跳；跨域剥离 `Cookie`/`Authorization`/`Referer`/`Origin`，跨域 `Set-Cookie` 进入独立 redirect jar，不污染后续同源请求。`EgressBlockedError` 原样传播且不重试。全模式私网/回环/link-local/metadata 拒绝、HTTPS 降级拒绝、跨域 307/308 正文拒绝与 DNS 固定已通过 Core 227/227 回归。B1 已修复：首次 socket lookup 固定 A/AAAA，后续连接复用；生产 fetch 使用 dispatcher 时同源重定向不重复解析，新 host 逐跳校验，策略变严仍复验。精确边界：`isPinned` 仅在至少一次成功通过策略校验的 socket lookup 后返回 `true`；注入 fetch 若忽略 dispatcher，就不会触发真实 socket lookup，既不能固定地址，也不能依靠 `isPinned` 跳过后续预检。代理/TLS 选项不会继承到固定 Agent；CookieJar 仍无 Domain/Path/Secure/过期属性。

## 6. 备份、恢复与轮转

### 6.1 快照可靠性

- 固定七文件白名单，逐项 SHA-256 + 字节数。
- 暂存目录私有（0700/0600），文件 flush 后一次 rename 发布；失败不留下“看似完成”的最终目录。
- 拒绝符号链接、非普通文件、清单外文件与旧明文字段。
- daily 保留 7 份、weekly 保留 4 份；只自动删除完整校验通过的副本。
- manual、pre-restore、损坏或不可验证备份永久保留，并提示空间风险。

### 6.2 恢复可靠性

恢复前完成源校验、密钥指纹决策与空间预检，再创建 `pre-restore-*`。替换采用同目录临时文件 + rename；全部替换后再次校验 SHA-256 与 JSON 可解析性。

失败时：

- 已替换文件按预备快照回滚；
- 恢复前不存在的文件被删除；
- 原 manifest 的 restored/skipped 记录尝试撤销；
- 写 `backup.restore_failed` 审计，包含 `rollbackOk` 与错误；
- 回滚不完全成功时明确报错，不假装恢复成功。

恢复期间停止后台引擎、暂停维护队列并挂起队列持久化，避免旧 `jobs.json` 在 finally 中覆盖恢复结果。成功后以退出码 75 请求受控重启；终态与日志通过 `run/job-receipts.json` 保留，重启后由 `GET /api/ai-debate/jobs` 合并展示。失败后回滚 live 文件、恢复队列持久化与运行状态，并真正重启后台引擎；临时 pause 不持久化，任务错误保留原始恢复失败上下文。receipt 损坏、结构非法或超过 2 MiB/50 条/40 日志上限时安全忽略并保留现场。维护队列对崩溃中的 `backup.restore` 不自动重跑。

### 6.3 凭据可移植性

| 目标机器状态 | 行为 |
|---|---|
| 无 `credentials.key` | 跳过 `credentials.json`，其他白名单文件恢复；提示重填 |
| 密钥指纹匹配 | 恢复密文并继续使用 |
| 已有不同密钥 | 拒绝整个恢复，不创建预备快照，不覆盖 live 数据 |

启动时不会因为“要准备恢复”而新建临时密钥，避免把可恢复的缺密钥场景变成指纹不匹配。

## 7. 可观测性与运维动作

自动挂机页从服务端读取：

- 调度心跳、最后 tick、最后成功读取、tick 耗时；
- 队列占用、最久等待、卡死数、积压等级；
- 监控启用/阻塞、最近错误、扫描覆盖、最后完整读取、补偿时间；
- 最近恢复与不确定模型调用；
- 内存 RSS/heap、数据目录与磁盘余量；
- 备份总数、分类、最近备份、无效清单数量；
- 台账加载/写入错误与待审核候选。

状态未知显示“—”，不显示伪造的 0。备份/恢复按钮等待后台任务真实终态；HTTP 202 不会被当成操作成功。

## 8. 可恢复 Soak

### 8.1 设计

`test/stress/soak-v022.ts` 使用生产 `AutomationEngine`、三个 store、`runAnalysis/runGeneration` 与核心台账；只把平台批量读取和模型替换为脚本/本地 HTTP double，不访问真实平台。

`scripts/run-soak.mjs` 是跨平台 supervisor：

- 子进程在持久安全点可自行 SIGKILL；
- supervisor 仅在 SIGKILL/137 且未到原截止时间时以 `--resume` 重启；
- 普通失败立即向父进程传播，不重试成假通过；
- 所有重启共享原墙钟 deadline；
- 状态文件保存迭代、计数、线程、游标水印、故障 PRNG 与故障计数，恢复后继续同一故障序列；
- 最终报告记录实际起止时间、累计/请求时长、重启、杀死、模型调用、候选、失败、重试、内存、CPU、队列/台账峰值与不变量。

原恢复长跑参数：`--seconds=86400 --monitors=1000 --seed=1 --kill-every=300`，supervisor 截止 **UTC 2026-11-21 13:23:51**。

### 8.2 原恢复长跑：历史快照，墙钟不等于连续 active

`checkpoints.json` 的 **19:23Z** 与 **01:23Z** 两个 `scheduled_checkpoint` 采到同一停止点：`lastTickAt=2026-11-20T16:38:01.057Z`、`elapsedHours=3.236`，iterations/scans/analyses/generations/restarts/kills 完全相同。长跑在 16:38Z 后实际停止，直到 2026-11-21 01:46Z 左右才从冻结快照恢复，中断约 **9 小时**。

因此 13:23Z→02:10Z 的约 **12h46m** 是墙钟跨度，不能当作连续 24h；实际 active 约为 **3.2h + 恢复后的运行时间**。

QA 最后快照（UTC 02:10:49）：`completed=false`，lastTickAge `0.329s`，iterations 2892、restarts 18、kills 11、peakQueue 25、peakLedger 531、memoryPeak 47.32 MB；duplicate/lost/cursor/terminal-replay/unrecorded/unhandled/convergence/stuck 均为 0，`invariantFailures=[]`。仍有 1 条 acknowledgedFailure、`storeWriteFailures=1`、`degradedDiskSessions=1`、`backlogSessions=3`，最终报告必须解释。

### 8.3 首次连续 Soak：历史失败快照

- 计划任务：`AI-Debate-Soak-v022-Continuous24h`。
- `startedAt=2026-11-21T01:51:30.195Z`，固定 `deadline=2026-11-22T01:51:04Z`。
- 冻结快照：`.tmp-data/soak-frozen-20261120T161446Z`；独立状态：`.tmp-data/soak-v022-continuous/state.json`。
- QA 快照（UTC 02:14:38）：`completed=false`，lastTickAge `0.037s`，iterations 1331、restarts/kills 4/4、peakQueue 26、peakLedger 278、memoryPeak 45.79 MB。
- 首次连续运行在 **1881.156s** 后失败，证据保留为 `report-failed-1881s.json`：`stuckIdentity=1`。`stable:faketieba:t016:r4` 于 02:22:24.854Z claim；generate task `55e161ed-01d3-4947-9b4b-4bd35ee4ebd4` attempts=2/maxAttempts=2，模型调用 02:22:48.748→49.874Z uncertain 超时，49.930Z failed/network；monitor `soak-monitor-0016` 最终无 blockedReason；50.889Z soak 失败。这是产品 failed+claimed 缺陷，不是 auth-blocked 误判。
- Soak harness 新增 `authBlockedIdentity`：仅当任务 `state='blocked'` 且对应 monitor 仍存在 `blockedReason` 时豁免，单独计数；`failed/cancelled/completed/needs_review` 以及 monitor 已不 blocked 的 blocked 任务仍严格计入 `stuckIdentity`。Soak 自测 **6/6 通过**；最终严格短 Soak 预检的 stuck/lost/duplicate/unhandled 全为 0。
- 产品侧终态任务占用身份已修复：active 集合只计真正覆盖工作的状态，blocked 监控不重排；failed generate 无候选时收敛为 `ignored`，人工 retry 仍可恢复；核心已有候选时直接转 `needs_review`；completed analyze 命中候选时 analyze 转 `needs_review`、generate 创建 0、model call 0；`markCandidate` 写失败保持 completed/claimed，并由 candidate/analyze 无模型对账继续收敛。最终 identities **13/13**、monitor-engine **47/47**，合计 **60/60**。
- 该次失败是历史事实，修复后的短测通过也不能替代 B1–B4 修复候选的连续 24h。

### 8.4 B1–B4 修复候选连续 24h Soak：302.081s 失败（历史事实）

- 启动时间：UTC 2026-11-21T06:35:44.646Z；失败时间：**UTC 2026-11-21T06:40:46**。
- 参数：`monitors=1000`、`seed=1`、`kill-every=300`、`seconds=86400`。
- 失败报告：`.tmp-data/soak-v022-final-20261121T063520Z/report.json`；`wallClockSeconds=302.081`。
- 首次 SIGKILL/resume 后 `stuckIdentity=2`、`coreLockTimeouts=3`。
- `lostTasks`、`duplicateCandidates`、`cursorRegressions`、`completedTaskReexecutions`、`unrecordedInterruptions`、`unhandledErrors`、`convergenceLag` 均为 `0`。
- 锁现场：`holderPid=1648`、`holderAt=2026-11-21T06:38:52.092Z`、`holderAgeMs=94623`。
- 该次检查点已停止，现场与报告保留。**该次连续 24h 未通过。**
- 两项发布阻断已修复：
  1. core 锁 release 的瞬时读失败不再泄漏活 PID 锁；同 PID 未注册 token 可回收，release 使用 token CAS。
  2. 自动化 session 与 Soak harness 改为 durable-only；dirty 内存候选不再成为身份/审核证据。
- 另修复历史幽灵候选写序：identity ignored 先于 task failed；任务写失败时下一轮仅补任务，不重读核心、不调用模型。
- B1–B4 架构签字前启动的 `.tmp-data/soak-v022-final-20261121T063026Z/` 已停止，不能作为连续 24h 证据。

### 8.5 最终冻结候选预检与连续 24h 运行

- 第一次最终长跑 `.tmp-data/soak-v022-continuous-final-20261121T092929Z/` 在约 22 分钟后因计数器回归主动中止并失效，现场保留于 `ABORTED.txt`。恢复既有候选曾重复累计 monitor 候选数；现仅正常生成路径计数，恢复/复用不重复计数。
- 第二次最终长跑 `.tmp-data/soak-v022-continuous-final-20261121T100117Z/` 在 5553.25 秒、18 次 SIGKILL/恢复后因 `lostTasks=1` 失败。分析任务入队失败曾被吞掉并继续推进游标；现发现顺序为 identity → analysis task → cursor，任务写失败时游标不推进。60 秒高磁盘故障压力测试通过，报告 SHA256 `3e7798e8b4307bf28aefdae357f07ae73e6ebd3ff3734c11411ee4a16655cbd9`。
- 冻结清单：`.tmp-data/soak-v022-continuous-final-20261121T120304Z/freeze.txt`；最终 `engine.ts` SHA256 `5323c87bc66306ba1e825fcf0ab0a5994afd754d05f977c6667f685225307c1c`。
- 1000 监控、15 秒预检通过，全部严格不变量为 0；报告 SHA256 `09274cef17918b329f18938147dbec9e5a904e4835a2623dab1a55fdb391cd4f`。
- 40 监控、`kill-every=4`、15 秒预检通过，2 次 SIGKILL、2 次恢复，全部严格不变量为 0；报告 SHA256 `90b4f1a6ae388abeb97f81381538d204754d73f8638b862c006aacf51c493e26`。
- 全新连续 24h Soak 于 UTC `2026-11-21T12:05:15.222Z` 启动，状态目录 `.tmp-data/soak-v022-continuous-final-20261121T120304Z/`；当前正在运行，尚无最终报告。

## 9. 回归证据

### 9.1 最终冻结候选回归

证据基线为 UTC 2026-11-21 12:03:04。Server 全量完成于最后一次仅涉及 server 写序的修复之前；该修复后已复跑 monitor-engine、Soak 自测、两组故障 Soak 与类型检查，最终 CI 仍须重新执行全量。

| 套件/检查 | 结果 | 边界 |
|---|---|---|
| Core | **227/227 通过** | 含 DNS 固定、manual 重定向、Cookie 隔离与出网边界 |
| Server | **164/164 通过，exit 0** | 最终 server-only 写序修复前全量；命令输出后本机安全策略附注拦截，未重试 |
| B1 四文件定向 | **74/74 通过** | `net-audit.ts`、`platforms/http.ts` 与两份对应测试 |
| monitor-engine | **47/47 通过** | 最终写序修复后独立复跑 |
| Web | **12/12 通过** | 自动挂机、备份错误、诊断与未知值展示 |
| standalone | **27/27 通过** | 脚本化端到端 |
| automation | **8/8 通过** | 平台为脚本化 double |
| recovery | **8 项通过** | 崩溃恢复 acceptance |
| paging | **7/7 通过** | 游标/分页 acceptance |
| 真实升级 | **97/97，`identityMigration: "migrated"`，`modelCalls=0`** | 真实 v0.2.1 Windows EXE；v0.2.0 仍为 fixture |
| 迁移相关 | **38/38** | migrate 20/20 + identities 13/13 + startup-migration 5/5 |
| 终态身份恢复 | **60/60** | identities 13/13 + monitor-engine 47/47 |
| Soak harness 自测 | **6/6 通过** | soak-v022 4/4 + soak-faults 2/2；不代替连续 24h |
| 秘密扫描器回归 | **12/12 通过** | 仓库扫描通过，235 个受版本控制文件；含 ELF 节偏移迁移基线回归 |
| 类型与差异检查 | **`tsc --noEmit`、`git diff --check`、`git diff --cached --check` 均通过** | 最终冻结候选 |

### 9.2 最终修复前 Windows 资产证据（非发布资产）

- `AI Debate 0.2.2 (win32-x64)`，89,966,592 字节，SHA256 `adfb51128437b159ab05fd3be7377b09438887bbbfc9eaf268d21ded98f8fea2`。
- 构建时间 UTC 2026-11-21 06:30:19，晚于 B1–B4 修复候选 engine。
- 该 EXE 已因新 Soak 阻断解除最终冻结资格；修复后需重新构建并回填最终哈希。
- `verify-release.mjs` 29/29；打包后 standalone 27/27；Windows launcher 1/1。
- Node 基线秘密扫描通过，忽略 3 条运行时原字节匹配；应用 bundle 0 命中。
- 注册表自启被本机安全策略阻断，未计通过；Linux TGZ 尚未构建。

### 9.3 历史快照与未完成项

- 文档工程师早期复跑与 QA Round 3 计数均属于历史快照，已被 §9.1 B1–B4 修复候选结果取代，不作为当前结论。
- 早期复跑使用 `npm run --ignore-scripts <suite>` 以避免重建钩子删除并重建产物；该命令边界仍只适用于对应历史证据。
- 302.081s 与 5553.25s 失败现场均保留；最终冻结候选的连续 24h Soak 正在运行。v0.2.2 CI 多轮运行中，Linux ELF 基线修复等待最新完整轮次；最终 Linux/Windows 资产、下载后复验与 Latest 尚未完成。当前发布判定为 **NO-GO**。

## 10. 剩余可靠性风险

| 风险 | 影响 | 当前缓解 |
|---|---|---|
| core 锁 release 瞬时读失败（已修复） | 曾留下活 PID 锁并触发 `coreLockTimeouts` | 同 PID 孤儿 token 回收、token CAS release、清理诊断不覆盖 persist；短测与 24h Soak 复验 |
| dirty 内存候选被当作持久证据（已修复） | 曾造成 candidate 身份/任务与磁盘 `candidates=0` 不一致 | durable-only 产品 API 与 harness；absent/unavailable 分离；短测与 24h Soak 复验 |
| 恢复既有候选重复累计 monitor 计数（已修复） | 升级/孤儿恢复把历史候选数再次加一 | 仅正常生成持久候选后计数；恢复/复用不计数；monitor-engine 47/47、真实升级 97/97 |
| 发现任务写失败后游标仍推进（已修复） | 回复被当作已知，短暂依赖延迟孤儿恢复并触发 lostTasks | identity → analysis task → cursor；任务写失败传播且游标不推进；monitor-engine 47/47、60 秒高磁盘故障压力测试通过 |
| 模型请求不是 exactly-once | 中断重试可能重复计费/调用 | 调用前落盘、uncertain 标记、候选去重、人工可见 |
| 租约不是分布式锁 | 强行多实例会破坏活性与一致性 | 单实例记录、明确不支持多实例 |
| 全局身份台账无独立 TTL/裁剪 | 长期运行文件可能持续增长 | 24h Soak 与状态中心体积观测；后续需制定保留策略 |
| manual/pre-restore 备份永不自动删除 | 长期运维可能占满磁盘 | 列表、空间预检与永久保留提示；需人工归档 |
| 维护队列写失败仅记日志 | `jobs.json` 的内存态可能领先磁盘 | 原子写保护旧文件；恢复路径暂停/挂起持久化；与后台任务的 fail-closed 语义不同 |
| logrotate 使用 copytruncate | truncate/append 窗口可能丢少量日志 | weekly/4 份/10 MB/压缩；审计与关键状态另有持久文件 |
| 有界读取 | 窗口外编辑、超页嵌套与超 `maxFloorPages` 内容可能漏读 | 明确 incomplete 原因、补偿与手动全量 |
| 真实平台行为未知 | 风控、限流阈值、页面结构可能与 fixture 不同 | 诊断、冷却、失败分类；实号验收未完成 |
| 身份迁移源损坏 | 以空身份栅栏启动可能重放旧回复 | 启动前迁移；身份/监控源不可读时自动化熔断，服务与健康检查仍可用 |
| 秘密扫描静默边界 | 允许文件或超大/过深目录可能漏扫 | 默认整文件豁免 scanner 与 fixtures README；目录模式跳过 >4 MiB、深度>8、文件数>5000；SEA 二进制通过 `--baseline` 单独差分：PE 同偏移原字节；ELF 按节名和大小配对，至少 99% 可加载代码/静态数据字节一致后，只放行对应字节完全相同的原匹配 |

## 11. 运维处置

| 现象 | 建议动作 |
|---|---|
| 监控 `blockedReason` 非空 | 更新平台凭据，确认账号/权限后点“恢复”；不要短时间反复重试 |
| 任务 `interrupted_uncertain` 或 `stuck` | 先查看核心会话是否已有同目标候选；需要时手动重试，承担可能重复的模型请求 |
| 状态显示“持久化写入失败” | 检查磁盘余量与目录权限；恢复写入后引擎会在冷却后继续，不要手工清空台账 |
| 扫描不完整 | 查看 `incompleteReason` 与页数；降低目标范围或择时全量重查，不把部分读取当完整 |
| 备份清单无效 | 点“校验”查看具体文件；不要恢复不可验证副本 |
| 恢复失败 | 服务会自动恢复队列运行并重启后台引擎；查看 `pre-restore-*`、审计 `rollbackOk` 与任务错误，确认回滚完整后再重试 |
| 备份空间持续增长 | 将 manual/pre-restore 副本归档到受控存储后再人工删除；不要关闭校验直接清理 |

## 12. 待最终验收回填

| 项目 | 必须记录 |
|---|---|
| 类型与差异检查 | 最终冻结候选已通过；最终 Tag 与 CI 上的命令、退出码仍待复验 |
| 24h Soak | 最终冻结候选连续 24h 报告、全部不变量、墙钟时长、重启/杀死、内存与队列/台账峰值 |
| Soak/持久化阻断 | 已修复并复审通过；core 孤儿锁/durable-only/幽灵候选写序的确定性回归已通过，等待 24h 与 CI 复验 |
| v0.2.2 CI | 运行链接、Ubuntu/Windows/真实升级/打包/systemd/Debian 各 job 结论 |
| 身份迁移 | 迁移 20/20、身份 13/13、启动集成 5/5，合计 38/38；真实升级 97/97 `migrated`；最终 Tag 与 CI `upgrade-real` 待复验 |
| 正式资产 | 既有 Windows EXE 非最终资产；最终 EXE/TGZ SHA256、版本、安装/恢复、下载复验与 Latest 待完成 |
| 真实平台与受限主机 | 实号、Windows 自启、Debian systemd 的实测结果或明确未覆盖说明 |

最终结论以 `docs/acceptance-v0.2.2.md` 为准。
