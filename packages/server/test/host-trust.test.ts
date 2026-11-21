/**
 * The Host fence, in both directions.
 *
 * The engine's seven routes sit behind `isTrustedRequest`, which compares the
 * request's `Host` against a list the *server* supplies. Until that list was
 * supplied, the engine fell back to loopback names — so a deployment bound to
 * `0.0.0.0` served its page and accepted a login, then answered 403 to the first
 * settings read. The page looked broken, and the documented remote-access path was
 * unusable.
 *
 * These tests pin both halves of the fix:
 *
 *   1. The list is derived from configuration and never from the request. A name
 *      the operator did not declare is refused, which is what closes DNS
 *      rebinding (`evil.example` resolving to 127.0.0.1 still sends
 *      `Host: evil.example`).
 *   2. A declared name is *admitted by the fence* — the answer becomes 401 (no
 *      session) instead of 403, and 200 once a session exists. Asserting the
 *      status code rather than "not 403" is deliberate: "admitted but broken"
 *      must fail too.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startServer, trustedHostsFor, LOOPBACK_HOSTS } from '../src/app.ts'

interface RawResponse {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
}

/**
 * Send a request with an arbitrary `Host` header.
 *
 * `fetch` cannot do this — it derives `Host` from the URL and forbids overriding
 * it — so the only way to reproduce "the browser reached us under a LAN name" is
 * the low-level client.
 */
function send(options: {
  readonly port: number
  readonly path: string
  readonly host: string
  readonly method?: string
  readonly cookie?: string
  readonly body?: unknown
}): Promise<RawResponse> {
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), 'utf8')
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: {
          host: options.host,
          ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': String(payload.length) }),
        },
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
        })
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

test('可信主机名单由绑定地址与显式配置推导，永不包含未声明的内网地址', () => {
  const loopbackOnly = trustedHostsFor('127.0.0.1', {})
  for (const name of LOOPBACK_HOSTS) assert.ok(loopbackOnly.includes(name), `缺少环回名 ${name}`)
  assert.ok(loopbackOnly.includes('127.0.0.1'))

  // A wildcard bind says "some address of this machine", not which name the
  // browser will use. Enumerating interfaces would guess; guessing is what the
  // fence exists to prevent.
  const wildcard = trustedHostsFor('0.0.0.0', {})
  assert.deepEqual([...wildcard].sort(), [...LOOPBACK_HOSTS].sort(), '0.0.0.0 只应信任环回名')

  const explicit = trustedHostsFor('0.0.0.0', { AI_DEBATE_TRUSTED_HOSTS: ' 192.168.1.20 , debate.example.com ,' })
  assert.ok(explicit.includes('192.168.1.20'))
  assert.ok(explicit.includes('debate.example.com'))
  assert.ok(!explicit.includes(''), '空项不应进入名单')

  const bound = trustedHostsFor('192.168.1.20', {})
  assert.ok(bound.includes('192.168.1.20'))
  assert.ok(!bound.includes('0.0.0.0'))
})

test('未声明的 Host 被拒，声明的 Host 放行到会话判定', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-host-'))
  const running = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    version: '0.0.0-test',
    scheduleBackups: false,
    trustedHosts: [...LOOPBACK_HOSTS, 'debate.example.com'],
  })
  try {
    const port = running.port
    const settingsPath = '/api/ai-debate/settings'

    const undeclared = await send({ port, path: settingsPath, host: `evil.example:${port}` })
    assert.equal(undeclared.status, 403, '未在名单里的 Host 必须 403，否则 DNS rebinding 防线就没了')
    assert.match(undeclared.body, /forbidden/)

    const declared = await send({ port, path: settingsPath, host: `debate.example.com:${port}` })
    assert.equal(declared.status, 401, '声明过的 Host 应进入会话判定（401），而不是被围栏挡住（403）')

    const loopback = await send({ port, path: settingsPath, host: `127.0.0.1:${port}` })
    assert.equal(loopback.status, 401)

    // A declared Host still is not a local browser: without the one-time token it
    // must not be able to initialise the administrator account.
    const remoteSetup = await send({
      port,
      path: '/api/ai-debate/auth/setup',
      host: `debate.example.com:${port}`,
      method: 'POST',
      body: { username: 'owner', password: 'host-trust-pass-2026' },
    })
    assert.equal(remoteSetup.status, 403)

    // Initialise over loopback, then use that session through the declared name
    // to prove the Host fence admits it and leaves the decision to authentication.
    const setup = await send({
      port,
      path: '/api/ai-debate/auth/setup',
      host: `127.0.0.1:${port}`,
      method: 'POST',
      body: { username: 'owner', password: 'host-trust-pass-2026' },
    })
    assert.equal(setup.status, 200, setup.body)
    const raw = setup.headers['set-cookie']
    const cookie = String(Array.isArray(raw) ? raw[0] : raw ?? '').split(';')[0]
    assert.ok(cookie.length > 0, '登录应返回会话 Cookie')

    const read = await send({ port, path: settingsPath, host: `debate.example.com:${port}`, cookie })
    assert.equal(read.status, 200, read.body)
    const view = JSON.parse(read.body) as { values?: Record<string, unknown>; server?: Record<string, unknown> }
    assert.equal(typeof view.values, 'object')

    // The process facts come from `appServer.info()`; without it the page has no
    // way to say which port and data directory it is looking at.
    assert.equal(typeof view.server, 'object', '设置页应带 appServer.info() 提供的进程事实')
    assert.equal(view.server?.port, port)
    assert.equal(view.server?.dataDir, dir)
    assert.equal(view.server?.version, '0.0.0-test')
    assert.equal(view.server?.pid, process.pid)
  } finally {
    await running.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
