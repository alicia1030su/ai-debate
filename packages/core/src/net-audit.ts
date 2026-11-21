/**
 * 出网守卫：把「这一次能不能访问那个地址」变成一个可检查、可留痕、可强制执行的判断。
 *
 * ## 为什么需要它
 *
 * 这个插件有两类出网：模型接口（用户自己配的，或宿主提供的）和平台接口
 * （微博 CLI、贴吧页面）。它们在**安全语义上完全不同**：
 *
 * - 模型接口：用户明确配置的目的地，允许。
 * - 平台接口：读取要授权、写入被三层禁用。手动导入模式下**一次都不该发生**。
 *
 * v0.2.35 的离线验收只能说「我们没有看到出网」——因为拦截器没有装上。空日志
 * 与「根本没有记录」在证据上是同一件事，那不是一个可以发布的安全结论。
 *
 * ## 一条判断，三个出口
 *
 * 所有出网都必须先过 {@link EgressGuard.check}：模型客户端（fetch）、平台 CLI
 * （子进程）、以及设置页的连通性测试。守卫做三件事：
 *
 * 1. **判断**：按策略决定 allow / deny，拒绝时抛 {@link EgressBlockedError}。
 * 2. **留痕**：每条判断写一行 JSONL（主机、用途、结果、原因），**不含任何
 *    header、查询串或凭据** —— 审计日志本身不能成为泄露源。
 * 3. **自检**：{@link EgressGuard.selfTest} 故意访问一个必然被拒的地址，用来
 *    证明「机制是活的」。一个从不拒绝任何请求的守卫，和一个没装上的守卫，
 *    在日志里长得一模一样。
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** 出网模式。 */
export type EgressMode =
  /** 不限制公网目的地（默认）；仅显式配置的初始模型 origin 可用本机/私网。 */
  | 'open'
  /**
   * 手动导入：只允许用户配置的模型地址与本机回环，**禁止任何平台主机**。
   * 模型传输层只对初始 origin 的显式本机/私网端点放行，重定向到其他 origin 不继承该例外。
   *
   * 这条模式存在的意义是把产品承诺写进代码：粘贴一段讨论、生成回复、复制，
   * 整个过程不应该碰微博或贴吧一个字节。
   */
  | 'manual'
  /** 完全离线：模型与平台传输层均拒绝私网/回环。用于离线验收场景。 */
  | 'offline'

/** 这次出网是为了什么。 */
export type EgressPurpose = 'model' | 'platform' | 'self-test' | 'other'

/** 一条审计记录。字段刻意少：够定位，不够泄露。 */
export interface EgressRecord {
  readonly at: string
  readonly mode: EgressMode
  readonly purpose: EgressPurpose
  readonly host: string
  readonly decision: 'allow' | 'deny'
  readonly reason: string
}

/** 被守卫拒绝时抛这个。`code` 让上层能区分「策略拒绝」与「网络故障」。 */
export class EgressBlockedError extends Error {
  readonly code = 'egress_blocked'
  readonly host: string
  readonly purpose: EgressPurpose
  readonly mode: EgressMode

  constructor(host: string, purpose: EgressPurpose, mode: EgressMode, reason: string) {
    super(`已阻止一次出网（${mode} / ${purpose}）：${host} —— ${reason}`)
    this.name = 'EgressBlockedError'
    this.host = host
    this.purpose = purpose
    this.mode = mode
  }
}

/** One validated DNS answer. The family is explicit so A and AAAA cannot be mixed accidentally. */
export interface DnsAnswer {
  readonly address: string
  readonly family: 4 | 6
}

/** Resolve exactly one address family. Injectable for tests and host-specific DNS policies. */
export type DnsResolver = (
  hostname: string,
  family: 4 | 6,
) => Promise<readonly DnsAnswer[]>

/** System resolver used by both the platform transport and the model transport. */
export const systemDnsResolver: DnsResolver = async (hostname, family) => {
  const answers = await lookup(hostname, { family, all: true, verbatim: true })
  return answers.map((answer) => ({ address: answer.address, family: answer.family as 4 | 6 }))
}

const ipv4 = (address: string): readonly [number, number, number, number] | undefined => {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const octets = parts.map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined
  return octets as [number, number, number, number]
}

const ipv4PrivateEndpoint = (address: string): boolean => {
  const parts = ipv4(address)
  if (parts === undefined) return false
  const [a, b] = parts
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

const ipv4Blocked = (address: string): boolean => {
  const parts = ipv4(address)
  if (parts === undefined) return false
  const [a, b] = parts
  return (
    ipv4PrivateEndpoint(address) ||
    a === 0 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 2) ||
    (a === 192 && b === 88 && parts[2] === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113)
  )
}

/** Expand IPv6 (including dotted IPv4 tails) into eight 16-bit words. */
const ipv6Words = (address: string): readonly number[] | undefined => {
  let normalized = address.toLowerCase().split('%', 1)[0] ?? ''
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
  if (dotted !== null) {
    const parts = ipv4(dotted[1] ?? '')
    if (parts === undefined) return undefined
    normalized = `${normalized.slice(0, dotted.index)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`
  }
  const halves = normalized.split('::')
  if (halves.length > 2) return undefined
  const parseHalf = (half: string): number[] | undefined => {
    if (half === '') return []
    const words: number[] = []
    for (const part of half.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined
      words.push(Number.parseInt(part, 16))
    }
    return words
  }
  const left = parseHalf(halves[0] ?? '')
  const right = halves.length === 2 ? parseHalf(halves[1] ?? '') : []
  if (left === undefined || right === undefined) return undefined
  if (halves.length === 1) return left.length === 8 ? left : undefined
  if (left.length + right.length >= 8) return undefined
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right]
}

const ipv4OfTwoWords = (high: number | undefined, low: number | undefined): string =>
  `${(high ?? 0) >> 8}.${(high ?? 0) & 255}.${(low ?? 0) >> 8}.${(low ?? 0) & 255}`

const ipv4OfWords = (words: readonly number[]): string | undefined => {
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
  const translated = words.slice(0, 4).every((word) => word === 0) && words[4] === 0xffff && words[5] === 0
  const compatible = words.slice(0, 6).every((word) => word === 0)
  if (!mapped && !translated && !compatible) return undefined
  return ipv4OfTwoWords(words[6], words[7])
}

const ipv6Blocked = (address: string): boolean => {
  const words = ipv6Words(address)
  if (words === undefined) return true
  if (words.every((word) => word === 0)) return true
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true

  // IPv4-mapped, translated and compatible IPv6 must be judged as IPv4.
  const embedded = ipv4OfWords(words)
  if (embedded !== undefined) return ipv4Blocked(embedded)

  const first = words[0] ?? 0
  // 6to4 and the well-known NAT64 prefix carry an IPv4 destination in the tail.
  if (first === 0x2002 && ipv4Blocked(ipv4OfTwoWords(words[1], words[2]))) return true
  if (
    first === 0x64 && words[1] === 0xff9b &&
    words.slice(2, 6).every((word) => word === 0) &&
    ipv4Blocked(ipv4OfTwoWords(words[6], words[7]))
  ) return true
  // Teredo obfuscates the client IPv4 address by XORing every bit with one.
  if (first === 0x2001 && words[1] === 0) {
    const server = ipv4OfTwoWords(words[2], words[3])
    const client = ipv4OfTwoWords((words[6] ?? 0) ^ 0xffff, (words[7] ?? 0) ^ 0xffff)
    if (ipv4Blocked(server) || ipv4Blocked(client)) return true
  }

  // fc00::/7, fe80::/10, fec0::/10, multicast, and the documentation prefix.
  return (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && words[1] === 0x0db8)
  )
}

/** Whether an address is loopback, including expanded and IPv4-mapped IPv6. */
export function isLoopbackAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '')
  const parts = ipv4(host)
  if (parts !== undefined) return parts[0] === 127
  const words = ipv6Words(host)
  if (words === undefined) return false
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true
  const embedded = ipv4OfWords(words)
  return embedded !== undefined && ipv4(embedded)?.[0] === 127
}

/**
 * Whether an address is an explicitly configurable local/private model destination.
 * Link-local, metadata, multicast and documentation addresses remain forbidden.
 */
export function isPrivateEndpointAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (isIP(host) === 4) return ipv4PrivateEndpoint(host)
  if (isIP(host) !== 6) return false
  if (isLoopbackAddress(host)) return true
  const words = ipv6Words(host)
  if (words === undefined) return false
  if (((words[0] ?? 0) & 0xfe00) === 0xfc00) return true
  const embedded = ipv4OfWords(words)
  return embedded !== undefined && ipv4PrivateEndpoint(embedded)
}

/**
 * Whether an IP is forbidden for untrusted egress.
 *
 * The list is deliberately fail-closed for local, private, carrier-grade NAT and
 * metadata ranges. It is shared by literal-URL checks and the socket lookup, so a
 * hostname cannot pass one check and resolve to a different class of address at
 * connection time.
 */
export function isBlockedNetworkAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (isIP(host) === 4) return ipv4Blocked(host)
  if (isIP(host) === 6) return ipv6Blocked(host)
  // Unknown address formats are never safe to connect to.
  return true
}

/** Options for resolving and validating every A/AAAA answer before a socket opens. */
export interface ResolveNetworkHostOptions {
  readonly resolver?: DnsResolver
  /** Only for an explicitly configured local model endpoint; every answer must be loopback. */
  readonly allowLoopback?: boolean
  /** Only for the configured initial model origin; permits loopback/RFC1918/CGNAT/ULA, never metadata. */
  readonly allowPrivateEndpoint?: boolean
  readonly purpose?: EgressPurpose
  readonly mode?: EgressMode
}

/** Apply the destination class policy to a complete, family-validated answer set. */
function assertAllowedAnswers(
  host: string,
  answers: readonly DnsAnswer[],
  options: ResolveNetworkHostOptions,
): void {
  const purpose = options.purpose ?? 'other'
  const mode = options.mode ?? 'open'
  if (options.allowPrivateEndpoint === true) {
    const allPrivate = answers.every((answer) => isPrivateEndpointAddress(answer.address))
    const allPublic = answers.every((answer) => !isBlockedNetworkAddress(answer.address))
    if (!allPrivate && !allPublic) {
      throw new EgressBlockedError(
        host,
        purpose,
        mode,
        '显式模型端点的 DNS 答案必须全部为本机/私网或全部为公网，不能混合或包含元数据/链路本地地址',
      )
    }
    return
  }
  if (options.allowLoopback === true) {
    if (!answers.every((answer) => isLoopbackAddress(answer.address))) {
      throw new EgressBlockedError(host, purpose, mode, '本机模型端点不得解析到非回环地址')
    }
    return
  }
  const unsafe = answers.find((answer) => isBlockedNetworkAddress(answer.address))
  if (unsafe !== undefined) {
    throw new EgressBlockedError(host, purpose, mode, `拒绝私网、回环、链路本地或元数据地址 ${unsafe.address}`)
  }
}

/**
 * Resolve both address families and reject the host if any answer is unsafe.
 *
 * A missing family (`ENOTFOUND`) is normal for an IPv4-only or IPv6-only host.
 * Any other resolver failure fails closed rather than silently using a partial
 * answer set. Returned answers are the exact addresses the transport must pin.
 */
export async function resolveNetworkHost(
  hostname: string,
  options: ResolveNetworkHostOptions = {},
): Promise<readonly DnsAnswer[]> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const purpose = options.purpose ?? 'other'
  const mode = options.mode ?? 'open'
  const resolver = options.resolver ?? systemDnsResolver
  const literalFamily = isIP(host)
  let answers: readonly DnsAnswer[]

  if (literalFamily !== 0) {
    answers = [{ address: host, family: literalFamily as 4 | 6 }]
  } else {
    const settled = await Promise.allSettled([
      resolver(host, 4),
      resolver(host, 6),
    ])
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as NodeJS.ErrnoException | undefined)
    const unexpected = failures.find((failure) => failure?.code !== 'ENOTFOUND')
    if (unexpected !== undefined) throw unexpected
    if (settled.every((result) => result.status === 'rejected')) {
      throw failures[0] ?? new Error(`DNS 解析失败：${host}`)
    }
    answers = settled.flatMap((result) => result.status === 'fulfilled' ? [...result.value] : [])
    if (answers.length === 0) throw failures[0] ?? new Error(`DNS 没有返回可用地址：${host}`)
  }

  for (const answer of answers) {
    if (isIP(answer.address) !== answer.family) {
      throw new EgressBlockedError(host, purpose, mode, `DNS 返回了无效的 IPv${answer.family} 地址`)
    }
  }
  assertAllowedAnswers(host, answers, options)
  return [...new Map(answers.map((answer) => [`${answer.family}:${answer.address}`, answer])).values()]
}

interface AgentConstructor {
  new (options: {
    connect: {
      lookup: (
        hostname: string,
        options: { family?: number; all?: boolean },
        callback: (
          error: NodeJS.ErrnoException | null,
          addressOrAddresses: string | DnsAnswer | readonly DnsAnswer[],
          family?: 4 | 6,
        ) => void,
      ) => void
    }
  }): {
    close: () => Promise<void>
  }
}

const nativeFetch: typeof fetch = globalThis.fetch
const UNDICI_DISPATCHER = Symbol.for('undici.globalDispatcher.1')

/** Per-host policy used by the connection-time resolver. */
export interface PinnedHostOptions {
  readonly resolver?: DnsResolver
  readonly allowLoopback?: boolean
  readonly allowPrivateEndpoint?: boolean
  readonly purpose?: EgressPurpose
  readonly mode?: EgressMode
}

interface PinnedHost {
  options: PinnedHostOptions
  values: readonly DnsAnswer[] | undefined
  pending: Promise<readonly DnsAnswer[]> | undefined
  pinned: boolean
}

/**
 * An Undici Agent that resolves and validates all A/AAAA answers at the first
 * real socket lookup, then pins that exact set for every later connection.
 *
 * Node bundles Undici inside `fetch` but does not expose it as an installable
 * package. Reusing the global fetch Agent constructor avoids a dependency while
 * preserving Host/SNI. Failure to create this Agent is fatal: silently falling
 * back to system lookup would reintroduce DNS rebinding.
 */
export class PinnedDnsAgent {
  readonly pinned = true
  private readonly dispatcher: { close: () => Promise<void> }
  private readonly hosts = new Map<string, PinnedHost>()

  private constructor(dispatcher: { close: () => Promise<void> }, hosts: Map<string, PinnedHost>) {
    this.dispatcher = dispatcher
    this.hosts = hosts
  }

  /** Create the agent, initializing Node's bundled fetch dispatcher when necessary. */
  static async create(
    hostname = '<unknown>',
    purpose: EgressPurpose = 'other',
    mode: EgressMode = 'open',
  ): Promise<PinnedDnsAgent> {
    let globalDispatcher = (globalThis as unknown as Record<symbol, unknown>)[UNDICI_DISPATCHER] as
      | { constructor?: unknown }
      | undefined
    if (globalDispatcher === undefined) {
      // A data URL performs no network I/O but initializes Node's fetch dispatcher.
      try {
        const warmup = await nativeFetch('data:text/plain,')
        await warmup.arrayBuffer()
      } catch (error) {
        throw new EgressBlockedError(hostname, purpose, mode, `无法初始化固定 DNS 的 Undici Agent：${String(error)}`)
      }
      globalDispatcher = (globalThis as unknown as Record<symbol, unknown>)[UNDICI_DISPATCHER] as
        | { constructor?: unknown }
        | undefined
    }
    const Agent = globalDispatcher?.constructor as AgentConstructor | undefined
    if (typeof Agent !== 'function') {
      throw new EgressBlockedError(hostname, purpose, mode, '当前环境不提供可固定 DNS 的 Undici Agent，已拒绝出网')
    }

    const hosts = new Map<string, PinnedHost>()
    let instance: { close: () => Promise<void> }
    try {
      instance = new Agent({
        connect: {
          lookup: (requestedHost, lookupOptions, callback): void => {
            const host = requestedHost.toLowerCase().replace(/^\[|\]$/g, '')
            const entry = hosts.get(host)
            if (entry === undefined) {
              callback(Object.assign(new Error(`没有为 ${host} 配置连接期 DNS 校验`), { code: 'ENOTFOUND' }), [])
              return
            }
            // The first socket lookup resolves and pins both families. Concurrent
            // lookups share that work; every later socket reuses the exact answers.
            const resolve = entry.values === undefined
              ? entry.pending ??= resolveNetworkHost(host, {
                resolver: entry.options.resolver,
                allowLoopback: entry.options.allowLoopback,
                allowPrivateEndpoint: entry.options.allowPrivateEndpoint,
                purpose: entry.options.purpose,
                mode: entry.options.mode,
              }).then((answers) => {
                entry.values = answers
                return answers
              }).finally(() => {
                entry.pending = undefined
              })
              : Promise.resolve(entry.values)

            void resolve.then((answers) => {
              const family = lookupOptions.family === 6 ? 6 : lookupOptions.family === 4 ? 4 : undefined
              try {
                // Redirects can tighten the policy without changing the pinned
                // destinations, so re-check the complete set before selecting.
                assertAllowedAnswers(host, answers, entry.options)
              } catch (error) {
                callback(error as NodeJS.ErrnoException, [])
                return
              }
              const selected = answers.filter((answer) => family === undefined || answer.family === family)
              if (selected.length === 0) {
                callback(Object.assign(new Error(`没有 IPv${family} 的已验证地址`), { code: 'ENOTFOUND' }), [])
                return
              }
              if (lookupOptions.all === true) callback(null, selected)
              else callback(null, selected[0]?.address ?? '', selected[0]?.family)
              entry.pinned = true
            }).catch((error: unknown) => {
              callback(error as NodeJS.ErrnoException, [])
            })
          },
        },
      })
    } catch (error) {
      throw new EgressBlockedError(hostname, purpose, mode, `无法创建固定 DNS 的 Undici Agent：${String(error)}`)
    }
    return new PinnedDnsAgent(instance, hosts)
  }

  /** Register the resolver/policy for a hostname; answers are pinned only at socket lookup. */
  remember(hostname: string, options: PinnedHostOptions = {}): void {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const existing = this.hosts.get(host)
    if (existing === undefined) {
      this.hosts.set(host, { options: { ...options }, values: undefined, pending: undefined, pinned: false })
    } else {
      // Keep already pinned values across redirects, but apply the strictest
      // current policy when the socket lookup selects from them.
      existing.options = { ...options }
    }
  }

  /** Whether this hostname has completed at least one validated socket lookup. */
  isPinned(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return this.hosts.get(host)?.pinned === true
  }

  /** Undici accepts this non-standard RequestInit field on Node's native fetch. */
  get dispatcherOption(): unknown {
    return this.dispatcher
  }

  /** Close idle sockets after the response body has been consumed. */
  async close(): Promise<void> {
    await this.dispatcher.close()
  }
}

/** 守卫需要的策略。 */
export interface EgressPolicy {
  readonly mode: EgressMode
  /**
   * 允许的主机（精确匹配，含端口通配）。
   *
   * 只放模型地址，不放平台地址：平台地址由 {@link PLATFORM_HOSTS} 单独识别，
   * 它们在 `manual` / `offline` 下一律拒绝，写进白名单也无效 —— 否则一次
   * 配置失误就能让「手动导入不碰平台」这条承诺失效。
   */
  readonly allowedHosts: readonly string[]
  /**
   * Exact configured model origins. Only the initial request at one of these
   * origins may use the local/private endpoint exception; redirects cannot.
   */
  readonly allowedOrigins?: readonly string[]
}

/** 平台主机：出现在这里的地址在 manual / offline 下一律拒绝。 */
export const PLATFORM_HOSTS: readonly RegExp[] = [
  /(^|\.)weibo\.com$/i,
  /(^|\.)weibo\.cn$/i,
  /(^|\.)sina\.com\.cn$/i,
  /(^|\.)baidu\.com$/i,
  /(^|\.)tieba\.com$/i,
]

/** 本机回环：策略层识别主机名；传输层仍会校验解析出的具体地址。 */
function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host.endsWith('.localhost') || isLoopbackAddress(host)
}

/** Model fetch follows at most five redirects, matching the platform transport. */
const MAX_MODEL_REDIRECTS = 5
const MODEL_REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** Validate a model URL before either policy or DNS checks see it. */
function modelUrl(raw: string, mode: EgressMode): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new EgressBlockedError(raw, 'model', mode, '模型请求地址不是有效的绝对 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EgressBlockedError(parsed.hostname, 'model', mode, '模型请求使用了不安全的协议')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new EgressBlockedError(parsed.hostname, 'model', mode, '模型请求地址不得内嵌用户名或密码')
  }
  parsed.hash = ''
  return parsed.href
}

/** Remove credentials and origin-bearing headers before a cross-origin model redirect. */
function stripModelCredentials(headers: Headers): void {
  for (const name of ['authorization', 'cookie', 'proxy-authorization', 'referer', 'origin', 'host']) {
    headers.delete(name)
  }
}

/** Find an egress refusal wrapped by native fetch/Undici without losing its code. */
function findEgressBlockedError(error: unknown): EgressBlockedError | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as { name?: unknown; code?: unknown; cause?: unknown }
    if (candidate.code === 'egress_blocked' && candidate.name === 'EgressBlockedError') {
      return current as EgressBlockedError
    }
    current = candidate.cause
  }
  return undefined
}

/** 主机是否是平台。 */
export function isPlatformHost(hostname: string): boolean {
  return PLATFORM_HOSTS.some((pattern) => pattern.test(hostname))
}

/** 从 URL 里取主机名，解析失败返回空串。 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** 审计落盘。写入失败不抛：审计坏了不该让一次生成失败。 */
export class EgressLog {
  private readonly path: string | undefined
  private readonly memory: EgressRecord[] = []
  private readonly maxMemory: number

  constructor(path?: string, maxMemory = 2000) {
    this.path = path
    this.maxMemory = maxMemory
    if (path !== undefined) {
      try {
        mkdirSync(dirname(path), { recursive: true })
      } catch {
        // 目录建不出来时只留内存记录：报告会说明「没有落盘」，不会假装写过。
      }
    }
  }

  record(entry: EgressRecord): void {
    this.memory.push(entry)
    if (this.memory.length > this.maxMemory) this.memory.splice(0, this.memory.length - this.maxMemory)
    if (this.path === undefined) return
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      // 见上：审计写入失败不升级成业务失败。
    }
  }

  /** 内存里的记录（最近 maxMemory 条）。 */
  entries(): readonly EgressRecord[] {
    return [...this.memory]
  }

  /** 审计文件路径，没有落盘时为 undefined。 */
  filePath(): string | undefined {
    return this.path
  }

  /** 读回落盘内容，用于验收脚本自己核对（不是产品逻辑）。 */
  readBack(): EgressRecord[] {
    if (this.path === undefined || !existsSync(this.path)) return []
    const out: EgressRecord[] = []
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line) as EgressRecord)
      } catch {
        // 半行（进程被杀时）跳过。
      }
    }
    return out
  }
}

/** 守卫本体。 */
export class EgressGuard {
  private readonly policy: EgressPolicy
  private readonly log: EgressLog
  private readonly resolver: DnsResolver

  constructor(policy: EgressPolicy, log: EgressLog, options: { resolver?: DnsResolver } = {}) {
    this.policy = policy
    this.log = log
    this.resolver = options.resolver ?? systemDnsResolver
  }

  mode(): EgressMode {
    return this.policy.mode
  }

  /**
   * 判断一次出网。
   *
   * @param url 目标地址；无法解析时按「未知主机」拒绝（`offline`/`manual`）或放行（`open`）。
   */
  check(url: string, purpose: EgressPurpose): { readonly host: string } {
    const host = hostnameOf(url)
    const verdict = this.decide(host, purpose)
    this.log.record({
      at: new Date().toISOString(),
      mode: this.policy.mode,
      purpose,
      host: host === '' ? '<unparsable>' : host,
      decision: verdict.allowed ? 'allow' : 'deny',
      reason: verdict.reason,
    })
    if (!verdict.allowed) {
      throw new EgressBlockedError(host === '' ? url : host, purpose, this.policy.mode, verdict.reason)
    }
    return { host }
  }

  /** 纯判断，不写日志 —— 供不需要留痕的预检使用。 */
  decide(host: string, purpose: EgressPurpose): { readonly allowed: boolean; readonly reason: string } {
    const mode = this.policy.mode
    if (mode === 'open') return { allowed: true, reason: 'open 模式不限制出网' }

    const loopback = isLoopback(host)

    // 平台主机先判：即使有人把它写进 allowedHosts，manual / offline 也不放行。
    if (isPlatformHost(host)) {
      return { allowed: false, reason: `${mode} 模式禁止访问平台主机` }
    }
    if (mode === 'offline') {
      return { allowed: false, reason: 'offline 模式禁止模型与平台访问私网/回环' }
    }
    if (loopback) return { allowed: true, reason: '本机回环' }
    // manual：只放模型用途 + 白名单里的主机。平台请求不能借用模型白名单。
    if (purpose === 'model' && this.policy.allowedHosts.some((entry) => entry.toLowerCase() === host.toLowerCase())) {
      return { allowed: true, reason: '手动导入模式下允许的模型地址' }
    }
    return { allowed: false, reason: 'manual 模式只允许配置的模型地址与本机回环' }
  }

  /**
   * Wrap model fetch with policy checks, DNS pinning and manual redirects.
   *
   * Every redirect is new egress. Credentials never cross origins, request
   * bodies are never replayed by 307/308 to another origin, and TLS is never
   * downgraded. In open/manual mode, an explicitly configured initial model
   * origin may resolve to loopback/RFC1918/CGNAT/ULA. Redirects never inherit
   * that exception, and offline mode always refuses private destinations.
   */
  fetch(base: typeof fetch = fetch): typeof fetch {
    const guarded = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input, init)
      request.signal.throwIfAborted()
      let currentUrl = modelUrl(request.url, this.policy.mode)
      const initialOrigin = new URL(currentUrl).origin
      let currentMethod = request.method.toUpperCase()
      let currentBody: Uint8Array | undefined = request.body === null
        ? undefined
        : new Uint8Array(await request.arrayBuffer())
      const requestHeaders = new Headers(request.headers)
      const visited = new Set<string>()
      const initialHost = new URL(currentUrl).hostname
      const agent = await PinnedDnsAgent.create(initialHost, 'model', this.policy.mode)
      const configuredOrigin = this.policy.allowedOrigins === undefined
        ? this.policy.allowedHosts.some((host) => host.toLowerCase() === initialHost.toLowerCase())
        : this.policy.allowedOrigins.includes(initialOrigin)
      let finalResponse: Response | undefined

      try {
        for (let hop = 0; ; hop += 1) {
          if (hop > MAX_MODEL_REDIRECTS) {
            throw new EgressBlockedError(currentUrl, 'model', this.policy.mode, `模型重定向超过 ${MAX_MODEL_REDIRECTS} 次`)
          }
          if (visited.has(currentUrl)) {
            throw new EgressBlockedError(currentUrl, 'model', this.policy.mode, '检测到模型 HTTP 重定向循环')
          }
          visited.add(currentUrl)

          const current = new URL(currentUrl)
          this.check(currentUrl, 'model')
          const allowPrivateEndpoint =
            this.policy.mode !== 'offline' &&
            configuredOrigin &&
            current.origin === initialOrigin
          try {
            if (!agent.isPinned(current.hostname)) {
              await resolveNetworkHost(current.hostname, {
                resolver: this.resolver,
                allowPrivateEndpoint,
                purpose: 'model',
                mode: this.policy.mode,
              })
            }
          } catch (error) {
            if (error instanceof EgressBlockedError) this.recordNetworkDenial(current.hostname, error)
            throw error
          }
          agent.remember(current.hostname, {
            resolver: this.resolver,
            allowPrivateEndpoint,
            purpose: 'model',
            mode: this.policy.mode,
          })
          request.signal.throwIfAborted()

          let response: Response
          try {
            response = await base(currentUrl, {
              method: currentMethod,
              headers: requestHeaders,
              body: currentBody,
              redirect: 'manual',
              signal: request.signal,
              dispatcher: agent.dispatcherOption,
            } as RequestInit)
          } catch (error) {
            const blocked = findEgressBlockedError(error)
            if (blocked !== undefined) {
              const refusal = new EgressBlockedError(
                current.hostname,
                'model',
                this.policy.mode,
                `连接期 DNS 校验拒绝：${blocked.message}`,
              )
              this.recordNetworkDenial(current.hostname, refusal)
              throw refusal
            }
            throw error
          }
          const redirecting = MODEL_REDIRECT_STATUSES.has(response.status)
          const location = response.headers.get('location')
          if (redirecting && (location === null || location.trim() === '')) {
            throw new EgressBlockedError(currentUrl, 'model', this.policy.mode, '模型重定向响应缺少 Location')
          }
          const nextUrl = redirecting
            ? modelUrl(new URL(location as string, currentUrl).href, this.policy.mode)
            : undefined

          if (redirecting && nextUrl !== undefined) {
            const sameOrigin = new URL(nextUrl).origin === current.origin
            if (current.protocol === 'https:' && new URL(nextUrl).protocol === 'http:') {
              throw new EgressBlockedError(nextUrl, 'model', this.policy.mode, '拒绝模型请求从 HTTPS 降级到 HTTP')
            }
            if (!sameOrigin) {
              stripModelCredentials(requestHeaders)
              if ((response.status === 307 || response.status === 308) && currentBody !== undefined) {
                throw new EgressBlockedError(nextUrl, 'model', this.policy.mode, '拒绝把模型请求体跨域重定向')
              }
              // The pinned Agent re-resolves and validates this new hostname at
              // its first socket lookup; credentials have already been removed.
            }
            if (
              currentMethod === 'POST' &&
              (response.status === 301 || response.status === 302 || response.status === 303)
            ) {
              currentMethod = 'GET'
              currentBody = undefined
              requestHeaders.delete('content-type')
              requestHeaders.delete('content-length')
            }
            void response.body?.cancel().catch(() => undefined)
            currentUrl = nextUrl
            continue
          }

          finalResponse = response
          return response
        }
      } finally {
        if (finalResponse?.body != null) {
          // Preserve the original Response (including url/status/headers) while
          // releasing the pinned agent after its body has actually been read.
          void finalResponse.clone().arrayBuffer().then(
            () => agent.close(),
            () => agent.close(),
          ).catch(() => undefined)
        } else {
          await agent.close().catch(() => undefined)
        }
      }
    }
    return guarded as typeof fetch
  }

  /** Record a DNS/literal-address refusal that happened after the policy check. */
  private recordNetworkDenial(host: string, error: EgressBlockedError): void {
    this.log.record({
      at: new Date().toISOString(),
      mode: this.policy.mode,
      purpose: 'model',
      host,
      decision: 'deny',
      reason: error.message,
    })
  }

  /**
   * 子进程出网预检。
   *
   * CLI 的网络在它自己的进程里，守卫拦不到它的 socket —— 所以这里拦的是**启动**
   * 这件事：在 manual / offline 模式下，平台 CLI 一次都不许起来。这比「起来了
   * 但没发请求」更强，也更容易验证：进程没起来，就不可能有流量。
   */
  assertSpawn(purpose: EgressPurpose, label: string): void {
    const verdict = this.decide('platform.invalid', purpose)
    // 上面那次判断只是借道拿策略；这里真正要问的是「这个模式允许平台动作吗」。
    void verdict
    const mode = this.policy.mode
    if (mode === 'open') return
    this.log.record({
      at: new Date().toISOString(),
      mode,
      purpose,
      host: `<spawn:${label}>`,
      decision: 'deny',
      reason: `${mode} 模式禁止启动平台进程`,
    })
    throw new EgressBlockedError(`<spawn:${label}>`, purpose, mode, `${mode} 模式禁止启动平台进程`)
  }

  /**
   * 自检：故意访问一个必然被拒的地址。
   *
   * 用 `.invalid` 顶级域：RFC 2606 保留，永远不解析。所以这里不是「碰运气访问
   * 一个外部站点看会不会超时」，而是一次**确定会被策略拒绝**的尝试。
   *
   * 返回 `blocked: true` 才说明守卫是活的。`open` 模式下它会走到 DNS 并失败，
   * 那也算「没有拦住」—— 报告必须如实写，而不是把它算成通过。
   */
  async selfTest(base?: typeof fetch): Promise<{
    readonly blocked: boolean
    readonly mode: EgressMode
    readonly host: string
    readonly reason: string
  }> {
    const host = 'network-boundary.invalid'
    const url = `https://${host}/self-test`
    try {
      this.check(url, 'self-test')
    } catch (error) {
      return {
        blocked: true,
        mode: this.policy.mode,
        host,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
    // 没被拦：用真 fetch 证明这次「放行」确实会出网（而不是守卫静默返回）。
    try {
      await (base ?? fetch)(url, { method: 'HEAD' })
      return { blocked: false, mode: this.policy.mode, host, reason: '请求被放行并已发出' }
    } catch (error) {
      return {
        blocked: false,
        mode: this.policy.mode,
        host,
        reason: `策略放行了这次请求（之后网络失败：${(error as Error).message}）`,
      }
    }
  }
}

/** 从配置构造策略。 */
export function egressPolicyOf(input: {
  readonly mode: EgressMode
  readonly llmBaseUrl: string
}): EgressPolicy {
  const hosts: string[] = []
  const origins: string[] = []
  try {
    const parsed = new URL(input.llmBaseUrl)
    if (parsed.hostname !== '') hosts.push(parsed.hostname)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origins.push(parsed.origin)
  } catch {
    // Invalid configuration contributes no allowed destination.
  }
  return { mode: input.mode, allowedHosts: hosts, allowedOrigins: origins }
}
