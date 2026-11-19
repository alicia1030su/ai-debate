/**
 * The configuration document.
 *
 * The core reads configuration by calling `resolveConfig(raw)` on *the object it
 * was handed at mount time*. That is what makes a live edit take effect without a
 * remount: the core does not cache the resolved values, it re-resolves on every
 * use. So this class owns exactly one object and mutates it in place — replacing
 * the reference would silently freeze the runtime on the boot-time values.
 *
 * The second job is conflict detection. Two browser tabs, or a text editor and the
 * page, can both write `config.json`. A write is only accepted when the file on
 * disk still has the hash this process last saw; otherwise the in-memory document
 * is reloaded and the caller gets a conflict, which the page renders as "reloaded,
 * please confirm again" instead of silently overwriting the other writer.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { writeJson } from './atomic.ts'

export interface ConfigDocument {
  readonly values: Record<string, unknown>
  readonly revision: number
  readonly writable: boolean
}

export class ConfigStore {
  readonly #file: string
  readonly #backup: string
  readonly #values: Record<string, unknown>
  #hash: string
  #revision = 0
  #onChange: ((values: Record<string, unknown>) => void) | undefined

  constructor(options: { file: string; backup: string; initial?: Record<string, unknown> }) {
    this.#file = options.file
    this.#backup = options.backup
    this.#values = { ...(options.initial ?? {}) }
    this.#hash = this.#hashOfFile()
  }

  /** The live object the core resolves against. Never replace it. */
  get raw(): Record<string, unknown> {
    return this.#values
  }

  get revision(): number {
    return this.#revision
  }

  get file(): string {
    return this.#file
  }

  /** Called after a successful write, so the runtime can be told to re-read. */
  onChange(listener: (values: Record<string, unknown>) => void): void {
    this.#onChange = listener
  }

  /**
   * Load from disk into the existing object.
   *
   * Returns whether anything changed, so a boot can distinguish "first run" from
   * "loaded an existing document" without a second read.
   */
  load(log?: { warn(message: string): void }): { loaded: boolean; corrupt: boolean } {
    if (!existsSync(this.#file)) {
      this.#hash = ''
      return { loaded: false, corrupt: false }
    }
    let text: string
    try {
      text = readFileSync(this.#file, 'utf8')
    } catch (error) {
      log?.warn(`读取配置失败：${(error as Error).message}`)
      return { loaded: false, corrupt: false }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      // Keep the damaged file: it is the only evidence of what the owner had.
      const aside = `${this.#file}.corrupt-${Date.now()}`
      try {
        writeJson(aside, { raw: text })
      } catch {
        // Not being able to keep a copy is not a reason to overwrite the original.
      }
      log?.warn(`配置文件不是合法 JSON（已另存为 ${aside}）：${(error as Error).message}`)
      this.#hash = this.#hashOfText(text)
      return { loaded: false, corrupt: true }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log?.warn('配置文件顶层不是对象，已忽略')
      return { loaded: false, corrupt: true }
    }
    this.#replace(parsed as Record<string, unknown>)
    this.#hash = this.#hashOfText(text)
    this.#revision += 1
    return { loaded: true, corrupt: false }
  }

  /** Apply an allow-listed patch. Throws a conflict error when the file moved. */
  update(patch: Record<string, unknown>, log?: { warn(message: string): void }): void {
    this.#assertUnchanged(log)
    for (const [key, value] of Object.entries(patch)) this.#values[key] = value
    this.#persist()
  }

  /** Remove fields, returning to their defaults. */
  unset(paths: readonly (readonly string[])[], log?: { warn(message: string): void }): void {
    this.#assertUnchanged(log)
    for (const path of paths) {
      if (path.length === 1) delete this.#values[path[0] as string]
      else if (path.length === 0) continue
    }
    this.#persist()
  }

  /** Replace everything (used by backup restore). */
  replaceAll(values: Record<string, unknown>): void {
    this.#replace(values)
    this.#persist()
  }

  /** A copy safe to hand to a backup writer. */
  snapshot(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this.#values)) as Record<string, unknown>
  }

  #replace(values: Record<string, unknown>): void {
    for (const key of Object.keys(this.#values)) delete this.#values[key]
    for (const [key, value] of Object.entries(values)) this.#values[key] = value
  }

  #assertUnchanged(log?: { warn(message: string): void }): void {
    if (!existsSync(this.#file)) {
      // The file disappeared under us. Treat it as "nothing to conflict with" and
      // rewrite from memory: refusing here would leave the product unconfigurable
      // after someone deletes a file by hand.
      this.#hash = ''
      return
    }
    const current = this.#hashOfFile()
    if (current === this.#hash) return
    log?.warn('配置文件在本次运行期间被外部修改，已重新加载，本次写入被拒绝')
    this.load(log)
    throw new Error('配置已被其他窗口或配置文件改动，已重新载入最新值，请再确认一次。')
  }

  #persist(): void {
    this.#revision += 1
    writeJson(this.#file, this.#values, { mode: 0o600, backup: this.#backup })
    this.#hash = this.#hashOfFile()
    this.#onChange?.(this.#values)
  }

  #hashOfFile(): string {
    try {
      return this.#hashOfText(readFileSync(this.#file, 'utf8'))
    } catch {
      return ''
    }
  }

  #hashOfText(text: string): string {
    return createHash('sha256').update(text).digest('hex')
  }

  /** File size, for the system page. */
  sizeBytes(): number {
    try {
      return statSync(this.#file).size
    } catch {
      return 0
    }
  }
}
