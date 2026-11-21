/** Corrupt receipt sidecars must degrade safely without poisoning diagnostics. */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { JobQueue } from '../src/jobs.ts'
import { startServer } from '../src/app.ts'
import { layoutOf } from '../src/paths.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }

function fixture(t: TestContext): { root: string; jobsFile: string; receiptFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'ai-debate-receipts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const jobsFile = join(root, 'jobs.json')
  const receiptFile = join(root, 'job-receipts.json')
  return { root, jobsFile, receiptFile }
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'receipt-1',
    type: 'backup.restore',
    state: 'failed',
    attempts: 1,
    maxAttempts: 1,
    payload: {},
    createdAt: NOW,
    updatedAt: NOW,
    nextRunAt: NOW,
    finishedAt: NOW,
    lastError: 'restore failed',
    logs: [{ at: NOW, level: 'error', message: 'restore failed' }],
    ...overrides,
  }
}

function writeReceipts(file: string, entries: readonly unknown[]): string {
  const raw = `${JSON.stringify({ version: 1, receipts: entries })}\n`
  writeFileSync(file, raw, { encoding: 'utf8', mode: 0o600 })
  return raw
}

async function load(item: { jobsFile: string; receiptFile: string }): Promise<JobQueue> {
  const queue = new JobQueue({ file: item.jobsFile, receiptFile: item.receiptFile, log: quiet })
  queue.start()
  return queue
}

function assertPreserved(item: { receiptFile: string }, raw: string): void {
  assert.equal(readFileSync(item.receiptFile, 'utf8'), raw, '非法 receipt 原件不得被覆盖')
  const directory = dirname(item.receiptFile)
  const copies = readdirSync(directory).filter((name) => name.startsWith('job-receipts.json.corrupt-'))
  assert.equal(copies.length, 1, '应保留一份现场副本')
  assert.equal(readFileSync(join(directory, copies[0] as string), 'utf8'), raw)
}

test('receipt：logs/null 与对象 lastError 被拒绝，服务队列继续可用', async (t) => {
  for (const invalid of [receipt({ logs: [null] }), receipt({ lastError: { malformed: true } })]) {
    await t.test(JSON.stringify(invalid.logs), async (child) => {
      const item = fixture(child)
      const raw = writeReceipts(item.receiptFile, [invalid])
      const queue = await load(item)
      try {
        assert.deepEqual(queue.snapshot().jobs, [], '非法 display receipt 不得进入内存')
        assertPreserved(item, raw)
      } finally {
        await queue.stop()
      }
    })
  }
})

test('receipt：日志字段、时间字段与数量上限逐项校验', async (t) => {
  const invalidRows = [
    receipt({ logs: [{ at: NOW, level: 'debug', message: 'x' }] }),
    receipt({ logs: [{ at: 'not-a-date', level: 'info', message: 'x' }] }),
    receipt({ logs: [{ at: NOW, level: 'info', message: 42 }] }),
    receipt({ createdAt: 'not-a-date' }),
    receipt({ attempts: -1 }),
    receipt({ maxAttempts: 0 }),
    receipt({ logs: Array.from({ length: 41 }, () => ({ at: NOW, level: 'info', message: 'x' })) }),
  ]
  for (const [index, invalid] of invalidRows.entries()) {
    await t.test(`case ${index}`, async (child) => {
      const item = fixture(child)
      const raw = writeReceipts(item.receiptFile, [invalid])
      const queue = await load(item)
      try {
        assert.deepEqual(queue.snapshot().jobs, [])
        assertPreserved(item, raw)
      } finally {
        await queue.stop()
      }
    })
  }
})

test('receipt：损坏 JSON 的日志不包含正文片段', async (t) => {
  const item = fixture(t)
  const raw = '{"receipts":[{"message":"TOP-SECRET-RECEIPT-FRAGMENT",broken'
  writeFileSync(item.receiptFile, raw, 'utf8')
  const errors: string[] = []
  const queue = new JobQueue({
    file: item.jobsFile,
    receiptFile: item.receiptFile,
    log: { ...quiet, error: (message) => errors.push(message) },
  })
  queue.start()
  try {
    assert.deepEqual(queue.snapshot().jobs, [])
    assert.equal(errors.some((message) => message.includes('TOP-SECRET-RECEIPT-FRAGMENT')), false)
    assertPreserved(item, raw)
  } finally {
    await queue.stop()
  }
})

test('receipt：超过 2 MiB 的 sidecar 在解析前拒绝并保留现场', async (t) => {
  const item = fixture(t)
  const raw = writeReceipts(item.receiptFile, [receipt({ logs: [{ at: NOW, level: 'info', message: 'x'.repeat(5 * 1024 * 1024) }] })])
  assert.ok(readFileSync(item.receiptFile).length > 2 * 1024 * 1024)
  const queue = await load(item)
  try {
    assert.deepEqual(queue.snapshot().jobs, [])
    assertPreserved(item, raw)
  } finally {
    await queue.stop()
  }
})

test('receipt：合法终态记录仍可加载并覆盖同 id 任务', async (t) => {
  const item = fixture(t)
  writeFileSync(item.jobsFile, JSON.stringify({
    version: 1,
    paused: false,
    jobs: [receipt({ id: 'same', state: 'running', logs: [] })],
  }), 'utf8')
  writeReceipts(item.receiptFile, [receipt({ id: 'same', state: 'succeeded', lastError: undefined })])
  const queue = await load(item)
  try {
    assert.equal(queue.snapshot().jobs[0]?.id, 'same')
    assert.equal(queue.snapshot().jobs[0]?.state, 'succeeded')
  } finally {
    await queue.stop()
  }
})

test('receipt：拒绝写入自身无法通过校验的超长凭证', async (t) => {
  const item = fixture(t)
  const queue = new JobQueue({ file: item.jobsFile, receiptFile: item.receiptFile, log: quiet })
  const job = queue.enqueue({ type: 'backup.restore' }).job
  assert.equal(queue.recordFailedReceipt(job.id, 'x'.repeat(65 * 1024)), false)
  assert.equal(existsSync(item.receiptFile), false)
  await queue.stop()
})

test('receipt：损坏 sidecar 不让管理页 diagnostics 返回 500', async (t) => {
  const item = fixture(t)
  const layout = layoutOf(item.root)
  mkdirSync(layout.runDir, { recursive: true })
  const receiptFile = join(layout.runDir, 'job-receipts.json')
  writeReceipts(receiptFile, [receipt({ logs: [null] })])
  const running = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: item.root,
    version: '0.0.0-receipt-test',
    logLevel: 'error',
    scheduleBackups: false,
    monitorTickMs: 3_600_000,
  })
  try {
    const base = `http://127.0.0.1:${running.port}`
    const setup = await fetch(`${base}/api/ai-debate/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'receipt-owner', password: 'receipt-pass-2026' }),
    })
    assert.equal(setup.status, 200)
    const cookie = setup.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    const diagnostics = await fetch(`${base}/api/ai-debate/diagnostics`, { headers: { cookie } })
    const diagnosticsText = await diagnostics.text()
    assert.equal(diagnostics.status, 200, diagnosticsText)
    const body = JSON.parse(diagnosticsText) as { diagnostics?: { queue?: { jobs?: unknown[] } } }
    assert.deepEqual(body.diagnostics?.queue?.jobs, [])
    assert.equal(existsSync(receiptFile), true)
  } finally {
    await running.close()
  }
})
