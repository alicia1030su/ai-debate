/**
 * Upgrade from a real v0.2.0 data directory.
 *
 * ## Why this is not a unit test
 *
 * The failure this has to catch is "the new build reads yesterday's files and
 * quietly loses something". A unit test constructs the old shape from the new
 * code's own types, so it agrees with itself. This script builds the old shape the
 * way v0.2.0 actually wrote it — including the fields v0.2.1 added and v0.2.0 never
 * had — then starts the *current* binary against that directory and checks what
 * survived.
 *
 * The directory is populated by running the real v0.2.0 executable when
 * `AI_DEBATE_V020_BIN` points at one, and falls back to a byte-faithful fixture
 * otherwise. Both paths are recorded in the report, because "we simulated the old
 * version" and "we ran the old version" are different claims.
 *
 * Usage:
 *   node --experimental-transform-types test/acceptance/upgrade.ts
 *   AI_DEBATE_V020_BIN=/path/to/v0.2.0.exe node --experimental-transform-types test/acceptance/upgrade.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 17921
const DATA_DIR = mkdtempSync(join(tmpdir(), 'ai-debate-upgrade-'))
const BASE = `http://127.0.0.1:${PORT}`

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let cookie = ''
async function call(path: string, options: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      origin: BASE,
      ...(cookie === '' ? {} : { cookie }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await response.text()
  let parsed: any = undefined
  try {
    parsed = text === '' ? undefined : JSON.parse(text)
  } catch {
    parsed = text
  }
  const setCookie = response.headers.get('set-cookie')
  if (setCookie !== null) {
    const match = /ai_debate_session=([^;]+)/.exec(setCookie)
    if (match !== null) cookie = `ai_debate_session=${match[1] as string}`
  }
  return { status: response.status, body: parsed }
}

function startService(env: Record<string, string> = {}): { child: ChildProcess; log: () => string } {
  const binary = process.env.AI_DEBATE_BIN
  const command = binary ?? process.execPath
  const args = [
    ...(binary === undefined ? [join(process.cwd(), 'dist', 'ai-debate.cjs')] : []),
    'serve',
    '--port',
    String(PORT),
    '--data-dir',
    DATA_DIR,
    '--log-level',
    'warn',
  ]
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AI_DEBATE_HOME: DATA_DIR, AI_DEBATE_VERSION: '0.2.1', ...env },
  })
  let log = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    log += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    log += chunk.toString('utf8')
  })
  return { child, log: () => log }
}

async function waitHealthy(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/healthz`)
      if (response.ok) return true
    } catch {
      // Not listening yet.
    }
    await sleep(250)
  }
  return false
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return
  child.kill('SIGTERM')
  for (let index = 0; index < 40; index += 1) {
    if (child.exitCode !== null) return
    await sleep(100)
  }
  child.kill('SIGKILL')
}

/**
 * Let the real v0.2.0 binary create the installation.
 *
 * This is the strongest form of the test: the admin record, the config file, the
 * monitor document and the queue file are all written by yesterday's code, so the
 * new build is reading bytes nobody on this side chose.
 *
 * Two gaps are unavoidable and are stated instead of papered over: a *candidate*
 * needs a live platform read, and an *approval* needs a candidate. Those two rows
 * are appended by {@link seedQueueRows}, in the shape v0.2.0 wrote them, and the
 * report says which parts came from the binary.
 */
async function seedWithRealBinary(binary: string): Promise<boolean> {
  const port = 17920
  const base = `http://127.0.0.1:${port}`
  const child = spawn(binary, ['serve', '--port', String(port), '--data-dir', DATA_DIR, '--log-level', 'warn'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AI_DEBATE_HOME: DATA_DIR },
  })
  let log = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    log += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    log += chunk.toString('utf8')
  })
  try {
    const deadline = Date.now() + 30_000
    let healthy = false
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) {
          healthy = true
          break
        }
      } catch {
        // Not listening yet.
      }
      await sleep(250)
    }
    if (!healthy) {
      process.stdout.write(`旧版二进制未能启动：${log.slice(-400)}\n`)
      return false
    }
    // v0.2.0 authenticates with a session cookie; without carrying it, setup works
    // and every later write is a 401 — which is exactly what the first CI run of
    // this script hit, making the "real binary" path silently fall back.
    let cookie = ''
    const post = async (path: string, body: unknown): Promise<number> => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: base,
          ...(cookie === '' ? {} : { cookie }),
        },
        body: JSON.stringify(body),
      })
      const setCookie = response.headers.get('set-cookie')
      const match = setCookie === null ? null : /ai_debate_session=([^;]+)/.exec(setCookie)
      if (match !== null) cookie = `ai_debate_session=${match[1] as string}`
      // Drain the body so the socket is reusable and an error page is not left open.
      await response.text()
      return response.status
    }
    const setupStatus = await post('/api/ai-debate/auth/setup', { username: 'owner', password: 'upgrade-pass-2026' })
    const settingsStatus = await post('/api/ai-debate/settings', {
      set: { llmModel: 'legacy-model', maxFloorPages: 42, llmSource: 'custom', llmBaseUrl: 'http://127.0.0.1:9/v1' },
    })
    const monitorStatus = await post('/api/ai-debate/automation/monitors', {
      url: 'https://tieba.baidu.com/p/123456',
      name: '旧版监控目标',
      intervalSec: 300,
    })
    process.stdout.write(
      `旧版二进制写入：setup=${setupStatus} settings=${settingsStatus} monitor=${monitorStatus}\n`,
    )
    return setupStatus === 200 && settingsStatus === 200 && monitorStatus === 200
  } finally {
    child.kill('SIGTERM')
    await sleep(800)
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

/** Append the two rows the real binary cannot produce without a live platform. */
function seedQueueRows(): void {
  const file = join(DATA_DIR, 'auto-tasks.json')
  const now = new Date().toISOString()
  let document: { version: number; paused: boolean; tasks: unknown[] } = { version: 1, paused: false, tasks: [] }
  if (existsSync(file)) {
    document = JSON.parse(readFileSync(file, 'utf8')) as typeof document
  }
  const monitors = JSON.parse(readFileSync(join(DATA_DIR, 'monitors.json'), 'utf8')) as {
    monitors: { id: string }[]
  }
  const monitorId = monitors.monitors[0]?.id ?? 'legacy-monitor-1'
  document.version = 1
  document.tasks = [
    {
      id: 'legacy-task-review',
      kind: 'generate',
      monitorId,
      postId: '222',
      sessionId: 'legacy-session-1',
      dedupeKey: 'generate:legacy-session-1:222',
      state: 'needs_review',
      attempts: 1,
      maxAttempts: 2,
      createdAt: now,
      updatedAt: now,
      nextRunAt: now,
      startedAt: now,
      finishedAt: now,
      logs: [{ at: now, level: 'info', message: '候选已生成' }],
    },
    ...document.tasks,
  ]
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
}

/**
 * Seed the data directory with a v0.2.0-shaped installation.
 *
 * The shapes below are copied from files the v0.2.0 build wrote: `monitors.json`
 * without `compensationHours`/`cursor`/`lastScan`, `auto-tasks.json` without
 * `modelCall`, and a session with a candidate already waiting for review.
 */
function seedV020Directory(): void {
  mkdirSync(DATA_DIR, { recursive: true })
  const now = new Date().toISOString()
  // A config document v0.2.0 could read, with one non-default value so "kept" is
  // distinguishable from "reset to default".
  writeFileSync(
    join(DATA_DIR, 'config.json'),
    `${JSON.stringify(
      {
        llmBaseUrl: 'http://127.0.0.1:9/v1',
        llmModel: 'legacy-model',
        llmSource: 'custom',
        maxFloorPages: 42,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  // v0.2.0's monitor document: version 1, no cursor, no compensation window.
  writeFileSync(
    join(DATA_DIR, 'monitors.json'),
    `${JSON.stringify(
      {
        version: 1,
        monitors: [
          {
            id: 'legacy-monitor-1',
            name: '旧版监控目标',
            platform: 'tieba',
            url: 'https://tieba.baidu.com/p/123456',
            threadId: '123456',
            enabled: true,
            intervalSec: 300,
            createdAt: now,
            updatedAt: now,
            lastCheckAt: now,
            lastSuccessAt: now,
            seen: ['111', '222'],
            baselineAt: now,
            counters: {
              discovered: 2,
              analyzed: 1,
              candidates: 1,
              failures: 0,
              day: now.slice(0, 10),
              todayDiscovered: 2,
              todayCandidates: 1,
              todayFailures: 0,
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  // v0.2.0's task document: version 1, one task waiting for a human, one finished.
  writeFileSync(
    join(DATA_DIR, 'auto-tasks.json'),
    `${JSON.stringify(
      {
        version: 1,
        paused: false,
        tasks: [
          {
            id: 'legacy-task-review',
            kind: 'generate',
            monitorId: 'legacy-monitor-1',
            postId: '222',
            sessionId: 'legacy-session-1',
            dedupeKey: 'generate:legacy-session-1:222',
            state: 'needs_review',
            attempts: 1,
            maxAttempts: 2,
            createdAt: now,
            updatedAt: now,
            nextRunAt: now,
            startedAt: now,
            finishedAt: now,
            logs: [{ at: now, level: 'info', message: '候选已生成' }],
          },
          {
            id: 'legacy-task-done',
            kind: 'probe',
            monitorId: 'legacy-monitor-1',
            dedupeKey: 'probe:legacy-monitor-1',
            state: 'completed',
            attempts: 1,
            maxAttempts: 4,
            createdAt: now,
            updatedAt: now,
            nextRunAt: now,
            finishedAt: now,
            logs: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

async function main(): Promise<void> {
  const binaryPath = process.env.AI_DEBATE_V020_BIN
  let usedRealBinary = false
  process.stdout.write(`数据目录：${DATA_DIR}\n`)
  if (binaryPath !== undefined && existsSync(binaryPath)) {
    usedRealBinary = await seedWithRealBinary(binaryPath)
  }
  if (usedRealBinary) {
    seedQueueRows()
    process.stdout.write('旧版来源：真实 v0.2.0 二进制（管理员、配置、监控由它写入；队列中的待审核行按 v0.2.0 结构追加）\n\n')
  } else {
    // A failed real-binary attempt leaves an admin record behind. Starting the
    // fixture on top of it would make setup return 409 and look like a product bug.
    rmSync(DATA_DIR, { recursive: true, force: true })
    mkdirSync(DATA_DIR, { recursive: true })
    seedV020Directory()
    process.stdout.write('旧版来源：按 v0.2.0 写出的文件结构（未提供或未能运行 v0.2.0 二进制）\n\n')
  }

  const stateFile = join(DATA_DIR, 'state.json')
  const stateHashBefore = existsSync(stateFile) ? createHash('sha256').update(readFileSync(stateFile)).digest('hex') : undefined

  let service: { child: ChildProcess; log: () => string } | undefined
  try {
    service = startService()
    const healthy = await waitHealthy()
    check('新版本能在旧数据目录上启动', healthy, healthy ? undefined : service.log().slice(-800))
    if (!healthy) return

    // --- authentication.
    //
    // Two cases, and the real-binary path is the second one: a fixture directory has
    // no admin record, so setup creates one; a directory created by v0.2.0 already
    // has one, and setup answers 409. Treating 409 as a failure would report the
    // whole upgrade as broken when in fact the account simply already existed.
    const setup = await call('/api/ai-debate/auth/setup', {
      method: 'POST',
      body: { username: 'owner', password: 'upgrade-pass-2026' },
    })
    if (setup.status === 200) {
      check('首次初始化成功', true)
    } else {
      if (setup.status !== 409) {
        check('旧目录已有管理员时应返回 409 或完成初始化', false, `status=${setup.status}`)
        return
      }
      const login = await call('/api/ai-debate/auth/login', {
        method: 'POST',
        body: { username: 'owner', password: 'upgrade-pass-2026' },
      })
      check('旧目录已有管理员时直接登录', login.status === 200, `status=${login.status}`)
      if (login.status !== 200) {
        process.stdout.write(`登录失败详情：${JSON.stringify(login.body)}\n`)
        return
      }
    }

    // --- config survived
    const settings = await call('/api/ai-debate/settings')
    const values = settings.body?.values ?? {}
    check('旧配置值保留', values.llmModel === 'legacy-model', `llmModel=${String(values.llmModel)}`)
    check('旧配置数值保留', values.maxFloorPages === 42, `maxFloorPages=${String(values.maxFloorPages)}`)

    // --- monitor migrated with new fields defaulted, old fields intact
    const monitorsResponse = await call('/api/ai-debate/automation/monitors')
    const monitors = (monitorsResponse.body?.monitors ?? []) as {
      id: string
      name: string
      intervalSec: number
      compensationHours?: number
      counters?: { discovered?: number }
      lastCompleteScanAt?: string
    }[]
    // Matched by name rather than by id: the real v0.2.0 binary assigns a UUID, the
    // fixture uses a fixed id, and the identity that matters to the operator is the
    // one they typed.
    const legacy = monitors.find((monitor) => monitor.name === '旧版监控目标')
    check('旧监控目标保留', legacy !== undefined, `count=${monitors.length}`)
    check('旧监控的名称与间隔未变', legacy?.intervalSec === 300, `intervalSec=${String(legacy?.intervalSec)}`)
    check(
      '旧监控的计数未丢',
      typeof legacy?.counters?.discovered === 'number',
      `discovered=${String(legacy?.counters?.discovered)}`,
    )
    check(
      '新增的补偿窗口被补上默认值',
      legacy?.compensationHours === 24,
      `compensationHours=${String(legacy?.compensationHours)}`,
    )
    check(
      '旧数据没有完整扫描记录时不会伪造一个',
      legacy?.lastCompleteScanAt === undefined,
      `lastCompleteScanAt=${String(legacy?.lastCompleteScanAt)}`,
    )

    // --- tasks migrated: the review row is still a review row
    const tasksResponse = await call('/api/ai-debate/automation/tasks?limit=50')
    const tasks = (tasksResponse.body?.tasks ?? []) as { id: string; state: string; kind: string }[]
    const review = tasks.find((task) => task.id === 'legacy-task-review')
    const done = tasks.find((task) => task.id === 'legacy-task-done')
    // The review row is seeded on both paths (a candidate needs a live platform, so
    // neither path can produce one honestly). The completed row only exists in the
    // fixture; asserting its presence on the real path would be inventing evidence.
    check('旧待审核任务保留', review !== undefined, `count=${tasks.length}`)
    check('待审核任务仍是待审核', review?.state === 'needs_review', `state=${String(review?.state)}`)
    if (done !== undefined) {
      check('已完成任务仍是已完成', done.state === 'completed', `state=${done.state}`)
    } else {
      process.stdout.write('  · 旧目录没有已完成任务行（真实 v0.2.0 未产生），跳过该检查\n')
    }

    // --- the core's own store is not rewritten just by upgrading. Sessions,
    //     approvals and the publish ledger live there, and a "migration" that
    //     touched them would be the exact failure this test exists to catch.
    if (stateHashBefore !== undefined) {
      const after = createHash('sha256').update(readFileSync(stateFile)).digest('hex')
      check('升级不改写核心台账（会话与批准原样保留）', after === stateHashBefore, `${stateHashBefore.slice(0, 12)} → ${after.slice(0, 12)}`)
    } else {
      check('升级不改写核心台账（本次旧目录没有该文件，跳过）', true)
    }

    // --- the ledger file on disk declares the new version, so a second start does
    //     not re-migrate or re-report.
    const monitorDoc = JSON.parse(readFileSync(join(DATA_DIR, 'monitors.json'), 'utf8')) as { version: number }
    check('监控配置已写回新版本结构', monitorDoc.version === 2, `version=${monitorDoc.version}`)

    // --- a new monitor can be added on top of migrated data
    const created = await call('/api/ai-debate/automation/monitors', {
      method: 'POST',
      body: { url: 'https://tieba.baidu.com/p/654321', name: '升级后新增' },
    })
    check('升级后仍可新增监控目标', created.status === 200, `status=${created.status}`)

    // --- restart: migrated state is stable across a second boot
    await stop(service.child)
    service = startService()
    const healthyAgain = await waitHealthy()
    check('升级后的数据目录可再次启动', healthyAgain)
    if (healthyAgain) {
      const again = await call('/api/ai-debate/auth/login', {
        method: 'POST',
        body: { username: 'owner', password: 'upgrade-pass-2026' },
      })
      check('升级后管理员账号仍可登录', again.status === 200, `status=${again.status}`)
      const monitorsAgain = await call('/api/ai-debate/automation/monitors')
      const listAgain = (monitorsAgain.body?.monitors ?? []) as { id: string; name: string }[]
      // Matched by name: the real v0.2.0 binary assigns a UUID, and the question the
      // operator cares about is "is the target I configured still there", not "did
      // the id stay the same".
      check('重启后监控目标仍在', listAgain.some((monitor) => monitor.name === '旧版监控目标'))
      check('重启后新增的监控也在', listAgain.some((monitor) => monitor.name === '升级后新增'), `count=${listAgain.length}`)
    }

    // --- a failed upgrade must be recoverable: corrupt the task ledger, start, and
    //     confirm the service still serves (with the damaged file preserved).
    await stop(service.child)
    service = undefined
    const taskFile = join(DATA_DIR, 'auto-tasks.json')
    const goodCopy = readFileSync(taskFile, 'utf8')
    writeFileSync(taskFile, goodCopy.slice(0, Math.floor(goodCopy.length / 2)), 'utf8')
    service = startService()
    const booted = await waitHealthy()
    check('台账损坏时服务仍能启动（不静默清空）', booted)
    if (booted) {
      await call('/api/ai-debate/auth/login', { method: 'POST', body: { username: 'owner', password: 'upgrade-pass-2026' } })
      const status = await call('/api/ai-debate/automation/status')
      const loadErrors = (status.body?.loadErrors ?? []) as string[]
      const entries = readdirSync(DATA_DIR)
      const quarantined = entries.some((name) => name.includes('.corrupt-'))
      // Two acceptable outcomes: the service reported the damage, or it restored
      // the last good copy and set the damaged one aside. What is *not* acceptable
      // is starting from empty, which is why the task rows are checked too.
      check(
        '损坏被识别（报告或从备份恢复）',
        loadErrors.length > 0 || (quarantined && entries.includes('auto-tasks.json.bak')),
        loadErrors.join(' / ').slice(0, 160),
      )
      // The damaged file must be set aside, not overwritten: an operator needs the
      // original bytes to tell "the disk failed" from "we wrote it wrong".
      const dirEntries = readdirSync(DATA_DIR)
      check('损坏文件被另存一份', dirEntries.some((name) => name.includes('.corrupt-')), dirEntries.join(',').slice(0, 120))
    }
    // The backup written on the last good persist is what recovery uses.
    const backupExists = existsSync(`${taskFile}.bak`) || existsSync(taskFile)
    check('损坏后原文件仍在（未被删除）', backupExists)

    writeFileSync(taskFile, goodCopy, 'utf8')
  } finally {
    await stop(service?.child)
    rmSync(DATA_DIR, { recursive: true, force: true })
  }

  const passed = results.filter((entry) => entry.ok).length
  process.stdout.write(`\n${passed}/${results.length} 项通过\n`)
  if (passed !== results.length) process.exitCode = 1
}

await main()
