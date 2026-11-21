/**
 * Global reply identity fence.
 *
 * A monitor is a *view* of a thread, not the owner of a reply. Two monitors can
 * point at the same post (different names, different intervals, one created by
 * mistake), and both tail reads can see the same new floor. De-duplicating inside
 * one monitor cannot prevent that: the second monitor would happily enqueue a
 * second analysis and a second model call.
 *
 * This store is the durable, global answer to "has this platform reply ever been
 * claimed?". Its key is deliberately independent of monitor and session:
 *
 *     stable:  <platform>:<threadId>:<postId>
 *     fallback:<platform>:<threadId>:sha256(normalised content)
 *
 * Tieba exposes stable post ids, so it uses the first form. A platform that does
 * not expose one must say so (`identityQuality: 'fallback'`); the fallback is
 * content-based and therefore cannot distinguish an edit from a new reply. The
 * caller records that limitation instead of pretending the id is stable.
 *
 * ## Ordering
 *
 * The claim is persisted *before* an analysis task is enqueued. If the process
 * dies between those two writes, startup finds a claimed identity with no active
 * task and re-enqueues it. If the process dies after enqueue, the task's durable
 * key prevents a second one. A candidate id is written back only after the core
 * store has produced it, so a crash in that window is repaired by the existing
 * candidate check rather than by another model call.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeJson, readJsonWithBackup } from '../atomic.ts'

export type ReplyIdentityQuality = 'stable' | 'fallback'
export type ReplyIdentityState = 'claimed' | 'candidate' | 'ignored'

export interface ReplyIdentity {
  readonly key: string
  readonly platform: string
  readonly threadId: string
  readonly postId: string
  readonly quality: ReplyIdentityQuality
  readonly fingerprint: string
  readonly monitorId: string
  state: ReplyIdentityState
  sessionId?: string
  candidateId?: string
  readonly createdAt: string
  updatedAt: string
  lastError?: string
}

/** Source digests captured by the last completed legacy migration. */
export interface IdentityMigrationSources {
  readonly state: string | null
  readonly monitors: string | null
  readonly tasks: string | null
}

/** Durable completion marker for the legacy-to-global identity migration. */
export interface IdentityMigrationMarker {
  readonly state: 'complete'
  readonly completedAt: string
  readonly sources: IdentityMigrationSources
}

interface IdentityDocument {
  version: 1
  entries: ReplyIdentity[]
  migration?: IdentityMigrationMarker
}

export interface ClaimInput {
  readonly platform: string
  readonly threadId: string
  readonly postId: string
  readonly quality: ReplyIdentityQuality
  readonly fingerprint: string
  readonly monitorId: string
}

export interface ClaimResult {
  readonly identity: ReplyIdentity
  readonly fresh: boolean
}

/** Build the global key. Empty ids are never allowed to become a shared identity. */
export function replyIdentityKey(input: {
  platform: string
  threadId: string
  postId: string
  quality: ReplyIdentityQuality
  fingerprint: string
}): string {
  if (input.platform === '' || input.threadId === '') throw new Error('回复身份缺少平台或帖子 ID')
  if (input.quality === 'stable') {
    if (input.postId === '') throw new Error('稳定回复身份缺少回复 ID')
    return `stable:${input.platform}:${input.threadId}:${input.postId}`
  }
  if (input.fingerprint === '') throw new Error('内容回退身份缺少指纹')
  return `fallback:${input.platform}:${input.threadId}:${input.fingerprint}`
}

export class ReplyIdentityStore {
  readonly #file: string
  readonly #backup: string
  readonly #log: { warn(message: string): void }
  readonly #onEvent: (event: 'corrupt' | 'restored' | 'write_failed', detail: Record<string, unknown>) => void
  #entries: ReplyIdentity[] = []
  #migration: IdentityMigrationMarker | undefined
  #restoredFromBackup = false
  #index = new Map<string, ReplyIdentity>()
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

  get migration(): IdentityMigrationMarker | undefined {
    return this.#migration
  }

  get restoredFromBackup(): boolean {
    return this.#restoredFromBackup
  }

  load(): void {
    if (!existsSync(this.#file)) return
    const loaded = readJsonWithBackup<IdentityDocument>(this.#file, this.#backup)
    if (loaded.restoredFromBackup) {
      this.#restoredFromBackup = true
      this.#onEvent('restored', { file: this.#file, aside: loaded.aside })
      this.#log.warn(`${this.#file} 无法解析，已从备份恢复`)
    }
    if (loaded.value === undefined || !validDocument(loaded.value)) {
      this.#entries = []
      this.#migration = undefined
      this.#rebuildIndex()
      this.#loadError = '全局回复身份台账无法解析或结构不认识，原文件保留。'
      this.#onEvent('corrupt', { file: this.#file, aside: loaded.aside })
      this.#log.warn(this.#loadError)
      return
    }
    this.#entries = loaded.value.entries
    this.#migration = loaded.value.migration
    this.#rebuildIndex()
  }

  all(): readonly ReplyIdentity[] {
    return this.#entries
  }

  /**
   * Publish a complete legacy migration in one atomic write.
   *
   * This is intentionally create-only: an existing identity ledger is newer
   * evidence and must never be replaced by a best-effort reconstruction. The
   * caller can still backfill task keys on later boots, which repairs the small
   * crash window between this write and the task-ledger write.
   *
   * @returns true when this call created the ledger, false when it already existed
   */
  replaceAllForMigration(entries: readonly ReplyIdentity[]): boolean {
    this.#validateEntries(entries)
    if (existsSync(this.#file)) return false
    this.#commit([...entries])
    return true
  }

  /**
   * Add identities absent from the live ledger without replacing newer evidence.
   *
   * This is the safe incremental path after a completed migration sees new core
   * candidates, or after a crash between the identity and task-ledger writes.
   */
  mergeForMigration(entries: readonly ReplyIdentity[]): number {
    this.#validateEntries(entries)
    const additions: ReplyIdentity[] = []
    for (const entry of entries) {
      const existing = this.#index.get(entry.key)
      if (existing === undefined) {
        additions.push(entry)
        continue
      }
      if (existing.state !== entry.state
        || (existing.state === 'candidate' && (existing.candidateId !== entry.candidateId || existing.sessionId !== entry.sessionId))) {
        throw new Error(`既有回复身份与重建结果冲突：${entry.key}`)
      }
    }
    if (additions.length === 0) return 0
    this.#commit([...additions, ...this.#entries])
    return additions.length
  }

  /** Mark migration complete only after identity and task writes both succeeded. */
  completeMigration(marker: IdentityMigrationMarker): void {
    if (!validMigration(marker)) {
      throw new Error('回复身份迁移完成标记无效。')
    }
    this.#commit(this.#entries, marker)
  }

  get(key: string): ReplyIdentity | undefined {
    return this.#index.get(key)
  }

  /** Claim a reply once. A second monitor gets the same record, `fresh: false`. */
  claim(input: ClaimInput, at = new Date().toISOString()): ClaimResult {
    const key = replyIdentityKey(input)
    const existing = this.#index.get(key)
    if (existing !== undefined) return { identity: existing, fresh: false }
    const identity: ReplyIdentity = {
      key,
      platform: input.platform,
      threadId: input.threadId,
      postId: input.postId,
      quality: input.quality,
      fingerprint: input.fingerprint,
      monitorId: input.monitorId,
      state: 'claimed',
      createdAt: at,
      updatedAt: at,
    }
    this.#commit([identity, ...this.#entries])
    return { identity, fresh: true }
  }

  /** Attach the session that analysed the reply. */
  attachSession(key: string, sessionId: string, at = new Date().toISOString()): void {
    const current = this.#index.get(key)
    if (current === undefined) return
    this.#commit(this.#replace({ ...current, sessionId, updatedAt: at }))
  }

  /** Record that the core store now owns a candidate for this reply. */
  markCandidate(key: string, detail: { sessionId?: string; candidateId: string }, at = new Date().toISOString()): void {
    if (!validString(detail.candidateId)) throw new Error('候选 ID 无效。')
    const current = this.#index.get(key)
    if (current === undefined) return
    this.#commit(
      this.#replace({
        ...current,
        state: 'candidate',
        ...(detail.sessionId === undefined ? {} : { sessionId: detail.sessionId }),
        candidateId: detail.candidateId,
        updatedAt: at,
      }),
    )
  }

  /** Record a deliberate no-candidate decision; other monitors must not retry it. */
  markIgnored(key: string, reason: string, at = new Date().toISOString()): void {
    if (!validString(reason)) throw new Error('忽略原因无效。')
    const current = this.#index.get(key)
    if (current === undefined) return
    this.#commit(this.#replace({ ...current, state: 'ignored', lastError: reason, updatedAt: at }))
  }

  /**
   * Claims with no live task. Startup calls this after loading both ledgers.
   *
   * `activeKeys` comes from the task ledger and contains only pending, running,
   * retry_wait, or still-blocked work. Terminal tasks do not cover a claim: the
   * engine checks for an existing candidate and then either resumes the missing
   * stage or closes the identity as ignored. This store deliberately does not
   * infer task semantics or reopen a model call while pruning history.
   */
  orphans(activeKeys: ReadonlySet<string>): readonly ReplyIdentity[] {
    return this.#entries.filter((entry) => entry.state === 'claimed' && !activeKeys.has(entry.key))
  }

  stats(): { total: number; claimed: number; candidate: number; ignored: number; fallback: number } {
    let claimed = 0
    let candidate = 0
    let ignored = 0
    let fallback = 0
    for (const entry of this.#entries) {
      if (entry.state === 'claimed') claimed += 1
      else if (entry.state === 'candidate') candidate += 1
      else ignored += 1
      if (entry.quality === 'fallback') fallback += 1
    }
    return { total: this.#entries.length, claimed, candidate, ignored, fallback }
  }

  #replace(next: ReplyIdentity): ReplyIdentity[] {
    return this.#entries.map((entry) => (entry.key === next.key ? next : entry))
  }

  #rebuildIndex(): void {
    this.#index = new Map(this.#entries.map((entry) => [entry.key, entry]))
  }

  #validateEntries(entries: readonly ReplyIdentity[]): void {
    if (!validEntries(entries)) {
      throw new Error('回复身份台账包含无效、不一致或重复条目。')
    }
  }

  #commit(next: ReplyIdentity[], migration: IdentityMigrationMarker | undefined = this.#migration): void {
    if (this.#loadError !== undefined) {
      throw new Error('回复身份台账加载失败，拒绝覆盖原文件。')
    }
    if (!validMigration(migration)) {
      throw new Error('回复身份迁移完成标记无效。')
    }
    if (!validDocument({
      version: 1,
      entries: next,
      ...(migration === undefined ? {} : { migration }),
    })) {
      throw new Error('回复身份台账包含无效、不一致或重复条目。')
    }
    try {
      writeJson(this.#file, {
        version: 1,
        entries: next,
        ...(migration === undefined ? {} : { migration }),
      } satisfies IdentityDocument, {
        mode: 0o600,
        backup: this.#backup,
      })
    } catch (error) {
      this.#saveError = error instanceof Error ? error.message : String(error)
      this.#onEvent('write_failed', { file: this.#file, reason: this.#saveError })
      throw error
    }
    this.#entries = next
    this.#migration = migration
    this.#rebuildIndex()
    this.#saveError = undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** IDs and reasons are opaque text, but never blank or padded with whitespace. */
function validString(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && (allowEmpty || value !== '')
}

function validEntry(value: unknown, keys: Set<string>): value is ReplyIdentity {
  if (!isRecord(value)) return false
  const row = value
  const key = row.key
  const platform = row.platform
  const threadId = row.threadId
  const postId = row.postId
  const quality = row.quality
  const fingerprint = row.fingerprint
  const monitorId = row.monitorId
  const state = row.state
  if (!validString(key) || keys.has(key)) return false
  if (!validString(platform) || !validString(threadId) || !validString(monitorId)) return false
  if (state !== 'claimed' && state !== 'candidate' && state !== 'ignored') return false
  if (quality !== 'stable' && quality !== 'fallback') return false
  if (typeof postId !== 'string' || !validString(postId, quality === 'fallback')) return false
  if (quality === 'stable' && postId === '') return false
  if (!validString(fingerprint)) return false
  if (!validString(row.createdAt) || !Number.isFinite(Date.parse(row.createdAt))) return false
  if (!validString(row.updatedAt) || !Number.isFinite(Date.parse(row.updatedAt))) return false

  // The key is derived evidence. Accepting a key that disagrees with its row
  // would let two monitors address different replies through one fence entry.
  const expectedKey = quality === 'stable'
    ? `stable:${platform}:${threadId}:${postId}`
    : `fallback:${platform}:${threadId}:${fingerprint}`
  if (key !== expectedKey) return false

  if (row.sessionId !== undefined && !validString(row.sessionId)) return false
  if (row.candidateId !== undefined && !validString(row.candidateId)) return false
  if (row.lastError !== undefined && !validString(row.lastError)) return false
  if (state === 'candidate' && !validString(row.candidateId)) return false
  if (state === 'ignored' && !validString(row.lastError)) return false
  keys.add(key)
  return true
}

function validEntries(value: unknown): value is ReplyIdentity[] {
  if (!Array.isArray(value)) return false
  const keys = new Set<string>()
  return value.every((entry) => validEntry(entry, keys))
}

function validDocument(value: unknown): value is IdentityDocument {
  return isRecord(value)
    && value.version === 1
    && validEntries(value.entries)
    && validMigration(value.migration)
}

function validMigration(value: unknown): value is IdentityMigrationMarker | undefined {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  if (value.state !== 'complete' || !validString(value.completedAt) || !Number.isFinite(Date.parse(value.completedAt))) return false
  const sources = value.sources
  if (!isRecord(sources)) return false
  return ['state', 'monitors', 'tasks'].every((key) => sources[key] === null
    || (typeof sources[key] === 'string' && /^[a-f0-9]{64}$/.test(sources[key] as string)))
}
