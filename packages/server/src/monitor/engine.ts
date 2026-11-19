/**
 * The background engine: schedule, execute, retry, stop.
 *
 * ## What it is
 *
 * A single-threaded loop with three responsibilities, deliberately kept apart from
 * the HTTP server so that closing a browser has no effect on it:
 *
 *   1. **Schedule** — every tick, ask each enabled monitor whether it is due, and
 *      enqueue a probe if so. Due-ness is computed from `lastCheckAt` and
 *      `intervalSec`, never from a wall-clock timer per monitor: timers do not
 *      survive a restart, and a monitor list that changes while the process runs
 *      would need one timer per edit.
 *   2. **Execute** — claim one due task at a time (bounded by a global and a
 *      per-platform cap), run it, record the outcome.
 *   3. **Back off** — when the platform says "slow down", wait exactly as long as
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
 */
import type { DebateProductApi } from '../../../core/src/product-api.ts'
import type { Logger } from '../logger.ts'
import type { MonitorStore, MonitorTarget } from './store.ts'
import { type AutoTask, type AutoTaskStore } from './tasks.ts'

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
}

const MAX_BACKOFF_MS = 30 * 60 * 1000
const BASE_BACKOFF_MS = 15 * 1000

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
  readonly #now: () => number
  #timer: NodeJS.Timeout | undefined
  #running = false
  #lastTickAt: string | undefined
  #lastError: string | undefined
  #inFlight = new Map<string, string>() // taskId → platform
  #scheduled = new Set<string>() // monitor ids with a probe already queued
  #ticking = false

  constructor(options: EngineOptions) {
    this.#monitors = options.monitors
    this.#tasks = options.tasks
    this.#api = options.api
    this.#log = options.log
    this.#concurrency = Math.max(1, Math.min(4, options.concurrency ?? 1))
    this.#perPlatform = Math.max(1, Math.min(4, options.perPlatformConcurrency ?? 1))
    this.#tickMs = Math.max(250, options.tickMs ?? 2000)
    this.#now = options.now ?? (() => Date.now())
  }

  start(): void {
    if (this.#timer !== undefined) return
    this.#running = true
    this.#timer = setInterval(() => void this.#tick(), this.#tickMs)
    this.#timer.unref?.()
    this.#log.info(`后台挂机引擎已启动：并发 ${this.#concurrency}，每平台 ${this.#perPlatform}`)
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
    return {
      paused: this.#tasks.paused,
      running: this.#running,
      concurrency: this.#concurrency,
      perPlatform: this.#perPlatform,
      monitors: {
        total: monitors.length,
        enabled: monitors.filter((monitor) => monitor.enabled).length,
        blocked: monitors.filter((monitor) => monitor.blockedReason !== undefined).length,
      },
      tasks: counts as unknown as Record<string, number>,
      today: { discovered, candidates, failures },
      queued: this.#tasks.queuedCount(),
      runningTasks: this.#tasks.runningCount(),
      ...(this.#lastTickAt === undefined ? {} : { lastTickAt: this.#lastTickAt }),
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
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
    try {
      this.#lastTickAt = new Date(this.#now()).toISOString()
      this.#scheduleDue()
      await this.#drain()
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error)
      this.#log.warn(`后台调度出错：${this.#lastError}`)
    } finally {
      this.#ticking = false
    }
  }

  /** Enqueue a probe for every monitor that is due. */
  #scheduleDue(): void {
    if (this.#tasks.paused) return
    const now = this.#now()
    for (const monitor of this.#monitors.list()) {
      if (!monitor.enabled || monitor.blockedReason !== undefined) continue
      if (this.#scheduled.has(monitor.id)) continue
      const last = monitor.lastCheckAt === undefined ? 0 : Date.parse(monitor.lastCheckAt)
      if (Number.isNaN(last)) continue
      if (now - last < monitor.intervalSec * 1000) continue
      // Never stack probes for one monitor: one check at a time is what keeps the
      // cursor honest, and two concurrent reads would both see the same new reply.
      const active = this.#tasks.activeByKey(`probe:${monitor.id}`)
      if (active !== undefined) continue
      this.#tasks.enqueue({ kind: 'probe', monitorId: monitor.id, dedupeKey: `probe:${monitor.id}` })
      this.#scheduled.add(monitor.id)
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
      else if (task.kind === 'analyze') await this.#runAnalyze(api, task)
      else await this.#runGenerate(api, task)
    } catch (error) {
      const failure = classifyFailure(error)
      const attemptsLeft = task.attempts < task.maxAttempts
      this.#tasks.note(task.id, 'error', failure.message)
      if (failure.blocksMonitor) {
        this.#monitors
          .block(task.monitorId, failure.message)
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
    this.#tasks.note(task.id, 'info', `读取 ${result.replies.length} 条发言（${result.pagesRead} 页${result.complete ? '' : '，未覆盖全帖'}）`)

    const owner = api.ownerIdentity(monitor.platform)
    const fresh = result.replies.filter((reply) => !isOwnerPost(reply, owner))

    if (monitor.baselineAt === undefined) {
      // First successful read: remember what was already there, analyse none of
      // it. The owner is shown the count so "why did nothing happen yet" has an
      // answer on screen instead of being a mystery.
      const seeded = this.#monitors.acceptSeen(monitor.id, fresh.map((reply) => reply.postId))
      this.#monitors.markBaseline(monitor.id, startedAt)
      this.#tasks.note(task.id, 'info', `首次检查建立基线：已记录 ${seeded.length} 条既有发言，不自动分析`)
      this.#tasks.finish(task.id, 'completed')
      return
    }

    const accepted = this.#monitors.acceptSeen(monitor.id, fresh.map((reply) => reply.postId))
    if (accepted.length === 0) {
      this.#tasks.finish(task.id, 'completed')
      return
    }
    // One analysis covers the whole batch: the read that found these replies also
    // contains them, so asking the engine to re-read per reply would multiply
    // platform requests by the number of new comments.
    this.#tasks.enqueue({
      kind: 'analyze',
      monitorId: monitor.id,
      postId: accepted[0],
      postIds: accepted,
      dedupeKey: `analyze:${monitor.id}:${accepted[0]}`,
    })
    this.#tasks.note(task.id, 'info', `发现 ${accepted.length} 条新发言，已排入分析队列`)
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
    this.#monitors.noteOutcome(monitor.id, 'analyzed')
    for (const postId of targets) {
      if (this.#tasks.settledByKey(`generate:${sessionId}:${postId}`) !== undefined) continue
      this.#tasks.enqueue({
        kind: 'generate',
        monitorId: monitor.id,
        postId,
        sessionId,
        dedupeKey: `generate:${sessionId}:${postId}`,
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

    const result = await api.generate({
      sessionId: task.sessionId,
      ...(task.postId === undefined ? {} : { targetPostId: task.postId }),
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
      createdAt: monitor.createdAt,
      updatedAt: monitor.updatedAt,
      ...(monitor.lastCheckAt === undefined ? {} : { lastCheckAt: monitor.lastCheckAt }),
      ...(monitor.lastSuccessAt === undefined ? {} : { lastSuccessAt: monitor.lastSuccessAt }),
      ...(monitor.lastError === undefined ? {} : { lastError: monitor.lastError }),
      ...(monitor.lastErrorAt === undefined ? {} : { lastErrorAt: monitor.lastErrorAt }),
      ...(monitor.blockedReason === undefined ? {} : { blockedReason: monitor.blockedReason }),
      pendingTasks: pending,
      reviewCandidates: review,
      counters: monitor.counters,
    }
  })
}
