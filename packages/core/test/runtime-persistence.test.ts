/** Generation must not cross the durable candidate boundary. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { ScriptedLlmClient } from '../lib/llm.js'
import { PlatformRegistry } from '../lib/platforms/registry.js'
import { buildRuntime } from '../lib/index.js'
import { runAnalysis, runGeneration, type Runtime } from '../lib/runtime.js'
import { DebateStore, type StoreData } from '../lib/store.js'
import { FakeAdapter } from '../../../test/support/fake-adapter.ts'

const quiet = {
  debug: (_message: string): void => undefined,
  info: (_message: string): void => undefined,
  warn: (_message: string): void => undefined,
  error: (_message: string): void => undefined,
}

const THREAD_URL = 'https://fake.example/p/recovery'

function draft(targetPostId: string): string {
  return JSON.stringify({
    status: 'ok',
    owner_position: '不能用个例概括所有人。',
    opponent_position: '年轻人吃不了苦。',
    main_dispute: '个别现象能否代表整体。',
    latest_argument: '用身边例子否定整体结论。',
    response_target_id: targetPostId,
    strategy: 'point_out_contradiction',
    confidence: 0.8,
    uncertainties: [],
    reply: '你举的例子只能说明有人这样，不能说明所有人都这样。',
  })
}

function harness(): { dir: string; store: DebateStore; runtime: Runtime; llm: ScriptedLlmClient } {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-runtime-persistence-'))
  const store = new DebateStore({ dir, lockTimeoutMs: 20 })
  const adapter = new FakeAdapter(
    { platform: 'faketieba', threadId: 'recovery', title: '持久化测试帖', url: THREAD_URL, body: '楼主开场白。', bodyAuthor: '楼主' },
    [
      { postId: 'f1', author: '楼主', authorId: 'owner-handle', content: '现在的年轻人根本不愿意吃苦，一点委屈都受不了。' },
      { postId: 'f2', author: '对方', authorId: 'rival', content: '你这话太绝对了，我身边很多人加班到很晚。' },
    ],
  )
  const registry = new PlatformRegistry()
  registry.register({
    id: 'faketieba',
    displayName: '持久化测试平台',
    shape: 'forum-thread',
    canHandleUrl: (url) => url.startsWith('https://fake.example/p/'),
    parseUrl: (url) => ({ platform: 'faketieba' as never, threadId: url.split('/').pop() ?? '', url }),
    describeCapabilities: () => ({
      platform: 'faketieba',
      declaredAt: '2026-11-01T00:00:00.000Z',
      capabilities: {
        'thread.read': { state: 'supported', reason: '测试' },
        'comment.list': { state: 'supported', reason: '测试' },
        'comment.paginate': { state: 'supported', reason: '测试' },
        'comment.nested': { state: 'supported', reason: '测试' },
        'comment.locate': { state: 'supported', reason: '测试' },
        'identity.verify': { state: 'supported', reason: '测试' },
        'event.mentions': { state: 'unavailable', reason: '测试' },
        'comment.publish': { state: 'unverified', reason: '测试' },
        'comment.reply': { state: 'unverified', reason: '测试' },
        'publish.verify': { state: 'unverified', reason: '测试' },
        'media.read': { state: 'unavailable', reason: '测试' },
        'user.profile': { state: 'unavailable', reason: '测试' },
      },
    }),
    createAdapter: () => adapter,
  })
  const config = resolveConfig({
    ...DEFAULT_CONFIG,
    enabled: true,
    ownerHandle: 'owner-handle',
    ownerUserName: '楼主',
    platformAccounts: JSON.stringify({
      owners: [{ platform: 'faketieba', primary: { platform: 'faketieba', handle: 'owner-handle', displayName: '楼主' } }],
      aiAccounts: [{ platform: 'faketieba', account: { platform: 'faketieba', displayName: 'AI 马甲' } }],
    }),
    llmModel: 'mock-model',
    llmProtocol: 'chat',
    egressMode: 'open',
    maxFloorPages: 5,
    pageDelayMs: 0,
  })
  const llm = new ScriptedLlmClient([{ text: draft('f2'), model: 'mock-model' }])
  const runtime = buildRuntime(() => config, quiet, registry, undefined, { store })
  // Keep the test entirely local while exercising the real generation pipeline.
  const localRuntime: Runtime = { ...runtime, adapter, llm: () => llm }
  return { dir, store, runtime: localRuntime, llm }
}

test('会话阶段写失败：runAnalysis 不返回 sessionId，重载无幽灵会话', async (t) => {
  const { dir, store, runtime } = harness()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await store.ready()
  t.mock.method(
    store as unknown as { persist(data: StoreData): Promise<void> },
    'persist',
    async () => {
      throw Object.assign(new Error('injected session persist failure'), { code: 'EIO' })
    },
  )

  await assert.rejects(() => runAnalysis(runtime, { url: THREAD_URL, postId: 'f1' }), /状态写入失败/)
  assert.equal(store.hasUnsavedChanges, true)
  assert.equal((await store.readPersistedSnapshot()).sessions.length, 0)

  const reloaded = new DebateStore({ dir })
  await reloaded.ready()
  assert.equal(reloaded.snapshot().sessions.length, 0)
})

test('候选阶段写失败：runGeneration 不返回 candidateId，重载无幽灵候选', async (t) => {
  const { dir, store, runtime, llm } = harness()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const analyzed = await runAnalysis(runtime, { url: THREAD_URL, postId: 'f1' })
  assert.equal((await store.readPersistedSession(analyzed.sessionId))?.candidates.length, 0)
  const persist = (store as unknown as { persist(data: StoreData): Promise<void> }).persist.bind(store)
  t.mock.method(
    store as unknown as { persist(data: StoreData): Promise<void> },
    'persist',
    async (data: StoreData) => {
      if (data.sessions.some((row) => row.id === analyzed.sessionId && row.candidates.length > 0)) {
        throw Object.assign(new Error('injected candidate persist failure'), { code: 'EIO' })
      }
      await persist(data)
    },
  )

  await assert.rejects(
    () => runGeneration(runtime, { sessionId: analyzed.sessionId, targetPostId: 'f2' }),
    /状态写入失败/,
  )
  assert.equal(llm.requests.length, 1, '模型确实已返回，失败发生在候选持久化边界')
  assert.equal(store.hasUnsavedChanges, true)
  assert.equal(store.getSession(analyzed.sessionId)?.candidates.length, 1, '失败尝试仍按契约保留在内存')
  assert.equal((await store.readPersistedSession(analyzed.sessionId))?.candidates.length, 0)

  const reloaded = new DebateStore({ dir })
  await reloaded.ready()
  assert.equal(reloaded.getSession(analyzed.sessionId)?.candidates.length, 0)
})

test('正常生成：candidateId 返回前已从磁盘读回确认', async (t) => {
  const { dir, store, runtime } = harness()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const analyzed = await runAnalysis(runtime, { url: THREAD_URL, postId: 'f1' })

  const output = await runGeneration(runtime, { sessionId: analyzed.sessionId, targetPostId: 'f2' })
  assert.equal(output.outcome, 'valid_draft')
  assert.ok(output.candidateId)
  assert.equal(
    (await store.readPersistedSession(analyzed.sessionId))?.candidates.some((row) => row.replyId === output.candidateId),
    true,
  )
})
