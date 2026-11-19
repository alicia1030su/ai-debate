/**
 * The HTTP surface.
 *
 * One server, four kinds of request, in this order:
 *
 *   1. `/healthz` — no auth, no runtime dependency. It answers "is the process
 *      alive", which is what the Windows launcher and systemd need.
 *   2. `/api/ai-debate/auth/*` — the only unauthenticated API. It exposes whether
 *      an administrator exists and, if so, whether this browser has a session.
 *      Nothing else: no usernames, no counts, no paths.
 *   3. The engine's own routes, registered by the core through the web-server
 *      adapter. They authenticate themselves (the core's guard calls back into
 *      `connection.requestRejection`), so this layer does not double-guess them.
 *   4. The standalone operator routes (`system/*`, `jobs*`) — session required
 *      here, because they are ours and this is the only place that checks.
 *
 * Cross-site protection is applied once, globally: a request with an `Origin` that
 * does not match `Host` is refused before it reaches any handler, and a
 * state-changing request must carry `application/json` (which a cross-site HTML
 * form cannot send without a CORS preflight that this server never approves).
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AssetStore } from './assets.ts'
import { clearSessionCookie, isLoopback, parseCookies, SESSION_COOKIE, sessionCookie, type AuthService } from './auth.ts'
import type { JobQueue } from './jobs.ts'
import type { Logger } from './logger.ts'
import type { WebServerRegistry } from './registry.ts'

export interface HttpDeps {
  readonly auth: AuthService
  readonly queue: JobQueue
  readonly registry: WebServerRegistry
  readonly assets: AssetStore
  readonly log: Logger
  readonly version: string
  readonly dataDir: string
  readonly startedAt: string
  readonly secureCookies: boolean
  readonly host: string
  readonly port: () => number
  readonly info: () => Record<string, unknown>
  /** Local-only token that lets the CLI stop or restart the service. */
  readonly controlToken: string
  /** The old plugin's data directory, read only when the owner asks. */
  readonly legacy: {
    scan(): { found: boolean; dir: string; sessions: number; ledger: number; approvals: number; bytes: number }
    import(): { ok: boolean; message: string }
  }
  readonly actions: {
    shutdown(reason: string): void
    restart(reason: string): void
    autostart(enable: boolean): { ok: boolean; message: string }
  }
}

const MAX_BODY_BYTES = 1024 * 1024

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'DENY')
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('cross-origin-opener-policy', 'same-origin')
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  )
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      overflow = true
      continue
    }
    chunks.push(buffer)
  }
  if (overflow) return undefined
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function cookieOf(request: IncomingMessage): string | undefined {
  const cookies = parseCookies(request.headers.cookie)
  return cookies[SESSION_COOKIE]
}

function remoteAddressOf(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? ''
}

/**
 * Refuse a request that a browser would have marked as cross-site.
 *
 * `Sec-Fetch-Site` is the strongest signal when present; `Origin` is the fallback
 * for older clients. A missing `Origin` on a GET is normal (address bar), and a
 * missing `Origin` on a POST is normal for a same-origin fetch in some browsers —
 * in that case SameSite=Strict on the cookie is what still protects the request.
 */
function crossSiteReason(request: IncomingMessage): string | undefined {
  if (request.headers['sec-fetch-site'] === 'cross-site') return 'cross-site fetch'
  const origin = request.headers.origin
  if (typeof origin !== 'string') return undefined
  const host = request.headers.host
  if (typeof host !== 'string') return 'missing host'
  try {
    if (new URL(origin).host !== host) return `origin ${origin} does not match host ${host}`
  } catch {
    return 'unparseable origin'
  }
  return undefined
}

export function createHttpServer(deps: HttpDeps): Server {
  const server = createServer(async (request, response) => {
    securityHeaders(response)
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    const pathname = url.pathname

    try {
      if (pathname === '/healthz') {
        writeJson(response, 200, { ok: true, version: deps.version, uptimeSec: Math.round(process.uptime()) })
        return
      }

      const crossSite = crossSiteReason(request)
      if (crossSite !== undefined) {
        deps.log.warn(`拒绝跨站请求：${method} ${pathname}（${crossSite}）`)
        writeJson(response, 403, { error: 'forbidden: 请求来源与本站不一致。' })
        return
      }

      const stateChanging = method !== 'GET' && method !== 'HEAD'
      if (stateChanging) {
        const type = request.headers['content-type'] ?? ''
        const hasBody = Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding'] !== undefined
        if (hasBody && !String(type).toLowerCase().startsWith('application/json')) {
          writeJson(response, 415, { error: '请求体必须是 application/json。' })
          return
        }
      }

      if (pathname.startsWith('/api/ai-debate/auth/')) {
        await handleAuth(deps, request, response, pathname, method)
        return
      }

      // The engine's routes authenticate themselves through the adapter.
      const route = deps.registry.match(pathname)
      if (route !== undefined) {
        await route.handler(request, response)
        return
      }

      if (pathname.startsWith('/api/ai-debate/system/') || pathname.startsWith('/api/ai-debate/jobs')) {
        // The CLI has no browser session, and it must still be able to stop and
        // restart the service it started. That is a local-only ability, proved by a
        // token that only a process able to read the data directory can obtain —
        // which is the same trust level as being able to delete the state file.
        const control = request.headers['x-ai-debate-control']
        const viaControlToken = typeof control === 'string' && control.length >= 16 && control === deps.controlToken
        const session = viaControlToken ? { username: 'local-cli' } : deps.auth.validate(cookieOf(request))
        if (session === undefined) {
          writeJson(response, 401, { error: 'unauthorized: 需要先登录管理后台。' })
          return
        }
        await handleOperator(deps, request, response, pathname, method, url, session, viaControlToken)
        return
      }

      if (pathname === '/system' || pathname === '/system/') {
        const session = deps.auth.validate(cookieOf(request))
        if (session === undefined) {
          response.writeHead(302, { location: '/' })
          response.end()
          return
        }
        const body = systemPage(deps)
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(body)
        return
      }

      if (pathname === '/' || pathname === '/index.html') {
        const asset = await deps.assets.read('index.html')
        if (asset === undefined) {
          writeJson(response, 503, { error: '页面资源缺失。请重新安装。' })
          return
        }
        response.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' })
        response.end(asset.body)
        return
      }

      if (pathname.startsWith('/assets/')) {
        const asset = await deps.assets.read(pathname)
        if (asset === undefined) {
          writeJson(response, 404, { error: 'not found' })
          return
        }
        const etag = `"${createHash('sha256').update(asset.body).digest('hex').slice(0, 32)}"`
        if (request.headers['if-none-match'] === etag) {
          response.writeHead(304, { etag })
          response.end()
          return
        }
        response.writeHead(200, {
          'content-type': asset.type,
          etag,
          'cache-control': asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        })
        response.end(asset.body)
        return
      }

      writeJson(response, 404, { error: 'not found' })
    } catch (error) {
      deps.log.error(`${method} ${pathname} 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      if (!response.headersSent) writeJson(response, 500, { error: '服务器内部错误，详情见日志。' })
      else response.end()
    }
  })

  server.headersTimeout = 30_000
  server.requestTimeout = 120_000
  return server
}

async function handleAuth(
  deps: HttpDeps,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  method: string,
): Promise<void> {
  if (pathname === '/api/ai-debate/auth/state') {
    if (method !== 'GET') {
      writeJson(response, 405, { error: 'method not allowed' })
      return
    }
    const session = deps.auth.validate(cookieOf(request))
    writeJson(response, 200, {
      initialized: deps.auth.initialized,
      authenticated: session !== undefined,
      ...(session === undefined ? {} : { username: session.username }),
      version: deps.version,
    })
    return
  }

  if (pathname === '/api/ai-debate/auth/setup') {
    if (method !== 'POST') {
      writeJson(response, 405, { error: 'method not allowed' })
      return
    }
    const body = await readJsonBody(request)
    if (body === undefined) {
      writeJson(response, 400, { error: '请求体不是合法 JSON。' })
      return
    }
    if (deps.auth.initialized) {
      writeJson(response, 409, { error: '已经初始化过了。请直接登录。' })
      return
    }
    const allowed = deps.auth.setupAllowed(remoteAddressOf(request), typeof body.token === 'string' ? body.token : undefined)
    if (!allowed.ok) {
      writeJson(response, 403, { error: allowed.reason })
      return
    }
    try {
      deps.auth.createAdmin(String(body.username ?? ''), String(body.password ?? ''))
    } catch (error) {
      writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    const outcome = deps.auth.login(String(body.username ?? ''), String(body.password ?? ''), {
      ip: remoteAddressOf(request),
      ...(request.headers['user-agent'] === undefined ? {} : { userAgent: String(request.headers['user-agent']) }),
    })
    if (!outcome.ok) {
      writeJson(response, 500, { error: '账号已创建，但自动登录失败。请手动登录。' })
      return
    }
    response.setHeader('set-cookie', sessionCookie(outcome.token, { secure: deps.secureCookies }))
    deps.log.info(`首次初始化完成：${String(body.username ?? '')} 来自 ${isLoopback(remoteAddressOf(request)) ? '本机' : '远程'}`)
    writeJson(response, 200, { ok: true, username: outcome.session.username })
    return
  }

  if (pathname === '/api/ai-debate/auth/login') {
    if (method !== 'POST') {
      writeJson(response, 405, { error: 'method not allowed' })
      return
    }
    const body = await readJsonBody(request)
    if (body === undefined) {
      writeJson(response, 400, { error: '请求体不是合法 JSON。' })
      return
    }
    const outcome = deps.auth.login(String(body.username ?? ''), String(body.password ?? ''), {
      ip: remoteAddressOf(request),
      ...(request.headers['user-agent'] === undefined ? {} : { userAgent: String(request.headers['user-agent']) }),
    })
    if (!outcome.ok) {
      if (outcome.status === 429) {
        response.setHeader('retry-after', String(outcome.retryAfterSec ?? 60))
        deps.log.warn(`登录被限流：${remoteAddressOf(request)}`)
      } else {
        deps.log.warn(`登录失败：${remoteAddressOf(request)} 用户名 ${String(body.username ?? '').slice(0, 64)}`)
      }
      writeJson(response, outcome.status, { error: outcome.message })
      return
    }
    response.setHeader('set-cookie', sessionCookie(outcome.token, { secure: deps.secureCookies }))
    writeJson(response, 200, { ok: true, username: outcome.session.username })
    return
  }

  if (pathname === '/api/ai-debate/auth/logout') {
    if (method !== 'POST') {
      writeJson(response, 405, { error: 'method not allowed' })
      return
    }
    deps.auth.logout(cookieOf(request))
    response.setHeader('set-cookie', clearSessionCookie())
    writeJson(response, 200, { ok: true })
    return
  }

  if (pathname === '/api/ai-debate/auth/password') {
    if (method !== 'POST') {
      writeJson(response, 405, { error: 'method not allowed' })
      return
    }
    const session = deps.auth.validate(cookieOf(request))
    if (session === undefined) {
      writeJson(response, 401, { error: 'unauthorized: 需要先登录管理后台。' })
      return
    }
    const body = await readJsonBody(request)
    if (body === undefined) {
      writeJson(response, 400, { error: '请求体不是合法 JSON。' })
      return
    }
    try {
      deps.auth.changePassword(String(body.current ?? ''), String(body.next ?? ''))
    } catch (error) {
      writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    response.setHeader('set-cookie', clearSessionCookie())
    writeJson(response, 200, { ok: true, message: '密码已更新，请用新密码重新登录。' })
    return
  }

  writeJson(response, 404, { error: 'not found' })
}

async function handleOperator(
  deps: HttpDeps,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  method: string,
  url: URL,
  session: { username: string },
  viaControlToken: boolean,
): Promise<void> {
  if (viaControlToken) {
    const allowed = new Set(['/api/ai-debate/system/status', '/api/ai-debate/system/action'])
    if (!allowed.has(pathname)) {
      writeJson(response, 403, { error: '本机控制令牌只能用于状态查询与停止/重启。' })
      return
    }
  }
  if (pathname === '/api/ai-debate/system/status' && method === 'GET') {
    writeJson(response, 200, {
      ...deps.info(),
      session: { username: session.username },
      queue: deps.queue.snapshot(),
    })
    return
  }

  if (pathname === '/api/ai-debate/system/logs' && method === 'GET') {
    const lines = Math.max(1, Math.min(2000, Number(url.searchParams.get('lines') ?? 200) || 200))
    const level = url.searchParams.get('level')
    const minLevel = level === 'debug' || level === 'warn' || level === 'error' ? level : 'info'
    writeJson(response, 200, { lines: deps.log.tail(lines, minLevel) })
    return
  }

  if (pathname === '/api/ai-debate/system/action' && method === 'POST') {
    const body = await readJsonBody(request)
    if (body === undefined) {
      writeJson(response, 400, { error: '请求体不是合法 JSON。' })
      return
    }
    const action = String(body.action ?? '')
    switch (action) {
      case 'restart':
        writeJson(response, 200, { ok: true, message: '服务将在 1 秒内重启。' })
        deps.actions.restart(`管理员 ${session.username} 请求重启`)
        return
      case 'stop':
        writeJson(response, 200, { ok: true, message: '服务将在 1 秒内停止。' })
        deps.actions.shutdown(`管理员 ${session.username} 请求停止`)
        return
      case 'backup': {
        const { job, deduplicated } = deps.queue.enqueue({ type: 'backup.create', key: 'manual-backup' })
        writeJson(response, 200, { ok: true, jobId: job.id, deduplicated })
        return
      }
      case 'rotate-logs': {
        const { job } = deps.queue.enqueue({ type: 'logs.rotate', key: 'manual-rotate' })
        writeJson(response, 200, { ok: true, jobId: job.id })
        return
      }
      case 'storage-check': {
        const { job } = deps.queue.enqueue({ type: 'storage.check', key: 'manual-storage' })
        writeJson(response, 200, { ok: true, jobId: job.id })
        return
      }
      case 'credentials-audit': {
        const { job } = deps.queue.enqueue({ type: 'credentials.audit', key: 'manual-credentials' })
        writeJson(response, 200, { ok: true, jobId: job.id })
        return
      }
      case 'legacy-scan':
        writeJson(response, 200, { ok: true, scan: deps.legacy.scan() })
        return
      case 'legacy-import': {
        const outcome = deps.legacy.import()
        writeJson(response, outcome.ok ? 200 : 409, outcome)
        return
      }
      case 'autostart-on':
      case 'autostart-off': {
        const outcome = deps.actions.autostart(action === 'autostart-on')
        writeJson(response, outcome.ok ? 200 : 400, outcome)
        return
      }
      default:
        writeJson(response, 400, { error: `未知操作：${action}` })
        return
    }
  }

  if (pathname === '/api/ai-debate/jobs' && method === 'GET') {
    writeJson(response, 200, deps.queue.snapshot())
    return
  }

  if (pathname === '/api/ai-debate/jobs' && method === 'POST') {
    const body = await readJsonBody(request)
    if (body === undefined) {
      writeJson(response, 400, { error: '请求体不是合法 JSON。' })
      return
    }
    const type = String(body.type ?? '')
    const allowed = ['backup.create', 'logs.rotate', 'credentials.audit', 'storage.check']
    if (!allowed.includes(type)) {
      writeJson(response, 400, { error: `不支持的任务类型：${type}。v0.1.0 只接受 ${allowed.join('、')}。` })
      return
    }
    try {
      const { job, deduplicated } = deps.queue.enqueue({
        type: type as 'backup.create',
        ...(typeof body.key === 'string' ? { key: body.key } : {}),
        ...(body.payload !== null && typeof body.payload === 'object' ? { payload: body.payload as Record<string, unknown> } : {}),
      })
      writeJson(response, 200, { ok: true, job, deduplicated })
    } catch (error) {
      writeJson(response, 429, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  const jobAction = /^\/api\/ai-debate\/jobs\/([^/]+)\/(pause|resume|cancel)$/.exec(pathname)
  if (jobAction !== null && method === 'POST') {
    const [, id, action] = jobAction
    const ok =
      action === 'pause' ? deps.queue.pauseJob(id) : action === 'resume' ? deps.queue.resumeJob(id) : deps.queue.cancelJob(id)
    writeJson(response, ok ? 200 : 404, { ok, ...(ok ? {} : { error: '任务不存在或当前状态不允许这个操作。' }) })
    return
  }

  if (pathname === '/api/ai-debate/queue' && method === 'POST') {
    const body = await readJsonBody(request)
    if (body === undefined) {
      writeJson(response, 400, { error: '请求体不是合法 JSON。' })
      return
    }
    const action = String(body.action ?? '')
    if (action === 'pause') deps.queue.pauseQueue()
    else if (action === 'resume') deps.queue.resumeQueue()
    else {
      writeJson(response, 400, { error: '未知队列操作。' })
      return
    }
    writeJson(response, 200, { ok: true, paused: deps.queue.snapshot().paused })
    return
  }

  writeJson(response, 404, { error: 'not found' })
}


/**
 * A server-rendered status page.
 *
 * Deliberately no JavaScript: the console's CSP forbids inline scripts, and a
 * status page that itself needs a working script bundle is a poor place to find
 * out that the bundle is broken. Everything here is read-only; the actions live in
 * the CLI and in the JSON API.
 */
function systemPage(deps: HttpDeps): string {
  const info = deps.info() as {
    server?: Record<string, unknown>
    engine?: Record<string, unknown>
    store?: Record<string, unknown>
    legacy?: { found?: boolean; dir?: string; note?: string }
  }
  const queue = deps.queue.snapshot()
  const server = info.server ?? {}
  const lines = deps.log.tail(80, 'info')
  const escape = (value: unknown): string =>
    String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  const rows = Object.entries(server)
    .map(([key, value]) => `<tr><th>${escape(key)}</th><td>${escape(value)}</td></tr>`)
    .join('')
  const queueRows = Object.entries(queue.counts)
    .map(([state, count]) => `<tr><th>${escape(state)}</th><td>${escape(count)}</td></tr>`)
    .join('')
  const logHtml = lines
    .map((line) => `<li><span class="lv">${escape(line.level)}</span> ${escape(line.at)} ${escape(line.message)}</li>`)
    .join('')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Debate — 服务状态</title>
<style>
body{font:14px/1.6 system-ui,-apple-system,"Segoe UI","Noto Sans CJK SC",sans-serif;margin:0;padding:24px;background:#f6f7f9;color:#1f2328}
h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:24px 0 8px;color:#57606a}
.card{background:#fff;border:1px solid #d8dee4;border-radius:12px;padding:16px;margin-bottom:16px;max-width:920px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #eaeef2;font-size:13px;vertical-align:top}
th{width:180px;color:#57606a;font-weight:600}
ul{list-style:none;padding:0;margin:0;font:12px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;max-height:340px;overflow:auto}
li{border-bottom:1px solid #eaeef2;padding:2px 0;word-break:break-all}.lv{color:#8250df}
a{color:#0969da}code{background:#eef1f4;padding:1px 4px;border-radius:4px}
</style></head><body>
<div class="card"><h1>AI Debate 服务状态</h1>
<p>当前登录：${escape(deps.auth.username ?? '')} · <a href="/">返回控制台</a></p>
<table>${rows}</table></div>
<div class="card"><h2>后台任务</h2><p>队列${queue.paused ? '已暂停' : '运行中'}，并发上限 ${queue.concurrency}。</p>
<table>${queueRows}</table>
<p style="color:#57606a;font-size:12px">停止 / 重启 / 备份 / 导入旧数据请用命令行：<code>ai-debate stop</code>、<code>ai-debate restart</code>、<code>ai-debate logs</code>。</p></div>
<div class="card"><h2>旧插件数据</h2><p>${escape(info.legacy?.note ?? '')}</p><p><code>${escape(info.legacy?.dir ?? '')}</code></p></div>
<div class="card"><h2>最近日志</h2><ul>${logHtml || '<li>（暂无）</li>'}</ul></div>
</body></html>`
}
