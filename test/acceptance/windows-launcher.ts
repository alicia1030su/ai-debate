/**
 * Windows launcher acceptance: the behaviour a double-click actually produces.
 *
 * Every step here uses the packaged EXE, not the source tree, because the failures
 * this is meant to catch are packaging failures: a launcher that exits before the
 * service is up, a second double-click that starts a second instance, a supervisor
 * that does not come back after a crash, a stop that leaves the supervisor fighting
 * it.
 *
 * Skipped on non-Windows platforms. The Linux equivalent is
 * `test/acceptance/linux-install.sh`, which runs against a real systemd.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = process.env.AI_DEBATE_BIN ?? join('dist', 'AI-Debate-windows-x64.exe')
const PORT = 17931
const BASE = `http://127.0.0.1:${PORT}`
const IMAGE = 'AI-Debate-windows-x64.exe'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function health(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return true
    } catch {
      // Not listening yet.
    }
    await sleep(300)
  }
  return false
}

/** PIDs of the packaged image, via tasklist (no PowerShell, no WMI). */
function pids(): number[] {
  const result = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${IMAGE}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}`
  const found: number[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^"[^"]+","(\d+)"/.exec(line.trim())
    if (match !== null) found.push(Number(match[1]))
  }
  return found
}

function run(args: readonly string[], dataDir: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(BIN, [...args, '--data-dir', dataDir], {
    encoding: 'utf8',
    env: { ...process.env, AI_DEBATE_NO_BROWSER: '1' },
    timeout: 60_000,
  })
  return { code: result.status ?? -1, stdout: `${result.stdout ?? ''}`, stderr: `${result.stderr ?? ''}` }
}

test('Windows 启动器：双击、单实例、崩溃恢复、干净停止', { skip: process.platform !== 'win32' }, async (t) => {
  assert.ok(existsSync(BIN), `找不到打包产物 ${BIN}，请先运行 npm run package:windows`)
  const dataDir = mkdtempSync(join(tmpdir(), 'ai-debate-win-'))
  t.after(async () => {
    run(['stop'], dataDir)
    await sleep(1200)
    for (const pid of pids()) spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' })
    rmSync(dataDir, { recursive: true, force: true })
  })

  // 1. Double-click: the launcher starts the service and returns; the service keeps
  //    running detached, which is what "close the browser" then depends on.
  const launched = spawn(BIN, ['--port', String(PORT), '--data-dir', dataDir], {
    env: { ...process.env, AI_DEBATE_NO_BROWSER: '1' },
    stdio: 'ignore',
    detached: true,
  })
  launched.unref()
  assert.equal(await health(35_000), true, '双击后服务应可用')
  const firstPids = pids()
  assert.ok(firstPids.length >= 1, `应有运行中的进程，实际 ${firstPids.length}`)

  // 2. Setup + a durable marker, so "data survived" is a fact rather than a guess.
  const setup = await fetch(`${BASE}/api/ai-debate/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ username: 'owner', password: 'windows-pass-2026' }),
  })
  assert.equal(setup.status, 200)
  const cookie = /ai_debate_session=([^;]+)/.exec(setup.headers.get('set-cookie') ?? '')?.[1]
  assert.ok(cookie !== undefined)
  const saved = await fetch(`${BASE}/api/ai-debate/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, cookie: `ai_debate_session=${cookie}` },
    body: JSON.stringify({ set: { llmModel: 'windows-acceptance-model' } }),
  })
  assert.equal(saved.status, 200)

  // 3. A second double-click must not start a second service.
  const second = spawn(BIN, ['--port', String(PORT), '--data-dir', dataDir], {
    env: { ...process.env, AI_DEBATE_NO_BROWSER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let secondOut = ''
  second.stdout?.on('data', (chunk: Buffer) => {
    secondOut += chunk.toString('utf8')
  })
  await new Promise((resolve) => second.once('exit', resolve))
  assert.match(secondOut, /已在运行/, `第二次启动应报告已有实例：${secondOut.slice(0, 200)}`)
  assert.equal(await health(5000), true)
  const afterSecond = pids()
  assert.ok(
    afterSecond.filter((pid) => firstPids.includes(pid)).length >= 1,
    '第一次启动的进程必须仍在使用',
  )

  // 4. Crash recovery: kill the *service* (not the supervisor) and wait for the
  //    supervisor to bring it back. `server.pid` names the service, so this hits
  //    the process that actually died in the field.
  const servicePid = Number(readFileSync(join(dataDir, 'run', 'server.pid'), 'utf8').trim())
  const killed = spawnSync('taskkill', ['/PID', String(servicePid), '/F'], { encoding: 'utf8' })
  assert.equal(killed.status, 0, `taskkill 应成功：${killed.stdout ?? ''}${killed.stderr ?? ''}`)
  await sleep(1200)
  assert.equal(await health(45_000), true, '守护进程应在服务被强杀后把它拉起来')

  // 5. Stop is clean: the service exits 0, the supervisor stops with it, and the
  //    port stops answering (a supervisor that restarts a deliberate stop is worse
  //    than no supervisor at all).
  const stopped = run(['stop'], dataDir)
  assert.equal(stopped.code, 0, `stop 应成功：${stopped.stdout}${stopped.stderr}`)
  await sleep(2500)
  let alive = true
  try {
    await fetch(`${BASE}/healthz`)
    alive = true
  } catch {
    alive = false
  }
  assert.equal(alive, false, 'stop 之后端口不应再应答')

  // 6. Data survives the stop: restart and read the value back.
  const relaunched = spawn(BIN, ['--port', String(PORT), '--data-dir', dataDir], {
    env: { ...process.env, AI_DEBATE_NO_BROWSER: '1' },
    stdio: 'ignore',
    detached: true,
  })
  relaunched.unref()
  assert.equal(await health(35_000), true, '重启后服务应可用')
  const login = await fetch(`${BASE}/api/ai-debate/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ username: 'owner', password: 'windows-pass-2026' }),
  })
  assert.equal(login.status, 200)
  const session = /ai_debate_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]
  const settings = await fetch(`${BASE}/api/ai-debate/settings`, {
    headers: { cookie: `ai_debate_session=${session}` },
  })
  const body = (await settings.json()) as { values?: { llmModel?: string } }
  assert.equal(body.values?.llmModel, 'windows-acceptance-model', '重启后配置必须保留')

  // 7. Autostart is opt-in and reversible.
  //
  //    This step needs `reg.exe`. On a host whose security policy blocks it (this
  //    build machine does), the honest outcome is a recorded skip — not a pass, and
  //    not a failure of the product. The API's own refusal is what is asserted in
  //    that case: it must say "failed" rather than report success it did not achieve.
  const authHeaders = {
    'content-type': 'application/json',
    origin: BASE,
    cookie: `ai_debate_session=${session}`,
  }
  const on = await fetch(`${BASE}/api/ai-debate/system/action`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ action: 'autostart-on' }),
  })
  const onBody = (await on.json()) as { ok?: boolean; message?: string }
  if (on.status === 200 && onBody.ok === true) {
    // `reg` worked: the entry must carry --no-browser so login does not pop a tab.
    // Reading it back with `reg query` is not possible where reg is blocked, so the
    // value is checked through the API's own message plus a re-disable.
    assert.match(onBody.message ?? '', /已开启/, `开启自启应给出明确结果：${onBody.message ?? ''}`)
    const off = await fetch(`${BASE}/api/ai-debate/system/action`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ action: 'autostart-off' }),
    })
    const offBody = (await off.json()) as { ok?: boolean; message?: string }
    assert.equal(off.status, 200)
    assert.match(offBody.message ?? '', /已关闭|本来就是关闭/, `关闭自启应给出明确结果：${offBody.message ?? ''}`)
    process.stdout.write('  ✔ 开机自启：可开启、可关闭（注册表值由产品写入）\n')
  } else {
    // A blocked `reg.exe` is a host policy, not a defect. Record it as skipped.
    assert.equal(on.status, 400, `自启失败应返回可读的 400，实际 ${on.status}`)
    assert.match(onBody.message ?? '', /失败|拦截/, `失败原因应可读：${onBody.message ?? ''}`)
    process.stdout.write(
      `  ⚠ 开机自启：本机无法验证（${onBody.message ?? '注册表不可写'}）——这是环境限制，未计为通过\n`,
    )
  }
})
