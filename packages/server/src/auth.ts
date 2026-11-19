/**
 * The administrator account and its sessions.
 *
 * Three decisions worth knowing before reading the code:
 *
 *   1. **The first-run window is the dangerous one.** Before an administrator
 *      exists, *anyone who can reach the port* can create one. So setup is only
 *      offered to loopback peers, or to whoever can present the one-time token the
 *      server prints on boot when it is listening on a non-loopback address.
 *      After that the endpoint is permanently closed.
 *   2. **Sessions are hashed on disk.** A stolen `sessions.json` must not be a
 *      stolen session; the file holds `sha256(id)`, not `id`.
 *   3. **Rate limiting is per-IP and per-username.** Per-IP alone fails behind a
 *      reverse proxy; per-username alone lets an attacker spray many names.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readJsonQuarantine, writeJson } from './atomic.ts'
import type { Auditor } from './audit.ts'
import { randomUUID } from 'node:crypto'

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, saltBytes: 16 }
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_SESSIONS = 8
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_PER_IP = 8
const LOGIN_MAX_PER_USER = 8

export const SESSION_COOKIE = 'ai_debate_session'

interface AdminRecord {
  version: 1
  username: string
  salt: string
  hash: string
  iterations: number
  createdAt: string
  updatedAt: string
}

interface SessionRecord {
  idHash: string
  username: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  userAgent?: string
}

interface SessionDocument {
  version: 1
  sessions: SessionRecord[]
}

export interface SessionView {
  readonly username: string
  readonly createdAt: string
  readonly expiresAt: string
}

/** A conservative list — long enough to cover what people actually pick. */
const WEAK_PASSWORDS = new Set([
  '1234567890', '12345678901', 'password10', 'qwertyuiop', 'administrator', 'admin12345',
  '1111111111', '0000000000', 'abcdefghij', 'password123', '123456789a', 'aaaaaaaaaa',
])

export function passwordProblem(password: string, username: string): string | undefined {
  if (password.length < 10) return '密码至少 10 位。'
  if (password.length > 256) return '密码过长（上限 256 位）。'
  if (password.toLowerCase() === username.toLowerCase()) return '密码不能与用户名相同。'
  if (WEAK_PASSWORDS.has(password.toLowerCase())) return '这个密码过于常见，请换一个。'
  if (/^(.)\1+$/.test(password)) return '密码不能是同一个字符的重复。'
  return undefined
}

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export class AuthService {
  readonly #adminFile: string
  readonly #sessionsFile: string
  readonly #log: { info(message: string): void; warn(message: string): void }
  readonly #audit: Auditor | undefined
  #admin: AdminRecord | undefined
  #sessions: SessionRecord[] = []
  #attempts = new Map<string, { count: number; resetAt: number }>()
  /** One-time token printed at boot for non-loopback first runs. */
  #setupToken: string | undefined
  readonly #allowLoopbackSetup: boolean

  constructor(options: {
    adminFile: string
    sessionsFile: string
    log: { info(message: string): void; warn(message: string): void }
    audit?: Auditor
    loopbackOnlySetup: boolean
  }) {
    this.#adminFile = options.adminFile
    this.#sessionsFile = options.sessionsFile
    this.#log = options.log
    this.#audit = options.audit
    this.#allowLoopbackSetup = options.loopbackOnlySetup
  }

  /** Read the account and sessions from disk. Missing files are a first run. */
  load(): { initialized: boolean } {
    const admin = readJsonQuarantine<AdminRecord>(this.#adminFile)
    if (admin.value !== undefined && typeof admin.value.hash === 'string' && admin.value.username !== undefined) {
      this.#admin = admin.value
    } else {
      this.#admin = undefined
    }
    const sessions = readJsonQuarantine<SessionDocument>(this.#sessionsFile)
    this.#sessions = Array.isArray(sessions.value?.sessions) ? [...sessions.value!.sessions] : []
    this.#pruneSessions()
    if (this.#admin === undefined) {
      if (!this.#allowLoopbackSetup) {
        this.#setupToken = randomBytes(16).toString('hex')
        this.#log.warn(
          `首次初始化需要一次性令牌（监听地址不是回环）：${this.#setupToken} —— 在初始化页面填入。10 分钟内有效。`,
        )
      }
      return { initialized: false }
    }
    return { initialized: true }
  }

  get initialized(): boolean {
    return this.#admin !== undefined
  }

  get username(): string | undefined {
    return this.#admin?.username
  }

  /** Whether this peer may run setup without the one-time token. */
  setupAllowed(remoteAddress: string | undefined, token: string | undefined): { ok: true } | { ok: false; reason: string } {
    if (this.#admin !== undefined) return { ok: false, reason: '已经初始化过了。' }
    if (isLoopback(remoteAddress)) return { ok: true }
    if (this.#setupToken !== undefined && typeof token === 'string' && token === this.#setupToken) return { ok: true }
    return { ok: false, reason: '远程初始化需要服务启动时打印的一次性令牌。请查看服务日志，或在本机完成初始化。' }
  }

  createAdmin(username: string, password: string): void {
    if (this.#admin !== undefined) throw new Error('已经初始化过了。')
    const name = username.trim()
    if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(name)) throw new Error('用户名只能包含字母、数字与 _ . @ -，长度 3–64。')
    const problem = passwordProblem(password, name)
    if (problem !== undefined) throw new Error(problem)
    const salt = randomBytes(SCRYPT.saltBytes)
    this.#admin = {
      version: 1,
      username: name,
      salt: salt.toString('base64'),
      hash: hashPassword(password, salt).toString('base64'),
      iterations: SCRYPT.N,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    writeJson(this.#adminFile, this.#admin, { mode: 0o600 })
    this.#setupToken = undefined
    this.#audit?.write('admin.created', { username: name })
    this.#log.info(`管理员账号已创建：${name}`)
  }

  /** Verify a password, applying the two-dimensional rate limit. */
  login(
    username: string,
    password: string,
    meta: { ip: string; userAgent?: string },
  ): { ok: true; token: string; session: SessionView } | { ok: false; status: 401 | 429 | 500; message: string; retryAfterSec?: number } {
    const admin = this.#admin
    if (admin === undefined) return { ok: false, status: 500, message: '还没有初始化管理员账号。' }
    const blocked = this.#blockedFor(meta.ip, username)
    if (blocked !== undefined) {
      this.#audit?.write('auth.throttled', { ip: meta.ip, username })
      return { ok: false, status: 429, message: `登录尝试过多，请 ${blocked} 秒后再试。`, retryAfterSec: blocked }
    }
    if (username.trim() !== admin.username) {
      this.#countFailure(meta.ip, username)
      this.#audit?.write('auth.login_failed', { ip: meta.ip, username })
      return { ok: false, status: 401, message: '用户名或密码不正确。' }
    }
    const salt = Buffer.from(admin.salt, 'base64')
    const expected = Buffer.from(admin.hash, 'base64')
    const actual = hashPassword(password, salt)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      this.#countFailure(meta.ip, username)
      this.#audit?.write('auth.login_failed', { ip: meta.ip, username })
      return { ok: false, status: 401, message: '用户名或密码不正确。' }
    }
    this.#attempts.delete(`ip:${meta.ip}`)
    this.#attempts.delete(`user:${username}`)
    const token = this.#issue(admin.username, meta.userAgent)
    const record = this.#sessions.find((item) => item.idHash === sha256(token))
    this.#audit?.write('auth.login', { username: admin.username, ip: meta.ip })
    this.#log.info(`管理员登录成功：${admin.username}`)
    return {
      ok: true,
      token,
      session: {
        username: admin.username,
        createdAt: record?.createdAt ?? new Date().toISOString(),
        expiresAt: record?.expiresAt ?? new Date(Date.now() + SESSION_IDLE_MS).toISOString(),
      },
    }
  }

  /** Resolve a cookie value to a session, sliding the idle window. */
  validate(token: string | undefined): SessionView | undefined {
    if (typeof token !== 'string' || token.length < 16) return undefined
    const idHash = sha256(token)
    const now = Date.now()
    const record = this.#sessions.find((item) => item.idHash === idHash)
    if (record === undefined) return undefined
    const expires = Date.parse(record.expiresAt)
    const created = Date.parse(record.createdAt)
    if (!Number.isFinite(expires) || expires <= now || now - created > SESSION_ABSOLUTE_MS) {
      this.#sessions = this.#sessions.filter((item) => item.idHash !== idHash)
      this.#persistSessions()
      return undefined
    }
    record.lastSeenAt = new Date(now).toISOString()
    record.expiresAt = new Date(Math.min(now + SESSION_IDLE_MS, created + SESSION_ABSOLUTE_MS)).toISOString()
    this.#persistSessions()
    return { username: record.username, createdAt: record.createdAt, expiresAt: record.expiresAt }
  }

  logout(token: string | undefined): void {
    if (typeof token !== 'string') return
    this.#audit?.write('auth.logout', {})
    const idHash = sha256(token)
    const before = this.#sessions.length
    this.#sessions = this.#sessions.filter((item) => item.idHash !== idHash)
    if (this.#sessions.length !== before) this.#persistSessions()
  }

  logoutAll(): void {
    this.#sessions = []
    this.#persistSessions()
  }

  changePassword(current: string, next: string): void {
    const admin = this.#admin
    if (admin === undefined) throw new Error('还没有初始化管理员账号。')
    const salt = Buffer.from(admin.salt, 'base64')
    const actual = hashPassword(current, salt)
    const expected = Buffer.from(admin.hash, 'base64')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error('当前密码不正确。')
    }
    const problem = passwordProblem(next, admin.username)
    if (problem !== undefined) throw new Error(problem)
    const freshSalt = randomBytes(SCRYPT.saltBytes)
    this.#admin = {
      ...admin,
      salt: freshSalt.toString('base64'),
      hash: hashPassword(next, freshSalt).toString('base64'),
      updatedAt: new Date().toISOString(),
    }
    writeJson(this.#adminFile, this.#admin, { mode: 0o600 })
    this.logoutAll()
    this.#audit?.write('auth.password_changed', { username: admin.username })
    this.#log.info('管理员密码已更新，所有会话已失效')
  }

  #issue(username: string, userAgent: string | undefined): string {
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    this.#sessions.push({
      idHash: sha256(token),
      username,
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_IDLE_MS).toISOString(),
      ...(userAgent === undefined ? {} : { userAgent: userAgent.slice(0, 200) }),
    })
    // Oldest-first: the cap exists so a forgotten browser does not accumulate
    // sessions forever, not to log someone out mid-use.
    this.#sessions.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    while (this.#sessions.length > MAX_SESSIONS) this.#sessions.shift()
    this.#persistSessions()
    return token
  }

  #pruneSessions(): void {
    const now = Date.now()
    const kept = this.#sessions.filter((item) => {
      const expires = Date.parse(item.expiresAt)
      const created = Date.parse(item.createdAt)
      return Number.isFinite(expires) && expires > now && now - created <= SESSION_ABSOLUTE_MS
    })
    if (kept.length !== this.#sessions.length) {
      this.#sessions = kept
      this.#persistSessions()
    }
  }

  #persistSessions(): void {
    writeJson(this.#sessionsFile, { version: 1, sessions: this.#sessions } satisfies SessionDocument, { mode: 0o600 })
  }

  #blockedFor(ip: string, username: string): number | undefined {
    const now = Date.now()
    for (const key of [`ip:${ip}`, `user:${username}`]) {
      const entry = this.#attempts.get(key)
      if (entry === undefined) continue
      if (entry.resetAt <= now) {
        this.#attempts.delete(key)
        continue
      }
      const limit = key.startsWith('ip:') ? LOGIN_MAX_PER_IP : LOGIN_MAX_PER_USER
      if (entry.count >= limit) return Math.ceil((entry.resetAt - now) / 1000)
    }
    return undefined
  }

  #countFailure(ip: string, username: string): void {
    const now = Date.now()
    for (const key of [`ip:${ip}`, `user:${username}`]) {
      const entry = this.#attempts.get(key)
      if (entry === undefined || entry.resetAt <= now) this.#attempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
      else entry.count += 1
    }
  }

  /** Session count, for the system page. */
  sessionCount(): number {
    return this.#sessions.length
  }

  /** A random id for a new session or job. */
  static id(): string {
    return randomUUID()
  }
}

/** Whether an address is the local machine. */
export function isLoopback(address: string | undefined): boolean {
  if (typeof address !== 'string') return false
  const normalised = address.startsWith('::ffff:') ? address.slice(7) : address
  return normalised === '127.0.0.1' || normalised === '::1' || normalised === 'localhost'
}

/** Parse a Cookie header into a map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (typeof header !== 'string' || header === '') return {}
  const jar: Record<string, string> = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name !== '') jar[name] = decodeURIComponent(value)
  }
  return jar
}

/** A Set-Cookie header for a session. */
export function sessionCookie(token: string, options: { secure: boolean; maxAgeSec?: number }): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${options.maxAgeSec ?? 12 * 60 * 60}`,
  ]
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

/** A Set-Cookie header that clears the session. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
}

/** Whether the admin file exists, without loading the whole service. */
export function adminExists(file: string): boolean {
  return existsSync(file)
}
