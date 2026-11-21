/**
 * Resumable v0.2.2 soak harness.
 *
 * This is not a simulated pipeline. `AutomationEngine`, `MonitorStore`,
 * `AutoTaskStore`, `ReplyIdentityStore`, `runAnalysis`, and `runGeneration` are
 * the production implementations. Only the platform reads are scripted in bulk
 * and the model is a local OpenAI-compatible double. No real platform is called.
 *
 * Usage:
 *   node --experimental-transform-types test/stress/soak-v022.ts --seconds=3 --monitors=20 --seed=1
 *   node scripts/run-soak.mjs --seconds=86400 --monitors=1000 --kill-every=300
 *   node --experimental-transform-types test/stress/soak-v022.ts --seconds=7 --disk-chance=1 --disk-store=monitors
 *   node --experimental-transform-types --test test/stress/soak-v022.ts --self-test
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG, resolveConfig } from '../../packages/core/lib/config.js'
import { buildRuntime } from '../../packages/core/lib/index.js'
import { fingerprintOf } from '../../packages/core/lib/probe.js'
import { runAnalysis, runGeneration } from '../../packages/core/lib/runtime.js'
import { DebateStore, type StoredCandidate, type StoredSession, type StoreData } from '../../packages/core/lib/store.js'
import { PlatformRegistry } from '../../packages/core/lib/platforms/registry.js'
import type { DebateProductApi, ProbeResult, SessionSummary } from '../../packages/core/lib/product-api.js'
import { writeJson } from '../../packages/server/src/atomic.ts'
import { AutomationEngine, type EngineStatus } from '../../packages/server/src/monitor/engine.ts'
import { MonitorStore, type MonitorTarget } from '../../packages/server/src/monitor/store.ts'
import { AutoTaskStore } from '../../packages/server/src/monitor/tasks.ts'
import { ReplyIdentityStore, replyIdentityKey } from '../../packages/server/src/monitor/identities.ts'
import { FakeAdapter, type FakeReplySeed } from '../support/fake-adapter.ts'
import {
  DiskWriteFault,
  FaultInjector,
  type DiskStoreName,
  type FaultInjectorOptions,
  type FaultInjectorSnapshot,
} from '../support/soak-faults.ts'

const PLATFORM = 'faketieba'
const STATE_VERSION = 2 as const
const MAX_HEAP_MB = 512
const MAX_THREAD_REPLIES = 12
const MONITOR_INTERVAL_SEC = 2 * 24 * 60 * 60
const OWNER_POST_ID = 'f1'
const BASELINE_POST_ID = 'f2'

const quiet = {
  debug: (_message: string): void => undefined,
  info: (_message: string): void => undefined,
  warn: (_message: string): void => undefined,
  error: (_message: string): void => undefined,
}

export interface SoakOptions {
  readonly seconds: number
  readonly deadline?: number
  readonly monitors: number
  readonly intervalMs: number
  readonly seed: number
  readonly stateFile?: string
  readonly resume: boolean
  readonly acknowledgeFailures: boolean
  readonly killEvery: number
  readonly noKill: boolean
  readonly report?: string
  readonly threads: number
  readonly replyEveryMs: number
  readonly scanBatch: number
  readonly scanEveryMs: number
  readonly capacity: number
  readonly maxTickActiveMs: number
  readonly drainTimeoutMs: number
  readonly platformFaultChance: number
  readonly modelFaultChance: number
  readonly diskFaultChance: number
  readonly backlogFaultChance: number
  readonly duplicateReplyChance: number
  readonly diskStore?: DiskStoreName
  readonly selfTest: boolean
  readonly explicit: ReadonlySet<string>
}

export interface PersistedThread {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly replies: readonly FakeReplySeed[]
  readonly nextReply: number
}

export interface CursorWatermark {
  readonly lastScanAt?: string
  readonly lastCompleteScanAt?: string
  readonly seen: number
}

export interface LockTimeoutEvent {
  readonly at: string
  readonly taskKind: string
  readonly message: string
  readonly runningTasks: number
  readonly holderPid?: number
  readonly holderAt?: number
  readonly holderAgeMs?: number
  readonly holderAlive?: boolean
}

export interface SoakState {
  readonly version: typeof STATE_VERSION
  startedAt: string
  lastTickAt: string
  iterations: number
  scans: number
  analyses: number
  generations: number
  failures: number
  retries: number
  restarts: number
  kills: number
  activeMs: number
  maxTickActiveMs: number
  readonly tickActiveLimitMs: number
  readonly drainTimeoutMs: number
  drainSeconds: number
  drainTimedOut: boolean
  peakQueue: number
  peakLedger: number
  duplicateCandidates: number
  lostTasks: number
  lostTaskStrikes: number
  convergenceLag: number
  convergenceLagPeak: number
  stuckIdentity: number
  authBlockedIdentity: number
  coreLockTimeouts: number
  lockTimeoutEvents: LockTimeoutEvent[]
  cursorRegressions: number
  completedTaskReexecutions: number
  unrecordedInterruptions: number
  unhandledErrors: number
  memoryPeakMb: number
  cpuUsage: { userMicros: number; systemMicros: number }
  seed: number
  completed: boolean
  readonly dataDir: string
  readonly monitors: number
  readonly threads: number
  readonly capacity: number
  readonly replyEveryMs: number
  readonly scanBatch: number
  readonly scanEveryMs: number
  nextReplyAt: number
  totalRepliesCreated: number
  threadStates: PersistedThread[]
  cursorWatermarks: Record<string, CursorWatermark>
  faults: FaultInjectorSnapshot
  storeWriteFailures: number
  storeRestores: number
  storeCorruptions: number
  diskSessions: number
  diskStoreActual: Record<DiskStoreName, number>
  diskStoreSkipped: Record<DiskStoreName, number>
  degradedDiskSessions: number
  undegradedDiskSessions: number
  recoveredDiskBlockers: number
  backlogSessions: number
  operatorResumes: number
  queueRejections: number
  prunedRows: number
  stoppedAt?: string
  acknowledgedFailures: string[]
  invariantFailures: string[]
}

export interface SoakReport {
  readonly schemaVersion: 1
  readonly tool: 'soak-v022'
  readonly status: 'passed' | 'failed'
  readonly originalStartedAt: string
  readonly actualStartedAt: string
  readonly actualEndedAt: string
  readonly wallClockSeconds: number
  readonly cumulativeSeconds: number
  readonly requestedSeconds: number
  readonly killEverySeconds: number
  readonly noKill: boolean
  readonly resumed: boolean
  readonly resumedAfterFailure: boolean
  readonly monitors: number
  readonly threads: number
  readonly seed: number
  readonly stateFile: string
  readonly dataDir: string
  readonly iterations: number
  readonly scans: number
  readonly analyses: number
  readonly generations: number
  readonly modelCalls: number
  readonly candidates: number
  readonly failures: number
  readonly retries: number
  readonly restarts: number
  readonly kills: number
  readonly activeSeconds: number
  readonly maxTickActiveMs: number
  readonly tickActiveLimitMs: number
  readonly drainTimeoutMs: number
  readonly drainSeconds: number
  readonly drainTimedOut: boolean
  readonly memoryPeakMb: number
  readonly heapFinalMb: number
  readonly cpuUsage: { userMicros: number; systemMicros: number; percent: number }
  readonly peakQueue: number
  readonly queueCapacity: number
  readonly queueAtEnd: number
  readonly peakLedger: number
  readonly ledgerRowsAtEnd: number
  readonly pendingAtEnd: number
  readonly duplicateCandidates: number
  readonly lostTasks: number
  readonly convergenceLag: number
  readonly convergenceLagPeak: number
  readonly stuckIdentity: number
  readonly authBlockedIdentity: number
  readonly coreLockTimeouts: number
  readonly lockTimeoutEvents: readonly LockTimeoutEvent[]
  readonly cursorRegressions: number
  readonly completedTaskReexecutions: number
  readonly unrecordedInterruptions: number
  readonly unhandledErrors: number
  readonly completed: boolean
  readonly sharedThreadGroups: number
  readonly maxMonitorsPerThread: number
  readonly totalRepliesCreated: number
  readonly faults: ReturnType<FaultInjector['stats']>
  readonly recentFaults: ReturnType<FaultInjector['recent']>
  readonly diskTargets: readonly DiskStoreName[]
  readonly diskStoreActual: Readonly<Record<DiskStoreName, number>>
  readonly diskStoreSkipped: Readonly<Record<DiskStoreName, number>>
  readonly orphanSweepMs: number
  readonly storeWriteFailures: number
  readonly storeRestores: number
  readonly storeCorruptions: number
  readonly degradedDiskSessions: number
  readonly undegradedDiskSessions: number
  readonly recoveredDiskBlockers: number
  readonly backlogSessions: number
  readonly operatorResumes: number
  readonly queueRejections: number
  readonly prunedRows: number
  readonly stoppedAt?: string
  readonly acknowledgedFailures: readonly string[]
  readonly identities: ReturnType<ReplyIdentityStore['stats']>
  readonly engine?: EngineStatus
  readonly invariants: Readonly<Record<string, boolean>>
  readonly invariantFailures: readonly string[]
  readonly limitations: readonly string[]
}

interface ThreadRuntime {
  readonly id: string
  readonly url: string
  readonly title: string
  replies: FakeReplySeed[]
  nextReply: number
  readonly adapter: FakeAdapter
}

interface ModelServer {
  readonly server: Server
  readonly port: number
  readonly calls: () => number
}

interface SoakContext {
  readonly options: SoakOptions
  readonly state: SoakState
  readonly faults: FaultInjector
  readonly stateFile: string
  readonly monitorsFile: string
  readonly tasksFile: string
  readonly identitiesFile: string
  readonly monitors: MonitorStore
  readonly tasks: AutoTaskStore
  readonly identities: ReplyIdentityStore
  readonly store: DebateStore
  readonly runtime: ReturnType<typeof buildRuntime>
  readonly engine: AutomationEngine
  readonly model: ModelServer
  readonly threads: readonly ThreadRuntime[]
  readonly startedAtMs: number
}

interface ActiveDiskFault {
  readonly store: DiskStoreName
  readonly blocker: DiskWriteFault
  readonly until: number
  degraded: boolean
  recorded: boolean
  restore(): void
}

interface InvariantResult {
  readonly duplicateCandidates: number
  readonly lostTasks: number
  readonly convergenceLag: number
  readonly stuckIdentity: number
  readonly authBlockedIdentity: number
  readonly cursorRegressions: number
  readonly completedTaskReexecutions: number
  readonly failures: readonly string[]
}

function parseArguments(argv: readonly string[]): SoakOptions {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index] ?? ''
    if (!entry.startsWith('--')) continue
    const equals = entry.indexOf('=')
    if (equals >= 0) {
      values.set(entry.slice(2, equals), entry.slice(equals + 1))
      continue
    }
    const name = entry.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      values.set(name, next)
      index += 1
    } else {
      flags.add(name)
    }
  }

  const number = (name: string, fallback: number, minimum = 0, integer = false): number => {
    const raw = values.get(name)
    if (raw === undefined) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < minimum || (integer && !Number.isInteger(parsed))) {
      throw new Error(`--${name} 必须是 >= ${minimum}${integer ? ' 的整数' : ''}，实际 ${raw}`)
    }
    return parsed
  }
  const probability = (name: string, fallback: number): number => number(name, fallback, 0)
  const seconds = number('seconds', 86_400, 0.001)
  const monitors = number('monitors', 1_000, 1, true)
  const shortRun = seconds <= 10
  const intervalMs = number('interval-ms', shortRun ? 250 : 1_000, 10, true)
  const noFaults = flags.has('no-faults')
  const killEvery = noFaults ? 0 : number('kill-every', 0)
  const threads = Math.min(monitors, number('threads', shortRun ? Math.min(4, monitors) : Math.min(25, monitors), 1, true))
  const stateFile = values.get('state-file')
  const report = values.get('report')
  const diskStore = values.get('disk-store')
  if (diskStore !== undefined && diskStore !== 'auto_tasks' && diskStore !== 'monitors' && diskStore !== 'identities') {
    throw new Error('--disk-store 必须是 auto_tasks、monitors 或 identities')
  }

  const known = new Set([
    'seconds', 'deadline', 'monitors', 'interval-ms', 'seed', 'state-file', 'resume', 'kill-every',
    'no-kill', 'report', 'threads', 'reply-every-ms', 'scan-batch', 'scan-every-ms',
    'capacity', 'max-tick-active-ms', 'drain-timeout-ms', 'platform-fault-chance', 'model-fault-chance', 'disk-fault-chance',
    'backlog-fault-chance', 'duplicate-reply-chance', 'disk-store', 'acknowledge-failures', 'no-faults', 'self-test',
  ])
  for (const name of new Set([...values.keys(), ...flags])) {
    if (!known.has(name)) throw new Error(`不认识的参数：--${name}`)
  }

  return {
    seconds,
    ...(values.has('deadline') ? { deadline: number('deadline', 0, 0) } : {}),
    monitors,
    intervalMs,
    seed: number('seed', 1, 0, true),
    ...(stateFile === undefined ? {} : { stateFile: resolve(stateFile) }),
    resume: flags.has('resume'),
    acknowledgeFailures: flags.has('acknowledge-failures'),
    killEvery,
    noKill: flags.has('no-kill'),
    ...(report === undefined ? {} : { report: resolve(report) }),
    threads,
    replyEveryMs: number('reply-every-ms', shortRun ? 500 : 60_000, 50, true),
    scanBatch: Math.min(monitors, number('scan-batch', shortRun ? Math.min(8, monitors) : 1, 1, true)),
    scanEveryMs: number('scan-every-ms', shortRun ? intervalMs : 10_000, 10, true),
    capacity: Math.max(50, Math.min(20_000, number('capacity', Math.max(1_500, monitors + 500), 50, true))),
    maxTickActiveMs: number('max-tick-active-ms', 15_000, 250, true),
    drainTimeoutMs: number('drain-timeout-ms', 300_000, 250, true),
    platformFaultChance: noFaults ? 0 : probability('platform-fault-chance', 0.08),
    modelFaultChance: noFaults ? 0 : probability('model-fault-chance', 0.12),
    diskFaultChance: noFaults ? 0 : probability('disk-fault-chance', 0.01),
    backlogFaultChance: noFaults ? 0 : probability('backlog-fault-chance', 0.01),
    duplicateReplyChance: noFaults ? 0 : probability('duplicate-reply-chance', 0.08),
    ...(diskStore === undefined ? {} : { diskStore }),
    selfTest: flags.has('self-test'),
    explicit: new Set([...values.keys(), ...flags]),
  }
}

/** Create the complete initial state; no counter is inferred or reset on load. */
export function createSoakState(input: {
  startedAt: string
  now: number
  seed: number
  dataDir: string
  monitors: number
  threads: number
  capacity: number
  maxTickActiveMs: number
  drainTimeoutMs: number
  replyEveryMs: number
  scanBatch: number
  scanEveryMs: number
  faults: FaultInjectorSnapshot
}): SoakState {
  return {
    version: STATE_VERSION,
    startedAt: input.startedAt,
    lastTickAt: input.startedAt,
    iterations: 0,
    scans: 0,
    analyses: 0,
    generations: 0,
    failures: 0,
    retries: 0,
    restarts: 0,
    kills: 0,
    activeMs: 0,
    maxTickActiveMs: 0,
    tickActiveLimitMs: input.maxTickActiveMs,
    drainTimeoutMs: input.drainTimeoutMs,
    drainSeconds: 0,
    drainTimedOut: false,
    peakQueue: 0,
    peakLedger: 0,
    duplicateCandidates: 0,
    lostTasks: 0,
    lostTaskStrikes: 0,
    convergenceLag: 0,
    convergenceLagPeak: 0,
    stuckIdentity: 0,
    authBlockedIdentity: 0,
    coreLockTimeouts: 0,
    lockTimeoutEvents: [],
    cursorRegressions: 0,
    completedTaskReexecutions: 0,
    unrecordedInterruptions: 0,
    unhandledErrors: 0,
    memoryPeakMb: 0,
    cpuUsage: { userMicros: 0, systemMicros: 0 },
    seed: input.seed,
    completed: false,
    dataDir: input.dataDir,
    monitors: input.monitors,
    threads: input.threads,
    capacity: input.capacity,
    replyEveryMs: input.replyEveryMs,
    scanBatch: input.scanBatch,
    scanEveryMs: input.scanEveryMs,
    nextReplyAt: input.now + input.replyEveryMs,
    totalRepliesCreated: 0,
    threadStates: [],
    cursorWatermarks: {},
    faults: input.faults,
    storeWriteFailures: 0,
    storeRestores: 0,
    storeCorruptions: 0,
    diskSessions: 0,
    diskStoreActual: { auto_tasks: 0, monitors: 0, identities: 0 },
    diskStoreSkipped: { auto_tasks: 0, monitors: 0, identities: 0 },
    degradedDiskSessions: 0,
    undegradedDiskSessions: 0,
    recoveredDiskBlockers: 0,
    backlogSessions: 0,
    operatorResumes: 0,
    queueRejections: 0,
    prunedRows: 0,
    acknowledgedFailures: [],
    invariantFailures: [],
  }
}

/** Atomically persist the soak state. A failed write is fatal to the harness. */
export function saveSoakState(file: string, state: SoakState): void {
  mkdirSync(dirname(file), { recursive: true })
  writeJson(file, state, { mode: 0o600 })
}

/** Load and validate a soak state without silently starting over. */
export function loadSoakState(file: string): SoakState {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SoakState>
  if (parsed.version !== STATE_VERSION) throw new Error(`不认识的 soak 状态版本：${String(parsed.version)}`)
  const requiredNumbers = [
    'iterations', 'scans', 'analyses', 'generations', 'failures', 'retries', 'restarts',
    'kills', 'activeMs', 'maxTickActiveMs', 'tickActiveLimitMs', 'drainTimeoutMs', 'drainSeconds', 'peakQueue', 'peakLedger', 'duplicateCandidates', 'lostTasks',
    'cursorRegressions', 'completedTaskReexecutions', 'unrecordedInterruptions',
    'unhandledErrors', 'memoryPeakMb', 'seed', 'monitors', 'threads', 'capacity',
  ] as const
  for (const key of requiredNumbers) {
    if (typeof parsed[key] !== 'number' || !Number.isFinite(parsed[key]) || parsed[key] < 0) {
      throw new Error(`soak 状态字段 ${key} 缺失、不是数字或为负数`)
    }
  }
  if (parsed.tickActiveLimitMs! < 250) throw new Error('soak tick active 上限无效')
  if (parsed.drainTimeoutMs! < 250) throw new Error('soak 排空超时上限无效')
  if (parsed.maxTickActiveMs! > parsed.tickActiveLimitMs!) {
    throw new Error('soak maxTickActiveMs 超过持久上限')
  }
  for (const key of ['startedAt', 'lastTickAt', 'dataDir'] as const) {
    if (typeof parsed[key] !== 'string') throw new Error(`soak 状态字段 ${key} 缺失`)
  }
  if (typeof parsed.completed !== 'boolean') throw new Error('soak 状态字段 completed 缺失')
  if (typeof parsed.drainTimedOut !== 'boolean') throw new Error('soak 状态字段 drainTimedOut 缺失')
  if (!Array.isArray(parsed.threadStates) || !Array.isArray(parsed.invariantFailures)) {
    throw new Error('soak 状态的 threadStates / invariantFailures 结构不正确')
  }
  if (parsed.faults === undefined || parsed.cpuUsage === undefined || parsed.cursorWatermarks === undefined) {
    throw new Error('soak 状态的 faults / cpuUsage / cursorWatermarks 缺失')
  }
  parsed.diskStoreActual ??= { auto_tasks: 0, monitors: 0, identities: 0 }
  parsed.diskStoreSkipped ??= { auto_tasks: 0, monitors: 0, identities: 0 }
  parsed.convergenceLag ??= 0
  parsed.convergenceLagPeak ??= 0
  parsed.stuckIdentity ??= 0
  parsed.authBlockedIdentity ??= 0
  parsed.coreLockTimeouts ??= 0
  parsed.lockTimeoutEvents ??= []
  parsed.acknowledgedFailures ??= []
  return parsed as SoakState
}

function baseReplies(threadId: string, createdAt: string): FakeReplySeed[] {
  return [
    { postId: OWNER_POST_ID, author: '楼主', authorId: 'owner-handle', content: '现在的年轻人根本不愿意吃苦，一点委屈都受不了。', createdAt },
    { postId: BASELINE_POST_ID, author: '对方', authorId: 'rival', content: '你这话太绝对了，我身边很多人加班到很晚。', createdAt },
  ]
}

function makeThreads(state: SoakState): ThreadRuntime[] {
  const persisted = new Map(state.threadStates.map((thread) => [thread.id, thread]))
  return Array.from({ length: state.threads }, (_unused, index) => {
    const id = `t${String(index + 1).padStart(3, '0')}`
    const url = `https://fake.example/p/${id}`
    const title = `Soak 共享帖 ${id}`
    const saved = persisted.get(id)
    const replies = saved === undefined
      ? baseReplies(id, state.startedAt)
      : saved.replies.map((reply) => ({ ...reply }))
    const adapter = new FakeAdapter(
      { platform: PLATFORM, threadId: id, title, url, body: '楼主开场白。', bodyAuthor: '楼主' },
      replies,
    )
    return {
      id,
      url,
      title,
      replies,
      nextReply: saved?.nextReply ?? 1,
      adapter,
    }
  })
}

function persistThreads(state: SoakState, threads: readonly ThreadRuntime[]): void {
  state.threadStates = threads.map((thread) => ({
    id: thread.id,
    url: thread.url,
    title: thread.title,
    replies: thread.replies.map((reply) => ({ ...reply })),
    nextReply: thread.nextReply,
  }))
}

function appendReply(thread: ThreadRuntime, at: string): void {
  const postId = `r${thread.nextReply}`
  thread.nextReply += 1
  const reply: FakeReplySeed = {
    postId,
    author: '对方',
    authorId: 'rival',
    content: `第 ${thread.nextReply} 条新回复：你只看到了身边的例子，不能代表所有人。`,
    createdAt: at,
  }
  const rivals = thread.replies.filter((entry) => entry.postId !== OWNER_POST_ID)
  rivals.push(reply)
  thread.replies = [thread.replies.find((entry) => entry.postId === OWNER_POST_ID) ?? baseReplies(thread.id, at)[0]!, ...rivals.slice(-(MAX_THREAD_REPLIES - 1))]
  thread.adapter.setReplies(thread.replies)
}

/** Routes one registered fake platform to the adapter for the requested thread. */
class RoutingFakeAdapter extends FakeAdapter {
  readonly #byThread: ReadonlyMap<string, FakeAdapter>
  readonly #fallback: FakeAdapter

  constructor(threads: readonly ThreadRuntime[]) {
    const first = threads[0]
    if (first === undefined) throw new Error('soak 至少需要一个线程')
    super({ platform: PLATFORM, threadId: first.id, title: first.title, url: first.url })
    this.#byThread = new Map(threads.map((thread) => [thread.id, thread.adapter]))
    this.#fallback = first.adapter
  }

  parseUrl(url: string): { platform: string; threadId: string; url: string } {
    return { platform: PLATFORM, threadId: url.split('/').pop() ?? '', url }
  }

  override async getThread(ref: { threadId: string; url: string }): ReturnType<FakeAdapter['getThread']> {
    return this.#for(ref.threadId).getThread({ ...ref, platform: PLATFORM })
  }

  override async getReplies(ref: { threadId: string; url: string }, page: number): ReturnType<FakeAdapter['getReplies']> {
    return this.#for(ref.threadId).getReplies({ ...ref, platform: PLATFORM }, page)
  }

  override async getNestedReplies(
    ref: { threadId: string; url: string },
    floor: Parameters<FakeAdapter['getNestedReplies']>[1],
    page: number,
  ): ReturnType<FakeAdapter['getNestedReplies']> {
    return this.#for(ref.threadId).getNestedReplies({ ...ref, platform: PLATFORM }, floor, page)
  }

  override async getReplyContext(
    ref: { threadId: string; url: string },
    postId: string,
  ): ReturnType<FakeAdapter['getReplyContext']> {
    return this.#for(ref.threadId).getReplyContext({ ...ref, platform: PLATFORM }, postId)
  }

  override async publishReply(): ReturnType<FakeAdapter['publishReply']> {
    return this.#fallback.publishReply()
  }

  #for(threadId: string): FakeAdapter {
    return this.#byThread.get(threadId) ?? this.#fallback
  }
}

function seedMonitors(file: string, state: SoakState, threads: readonly ThreadRuntime[], now: string): void {
  const baseline = baseReplies('baseline', now)[1]!
  const fingerprint = fingerprintOf({
    kind: 'floor',
    authorId: baseline.authorId,
    authorName: baseline.author,
    createdAt: baseline.createdAt,
    floorPostId: baseline.postId,
    content: baseline.content,
  })
  const monitors: MonitorTarget[] = Array.from({ length: state.monitors }, (_unused, index) => {
    const thread = threads[index % threads.length]!
    return {
      id: `soak-monitor-${String(index + 1).padStart(4, '0')}`,
      name: `Soak 监控 ${index + 1}`,
      platform: PLATFORM,
      url: thread.url,
      threadId: thread.id,
      enabled: true,
      intervalSec: MONITOR_INTERVAL_SEC,
      createdAt: now,
      updatedAt: now,
      lastCheckAt: now,
      lastSuccessAt: now,
      platformState: 'healthy',
      seen: [BASELINE_POST_ID],
      baselineAt: now,
      cursor: {
        fingerprints: { [BASELINE_POST_ID]: fingerprint },
        lastSeenPostId: BASELINE_POST_ID,
        lastSeenAt: now,
        lastCompleteScanAt: now,
        lastScanAt: now,
        lastCoverage: 'tail',
      },
      lastScan: {
        at: now,
        complete: true,
        coverage: 'tail',
        pagesRead: 1,
        totalPages: 1,
        repliesSeen: 2,
      },
      compensationHours: 0,
      changes: [],
      counters: {
        discovered: 0,
        analyzed: 0,
        candidates: 0,
        failures: 0,
        day: now.slice(0, 10),
        todayDiscovered: 0,
        todayCandidates: 0,
        todayFailures: 0,
      },
    }
  })
  writeJson(file, { version: 2, monitors }, { mode: 0o600 })
}

function scriptedProbe(thread: ThreadRuntime, input: Parameters<DebateProductApi['probe']>[0], duplicate: boolean): ProbeResult {
  const mode = input.mode ?? (input.fullScan === true ? 'full' : 'tail')
  const replies = thread.replies.map((reply, index) => ({
    postId: reply.postId,
    kind: 'floor' as const,
    authorName: reply.author,
    authorId: reply.authorId,
    content: reply.content,
    ...(reply.createdAt === undefined ? {} : { createdAt: reply.createdAt }),
    floorPostId: reply.postId,
    floorNumber: index + 1,
    order: index,
    fingerprint: fingerprintOf({
      kind: 'floor',
      authorId: reply.authorId,
      authorName: reply.author,
      createdAt: reply.createdAt,
      floorPostId: reply.postId,
      content: reply.content,
    }),
    identityQuality: 'stable' as const,
  }))
  if (duplicate && replies.length > 0) replies.push({ ...replies[replies.length - 1]! })
  const totalPages = Math.max(1, Math.ceil(thread.replies.length / 20))
  return {
    platform: PLATFORM,
    threadId: thread.id,
    title: thread.title,
    url: thread.url,
    replies,
    complete: true,
    pagesRead: totalPages,
    declaredTotal: thread.replies.length,
    scan: {
      mode,
      complete: true,
      pagesRead: totalPages,
      totalPages,
      repliesSeen: replies.length,
    },
  }
}

async function startModel(faults: FaultInjector): Promise<ModelServer> {
  let calls = 0
  const server = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'method_not_allowed' }))
      return
    }
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      raw += chunk
    })
    request.on('end', () => {
      calls += 1
      const fault = faults.modelFault(Date.now())
      if (fault?.kind === 'timeout') {
        setTimeout(() => {
          if (!response.destroyed) {
            response.writeHead(fault.status, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: 'soak model timeout' }))
          }
        }, faults.modelTimeoutDelayMs)
        return
      }
      if (fault !== undefined) {
        response.writeHead(fault.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'soak model 5xx' }))
        return
      }
      const target = /回复对象的 post id 应为\s*([A-Za-z0-9:_-]+)/.exec(raw)?.[1] ?? BASELINE_POST_ID
      const draft = {
        status: 'ok',
        owner_position: '对方的结论建立在个例上。',
        opponent_position: '现在的年轻人吃不了苦。',
        main_dispute: '能否用个别现象概括整体。',
        latest_argument: '用身边例子否定整体结论。',
        response_target_id: target,
        strategy: 'point_out_contradiction',
        confidence: 0.7,
        uncertainties: [],
        reply: '你举的例子只能说明有人这样，不能说明所有人都这样。',
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'soak-mock',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(draft) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
      }))
    })
  })
  return new Promise((resolveModel) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolveModel({
        server,
        port: typeof address === 'object' && address !== null ? address.port : 0,
        calls: () => calls,
      })
    })
  })
}

function summarizeSession(session: NonNullable<ReturnType<DebateStore['getSession']>>): SessionSummary {
  return {
    id: session.id,
    platform: session.platform,
    threadId: session.threadId,
    threadTitle: session.threadTitle,
    threadUrl: session.threadUrl,
    state: session.state,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.selectedTargetPostId === undefined ? {} : { targetPostId: session.selectedTargetPostId }),
    candidates: session.candidates.map((candidate) => ({
      replyId: candidate.replyId,
      text: candidate.text,
      targetPostId: candidate.targetPostId,
      candidateVersion: candidate.candidateVersion,
      createdAt: candidate.createdAt,
    })),
  }
}

function recordCoreLockTimeout(
  context: Pick<SoakContext, 'state' | 'tasks'>,
  error: unknown,
  taskKind: string,
): void {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes('状态写入锁')) return
  const holder: {
    holderPid?: number
    holderAt?: number
    holderAgeMs?: number
    holderAlive?: boolean
  } = {}
  try {
    const raw = JSON.parse(readFileSync(join(context.state.dataDir, 'state.json.lock'), 'utf8')) as {
      pid?: unknown
      at?: unknown
    }
    if (typeof raw.pid === 'number') {
      holder.holderPid = raw.pid
      try {
        process.kill(raw.pid, 0)
        holder.holderAlive = true
      } catch {
        holder.holderAlive = false
      }
    }
    if (typeof raw.at === 'number') {
      holder.holderAt = raw.at
      holder.holderAgeMs = Date.now() - raw.at
    }
  } catch {
    // The holder may have released the lock between the timeout and sampling.
  }
  const event: LockTimeoutEvent = {
    at: new Date().toISOString(),
    taskKind,
    message,
    runningTasks: context.tasks.runningCount(),
    ...holder,
  }
  context.state.coreLockTimeouts += 1
  context.state.lockTimeoutEvents.push(event)
  context.state.lockTimeoutEvents = context.state.lockTimeoutEvents.slice(-20)
}

function makeProductApi(
  context: Pick<SoakContext, 'state' | 'faults' | 'threads' | 'runtime' | 'store' | 'tasks'>,
): DebateProductApi {
  const byUrl = new Map(context.threads.map((thread) => [thread.url, thread]))
  return {
    resolveUrl: (url: string) => ({ platform: PLATFORM, threadId: url.split('/').pop() ?? '', url }),
    probe: async (input) => {
      context.state.scans += 1
      const thread = byUrl.get(input.url)
      if (thread === undefined) throw new Error(`soak 不知道这个线程：${input.url}`)
      const fault = context.faults.platformFault(Date.now())
      if (fault !== undefined) {
        context.state.failures += 1
        throw fault
      }
      return scriptedProbe(thread, input, context.faults.duplicateReply())
    },
    analyze: async (input) => {
      context.state.analyses += 1
      try {
        const output = await runAnalysis(context.runtime, { url: input.url })
        return { sessionId: output.sessionId }
      } catch (error) {
        context.state.failures += 1
        recordCoreLockTimeout(context, error, 'analyze')
        throw error
      }
    },
    generate: async (input) => {
      context.state.generations += 1
      try {
        const output = await runGeneration(context.runtime, {
          sessionId: input.sessionId,
          ...(input.targetPostId === undefined ? {} : { targetPostId: input.targetPostId }),
        })
        const produced = output.outcome === 'valid_draft' || output.outcome === 'invalid_draft'
        return {
          ok: output.outcome === 'valid_draft',
          outcome: output.outcome,
          ...(produced && output.candidateId !== undefined ? { candidateId: output.candidateId } : {}),
          ...(output.needsInputReason === undefined ? {} : { message: output.needsInputReason }),
          ...(output.violations === undefined ? {} : { violations: output.violations }),
        }
      } catch (error) {
        context.state.failures += 1
        recordCoreLockTimeout(context, error, 'generate')
        throw error
      }
    },
    session: async (sessionId: string) => {
      try {
        const session = await context.store.readPersistedSession(sessionId)
        return session === undefined ? undefined : summarizeSession(session)
      } catch (error) {
        recordCoreLockTimeout(context, error, 'session')
        throw error
      }
    },
    sessionForThread: async (url: string) => {
      try {
        const threadId = url.split('/').pop() ?? ''
        const session = (await context.store.readPersistedSessionsForThread(threadId))[0]
        return session === undefined ? undefined : summarizeSession(session)
      } catch (error) {
        recordCoreLockTimeout(context, error, 'sessionForThread')
        throw error
      }
    },
    ownerIdentity: () => ({ handle: 'owner-handle', userName: '楼主' }),
  }
}

function addInvariantFailure(state: SoakState, message: string): void {
  if (!state.invariantFailures.includes(message)) {
    state.invariantFailures.push(message)
    state.invariantFailures = state.invariantFailures.slice(-30)
  }
}

/**
 * Account for one scheduler tick. Normal cadence (including its bounded sleep)
 * counts as active; a stalled tick is capped and fails the run. On resume the
 * caller must pass the new child process start time, never the previous
 * process's persisted lastTickAt, so supervisor downtime is excluded.
 */
export function recordTickActive(state: SoakState, previousTickAt: number, now = Date.now()): boolean {
  const delta = Math.max(0, now - previousTickAt)
  state.activeMs += Math.min(delta, state.tickActiveLimitMs)
  state.maxTickActiveMs = Math.max(state.maxTickActiveMs, delta)
  if (delta > state.tickActiveLimitMs) {
    addInvariantFailure(state, `单 tick 间隔 ${delta}ms 超过 active 上限 ${state.tickActiveLimitMs}ms`)
    return false
  }
  return true
}

export async function inspectInvariants(context: SoakContext, allowTransientLostTasks = false): Promise<InvariantResult> {
  const { state, tasks, identities, store, monitors } = context
  const failures: string[] = []
  // A clean store's snapshot is the document confirmed by its last successful
  // persist, so it can be sampled synchronously with the ledgers below. Only a
  // dirty store needs an awaited durable read; after that read, take every
  // business-ledger snapshot before yielding again. This prevents an old core
  // snapshot from being paired with candidate/review rows written while the read
  // was in flight, without ignoring dirty ghost candidates.
  const persisted = store.hasUnsavedChanges ? await store.readPersistedSnapshot() : store.snapshot()
  const entries = identities.all()
  const taskEntries = tasks.all()
  const monitorEntries = monitors.list()
  const identityByKey = new Map<string, (typeof entries)[number]>()
  const identityByReply = new Map<string, (typeof entries)[number]>()
  let identityDuplicates = 0
  for (const entry of entries) {
    if (identityByKey.has(entry.key)) identityDuplicates += 1
    identityByKey.set(entry.key, entry)
    identityByReply.set(`${entry.platform}:${entry.threadId}:${entry.postId}`, entry)
  }

  const candidatesByReply = new Map<string, number>()
  for (const session of persisted.sessions) {
    for (const candidate of session.candidates) {
      const key = `${session.platform}:${session.threadId}:${candidate.targetPostId}`
      candidatesByReply.set(key, (candidatesByReply.get(key) ?? 0) + 1)
    }
  }
  let duplicateCandidates = identityDuplicates
  for (const count of candidatesByReply.values()) {
    if (count > 1) duplicateCandidates += count - 1
  }

  const activeKeys = new Set<string>()
  const terminalKeys = new Set<string>()
  // Only an auth/policy-blocked task whose monitor is still blocked is an
  // intentional safe stop. Failed/cancelled/completed/needs_review work must
  // converge or remain a strict invariant failure.
  const authBlockedKeys = new Set<string>()
  const blockedMonitorIds = new Set(
    monitorEntries.filter((monitor) => monitor.blockedReason !== undefined).map((monitor) => monitor.id),
  )
  for (const task of taskEntries) {
    const keys = [task.identityKey, ...(task.identityKeys ?? [])].filter((key): key is string => key !== undefined)
    if (task.state === 'pending' || task.state === 'running' || task.state === 'retry_wait') {
      for (const key of keys) activeKeys.add(key)
    } else if (task.state === 'blocked' && blockedMonitorIds.has(task.monitorId)) {
      for (const key of keys) authBlockedKeys.add(key)
    } else {
      for (const key of keys) terminalKeys.add(key)
    }
  }
  const activeReplyCoordinates = new Set<string>()
  for (const entry of entries) {
    if (!activeKeys.has(entry.key)) continue
    activeReplyCoordinates.add(`${entry.platform}:${entry.threadId}:${entry.postId}`)
  }
  const terminalReplyCoordinates = new Set<string>()
  for (const entry of entries) {
    if (!terminalKeys.has(entry.key)) continue
    terminalReplyCoordinates.add(`${entry.platform}:${entry.threadId}:${entry.postId}`)
  }
  const authBlockedReplyCoordinates = new Set<string>()
  for (const entry of entries) {
    if (!authBlockedKeys.has(entry.key)) continue
    authBlockedReplyCoordinates.add(`${entry.platform}:${entry.threadId}:${entry.postId}`)
  }
  let lostTasks = 0
  let convergenceLag = 0
  let stuckIdentity = 0
  let authBlockedIdentity = 0
  const lostCoordinates: string[] = []
  const classifyUnconverged = (key: string): void => {
    if (activeReplyCoordinates.has(key)) {
      convergenceLag += 1
      return
    }
    if (terminalReplyCoordinates.has(key)) stuckIdentity += 1
    else if (authBlockedReplyCoordinates.has(key)) authBlockedIdentity += 1
    else {
      lostTasks += 1
      if (lostCoordinates.length < 10) lostCoordinates.push(key)
    }
  }
  for (const identity of entries) {
    if (identity.state === 'claimed' && !activeKeys.has(identity.key)) {
      classifyUnconverged(`${identity.platform}:${identity.threadId}:${identity.postId}`)
    }
  }
  for (const identity of entries) {
    if (identity.state !== 'candidate') continue
    const key = `${identity.platform}:${identity.threadId}:${identity.postId}`
    if (!candidatesByReply.has(key)) classifyUnconverged(key)
  }
  for (const key of candidatesByReply.keys()) {
    if (identityByReply.get(key)?.state !== 'candidate') classifyUnconverged(key)
  }
  for (const monitor of monitorEntries) {
    for (const postId of monitor.seen) {
      if (postId === BASELINE_POST_ID) continue
      const key = replyIdentityKey({
        platform: monitor.platform,
        threadId: monitor.threadId,
        postId,
        quality: 'stable',
        fingerprint: '',
      })
      if (!identityByKey.has(key)) classifyUnconverged(`${monitor.platform}:${monitor.threadId}:${postId}`)
    }
  }

  const settledKeys = new Map<string, number>()
  for (const task of taskEntries) {
    if (task.kind === 'probe' || task.kind === 'compensate') continue
    if (task.state !== 'completed' && task.state !== 'needs_review') continue
    settledKeys.set(task.dedupeKey, (settledKeys.get(task.dedupeKey) ?? 0) + 1)
  }
  let completedTaskReexecutions = 0
  for (const count of settledKeys.values()) {
    if (count > 1) completedTaskReexecutions += count - 1
  }

  let cursorRegressions = 0
  for (const monitor of monitorEntries) {
    const previous = state.cursorWatermarks[monitor.id]
    const current: CursorWatermark = {
      ...(monitor.cursor?.lastScanAt === undefined ? {} : { lastScanAt: monitor.cursor.lastScanAt }),
      ...(monitor.cursor?.lastCompleteScanAt === undefined ? {} : { lastCompleteScanAt: monitor.cursor.lastCompleteScanAt }),
      seen: monitor.seen.length,
    }
    if (previous !== undefined) {
      if (current.lastScanAt !== undefined && previous.lastScanAt !== undefined && Date.parse(current.lastScanAt) < Date.parse(previous.lastScanAt)) {
        cursorRegressions += 1
      }
      if (
        current.lastCompleteScanAt !== undefined &&
        previous.lastCompleteScanAt !== undefined &&
        Date.parse(current.lastCompleteScanAt) < Date.parse(previous.lastCompleteScanAt)
      ) {
        cursorRegressions += 1
      }
    }
    state.cursorWatermarks[monitor.id] = current
  }

  if (duplicateCandidates > 0) failures.push(`检测到 ${duplicateCandidates} 个重复回复候选/身份`)
  if (completedTaskReexecutions > 0) failures.push(`检测到 ${completedTaskReexecutions} 个已完成任务被重复执行`)
  if (cursorRegressions > 0) failures.push(`检测到 ${cursorRegressions} 次游标倒退`)
  if (tasks.queuedCount() > tasks.capacity) failures.push(`待执行队列 ${tasks.queuedCount()} 超过容量 ${tasks.capacity}`)
  if (state.memoryPeakMb > MAX_HEAP_MB) failures.push(`堆峰值 ${state.memoryPeakMb.toFixed(1)} MB 超过 ${MAX_HEAP_MB} MB`)
  if (state.unhandledErrors > 0) failures.push(`发生 ${state.unhandledErrors} 个未处理异常`)
  if (state.coreLockTimeouts > 0) failures.push(`发生 ${state.coreLockTimeouts} 次 core 状态锁超时`)
  if (state.unrecordedInterruptions > 0) failures.push(`${state.unrecordedInterruptions} 个中断任务没有恢复记录`)
  if (state.storeCorruptions > 0) failures.push(`检测到 ${state.storeCorruptions} 次 store 损坏`)
  if (stuckIdentity > 0) failures.push(`${stuckIdentity} 个身份的覆盖任务已终态但仍未收敛`)
  if (lostTasks > 0 && !allowTransientLostTasks) {
    state.lostTaskStrikes += 1
    if (state.lostTaskStrikes >= 3) failures.push(`${lostTasks} 个已发现回复连续三轮缺少身份或任务记录：${lostCoordinates.join(', ')}`)
  } else {
    state.lostTaskStrikes = 0
  }

  state.duplicateCandidates = duplicateCandidates
  state.lostTasks = lostTasks
  state.convergenceLag = convergenceLag
  state.convergenceLagPeak = Math.max(state.convergenceLagPeak, convergenceLag)
  state.stuckIdentity = stuckIdentity
  state.authBlockedIdentity = authBlockedIdentity
  state.cursorRegressions += cursorRegressions
  state.completedTaskReexecutions = completedTaskReexecutions
  for (const failure of failures) addInvariantFailure(state, failure)
  return { duplicateCandidates, lostTasks, convergenceLag, stuckIdentity, authBlockedIdentity, cursorRegressions, completedTaskReexecutions, failures }
}

/** Derive every PASS gate from the same live ledgers used to build the report. */
function invariantsOf(context: Pick<SoakContext, 'state' | 'tasks' | 'engine'>): Record<string, boolean> {
  const { state, tasks, engine } = context
  const engineStatus = engine.status()
  return {
    uniqueReplyCandidates: state.duplicateCandidates === 0,
    completedTasksNotReexecuted: state.completedTaskReexecutions === 0,
    cursorNeverRegresses: state.cursorRegressions === 0,
    interruptedTasksRecorded: state.unrecordedInterruptions === 0,
    queueWithinCapacity: state.peakQueue <= state.capacity,
    heapWithinThreshold: state.memoryPeakMb <= MAX_HEAP_MB,
    noUnhandledErrors: state.unhandledErrors === 0,
    noCoreLockTimeouts: state.coreLockTimeouts === 0,
    noLostTasks: state.lostTasks === 0,
    noStuckIdentity: state.stuckIdentity === 0,
    noIdentityLedgerDrift: state.duplicateCandidates === 0
      && state.lostTasks === 0
      && state.convergenceLag === 0
      && state.stuckIdentity === 0,
    noTaskLedgerDrift: state.completedTaskReexecutions === 0
      && state.cursorRegressions === 0
      && state.unrecordedInterruptions === 0,
    noStoreCorruption: state.storeCorruptions === 0,
    diskFailuresDegraded: state.undegradedDiskSessions === 0,
    activeTicksWithinLimit: state.maxTickActiveMs <= state.tickActiveLimitMs,
    drainConverged: !state.drainTimedOut
      && state.drainSeconds <= state.drainTimeoutMs
      && tasks.queuedCount() === 0
      && tasks.runningCount() === 0
      && engineStatus.queued === 0
      && engineStatus.runningTasks === 0,
  }
}

function reportOf(context: SoakContext, endedAtMs: number, status: 'passed' | 'failed'): SoakReport {
  const { state, options, faults, tasks, identities, engine, model, monitors, threads } = context
  const endedAt = new Date(endedAtMs).toISOString()
  const wallClockSeconds = Math.max(0, (endedAtMs - context.startedAtMs) / 1_000)
  const cumulativeSeconds = Math.max(0, (endedAtMs - Date.parse(state.startedAt)) / 1_000)
  const cpuSeconds = (state.cpuUsage.userMicros + state.cpuUsage.systemMicros) / 1_000_000
  const byThread = new Map<string, number>()
  for (const monitor of monitors.list()) byThread.set(monitor.threadId, (byThread.get(monitor.threadId) ?? 0) + 1)
  const queue = tasks.stats(Date.now())
  const invariants = invariantsOf(context)
  return {
    schemaVersion: 1,
    tool: 'soak-v022',
    status,
    originalStartedAt: state.startedAt,
    actualStartedAt: new Date(context.startedAtMs).toISOString(),
    actualEndedAt: endedAt,
    wallClockSeconds: Number(wallClockSeconds.toFixed(3)),
    cumulativeSeconds: Number(cumulativeSeconds.toFixed(3)),
    requestedSeconds: options.seconds,
    killEverySeconds: options.killEvery,
    noKill: options.noKill,
    resumed: state.restarts > 0,
    resumedAfterFailure: options.resume && options.acknowledgeFailures,
    monitors: state.monitors,
    threads: state.threads,
    seed: state.seed,
    stateFile: context.stateFile,
    dataDir: state.dataDir,
    iterations: state.iterations,
    scans: state.scans,
    analyses: state.analyses,
    generations: state.generations,
    modelCalls: model.calls(),
    candidates: identities.stats().candidate,
    failures: state.failures,
    retries: state.retries,
    restarts: state.restarts,
    kills: state.kills,
    activeSeconds: Number((state.activeMs / 1000).toFixed(3)),
    maxTickActiveMs: state.maxTickActiveMs,
    tickActiveLimitMs: state.tickActiveLimitMs,
    drainTimeoutMs: state.drainTimeoutMs,
    drainSeconds: Number((state.drainSeconds / 1000).toFixed(3)),
    drainTimedOut: state.drainTimedOut,
    memoryPeakMb: Number(state.memoryPeakMb.toFixed(2)),
    heapFinalMb: Number((process.memoryUsage().heapUsed / 1_048_576).toFixed(2)),
    cpuUsage: {
      userMicros: state.cpuUsage.userMicros,
      systemMicros: state.cpuUsage.systemMicros,
      percent: Number((cumulativeSeconds === 0 ? 0 : cpuSeconds / cumulativeSeconds * 100).toFixed(2)),
    },
    peakQueue: state.peakQueue,
    queueCapacity: state.capacity,
    queueAtEnd: tasks.queuedCount(),
    peakLedger: state.peakLedger,
    ledgerRowsAtEnd: tasks.all().length,
    pendingAtEnd: queue.byState.pending + queue.byState.retry_wait + queue.byState.running,
    duplicateCandidates: state.duplicateCandidates,
    lostTasks: state.lostTasks,
    convergenceLag: state.convergenceLag,
    convergenceLagPeak: state.convergenceLagPeak,
    stuckIdentity: state.stuckIdentity,
    authBlockedIdentity: state.authBlockedIdentity,
    coreLockTimeouts: state.coreLockTimeouts,
    lockTimeoutEvents: state.lockTimeoutEvents.map((event) => ({ ...event })),
    cursorRegressions: state.cursorRegressions,
    completedTaskReexecutions: state.completedTaskReexecutions,
    unrecordedInterruptions: state.unrecordedInterruptions,
    unhandledErrors: state.unhandledErrors,
    completed: state.completed,
    sharedThreadGroups: [...byThread.values()].filter((count) => count > 1).length,
    maxMonitorsPerThread: Math.max(0, ...byThread.values()),
    totalRepliesCreated: state.totalRepliesCreated,
    faults: faults.stats(),
    recentFaults: faults.recent(),
    diskTargets: options.diskStore === undefined
      ? ['auto_tasks', 'monitors', 'identities']
      : [options.diskStore],
    diskStoreActual: { ...state.diskStoreActual },
    diskStoreSkipped: { ...state.diskStoreSkipped },
    orphanSweepMs: 0,
    storeWriteFailures: state.storeWriteFailures,
    storeRestores: state.storeRestores,
    storeCorruptions: state.storeCorruptions,
    degradedDiskSessions: state.degradedDiskSessions,
    undegradedDiskSessions: state.undegradedDiskSessions,
    recoveredDiskBlockers: state.recoveredDiskBlockers,
    backlogSessions: state.backlogSessions,
    operatorResumes: state.operatorResumes,
    queueRejections: state.queueRejections,
    prunedRows: state.prunedRows,
    ...(state.stoppedAt === undefined ? {} : { stoppedAt: state.stoppedAt }),
    acknowledgedFailures: [...state.acknowledgedFailures],
    identities: identities.stats(),
    engine: engine.status(),
    invariants,
    invariantFailures: [...state.invariantFailures],
    limitations: [
      '平台与模型均为本地替身；本报告不构成真实平台或真实模型验证。',
      '为保持 1000 监控可持续运行，监控批量轮转共享线程，并非每 tick 扫描全部目标。',
      '同一 thread 的多个监控允许交错探测；node:test 覆盖 A 分析中、B 发现 r3 的 monitor-dominant 批次补全。',
      'live 磁盘写入故障覆盖 auto-tasks/monitor/reply-identity 三个 store；monitor 故障在 identity claim 之后注入，以验证 orphan 对账。',
      '默认 3 秒冒烟不会替代 24 小时运行；报告中的 wallClockSeconds 是实际执行时长。',
    ],
  }
}

function writeReport(report: SoakReport, file?: string): void {
  const json = `${JSON.stringify(report, null, 2)}\n`
  process.stdout.write(json)
  if (file !== undefined) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, json, 'utf8')
    } catch (error) {
      process.stderr.write(`无法写入报告文件 ${file}：${String(error)}\n`)
      process.exitCode = 1
    }
  }
}

function valuesOf(options: SoakOptions, name: string): number | undefined {
  if (!options.explicit.has(name)) return undefined
  switch (name) {
    case 'seed': return options.seed
    case 'monitors': return options.monitors
    case 'threads': return options.threads
    case 'capacity': return options.capacity
    case 'max-tick-active-ms': return options.maxTickActiveMs
    case 'drain-timeout-ms': return options.drainTimeoutMs
    case 'reply-every-ms': return options.replyEveryMs
    case 'scan-batch': return options.scanBatch
    case 'scan-every-ms': return options.scanEveryMs
    default: return undefined
  }
}

async function buildContext(options: SoakOptions): Promise<SoakContext> {
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  let rootDir: string
  let stateFile: string
  let state: SoakState
  if (options.resume) {
    if (options.stateFile === undefined) throw new Error('--resume 必须同时提供 --state-file')
    stateFile = options.stateFile
    state = loadSoakState(stateFile)
    rootDir = dirname(stateFile)
    const persisted: ReadonlyArray<readonly [string, number]> = [
      ['seed', state.seed],
      ['monitors', state.monitors],
      ['threads', state.threads],
      ['capacity', state.capacity],
      ['max-tick-active-ms', state.tickActiveLimitMs],
      ['drain-timeout-ms', state.drainTimeoutMs],
      ['reply-every-ms', state.replyEveryMs],
      ['scan-batch', state.scanBatch],
      ['scan-every-ms', state.scanEveryMs],
    ]
    for (const [name, expected] of persisted) {
      const raw = valuesOf(options, name)
      if (raw !== undefined && raw !== expected) throw new Error(`恢复参数 --${name}=${raw} 与原状态 ${expected} 不一致`)
    }
    options = {
      ...options,
      seed: state.seed,
      monitors: state.monitors,
      threads: state.threads,
      capacity: state.capacity,
      maxTickActiveMs: state.tickActiveLimitMs,
      drainTimeoutMs: state.drainTimeoutMs,
      replyEveryMs: state.replyEveryMs,
      scanBatch: state.scanBatch,
      scanEveryMs: state.scanEveryMs,
    }
    state.completed = false
    if (options.acknowledgeFailures) {
      for (const failure of state.invariantFailures) {
        if (!state.acknowledgedFailures.includes(failure)) state.acknowledgedFailures.push(failure)
      }
      state.invariantFailures = []
      state.lostTaskStrikes = 0
    }
  } else {
    rootDir = options.stateFile === undefined
      ? mkdtempSync(join(tmpdir(), 'ai-debate-soak-v022-'))
      : dirname(options.stateFile)
    stateFile = options.stateFile ?? join(rootDir, 'soak-state.json')
    if (options.stateFile !== undefined && readFileStateExists(stateFile)) {
      throw new Error(`状态文件已存在：${stateFile}；如要继续请加 --resume`)
    }
    state = createSoakState({
      startedAt: nowIso,
      now: nowMs,
      seed: options.seed,
      dataDir: `${stateFile}.data`,
      monitors: options.monitors,
      threads: options.threads,
      capacity: options.capacity,
      maxTickActiveMs: options.maxTickActiveMs,
      drainTimeoutMs: options.drainTimeoutMs,
      replyEveryMs: options.replyEveryMs,
      scanBatch: options.scanBatch,
      scanEveryMs: options.scanEveryMs,
      faults: new FaultInjector().snapshot(),
    })
  }

  if (
    state.seed !== options.seed ||
    state.monitors !== options.monitors ||
    state.threads !== options.threads ||
    state.capacity !== options.capacity ||
    state.tickActiveLimitMs !== options.maxTickActiveMs ||
    state.drainTimeoutMs !== options.drainTimeoutMs ||
    state.replyEveryMs !== options.replyEveryMs ||
    state.scanBatch !== options.scanBatch ||
    state.scanEveryMs !== options.scanEveryMs
  ) {
    throw new Error('恢复参数与原 soak 状态不一致（seed/monitors/threads/capacity/扫描或回复频率）')
  }

  const faultOptions: FaultInjectorOptions = {
    seed: options.seed,
    platformChance: options.platformFaultChance,
    modelChance: options.modelFaultChance,
    diskChance: options.diskFaultChance,
    backlogChance: options.backlogFaultChance,
    duplicateReplyChance: options.duplicateReplyChance,
    killEverySec: options.noKill ? 0 : options.killEvery,
  }
  const faults = options.resume ? FaultInjector.restore(state.faults, faultOptions) : new FaultInjector(faultOptions)
  faults.armKillSchedule(nowMs)
  // The supervisor owns restart accounting. Counting here as well double-counted
  // every resume and made kills != restarts in otherwise valid reports.
  state.faults = faults.snapshot()
  mkdirSync(state.dataDir, { recursive: true })
  state.recoveredDiskBlockers += DiskWriteFault.recover(state.dataDir)

  const monitorsFile = join(state.dataDir, 'monitors.json')
  const tasksFile = join(state.dataDir, 'auto-tasks.json')
  const identitiesFile = join(state.dataDir, 'reply-identities.json')
  const threads = makeThreads(state)
  if (!options.resume) {
    seedMonitors(monitorsFile, state, threads, nowIso)
    for (const thread of threads) {
      appendReply(thread, nowIso)
      state.totalRepliesCreated += 1
    }
  }
  persistThreads(state, threads)

  const storeEvent = (store: DiskStoreName, event: string, detail: Record<string, unknown>): void => {
    faults.noteStoreEvent(store, event, detail)
    if (event === 'write_failed') state.storeWriteFailures += 1
    if (event === 'restored') state.storeRestores += 1
    if (event === 'corrupt') state.storeCorruptions += 1
  }

  const monitors = new MonitorStore({ file: monitorsFile, log: quiet, onEvent: (event, detail) => storeEvent('monitors', event, detail) })
  monitors.load()
  const tasks = new AutoTaskStore({ file: tasksFile, log: quiet, capacity: state.capacity, onEvent: (event, detail) => storeEvent('auto_tasks', event, detail) })
  tasks.load()
  const identities = new ReplyIdentityStore({ file: identitiesFile, log: quiet, onEvent: (event, detail) => storeEvent('identities', event, detail) })
  identities.load()
  if (monitors.loadError !== undefined || tasks.loadError !== undefined || identities.loadError !== undefined) {
    throw new Error(`store 加载失败：${monitors.loadError ?? tasks.loadError ?? identities.loadError ?? 'unknown'}`)
  }
  if (monitors.list().length !== state.monitors) throw new Error(`恢复的监控数量 ${monitors.list().length} != ${state.monitors}`)

  const runningBeforeRecovery = tasks.all().filter((task) => task.state === 'running').length
  const recovered = tasks.recoverInterrupted(nowIso)
  if (recovered.recovered !== runningBeforeRecovery) {
    state.unrecordedInterruptions += Math.abs(runningBeforeRecovery - recovered.recovered)
  }
  if (recovered.recovered > 0 && tasks.lastRecovery === undefined) state.unrecordedInterruptions += recovered.recovered
  if (options.resume && tasks.paused) {
    tasks.resumeQueue()
    state.operatorResumes += 1
  }
  if (!readFileStateExists(tasksFile)) {
    tasks.pauseQueue()
    tasks.resumeQueue()
  }

  const model = await startModel(faults)
  const config = {
    ...DEFAULT_CONFIG,
    enabled: true,
    platformAccounts: JSON.stringify({
      owners: [{ platform: PLATFORM, primary: { platform: PLATFORM, handle: 'owner-handle', displayName: '楼主' } }],
      aiAccounts: [{ platform: PLATFORM, account: { platform: PLATFORM, displayName: 'AI 马甲' } }],
    }),
    llmBaseUrl: `http://127.0.0.1:${model.port}/v1`,
    llmModel: 'soak-mock-model',
    llmSource: 'custom' as const,
    llmProtocol: 'chat' as const,
    llmTimeoutMs: 1_000,
    llmRetries: 0,
    egressMode: 'open' as const,
    pageDelayMs: 0,
    maxFloorPages: 5,
  }
  const store = new DebateStore({
    dir: state.dataDir,
    sessionTtlMs: 24 * 60 * 60 * 1_000,
    maxSessions: 100_000,
    maxUsageRows: 500,
  })
  const registry = new PlatformRegistry()
  const adapter = new RoutingFakeAdapter(threads)
  registry.register({
    id: PLATFORM,
    displayName: 'Soak 假平台',
    shape: 'forum-thread',
    canHandleUrl: (url: string) => url.startsWith('https://fake.example/p/'),
    parseUrl: (url: string) => ({ platform: PLATFORM, threadId: url.split('/').pop() ?? '', url }),
    describeCapabilities: () => ({
      platform: PLATFORM,
      declaredAt: '2026-11-01T00:00:00.000Z',
      capabilities: {
        'thread.read': { state: 'supported', reason: 'Soak 假平台' },
        'comment.list': { state: 'supported', reason: 'Soak 假平台' },
        'comment.paginate': { state: 'supported', reason: 'Soak 假平台' },
        'comment.nested': { state: 'supported', reason: 'Soak 假平台' },
        'comment.locate': { state: 'supported', reason: 'Soak 假平台' },
        'identity.verify': { state: 'supported', reason: 'Soak 假平台' },
        'event.mentions': { state: 'unavailable', reason: 'Soak 假平台不提供艾特列表' },
        'comment.publish': { state: 'unverified', reason: 'Soak 不发表' },
        'comment.reply': { state: 'unverified', reason: 'Soak 不发表' },
        'publish.verify': { state: 'unverified', reason: 'Soak 不发表' },
        'media.read': { state: 'unavailable', reason: 'Soak 不提供媒体' },
        'user.profile': { state: 'unavailable', reason: 'Soak 不提供用户资料' },
      },
    }) as never,
    createAdapter: () => adapter,
  })
  const runtime = buildRuntime(() => resolveConfig(config), quiet as never, registry, undefined, { store })
  await store.ready()
  let api: DebateProductApi | undefined
  const engine = new AutomationEngine({
    monitors,
    tasks,
    identities,
    api: () => api,
    log: quiet as never,
      tickMs: 3_600_000,
      orphanSweepMs: 0,
      taskTimeoutMs: 120_000,
    concurrency: 4,
    perPlatformConcurrency: 4,
  })
  api = makeProductApi({ state, faults, threads, runtime, store, tasks })
  engine.start()
  saveSoakState(stateFile, state)
  return {
    options,
    state,
    faults,
    stateFile,
    monitorsFile,
    tasksFile,
    identitiesFile,
    monitors,
    tasks,
    identities,
    store,
    runtime,
    engine,
    model,
    threads,
    startedAtMs: nowMs,
  }
}

function readFileStateExists(file: string): boolean {
  return existsSync(file)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(1, ms)))
}

async function runSoak(options: SoakOptions): Promise<void> {
  let context: SoakContext | undefined
  let activeDisk: ActiveDiskFault | undefined
  let lostTaskGraceUntil = 0
  let backlogUntil = 0
  let fatalError: string | undefined
  let lastCpu = process.cpuUsage()
  let lastScanAt = 0
  let lastPruneAt = 0
  let scanCursor = 0

  const onUnhandled = (error: unknown, origin: string): void => {
    fatalError = `未处理异常（${origin}）：${error instanceof Error ? error.stack ?? error.message : String(error)}`
    if (context !== undefined) {
      context.state.unhandledErrors += 1
      addInvariantFailure(context.state, fatalError)
      try {
        saveSoakState(context.stateFile, context.state)
      } catch {
        // The main loop will report the original unhandled error. A state-write
        // failure must not recursively enter the unhandled handler.
      }
    }
    process.exitCode = 1
  }
  const onUncaughtException = (error: Error): void => onUnhandled(error, 'uncaughtException')
  const onUnhandledRejection = (error: unknown): void => onUnhandled(error, 'unhandledRejection')
  process.on('uncaughtException', onUncaughtException)
  process.on('unhandledRejection', onUnhandledRejection)

  try {
    context = await buildContext(options)
    const { state, faults, tasks, monitors, engine, threads } = context
    const deadline = options.deadline ?? context.startedAtMs + options.seconds * 1_000
    const shortRunGraceDeadline = options.deadline === undefined && options.seconds <= 10 ? deadline + 5_000 : deadline
    lastScanAt = context.startedAtMs - options.scanEveryMs
    lastPruneAt = context.startedAtMs
    // Node startup is active initialization, not supervisor downtime. Including
    // it prevents planned restarts from silently shrinking the active budget.
    let previousTickAt = context.startedAtMs - process.uptime() * 1_000

    while (
      Date.now() < deadline ||
      (options.deadline === undefined && options.seconds <= 10 && context.identities.stats().candidate === 0 && Date.now() < shortRunGraceDeadline)
    ) {
      if (fatalError !== undefined) break
      const now = Date.now()
      if (!recordTickActive(state, previousTickAt, now)) break
      previousTickAt = now
      state.iterations += 1

      if (now < deadline && now >= state.nextReplyAt) {
        const thread = threads[faults.random.integer(0, threads.length - 1)]!
        appendReply(thread, new Date(now).toISOString())
        state.totalRepliesCreated += 1
        state.nextReplyAt = now + state.replyEveryMs
      }

      // A 403 is deliberately blocking in the product. The soak acts as the
      // operator who investigates and resumes it; the resume is counted, not
      // hidden as if the platform recovered by itself.
      for (const monitor of monitors.list()) {
        if (monitor.blockedReason === undefined || !monitor.blockedReason.startsWith('Soak 注入')) continue
        monitors.clearBlock(monitor.id)
        monitors.update(monitor.id, { enabled: true })
        state.operatorResumes += 1
      }

      if (backlogUntil > 0 && now >= backlogUntil) {
        tasks.resumeQueue()
        backlogUntil = 0
        state.operatorResumes += 1
      }
      if (backlogUntil === 0 && faults.backlogFault(now)) {
        if (tasks.queuedCount() >= tasks.capacity * 0.8) {
          faults.mark('queue_backlog', 'skipped', 'queue already near capacity', now)
        } else {
          tasks.pauseQueue()
          const targets = monitors.list()
          let injected = 0
          for (let index = 0; index < 25 && targets.length > 0; index += 1) {
            const monitor = targets[(scanCursor + index) % targets.length]!
            try {
              tasks.enqueue({
                kind: 'probe',
                monitorId: monitor.id,
                dedupeKey: `soak-backlog:${state.iterations}:${index}`,
              })
              injected += 1
            } catch {
              state.queueRejections += 1
              faults.mark('queue_backlog', 'skipped', 'enqueue rejected', now)
              break
            }
          }
          if (injected === 0) tasks.resumeQueue()
          else {
            backlogUntil = now + faults.backlogDurationMs
            state.backlogSessions += 1
            faults.mark('queue_backlog', 'actual', `${injected} probe tasks queued`, now)
          }
        }
      }

      const safeForDisk = engine.status().runningTasks === 0 && tasks.runningCount() === 0 && tasks.queuedCount() === 0
      if (activeDisk === undefined && faults.diskFault(now)) {
        if (!safeForDisk) {
          faults.mark('disk_write', 'skipped', 'queue is not idle', now)
        } else {
          const store = options.diskStore ?? faults.random.pick(['auto_tasks', 'monitors', 'identities'] as const)
          const target = monitors.list()[scanCursor % monitors.list().length]
          let blocker: DiskWriteFault | undefined
          let restoreInstrumentation = (): void => undefined
          try {
            if (target === undefined) throw new Error('没有可用于磁盘故障的监控')
            const thread = threads.find((entry) => entry.id === target.threadId)
            if (thread === undefined) throw new Error(`找不到监控线程 ${target.threadId}`)
            appendReply(thread, new Date(now).toISOString())
            state.totalRepliesCreated += 1
            tasks.enqueue({ kind: 'probe', monitorId: target.id, dedupeKey: `soak-disk:${state.iterations}` })
            const file = store === 'auto_tasks'
              ? context.tasksFile
              : store === 'monitors'
                ? context.monitorsFile
                : context.identitiesFile
            blocker = new DiskWriteFault(file)
            if (store === 'monitors' || store === 'auto_tasks') {
              // Monitor: fail the cursor write after the identity claim. Task:
              // let identity+cursor commit, then fail the analyze-task write.
              const original = monitors.applyScan.bind(monitors)
              let fired = false
              monitors.applyScan = (id, scan): ReturnType<MonitorStore['applyScan']> => {
                if (store === 'monitors' && !fired) {
                  blocker?.activate()
                  fired = true
                }
                const outcome = original(id, scan)
                if (store === 'auto_tasks' && !fired) {
                  blocker?.activate()
                  fired = true
                }
                return outcome
              }
              restoreInstrumentation = (): void => {
                monitors.applyScan = original
              }
            } else {
              blocker.activate()
            }
            activeDisk = {
              store,
              blocker,
              until: now + faults.diskDurationMs,
              degraded: false,
              recorded: false,
              restore: restoreInstrumentation,
            }
            state.diskSessions += 1
          } catch (error) {
            restoreInstrumentation()
            try {
              blocker?.restore()
            } catch {
              // The recovery pass on the next startup preserves the hidden file.
            }
            state.diskStoreSkipped[store] += 1
            faults.mark('disk_write', 'skipped', `${store}: ${String(error)}`, now)
          }
        }
      }
      if (activeDisk !== undefined && now >= activeDisk.until) {
        activeDisk.restore()
        activeDisk.blocker.restore()
        if (activeDisk.blocker.observed) {
          if (!activeDisk.recorded) {
            activeDisk.recorded = true
            state.diskStoreActual[activeDisk.store] += 1
            faults.mark('disk_write', 'actual', activeDisk.store, now)
          }
          if (activeDisk.degraded) state.degradedDiskSessions += 1
          else {
            state.undegradedDiskSessions += 1
            addInvariantFailure(state, `${activeDisk.store} 写入失败已发生，但没有观察到 degraded/暂停状态`)
          }
          if (tasks.paused && backlogUntil === 0) {
            tasks.resumeQueue()
            state.operatorResumes += 1
          }
        } else {
          state.diskStoreSkipped[activeDisk.store] += 1
          faults.mark('disk_write', 'skipped', `${activeDisk.store}: no write attempted`, now)
        }
        activeDisk = undefined
        lostTaskGraceUntil = Date.now() + 3_000
      }

      if (
        activeDisk === undefined &&
        backlogUntil === 0 &&
        now < deadline &&
        now - lastScanAt >= options.scanEveryMs &&
        tasks.queuedCount() < options.scanBatch * 2
      ) {
        const targets = monitors.list()
        for (let index = 0; index < options.scanBatch && targets.length > 0; index += 1) {
          const monitor = targets[scanCursor % targets.length]!
          scanCursor += 1
          try {
            engine.checkNow(monitor.id)
          } catch (error) {
            state.queueRejections += 1
            faults.mark('queue_backlog', 'skipped', `checkNow: ${String(error)}`, now)
          }
        }
        lastScanAt = now
      }

      await engine.tick()
      if (activeDisk !== undefined) {
        const status = engine.status()
        const storeError = activeDisk.store === 'auto_tasks'
          ? tasks.saveError
          : activeDisk.store === 'monitors'
            ? monitors.saveError
            : context.identities.saveError
        if (status.degraded !== undefined || storeError !== undefined) {
          activeDisk.degraded = true
          activeDisk.blocker.noteObserved()
          if (activeDisk.store !== 'auto_tasks' && !tasks.paused) tasks.pauseQueue()
        }
        if (activeDisk.blocker.observed && !activeDisk.recorded) {
          activeDisk.recorded = true
          state.diskStoreActual[activeDisk.store] += 1
          faults.mark('disk_write', 'actual', activeDisk.store, now)
        }
      }

      state.peakQueue = Math.max(state.peakQueue, tasks.queuedCount())
      state.peakLedger = Math.max(state.peakLedger, tasks.all().length)
      let retryLogs = 0
      for (const task of tasks.all()) {
        for (const entry of task.logs) {
          if (entry.message.includes('秒后重试')) retryLogs += 1
        }
      }
      state.retries = Math.max(state.retries, retryLogs)
      state.failures = Math.max(
        state.failures,
        monitors.list().reduce((total, monitor) => total + monitor.counters.failures, 0),
      )

      if (now - lastPruneAt >= 30_000 && activeDisk === undefined) {
        state.prunedRows += tasks.prune({ keepDays: 1, keepTerminal: 300 }).removed
        lastPruneAt = now
      }

      const invariants = await inspectInvariants(context, activeDisk !== undefined || Date.now() < lostTaskGraceUntil)
      if (invariants.failures.length > 0) break

      const usage = process.cpuUsage(lastCpu)
      state.cpuUsage.userMicros += usage.user
      state.cpuUsage.systemMicros += usage.system
      lastCpu = process.cpuUsage()
      state.memoryPeakMb = Math.max(state.memoryPeakMb, process.memoryUsage().heapUsed / 1_048_576)
      if (state.memoryPeakMb > MAX_HEAP_MB) {
        addInvariantFailure(state, `堆峰值 ${state.memoryPeakMb.toFixed(1)} MB 超过 ${MAX_HEAP_MB} MB`)
        break
      }

      persistThreads(state, threads)
      state.faults = faults.snapshot()
      const tickEndedAt = Date.now()
      if (!recordTickActive(state, previousTickAt, tickEndedAt)) break
      previousTickAt = tickEndedAt
      state.lastTickAt = new Date(tickEndedAt).toISOString()
      const safeForKill =
        activeDisk === undefined &&
        Date.now() + options.killEvery * 1_000 < deadline
      if (!options.noKill && options.killEvery > 0 && safeForKill && faults.killDue(Date.now())) {
        state.kills += 1
        const killRecord = faults.mark('process_kill', 'actual', `pid=${process.pid}`, Date.now())
        state.faults = faults.snapshot()
        try {
          saveSoakState(context.stateFile, state)
        } catch (error) {
          faults.unmark(killRecord)
          state.kills = Math.max(0, state.kills - 1)
          state.faults = faults.snapshot()
          faults.mark('process_kill', 'skipped', `state save failed: ${String(error)}`, Date.now())
          throw error
        }
        if (process.platform === 'win32') process.exit(137)
        process.kill(process.pid, 'SIGKILL')
        return
      }
      saveSoakState(context.stateFile, state)
      const remaining = shortRunGraceDeadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(options.intervalMs, remaining))
    }

    if (activeDisk !== undefined) {
      activeDisk.restore()
      activeDisk.blocker.restore()
      if (activeDisk.blocker.observed) {
        if (!activeDisk.recorded) {
          activeDisk.recorded = true
          state.diskStoreActual[activeDisk.store] += 1
          faults.mark('disk_write', 'actual', activeDisk.store, Date.now())
        }
        if (activeDisk.degraded) state.degradedDiskSessions += 1
        else {
          state.undegradedDiskSessions += 1
          addInvariantFailure(state, `${activeDisk.store} 写入失败已发生，但没有观察到 degraded/暂停状态`)
        }
        if (tasks.paused && backlogUntil === 0) {
          tasks.resumeQueue()
          state.operatorResumes += 1
        }
      } else {
        state.diskStoreSkipped[activeDisk.store] += 1
        faults.mark('disk_write', 'skipped', `${activeDisk.store}: no write attempted`, Date.now())
      }
      activeDisk = undefined
      lostTaskGraceUntil = Date.now() + 3_000
    }
    if (backlogUntil > 0) {
      tasks.resumeQueue()
      state.operatorResumes += 1
      backlogUntil = 0
    }
    if (tasks.paused) tasks.resumeQueue()

    // The loop may finish its final bounded sleep exactly at the deadline, so no
    // subsequent iteration exists to account for that tail. Capture it before
    // drain starts; otherwise a valid run can finish just under requestedSeconds.
    const loadEndedAt = Date.now()
    recordTickActive(state, previousTickAt, loadEndedAt)
    previousTickAt = loadEndedAt

    // The requested soak window is over. Stop creating work and let the already
    // discovered pipeline converge. A PASS with pending/running/retry_wait rows
    // would only prove that the clock expired, not that the ledger converged.
    const drainStartedAt = Date.now()
    while (fatalError === undefined) {
      await engine.tick()
      const tickEndedAt = Date.now()
      if (!recordTickActive(state, previousTickAt, tickEndedAt)) break
      previousTickAt = tickEndedAt
      state.drainSeconds = tickEndedAt - drainStartedAt
      state.lastTickAt = new Date(tickEndedAt).toISOString()
      const engineStatus = engine.status()
      const idle = tasks.queuedCount() === 0
        && tasks.runningCount() === 0
        && engineStatus.queued === 0
        && engineStatus.runningTasks === 0
      const timedOut = !idle && state.drainSeconds >= options.drainTimeoutMs
      if (timedOut) {
        state.drainTimedOut = true
        addInvariantFailure(state, `截止后 ${options.drainTimeoutMs}ms 内队列仍未收敛：queued=${tasks.queuedCount()} running=${tasks.runningCount()} engineRunningTasks=${engineStatus.runningTasks}`)
      }
      saveSoakState(context.stateFile, state)
      if (idle || timedOut) break
      await sleep(Math.min(options.intervalMs, options.drainTimeoutMs - state.drainSeconds))
    }
    await engine.stop()
    const finalInvariants = await inspectInvariants(context)
    if (finalInvariants.lostTasks > 0) {
      addInvariantFailure(state, `截止后仍有 ${finalInvariants.lostTasks} 个已发现回复缺少身份或任务记录`)
    }
    if (finalInvariants.convergenceLag > 0) {
      addInvariantFailure(state, `截止后仍有 ${finalInvariants.convergenceLag} 个身份未收敛`)
    }
    for (const [name, passed] of Object.entries(invariantsOf(context))) {
      if (!passed) addInvariantFailure(state, `最终不变量 ${name} 不为 true`)
    }
    recordTickActive(state, previousTickAt, Date.now())
    if (fatalError !== undefined) addInvariantFailure(state, fatalError)
    state.completed = state.invariantFailures.length === 0
      && fatalError === undefined
      && Object.values(invariantsOf(context)).every(Boolean)
    state.lastTickAt = new Date().toISOString()
    if (!state.completed) state.stoppedAt ??= state.lastTickAt
    state.faults = faults.snapshot()
    saveSoakState(context.stateFile, state)
    const report = reportOf(context, Date.now(), state.completed ? 'passed' : 'failed')
    writeReport(report, options.report)
    if (!state.completed) process.exitCode = 1
  } catch (error) {
    fatalError = error instanceof Error ? error.stack ?? error.message : String(error)
    if (activeDisk !== undefined) {
      try {
        activeDisk.restore()
        activeDisk.blocker.restore()
      } catch (restoreError) {
        if (context !== undefined) addInvariantFailure(context.state, `磁盘故障恢复失败：${String(restoreError)}`)
      }
      activeDisk = undefined
    }
    if (context !== undefined) {
      addInvariantFailure(context.state, fatalError)
      context.state.completed = false
      context.state.lastTickAt = new Date().toISOString()
      context.state.stoppedAt ??= context.state.lastTickAt
      context.state.faults = context.faults.snapshot()
      try {
        saveSoakState(context.stateFile, context.state)
      } catch (stateError) {
        process.stderr.write(`无法保存失败状态：${String(stateError)}\n`)
      }
      try {
        const report = reportOf(context, Date.now(), 'failed')
        writeReport(report, options.report)
      } catch (reportError) {
        process.stderr.write(`无法写入失败报告：${String(reportError)}\n`)
      }
    } else {
      writeReport({
        schemaVersion: 1,
        tool: 'soak-v022',
        status: 'failed',
        originalStartedAt: new Date().toISOString(),
        actualStartedAt: new Date().toISOString(),
        actualEndedAt: new Date().toISOString(),
        wallClockSeconds: 0,
        cumulativeSeconds: 0,
        requestedSeconds: options.seconds,
        killEverySeconds: options.killEvery,
        noKill: options.noKill,
        resumed: options.resume,
        resumedAfterFailure: options.resume && options.acknowledgeFailures,
        monitors: options.monitors,
        threads: options.threads,
        seed: options.seed,
        stateFile: options.stateFile ?? '',
        dataDir: '',
        iterations: 0,
        scans: 0,
        analyses: 0,
        generations: 0,
        modelCalls: 0,
        candidates: 0,
        failures: 1,
        retries: 0,
        restarts: 0,
        kills: 0,
        activeSeconds: 0,
        maxTickActiveMs: 0,
        tickActiveLimitMs: options.maxTickActiveMs,
        drainTimeoutMs: options.drainTimeoutMs,
        drainSeconds: 0,
        drainTimedOut: false,
        memoryPeakMb: 0,
        heapFinalMb: Number((process.memoryUsage().heapUsed / 1_048_576).toFixed(2)),
        cpuUsage: { userMicros: 0, systemMicros: 0, percent: 0 },
        peakQueue: 0,
        queueCapacity: options.capacity,
        queueAtEnd: 0,
        peakLedger: 0,
        ledgerRowsAtEnd: 0,
        pendingAtEnd: 0,
        duplicateCandidates: 0,
        lostTasks: 0,
        convergenceLag: 0,
        convergenceLagPeak: 0,
        stuckIdentity: 0,
        authBlockedIdentity: 0,
        coreLockTimeouts: 0,
        lockTimeoutEvents: [],
        cursorRegressions: 0,
        completedTaskReexecutions: 0,
        unrecordedInterruptions: 0,
        unhandledErrors: 0,
        completed: false,
        sharedThreadGroups: 0,
        maxMonitorsPerThread: 0,
        totalRepliesCreated: 0,
        faults: new FaultInjector({ seed: options.seed }).stats(),
        recentFaults: [],
        diskTargets: ['auto_tasks', 'monitors', 'identities'],
        diskStoreActual: { auto_tasks: 0, monitors: 0, identities: 0 },
        diskStoreSkipped: { auto_tasks: 0, monitors: 0, identities: 0 },
        orphanSweepMs: 0,
        storeWriteFailures: 0,
        storeRestores: 0,
        storeCorruptions: 0,
        degradedDiskSessions: 0,
        undegradedDiskSessions: 0,
        recoveredDiskBlockers: 0,
        backlogSessions: 0,
        operatorResumes: 0,
        queueRejections: 0,
        prunedRows: 0,
        acknowledgedFailures: [],
        identities: { total: 0, claimed: 0, candidate: 0, ignored: 0, fallback: 0 },
        invariants: { startupCompleted: false },
        invariantFailures: [fatalError],
        limitations: ['启动失败，未执行 soak。'],
      }, options.report)
    }
    process.stderr.write(`soak 失败：${fatalError}\n`)
    process.exitCode = 1
  } finally {
    process.removeListener('uncaughtException', onUncaughtException)
    process.removeListener('unhandledRejection', onUnhandledRejection)
    if (context !== undefined) {
      context.model.server.close()
      context.model.server.closeAllConnections()
    }
  }
}

/** Node-test self tests for state round-trip and deterministic fault restore. */
export async function runSoakSelfTests(): Promise<void> {
  test('soak 状态原子写入并恢复后不重置统计', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-debate-soak-state-test-'))
    try {
      const file = join(dir, 'state.json')
      const state = createSoakState({
        startedAt: '2026-01-01T00:00:00.000Z',
        now: Date.parse('2026-01-01T00:00:00.000Z'),
        seed: 7,
        dataDir: join(dir, 'data'),
        monitors: 20,
        threads: 4,
        capacity: 1_500,
        maxTickActiveMs: 15_000, drainTimeoutMs: 300_000,
        replyEveryMs: 500,
        scanBatch: 20,
        scanEveryMs: 250,
        faults: new FaultInjector({ seed: 7 }).snapshot(),
      })
      state.iterations = 41
      state.scans = 73
      state.generations = 9
      state.authBlockedIdentity = 2
      state.drainSeconds = 1_234
      state.completed = false
      saveSoakState(file, state)
      const restored = loadSoakState(file)
      assert.equal(restored.iterations, 41)
      assert.equal(restored.scans, 73)
      assert.equal(restored.generations, 9)
      assert.equal(restored.authBlockedIdentity, 2)
      assert.equal(restored.drainTimeoutMs, 300_000)
      assert.equal(restored.drainSeconds, 1_234)
      assert.equal(restored.drainTimedOut, false)
      assert.equal(restored.completed, false)
      restored.iterations += 1
      saveSoakState(file, restored)
      assert.equal(loadSoakState(file).iterations, 42)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('soak v2 active：按 tick 累计、设上限，超限即失败', () => {
    const state = createSoakState({
      startedAt: '2026-01-01T00:00:00.000Z',
      now: Date.parse('2026-01-01T00:00:00.000Z'),
      seed: 7,
      dataDir: '/tmp/soak-active',
      monitors: 1,
      threads: 1,
      capacity: 1_500,
      maxTickActiveMs: 1_000,
      drainTimeoutMs: 300_000,
      replyEveryMs: 500,
      scanBatch: 1,
      scanEveryMs: 250,
      faults: new FaultInjector({ seed: 7 }).snapshot(),
    })
    assert.equal(recordTickActive(state, 0, 400), true)
    assert.equal(recordTickActive(state, 400, 1_200), true)
    assert.equal(state.activeMs, 1_200)
    assert.equal(state.maxTickActiveMs, 800)
    assert.equal(recordTickActive(state, 1_200, 2_600), false)
    assert.equal(state.activeMs, 2_200, '超限部分不得计入 active')
    assert.equal(state.maxTickActiveMs, 1_400)
    assert.match(state.invariantFailures.at(-1) ?? '', /超过 active 上限/)
  })

  test('soak v2 拒绝恢复缺少 active 字段的旧状态', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-debate-soak-v1-reject-'))
    try {
      const file = join(dir, 'state.json')
      writeFileSync(file, JSON.stringify({ version: 1, startedAt: '2026-01-01T00:00:00.000Z' }))
      assert.throws(() => loadSoakState(file), /状态版本/)
      const state = createSoakState({
        startedAt: '2026-01-01T00:00:00.000Z',
        now: Date.parse('2026-01-01T00:00:00.000Z'),
        seed: 7,
        dataDir: join(dir, 'data'),
        monitors: 1,
        threads: 1,
        capacity: 1_500,
        maxTickActiveMs: 1_000,
        drainTimeoutMs: 300_000,
        replyEveryMs: 500,
        scanBatch: 1,
        scanEveryMs: 250,
        faults: new FaultInjector({ seed: 7 }).snapshot(),
      })
      const { activeMs: _activeMs, maxTickActiveMs: _maxTickActiveMs, tickActiveLimitMs: _limit, ...withoutActive } = state
      writeFileSync(file, JSON.stringify({ ...withoutActive, version: 2 }))
      assert.throws(() => loadSoakState(file), /activeMs 缺失/)
      const { drainTimeoutMs: _drainTimeoutMs, ...withoutDrainTimeout } = state
      writeFileSync(file, JSON.stringify({ ...withoutDrainTimeout, version: 2 }))
      assert.throws(() => loadSoakState(file), /drainTimeoutMs 缺失/)
      writeFileSync(file, JSON.stringify({ ...state, version: 2, drainTimeoutMs: 0 }))
      assert.throws(() => loadSoakState(file), /排空超时上限无效/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('soak 不变量：仅 blocked 且 monitor 仍 blocked 豁免，failed/cancelled 严格计 stuck', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-debate-soak-blocked-identity-'))
    const monitors = new MonitorStore({ file: join(dir, 'monitors.json'), log: quiet })
    const tasks = new AutoTaskStore({ file: join(dir, 'auto-tasks.json'), log: quiet })
    const identities = new ReplyIdentityStore({ file: join(dir, 'reply-identities.json'), log: quiet })
    const store = new DebateStore({ dir: join(dir, 'core'), sessionTtlMs: 60_000, maxSessions: 10, maxUsageRows: 10 })
    try {
      monitors.load()
      tasks.load()
      identities.load()
      await store.ready()
      const monitor = monitors.create(
        { name: 'blocked-identity', url: 'https://fake.example/p/blocked', enabled: false },
        { platform: PLATFORM, threadId: 'blocked' },
      )
      const key = replyIdentityKey({ platform: PLATFORM, threadId: 'blocked', postId: 'r1', quality: 'stable', fingerprint: 'fp-r1' })
      identities.claim({ platform: PLATFORM, threadId: 'blocked', postId: 'r1', quality: 'stable', fingerprint: 'fp-r1', monitorId: monitor.id })
      const task = tasks.enqueue({ kind: 'generate', monitorId: monitor.id, postId: 'r1', identityKey: key, dedupeKey: `generate:${key}` }).task
      const state = createSoakState({
        startedAt: '2026-01-01T00:00:00.000Z',
        now: Date.parse('2026-01-01T00:00:00.000Z'),
        seed: 7,
        dataDir: join(dir, 'data'),
        monitors: 1,
        threads: 1,
        capacity: 1_500,
        maxTickActiveMs: 15_000, drainTimeoutMs: 300_000,
        replyEveryMs: 500,
        scanBatch: 1,
        scanEveryMs: 250,
        faults: new FaultInjector({ seed: 7 }).snapshot(),
      })
      const context = { state, tasks, identities, store, monitors } as SoakContext

      tasks.finish(task.id, 'failed', { error: 'model timeout', errorKind: 'network' })
      const failed = await inspectInvariants(context)
      assert.equal(failed.authBlockedIdentity, 0)
      assert.equal(failed.stuckIdentity, 1)
      assert.equal(failed.lostTasks, 0)
      assert.equal(failed.failures.some((message) => message.includes('仍未收敛')), true)

      assert.equal(tasks.retry(task.id), true)
      const retried = await inspectInvariants(context)
      assert.equal(retried.authBlockedIdentity, 0)
      assert.equal(retried.stuckIdentity, 0)
      assert.equal(retried.lostTasks, 0)
      assert.equal(tasks.get(task.id)?.state, 'pending')

      tasks.finish(task.id, 'blocked', { error: 'policy blocked', errorKind: 'auth' })
      const unbackedBlocked = await inspectInvariants(context)
      assert.equal(unbackedBlocked.authBlockedIdentity, 0)
      assert.equal(unbackedBlocked.stuckIdentity, 1)

      monitors.block(monitor.id, 'Soak 注入：平台拒绝访问（403）')
      const backedBlocked = await inspectInvariants(context)
      assert.equal(backedBlocked.authBlockedIdentity, 1)
      assert.equal(backedBlocked.stuckIdentity, 0)
      assert.equal(backedBlocked.failures.some((message) => message.includes('仍未收敛')), false)

      monitors.clearBlock(monitor.id)
      const cleared = await inspectInvariants(context)
      assert.equal(cleared.authBlockedIdentity, 0)
      assert.equal(cleared.stuckIdentity, 1)

      assert.equal(tasks.retry(task.id), true)
      tasks.finish(task.id, 'cancelled')
      const cancelled = await inspectInvariants(context)
      assert.equal(cancelled.authBlockedIdentity, 0)
      assert.equal(cancelled.stuckIdentity, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('soak 不变量：dirty 持久读挂起期间双台账推进后按新快照采样，不产生伪 stuck', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-debate-soak-snapshot-race-'))
    const monitors = new MonitorStore({ file: join(dir, 'monitors.json'), log: quiet })
    const tasks = new AutoTaskStore({ file: join(dir, 'auto-tasks.json'), log: quiet })
    const identities = new ReplyIdentityStore({ file: join(dir, 'reply-identities.json'), log: quiet })
    const store = new DebateStore({ dir: join(dir, 'core'), sessionTtlMs: 60_000, maxSessions: 10, maxUsageRows: 10 })
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    monitors.load()
    tasks.load()
    identities.load()
    await store.ready()
    const monitor = monitors.create(
      { name: 'snapshot-race', url: 'https://fake.example/p/snapshot', enabled: false },
      { platform: PLATFORM, threadId: 'snapshot' },
    )
    const key = replyIdentityKey({ platform: PLATFORM, threadId: 'snapshot', postId: 'r1', quality: 'stable', fingerprint: 'fp-r1' })
    identities.claim({ platform: PLATFORM, threadId: 'snapshot', postId: 'r1', quality: 'stable', fingerprint: 'fp-r1', monitorId: monitor.id })
    identities.attachSession(key, 'session-1')
    const task = tasks.enqueue({
      kind: 'generate',
      monitorId: monitor.id,
      postId: 'r1',
      identityKey: key,
      sessionId: 'session-1',
      dedupeKey: `generate:${key}`,
    }).task
    tasks.finish(task.id, 'failed', { error: 'old failure', errorKind: 'io' })

    const at = '2026-01-01T00:00:00.000Z'
    const candidate: StoredCandidate = {
      replyId: 'candidate-1',
      text: '已持久候选',
      strategy: 'direct_rebuttal',
      targetPostId: 'r1',
      candidateVersion: 1,
      textHash: 'hash-1',
      confidence: 0.8,
      violations: [],
      notes: [],
      approved: false,
      createdAt: at,
    }
    const session: StoredSession = {
      id: 'session-1',
      platform: PLATFORM,
      threadId: 'snapshot',
      threadTitle: '快照竞态测试帖',
      threadUrl: 'https://fake.example/p/snapshot',
      forumName: '测试吧',
      ownerKey: 'owner',
      ownerName: '楼主',
      opponentKey: 'rival',
      opponentName: '对方',
      disputeFloorPostId: 'r1',
      disputeFloorNumber: 1,
      triggerPostId: 'r1',
      persona: { style: '直接', intensity: 3, maxLength: 200 },
      comments: [],
      readQuality: { floorsRead: 0, nestedRead: 0, truncated: false, reasons: [], observationOverflow: [] },
      sentTexts: [],
      candidates: [candidate],
      state: 'READY',
      statusText: '候选已就绪',
      publishedPostIds: [],
      createdAt: at,
      updatedAt: at,
    }
    await store.mutate((data) => ({ ...data, sessions: [session] }))
    const durable = await store.readPersistedSnapshot()

    // Force the dirty path without changing the durable candidate document.
    t.mock.method(
      store as unknown as { persist(data: StoreData): Promise<void> },
      'persist',
      async () => {
        throw Object.assign(new Error('injected dirty state'), { code: 'EIO' })
      },
    )
    await assert.rejects(() => store.mutate((data) => ({
      ...data,
      sessions: data.sessions.map((row) => row.id === session.id ? { ...row, statusText: 'dirty only' } : row),
    })), /状态写入失败/)
    assert.equal(store.hasUnsavedChanges, true)

    let releaseRead!: (value: StoreData) => void
    const pendingRead = new Promise<StoreData>((resolve) => {
      releaseRead = resolve
    })
    t.mock.method(store, 'readPersistedSnapshot', async () => pendingRead)
    const state = createSoakState({
      startedAt: at,
      now: Date.parse(at),
      seed: 7,
      dataDir: join(dir, 'data'),
      monitors: 1,
      threads: 1,
      capacity: 1_500,
      maxTickActiveMs: 15_000, drainTimeoutMs: 300_000,
      replyEveryMs: 500,
      scanBatch: 1,
      scanEveryMs: 250,
      faults: new FaultInjector({ seed: 7 }).snapshot(),
    })
    const context = { state, tasks, identities, store, monitors } as SoakContext
    const inspection = inspectInvariants(context)

    // The old implementation sampled claimed+failed before awaiting the core
    // read, then paired it with the now-persisted candidate and reported stuck.
    identities.markCandidate(key, { sessionId: session.id, candidateId: candidate.replyId })
    tasks.finish(task.id, 'needs_review', { sessionId: session.id })
    releaseRead(durable)

    const result = await inspection
    assert.equal(result.stuckIdentity, 0)
    assert.equal(result.lostTasks, 0)
    assert.equal(result.duplicateCandidates, 0)
    assert.equal(result.convergenceLag, 0)
    assert.deepEqual(result.failures, [])
  })

  test('monitor-dominant 交错：A 分析中，B 发现 r3 时必须补入第二批', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-debate-soak-interleave-'))
    const urlA = 'https://fake.example/p/t1?monitor=a'
    const urlB = 'https://fake.example/p/t1?monitor=b'
    const at = '2026-01-01T00:00:00.000Z'
    const owner: FakeReplySeed = { postId: 'f1', author: '楼主', authorId: 'owner-handle', content: '楼主开场白。', createdAt: at }
    const baseline: FakeReplySeed = { postId: 'f2', author: '对方', authorId: 'rival', content: '基线回复。', createdAt: at }
    const r1: FakeReplySeed = { postId: 'r1', author: '对方', authorId: 'rival', content: '第一条新回复。', createdAt: at }
    const r2: FakeReplySeed = { postId: 'r2', author: '对方', authorId: 'rival', content: '第二条新回复。', createdAt: at }
    const r3: FakeReplySeed = { postId: 'r3', author: '对方', authorId: 'rival', content: '第三条新回复。', createdAt: at }
    const repliesA = [owner, baseline, r1, r2]
    const repliesB = [owner, baseline, r1, r2]
    const probeFor = (url: string, replies: readonly FakeReplySeed[]): ProbeResult => ({
      platform: PLATFORM,
      threadId: 't1',
      title: '交错测试帖',
      url,
      complete: true,
      pagesRead: 1,
      declaredTotal: replies.length,
      replies: replies.map((reply, index) => ({
        postId: reply.postId,
        kind: 'floor',
        authorName: reply.author,
        authorId: reply.authorId,
        content: reply.content,
        createdAt: reply.createdAt,
        floorPostId: reply.postId,
        floorNumber: index + 1,
        order: index,
        fingerprint: fingerprintOf({
          kind: 'floor',
          authorId: reply.authorId,
          authorName: reply.author,
          createdAt: reply.createdAt,
          floorPostId: reply.postId,
          content: reply.content,
        }),
        identityQuality: 'stable',
      })),
      scan: { mode: 'tail', complete: true, pagesRead: 1, totalPages: 1, repliesSeen: replies.length },
    })

    const monitors = new MonitorStore({ file: join(dir, 'monitors.json'), log: quiet })
    const tasks = new AutoTaskStore({ file: join(dir, 'auto-tasks.json'), log: quiet })
    const identities = new ReplyIdentityStore({ file: join(dir, 'reply-identities.json'), log: quiet })
    monitors.load()
    tasks.load()
    identities.load()
    const monitorA = monitors.create({ name: 'A', url: urlA }, { platform: PLATFORM, threadId: 't1' })
    // B is driven explicitly below. If its scheduler probe runs first it records
    // r1/r2 before A owns them, and the test no longer exercises the mixed
    // old-running-identity + new-identity batch that used to lose r3.
    const monitorB = monitors.create({ name: 'B', url: urlB, enabled: false }, { platform: PLATFORM, threadId: 't1' })
    const baselineFingerprint = fingerprintOf({
      kind: 'floor',
      authorId: baseline.authorId,
      authorName: baseline.author,
      createdAt: baseline.createdAt,
      floorPostId: baseline.postId,
      content: baseline.content,
    })
    for (const monitor of [monitorA, monitorB]) {
      monitors.markBaseline(monitor.id, at)
      monitors.applyScan(monitor.id, {
        at,
        coverage: 'tail',
        complete: true,
        pagesRead: 1,
        replies: [{ postId: baseline.postId, fingerprint: baselineFingerprint }],
      })
    }

    let analysisCalls = 0
    let analysisStarted = false
    let releaseFirst = (_sessionId: string): void => undefined
    const firstAnalysis = new Promise<string>((resolveFirst) => {
      releaseFirst = resolveFirst
    })
    const generatedTargets: string[] = []
    const persistedSessions = new Map<string, SessionSummary>()
    const api: DebateProductApi = {
      resolveUrl: (url) => ({ platform: PLATFORM, threadId: 't1', url }),
      probe: async (input) => probeFor(input.url, input.url === urlA ? repliesA : repliesB),
      analyze: async () => {
        analysisCalls += 1
        if (analysisCalls === 1) {
          analysisStarted = true
          return { sessionId: await firstAnalysis }
        }
        return { sessionId: `session-${analysisCalls}` }
      },
      generate: async (input) => {
        const targetPostId = input.targetPostId ?? 'unknown'
        const candidateId = `candidate-${targetPostId}`
        generatedTargets.push(targetPostId)
        const current = persistedSessions.get(input.sessionId)
        persistedSessions.set(input.sessionId, {
          id: input.sessionId,
          platform: PLATFORM,
          threadId: 't1',
          threadTitle: '交错测试帖',
          threadUrl: urlA,
          state: 'ready',
          createdAt: at,
          updatedAt: at,
          candidates: [
            ...(current?.candidates ?? []),
            { replyId: candidateId, text: '候选', targetPostId, candidateVersion: 1, createdAt: at },
          ],
        })
        return { ok: true, outcome: 'valid_draft', candidateId }
      },
      session: async (sessionId) => persistedSessions.get(sessionId),
      sessionForThread: async () => undefined,
      ownerIdentity: () => ({ handle: 'owner-handle', userName: '楼主' }),
    }
    const engine = new AutomationEngine({
      monitors,
      tasks,
      identities,
      api: () => api,
      log: quiet as never,
      tickMs: 3_600_000,
      orphanSweepMs: 0,
      concurrency: 2,
      perPlatformConcurrency: 2,
    })
    const tickUntil = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await engine.tick()
        if (predicate()) return
        await sleep(10)
      }
      assert.fail('monitor-dominant 交错测试等待超时')
    }
    engine.start()
    try {
      tasks.enqueue({ kind: 'probe', monitorId: monitorA.id, dedupeKey: `probe:${monitorA.id}` })
      await tickUntil(() => analysisStarted && tasks.runningCount() === 1)
      const firstBatch = tasks.all().find((task) => task.kind === 'analyze' && task.state === 'running')
      assert.ok(firstBatch !== undefined, 'A 的分析批次应处于运行中')
      assert.deepEqual(monitors.get(monitorB.id)?.seen, [baseline.postId], 'B 不得提前自动记录 r1/r2')
      repliesB.push(r3)
      tasks.enqueue({ kind: 'probe', monitorId: monitorB.id, dedupeKey: `probe:${monitorB.id}` })
      const r3Key = replyIdentityKey({
        platform: PLATFORM,
        threadId: 't1',
        postId: r3.postId,
        quality: 'stable',
        fingerprint: '',
      })
      await tickUntil(() => identities.get(r3Key) !== undefined)
      await tickUntil(() => tasks.all().some((task) =>
        task.kind === 'analyze' && task.identityKeys?.includes(r3Key) === true,
      ))
      const covering = tasks.all().find((task) =>
        task.kind === 'analyze' && task.identityKeys?.includes(r3Key) === true,
      )
      assert.ok(covering !== undefined, 'r3 必须被分析批次覆盖，不能成为 orphan')
      assert.notEqual(covering.id, firstBatch.id, '运行中的第一批不能吞掉 r3')
      assert.equal(firstBatch.identityKeys?.includes(r3Key) ?? false, false)
      assert.deepEqual(covering.identityKeys, [r3Key], '第二批只能包含尚未覆盖的 r3')
      assert.deepEqual(covering.postIds, [r3.postId])

      releaseFirst('session-a')
      await tickUntil(() => identities.get(r3Key)?.state === 'candidate' && generatedTargets.length === 3)
      assert.deepEqual([...generatedTargets].sort(), ['r1', 'r2', 'r3'])
      assert.equal(identities.stats().candidate, 3)
    } finally {
      releaseFirst('session-finally')
      await engine.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1])
if (process.env.NODE_TEST_CONTEXT !== undefined) {
  await runSoakSelfTests()
} else if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2))
  if (options.selfTest) await runSoakSelfTests()
  else await runSoak(options)
}
