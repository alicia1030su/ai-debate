/**
 * The background pipeline, end to end, against a scripted platform.
 *
 * What this proves and what it does not:
 *
 *   - **Proves**: the scheduler notices a new reply, records it once, analyses it
 *     through the real engine, generates a candidate through the real generator,
 *     and stops at "waiting for a human". Also: a rate limit backs off by the amount
 *     the platform asked for, an auth failure stops the monitor, a crash mid-task is
 *     recovered without producing a second candidate, and a repeat poll never
 *     re-analyses a reply it already saw.
 *   - **Does not prove**: that any real platform is reachable or that the real
 *     adapter parses its pages. The adapter here is a double. The real-platform
 *     record is kept separately in `docs/acceptance-v0.2.0.md`, and stays empty
 *     until someone runs it with a real account.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig, DEFAULT_CONFIG } from '../../packages/core/lib/config.js'
// `buildRuntime` lives on the core's index (it is the composition helper, not a
// runtime method), so the import names the package entry rather than a file.
import { buildRuntime } from '../../packages/core/lib/index.js'
import { DebateStore } from '../../packages/core/lib/store.js'
import { PlatformRegistry } from '../../packages/core/lib/platforms/registry.js'
import { probeThread } from '../../packages/core/lib/probe.js'
import { runAnalysis, runGeneration } from '../../packages/core/lib/runtime.js'
import { MonitorStore } from '../../packages/server/src/monitor/store.ts'
import { AutoTaskStore } from '../../packages/server/src/monitor/tasks.ts'
import { AutomationEngine, classifyFailure, isOwnerPost } from '../../packages/server/src/monitor/engine.ts'
import { FakeAdapter, type FakeReplySeed } from '../support/fake-adapter.ts'
import type { DebateProductApi } from '../../packages/core/lib/product-api.js'

const PLATFORM = 'faketieba'
const THREAD_URL = `https://fake.example/p/9001`

/** A minimal OpenAI-compatible endpoint that returns a usable draft. */
function startModel(): Promise<{ server: Server; port: number; calls: () => number }> {
  let calls = 0
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      raw += chunk
    })
    request.on('end', () => {
      calls += 1
      // The prompt states the target as 「回复对象的 post id 应为 <id>」. Parsing the
      // first "post id" anywhere would pick up the thread listing instead, and the
      // mock would answer the wrong comment — which the engine correctly rejects as
      // a wrong-target draft, making the test look broken.
      const target = /回复对象的 post id 应为\s*([A-Za-z0-9:_-]+)/.exec(raw)?.[1] ?? 'f2'
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
      response.end(
        JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(draft) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
        }),
      )
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0, calls: () => calls })
    })
  })
}

interface Harness {
  api: DebateProductApi
  monitors: MonitorStore
  tasks: AutoTaskStore
  engine: AutomationEngine
  adapter: FakeAdapter
  dir: string
  dispose(): Promise<void>
}

const noisy = process.env.AI_DEBATE_TEST_LOG === '1'
const log = {
  debug: (m: string) => noisy && process.stdout.write(`  D ${m}\n`),
  info: (m: string) => noisy && process.stdout.write(`  I ${m}\n`),
  warn: (m: string) => noisy && process.stdout.write(`  W ${m}\n`),
  error: (m: string) => noisy && process.stdout.write(`  E ${m}\n`),
}

function baseReplies(): FakeReplySeed[] {
  return [
    { postId: 'f1', author: '楼主', authorId: 'owner-handle', content: '现在的年轻人根本不愿意吃苦，一点委屈都受不了。' },
    { postId: 'f2', author: '对方', authorId: 'rival', content: '你这话太绝对了，我身边很多人加班到很晚。' },
  ]
}

/** Tick until `predicate` is true. More precise than "wait idle", which never
 * settles while a task is legitimately waiting out a rate limit. */
async function tickUntil(
  engine: AutomationEngine,
  predicate: () => boolean,
  timeoutMs = 30_000,
  dump?: () => readonly { kind: string; state: string; lastError?: string; logs: readonly { message: string }[] }[],
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await engine.tick()
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const ok = predicate()
  if (!ok && dump !== undefined) {
    // A failing wait is the only place a reader can see *why* nothing happened:
    // the task ledger carries the reason, and a bare `false !== true` does not.
    process.stdout.write('  任务台账：\n')
    for (const task of dump()) {
      process.stdout.write(`    ${task.kind} ${task.state}${task.lastError === undefined ? '' : ` — ${task.lastError}`}\n`)
      for (const line of task.logs) process.stdout.write(`      · ${line.message}\n`)
    }
  }
  return ok
}

async function harness(options: { modelPort: number; replies?: FakeReplySeed[]; concurrency?: number }): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-auto-'))
  const adapter = new FakeAdapter(
    { platform: PLATFORM, threadId: '9001', title: '验收帖', url: THREAD_URL, body: '楼主开场白。', bodyAuthor: '楼主' },
    options.replies ?? baseReplies(),
  )
  const registry = new PlatformRegistry()
  registry.register({
    id: PLATFORM,
    displayName: '验收平台',
    shape: 'forum-thread',
    canHandleUrl: (url: string) => url.startsWith('https://fake.example/p/'),
    parseUrl: (url: string) => ({ platform: PLATFORM as never, threadId: url.split('/').pop() ?? '', url }),
    describeCapabilities: () => ({
      platform: PLATFORM,
      declaredAt: '2026-11-01T00:00:00.000Z',
      capabilities: {
        'thread.read': { state: 'supported', reason: '验收平台' },
        'comment.list': { state: 'supported', reason: '验收平台' },
        'comment.paginate': { state: 'supported', reason: '验收平台' },
        'comment.nested': { state: 'supported', reason: '验收平台' },
        'comment.locate': { state: 'supported', reason: '验收平台' },
        'identity.verify': { state: 'supported', reason: '验收平台' },
        'event.mentions': { state: 'unavailable', reason: '验收平台不提供艾特列表' },
        'comment.publish': { state: 'unverified', reason: '验收平台不发表' },
        'comment.reply': { state: 'unverified', reason: '验收平台不发表' },
        'publish.verify': { state: 'unverified', reason: '验收平台不发表' },
        'media.read': { state: 'unavailable', reason: '验收平台不读媒体' },
        'user.profile': { state: 'unavailable', reason: '验收平台不提供资料' },
      },
    }),
    createAdapter: () => adapter,
  })

  const config = {
    ...DEFAULT_CONFIG,
    enabled: true,
    ownerHandle: '',
    ownerUserName: '',
    // A platform-scoped binding: the legacy globals only ever describe Tieba, and
    // this deployment is not Tieba.
    platformAccounts: JSON.stringify({
      owners: [{ platform: PLATFORM, primary: { platform: PLATFORM, handle: 'owner-handle', displayName: '楼主' } }],
      aiAccounts: [{ platform: PLATFORM, account: { platform: PLATFORM, displayName: 'AI 马甲' } }],
    }),
    llmBaseUrl: `http://127.0.0.1:${options.modelPort}/v1`,
    llmModel: 'mock-model',
    llmSource: 'custom' as const,
    llmProtocol: 'chat' as const,
    egressMode: 'open' as const,
    maxFloorPages: 5,
    pageDelayMs: 0,
  }

  const store = new DebateStore({ dir })
  const runtime = buildRuntime(() => resolveConfig(config), log as never, registry, undefined, { store })

  const api: DebateProductApi = {
    resolveUrl: (url) => ({ platform: PLATFORM, threadId: url.split('/').pop() ?? '', url }),
    probe: (input) => probeThread(runtime, input),
    analyze: async (input) => {
      const output = await runAnalysis(runtime, {
        url: input.url,
        ...(input.postId === undefined ? {} : { postId: input.postId }),
      })
      return { sessionId: output.sessionId }
    },
    generate: async (input) => {
      const output = await runGeneration(runtime, {
        sessionId: input.sessionId,
        ...(input.targetPostId === undefined ? {} : { targetPostId: input.targetPostId }),
      })
      const produced = output.outcome === 'valid_draft' || output.outcome === 'invalid_draft'
      return {
        ok: output.outcome === 'valid_draft',
        outcome: output.outcome,
        ...(produced && output.candidateId !== undefined ? { candidateId: output.candidateId } : {}),
        ...(output.needsInputReason === undefined ? {} : { message: output.needsInputReason }),
      }
    },
    session: async (sessionId) => {
      await store.ready()
      const session = store.getSession(sessionId)
      if (session === undefined) return undefined
      return {
        id: session.id,
        platform: session.platform,
        threadId: session.threadId,
        threadTitle: session.threadTitle,
        threadUrl: session.threadUrl,
        state: session.state,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        candidates: session.candidates.map((candidate) => ({
          replyId: candidate.replyId,
          text: candidate.text,
          targetPostId: candidate.targetPostId,
          candidateVersion: candidate.candidateVersion,
          createdAt: candidate.createdAt,
        })),
      }
    },
    sessionForThread: async () => undefined,
    ownerIdentity: () => ({ userId: undefined, handle: 'owner-handle', userName: '楼主' }),
  }

  const monitors = new MonitorStore({ file: join(dir, 'monitors.json'), log })
  monitors.load()
  const tasks = new AutoTaskStore({ file: join(dir, 'auto-tasks.json'), log })
  tasks.load()
  const engine = new AutomationEngine({
    monitors,
    tasks,
    api: () => api,
    log: log as never,
    tickMs: 3_600_000, // the test drives ticks by hand; no timer races
    concurrency: options.concurrency ?? 1,
  })
  engine.start()

  return {
    api,
    monitors,
    tasks,
    engine,
    adapter,
    dir,
    async dispose() {
      await engine.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('挂机链路：基线 → 发现新回复 → 分析 → 生成 → 待审核', async () => {
  const model = await startModel()
  const kit = await harness({ modelPort: model.port })
  try {
    const monitor = kit.monitors.create(
      { name: '验收监控', url: THREAD_URL, intervalSec: 120 },
      { platform: PLATFORM, threadId: '9001' },
    )

    // 1. First scan only seeds the baseline: an existing backlog is not "new".
    kit.tasks.enqueue({ kind: 'probe', monitorId: monitor.id, dedupeKey: `probe:${monitor.id}` })
    assert.equal(await tickUntil(kit.engine, () => kit.monitors.get(monitor.id)?.baselineAt !== undefined), true, '首次检查应完成')
    let stored = kit.monitors.get(monitor.id)
    // The owner's own floor is filtered out before the cursor sees it — the bot must
    // never treat "I said something" as a reason to answer me.
    assert.equal(stored?.seen.length, 1, '首次检查应记录对方的那条既有发言（楼主自己的除外）')
    assert.equal(stored?.baselineAt !== undefined, true, '首次检查后应写入基线时间')
    assert.equal(kit.tasks.list().filter((task) => task.kind === 'analyze').length, 0, '基线不应触发分析')

    // 2. A new reply appears.
    kit.adapter.setReplies([
      ...baseReplies(),
      { postId: 'f3', author: '对方', authorId: 'rival', content: '再说了，现在的年轻人动不动就辞职。' },
    ])
    kit.tasks.enqueue({ kind: 'probe', monitorId: monitor.id, dedupeKey: `probe:${monitor.id}` })
    assert.equal(
      await tickUntil(kit.engine, () => kit.tasks.list().some((task) => task.state === 'needs_review'), 30_000, () => kit.tasks.list()),
      true,
      '应出现待审核任务',
    )

    const review = kit.tasks.list().filter((task) => task.state === 'needs_review')
    assert.equal(review.length, 1, '一条新回复应产生且只产生一个待审核任务')
    assert.equal(review[0]?.postId, 'f3')
    assert.ok(review[0]?.sessionId !== undefined)

    const session = await kit.api.session(review[0]!.sessionId!)
    assert.equal(session?.candidates.length, 1, '应生成一个候选')
    assert.equal(session?.candidates[0]?.targetPostId, 'f3')
    assert.equal(model.calls() > 0, true, '生成应真的调用模型')

    // 3. Polling again with no change must not create anything.
    const before = kit.tasks.list().length
    kit.tasks.enqueue({ kind: 'probe', monitorId: monitor.id, dedupeKey: `probe:${monitor.id}` })
    await tickUntil(kit.engine, () => kit.tasks.list().filter((task) => task.kind === 'probe').length >= 2, 10_000)
    const after = kit.tasks.list()
    assert.equal(after.filter((task) => task.kind === 'analyze').length, 1, '重复轮询不得重复分析')
    assert.equal(after.length >= before, true)

    // 4. Same reply re-queued by hand: the dedupe key must refuse a second candidate.
    //    The key is scoped to the monitor and the reply, not to the session: a second
    //    analysis of the same thread yields a *new* session id, and a session-scoped
    //    key would let the same reply collect a second candidate under it.
    const key = `generate:${monitor.id}:f3`
    const again = kit.tasks.enqueue({ kind: 'generate', monitorId: monitor.id, postId: 'f3', sessionId: review[0]!.sessionId, dedupeKey: key })
    assert.equal(again.deduplicated, true, '同一回复只能有一个生成任务')

    // 5. A fresh session for the same thread must not reopen the question.
    const reanalyzed = kit.tasks.enqueue({
      kind: 'generate',
      monitorId: monitor.id,
      postId: 'f3',
      sessionId: 'a-different-session',
      dedupeKey: `generate:${monitor.id}:f3`,
    })
    assert.equal(reanalyzed.deduplicated, true, '换一个会话也不能为同一回复再生成一个候选')
  } finally {
    await kit.dispose()
    model.server.close()
  }
})

test('429：按平台给出的 Retry-After 退避，而不是立刻重试', async () => {
  const model = await startModel()
  const kit = await harness({ modelPort: model.port })
  try {
    const monitor = kit.monitors.create({ name: '限流', url: THREAD_URL }, { platform: PLATFORM, threadId: '9001' })
    kit.tasks.enqueue({ kind: 'probe', monitorId: monitor.id, dedupeKey: `probe:${monitor.id}` })
    await tickUntil(kit.engine, () => kit.monitors.get(monitor.id)?.baselineAt !== undefined)
    kit.monitors.markBaseline(monitor.id, new Date().toISOString())

    kit.adapter.armError('rate_limited', '平台要求限流', { status: 429, retryAfterMs: 45_000 })
    kit.tasks.enqueue({ kind: 'probe', monitorId: monitor.id, dedupeKey: `probe:${monitor.id}` })
    await tickUntil(kit.engine, () => kit.tasks.list().some((task) => task.state === 'retry_wait'), 15_000)

    const waiting = kit.tasks.list().find((task) => task.kind === 'probe' && task.state === 'retry_wait')
    assert.ok(waiting !== undefined, '限流后应进入 retry_wait')
    const delay = Date.parse(waiting!.nextRunAt) - Date.now()
    assert.ok(delay > 30_000, `应等待平台给出的时长，实际 ${Math.round(delay / 1000)} 秒`)
    assert.equal(waiting!.lastErrorKind, 'rate_limited')
  } finally {
    await kit.dispose()
    model.server.close()
  }
})

test('401：暂停该监控并记录原因，而不是无限重试', async () => {
  const model = await startModel()
  const kit = await harness({ modelPort: model.port })
  try {
    const monitor = kit.monitors.create({ name: '登录失效', url: THREAD_URL }, { platform: PLATFORM, threadId: '9001' })
    kit.tasks.enqueue({ kind: 'probe', monitorId: monitor.id, dedupeKey: `probe:${monitor.id}` })
    await tickUntil(kit.engine, () => kit.tasks.list().some((task) => task.state === 'completed'))

    kit.adapter.armError('auth_required', '登录已失效', { status: 401 })
    kit.tasks.enqueue({ kind: 'probe', monitorId: monitor.id, dedupeKey: `probe:${monitor.id}` })
    await tickUntil(kit.engine, () => kit.monitors.get(monitor.id)?.blockedReason !== undefined, 15_000)

    const stored = kit.monitors.get(monitor.id)
    assert.equal(stored?.enabled, false, '认证失败应暂停监控')
    assert.match(stored?.blockedReason ?? '', /登录已失效/)
    const blocked = kit.tasks.list().find((task) => task.state === 'blocked')
    assert.ok(blocked !== undefined)
    assert.equal(blocked!.lastErrorKind, 'auth')
  } finally {
    await kit.dispose()
    model.server.close()
  }
})

test('崩溃恢复：running 任务重新排队，且不会重复生成候选', async () => {
  const model = await startModel()
  const kit = await harness({ modelPort: model.port })
  try {
    const monitor = kit.monitors.create({ name: '崩溃恢复', url: THREAD_URL }, { platform: PLATFORM, threadId: '9001' })
    kit.tasks.enqueue({ kind: 'probe', monitorId: monitor.id, dedupeKey: `probe:${monitor.id}` })
    await tickUntil(kit.engine, () => kit.monitors.get(monitor.id)?.baselineAt !== undefined)
    kit.monitors.markBaseline(monitor.id, new Date().toISOString())

    kit.adapter.setReplies([
      ...baseReplies(),
      { postId: 'f4', author: '对方', authorId: 'rival', content: '反正我见到的年轻人都不愿意加班。' },
    ])
    kit.tasks.enqueue({ kind: 'probe', monitorId: monitor.id, dedupeKey: `probe:${monitor.id}` })
    await tickUntil(kit.engine, () => kit.tasks.list().some((task) => task.state === 'needs_review'))
    const review = kit.tasks.list().find((task) => task.state === 'needs_review')
    assert.ok(review !== undefined)

    // Simulate a crash mid-generation: rewrite the ledger as if the process died
    // while the generate task was running.
    const file = join(kit.dir, 'auto-tasks.json')
    const document = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(file, 'utf8'))) as {
      version: 1
      paused: boolean
      tasks: { id: string; kind: string; state: string }[]
    }
    const generate = document.tasks.find((task) => task.kind === 'generate')
    assert.ok(generate !== undefined)
    generate.state = 'running'
    // A task killed *during* the model call: the request was dispatched, the answer
    // was never persisted. That is the only case where a retry may duplicate the
    // request, so it must be recorded as uncertain rather than silently replayed.
    ;(generate as unknown as { modelCall: { startedAt: string } }).modelCall = {
      startedAt: new Date().toISOString(),
    }
    writeFileSync(file, JSON.stringify(document), 'utf8')

    const reloaded = new AutoTaskStore({ file, log })
    reloaded.load()
    const recovered = reloaded.recoverInterrupted()
    assert.equal(recovered.recovered, 1, '运行中的任务应被恢复')
    assert.equal(recovered.uncertain, 1, '模型调用中的任务应标记为结果不确定')
    const recoveredTask = reloaded.list().find((task) => task.kind === 'generate')
    assert.equal(recoveredTask?.state, 'pending')
    assert.equal(recoveredTask?.lastErrorKind, 'interrupted_uncertain')
    assert.equal(recoveredTask?.modelCall?.uncertain, true)

    // Re-running it must reuse the existing candidate, not create a second one.
    kit.tasks.load()
    kit.tasks.recoverInterrupted()
    await tickUntil(kit.engine, () => kit.tasks.list().every((task) => task.state !== 'pending' && task.state !== 'running'), 20_000)
    const session = await kit.api.session(review!.sessionId!)
    assert.equal(session?.candidates.length, 1, '恢复后不得出现第二个候选')
  } finally {
    await kit.dispose()
    model.server.close()
  }
})

test('并发上限：同一监控目标不会被同时执行两次', async () => {
  const model = await startModel()
  const kit = await harness({ modelPort: model.port, concurrency: 2 })
  try {
    const monitor = kit.monitors.create({ name: '并发', url: THREAD_URL }, { platform: PLATFORM, threadId: '9001' })
    // Two enqueues with the same key: the second must dedupe, not run in parallel.
    const first = kit.tasks.enqueue({ kind: 'probe', monitorId: monitor.id, dedupeKey: `probe:${monitor.id}` })
    const second = kit.tasks.enqueue({ kind: 'probe', monitorId: monitor.id, dedupeKey: `probe:${monitor.id}` })
    assert.equal(second.deduplicated, true)
    assert.equal(first.task.id, second.task.id)
    await tickUntil(kit.engine, () => kit.tasks.list().some((task) => task.state === 'completed'))
    const probes = kit.tasks.list().filter((task) => task.kind === 'probe')
    assert.equal(probes.length, 1, '同一目标只应存在一个探测任务')
  } finally {
    await kit.dispose()
    model.server.close()
  }
})

test('失败分类：认证/限流/网络/永久错误各自落到正确处理', () => {
  const auth = classifyFailure(Object.assign(new Error('401'), { code: 'auth_required' }))
  assert.equal(auth.blocksMonitor, true)
  assert.equal(auth.retryable, false)

  const rate = classifyFailure(Object.assign(new Error('429'), { code: 'rate_limited', retryAfterMs: 5000 }))
  assert.equal(rate.retryable, true)
  assert.equal(rate.retryAfterMs, 5000)

  const net = classifyFailure(Object.assign(new Error('ECONNRESET'), { code: 'network' }))
  assert.equal(net.retryable, true)
  assert.equal(net.blocksMonitor, false)

  const gone = classifyFailure(Object.assign(new Error('404'), { code: 'not_found' }))
  assert.equal(gone.retryable, false)

  const unbound = classifyFailure(new Error('还没有绑定主人（平台「tieba」）：请先调用 debate_bind_owner'))
  assert.equal(unbound.blocksMonitor, true)
  assert.equal(unbound.kind, 'owner_unbound')
})

test('自己的发言不会被当成新回复去回复', () => {
  assert.equal(isOwnerPost({ authorNumericUid: '10086' }, { userId: '10086' }), true)
  assert.equal(isOwnerPost({ authorId: 'un-name' }, { handle: 'un-name' }), true)
  assert.equal(isOwnerPost({ authorName: '昵称' }, { userName: '昵称' }), true)
  assert.equal(isOwnerPost({ authorName: '别人' }, { handle: 'un-name' }), false)
})
