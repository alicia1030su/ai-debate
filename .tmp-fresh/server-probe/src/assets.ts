/**
 * Static assets, from inside the executable or from the source tree.
 *
 * A packaged build embeds the console in the binary (SEA assets, keyed
 * `web/<path>`); a development run reads `packages/web/static` from disk. Both
 * answer the same question, so the HTTP layer never learns which one it is
 * talking to.
 *
 * The `node:sea` import is dynamic on purpose: the module does not exist in a
 * non-SEA Node, and a static import would make every development run fail with
 * an unrelated error.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

export interface Asset {
  readonly body: Buffer
  readonly type: string
  readonly immutable: boolean
}

type SeaApi = { isSea?: () => boolean; getAsset?: (key: string) => ArrayBuffer | string }

let seaPromise: Promise<SeaApi | undefined> | undefined

async function sea(): Promise<SeaApi | undefined> {
  if (seaPromise === undefined) {
    seaPromise = (async () => {
      try {
        const module = (await import('node:sea')) as unknown as SeaApi
        if (typeof module.isSea === 'function' && module.isSea() && typeof module.getAsset === 'function') return module
        return undefined
      } catch {
        return undefined
      }
    })()
  }
  return seaPromise
}

/** Every asset key embedded in the binary, or the files present on disk. */
async function manifest(diskRoot: string | undefined): Promise<readonly string[]> {
  const api = await sea()
  if (api !== undefined) {
    const raw = api.getAsset?.('web/manifest.json')
    if (raw === undefined) return []
    try {
      const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
      const parsed = JSON.parse(text) as { assets?: unknown }
      return Array.isArray(parsed.assets) ? parsed.assets.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  }
  if (diskRoot === undefined || !existsSync(diskRoot)) return []
  const keys: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else keys.push(`web/${normalize(full.slice(diskRoot.length + 1)).split(sep).join('/')}`)
    }
  }
  walk(diskRoot)
  return keys
}

export class AssetStore {
  readonly #diskRoot: string | undefined
  #keys: readonly string[] | undefined

  constructor(options: { diskRoot?: string | undefined }) {
    this.#diskRoot = options.diskRoot
  }

  /** Load the key list once; a missing manifest is a startup failure, not a 404. */
  async init(): Promise<{ source: 'sea' | 'disk'; keys: number }> {
    this.#keys = await manifest(this.#diskRoot)
    const api = await sea()
    return { source: api === undefined ? 'disk' : 'sea', keys: this.#keys.length }
  }

  get keys(): readonly string[] {
    return this.#keys ?? []
  }

  /** Read one asset by request pathname (`/assets/app.js`, `/`, `/index.html`). */
  async read(pathname: string): Promise<Asset | undefined> {
    if (this.#keys === undefined) await this.init()
    const relative = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\/+/, '')
    if (relative.includes('..') || relative.includes('\\')) return undefined
    const key = `web/${relative}`
    if (!(this.#keys ?? []).includes(key)) return undefined
    const api = await sea()
    if (api !== undefined) {
      const raw = api.getAsset?.(key)
      if (raw === undefined) return undefined
      const body = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw)
      return { body, type: MIME[extname(relative)] ?? 'application/octet-stream', immutable: relative.startsWith('assets/') }
    }
    if (this.#diskRoot === undefined) return undefined
    const full = join(this.#diskRoot, normalize(relative))
    if (!existsSync(full)) return undefined
    return {
      body: readFileSync(full),
      type: MIME[extname(relative)] ?? 'application/octet-stream',
      immutable: relative.startsWith('assets/'),
    }
  }
}
