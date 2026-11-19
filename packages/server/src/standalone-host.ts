/**
 * The standalone host adapter.
 *
 * The debate engine is 40k lines that were written as a plugin. It expects a host
 * object with a handful of services: a tool registry, a system-prompt registry, a
 * logger factory, an effect scope, a lazy service lookup, scoped injection, and a
 * credential-update event. Rather than rewrite the assembly code (which owns the
 * entire business API surface, including the seven HTTP route families), this file
 * supplies exactly that surface backed by the standalone runtime.
 *
 * The contract is deliberately *narrow*. Every method here answers one question the
 * core asks, and none of them pretend to be a plugin framework:
 *
 *   - `effect(fn)` runs now and returns a disposer. The core uses it for route and
 *     tool lifetimes; a standalone process lives as long as the server does.
 *   - `inject(deps, fn)` runs `fn` immediately with a scope that resolves to the
 *     same services. All of them are present from boot, so there is nothing to wait
 *     for; the method exists so the core's registration path is unchanged.
 *   - `get(name, strict?)` never throws. A missing service is `undefined`, which is
 *     the answer the core already handles for every optional dependency.
 *   - `tools.register` collects definitions instead of publishing them to an agent.
 *     There is no agent in this product; keeping the list lets the system page
 *     report what the engine exposes, and keeps the upstream tool code compiling.
 */
import type { AuthService } from './auth.ts'
import { parseCookies, SESSION_COOKIE, isLoopback } from './auth.ts'
import type { ConfigStore } from './config-store.ts'
import type { CredentialStore } from './credential-store.ts'
import type { WebServerRegistry } from './registry.ts'

export interface StandaloneHostOptions {
  /** Hosts this deployment answers to; the trust fence uses it to reject rebinding. */
  readonly trustedHosts?: readonly string[]
  /** Facts about the listener, shown on the settings page's status tab. */
  readonly serverInfo?: () => { listen: string; port: number; dataDir: string; version: string; startedAt: string; pid: number }
  readonly config: ConfigStore
  readonly credentials: CredentialStore
  readonly auth: AuthService
  readonly registry: WebServerRegistry
  readonly dataDir: string
  readonly version: string
  readonly audit?: { write(event: 'settings.write_failed', detail?: Record<string, unknown>): void }
  readonly log: {
    debug(message: string): void
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }
}

export interface StandaloneHost {
  /** The object handed to the core's `apply`. Structurally a plugin context. */
  readonly ctx: unknown
  /** Every tool definition the engine registered, in order. */
  readonly tools: readonly { name: string }[]
  /** Route paths currently registered by the core. */
  readonly routePaths: () => readonly string[]
  /** Called when the core asks for a credential update notification. */
  emitCredentialUpdate(ref: string): void
}

/** Services the core may look up by name. */
interface Services {
  readonly appServer: unknown
  readonly settings: unknown
  readonly credentials: unknown
  readonly connection: unknown
  readonly webServer: unknown
  readonly paths: unknown
  readonly appInfo: unknown
}

export function createStandaloneHost(options: StandaloneHostOptions): StandaloneHost {
  const tools: { name: string }[] = []
  const disposers: (() => void)[] = []
  const credentialListeners: ((ref: string) => void)[] = []

  const settings = {
    writable: true,
    async update(_namespace: string, patch: Record<string, unknown>): Promise<unknown> {
      try {
        options.config.update(patch, options.log)
      } catch (error) {
        options.audit?.write('settings.write_failed', { fields: Object.keys(patch), reason: String(error) })
        throw error
      }
      return { ok: true }
    },
    async mutate(_namespace: string, operations: readonly { op: 'unset'; path: readonly string[] }[]): Promise<unknown> {
      options.config.unset(
        operations.map((operation) => operation.path),
        options.log,
      )
      return { ok: true }
    },
  }

  const connection = {
    /**
     * The core's authorizer.
     *
     * It is called for every request to the plugin-owned routes, and its answer is
     * the only thing standing between the network and a settings write. Returning
     * `undefined` means "allowed"; 401 means "no session"; 403 means "session but
     * not acceptable" (here: a request that did not come from the owner's browser).
     */
    requestRejection(request: { headers: unknown }): 401 | 403 | undefined {
      const headers = request.headers as Record<string, string | string[] | undefined>
      const cookieHeader = headers.cookie
      const cookies = parseCookies(Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader)
      const session = options.auth.validate(cookies[SESSION_COOKIE])
      if (session === undefined) return 401
      // The browser sends Origin on every cross-site request; a same-origin page
      // sends its own host. A mismatch here is a cross-site request that somehow
      // carries the cookie, which Strict mode already blocks — this is the second
      // lock, for the case where someone turns Strict off in a fork.
      const origin = headers.origin
      const host = headers.host
      if (typeof origin === 'string' && typeof host === 'string') {
        try {
          if (new URL(origin).host !== host) return 403
        } catch {
          return 403
        }
      }
      return undefined
    },
    /** Whether the caller is on this machine, used by the UI for a hint only. */
    isLocal(request: { socket?: { remoteAddress?: string } }): boolean {
      return isLoopback(request.socket?.remoteAddress)
    },
  }

  const services: Services = {
    appServer: {
      ...(options.trustedHosts === undefined ? {} : { trustedHosts: options.trustedHosts }),
      ...(options.serverInfo === undefined ? {} : { info: options.serverInfo }),
    },
    settings,
    credentials: options.credentials,
    connection,
    webServer: options.registry,
    paths: { dataDir: options.dataDir },
    appInfo: { version: options.version, name: 'AI Debate' },
  }

  const getService = (name: string): unknown => {
    if (name === 'llm') return undefined
    return (services as unknown as Record<string, unknown>)[name]
  }

  const logger = {
    debug: (message: string) => options.log.debug(message),
    info: (message: string) => options.log.info(message),
    warn: (message: string) => options.log.warn(message),
    error: (message: string) => options.log.error(message),
  }

  const ctx = {
    tools: {
      register(definition: { name: string }): () => void {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    systemPrompt: {
      // There is no agent to announce to. The section text is discarded, and the
      // listener pattern is kept so the core's registration call still works.
      section(): () => void {
        return () => undefined
      },
    },
    logger: () => logger,
    effect(execute: () => (() => void) | void): () => void {
      const dispose = execute()
      const wrapped = typeof dispose === 'function' ? dispose : () => undefined
      disposers.push(wrapped)
      return wrapped
    },
    get: getService,
    inject(_deps: string[], fn: (scope: { get: (name: string) => unknown; effect: (f: () => (() => void) | void) => () => void }) => unknown): unknown {
      const scope = {
        get: getService,
        effect: (execute: () => (() => void) | void): (() => void) => {
          const dispose = execute()
          return typeof dispose === 'function' ? dispose : () => undefined
        },
      }
      return fn(scope)
    },
    on(event: string, listener: (ref: unknown) => void): () => void {
      if (event !== 'credentials/reference-updated') return () => undefined
      credentialListeners.push(listener as (ref: string) => void)
      return () => {
        const index = credentialListeners.indexOf(listener as (ref: string) => void)
        if (index >= 0) credentialListeners.splice(index, 1)
      }
    },
  }

  return {
    ctx,
    tools,
    routePaths: () => options.registry.paths(),
    emitCredentialUpdate(ref: string): void {
      for (const listener of [...credentialListeners]) {
        try {
          listener(ref)
        } catch (error) {
          options.log.warn(`凭据更新通知的接收方抛错：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    },
  }
}
