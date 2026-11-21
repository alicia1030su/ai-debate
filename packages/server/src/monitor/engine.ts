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
import type { MonitorStore, MonitorTarget, PlatformState } from './store.ts'
import { type ReplyIdentity, ReplyIdentityStore, replyIdentityKey } from './identities.ts'
import { isTerminal, type AutoTask, type AutoTaskStore, type QueueStats, type RecoveryRecord } from './tasks.ts'

export interface EngineOptions {
  readonly monitors: MonitorStore
  readonly tasks: AutoTaskStore
  readonly identities: ReplyIdentityStore
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
  /** How often to reconcile durable claims with queued tasks (default 30s). */
  readonly orphanSweepMs?: number
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

type CandidateLookup =
  | { readonly kind: 'found'; readonly candidateId: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable' }

/** Classify a thrown error into "retry", "block the monitor" or "give up". */
export function classifyFailure(error: unknown): {
  kind: string
  retryable: boolean
  blocksMonitor: boolean
  message: string
  platformState?: PlatformState
  retryAfterMs?: number
} {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown }).code
  const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs
  const status = (error as { status?: unknown }).status

  if (typeof code === 'string') {
    if (code === 'egress_blocked') {
      return {
        kind: 'egress_blocked',
        retryable: false,
        blocksMonitor: false,
        message: '出网策略拒绝：请求未连接到平台。请检查运行模式与允许出网的目标，不要伪装成网络故障。',
        platformState: 'egress_blocked',
      }
    }
    // Platform-level codes (PlatformError) and model-level codes (LlmError) share
    // a few names; both are handled here because the reaction is the same.
    if (code === 'rate_limited') {
      return {
        kind: 'rate_limited',
        retryable: true,
        blocksMonitor: false,
        message,
        platformState: 'rate_limited',
        ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
      }
    }
    if (code === 'auth_required' || code === 'unauthorized' || code === 'forbidden' || code === 'permission_denied' || code === 'captcha') {
      return {
        kind: 'auth',
        retryable: false,
        blocksMonitor: true,
        message,
        platformState: code === 'forbidden' || code === 'permission_denied' || code === 'captcha' || status === 403 ? 'forbidden' : 'unauthorized',
      }
    }
    if (code === 'network' || code === 'timeout' || code === 'dns') {
      return { kind: 'network', retryable: true, blocksMonitor: false, message, platformState: 'network_error' }
    }
    if (code === 'quota') {
      return { kind: 'quota', retryable: false, blocksMonitor: false, message }
    }
    if (code === 'not_found' || code === 'malformed_response' || code === 'bad_response') {
      return { kind: 'permanent', retryable: false, blocksMonitor: false, message, platformState: 'adapter_error' }
    }
    if (code === 'context_too_long') {
      return { kind: 'policy', retryable: false, blocksMonitor: false, message }
    }
  }

  if (typeof status === 'number') {
    if (status === 429) return { kind: 'rate_limited', retryable: true, blocksMonitor: false, message, platformState: 'rate_limited' }
    if (status === 401 || status === 403) return { kind: 'auth', retryable: false, blocksMonitor: true, message, platformState: status === 403 ? 'forbidden' : 'unauthorized' }
    if (status >= 500) return { kind: 'network', retryable: true, blocksMonitor: false, message, platformState: 'network_error' }
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
  readonly #identities: ReplyIdentityStore
  readonly #api: () => DebateProductApi | undefined
  readonly #log: Logger
  readonly #concurrency: number
  readonly #perPlatform: number
  readonly #tickMs: number
  readonly #taskTimeoutMs: number
  readonly #compensationEveryMs: number
  readonly #orphanSweepMs: number
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
  #lastOrphanSweep = 0
  #orphanSweepRunning = false
  /** Candidate evidence already reconciled in this process; intentionally not persisted. */
  #verifiedCandidates = new Set<string>()

  constructor(options: EngineOptions) {
    this.#monitors = options.monitors
    this.#tasks = options.tasks
    this.#identities = options.identities
    this.#api = options.api
    this.#log = options.log
    this.#concurrency = Math.max(1, Math.min(4, options.concurrency ?? 1))
    this.#perPlatform = Math.max(1, Math.min(4, options.perPlatformConcurrency ?? 1))
    this.#tickMs = Math.max(250, options.tickMs ?? 2000)
    this.#taskTimeoutMs = Math.max(30_000, options.taskTimeoutMs ?? 10 * 60 * 1000)
    this.#compensationEveryMs = Math.max(60_000, options.compensationEveryMs ?? DEFAULT_COMPENSATION_EVERY_MS)
    this.#orphanSweepMs = Math.max(0, options.orphanSweepMs ?? 30_000)
    this.#now = options.now ?? (() => Date.now())
  }

  start(): void {
    if (this.#timer !== undefined) return
    this.#running = true
    this.#timer = setInterval(() => void this.#tick(), this.#tickMs)
    this.#timer.unref?.()
    this.#log.info(`后台挂机引擎已启动：并发 ${this.#concurrency}，每平台 ${this.#perPlatform}，心跳 ${this.#tickMs}ms`)
    this.#lastOrphanSweep = this.#now()
    void this.#recoverOrphanClaims().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.#lastError = message
      this.#log.warn(`启动身份对账失败：${message}`)
      if (error instanceof AtomicWriteError) this.#degrade(error)
    })
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
      // Renew every in-flight lease before deciding whether any of them expired.
      // The lease is persisted, so a killed process leaves an expiry that recovery
      // can reason about; a live process keeps it alive with the scheduler heartbeat.
      for (const [taskId, platform] of this.#inFlight) {
        const task = this.#tasks.get(taskId)
        if (task === undefined) continue
        if (!this.#tasks.renewLease(taskId, task.leaseToken, startedAt, this.#taskTimeoutMs)) {
          this.#log.warn(`任务 ${taskId} 的租约已失效（${platform}）`)
        }
      }
      // A hung task holds a concurrency slot forever. Reaping is part of the tick,
      // not a separate timer, so it cannot be forgotten when the loop changes.
      const reaped = this.#tasks.reapStuck(startedAt, this.#taskTimeoutMs)
      if (reaped.length > 0) this.#log.warn(`${reaped.length} 个任务超时，已判定为卡死并释放槽位`)
      this.#scheduleDue()
      // A live write failure can leave a claim without its task just as a crash can.
      // Sweep occasionally rather than only at startup, so recovery does not require
      // the operator to restart the service.
      if (startedAt - this.#lastOrphanSweep >= this.#orphanSweepMs) {
        this.#lastOrphanSweep = startedAt
        await this.#recoverOrphanClaims()
      }
      await this.#drain()
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error)
      this.#log.warn(`后台调度出错：${this.#lastError}`)
      if (error instanceof AtomicWriteError) {
        // The ledger could not be written. Claiming more work would risk repeating
        // it after a restart, so stop claiming until the disk recovers.
        this.#degrade(error)
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
      if (error instanceof AtomicWriteError) this.#degrade(error)
    }
  }

  /** Stop claiming work until the durable ledger is writable again. */
  #degrade(error: AtomicWriteError): void {
    this.#degraded = `持久化写入失败（${error.target}）：${error.message}`
    this.#degradedUntil = this.#now() + DEGRADED_COOLDOWN_MS
    this.#lastError = this.#degraded
    this.#log.error(this.#degraded)
  }

  async #drain(): Promise<void> {
    while (this.#running) {
      if (this.#inFlight.size >= this.#concurrency) return
      const task = this.#tasks.claim(this.#now(), this.#taskTimeoutMs)
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
      void this.#execute(task, platform)
        .catch((error: unknown) => {
          // Defensive last resort: #execute is not allowed to reject, but a future
          // edit must not turn a bookkeeping bug into an unhandledRejection that
          // kills a long-running service.
          const message = error instanceof Error ? error.message : String(error)
          this.#lastError = message
          this.#log.error(`后台任务执行出现未处理异常（${task.id}）：${message}`)
          if (error instanceof AtomicWriteError) this.#degrade(error)
        })
        .finally(() => {
          this.#inFlight.delete(task.id)
          this.#scheduled.delete(task.monitorId)
          this.#compensating.delete(task.monitorId)
        })
    }
  }

  async #execute(task: AutoTask, platform: string): Promise<void> {
    try {
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
        if (error instanceof AtomicWriteError) {
          // The ledger itself is unavailable. Trying to note/retry/finish would
          // issue another failing write from inside this catch and escape as an
          // unhandled rejection. Leave the durable running row for lease recovery,
          // stop claiming, and let the orphan sweep repair lost task enqueues once
          // the disk is writable again.
          this.#degrade(error)
          return
        }
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
        // Close the identity before publishing the terminal task row. A timeout
        // can happen after the core persisted a candidate, and the reverse write
        // order would expose a failed task with a permanently claimed identity to
        // an invariant check. If the candidate store is unavailable, leave the
        // claim for the orphan sweep rather than guessing absence.
        if (task.kind === 'generate' && task.identityKey !== undefined) {
          const identity = this.#identities.get(task.identityKey)
          if (identity?.state === 'claimed') {
            const related = this.#tasks.all().filter((entry) =>
              entry.identityKey === identity.key || entry.identityKeys?.includes(identity.key) === true,
            )
            const candidate = await this.#findExistingCandidate(identity, related)
            if (candidate.kind === 'found') {
              this.#recordRecoveredCandidate(identity, task.sessionId, candidate.candidateId)
              this.#tasks.finish(task.id, 'needs_review', { sessionId: task.sessionId })
              this.#log.warn(`生成超时但已找到既有候选 ${candidate.candidateId}，任务转为待审核；不重复累计候选数`)
              return
            }
            if (candidate.kind === 'absent') {
              const uncertain = this.#tasks.get(task.id)?.modelCall?.uncertain === true ? '；模型调用结果不确定' : ''
              this.#ignoreOrphanIdentity(
                identity,
                `生成任务 ${task.id} 失败（${failure.message}，尝试 ${task.attempts}/${task.maxAttempts}），未找到候选${uncertain}；已停止自动重试，可由操作员手动重试`,
              )
            } else {
              this.#log.warn(`回复身份 ${identity.key} 的候选存储暂不可读，保留 claim 等待孤儿对账`)
            }
          }
        }
        this.#tasks.finish(task.id, 'failed', { error: failure.message, errorKind: failure.kind })
        this.#monitors.noteOutcome(task.monitorId, 'failure')
        this.#log.warn(`任务失败（${task.kind}/${platform}）：${failure.message}`)
      }
    } catch (error) {
      // Bookkeeping can fail too (monitor write, auth block, note after a model
      // error). None of those may reject the fire-and-forget execution promise.
      if (error instanceof AtomicWriteError) {
        this.#degrade(error)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      this.#lastError = message
      this.#log.error(`后台任务收尾失败（${task.id}）：${message}`)
    }
  }

  #claimReplies(
    monitor: MonitorTarget,
    replies: readonly { postId: string; fingerprint: string; identityQuality: 'stable' | 'fallback' }[],
    freshIds: readonly string[],
  ): readonly { postId: string; key: string }[] {
    const wanted = new Set(freshIds)
    const claimed: { postId: string; key: string }[] = []
    for (const reply of replies) {
      if (!wanted.has(reply.postId)) continue
      const key = replyIdentityKey({
        platform: monitor.platform,
        threadId: monitor.threadId,
        postId: reply.postId,
        quality: reply.identityQuality,
        fingerprint: reply.fingerprint,
      })
      const result = this.#identities.claim({
        platform: monitor.platform,
        threadId: monitor.threadId,
        postId: reply.postId,
        quality: reply.identityQuality,
        fingerprint: reply.fingerprint,
        monitorId: monitor.id,
      })
      if (result.fresh || result.identity.state === 'claimed') claimed.push({ postId: reply.postId, key })
    }
    return claimed
  }

  /**
   * Ensure every claimed reply is covered by an analysis task.
   *
   * The first monitor's batch can still be pending when a second monitor discovers
   * more replies in the same thread. In that case the new identities are appended
   * to the pending batch. If it is already running, a second batch is queued for
   * the uncovered replies. Keying only on the first identity would silently drop
   * the rest of the batch.
   */
  #enqueueAnalysis(
    monitor: MonitorTarget,
    claimed: readonly { postId: string; key: string }[],
  ): void {
    const uncovered: { postId: string; key: string }[] = []
    for (const entry of claimed) {
      const identity = this.#identities.get(entry.key)
      if (identity?.state === 'candidate' || identity?.state === 'ignored') continue
      const covering = this.#tasks.all().find(
        (task) =>
          task.kind === 'analyze' &&
          (task.identityKey === entry.key || task.identityKeys?.includes(entry.key) === true),
      )
      if (covering === undefined) {
        uncovered.push(entry)
        continue
      }
      if (covering.state === 'completed' || covering.state === 'needs_review') continue
      if (covering.state === 'pending' || covering.state === 'retry_wait') {
        try {
          if (this.#tasks.appendIdentities(covering.id, [{ postId: entry.postId, identityKey: entry.key }])) continue
        } catch (error) {
          this.#lastError = error instanceof Error ? error.message : String(error)
          this.#log.warn(`补充分析批次失败：${this.#lastError}`)
        }
      }
      // Running, failed, blocked or cancelled: this identity is not safely covered.
      uncovered.push(entry)
    }
    if (uncovered.length === 0) return
    // Discovery must not advance the monitor cursor unless the analysis row is
    // durable. Let write failures propagate so the probe stays running for lease
    // recovery and the next scan can retry the same fresh reply.
    this.#tasks.enqueue({
      kind: 'analyze',
      monitorId: monitor.id,
      postId: uncovered[0]!.postId,
      postIds: uncovered.map((entry) => entry.postId),
      identityKey: uncovered[0]!.key,
      identityKeys: uncovered.map((entry) => entry.key),
      dedupeKey: `analyze:${uncovered[0]!.key}`,
    })
  }

  /**
   * Reconcile durable claims with the tasks that actually still cover them.
   *
   * Only pending/running/retry_wait work is active. A blocked task covers its
   * identity only while its own monitor is still blocked; otherwise an auth pause
   * would either be silently reopened or re-queued on every sweep. Terminal tasks
   * never cover work: failed/cancelled generation is closed as ignored after the
   * candidate check, while a completed analysis can resume at generation.
   */
  async #recoverOrphanClaims(): Promise<void> {
    if (this.#orphanSweepRunning) return
    this.#orphanSweepRunning = true
    try {
      // An ignored identity is a durable fence. If closing its review row failed
      // after that fence was written, finish the row without another core read or
      // model call. This is the reverse crash window of candidate-missing
      // recovery: identity first, task terminal state second.
      for (const task of this.#tasks.all()) {
        if (task.state !== 'needs_review' || task.identityKey === undefined) continue
        const identity = this.#identities.get(task.identityKey)
        if (identity?.state !== 'ignored') continue
        this.#tasks.finish(task.id, 'failed', {
          error: identity.lastError ?? '回复身份已熔断，待审核任务无效',
          errorKind: 'candidate_missing',
          ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
        })
      }

      // Candidate identities are normally excluded from orphan recovery because
      // they are terminal bookkeeping. They still need a core-backed audit: an
      // older bug could persist the identity/review row while the candidate write
      // failed. Re-read durable core evidence on every process start and close
      // such ghosts without calling the model again.
      for (const snapshot of this.#identities.all()) {
        if (snapshot.state !== 'candidate' || this.#verifiedCandidates.has(this.#candidateEvidenceKey(snapshot))) continue
        try {
          await this.#recoverCandidateIdentity(snapshot)
        } catch (error) {
          if (error instanceof AtomicWriteError) throw error
          const message = error instanceof Error ? error.message : String(error)
          this.#log.warn(`回复身份 ${snapshot.key} 候选核心核验失败：${message}`)
        }
      }

      const byIdentity = this.#tasksByIdentity()
      const active = new Set<string>()
      for (const [key, tasks] of byIdentity) {
        if (tasks.some((task) => this.#taskCoversIdentity(task))) active.add(key)
      }
      for (const identity of this.#identities.orphans(active)) {
        try {
          await this.#recoverOrphanClaim(identity)
        } catch (error) {
          // One unreadable session must not prevent unrelated identities from
          // converging. Ledger write failures are different: stop before doing
          // more work on a store that is not durable.
          if (error instanceof AtomicWriteError) throw error
          const message = error instanceof Error ? error.message : String(error)
          this.#log.warn(`回复身份 ${identity.key} 对账失败：${message}`)
        }
      }
    } finally {
      this.#orphanSweepRunning = false
    }
  }

  /** Index both single and batched identity keys without changing either ledger. */
  #tasksByIdentity(): Map<string, AutoTask[]> {
    const byIdentity = new Map<string, AutoTask[]>()
    for (const task of this.#tasks.all()) {
      const keys = new Set<string>()
      if (task.identityKey !== undefined) keys.add(task.identityKey)
      for (const key of task.identityKeys ?? []) keys.add(key)
      for (const key of keys) {
        const tasks = byIdentity.get(key) ?? []
        tasks.push(task)
        byIdentity.set(key, tasks)
      }
    }
    return byIdentity
  }

  /** Whether a task still owns this identity's pipeline work. */
  #taskCoversIdentity(task: AutoTask): boolean {
    if (task.state === 'pending' || task.state === 'running' || task.state === 'retry_wait') return true
    return task.state === 'blocked' && this.#monitors.get(task.monitorId)?.blockedReason !== undefined
  }

  /** Re-read coverage after an asynchronous candidate lookup. */
  #identityHasCoverage(key: string): boolean {
    return this.#tasks.all().some((task) =>
      (task.identityKey === key || task.identityKeys?.includes(key) === true)
      && this.#taskCoversIdentity(task),
    )
  }

  /** Whether any task already carries this identity's single review row. */
  #identityHasReview(key: string): boolean {
    return this.#tasks.all().some((task) =>
      (task.identityKey === key || task.identityKeys?.includes(key) === true)
      && task.state === 'needs_review',
    )
  }

  /** Identity fields that change when new durable candidate evidence is recorded. */
  #candidateEvidenceKey(identity: ReplyIdentity): string {
    return `${identity.key}\u0000${identity.sessionId ?? ''}\u0000${identity.candidateId ?? ''}`
  }

  /**
   * Cache only a fully reconciled candidate review.
   *
   * The cache suppresses future core reads, so candidate identity evidence alone
   * is insufficient: a review row must already be durable. When a model-call
   * record exists, its candidate id is diagnostic provenance rather than an
   * approval; correct it to the core-confirmed id before caching. If any write
   * fails, nothing is cached and the next sweep retries the remaining work.
   */
  #cacheVerifiedCandidateReview(identity: ReplyIdentity, candidateId: string): void {
    const current = this.#identities.get(identity.key)
    if (current?.state !== 'candidate' || !this.#identityHasReview(current.key)) return
    for (const task of this.#tasks.all()) {
      if ((task.identityKey !== current.key && task.identityKeys?.includes(current.key) !== true)
        || task.state !== 'needs_review'
        || task.modelCall === undefined
        || task.modelCall.candidateId === candidateId) continue
      this.#tasks.finishModelCall(task.id, { candidateId })
    }
    this.#verifiedCandidates.add(this.#candidateEvidenceKey(current))
  }

  /**
   * Reconcile a candidate identity against the durable core document.
   *
   * This is deliberately broader than orphan-claim recovery. `candidate` is a
   * terminal identity state, so a historical write-ordering bug used to leave it
   * and its `needs_review` task stuck forever when core candidates were empty.
   * Absence is actionable only after a successful core read; unavailable storage
   * remains deferred. No branch calls analyze or generate.
   */
  async #recoverCandidateIdentity(snapshot: ReplyIdentity): Promise<void> {
    let identity = this.#identities.get(snapshot.key)
    if (identity === undefined || identity.state !== 'candidate') return
    const identityKey = identity.key
    const tasks = this.#tasks.all().filter((task) =>
      task.identityKey === identityKey || task.identityKeys?.includes(identityKey) === true,
    )
    const candidate = await this.#findExistingCandidate(identity, tasks)
    identity = this.#identities.get(snapshot.key)
    if (identity === undefined || identity.state !== 'candidate') return
    if (candidate.kind === 'unavailable') {
      this.#log.warn(`回复身份 ${identity.key} 的候选存储暂不可读，保留候选身份等待下次核验`)
      return
    }
    // A live task may be in the middle of writing the candidate or retrying an
    // unavailable read. It remains the owner and will perform its own check.
    if (this.#identityHasCoverage(identity.key)) return

    if (candidate.kind === 'absent') {
      const reason =
        `数据不一致：回复身份 ${identity.key} 记录候选 ${identity.candidateId ?? '(缺失)'}，` +
        `但核心持久会话未确认目标 ${identity.postId} 的候选；已停止自动处理，未调用模型`
      // Close the identity first. If this durable write fails, the task remains
      // needs_review and the next sweep retries the same core-backed decision;
      // no candidate+failed window is exposed. If the subsequent task write fails,
      // the ignored identity is a durable fence and the sweep's ignored-review
      // pass closes only that task, without another core read or model call.
      this.#identities.markIgnored(identity.key, reason)
      for (const task of tasks) {
        if (task.state === 'needs_review') {
          this.#tasks.finish(task.id, 'failed', {
            error: reason,
            errorKind: 'candidate_missing',
            ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
          })
        }
      }
      this.#log.warn(`回复身份 ${identity.key} 已熔断：${reason}`)
      return
    }

    const confirmedSessionId = identity.sessionId ?? tasks.find((task) => task.sessionId !== undefined)?.sessionId
    if (identity.candidateId !== candidate.candidateId || confirmedSessionId === undefined) {
      this.#identities.markCandidate(identity.key, {
        ...(confirmedSessionId === undefined ? {} : { sessionId: confirmedSessionId }),
        candidateId: candidate.candidateId,
      })
      identity = this.#identities.get(identity.key)
      if (identity === undefined || identity.state !== 'candidate') return
    }
    if (this.#identityHasReview(identity.key)) {
      this.#cacheVerifiedCandidateReview(identity, candidate.candidateId)
      return
    }

    const completedAnalysis = tasks.find((task) => task.kind === 'analyze' && task.state === 'completed')
    if (completedAnalysis !== undefined) {
      await this.#recoverCandidateAnalysisReview(identity, completedAnalysis, candidate)
    } else {
      const generation = tasks.find((task) => task.kind === 'generate')
      const sessionId = identity.sessionId ?? generation?.sessionId
      // A terminal generation is historical evidence. Preserve its failed or
      // completed state (the existing recovery contract) while retaining the
      // now-verified candidate identity; only manufacture review provenance when
      // no generation row exists at all.
      if (generation === undefined) {
        const monitor = this.#monitors.get(identity.monitorId)
        if (monitor !== undefined && sessionId !== undefined) {
          this.#enqueueRecoveredCandidateReview(identity, monitor.id, sessionId, candidate.candidateId)
        }
      }
    }
    const current = this.#identities.get(identity.key)
    if (current?.state === 'candidate') this.#cacheVerifiedCandidateReview(current, candidate.candidateId)
  }

  /**
   * Retry the review transition after candidate persistence succeeded but the
   * analyze task write did not. Candidate identities are intentionally excluded
   * from `orphans()`, so this reverse ledger gap must be reconciled explicitly.
   */
  async #recoverCandidateAnalysisReview(
    snapshot: ReplyIdentity,
    completedAnalysis: AutoTask,
    confirmed?: Extract<CandidateLookup, { kind: 'found' }>,
  ): Promise<void> {
    const identity = this.#identities.get(snapshot.key)
    if (identity === undefined || identity.state !== 'candidate') return
    const analysis = this.#tasks.get(completedAnalysis.id)
    if (analysis?.kind !== 'analyze' || analysis.state !== 'completed') return

    const tasks = this.#tasks.all().filter((task) =>
      task.identityKey === identity.key || task.identityKeys?.includes(identity.key) === true,
    )
    // The normal pipeline already has a generate review row. Reconciling the
    // earlier completed analyze as well would create a duplicate review entry
    // and count the same candidate twice.
    if (this.#identityHasReview(identity.key)) return
    const candidate = confirmed ?? await this.#findExistingCandidate(identity, tasks)
    // A concurrent task may have created the review row while the core read was
    // in flight. Re-check immediately after the await before doing any write.
    if (this.#identityHasReview(identity.key)) return
    if (candidate.kind === 'unavailable') {
      this.#log.warn(`回复身份 ${identity.key} 的候选存储暂不可读，保留已完成分析等待下次对账`)
      return
    }
    if (candidate.kind === 'absent') {
      // The durable candidate state is evidence that a candidate once existed,
      // but the readable core no longer confirms one for this target. Preserve
      // both ledgers rather than inventing review provenance.
      this.#log.warn(`回复身份 ${identity.key} 标记为候选但核心未确认候选证据，保留已完成分析等待下次对账`)
      return
    }
    if (this.#identityHasCoverage(identity.key)) return

    // Candidate lookup is asynchronous. Re-read the identity immediately before
    // writing; the final review check and finish have no await between them.
    const currentIdentity = this.#identities.get(identity.key)
    const currentAnalysis = this.#tasks.get(analysis.id)
    if (currentIdentity?.state !== 'candidate' || currentAnalysis?.state !== 'completed') return
    if (this.#identityHasReview(identity.key)) return
    const sessionId = currentAnalysis.sessionId ?? currentIdentity.sessionId
    this.#tasks.finish(currentAnalysis.id, 'needs_review', sessionId === undefined ? {} : { sessionId })
    this.#log.warn(`回复身份 ${identity.key} 已确认既有候选 ${candidate.candidateId}，补写原分析任务待审核状态，未创建生成任务，不重复累计候选数`)
  }

  /** Apply the smallest safe transition to one uncovered claim. */
  async #recoverOrphanClaim(snapshot: ReplyIdentity): Promise<void> {
    const identity = this.#identities.get(snapshot.key)
    if (identity === undefined || identity.state !== 'claimed') return
    const tasks = this.#tasks.all().filter((task) =>
      task.identityKey === identity.key || task.identityKeys?.includes(identity.key) === true,
    )
    // An asynchronous candidate lookup can race a newly enqueued task. Re-check
    // coverage before mutating the identity so recovery never steals live work.
    if (tasks.some((task) => this.#taskCoversIdentity(task))) return

    const terminal = tasks.filter((task) => isTerminal(task.state))
    const terminalGenerate = terminal.find((task) => task.kind === 'generate')
    if (terminalGenerate !== undefined) {
      const candidate = await this.#findExistingCandidate(identity, tasks)
      // A manual retry or another monitor may have enqueued work while the
      // session read was in flight. Never close over that new coverage.
      if (this.#identityHasCoverage(identity.key)) return
      if (candidate.kind === 'unavailable') {
        this.#log.warn(`回复身份 ${identity.key} 的候选存储暂不可读，保留 claim 等待下次对账`)
        return
      }
      if (candidate.kind === 'found') {
        this.#recordRecoveredCandidate(identity, terminalGenerate.sessionId ?? identity.sessionId, candidate.candidateId)
        return
      }
      const uncertainty = terminalGenerate.modelCall?.uncertain === true ? '；模型调用结果不确定' : ''
      const diagnosis = terminalGenerate.state === 'needs_review' ? '数据不一致：' : ''
      const stateLabel = terminalGenerate.state === 'needs_review' ? '已待审核' : `已 ${terminalGenerate.state}`
      this.#ignoreOrphanIdentity(
        identity,
        `${diagnosis}生成任务 ${terminalGenerate.id} ${stateLabel}，未找到候选${uncertainty}；已停止自动重试，可由操作员手动重试`,
      )
      return
    }

    // A failed/cancelled analysis can still carry a session from a partially
    // completed pipeline. Candidate evidence must win before we circuit-break it.
    const candidateBearingTerminal = terminal.some((task) =>
      (task.kind !== 'analyze' || task.state !== 'completed')
      && (identity.sessionId !== undefined || identity.candidateId !== undefined || task.sessionId !== undefined),
    )
    if (candidateBearingTerminal) {
      const candidate = await this.#findExistingCandidate(identity, tasks)
      if (candidate.kind === 'unavailable') {
        this.#log.warn(`回复身份 ${identity.key} 的候选存储暂不可读，保留 claim 等待下次对账`)
        return
      }
      if (this.#identityHasCoverage(identity.key)) return
      if (candidate.kind === 'found') {
        const sessionId = identity.sessionId ?? terminal.find((task) => task.sessionId !== undefined)?.sessionId
        this.#recordRecoveredCandidate(identity, sessionId, candidate.candidateId)
        const owner = terminal[0]
        if (owner !== undefined && sessionId !== undefined && this.#monitors.get(owner.monitorId) !== undefined) {
          this.#enqueueRecoveredCandidateReview(identity, owner.monitorId, sessionId, candidate.candidateId)
        }
        return
      }
    }

    const failedOrCancelled = terminal.find((task) => task.state === 'failed' || task.state === 'cancelled')
    if (failedOrCancelled !== undefined) {
      this.#ignoreOrphanIdentity(
        identity,
        `${failedOrCancelled.kind} 任务 ${failedOrCancelled.id} 已 ${failedOrCancelled.state}：${failedOrCancelled.lastError ?? '未记录原因'}；已停止自动重试`,
      )
      return
    }
    const inconsistentReview = terminal.find((task) => task.state === 'needs_review')
    if (inconsistentReview !== undefined) {
      this.#ignoreOrphanIdentity(
        identity,
        `数据不一致：${inconsistentReview.kind} 任务 ${inconsistentReview.id} 已待审核但身份未记录候选，已熔断；请检查候选存储`,
      )
      return
    }

    const completedAnalysis = terminal.find((task) => task.kind === 'analyze' && task.state === 'completed')
    if (completedAnalysis !== undefined) {
      const sessionId = completedAnalysis.sessionId ?? identity.sessionId
      if (sessionId === undefined) {
        this.#ignoreOrphanIdentity(identity, `分析任务 ${completedAnalysis.id} 已完成但未记录会话，已熔断`)
        return
      }
      const candidate = await this.#findExistingCandidate(identity, tasks)
      if (candidate.kind === 'unavailable') {
        this.#log.warn(`回复身份 ${identity.key} 的候选存储暂不可读，保留 claim 等待下次对账`)
        return
      }
      if (this.#identityHasCoverage(identity.key)) return
      if (candidate.kind === 'found') {
        // The candidate already exists, so the original analysis is the review
        // row. Do not manufacture a generate task: mark the identity first, and
        // only then promote the analyze row. If the identity write fails, the
        // completed/claimed pair remains for the next sweep to retry.
        this.#identities.markCandidate(identity.key, { sessionId, candidateId: candidate.candidateId })
        this.#tasks.finish(completedAnalysis.id, 'needs_review', { sessionId })
        this.#log.warn(`回复身份 ${identity.key} 已找到既有候选 ${candidate.candidateId}，原分析任务转为待审核，未创建生成任务，不重复累计候选数`)
        return
      }
      if (this.#monitors.get(completedAnalysis.monitorId) === undefined) {
        this.#ignoreOrphanIdentity(identity, `分析任务 ${completedAnalysis.id} 已完成但监控已删除且无候选，已熔断`)
        return
      }
      // Generation uses the already-created core session, not platform reads, so
      // it can safely finish even if a later auth failure paused the monitor.
      this.#enqueueOrphanGeneration(identity, completedAnalysis.monitorId, sessionId, '分析已完成但生成任务缺失')
      return
    }

    const monitor = this.#monitors.get(identity.monitorId)
    // The original crash window can also leave an attached session with no task.
    // Resolve its candidate before a deleted monitor or auth pause closes/defers
    // the claim; candidate evidence always wins over those bookkeeping states.
    if (identity.sessionId !== undefined || identity.candidateId !== undefined) {
      const candidate = await this.#findExistingCandidate(identity, tasks)
      if (candidate.kind === 'unavailable') {
        this.#log.warn(`回复身份 ${identity.key} 的候选存储暂不可读，保留 claim 等待下次对账`)
        return
      }
      if (this.#identityHasCoverage(identity.key)) return
      if (candidate.kind === 'found') {
        this.#recordRecoveredCandidate(identity, identity.sessionId, candidate.candidateId)
        if (monitor !== undefined && identity.sessionId !== undefined) {
          this.#enqueueRecoveredCandidateReview(identity, monitor.id, identity.sessionId, candidate.candidateId)
        }
        return
      }
    }
    if (monitor === undefined) {
      this.#ignoreOrphanIdentity(identity, '回复身份所属监控已删除且无候选证据，已停止自动处理')
      return
    }
    if (monitor.blockedReason !== undefined) {
      // Authentication is an operator pause, not a terminal answer. Keep the
      // claim and resume will make its blocked task cover the identity again.
      return
    }
    if (terminal.length > 0) {
      this.#ignoreOrphanIdentity(identity, '身份存在终态任务但没有可恢复的分析或生成阶段，已熔断')
      return
    }

    // Analysis already attached a session and candidate lookup proved absence;
    // resume at generation rather than analyse twice.
    if (identity.sessionId !== undefined) {
      this.#enqueueOrphanGeneration(identity, monitor.id, identity.sessionId, '身份已有会话但生成任务缺失')
      return
    }
    this.#enqueue({
      kind: 'analyze',
      monitorId: monitor.id,
      postId: identity.postId,
      identityKey: identity.key,
      identityKeys: [identity.key],
      dedupeKey: `analyze:${identity.key}`,
    })
    this.#log.warn(`回复身份 ${identity.key} 已持久化但任务缺失，已重新排队`)
  }

  /** Resume a missing generation once; the normal candidate check still runs first. */
  #enqueueOrphanGeneration(identity: ReplyIdentity, monitorId: string, sessionId: string, reason: string): void {
    const current = this.#identities.get(identity.key)
    if (current === undefined || current.state !== 'claimed') return
    if (this.#tasks.all().some((task) =>
      (task.identityKey === identity.key || task.identityKeys?.includes(identity.key) === true)
      && this.#taskCoversIdentity(task),
    )) return
    this.#enqueue({
      kind: 'generate',
      monitorId,
      postId: identity.postId,
      identityKey: identity.key,
      sessionId,
      dedupeKey: `generate:${identity.key}`,
      maxAttempts: 1,
    })
    this.#log.warn(`回复身份 ${identity.key}：${reason}，已排入一次有界生成恢复`)
  }

  /**
   * Materialize review provenance for a candidate found before generation.
   *
   * The task is enqueued before the identity write and finished immediately. If
   * either write fails, the surviving pending task re-runs the candidate check
   * and settles without calling the model.
   */
  #enqueueRecoveredCandidateReview(identity: ReplyIdentity, monitorId: string, sessionId: string, candidateId: string): void {
    if (this.#identityHasCoverage(identity.key)) return
    const current = this.#identities.get(identity.key)
    if (current === undefined || (current.state !== 'claimed' && current.state !== 'candidate')) return
    const enqueued = this.#tasks.enqueue({
      kind: 'generate',
      monitorId,
      postId: identity.postId,
      identityKey: identity.key,
      sessionId,
      dedupeKey: `generate:${identity.key}`,
      maxAttempts: 1,
    })
    if (enqueued.deduplicated) return
    this.#identities.markCandidate(identity.key, { sessionId, candidateId })
    this.#tasks.finish(enqueued.task.id, 'needs_review', { sessionId })
    const confirmed = this.#identities.get(identity.key)
    if (confirmed !== undefined) this.#cacheVerifiedCandidateReview(confirmed, candidateId)
    this.#log.warn(`回复身份 ${identity.key} 已找到既有候选 ${candidateId}，直接建立待审核任务，未调用模型，不重复累计候选数`)
  }

  /**
   * Look for a candidate before closing an uncertain terminal generation.
   *
   * A timeout can happen after the core persisted the candidate. Treating the
   * task's failure as proof of absence would hide that candidate forever; treating
   * an unavailable store as absence would be equally wrong, so that case defers.
   */
  async #findExistingCandidate(identity: ReplyIdentity, tasks: readonly AutoTask[]): Promise<CandidateLookup> {
    const sessionIds = new Set<string>()
    const preferredIds = new Set<string>()
    for (const task of tasks) {
      if (task.sessionId !== undefined) sessionIds.add(task.sessionId)
      const candidateId = task.modelCall?.candidateId
      if (typeof candidateId === 'string' && candidateId.trim() !== '') preferredIds.add(candidateId)
    }
    if (identity.sessionId !== undefined) sessionIds.add(identity.sessionId)
    if (typeof identity.candidateId === 'string' && identity.candidateId.trim() !== '') preferredIds.add(identity.candidateId)
    // Ledger ids are only hints. Without a session there is no core evidence to
    // verify them against, so fail closed rather than treating the hint as proof.
    if (sessionIds.size === 0) return preferredIds.size === 0 ? { kind: 'absent' } : { kind: 'unavailable' }
    const api = this.#api()
    if (api === undefined) return { kind: 'unavailable' }
    let fallbackCandidateId: string | undefined
    let unavailable = false
    for (const sessionId of sessionIds) {
      try {
        const session = await api.session(sessionId)
        if (session === undefined) continue
        const candidates = session.candidates.filter((entry) =>
          entry.targetPostId === identity.postId && typeof entry.replyId === 'string' && entry.replyId.trim() !== '',
        )
        // A recorded id confirmed by any readable session is conclusive. Keep
        // checking the remaining sessions only when no preferred id has matched.
        for (const preferredId of preferredIds) {
          if (candidates.some((entry) => entry.replyId === preferredId)) {
            return { kind: 'found', candidateId: preferredId }
          }
        }
        fallbackCandidateId ??= candidates[0]?.replyId
      } catch {
        // A readable session with an unreadable candidate collection is just as
        // inconclusive as a failed session read. Remember the failure so a
        // fallback candidate or absence from another session is not overstated.
        unavailable = true
      }
    }
    if (unavailable) return { kind: 'unavailable' }
    if (fallbackCandidateId !== undefined) return { kind: 'found', candidateId: fallbackCandidateId }
    return { kind: 'absent' }
  }

  /** Repair the identity half of a candidate write that was interrupted. */
  #recordRecoveredCandidate(identity: ReplyIdentity, sessionId: string | undefined, candidateId: string): void {
    const current = this.#identities.get(identity.key)
    if (current === undefined) return
    // A concurrent task may have advanced this identity while the core lookup was
    // in flight. Refresh an existing candidate from authoritative core evidence,
    // but never reopen an explicitly ignored identity or any unknown state.
    if (current.state !== 'claimed' && current.state !== 'candidate') return
    const confirmedSessionId = sessionId ?? current.sessionId
    if (current.state !== 'candidate'
      || current.candidateId !== candidateId
      || current.sessionId !== confirmedSessionId) {
      this.#identities.markCandidate(identity.key, {
        ...(confirmedSessionId === undefined ? {} : { sessionId: confirmedSessionId }),
        candidateId,
      })
    }
    const confirmed = this.#identities.get(identity.key)
    if (confirmed?.state === 'candidate') this.#cacheVerifiedCandidateReview(confirmed, candidateId)
    this.#log.warn(`回复身份 ${identity.key} 已找到既有候选 ${candidateId}，未重复调用模型`)
  }

  /** Close a terminal orphan without deleting its task evidence. */
  #ignoreOrphanIdentity(identity: ReplyIdentity, reason: string): void {
    const current = this.#identities.get(identity.key)
    if (current === undefined || current.state !== 'claimed') return
    this.#identities.markIgnored(identity.key, reason)
    this.#log.warn(`回复身份 ${identity.key} 已熔断：${reason}`)
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
      this.#monitors.noteCheck(monitor.id, { at: startedAt, ok: false, error: failure.message, platformState: failure.platformState })
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

    // Durable discovery order: identity -> analysis task -> monitor cursor. If
    // either ledger write fails, the cursor stays put and the next scan sees the
    // reply again. A cursor failure after both ledgers are safe: orphan recovery
    // already has a claimed identity covered by durable work.
    const known = new Set(monitor.seen)
    const freshIds = fresh.filter((reply) => !known.has(reply.postId)).map((reply) => reply.postId)
    const claimed = this.#claimReplies(monitor, fresh, freshIds)
    if (freshIds.length > 0) this.#enqueueAnalysis(monitor, claimed)
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
    // Two monitors can see the same floor; the identity fence makes the second
    // one a no-op even though its own cursor was advanced independently.
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
      this.#monitors.noteCheck(monitor.id, { at: startedAt, ok: false, error: failure.message, platformState: failure.platformState })
      throw error
    }
    const owner = api.ownerIdentity(monitor.platform)
    const replies = result.replies.filter((reply) => !isOwnerPost(reply, owner))
    const known = new Set(monitor.seen)
    const freshIds = replies.filter((reply) => !known.has(reply.postId)).map((reply) => reply.postId)
    const claimed = this.#claimReplies(monitor, replies, freshIds)
    if (freshIds.length > 0) this.#enqueueAnalysis(monitor, claimed)
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
    for (const [index, postId] of targets.entries()) {
      const key = task.identityKeys?.[index] ?? task.identityKey ?? `legacy:${monitor.platform}:${monitor.threadId}:${postId}`
      if (key !== undefined) this.#identities.attachSession(key, sessionId)
      const identity = this.#identities.get(key)
      if (identity?.state === 'candidate' || identity?.state === 'ignored') continue
      const dedupeKey = `generate:${key}`
      if (this.#tasks.settledByKey(dedupeKey) !== undefined) continue
      this.#enqueue({
        kind: 'generate',
        monitorId: monitor.id,
        postId,
        identityKey: key,
        sessionId,
        dedupeKey,
      })
    }
    this.#tasks.finish(task.id, 'completed', { sessionId })
  }

  async #runGenerate(api: DebateProductApi, task: AutoTask): Promise<void> {
    if (task.sessionId === undefined) {
      this.#tasks.finish(task.id, 'cancelled', { error: '监控目标或会话已不存在' })
      return
    }
    const monitor = this.#monitors.get(task.monitorId)
    const identity = task.identityKey === undefined ? undefined : this.#identities.get(task.identityKey)
    if (identity?.state === 'candidate') {
      const related = this.#tasks.all().filter((entry) =>
        entry.identityKey === identity.key || entry.identityKeys?.includes(identity.key) === true,
      )
      const candidate = await this.#findExistingCandidate(identity, related)
      if (candidate.kind === 'found') {
        this.#tasks.note(task.id, 'info', `核心已确认既有候选 ${candidate.candidateId}，不再调用模型，不重复累计候选数`)
        this.#tasks.finish(task.id, 'needs_review', { sessionId: identity.sessionId ?? task.sessionId })
        return
      }
      if (candidate.kind === 'unavailable') {
        const error = '身份已记录候选，但核心候选存储暂不可读；等待核验后转入待审核，不调用模型'
        // Unavailable is not absence. Keep the identity and an active retry row
        // even after the normal attempt budget; terminally failing here would
        // create candidate+failed with no safe way to decide ignored vs review.
        this.#tasks.retryLater(task.id, 30_000, { error, errorKind: 'candidate_unavailable' })
        return
      }
      const error = '身份记录为候选，但核心不存在匹配目标的有效候选；已停止自动处理'
      // Close the identity first. If this durable write fails, the task stays
      // running for lease recovery instead of exposing terminal failed+candidate
      // for one sweep interval (the strict soak invariant rejects that window).
      if (task.identityKey !== undefined) this.#identities.markIgnored(task.identityKey, error)
      this.#tasks.finish(task.id, 'failed', { error, errorKind: 'candidate_missing', sessionId: task.sessionId })
      if (monitor !== undefined) this.#monitors.noteOutcome(monitor.id, 'failure')
      return
    }
    // A candidate for this exact target may already exist — from an earlier
    // attempt that was interrupted after the model call. Reusing it is both
    // cheaper and the only way "one reply, one candidate" holds across a crash.
    const session = await api.session(task.sessionId)
    const existing = session?.candidates.find((candidate) =>
      candidate.targetPostId === task.postId && typeof candidate.replyId === 'string' && candidate.replyId.trim() !== '',
    )
    if (existing !== undefined) {
      this.#tasks.note(task.id, 'info', `该目标已有候选 ${existing.replyId}，不再重复生成，不重复累计候选数`)
      if (task.identityKey !== undefined) this.#identities.markCandidate(task.identityKey, { sessionId: task.sessionId, candidateId: existing.replyId })
      this.#tasks.finish(task.id, 'needs_review', { sessionId: task.sessionId })
      return
    }
    if (monitor === undefined) {
      this.#tasks.finish(task.id, 'cancelled', { error: '监控目标已删除' })
      return
    }
    // Automatic recovery closes exhausted identities as ignored. Only the
    // durable marker written by AutoTaskStore.retry may reopen one; a stale
    // duplicate task must not turn an ignored decision into another model call.
    const manuallyRetried = task.logs.some((entry) => entry.message === '操作员手动重试')
    if (identity?.state === 'ignored' && !manuallyRetried) {
      this.#tasks.finish(task.id, 'completed', { error: identity.lastError ?? '该回复已被标记为不生成', errorKind: 'generator_declined', sessionId: task.sessionId })
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
    const candidateId = typeof result.candidateId === 'string' ? result.candidateId.trim() : ''
    const validCandidate = result.ok && candidateId !== ''
    if (result.ok && candidateId === '') {
      // A successful response without a durable candidate id is not reviewable.
      // Reuse the normal uncertain-result reconciliation: the core may still own
      // a candidate, but an absent or unreadable core must never create one in the
      // identity ledger by assumption.
      this.#tasks.finishModelCall(task.id, { uncertain: true })
      throw Object.assign(new Error('生成返回成功但缺少非空 candidateId，模型调用结果不确定'), { code: 'bad_response' })
    }
    if (validCandidate) {
      // The API contract promises a persisted candidate, but the server verifies
      // that promise before advancing either ledger. This is the final boundary
      // that prevents a dirty in-memory candidate from becoming needs_review.
      let confirmed = false
      try {
        const persisted = await api.session(task.sessionId)
        confirmed = persisted?.candidates.some((candidate) =>
          candidate.replyId === candidateId
          && (task.postId === undefined || candidate.targetPostId === task.postId),
        ) === true
      } catch (error) {
        this.#tasks.finishModelCall(task.id, { candidateId, uncertain: true })
        throw error
      }
      this.#tasks.finishModelCall(task.id, {
        candidateId,
        ...(confirmed ? {} : { uncertain: true }),
      })
      if (!confirmed) {
        throw Object.assign(
          new Error(`生成返回的 candidateId ${candidateId} 未在核心持久候选中确认，模型调用结果不确定`),
          { code: 'bad_response' },
        )
      }
      if (task.identityKey !== undefined) {
        this.#identities.markCandidate(task.identityKey, { sessionId: task.sessionId, candidateId })
      }
      this.#tasks.note(task.id, 'info', `候选已生成：${candidateId}`)
      this.#tasks.finish(task.id, 'needs_review', { sessionId: task.sessionId })
      if (task.identityKey !== undefined) {
        const confirmedIdentity = this.#identities.get(task.identityKey)
        if (confirmedIdentity !== undefined) this.#cacheVerifiedCandidateReview(confirmedIdentity, candidateId)
      }
      this.#monitors.noteOutcome(monitor.id, 'candidate')
      return
    }
    this.#tasks.finishModelCall(task.id, {
      ...(candidateId === '' ? {} : { candidateId }),
      uncertain: true,
    })
    // A refusal from the generator is a decision with a reason. It is recorded in
    // full and never retried — asking the model again hoping for a different
    // judgement is how a rejected reply eventually gets through.
    const reason = result.message ?? `生成未产出候选（${result.outcome}）`
    const violations = result.violations?.join('；')
    this.#tasks.note(task.id, 'warn', violations === undefined ? reason : `${reason}：${violations}`)
    if (task.identityKey !== undefined) this.#identities.markIgnored(task.identityKey, violations === undefined ? reason : `${reason}：${violations}`)
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
      platformState: monitor.platformState,
      nextScanAt: monitor.enabled && monitor.lastCheckAt !== undefined
        ? new Date(Date.parse(monitor.lastCheckAt) + monitor.intervalSec * 1000).toISOString()
        : undefined,
      scanning: own.some((task) => task.kind === 'probe' && task.state === 'running'),
      retryWaitSec: own
        .filter((task) => task.state === 'retry_wait' && task.retryAfterMs !== undefined)
        .reduce<number>((acc, task) => Math.max(acc, task.retryAfterMs as number), 0) / 1000,
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
