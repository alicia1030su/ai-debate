/**
 * The monitoring API, over a real socket.
 *
 * These assertions are about the front door of the new feature, not about the
 * scheduler — the pipeline itself is covered by `test/acceptance/automation.ts`
 * against a scripted platform. What matters here:
 *
 *   - Monitoring spends model calls and touches platforms, so it must be exactly as
 *     authenticated as the settings page. A single unguarded route would be enough
 *     to let anyone with local network access start spending the owner's credits.
 *   - A monitor URL must be refused before it is persisted if it is not a thread on
 *     a registered platform. That is the SSRF fence at the point of entry: the
 *     engine never sees a host it was not told about.
 *   - Every number the page shows comes from the ledger. A fresh install reports
 *     zero, not a plausible-looking placeholder.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startServer } from '../src/app.ts'

const PASSWORD = 'monitor-api-pass-2026'

test('监控接口：未登录一律 401，登录后可管理，非法链接被拒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-monitor-api-'))
  const running = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    version: '0.0.0-test',
    scheduleBackups: false,
    // The scheduler must not fire during this test: it would try to read the real
    // platform behind the URL, which is exactly what a unit test must not do.
    monitorTickMs: 3_600_000,
  })
  const base = `http://127.0.0.1:${running.port}`
  try {
    // 1. Closed until a session exists.
    for (const path of [
      '/api/ai-debate/automation/status',
      '/api/ai-debate/automation/monitors',
      '/api/ai-debate/automation/tasks',
    ]) {
      const response = await fetch(`${base}${path}`)
      assert.equal(response.status, 401, `${path} 未登录时必须 401`)
    }
    const unauthCreate = await fetch(`${base}/api/ai-debate/automation/monitors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ url: 'https://tieba.baidu.com/p/1' }),
    })
    assert.equal(unauthCreate.status, 401)
    const unauthPause = await fetch(`${base}/api/ai-debate/automation/pause`, { method: 'POST' })
    assert.equal(unauthPause.status, 401)

    // 2. A session.
    const setup = await fetch(`${base}/api/ai-debate/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'owner', password: PASSWORD }),
    })
    assert.equal(setup.status, 200)
    const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

    // 3. A fresh install reports zeroes, not placeholders.
    const status = await fetch(`${base}/api/ai-debate/automation/status`, { headers: { cookie } })
    assert.equal(status.status, 200)
    const view = (await status.json()) as {
      monitors?: { total: number; enabled: number }
      tasks?: Record<string, number>
      today?: { discovered: number; candidates: number; failures: number }
      reviews?: unknown[]
      recentTasks?: unknown[]
    }
    assert.equal(view.monitors?.total, 0)
    assert.equal(view.monitors?.enabled, 0)
    assert.deepEqual(view.today, { discovered: 0, candidates: 0, failures: 0 })
    assert.deepEqual(view.reviews, [])
    assert.deepEqual(view.recentTasks, [])

    // 4. A URL that is not a thread on a registered platform is refused. This is
    //    the SSRF fence: the engine only ever reads hosts a provider claimed.
    for (const bad of ['http://127.0.0.1:8080/admin', 'file:///etc/passwd', 'https://evil.example/p/1', 'not a url']) {
      const response = await fetch(`${base}/api/ai-debate/automation/monitors`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, cookie },
        body: JSON.stringify({ name: 'bad', url: bad }),
      })
      assert.equal(response.status, 400, `${bad} 应被拒绝`)
    }
    const emptyList = (await (await fetch(`${base}/api/ai-debate/automation/monitors`, { headers: { cookie } })).json()) as {
      monitors?: unknown[]
    }
    assert.equal(emptyList.monitors?.length, 0, '被拒绝的链接不得留在监控列表里')

    // 5. A legitimate thread URL is accepted, and the duplicate is refused.
    const created = await fetch(`${base}/api/ai-debate/automation/monitors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: JSON.stringify({ name: '验收监控', url: 'https://tieba.baidu.com/p/6826726803', intervalSec: 120 }),
    })
    assert.equal(created.status, 200)
    const createdBody = (await created.json()) as { ok?: boolean; monitor?: { id: string; intervalSec: number; enabled: boolean } }
    assert.equal(createdBody.ok, true)
    assert.equal(createdBody.monitor?.intervalSec, 120)
    assert.equal(createdBody.monitor?.enabled, true)
    const monitorId = createdBody.monitor!.id

    const duplicate = await fetch(`${base}/api/ai-debate/automation/monitors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: JSON.stringify({ url: 'https://tieba.baidu.com/p/6826726803' }),
    })
    assert.equal(duplicate.status, 400, '同一个帖子不应重复监控')

    // 6. Pause / resume / edit / delete round-trip.
    const pause = await fetch(`${base}/api/ai-debate/automation/monitors/${monitorId}/pause`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: '{}',
    })
    assert.equal(pause.status, 200)
    let list = (await (await fetch(`${base}/api/ai-debate/automation/monitors`, { headers: { cookie } })).json()) as {
      monitors?: { id: string; enabled: boolean }[]
    }
    assert.equal(list.monitors?.[0]?.enabled, false)

    const resume = await fetch(`${base}/api/ai-debate/automation/monitors/${monitorId}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: '{}',
    })
    assert.equal(resume.status, 200)
    list = (await (await fetch(`${base}/api/ai-debate/automation/monitors`, { headers: { cookie } })).json()) as {
      monitors?: { id: string; enabled: boolean }[]
    }
    assert.equal(list.monitors?.[0]?.enabled, true)

    const patch = await fetch(`${base}/api/ai-debate/automation/monitors/${monitorId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: JSON.stringify({ intervalSec: 5, name: '改名' }),
    })
    assert.equal(patch.status, 200)
    const patched = (await patch.json()) as { monitor?: { intervalSec: number; name: string } }
    assert.equal(patched.monitor?.intervalSec, 120, '间隔不得低于下限')
    assert.equal(patched.monitor?.name, '改名')

    // 7. Global pause / resume.
    const pauseAll = await fetch(`${base}/api/ai-debate/automation/pause`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: '{}',
    })
    assert.equal(pauseAll.status, 200)
    const pausedStatus = (await (await fetch(`${base}/api/ai-debate/automation/status`, { headers: { cookie } })).json()) as {
      paused?: boolean
    }
    assert.equal(pausedStatus.paused, true)
    const resumeAll = await fetch(`${base}/api/ai-debate/automation/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: '{}',
    })
    assert.equal(resumeAll.status, 200)

    // 8. Cross-site writes are refused here too.
    const crossSite = await fetch(`${base}/api/ai-debate/automation/monitors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example', cookie },
      body: JSON.stringify({ url: 'https://tieba.baidu.com/p/1' }),
    })
    assert.equal(crossSite.status, 403)

    // 9. There is no publish endpoint here, and there must not be one: the whole
    //    product decision is that a background task ends at `needs_review`.
    for (const path of ['/api/ai-debate/automation/publish', '/api/ai-debate/automation/approve']) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, cookie },
        body: JSON.stringify({ sessionId: 'x', candidateId: 'y' }),
      })
      assert.equal(response.status, 404, `${path} 不应存在：后台不允许发表`)
    }

    // 10. Delete.
    const removed = await fetch(`${base}/api/ai-debate/automation/monitors/${monitorId}`, {
      method: 'DELETE',
      headers: { origin: base, cookie },
    })
    assert.equal(removed.status, 200)
    const after = (await (await fetch(`${base}/api/ai-debate/automation/monitors`, { headers: { cookie } })).json()) as {
      monitors?: unknown[]
    }
    assert.equal(after.monitors?.length, 0)
  } finally {
    await running.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
