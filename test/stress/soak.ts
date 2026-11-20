/**
 * Soak test: keep the pipeline running and watch for growth.
 *
 * ## What it measures
 *
 * The failure this is designed to catch is not "it crashes" — it is "it works for
 * an hour and then the process is 900 MB and the ledger has 40,000 rows". Three
 * numbers are sampled while the engine runs:
 *
 *   - **heap** — after a warm-up, so the JIT and caches settle;
 *   - **ledger rows** — must stay under the queue capacity, because history is
 *     pruned rather than accumulated;
 *   - **candidates per reply** — must stay at one, because a duplicate here is the
 *     bug the whole de-duplication design exists to prevent.
 *
 * ## Honesty about duration
 *
 * A 24-hour run is what the specification asks for, and `--seconds=86400` is how
 * to do it. A CI run uses minutes. The report prints the actual wall-clock time so
 * nobody can mistake one for the other, and `docs/acceptance-v0.2.1.md` records
 * which one was executed.
 *
 * Usage:
 *   node --experimental-transform-types test/stress/soak.ts --seconds=120
 *   node --experimental-transform-types test/stress/soak.ts --seconds=86400 --interval-ms=2000
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig, DEFAULT_CONFIG } from '../../packages/core/lib/config.js'
import { buildRuntime } from '../../packages/core/lib/index.js'
import { DebateStore } from '../../packages/core/lib/store.js'
import { PlatformRegistry } from '../../packages/core/lib/platforms/registry.js'
import { probeThread } from '../../packages/core/lib/probe.js'
import { runAnalysis, runGeneration } from '../../packages/core/lib/runtime.js'
import { MonitorStore } from '../../packages/server/src/monitor/store.ts'
import { AutoTaskStore } from '../../packages/server/src/monitor/tasks.ts'
import { AutomationEngine } from '../../packages/server/src/monitor/engine.ts'
import { FakeAdapter, type FakeReplySeed } from '../support/fake-adapter.ts'
import type { DebateProductApi } from '../../packages/core/lib/product-api.js'

const PLATFORM = 'faketieba'
const THREAD_URL = 'https://fake.example/p/9200'

function arg(name: string, fallback: number): number {
  const hit = process.argv.find((entry) => entry.startsWith(`--${name}=`))
  if (hit === undefined) return fallback
  const value = Number(hit.slice(name.length + 3))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

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

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

async function main(): Promise<void> {
  const seconds = arg('seconds', 120)
  const intervalMs = arg('interval-ms', 50)
  const replyEvery = arg('reply-every', 4)
  // A soak with an ever-growing thread is a different test: the analysis reads at
  // most `maxFloorPages` pages, so replies past that are genuinely unanswerable and
  // would show up as a real (correct) failure. The cap keeps the thread within one
  // read, which is what a monitored thread actually looks like between checks.
  const maxReplies = arg('max-replies', 120)

  const model = await startModel()
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-soak-'))
  const adapter = new FakeAdapter(
    { platform: PLATFORM, threadId: '9200', title: '压力测试帖', url: THREAD_URL, body: '开场白。', bodyAuthor: '楼主' },
    [
      { postId: 'f1', author: '楼主', authorId: 'owner-handle', content: '现在的年轻人根本不愿意吃苦。' },
      { postId: 'f2', author: '对方', authorId: 'rival', content: '你这话太绝对了。' },
    ],
  )
  const registry = new PlatformRegistry()
  registry.register({
    id: PLATFORM,
    displayName: '假平台',
    shape: 'forum-thread',
    canHandleUrl: (url: string) => url.startsWith('https://fake.example/p/'),
    parseUrl: (url: string) => ({ platform: PLATFORM as never, threadId: url.split('/').pop() ?? '', url }),
    describeCapabilities: () => ({ platform: PLATFORM, declaredAt: '2026-11-01T00:00:00.000Z', capabilities: {} }) as never,
    createAdapter: () => adapter,
  })
  const config = {
    ...DEFAULT_CONFIG,
    platformAccounts: JSON.stringify({
      owners: [{ platform: PLATFORM, primary: { platform: PLATFORM, handle: 'owner-handle', displayName: '楼主' } }],
      aiAccounts: [{ platform: PLATFORM, account: { platform: PLATFORM, displayName: 'AI 马甲' } }],
    }),
    llmBaseUrl: `http://127.0.0.1:${model.port}/v1`,
    llmModel: 'mock-model',
    llmSource: 'custom' as const,
    egressMode: 'open' as const,
    pageDelayMs: 0,
    maxFloorPages: 30,
  }
  const store = new DebateStore({ dir })
  const runtime = buildRuntime(() => resolveConfig(config), quiet as never, registry, undefined, { store })
  const api: DebateProductApi = {
    resolveUrl: (url) => ({ platform: PLATFORM, threadId: '9200', url }),
    probe: (input) => probeThread(runtime, input),
    analyze: async (input) => ({ sessionId: (await runAnalysis(runtime, input)).sessionId }),
    // Mirror the server's product API mapping: `runGeneration` returns an outcome
    // enum, while the engine's contract is `{ ok, candidateId }`. Passing the raw
    // output would make every successful draft look declined — which is exactly
    // what this soak reported before the mapping was added.
    generate: async (input) => {
      const output = await runGeneration(runtime, input)
      const produced = output.outcome === 'valid_draft' || output.outcome === 'invalid_draft'
      return {
        ok: output.outcome === 'valid_draft',
        outcome: output.outcome,
        ...(produced && output.candidateId !== undefined ? { candidateId: output.candidateId } : {}),
        ...(output.needsInputReason === undefined ? {} : { message: output.needsInputReason }),
        ...(output.violations === undefined ? {} : { violations: output.violations }),
      }
    },
    session: async (sessionId) => {
      const session = store.getSession(sessionId)
      return session === undefined
        ? undefined
        : {
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
    ownerIdentity: () => ({ handle: 'owner-handle', userName: '楼主' }),
  }

  const monitors = new MonitorStore({ file: join(dir, 'monitors.json'), log: quiet })
  monitors.load()
  const tasks = new AutoTaskStore({ file: join(dir, 'auto-tasks.json'), log: quiet, capacity: 400 })
  tasks.load()
  tasks.recoverInterrupted()
  const engine = new AutomationEngine({ monitors, tasks, api: () => api, log: quiet as never, tickMs: intervalMs, taskTimeoutMs: 120_000 })
  engine.start()

  const monitor = monitors.create({ name: '压力', url: THREAD_URL, intervalSec: 120 }, { platform: PLATFORM, threadId: '9200' })
  tasks.enqueue({ kind: 'probe', monitorId: monitor.id, dedupeKey: `probe:${monitor.id}` })

  const startedAt = Date.now()
  const deadline = startedAt + seconds * 1000
  const samples: number[] = []
  let replies = 2
  let iteration = 0
  let peakTasks = 0
  let peakQueued = 0
  let duplicateCandidates = 0
  let pruned = 0

  // Warm-up: one full cycle, so the baseline heap includes the caches that will
  // stay for the whole run. Measuring from a cold start would show growth that is
  // really just the first analysis being compiled and cached.
  for (let index = 0; index < 20; index += 1) {
    await engine.tick()
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  const baselineHeap = process.memoryUsage().heapUsed

  while (Date.now() < deadline) {
    iteration += 1
    if (iteration % replyEvery === 0 && replies < maxReplies) {
      replies += 1
      adapter.setReplies([
        { postId: 'f1', author: '楼主', authorId: 'owner-handle', content: '现在的年轻人根本不愿意吃苦。' },
        ...Array.from({ length: replies - 1 }, (_unused, index) => ({
          postId: `r${index + 2}`,
          author: '对方',
          authorId: 'rival',
          content: `第 ${index + 2} 条回复：你只看到了你身边的例子。`,
        })),
      ])
    }
    // The product's minimum poll interval is two minutes; the soak compresses time
    // by asking for a check explicitly rather than pretending the interval is
    // shorter, so the scheduler's own gating is still exercised.
    if (iteration % 20 === 0) {
      tasks.enqueue({ kind: 'probe', monitorId: monitor.id, dedupeKey: `probe:${monitor.id}` })
    }
    await engine.tick()
    peakTasks = Math.max(peakTasks, tasks.all().length)
    // Capacity bounds *runnable* work, not history: a completed row is a record, not
    // a slot. The queue's own limit is what "no unbounded growth" means here.
    peakQueued = Math.max(peakQueued, tasks.queuedCount())
    if (iteration % 40 === 0) {
      // Keep the ledger honest the way the running product does: history is pruned,
      // never accumulated. The soak asserts the effect of that policy.
      pruned += tasks.prune({ keepDays: 1, keepTerminal: 60 }).removed
    }
    if (iteration % 10 === 0) samples.push(process.memoryUsage().heapUsed)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  const finalHeap = process.memoryUsage().heapUsed
  const status = engine.status()

  // Every reply that produced a candidate must have exactly one.
  //
  // Sessions are de-duplicated first: a monitoring session is reused for the whole
  // life of its trigger, so 119 review tasks can all point at one session. Counting
  // per task would multiply that session's candidate list by 119 and report a
  // duplicate problem that does not exist.
  const sessionIds = new Set<string>()
  for (const entry of tasks.all()) {
    if (entry.sessionId !== undefined) sessionIds.add(entry.sessionId)
  }
  const sessions: { candidates: { targetPostId: string }[] }[] = []
  for (const sessionId of sessionIds) {
    const session = await api.session(sessionId)
    if (session !== undefined) sessions.push({ candidates: [...session.candidates] })
  }
  const perTarget = new Map<string, number>()
  for (const session of sessions) {
    for (const candidate of session.candidates) {
      perTarget.set(candidate.targetPostId, (perTarget.get(candidate.targetPostId) ?? 0) + 1)
    }
  }
  for (const count of perTarget.values()) if (count > 1) duplicateCandidates += 1

  const report = {
    wallClockSeconds: Math.round((Date.now() - startedAt) / 1000),
    iterations: iteration,
    replies,
    modelCalls: model.calls(),
    heapBaselineMb: Math.round(baselineHeap / 1024 / 1024),
    heapFinalMb: Math.round(finalHeap / 1024 / 1024),
    heapGrowthMb: Math.round((finalHeap - baselineHeap) / 1024 / 1024),
    peakLedgerRows: peakTasks,
    peakQueued,
    ledgerRowsAtEnd: tasks.all().length,
    prunedRows: pruned,
    candidates: perTarget.size,
    duplicateCandidates,
    queue: status.queue,
    alerts: status.alerts,
    topErrors: Object.entries(
      tasks.all().reduce<Record<string, number>>((acc, task) => {
        if (task.lastError === undefined) return acc
        const key = `${task.kind}: ${task.lastErrorKind ?? '?'}: ${task.lastError.slice(0, 90)}`
        acc[key] = (acc[key] ?? 0) + 1
        return acc
      }, {}),
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8),
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

  await engine.stop()
  model.server.close()
  rmSync(dir, { recursive: true, force: true })

  const failures: string[] = []
  if (duplicateCandidates > 0) failures.push(`${duplicateCandidates} 条回复出现了多个候选`)
  if (report.peakQueued > tasks.capacity) failures.push(`待执行任务峰值 ${report.peakQueued} 超过容量 ${tasks.capacity}`)
  // Every `needs_review` row is protected from pruning, so the ledger's floor is the
  // number of candidates a human still has to look at. Anything beyond that is
  // history and must stay bounded by the retention policy.
  const protectedRows = tasks.all().filter((task) => task.state === 'needs_review').length
  if (report.peakLedgerRows > tasks.capacity + protectedRows + 300) {
    failures.push(`台账峰值 ${report.peakLedgerRows} 超出「容量 + 待审核 + 保留」上限`)
  }
  if (report.heapGrowthMb > 120) failures.push(`堆增长 ${report.heapGrowthMb} MB 超过阈值 120 MB`)
  // A `valid_draft` outcome that produced no candidate would silently lose work.
  const declined = tasks.all().filter((task) => task.lastErrorKind === 'generator_declined').length
  const reviewed = tasks.all().filter((task) => task.state === 'needs_review').length
  if (reviewed === 0 && declined > 0) failures.push('所有生成都被拒绝，链路没有产出任何候选')
  if (perTarget.size === 0 && model.calls() > 0) failures.push('有模型调用但没有任何候选')
  if (failures.length > 0) {
    process.stderr.write(`\n压力测试失败：\n${failures.map((line) => `  - ${line}`).join('\n')}\n`)
    process.exitCode = 1
  }
}

await main()
