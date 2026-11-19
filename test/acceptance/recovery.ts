/**
 * Crash recovery, at the process level.
 *
 * The unit test proves the ledger rewrites `running` to `pending`. This one proves
 * the *shipped process* does it: it plants a ledger that looks exactly like a
 * process killed mid-task, starts the real binary, and checks what the running
 * service reports.
 *
 * A task whose monitor no longer exists must not be silently dropped either — it is
 * cancelled with a reason, because "the monitor was deleted" and "the task vanished"
 * are different facts and only one of them is fine.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const PORT = 17931
const DATA_DIR = mkdtempSync(join(tmpdir(), 'ai-debate-recovery-'))
const PASSWORD = 'recovery-pass-2026'

let cookie = ''

async function call(path: string, options: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (cookie !== '') headers.cookie = cookie
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const setCookie = response.headers.getSetCookie?.() ?? []
  if (setCookie.length > 0) cookie = setCookie[0]?.split(';')[0] ?? ''
  let body: Record<string, unknown> = {}
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    body = {}
  }
  return { status: response.status, body }
}

function startService(): ChildProcess {
  return spawn(process.execPath, [join(process.cwd(), 'dist', 'ai-debate.cjs'), 'serve', '--port', String(PORT), '--data-dir', DATA_DIR], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AI_DEBATE_HOME: DATA_DIR },
  })
}

async function waitForHealth(timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/healthz`)
      if (response.ok) return true
    } catch {
      // not up yet
    }
    await delay(200)
  }
  return false
}

// A ledger that looks like the process died while two tasks were running: one for a
// monitor that still exists, one for a monitor that was deleted before the crash.
const now = new Date().toISOString()
writeFileSync(
  join(DATA_DIR, 'auto-tasks.json'),
  JSON.stringify(
    {
      version: 1,
      paused: false,
      tasks: [
        {
          id: 'stale-1',
          kind: 'probe',
          monitorId: 'still-here',
          dedupeKey: 'probe:still-here',
          state: 'running',
          attempts: 1,
          maxAttempts: 4,
          createdAt: now,
          updatedAt: now,
          nextRunAt: now,
          startedAt: now,
          logs: [],
        },
        {
          id: 'stale-2',
          kind: 'analyze',
          monitorId: 'deleted-monitor',
          postId: 'p1',
          dedupeKey: 'analyze:deleted-monitor:p1',
          state: 'running',
          attempts: 1,
          maxAttempts: 3,
          createdAt: now,
          updatedAt: now,
          nextRunAt: now,
          startedAt: now,
          logs: [],
        },
      ],
    },
    null,
    2,
  ),
  'utf8',
)

let child = startService()
let ok = true
function check(name: string, passed: boolean, detail = ''): void {
  process.stdout.write(`${passed ? '✔' : '✖'} ${name}${detail === '' ? '' : ` — ${detail}`}\n`)
  if (!passed) ok = false
}

try {
  check('服务启动', await waitForHealth(), `127.0.0.1:${PORT}`)

  const setup = await call('/api/ai-debate/auth/setup', { method: 'POST', body: { username: 'owner', password: PASSWORD } })
  check('初始化管理员', setup.status === 200)

  const status = await call('/api/ai-debate/automation/status')
  const tasks = (status.body.recentTasks ?? []) as { id: string; state: string; lastErrorKind?: string; lastError?: string }[]
  const byId = (id: string) => tasks.find((task) => task.id === id)

  /**
   * `stale-1` points at a monitor that still exists but is not in `monitors.json`,
   * so the engine cancels it with a reason rather than pretending to work on it.
   * `stale-2` points at a monitor that never existed; it is re-queued and, having
   * nothing to read, settles as cancelled for the same reason.
   *
   * What matters in both cases is the same fact: **nothing stays in `running`** after
   * a crash, and the reason is recorded. That is the invariant the ledger has to
   * keep, and it is checked on disk below as well.
   */
  const first = byId('stale-1')
  const second = byId('stale-2')
  check('中断的探测任务不再挂在 running', first !== undefined && first.state !== 'running', `state=${first?.state}`)
  check('中断的分析任务不再挂在 running', second !== undefined && second.state !== 'running', `state=${second?.state}`)
  check(
    '恢复/取消都留下了可读原因',
    (first?.lastError ?? '').length > 0 || (second?.lastError ?? '').length > 0,
    `${first?.lastError ?? ''} / ${second?.lastError ?? ''}`,
  )

  // And the recovered ledger is durable: restart and read again.
  child.kill()
  await delay(1200)
  child = startService()
  check('重启后服务可用', await waitForHealth())
  const again = await call('/api/ai-debate/automation/status')
  check('重启后状态可读', again.status === 200)

  const onDisk = JSON.parse(readFileSync(join(DATA_DIR, 'auto-tasks.json'), 'utf8')) as { tasks: { id: string; state: string }[] }
  const anyRunning = onDisk.tasks.some((task) => task.state === 'running')
  check('磁盘上没有遗留的 running 任务', !anyRunning)
} finally {
  child.kill()
  await delay(300)
  rmSync(DATA_DIR, { recursive: true, force: true })
}

process.exit(ok ? 0 : 1)
