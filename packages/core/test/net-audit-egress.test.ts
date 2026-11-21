/** Model egress: private-address matrix, pinned DNS and manual redirect boundaries. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import {
  EgressBlockedError,
  PinnedDnsAgent,
  EgressGuard,
  EgressLog,
  egressPolicyOf,
  isBlockedNetworkAddress,
  isLoopbackAddress,
  isPrivateEndpointAddress,
  resolveNetworkHost,
  type DnsAnswer,
  type DnsResolver,
} from '../src/net-audit.ts'
import { HttpClient } from '../lib/platforms/http.js'
import { PlatformError } from '../lib/types.js'

const PUBLIC_DNS: DnsResolver = async (_hostname, family) =>
  family === 4 ? [{ address: '93.184.216.34', family: 4 }] : []

const UNDICI_DISPATCHER = Symbol.for('undici.globalDispatcher.1')

type SocketLookupOptions = { family?: number; all?: boolean }
type SocketLookupCallback = (
  error: NodeJS.ErrnoException | null,
  addressOrAddresses: string | DnsAnswer | readonly DnsAnswer[],
  family?: 4 | 6,
) => void

class RecordingAgent {
  static latest: RecordingAgent | undefined
  readonly connect: { lookup: (hostname: string, options: SocketLookupOptions, callback: SocketLookupCallback) => void }

  constructor(options: {
    connect: { lookup: (hostname: string, options: SocketLookupOptions, callback: SocketLookupCallback) => void }
  }) {
    this.connect = options.connect
    RecordingAgent.latest = this
  }

  async close(): Promise<void> {}
}

/** Temporarily replace Node's bundled Agent constructor without changing production APIs. */
async function withDispatcherConstructor<T>(constructor: unknown, run: () => Promise<T>): Promise<T> {
  const registry = globalThis as unknown as Record<symbol, unknown>
  const hadDispatcher = Object.prototype.hasOwnProperty.call(globalThis, UNDICI_DISPATCHER)
  const previous = registry[UNDICI_DISPATCHER]
  if (hadDispatcher) registry[UNDICI_DISPATCHER] = { constructor }
  else {
    Object.defineProperty(globalThis, UNDICI_DISPATCHER, {
      configurable: true,
      value: { constructor },
    })
  }
  try {
    return await run()
  } finally {
    if (hadDispatcher) registry[UNDICI_DISPATCHER] = previous
    else delete registry[UNDICI_DISPATCHER]
  }
}

async function withRecordingAgent<T>(
  run: (pinned: PinnedDnsAgent, recorder: RecordingAgent) => Promise<T>,
): Promise<T> {
  return withDispatcherConstructor(RecordingAgent, async () => {
    const pinned = await PinnedDnsAgent.create()
    const recorder = RecordingAgent.latest
    assert.ok(recorder !== undefined, 'PinnedDnsAgent 应使用注入的 Agent 构造器')
    try {
      return await run(pinned, recorder)
    } finally {
      await pinned.close()
    }
  })
}

function socketLookup(
  recorder: RecordingAgent,
  hostname: string,
  options: SocketLookupOptions = {},
): Promise<readonly DnsAnswer[]> {
  return new Promise((resolve, reject) => {
    recorder.connect.lookup(hostname, options, (error, addressOrAddresses, family) => {
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

function guard(
  mode: 'open' | 'manual' | 'offline' = 'open',
  allowedHosts: readonly string[] = [],
  resolver: DnsResolver = PUBLIC_DNS,
  allowedOrigins?: readonly string[],
): EgressGuard {
  return new EgressGuard({
    mode,
    allowedHosts,
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
  }, new EgressLog(), { resolver })
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name)
}

function findCause(error: unknown): unknown {
  let current = error
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    if (current instanceof EgressBlockedError) return current
    current = (current as { cause?: unknown }).cause
  }
  return current
}

test('IP 矩阵：私网、回环、link-local、CGNAT、IPv6 与 mapped IPv6 全部阻断', () => {
  const blocked = [
    '127.0.0.1', '127.255.255.254',
    '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '192.168.255.255',
    '169.254.169.254', '169.254.1.1',
    '100.64.0.1', '100.127.255.255',
    '0.0.0.0', '224.0.0.1',
    '192.0.0.1', '192.0.2.1', '192.88.99.1',
    '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1',
    '::', '::1', '0:0:0:0:0:0:0:1', 'fc00::1', 'fdff::1',
    'fc00:0:0:0:0:0:0:1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe',
    '::ffff:6440:101', '::ffff:c0a8:101', '::ffff:0:7f00:1',
    '::127.0.0.1', '::10.0.0.1', '::7f00:1', '::a00:1',
    '2002:7f00:1::', '2002:a00:1::', '64:ff9b::a00:1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  ]
  for (const address of blocked) {
    assert.equal(isBlockedNetworkAddress(address), true, address)
  }
  const allowed = [
    '8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1',
    '100.63.255.255', '100.128.0.1', '192.169.0.1',
    '2606:2800:220:1:248:1893:25c8:1946', '2001:4860:4860::8888',
  ]
  for (const address of allowed) {
    assert.equal(isBlockedNetworkAddress(address), false, address)
  }
  assert.equal(isLoopbackAddress('::ffff:127.0.0.2'), true)
  assert.equal(isLoopbackAddress('127.42.0.1'), true)
  for (const address of ['127.0.0.1', '10.0.0.8', '172.16.0.1', '192.168.1.1', '100.64.0.1', '::1', 'fd00::8']) {
    assert.equal(isPrivateEndpointAddress(address), true, address)
  }
  for (const address of ['169.254.169.254', 'fe80::1', '8.8.8.8', '2001:4860:4860::8888']) {
    assert.equal(isPrivateEndpointAddress(address), false, address)
  }
})

test('manual 白名单只服务模型用途，平台请求不能借用', () => {
  const modelGuard = guard('manual', ['model.example'])
  assert.equal(modelGuard.decide('model.example', 'model').allowed, true)
  assert.equal(modelGuard.decide('model.example', 'platform').allowed, false)
})

test('DNS 校验：同时解析 A/AAAA，任一私网答案都fail-closed', async () => {
  const calls: Array<[string, 4 | 6]> = []
  const resolver: DnsResolver = async (hostname, family) => {
    calls.push([hostname, family])
    return family === 4
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '::ffff:169.254.169.254', family: 6 }]
  }
  await assert.rejects(
    () => resolveNetworkHost('mixed.example', { resolver }),
    (error: unknown) => error instanceof EgressBlockedError
      && error.code === 'egress_blocked'
      && /元数据/.test(error.message),
  )
  assert.deepEqual(calls, [['mixed.example', 4], ['mixed.example', 6]])
})

test('DNS 校验：本机模型端点只接受全回环答案', async () => {
  await assert.rejects(
    () => resolveNetworkHost('local-model.example', {
      allowLoopback: true,
      resolver: async (_hostname, family) => family === 4
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: 'fd00::8', family: 6 }],
    }),
    (error: unknown) => error instanceof EgressBlockedError && /非回环/.test(error.message),
  )
  const answers = await resolveNetworkHost('local-model.example', {
    allowLoopback: true,
    resolver: async (_hostname, family) => family === 4
      ? [{ address: '127.0.0.1', family: 4 }]
      : [{ address: '::1', family: 6 }],
  })
  assert.deepEqual(answers.map((answer) => answer.address), ['127.0.0.1', '::1'])
})

test('配置策略保留精确模型 origin，供初始私网端点例外使用', () => {
  const policy = egressPolicyOf({ mode: 'open', llmBaseUrl: 'http://127.0.0.1:17902/v1' })
  assert.deepEqual(policy.allowedHosts, ['127.0.0.1'])
  assert.deepEqual(policy.allowedOrigins, ['http://127.0.0.1:17902'])
})

test('DNS 校验：显式初始模型端点接受全私网答案，但拒绝 metadata/link-local', async () => {
  const answers = await resolveNetworkHost('model.lan', {
    allowPrivateEndpoint: true,
    resolver: async (_hostname, family) => family === 4
      ? [{ address: '10.0.0.8', family: 4 }]
      : [{ address: 'fd00::8', family: 6 }],
  })
  assert.deepEqual(answers.map((answer) => answer.address), ['10.0.0.8', 'fd00::8'])
  await assert.rejects(
    () => resolveNetworkHost('metadata.example', {
      allowPrivateEndpoint: true,
      resolver: async (_hostname, family) => family === 4
        ? [{ address: '169.254.169.254', family: 4 }]
        : [],
    }),
    (error: unknown) => error instanceof EgressBlockedError && /元数据/.test(error.message),
  )
  const publicAnswers = await resolveNetworkHost('public-model.example', {
    allowPrivateEndpoint: true,
    resolver: PUBLIC_DNS,
  })
  assert.deepEqual(publicAnswers.map((answer) => answer.address), ['93.184.216.34'])
  await assert.rejects(
    () => resolveNetworkHost('mixed-model.example', {
      allowPrivateEndpoint: true,
      resolver: async (_hostname, family) => family === 4
        ? [{ address: '10.0.0.8', family: 4 }]
        : [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }],
    }),
    (error: unknown) => error instanceof EgressBlockedError && /不能混合/.test(error.message),
  )
})

test('open/manual 显式初始模型端点允许本机/RFC1918，offline 仍拒绝', async (t) => {
  for (const mode of ['open', 'manual'] as const) {
    await t.test(mode, async () => {
      let calls = 0
      const base = (async () => {
        calls += 1
        return new Response('ok')
      }) as typeof fetch
      const local = guard(mode, ['127.0.0.1'], PUBLIC_DNS, ['http://127.0.0.1:17902'])
      assert.equal(await (await local.fetch(base)('http://127.0.0.1:17902/v1/chat/completions', {
        method: 'POST',
        body: '{}',
      })).text(), 'ok')
      assert.equal(calls, 1)

      const lan = guard(mode, ['model.lan'], async (_hostname, family) => family === 4
        ? [{ address: '10.2.3.4', family: 4 }]
        : [], ['http://model.lan:11434'])
      assert.equal((await lan.fetch(base)('http://model.lan:11434/v1/models')).status, 200)

      const publicModel = guard(mode, ['model.example'], PUBLIC_DNS, ['https://model.example'])
      assert.equal((await publicModel.fetch(base)('https://model.example/v1/models')).status, 200)
    })
  }
  await assert.rejects(
    () => guard('offline', ['127.0.0.1'], PUBLIC_DNS, ['http://127.0.0.1:17902'])
      .fetch(async () => new Response('unexpected'))('http://127.0.0.1:17902/v1/models'),
    (error: unknown) => error instanceof EgressBlockedError && error.code === 'egress_blocked',
  )
})

test('模型重定向：manual 本机端点允许同源跳转，拒绝其他本机地址', async () => {
  const seen: string[] = []
  const base = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    seen.push(url)
    assert.equal(init?.redirect, 'manual')
    if (url === 'http://127.0.0.1:11434/chat/completions') {
      return new Response(null, { status: 302, headers: { location: '/v1/chat/completions' } })
    }
    return new Response('{"choices":[]}', { status: 200 })
  }) as typeof fetch
  const modelGuard = guard('manual', ['127.0.0.1'])
  const response = await modelGuard.fetch(base)('http://127.0.0.1:11434/chat/completions', {
    method: 'POST',
    body: '{}',
  })
  assert.equal(await response.text(), '{"choices":[]}')
  assert.deepEqual(seen, [
    'http://127.0.0.1:11434/chat/completions',
    'http://127.0.0.1:11434/v1/chat/completions',
  ])

  let calls = 0
  const redirecting = (async () => {
    calls += 1
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.2:11434/steal' } })
  }) as typeof fetch
  await assert.rejects(
    () => modelGuard.fetch(redirecting)('http://127.0.0.1:11434/chat/completions', { method: 'POST', body: '{}' }),
    (error: unknown) => error instanceof EgressBlockedError && error.code === 'egress_blocked',
  )
  assert.equal(calls, 1)
})

test('模型重定向：公网模型跳到回环/私网/元数据在连接前被拒绝', async (t) => {
  for (const target of [
    'http://127.0.0.1:8080/admin',
    'http://10.0.0.1/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]:8080/admin',
  ]) {
    await t.test(target, async () => {
      let calls = 0
      const base = (async () => {
        calls += 1
        return new Response(null, { status: 302, headers: { location: target } })
      }) as typeof fetch
      await assert.rejects(
        () => guard().fetch(base)('https://model.example/chat/completions', { method: 'POST', body: '{}' }),
        (error: unknown) => error instanceof EgressBlockedError && error.code === 'egress_blocked',
      )
      assert.equal(calls, 1)
    })
  }
})

test('模型重定向：跨域剥离凭据/referer/origin，返回原域也不恢复', async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = []
  const base = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    seen.push({ url, init })
    if (url === 'https://model.example/start') {
      return new Response(null, { status: 302, headers: { location: 'https://other.example/next' } })
    }
    if (url === 'https://other.example/next') {
      return new Response(null, { status: 302, headers: { location: 'https://model.example/final' } })
    }
    return new Response('ok')
  }) as typeof fetch
  await guard().fetch(base)('https://model.example/start', {
    headers: {
      authorization: 'Bearer secret',
      cookie: 'SESSION=secret',
      'proxy-authorization': 'Basic secret',
      referer: 'https://model.example/start',
      origin: 'https://model.example',
      accept: 'application/json',
    },
  })
  for (const request of seen.slice(1)) {
    for (const name of ['authorization', 'cookie', 'proxy-authorization', 'referer', 'origin']) {
      assert.equal(header(request.init, name), null, `${request.url} leaked ${name}`)
    }
    assert.equal(header(request.init, 'accept'), 'application/json')
  }
})

test('模型重定向：跨域 307/308 不重放 POST 正文', async (t) => {
  for (const status of [307, 308]) {
    await t.test(String(status), async () => {
      let calls = 0
      const base = (async () => {
        calls += 1
        return new Response(null, { status, headers: { location: 'https://other.example/upload' } })
      }) as typeof fetch
      await assert.rejects(
        () => guard().fetch(base)('https://model.example/start', { method: 'POST', body: 'private-prompt' }),
        (error: unknown) => error instanceof EgressBlockedError && /请求体跨域/.test(error.message),
      )
      assert.equal(calls, 1)
    })
  }
})

test('模型 fetch：同源 307/308 manual redirect 不重复 DNS 预检', async (t) => {
  for (const status of [307, 308] as const) {
    await t.test(String(status), async () => {
      let resolutions = 0
      let afterFirstHop: number | undefined
      const seen: string[] = []
      const resolver: DnsResolver = async (_hostname, family) => {
        resolutions += 1
        return family === 4 ? [{ address: '93.184.216.34', family: 4 }] : []
      }
      await withDispatcherConstructor(RecordingAgent, async () => {
        const base = (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          seen.push(url)
          assert.equal(init?.redirect, 'manual')
          const recorder = RecordingAgent.latest
          assert.ok(recorder !== undefined)
          await socketLookup(recorder, new URL(url).hostname, { family: 4 })
          afterFirstHop ??= resolutions
          return url.endsWith('/start')
            ? new Response(null, { status, headers: { location: '/final' } })
            : new Response('ok')
        }) as typeof fetch
        const response = await guard('open', ['model.example'], resolver).fetch(base)(
          'https://model.example/start',
        )
        assert.equal(await response.text(), 'ok')
      })
      assert.deepEqual(seen, ['https://model.example/start', 'https://model.example/final'])
      assert.equal(afterFirstHop, 4, '首跳预检与首次 socket lookup 各解析一次 A/AAAA')
      assert.equal(resolutions, afterFirstHop, '第二跳不得重复 DNS 预检或 socket 解析')
    })
  }
})

test('模型 fetch：新 host 仍解析并固定，返回已固定 host 不重复解析', async () => {
  const calls: Array<[string, 4 | 6]> = []
  const resolver: DnsResolver = async (hostname, family) => {
    calls.push([hostname, family])
    if (family === 6) return []
    return [{ address: hostname === 'model.example' ? '93.184.216.34' : '8.8.8.8', family: 4 }]
  }
  const seen: string[] = []
  await withDispatcherConstructor(RecordingAgent, async () => {
    const base = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      seen.push(url)
      assert.equal(init?.redirect, 'manual')
      const recorder = RecordingAgent.latest
      assert.ok(recorder !== undefined)
      await socketLookup(recorder, new URL(url).hostname, { family: 4 })
      if (url.endsWith('/start')) {
        return new Response(null, { status: 302, headers: { location: 'https://other.example/middle' } })
      }
      if (url.endsWith('/middle')) {
        return new Response(null, { status: 302, headers: { location: 'https://model.example/final' } })
      }
      return new Response('ok')
    }) as typeof fetch
    const response = await guard('open', [], resolver).fetch(base)('https://model.example/start')
    assert.equal(await response.text(), 'ok')
  })
  assert.deepEqual(seen, [
    'https://model.example/start',
    'https://other.example/middle',
    'https://model.example/final',
  ])
  assert.deepEqual(calls, [
    ['model.example', 4], ['model.example', 6],
    ['model.example', 4], ['model.example', 6],
    ['other.example', 4], ['other.example', 6],
    ['other.example', 4], ['other.example', 6],
  ])
})

test('模型重定向：拒绝 HTTPS 降级、循环和超过 5 跳', async (t) => {
  await t.test('降级', async () => {
    const base = (async () => new Response(null, {
      status: 302,
      headers: { location: 'http://model.example/next' },
    })) as typeof fetch
    await assert.rejects(
      () => guard().fetch(base)('https://model.example/start'),
      (error: unknown) => error instanceof EgressBlockedError && /降级/.test(error.message),
    )
  })

  await t.test('循环', async () => {
    let calls = 0
    const base = (async () => {
      calls += 1
      return new Response(null, { status: 302, headers: { location: '/again' } })
    }) as typeof fetch
    await assert.rejects(
      () => guard().fetch(base)('https://model.example/start'),
      (error: unknown) => error instanceof EgressBlockedError && /循环/.test(error.message),
    )
    assert.equal(calls, 2)
  })

  await t.test('跳数上限', async () => {
    let calls = 0
    const base = (async (input: string | URL | Request) => {
      calls += 1
      const url = new URL(String(input))
      const hop = Number(url.pathname.slice(2))
      return new Response(null, { status: 302, headers: { location: `/r${hop + 1}` } })
    }) as typeof fetch
    await assert.rejects(
      () => guard().fetch(base)('https://model.example/r0'),
      (error: unknown) => error instanceof EgressBlockedError && /超过 5 次/.test(error.message),
    )
    assert.equal(calls, 6)
  })
})

test('DNS pinning：并发 lookup 复用 pending，公网重绑定仍返回首次固定地址', async () => {
  const calls: Array<[string, 4 | 6]> = []
  let resolutionRound = 1
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const resolver: DnsResolver = async (hostname, family) => {
    calls.push([hostname, family])
    await gate
    if (family === 4) {
      return [{ address: resolutionRound === 1 ? '93.184.216.34' : '8.8.8.8', family: 4 }]
    }
    return [{ address: resolutionRound === 1
      ? '2606:2800:220:1:248:1893:25c8:1946'
      : '2001:4860:4860::8888', family: 6 }]
  }

  await withRecordingAgent(async (agent, recorder) => {
    agent.remember('public.example', { resolver })
    assert.equal(agent.isPinned('PUBLIC.example'), false)
    const firstLookup = socketLookup(recorder, 'PUBLIC.example', { family: 4 })
    const concurrentLookup = socketLookup(recorder, 'public.example', { all: true })
    release?.()
    const [first, concurrent] = await Promise.all([firstLookup, concurrentLookup])
    assert.equal(agent.isPinned('public.example'), true)
    assert.deepEqual(first, [{ address: '93.184.216.34', family: 4 }])
    assert.deepEqual(concurrent, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ])

    resolutionRound = 2
    const later = await socketLookup(recorder, 'public.example', { all: true })
    assert.deepEqual(later, concurrent, '后续连接必须复用首次 A/AAAA，即使 resolver 已返回其他公网地址')
  })
  assert.deepEqual(calls, [['public.example', 4], ['public.example', 6]])
})

test('DNS pinning：策略变严时重新校验固定 values，且不重新解析', async () => {
  const calls: Array<[string, 4 | 6]> = []
  const resolver: DnsResolver = async (hostname, family) => {
    calls.push([hostname, family])
    return family === 4 ? [{ address: '127.0.0.1', family: 4 }] : []
  }
  await withRecordingAgent(async (agent, recorder) => {
    agent.remember('strict.example', { resolver, allowPrivateEndpoint: true })
    assert.deepEqual(await socketLookup(recorder, 'strict.example'), [{ address: '127.0.0.1', family: 4 }])
    assert.equal(agent.isPinned('strict.example'), true)

    agent.remember('strict.example', { resolver, purpose: 'model', mode: 'manual' })
    await assert.rejects(
      () => socketLookup(recorder, 'strict.example'),
      (error: unknown) => error instanceof EgressBlockedError && /私网/.test(error.message),
    )
    assert.equal(agent.isPinned('strict.example'), true, '策略拒绝不能抹掉已成功固定的地址')
  })
  assert.deepEqual(calls, [['strict.example', 4], ['strict.example', 6]])
})

test('DNS pinning：Agent 不可用或 hostname 未注册时 fail-closed', async () => {
  await withDispatcherConstructor(undefined, async () => {
    await assert.rejects(
      () => PinnedDnsAgent.create('blocked.example'),
      (error: unknown) => error instanceof EgressBlockedError && /不提供可固定 DNS/.test(error.message),
    )
  })
  await withRecordingAgent(async (agent, recorder) => {
    assert.equal(agent.isPinned('unregistered.example'), false)
    await assert.rejects(
      () => socketLookup(recorder, 'unregistered.example'),
      (error: unknown) => error instanceof Error
        && (error as NodeJS.ErrnoException).code === 'ENOTFOUND'
        && /没有为/.test(error.message),
    )
  })
})

test('DNS rebinding：同一 hostname 第二次连接仍连首次固定地址，策略变严后拒绝', async (t) => {
  let firstHits = 0
  let reboundHits = 0
  let resolutions = 0
  const first = createServer((_request, response) => {
    firstHits += 1
    response.setHeader('connection', 'close')
    response.end('pinned-first')
  })
  const rebound = createServer((_request, response) => {
    reboundHits += 1
    response.setHeader('connection', 'close')
    response.end('rebound-second')
  })
  t.after(() => {
    first.closeAllConnections()
    rebound.closeAllConnections()
    first.close()
    rebound.close()
  })
  await listen(rebound, '127.0.0.2', 0)
  const address = rebound.address()
  assert.ok(address !== null && typeof address !== 'string')
  await listen(first, '127.0.0.1', address.port)

  const agent = await PinnedDnsAgent.create()
  t.after(() => agent.close())
  assert.equal(agent.pinned, true, 'Node 内置 fetch 应提供可复用的 Undici Agent')
  const resolver: DnsResolver = async (_hostname, family) => {
    resolutions += 1
    if (family === 6) return []
    return [{ address: resolutions === 1 ? '127.0.0.1' : '127.0.0.2', family: 4 }]
  }
  agent.remember('rebind.test', { allowPrivateEndpoint: true, resolver })
  for (const path of ['/first', '/second']) {
    const response: Response = await fetch(`http://rebind.test:${address.port}${path}`, {
      dispatcher: agent.dispatcherOption,
    } as RequestInit)
    assert.equal(await response.text(), 'pinned-first')
  }
  assert.equal(resolutions, 2, '首次真实 socket lookup 只解析一次 A/AAAA')
  assert.equal(firstHits, 2)
  assert.equal(reboundHits, 0)

  agent.remember('rebind.test', { resolver })
  await assert.rejects(
    () => fetch(`http://rebind.test:${address.port}/strict`, {
      dispatcher: agent.dispatcherOption,
    } as RequestInit),
    (error: unknown) => {
      const blocked = findCause(error)
      return blocked instanceof EgressBlockedError && /私网/.test(blocked.message)
    },
  )
  assert.equal(resolutions, 2, '严格策略只重校验固定地址，不重新解析')
  assert.equal(firstHits, 2)
  assert.equal(reboundHits, 0)
})

test('DNS rebinding：公网预检后首次 socket lookup 返回私网仍拒绝', async (t) => {
  let hits = 0
  let resolutions = 0
  const server = createServer((_request, response) => {
    hits += 1
    response.end('unexpected')
  })
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  await listen(server, '127.0.0.1', 0)
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')

  const resolver: DnsResolver = async (_hostname, family) => {
    resolutions += 1
    if (family === 6) return []
    return [{ address: resolutions <= 2 ? '93.184.216.34' : '127.0.0.1', family: 4 }]
  }
  await resolveNetworkHost('socket-rebind.test', { resolver })
  const agent = await PinnedDnsAgent.create()
  t.after(() => agent.close())
  agent.remember('socket-rebind.test', { resolver })
  await assert.rejects(
    () => fetch(`http://socket-rebind.test:${address.port}/`, {
      dispatcher: agent.dispatcherOption,
    } as RequestInit),
    (error: unknown) => {
      const blocked = findCause(error)
      return blocked instanceof EgressBlockedError && /私网/.test(blocked.message)
    },
  )
  assert.equal(resolutions, 4, '预检与首次 socket lookup 各解析一次 A/AAAA')
  assert.equal(hits, 0, '重绑定后的本机服务不能收到请求')
  assert.equal(agent.isPinned('socket-rebind.test'), false, '失败的首次 socket lookup 不能标记为已固定')
})

test('DNS pinning：同源 307/308 重开连接不重新解析', async (t) => {
  for (const status of [307, 308] as const) {
    await t.test(String(status), async (child) => {
      let firstHits = 0
      let reboundHits = 0
      let resolutions = 0
      const first = createServer((request, response) => {
        firstHits += 1
        response.setHeader('connection', 'close')
        if (request.url === '/start') {
          response.writeHead(status, { location: '/final' })
          response.end()
          return
        }
        response.end('pinned-first')
      })
      const rebound = createServer((_request, response) => {
        reboundHits += 1
        response.setHeader('connection', 'close')
        response.end('rebound-second')
      })
      child.after(() => {
        first.closeAllConnections()
        rebound.closeAllConnections()
        first.close()
        rebound.close()
      })
      await listen(rebound, '127.0.0.2', 0)
      const address = rebound.address()
      assert.ok(address !== null && typeof address !== 'string')
      await listen(first, '127.0.0.1', address.port)

      const agent = await PinnedDnsAgent.create()
      child.after(() => agent.close())
      const resolver: DnsResolver = async (_hostname, family) => {
        resolutions += 1
        if (family === 6) return []
        return [{ address: resolutions === 1 ? '127.0.0.1' : '127.0.0.2', family: 4 }]
      }
      agent.remember('redirect.test', { allowPrivateEndpoint: true, resolver })
      const response = await fetch(`http://redirect.test:${address.port}/start`, {
        redirect: 'follow',
        dispatcher: agent.dispatcherOption,
      } as RequestInit)
      assert.equal(await response.text(), 'pinned-first')
      assert.equal(resolutions, 2, '同源重定向的新连接必须复用首次 A/AAAA')
      assert.equal(firstHits, 2)
      assert.equal(reboundHits, 0)
    })
  }
})

test('平台 HTTP rebinding：预检公网、建连私网在 socket 前被拒绝', async (t) => {
  let hits = 0
  let resolutions = 0
  const server = createServer((_request, response) => {
    hits += 1
    response.end('unexpected')
  })
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  await listen(server, '127.0.0.1', 0)
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')

  const resolver: DnsResolver = async (_hostname, family) => {
    resolutions += 1
    if (family === 6) return []
    return resolutions <= 2
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }]
  }
  await assert.rejects(
    () => new HttpClient({ retries: 0, timeoutMs: 1_000, resolver })
      .request(`http://rebind.example:${address.port}/`),
    (error: unknown) => error instanceof PlatformError && error.code === 'egress_blocked',
  )
  assert.equal(resolutions, 4, '预检与首次 socket lookup 各解析一次 A/AAAA')
  assert.equal(hits, 0, '重绑定后的本机服务不能收到请求')
})

function listen(server: Server, hostname: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, hostname, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

test('模型 fetch：DNS 解析期间取消不会发出请求', async () => {
  const controller = new AbortController()
  let calls = 0
  const resolver: DnsResolver = async () => {
    controller.abort()
    return [{ address: '93.184.216.34', family: 4 }]
  }
  const base = (async () => {
    calls += 1
    return new Response('unexpected')
  }) as typeof fetch
  await assert.rejects(
    () => guard('open', [], resolver).fetch(base)('https://model.example/start', { signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
  assert.equal(calls, 0)
})
