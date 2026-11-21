/** Tieba paging/error contract tests, using the real captured WAP fixtures. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { TiebaAdapter } from '../lib/platforms/tieba/adapter.js'
import { __setHttpEgressGate } from '../lib/platforms/http.js'
import { EgressBlockedError, type DnsResolver } from '../lib/net-audit.js'
import { pagedMeta, pagedPage } from './helpers.ts'

const meta = pagedMeta()
const ref = { platform: 'tieba' as const, threadId: meta.tid, url: `https://tieba.baidu.com/p/${meta.tid}` }
const PUBLIC_DNS: DnsResolver = async (_hostname, family) =>
  family === 4 ? [{ address: '93.184.216.34', family: 4 }] : []

async function withFetch<T>(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

function fixtureFetch(overrides: Record<number, string> = {}): (url: string) => Response {
  return (url) => {
    if (url === 'https://www.baidu.com/') {
      return new Response('', { status: 200, headers: { 'set-cookie': 'BAIDUID=fixture; Path=/' } })
    }
    const parsed = new URL(url)
    const offset = Number(parsed.searchParams.get('pn') ?? '0')
    const page = Math.floor(offset / 30) + 1
    const html = overrides[page] ?? pagedPage(page)
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
}

test('贴吧分页：首页/中间页/末页的 pagingState 与实际页数一致', async () => {
  await withFetch(fixtureFetch(), async () => {
    const adapter = new TiebaAdapter({ retries: 0, pageDelayMs: 0, resolver: PUBLIC_DNS })
    const first = await adapter.getReplies(ref, 1)
    assert.equal(first.page, 1)
    assert.equal(first.declaredTotalPages, 8)
    assert.equal(first.pagingState, 'more')
    assert.equal(first.hasMore, true)
    assert.equal(first.incomplete, false)

    const last = await adapter.getReplies(ref, 8)
    assert.equal(last.pagingState, 'done')
    assert.equal(last.hasMore, false)
    assert.equal(last.incomplete, false)
  })
})

test('贴吧分页：平台返回的 current_page 与请求页不一致时标记 partial', async () => {
  // Request page 1 but serve the captured page 2. The metadata exposes the mismatch.
  await withFetch(fixtureFetch({ 1: pagedPage(2) }), async () => {
    const adapter = new TiebaAdapter({ retries: 0, pageDelayMs: 0, resolver: PUBLIC_DNS })
    const page = await adapter.getReplies(ref, 1)
    assert.equal(page.pagingState, 'partial')
    assert.equal(page.incomplete, true)
  })
})

test('贴吧分页：声明还有后续页却返回空页时标记 partial', async () => {
  const empty = '<html><script>page: {"current_page": 2, "total_page": 8, "total_num": 240, "page_size": 30}</script></html>'
  await withFetch(fixtureFetch({ 2: empty }), async () => {
    const adapter = new TiebaAdapter({ retries: 0, pageDelayMs: 0, resolver: PUBLIC_DNS })
    const page = await adapter.getReplies(ref, 2)
    assert.equal(page.floors.length, 0)
    assert.equal(page.pagingState, 'partial')
    assert.equal(page.incomplete, true)
  })
})

test('贴吧分页：maxPages 截断不能声称 complete', async () => {
  await withFetch(fixtureFetch(), async () => {
    const adapter = new TiebaAdapter({ retries: 0, pageDelayMs: 0, maxPages: 2, resolver: PUBLIC_DNS })
    const all = await adapter.getAllFloors(ref)
    assert.equal(all.totalPages, 8)
    assert.equal(all.complete, false)
  })
})

test('贴吧认证探测：出网策略拒绝原样抛出，不伪装成未登录', async () => {
  const blocked = new EgressBlockedError('tieba.baidu.com', 'platform', 'offline', '离线')
  let calls = 0
  await withFetch(() => {
    calls += 1
    return new Response('unexpected')
  }, async () => {
    __setHttpEgressGate(() => { throw blocked })
    try {
      await assert.rejects(
        () => new TiebaAdapter({
          retries: 2,
          resolver: PUBLIC_DNS,
          authProbeThreadId: ref.threadId,
        }).checkAuthentication(),
        (error: unknown) => error === blocked,
      )
      assert.equal(calls, 0)
    } finally {
      __setHttpEgressGate(undefined)
    }
  })
})

test('贴吧 HTTP：429 保留 Retry-After，403 验证页归类 captcha，5xx 归类 network', async () => {
  const cases: { status: number; body: string; code: string; retryAfterMs?: number }[] = [
    { status: 429, body: 'slow down', code: 'rate_limited', retryAfterMs: 7000 },
    { status: 403, body: '百度安全验证，请输入验证码', code: 'captcha' },
    { status: 500, body: 'server error', code: 'network' },
  ]
  for (const item of cases) {
    await withFetch((url) => {
      if (url === 'https://www.baidu.com/') return new Response('', { headers: { 'set-cookie': 'BAIDUID=fixture' } })
      return new Response(item.body, {
        status: item.status,
        headers: item.retryAfterMs === undefined ? {} : { 'retry-after': String(item.retryAfterMs / 1000) },
      })
    }, async () => {
      const adapter = new TiebaAdapter({ retries: 0, timeoutMs: 1000, resolver: PUBLIC_DNS })
      await assert.rejects(
        () => adapter.getReplies(ref, 1),
        (error: unknown) => {
          const typed = error as { code?: string; status?: number; retryAfterMs?: number }
          assert.equal(typed.code, item.code)
          assert.equal(typed.status, item.status)
          if (item.retryAfterMs !== undefined) assert.equal(typed.retryAfterMs, item.retryAfterMs)
          return true
        },
      )
    })
  }
})
