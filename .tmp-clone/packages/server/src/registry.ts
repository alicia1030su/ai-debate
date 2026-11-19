/**
 * The route registry the core registers into.
 *
 * The upstream plugin called `ctx.inject(['webServer'], scope => scope.get('webServer')
 * .register(route))`. Rather than rewrite the seven route builders, the standalone
 * server implements that same two-method service and owns dispatch. Keeping the
 * shape means the core's registration code — including the ordering rules it
 * documents — runs unchanged.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface WebRoute {
  readonly kind: 'exact' | 'prefix'
  /** Absolute pathname, no trailing slash. */
  readonly path: string
  /** Owns the full response lifecycle. */
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

export class WebServerRegistry {
  readonly #routes: { route: WebRoute; order: number }[] = []
  #counter = 0

  register(route: WebRoute): () => void {
    const entry = { route, order: this.#counter++ }
    this.#routes.push(entry)
    return () => {
      const index = this.#routes.indexOf(entry)
      if (index >= 0) this.#routes.splice(index, 1)
    }
  }

  get size(): number {
    return this.#routes.length
  }

  /** Paths in registration order, for diagnostics. */
  paths(): readonly string[] {
    return this.#routes.map((entry) => `${entry.route.kind === 'exact' ? '=' : '~'}${entry.route.path}`)
  }

  /**
   * Find the handler for a pathname.
   *
   * Exact beats prefix; among prefixes the longest wins. That order matters: a
   * generic `/api/ai-debate` prefix route must not shadow `/api/ai-debate/settings`.
   */
  match(pathname: string): WebRoute | undefined {
    const normalised = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
    const exact = this.#routes
      .filter((entry) => entry.route.kind === 'exact' && entry.route.path === normalised)
      .sort((a, b) => a.order - b.order)[0]
    if (exact !== undefined) return exact.route
    const prefixed = this.#routes
      .filter(
        (entry) =>
          entry.route.kind === 'prefix' &&
          (normalised === entry.route.path || normalised.startsWith(`${entry.route.path}/`)),
      )
      .sort((a, b) => b.route.path.length - a.route.path.length || a.order - b.order)[0]
    return prefixed?.route
  }
}
