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
import { chmodSync, copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

interface ReceiptDocument {
  version: 1
  receipts: Job[]
}

const JOB_TYPES: ReadonlySet<string> = new Set<JobType>([
  'backup.create',
  'backup.restore',
  'logs.rotate',
  'credentials.audit',
  'storage.check',
])
const TERMINAL_RECEIPT_STATES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value))
}

function isBoundedString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length <= maxChars
}

function isJobLogLine(value: unknown): value is JobLogLine {
  return isRecord(value) &&
    isTimestamp(value.at) &&
    (value.level === 'info' || value.level === 'warn' || value.level === 'error') &&
    isBoundedString(value.message, 64 * 1024)
}

/** Receipts are display-only terminal records and must never be schedulable. */
function isJobReceipt(value: unknown): value is Job {
  return isRecord(value) &&
    isBoundedString(value.id, 200) && value.id !== '' &&
    typeof value.type === 'string' && JOB_TYPES.has(value.type) &&
    typeof value.state === 'string' && TERMINAL_RECEIPT_STATES.has(value.state) &&
    typeof value.attempts === 'number' && Number.isInteger(value.attempts) && value.attempts >= 0 &&
    typeof value.maxAttempts === 'number' && Number.isInteger(value.maxAttempts) && value.maxAttempts >= 1 &&
    isRecord(value.payload) &&
    isTimestamp(value.createdAt) && isTimestamp(value.updatedAt) && isTimestamp(value.nextRunAt) &&
    (value.key === undefined || isBoundedString(value.key, 500)) &&
    (value.startedAt === undefined || isTimestamp(value.startedAt)) &&
    (value.finishedAt === undefined || isTimestamp(value.finishedAt)) &&
    (value.lastError === undefined || isBoundedString(value.lastError, 256 * 1024)) &&
    Array.isArray(value.logs) && value.logs.length <= MAX_JOB_LOGS && value.logs.every(isJobLogLine)
}

export interface JobHandlerContext {
  /** Append a line to this job's own log. */
  note(level: 'info' | 'warn' | 'error', message: string): void
  /** Set when the queue is shutting down or the job was cancelled. */
  readonly signal: AbortSignal
  readonly jobId: string
  readonly payload: Record<string, unknown>
}

export type JobHandler = (context: JobHandlerContext) => Promise<void>

export interface QueueSnapshot {
  readonly paused: boolean
  readonly counts: Record<JobState, number>
  readonly jobs: readonly Job[]
  readonly concurrency: number
  readonly persistenceSuspended: boolean
}

const MAX_JOBS = 200
const MAX_JOB_LOGS = 40
const MAX_RECEIPTS = 50
/** Bound the whole sidecar before JSON.parse; 5 MiB of junk is not a receipt. */
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024
const BASE_BACKOFF_MS = 5_000
const MAX_BACKOFF_MS = 5 * 60_000
const JOB_TIMEOUT_MS = 5 * 60_000

export class JobQueue {
  readonly #file: string
  readonly #receiptFile: string | undefined
  readonly #log: { info(message: string): void; warn(message: string): void; error(message: string): void }
  readonly #handlers = new Map<JobType, JobHandler>()
  readonly #concurrency: number
  #jobs: Job[] = []
  #receipts: Job[] = []
  #paused = false
  #timer: NodeJS.Timeout | undefined
  #running = new Map<string, AbortController>()
  #stopped = false
  #persistenceSuspended = false

  constructor(options: {
    file: string
    receiptFile?: string | undefined
    log: { info(message: string): void; warn(message: string): void; error(message: string): void }
    concurrency?: number
  }) {
    this.#file = options.file
    this.#receiptFile = options.receiptFile
    this.#log = options.log
    // One at a time by default, and never more than four: the engine's own limits
    // (`maxAutoPerSession`, `cooldownSeconds`, one adapter per platform) assume a
    // single process doing one thing at a time, and two backups writing the same
    // `backups/` tree is a data race with no upside. The environment variable
    // exists for a CPU-bound installation, not as a tuning knob to be discovered.
    const fromEnv = Number(process.env.AI_DEBATE_JOB_CONCURRENCY ?? '')
    const requested = options.concurrency ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 1)
    this.#concurrency = Math.max(1, Math.min(4, Math.floor(requested)))
  }

  register(type: JobType, handler: JobHandler): void {
    this.#handlers.set(type, handler)
  }

  /** Load, recover interrupted jobs, and start the tick. */
  start(): { recovered: number } {
    this.#load()
    this.#loadReceipts()
    this.#mergeReceipts()
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

  /**
   * Stop writing this in-memory queue to disk.
   *
   * Restore replaces `jobs.json` with the backup's ledger. Letting the finally
   * block persist the old array afterwards would silently undo that restore.
   */
  suspendPersistence(): void { this.#persistenceSuspended = true }
  resumePersistence(): void { this.#persistenceSuspended = false }

  /** Persist a terminal display record without touching the restored jobs ledger. */
  recordSucceededReceipt(jobId: string, message: string): boolean {
    return this.#recordReceipt(jobId, 'succeeded', message)
  }

  /** Persist a failed restore outcome for post-restart operator visibility. */
  recordFailedReceipt(jobId: string, message: string): boolean {
    return this.#recordReceipt(jobId, 'failed', message)
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
    return {
      paused: this.#paused,
      counts,
      jobs: this.#jobs,
      concurrency: this.#concurrency,
      persistenceSuspended: this.#persistenceSuspended,
    }
  }

  pauseQueue(options: { readonly persist?: boolean } = {}): void {
    this.#paused = true
    if (options.persist !== false) this.#persist()
  }

  resumeQueue(options: { readonly persist?: boolean } = {}): void {
    this.#paused = false
    if (options.persist !== false) this.#persist()
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

  #loadReceipts(): void {
    const file = this.#receiptFile
    if (file === undefined || !existsSync(file)) return
    try {
      const size = statSync(file).size
      if (size > MAX_RECEIPT_BYTES) throw new Error(`receipt 文件超过 ${MAX_RECEIPT_BYTES} 字节上限`)
      const bytes = readFileSync(file)
      // Re-check after reading to cover a file that grew between stat and read.
      if (bytes.length > MAX_RECEIPT_BYTES) throw new Error(`receipt 文件超过 ${MAX_RECEIPT_BYTES} 字节上限`)
      const parsed = JSON.parse(bytes.toString('utf8')) as ReceiptDocument
      if (parsed.version !== 1 || !Array.isArray(parsed.receipts) || parsed.receipts.some((receipt) => !isJobReceipt(receipt))) {
        throw new Error('receipt 文档结构不正确')
      }
      this.#receipts = parsed.receipts.slice(0, MAX_RECEIPTS)
    } catch (error) {
      this.#receipts = []
      // JSON.parse errors can quote a slice of the corrupt document. Receipts may
      // contain operator-visible failure text, so never echo that slice to logs.
      const reason = error instanceof SyntaxError ? 'JSON 语法错误' : (error as Error).message
      this.#log.error(`任务凭证文件无法解析，已保留现场：${reason}`)
      try {
        const preserved = `${file}.corrupt-${Date.now()}`
        copyFileSync(file, preserved)
        chmodSync(preserved, 0o600)
      } catch {
        // Best effort: the original file remains untouched for manual inspection.
      }
    }
  }

  /** Terminal receipts override same-id jobs and are never eligible for #tick. */
  #mergeReceipts(): void {
    for (const receipt of this.#receipts) {
      const index = this.#jobs.findIndex((job) => job.id === receipt.id)
      if (index >= 0) this.#jobs[index] = receipt
      else this.#jobs.unshift(receipt)
    }
    this.#trim()
  }

  #recordReceipt(jobId: string, state: 'succeeded' | 'failed', message: string): boolean {
    if (this.#receiptFile === undefined) return false
    const job = this.#jobs.find((item) => item.id === jobId)
    if (job === undefined) {
      this.#log.warn(`无法记录任务凭证：找不到 ${jobId}`)
      return false
    }
    const now = new Date().toISOString()
    const receipt: Job = {
      ...job,
      state,
      finishedAt: now,
      updatedAt: now,
      lastError: state === 'failed' ? message : undefined,
      logs: [...job.logs, { at: now, level: (state === 'failed' ? 'error' : 'info') as JobLogLine['level'], message }].slice(-MAX_JOB_LOGS),
    }
    const receipts = [receipt, ...this.#receipts.filter((item) => item.id !== jobId)].slice(0, MAX_RECEIPTS)
    const document: ReceiptDocument = { version: 1, receipts }
    const serialized = `${JSON.stringify(document, null, 2)}\n`
    if (!isJobReceipt(receipt) || Buffer.byteLength(serialized, 'utf8') > MAX_RECEIPT_BYTES) {
      this.#log.error('任务凭证内容超过安全上限，拒绝写入；已恢复的 jobs.json 不受影响。')
      return false
    }
    try {
      writeJson(this.#receiptFile, document, { mode: 0o600 })
      this.#receipts = receipts
      const index = this.#jobs.findIndex((item) => item.id === jobId)
      if (index >= 0) this.#jobs[index] = receipt
      return true
    } catch (error) {
      this.#log.error(`任务凭证写入失败（不影响已恢复的 jobs.json）：${(error as Error).message}`)
      return false
    }
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
        jobId: job.id,
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
    if (this.#persistenceSuspended) return
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
