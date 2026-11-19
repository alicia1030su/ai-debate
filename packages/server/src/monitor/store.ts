/**
 * Monitoring targets, persisted.
 *
 * A monitor is a standing instruction: "watch this thread, and when someone
 * answers, do the analysis I would have done by hand". That makes it different
 * from a setting and closer to a subscription — losing it on restart would silently
 * stop work the owner believes is running, which is worse than a visible error.
 *
 * Everything lives in one JSON document written through `writeJson`'s
 * temp-file-and-rename: a torn write leaves the previous version, never a
 * half-parsed file. The cursor (which posts have been seen) rides in the same
 * document on purpose — splitting it would let a crash persist the cursor without
 * the target that explains it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { writeJson } from '../atomic.ts'

/** The smallest interval a monitor may be configured with, in seconds. */
export const MIN_INTERVAL_SEC = 120

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
  counters: MonitorCounters
}

export type MonitorInput = {
  readonly name: string
  readonly url: string
  readonly platform?: string
  readonly accountLabel?: string
  readonly intervalSec?: number
  readonly enabled?: boolean
}

interface MonitorDocument {
  version: 1
  monitors: MonitorTarget[]
}

/** Cap on remembered post ids per monitor; ~1k is months of a busy thread. */
const MAX_SEEN = 1000

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

export class MonitorStore {
  readonly #file: string
  readonly #log: { warn(message: string): void }
  #monitors: MonitorTarget[] = []
  #loadError: string | undefined

  constructor(options: { file: string; log: { warn(message: string): void } }) {
    this.#file = options.file
    this.#log = options.log
  }

  get loadError(): string | undefined {
    return this.#loadError
  }

  load(): void {
    if (!existsSync(this.#file)) {
      this.#monitors = []
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf8')) as MonitorDocument
      if (parsed.version !== 1 || !Array.isArray(parsed.monitors)) throw new Error('结构不认识')
      this.#monitors = parsed.monitors.map((monitor) => ({ ...monitor, counters: rollover(monitor.counters) }))
    } catch (error) {
      // Never start from empty when the file exists: that would silently delete
      // every standing instruction. Keep the damaged file and report it.
      this.#loadError = `监控配置无法解析：${error instanceof Error ? error.message : String(error)}`
      this.#log.warn(`${this.#loadError}。原文件保留，监控未启动。`)
      this.#monitors = []
    }
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
      counters: freshCounters(),
    }
    this.#monitors = [...this.#monitors, monitor]
    this.#persist()
    return monitor
  }

  update(id: string, patch: Partial<Pick<MonitorTarget, 'name' | 'intervalSec' | 'enabled' | 'accountLabel'>>): MonitorTarget | undefined {
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
      updatedAt: new Date().toISOString(),
    }
    this.#monitors = [...this.#monitors.slice(0, index), next, ...this.#monitors.slice(index + 1)]
    this.#persist()
    return next
  }

  remove(id: string): boolean {
    const before = this.#monitors.length
    this.#monitors = this.#monitors.filter((monitor) => monitor.id !== id)
    if (this.#monitors.length === before) return false
    this.#persist()
    return true
  }

  /** Record the outcome of one scheduled check. */
  noteCheck(id: string, outcome: { at: string; ok: boolean; error?: string }): void {
    const index = this.#monitors.findIndex((monitor) => monitor.id === id)
    if (index < 0) return
    const current = this.#monitors[index] as MonitorTarget
    const next: MonitorTarget = {
      ...current,
      lastCheckAt: outcome.at,
      ...(outcome.ok ? { lastSuccessAt: outcome.at, lastError: undefined, lastErrorAt: undefined } : {}),
      ...(outcome.ok || outcome.error === undefined ? {} : { lastError: outcome.error, lastErrorAt: outcome.at }),
      updatedAt: outcome.at,
    }
    this.#monitors = [...this.#monitors.slice(0, index), next, ...this.#monitors.slice(index + 1)]
    this.#persist()
  }

  /**
   * Accept newly seen post ids and count them.
   *
   * Returns only the ids that were not already known, so the caller's "enqueue an
   * analysis for each new reply" loop cannot double-count a post that a previous
   * tick already saw. The write happens before the caller enqueues anything: a
   * crash in between loses work that a re-read will find again, whereas the
   * opposite order would create duplicates from a re-read.
   */
  acceptSeen(id: string, postIds: readonly string[]): readonly string[] {
    const index = this.#monitors.findIndex((monitor) => monitor.id === id)
    if (index < 0) return []
    const current = this.#monitors[index] as MonitorTarget
    const known = new Set(current.seen)
    const fresh = postIds.filter((postId) => !known.has(postId))
    if (fresh.length === 0) return []
    const merged = [...current.seen, ...fresh]
    const counters = rollover(current.counters)
    const nextCounters: MonitorCounters = {
      ...counters,
      discovered: counters.discovered + fresh.length,
      todayDiscovered: counters.todayDiscovered + fresh.length,
    }
    const next: MonitorTarget = {
      ...current,
      seen: merged.slice(-MAX_SEEN),
      counters: nextCounters,
      updatedAt: new Date().toISOString(),
    }
    this.#monitors = [...this.#monitors.slice(0, index), next, ...this.#monitors.slice(index + 1)]
    this.#persist()
    return fresh
  }

  /** Count one analysed session / candidate / failure against a monitor. */
  noteOutcome(id: string, outcome: 'analyzed' | 'candidate' | 'failure'): void {
    const index = this.#monitors.findIndex((monitor) => monitor.id === id)
    if (index < 0) return
    const current = this.#monitors[index] as MonitorTarget
    const counters = rollover(current.counters)
    const nextCounters: MonitorCounters =
      outcome === 'analyzed'
        ? { ...counters, analyzed: counters.analyzed + 1 }
        : outcome === 'candidate'
          ? { ...counters, candidates: counters.candidates + 1, todayCandidates: counters.todayCandidates + 1 }
          : { ...counters, failures: counters.failures + 1, todayFailures: counters.todayFailures + 1 }
    const next: MonitorTarget = { ...current, counters: nextCounters, updatedAt: new Date().toISOString() }
    this.#monitors = [...this.#monitors.slice(0, index), next, ...this.#monitors.slice(index + 1)]
    this.#persist()
  }

  /** Record that the baseline scan completed. */
  markBaseline(id: string, at: string): void {
    const index = this.#monitors.findIndex((monitor) => monitor.id === id)
    if (index < 0) return
    const current = this.#monitors[index] as MonitorTarget
    const next: MonitorTarget = { ...current, baselineAt: at, updatedAt: at }
    this.#monitors = [...this.#monitors.slice(0, index), next, ...this.#monitors.slice(index + 1)]
    this.#persist()
  }

  /** Mark a target blocked by an authentication failure. */
  block(id: string, reason: string): void {
    const index = this.#monitors.findIndex((monitor) => monitor.id === id)
    if (index < 0) return
    const current = this.#monitors[index] as MonitorTarget
    const next: MonitorTarget = {
      ...current,
      enabled: false,
      blockedReason: reason,
      lastError: reason,
      lastErrorAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    this.#monitors = [...this.#monitors.slice(0, index), next, ...this.#monitors.slice(index + 1)]
    this.#persist()
  }

  /** Clear the blocked flag when the owner resumes the target. */
  clearBlock(id: string): void {
    const index = this.#monitors.findIndex((monitor) => monitor.id === id)
    if (index < 0) return
    const current = this.#monitors[index] as MonitorTarget
    const next: MonitorTarget = { ...current, blockedReason: undefined, updatedAt: new Date().toISOString() }
    this.#monitors = [...this.#monitors.slice(0, index), next, ...this.#monitors.slice(index + 1)]
    this.#persist()
  }

  #persist(): void {
    writeJson(this.#file, { version: 1, monitors: this.#monitors } satisfies MonitorDocument, { mode: 0o600 })
  }
}
