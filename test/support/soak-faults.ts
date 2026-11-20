/**
 * Deterministic fault injection for the v0.2.2 soak harness.
 *
 * The injector never pretends a fault happened. Every attempted fault is recorded
 * as `actual` or `skipped`, and its PRNG/counter state can be serialized so a
 * resumed soak continues the same fault sequence instead of restarting it.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

import { PlatformError } from '../../packages/core/lib/types.js'

export type SoakFaultKind =
  | 'platform_rate_limited'
  | 'platform_forbidden'
  | 'platform_network'
  | 'platform_malformed_response'
  | 'platform_500'
  | 'model_timeout'
  | 'model_500'
  | 'disk_write'
  | 'queue_backlog'
  | 'duplicate_reply'
  | 'process_kill'
  | 'store_write_failed'

export type FaultOutcome = 'actual' | 'skipped'
export type DiskStoreName = 'auto_tasks' | 'monitors' | 'identities'

export interface FaultCount {
  actual: number
  skipped: number
}

export interface FaultRecord {
  readonly kind: SoakFaultKind
  readonly outcome: FaultOutcome
  readonly at: string
  readonly detail?: string
}

export interface FaultInjectorOptions {
  readonly seed?: number
  readonly platformChance?: number
  readonly modelChance?: number
  readonly diskChance?: number
  readonly backlogChance?: number
  readonly duplicateReplyChance?: number
  readonly killEverySec?: number
  readonly platformMinIntervalMs?: number
  readonly modelMinIntervalMs?: number
  readonly diskMinIntervalMs?: number
  readonly backlogMinIntervalMs?: number
  readonly diskDurationMs?: number
  readonly backlogDurationMs?: number
  readonly modelTimeoutDelayMs?: number
}

export interface FaultInjectorSnapshot {
  readonly version: 1
  readonly configSignature: string
  readonly rngState: number
  readonly nextAllowedAt: Record<string, number>
  readonly nextKillAt?: number
  readonly counts: Record<SoakFaultKind, FaultCount>
  readonly recent: readonly FaultRecord[]
}

export interface ModelFault {
  readonly kind: 'timeout' | 'server_500'
  readonly status: 500 | 502 | 503 | 504
}

const FAULT_KINDS: readonly SoakFaultKind[] = [
  'platform_rate_limited',
  'platform_forbidden',
  'platform_network',
  'platform_malformed_response',
  'platform_500',
  'model_timeout',
  'model_500',
  'disk_write',
  'queue_backlog',
  'duplicate_reply',
  'process_kill',
  'store_write_failed',
]

function emptyCounts(): Record<SoakFaultKind, FaultCount> {
  return Object.fromEntries(FAULT_KINDS.map((kind) => [kind, { actual: 0, skipped: 0 }])) as Record<SoakFaultKind, FaultCount>
}

function chance(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new Error(`故障概率必须在 0..1 之间：${String(resolved)}`)
  }
  return resolved
}

/** Small deterministic PRNG (mulberry32); one 32-bit state is enough to resume. */
export class SeededRandom {
  #state: number

  constructor(seed: number, state?: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new Error(`seed 必须是 0..4294967295 的整数：${String(seed)}`)
    }
    this.#state = state ?? seed
  }

  next(): number {
    let value = (this.#state += 0x6d2b79f5)
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }

  integer(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1))
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new Error('不能从空列表中选择故障')
    return values[Math.floor(this.next() * values.length)] as T
  }

  get state(): number {
    return this.#state
  }
}

/**
 * A cross-platform write blocker.
 *
 * Renaming the live file aside and putting an empty directory at its path makes
 * the product's temp-file-plus-rename write fail on POSIX and Windows without
 * relying on chmod (which is not a reliable permission control on Windows).
 */
export class DiskWriteFault {
  readonly target: string
  readonly #hidden: string
  #active = false
  #observed = false

  constructor(target: string) {
    this.target = target
    this.#hidden = `${target}.soak-hidden`
  }

  get active(): boolean {
    return this.#active
  }

  get observed(): boolean {
    return this.#observed
  }

  activate(): void {
    if (this.#active) return
    if (!existsSync(this.target)) throw new Error(`磁盘故障目标不存在：${this.target}`)
    if (existsSync(this.#hidden)) throw new Error(`磁盘故障恢复文件已存在：${this.#hidden}`)
    mkdirSync(dirname(this.target), { recursive: true })
    renameSync(this.target, this.#hidden)
    try {
      mkdirSync(this.target)
    } catch (error) {
      renameSync(this.#hidden, this.target)
      throw error
    }
    this.#active = true
  }

  noteObserved(): void {
    this.#observed = true
  }

  restore(): void {
    if (!this.#active) return
    try {
      const stat = lstatSync(this.target)
      if (!stat.isDirectory()) throw new Error(`磁盘故障目标被替换成了非目录：${this.target}`)
      rmSync(this.target, { recursive: true, force: true })
      renameSync(this.#hidden, this.target)
      this.#active = false
    } catch (error) {
      // Keep the hidden original. A later recovery pass is safer than deleting
      // the only copy because the blocker could not be removed.
      throw new Error(`磁盘故障恢复失败（原文件保留在 ${this.#hidden}）：${String(error)}`, { cause: error })
    }
  }

  /** Repair blockers left behind by SIGKILL before stores load their files. */
  static recover(root: string): number {
    if (!existsSync(root)) return 0
    let recovered = 0
    for (const name of readdirSync(root)) {
      if (!name.endsWith('.soak-hidden')) continue
      const hidden = join(root, name)
      const target = hidden.slice(0, -'.soak-hidden'.length)
      if (!existsSync(target)) {
        renameSync(hidden, target)
        recovered += 1
        continue
      }
      const stat = lstatSync(target)
      if (stat.isDirectory()) {
        rmSync(target, { recursive: true, force: true })
        renameSync(hidden, target)
        recovered += 1
      }
    }
    return recovered
  }
}

/** Seeded, resumable source of platform/model/storage/process faults. */
export class FaultInjector {
  readonly options: Readonly<Required<FaultInjectorOptions>>
  random: SeededRandom
  #nextAllowedAt: Record<string, number>
  #nextKillAt: number | undefined
  #counts: Record<SoakFaultKind, FaultCount>
  #recent: FaultRecord[] = []

  constructor(options: FaultInjectorOptions = {}) {
    const seed = options.seed ?? 1
    this.options = {
      seed,
      platformChance: chance(options.platformChance, 0.08),
      modelChance: chance(options.modelChance, 0.12),
      diskChance: chance(options.diskChance, 0.01),
      backlogChance: chance(options.backlogChance, 0.01),
      duplicateReplyChance: chance(options.duplicateReplyChance, 0.08),
      killEverySec: Math.max(0, options.killEverySec ?? 0),
      platformMinIntervalMs: Math.max(0, options.platformMinIntervalMs ?? 750),
      modelMinIntervalMs: Math.max(0, options.modelMinIntervalMs ?? 750),
      diskMinIntervalMs: Math.max(0, options.diskMinIntervalMs ?? 5_000),
      backlogMinIntervalMs: Math.max(0, options.backlogMinIntervalMs ?? 5_000),
      diskDurationMs: Math.max(250, options.diskDurationMs ?? 1_500),
      backlogDurationMs: Math.max(250, options.backlogDurationMs ?? 2_000),
      modelTimeoutDelayMs: Math.max(1_100, options.modelTimeoutDelayMs ?? 1_800),
    }
    this.random = new SeededRandom(seed)
    this.#nextAllowedAt = {}
    this.#nextKillAt = undefined
    this.#counts = emptyCounts()
  }

  /** Restore a snapshot, rejecting a snapshot made with different probabilities. */
  static restore(snapshot: FaultInjectorSnapshot, options: FaultInjectorOptions = {}): FaultInjector {
    const injector = new FaultInjector(options)
    if (snapshot.version !== 1) throw new Error(`不认识的 FaultInjector 状态版本：${String(snapshot.version)}`)
    if (snapshot.configSignature !== injector.configSignature) {
      throw new Error('FaultInjector 状态与当前故障参数不一致，拒绝静默改变故障序列')
    }
    injector.random = new SeededRandom(injector.options.seed, snapshot.rngState)
    injector.#nextAllowedAt = { ...snapshot.nextAllowedAt }
    injector.#nextKillAt = snapshot.nextKillAt
    injector.#counts = Object.fromEntries(
      FAULT_KINDS.map((kind) => [kind, { ...snapshot.counts[kind] }]),
    ) as Record<SoakFaultKind, FaultCount>
    injector.#recent = snapshot.recent.slice(-20)
    return injector
  }

  get configSignature(): string {
    const { killEverySec: _killEverySec, ...stableOptions } = this.options
    return JSON.stringify(stableOptions)
  }

  get diskDurationMs(): number {
    return this.options.diskDurationMs
  }

  get backlogDurationMs(): number {
    return this.options.backlogDurationMs
  }

  get modelTimeoutDelayMs(): number {
    return this.options.modelTimeoutDelayMs
  }

  /** Return a platform error when the seeded schedule selects one. */
  platformFault(now = Date.now()): PlatformError | undefined {
    if (!this.#gate('platform', now, this.options.platformMinIntervalMs)) return undefined
    if (this.random.next() >= this.options.platformChance) return undefined
    const kind = this.random.pick([
      'platform_rate_limited',
      'platform_forbidden',
      'platform_network',
      'platform_malformed_response',
      'platform_500',
    ] as const)
    if (kind === 'platform_rate_limited') {
      const retryAfterMs = this.random.integer(1_000, 4_000)
      this.mark(kind, 'actual', `retryAfterMs=${retryAfterMs}`, now)
      return new PlatformError('Soak 注入：平台限流（429）', 'rate_limited', { status: 429, retryAfterMs })
    }
    if (kind === 'platform_forbidden') {
      this.mark(kind, 'actual', 'status=403', now)
      return new PlatformError('Soak 注入：平台拒绝访问（403）', 'forbidden', { status: 403 })
    }
    if (kind === 'platform_network') {
      this.mark(kind, 'actual', 'ECONNRESET', now)
      return new PlatformError('Soak 注入：网络连接被重置', 'network', { status: 503 })
    }
    if (kind === 'platform_malformed_response') {
      this.mark(kind, 'actual', 'malformed_response', now)
      return new PlatformError('Soak 注入：平台返回结构损坏', 'malformed_response', { status: 502 })
    }
    this.mark(kind, 'actual', 'status=500', now)
    return new PlatformError('Soak 注入：平台内部错误（500）', 'unknown', { status: 500 })
  }

  /** Return a model fault descriptor for the mock HTTP endpoint. */
  modelFault(now = Date.now()): ModelFault | undefined {
    if (!this.#gate('model', now, this.options.modelMinIntervalMs)) return undefined
    if (this.random.next() >= this.options.modelChance) return undefined
    if (this.random.next() < 0.5) {
      this.mark('model_timeout', 'actual', `delayMs=${this.options.modelTimeoutDelayMs}`, now)
      return { kind: 'timeout', status: 504 }
    }
    const status = this.random.pick([500, 502, 503] as const)
    this.mark('model_500', 'actual', `status=${status}`, now)
    return { kind: 'server_500', status }
  }

  /** Whether a storage write should be blocked at the next safe point. */
  diskFault(now = Date.now()): boolean {
    if (!this.#gate('disk', now, this.options.diskMinIntervalMs, true)) return false
    if (this.random.next() >= this.options.diskChance) return false
    return true
  }

  /** Whether the queue should be paused long enough to build a backlog. */
  backlogFault(now = Date.now()): boolean {
    if (!this.#gate('backlog', now, this.options.backlogMinIntervalMs, true)) return false
    if (this.random.next() >= this.options.backlogChance) return false
    return true
  }

  duplicateReply(): boolean {
    if (this.random.next() >= this.options.duplicateReplyChance) return false
    this.mark('duplicate_reply', 'actual', 'same postId repeated in one probe', Date.now())
    return true
  }

  /** Arm the first kill relative to this process, never relative to the epoch. */
  armKillSchedule(now = Date.now()): void {
    if (this.options.killEverySec > 0 && this.#nextKillAt === undefined) {
      this.#nextKillAt = now + this.options.killEverySec * 1_000
    }
  }

  /** Explicit opt-in only. The runner passes --kill-every for child processes. */
  killDue(now = Date.now()): boolean {
    if (this.#nextKillAt === undefined || this.options.killEverySec <= 0 || now < this.#nextKillAt) return false
    this.#nextKillAt = now + this.options.killEverySec * 1_000
    return true
  }

  /** Record a real store callback; this is observation, not synthetic success. */
  noteStoreEvent(store: DiskStoreName, event: string, detail: Record<string, unknown>, now = Date.now()): void {
    if (event !== 'write_failed') return
    this.mark('store_write_failed', 'actual', `${store}: ${String(detail.reason ?? 'write failed')}`, now)
  }

  mark(kind: SoakFaultKind, outcome: FaultOutcome, detail?: string, now = Date.now()): FaultRecord {
    this.#counts[kind][outcome] += 1
    const record: FaultRecord = {
      kind,
      outcome,
      at: new Date(now).toISOString(),
      ...(detail === undefined ? {} : { detail }),
    }
    this.#recent.push(record)
    this.#recent = this.#recent.slice(-20)
    return record
  }

  /** Undo a just-recorded event when its required side effect did not happen. */
  unmark(record: FaultRecord): void {
    this.#counts[record.kind][record.outcome] = Math.max(0, this.#counts[record.kind][record.outcome] - 1)
    this.#recent = this.#recent.filter((entry) => entry !== record)
  }

  stats(): Record<SoakFaultKind, FaultCount> {
    return Object.fromEntries(FAULT_KINDS.map((kind) => [kind, { ...this.#counts[kind] }])) as Record<SoakFaultKind, FaultCount>
  }

  recent(): readonly FaultRecord[] {
    return this.#recent.map((entry) => ({ ...entry }))
  }

  snapshot(): FaultInjectorSnapshot {
    return {
      version: 1,
      configSignature: this.configSignature,
      rngState: this.random.state,
      nextAllowedAt: { ...this.#nextAllowedAt },
      ...(this.#nextKillAt === undefined ? {} : { nextKillAt: this.#nextKillAt }),
      counts: this.stats(),
      recent: this.recent(),
    }
  }

  #gate(key: string, now: number, minIntervalMs: number, delayFirst = false): boolean {
    const next = this.#nextAllowedAt[key]
    if (next === undefined && delayFirst) {
      this.#nextAllowedAt[key] = now + minIntervalMs
      return minIntervalMs === 0
    }
    if (next !== undefined && now < next) return false
    this.#nextAllowedAt[key] = now + minIntervalMs
    return true
  }
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
test('FaultInjector 相同 seed 产生相同故障，快照恢复后继续同一序列', () => {
  const options: FaultInjectorOptions = {
    seed: 42,
    platformChance: 1,
    modelChance: 1,
    diskChance: 1,
    backlogChance: 1,
    duplicateReplyChance: 1,
    platformMinIntervalMs: 0,
    modelMinIntervalMs: 0,
    diskMinIntervalMs: 0,
    backlogMinIntervalMs: 0,
  }
  const left = new FaultInjector(options)
  const right = new FaultInjector(options)
  for (let index = 1; index <= 12; index += 1) {
    const now = index * 100
    const leftPlatform = left.platformFault(now)
    const rightPlatform = right.platformFault(now)
    assert.equal(leftPlatform?.code, rightPlatform?.code)
    assert.equal(leftPlatform?.status, rightPlatform?.status)
    assert.equal(leftPlatform?.retryAfterMs, rightPlatform?.retryAfterMs)
    assert.deepEqual(left.modelFault(now), right.modelFault(now))
    assert.equal(left.diskFault(now), right.diskFault(now))
    assert.equal(left.backlogFault(now), right.backlogFault(now))
    assert.equal(left.duplicateReply(), right.duplicateReply())
  }
  assert.deepEqual(left.stats(), right.stats())

  const restored = FaultInjector.restore(left.snapshot(), options)
  for (let index = 13; index <= 20; index += 1) {
    const now = index * 100
    const leftPlatform = left.platformFault(now)
    const restoredPlatform = restored.platformFault(now)
    assert.equal(leftPlatform?.code, restoredPlatform?.code)
    assert.equal(leftPlatform?.status, restoredPlatform?.status)
    assert.equal(leftPlatform?.retryAfterMs, restoredPlatform?.retryAfterMs)
    assert.deepEqual(left.modelFault(now), restored.modelFault(now))
  }
  assert.deepEqual(left.snapshot().rngState, restored.snapshot().rngState)
})

test('DiskWriteFault 对三类 store 实际阻止写入，并可在 SIGKILL 后恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-soak-disk-test-'))
  const files = ['auto-tasks.json', 'monitors.json', 'reply-identities.json']
  try {
    for (const name of files) writeFileSync(join(dir, name), '{"original":true}\n', 'utf8')
    for (const name of files) {
      const target = join(dir, name)
      const blocker = new DiskWriteFault(target)
      blocker.activate()
      assert.throws(() => writeFileSync(target, 'replacement', 'utf8'))
      blocker.noteObserved()
      assert.equal(blocker.observed, true)
      blocker.restore()
      assert.equal(readFileSync(target, 'utf8'), '{"original":true}\n')
    }

    for (const name of files) new DiskWriteFault(join(dir, name)).activate()
    assert.equal(DiskWriteFault.recover(dir), 3)
    for (const name of files) {
      const target = join(dir, name)
      assert.equal(readFileSync(target, 'utf8'), '{"original":true}\n')
      assert.equal(existsSync(`${target}.soak-hidden`), false)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
}
