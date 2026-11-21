/** Production startup must migrate identities before automation can run. */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type RunningServer } from '../src/app.ts'
import { layoutOf } from '../src/paths.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const USERNAME = 'migration-owner'
const PASSWORD = 'migration-pass-2026'

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

function hash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function fixture(t: TestContext): { root: string; tasksFile: string; identityFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'ai-debate-startup-migration-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = layoutOf(root)
  writeJson(layout.monitorsFile, {
    version: 2,
    monitors: [{
      id: 'legacy-monitor',
      name: '旧监控',
      platform: 'tieba',
      url: 'https://tieba.baidu.com/p/123',
      threadId: '123',
      enabled: false,
      intervalSec: 300,
      createdAt: NOW,
      updatedAt: NOW,
      platformState: 'healthy',
      seen: ['111', '222', '333'],
      cursor: { fingerprints: { '111': 'fp-111', '222': 'fp-222', '333': 'fp-333' } },
      counters: { discovered: 3, analyzed: 1, candidates: 2, failures: 0, day: '2026-01-01', todayDiscovered: 3, todayCandidates: 2, todayFailures: 0 },
    }],
  })
  writeJson(layout.autoTasksFile, {
    version: 2,
    paused: true,
    tasks: [{
      id: 'legacy-review',
      kind: 'generate',
      monitorId: 'legacy-monitor',
      postId: '333',
      dedupeKey: 'generate:legacy-monitor:333',
      state: 'needs_review',
      attempts: 1,
      maxAttempts: 3,
      createdAt: NOW,
      updatedAt: NOW,
      nextRunAt: NOW,
      logs: [],
    }],
  })
  writeJson(join(root, 'state.json'), {
    version: 1,
    sessions: [{
      id: 'legacy-session',
      platform: 'tieba',
      threadId: '123',
      candidates: [
        { replyId: 'candidate-222', targetPostId: '222' },
        { replyId: 'candidate-333', targetPostId: '333' },
      ],
    }],
    dedupe: [],
  })
  return { root, tasksFile: layout.autoTasksFile, identityFile: layout.identitiesFile }
}

async function boot(root: string): Promise<RunningServer> {
  return startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: root,
    version: '0.0.0-startup-test',
    logLevel: 'error',
    scheduleBackups: false,
    monitorTickMs: 60_000,
  })
}

async function stop(running: RunningServer | undefined): Promise<void> {
  await running?.close()
}

async function authenticate(running: RunningServer): Promise<string> {
  const base = `http://127.0.0.1:${running.port}`
  const setup = await fetch(`${base}/api/ai-debate/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  })
  assert.equal(setup.status, 200, await setup.text())
  const login = await fetch(`${base}/api/ai-debate/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  })
  assert.equal(login.status, 200, await login.text())
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
  assert.ok(cookie)
  return cookie as string
}

test('启动集成：旧候选/活跃任务/seen 在引擎启动前迁移，二次启动幂等', async (t) => {
  const item = fixture(t)
  let running: RunningServer | undefined
  try {
    running = await boot(item.root)
    assert.equal(running.mounted, true, running.mountError)
    assert.equal(running.automationDisabled, undefined)
    assert.equal(existsSync(item.identityFile), true)
    const identityDocument = readJson<{
      entries: Array<{ postId: string; state: string }>
      migration: { state: string; completedAt: string; sources: Record<string, string | null> }
    }>(item.identityFile)
    assert.equal(identityDocument.migration.state, 'complete')
    const identities = identityDocument.entries
    assert.equal(identities.find((entry) => entry.postId === '222')?.state, 'candidate')
    assert.equal(identities.find((entry) => entry.postId === '333')?.state, 'candidate')
    assert.equal(identities.find((entry) => entry.postId === '111')?.state, 'ignored')
    assert.equal(identities.some((entry) => entry.state === 'claimed'), false)
    const tasks = readJson<{ tasks: Array<{ identityKey?: string }> }>(item.tasksFile).tasks
    assert.equal(tasks[0]?.identityKey, 'stable:tieba:123:333')
    const identityHash = hash(item.identityFile)
    const taskHash = hash(item.tasksFile)

    const health = await fetch(`http://127.0.0.1:${running.port}/healthz`)
    assert.equal(health.status, 200)
    await stop(running)
    running = await boot(item.root)
    assert.equal(running.automationDisabled, undefined)
    assert.equal(hash(item.identityFile), identityHash)
    assert.equal(hash(item.tasksFile), taskHash)
  } finally {
    await stop(running)
  }
})

test('启动集成：身份与任务键齐全时跳过迁移，不读取后来损坏的 state.json', async (t) => {
  const item = fixture(t)
  let running: RunningServer | undefined
  try {
    running = await boot(item.root)
    assert.equal(running.automationDisabled, undefined)
    const identityHash = hash(item.identityFile)
    await stop(running)
    running = undefined
    writeFileSync(join(item.root, 'state.json'), '{broken-after-completion', 'utf8')

    running = await boot(item.root)
    assert.equal(running.mounted, true, running.mountError)
    assert.equal(running.automationDisabled, undefined)
    assert.equal(hash(item.identityFile), identityHash)
  } finally {
    await stop(running)
  }
})

test('启动集成：身份台账不可读时服务仍健康，但自动化熔断且不改写任务', async (t) => {
  const item = fixture(t)
  writeFileSync(item.identityFile, '{"entries":[broken', 'utf8')
  const taskHash = hash(item.tasksFile)
  let running: RunningServer | undefined
  try {
    running = await boot(item.root)
    assert.equal(running.mounted, true, running.mountError)
    assert.match(running.automationDisabled ?? '', /回复身份迁移失败/)
    assert.equal(hash(item.tasksFile), taskHash, '熔断前不得回填或改写任务台账')
    const health = await fetch(`http://127.0.0.1:${running.port}/healthz`)
    assert.equal(health.status, 200, '迁移失败不应让健康检查进程直接消失')

    const cookie = await authenticate(running)
    const manual = await fetch(`http://127.0.0.1:${running.port}/api/ai-debate/workbench?sessionId=legacy-session`, {
      headers: { cookie, origin: `http://127.0.0.1:${running.port}` },
    })
    assert.equal(manual.status, 503, '迁移未完成时不得开放会绕过身份栅栏的手工分析流程')
    const status = await fetch(`http://127.0.0.1:${running.port}/api/ai-debate/automation/status`, {
      headers: { cookie, origin: `http://127.0.0.1:${running.port}` },
    })
    assert.equal(status.status, 200)
    const body = await status.json() as {
      running: boolean
      identityMigrationError: string
      loadErrors: string[]
    }
    assert.equal(body.running, false)
    assert.match(body.identityMigrationError, /回复身份迁移失败/)
    assert.ok(body.loadErrors.some((entry) => entry.includes('回复身份迁移失败')))
  } finally {
    await stop(running)
  }
})

test('启动集成：身份台账从备份恢复但未落盘时熔断，不覆盖较新备份', async (t) => {
  const item = fixture(t)
  const backup = `${item.identityFile}.bak`
  writeJson(backup, {
    version: 1,
    entries: [{
      key: 'stable:tieba:123:999',
      platform: 'tieba',
      threadId: '123',
      postId: '999',
      quality: 'stable',
      fingerprint: 'newer-evidence',
      monitorId: 'legacy-monitor',
      state: 'candidate',
      candidateId: 'newer-candidate',
      sessionId: 'legacy-session',
      createdAt: NOW,
      updatedAt: NOW,
    }],
    migration: {
      state: 'complete',
      completedAt: NOW,
      sources: { state: null, monitors: null, tasks: null },
    },
  })
  writeFileSync(item.identityFile, '{broken', 'utf8')
  const backupHash = hash(backup)
  let running: RunningServer | undefined
  try {
    running = await boot(item.root)
    assert.equal(running.mounted, true, running.mountError)
    assert.match(running.automationDisabled ?? '', /备份恢复后尚未落盘/)
    assert.equal(hash(backup), backupHash)
  } finally {
    await stop(running)
  }
})

test('启动集成：监控源台账损坏时同样熔断，不以空身份台账启动', async (t) => {
  const item = fixture(t)
  const layout = layoutOf(item.root)
  writeFileSync(layout.monitorsFile, '{"monitors":[broken', 'utf8')
  let running: RunningServer | undefined
  try {
    running = await boot(item.root)
    assert.equal(running.mounted, true, running.mountError)
    assert.match(running.automationDisabled ?? '', /监控配置无法解析/)
    assert.equal(existsSync(item.identityFile), false)
  } finally {
    await stop(running)
  }
})
