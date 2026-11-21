/**
 * HTTP plumbing shared by every platform adapter.
 *
 * Three jobs, all of which past attempts at this get wrong in the same ways:
 *
 * 1. **A cookie jar.** Tieba refuses plain requests with a security challenge
 *    page until the client holds a real `BAIDUID`; the jar makes that
 *    bootstrap reusable instead of repeated on every call.
 * 2. **Bounded retry with classified errors.** Only transport-level failures
 *    and explicit throttling retry; a 403, a captcha or a 404 does not.
 * 3. **Encoding detection.** Several Tieba endpoints answer in GBK, and
 *    decoding those as UTF-8 produces mojibake that then gets fed to a model.
 */

import { PlatformError, type PlatformErrorCode } from '../types.js'
import {
  EgressBlockedError,
  PinnedDnsAgent,
  resolveNetworkHost,
  systemDnsResolver,
  type DnsResolver,
} from '../net-audit.js'

/** A minimal cookie jar: name → value, with no domain or path scoping. */
export class CookieJar {
  private readonly cookies = new Map<string, string>()

  /** Record every `Set-Cookie` from a response. */
  absorb(response: Response): void {
    const listed = response.headers.getSetCookie?.() ?? []
    for (const raw of listed) {
      const pair = raw.split(';', 1)[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (name) this.cookies.set(name, value)
    }
  }

  /** Serialize for a `Cookie` request header; empty string when nothing is held. */
  header(): string {
    const parts: string[] = []
    for (const [name, value] of this.cookies) parts.push(`${name}=${value}`)
    return parts.join('; ')
  }

  /** True when a cookie with this exact name is held and non-empty. */
  has(name: string): boolean {
    const value = this.cookies.get(name)
    return value !== undefined && value !== ''
  }

  /** Number of held cookies, for diagnostics that never reveal values. */
  get size(): number {
    return this.cookies.size
  }

  /** The held cookie names, never their values. */
  names(): readonly string[] {
    return [...this.cookies.keys()]
  }

  /** Set or replace one cookie; used when the user supplies a session. */
  set(name: string, value: string): void {
    this.cookies.set(name, value)
  }

  /** Drop everything; used when a session is reset. */
  clear(): void {
    this.cookies.clear()
  }
}

/** Options for one logical request. */
export interface RequestOptions {
  readonly method?: 'GET' | 'POST'
  readonly headers?: Readonly<Record<string, string>>
  /** Form body for POST; serialized as `application/x-www-form-urlencoded`. */
  readonly form?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  /** Total timeout for one attempt, including every redirect hop, in milliseconds. */
  readonly timeoutMs?: number
  /** How many extra attempts transport failures get. Defaults to 2. */
  readonly retries?: number
  /** Override the text encoding; `auto` sniffs from headers and content. */
  readonly encoding?: 'auto' | 'utf-8' | 'gbk'
}

/** The result of one successful logical request. */
export interface HttpResult {
  readonly status: number
  readonly url: string
  readonly text: string
  readonly contentType: string
}

/**
 * Markers that identify an anti-bot / verification page.
 *
 * Deliberately duplicated from `fault-classify.ts` rather than importing it:
 * this module sits below fault classification in the dependency order, and a
 * platform adapter must not depend on the error-classification layer. The two
 * lists are pinned together by `packages/core/test/tieba-403-diagnosis.test.ts`,
 * which exercises the real 403 fixture and representative markers from both.
 */
const CHALLENGE_BODY_MARKERS = /captcha|验证码|安全验证|人机验证|verify you are (a )?human|异常流量|访问受限|wappass\.baidu\.com/i

/** Redirects are followed explicitly so every hop can pass the egress fence. */
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** A browser-shaped user agent; the mobile one triggers the WAP rendering. */
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** The WAP user agent, which makes Tieba serve the lightweight HTML tree. */
export const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'

/** Map an HTTP status onto the normalized error classes. */
export function classifyStatus(status: number): PlatformErrorCode {
  if (status === 401) return 'auth_required'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'network'
  if (status >= 400) return 'unknown'
  return 'unknown'
}

/** Map a thrown fetch error onto the normalized error classes. */
export function classifyThrown(error: unknown): { code: PlatformErrorCode; message: string } {
  if (error instanceof PlatformError) return { code: error.code, message: error.message }
  if (isEgressBlockedError(error)) {
    return {
      code: 'egress_blocked',
      message: '出网策略拒绝：请求未连接到平台。请检查运行模式与允许出网的目标。',
    }
  }
  const err = error as { name?: string; message?: string; code?: string; cause?: { code?: string } }
  const message = err?.message ?? String(error)
  if (err?.name === 'AbortError') return { code: 'timeout', message: '请求被取消或超时' }
  if (err?.name === 'TimeoutError') return { code: 'timeout', message: '请求超时' }
  const causeCode = err?.cause?.code ?? err?.code
  if (causeCode === 'egress_blocked') {
    return {
      code: 'egress_blocked',
      message: '出网策略拒绝：连接期 DNS 校验未通过，请求未连接到平台。',
    }
  }
  if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN') {
    return { code: 'dns', message: `DNS 解析失败：${message}` }
  }
  if (typeof causeCode === 'string' && causeCode.startsWith('UND_ERR')) {
    return { code: 'network', message: `连接失败：${message}` }
  }
  return { code: 'network', message }
}

/**
 * Decode a response body, honoring the declared charset and falling back to
 * GBK when the bytes are not valid UTF-8.
 */
export function decodeBody(bytes: Uint8Array, contentType: string, mode: RequestOptions['encoding']): string {
  const declared =
    mode === 'utf-8' || mode === 'gbk'
      ? mode
      : /charset=["']?\s*([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? 'auto'

  if (declared === 'gbk' || declared === 'gb2312' || declared === 'gb18030') {
    return new TextDecoder('gb18030').decode(bytes)
  }
  if (declared === 'utf-8' || declared === 'utf8') {
    return new TextDecoder('utf-8').decode(bytes)
  }

  // `auto`: UTF-8 is the common case, so try it strictly first.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gb18030').decode(bytes)
  }
}

/** The shared HTTP client: one cookie jar, bounded retry, classified errors. */
/**
 * 平台 HTTP 的出网检查钩子（v0.2.36 §4）。
 *
 * ## 为什么用模块级钩子，而不是给每个适配器加一个构造参数
 *
 * `HttpClient` 由贴吧适配器持有，适配器由注册中心按平台创建，而「这次允许出网吗」
 * 是**进程级**的策略（一个插件挂载只有一套配置）。把策略从注册中心一路传进
 * 适配器的构造函数，会让每个平台都要多一个参数，而它们对该参数的处理是完全
 * 相同的 —— 那只是把一个全局约束手工复制 N 份。
 *
 * 钩子在 `request()` 的**每一跳**发连接前调用。即使没有设置钩子，传输层仍
 * 强制拒绝私网、回环、link-local 与元数据地址；策略钩子只叠加模式限制。
 */
let egressGate: ((url: string) => void) | undefined

/** 设置平台 HTTP 的出网检查。传 undefined 恢复不限。 */
export function __setHttpEgressGate(next: ((url: string) => void) | undefined): void {
  egressGate = next
}

/** Dependencies and defaults for one platform HTTP client. */
export interface HttpClientOptions {
  readonly timeoutMs?: number
  readonly retries?: number
  /** Resolver injection for tests and host-specific DNS policy. */
  readonly resolver?: DnsResolver
}

export class HttpClient {
  readonly jar = new CookieJar()
  private readonly defaultTimeoutMs: number
  private readonly defaultRetries: number
  private readonly resolver: DnsResolver

  constructor(options: HttpClientOptions = {}) {
    this.defaultTimeoutMs = options.timeoutMs ?? 20_000
    this.defaultRetries = options.retries ?? 2
    this.resolver = options.resolver ?? systemDnsResolver
  }

  /**
   * Perform one logical request, retrying only transport failures.
   *
   * @param url absolute URL
   * @param options method, headers, form body, timeout, retry count
   * @returns the decoded body with its status
   * @throws PlatformError with a normalized `code`
   */
  async request(url: string, options: RequestOptions = {}): Promise<HttpResult> {
    const initialUrl = safeHttpUrl(url).href
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    const attempts = Math.max(1, (options.retries ?? this.defaultRetries) + 1)
    let lastError: PlatformError | undefined

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (options.signal?.aborted) {
        throw new PlatformError('请求已取消', 'timeout')
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const onAbort = (): void => controller.abort()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      // Close the check/listener race: an abort that happened between the guard
      // above and addEventListener must still cancel this attempt.
      if (options.signal?.aborted) controller.abort()
      let agent: PinnedDnsAgent | undefined

      try {
        agent = await PinnedDnsAgent.create(new URL(initialUrl).hostname, 'platform', 'open')
        let currentUrl = initialUrl
        let currentMethod = options.method ?? (options.form ? 'POST' : 'GET')
        let currentBody: string | undefined
        let requestHeaders: Record<string, string> = {
          'user-agent': DESKTOP_UA,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9',
          ...options.headers,
        }
        if (options.form) {
          currentBody = new URLSearchParams(options.form).toString()
          requestHeaders['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8'
        }
        let allowJarCookie = true
        // Cookies learned from a different origin stay in this private jar. The
        // shared jar has no domain scoping, so absorbing them there would leak the
        // redirect target's cookies into later first-party requests.
        let redirectJar: CookieJar | undefined
        const visited = new Set<string>()

        for (let hop = 0; ; hop += 1) {
          if (hop > MAX_REDIRECTS) {
            throw new PlatformError(`平台重定向超过 ${MAX_REDIRECTS} 次，已停止请求`, 'unknown')
          }
          if (visited.has(currentUrl)) {
            throw new PlatformError('检测到 HTTP 重定向循环', 'unknown')
          }
          visited.add(currentUrl)
          // Check every hop before fetch can open a socket. A redirect target is
          // new egress, not an extension of the destination already approved.
          egressGate?.(currentUrl)
          const destination = new URL(currentUrl)
          if (!agent.isPinned(destination.hostname)) {
            await resolveNetworkHost(destination.hostname, {
              resolver: this.resolver,
              purpose: 'platform',
              mode: 'open',
            })
          }
          agent.remember(destination.hostname, {
            resolver: this.resolver,
            purpose: 'platform',
            mode: 'open',
          })
          if (controller.signal.aborted) throw new PlatformError('请求已取消', 'timeout')
          const headers = { ...requestHeaders }
          const cookie = allowJarCookie ? (redirectJar?.header() ?? this.jar.header()) : ''
          if (cookie !== '' && !hasHeader(headers, 'cookie')) headers.cookie = cookie

          const response = await fetch(currentUrl, {
            method: currentMethod,
            headers,
            body: currentBody,
            redirect: 'manual',
            signal: controller.signal,
            dispatcher: agent.dispatcherOption,
          } as RequestInit)
          const redirecting = REDIRECT_STATUSES.has(response.status)
          const location = response.headers.get('location')
          if (redirecting && (location === null || location.trim() === '')) {
            throw new PlatformError(`平台返回 HTTP ${response.status} 重定向，但没有 Location`, 'unknown')
          }
          const nextUrl = redirecting ? safeHttpUrl(location as string, currentUrl) : undefined
          const sameOrigin = nextUrl !== undefined && nextUrl.origin === new URL(currentUrl).origin
          if (!allowJarCookie || (nextUrl !== undefined && !sameOrigin)) {
            (redirectJar ??= new CookieJar()).absorb(response)
          } else {
            this.jar.absorb(response)
          }

          if (redirecting && nextUrl !== undefined) {
            const currentOrigin = new URL(currentUrl)
            if (currentOrigin.protocol === 'https:' && new URL(nextUrl).protocol === 'http:') {
              throw new PlatformError('拒绝平台请求从 HTTPS 降级到 HTTP', 'unknown')
            }
            if (!sameOrigin) {
              // Fetch's automatic redirects strip these on a cross-origin hop.
              // Keep them stripped even if a later hop returns to the first origin.
              requestHeaders = withoutCredentials(requestHeaders)
              allowJarCookie = false
              // A 307/308 deliberately replays the request body. Sending a form
              // to another origin can disclose content as well as credentials, so
              // refuse rather than silently changing a write into a GET.
              if ((response.status === 307 || response.status === 308) && currentBody !== undefined) {
                throw new PlatformError('拒绝把请求体跨域重定向到其他源', 'unknown')
              }
            }
            if (currentMethod === 'POST' && (response.status === 301 || response.status === 302 || response.status === 303)) {
              currentMethod = 'GET'
              currentBody = undefined
              removeHeader(requestHeaders, 'content-type')
              removeHeader(requestHeaders, 'content-length')
            }
            // Manual mode leaves the redirect body to the caller. Release it
            // without buffering an unbounded intermediate error page.
            void response.body?.cancel().catch(() => undefined)
            currentUrl = nextUrl.href
            continue
          }

          const buffer = await response.arrayBuffer()
          const text = decodeBody(new Uint8Array(buffer), response.headers.get('content-type') ?? '', options.encoding)

          if (response.status >= 400) {
            // v0.2.23: keep looking at the body before deciding what a 403 *means*.
            //
            // v0.2.22 threw `平台返回 403（forbidden）` and dropped the body. Tieba
            // answers an anti-bot block with a 200-shaped verification page and, once
            // the block deepens, with 403 *carrying that same page*. Without the body
            // the caller could not tell "the platform wants a human" from "the post
            // is gone", and the read path reported the first as the second.
            //
            // Only a short marker check is performed; the body is never logged.
            const challenge = CHALLENGE_BODY_MARKERS.test(text)
            const code = challenge ? 'captcha' : classifyStatus(response.status)
            const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
            const failure = new PlatformError(
              challenge
                ? `平台返回了安全验证页（HTTP ${response.status}）：这是反爬控制，不是登录失效，也不是帖子被删除`
                : `平台返回 ${response.status}（${code}）`,
              code,
              { status: response.status, retryAfterMs: retryAfter },
            )
            if (!failure.retryable) throw failure
            lastError = failure
            break
          }
          return {
            status: response.status,
            url: response.url || currentUrl,
            text,
            contentType: response.headers.get('content-type') ?? '',
          }
        }
      } catch (error) {
        // A policy refusal is not a transport failure. Wrapping it would turn a
        // deliberate block into a retryable network error and hide its audit code.
        if (isEgressBlockedError(error)) throw error
        if (error instanceof PlatformError && !error.retryable) throw error
        const classified = classifyThrown(error)
        if (classified.code === 'egress_blocked') {
          throw new PlatformError(classified.message, 'egress_blocked', { cause: error })
        }
        lastError = new PlatformError(classified.message, classified.code, { cause: error })
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        await agent?.close().catch(() => undefined)
      }

      if (attempt + 1 < attempts) {
        const backoffMs = Math.min(2_000, 300 * 2 ** attempt)
        const retryAfterMs = lastError?.code === 'rate_limited'
          ? Math.min(120_000, Math.max(backoffMs, lastError.retryAfterMs ?? 0))
          : backoffMs
        await delay(retryAfterMs, options.signal)
      }
    }

    throw lastError ?? new PlatformError('请求失败且没有捕获到具体错误', 'unknown')
  }
}

/** Validate a destination before either the policy hook or fetch sees it. */
function safeHttpUrl(raw: string, base?: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw, base)
  } catch {
    throw new PlatformError('请求或重定向地址不是有效的绝对 URL', 'unknown')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PlatformError('请求或重定向使用了不安全的协议', 'unknown')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new PlatformError('请求地址不得内嵌用户名或密码', 'unknown')
  }
  // Fragments never reach the server. Removing them prevents fragment changes
  // from bypassing loop detection for the same network destination.
  parsed.hash = ''
  return parsed
}

function hasHeader(headers: Readonly<Record<string, string>>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase())
}

function removeHeader(headers: Record<string, string>, name: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key]
  }
}

/** Recognize the guard's refusal without importing its Node-only audit module. */
function isEgressBlockedError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; code?: unknown }
  return candidate.code === 'egress_blocked'
    && (candidate.name === 'EgressBlockedError' || candidate.name === 'PlatformError')
}

/** Remove credentials case-insensitively before a cross-origin redirect hop. */
function withoutCredentials(headers: Readonly<Record<string, string>>): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (
      lower !== 'cookie' &&
      lower !== 'authorization' &&
      lower !== 'proxy-authorization' &&
      lower !== 'referer' &&
      lower !== 'origin' &&
      lower !== 'host'
    ) {
      next[name] = value
    }
  }
  return next
}

/** Parse an RFC-ish `Retry-After` header into milliseconds. */
function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 120) * 1000
  const date = Date.parse(raw)
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 120_000))
  return undefined
}

/** Sleep that honors an abort signal. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new PlatformError('等待被取消', 'timeout'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // Register first, then re-check: an abort between the caller's check and
    // addEventListener must not leave a sleep that outlives its request.
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
  })
}
