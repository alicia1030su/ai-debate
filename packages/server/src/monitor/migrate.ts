/**
 * Strict one-time migration from the v0.2.1 reply ledgers to the global identity
 * fence, with safe incremental repair on later starts.
 *
 * v0.2.1 only knew replies inside a monitor (`seen`/`cursor`) or a queue row.
 * v0.2.2 de-duplicates globally, so an upgrade must reconstruct those facts before
 * the engine starts. The precedence is deliberate:
 *
 *   core candidate > active task claim > terminal task / monitor-only ignored
 *
 * The identity ledger is written first. Task keys are backfilled afterwards in a
 * single task-ledger write. Only then is a completion marker committed. A crash in
 * either window is repaired on the next start without replacing newer identities.
 * Once complete, changed source digests trigger an additive pass: existing identity
 * evidence always wins, and only previously unknown keys are added.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { AutoTaskKind, AutoTaskState, AutoTaskStore } from './tasks.ts'
import {
  replyIdentityKey,
  type IdentityMigrationSources,
  type ReplyIdentity,
  type ReplyIdentityState,
  type ReplyIdentityStore,
} from './identities.ts'

/** Queue states that still represent work which must not be replayed. */
const ACTIVE_STATES: ReadonlySet<AutoTaskState> = new Set([
  'pending',
  'running',
  'retry_wait',
  'blocked',
])

const TASK_STATES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'completed',
  'retry_wait',
  'needs_review',
  'blocked',
  'failed',
  'cancelled',
])

const TASK_KINDS: ReadonlySet<AutoTaskKind> = new Set([
  'probe',
  'analyze',
  'generate',
  'compensate',
])

interface MigrationOptions {
  readonly monitorsFile: string
  readonly tasksFile: string
  readonly stateFile: string
  readonly identities: ReplyIdentityStore
  readonly tasks: AutoTaskStore
  readonly log?: { warn(message: string): void }
  /** Test seam; production uses the current time. */
  readonly now?: string
}

export interface IdentityMigrationResult {
  readonly completed: boolean
  readonly alreadyComplete: boolean
  readonly identityWritten: boolean
  readonly identitiesAdded: number
  readonly identities: number
  readonly candidates: number
  readonly claimed: number
  readonly ignored: number
  readonly tasksBackfilled: number
  /** Retained for callers that display non-fatal diagnostics; strict parsing now throws. */
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

interface ReplyContext {
  readonly platform: string
  readonly threadId: string
  readonly monitorId: string
  readonly fingerprints: Map<string, string>
}

interface CoreCandidate {
  readonly sessionId: string
  readonly candidateId: string
  readonly approved: boolean
  readonly published: boolean
  readonly version: number
}

interface SourceDocument {
  readonly value: Record<string, unknown>
  readonly digest: string | null
}

interface ParsedIdentityKey {
  readonly platform: string
  readonly threadId: string
  readonly postId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function requiredString(row: Record<string, unknown>, key: string, label: string): string {
  const value = row[key]
  if (!nonEmpty(value) || value !== value.trim()) throw new Error(`${label}.${key} 必须是非空且无首尾空白的字符串。`)
  return value
}

function optionalString(row: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = row[key]
  if (value === undefined) return undefined
  if (!nonEmpty(value) || value !== value.trim()) throw new Error(`${label}.${key} 必须是非空且无首尾空白的字符串。`)
  return value
}

/** Reject unknown task kinds without echoing untrusted ledger contents into diagnostics. */
function readTaskKind(row: Record<string, unknown>, label: string): AutoTaskKind {
  const kind = requiredString(row, 'kind', label)
  if (!TASK_KINDS.has(kind as AutoTaskKind)) {
    throw new Error(`${label}.kind 不是受支持的任务类型。`)
  }
  return kind as AutoTaskKind
}

function readTaskCandidateId(value: unknown, label: string): string | undefined {
  if (!isRecord(value)) throw new Error(`${label}.modelCall 不是对象。`)
  return optionalString(value, 'candidateId', `${label}.modelCall`)
}

function strictArray(value: unknown, label: string): Record<string, unknown>[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} 不是数组。`)
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${label}[${index}] 不是对象。`)
    return entry
  })
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} 不是数组。`)
  return value.map((entry, index) => {
    if (!nonEmpty(entry) || entry !== entry.trim()) throw new Error(`${label}[${index}] 不是有效字符串。`)
    return entry
  })
}

function digest(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

/** Read and parse one source once; the marker hashes exactly the bytes parsed. */
function readSource(file: string, label: string, required: boolean): SourceDocument {
  if (!existsSync(file)) {
    if (required) throw new Error(`${label} 不存在，无法安全迁移回复身份。`)
    return { value: {}, digest: null }
  }
  let contents: string
  try {
    contents = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`${label} 无法读取：${error instanceof Error ? error.message : String(error)}`)
  }
  let value: unknown
  try {
    value = JSON.parse(contents) as unknown
  } catch {
    // Node's JSON parser may quote a fragment of the damaged document. Never
    // copy that fragment into logs, audit records or the diagnostics API.
    throw new Error(`${label} 无法解析（JSON 语法错误）`)
  }
  if (!isRecord(value)) throw new Error(`${label} 顶层不是对象。`)
  return { value, digest: digest(contents) }
}

function currentDigest(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    return digest(readFileSync(file))
  } catch (error) {
    throw new Error(`无法读取迁移源文件 ${file}：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Deterministic non-empty fingerprint for old rows that predate cursor fingerprints. */
function legacyFingerprint(platform: string, threadId: string, postId: string): string {
  const hash = createHash('sha256')
    .update(`v021-reply:${platform}:${threadId}:${postId}`, 'utf8')
    .digest('hex')
    .slice(0, 32)
  return `legacy-${hash}`
}

function threadKey(context: { platform: string; threadId: string }): string {
  return `${context.platform}:${context.threadId}`
}

function parseIdentityKey(key: string): ParsedIdentityKey | undefined {
  const stable = /^stable:([^:]+):([^:]+):(.+)$/.exec(key)
  if (stable !== null) {
    return { platform: stable[1] as string, threadId: stable[2] as string, postId: stable[3] as string }
  }
  const fallback = /^fallback:([^:]+):([^:]+):(.+)$/.exec(key)
  if (fallback !== null) return { platform: fallback[1] as string, threadId: fallback[2] as string }
  return undefined
}

const STATE_PRIORITY: Readonly<Record<ReplyIdentityState, number>> = {
  ignored: 0,
  claimed: 1,
  candidate: 2,
}

function sameSources(left: IdentityMigrationSources, right: IdentityMigrationSources): boolean {
  return left.state === right.state && left.monitors === right.monitors && left.tasks === right.tasks
}

function chooseCandidate(
  existing: CoreCandidate,
  incoming: CoreCandidate,
  referenced: ReadonlySet<string>,
  label: string,
): CoreCandidate {
  if (existing.candidateId === incoming.candidateId) {
    if (existing.sessionId !== incoming.sessionId) throw new Error(`${label} 的候选 ID 跨会话重复，无法安全选择。`)
    return existing
  }
  const existingReferenced = referenced.has(existing.candidateId)
  const incomingReferenced = referenced.has(incoming.candidateId)
  if (existingReferenced !== incomingReferenced) return existingReferenced ? existing : incoming
  if (existing.published !== incoming.published) return existing.published ? existing : incoming
  if (existing.approved !== incoming.approved) return existing.approved ? existing : incoming
  if (existing.version !== incoming.version) return existing.version > incoming.version ? existing : incoming
  throw new Error(`${label} 存在无法证明优先级的候选冲突，无法安全选择。`)
}

/**
 * Reconstruct and persist global reply identities before the automation engine
 * starts. Malformed sources, missing context and ambiguous approved candidates are
 * fatal; no partial identity or task write is allowed to stand in for completion.
 */
export function migrateLegacyReplyIdentities(options: MigrationOptions): IdentityMigrationResult {
  const now = options.now ?? new Date().toISOString()
  const warnings: string[] = []
  const monitorSource = readSource(options.monitorsFile, 'monitors.json', false)
  const taskSource = readSource(options.tasksFile, 'auto-tasks.json', false)
  const stateSource = readSource(options.stateFile, 'state.json', false)
  const rawTasks = strictArray(taskSource.value.tasks, 'auto-tasks.json.tasks')
  const sources: IdentityMigrationSources = {
    state: stateSource.digest,
    monitors: monitorSource.digest,
    tasks: taskSource.digest,
  }
  // Validate the complete task enum before the completion-marker fast path. An
  // unknown kind must never be treated as an ignorable row and certified complete.
  for (const [index, task] of rawTasks.entries()) {
    readTaskKind(task, `auto-tasks.json.tasks[${index}]`)
  }
  const marker = options.identities.migration
  if (marker !== undefined && sameSources(marker.sources, sources)) {
    const stats = options.identities.stats()
    return {
      completed: true,
      alreadyComplete: true,
      identityWritten: false,
      identitiesAdded: 0,
      identities: stats.total,
      candidates: stats.candidate,
      claimed: stats.claimed,
      ignored: stats.ignored,
      tasksBackfilled: 0,
      errors: [],
      warnings,
    }
  }

  const monitors = strictArray(monitorSource.value.monitors, 'monitors.json.monitors')
  const monitorById = new Map<string, ReplyContext>()
  const contextByThread = new Map<string, ReplyContext>()
  for (const [index, monitor] of monitors.entries()) {
    const label = `monitors.json.monitors[${index}]`
    const id = requiredString(monitor, 'id', label)
    const platform = requiredString(monitor, 'platform', label)
    const threadId = requiredString(monitor, 'threadId', label)
    const fingerprints = new Map<string, string>()
    if (monitor.cursor !== undefined) {
      if (!isRecord(monitor.cursor)) throw new Error(`${label}.cursor 不是对象。`)
      if (monitor.cursor.fingerprints !== undefined) {
        if (!isRecord(monitor.cursor.fingerprints)) throw new Error(`${label}.cursor.fingerprints 不是对象。`)
        for (const [postId, fingerprint] of Object.entries(monitor.cursor.fingerprints)) {
          if (postId === '' || !nonEmpty(fingerprint) || fingerprint !== fingerprint.trim()) {
            throw new Error(`${label}.cursor.fingerprints 包含无效条目。`)
          }
          fingerprints.set(postId, fingerprint)
        }
      }
    }
    stringArray(monitor.seen, `${label}.seen`)
    const context: ReplyContext = { platform, threadId, monitorId: id, fingerprints }
    const prior = monitorById.get(id)
    if (prior !== undefined && threadKey(prior) !== threadKey(context)) {
      throw new Error(`监控 ${id} 被重复用于不同帖子，无法安全迁移。`)
    }
    monitorById.set(id, context)
    const key = threadKey(context)
    const existing = contextByThread.get(key)
    if (existing === undefined) {
      contextByThread.set(key, context)
    } else {
      for (const [postId, fingerprint] of fingerprints) {
        const previous = existing.fingerprints.get(postId)
        if (previous !== undefined && previous !== fingerprint) {
          warnings.push(`帖子 ${key}:${postId} 的旧游标指纹冲突，保留先出现的证据。`)
        }
        if (previous === undefined) existing.fingerprints.set(postId, fingerprint)
      }
    }
  }

  const taskCandidateIds = new Set<string>()
  if (stateSource.digest === null) {
    for (const [index, task] of rawTasks.entries()) {
      const label = `auto-tasks.json.tasks[${index}]`
      const kind = readTaskKind(task, label)
      if (kind !== 'analyze' && kind !== 'generate') continue
      const sessionId = optionalString(task, 'sessionId', label)
      const candidateId = task.modelCall === undefined ? undefined : readTaskCandidateId(task.modelCall, label)
      if (sessionId !== undefined || candidateId !== undefined) {
        throw new Error(`${label} 引用核心会话或候选，但 state.json 不存在，无法安全迁移。`)
      }
    }
  }
  for (const [index, task] of rawTasks.entries()) {
    const label = `auto-tasks.json.tasks[${index}]`
    const kind = readTaskKind(task, label)
    if (kind !== 'analyze' && kind !== 'generate' || task.modelCall === undefined) continue
    const candidateId = readTaskCandidateId(task.modelCall, label)
    if (candidateId !== undefined) taskCandidateIds.add(candidateId)
  }

  const sessions = new Map<string, { platform: string; threadId: string }>()
  const candidates = new Map<string, CoreCandidate>()
  for (const [index, session] of strictArray(stateSource.value.sessions, 'state.json.sessions').entries()) {
    const label = `state.json.sessions[${index}]`
    const id = requiredString(session, 'id', label)
    const platform = requiredString(session, 'platform', label)
    const threadId = requiredString(session, 'threadId', label)
    const context = { platform, threadId }
    const prior = sessions.get(id)
    if (prior !== undefined && threadKey(prior) !== threadKey(context)) {
      throw new Error(`核心会话 ${id} 被重复用于不同帖子，无法安全迁移。`)
    }
    sessions.set(id, context)
    for (const [candidateIndex, candidate] of strictArray(session.candidates, `${label}.candidates`).entries()) {
      const candidateLabel = `${label}.candidates[${candidateIndex}]`
      const targetPostId = requiredString(candidate, 'targetPostId', candidateLabel)
      const candidateId = requiredString(candidate, 'replyId', candidateLabel)
      const approved = candidate.approved === undefined ? false : candidate.approved
      if (typeof approved !== 'boolean') throw new Error(`${candidateLabel}.approved 不是布尔值。`)
      const publishedPostId = optionalString(candidate, 'publishedPostId', candidateLabel)
      const rawVersion = candidate.candidateVersion === undefined ? 1 : candidate.candidateVersion
      if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion) || rawVersion < 1) {
        throw new Error(`${candidateLabel}.candidateVersion 不是正整数。`)
      }
      const replyContext = contextByThread.get(threadKey(context)) ?? {
        ...context,
        monitorId: `legacy:${platform}:${threadId}`,
        fingerprints: new Map<string, string>(),
      }
      const key = replyIdentityKey({
        ...replyContext,
        postId: targetPostId,
        quality: 'stable',
        fingerprint: replyContext.fingerprints.get(targetPostId) ?? legacyFingerprint(platform, threadId, targetPostId),
      })
      const incoming: CoreCandidate = {
        sessionId: id,
        candidateId,
        approved,
        published: publishedPostId !== undefined,
        version: rawVersion,
      }
      const existing = candidates.get(key)
      candidates.set(key, existing === undefined ? incoming : chooseCandidate(existing, incoming, taskCandidateIds, candidateLabel))
    }
  }

  const knownCandidateIds = new Set([...candidates.values()].map((candidate) => candidate.candidateId))
  for (const candidateId of taskCandidateIds) {
    if (!knownCandidateIds.has(candidateId)) {
      throw new Error(`任务 modelCall 引用的候选 ${candidateId} 不在 state.json 中，无法安全迁移。`)
    }
  }

  const entries = new Map<string, ReplyIdentity>()
  const upsert = (
    context: ReplyContext,
    postId: string,
    state: ReplyIdentityState,
    detail: { sessionId?: string; candidateId?: string; reason?: string } = {},
  ): string => {
    const fingerprint = context.fingerprints.get(postId) ?? legacyFingerprint(context.platform, context.threadId, postId)
    const key = replyIdentityKey({
      platform: context.platform,
      threadId: context.threadId,
      postId,
      quality: 'stable',
      fingerprint,
    })
    const existing = entries.get(key)
    if (existing !== undefined && STATE_PRIORITY[existing.state] > STATE_PRIORITY[state]) return key
    const preferRealMonitor = existing === undefined
      || existing.monitorId.startsWith('legacy:')
      || !context.monitorId.startsWith('legacy:')
    const preferRealFingerprint = existing === undefined
      || !existing.fingerprint.startsWith('legacy:')
      || !fingerprint.startsWith('legacy-')
    entries.set(key, {
      key,
      platform: context.platform,
      threadId: context.threadId,
      postId,
      quality: 'stable',
      fingerprint: preferRealFingerprint ? fingerprint : existing.fingerprint,
      monitorId: preferRealMonitor ? context.monitorId : existing.monitorId,
      state,
      ...(detail.sessionId === undefined ? {} : { sessionId: detail.sessionId }),
      ...(detail.candidateId === undefined ? {} : { candidateId: detail.candidateId }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(state === 'ignored' ? { lastError: detail.reason ?? 'legacy-reply' } : {}),
    })
    return key
  }

  // Core candidates are authoritative and are inserted before queue/monitor rows.
  for (const [key, candidate] of candidates) {
    const parsed = parseIdentityKey(key)
    if (parsed?.postId === undefined) continue
    const context = contextByThread.get(`${parsed.platform}:${parsed.threadId}`) ?? {
      platform: parsed.platform,
      threadId: parsed.threadId,
      monitorId: `legacy:${parsed.platform}:${parsed.threadId}`,
      fingerprints: new Map<string, string>(),
    }
    upsert(context, parsed.postId, 'candidate', candidate)
  }

  const assignments = new Map<string, readonly string[]>()
  for (const [index, task] of rawTasks.entries()) {
    const label = `auto-tasks.json.tasks[${index}]`
    const id = requiredString(task, 'id', label)
    const kind = readTaskKind(task, label)
    const state = requiredString(task, 'state', label)
    if (!TASK_STATES.has(state)) throw new Error(`${label}.state 不认识：${state}`)
    if (kind !== 'analyze' && kind !== 'generate') continue

    const monitorId = optionalString(task, 'monitorId', label)
    const sessionId = optionalString(task, 'sessionId', label)
    if (sessionId !== undefined && !sessions.has(sessionId)) {
      throw new Error(`${label} 引用的核心会话 ${sessionId} 不在 state.json 中，无法安全迁移。`)
    }
    const dedupeKey = optionalString(task, 'dedupeKey', label) ?? ''
    const parts = dedupeKey.split(':')
    const dedupeOwner = parts.length >= 3 ? parts[1] : undefined
    const postIds = new Set(stringArray(task.postIds, `${label}.postIds`))
    for (const postId of stringArray(task.postId === undefined ? undefined : [task.postId], `${label}.postId`)) {
      if (postId !== 'full') postIds.add(postId)
    }
    if (postIds.size === 0 && parts.length >= 3 && parts[0] !== 'probe' && parts[0] !== 'compensate') {
      const fallback = parts.at(-1)
      if (nonEmpty(fallback) && fallback !== 'full') postIds.add(fallback)
    }

    const identityKey = optionalString(task, 'identityKey', label)
    const rawKeys = [
      ...stringArray(task.identityKeys, `${label}.identityKeys`),
      ...(identityKey === undefined ? [] : [identityKey]),
    ]
    const parsedKeys: ParsedIdentityKey[] = []
    for (const key of rawKeys) {
      const parsed = parseIdentityKey(key)
      if (parsed === undefined) throw new Error(`${label} 包含无法识别的全局身份键：${key}`)
      parsedKeys.push(parsed)
      if (parsed.postId !== undefined) postIds.add(parsed.postId)
    }

    const contexts: ReplyContext[] = []
    const addContext = (context: ReplyContext | undefined): void => {
      if (context !== undefined && !contexts.some((entry) => threadKey(entry) === threadKey(context))) contexts.push(context)
    }
    addContext(monitorId === undefined ? undefined : monitorById.get(monitorId))
    if (sessionId !== undefined) {
      const session = sessions.get(sessionId)
      if (session !== undefined) addContext(contextByThread.get(threadKey(session)) ?? {
        ...session,
        monitorId: `legacy:${session.platform}:${session.threadId}`,
        fingerprints: new Map<string, string>(),
      })
    }
    if (dedupeOwner !== undefined) {
      addContext(monitorById.get(dedupeOwner))
      const session = sessions.get(dedupeOwner)
      if (session !== undefined) addContext(contextByThread.get(threadKey(session)) ?? {
        ...session,
        monitorId: `legacy:${session.platform}:${session.threadId}`,
        fingerprints: new Map<string, string>(),
      })
    }
    for (const parsed of parsedKeys) {
      addContext(contextByThread.get(`${parsed.platform}:${parsed.threadId}`) ?? {
        platform: parsed.platform,
        threadId: parsed.threadId,
        monitorId: `legacy:${parsed.platform}:${parsed.threadId}`,
        fingerprints: new Map<string, string>(),
      })
    }
    if (contexts.length > 1) throw new Error(`${label} 的监控、会话、dedupeKey 与身份键指向不同帖子，无法安全迁移。`)
    const context = contexts[0]
    if (context === undefined) {
      if (postIds.size > 0 || rawKeys.length > 0) throw new Error(`${label} 找不到监控或核心会话上下文，无法安全迁移。`)
      continue
    }

    const keys = [...rawKeys]
    const active = ACTIVE_STATES.has(state as AutoTaskState)
    for (const postId of postIds) {
      const candidate = candidates.get(replyIdentityKey({
        platform: context.platform,
        threadId: context.threadId,
        postId,
        quality: 'stable',
        fingerprint: context.fingerprints.get(postId) ?? legacyFingerprint(context.platform, context.threadId, postId),
      }))
      keys.push(upsert(
        context,
        postId,
        candidate === undefined ? (active ? 'claimed' : 'ignored') : 'candidate',
        candidate ?? (active ? {} : { reason: 'legacy-task-terminal' }),
      ))
    }
    const uniqueKeys = [...new Set(keys)]
    if (uniqueKeys.length > 0) assignments.set(id, uniqueKeys)
  }

  // Anything only present in a monitor cursor is old news, not an unclaimed reply.
  for (const monitor of monitors) {
    const context = monitorById.get(requiredString(monitor, 'id', 'monitors.json.monitors'))
    if (context === undefined) continue
    const postIds = new Set(stringArray(monitor.seen, 'monitors.json.monitors.seen'))
    for (const postId of context.fingerprints.keys()) postIds.add(postId)
    for (const postId of postIds) upsert(context, postId, 'ignored', { reason: 'legacy-seen' })
  }

  for (const warning of warnings) options.log?.warn(`回复身份迁移：${warning}`)

  const ordered = [...entries.values()].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  // Create-only and atomic. A throw here happens before task backfill.
  const identityWritten = options.identities.replaceAllForMigration(ordered)
  const identitiesAdded = identityWritten ? ordered.length : options.identities.mergeForMigration(ordered)
  // Idempotent repair for a crash between the identity and task writes.
  const tasksBackfilled = options.tasks.backfillIdentityKeys(assignments, now)
  // Capture the post-backfill task bytes so an unchanged second start is a no-op.
  options.identities.completeMigration({
    state: 'complete',
    completedAt: now,
    sources: { ...sources, tasks: currentDigest(options.tasksFile) },
  })

  const stats = options.identities.stats()
  return {
    completed: true,
    alreadyComplete: false,
    identityWritten,
    identitiesAdded,
    identities: stats.total,
    candidates: stats.candidate,
    claimed: stats.claimed,
    ignored: stats.ignored,
    tasksBackfilled,
    errors: [],
    warnings,
  }
}
