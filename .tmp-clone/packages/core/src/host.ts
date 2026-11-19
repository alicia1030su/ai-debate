/**
 * Minimal structural types for the services this engine uses.
 *
 * They are declared here rather than imported from a host package so the
 * package compiles and packs without depending on a specific runtime build,
 * while still being exact about what is called. Anything not declared here is
 * not used.
 *
 * Two of these (`tools`, `systemPrompt`) are required by {@link PluginContext}
 * and supplied by the standalone server as real in-memory registries — the
 * engine registers its nine tools into them exactly as it did inside a host.
 * The rest are optional, and their absence has a defined meaning everywhere it
 * is consumed.
 */

/** A content block the chat can render. */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }

/** A JSON Schema node, as the tool registry accepts it. */
export interface JsonSchemaNode {
  type?: string
  description?: string
  enum?: readonly (string | number | boolean)[]
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  required?: readonly string[]
  additionalProperties?: boolean
  default?: unknown
  minimum?: number
  maximum?: number
  oneOf?: readonly JsonSchemaNode[]
}

/** The context handed to a tool's `execute`. */
export interface ToolRunContext {
  readonly signal?: AbortSignal
  readonly callId?: string
  deferContext?: (context: unknown) => void
  concludeTurn?: () => void
}

/** A tool definition, matching the Harness contract. */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchemaNode
  readonly output: {
    readonly schema: JsonSchemaNode
    render(args: unknown, value: unknown): ContentBlock[]
    presentationMeta?(args: unknown, value: unknown): unknown
  }
  execute(args: unknown, context: ToolRunContext): Promise<unknown>
  readonly timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  presentCall?(args: unknown): unknown
  presentResult?(args: unknown, result: unknown): unknown
}

/** The `tools` service. */
export interface ToolsService {
  register(definition: ToolDefinition): () => void
}

/** The `systemPrompt` service. */
export interface SystemPromptService {
  section(options: { name: string; order: number; text: string }): () => void
}

/** A logger compatible with the Harness logger. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** The `webServer` route shape (structural: only `register` is used). */
export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: unknown, res: unknown) => void | Promise<void>
  }): () => void
}

/**
 * Facts the standalone server exposes about itself.
 *
 * Optional, and deliberately structural: the engine can be mounted by a test
 * context that has none of this, in which case the settings page simply cannot
 * say which instance it is looking at. It exists so the *listener* owns the
 * answers that only the listener knows — which hostnames it answers to (the
 * trust fence's input) and where it is listening.
 *
 * A service rather than extra `apply()` arguments: `apply(ctx, config)` is the
 * one entry point, and threading server facts through it would make the engine's
 * API depend on the HTTP shell it happens to run under.
 */
export interface AppServerService {
  /**
   * Hostnames the HTTP listener answers to, e.g. `['127.0.0.1', 'localhost']`.
   *
   * The engine refuses a settings request whose `Host` is not in this list, so a
   * server bound to a real interface must say which name it is served under.
   */
  readonly trustedHosts?: readonly string[]
  /** Listener facts for the status panel. */
  info?(): {
    readonly listen: string
    readonly port: number
    readonly dataDir: string
    readonly version: string
    readonly startedAt: string
    readonly pid: number
  }
}

/**
 * Locate the optional server facets on a context.
 *
 * Both readings are tolerated — `ctx.get('appServer')` and a plain
 * `ctx.appServer` property — because the standalone context is hand-built and the
 * engine must not require it to implement a service registry it does not need.
 * Every failure mode is "absent", never a throw: a context without server facts
 * is a valid context.
 *
 * @param ctx the engine context
 * @returns the facets, or `undefined` when this context has none
 */
export function appServerOf(ctx: unknown): AppServerService | undefined {
  if (ctx === null || typeof ctx !== 'object') return undefined
  const record = ctx as Record<string, unknown>

  const usable = (value: unknown): value is AppServerService => {
    if (value === null || typeof value !== 'object') return false
    const candidate = value as AppServerService
    if (candidate.trustedHosts !== undefined && !Array.isArray(candidate.trustedHosts)) return false
    if (candidate.info !== undefined && typeof candidate.info !== 'function') return false
    return true
  }

  try {
    if (usable(record.appServer)) return record.appServer
  } catch {
    // A proxy that throws on an undeclared property means "no such service".
  }

  const get = record.get
  if (typeof get === 'function') {
    try {
      const service = (get as (name: string, strict?: boolean) => unknown).call(ctx, 'appServer', false)
      if (usable(service)) return service
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * A scope handed to `ctx.inject(deps, fn)`.
 *
 * Inside it the named services are guaranteed active, so `get` is a plain lookup
 * rather than a may-be-undefined probe. `effect` ties cleanup to that scope, which
 * is what makes "register routes when the webserver appears, drop them when it
 * goes away" a one-liner instead of a lifecycle the plugin has to track itself.
 */
export interface InjectableScope {
  get?: (name: string) => unknown
  effect?: (execute: () => (() => void) | void, label?: string) => () => void
}

/** The plugin context this plugin actually uses. */
export interface PluginContext {
  readonly tools: ToolsService
  readonly systemPrompt: SystemPromptService
  readonly logger?: (name: string) => Logger
  readonly effect?: (execute: () => (() => void) | void, label?: string) => () => void
  /** Present on recent Harness builds; used when the plugin is mounted in a scope. */
  readonly get?: (name: string) => unknown
  /**
   * Scoped injection: runs `fn` once every named service is active, and again if
   * one is replaced. Present on the Cordis builds this plugin targets.
   */
  readonly inject?: (deps: string[], fn: (scope: InjectableScope) => void) => unknown
}

/** Read a logger from a context, tolerating contexts without one. */
export function loggerOf(ctx: PluginContext, name: string): Logger {
  if (typeof ctx.logger === 'function') return ctx.logger(name)
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }
}
