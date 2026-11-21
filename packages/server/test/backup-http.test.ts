/** Production wiring for the backup centre, exercised over a real HTTP socket. */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type RunningServer, type StartOptions } from '../src/app.ts'
import { writeJson } from '../src/atomic.ts'
import { CredentialStore } from '../src/credential-store.ts'
import { MonitorStore } from '../src/monitor/store.ts'
import { AutoTaskStore } from '../src/monitor/tasks.ts'
import { layoutOf } from '../src/paths.ts'
import { JobQueue } from '../src/jobs.ts'
import type { BackupManifest } from '../src/backup.ts'

const PASSWORD = 'backup-http-pass-2026'
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }

interface Harness {
  readonly dir: string
  readonly running: RunningServer
  readonly base: string
  readonly cookie: string
  readonly exitCodes: number[]
  readonly exited: Promise<number>
}

async function harness(
  t: TestContext,
  options: { secureCookies?: boolean; seed?: (dir: string) => void | Promise<void> } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-backup-http-'))
  await options.seed?.(dir)
  const exitCodes: number[] = []
  let resolveExit: (code: number) => void = () => undefined
  const exited = new Promise<number>((resolve) => { resolveExit = resolve })
  const startOptions: StartOptions = {
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    version: '0.2.2-test',
    logLevel: 'error',
    scheduleBackups: false,
    monitorTickMs: 60_000,
    restartDelayMs: 0,
    exitProcess: (code: number): void => {
      exitCodes.push(code)
      resolveExit(code)
    },
    ...(options.secureCookies === undefined ? {} : { secureCookies: options.secureCookies }),
  }
  const running = await startServer(startOptions)
  t.after(async () => {
    await running.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${running.port}`
  const setup = await fetch(`${base}/api/ai-debate/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'owner', password: PASSWORD }),
  })
  assert.equal(setup.status, 200)
  const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  assert.ok(cookie.startsWith('ai_debate_session='))
  if (options.secureCookies === true) assert.match(setup.headers.get('set-cookie') ?? '', /Secure/i)
  if (options.secureCookies === false) assert.doesNotMatch(setup.headers.get('set-cookie') ?? '', /Secure/i)
  return { dir, running, base, cookie, exitCodes, exited }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('等待条件超时')
}

async function waitJob(base: string, cookie: string, jobId: string, state: string): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined
  await waitFor(async () => {
    const response = await fetch(`${base}/api/ai-debate/jobs`, { headers: { cookie } })
    assert.equal(response.status, 200)
    const body = (await response.json()) as { jobs?: Record<string, unknown>[] }
    found = body.jobs?.find((job) => job.id === jobId)
    return found?.state === state
  })
  assert.ok(found !== undefined)
  return found
}

async function enqueue(base: string, cookie: string, type: string, key: string): Promise<string> {
  const response = await fetch(`${base}/api/ai-debate/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie },
    body: JSON.stringify({ type, key }),
  })
  assert.equal(response.status, 200)
  return ((await response.json()) as { job: { id: string } }).job.id
}

test('HTTP 备份全链路：创建→列表→校验→恢复，旧队列不得覆盖 jobs.json', async (t) => {
  const h = await harness(t, {
    secureCookies: false,
    seed: (dir): void => {
      writeJson(join(dir, 'config.json'), { version: 1, maxLength: 200, debate: { rounds: 3 } })
    },
  })
  const layout = layoutOf(h.dir)

  const firstJob = await enqueue(h.base, h.cookie, 'storage.check', 'before-backup')
  await waitJob(h.base, h.cookie, firstJob, 'succeeded')

  const createResponse = await fetch(`${h.base}/api/ai-debate/backups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.base, cookie: h.cookie },
    body: JSON.stringify({ kind: 'manual' }),
  })
  assert.equal(createResponse.status, 202)
  const created = (await createResponse.json()) as { jobId: string; message?: string }
  assert.match(created.message ?? '', /已排队/)
  await waitJob(h.base, h.cookie, created.jobId, 'succeeded')

  const listResponse = await fetch(`${h.base}/api/ai-debate/backups`, { headers: { cookie: h.cookie } })
  assert.equal(listResponse.status, 200)
  const listed = (await listResponse.json()) as { backups: { name: string; kind: string; valid: boolean }[] }
  const backup = listed.backups.find((entry) => entry.kind === 'manual' && entry.valid)
  assert.ok(backup !== undefined)
  const summary = (await (await fetch(`${h.base}/api/ai-debate/automation/status`, { headers: { cookie: h.cookie } })).json()) as {
    backups: { total: number; manual: number; latest: { name: string; bytes: number } | null }
  }
  assert.equal(summary.backups.total, 1)
  assert.equal(summary.backups.manual, 1)
  assert.equal(summary.backups.latest?.name, backup.name)
  assert.ok((summary.backups.latest?.bytes ?? 0) > 0)

  const verifyResponse = await fetch(`${h.base}/api/ai-debate/backups/${backup.name}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.base, cookie: h.cookie },
    body: '{}',
  })
  assert.equal(verifyResponse.status, 200)
  assert.deepEqual((await verifyResponse.json()) as { valid?: boolean }, { ok: true, valid: true, message: '备份校验通过。' })

  const backupJobs = readFileSync(join(layout.backupsDir, backup.name, 'jobs.json'))
  const originalConfig = readFileSync(join(layout.backupsDir, backup.name, 'config.json'))
  const settings = await fetch(`${h.base}/api/ai-debate/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.base, cookie: h.cookie },
    body: JSON.stringify({ set: { maxLength: 999 } }),
  })
  assert.equal(settings.status, 200)
  const secondJob = await enqueue(h.base, h.cookie, 'storage.check', 'after-backup')
  await waitJob(h.base, h.cookie, secondJob, 'succeeded')
  assert.notDeepEqual(readFileSync(layout.jobsFile), backupJobs)

  const restoreResponse = await fetch(`${h.base}/api/ai-debate/backups/${backup.name}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.base, cookie: h.cookie },
    body: JSON.stringify({ confirmed: true }),
  })
  assert.equal(restoreResponse.status, 202)
  const restoreJobId = ((await restoreResponse.json()) as { jobId: string }).jobId
  assert.equal(await h.exited, 75)
  assert.deepEqual(h.exitCodes, [75])
  assert.deepEqual(readFileSync(layout.configFile), originalConfig)
  assert.deepEqual(readFileSync(layout.jobsFile), backupJobs, 'restore 后不得被旧队列 finally/stop 回写')
  const manifest = JSON.parse(readFileSync(join(layout.backupsDir, backup.name, 'manifest.json'), 'utf8')) as BackupManifest
  assert.ok(manifest.restored?.includes('jobs.json') === true)

  const receiptFile = join(layout.runDir, 'job-receipts.json')
  assert.equal(existsSync(receiptFile), true)
  if (process.platform !== 'win32') assert.equal(statSync(receiptFile).mode & 0o777, 0o600)
  const reloaded = new JobQueue({ file: layout.jobsFile, receiptFile, log: quiet })
  reloaded.start()
  try {
    const receipt = reloaded.snapshot().jobs.find((job) => job.id === restoreJobId)
    assert.equal(receipt?.state, 'succeeded')
    assert.equal(receipt?.logs.some((line) => line.message.includes('备份恢复成功')), true)
  } finally {
    await reloaded.stop()
  }
})

test('备份任务类型：自动任务落 daily，运维 API 可创建 weekly', async (t) => {
  const h = await harness(t, {
    seed: (dir): void => writeJson(join(dir, 'config.json'), { version: 1, maxLength: 200 }),
  })
  const auto = await fetch(`${h.base}/api/ai-debate/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.base, cookie: h.cookie },
    body: JSON.stringify({ type: 'backup.create', key: 'auto-backup-test', payload: { auto: true } }),
  })
  assert.equal(auto.status, 200)
  const autoJob = (await auto.json()) as { job: { id: string } }
  await waitJob(h.base, h.cookie, autoJob.job.id, 'succeeded')

  const weekly = await fetch(`${h.base}/api/ai-debate/backups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.base, cookie: h.cookie },
    body: JSON.stringify({ kind: 'weekly' }),
  })
  assert.equal(weekly.status, 202)
  const weeklyJob = (await weekly.json()) as { jobId: string }
  await waitJob(h.base, h.cookie, weeklyJob.jobId, 'succeeded')

  const list = (await (await fetch(`${h.base}/api/ai-debate/backups`, { headers: { cookie: h.cookie } })).json()) as {
    backups: { kind: string; valid: boolean }[]
  }
  assert.equal(list.backups.some((entry) => entry.kind === 'daily' && entry.valid), true)
  assert.equal(list.backups.some((entry) => entry.kind === 'weekly' && entry.valid), true)
  assert.equal(list.backups.some((entry) => entry.kind === 'manual'), false)
})

test('HTTP 安全与诊断：会话/跨站/control 边界、Secure Cookie、无秘密诊断', async (t) => {
  const secret = 'diagnostic-secret-value-123456'
  const h = await harness(t, {
    secureCookies: true,
    seed: async (dir): Promise<void> => {
      writeJson(join(dir, 'config.json'), { version: 1, maxLength: 200 })
      const credentials = new CredentialStore({ file: join(dir, 'credentials.json'), keyFile: join(dir, 'credentials.key'), log: quiet })
      credentials.load()
      await credentials.set('AI_DEBATE_TEST_TOKEN', secret)
      const monitors = new MonitorStore({ file: join(dir, 'monitors.json'), log: quiet })
      monitors.load()
      monitors.create(
        { name: 'disabled-monitor', url: 'https://tieba.baidu.com/p/1234567890', enabled: false },
        { platform: 'tieba', threadId: '1234567890' },
      )
      const tasks = new AutoTaskStore({ file: join(dir, 'auto-tasks.json'), log: quiet })
      tasks.load()
      tasks.enqueue({ kind: 'analyze', monitorId: 'missing-monitor', dedupeKey: 'recovery-test' })
      const document = JSON.parse(readFileSync(join(dir, 'auto-tasks.json'), 'utf8')) as {
        paused: boolean
        tasks: { state: string; modelCall?: { startedAt: string; uncertain: boolean } }[]
      }
      document.paused = true
      document.tasks[0]!.state = 'running'
      document.tasks[0]!.modelCall = { startedAt: new Date().toISOString(), uncertain: true }
      writeJson(join(dir, 'auto-tasks.json'), document)
    },
  })

  for (const path of ['/api/ai-debate/backups', '/api/ai-debate/diagnostics']) {
    assert.equal((await fetch(`${h.base}${path}`)).status, 401)
  }
  const crossSite = await fetch(`${h.base}/api/ai-debate/backups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example', cookie: h.cookie },
    body: JSON.stringify({ kind: 'manual' }),
  })
  assert.equal(crossSite.status, 403)

  const controlToken = (JSON.parse(readFileSync(join(h.dir, 'run', 'control.json'), 'utf8')) as { token: string }).token
  const controlHeaders = { 'x-ai-debate-control': controlToken }
  assert.equal((await fetch(`${h.base}/api/ai-debate/system/status`, { headers: controlHeaders })).status, 200)
  assert.equal((await fetch(`${h.base}/api/ai-debate/backups`, { headers: controlHeaders })).status, 403)
  const controlBackup = await fetch(`${h.base}/api/ai-debate/system/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...controlHeaders },
    body: JSON.stringify({ action: 'backup' }),
  })
  assert.equal(controlBackup.status, 403)

  const diagnosticsResponse = await fetch(`${h.base}/api/ai-debate/diagnostics`, { headers: { cookie: h.cookie } })
  assert.equal(diagnosticsResponse.status, 200)
  const diagnosticsText = await diagnosticsResponse.text()
  for (const hidden of [secret, readFileSync(join(h.dir, 'credentials.key'), 'utf8').trim(), h.cookie, controlToken]) {
    assert.equal(diagnosticsText.includes(hidden), false, '诊断正文不得包含凭据、密钥、会话或控制令牌')
  }
  const diagnostics = JSON.parse(diagnosticsText) as {
    diagnostics: {
      monitors: { platformState: string }[]
      tasks: { uncertain: boolean }[]
      backups: { total: number; invalid: number }
      automation: { recovery: { uncertain: number }; backups: { latest: null | { bytes: number } } }
    }
  }
  assert.equal(diagnostics.diagnostics.monitors[0]?.platformState, 'healthy')
  assert.equal(diagnostics.diagnostics.tasks.some((task) => task.uncertain), true)
  assert.equal(diagnostics.diagnostics.automation.recovery.uncertain, 1)
  assert.equal(diagnostics.diagnostics.backups.total, 0)

  const status = await (await fetch(`${h.base}/api/ai-debate/automation/status`, { headers: { cookie: h.cookie } })).json() as {
    backups: { total: number; daily: number; weekly: number; manual: number; invalid: number }
    recovered: number
    uncertain: number
  }
  assert.equal(status.backups.total, 0)
  assert.equal(status.recovered, 1)
  assert.equal(status.uncertain, 1)

  assert.equal((await fetch(`${h.base}/api/ai-debate/automation/monitors/missing/platform-check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.base, cookie: h.cookie },
    body: '{}',
  })).status, 404)
  assert.equal((await fetch(`${h.base}/api/ai-debate/backups/2026-01-01T00-00-00-000Z/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.base, cookie: h.cookie },
    body: '{}',
  })).status, 400)
  assert.equal((await fetch(`${h.base}/api/ai-debate/backups/2026-01-01T00-00-00-000Z/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.base, cookie: h.cookie },
    body: '{}',
  })).status, 422)
  assert.equal(existsSync(join(h.dir, 'credentials.key')), true)
})

test('恢复失败：回滚 live 文件、引擎与队列恢复运行，receipt 记录失败', async (t) => {
  const h = await harness(t, {
    seed: (dir): void => writeJson(join(dir, 'config.json'), { version: 1, maxLength: 200 }),
  })
  const layout = layoutOf(h.dir)
  const createResponse = await fetch(`${h.base}/api/ai-debate/backups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.base, cookie: h.cookie },
    body: JSON.stringify({ kind: 'manual' }),
  })
  const created = (await createResponse.json()) as { jobId: string }
  await waitJob(h.base, h.cookie, created.jobId, 'succeeded')
  const list = (await (await fetch(`${h.base}/api/ai-debate/backups`, { headers: { cookie: h.cookie } })).json()) as {
    backups: { name: string }[]
  }
  const name = list.backups[0]!.name
  const invalid = Buffer.from('{"version":1,"broken":', 'utf8')
  writeFileSync(join(layout.backupsDir, name, 'config.json'), invalid)
  const manifestPath = join(layout.backupsDir, name, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest
  writeJson(manifestPath, {
    ...manifest,
    files: { ...manifest.files, 'config.json': { sha256: createHash('sha256').update(invalid).digest('hex'), bytes: invalid.length } },
  })
  const liveConfig = readFileSync(layout.configFile)
  const pausedBefore = (JSON.parse(readFileSync(layout.jobsFile, 'utf8')) as { paused: boolean }).paused

  const restore = await fetch(`${h.base}/api/ai-debate/backups/${name}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.base, cookie: h.cookie },
    body: JSON.stringify({ confirmed: true }),
  })
  assert.equal(restore.status, 202)
  const queued = (await restore.json()) as { jobId: string }
  const failed = await waitJob(h.base, h.cookie, queued.jobId, 'failed')
  assert.match(String(failed.lastError ?? ''), /JSON/)
  assert.match(String(failed.lastError ?? ''), /后台引擎已重新启动/)
  assert.match(String(failed.lastError ?? ''), /队列已恢复运行/)
  assert.deepEqual(readFileSync(layout.configFile), liveConfig)
  assert.equal(h.running.queue.snapshot().paused, false)
  assert.equal(h.running.queue.snapshot().persistenceSuspended, false)
  assert.equal((JSON.parse(readFileSync(layout.jobsFile, 'utf8')) as { paused: boolean }).paused, pausedBefore)
  const status = (await (await fetch(`${h.base}/api/ai-debate/automation/status`, { headers: { cookie: h.cookie } })).json()) as {
    running?: boolean
  }
  assert.equal(status.running, true)
  assert.deepEqual(h.exitCodes, [])
  const receipts = JSON.parse(readFileSync(join(layout.runDir, 'job-receipts.json'), 'utf8')) as {
    receipts: { id: string; state: string; logs: { message: string }[] }[]
  }
  const receipt = receipts.receipts.find((item) => item.id === queued.jobId)
  assert.equal(receipt?.state, 'failed')
  assert.equal(receipt?.logs.some((line) => line.message.includes('后台引擎已重新启动')), true)
})

test('恢复成功但 receipt 写入失败：仍退出 75，jobs.json 不被覆盖', async (t) => {
  const h = await harness(t, {
    seed: (dir): void => writeJson(join(dir, 'config.json'), { version: 1, maxLength: 200 }),
  })
  const layout = layoutOf(h.dir)
  const firstJob = await enqueue(h.base, h.cookie, 'storage.check', 'before-receipt-failure')
  await waitJob(h.base, h.cookie, firstJob, 'succeeded')
  const create = await fetch(`${h.base}/api/ai-debate/backups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.base, cookie: h.cookie },
    body: JSON.stringify({ kind: 'manual' }),
  })
  const created = (await create.json()) as { jobId: string }
  await waitJob(h.base, h.cookie, created.jobId, 'succeeded')
  const list = (await (await fetch(`${h.base}/api/ai-debate/backups`, { headers: { cookie: h.cookie } })).json()) as {
    backups: { name: string }[]
  }
  const name = list.backups[0]!.name
  const backupJobs = readFileSync(join(layout.backupsDir, name, 'jobs.json'))
  mkdirSync(join(layout.runDir, 'job-receipts.json'))

  const restore = await fetch(`${h.base}/api/ai-debate/backups/${name}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.base, cookie: h.cookie },
    body: JSON.stringify({ confirmed: true }),
  })
  assert.equal(restore.status, 202)
  assert.equal(await h.exited, 75)
  assert.deepEqual(h.exitCodes, [75])
  assert.deepEqual(readFileSync(layout.jobsFile), backupJobs)
})
