/**
 * The background task ledger.
 *
 * This is a different thing from the maintenance queue in `jobs.ts`, and the
 * separation is deliberate rather than tidy-mindedness:
 *
 *   - The maintenance queue's tasks are *housekeeping* — backup, rotate, audit.
 *     They have no notion of "the answer is waiting for a human", because their
 *     output is a file, not a decision.
 *   - These tasks carry the monitor's pipeline: discover → analyse → generate.
 *     Their terminal state can be `needs_review`, they can be `blocked` by an
 *     expired cookie, and their retry policy depends on what the platform said.
 *
 * Merging them would force one state machine to mean two things, and the first
 * thing to be lost would be "this candidate is waiting for you" — which is the
 * entire point of the feature.
 *
 * ## Persistence rules this file has to get right
 *
 *   1. **A task is written before it runs.** Otherwise a crash mid-task leaves no
 *      record, the work is repeated, and a reply can be analysed twice.
 *   2. **A restart cannot resurrect a finished task.** Terminal states are
 *      terminal; `running` is the only state recovery touches.
 *   3. **The dedupe key is durable.** One monitor, one reply, one analysis —
 *      across restarts, across re-reads, across a crash between enqueue and run.
 *   4. **Memory never runs ahead of disk.** Every mutation builds the next array
 *      and persists it *before* adopting it. A failed write therefore leaves the
 *      ledger exactly as the disk has it, and the caller sees the error.
 *   5. **A model call that may have happened is recorded as uncertain.** Repeating
 *      an HTTP request cannot be made exactly-once from this side, so the ledger
 *      distinguishes "the request was sent and we never saw the answer" from "the
 *      request never left". The former is never silently replayed without a note.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeJson, readJsonWithBackup } from '../atomic.ts'

/**
 * The lifecycle, as the operator sees it.
 *
 * `retry_wait` is separate from `pending` because "waiting for its slot" and
 * "waiting out a rate limit" need different words on screen — one is progress, the
 * other is a platform telling us to slow down.
 */
export type AutoTaskState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'retry_wait'
  | 'needs_review'
  | 'blocked'
  | 'failed'
  | 'cancelled'

/**
 * `compensate` re-reads a window of history — the only task whose purpose is to
 * notice that something *old* changed. Keeping it a first-class kind means it gets
 * the same retry, timeout and audit treatment as the rest instead of running on a
 * side timer nothing observes.
 */
export type AutoTaskKind = 'probe' | 'analyze' | 'generate' | 'compensate'

export interface AutoTaskLog {
  readonly at: string
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
}

/**
 * What is known about the model call a task made.
 *
 * `uncertain` is the important field: it is set when a task was interrupted after
 * the request was dispatched but before the answer was persisted. The next attempt
 * may therefore be a *duplicate* request; the candidate de-duplication in the
 * engine keeps that from producing two candidates, but the ledger must say so.
 */
export interface ModelCallRecord {
  readonly startedAt: string
  finishedAt?: string
  /** The request may have reached the model; the answer is unknown. */
  uncertain?: boolean
  /** Candidate id the call produced, when it produced one. */
  candidateId?: string
}

export interface AutoTask {
  readonly id: string
  readonly kind: AutoTaskKind
  readonly monitorId: string
  /** The reply this task is about, for analyze/generate. */
  readonly postId?: string
  /**
   * All newly discovered replies this analysis covers.
   *
   * One read of the thread covers a whole batch, so charging one read per reply
   * would multiply the platform requests by exactly the number of new comments —
   * the fastest way to get rate limited by a busy thread.
   */
  readonly postIds?: readonly string[]
  sessionId?: string
  /** Stable identity for de-duplication; unique while the task is not terminal. */
  readonly dedupeKey: string
  state: AutoTaskState
  attempts: number
  readonly maxAttempts: number
  readonly createdAt: string
  updatedAt: string
  /** Earliest time the scheduler may pick it up. */
  nextRunAt: string
  startedAt?: string
  finishedAt?: string
  lastError?: string
  /** Machine-readable reason: `rate_limited`, `auth`, `network`, `policy`, … */
  lastErrorKind?: string
  /** How long the platform asked us to wait, when it said. */
  retryAfterMs?: number
  /** Set while a model call is in flight and after it returns. */
  modelCall?: ModelCallRecord
  /** Set when recovery found this task mid-flight. */
  recoveredAt?: string
  logs: AutoTaskLog[]
}

/** What the last startup recovery did, so the console can show it. */
export interface RecoveryRecord {
  readonly at: string
  readonly recovered: number
  readonly uncertain: number
}

interface TaskDocument {
  version: 2
  paused: boolean
  tasks: AutoTask[]
  lastRecovery?: RecoveryRecord
  lastPruneAt?: string
}

export interface EnqueueInput {
  readonly kind: AutoTaskKind
  readonly monitorId: string
  readonly postId?: string
  readonly postIds?: readonly string[]
  sessionId?: string
  readonly dedupeKey: string
  readonly maxAttempts?: number
  readonly delayMs?: number
}

export interface QueueStats {
  readonly capacity: number
  readonly used: number
  readonly byState: Record<AutoTaskState, number>
  /** Seconds the oldest runnable task has been waiting. */
  readonly oldestPendingAgeSec: number
  /** Seconds the longest-running task has been running. */
  readonly longestRunningSec: number
  /** Tasks that look stuck (running past the timeout). */
  readonly stuck: number
  readonly backlog: { readonly level: 'ok' | 'warn' | 'alert'; readonly reason?: string }
}

const DEFAULT_CAPACITY = 1500
const MAX_LOGS = 30
/** Terminal states: never resurrected, never re-run. */
const TERMINAL: ReadonlySet<AutoTaskState> = new Set(['completed', 'failed', 'cancelled', 'needs_review'])

export function isTerminal(state: AutoTaskState): boolean {
  return TERMINAL.has(state)
}

/** Tasks whose completion produced something a human still has to look at. */
function needsReview(task: AutoTask): boolean {
  return task.state === 'needs_review'
}

export interface PruneOptions {
  /** Keep terminal rows younger than this. */
  readonly keepDays?: number
  /** Always keep at least this many terminal rows. */
  readonly keepTerminal?: number
  readonly now?: number
}

export class AutoTaskStore {
  readonly #file: string
  readonly #backup: string
  readonly #log: { warn(message: string): void }
  readonly #capacity: number
  readonly #onEvent: (event: 'corrupt' | 'restored' | 'write_failed' | 'pruned', detail: Record<string, unknown>) => void
  #tasks: AutoTask[] = []
  #paused = false
  #loadError: string | undefined
  #saveError: string | undefined
  #lastRecovery: RecoveryRecord | undefined
  #lastPruneAt: string | undefined

  constructor(options: {
    file: string
    log: { warn(message: string): void }
    capacity?: number
    onEvent?: (event: 'corrupt' | 'restored' | 'write_failed' | 'pruned', detail: Record<string, unknown>) => void
  }) {
    this.#file = options.file
    this.#backup = `${options.file}.bak`
    this.#log = options.log
    this.#capacity = Math.max(50, Math.min(20_000, options.capacity ?? DEFAULT_CAPACITY))
    this.#onEvent = options.onEvent ?? (() => undefined)
  }

  get paused(): boolean {
    return this.#paused
  }

  get capacity(): number {
    return this.#capacity
  }

  get loadError(): string | undefined {
    return this.#loadError
  }

  get saveError(): string | undefined {
    return this.#saveError
  }

  get lastRecovery(): RecoveryRecord | undefined {
    return this.#lastRecovery
  }

  load(): { recovered: number } {
    if (!existsSync(this.#file)) return { recovered: 0 }
    const loaded = readJsonWithBackup<TaskDocument>(this.#file, this.#backup)
    if (loaded.restoredFromBackup) {
      this.#onEvent('restored', { file: this.#file, aside: loaded.aside })
      this.#log.warn(`${this.#file} 无法解析，已从备份恢复；损坏文件保留在 ${loaded.aside ?? '(复制失败)'}`)
    }
    if (loaded.value === undefined) {
      this.#loadError = '任务台账无法解析，且没有可用备份。原文件保留，后台任务未恢复。'
      this.#onEvent('corrupt', { file: this.#file, aside: loaded.aside })
      this.#log.warn(this.#loadError)
      this.#tasks = []
      return { recovered: 0 }
    }
    const document = loaded.value as TaskDocument
    if (!Array.isArray(document.tasks)) {
      this.#loadError = '任务台账结构不认识（tasks 不是数组）。原文件保留。'
      this.#onEvent('corrupt', { file: this.#file })
      this.#tasks = []
      return { recovered: 0 }
    }
    this.#tasks = document.tasks
    this.#paused = document.paused === true
    this.#lastRecovery = document.lastRecovery
    this.#lastPruneAt = document.lastPruneAt
    return { recovered: 0 }
  }

  /**
   * Put interrupted work back on the queue.
   *
   * Only `running` is touched. A task that was mid-flight when the process died is
   * ambiguous — it may have produced a candidate already — so it goes back to
   * `pending` with its attempt count incremented and a note; the handlers are
   * written to be idempotent (an analysis for the same trigger reuses its session,
   * a generation for the same target reuses its candidate).
   *
   * A task whose model call had started but not finished is additionally marked
   * `uncertain`: the candidate de-duplication makes the retry safe for *records*,
   * but the request itself may be sent twice, and pretending otherwise would be a
   * false claim about exactly-once behaviour.
   */
  recoverInterrupted(at = new Date().toISOString()): { recovered: number; uncertain: number } {
    let recovered = 0
    let uncertain = 0
    const next = this.#tasks.map((task) => {
      if (task.state !== 'running') return task
      recovered += 1
      const call = task.modelCall
      const inFlight = call !== undefined && call.finishedAt === undefined
      if (inFlight) uncertain += 1
      return {
        ...task,
        state: 'pending' as AutoTaskState,
        attempts: task.attempts + 1,
        nextRunAt: at,
        updatedAt: at,
        recoveredAt: at,
        lastError: inFlight
          ? '进程在模型调用期间退出：本次请求结果不确定，已重新排队（不会重复生成候选）'
          : '进程在任务执行中退出，已重新排队',
        lastErrorKind: inFlight ? 'interrupted_uncertain' : 'interrupted',
        ...(call === undefined
          ? {}
          : { modelCall: { ...call, ...(inFlight ? { uncertain: true } : {}) } }),
        logs: [...task.logs, {
          at,
          level: 'warn' as const,
          message: inFlight ? '任务因进程退出被恢复；模型调用结果不确定，已标记' : '任务因进程退出被恢复',
        }].slice(-MAX_LOGS),
      }
    })
    if (recovered > 0) {
      const record: RecoveryRecord = { at, recovered, uncertain }
      this.#commit(next, { lastRecovery: record })
      this.#log.warn(`恢复 ${recovered} 个中断任务，其中 ${uncertain} 个模型调用结果不确定`)
    }
    return { recovered, uncertain }
  }

  list(limit = 200): readonly AutoTask[] {
    return this.#tasks.slice(0, Math.max(1, limit))
  }

  all(): readonly AutoTask[] {
    return this.#tasks
  }

  get(id: string): AutoTask | undefined {
    return this.#tasks.find((task) => task.id === id)
  }

  /** A non-terminal task with the same key: the de-duplication fence. */
  activeByKey(key: string): AutoTask | undefined {
    return this.#tasks.find((task) => task.dedupeKey === key && !isTerminal(task.state) && task.state !== 'blocked')
  }

  /** Whether this exact key ever completed or is waiting for review. */
  settledByKey(key: string): AutoTask | undefined {
    return this.#tasks.find((task) => task.dedupeKey === key && (task.state === 'completed' || task.state === 'needs_review'))
  }

  countByState(): Record<AutoTaskState, number> {
    const counts: Record<AutoTaskState, number> = {
      pending: 0,
      running: 0,
      completed: 0,
      retry_wait: 0,
      needs_review: 0,
      blocked: 0,
      failed: 0,
      cancelled: 0,
    }
    for (const task of this.#tasks) counts[task.state] += 1
    return counts
  }

  runningCount(): number {
    return this.#tasks.filter((task) => task.state === 'running').length
  }

  queuedCount(): number {
    return this.#tasks.filter((task) => task.state === 'pending' || task.state === 'retry_wait').length
  }

  /**
   * Queue health, computed from the ledger rather than from counters kept beside
   * it. `stuck` is the count of running tasks older than the timeout — the caller
   * decides whether to reap them, but the console should show them either way.
   */
  stats(now = Date.now(), stuckAfterMs = 10 * 60 * 1000): QueueStats {
    const byState = this.countByState()
    const runnable = this.#tasks.filter((task) => task.state === 'pending' || task.state === 'retry_wait')
    const oldest = runnable.reduce<number>(
      (acc, task) => Math.min(acc, Date.parse(task.nextRunAt)),
      Number.POSITIVE_INFINITY,
    )
    const longest = this.#tasks
      .filter((task) => task.state === 'running' && task.startedAt !== undefined)
      .reduce<number>((acc, task) => Math.max(acc, now - Date.parse(task.startedAt as string)), 0)
    const stuck = this.#tasks.filter(
      (task) => task.state === 'running' && task.startedAt !== undefined && now - Date.parse(task.startedAt) > stuckAfterMs,
    ).length
    const used = this.#tasks.length
    const oldestPendingAgeSec =
      Number.isFinite(oldest) && oldest <= now ? Math.round((now - oldest) / 1000) : 0
    const backlog = this.#backlog(byState, used, oldestPendingAgeSec)
    return {
      capacity: this.#capacity,
      used,
      byState,
      oldestPendingAgeSec,
      longestRunningSec: Math.round(longest / 1000),
      stuck,
      backlog,
    }
  }

  #backlog(byState: Record<AutoTaskState, number>, used: number, oldestAgeSec: number): QueueStats['backlog'] {
    const queued = byState.pending + byState.retry_wait
    if (used >= this.#capacity) {
      return { level: 'alert', reason: `队列已满（${used}/${this.#capacity}），新任务会被拒绝` }
    }
    if (queued >= Math.max(20, Math.floor(this.#capacity * 0.8))) {
      return { level: 'alert', reason: `积压 ${queued} 个待执行任务（容量 ${this.#capacity}）` }
    }
    if (oldestAgeSec >= 1800) {
      return { level: 'warn', reason: `最老的待执行任务已等待 ${Math.round(oldestAgeSec / 60)} 分钟` }
    }
    return { level: 'ok' }
  }

  enqueue(input: EnqueueInput): { task: AutoTask; deduplicated: boolean } {
    // A probe and a compensating scan are *recurring* reads: "this key already
    // completed" must not block the next one. Analyses and generations are
    // once-per-key by design — one reply, one analysis, one candidate — so those
    // consult the settled record.
    const recurring = input.kind === 'probe' || input.kind === 'compensate'
    const existing = recurring
      ? this.activeByKey(input.dedupeKey)
      : (this.activeByKey(input.dedupeKey) ?? this.settledByKey(input.dedupeKey))
    if (existing !== undefined) return { task: existing, deduplicated: true }
    if (this.queuedCount() >= this.#capacity) {
      throw new Error(`后台任务队列已满（${this.#capacity}）。请等待当前任务完成，或清理失败任务。`)
    }
    const now = new Date()
    const task: AutoTask = {
      id: randomUUID(),
      kind: input.kind,
      monitorId: input.monitorId,
      ...(input.postId === undefined ? {} : { postId: input.postId }),
      ...(input.postIds === undefined ? {} : { postIds: [...input.postIds] }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      dedupeKey: input.dedupeKey,
      state: 'pending',
      attempts: 0,
      maxAttempts: Math.max(1, Math.min(6, input.maxAttempts ?? defaultAttempts(input.kind))),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: new Date(now.getTime() + (input.delayMs ?? 0)).toISOString(),
      logs: [],
    }
    this.#commit([task, ...this.#tasks])
    return { task, deduplicated: false }
  }

  /** Claim one due task, respecting the concurrency caps. */
  claim(now = Date.now()): AutoTask | undefined {
    if (this.#paused) return undefined
    const candidate = this.#tasks
      .filter((entry) => (entry.state === 'pending' || entry.state === 'retry_wait') && Date.parse(entry.nextRunAt) <= now)
      .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))[0]
    if (candidate === undefined) return undefined
    const startedAt = new Date(now).toISOString()
    const claimed: AutoTask = {
      ...candidate,
      state: 'running',
      attempts: candidate.attempts + 1,
      startedAt,
      updatedAt: startedAt,
      // A fresh execution: any previous uncertainty belongs to the previous
      // attempt and stays in the log, not on the new call record.
      modelCall: undefined,
    }
    this.#commit(this.#replace(claimed))
    return claimed
  }

  /**
   * Put a claimed task back without consuming an attempt.
   *
   * Used when a task was claimed but its platform is already at the concurrency
   * cap: waiting for a slot is not a failure, and charging a retry for it would
   * make a busy platform look like a broken one.
   */
  release(id: string): void {
    const task = this.get(id)
    if (task === undefined || task.state !== 'running') return
    this.#commit(
      this.#replace({
        ...task,
        state: 'pending',
        attempts: Math.max(0, task.attempts - 1),
        nextRunAt: new Date(Date.now() + 500).toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    )
  }

  /** Record that a model call is about to be sent. */
  beginModelCall(id: string, at = new Date().toISOString()): void {
    const task = this.get(id)
    if (task === undefined) return
    this.#commit(this.#replace({ ...task, modelCall: { startedAt: at }, updatedAt: at }))
  }

  /** Record the model call's outcome. `uncertain` when the answer was not used. */
  finishModelCall(id: string, detail: { candidateId?: string; uncertain?: boolean; at?: string } = {}): void {
    const task = this.get(id)
    if (task === undefined) return
    const at = detail.at ?? new Date().toISOString()
    const call = task.modelCall ?? { startedAt: at }
    this.#commit(
      this.#replace({
        ...task,
        modelCall: {
          ...call,
          finishedAt: at,
          ...(detail.candidateId === undefined ? {} : { candidateId: detail.candidateId }),
          ...(detail.uncertain === true ? { uncertain: true } : {}),
        },
        updatedAt: at,
      }),
    )
  }

  note(id: string, level: AutoTaskLog['level'], message: string): void {
    const task = this.get(id)
    if (task === undefined) return
    const at = new Date().toISOString()
    this.#commit(
      this.#replace({
        ...task,
        logs: [...task.logs, { at, level, message }].slice(-MAX_LOGS),
        updatedAt: at,
      }),
    )
  }

  finish(
    id: string,
    state: AutoTaskState,
    detail: { error?: string; errorKind?: string; sessionId?: string } = {},
  ): void {
    const task = this.get(id)
    if (task === undefined) return
    const now = new Date().toISOString()
    const terminal = state !== 'pending' && state !== 'retry_wait' && state !== 'running'
    this.#commit(
      this.#replace({
        ...task,
        state,
        updatedAt: now,
        ...(terminal ? { finishedAt: now } : {}),
        ...(detail.error === undefined ? {} : { lastError: detail.error }),
        ...(detail.errorKind === undefined ? {} : { lastErrorKind: detail.errorKind }),
        ...(detail.sessionId === undefined ? {} : { sessionId: detail.sessionId }),
      }),
    )
  }

  /** Schedule a retry with an explicit delay (the platform asked for it). */
  retryLater(id: string, delayMs: number, detail: { error: string; errorKind: string }): void {
    const task = this.get(id)
    if (task === undefined) return
    const now = Date.now()
    const at = new Date(now).toISOString()
    this.#commit(
      this.#replace({
        ...task,
        state: 'retry_wait',
        nextRunAt: new Date(now + Math.max(1000, delayMs)).toISOString(),
        retryAfterMs: Math.max(1000, delayMs),
        lastError: detail.error,
        lastErrorKind: detail.errorKind,
        updatedAt: at,
        logs: [...task.logs, {
          at,
          level: 'warn' as const,
          message: `将在 ${Math.round(delayMs / 1000)} 秒后重试：${detail.error}`,
        }].slice(-MAX_LOGS),
      }),
    )
  }

  cancel(id: string): boolean {
    const task = this.get(id)
    if (task === undefined || isTerminal(task.state)) return false
    const at = new Date().toISOString()
    this.#commit(this.#replace({ ...task, state: 'cancelled', finishedAt: at, updatedAt: at }))
    return true
  }

  /**
   * Put a failed, blocked or cancelled task back in the queue by hand.
   *
   * Attempts are reset because a manual retry usually follows an operator fixing
   * the cause (a new cookie, a corrected URL); carrying the old count would make
   * the next transient error fail immediately.
   */
  retry(id: string, at = new Date().toISOString()): boolean {
    const task = this.get(id)
    if (task === undefined) return false
    if (task.state !== 'failed' && task.state !== 'blocked' && task.state !== 'cancelled') return false
    this.#commit(
      this.#replace({
        ...task,
        state: 'pending',
        attempts: 0,
        nextRunAt: at,
        updatedAt: at,
        finishedAt: undefined,
        lastError: undefined,
        lastErrorKind: undefined,
        retryAfterMs: undefined,
        logs: [...task.logs, { at, level: 'info' as const, message: '操作员手动重试' }].slice(-MAX_LOGS),
      }),
    )
    return true
  }

  /**
   * Fail tasks that have been `running` longer than the timeout.
   *
   * A hung platform read is indistinguishable from a slow one until the timeout
   * passes; after that it is not "in progress", it is a stuck slot that would
   * otherwise consume the concurrency budget forever. The task is marked failed
   * with a distinct reason so the operator can retry it deliberately.
   */
  reapStuck(now = Date.now(), timeoutMs = 10 * 60 * 1000): readonly string[] {
    const stuck = this.#tasks.filter(
      (task) =>
        task.state === 'running' && task.startedAt !== undefined && now - Date.parse(task.startedAt) > timeoutMs,
    )
    if (stuck.length === 0) return []
    const at = new Date(now).toISOString()
    const ids = new Set(stuck.map((task) => task.id))
    const next = this.#tasks.map((task) =>
      ids.has(task.id)
        ? {
            ...task,
            state: 'failed' as AutoTaskState,
            finishedAt: at,
            updatedAt: at,
            lastError: `任务超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已判定为卡死`,
            lastErrorKind: 'stuck',
            modelCall: task.modelCall === undefined ? undefined : { ...task.modelCall, uncertain: true },
            logs: [...task.logs, { at, level: 'error' as const, message: '超时，判定为卡死' }].slice(-MAX_LOGS),
          }
        : task,
    )
    this.#commit(next)
    return [...ids]
  }

  /**
   * Trim history without touching anything a human still has to act on.
   *
   * `needs_review` rows are never removed: they are the link between a candidate
   * in the store and the monitor that produced it. Deleting one would leave a
   * pending candidate whose provenance the console can no longer show.
   */
  prune(options: PruneOptions = {}): { removed: number; keptForReview: number } {
    const now = options.now ?? Date.now()
    const keepDays = options.keepDays ?? 7
    const keepTerminal = options.keepTerminal ?? 300
    const cutoff = now - keepDays * 24 * 60 * 60 * 1000

    const terminal = this.#tasks
      .filter((task) => isTerminal(task.state))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    const protectedIds = new Set(terminal.filter(needsReview).map((task) => task.id))
    const survivors = new Set<string>()
    let kept = 0
    for (const task of terminal) {
      if (protectedIds.has(task.id)) continue
      if (kept < keepTerminal || Date.parse(task.updatedAt) >= cutoff) {
        survivors.add(task.id)
        kept += 1
      }
    }
    const next = this.#tasks.filter((task) => !isTerminal(task.state) || protectedIds.has(task.id) || survivors.has(task.id))
    const removed = this.#tasks.length - next.length
    if (removed > 0) {
      const at = new Date(now).toISOString()
      this.#commit(next, { lastPruneAt: at })
      this.#onEvent('pruned', { removed, keptForReview: protectedIds.size })
    }
    return { removed, keptForReview: protectedIds.size }
  }

  pauseQueue(): void {
    this.#commit(this.#tasks, { paused: true })
  }

  resumeQueue(): void {
    this.#commit(this.#tasks, { paused: false })
  }

  #replace(next: AutoTask): AutoTask[] {
    return this.#tasks.map((task) => (task.id === next.id ? next : task))
  }

  /**
   * Persist first, adopt second.
   *
   * A mutation that only reached memory would be invisible after a restart — the
   * worst possible outcome for a ledger whose job is "this is what happened".
   */
  #commit(
    next: AutoTask[],
    extra: { paused?: boolean; lastRecovery?: RecoveryRecord; lastPruneAt?: string } = {},
  ): void {
    const recovery = extra.lastRecovery ?? this.#lastRecovery
    const prunedAt = extra.lastPruneAt ?? this.#lastPruneAt
    const document: TaskDocument = {
      version: 2,
      paused: extra.paused ?? this.#paused,
      tasks: next,
      ...(recovery === undefined ? {} : { lastRecovery: recovery }),
      ...(prunedAt === undefined ? {} : { lastPruneAt: prunedAt }),
    }
    try {
      writeJson(this.#file, document, { mode: 0o600, backup: this.#backup })
    } catch (error) {
      this.#saveError = error instanceof Error ? error.message : String(error)
      this.#onEvent('write_failed', { file: this.#file, reason: this.#saveError })
      throw error
    }
    this.#tasks = next
    if (extra.paused !== undefined) this.#paused = extra.paused
    if (extra.lastRecovery !== undefined) this.#lastRecovery = extra.lastRecovery
    if (extra.lastPruneAt !== undefined) this.#lastPruneAt = extra.lastPruneAt
    this.#saveError = undefined
  }
}

function defaultAttempts(kind: AutoTaskKind): number {
  // A probe, a compensating scan and an analysis are safe to repeat: the reads are
  // reads, and the analysis reuses its session for the same trigger. A generation
  // is too, because the handler checks for an existing candidate first — but it is
  // capped lower because each attempt costs a model call.
  if (kind === 'probe') return 4
  if (kind === 'compensate') return 3
  if (kind === 'analyze') return 3
  return 2
}
