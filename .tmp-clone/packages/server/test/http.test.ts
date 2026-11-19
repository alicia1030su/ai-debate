/**
 * The HTTP surface, exercised over a real socket.
 *
 * Every assertion here is one of the product's promises about its own front door:
 *
 *   - `/healthz` answers without a session, because the launcher and systemd poll
 *     it before any administrator exists.
 *   - Every business route requires a session, and says 401 rather than 404 —
 *     a route that hides itself also hides that the install is working.
 *   - A cross-site request is refused even when it carries a valid cookie, which
 *     is the layer SameSite cannot provide on its own.
 *   - A browser form's `text/plain` body is refused before any handler sees it.
 *   - A missing route is 404 JSON, not an HTML error page a fetch caller would
 *     fail to parse.
 *
 * The settings route itself belongs to the engine; this file cares about the fence
 * in front of it, so a 200 from `/settings` means "the fence admitted a session",
 * not "the engine's view was correct" — the engine's own 112 tests cover that.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startServer } from '../src/app.ts'

const PASSWORD = 'http-surface-pass-2026'

test('前端门禁：健康检查免认证，业务接口需会话，跨站写入被拒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-http-'))
  const running = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    version: '0.0.0-test',
    scheduleBackups: false,
  })
  const base = `http://127.0.0.1:${running.port}`
  try {
    // 1. Health is unauthenticated and carries the security headers.
    const health = await fetch(`${base}/healthz`)
    assert.equal(health.status, 200)
    const healthBody = (await health.json()) as { ok?: boolean; version?: string }
    assert.equal(healthBody.ok, true)
    assert.equal(healthBody.version, '0.0.0-test')
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(health.headers.get('x-frame-options'), 'DENY')
    assert.match(String(health.headers.get('content-security-policy')), /default-src 'self'/)
    assert.match(String(health.headers.get('content-security-policy')), /style-src 'self' 'unsafe-inline'/)

    // 2. Every business route is closed until a session exists. The engine's own
    //    routes are included on purpose: their fence is the adapter's `connection`
    //    service, so this is also the only test that proves that wiring.
    for (const path of [
      '/api/ai-debate/settings',
      '/api/ai-debate/status',
      '/api/ai-debate/workbench',
      '/api/ai-debate/system/status',
      '/api/ai-debate/jobs',
    ]) {
      const response = await fetch(`${base}${path}`)
      assert.equal(response.status, 401, `${path} 未登录时必须 401`)
    }

    // 3. An unauthenticated read must not leak whether an administrator exists.
    const state = await fetch(`${base}/api/ai-debate/auth/state`)
    assert.equal(state.status, 200)
    const stateBody = (await state.json()) as Record<string, unknown>
    assert.equal(stateBody.initialized, false)
    assert.equal(stateBody.authenticated, false)
    assert.equal(stateBody.username, undefined)

    // 4. Setup, then the same routes answer.
    const setup = await fetch(`${base}/api/ai-debate/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'owner', password: PASSWORD }),
    })
    assert.equal(setup.status, 200)
    const rawCookie = setup.headers.get('set-cookie') ?? ''
    const cookie = rawCookie.split(';')[0] ?? ''
    assert.match(rawCookie, /HttpOnly/i)
    assert.match(rawCookie, /SameSite=Strict/i)
    assert.ok(cookie.startsWith('ai_debate_session='), rawCookie)

    const settings = await fetch(`${base}/api/ai-debate/settings`, { headers: { cookie } })
    assert.equal(settings.status, 200)
    const view = (await settings.json()) as { values?: Record<string, unknown> }
    assert.equal(typeof view.values, 'object')

    const system = await fetch(`${base}/api/ai-debate/system/status`, { headers: { cookie } })
    assert.equal(system.status, 200)
    const systemBody = (await system.json()) as { server?: Record<string, unknown>; queue?: Record<string, unknown> }
    assert.equal(typeof systemBody.server, 'object')
    assert.equal(systemBody.server?.dataDir, dir)
    assert.equal(typeof systemBody.queue, 'object')

    const jobs = await fetch(`${base}/api/ai-debate/jobs`, { headers: { cookie } })
    assert.equal(jobs.status, 200)

    // The queue switch is authenticated like every other operator route. It used
    // to be unreachable: the route existed but the prefix fence did not include it,
    // so pausing answered 404 — a control that silently does nothing is worse than
    // no control, because the operator believes background work stopped.
    const pause = await fetch(`${base}/api/ai-debate/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: JSON.stringify({ action: 'pause' }),
    })
    assert.equal(pause.status, 200)
    assert.equal(((await pause.json()) as { paused?: boolean }).paused, true)
    const pausedView = (await (await fetch(`${base}/api/ai-debate/jobs`, { headers: { cookie } })).json()) as {
      paused?: boolean
    }
    assert.equal(pausedView.paused, true)
    const resume = await fetch(`${base}/api/ai-debate/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: JSON.stringify({ action: 'resume' }),
    })
    assert.equal(resume.status, 200)
    assert.equal(((await resume.json()) as { paused?: boolean }).paused, false)

    // 5. Cross-site writes are refused even with a valid cookie. `SameSite=Strict`
    //    already blocks the browser from sending one, so this is the second lock —
    //    it must hold on its own for the case where a fork relaxes the cookie.
    const crossSite = await fetch(`${base}/api/ai-debate/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example', cookie },
      body: JSON.stringify({ set: {} }),
    })
    assert.equal(crossSite.status, 403)

    // 6. A cross-site form cannot send `application/json`; refusing the body type
    //    is what makes that structural rather than a browser behaviour to hope for.
    const formBody = await fetch(`${base}/api/ai-debate/settings`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie },
      body: 'set=1',
    })
    assert.equal(formBody.status, 415)

    // 7. A same-origin write still works — otherwise the fence would be a wall.
    const write = await fetch(`${base}/api/ai-debate/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: JSON.stringify({ set: { maxLength: 200 } }),
    })
    assert.equal(write.status, 200)
    const after = (await (await fetch(`${base}/api/ai-debate/settings`, { headers: { cookie } })).json()) as {
      values?: Record<string, unknown>
    }
    assert.equal(after.values?.maxLength, 200)

    // 8. Unknown paths are JSON 404s: the console's fetch helper parses JSON and
    //    an HTML body would surface as "unexpected token '<'".
    const missing = await fetch(`${base}/api/ai-debate/nope`, { headers: { cookie } })
    assert.equal(missing.status, 404)
    assert.match(String(missing.headers.get('content-type')), /application\/json/)
    assert.equal(((await missing.json()) as { error?: string }).error, 'not found')

    // 9. Logout revokes the session on the next request.
    const logout = await fetch(`${base}/api/ai-debate/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: '{}',
    })
    assert.equal(logout.status, 200)
    const revoked = await fetch(`${base}/api/ai-debate/settings`, { headers: { cookie } })
    assert.equal(revoked.status, 401)
  } finally {
    await running.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
