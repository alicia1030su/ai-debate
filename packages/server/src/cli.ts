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
`

function flagString(flags: Record<string, string | true>, name: string): string | undefined {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

export async function runCli(argv: readonly string[]): Promise<void> {
  const parsed = parse(argv)
  const dataDir = resolveDataDir({ flag: flagString(parsed.flags, 'data-dir') })
  const portFlag = Number(flagString(parsed.flags, 'port') ?? '')
  const hostFlag = flagString(parsed.flags, 'host')

  if (parsed.flags.version === true || parsed.command === 'version') {
    process.stdout.write(`AI Debate ${version()} (${process.platform}-${process.arch})\n`)
    return
  }
  if (parsed.flags.help === true || parsed.command === 'help') {
    process.stdout.write(HELP)
    return
  }

  if (parsed.command === 'serve') {
    await serveForeground({
      host: hostFlag ?? process.env.AI_DEBATE_HOST ?? DEFAULT_HOST,
      port: Number.isFinite(portFlag) && portFlag > 0 ? portFlag : Number(process.env.AI_DEBATE_PORT ?? DEFAULT_PORT),
      dataDir,
      logLevel: (flagString(parsed.flags, 'log-level') ?? process.env.AI_DEBATE_LOG_LEVEL ?? 'info') as LogLevel,
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
  await launch({ dataDir, portFlag, hostFlag })
}

async function launch(options: { dataDir: string; portFlag: number; hostFlag: string | undefined }): Promise<void> {
  const run = readRunFile(options.dataDir)
  const port = options.portFlag > 0 ? options.portFlag : (run?.port ?? DEFAULT_PORT)
  const host = options.hostFlag ?? run?.host ?? DEFAULT_HOST
  const probe = await health(host, port)
  if (probe.ok) {
    process.stdout.write(`AI Debate 已在运行：http://${host}:${port}/\n`)
    openBrowser(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`)
    return
  }

  process.stdout.write(`正在启动 AI Debate（${host}:${port}）…\n`)
  const packaged = await isSea()
  const args = packaged ? ['serve'] : [process.argv[1] ?? '', 'serve']
  if (options.portFlag > 0) args.push('--port', String(options.portFlag))
  if (options.hostFlag !== undefined) args.push('--host', options.hostFlag)
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
      openBrowser(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`)
      return
    }
  }

  process.stderr.write(
    `启动超时。请查看日志：\n  ${join(layoutOf(options.dataDir).logsDir, 'server.log')}\n` +
      `也可以在前台运行看错误：ai-debate serve --port ${port}\n`,
  )
  process.exitCode = 1
}

async function serveForeground(options: { host: string; port: number; dataDir: string; logLevel: LogLevel }): Promise<void> {
  const running = await startServer({
    host: options.host,
    port: options.port,
    dataDir: options.dataDir,
    version: version(),
    logLevel: options.logLevel,
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
