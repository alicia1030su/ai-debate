/** Orphan-claim recovery must converge without duplicating candidates. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DebateProductApi, GenerateResult, ProbeResult, SessionSummary } from '../../core/src/product-api.ts'
import { AtomicWriteError } from '../src/atomic.ts'
import { AutomationEngine } from '../src/monitor/engine.ts'
import { ReplyIdentityStore } from '../src/monitor/identities.ts'
import { MonitorStore } from '../src/monitor/store.ts'
import { AutoTaskStore } from '../src/monitor/tasks.ts'
import { silentLogger } from '../src/logger.ts'

const PLATFORM = 'faketieba'
const THREAD_ID = 't016'
const POST_ID = 'r4'
const IDENTITY_KEY = `stable:${PLATFORM}:${THREAD_ID}:${POST_ID}`

function sessionWithCandidate(sessionId: string, candidateId: string): SessionSummary {
  return {
    id: sessionId,
    platform: PLATFORM,
    threadId: THREAD_ID,
    threadTitle: '恢复测试帖',
    threadUrl: 'https://fake.example/p/t016',
    state: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    candidates: [{
      replyId: candidateId,
      text: '既有候选',
      targetPostId: POST_ID,
      candidateVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
  }
}

function probeWithReply(postId: string): ProbeResult {
  const at = '2026-01-01T00:00:00.000Z'
  return {
    platform: PLATFORM,
    threadId: THREAD_ID,
    title: '恢复测试帖',
    url: 'https://fake.example/p/t016',
    complete: true,
    pagesRead: 1,
    declaredTotal: 1,
    replies: [{
      postId,
      kind: 'floor',
      authorName: '对方',
      authorId: 'rival',
      content: '一条新的反对意见。',
      createdAt: at,
      floorPostId: postId,
      floorNumber: 1,
      order: 0,
      fingerprint: `fp-${postId}`,
      identityQuality: 'stable',
    }],
    scan: { mode: 'tail', complete: true, pagesRead: 1, totalPages: 1, repliesSeen: 1 },
  }
}

interface Harness {
  readonly monitors: MonitorStore
  readonly tasks: AutoTaskStore
  readonly identities: ReplyIdentityStore
  readonly engine: AutomationEngine
  readonly monitorId: string
  readonly now: { value: number }
  readonly calls: { generate: number; analyze: number; session: number }
  setGenerate(handler: () => Promise<GenerateResult>): void
  setSession(handler: (sessionId: string) => Promise<SessionSummary | undefined>): void
  reload(): Promise<Harness>
  dispose(): Promise<void>
}

function harness(options: {
  generate?: () => Promise<GenerateResult>
  analyze?: () => Promise<{ sessionId: string }>
  probe?: () => Promise<ProbeResult>
  session?: (sessionId: string) => Promise<SessionSummary | undefined>
} = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-orphan-'))
  const log = silentLogger()
  const monitors = new MonitorStore({ file: join(dir, 'monitors.json'), log })
  monitors.load()
  const tasks = new AutoTaskStore({ file: join(dir, 'tasks.json'), log })
  tasks.load()
  const identities = new ReplyIdentityStore({ file: join(dir, 'identities.json'), log })
  identities.load()
  const monitor = monitors.create(
    { name: '恢复测试', url: 'https://fake.example/p/t016', platform: PLATFORM, enabled: false },
    { platform: PLATFORM, threadId: THREAD_ID },
  )
  const now = { value: Date.now() }
  const calls = { generate: 0, analyze: 0, session: 0 }
  let generate = options.generate ?? (async () => ({ ok: true, outcome: 'valid_draft', candidateId: 'new-candidate' }))
  let session = options.session ?? (async () => undefined)
  const api: DebateProductApi = {
    resolveUrl: (url) => ({ platform: PLATFORM, threadId: THREAD_ID, url }),
    probe: async () => {
      if (options.probe === undefined) throw new Error('测试不应读取平台')
      return options.probe()
    },
    analyze: async () => {
      calls.analyze += 1
      return options.analyze === undefined ? { sessionId: 'analysis-session' } : options.analyze()
    },
    generate: async () => {
      calls.generate += 1
      return generate()
    },
    session: async (sessionId) => {
      calls.session += 1
      return session(sessionId)
    },
    sessionForThread: async () => undefined,
    ownerIdentity: () => ({ handle: 'owner' }),
  }
  const makeEngine = (
    nextMonitors: MonitorStore,
    nextTasks: AutoTaskStore,
    nextIdentities: ReplyIdentityStore,
  ): AutomationEngine => new AutomationEngine({
    monitors: nextMonitors,
    tasks: nextTasks,
    identities: nextIdentities,
    api: () => api,
    log,
    tickMs: 3_600_000,
    orphanSweepMs: 0,
    now: () => now.value,
  })
  const engine = makeEngine(monitors, tasks, identities)
  async function reload(currentEngine: AutomationEngine): Promise<Harness> {
    await currentEngine.stop()
    const nextMonitors = new MonitorStore({ file: join(dir, 'monitors.json'), log })
    nextMonitors.load()
    const nextTasks = new AutoTaskStore({ file: join(dir, 'tasks.json'), log })
    nextTasks.load()
    const nextIdentities = new ReplyIdentityStore({ file: join(dir, 'identities.json'), log })
    nextIdentities.load()
    const nextEngine = makeEngine(nextMonitors, nextTasks, nextIdentities)
    return {
      monitors: nextMonitors,
      tasks: nextTasks,
      identities: nextIdentities,
      engine: nextEngine,
      monitorId: monitor.id,
      now,
      calls,
      setGenerate(handler: () => Promise<GenerateResult>): void {
        generate = handler
      },
      setSession(handler: (sessionId: string) => Promise<SessionSummary | undefined>): void {
        session = handler
      },
      reload: () => reload(nextEngine),
      async dispose(): Promise<void> {
        await nextEngine.stop()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }
  return {
    monitors,
    tasks,
    identities,
    engine,
    monitorId: monitor.id,
    now,
    calls,
    setGenerate(handler: () => Promise<GenerateResult>): void {
      generate = handler
    },
    setSession(handler: (sessionId: string) => Promise<SessionSummary | undefined>): void {
      session = handler
    },
    reload: () => reload(engine),
    async dispose(): Promise<void> {
      await engine.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function claim(kit: Harness): void {
  kit.identities.claim({
    platform: PLATFORM,
    threadId: THREAD_ID,
    postId: POST_ID,
    quality: 'stable',
    fingerprint: 'fingerprint',
    monitorId: kit.monitorId,
  })
}

async function tickUntil(kit: Harness, predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    await kit.engine.tick()
    if (predicate()) return true
    kit.now.value += 25
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

test('发现写序：分析任务写失败时游标不得推进，恢复后补分析任务', async (t) => {
  const kit = harness({ probe: async () => probeWithReply(POST_ID) })
  t.after(() => kit.dispose())
  kit.monitors.markBaseline(kit.monitorId, new Date(kit.now.value - 1_000).toISOString())
  const originalEnqueue = kit.tasks.enqueue.bind(kit.tasks)
  let injected = false
  let failWrites = true
  kit.tasks.enqueue = (...args: Parameters<AutoTaskStore['enqueue']>) => {
    if (args[0].kind === 'analyze' && failWrites) {
      injected = true
      throw new AtomicWriteError('io', 'tasks.json', 'injected analysis enqueue failure')
    }
    return originalEnqueue(...args)
  }
  kit.tasks.enqueue({ kind: 'probe', monitorId: kit.monitorId, dedupeKey: `probe:${kit.monitorId}` })
  kit.engine.start()
  try {
    assert.equal(await tickUntil(kit, () => injected && kit.engine.status().degraded !== undefined), true)
    assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'claimed')
    assert.equal(kit.monitors.get(kit.monitorId)?.seen.includes(POST_ID), false, '任务未持久化时游标不得推进')
    assert.equal(kit.tasks.all().some((task) => task.kind === 'analyze'), false)

    failWrites = false
    kit.tasks.enqueue = originalEnqueue
    kit.now.value += 30_001
    assert.equal(await tickUntil(kit, () => kit.tasks.all().some((task) => task.kind === 'analyze')), true)
    assert.equal(kit.monitors.get(kit.monitorId)?.seen.includes(POST_ID), false, '恢复任务不应伪造游标')
    assert.equal(kit.calls.generate, 0)
  } finally {
    kit.tasks.enqueue = originalEnqueue
  }
})

test('孤儿对账：failed generate 收敛为 ignored，人工 retry 仍可生成候选', async (t) => {
  const kit = harness({
    generate: async () => { throw Object.assign(new Error('model timeout'), { code: 'timeout' }) },
  })
  t.after(() => kit.dispose())
  claim(kit)
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'generation-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
    maxAttempts: 1,
  })
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.tasks.get(task.id)?.state === 'failed'), true)
  assert.equal(kit.tasks.get(task.id)?.modelCall?.uncertain, true)
  assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'ignored'), true)
  assert.match(kit.identities.get(IDENTITY_KEY)?.lastError ?? '', /失败.*模型调用结果不确定.*手动重试/)
  assert.equal(kit.identities.stats().claimed, 0)
  assert.equal(kit.tasks.all().filter((entry) => entry.kind === 'generate').length, 1, '不应自动重开生成任务')
  assert.equal(kit.calls.generate, 1)
  assert.equal(kit.tasks.get(task.id)?.logs.some((entry) => entry.message === '操作员手动重试'), false, '自动收口不得写手动重试标记')

  let manualCandidateStored = false
  kit.setGenerate(async () => {
    manualCandidateStored = true
    return { ok: true, outcome: 'valid_draft', candidateId: 'manual-candidate' }
  })
  kit.setSession(async (sessionId) => manualCandidateStored
    ? sessionWithCandidate(sessionId, 'manual-candidate')
    : { ...sessionWithCandidate(sessionId, 'core-candidate'), candidates: [] })
  assert.equal(kit.tasks.retry(task.id), true)
  assert.equal(kit.tasks.get(task.id)?.logs.some((entry) => entry.message === '操作员手动重试'), true, 'retry 必须持久化手动标记')
  assert.equal(
    await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'candidate'),
    true,
    JSON.stringify({ identity: kit.identities.get(IDENTITY_KEY), task: kit.tasks.get(task.id), calls: kit.calls }),
  )
  assert.equal(kit.identities.get(IDENTITY_KEY)?.candidateId, 'manual-candidate')
  assert.equal(kit.tasks.get(task.id)?.state, 'needs_review')
  assert.equal(kit.calls.generate, 2, '仅操作员显式重试才再次调用模型')
})

for (const candidateId of [undefined, ''] as const) {
  test(`生成结果：ok=true 但 candidateId=${candidateId === undefined ? '缺失' : '为空'}时不得写入 candidate 身份`, async (t) => {
    const kit = harness({
      generate: async () => ({
        ok: true,
        outcome: 'valid_draft',
        ...(candidateId === undefined ? {} : { candidateId }),
      }),
    })
    t.after(() => kit.dispose())
    claim(kit)
    const { task } = kit.tasks.enqueue({
      kind: 'generate',
      monitorId: kit.monitorId,
      postId: POST_ID,
      identityKey: IDENTITY_KEY,
      sessionId: 'generation-session',
      dedupeKey: `generate:${IDENTITY_KEY}`,
      maxAttempts: 1,
    })
    kit.engine.start()

    assert.equal(await tickUntil(kit, () => kit.tasks.get(task.id)?.state === 'failed'), true)
    assert.equal(kit.tasks.get(task.id)?.modelCall?.uncertain, true)
    assert.equal(kit.tasks.get(task.id)?.lastErrorKind, 'permanent')
    assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'ignored', '核心无候选时按既有失败路径收口')
    assert.equal(kit.identities.get(IDENTITY_KEY)?.candidateId, undefined)
    assert.equal(kit.identities.stats().candidate, 0)
    assert.equal(kit.tasks.all().length, 1)
    assert.equal(kit.calls.generate, 1)
  })
}

test('生成成功但核心无持久候选：不得写 candidate 身份或 needs_review', async (t) => {
  const kit = harness({
    generate: async () => ({ ok: true, outcome: 'valid_draft', candidateId: 'ghost-candidate' }),
    session: async (sessionId) => ({ ...sessionWithCandidate(sessionId, 'core-candidate'), candidates: [] }),
  })
  t.after(() => kit.dispose())
  claim(kit)
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'generation-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
    maxAttempts: 1,
  })
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.tasks.get(task.id)?.state === 'failed'), true)
  assert.equal(kit.tasks.get(task.id)?.modelCall?.uncertain, true)
  assert.equal(kit.tasks.get(task.id)?.modelCall?.candidateId, 'ghost-candidate', 'candidateId 只保留为待核验提示')
  assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'ignored')
  assert.equal(kit.identities.get(IDENTITY_KEY)?.candidateId, undefined)
  assert.equal(kit.tasks.all().some((entry) => entry.state === 'needs_review'), false)
  assert.equal(kit.calls.generate, 1)
})

test('启动恢复：candidate 身份与 needs_review 在核心无候选时熔断，重载保持幂等', async (t) => {
  const kit = harness({
    session: async (sessionId) => ({ ...sessionWithCandidate(sessionId, 'core-candidate'), candidates: [] }),
  })
  let active = kit
  t.after(() => active.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'generation-session')
  kit.identities.markCandidate(IDENTITY_KEY, { sessionId: 'generation-session', candidateId: 'ghost-candidate' })
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'generation-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
    maxAttempts: 1,
  })
  kit.tasks.finish(task.id, 'needs_review', { sessionId: 'generation-session' })

  active = await kit.reload()
  active.engine.start()
  assert.equal(await tickUntil(active, () =>
    active.identities.get(IDENTITY_KEY)?.state === 'ignored'
    && active.tasks.get(task.id)?.state === 'failed',
  ), true)
  assert.equal(active.tasks.get(task.id)?.lastErrorKind, 'candidate_missing')
  assert.match(active.tasks.get(task.id)?.lastError ?? '', /核心持久会话未确认/)
  assert.match(active.identities.get(IDENTITY_KEY)?.lastError ?? '', /数据不一致.*未调用模型/)
  assert.equal(active.identities.get(IDENTITY_KEY)?.candidateId, 'ghost-candidate', '保留原始候选提示作为审计证据')
  assert.equal(active.tasks.all().some((entry) => entry.state === 'needs_review'), false)
  assert.equal(active.calls.generate, 0, '幽灵候选恢复不得再次调用模型')
  assert.equal(active.calls.analyze, 0)

  const readsBeforeReload = active.calls.session
  active = await active.reload()
  active.engine.start()
  for (let index = 0; index < 3; index += 1) {
    active.now.value += 25
    await active.engine.tick()
  }
  assert.equal(active.identities.get(IDENTITY_KEY)?.state, 'ignored')
  assert.equal(active.tasks.get(task.id)?.state, 'failed')
  assert.equal(active.calls.session, readsBeforeReload, 'ignored 身份重载后不得重复核验')
  assert.equal(active.calls.generate, 0)
})

test('候选身份核验：核心 candidateId 与身份提示不一致时以核心为准，保留唯一审核行', async (t) => {
  const kit = harness({ session: async (sessionId) => sessionWithCandidate(sessionId, 'core-candidate') })
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'generation-session')
  kit.identities.markCandidate(IDENTITY_KEY, { sessionId: 'generation-session', candidateId: 'stale-hint' })
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'generation-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
    maxAttempts: 1,
  })
  kit.tasks.beginModelCall(task.id)
  kit.tasks.finishModelCall(task.id, { candidateId: 'stale-hint', uncertain: true })
  kit.tasks.finish(task.id, 'needs_review', { sessionId: 'generation-session' })
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.candidateId === 'core-candidate'), true)
  assert.equal(kit.tasks.get(task.id)?.modelCall?.candidateId, 'core-candidate', '审核 provenance 必须指向核心确认候选')
  assert.equal(kit.tasks.get(task.id)?.modelCall?.uncertain, true, '修正 provenance 不得抹掉历史不确定性')
  assert.equal(kit.tasks.all().filter((entry) => entry.state === 'needs_review').length, 1)
  assert.equal(kit.calls.generate, 0)
  assert.equal(kit.calls.analyze, 0)
})

test('verified 缓存：核心有候选但 review 未建立时不得缓存，下轮继续核验', async (t) => {
  const kit = harness({ session: async (sessionId) => sessionWithCandidate(sessionId, 'core-candidate') })
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'generation-session')
  kit.identities.markCandidate(IDENTITY_KEY, { sessionId: 'generation-session', candidateId: 'core-candidate' })
  assert.equal(kit.monitors.remove(kit.monitorId), true)
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.calls.session >= 1), true)
  const firstReads = kit.calls.session
  for (let index = 0; index < 3; index += 1) {
    kit.now.value += 25
    await kit.engine.tick()
  }
  assert.ok(kit.calls.session > firstReads, '没有 review 的候选证据不能进入本进程 verified 缓存')
  assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'candidate')
  assert.equal(kit.tasks.all().some((entry) => entry.state === 'needs_review'), false)
  assert.equal(kit.calls.generate, 0)
})

test('verified 缓存：恢复 review 写失败时不得缓存，任务恢复完成后再缓存', async (t) => {
  const kit = harness({ session: async (sessionId) => sessionWithCandidate(sessionId, 'core-candidate') })
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'generation-session')
  kit.identities.markCandidate(IDENTITY_KEY, { sessionId: 'generation-session', candidateId: 'core-candidate' })
  const originalFinish = kit.tasks.finish.bind(kit.tasks)
  const originalClaim = kit.tasks.claim.bind(kit.tasks)
  let failWrites = true
  let blockClaims = true
  kit.tasks.finish = (id, state, detail = {}) => {
    if (state === 'needs_review' && failWrites) {
      throw new AtomicWriteError('io', 'tasks.json', 'injected recovered review failure')
    }
    return originalFinish(id, state, detail)
  }
  // start() launches recovery and scheduling concurrently. Keep the recovered row
  // pending while the write is injected to fail; otherwise a fast scheduler can
  // claim it first and turn this cache regression into a lease-recovery timing test.
  kit.tasks.claim = (...args: Parameters<AutoTaskStore['claim']>) => blockClaims ? undefined : originalClaim(...args)
  kit.engine.start()
  try {
    assert.equal(await tickUntil(kit, () => kit.tasks.all().some((task) => task.state === 'pending')), true)
    assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'candidate')
    assert.equal(kit.tasks.all().some((task) => task.state === 'needs_review'), false)

    failWrites = false
    blockClaims = false
    kit.tasks.finish = originalFinish
    kit.tasks.claim = originalClaim
    assert.equal(await tickUntil(kit, () => kit.tasks.all().some((task) => task.state === 'needs_review')), true)
    const readsAfterReview = kit.calls.session
    for (let index = 0; index < 3; index += 1) {
      kit.now.value += 25
      await kit.engine.tick()
    }
    assert.equal(kit.calls.session, readsAfterReview, 'review 持久化成功后本进程才可缓存')
    assert.equal(kit.calls.generate, 0)
  } finally {
    kit.tasks.finish = originalFinish
    kit.tasks.claim = originalClaim
  }
})

test('恢复竞态：身份在核心查询期间变为 stale candidate，recordRecoveredCandidate 以核心值纠正', async (t) => {
  const lookup = deferred<SessionSummary | undefined>()
  const lookupStarted = deferred<void>()
  const kit = harness({
    session: async () => {
      lookupStarted.resolve()
      return lookup.promise
    },
  })
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'stale-session')
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'core-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
    maxAttempts: 1,
  })
  kit.tasks.finish(task.id, 'failed', { error: 'old failure', errorKind: 'io' })
  kit.engine.start()
  await lookupStarted.promise

  // Simulate another path winning the identity write while core lookup is in
  // flight. Both the session and candidate hints are now stale.
  kit.identities.markCandidate(IDENTITY_KEY, { sessionId: 'stale-session', candidateId: 'stale-hint' })
  kit.tasks.beginModelCall(task.id)
  kit.tasks.finishModelCall(task.id, { candidateId: 'stale-hint', uncertain: true })
  kit.tasks.finish(task.id, 'needs_review', { sessionId: 'core-session' })
  lookup.resolve(sessionWithCandidate('core-session', 'core-candidate'))

  assert.equal(await tickUntil(kit, () =>
    kit.identities.get(IDENTITY_KEY)?.sessionId === 'core-session'
    && kit.identities.get(IDENTITY_KEY)?.candidateId === 'core-candidate'
    && kit.tasks.get(task.id)?.modelCall?.candidateId === 'core-candidate',
  ), true)
  assert.equal(kit.tasks.get(task.id)?.modelCall?.uncertain, true)
  assert.equal(kit.tasks.get(task.id)?.state, 'needs_review')
  assert.equal(kit.calls.generate, 0)
  assert.equal(kit.calls.analyze, 0)
})

test('幽灵候选反向窗口：identity ignored 先落盘、task failed 写失败，下轮只补任务', async (t) => {
  const kit = harness({
    session: async (sessionId) => ({ ...sessionWithCandidate(sessionId, 'core-candidate'), candidates: [] }),
  })
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'generation-session')
  kit.identities.markCandidate(IDENTITY_KEY, { sessionId: 'generation-session', candidateId: 'ghost-candidate' })
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'generation-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
    maxAttempts: 1,
  })
  kit.tasks.finish(task.id, 'needs_review', { sessionId: 'generation-session' })
  const originalFinish = kit.tasks.finish.bind(kit.tasks)
  let injected = false
  let failWrites = true
  kit.tasks.finish = (id, state, detail = {}) => {
    if (id === task.id && state === 'failed' && failWrites) {
      injected = true
      throw new AtomicWriteError('io', 'tasks.json', 'injected ghost task close failure')
    }
    return originalFinish(id, state, detail)
  }
  kit.engine.start()
  try {
    assert.equal(await tickUntil(kit, () => injected
      && kit.identities.get(IDENTITY_KEY)?.state === 'ignored'
      && kit.tasks.get(task.id)?.state === 'needs_review'), true)
    const readsBeforeRecovery = kit.calls.session

    failWrites = false
    kit.tasks.finish = originalFinish
    assert.equal(await tickUntil(kit, () => kit.tasks.get(task.id)?.state === 'failed'), true)
    assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'ignored')
    assert.equal(kit.tasks.get(task.id)?.lastErrorKind, 'candidate_missing')
    assert.equal(kit.calls.generate, 0)
    assert.equal(kit.calls.session, readsBeforeRecovery, '补写终态任务不得再次读取核心')
  } finally {
    kit.tasks.finish = originalFinish
  }
})

test('幽灵候选写失败二：identity ignored 写失败时保留 candidate+needs_review，恢复后收口', async (t) => {
  const kit = harness({
    session: async (sessionId) => ({ ...sessionWithCandidate(sessionId, 'core-candidate'), candidates: [] }),
  })
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'generation-session')
  kit.identities.markCandidate(IDENTITY_KEY, { sessionId: 'generation-session', candidateId: 'ghost-candidate' })
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'generation-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
    maxAttempts: 1,
  })
  kit.tasks.finish(task.id, 'needs_review', { sessionId: 'generation-session' })
  const originalIgnore = kit.identities.markIgnored.bind(kit.identities)
  let injected = false
  let failWrites = true
  kit.identities.markIgnored = (key, reason, at) => {
    if (failWrites) {
      injected = true
      throw new AtomicWriteError('io', 'identities.json', 'injected ghost identity close failure')
    }
    return originalIgnore(key, reason, at)
  }
  kit.engine.start()
  try {
    assert.equal(await tickUntil(kit, () => injected), true)
    assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'candidate')
    assert.equal(kit.tasks.get(task.id)?.state, 'needs_review')
    assert.notEqual(kit.tasks.get(task.id)?.state, 'failed', '身份熔断写失败时不得先暴露 candidate+failed')

    failWrites = false
    kit.identities.markIgnored = originalIgnore
    assert.equal(await tickUntil(kit, () =>
      kit.identities.get(IDENTITY_KEY)?.state === 'ignored' && kit.tasks.get(task.id)?.state === 'failed'), true)
    assert.equal(kit.tasks.get(task.id)?.lastErrorKind, 'candidate_missing')
    assert.equal(kit.calls.generate, 0)
  } finally {
    kit.identities.markIgnored = originalIgnore
  }
})

test('候选缺失实时分支：identity ignored 写失败不得先暴露 failed+candidate', async (t) => {
  const kit = harness({
    session: async (sessionId) => ({ ...sessionWithCandidate(sessionId, 'core-candidate'), candidates: [] }),
  })
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'generation-session')
  kit.identities.markCandidate(IDENTITY_KEY, { sessionId: 'generation-session', candidateId: 'ghost-candidate' })
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'generation-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
    maxAttempts: 1,
  })
  const originalIgnore = kit.identities.markIgnored.bind(kit.identities)
  let injected = false
  kit.identities.markIgnored = (key, reason, at) => {
    if (!injected) {
      injected = true
      throw new AtomicWriteError('io', 'identities.json', 'injected live identity close failure')
    }
    return originalIgnore(key, reason, at)
  }
  kit.engine.start()
  try {
    assert.equal(await tickUntil(kit, () => injected && kit.tasks.get(task.id)?.state === 'running'), true)
    assert.notEqual(kit.tasks.get(task.id)?.state, 'failed')
    assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'candidate')

    kit.identities.markIgnored = originalIgnore
    assert.deepEqual(kit.tasks.recoverInterrupted(), { recovered: 1, uncertain: 0 })
    kit.now.value += 30_001
    assert.equal(await tickUntil(kit, () =>
      kit.identities.get(IDENTITY_KEY)?.state === 'ignored' && kit.tasks.get(task.id)?.state === 'failed',
    ), true)
    assert.equal(kit.calls.generate, 0)
  } finally {
    kit.identities.markIgnored = originalIgnore
  }
})

test('生成候选身份：核心暂不可读时无模型延后核验，恢复后转待审核', async (t) => {
  const kit = harness()
  kit.setSession(async () => { throw new Error('core session unreadable') })
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'generation-session')
  kit.identities.markCandidate(IDENTITY_KEY, { sessionId: 'generation-session', candidateId: 'stored-candidate' })
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'generation-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
    maxAttempts: 2,
  })
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.tasks.get(task.id)?.state === 'retry_wait'), true)
  assert.equal(kit.tasks.get(task.id)?.lastErrorKind, 'candidate_unavailable')
  assert.equal(kit.calls.generate, 0, '等待核心核验期间不得调用模型')
  assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'candidate')

  kit.setSession(async () => sessionWithCandidate('generation-session', 'stored-candidate'))
  kit.now.value += 30_001
  assert.equal(await tickUntil(kit, () => kit.tasks.get(task.id)?.state === 'needs_review'), true)
  assert.equal(kit.calls.generate, 0)
  assert.equal(kit.tasks.all().length, 1)
})

test('生成候选身份：核心确认候选不存在时失败关闭，不得转待审核或调用模型', async (t) => {
  const kit = harness({ session: async () => ({ ...sessionWithCandidate('generation-session', 'core-candidate'), candidates: [] }) })
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'generation-session')
  kit.identities.markCandidate(IDENTITY_KEY, { sessionId: 'generation-session', candidateId: 'ghost-candidate' })
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'generation-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
    maxAttempts: 1,
  })
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.tasks.get(task.id)?.state === 'failed'), true)
  assert.equal(kit.tasks.get(task.id)?.lastErrorKind, 'candidate_missing')
  assert.equal(kit.calls.generate, 0)
  assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'ignored', '启动/周期对账必须收口核心已确认缺失的候选身份')
  assert.match(kit.identities.get(IDENTITY_KEY)?.lastError ?? '', /核心不存在匹配目标/)
  assert.equal(kit.tasks.all().length, 1)
})

test('孤儿对账：generate 超时但核心已有候选时立即转待审核，不留下 failed+claimed', async (t) => {
  let candidateStored = false
  const kit = harness({
    generate: async () => {
      candidateStored = true
      throw Object.assign(new Error('model timeout'), { code: 'timeout' })
    },
    session: async () => candidateStored ? sessionWithCandidate('generation-session', 'stored-candidate') : undefined,
  })
  t.after(() => kit.dispose())
  claim(kit)
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'generation-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
    maxAttempts: 1,
  })
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.tasks.get(task.id)?.state === 'needs_review'), true)
  assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'candidate')
  assert.equal(kit.identities.get(IDENTITY_KEY)?.candidateId, 'stored-candidate')
  assert.equal(kit.tasks.get(task.id)?.modelCall?.uncertain, true)
  assert.equal(kit.calls.generate, 1)
})

test('孤儿对账：blocked auth 与 blocked monitor 保持覆盖，不重复重排', async (t) => {
  const kit = harness({
    analyze: async () => { throw Object.assign(new Error('login required'), { code: 'auth_required' }) },
  })
  t.after(() => kit.dispose())
  claim(kit)
  const { task } = kit.tasks.enqueue({
    kind: 'analyze',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    dedupeKey: `analyze:${IDENTITY_KEY}`,
  })
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.tasks.get(task.id)?.state === 'blocked'), true)
  for (let index = 0; index < 3; index += 1) {
    kit.now.value += 1
    await kit.engine.tick()
  }
  assert.notEqual(kit.monitors.get(kit.monitorId)?.blockedReason, undefined)
  assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'claimed')
  assert.equal(kit.tasks.all().length, 1)
  assert.equal(kit.tasks.get(task.id)?.state, 'blocked')
  assert.equal(kit.calls.analyze, 1)

  kit.monitors.clearBlock(kit.monitorId)
  kit.now.value += 25
  await kit.engine.tick()
  assert.equal(kit.tasks.all().length, 2, 'monitor 恢复后 blocked task 不再覆盖，sweep 才重排')
  assert.equal(kit.tasks.get(task.id)?.state, 'blocked', '原 blocked 证据不被改写')
  assert.equal(kit.tasks.all().filter((entry) => entry.id !== task.id)[0]?.identityKey, IDENTITY_KEY)
})

test('孤儿对账：monitor 已 blocked 不掩盖终态 generate，仍收敛为 ignored', async (t) => {
  const kit = harness()
  t.after(() => kit.dispose())
  claim(kit)
  kit.monitors.block(kit.monitorId, 'login required')
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'generation-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
  })
  kit.tasks.finish(task.id, 'failed', { error: 'model timeout', errorKind: 'timeout' })
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'ignored'), true)
  assert.equal(kit.identities.stats().claimed, 0)
  assert.equal(kit.tasks.all().length, 1)
  assert.equal(kit.calls.generate, 0)
})

test('孤儿对账：终态 uncertain generate 先发现既有候选，不调用模型', async (t) => {
  const kit = harness({ session: async () => sessionWithCandidate('generation-session', 'stored-candidate') })
  t.after(() => kit.dispose())
  claim(kit)
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'generation-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
    maxAttempts: 1,
  })
  kit.tasks.claim(kit.now.value)
  kit.tasks.beginModelCall(task.id)
  kit.tasks.finishModelCall(task.id, { uncertain: true })
  kit.tasks.finish(task.id, 'failed', { error: 'model timeout', errorKind: 'timeout' })
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'candidate'), true)
  assert.equal(kit.identities.get(IDENTITY_KEY)?.candidateId, 'stored-candidate')
  assert.equal(kit.tasks.get(task.id)?.state, 'failed', '失败任务证据不被恢复动作改写')
  assert.equal(kit.tasks.all().length, 1)
  assert.equal(kit.calls.generate, 0)
})

test('孤儿对账：task.modelCall.candidateId 在核心不存在时不得作为候选证据', async (t) => {
  const kit = harness({ session: async () => ({ ...sessionWithCandidate('generation-session', 'core-candidate'), candidates: [] }) })
  t.after(() => kit.dispose())
  claim(kit)
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'generation-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
    maxAttempts: 1,
  })
  kit.tasks.claim(kit.now.value)
  kit.tasks.beginModelCall(task.id)
  kit.tasks.finishModelCall(task.id, { candidateId: 'ghost-candidate', uncertain: true })
  kit.tasks.finish(task.id, 'failed', { error: 'model timeout', errorKind: 'timeout' })
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'ignored'), true)
  assert.ok(kit.calls.session > 0, 'task candidateId 必须读取核心核验')
  assert.equal(kit.tasks.get(task.id)?.modelCall?.candidateId, 'ghost-candidate')
  assert.equal(kit.identities.get(IDENTITY_KEY)?.candidateId, undefined)
  assert.equal(kit.tasks.all().length, 1)
  assert.equal(kit.calls.generate, 0)
})

test('孤儿对账：claim 已落盘但任务缺失时恢复链路，最终复用候选', async (t) => {
  const kit = harness({ session: async () => sessionWithCandidate('analysis-session', 'stored-candidate') })
  t.after(() => kit.dispose())
  claim(kit)
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'candidate'), true)
  assert.equal(kit.identities.get(IDENTITY_KEY)?.candidateId, 'stored-candidate')
  assert.equal(kit.tasks.all().filter((entry) => entry.kind === 'analyze').length, 1)
  assert.equal(kit.tasks.all().filter((entry) => entry.kind === 'generate').length, 1)
  assert.equal(kit.calls.analyze, 1)
  assert.equal(kit.calls.generate, 0)
})

test('孤儿对账：completed analyze 命中候选时原任务转待审核，generate 创建次数为 0', async (t) => {
  const kit = harness()
  let generateTasksAtLookup = -1
  kit.setSession(async () => {
    generateTasksAtLookup = kit.tasks.all().filter((entry) => entry.kind === 'generate').length
    return sessionWithCandidate('analysis-session', 'stored-candidate')
  })
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'analysis-session')
  const { task } = kit.tasks.enqueue({
    kind: 'analyze',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'analysis-session',
    dedupeKey: `analyze:${IDENTITY_KEY}`,
  })
  kit.tasks.finish(task.id, 'completed', { sessionId: 'analysis-session' })
  assert.equal(kit.monitors.remove(kit.monitorId), true)
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'candidate'), true)
  assert.equal(kit.identities.get(IDENTITY_KEY)?.candidateId, 'stored-candidate')
  assert.equal(kit.tasks.all().length, 1, '不得创建 generate 任务')
  assert.equal(kit.tasks.get(task.id)?.kind, 'analyze')
  assert.equal(kit.tasks.get(task.id)?.state, 'needs_review', '原 analyze 任务直接承载审核语义')
  assert.equal(kit.tasks.all().filter((entry) => entry.kind === 'generate').length, 0)
  assert.equal(generateTasksAtLookup, 0, '候选解析必须发生在任何 generate enqueue 之前')
  assert.equal(kit.calls.analyze, 0)
  assert.equal(kit.calls.generate, 0)
})

test('孤儿对账：恢复既有候选不得重复累计 monitor 候选计数', async (t) => {
  const kit = harness({ session: async () => sessionWithCandidate('analysis-session', 'stored-candidate') })
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'analysis-session')
  const { task } = kit.tasks.enqueue({
    kind: 'analyze',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'analysis-session',
    dedupeKey: `analyze:${IDENTITY_KEY}`,
  })
  kit.tasks.finish(task.id, 'completed', { sessionId: 'analysis-session' })
  kit.monitors.noteOutcome(kit.monitorId, 'candidate')
  kit.monitors.noteOutcome(kit.monitorId, 'candidate')
  const before = kit.monitors.get(kit.monitorId)?.counters
  assert.equal(before?.candidates, 2)

  kit.engine.start()
  assert.equal(await tickUntil(kit, () =>
    kit.identities.get(IDENTITY_KEY)?.state === 'candidate' && kit.tasks.get(task.id)?.state === 'needs_review'), true)
  assert.deepEqual(kit.monitors.get(kit.monitorId)?.counters, before, '历史候选恢复不是新候选生产')
  assert.equal(kit.calls.analyze, 0)
  assert.equal(kit.calls.generate, 0)
})

test('崩溃窗口：completed analyze 的 markCandidate 写失败保持 completed/claimed，下次 sweep 无模型修复', async (t) => {
  const kit = harness()
  kit.setSession(async () => sessionWithCandidate('analysis-session', 'stored-candidate'))
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'analysis-session')
  const { task } = kit.tasks.enqueue({
    kind: 'analyze',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'analysis-session',
    dedupeKey: `analyze:${IDENTITY_KEY}`,
  })
  kit.tasks.finish(task.id, 'completed', { sessionId: 'analysis-session' })
  const originalMarkCandidate = kit.identities.markCandidate.bind(kit.identities)
  let injectWrite = true
  let injected = false
  kit.identities.markCandidate = (key, detail, at) => {
    if (injectWrite) {
      injected = true
      throw new AtomicWriteError('io', 'identities.json', 'injected candidate identity write failure')
    }
    return originalMarkCandidate(key, detail, at)
  }
  try {
    kit.engine.start()
    assert.equal(await tickUntil(kit, () => injected && kit.engine.status().degraded !== undefined), true)
    assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'claimed')
    assert.equal(kit.tasks.get(task.id)?.state, 'completed', '身份写失败不得改写 analyze 终态')
    assert.equal(kit.tasks.all().length, 1)
    assert.equal(kit.tasks.all().filter((entry) => entry.kind === 'generate').length, 0)
    assert.equal(kit.calls.generate, 0)

    injectWrite = false
    kit.identities.markCandidate = originalMarkCandidate
    kit.now.value += 30_001
    assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'candidate'), true)
    assert.equal(kit.tasks.get(task.id)?.state, 'needs_review')
    assert.equal(kit.tasks.all().filter((entry) => entry.kind === 'generate').length, 0)
    assert.equal(kit.calls.generate, 0)
  } finally {
    kit.identities.markCandidate = originalMarkCandidate
  }
})

test('崩溃窗口：identity candidate 写成功、analyze needs_review 写失败，重载后不重复候选或模型', async (t) => {
  const kit = harness()
  kit.setSession(async () => sessionWithCandidate('analysis-session', 'stored-candidate'))
  let active = kit
  t.after(() => active.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'analysis-session')
  const { task } = kit.tasks.enqueue({
    kind: 'analyze',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'analysis-session',
    dedupeKey: `analyze:${IDENTITY_KEY}`,
  })
  kit.tasks.finish(task.id, 'completed', { sessionId: 'analysis-session' })
  const originalFinish = kit.tasks.finish.bind(kit.tasks)
  let injected = false
  kit.tasks.finish = (id, state, detail = {}) => {
    if (id === task.id && state === 'needs_review') {
      injected = true
      throw new AtomicWriteError('io', 'tasks.json', 'injected analyze review write failure')
    }
    return originalFinish(id, state, detail)
  }
  try {
    kit.engine.start()
    assert.equal(await tickUntil(kit, () =>
      injected
      && kit.identities.get(IDENTITY_KEY)?.state === 'candidate'
      && kit.tasks.get(task.id)?.state === 'completed',
    ), true)
    assert.equal(kit.tasks.all().length, 1)
    assert.equal(kit.tasks.all().filter((entry) => entry.kind === 'generate').length, 0)
    assert.equal(kit.calls.generate, 0)

    const sessionReadsBeforeReload = kit.calls.session
    active = await kit.reload()
    active.engine.start()
    assert.equal(await tickUntil(active, () => active.tasks.get(task.id)?.state === 'needs_review'), true)
    assert.equal(active.identities.get(IDENTITY_KEY)?.state, 'candidate')
    assert.equal(active.identities.get(IDENTITY_KEY)?.candidateId, 'stored-candidate')
    assert.equal(active.identities.all().length, 1, '候选身份不重复')
    assert.equal(active.tasks.get(task.id)?.kind, 'analyze')
    assert.equal(active.tasks.get(task.id)?.state, 'needs_review', '重载后 sweep 补写原分析任务待审核状态')
    assert.equal(active.tasks.all().length, 1)
    assert.equal(active.tasks.all().filter((entry) => entry.kind === 'generate').length, 0)
    assert.equal(active.calls.analyze, 0)
    assert.equal(active.calls.generate, 0, '对账不得调用模型')
    assert.equal(active.calls.session, sessionReadsBeforeReload + 1, '重载后必须读取核心核验持久化 candidateId')
    const sessionReadsAfterReview = active.calls.session

    const reloadedFinish = active.tasks.finish.bind(active.tasks)
    let finishCalls = 0
    active.tasks.finish = (id, state, detail = {}) => {
      finishCalls += 1
      return reloadedFinish(id, state, detail)
    }
    try {
      for (let index = 0; index < 3; index += 1) {
        active.now.value += 25
        await active.engine.tick()
      }
    } finally {
      active.tasks.finish = reloadedFinish
    }
    assert.equal(finishCalls, 0, 'analyze 已 needs_review 时对账幂等')
    assert.equal(active.calls.session, sessionReadsAfterReview, '已收敛后不得重复核验核心')
    assert.equal(active.tasks.all().length, 1)
    assert.equal(active.identities.all().length, 1)
  } finally {
    kit.tasks.finish = originalFinish
  }
})

test('正常链路：已有 generate 待审核时不得重复提升 analyze 或候选计数', async (t) => {
  const kit = harness()
  kit.setSession(async (sessionId) => sessionWithCandidate(sessionId, 'stored-candidate'))
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'analysis-session')
  const { task: analysis } = kit.tasks.enqueue({
    kind: 'analyze',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'analysis-session',
    dedupeKey: `analyze:${IDENTITY_KEY}`,
  })
  kit.tasks.finish(analysis.id, 'completed', { sessionId: 'analysis-session' })
  const { task: generation } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'analysis-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
  })
  kit.tasks.finish(generation.id, 'needs_review', { sessionId: 'analysis-session' })
  kit.identities.markCandidate(IDENTITY_KEY, { sessionId: 'analysis-session', candidateId: 'stored-candidate' })
  kit.monitors.noteOutcome(kit.monitorId, 'candidate')
  kit.engine.start()
  assert.equal(await tickUntil(kit, () => kit.calls.session === 1), true, '启动时必须核验已有审核行的核心候选证据')

  for (let index = 0; index < 3; index += 1) {
    kit.now.value += 25
    await kit.engine.tick()
  }
  assert.equal(kit.tasks.get(analysis.id)?.state, 'completed', '正常 analyze 终态不应被重复提升')
  assert.equal(kit.tasks.get(generation.id)?.state, 'needs_review')
  assert.equal(kit.tasks.all().filter((entry) => entry.state === 'needs_review').length, 1)
  assert.equal(kit.monitors.get(kit.monitorId)?.counters.candidates, 1, '候选计数不得重复增加')
  assert.equal(kit.calls.session, 1, '同一进程只核验一次已收敛的候选证据')
  assert.equal(kit.calls.analyze, 0)
  assert.equal(kit.calls.generate, 0)
})

test('孤儿对账：只有 candidateId 提示而没有 sessionId 时保持 unavailable', async (t) => {
  const kit = harness()
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.markCandidate(IDENTITY_KEY, { candidateId: 'stored-candidate' })
  const { task } = kit.tasks.enqueue({
    kind: 'analyze',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    dedupeKey: `analyze:${IDENTITY_KEY}`,
  })
  kit.tasks.finish(task.id, 'completed')
  kit.engine.start()

  for (let index = 0; index < 3; index += 1) {
    kit.now.value += 25
    await kit.engine.tick()
  }
  assert.equal(kit.calls.session, 0, '没有 sessionId 时无法读取核心')
  assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'candidate')
  assert.equal(kit.tasks.get(task.id)?.state, 'completed', '无法核验时不得转为待审核或判定无候选')
  assert.equal(kit.tasks.all().length, 1)
  assert.equal(kit.calls.generate, 0)
})

test('孤儿对账：多 session 中任一可读会话确认提示 candidateId 即可收敛', async (t) => {
  const kit = harness()
  const reads: string[] = []
  kit.setSession(async (sessionId) => {
    reads.push(sessionId)
    return sessionWithCandidate(sessionId, sessionId === 'session-b' ? 'preferred-candidate' : 'other-candidate')
  })
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'session-a')
  kit.identities.markCandidate(IDENTITY_KEY, { sessionId: 'session-a', candidateId: 'preferred-candidate' })
  const { task: generation } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'session-b',
    dedupeKey: `generate:${IDENTITY_KEY}`,
  })
  kit.tasks.finish(generation.id, 'failed', { error: 'bookkeeping failed', errorKind: 'io' })
  const { task: analysis } = kit.tasks.enqueue({
    kind: 'analyze',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'session-a',
    dedupeKey: `analyze:${IDENTITY_KEY}`,
  })
  kit.tasks.finish(analysis.id, 'completed', { sessionId: 'session-a' })
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.tasks.get(analysis.id)?.state === 'needs_review'), true)
  assert.deepEqual(reads, ['session-a', 'session-b'], '应先检查无提示匹配的会话，再确认后续会话中的提示 ID')
  assert.equal(kit.identities.get(IDENTITY_KEY)?.candidateId, 'preferred-candidate')
  assert.equal(kit.tasks.all().length, 2)
  assert.equal(kit.calls.generate, 0)
})

for (const scenario of ['no-match', 'fallback'] as const) {
  test(`孤儿对账：多 session 中任一读取失败时保持 unavailable（${scenario}）`, async (t) => {
    const kit = harness()
    const reads: string[] = []
    kit.setSession(async (sessionId) => {
      reads.push(sessionId)
      if (sessionId === 'session-b') throw new Error('core session unreadable')
      return {
        ...sessionWithCandidate(sessionId, 'other-candidate'),
        candidates: scenario === 'fallback'
          ? sessionWithCandidate(sessionId, 'other-candidate').candidates
          : [],
      }
    })
    t.after(() => kit.dispose())
    claim(kit)
    kit.identities.attachSession(IDENTITY_KEY, 'session-a')
    kit.identities.markCandidate(IDENTITY_KEY, { sessionId: 'session-a', candidateId: 'preferred-candidate' })
    const { task: generation } = kit.tasks.enqueue({
      kind: 'generate',
      monitorId: kit.monitorId,
      postId: POST_ID,
      identityKey: IDENTITY_KEY,
      sessionId: 'session-b',
      dedupeKey: `generate:${IDENTITY_KEY}`,
    })
    kit.tasks.finish(generation.id, 'failed', { error: 'bookkeeping failed', errorKind: 'io' })
    const { task: analysis } = kit.tasks.enqueue({
      kind: 'analyze',
      monitorId: kit.monitorId,
      postId: POST_ID,
      identityKey: IDENTITY_KEY,
      sessionId: 'session-a',
      dedupeKey: `analyze:${IDENTITY_KEY}`,
    })
    kit.tasks.finish(analysis.id, 'completed', { sessionId: 'session-a' })
    kit.engine.start()

    for (let index = 0; index < 3; index += 1) {
      kit.now.value += 25
      await kit.engine.tick()
    }
    assert.ok(reads.includes('session-a') && reads.includes('session-b'))
    assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'candidate')
    assert.equal(kit.tasks.get(analysis.id)?.state, 'completed', '任一读取失败时不得用其他会话的 fallback 或缺失结果收敛')
    assert.equal(kit.tasks.all().length, 2)
    assert.equal(kit.calls.generate, 0)
  })
}

test('孤儿对账：所有可读 session 均无匹配候选时才判定 absent', async (t) => {
  const kit = harness()
  const reads: string[] = []
  kit.setSession(async (sessionId) => {
    reads.push(sessionId)
    return { ...sessionWithCandidate(sessionId, 'other-candidate'), candidates: [] }
  })
  t.after(() => kit.dispose())
  claim(kit)
  for (const sessionId of ['session-a', 'session-b']) {
    const { task } = kit.tasks.enqueue({
      kind: 'generate',
      monitorId: kit.monitorId,
      postId: POST_ID,
      identityKey: IDENTITY_KEY,
      sessionId,
      dedupeKey: `generate:${sessionId}`,
      maxAttempts: 1,
    })
    kit.tasks.finish(task.id, 'failed', { error: 'model timeout', errorKind: 'timeout' })
  }
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'ignored'), true)
  assert.deepEqual(reads, ['session-b', 'session-a'])
  assert.equal(kit.tasks.all().length, 2)
  assert.equal(kit.calls.generate, 0)
})

test('孤儿对账：合法 candidateId 在核心不可读时 fail-closed，恢复并核验后补写待审核', async (t) => {
  const kit = harness()
  kit.setSession(async () => { throw new Error('core session unreadable') })
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'analysis-session')
  kit.identities.markCandidate(IDENTITY_KEY, { sessionId: 'analysis-session', candidateId: 'stored-candidate' })
  const { task } = kit.tasks.enqueue({
    kind: 'analyze',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'analysis-session',
    dedupeKey: `analyze:${IDENTITY_KEY}`,
  })
  kit.tasks.finish(task.id, 'completed', { sessionId: 'analysis-session' })
  kit.engine.start()

  for (let index = 0; index < 3; index += 1) {
    kit.now.value += 25
    await kit.engine.tick()
  }
  assert.ok(kit.calls.session > 0, '即使存在 candidateId 也必须读取核心核验')
  assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'candidate')
  assert.equal(kit.tasks.get(task.id)?.state, 'completed', '核心不可读不得直接信任 candidateId')
  assert.equal(kit.tasks.all().length, 1)
  assert.equal(kit.tasks.all().filter((entry) => entry.kind === 'generate').length, 0)
  assert.equal(kit.calls.generate, 0)

  kit.setSession(async () => sessionWithCandidate('analysis-session', 'stored-candidate'))
  assert.equal(await tickUntil(kit, () => kit.tasks.get(task.id)?.state === 'needs_review'), true)
  assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'candidate')
  assert.equal(kit.identities.all().length, 1)
  assert.equal(kit.tasks.all().length, 1)
  assert.equal(kit.tasks.all().filter((entry) => entry.kind === 'generate').length, 0)
  assert.equal(kit.calls.analyze, 0)
  assert.equal(kit.calls.generate, 0)
})

for (const scenario of ['missing', 'wrong-target'] as const) {
  test(`孤儿对账：candidateId 指向核心${scenario === 'missing' ? '不存在' : '目标不匹配'}的候选时不得转待审核`, async (t) => {
    const kit = harness()
    const candidate = sessionWithCandidate('analysis-session', 'core-candidate').candidates[0]!
    kit.setSession(async () => ({
      ...sessionWithCandidate('analysis-session', 'core-candidate'),
      candidates: scenario === 'missing'
        ? []
        : [{ ...candidate, targetPostId: 'another-post' }],
    }))
    t.after(() => kit.dispose())
    claim(kit)
    kit.identities.attachSession(IDENTITY_KEY, 'analysis-session')
    kit.identities.markCandidate(IDENTITY_KEY, {
      sessionId: 'analysis-session',
      candidateId: scenario === 'missing' ? 'ghost-candidate' : 'core-candidate',
    })
    const { task } = kit.tasks.enqueue({
      kind: 'analyze',
      monitorId: kit.monitorId,
      postId: POST_ID,
      identityKey: IDENTITY_KEY,
      sessionId: 'analysis-session',
      dedupeKey: `analyze:${IDENTITY_KEY}`,
    })
    kit.tasks.finish(task.id, 'completed', { sessionId: 'analysis-session' })
    kit.engine.start()

    for (let index = 0; index < 3; index += 1) {
      kit.now.value += 25
      await kit.engine.tick()
    }
    assert.ok(kit.calls.session > 0)
    assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'ignored', '核心确认无匹配候选后必须收口身份')
    assert.equal(kit.tasks.get(task.id)?.state, 'completed', '没有核心候选证据不得伪造审核状态')
    assert.equal(kit.tasks.all().length, 1)
    assert.equal(kit.tasks.all().filter((entry) => entry.kind === 'generate').length, 0)
    assert.equal(kit.calls.analyze, 0)
    assert.equal(kit.calls.generate, 0)
  })
}

for (const state of ['completed', 'needs_review'] as const) {
  test(`孤儿对账：${state} generate 无候选时显式熔断为 ignored`, async (t) => {
    const kit = harness()
    t.after(() => kit.dispose())
    claim(kit)
    const { task } = kit.tasks.enqueue({
      kind: 'generate',
      monitorId: kit.monitorId,
      postId: POST_ID,
      identityKey: IDENTITY_KEY,
      sessionId: 'generation-session',
      dedupeKey: `generate:${IDENTITY_KEY}`,
    })
    kit.tasks.finish(task.id, state, { sessionId: 'generation-session' })
    kit.engine.start()

    assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'ignored'), true)
    assert.match(kit.identities.get(IDENTITY_KEY)?.lastError ?? '', /已(?: completed|待审核).*未找到候选/)
    if (state === 'needs_review') {
      assert.match(kit.identities.get(IDENTITY_KEY)?.lastError ?? '', /数据不一致.*待审核.*未找到候选/)
    }
    assert.equal(kit.identities.stats().claimed, 0)
    assert.equal(kit.tasks.all().length, 1)
    assert.equal(kit.calls.generate, 0)
  })
}

test('孤儿对账：failed analyze 带 session 时仍先查候选，存在则直接待审核', async (t) => {
  const kit = harness()
  kit.setSession(async () => sessionWithCandidate('analysis-session', 'stored-candidate'))
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'analysis-session')
  const { task } = kit.tasks.enqueue({
    kind: 'analyze',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'analysis-session',
    dedupeKey: `analyze:${IDENTITY_KEY}`,
  })
  kit.tasks.finish(task.id, 'failed', { error: 'bookkeeping failed', errorKind: 'io' })
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'candidate'), true)
  assert.equal(kit.identities.get(IDENTITY_KEY)?.candidateId, 'stored-candidate')
  assert.equal(kit.tasks.get(task.id)?.state, 'failed', '分析失败证据不被改写')
  assert.equal(kit.tasks.all().filter((entry) => entry.kind === 'generate' && entry.state === 'needs_review').length, 1)
  assert.equal(kit.calls.analyze, 0)
  assert.equal(kit.calls.generate, 0)
})

test('孤儿对账：monitor 删除的纯 orphan 先解析 session 候选，再收口 candidate', async (t) => {
  const kit = harness()
  kit.setSession(async () => sessionWithCandidate('attached-session', 'stored-candidate'))
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'attached-session')
  assert.equal(kit.monitors.remove(kit.monitorId), true)
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'candidate'), true)
  assert.equal(kit.identities.get(IDENTITY_KEY)?.candidateId, 'stored-candidate')
  assert.equal(kit.tasks.all().length, 0, 'monitor 已删除，不为纯 orphan 伪造审核任务')
  assert.equal(kit.calls.generate, 0)
})

test('孤儿对账：monitor 删除的纯 orphan 有 candidateId 提示时仍需核心核验', async (t) => {
  const kit = harness({ session: async () => sessionWithCandidate('attached-session', 'recorded-candidate') })
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'attached-session')
  const identity = kit.identities.get(IDENTITY_KEY)!
  identity.candidateId = 'recorded-candidate'
  assert.equal(kit.monitors.remove(kit.monitorId), true)
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'candidate'), true)
  assert.equal(kit.identities.get(IDENTITY_KEY)?.candidateId, 'recorded-candidate')
  assert.ok(kit.calls.session >= 2, 'candidateId 只作为核心提示；未建立 review 不得缓存，下一 sweep 会再核验')
  assert.equal(kit.tasks.all().length, 0)
  assert.equal(kit.calls.generate, 0)
})

test('孤儿对账：monitor 删除的纯 orphan 无候选证据时才 ignored', async (t) => {
  const kit = harness()
  kit.setSession(async () => undefined)
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'attached-session')
  assert.equal(kit.monitors.remove(kit.monitorId), true)
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'ignored'), true)
  assert.match(kit.identities.get(IDENTITY_KEY)?.lastError ?? '', /监控已删除且无候选证据/)
  assert.equal(kit.calls.generate, 0)
})

test('孤儿对账：completed analyze 候选查询期间出现新覆盖任务时不重复 enqueue', async (t) => {
  const lookup = deferred<SessionSummary | undefined>()
  const kit = harness()
  kit.setSession(() => lookup.promise)
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'analysis-session')
  const { task } = kit.tasks.enqueue({
    kind: 'analyze',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'analysis-session',
    dedupeKey: `analyze:${IDENTITY_KEY}`,
  })
  kit.tasks.finish(task.id, 'completed', { sessionId: 'analysis-session' })
  kit.engine.start()
  assert.equal(await tickUntil(kit, () => kit.calls.session > 0), true)

  const covering = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'analysis-session',
    dedupeKey: 'manual-generate-cover',
    delayMs: 60_000,
  })
  lookup.resolve(sessionWithCandidate('analysis-session', 'stored-candidate'))
  await new Promise((resolve) => setImmediate(resolve))
  await kit.engine.tick()

  assert.equal(kit.tasks.all().filter((entry) => entry.kind === 'generate').length, 1)
  assert.equal(kit.tasks.get(covering.task.id)?.state, 'pending')
  assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'claimed', '新覆盖存在时 sweep 不抢写身份')
  assert.equal(kit.calls.generate, 0)
})

test('崩溃窗口：候选查询挂起期间 generate 先转待审核时不得重复提升 analyze', async (t) => {
  const lookup = deferred<SessionSummary | undefined>()
  const kit = harness()
  kit.setSession(() => lookup.promise)
  t.after(() => kit.dispose())
  claim(kit)
  kit.identities.attachSession(IDENTITY_KEY, 'analysis-session')
  kit.identities.markCandidate(IDENTITY_KEY, { sessionId: 'analysis-session', candidateId: 'stored-candidate' })
  const { task: analysis } = kit.tasks.enqueue({
    kind: 'analyze',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'analysis-session',
    dedupeKey: `analyze:${IDENTITY_KEY}`,
  })
  kit.tasks.finish(analysis.id, 'completed', { sessionId: 'analysis-session' })
  kit.engine.start()
  assert.equal(await tickUntil(kit, () => kit.calls.session > 0), true)

  const { task: generation } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'analysis-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
  })
  kit.tasks.finish(generation.id, 'needs_review', { sessionId: 'analysis-session' })
  kit.monitors.noteOutcome(kit.monitorId, 'candidate')
  lookup.resolve(sessionWithCandidate('analysis-session', 'stored-candidate'))
  await new Promise((resolve) => setImmediate(resolve))
  await kit.engine.tick()

  assert.equal(kit.tasks.get(analysis.id)?.state, 'completed', '写前必须重查并发产生的审核行')
  assert.equal(kit.tasks.get(generation.id)?.state, 'needs_review')
  assert.equal(kit.tasks.all().filter((entry) => entry.state === 'needs_review').length, 1)
  assert.equal(kit.monitors.get(kit.monitorId)?.counters.candidates, 1, '候选计数不得重复增加')
  assert.equal(kit.identities.all().length, 1)
  assert.equal(kit.calls.generate, 0)
})

for (const failurePoint of ['session', 'candidates'] as const) {
  test(`孤儿对账：核心 ${failurePoint} 不可读时保持 claimed，恢复后才熔断`, async (t) => {
    const kit = harness()
    t.after(() => kit.dispose())
    claim(kit)
    const { task } = kit.tasks.enqueue({
      kind: 'generate',
      monitorId: kit.monitorId,
      postId: POST_ID,
      identityKey: IDENTITY_KEY,
      sessionId: 'generation-session',
      dedupeKey: `generate:${IDENTITY_KEY}`,
    })
    kit.tasks.finish(task.id, 'failed', { error: 'model timeout', errorKind: 'timeout' })
    kit.setSession(async () => {
      if (failurePoint === 'session') throw new Error('core session unreadable')
      const malformed = sessionWithCandidate('generation-session', 'stored-candidate')
      Object.defineProperty(malformed, 'candidates', {
        get(): never { throw new Error('candidate collection unreadable') },
      })
      return malformed
    })
    kit.engine.start()

    for (let index = 0; index < 3; index += 1) {
      kit.now.value += 25
      await kit.engine.tick()
    }
    assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'claimed', '不可读不等于无候选')
    assert.equal(kit.tasks.get(task.id)?.state, 'failed')
    assert.equal(kit.calls.generate, 0)

    kit.setSession(async () => undefined)
    assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'ignored'), true)
    assert.equal(kit.calls.generate, 0)
  })
}

test('崩溃窗口：identity ignored 先落盘、task failed 写失败，重载 store 后无模型收口', async (t) => {
  const kit = harness({
    generate: async () => { throw Object.assign(new Error('model timeout'), { code: 'timeout' }) },
  })
  let active = kit
  t.after(() => active.dispose())
  claim(kit)
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'generation-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
    maxAttempts: 1,
  })
  const originalFinish = kit.tasks.finish.bind(kit.tasks)
  let injected = false
  kit.tasks.finish = (id, state, detail = {}) => {
    if (state === 'failed' && !injected) {
      injected = true
      throw new AtomicWriteError('io', 'tasks.json', 'injected terminal task write failure')
    }
    return originalFinish(id, state, detail)
  }
  try {
    kit.engine.start()
    assert.equal(await tickUntil(kit, () =>
      injected
      && kit.identities.get(IDENTITY_KEY)?.state === 'ignored'
      && kit.tasks.get(task.id)?.state === 'running',
    ), true)
    assert.equal(kit.tasks.get(task.id)?.logs.some((entry) => entry.message === '操作员手动重试'), false)

    kit.tasks.finish = originalFinish
    active = await kit.reload()
    assert.deepEqual(active.tasks.recoverInterrupted(), { recovered: 1, uncertain: 0 })
    assert.equal(active.tasks.get(task.id)?.state, 'pending')
    assert.equal(active.tasks.get(task.id)?.modelCall?.uncertain, true, '已结束但结果不确定的调用仍保留 uncertain 证据')
    assert.equal(active.tasks.get(task.id)?.logs.some((entry) => entry.message === '操作员手动重试'), false, '进程恢复不得代写手动标记')
    kit.now.value += 30_001
    active.engine.start()
    assert.equal(await tickUntil(active, () => active.tasks.get(task.id)?.state === 'completed'), true)
    assert.equal(active.identities.get(IDENTITY_KEY)?.state, 'ignored')
    assert.equal(active.calls.generate, 1, '重载恢复任务被 ignored fence 无模型收口')
  } finally {
    kit.tasks.finish = originalFinish
  }
})

test('双台账反向：task failed 已落盘但 identity 仍 claimed，sweep 无模型收口', async (t) => {
  const kit = harness()
  t.after(() => kit.dispose())
  claim(kit)
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'generation-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
    maxAttempts: 1,
  })
  kit.tasks.finish(task.id, 'failed', { error: 'model timeout', errorKind: 'timeout' })
  assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'claimed')
  kit.engine.start()

  assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'ignored'), true)
  assert.equal(kit.tasks.get(task.id)?.state, 'failed', '终态任务证据不被改写')
  assert.equal(kit.identities.stats().claimed, 0)
  assert.equal(kit.calls.generate, 0)
})

test('双台账正向：identity 写失败不抢先写 task failed，恢复后候选仍只收口一次', async (t) => {
  const kit = harness({
    generate: async () => { throw Object.assign(new Error('model timeout'), { code: 'timeout' }) },
  })
  t.after(() => kit.dispose())
  claim(kit)
  const { task } = kit.tasks.enqueue({
    kind: 'generate',
    monitorId: kit.monitorId,
    postId: POST_ID,
    identityKey: IDENTITY_KEY,
    sessionId: 'generation-session',
    dedupeKey: `generate:${IDENTITY_KEY}`,
    maxAttempts: 1,
  })
  const originalIgnore = kit.identities.markIgnored.bind(kit.identities)
  let injected = false
  kit.identities.markIgnored = (key, reason, at) => {
    if (!injected) {
      injected = true
      throw new AtomicWriteError('io', 'identities.json', 'injected identity write failure')
    }
    return originalIgnore(key, reason, at)
  }
  try {
    kit.engine.start()
    assert.equal(await tickUntil(kit, () => injected && kit.tasks.get(task.id)?.state === 'running'), true)
    assert.equal(kit.identities.get(IDENTITY_KEY)?.state, 'claimed')
    assert.notEqual(kit.tasks.get(task.id)?.state, 'failed', '身份写失败时不得制造 failed+claimed')

    kit.identities.markIgnored = originalIgnore
    let recoveredCandidateStored = false
    kit.setGenerate(async () => {
      recoveredCandidateStored = true
      return { ok: true, outcome: 'valid_draft', candidateId: 'recovered-candidate' }
    })
    kit.setSession(async (sessionId) => recoveredCandidateStored
      ? sessionWithCandidate(sessionId, 'recovered-candidate')
      : { ...sessionWithCandidate(sessionId, 'core-candidate'), candidates: [] })
    assert.deepEqual(kit.tasks.recoverInterrupted(), { recovered: 1, uncertain: 0 })
    assert.equal(kit.tasks.get(task.id)?.modelCall?.uncertain, true)
    kit.now.value += 30_001
    assert.equal(await tickUntil(kit, () => kit.identities.get(IDENTITY_KEY)?.state === 'candidate'), true)
    assert.equal(kit.identities.get(IDENTITY_KEY)?.candidateId, 'recovered-candidate')
    assert.equal(kit.tasks.get(task.id)?.state, 'needs_review')
    assert.equal(kit.calls.generate, 2, '身份写失败允许模型请求重发，但候选身份只收口一次')
    assert.equal(kit.identities.all().length, 1)
  } finally {
    kit.identities.markIgnored = originalIgnore
  }
})
