/**
 * The command line, and the desktop launcher.
 *
 * One binary, several behaviours. The launcher (no arguments) is what a
 * double-click runs: reuse a live instance or start one, then open the browser and
 * return. The service keeps running because it is a detached child — closing the
 * browser must not stop the engine.
 *
 * The other subcommands exist so that a user who does not want a browser, or whose
 * browser did not open, still has a way in: `status`, `logs`, `stop`, `restart`.
 * `stop` and `restart` authenticate with a control token from the data directory
 * rather than a password, because they are issued from a shell that already has
 * access to that directory.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { startServer, setAutostart } from './app.ts'
import { clearInstance, pidAlive, readInstance, type InstanceRecord } from './instance.ts'
import { layoutOf, resolveDataDir } from './paths.ts'
import type { LogLevel } from './logger.ts'

interface Parsed {
  readonly command: string
  readonly flags: Record<string, string | true>
  readonly rest: readonly string[]
}

const DEFAULT_PORT = 17860
const DEFAULT_HOST = '127.0.0.1'

function parse(argv: readonly string[]): Parsed {
  const flags: Record<string, string | true> = {}
  const rest: string[] = []
  let command = ''
  const takesValue = new Set(['port', 'host', 'data-dir', 'log-level', 'lines'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      if (takesValue.has(body) && index + 1 < argv.length && !(argv[index + 1] as string).startsWith('-')) {
        flags[body] = argv[index + 1] as string
        index += 1
        continue
      }
      flags[body] = true
      continue
    }
    if (token === '-v') {
      flags.version = true
      continue
    }
    if (token === '-h') {
      flags.help = true
      continue
    }
    if (command === '') command = token
    else rest.push(token)
  }
  return { command, flags, rest }
}

function readRunFile(dataDir: string): { pid?: number; host?: string; port?: number; version?: string; startedAt?: string } | undefined {
  const file = layoutOf(dataDir).runFile
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; host?: string; port?: number }
  } catch {
    return undefined
  }
}

/** The address a human should be told to open, for a given bind address. */
export function browserHost(host: string): string {
  return host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host
}

/**
 * Is another process already serving this data directory?
 *
 * Two facts have to agree before a start is refused, because either alone can be
 * wrong: a pid file left by a crash names a process that no longer exists, and a
 * port that answers may belong to something else entirely. So the pid must be
 * alive *and* `/healthz` must answer on the port the record claims.
 *
 * A stale record is deleted rather than merely ignored — leaving it would make the
 * next start pay for the same probe, and the operator would see a "1 instance"
 * count that does not exist.
 *
 * @param dataDir the directory whose instance record to read
 * @returns the live instance, or undefined when starting is safe
 */
export async function liveInstance(dataDir: string): Promise<InstanceRecord | undefined> {
  const layout = layoutOf(dataDir)
  const record = readInstance(layout.instanceFile)
  if (record === undefined) return undefined
  if (record.pid === process.pid) return undefined
  if (!pidAlive(record.pid)) {
    clearInstance(layout.instanceFile)
    return undefined
  }
  const probe = await health(browserHost(record.host), record.port, 1200)
  if (probe.ok) return record
  // The process exists but is not serving — it is starting up or shutting down.
  // Waiting a moment distinguishes "about to be healthy" from "wedged"; if it is
  // still silent, starting is the better outcome, since refusing would need the
  // owner to find and kill a pid they cannot see.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500))
  const second = await health(browserHost(record.host), record.port, 1200)
  return second.ok ? record : undefined
}

function readControlToken(dataDir: string): string | undefined {
  const file = layoutOf(dataDir).controlFile
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown }
    return typeof parsed.token === 'string' ? parsed.token : undefined
  } catch {
    return undefined
  }
}

function health(host: string, port: number, timeoutMs = 1200): Promise<{ ok: boolean; version?: string }> {
  return new Promise((resolvePromise) => {
    const req = httpRequest(
      { hostname: host === '0.0.0.0' ? '127.0.0.1' : host, port, path: '/healthz', method: 'GET', timeout: timeoutMs },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { ok?: boolean; version?: string }
            resolvePromise({ ok: parsed.ok === true, version: typeof parsed.version === 'string' ? parsed.version : undefined })
          } catch {
            resolvePromise({ ok: response.statusCode === 200 })
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolvePromise({ ok: false })
    })
    req.on('error', () => resolvePromise({ ok: false }))
    req.end()
  })
}

function callControl(
  host: string,
  port: number,
  token: string,
  action: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolvePromise) => {
    const payload = Buffer.from(JSON.stringify({ action }), 'utf8')
    const req = httpRequest(
      {
        hostname: host === '0.0.0.0' ? '127.0.0.1' : host,
        port,
        path: '/api/ai-debate/system/action',
        method: 'POST',
        timeout: 5000,
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
          'x-ai-debate-control': token,
        },
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.on('end', () => {
          try {
            resolvePromise({ status: response.statusCode ?? 0, body: JSON.parse(body) })
          } catch {
            resolvePromise({ status: response.statusCode ?? 0, body })
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolvePromise({ status: 0, body: { error: '请求超时' } })
    })
    req.on('error', (error) => resolvePromise({ status: 0, body: { error: error.message } }))
    req.write(payload)
    req.end()
  })
}

/**
 * Whether this invocation may open a browser.
 *
 * The launcher normally does, because double-clicking an EXE that silently starts
 * a server looks like nothing happened. Two cases must not: an autostart entry
 * (opening a tab at every login is hostile) and a headless test run. Both pass
 * `--no-browser`, which is also honoured through the environment so a shortcut
 * can be configured without a wrapper script.
 */
function browserAllowed(flags: Record<string, string | true>): boolean {
  if (flags['no-browser'] === true) return false
  return process.env.AI_DEBATE_NO_BROWSER !== '1'
}

function openBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {
      process.stdout.write(`无法自动打开浏览器，请手动访问 ${url}\n`)
    })
    child.unref()
  } catch {
    process.stdout.write(`无法自动打开浏览器，请手动访问 ${url}\n`)
  }
}

async function isSea(): Promise<boolean> {
  try {
    const sea = (await import('node:sea')) as unknown as { isSea?: () => boolean }
    return typeof sea.isSea === 'function' && sea.isSea()
  } catch {
    return false
  }
}

function version(): string {
  const injected = process.env.AI_DEBATE_VERSION
  if (typeof injected === 'string' && injected !== '') return injected
  try {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: string }
    if (typeof manifest.version === 'string') return manifest.version
  } catch {
    // Fall through: a packaged binary has no package.json next to it.
  }
  return '0.1.0'
}

const HELP = `AI Debate — 独立讨论分析与回复工作台

用法：
  ai-debate                     启动（若未运行）并打开浏览器
  ai-debate serve               前台运行服务（systemd 使用这个）
  ai-debate supervise           守护模式：serve 异常退出后自动拉起
  ai-debate status              查看服务状态
  ai-debate stop                停止后台服务
  ai-debate restart             重启后台服务
  ai-debate logs [--lines 200]  查看最近日志
  ai-debate open                只打开浏览器
  ai-debate autostart on|off    Windows 开机自启（默认关闭）
  ai-debate --version           版本
  ai-debate --help              这段说明

通用选项：
  --port <端口>        监听端口，默认 17860
  --host <地址>        监听地址，默认 127.0.0.1
  --data-dir <目录>    数据目录
  --log-level <级别>   debug | info | warn | error
  --secure-cookies    会话 Cookie 加 Secure（仅 HTTPS 反代使用；也可 AI_DEBATE_SECURE_COOKIES=1）
`

function flagString(flags: Record<string, string | true>, name: string): string | undefined {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

function secureCookiesFor(flags: Record<string, string | true>): boolean {
  const value = flags['secure-cookies']
  if (value === '0' || value === 'false') return false
  if (value === true || value === '1' || value === 'true') return true
  return process.env.AI_DEBATE_SECURE_COOKIES === '1'
}

export async function runCli(argv: readonly string[]): Promise<void> {
  const parsed = parse(argv)
  const dataDir = resolveDataDir({ flag: flagString(parsed.flags, 'data-dir') })
  const portFlag = Number(flagString(parsed.flags, 'port') ?? '')
  const hostFlag = flagString(parsed.flags, 'host')
  const secureCookies = secureCookiesFor(parsed.flags)

  if (parsed.flags.version === true || parsed.command === 'version') {
    process.stdout.write(`AI Debate ${version()} (${process.platform}-${process.arch})\n`)
    return
  }
  if (parsed.flags.help === true || parsed.command === 'help') {
    process.stdout.write(HELP)
    return
  }

  if (parsed.command === 'supervise') {
    await supervise({
      host: hostFlag ?? process.env.AI_DEBATE_HOST ?? DEFAULT_HOST,
      port: Number.isFinite(portFlag) && portFlag > 0 ? portFlag : Number(process.env.AI_DEBATE_PORT ?? DEFAULT_PORT),
      dataDir,
      logLevel: (flagString(parsed.flags, 'log-level') ?? process.env.AI_DEBATE_LOG_LEVEL ?? 'info') as LogLevel,
      secureCookies,
    })
    return
  }

  if (parsed.command === 'serve') {
    await serveForeground({
      host: hostFlag ?? process.env.AI_DEBATE_HOST ?? DEFAULT_HOST,
      port: Number.isFinite(portFlag) && portFlag > 0 ? portFlag : Number(process.env.AI_DEBATE_PORT ?? DEFAULT_PORT),
      dataDir,
      logLevel: (flagString(parsed.flags, 'log-level') ?? process.env.AI_DEBATE_LOG_LEVEL ?? 'info') as LogLevel,
      secureCookies,
    })
    return
  }

  if (parsed.command === 'autostart') {
    const choice = parsed.rest[0] ?? ''
    if (choice !== 'on' && choice !== 'off') {
      process.stderr.write('用法：ai-debate autostart on|off\n')
      process.exitCode = 2
      return
    }
    const outcome = setAutostart(choice === 'on')
    process.stdout.write(`${outcome.message}\n`)
    if (!outcome.ok) process.exitCode = 1
    return
  }

  const run = readRunFile(dataDir)

  if (parsed.command === 'status') {
    const port = portFlag > 0 ? portFlag : (run?.port ?? DEFAULT_PORT)
    const host = hostFlag ?? run?.host ?? DEFAULT_HOST
    const probe = await health(host, port)
    if (!probe.ok) {
      process.stdout.write(`服务未运行（${host}:${port}）\n数据目录：${dataDir}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(
      `服务运行中\n  地址：http://${host}:${port}/\n  版本：${probe.version ?? run?.version ?? '未知'}\n  PID：${run?.pid ?? '未知'}\n  数据目录：${dataDir}\n  启动时间：${run?.startedAt ?? '未知'}\n`,
    )
    return
  }

  if (parsed.command === 'stop' || parsed.command === 'restart') {
    const port = portFlag > 0 ? portFlag : (run?.port ?? DEFAULT_PORT)
    const host = hostFlag ?? run?.host ?? DEFAULT_HOST
    const token = readControlToken(dataDir)
    if (token === undefined) {
      process.stderr.write('找不到本机控制令牌（run/control.json）。服务可能从未启动过。\n')
      process.exitCode = 1
      return
    }
    const result = await callControl(host, port, token, parsed.command)
    if (result.status !== 200) {
      process.stderr.write(`操作失败：${JSON.stringify(result.body)}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`${parsed.command === 'stop' ? '已请求停止' : '已请求重启'}\n`)
    return
  }

  if (parsed.command === 'logs') {
    const file = layoutOf(dataDir).logFile
    if (!existsSync(file)) {
      process.stdout.write('还没有日志。\n')
      return
    }
    const lines = Number(flagString(parsed.flags, 'lines') ?? 200)
    const text = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    process.stdout.write(`${text.slice(-Math.max(1, lines)).join('\n')}\n`)
    return
  }

  if (parsed.command === 'open') {
    const port = portFlag > 0 ? portFlag : (run?.port ?? DEFAULT_PORT)
    const host = hostFlag ?? run?.host ?? DEFAULT_HOST
    openBrowser(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`)
    return
  }

  if (parsed.command !== '') {
    process.stderr.write(`未知命令：${parsed.command}\n\n${HELP}`)
    process.exitCode = 2
    return
  }

  // No command: the double-click path.
  await launch({ dataDir, portFlag, hostFlag, secureCookies, openBrowser: browserAllowed(parsed.flags) })
}

async function launch(options: {
  dataDir: string
  portFlag: number
  hostFlag: string | undefined
  secureCookies: boolean
  openBrowser: boolean
}): Promise<void> {
  const run = readRunFile(options.dataDir)
  const port = options.portFlag > 0 ? options.portFlag : (run?.port ?? DEFAULT_PORT)
  const host = options.hostFlag ?? run?.host ?? DEFAULT_HOST
  const probe = await health(host, port)
  if (probe.ok) {
    process.stdout.write(`AI Debate 已在运行：http://${host}:${port}/\n`)
    if (options.openBrowser) openBrowser(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`)
    return
  }

  process.stdout.write(`正在启动 AI Debate（${host}:${port}）…\n`)
  const packaged = await isSea()
  // The foreground entry is the *supervisor*, not the service: a crashed service
  // must come back without the owner noticing, and on Windows there is no systemd
  // to do that. The supervisor exits when the service stops cleanly.
  const args = packaged ? ['supervise'] : [process.argv[1] ?? '', 'supervise']
  if (options.portFlag > 0) args.push('--port', String(options.portFlag))
  if (options.hostFlag !== undefined) args.push('--host', options.hostFlag)
  args.push('--secure-cookies', options.secureCookies ? '1' : '0')
  args.push('--data-dir', options.dataDir)

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, AI_DEBATE_VERSION: version() },
  })
  child.unref()

  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400))
    const check = await health(host, port, 800)
    if (check.ok) {
      process.stdout.write(`已启动：http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/\n`)
      if (options.openBrowser) openBrowser(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`)
      return
    }
  }

  process.stderr.write(
    `启动超时。请查看日志：\n  ${join(layoutOf(options.dataDir).logsDir, 'server.log')}\n` +
      `也可以在前台运行看错误：ai-debate serve --port ${port}\n`,
  )
  process.exitCode = 1
}

async function serveForeground(options: { host: string; port: number; dataDir: string; logLevel: LogLevel; secureCookies: boolean }): Promise<void> {
  const existing = await liveInstance(options.dataDir)
  if (existing !== undefined) {
    // Exit code 3 is "already running", not "failed": the launcher and scripts
    // need to tell those apart, and a user who double-clicks twice should not see
    // an error.
    process.stdout.write(
      `已有实例在运行：http://${browserHost(existing.host)}:${existing.port}/\n` +
        `数据目录：${options.dataDir}\n` +
        '同一个数据目录只允许一个实例；要再开一个请看 --data-dir。\n',
    )
    process.exitCode = 3
    return
  }

  const running = await startServer({
    host: options.host,
    port: options.port,
    dataDir: options.dataDir,
    version: version(),
    logLevel: options.logLevel,
    secureCookies: options.secureCookies,
    webDir: resolveWebDir(),
  })

  process.stdout.write(
    `\nAI Debate ${running.version} 正在运行\n  管理页面：http://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${running.port}/\n  数据目录：${running.layout.dataDir}\n  工具：${running.toolCount} 个，路由：${running.routePaths.length} 条\n\n`,
  )

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    process.stdout.write(`收到 ${signal}，正在停止…\n`)
    void running.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  // Stay alive until a signal arrives. The server keeps the event loop busy; this
  // promise documents the intent and keeps the function from returning early.
  await new Promise<void>(() => undefined)
}

/** A convenience for tests and tools: the log file size, used to prove rotation. */
export function logSizeOf(dataDir: string): number {
  try {
    return statSync(layoutOf(dataDir).logFile).size
  } catch {
    return 0
  }
}

/**
 * Keep the service running.
 *
 * Windows has no systemd, so "the process died" would otherwise mean "the product
 * silently stopped working" — the exact failure a background engine must not have.
 * This loop restarts it after an abnormal exit with a capped backoff, and stops when
 * the service exits cleanly (which is what the `stop` action does) so that an
 * intentional shutdown is not fought by the supervisor.
 */
async function supervise(options: { host: string; port: number; dataDir: string; logLevel: LogLevel; secureCookies: boolean }): Promise<void> {
  const packaged = await isSea()
  const layout = layoutOf(options.dataDir)
  let stopping = false
  let attempt = 0

  const stop = (): void => {
    stopping = true
    if (child !== undefined && child.exitCode === null) child.kill()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  let child: ReturnType<typeof spawn> | undefined
  while (!stopping) {
    const args = packaged ? ['serve'] : [process.argv[1] ?? '', 'serve']
    args.push('--host', options.host, '--port', String(options.port), '--data-dir', options.dataDir, '--log-level', options.logLevel)
    args.push('--secure-cookies', options.secureCookies ? '1' : '0')
    // `ignore`, not `inherit`: the supervisor is spawned detached by the launcher,
    // where inheriting a console that no longer exists would fail on Windows. The
    // service writes its own log file, which is what `ai-debate logs` reads.
    child = spawn(process.execPath, args, {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, AI_DEBATE_VERSION: version() },
    })

    const code: number = await new Promise((resolve) => {
      child!.once('exit', (value) => resolve(value ?? 1))
    })
    if (stopping) break
    // 0 = asked to stop; 75 = asked to restart; anything else is a crash.
    if (code === 0) break
    if (code === 75) {
      attempt = 0
      continue
    }
    attempt += 1
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, attempt - 1))
    process.stderr.write(`AI Debate 服务异常退出（码 ${code}），${Math.round(delay / 1000)} 秒后重启（第 ${attempt} 次）\n`)
    await new Promise((resolve) => setTimeout(resolve, delay))
  }

  try {
    const { unlinkSync } = await import('node:fs')
    unlinkSync(join(layout.runDir, 'supervisor.pid'))
  } catch {
    // Already gone.
  }
}

/** The default data directory, exported so packaging scripts can print it. */
export const DEFAULT_DATA_DIR = join(homedir(), '.local', 'share', 'ai-debate')

/**
 * Where the console's static files are, when they are not embedded.
 *
 * A packaged binary embeds them and this returns undefined. A development run has
 * two plausible layouts — `dist/web` next to the bundle produced by
 * `bundle-server.mjs`, and `packages/web/static` in a source checkout — and both
 * are checked rather than guessed, because "the page is 404 and the log says
 * nothing" is a miserable way to discover a wrong path.
 */
export function resolveWebDir(): string | undefined {
  const fromEnv = process.env.AI_DEBATE_WEB_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '' && existsSync(fromEnv)) return resolve(fromEnv)
  const candidates = [join(process.cwd(), 'dist', 'web'), join(process.cwd(), 'packages', 'web', 'static')]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  return undefined
}

/**
 * Whether this module was named on the command line.
 *
 * `npm start` runs `node ... packages/server/src/cli.ts serve`, so this file is
 * both a library (`runCli`, `liveInstance`, `resolveWebDir` for the tests) and an
 * entry point. Without this guard the entry invocation would authoritatively run
 * the CLI during an import, and every test that imports a helper would start a
 * server.
 *
 * Only `cli.*` matches, deliberately: `main.ts` imports `runCli` and calls it
 * itself, so matching `main.*` here would run the CLI twice in one process — the
 * second copy binding a second listener over the first. The match is on the
 * executable's own path, so a bundle (`dist/ai-debate.cjs`) is unaffected.
 */
const INVOKED_DIRECTLY =
  typeof process.argv[1] === 'string' && /[\\/]cli\.(?:ts|js|cjs|mjs)$/.test(process.argv[1])

if (INVOKED_DIRECTLY) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`AI Debate: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
