# v0.2.1 可靠性增强：设计与实现说明

本文件记录 v0.2.1 相对 v0.2.0 在**可靠性**上的改动：为什么改、改在哪、以及哪些是刻意不做的。
它不是发布说明（见 `docs/release-notes-v0.2.1.md`），也不是验收证据（见 `docs/acceptance-v0.2.1.md`）。

## 1. 出发点：v0.2.0 的四个真实缺口

v0.2.0 把挂机链路跑通了，但四件事在长期运行上站不住：

| 缺口 | 后果 | v0.2.1 的处理 |
|---|---|---|
| 写入失败时内存先行 | 磁盘满时控制台显示「已保存」，重启后消失 | 所有状态写入改为**先落盘、再采纳**；失败抛错并进入降级 |
| 只读帖子尾部 | 旧回复被编辑/删除永远发现不了 | 新增**补偿扫描**（时间窗口）+ 指纹比对 + 手动全量重查 |
| 恢复不区分「请求是否发出」 | 崩溃后重放模型调用，却不说明可能重复 | 任务记录 `modelCall`，中断的调用标记 `uncertain` |
| 队列只增不减 | 长期运行后台账无界 | 分层保留策略 + 容量上限 + 卡死回收 + 积压告警 |

## 2. 存储层（`packages/server/src/atomic.ts`）

### 2.1 原子写

```
open(temp) → write 全量（短写即抛错） → fsync(file) → [copy .bak] → rename → fsync(dir)
```

三处容易漏掉，都已处理：

1. **短写**：`writeSync` 可能只写一部分。旧实现遇到 `written <= 0` 就 `break`，然后把半截文件 rename 过去并报告成功。现在抛错并删除临时文件。
2. **目录项持久化**：`fsync` 文件只保证内容落盘，重命名这个目录项本身还需要 `fsync(dir)`。Linux/macOS 开目录句柄做；Windows 的 NTFS 重命名自带日志，跳过。
3. **失败不伤旧文件**：目标文件只被最后的 rename 触碰；rename 前才复制 `.bak`。

`AtomicWriteError` 带 `kind: 'disk_full' | 'permission' | 'io'`，调用方能区分「该停下」与「该提示路径」。

### 2.2 损坏与恢复

- `readJsonQuarantine`：解析失败先复制为 `.corrupt-<时间>`，再返回 `corrupt: true`，绝不覆盖原文。
- `readJsonWithBackup`：主文件坏 → 试 `.bak` → 都没有才返回不可用。恢复时写一条 `store.restored` 审计事件。
- 磁盘空间：`assertWritableSpace` 在写大文档前检查余量，不足时抛 `disk_full` 而不是写一半。

### 2.3 为什么不换 SQLite

评估过。结论是**不换**，理由：

- 现有三个文档（`monitors.json`、`auto-tasks.json`、核心的 `state.json`）都是「整体读、整体写、单进程」，没有并发写者。SQLite 的价值在多方并发与部分更新，这里都用不上。
- 换库意味着核心的 `DebateStore` 也要动（它有跨进程锁、原子写、去重台账）。那是一次 4 万行代码的存储迁移，风险远大于收益。
- 真正需要的能力（崩溃后不丢、损坏可恢复、写入失败不谎报）用原子写 + 备份 + 隔离就能满足，而且这些已经实现了。

如果将来出现「多进程同时写同一目录」的需求，那才是换 SQLite 的时机；现在的单实例锁明确禁止这种部署。

## 3. 监控游标（`packages/server/src/monitor/store.ts`）

### 3.1 一条不变量

> **游标只在那次扫描完整、且扫描到的回复已经和游标写进同一个文档时，才前进。**

`applyScan()` 把「新回复、变化、消失、游标、计数」构造成一个文档，一次写入。写失败则内存不变（见 §2.1 的「先落盘再采纳」），所以不会出现「内存以为读完了、磁盘上没有」的状态。

### 3.2 三种读取模式（`packages/core/src/probe.ts`）

| 模式 | 读什么 | 用在哪 |
|---|---|---|
| `tail` | 首页 + 末两页 + 这些楼的楼中楼 | 每次轮询 |
| `window` | 从末页向前，直到整页早于窗口（上限 8 页） | 补偿扫描 |
| `full` | `collectThread` 全量，受 `maxFloorPages` 限制 | 手动全量重查 |

三种模式都返回 `scan.complete` 与 `scan.incompleteReason`。**不完整就说不完整**，前端与任务日志都直接显示这句话。

### 3.3 指纹

每条回复带 `fingerprint = sha256(kind, authorId, authorName, createdAt, floorPostId, content).slice(16)`。

- **不含 `order`**：`order` 是页内位置，别人回一句就变，把它算进去会把每次新回复都误报成「所有旧回复都被编辑」。
- 指纹存在游标里，只保留 `seen` 里还留着的 id，不会无界增长。
- 已知 id 且指纹变了 → 记为 `edited`；只在 `full` 模式下「已知 id 不在结果里」→ 记为 `deleted`。

### 3.4 编辑不算新回复

`applyScan` 返回 `fresh / changed / removed` 三组。只有 `fresh` 进分析队列。**被编辑的旧回复只记录差异，不生成候选**——针对一条已被改写的发言生成回复，等于回答一个不存在的问题。

### 3.5 补偿扫描也会发现新内容

第一版把补偿扫描写成「只记差异」。实测发现：当轮询间隔较长或进程刚恢复时，新回复可能第一次出现在补偿扫描里，那样就会被静默丢弃。现在补偿扫描的 `fresh` 同样进分析队列，`changed` 仍然只记录。

## 4. 任务台账（`packages/server/src/monitor/tasks.ts`）

### 4.1 先写盘，再采纳

`#commit(next)` 的顺序是 `writeJson` → 成功后才替换内存数组。任何写失败都抛 `AtomicWriteError`，调用方（引擎）据此降级：停止领取新任务 30 秒，并在状态中心显示原因。**「队列卡住不动且说得出为什么」比「假装在跑」好。**

### 4.2 模型调用的可追溯性

```ts
modelCall?: { startedAt, finishedAt?, uncertain?, candidateId? }
```

- `generate` 任务在发出请求**之前**写 `beginModelCall`。
- 请求返回（无论成功失败）写 `finishModelCall`；失败或拒绝时 `uncertain: true`。
- 崩溃恢复看到 `running` + 未完成的 `modelCall` → `lastErrorKind = 'interrupted_uncertain'`，并在恢复记录里计数。

这解决的是**诚实性**问题：HTTP 请求无法从客户端做到 exactly-once，所以不承诺；但「请求可能发出过」这件事必须写下来，否则重试就是无声的重复调用。

候选本身的唯一性由去重键保证（§4.3），与请求是否重复是两件事。

### 4.3 去重键从会话维度改成监控维度

v0.2.0：`generate:<sessionId>:<postId>`。
问题：同一帖子第二次分析会产生**新的** sessionId，同一条回复就能再拿一个候选。
v0.2.1：`generate:<monitorId>:<postId>`。

同时探测与补偿扫描是「可重复」任务（只查 `activeByKey`），分析与生成是「一次性」任务（查 `activeByKey ?? settledByKey`）。

### 4.4 会话上下文会刷新，候选不会

挂机会话与它的触发帖同寿。如果存下的评论列表停在第一次读取，之后发现的回复在 `runGeneration` 的目标校验里会被判为「不在这次读取到的评论里」——**每一条新回复都不可答**。

`persistAnalysis` 复用会话时现在会替换 `comments / readQuality / threadUrl / threadTitle / updatedAt`，保留 `candidates / persona / 台账行`。候选按自己的 `targetPostId` 索引，刷新上下文不会让它指向别处。

这条是压力测试发现的：120 条回复、119 次生成全部 `generator_declined`，根因就是上下文冻结。

### 4.5 队列维护

| 能力 | 实现 | 约束 |
|---|---|---|
| 容量 | `capacity`（默认 1500，`AI_DEBATE_QUEUE_CAPACITY`） | 满了拒绝新任务，已写盘的不变 |
| 历史保留 | `prune({keepDays, keepTerminal})` | **`needs_review` 永不删除**——它是候选与监控之间唯一的关联 |
| 卡死检测 | `stats().stuck` + `reapStuck(timeout)` | 超时任务置 `failed`，`modelCall.uncertain = true`，释放槽位 |
| 手动重试 | `retry(id)` | 只对 failed/blocked/cancelled；重置 attempts |
| 手动取消 | `cancel(id)` | 终态不可取消 |
| 积压告警 | `stats().backlog` | 三档：ok / warn（最老等待 30 分钟）/ alert（占用 80% 或满） |

## 5. 引擎（`packages/server/src/monitor/engine.ts`）

- **心跳**：`status().heartbeat` 给出 `ticks / intervalMs / lastDurationMs / healthy`。健康判据是「最近一次 tick 不超过 3 个间隔」，不是「进程还活着」。
- **补偿调度**：与轮询分开的慢周期（默认 6 小时，`AI_DEBATE_COMPENSATION_MS`），且**只在建立基线之后**——基线前整帖都是「旧内容」，补偿扫描会与首读重复。
- **状态中心**：`health()` 给内存、数据目录大小、磁盘余量、启动时间；`alerts` 给需要人看的告警（积压、卡死、认证暂停、写入降级、心跳停止）。
- **降级**：写入失败时暂停领取，冷却 30 秒后重试。恢复时写日志，状态中心同步消失该告警。

## 6. 刻意没做的事

| 没做 | 原因 |
|---|---|
| 换 SQLite | 见 §2.3：没有并发写者，迁移核心存储的风险大于收益 |
| 承诺模型调用 exactly-once | 客户端无法保证；改为记录「不确定」，让重试是可审计的 |
| 自动重试发表 | 从未进入后台接口；`DebateProductApi` 里没有 publish 方法 |
| 后台自行批准 | 候选终态是 `needs_review`；批准仍需审批页的一次性操作 |
| 提高轮询频率以「更快发现」 | 服从平台限制：最低 120 秒，且不因积压缩短 |
| 伪造补偿扫描的完整覆盖 | 窗口/页数上限到了就报「未覆盖」，界面显示同一句话 |
