/**
 * Credential storage: encrypted at rest, write-only through the console.
 *
 * The rule the whole product is built around is that a saved secret is never
 * readable again by the thing that stores it for display. `describe()` therefore
 * answers *whether* a reference is configured, never how long it is or what it
 * ends with — a length and a four-character tail are still a partial disclosure,
 * and the upstream project had a live bug where a partially-parsed store reported
 * "configured, tail —" for a value that was not there at all.
 *
 * Encryption is AES-256-GCM with a random 32-byte key in a separate `0600` file.
 * That protects a backup, a synced folder, or an antivirus upload. It does *not*
 * protect against another process running as the same user, which could read the
 * key file; that is stated in `docs/security.md` rather than papered over.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readJsonQuarantine, writeJson } from './atomic.ts'

/** The four methods the core's credential mirror calls. */
export interface CredentialSeam {
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

interface SealedEntry {
  readonly iv: string
  readonly tag: string
  readonly data: string
}

interface CredentialDocument {
  version: 1
  entries: Record<string, SealedEntry>
}

const ALLOWED_PREFIX = 'AI_DEBATE_'
const KEY_BYTES = 32
const IV_BYTES = 12

/** Only the product's own namespace is accepted, so a typo cannot create a shadow store. */
export function assertRef(ref: string): void {
  if (!ref.startsWith(ALLOWED_PREFIX)) {
    throw new Error(`不支持的凭据引用名：${ref}。只接受 ${ALLOWED_PREFIX}* 命名空间。`)
  }
  if (!/^[A-Z0-9_]+$/.test(ref)) {
    throw new Error(`凭据引用名只能包含大写字母、数字与下划线：${ref}`)
  }
}

export class CredentialStore implements CredentialSeam {
  readonly #file: string
  readonly #keyFile: string
  #key: Buffer | undefined
  #entries: Record<string, SealedEntry> = {}
  #listeners: ((ref: string) => void)[] = []
  readonly #log: { warn(message: string): void }

  constructor(options: { file: string; keyFile: string; log?: { warn(message: string): void } }) {
    this.#file = options.file
    this.#keyFile = options.keyFile
    this.#log = options.log ?? { warn: () => undefined }
  }

  /** Load and (if needed) create the key. Returns whether a store already existed. */
  load(): { loaded: boolean; corrupt: boolean } {
    this.#key = this.#readOrCreateKey()
    const { value, corrupt } = readJsonQuarantine<CredentialDocument>(this.#file)
    if (value === undefined) {
      this.#entries = {}
      return { loaded: false, corrupt }
    }
    if (value.version !== 1 || typeof value.entries !== 'object' || value.entries === null) {
      this.#log.warn('凭据文件结构不认识，已忽略（原文件保留）')
      this.#entries = {}
      return { loaded: false, corrupt: true }
    }
    this.#entries = value.entries
    return { loaded: true, corrupt: false }
  }

  /** Subscribe to changes so the core can re-key its adapters. */
  onChange(listener: (ref: string) => void): void {
    this.#listeners.push(listener)
  }

  /** Reference names currently holding a value. Never the values themselves. */
  configuredRefs(): readonly string[] {
    return Object.keys(this.#entries).sort()
  }

  async describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }> {
    assertRef(ref)
    const sealed = this.#entries[ref]
    const configured = sealed !== undefined && this.#open(ref, sealed) !== undefined
    return { configured, ...(configured ? { source: 'store' as const } : {}), writable: true }
  }

  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    assertRef(ref)
    const sealed = this.#entries[ref]
    if (sealed === undefined) return undefined
    const value = this.#open(ref, sealed)
    return value === undefined ? undefined : { value, source: 'store' }
  }

  async set(ref: string, value: string): Promise<void> {
    assertRef(ref)
    const trimmed = value.trim()
    if (trimmed === '') {
      await this.unset(ref)
      return
    }
    const key = this.#requireKey()
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(ref, 'utf8'))
    const data = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()])
    this.#entries[ref] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    }
    this.#persist()
    for (const listener of this.#listeners) listener(ref)
  }

  async unset(ref: string): Promise<void> {
    assertRef(ref)
    if (this.#entries[ref] === undefined) return
    delete this.#entries[ref]
    this.#persist()
    for (const listener of this.#listeners) listener(ref)
  }

  #open(ref: string, sealed: SealedEntry): string | undefined {
    const key = this.#requireKey()
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
      decipher.setAAD(Buffer.from(ref, 'utf8'))
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8')
    } catch (error) {
      // A tampered ciphertext must read as "not configured", never as an empty
      // value that then silently overwrites a working credential.
      this.#log.warn(`凭据 ${ref} 无法解密（可能被篡改或密钥已更换）：${(error as Error).message}`)
      return undefined
    }
  }

  #persist(): void {
    const document: CredentialDocument = { version: 1, entries: this.#entries }
    writeJson(this.#file, document, { mode: 0o600 })
  }

  #requireKey(): Buffer {
    if (this.#key === undefined) this.#key = this.#readOrCreateKey()
    return this.#key
  }

  #readOrCreateKey(): Buffer {
    if (existsSync(this.#keyFile)) {
      const text = readFileSync(this.#keyFile, 'utf8').trim()
      const decoded = Buffer.from(text, 'base64')
      if (decoded.length === KEY_BYTES) return decoded
      // A damaged key file cannot decrypt anything; keep it aside so the owner can
      // tell "the key was corrupted" from "no credential was ever saved".
      const aside = `${this.#keyFile}.damaged-${Date.now()}`
      try {
        writeFileSync(aside, text, { mode: 0o600 })
      } catch {
        // Best effort.
      }
      this.#log.warn(
        `凭据密钥长度异常（${decoded.length} 字节），已重建。原有加密凭据无法解密，原文件保留在 ${this.#file}；请在凭据栏重新填写。`,
      )
    }
    const key = randomBytes(KEY_BYTES)
    writeFileSync(this.#keyFile, key.toString('base64'), { mode: 0o600 })
    this.#harden(this.#keyFile)
    return key
  }

  #harden(path: string): void {
    if (process.platform === 'win32') {
      // NTFS has no chmod; the closest equivalent is removing inherited access and
      // granting only the current user. Failure is not fatal — the file is already
      // inside the user's own profile.
      try {
        const user = process.env.USERNAME
        if (typeof user === 'string' && user !== '') {
          spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore', timeout: 5000 })
        }
      } catch {
        // Ignore: the credential file is still inside a per-user directory.
      }
      return
    }
    try {
      chmodSync(path, 0o600)
    } catch {
      // Best effort.
    }
  }

  /** Size on disk, for diagnostics. */
  sizeBytes(): number {
    try {
      return statSync(this.#file).size
    } catch {
      return 0
    }
  }
}

/** Constant-time string comparison, for anything that compares a secret. */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** A stable id for a session or job. */
export function newId(): string {
  return randomUUID()
}
