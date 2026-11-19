# v0.2.0 后台挂机架构

从 v0.1.3 的工具型工作台，升级为可长期运行的后台 Agent。本文件记录**做了什么、边界在哪、以及为什么这样分层**。

## 一、一句话

新增一层「后台引擎」：独立的监控配置、独立的任务台账、独立的调度器。它调用 `packages/core` 已有的分析与生成逻辑（不重写引擎），产出的候选停在「待人工审核」，**永远不自动发表**。

## 二、分层

```
packages/core
  product-api.ts   ← 后台可用的最小接口（probe / analyze / generate / session / ownerIdentity / resolveUrl）
  probe.ts         ← 读策略：首页 + 末页 + 有界嵌套回复；fullScan 才走整帖

packages/server
  monitor/store.ts   ← 监控目标 + 游标 + 基线 + 计数器（monitors.json）
  monitor/tasks.ts   ← 后台任务台账（auto-tasks.json），8 个状态
  monitor/engine.ts  ← 调度 + 执行 + 重试退避 + 失败分类 + 阻塞
  http.ts            ← /api/ai-debate/automation/*（会话鉴权）
  jobs.ts            ← 原有维护队列，**未改动语义**

packages/web
  automation-panel.cjs ← 新「自动挂机」视图（普通 DOM）
  entry.cjs            ← 顶栏加「配置 / 自动挂机」两个入口
```

### 为什么维护队列不复用
`jobs.ts` 的任务产出是文件（备份、轮转），终态只有成功/失败。后台任务产出的是「等你审的候选」，终态里有 `needs_review`，重试策略取决于平台响应。合成一个状态机，第一个被丢掉的就是「这条在等你」。所以两套台账并存，互不影响；`jobs.ts` 一行未改。

## 三、监控目标

`monitors.json`，每个目标记录：

| 字段 | 说明 |
|---|---|
| `id / name / platform / url / threadId` | 身份 |
| `accountLabel` | 操作者自填的平台账号备注（不参与鉴权） |
| `enabled` | 调度器是否领取 |
| `intervalSec` | ≥120 秒，低于下限被抬到 120 |
| `lastCheckAt / lastSuccessAt / lastError / lastErrorAt` | 最近一次检查的可观测状态 |
| `blockedReason` | 认证失败时写入并自动暂停 |
| `seen[]` | 已处理过的 post id，最多 1000 条 |
| `baselineAt` | 首次成功读取的时间，之前的内容只入游标不分析 |
| `counters` | 累计/当日：发现、分析、候选、失败 |

**基线语义**：第一次成功读取只建立游标，不分析既有回复。否则按下「监控」就要为一个 200 楼的历史帖付 200 次模型费。页面会显示「首次检查建立基线：已记录 N 条既有发言，不自动分析」。

## 四、任务台账

`auto-tasks.json`，状态机：

```
pending ──claim──> running ──ok──> completed
   ▲                  │
   │                  ├─ needs_review   （候选已生成，等人确认）
   │                  ├─ blocked        （认证/绑定问题，监控被暂停）
   │                  ├─ failed         （不可重试或重试用尽）
   └── retry_wait <───┘                （平台要求等待，或退避）
```

字段：`id / kind / monitorId / postId / postIds / sessionId / dedupeKey / state / attempts / maxAttempts / createdAt / updatedAt / nextRunAt / startedAt / finishedAt / lastError / lastErrorKind / retryAfterMs / logs[]`。

### 去重

| 任务 | dedupeKey | 语义 |
|---|---|---|
| probe | `probe:<monitorId>` | 同一目标同时只允许一个探测（recurring，完成后可再排） |
| analyze | `analyze:<monitorId>:<首个新postId>` | 一批新回复合并成一次分析 |
| generate | `generate:<sessionId>:<postId>` | 一条回复只允许一个候选，跨重启成立 |

探测是**重复性**任务，完成后可以被再次排入；分析与生成是**一次性**任务，完成后同 key 不再接受。这个差异写在 `enqueue()` 里，用一个分支表达，不是两套代码。

## 五、执行顺序

一个 tick：

1. **调度**：对每个 `enabled && !blocked` 且 `now - lastCheckAt >= intervalSec * 1000` 的目标排一个 probe；已在队列里的跳过。
2. **领取**：取 `nextRunAt <= now` 的最早任务，转 `running`，attempts+1。
3. **并发**：全局默认 1（`AI_DEBATE_JOB_CONCURRENCY` 同源，1..4），每平台 1。平台满时任务**释放回队列**（`release()` 回退 attempts），不消耗重试次数。
4. **执行**：
   - probe：`api.probe()` → 过滤主人自己的发言 → `acceptSeen()` 写游标 → 新回复排入一批 analyze。
   - analyze：`api.analyze({ url })`（**不传 postId**，见下）→ 为每个新回复排 generate。
   - generate：先查是否已有同目标候选（崩溃恢复时复用）→ 否则 `api.generate()` → `needs_review`。
5. **失败处理**：见下表。

**为什么 analyze 不传新回复的 postId**：`runAnalysis` 要求触发帖的作者是主人，否则抛「这条回复的作者不是配置的主人」。新回复必然是对手写的，传进去每一条都会失败；不传则引擎自己选主人最新一条，与手工粘贴链接的行为一致。

## 六、失败分类

`classifyFailure()` 把异常归成 6 类，决定「重试 / 暂停监控 / 放弃」：

| kind | 判定依据 | 动作 |
|---|---|---|
| `rate_limited` | `code=rate_limited` 或 HTTP 429 | 按 `retryAfterMs` 等待；没有则指数退避+抖动 |
| `auth` | `auth_required` / `unauthorized` / `forbidden` / `permission_denied` / `captcha` / 401 / 403 | **暂停该监控**，写 `blockedReason`，不重试 |
| `network` | `network` / `timeout` / `dns` / 5xx | 指数退避（15s 起，上限 30min，半抖动） |
| `permanent` | `not_found` / `malformed_response` / `bad_response` | 直接 failed |
| `policy` | `context_too_long` 或安全拒绝文案 | 直接 failed，记录原因 |
| `owner_unbound` / `capacity` | 核心特定文案 | 前者暂停监控，后者退避重试 |

**无限重试不存在**：`maxAttempts` 按类型固定（probe 4 / analyze 3 / generate 2），用尽即 failed。

## 七、崩溃恢复

启动时 `recoverInterrupted()`：把磁盘上所有 `running` 改回 `pending`，attempts+1，写 `lastErrorKind='interrupted'`，并记一条日志。

安全性来自三个幂等点：
- analyze 用 `(thread, trigger)` 去重，重跑复用同一会话；
- generate 先查同目标候选，已存在就转 `needs_review` 而不重新调用模型；
- probe 重复读只是多一次请求，游标不会倒退（`acceptSeen` 只追加）。

验证：`test/acceptance/recovery.ts` 用真实进程 + 预埋 `running` 台账，断言「重启后磁盘上没有遗留 running」。

## 八、安全边界（未放宽任何一条）

| 约束 | 现状 |
|---|---|
| 不自动发表 | `DebateProductApi` 没有 publish 方法；`/automation/publish` 与 `/approve` 是 404（测试钉住） |
| 人工批准仍然必需 | 候选终态 `needs_review`，仍需在审批页生成一次性批准记录 |
| 认证 | `/automation/*` 与会话同级，未登录 401；控制令牌不覆盖它 |
| CSRF/同源 | 复用全局围栏（Origin/Host + `application/json` + SameSite=Strict） |
| SSRF | 新建监控前 `resolveUrl()` 必须命中已注册平台；非法链接 400 且不落库 |
| 凭据 | 未新增任何明文路径；后台任务日志只记 post id 与错误文本 |
| 审计 | `monitor.created/updated/removed/toggled`、`automation.paused/resumed` 全部落 `audit.jsonl` |

## 九、Windows 与 Linux 的常驻差异

| 机制 | Windows | Linux |
|---|---|---|
| 守护 | `ai-debate supervise`：子进程退出码非 0/75 时按 1s→30s 指数退避重启 | systemd `Restart=always` |
| 自启 | 可选写 `HKCU\...\Run`（默认关闭） | `systemctl enable` |
| 单实例 | `run/instance.lock` + `/healthz` 双判据 | 同 |
| 停止 | `ai-debate stop`（control token → `process.exit(0)`，守护不再拉起） | `systemctl stop` |

## 十、已知取舍

1. **探测只读末页**（默认 2 页 + 每楼最多 3 页嵌套、最多 12 楼）。长帖中途被删改的旧回复不会补读；全量读要显式 `fullScan`。
2. **一个帖子一个监控**：同一 thread 重复添加被 400 拒绝，避免两个游标互相覆盖。
3. **计数器按日滚动**：跨日自动清零，`counters.day` 记录归属日期。
4. **监控暂停不取消已排队任务**：恢复后继续，避免「暂停一次丢掉半条链」。
