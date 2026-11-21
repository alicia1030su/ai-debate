/** Platform HTTP redirect and egress-boundary regression tests. */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EgressBlockedError, type DnsAnswer, type DnsResolver } from '../lib/net-audit.js'
import { blocksPublishing, classifyFault } from '../lib/fault-classify.js'
import { HttpClient, __setHttpEgressGate, classifyThrown, delay } from '../lib/platforms/http.js'
import { PlatformError } from '../lib/types.js'

const PUBLIC_DNS: DnsResolver = async (_hostname, family) =>
  family === 4 ? [{ address: '93.184.216.34', family: 4 }] : []

const UNDICI_DISPATCHER = Symbol.for('undici.globalDispatcher.1')

type SocketLookupCallback = (
  error: NodeJS.ErrnoException | null,
  addressOrAddresses: string | DnsAnswer | readonly DnsAnswer[],
  family?: 4 | 6,
) => void

class RecordingAgent {
  readonly connect: {
    lookup: (hostname: string, options: { family?: number; all?: boolean }, callback: SocketLookupCallback) => void
  }

  constructor(options: {
    connect: { lookup: (hostname: string, options: { family?: number; all?: boolean }, callback: SocketLookupCallback) => void }
  }) {
    this.connect = options.connect
  }

  async close(): Promise<void> {}
}

/** Run one request with a recording Agent so tests can simulate its socket lookup. */
async function withRecordingDispatcher<T>(run: () => Promise<T>): Promise<T> {
  const registry = globalThis as unknown as Record<symbol, unknown>
  const hadDispatcher = Object.prototype.hasOwnProperty.call(globalThis, UNDICI_DISPATCHER)
  const previous = registry[UNDICI_DISPATCHER]
  if (hadDispatcher) registry[UNDICI_DISPATCHER] = { constructor: RecordingAgent }
  else {
    Object.defineProperty(globalThis, UNDICI_DISPATCHER, {
      configurable: true,
      value: { constructor: RecordingAgent },
    })
  }
  try {
    return await run()
  } finally {
    if (hadDispatcher) registry[UNDICI_DISPATCHER] = previous
    else delete registry[UNDICI_DISPATCHER]
  }
}

function simulateSocketLookup(dispatcher: unknown, hostname: string): Promise<readonly DnsAnswer[]> {
  assert.ok(dispatcher instanceof RecordingAgent, 'fetch 必须收到固定 DNS 的 dispatcher')
  return new Promise((resolve, reject) => {
    dispatcher.connect.lookup(hostname, { family: 4 }, (error, addressOrAddresses, family) => {
      if (error !== null) {
        reject(error)
        return
      }
      if (typeof addressOrAddresses === 'string') {
        if (family === undefined) {
          reject(new Error('socket lookup 没有返回地址族'))
          return
        }
        resolve([{ address: addressOrAddresses, family }])
        return
      }
      resolve(Array.isArray(addressOrAddresses) ? [...addressOrAddresses] : [addressOrAddresses])
    })
  })
}

interface SeenRequest {
  readonly url: string
  readonly init: RequestInit
}

function mockFetch(
  t: TestContext,
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { requests: SeenRequest[] } {
  const original = globalThis.fetch
  const requests: SeenRequest[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, init: init ?? {} })
    return handler(url, init)
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = original
    __setHttpEgressGate(undefined)
  })
  return { requests }
}

function header(init: RequestInit, name: string): string | undefined {
  const headers = init.headers
  if (headers === undefined) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase())
    return found?.[1]
  }
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return found?.[1]
}

test('HTTP 重定向：manual 逐跳执行、同源保留凭据、POST 302 转 GET', async (t) => {
  const seen: string[] = []
  const mock = mockFetch(t, (url) => {
    if (url === 'https://tieba.baidu.com/start') {
      return new Response(null, {
        status: 302,
        headers: { location: '/middle', 'set-cookie': 'BAIDUID=fixture; Path=/' },
      })
    }
    if (url === 'https://tieba.baidu.com/middle') {
      return new Response(null, { status: 307, headers: { location: '/final' } })
    }
    return new Response('done', { status: 200 })
  })
  __setHttpEgressGate((url) => seen.push(url))
  const client = new HttpClient({ retries: 0, resolver: PUBLIC_DNS })
  client.jar.set('EXISTING', 'held')

  const result = await client.request('https://tieba.baidu.com/start', {
    method: 'POST',
    form: { content: 'hello' },
    headers: { authorization: 'Bearer first-party' },
  })

  assert.equal(result.url, 'https://tieba.baidu.com/final')
  assert.equal(result.text, 'done')
  assert.deepEqual(seen, [
    'https://tieba.baidu.com/start',
    'https://tieba.baidu.com/middle',
    'https://tieba.baidu.com/final',
  ])
  assert.equal(mock.requests.length, 3)
  for (const request of mock.requests) assert.equal(request.init.redirect, 'manual')
  assert.equal(mock.requests[0]?.init.method, 'POST')
  assert.equal(header(mock.requests[0]?.init ?? {}, 'authorization'), 'Bearer first-party')
  assert.match(header(mock.requests[1]?.init ?? {}, 'cookie') ?? '', /EXISTING=held/)
  assert.match(header(mock.requests[1]?.init ?? {}, 'cookie') ?? '', /BAIDUID=fixture/)
  assert.equal(mock.requests[1]?.init.method, 'GET')
  assert.equal(mock.requests[1]?.init.body, undefined)
  assert.equal(header(mock.requests[2]?.init ?? {}, 'authorization'), 'Bearer first-party')
})

test('HTTP 重定向：307/308 保留 POST 表单体', async (t) => {
  let status: 307 | 308 = 307
  const mock = mockFetch(t, (url) => url.endsWith('/start')
    ? new Response(null, { status, headers: { location: '/final' } })
    : new Response('ok'))
  for (const nextStatus of [307, 308] as const) {
    status = nextStatus
    const client = new HttpClient({ retries: 0, resolver: PUBLIC_DNS })
    await client.request('https://tieba.baidu.com/start', { method: 'POST', form: { content: 'hello' } })
    assert.equal(mock.requests.at(-2)?.init.method, 'POST')
    assert.equal(mock.requests.at(-1)?.init.method, 'POST')
    assert.equal(mock.requests.at(-1)?.init.body, 'content=hello')
    assert.equal(header(mock.requests.at(-1)?.init ?? {}, 'content-type'), 'application/x-www-form-urlencoded;charset=UTF-8')
  }
})

test('HTTP 重定向：同源 307/308 已固定 host 不重复 DNS 预检', async (t) => {
  for (const status of [307, 308] as const) {
    await t.test(String(status), async (child) => {
      const calls: Array<[string, 4 | 6]> = []
      let afterFirstHop: number | undefined
      const resolver: DnsResolver = async (hostname, family) => {
        calls.push([hostname, family])
        if (family === 6) return []
        const aCalls = calls.filter(([, answerFamily]) => answerFamily === 4).length
        return [{ address: aCalls <= 2 ? '93.184.216.34' : '8.8.8.8', family: 4 }]
      }
      const mock = mockFetch(child, async (url, init) => {
        assert.equal(init?.redirect, 'manual')
        const dispatcher = (init as (RequestInit & { dispatcher?: unknown }) | undefined)?.dispatcher
        const answers = await simulateSocketLookup(dispatcher, new URL(url).hostname)
        assert.deepEqual(answers, [{ address: '93.184.216.34', family: 4 }])
        afterFirstHop ??= calls.length
        return url.endsWith('/start')
          ? new Response(null, { status, headers: { location: '/final' } })
          : new Response('ok')
      })
      const gated: string[] = []
      __setHttpEgressGate((url) => gated.push(url))

      await withRecordingDispatcher(async () => {
        const result = await new HttpClient({ retries: 0, resolver }).request(
          'https://tieba.baidu.com/start',
        )
        assert.equal(result.text, 'ok')
      })
      assert.deepEqual(gated, [
        'https://tieba.baidu.com/start',
        'https://tieba.baidu.com/final',
      ])
      assert.equal(mock.requests.length, 2)
      assert.equal(afterFirstHop, 4, '首跳预检与首次 socket lookup 各解析一次 A/AAAA')
      assert.equal(calls.length, afterFirstHop, '第二跳不得重复 DNS 预检或 socket 解析')
      assert.deepEqual(calls, [
        ['tieba.baidu.com', 4],
        ['tieba.baidu.com', 6],
        ['tieba.baidu.com', 4],
        ['tieba.baidu.com', 6],
      ])
    })
  }
})

test('HTTP 重定向：新 host 仍解析并固定，返回已固定 host 不重复解析', async (t) => {
  const calls: Array<[string, 4 | 6]> = []
  const resolver: DnsResolver = async (hostname, family) => {
    calls.push([hostname, family])
    if (family === 6) return []
    return [{ address: hostname === 'tieba.baidu.com' ? '93.184.216.34' : '8.8.8.8', family: 4 }]
  }
  const mock = mockFetch(t, async (url, init) => {
    assert.equal(init?.redirect, 'manual')
    const dispatcher = (init as (RequestInit & { dispatcher?: unknown }) | undefined)?.dispatcher
    await simulateSocketLookup(dispatcher, new URL(url).hostname)
    if (url.endsWith('/start')) {
      return new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/middle' } })
    }
    if (url.endsWith('/middle')) {
      return new Response(null, { status: 302, headers: { location: 'https://tieba.baidu.com/final' } })
    }
    return new Response('ok')
  })
  const gated: string[] = []
  __setHttpEgressGate((url) => gated.push(url))

  await withRecordingDispatcher(async () => {
    const result = await new HttpClient({ retries: 0, resolver }).request('https://tieba.baidu.com/start')
    assert.equal(result.text, 'ok')
  })
  assert.deepEqual(gated, [
    'https://tieba.baidu.com/start',
    'https://cdn.example.net/middle',
    'https://tieba.baidu.com/final',
  ])
  assert.equal(mock.requests.length, 3)
  assert.deepEqual(calls, [
    ['tieba.baidu.com', 4], ['tieba.baidu.com', 6],
    ['tieba.baidu.com', 4], ['tieba.baidu.com', 6],
    ['cdn.example.net', 4], ['cdn.example.net', 6],
    ['cdn.example.net', 4], ['cdn.example.net', 6],
  ])
})

test('HTTP 重定向：跨域剥离 Cookie/Authorization，返回原域也不恢复', async (t) => {
  const mock = mockFetch(t, (url) => {
    if (url === 'https://tieba.baidu.com/start') {
      return new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/next' } })
    }
    if (url === 'https://cdn.example.net/next') {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://tieba.baidu.com/final', 'set-cookie': 'ATTACKER=redirect-cookie; Path=/' },
      })
    }
    return new Response('ok')
  })
  const client = new HttpClient({ retries: 0, resolver: PUBLIC_DNS })
  client.jar.set('BAIDUID', 'secret-cookie')

  await client.request('https://tieba.baidu.com/start', {
    headers: {
      Authorization: 'Bearer secret',
      CoOkIe: 'EXPLICIT=secret',
      'Proxy-Authorization': 'Basic proxy-secret',
      accept: 'text/html',
    },
  })

  assert.equal(header(mock.requests[0]?.init ?? {}, 'cookie'), 'EXPLICIT=secret', '显式 Cookie 按既有优先级覆盖 jar')
  assert.equal(header(mock.requests[0]?.init ?? {}, 'authorization'), 'Bearer secret')
  for (const request of mock.requests.slice(1)) {
    assert.equal(header(request.init, 'cookie'), undefined)
    assert.equal(header(request.init, 'authorization'), undefined)
    assert.equal(header(request.init, 'proxy-authorization'), undefined)
    assert.equal(header(request.init, 'accept'), 'text/html')
  }

  await client.request('https://tieba.baidu.com/final')
  const laterCookie = header(mock.requests.at(-1)?.init ?? {}, 'cookie') ?? ''
  assert.match(laterCookie, /BAIDUID=secret-cookie/)
  assert.equal(laterCookie.includes('ATTACKER'), false, '跨域 Set-Cookie 不得污染后续第一方请求')
})

test('HTTP 重定向：跨域 307/308 拒绝重放请求体', async (t) => {
  for (const status of [307, 308] as const) {
    const mock = mockFetch(t, () => new Response(null, {
      status,
      headers: { location: 'https://other.example/upload' },
    }))
    await assert.rejects(
      () => new HttpClient({ retries: 0, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/start', {
        method: 'POST',
        form: { content: 'private-body' },
      }),
      (error: unknown) => error instanceof PlatformError && /请求体跨域/.test(error.message),
    )
    assert.equal(mock.requests.length, 1)
  }
})

test('HTTP 重定向：每一跳都过 egressGate，拒绝原样传播且不重试', async (t) => {
  const mock = mockFetch(t, () => new Response(null, {
    status: 302,
    headers: { location: 'https://forbidden.example.net/next' },
  }))
  const checked: string[] = []
  const blocked = new EgressBlockedError('forbidden.example.net', 'platform', 'manual', '测试拒绝')
  __setHttpEgressGate((url) => {
    checked.push(url)
    if (url === 'https://forbidden.example.net/next') throw blocked
  })

  await assert.rejects(
    () => new HttpClient({ retries: 3, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/start'),
    (error: unknown) => error === blocked,
  )
  assert.deepEqual(checked, ['https://tieba.baidu.com/start', 'https://forbidden.example.net/next'])
  assert.equal(mock.requests.length, 1, '被策略拒绝的目标不能产生 socket，也不能重试')
  assert.equal(classifyThrown(blocked).code, 'egress_blocked')
  assert.match(classifyThrown(blocked).message, /出网策略拒绝/)
})

test('出网策略拒绝：诊断不是网络故障且禁止重试/发表', () => {
  const fault = classifyFault({ code: 'egress_blocked', hostReachable: false, hasCredential: false })
  assert.equal(fault.kind, 'egress_blocked')
  assert.equal(fault.retryable, false)
  assert.equal(blocksPublishing(fault), true)
  assert.match(fault.nextStep, /检查运行模式/)
})

test('HTTP 重定向：首跳被拒时不调用 fetch', async (t) => {
  const mock = mockFetch(t, () => new Response('unexpected'))
  const blocked = new EgressBlockedError('tieba.baidu.com', 'platform', 'offline', '离线')
  __setHttpEgressGate(() => { throw blocked })
  await assert.rejects(
    () => new HttpClient({ retries: 2, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/start'),
    (error: unknown) => error === blocked,
  )
  assert.equal(mock.requests.length, 0)
})

test('HTTP 重定向：循环立即停止，不消耗完整跳数预算', async (t) => {
  const mock = mockFetch(t, () => new Response(null, { status: 302, headers: { location: '/again' } }))
  await assert.rejects(
    () => new HttpClient({ retries: 2, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/start'),
    (error: unknown) => error instanceof PlatformError && /重定向循环/.test(error.message),
  )
  assert.equal(mock.requests.length, 2)
})

test('HTTP 重定向：最多跟随 5 跳，超限目标不发请求', async (t) => {
  const mock = mockFetch(t, (url) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/start') {
      return new Response(null, { status: 302, headers: { location: '/r1' } })
    }
    const hop = Number(parsed.pathname.slice(2))
    return hop <= 5
      ? new Response(null, { status: 302, headers: { location: `/r${hop + 1}` } })
      : new Response('unreachable')
  })
  await assert.rejects(
    () => new HttpClient({ retries: 0, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/start'),
    (error: unknown) => error instanceof PlatformError && /重定向超过/.test(error.message),
  )
  assert.equal(mock.requests.length, 6, '初始请求 + 5 次重定向')
})

test('HTTP 重定向：单次尝试的总超时覆盖整条跳链并遵守 AbortSignal', async (t) => {
  const mock = mockFetch(t, (url, init) => {
    if (url.endsWith('/start')) {
      return new Response(null, { status: 302, headers: { location: '/slow' } })
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
  })
  await assert.rejects(
    () => new HttpClient({ retries: 0, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/start', { timeoutMs: 30 }),
    (error: unknown) => error instanceof PlatformError && error.code === 'timeout',
  )
  assert.equal(mock.requests.length, 2)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => new HttpClient({ retries: 2, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/start', { signal: controller.signal }),
    (error: unknown) => error instanceof PlatformError && error.code === 'timeout',
  )
  assert.equal(mock.requests.length, 2, '已取消的请求不得再发连接')
})

test('HTTP 重定向：无效 Location 在发请求前被拒绝且不重试', async (t) => {
  const mock = mockFetch(t, () => new Response(null, { status: 302, headers: { location: 'http://[' } }))
  await assert.rejects(
    () => new HttpClient({ retries: 2, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/start'),
    (error: unknown) => error instanceof PlatformError && /有效的绝对 URL/.test(error.message),
  )
  assert.equal(mock.requests.length, 1)
})

test('HTTP 重定向：不安全协议在发请求前被拒绝', async (t) => {
  const mock = mockFetch(t, () => new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }))
  await assert.rejects(
    () => new HttpClient({ retries: 0, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/start'),
    (error: unknown) => error instanceof PlatformError && /不安全的协议/.test(error.message),
  )
  assert.equal(mock.requests.length, 1)
})

test('HTTP 重定向：跨域私网目标被 egressGate 拒绝，不出网', async (t) => {
  const mock = mockFetch(t, () => new Response(null, {
    status: 302,
    headers: { location: 'https://127.0.0.1:8080/admin?token=private' },
  }))
  const checked: string[] = []
  __setHttpEgressGate((url) => {
    checked.push(url)
    if (new URL(url).hostname === '127.0.0.1') {
      throw new EgressBlockedError('127.0.0.1', 'platform', 'offline', '禁止私网')
    }
  })
  await assert.rejects(
    () => new HttpClient({ retries: 2, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/start'),
    (error: unknown) => error instanceof EgressBlockedError && error.code === 'egress_blocked',
  )
  assert.deepEqual(checked, ['https://tieba.baidu.com/start', 'https://127.0.0.1:8080/admin?token=private'])
  assert.equal(mock.requests.length, 1)
})

test('HTTP 重定向：port 变化也按跨域剥离凭据', async (t) => {
  for (const target of ['https://tieba.baidu.com:8443/next']) {
    const mock = mockFetch(t, (url) => url.endsWith('/start')
      ? new Response(null, { status: 302, headers: { location: target } })
      : new Response('ok'))
    const client = new HttpClient({ retries: 0, resolver: PUBLIC_DNS })
    client.jar.set('BAIDUID', 'secret')
    await client.request('https://tieba.baidu.com/start', {
      headers: { authorization: 'Bearer secret', cookie: 'EXPLICIT=secret' },
    })
    assert.equal(header(mock.requests[1]?.init ?? {}, 'cookie'), undefined)
    assert.equal(header(mock.requests[1]?.init ?? {}, 'authorization'), undefined)
  }
})

test('平台 HTTP：没有 egressGate 时仍拒绝私网/回环/link-local/metadata', async (t) => {
  const targets = [
    'http://127.0.0.1/admin',
    'http://10.1.2.3/admin',
    'http://172.16.0.1/admin',
    'http://192.168.1.1/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1/admin',
    'http://[::1]/admin',
    'http://[fc00::1]/admin',
    'http://[::ffff:127.0.0.1]/admin',
  ]
  for (const target of targets) {
    await t.test(target, async (child) => {
      const mock = mockFetch(child, () => new Response('unexpected'))
      await assert.rejects(
        () => new HttpClient({ retries: 2, resolver: PUBLIC_DNS }).request(target),
        (error: unknown) => error instanceof EgressBlockedError && error.code === 'egress_blocked',
      )
      assert.equal(mock.requests.length, 0)
    })
  }
})

test('平台 HTTP：DNS 任一 A/AAAA 私网答案都阻断，且不调用 fetch', async (t) => {
  const mock = mockFetch(t, () => new Response('unexpected'))
  const resolver: DnsResolver = async (_hostname, family) => family === 4
    ? [{ address: '93.184.216.34', family: 4 }]
    : [{ address: '::ffff:a9fe:a9fe', family: 6 }]
  await assert.rejects(
    () => new HttpClient({ retries: 2, resolver }).request('https://mixed.example/start'),
    (error: unknown) => error instanceof EgressBlockedError && /元数据/.test(error.message),
  )
  assert.equal(mock.requests.length, 0)
})

test('平台 HTTP：连接使用 pinned dispatcher，且每个 hostname 只解析一次', async (t) => {
  const mock = mockFetch(t, () => new Response('ok'))
  const calls: Array<[string, 4 | 6]> = []
  const resolver: DnsResolver = async (hostname, family) => {
    calls.push([hostname, family])
    return family === 4 ? [{ address: '93.184.216.34', family: 4 }] : []
  }
  await new HttpClient({ retries: 0, resolver }).request('https://tieba.baidu.com/start')
  assert.deepEqual(calls, [['tieba.baidu.com', 4], ['tieba.baidu.com', 6]])
  const init = mock.requests[0]?.init as RequestInit & { dispatcher?: unknown }
  assert.ok(init.dispatcher != null, 'native fetch 必须收到固定地址的 Undici dispatcher')
})

test('HTTP 重定向：HTTPS 降级到 HTTP 在发请求前被拒绝', async (t) => {
  const mock = mockFetch(t, () => new Response(null, {
    status: 302,
    headers: { location: 'http://tieba.baidu.com/next' },
  }))
  await assert.rejects(
    () => new HttpClient({ retries: 2, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/start'),
    (error: unknown) => error instanceof PlatformError && /降级/.test(error.message),
  )
  assert.equal(mock.requests.length, 1)
})

test('HTTP 重定向：跨域同时剥离 Referer/Origin，返回原域也不恢复', async (t) => {
  const mock = mockFetch(t, (url) => url.endsWith('/start')
    ? new Response(null, { status: 302, headers: { location: 'https://other.example/next' } })
    : url.endsWith('/next')
      ? new Response(null, { status: 302, headers: { location: 'https://tieba.baidu.com/final' } })
      : new Response('ok'))
  await new HttpClient({ retries: 0, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/start', {
    headers: {
      authorization: 'Bearer secret',
      referer: 'https://tieba.baidu.com/start',
      origin: 'https://tieba.baidu.com',
    },
  })
  for (const request of mock.requests.slice(1)) {
    assert.equal(header(request.init, 'authorization'), undefined)
    assert.equal(header(request.init, 'referer'), undefined)
    assert.equal(header(request.init, 'origin'), undefined)
  }
})

test('HTTP 429：内部重试等待 Retry-After，而不是立即再次请求', async (t) => {
  let calls = 0
  const requestedAt: number[] = []
  mockFetch(t, () => {
    requestedAt.push(performance.now())
    calls += 1
    return calls === 1
      ? new Response('slow down', { status: 429, headers: { 'retry-after': '1' } })
      : new Response('ok')
  })
  const result = await new HttpClient({ retries: 1, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/start')
  assert.equal(result.text, 'ok')
  assert.equal(calls, 2)
  assert.ok((requestedAt[1] ?? 0) - (requestedAt[0] ?? 0) >= 900, '第二次请求应至少等待 Retry-After 的 1 秒')
})

test('AbortSignal 竞态：注册后复查可阻止请求与 delay', async (t) => {
  const mock = mockFetch(t, () => new Response('unexpected'))
  const signal = racingAbortSignal()
  await assert.rejects(
    () => new HttpClient({ retries: 0, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/start', { signal }),
    (error: unknown) => error instanceof PlatformError && error.code === 'timeout',
  )
  assert.equal(mock.requests.length, 0)
  await assert.rejects(
    () => delay(10_000, racingAbortSignal()),
    (error: unknown) => error instanceof PlatformError && error.code === 'timeout',
  )
})

/** A signal that becomes aborted immediately after its listener is registered. */
function racingAbortSignal(): AbortSignal {
  const controller = new AbortController()
  let registered = false
  return new Proxy(controller.signal, {
    get(target, property): unknown {
      if (property === 'aborted') return registered
      if (property === 'addEventListener') {
        return (...args: Parameters<AbortSignal['addEventListener']>): void => {
          registered = true
          target.addEventListener(...args)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test('HTTP 403：真实验证页归类 captcha 且不重试，普通拒绝仍是 forbidden', async (t) => {
  const fixture = readFileSync(new URL('./fixtures/real/challenge-403.html', import.meta.url), 'utf8')
  const cases = [
    { body: '百度安全验证，请输入验证码', code: 'captcha' },
    { body: fixture, code: 'captcha' },
    { body: 'forbidden', code: 'forbidden' },
  ] as const
  let index = 0
  const mock = mockFetch(t, () => new Response(cases[index++]?.body, { status: 403 }))
  for (const item of cases) {
    const before = mock.requests.length
    await assert.rejects(
      () => new HttpClient({ retries: 2, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/p/123'),
      (error: unknown) => {
        assert.ok(error instanceof PlatformError)
        assert.equal(error.code, item.code)
        assert.equal(error.status, 403)
        assert.equal(error.retryable, false)
        return true
      },
    )
    assert.equal(mock.requests.length, before + 1)
  }
})
