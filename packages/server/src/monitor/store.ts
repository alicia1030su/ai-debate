/**
 * Monitoring targets, persisted.
 *
 * A monitor is a standing instruction: "watch this thread, and when someone
 * answers, do the analysis I would have done by hand". That makes it different
 * from a setting and closer to a subscription — losing it on restart would silently
 * stop work the owner believes is running, which is worse than a visible error.
 *
 * ## Why the cursor lives here
 *
 * The cursor (what has been seen, how much of the thread was covered, when the
 * last *complete* scan happened) rides in the same document as the target on
 * purpose. Splitting them would allow a crash to persist the cursor without the
 * target that explains it, or the reverse: a monitor that claims to have scanned
 * a thread it no longer knows the URL of.
 *
 * ## The rule that matters
 *
 * **A cursor only advances when the scan that would advance it is complete and the
 * replies it found are in the same write.** `applyScan` enforces this by
 * constructing one document that contains both and writing it once. If the write
 * fails, the in-memory state is not updated either, so a failed save cannot leave
 * a monitor that believes it is further along than the disk does.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeJson, readJsonWithBackup } from '../atomic.ts'

/** The smallest interval a monitor may be configured with, in seconds. */
export const MIN_INTERVAL_SEC = 120
/** Default re-read window for the compensating scan. */
export const DEFAULT_COMPENSATION_HOURS = 24
/** Upper bound on the compensating window, so a full history walk stays explicit. */
export const MAX_COMPENSATION_HOURS = 168
/** Cap on remembered post ids per monitor; ~1k is months of a busy thread. */
const MAX_SEEN = 1000
/** Cap on recorded differences, so a vandalised thread cannot grow the file. */
const MAX_CHANGES = 200

export interface MonitorCounters {
  /** Replies ever accepted into the pipeline for this target. */
  readonly discovered: number
  /** Analyses that produced a session. */
  readonly analyzed: number
  /** Candidates produced and waiting for a human. */
  readonly candidates: number
  readonly failures: number
  /** UTC date (`YYYY-MM-DD`) the daily counters belong to. */
  readonly day: string
  readonly todayDiscovered: number
  readonly todayCandidates: number
  readonly todayFailures: number
}

/** Platform-facing health, deliberately separate from task failure. */
export type PlatformState =
  | 'healthy'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'network_error'
  | 'egress_blocked'
  | 'adapter_error'
  | 'paused'

/** How much of the thread the last scan actually looked at. */
export type ScanCoverage = 'tail' | 'full'

export interface ScanRecord {
  readonly at: string
  /** Whether the read covered everything it set out to cover. */
  readonly complete: boolean
  readonly coverage: ScanCoverage
  readonly pagesRead: number
  readonly totalPages?: number
  /** Replies the platform returned, before de-duplication. */
  readonly repliesSeen: number
  /** Why the scan was incomplete, when it was. */
  readonly incompleteReason?: string
}

export interface CursorState {
  /** Replies whose content was last confirmed, keyed by post id. */
  readonly fingerprints: Record<string, string>
  /** Newest post id accepted, for the operator's benefit (not used for ordering). */
  lastSeenPostId?: string
  lastSeenAt?: string
  /** Only scans with `complete === true` move this. */
  lastCompleteScanAt?: string
  /** The last scan of any kind. */
  lastScanAt?: string
  lastCoverage?: ScanCoverage
}

export type ChangeKind = 'edited' | 'deleted' | 'restored'

export interface MonitorChange {
  readonly at: string
  readonly postId: string
  readonly kind: ChangeKind
  /** Short human-readable note; never the full reply body. */
  readonly note: string
}

export interface MonitorTarget {
  readonly id: string
  readonly name: string
  readonly platform: string
  readonly url: string
  readonly threadId: string
  /** Free-text label for the platform account that reads it, for the operator. */
  readonly accountLabel?: string
  /** `true` when the scheduler may pick it up. */
  readonly enabled: boolean
  /** Poll interval in seconds; never below {@link MIN_INTERVAL_SEC}. */
  readonly intervalSec: number
  readonly createdAt: string
  updatedAt: string
  /** When the scheduler last started a check. */
  lastCheckAt?: string
  /** When a check last completed without error. */
  lastSuccessAt?: string
  lastError?: string
  lastErrorAt?: string
  /** Current platform read state. Model failures do not change this. */
  platformState: PlatformState
  /** Set when the platform told us the credentials are gone; clears on resume. */
  blockedReason?: string
  /** Post ids already accepted into the pipeline, newest last. */
  seen: string[]
  /**
   * When the first successful read happened.
   *
   * The first scan is a *baseline*: every reply already in the thread is old news,
   * and analysing a two-hundred-floor backlog because someone pressed "monitor"
   * would spend real money to answer month-old posts. Until this is set, a scan
   * seeds the cursor and analyses nothing.
   */
  baselineAt?: string
  /** Cursor fields; absent on files written before v0.2.1. */
  cursor?: CursorState
  /** Last scan attempt and its coverage. */
  lastScan?: ScanRecord
  /** Re-read window for the compensating scan, in hours. `0` disables it. */
  compensationHours: number
  lastCompensationAt?: string
  /** Differences found by compensating scans, newest last. */
  changes: MonitorChange[]
  counters: MonitorCounters
}

export type MonitorInput = {
  readonly name: string
  readonly url: string
  readonly platform?: string
  readonly accountLabel?: string
  readonly intervalSec?: number
  readonly enabled?: boolean
  readonly compensationHours?: number
}

export type MonitorPatch = {
  readonly name?: string
  readonly intervalSec?: number
  readonly enabled?: boolean
  readonly accountLabel?: string
  readonly compensationHours?: number
}

interface MonitorDocument {
  version: 2
  monitors: MonitorTarget[]
}

/** What one scan found, as handed to {@link MonitorStore.applyScan}. */
export interface ScanInput {
  readonly at: string
  readonly coverage: ScanCoverage
  readonly complete: boolean
  readonly pagesRead: number
  readonly totalPages?: number
  readonly incompleteReason?: string
  readonly replies: readonly { postId: string; fingerprint: string }[]
}

export interface ScanOutcome {
  /** Post ids not previously known. */
  readonly fresh: readonly string[]
  /** Known posts whose content changed. */
  readonly changed: readonly string[]
  /** Known posts absent from a full scan. */
  readonly removed: readonly string[]
  /** Whether the cursor moved. */
  readonly cursorAdvanced: boolean
}

function today(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

function freshCounters(): MonitorCounters {
  return {
    discovered: 0,
    analyzed: 0,
    candidates: 0,
    failures: 0,
    day: today(),
    todayDiscovered: 0,
    todayCandidates: 0,
    todayFailures: 0,
  }
}

/** Roll the daily counters when the date changed. */
function rollover(counters: MonitorCounters): MonitorCounters {
  const now = today()
  if (counters.day === now) return counters
  return { ...counters, day: now, todayDiscovered: 0, todayCandidates: 0, todayFailures: 0 }
}

/** Fill in fields a v0.2.0 file did not have. */
function upgradeMonitor(raw: MonitorTarget & { compensationHours?: number; changes?: MonitorChange[] }): MonitorTarget {
  return {
    ...raw,
    compensationHours:
      typeof raw.compensationHours === 'number'
        ? Math.max(0, Math.min(MAX_COMPENSATION_HOURS, Math.round(raw.compensationHours)))
        : DEFAULT_COMPENSATION_HOURS,
    changes: Array.isArray(raw.changes) ? raw.changes : [],
    seen: Array.isArray(raw.seen) ? raw.seen : [],
    platformState: raw.platformState ?? (raw.blockedReason ? 'paused' : 'healthy'),
  }
}

export class MonitorStore {
  readonly #file: string
  readonly #backup: string
  readonly #log: { warn(message: string): void }
  readonly #onEvent: (event: 'corrupt' | 'restored' | 'write_failed', detail: Record<string, unknown>) => void
  #monitors: MonitorTarget[] = []
  #loadError: string | undefined
  #saveError: string | undefined

  constructor(options: {
    file: string
    log: { warn(message: string): void }
    onEvent?: (event: 'corrupt' | 'restored' | 'write_failed', detail: Record<string, unknown>) => void
  }) {
    this.#file = options.file
    this.#backup = `${options.file}.bak`
    this.#log = options.log
    this.#onEvent = options.onEvent ?? (() => undefined)
  }

  get loadError(): string | undefined {
    return this.#loadError
  }

  get saveError(): string | undefined {
    return this.#saveError
  }

  load(): { migrated: boolean } {
    if (!existsSync(this.#file)) {
      this.#monitors = []
      return { migrated: false }
    }
    const loaded = readJsonWithBackup<MonitorDocument>(this.#file, this.#backup)
    if (loaded.restoredFromBackup) {
      this.#onEvent('restored', { file: this.#file, aside: loaded.aside })
      this.#log.warn(`${this.#file} 无法解析，已从备份恢复；损坏文件保留在 ${loaded.aside ?? '(复制失败)'}`)
    }
    if (loaded.value === undefined) {
      // Never start from empty when a file existed: that would silently delete
      // every standing instruction. Keep the damaged file and refuse to work.
      this.#loadError = `监控配置无法解析，且没有可用备份。原文件保留，监控未启动。`
      this.#onEvent('corrupt', { file: this.#file, aside: loaded.aside })
      this.#log.warn(this.#loadError)
      this.#monitors = []
      return { migrated: false }
    }
    const document = loaded.value as MonitorDocument & { version?: number }
    if (!Array.isArray(document.monitors)) {
      this.#loadError = '监控配置结构不认识（monitors 不是数组）。原文件保留。'
      this.#onEvent('corrupt', { file: this.#file })
      this.#log.warn(this.#loadError)
      this.#monitors = []
      return { migrated: false }
    }
    const migrated = document.version !== 2
    this.#monitors = document.monitors.map((monitor) => upgradeMonitor(monitor))
    return { migrated }
  }

  /**
   * Write the loaded document back once, in the current shape.
   *
   * Called after a migration so the file on disk stops being a v0.2.0 document that
   * happens to be readable. Without it, every restart would re-run the same field
   * defaulting and a future refusal of the old shape would strand the installation.
   */
  save(): void {
    this.#commit(this.#monitors)
  }

  list(): readonly MonitorTarget[] {
    return this.#monitors
  }

  get(id: string): MonitorTarget | undefined {
    return this.#monitors.find((monitor) => monitor.id === id)
  }

  findByThread(platform: string, threadId: string): MonitorTarget | undefined {
    return this.#monitors.find((monitor) => monitor.platform === platform && monitor.threadId === threadId)
  }

  create(input: MonitorInput, resolved: { platform: string; threadId: string }): MonitorTarget {
    const now = new Date().toISOString()
    const interval = Math.max(MIN_INTERVAL_SEC, Math.round(input.intervalSec ?? 300))
    const monitor: MonitorTarget = {
      id: randomUUID(),
      name: input.name.trim() === '' ? input.url : input.name.trim(),
      platform: resolved.platform,
      url: input.url,
      threadId: resolved.threadId,
      ...(input.accountLabel === undefined || input.accountLabel.trim() === ''
        ? {}
        : { accountLabel: input.accountLabel.trim() }),
      enabled: input.enabled ?? true,
      intervalSec: interval,
      createdAt: now,
      updatedAt: now,
      seen: [],
      compensationHours:
        input.compensationHours === undefined
          ? DEFAULT_COMPENSATION_HOURS
          : Math.max(0, Math.min(MAX_COMPENSATION_HOURS, Math.round(input.compensationHours))),
      changes: [],
      platformState: 'healthy',
      counters: freshCounters(),
    }
    this.#commit([...this.#monitors, monitor])
    return monitor
  }

  update(id: string, patch: MonitorPatch): MonitorTarget | undefined {
    const index = this.#monitors.findIndex((monitor) => monitor.id === id)
    if (index < 0) return undefined
    const current = this.#monitors[index] as MonitorTarget
    const next: MonitorTarget = {
      ...current,
      ...(patch.name === undefined ? {} : { name: patch.name.trim() === '' ? current.name : patch.name.trim() }),
      ...(patch.intervalSec === undefined
        ? {}
        : { intervalSec: Math.max(MIN_INTERVAL_SEC, Math.round(patch.intervalSec)) }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.accountLabel === undefined ? {} : { accountLabel: patch.accountLabel }),
      ...(patch.compensationHours === undefined
        ? {}
        : {
            compensationHours: Math.max(0, Math.min(MAX_COMPENSATION_HOURS, Math.round(patch.compensationHours))),
          }),
      updatedAt: new Date().toISOString(),
    }
    this.#commit(this.#replace(index, next))
    return next
  }

  remove(id: string): boolean {
    const next = this.#monitors.filter((monitor) => monitor.id !== id)
    if (next.length === this.#monitors.length) return false
    this.#commit(next)
    return true
  }

  /** Record the outcome of one scheduled check. */
  noteCheck(id: string, outcome: { at: string; ok: boolean; error?: string; platformState?: PlatformState }): void {
    const index = this.#indexOf(id)
    if (index < 0) return
    const current = this.#monitors[index] as MonitorTarget
    const next: MonitorTarget = {
      ...current,
      lastCheckAt: outcome.at,
      platformState: outcome.ok ? 'healthy' : (outcome.platformState ?? 'adapter_error'),
      ...(outcome.ok ? { lastSuccessAt: outcome.at, lastError: undefined, lastErrorAt: undefined } : {}),
      ...(outcome.ok || outcome.error === undefined ? {} : { lastError: outcome.error, lastErrorAt: outcome.at }),
      updatedAt: outcome.at,
    }
    this.#commit(this.#replace(index, next))
  }

  /**
   * Apply one scan: new replies, changed replies, removed replies, and the cursor,
   * in a single durable write.
   *
   * Returns what changed so the caller can enqueue analyses for the *new* ids only
   * and record differences for the others. The order of operations is the whole
   * point: nothing is reported as accepted until the document containing it is on
   * disk.
   */
  applyScan(id: string, scan: ScanInput): ScanOutcome {
    const index = this.#indexOf(id)
    if (index < 0) return { fresh: [], changed: [], removed: [], cursorAdvanced: false }
    const current = this.#monitors[index] as MonitorTarget
    const known = new Set(current.seen)
    const previous = current.cursor?.fingerprints ?? {}

    const fresh: string[] = []
    const changed: string[] = []
    const seenThisScan = new Set<string>()
    const fingerprints: Record<string, string> = { ...previous }
    for (const reply of scan.replies) {
      if (reply.postId === '') continue
      // A page boundary can repeat a floor, and two pages read in one scan can
      // overlap. Counting the same id twice would inflate `discovered` and queue
      // the same analysis twice.
      if (seenThisScan.has(reply.postId)) continue
      seenThisScan.add(reply.postId)
      const before = previous[reply.postId]
      if (!known.has(reply.postId)) {
        fresh.push(reply.postId)
      } else if (before !== undefined && before !== reply.fingerprint) {
        changed.push(reply.postId)
      }
      fingerprints[reply.postId] = reply.fingerprint
    }

    // A tail scan cannot prove absence: only a full read may report deletions.
    const present = new Set(scan.replies.map((reply) => reply.postId))
    const removed = scan.coverage === 'full' ? current.seen.filter((postId) => !present.has(postId)) : []

    const now = scan.at
    const nextSeen = [...current.seen, ...fresh].slice(-MAX_SEEN)
    // Keep fingerprints for retained ids only, so the map cannot outgrow the cursor.
    const keptFingerprints: Record<string, string> = {}
    for (const postId of nextSeen) {
      const value = fingerprints[postId]
      if (value !== undefined) keptFingerprints[postId] = value
    }

    const changes: MonitorChange[] = [...current.changes]
    for (const postId of changed) {
      changes.push({ at: now, postId, kind: 'edited', note: '内容或楼中楼结构发生变化' })
    }
    for (const postId of removed) {
      changes.push({ at: now, postId, kind: 'deleted', note: '全量重查时该发言已不存在' })
    }

    const counters = rollover(current.counters)
    const nextCounters: MonitorCounters = {
      ...counters,
      discovered: counters.discovered + fresh.length,
      todayDiscovered: counters.todayDiscovered + fresh.length,
    }

    // The cursor moves only on a complete scan. An incomplete read still records
    // what it saw (so the same reply is not queued twice) but does not claim the
    // thread has been read up to this point.
    const cursor: CursorState = {
      fingerprints: keptFingerprints,
      ...(nextSeen.length === 0 ? {} : { lastSeenPostId: nextSeen[nextSeen.length - 1] as string }),
      ...(fresh.length === 0 ? {} : { lastSeenAt: now }),
      ...(scan.complete
        ? { lastCompleteScanAt: now }
        : current.cursor?.lastCompleteScanAt === undefined
          ? {}
          : { lastCompleteScanAt: current.cursor.lastCompleteScanAt }),
      lastScanAt: now,
      lastCoverage: scan.coverage,
    }

    const next: MonitorTarget = {
      ...current,
      seen: nextSeen,
      cursor,
      lastScan: {
        at: now,
        complete: scan.complete,
        coverage: scan.coverage,
        pagesRead: scan.pagesRead,
        ...(scan.totalPages === undefined ? {} : { totalPages: scan.totalPages }),
        repliesSeen: scan.replies.length,
        ...(scan.incompleteReason === undefined ? {} : { incompleteReason: scan.incompleteReason }),
      },
      changes: changes.slice(-MAX_CHANGES),
      counters: nextCounters,
      updatedAt: now,
    }

    this.#commit(this.#replace(index, next))
    return { fresh, changed, removed, cursorAdvanced: scan.complete }
  }

  /** Record that the baseline scan completed. */
  markBaseline(id: string, at: string): void {
    const index = this.#indexOf(id)
    if (index < 0) return
    const current = this.#monitors[index] as MonitorTarget
    this.#commit(this.#replace(index, { ...current, baselineAt: at, updatedAt: at }))
  }

  markCompensated(id: string, at: string): void {
    const index = this.#indexOf(id)
    if (index < 0) return
    const current = this.#monitors[index] as MonitorTarget
    this.#commit(this.#replace(index, { ...current, lastCompensationAt: at }))
  }

  /** Count one analysed session / candidate / failure against a monitor. */
  noteOutcome(id: string, outcome: 'analyzed' | 'candidate' | 'failure'): void {
    const index = this.#indexOf(id)
    if (index < 0) return
    const current = this.#monitors[index] as MonitorTarget
    const counters = rollover(current.counters)
    const nextCounters: MonitorCounters =
      outcome === 'analyzed'
        ? { ...counters, analyzed: counters.analyzed + 1 }
        : outcome === 'candidate'
          ? { ...counters, candidates: counters.candidates + 1, todayCandidates: counters.todayCandidates + 1 }
          : { ...counters, failures: counters.failures + 1, todayFailures: counters.todayFailures + 1 }
    this.#commit(this.#replace(index, { ...current, counters: nextCounters, updatedAt: new Date().toISOString() }))
  }

  /** Mark a target blocked by an authentication failure. */
  block(id: string, reason: string): void {
    const index = this.#indexOf(id)
    if (index < 0) return
    const current = this.#monitors[index] as MonitorTarget
    const at = new Date().toISOString()
    this.#commit(
      this.#replace(index, {
        ...current,
        enabled: false,
        blockedReason: reason,
        platformState: 'paused',
        lastError: reason,
        lastErrorAt: at,
        updatedAt: at,
      }),
    )
  }

  /** Clear the blocked flag when the owner resumes the target. */
  clearBlock(id: string): void {
    const index = this.#indexOf(id)
    if (index < 0) return
    const current = this.#monitors[index] as MonitorTarget
    this.#commit(this.#replace(index, { ...current, blockedReason: undefined, platformState: 'healthy', updatedAt: new Date().toISOString() }))
  }

  #indexOf(id: string): number {
    return this.#monitors.findIndex((monitor) => monitor.id === id)
  }

  #replace(index: number, next: MonitorTarget): MonitorTarget[] {
    return [...this.#monitors.slice(0, index), next, ...this.#monitors.slice(index + 1)]
  }

  /**
   * Write first, then adopt.
   *
   * Assigning to `#monitors` before the write would leave memory ahead of disk
   * whenever the write throws (a full disk, a revoked permission). The next read
   * would then serve data that does not exist on disk, and a restart would silently
   * roll it back. Persisting first makes "the write succeeded" the only condition
   * under which the change is visible.
   */
  #commit(next: MonitorTarget[]): void {
    try {
      writeJson(
        this.#file,
        { version: 2, monitors: next } satisfies MonitorDocument,
        { mode: 0o600, backup: this.#backup },
      )
    } catch (error) {
      this.#saveError = error instanceof Error ? error.message : String(error)
      this.#onEvent('write_failed', { file: this.#file, reason: this.#saveError })
      throw error
    }
    this.#monitors = next
    this.#saveError = undefined
  }

  /** Exposed for the status centre: whether the last write succeeded. */
  get writable(): boolean {
    return this.#saveError === undefined
  }
}
