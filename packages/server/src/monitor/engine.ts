/**
 * The background engine: schedule, execute, retry, stop.
 *
 * ## What it is
 *
 * A single-threaded loop with four responsibilities, deliberately kept apart from
 * the HTTP server so that closing a browser has no effect on it:
 *
 *   1. **Schedule** — every tick, ask each enabled monitor whether it is due, and
 *      enqueue a probe if so. Due-ness is computed from `lastCheckAt` and
 *      `intervalSec`, never from a wall-clock timer per monitor: timers do not
 *      survive a restart, and a monitor list that changes while the process runs
 *      would need one timer per edit.
 *   2. **Compensate** — on a much slower cadence, re-read a window of history so an
 *      edited or deleted reply is noticed. A tail read cannot see that by
 *      construction, and "we only look at the end" is not a defensible answer for
 *      a product that claims to monitor a discussion.
 *   3. **Execute** — claim one due task at a time (bounded by a global and a
 *      per-platform cap), run it, record the outcome.
 *   4. **Back off** — when the platform says "slow down", wait exactly as long as
 *      it asked; when it says "your cookie is gone", stop that monitor and say so.
 *
 * ## What it deliberately is not
 *
 * - **It cannot publish.** `DebateProductApi` has no publish method; the engine
 *   has no adapter. A background candidate ends at `needs_review`, and the only
 *   way past that is a human clicking approve in the console.
 * - **It never retries a permanent failure.** A 403 on the credentials is not a
 *   network blip; retrying it deepens a block and hides the real problem.
 * - **It does not invent statistics.** Every number in `status()` is read from the
 *   task ledger and the monitor store; there is no running total kept in memory
 *   that a restart would reset to zero while the UI still showed it.
 * - **It does not keep working on a broken ledger.** If the task file cannot be
 *   written, claiming more work would risk repeating it after a restart, so the
 *   engine degrades: it stops claiming and says why.
 */
import type { DebateProductApi } from '../../../core/src/product-api.ts'
import type { Logger } from '../logger.ts'
import { AtomicWriteError } from '../atomic.ts'
import type { MonitorStore, MonitorTarget } from './store.ts'
import { type AutoTask, type AutoTaskStore, type QueueStats, type RecoveryRecord } from './tasks.ts'

export interface EngineOptions {
  readonly monitors: MonitorStore
  readonly tasks: AutoTaskStore
  readonly api: () => DebateProductApi | undefined
  readonly log: Logger
  /** Global cap on concurrently running tasks. */
  readonly concurrency?: number
  /** Per-platform cap, so one broken platform cannot starve the others. */
  readonly perPlatformConcurrency?: number
  /** How often the loop wakes up. */
  readonly tickMs?: number
  /** A task running longer than this is treated as stuck. */
  readonly taskTimeoutMs?: number
  /** Minimum gap between compensating scans of one monitor. */
  readonly compensationEveryMs?: number
  /** Injected clock, for tests. */
  readonly now?: () => number
}

export interface EngineStatus {
  readonly paused: boolean
  readonly running: boolean
  readonly concurrency: number
  readonly perPlatform: number
  readonly monitors: {
    readonly total: number
    readonly enabled: number
    readonly blocked: number
  }
  readonly tasks: Record<string, number>
  readonly today: {
    readonly discovered: number
    readonly candidates: number
    readonly failures: number
  }
  readonly queued: number
  readonly runningTasks: number
  readonly lastTickAt?: string
  readonly lastError?: string
  /** Liveness: a tick that has not happened for three intervals is not healthy. */
  readonly heartbeat: {
    readonly ticks: number
    readonly intervalMs: number
    readonly lastDurationMs?: number
    readonly healthy: boolean
    readonly lastSuccessProbeAt?: string
  }
  readonly queue: QueueStats
  readonly recovery?: RecoveryRecord
  /** Set when the ledger cannot be written; the engine stops claiming work. */
  readonly degraded?: string
  readonly alerts: readonly { readonly level: 'warn' | 'alert'; readonly reason: string }[]
}

const MAX_BACKOFF_MS = 30 * 60 * 1000
const BASE_BACKOFF_MS = 15 * 1000
/** A compensating scan is a background chore, not a poll: six hours is plenty. */
const DEFAULT_COMPENSATION_EVERY_MS = 6 * 60 * 60 * 1000
/** How long a failed ledger write suspends claiming, before it retries. */
const DEGRADED_COOLDOWN_MS = 30 * 1000

/** Classify a thrown error into "retry", "block the monitor" or "give up". */
export function classifyFailure(error: unknown): {
  kind: string
  retryable: boolean
  blocksMonitor: boolean
  message: string
  retryAfterMs?: number
} {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown }).code
  const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs
  const status = (error as { status?: unknown }).status

  if (typeof code === 'string') {
    // Platform-level codes (PlatformError) and model-level codes (LlmError) share
    // a few names; both are handled here because the reaction is the same.
    if (code === 'rate_limited') {
      return {
        kind: 'rate_limited',
        retryable: true,
        blocksMonitor: false,
        message,
        ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
      }
    }
    if (code === 'auth_required' || code === 'unauthorized' || code === 'forbidden' || code === 'permission_denied' || code === 'captcha') {
      return { kind: 'auth', retryable: false, blocksMonitor: true, message }
    }
    if (code === 'network' || code === 'timeout' || code === 'dns') {
      return { kind: 'network', retryable: true, blocksMonitor: false, message }
    }
    if (code === 'quota') {
      return { kind: 'quota', retryable: false, blocksMonitor: false, message }
    }
    if (code === 'not_found' || code === 'malformed_response' || code === 'bad_response') {
      return { kind: 'permanent', retryable: false, blocksMonitor: false, message }
    }
    if (code === 'context_too_long') {
      return { kind: 'policy', retryable: false, blocksMonitor: false, message }
    }
  }

  if (typeof status === 'number') {
    if (status === 429) return { kind: 'rate_limited', retryable: true, blocksMonitor: false, message }
    if (status === 401 || status === 403) return { kind: 'auth', retryable: false, blocksMonitor: true, message }
    if (status >= 500) return { kind: 'network', retryable: true, blocksMonitor: false, message }
  }

  // The core's owner-binding refusal is an operator action, not a transient fault.
  if (/还没有绑定主人|请先.*绑定主人/.test(message)) {
    return { kind: 'owner_unbound', retryable: false, blocksMonitor: true, message }
  }
  // Session capacity is an operator action too: finish or cancel something.
  if (/会话容量|capacity|maxSessions/i.test(message)) {
    return { kind: 'capacity', retryable: true, blocksMonitor: false, message }
  }
  // A safety refusal is a decision, not a failure to retry.
  if (/安全|违规|注入|不允许/.test(message) && /拒绝|不能/.test(message)) {
    return { kind: 'policy', retryable: false, blocksMonitor: false, message }
  }
  return { kind: 'unknown', retryable: true, blocksMonitor: false, message }
}

function backoffFor(attempts: number, kind: string): number {
  const base = kind === 'network' ? BASE_BACKOFF_MS : BASE_BACKOFF_MS * 2
  const exponential = Math.min(MAX_BACKOFF_MS, base * 2 ** Math.max(0, attempts - 1))
  // Jitter: half to full, so a fleet of monitors recovering from the same outage
  // does not hit the platform in one burst.
  return Math.round(exponential * (0.5 + Math.random() * 0.5))
}

/** The platform whose task is running, for the per-platform cap. */
function platformOf(monitors: MonitorStore, task: AutoTask): string {
  return monitors.get(task.monitorId)?.platform ?? 'unknown'
}

export class AutomationEngine {
  readonly #monitors: MonitorStore
  readonly #tasks: AutoTaskStore
  readonly #api: () => DebateProductApi | undefined
  readonly #log: Logger
  readonly #concurrency: number
  readonly #perPlatform: number
  readonly #tickMs: number
  readonly #taskTimeoutMs: number
  readonly #compensationEveryMs: number
  readonly #now: () => number
  #timer: NodeJS.Timeout | undefined
  #running = false
  #lastTickAt: string | undefined
  #lastError: string | undefined
  #inFlight = new Map<string, string>() // taskId → platform
  #scheduled = new Set<string>() // monitor ids with a probe already queued
  #compensating = new Set<string>()
  #ticking = false
  #ticks = 0
  #lastDurationMs: number | undefined
  #lastSuccessProbeAt: string | undefined
  #degraded: string | undefined
  #degradedUntil = 0

  constructor(options: EngineOptions) {
    this.#monitors = options.monitors
    this.#tasks = options.tasks
    this.#api = options.api
    this.#log = options.log
    this.#concurrency = Math.max(1, Math.min(4, options.concurrency ?? 1))
    this.#perPlatform = Math.max(1, Math.min(4, options.perPlatformConcurrency ?? 1))
    this.#tickMs = Math.max(250, options.tickMs ?? 2000)
    this.#taskTimeoutMs = Math.max(30_000, options.taskTimeoutMs ?? 10 * 60 * 1000)
    this.#compensationEveryMs = Math.max(60_000, options.compensationEveryMs ?? DEFAULT_COMPENSATION_EVERY_MS)
    this.#now = options.now ?? (() => Date.now())
  }

  start(): void {
    if (this.#timer !== undefined) return
    this.#running = true
    this.#timer = setInterval(() => void this.#tick(), this.#tickMs)
    this.#timer.unref?.()
    this.#log.info(`后台挂机引擎已启动：并发 ${this.#concurrency}，每平台 ${this.#perPlatform}，心跳 ${this.#tickMs}ms`)
    void this.#tick()
  }

  async stop(): Promise<void> {
    this.#running = false
    if (this.#timer !== undefined) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
    const deadline = this.#now() + 4000
    while (this.#inFlight.size > 0 && this.#now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  get running(): boolean {
    return this.#running
  }

  /** Enqueue one check for a monitor, ignoring its interval. */
  checkNow(monitorId: string): { ok: boolean; message?: string } {
    const monitor = this.#monitors.get(monitorId)
    if (monitor === undefined) return { ok: false, message: '监控目标不存在。' }
    const { deduplicated } = this.#tasks.enqueue({
      kind: 'probe',
      monitorId: monitor.id,
      dedupeKey: `probe:${monitor.id}`,
    })
    return { ok: true, ...(deduplicated ? { message: '已有检查在排队，本次未重复创建。' } : {}) }
  }

  /** Enqueue a compensating scan, or a full re-read, on demand. */
  scanNow(monitorId: string, mode: 'compensate' | 'full' = 'compensate'): { ok: boolean; message?: string } {
    const monitor = this.#monitors.get(monitorId)
    if (monitor === undefined) return { ok: false, message: '监控目标不存在。' }
    const { deduplicated } = this.#tasks.enqueue({
      kind: 'compensate',
      monitorId: monitor.id,
      dedupeKey: `compensate:${monitor.id}:${mode}`,
      ...(mode === 'full' ? { postId: 'full' } : {}),
    })
    return { ok: true, ...(deduplicated ? { message: '已有补偿检查在排队。' } : {}) }
  }

  pause(): void {
    this.#tasks.pauseQueue()
    this.#log.info('后台挂机已暂停：不再领取新任务')
  }

  resume(): void {
    this.#tasks.resumeQueue()
    this.#log.info('后台挂机已恢复')
  }

  /**
   * Everything the console shows, computed on demand.
   *
   * No counters are cached: a number that survives a restart in the UI but not in
   * the ledger is a lie, and this project has already shipped one of those.
   */
  status(): EngineStatus {
    const monitors = this.#monitors.list()
    const counts = this.#tasks.countByState()
    let discovered = 0
    let candidates = 0
    let failures = 0
    for (const monitor of monitors) {
      discovered += monitor.counters.todayDiscovered
      candidates += monitor.counters.todayCandidates
      failures += monitor.counters.todayFailures
    }
    const queue = this.#tasks.stats(this.#now(), this.#taskTimeoutMs)
    const lastTick = this.#lastTickAt === undefined ? Number.NaN : Date.parse(this.#lastTickAt)
    const heartbeatHealthy =
      this.#running && (this.#lastTickAt === undefined || this.#now() - lastTick <= this.#tickMs * 3)
    const recovery = this.#tasks.lastRecovery
    const alerts: { level: 'warn' | 'alert'; reason: string }[] = []
    if (queue.backlog.level !== 'ok' && queue.backlog.reason !== undefined) {
      alerts.push({ level: queue.backlog.level, reason: queue.backlog.reason })
    }
    if (queue.stuck > 0) {
      alerts.push({ level: 'warn', reason: `${queue.stuck} 个任务运行超过 ${Math.round(this.#taskTimeoutMs / 60000)} 分钟` })
    }
    if (this.#degraded !== undefined) {
      alerts.push({ level: 'alert', reason: this.#degraded })
    }
    if (!heartbeatHealthy && this.#running) {
      alerts.push({ level: 'alert', reason: '调度心跳已停止' })
    }
    const blocked = monitors.filter((monitor) => monitor.blockedReason !== undefined)
    if (blocked.length > 0) {
      alerts.push({ level: 'warn', reason: `${blocked.length} 个监控因认证问题暂停` })
    }
    return {
      paused: this.#tasks.paused,
      running: this.#running,
      concurrency: this.#concurrency,
      perPlatform: this.#perPlatform,
      monitors: {
        total: monitors.length,
        enabled: monitors.filter((monitor) => monitor.enabled).length,
        blocked: blocked.length,
      },
      tasks: counts as unknown as Record<string, number>,
      today: { discovered, candidates, failures },
      queued: this.#tasks.queuedCount(),
      runningTasks: this.#tasks.runningCount(),
      ...(this.#lastTickAt === undefined ? {} : { lastTickAt: this.#lastTickAt }),
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
      heartbeat: {
        ticks: this.#ticks,
        intervalMs: this.#tickMs,
        ...(this.#lastDurationMs === undefined ? {} : { lastDurationMs: this.#lastDurationMs }),
        healthy: heartbeatHealthy,
        ...(this.#lastSuccessProbeAt === undefined ? {} : { lastSuccessProbeAt: this.#lastSuccessProbeAt }),
      },
      queue,
      ...(recovery === undefined ? {} : { recovery }),
      ...(this.#degraded === undefined ? {} : { degraded: this.#degraded }),
      alerts,
    }
  }

  /**
   * Wait until nothing is queued or running.
   *
   * Public because the acceptance test drives real ticks and needs a
   * deterministic "it is done" — polling the JSON files would race the writes.
   */
  async waitIdle(timeoutMs = 60_000): Promise<boolean> {
    const deadline = this.#now() + timeoutMs
    while (this.#now() < deadline) {
      if (this.#tasks.queuedCount() === 0 && this.#tasks.runningCount() === 0 && this.#inFlight.size === 0) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
      await this.#tick()
    }
    return false
  }

  /** One scheduling + execution pass. Public so tests can drive it deterministically. */
  async tick(): Promise<void> {
    await this.#tick()
  }

  async #tick(): Promise<void> {
    if (!this.#running || this.#ticking) return
    this.#ticking = true
    const startedAt = this.#now()
    try {
      this.#lastTickAt = new Date(startedAt).toISOString()
      this.#ticks += 1
      // A hung task holds a concurrency slot forever. Reaping is part of the tick,
      // not a separate timer, so it cannot be forgotten when the loop changes.
      const reaped = this.#tasks.reapStuck(startedAt, this.#taskTimeoutMs)
      if (reaped.length > 0) this.#log.warn(`${reaped.length} 个任务超时，已判定为卡死并释放槽位`)
      this.#scheduleDue()
      await this.#drain()
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error)
      this.#log.warn(`后台调度出错：${this.#lastError}`)
      if (error instanceof AtomicWriteError) {
        // The ledger could not be written. Claiming more work would risk repeating
        // it after a restart, so stop claiming until the disk recovers.
        this.#degraded = `任务台账写入失败：${error.message}`
        this.#degradedUntil = this.#now() + DEGRADED_COOLDOWN_MS
      }
    } finally {
      this.#lastDurationMs = this.#now() - startedAt
      this.#ticking = false
    }
  }

  /** Enqueue a probe or a compensating scan for every monitor that is due. */
  #scheduleDue(): void {
    if (this.#tasks.paused) return
    if (this.#degraded !== undefined && this.#now() < this.#degradedUntil) return
    if (this.#degraded !== undefined) {
      // The cooldown passed: try again with a real write rather than assuming.
      this.#degraded = undefined
      this.#log.info('任务台账写入恢复，继续调度')
    }
    const now = this.#now()
    for (const monitor of this.#monitors.list()) {
      if (!monitor.enabled || monitor.blockedReason !== undefined) continue
      if (!this.#scheduled.has(monitor.id)) {
        const last = monitor.lastCheckAt === undefined ? 0 : Date.parse(monitor.lastCheckAt)
        if (!Number.isNaN(last) && now - last >= monitor.intervalSec * 1000) {
          // Never stack probes for one monitor: one check at a time is what keeps
          // the cursor honest, and two concurrent reads would both see the same
          // new reply.
          if (this.#tasks.activeByKey(`probe:${monitor.id}`) === undefined) {
            this.#enqueue({ kind: 'probe', monitorId: monitor.id, dedupeKey: `probe:${monitor.id}` })
            this.#scheduled.add(monitor.id)
          }
        }
      }
      if (
        monitor.compensationHours > 0 &&
        monitor.baselineAt !== undefined &&
        !this.#compensating.has(monitor.id)
      ) {
        const last = monitor.lastCompensationAt === undefined ? 0 : Date.parse(monitor.lastCompensationAt)
        if (!Number.isNaN(last) && now - last >= this.#compensationEveryMs) {
          if (this.#tasks.activeByKey(`compensate:${monitor.id}:compensate`) === undefined) {
            this.#enqueue({
              kind: 'compensate',
              monitorId: monitor.id,
              dedupeKey: `compensate:${monitor.id}:compensate`,
            })
            this.#compensating.add(monitor.id)
          }
        }
      }
    }
  }

  /** Enqueue without letting a full queue break the whole tick. */
  #enqueue(input: Parameters<AutoTaskStore['enqueue']>[0]): void {
    try {
      this.#tasks.enqueue(input)
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error)
      this.#log.warn(`无法排队任务（${input.kind}/${input.monitorId}）：${this.#lastError}`)
    }
  }

  async #drain(): Promise<void> {
    while (this.#running) {
      if (this.#inFlight.size >= this.#concurrency) return
      const task = this.#tasks.claim(this.#now())
      if (task === undefined) return
      const platform = platformOf(this.#monitors, task)
      const samePlatform = [...this.#inFlight.values()].filter((value) => value === platform).length
      if (samePlatform >= this.#perPlatform) {
        // Claimed but not allowed to run yet: put it back without consuming an
        // attempt, so a busy platform does not burn retries by waiting.
        this.#tasks.release(task.id)
        this.#tasks.note(task.id, 'info', `平台 ${platform} 的并发已满，稍后再试`)
        return
      }
      this.#inFlight.set(task.id, platform)
      void this.#execute(task, platform).finally(() => {
        this.#inFlight.delete(task.id)
        this.#scheduled.delete(task.monitorId)
        this.#compensating.delete(task.monitorId)
      })
    }
  }

  async #execute(task: AutoTask, platform: string): Promise<void> {
    const api = this.#api()
    if (api === undefined) {
      this.#tasks.finish(task.id, 'blocked', {
        error: '后台接口尚未就绪（辩论引擎未挂载）',
        errorKind: 'not_ready',
      })
      return
    }
    try {
      if (task.kind === 'probe') await this.#runProbe(api, task)
      else if (task.kind === 'compensate') await this.#runCompensate(api, task)
      else if (task.kind === 'analyze') await this.#runAnalyze(api, task)
      else await this.#runGenerate(api, task)
    } catch (error) {
      const failure = classifyFailure(error)
      const attemptsLeft = task.attempts < task.maxAttempts
      this.#tasks.note(task.id, 'error', failure.message)
      if (failure.blocksMonitor) {
        this.#monitors.block(task.monitorId, failure.message)
        this.#tasks.finish(task.id, 'blocked', { error: failure.message, errorKind: failure.kind })
        this.#log.warn(`监控 ${task.monitorId} 因 ${failure.kind} 被暂停：${failure.message}`)
        return
      }
      if (failure.retryable && attemptsLeft) {
        const delay = failure.retryAfterMs ?? backoffFor(task.attempts, failure.kind)
        this.#tasks.retryLater(task.id, delay, { error: failure.message, errorKind: failure.kind })
        return
      }
      this.#tasks.finish(task.id, 'failed', { error: failure.message, errorKind: failure.kind })
      this.#monitors.noteOutcome(task.monitorId, 'failure')
      this.#log.warn(`任务失败（${task.kind}/${platform}）：${failure.message}`)
    }
  }

  async #runProbe(api: DebateProductApi, task: AutoTask): Promise<void> {
    const monitor = this.#monitors.get(task.monitorId)
    if (monitor === undefined) {
      this.#tasks.finish(task.id, 'cancelled', { error: '监控目标已删除' })
      return
    }
    const startedAt = new Date(this.#now()).toISOString()
    let result
    try {
      result = await api.probe({ url: monitor.url })
    } catch (error) {
      const failure = classifyFailure(error)
      this.#monitors.noteCheck(monitor.id, { at: startedAt, ok: false, error: failure.message })
      throw error
    }
    this.#monitors.noteCheck(monitor.id, { at: startedAt, ok: true })
    this.#lastSuccessProbeAt = startedAt
    const scope = result.scan.complete ? '完整' : `不完整：${result.scan.incompleteReason ?? '未知原因'}`
    this.#tasks.note(
      task.id,
      'info',
      `读取 ${result.replies.length} 条发言（${result.scan.pagesRead} 页，${scope}）`,
    )

    const owner = api.ownerIdentity(monitor.platform)
    const fresh = result.replies.filter((reply) => !isOwnerPost(reply, owner))

    if (monitor.baselineAt === undefined) {
      // First successful read: remember what was already there, analyse none of
      // it. The owner is shown the count so "why did nothing happen yet" has an
      // answer on screen instead of being a mystery.
      const outcome = this.#monitors.applyScan(monitor.id, {
        at: startedAt,
        coverage: 'tail',
        complete: result.scan.complete,
        pagesRead: result.scan.pagesRead,
        ...(result.scan.totalPages === undefined ? {} : { totalPages: result.scan.totalPages }),
        ...(result.scan.incompleteReason === undefined ? {} : { incompleteReason: result.scan.incompleteReason }),
        replies: fresh.map((reply) => ({ postId: reply.postId, fingerprint: reply.fingerprint })),
      })
      this.#monitors.markBaseline(monitor.id, startedAt)
      this.#monitors.markCompensated(monitor.id, startedAt)
      this.#tasks.note(task.id, 'info', `首次检查建立基线：已记录 ${outcome.fresh.length} 条既有发言，不自动分析`)
      this.#tasks.finish(task.id, 'completed')
      return
    }

    const outcome = this.#monitors.applyScan(monitor.id, {
      at: startedAt,
      coverage: 'tail',
      complete: result.scan.complete,
      pagesRead: result.scan.pagesRead,
      ...(result.scan.totalPages === undefined ? {} : { totalPages: result.scan.totalPages }),
      ...(result.scan.incompleteReason === undefined ? {} : { incompleteReason: result.scan.incompleteReason }),
      replies: fresh.map((reply) => ({ postId: reply.postId, fingerprint: reply.fingerprint })),
    })
    if (!outcome.cursorAdvanced) {
      this.#tasks.note(task.id, 'warn', '本次读取不完整，游标未推进；下一轮会重新覆盖同一范围')
    }
    if (outcome.changed.length > 0) {
      this.#tasks.note(task.id, 'info', `发现 ${outcome.changed.length} 条既有发言被修改（已记录，不重复生成候选）`)
    }
    if (outcome.fresh.length === 0) {
      this.#tasks.finish(task.id, 'completed')
      return
    }
    // One analysis covers the whole batch: the read that found these replies also
    // contains them, so asking the engine to re-read per reply would multiply
    // platform requests by the number of new comments.
    this.#enqueue({
      kind: 'analyze',
      monitorId: monitor.id,
      postId: outcome.fresh[0] as string,
      postIds: outcome.fresh,
      dedupeKey: `analyze:${monitor.id}:${outcome.fresh[0] as string}`,
    })
    this.#tasks.note(task.id, 'info', `发现 ${outcome.fresh.length} 条新发言，已排入分析队列`)
    this.#tasks.finish(task.id, 'completed')
  }

  async #runCompensate(api: DebateProductApi, task: AutoTask): Promise<void> {
    const monitor = this.#monitors.get(task.monitorId)
    if (monitor === undefined) {
      this.#tasks.finish(task.id, 'cancelled', { error: '监控目标已删除' })
      return
    }
    const full = task.postId === 'full'
    const startedAt = new Date(this.#now()).toISOString()
    let result
    try {
      result = await api.probe({
        url: monitor.url,
        mode: full ? 'full' : 'window',
        ...(full ? {} : { windowHours: monitor.compensationHours }),
      })
    } catch (error) {
      const failure = classifyFailure(error)
      this.#monitors.noteCheck(monitor.id, { at: startedAt, ok: false, error: failure.message })
      throw error
    }
    const owner = api.ownerIdentity(monitor.platform)
    const replies = result.replies.filter((reply) => !isOwnerPost(reply, owner))
    const outcome = this.#monitors.applyScan(monitor.id, {
      at: startedAt,
      coverage: full ? 'full' : 'tail',
      complete: result.scan.complete,
      pagesRead: result.scan.pagesRead,
      ...(result.scan.totalPages === undefined ? {} : { totalPages: result.scan.totalPages }),
      ...(result.scan.incompleteReason === undefined ? {} : { incompleteReason: result.scan.incompleteReason }),
      replies: replies.map((reply) => ({ postId: reply.postId, fingerprint: reply.fingerprint })),
    })
    if (full) this.#monitors.markCompensated(monitor.id, startedAt)
    else if (result.scan.complete) this.#monitors.markCompensated(monitor.id, startedAt)

    // A compensating scan never generates. Its job is to notice that the record is
    // stale, and a candidate produced from an edited reply would be a new answer to
    // an old question.
    this.#tasks.note(
      task.id,
      'info',
      `补偿扫描（${full ? '全量' : `${monitor.compensationHours} 小时窗口`}）：读取 ${replies.length} 条，修改 ${outcome.changed.length} 条，消失 ${outcome.removed.length} 条，新增 ${outcome.fresh.length} 条`,
    )
    if (outcome.changed.length > 0) {
      this.#tasks.note(task.id, 'warn', `以下发言内容已变化：${outcome.changed.slice(0, 5).join('、')}`)
    }
    if (outcome.fresh.length > 0) {
      // New content found by the compensating read is genuinely new: it must go
      // through analysis like any other discovery, or a slow probe cadence would
      // silently drop it. Rewrites are the opposite case — they are recorded only,
      // because a candidate built on a since-edited reply answers a dead question.
      this.#enqueue({
        kind: 'analyze',
        monitorId: monitor.id,
        postId: outcome.fresh[0] as string,
        postIds: outcome.fresh,
        dedupeKey: `analyze:${monitor.id}:${outcome.fresh[0] as string}`,
      })
      this.#tasks.note(task.id, 'info', `补偿扫描发现 ${outcome.fresh.length} 条新发言，已排入分析队列`)
    }
    if (!result.scan.complete) {
      this.#tasks.note(task.id, 'warn', `补偿扫描不完整：${result.scan.incompleteReason ?? '未知原因'}`)
    }
    this.#tasks.finish(task.id, 'completed')
  }

  async #runAnalyze(api: DebateProductApi, task: AutoTask): Promise<void> {
    const monitor = this.#monitors.get(task.monitorId)
    if (monitor === undefined || task.postId === undefined) {
      this.#tasks.finish(task.id, 'cancelled', { error: '监控目标或回复已不存在' })
      return
    }
    /**
     * ## The trigger is the owner's own post, not the new reply
     *
     * `runAnalysis` refuses a trigger whose author is not the owner — a reply by
     * someone else cannot "summon" the assistant, and passing one would throw
     * `这条回复的作者不是配置的主人` on every single new comment. Omitting the id
     * lets the engine pick the newest owner post, which is what a hand-run analysis
     * does when the owner pastes a link without pointing at a floor.
     */
    const { sessionId } = await api.analyze({ url: monitor.url })
    this.#tasks.note(task.id, 'info', `分析完成，会话 ${sessionId}（覆盖 ${task.postIds?.length ?? 1} 条新回复）`)
    this.#monitors.noteOutcome(monitor.id, 'analyzed')

    const targets = task.postIds ?? (task.postId === undefined ? [] : [task.postId])
    for (const postId of targets) {
      // Keyed by monitor and reply, not by session: a second analysis of the same
      // thread produces a new session id, and a session-scoped key would then let
      // the same reply collect a second candidate.
      const key = `generate:${monitor.id}:${postId}`
      if (this.#tasks.settledByKey(key) !== undefined) continue
      this.#enqueue({
        kind: 'generate',
        monitorId: monitor.id,
        postId,
        sessionId,
        dedupeKey: key,
      })
    }
    this.#tasks.finish(task.id, 'completed', { sessionId })
  }

  async #runGenerate(api: DebateProductApi, task: AutoTask): Promise<void> {
    const monitor = this.#monitors.get(task.monitorId)
    if (monitor === undefined || task.sessionId === undefined) {
      this.#tasks.finish(task.id, 'cancelled', { error: '监控目标或会话已不存在' })
      return
    }
    // A candidate for this exact target may already exist — from an earlier
    // attempt that was interrupted after the model call. Reusing it is both
    // cheaper and the only way "one reply, one candidate" holds across a crash.
    const session = await api.session(task.sessionId)
    const existing = session?.candidates.find((candidate) => candidate.targetPostId === task.postId)
    if (existing !== undefined) {
      this.#tasks.note(task.id, 'info', `该目标已有候选 ${existing.replyId}，不再重复生成`)
      this.#tasks.finish(task.id, 'needs_review', { sessionId: task.sessionId })
      this.#monitors.noteOutcome(monitor.id, 'candidate')
      return
    }

    // Record that a model call is going out before it goes. This is what makes the
    // difference between "the request never left" and "the request left and the
    // answer was lost" visible after a crash.
    this.#tasks.beginModelCall(task.id)
    let result
    try {
      result = await api.generate({
        sessionId: task.sessionId,
        ...(task.postId === undefined ? {} : { targetPostId: task.postId }),
      })
    } catch (error) {
      // The call was dispatched; whatever the error, its side effects are unknown.
      this.#tasks.finishModelCall(task.id, { uncertain: true })
      throw error
    }
    this.#tasks.finishModelCall(task.id, {
      ...(result.candidateId === undefined ? {} : { candidateId: result.candidateId }),
      ...(result.ok ? {} : { uncertain: true }),
    })
    if (result.ok) {
      this.#tasks.note(task.id, 'info', `候选已生成：${result.candidateId ?? '(未返回 id)'}`)
      this.#tasks.finish(task.id, 'needs_review', { sessionId: task.sessionId })
      this.#monitors.noteOutcome(monitor.id, 'candidate')
      return
    }
    // A refusal from the generator is a decision with a reason. It is recorded in
    // full and never retried — asking the model again hoping for a different
    // judgement is how a rejected reply eventually gets through.
    const reason = result.message ?? `生成未产出候选（${result.outcome}）`
    const violations = result.violations?.join('；')
    this.#tasks.note(task.id, 'warn', violations === undefined ? reason : `${reason}：${violations}`)
    this.#tasks.finish(task.id, 'completed', {
      error: violations === undefined ? reason : `${reason}：${violations}`,
      errorKind: 'generator_declined',
      sessionId: task.sessionId,
    })
    this.#monitors.noteOutcome(monitor.id, 'failure')
  }
}

/** Whether a probed reply is the owner's own post, which must not be answered. */
export function isOwnerPost(
  reply: { authorId?: string; authorName?: string; authorNumericUid?: string },
  owner: { userId?: string; handle?: string; userName?: string },
): boolean {
  if (owner.userId !== undefined && owner.userId !== '' && reply.authorNumericUid === owner.userId) return true
  if (owner.handle !== undefined && owner.handle !== '' && reply.authorId === owner.handle) return true
  // A display name is the weakest signal and the only one left when nothing else
  // is bound; matching it is better than the bot replying to its own owner.
  if (owner.userName !== undefined && owner.userName !== '' && reply.authorName === owner.userName) return true
  return false
}

/** Compose the console's monitor rows: config plus live task counts. */
export function monitorViews(
  monitors: readonly MonitorTarget[],
  tasks: readonly AutoTask[],
): readonly Record<string, unknown>[] {
  return monitors.map((monitor) => {
    const own = tasks.filter((task) => task.monitorId === monitor.id)
    const pending = own.filter((task) => task.state === 'pending' || task.state === 'retry_wait' || task.state === 'running').length
    const review = own.filter((task) => task.state === 'needs_review').length
    return {
      id: monitor.id,
      name: monitor.name,
      platform: monitor.platform,
      url: monitor.url,
      threadId: monitor.threadId,
      ...(monitor.accountLabel === undefined ? {} : { accountLabel: monitor.accountLabel }),
      enabled: monitor.enabled,
      intervalSec: monitor.intervalSec,
      compensationHours: monitor.compensationHours,
      createdAt: monitor.createdAt,
      updatedAt: monitor.updatedAt,
      ...(monitor.lastCheckAt === undefined ? {} : { lastCheckAt: monitor.lastCheckAt }),
      ...(monitor.lastSuccessAt === undefined ? {} : { lastSuccessAt: monitor.lastSuccessAt }),
      ...(monitor.lastError === undefined ? {} : { lastError: monitor.lastError }),
      ...(monitor.lastErrorAt === undefined ? {} : { lastErrorAt: monitor.lastErrorAt }),
      ...(monitor.blockedReason === undefined ? {} : { blockedReason: monitor.blockedReason }),
      ...(monitor.lastScan === undefined ? {} : { lastScan: monitor.lastScan }),
      ...(monitor.cursor?.lastCompleteScanAt === undefined ? {} : { lastCompleteScanAt: monitor.cursor.lastCompleteScanAt }),
      ...(monitor.lastCompensationAt === undefined ? {} : { lastCompensationAt: monitor.lastCompensationAt }),
      recentChanges: monitor.changes.slice(-5),
      pendingTasks: pending,
      reviewCandidates: review,
      counters: monitor.counters,
    }
  })
}
