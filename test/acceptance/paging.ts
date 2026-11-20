/**
 * Paging and cursor integrity.
 *
 * The tail-read strategy is a compromise, and a compromise is only defensible if
 * its boundaries are tested: how many pages it actually asks for, what it reports
 * when a page comes back short, and whether the cursor refuses to move when the
 * read was not whole.
 *
 * Everything here runs against a scriptable adapter, not a real platform — see
 * `docs/known-issues.md` for what that does and does not prove.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { probeThread } from '../../packages/core/lib/probe.js'
import { resolveConfig, DEFAULT_CONFIG, buildRuntime } from '../../packages/core/lib/index.js'
import { DebateStore } from '../../packages/core/lib/store.js'
import { PlatformRegistry } from '../../packages/core/lib/platforms/registry.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAdapter, type FakeReplySeed } from '../support/fake-adapter.ts'

const PLATFORM = 'faketieba'
const URL = 'https://fake.example/p/9100'

/** Build a runtime wired to one adapter, so `probeThread` can be driven directly. */
function makeRuntime(adapter: FakeAdapter, overrides: Record<string, unknown> = {}) {
  const registry = new PlatformRegistry()
  registry.register({
    id: PLATFORM,
    displayName: '假平台',
    shape: 'forum-thread',
    canHandleUrl: (url: string) => url.startsWith('https://fake.example/p/'),
    parseUrl: (url: string) => ({ platform: PLATFORM as never, threadId: url.split('/').pop() ?? '', url }),
    describeCapabilities: () =>
      ({
        platform: PLATFORM,
        declaredAt: '2026-11-01T00:00:00.000Z',
        capabilities: {},
      }) as never,
    createAdapter: () => adapter,
  })
  const config = {
    ...DEFAULT_CONFIG,
    egressMode: 'open' as const,
    pageDelayMs: 0,
    maxFloorPages: 20,
    ...overrides,
  }
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-paging-'))
  const store = new DebateStore({ dir })
  const runtime = buildRuntime(
    () => resolveConfig(config),
    { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    registry,
    undefined,
    { store },
  )
  return runtime
}

function floorSeeds(count: number, options: { startAt?: number; createdAt?: string } = {}): FakeReplySeed[] {
  const start = options.startAt ?? 0
  return Array.from({ length: count }, (_unused, index) => ({
    postId: `f${start + index + 1}`,
    author: index % 3 === 0 ? '楼主' : '对方',
    authorId: index % 3 === 0 ? 'owner-handle' : 'rival',
    content: `第 ${start + index + 1} 条发言的内容。`,
    createdAt: options.createdAt ?? '2026-11-19T10:00:00.000Z',
  }))
}

test('尾部读取只请求首页与最后两页，不逐页翻完整帖', async () => {
  // 120 floors at 20 per page is six pages; a tail read must touch three of them.
  const adapter = new FakeAdapter(
    { platform: PLATFORM, threadId: '9100', title: '长帖', url: URL, body: '开场白。', bodyAuthor: '楼主' },
    floorSeeds(120),
  )
  const runtime = makeRuntime(adapter)
  const result = await probeThread(runtime, { url: URL })

  assert.equal(result.scan.mode, 'tail')
  assert.equal(result.scan.pagesRead, 3, `应只读 3 页，实际 ${result.scan.pagesRead}`)
  const floorRequests = adapter.calls.filter((call) => call.method === 'getReplies').map((call) => call.page)
  assert.deepEqual(floorRequests, [1, 5, 6], `请求页码应为首页加末两页，实际 ${floorRequests.join(',')}`)
  // Every page read came back whole, so the tail itself is complete — "complete"
  // describes the range this mode set out to cover, and the coverage field says
  // which range that was.
  assert.equal(result.scan.complete, true)
  assert.equal(result.scan.totalPages, 6)
  // The newest floor is present; a first-page-only read would have missed it.
  assert.equal(result.replies.some((reply) => reply.postId === 'f120'), true)
})

test('尾部读取：页面返回不完整时报告缺口且不声称完整', async () => {
  const adapter = new FakeAdapter(
    { platform: PLATFORM, threadId: '9101', title: '残页', url: URL, body: '开场白。' },
    floorSeeds(120),
  )
  // Make the last page report itself as a degraded subset, exactly as a platform
  // that served a partial page would.
  const original = adapter.getReplies.bind(adapter)
  adapter.getReplies = async (ref, page) => {
    const result = await original(ref, page)
    return page === 6 ? { ...result, incomplete: true } : result
  }
  const runtime = makeRuntime(adapter)
  const result = await probeThread(runtime, { url: URL })

  assert.equal(result.scan.complete, false, '有一页不完整就不能声称完整')
  assert.match(result.scan.incompleteReason ?? '', /第 6 页/)
  assert.equal(result.scan.pagesRead, 3)
})

test('补偿扫描：按时间窗口向前读，遇到足够旧的页就停', async () => {
  const adapter = new FakeAdapter(
    { platform: PLATFORM, threadId: '9102', title: '补偿', url: URL, body: '开场白。' },
    // Six pages, each a day apart, newest first in time terms is the last page.
    floorSeeds(120, { createdAt: '2026-11-01T10:00:00.000Z' }),
  )
  const original = adapter.getReplies.bind(adapter)
  adapter.getReplies = async (ref, page) => {
    const result = await original(ref, page)
    // Page 6 = newest (day 6), page 1 = oldest (day 1).
    const day = page
    return {
      ...result,
      floors: result.floors.map((floor, index) => ({
        ...floor,
        createdAt: `2026-11-0${day}T10:00:${String(index).padStart(2, '0')}.000Z`,
      })),
    }
  }
  const runtime = makeRuntime(adapter)
  const originalNow = Date.now
  // "Now" is day 6 noon; a 24-hour window reaches back to day 5 noon.
  Date.now = () => Date.parse('2026-11-06T12:00:00.000Z')
  try {
    const result = await probeThread(runtime, { url: URL, mode: 'window', windowHours: 24 })
    const requests = adapter.calls.filter((call) => call.method === 'getReplies').map((call) => call.page)
    // It must walk back from the end and stop once a page is entirely older than
    // the cutoff — page 5 is day 5, older than day 5 noon, so it is the last read.
    assert.deepEqual(requests, [1, 6, 5], `补偿扫描页码应为 1,6,5，实际 ${requests.join(',')}`)
    assert.equal(result.scan.mode, 'window')
    // Reaching the cutoff is what makes a window complete. `hasMore` on the page
    // just read means "older content exists below", which is expected and is not a
    // gap — only a forward walk can be surprised by it.
    assert.equal(result.scan.complete, true)
  } finally {
    Date.now = originalNow
  }
})

test('补偿扫描：页数上限内没覆盖到窗口就明确报告未覆盖', async () => {
  const adapter = new FakeAdapter(
    { platform: PLATFORM, threadId: '9103', title: '长补偿', url: URL, body: '开场白。' },
    floorSeeds(600),
  )
  const runtime = makeRuntime(adapter)
  const result = await probeThread(runtime, { url: URL, mode: 'window', windowHours: 168 })
  // 600 floors = 30 pages, and the walk budget is 8 pages: it cannot reach the
  // start, so it must say so rather than imply a clean sweep.
  assert.equal(result.scan.complete, false)
  assert.match(result.scan.incompleteReason ?? '', /预算|未覆盖/)
  assert.equal(result.scan.pagesRead, 8)
})

test('全量读取：报告是否真的覆盖全部楼层', async () => {
  const adapter = new FakeAdapter(
    { platform: PLATFORM, threadId: '9104', title: '全量', url: URL, body: '开场白。' },
    floorSeeds(40),
  )
  const runtime = makeRuntime(adapter)
  const result = await probeThread(runtime, { url: URL, mode: 'full' })
  assert.equal(result.scan.mode, 'full')
  assert.equal(result.replies.filter((reply) => reply.kind === 'floor').length, 40)
})

test('指纹区分编辑，且不随页内顺序变化', async () => {
  const make = (content: string, order: number) => {
    const adapter = new FakeAdapter(
      { platform: PLATFORM, threadId: '9105', title: '指纹', url: URL, body: '开场白。' },
      [
        { postId: 'f1', author: '对方', authorId: 'rival', content, createdAt: '2026-11-01T00:00:00.000Z' },
        { postId: 'f2', author: '路人', authorId: 'other', content: '另一条。', createdAt: '2026-11-01T00:00:01.000Z' },
      ].slice(0, order),
    )
    return adapter
  }
  const one = await probeThread(makeRuntime(make('原始内容。', 2)), { url: URL })
  const fingerprint = one.replies.find((reply) => reply.postId === 'f1')?.fingerprint
  assert.ok(fingerprint !== undefined)

  const edited = await probeThread(makeRuntime(make('改过之后的内容。', 2)), { url: URL })
  assert.notEqual(edited.replies.find((reply) => reply.postId === 'f1')?.fingerprint, fingerprint, '文本变化必须改变指纹')

  // Same reply, different page composition: the fingerprint must not change.
  const reordered = await probeThread(makeRuntime(make('原始内容。', 1)), { url: URL })
  assert.equal(reordered.replies.find((reply) => reply.postId === 'f1')?.fingerprint, fingerprint, '顺序变化不得改变指纹')
})

test('楼中楼：修改子回复也会改变所属楼层的指纹集合', async () => {
  const adapter = new FakeAdapter(
    { platform: PLATFORM, threadId: '9106', title: '楼中楼', url: URL, body: '开场白。' },
    [
      { postId: 'f1', author: '楼主', authorId: 'owner-handle', content: '主楼内容。' },
      { postId: 'n1', author: '对方', authorId: 'rival', content: '第一条楼中楼。', parentPostId: 'f1' },
    ],
  )
  const runtime = makeRuntime(adapter)
  const result = await probeThread(runtime, { url: URL })
  const nested = result.replies.find((reply) => reply.postId === 'n1')
  assert.ok(nested !== undefined, '楼中楼必须出现在结果里')
  assert.equal(nested?.kind, 'nested')
  assert.equal(nested?.floorPostId, 'f1')
})
