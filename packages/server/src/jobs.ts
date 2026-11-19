/**
 * The background job queue.
 *
 * What this is for, and what it is pointedly *not* for:
 *
 *   - It keeps housekeeping work running when nobody has the console open:
 *     backups, log rotation, credential and storage audits.
 *   - It never carries a publish. Publishing is a single irreversible act that
 *     requires a person in front of the screen and a one-shot approval record;
 *     putting it in a retrying queue is how "posted twice" happens. The queue
 *     types live in a closed set for that reason, not by convention.
 *
 * Crash recovery is the part that needs care: a job found in `running` at boot was
 * interrupted, so it is put back to `queued` with its attempt count incremented —
 * except `backup.restore`, which is not safe to repeat blindly and is instead
 * marked `failed` with a reason the operator can act on.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { writeJson } from './atomic.ts'
import { randomUUID } from 'node:crypto'

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'paused' | 'cancelled'

export type JobType =
  | 'backup.create'
  | 'backup.restore'
  | 'logs.rotate'
  | 'credentials.audit'
  | 'storage.check'

const RETRYABLE: ReadonlySet<JobType> = new Set(['backup.create', 'logs.rotate', 'credentials.audit', 'storage.check'])

export interface JobLogLine {
  readonly at: string
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
}

export interface Job {
  readonly id: string
  readonly type: JobType
  readonly key?: string
  readonly payload: Record<string, unknown>
  state: JobState
  attempts: number
  readonly maxAttempts: number
  readonly createdAt: string
  updatedAt: string
  nextRunAt: string
  startedAt?: string
  finishedAt?: string
  lastError?: string
  logs: JobLogLine[]
}

interface JobDocument {
  version: 1
  paused: boolean
  jobs: Job[]
}

export interface JobHandlerContext {
  /** Append a line to this job's own log. */
  note(level: 'info' | 'warn' | 'error', message: string): void
  /** Set when the queue is shutting down or the job was cancelled. */
  readonly signal: AbortSignal
  readonly payload: Record<string, unknown>
}

export type JobHandler = (context: JobHandlerContext) => Promise<void>

export interface QueueSnapshot {
  readonly paused: boolean
  readonly counts: Record<JobState, number>
  readonly jobs: readonly Job[]
  readonly concurrency: number
}

const MAX_JOBS = 200
const MAX_JOB_LOGS = 40
const BASE_BACKOFF_MS = 5_000
const MAX_BACKOFF_MS = 5 * 60_000
const JOB_TIMEOUT_MS = 5 * 60_000

export class JobQueue {
  readonly #file: string
  readonly #log: { info(message: string): void; warn(message: string): void; error(message: string): void }
  readonly #handlers = new Map<JobType, JobHandler>()
  readonly #concurrency: number
  #jobs: Job[] = []
  #paused = false
  #timer: NodeJS.Timeout | undefined
  #running = new Map<string, AbortController>()
  #stopped = false

  constructor(options: {
    file: string
    log: { info(message: string): void; warn(message: string): void; error(message: string): void }
    concurrency?: number
  }) {
    this.#file = options.file
    this.#log = options.log
    this.#concurrency = Math.max(1, Math.min(4, options.concurrency ?? 1))
  }

  register(type: JobType, handler: JobHandler): void {
    this.#handlers.set(type, handler)
  }

  /** Load, recover interrupted jobs, and start the tick. */
  start(): { recovered: number } {
    this.#load()
    const recovered = this.#recover()
    this.#tick()
    this.#timer = setInterval(() => void this.#tick(), 1000)
    this.#timer.unref?.()
    return { recovered }
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#timer !== undefined) clearInterval(this.#timer)
    for (const controller of this.#running.values()) controller.abort()
    // Give the in-flight handlers a moment to observe the abort and finish their
    // bookkeeping, so "stopped" does not mean "left in running forever".
    const deadline = Date.now() + 4000
    while (this.#running.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    this.#persist()
  }

  /** Enqueue a job, de-duplicating on `key` while queued or running. */
  enqueue(input: {
    type: JobType
    payload?: Record<string, unknown>
    key?: string
    maxAttempts?: number
    delayMs?: number
  }): { job: Job; deduplicated: boolean } {
    if (input.key !== undefined) {
      const existing = this.#jobs.find(
        (job) => job.key === input.key && (job.state === 'queued' || job.state === 'running' || job.state === 'paused'),
      )
      if (existing !== undefined) return { job: existing, deduplicated: true }
    }
    if (this.#jobs.filter((job) => job.state === 'queued' || job.state === 'running').length >= MAX_JOBS) {
      throw new Error(`任务队列已满（上限 ${MAX_JOBS}）。请等当前任务完成，或清理失败任务。`)
    }
    const now = new Date()
    const job: Job = {
      id: randomUUID(),
      type: input.type,
      ...(input.key === undefined ? {} : { key: input.key }),
      payload: input.payload ?? {},
      state: 'queued',
      attempts: 0,
      maxAttempts: Math.max(1, Math.min(5, input.maxAttempts ?? (RETRYABLE.has(input.type) ? 3 : 1))),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: new Date(now.getTime() + (input.delayMs ?? 0)).toISOString(),
      logs: [],
    }
    this.#jobs.unshift(job)
    this.#trim()
    this.#persist()
    this.#log.info(`任务入队：${job.type} ${job.id}`)
    return { job, deduplicated: false }
  }

  list(): readonly Job[] {
    return this.#jobs
  }

  snapshot(): QueueSnapshot {
    const counts: Record<JobState, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, paused: 0, cancelled: 0 }
    for (const job of this.#jobs) counts[job.state] += 1
    return { paused: this.#paused, counts, jobs: this.#jobs, concurrency: this.#concurrency }
  }

  pauseQueue(): void {
    this.#paused = true
    this.#persist()
  }

  resumeQueue(): void {
    this.#paused = false
    this.#persist()
  }

  pauseJob(id: string): boolean {
    const job = this.#jobs.find((item) => item.id === id)
    if (job === undefined || job.state !== 'queued') return false
    job.state = 'paused'
    job.updatedAt = new Date().toISOString()
    this.#persist()
    return true
  }

  resumeJob(id: string): boolean {
    const job = this.#jobs.find((item) => item.id === id)
    if (job === undefined || job.state !== 'paused') return false
    job.state = 'queued'
    job.nextRunAt = new Date().toISOString()
    job.updatedAt = new Date().toISOString()
    this.#persist()
    return true
  }

  cancelJob(id: string): boolean {
    const job = this.#jobs.find((item) => item.id === id)
    if (job === undefined) return false
    if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') return false
    this.#running.get(id)?.abort()
    job.state = 'cancelled'
    job.finishedAt = new Date().toISOString()
    job.updatedAt = new Date().toISOString()
    this.#persist()
    return true
  }

  #load(): void {
    if (!existsSync(this.#file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf8')) as JobDocument
      if (Array.isArray(parsed.jobs)) this.#jobs = parsed.jobs
      this.#paused = parsed.paused === true
    } catch (error) {
      // Never silently start with an empty queue when the file exists: that would
      // erase the record of what was pending.
      this.#log.error(`任务队列文件无法解析，已改名保留：${(error as Error).message}`)
      try {
        writeJson(`${this.#file}.corrupt-${Date.now()}`, { raw: readFileSync(this.#file, 'utf8') })
      } catch {
        // Best effort.
      }
      this.#jobs = []
    }
  }

  #recover(): number {
    let recovered = 0
    const now = new Date().toISOString()
    for (const job of this.#jobs) {
      if (job.state !== 'running') continue
      recovered += 1
      if (job.type === 'backup.restore') {
        // A restore interrupted halfway is not something to re-run automatically.
        job.state = 'failed'
        job.lastError = '进程在恢复备份途中退出。请先确认数据目录的当前内容，再手动重试。'
        job.finishedAt = now
      } else {
        job.state = 'queued'
        job.attempts += 1
        job.nextRunAt = now
        job.lastError = '进程在任务执行中退出，已重新排队。'
      }
      job.updatedAt = now
      job.logs.push({ at: now, level: 'warn', message: job.lastError })
    }
    if (recovered > 0) {
      this.#persist()
      this.#log.warn(`发现 ${recovered} 个中断的任务，已按类型恢复`)
    }
    return recovered
  }

  async #tick(): Promise<void> {
    if (this.#stopped || this.#paused) return
    if (this.#running.size >= this.#concurrency) return
    const now = Date.now()
    const next = this.#jobs
      .filter((job) => job.state === 'queued' && Date.parse(job.nextRunAt) <= now)
      .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))[0]
    if (next === undefined) return
    void this.#run(next)
  }

  async #run(job: Job): Promise<void> {
    const handler = this.#handlers.get(job.type)
    if (handler === undefined) {
      job.state = 'failed'
      job.lastError = `没有注册处理 ${job.type} 的处理器`
      job.updatedAt = new Date().toISOString()
      this.#persist()
      return
    }
    const controller = new AbortController()
    this.#running.set(job.id, controller)
    job.state = 'running'
    job.attempts += 1
    job.startedAt = new Date().toISOString()
    job.updatedAt = job.startedAt
    this.#persist()
    const timeout = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS)
    try {
      await handler({
        payload: job.payload,
        signal: controller.signal,
        note: (level, message) => {
          job.logs.push({ at: new Date().toISOString(), level, message })
          if (job.logs.length > MAX_JOB_LOGS) job.logs.shift()
          this.#persist()
        },
      })
      // The handler may have been cancelled while it ran, which flips the state
      // through a path TypeScript cannot see from here.
      const stateAfterRun = job.state as JobState
      if (stateAfterRun === 'cancelled') {
        // A cancelled job that finished anyway keeps its cancelled state: the
        // operator asked for it to stop, and saying "succeeded" would be a lie.
      } else {
        job.state = 'succeeded'
        job.finishedAt = new Date().toISOString()
        job.updatedAt = job.finishedAt
        job.lastError = undefined
        this.#log.info(`任务完成：${job.type} ${job.id}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const retryable = RETRYABLE.has(job.type) && job.attempts < job.maxAttempts && !controller.signal.aborted
      job.lastError = message
      job.logs.push({ at: new Date().toISOString(), level: 'error', message })
      if (retryable) {
        const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (job.attempts - 1))
        job.state = 'queued'
        job.nextRunAt = new Date(Date.now() + delay).toISOString()
        this.#log.warn(`任务失败将重试：${job.type} ${job.id}（${message}），${Math.round(delay / 1000)} 秒后重试`)
      } else {
        job.state = 'failed'
        job.finishedAt = new Date().toISOString()
        this.#log.error(`任务失败：${job.type} ${job.id}（${message}）`)
      }
    } finally {
      clearTimeout(timeout)
      this.#running.delete(job.id)
      job.updatedAt = new Date().toISOString()
      this.#persist()
    }
  }

  #trim(): void {
    if (this.#jobs.length <= MAX_JOBS + 50) return
    const terminal = this.#jobs.filter((job) => job.state === 'succeeded' || job.state === 'cancelled' || job.state === 'failed')
    const removable = terminal.slice(0, Math.max(0, this.#jobs.length - MAX_JOBS))
    const drop = new Set(removable.map((job) => job.id))
    this.#jobs = this.#jobs.filter((job) => !drop.has(job.id))
  }

  #persist(): void {
    const document: JobDocument = { version: 1, paused: this.#paused, jobs: this.#jobs }
    try {
      writeJson(this.#file, document, { mode: 0o600 })
    } catch (error) {
      this.#log.error(`任务队列写入失败：${(error as Error).message}`)
    }
  }

  /** Size of the queue file, for the system page. */
  sizeBytes(): number {
    try {
      return statSync(this.#file).size
    } catch {
      return 0
    }
  }
}
