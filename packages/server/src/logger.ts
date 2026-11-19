/**
 * Logging that cannot leak a secret.
 *
 * Two requirements meet here and shape every decision in this file:
 *
 *   1. The owner has to be able to say "show me why it failed" without a console.
 *      So the server keeps a file and an in-memory tail that the web console can
 *      read.
 *   2. That tail is read by a browser and may be pasted into an issue. So every
 *      line is redacted *before* it reaches the buffer — not filtered on the way
 *      out, where one forgotten exit path is enough to publish a cookie.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const RING_CAPACITY = 500
const ROTATE_BYTES = 2 * 1024 * 1024

export interface LogLine {
  readonly at: string
  readonly level: LogLevel
  readonly message: string
}

/**
 * Patterns whose *value* must never appear.
 *
 * Each rule keeps the key and replaces the value, so a redacted line still explains
 * what was being set. `Bearer` and `Cookie` headers are handled as a unit because
 * their value can itself contain commas and equals signs.
 */
const REDACTIONS: readonly { re: RegExp; replace: string }[] = [
  { re: /(Cookie\s*:\s*)([^\r\n]+)/gi, replace: '$1***' },
  { re: /(Set-Cookie\s*:\s*)([^\r\n]+)/gi, replace: '$1***' },
  { re: /(Authorization\s*:\s*)([^\r\n]+)/gi, replace: '$1***' },
  { re: /(Bearer\s+)([A-Za-z0-9._~+/=-]{12,})/g, replace: '$1***' },
  { re: /(BDUSS(?:_BF)?\s*=\s*)([^;\s"']{8,})/g, replace: '$1***' },
  { re: /(SUB(?:_2A25)?\s*=\s*)([^;\s"']{8,})/g, replace: '$1***' },
  { re: /(sk-)([A-Za-z0-9_-]{12,})/g, replace: '$1***' },
  { re: /(AI_DEBATE_[A-Z0-9_]+\s*[=:]\s*)([^\s"',;]{8,})/g, replace: '$1***' },
  { re: /(\bapi[_-]?key\s*[=:]\s*)([^\s"',;]{8,})/gi, replace: '$1***' },
  { re: /(\bpassword\s*[=:]\s*)([^\s"',;]{4,})/gi, replace: '$1***' },
]

/** Strip secret-shaped substrings. Idempotent, so it can be applied twice. */
export function redact(input: string): string {
  let output = input
  for (const rule of REDACTIONS) output = output.replace(rule.re, rule.replace)
  return output
}

export class Logger {
  readonly #minLevel: LogLevel
  readonly #file: string | undefined
  readonly #ring: LogLine[] = []
  readonly #echo: boolean

  constructor(options: { level?: LogLevel; file?: string | undefined; echo?: boolean } = {}) {
    this.#minLevel = options.level ?? 'info'
    this.#file = options.file
    this.#echo = options.echo ?? true
    if (this.#file !== undefined) {
      mkdirSync(dirname(this.#file), { recursive: true })
    }
  }

  get level(): LogLevel {
    return this.#minLevel
  }

  /** Recent lines, newest last. */
  tail(limit = 200, minLevel: LogLevel = 'debug'): readonly LogLine[] {
    const floor = ORDER[minLevel]
    return this.#ring.filter((line) => ORDER[line.level] >= floor).slice(-Math.max(1, limit))
  }

  debug(message: string): void { this.#write('debug', message) }
  info(message: string): void { this.#write('info', message) }
  warn(message: string): void { this.#write('warn', message) }
  error(message: string): void { this.#write('error', message) }

  #write(level: LogLevel, message: string): void {
    if (ORDER[level] < ORDER[this.#minLevel]) return
    const at = new Date().toISOString()
    const text = redact(message).replace(/\r?\n/g, ' ⏎ ')
    const line: LogLine = { at, level, message: text }
    this.#ring.push(line)
    if (this.#ring.length > RING_CAPACITY) this.#ring.shift()
    const rendered = `${at} ${level.toUpperCase().padEnd(5)} ${text}`
    if (this.#echo) process.stdout.write(`${rendered}\n`)
    if (this.#file !== undefined) {
      try {
        this.#rotateIfNeeded()
        appendFileSync(this.#file, `${rendered}\n`, { encoding: 'utf8', mode: 0o600 })
      } catch {
        // A log file that cannot be written must not stop the request being served.
      }
    }
  }

  #rotateIfNeeded(): void {
    if (this.#file === undefined) return
    if (!existsSync(this.#file)) return
    try {
      if (statSync(this.#file).size < ROTATE_BYTES) return
      const previous = `${this.#file}.1`
      if (existsSync(previous)) unlinkSync(previous)
      renameSync(this.#file, previous)
    } catch {
      // Rotation is housekeeping; failing it only means the file grows.
    }
  }
}

/** A logger that drops everything, for tests and for tools that must stay silent. */
export function silentLogger(): Logger {
  return new Logger({ level: 'error', echo: false })
}
