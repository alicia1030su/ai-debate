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
 * Persistence rules this file has to get right:
 *
 *   1. **A task is written before it runs.** Otherwise a crash mid-task leaves no
 *      record, the work is repeated, and a reply can be analysed twice.
 *   2. **A restart cannot resurrect a finished task.** Terminal states are
 *      terminal; `running` is the only state recovery touches.
 *   3. **The dedupe key is durable.** One monitor, one reply, one analysis —
 *      across restarts, across re-reads, across a crash between enqueue and run.
 */
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { writeJson } from '../atomic.ts'

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

export type AutoTaskKind = 'probe' | 'analyze' | 'generate'

export interface AutoTaskLog {
  readonly at: string
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
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
  logs: AutoTaskLog[]
}

interface TaskDocument {
  version: 1
  paused: boolean
  tasks: AutoTask[]
}

export interface EnqueueInput {
  readonly kind: AutoTaskKind
  readonly monitorId: string
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
  readonly dedupeKey: string
  readonly maxAttempts?: number
  readonly delayMs?: number
}

const MAX_TASKS = 1500
const MAX_LOGS = 30
/** Terminal states: never resurrected, never re-run. */
const TERMINAL: ReadonlySet<AutoTaskState> = new Set(['completed', 'failed', 'cancelled', 'needs_review'])

export function isTerminal(state: AutoTaskState): boolean {
  return TERMINAL.has(state)
}

export class AutoTaskStore {
  readonly #file: string
  readonly #log: { warn(message: string): void }
  #tasks: AutoTask[] = []
  #paused = false
  #loadError: string | undefined

  constructor(options: { file: string; log: { warn(message: string): void } }) {
    this.#file = options.file
    this.#log = options.log
  }

  get paused(): boolean {
    return this.#paused
  }

  get loadError(): string | undefined {
    return this.#loadError
  }

  load(): { recovered: number } {
    if (!existsSync(this.#file)) return { recovered: 0 }
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf8')) as TaskDocument
      if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) throw new Error('结构不认识')
      this.#tasks = parsed.tasks
      this.#paused = parsed.paused === true
    } catch (error) {
      this.#loadError = `任务台账无法解析：${error instanceof Error ? error.message : String(error)}`
      this.#log.warn(`${this.#loadError}。原文件保留，后台任务未恢复。`)
      this.#tasks = []
      return { recovered: 0 }
    }
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
   */
  recoverInterrupted(at = new Date().toISOString()): number {
    let recovered = 0
    for (const task of this.#tasks) {
      if (task.state !== 'running') continue
      recovered += 1
      task.state = 'pending'
      task.attempts += 1
      task.nextRunAt = at
      task.updatedAt = at
      task.lastError = '进程在任务执行中退出，已重新排队'
      task.lastErrorKind = 'interrupted'
      task.logs.push({ at, level: 'warn', message: '任务因进程退出被恢复' })
      if (task.logs.length > MAX_LOGS) task.logs.splice(0, task.logs.length - MAX_LOGS)
    }
    if (recovered > 0) this.#persist()
    return recovered
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

  enqueue(input: EnqueueInput): { task: AutoTask; deduplicated: boolean } {
    // A probe is a *recurring* read: "this key already completed" must not block
    // the next poll. Analyses and generations are once-per-key by design — one
    // reply, one analysis, one candidate — so those consult the settled record.
    const existing =
      input.kind === 'probe'
        ? this.activeByKey(input.dedupeKey)
        : (this.activeByKey(input.dedupeKey) ?? this.settledByKey(input.dedupeKey))
    if (existing !== undefined) return { task: existing, deduplicated: true }
    if (this.queuedCount() >= MAX_TASKS) {
      throw new Error(`后台任务队列已满（${MAX_TASKS}）。请等待当前任务完成，或清理失败任务。`)
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
    this.#tasks = [task, ...this.#tasks]
    this.#trim()
    this.#persist()
    return { task, deduplicated: false }
  }

  /** Claim one due task, respecting the concurrency caps. */
  claim(now = Date.now()): AutoTask | undefined {
    if (this.#paused) return undefined
    const task = this.#tasks
      .filter((entry) => (entry.state === 'pending' || entry.state === 'retry_wait') && Date.parse(entry.nextRunAt) <= now)
      .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))[0]
    if (task === undefined) return undefined
    task.state = 'running'
    task.attempts += 1
    task.startedAt = new Date(now).toISOString()
    task.updatedAt = task.startedAt
    this.#persist()
    return task
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
    task.state = 'pending'
    task.attempts = Math.max(0, task.attempts - 1)
    task.nextRunAt = new Date(Date.now() + 500).toISOString()
    task.updatedAt = new Date().toISOString()
    this.#persist()
  }

  note(id: string, level: AutoTaskLog['level'], message: string): void {
    const task = this.get(id)
    if (task === undefined) return
    task.logs.push({ at: new Date().toISOString(), level, message })
    if (task.logs.length > MAX_LOGS) task.logs.splice(0, task.logs.length - MAX_LOGS)
    task.updatedAt = new Date().toISOString()
    this.#persist()
  }

  finish(
    id: string,
    state: AutoTaskState,
    detail: { error?: string; errorKind?: string; sessionId?: string } = {},
  ): void {
    const task = this.get(id)
    if (task === undefined) return
    const now = new Date().toISOString()
    task.state = state
    task.updatedAt = now
    if (state !== 'pending' && state !== 'retry_wait' && state !== 'running') task.finishedAt = now
    if (detail.error !== undefined) task.lastError = detail.error
    if (detail.errorKind !== undefined) task.lastErrorKind = detail.errorKind
    if (detail.sessionId !== undefined) task.sessionId = detail.sessionId
    this.#persist()
  }

  /** Schedule a retry with an explicit delay (the platform asked for it). */
  retryLater(id: string, delayMs: number, detail: { error: string; errorKind: string }): void {
    const task = this.get(id)
    if (task === undefined) return
    const now = Date.now()
    task.state = 'retry_wait'
    task.nextRunAt = new Date(now + Math.max(1000, delayMs)).toISOString()
    task.retryAfterMs = Math.max(1000, delayMs)
    task.lastError = detail.error
    task.lastErrorKind = detail.errorKind
    task.updatedAt = new Date(now).toISOString()
    task.logs.push({
      at: task.updatedAt,
      level: 'warn',
      message: `将在 ${Math.round(delayMs / 1000)} 秒后重试：${detail.error}`,
    })
    if (task.logs.length > MAX_LOGS) task.logs.splice(0, task.logs.length - MAX_LOGS)
    this.#persist()
  }

  cancel(id: string): boolean {
    const task = this.get(id)
    if (task === undefined || isTerminal(task.state)) return false
    task.state = 'cancelled'
    task.finishedAt = new Date().toISOString()
    task.updatedAt = task.finishedAt
    this.#persist()
    return true
  }

  pauseQueue(): void {
    this.#paused = true
    this.#persist()
  }

  resumeQueue(): void {
    this.#paused = false
    this.#persist()
  }

  /** Drop the oldest terminal rows once the ledger grows past its cap. */
  #trim(): void {
    if (this.#tasks.length <= MAX_TASKS) return
    const terminal = this.#tasks.filter((task) => isTerminal(task.state))
    const excess = this.#tasks.length - MAX_TASKS
    const drop = new Set(terminal.slice(-excess).map((task) => task.id))
    this.#tasks = this.#tasks.filter((task) => !drop.has(task.id))
  }

  #persist(): void {
    writeJson(this.#file, { version: 1, paused: this.#paused, tasks: this.#tasks } satisfies TaskDocument, { mode: 0o600 })
  }
}

function defaultAttempts(kind: AutoTaskKind): number {
  // A probe and an analysis are safe to repeat: the probe is a read, and the
  // analysis reuses its session for the same trigger. A generation is too, because
  // the handler checks for an existing candidate first — but it is capped lower
  // because each attempt costs a model call.
  if (kind === 'probe') return 4
  if (kind === 'analyze') return 3
  return 2
}
