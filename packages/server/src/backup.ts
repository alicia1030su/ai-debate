/**
 * Backup and restore for the standalone server.
 *
 * A backup is an immutable-looking directory under `backups/`: only the fixed
 * whitelist below is copied, every copied file is hashed, and the directory is
 * published with one rename after its manifest is durable. The administrator
 * account, encryption key, sessions, logs and runtime records are deliberately
 * outside that whitelist.
 *
 * Restore is deliberately conservative. It verifies the source first, takes a
 * complete pre-restore snapshot, replaces files one at a time, and rolls the
 * snapshot back if any later validation fails. Files absent from the backup are
 * never removed from the live data directory. A same-machine upgrade therefore
 * keeps its administrator and credential key; a fresh installation must create a
 * new administrator and re-enter credentials because neither secret is portable.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertWritableSpace, writeFileAtomic, writeJson } from './atomic.ts'
import type { Auditor } from './audit.ts'
import type { Layout } from './paths.ts'

/** The three rotation classes understood by the backup centre. */
export type BackupKind = 'manual' | 'daily' | 'weekly'

/** File names that may ever enter a backup, in deterministic restore order. */
export const BACKUP_FILE_NAMES = [
  'config.json',
  'state.json',
  'jobs.json',
  'monitors.json',
  'auto-tasks.json',
  'reply-identities.json',
  'credentials.json',
] as const

/** A whitelisted backup file name. */
export type BackupFileName = (typeof BACKUP_FILE_NAMES)[number]

/** Integrity information recorded for one copied file. */
export interface BackupFileEntry {
  readonly sha256: string
  readonly bytes: number
}

/** The validated form of `manifest.json`. */
export interface BackupManifest {
  readonly version: string
  readonly createdAt: string
  readonly kind: BackupKind
  readonly files: Readonly<Record<string, BackupFileEntry>>
  readonly containsCredentials: boolean
  /** Non-secret SHA-256 fingerprint of the credential key, never the key itself. */
  readonly credentialKeyId?: string
  /** True when a pre-restore snapshot had to sanitize the current config. */
  readonly sanitized?: boolean
  /** Human-readable portability warning stored with new backups. */
  readonly note?: string
  readonly restored?: readonly string[]
  readonly skipped?: readonly string[]
  readonly restoredAt?: string
}

/** One row returned by the backup centre. It contains no filesystem paths. */
export interface BackupListEntry {
  readonly name: string
  readonly createdAt: string
  readonly kind: BackupKind | 'unknown'
  /** Number of whitelisted files declared by the manifest. */
  readonly files: number
  /** Sum of the file sizes declared by the manifest. */
  readonly bytes: number
  /** Whether the manifest itself is readable and structurally valid. */
  readonly valid: boolean
  readonly error: string | null
}

/** Result of a full integrity check, including every file's SHA-256 digest. */
export interface BackupVerification {
  readonly valid: boolean
  readonly error?: string
}

/** Optional cancellation support checked at file boundaries. */
export interface BackupOperationOptions {
  readonly signal?: AbortSignal | undefined
}

/** Restore requires an explicit confirmation in addition to cancellation. */
export interface BackupRestoreOptions extends BackupOperationOptions {
  readonly confirmed: boolean
}

/** Details of a successful restore. Paths are represented by directory names. */
export interface BackupRestoreResult {
  readonly name: string
  readonly preRestore: string
  readonly restored: readonly string[]
  readonly skipped: readonly string[]
}

/** Narrow dependencies so the service is straightforward to test and wire. */
export interface BackupLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/**
 * Audit dependency. `backup.restore_failed` is intentionally included here even
 * though older `AuditEvent` unions do not list it yet; the runtime auditor writes
 * any string event and the composition root can widen its union independently.
 */
export interface BackupAuditor {
  write(
    event: 'backup.created' | 'backup.restored' | 'backup.restore_failed',
    detail?: Record<string, unknown>,
  ): void
}

/** Construction options for {@link BackupService}. */
export interface BackupServiceOptions {
  readonly layout: Layout
  readonly version: string
  readonly log: BackupLogger
  /** Accepts both the current auditor and the widened failure-event dependency. */
  readonly audit: BackupAuditor | Auditor
  readonly onRestored?: (() => void) | undefined
}

/** A user-facing backup failure without an unchecked filesystem error. */
export class BackupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BackupError'
  }
}

interface Inspection {
  readonly valid: boolean
  readonly error?: string
  readonly dir?: string
  readonly manifest?: BackupManifest
  readonly manifestText?: string
}

interface BackupSource {
  readonly name: BackupFileName
  readonly source: string
  readonly bytes: number
  /** Replacement text used only for sanitized pre-restore config snapshots. */
  readonly contents?: string
}

// Accept legacy one-level directory names so old backups remain visible as
// invalid rows, but reject separators, drive prefixes, dot entries and Windows
// trailing dots/spaces. New directories use the stricter timestamp-kind-UUID form.
const SAFE_BACKUP_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_MANIFEST_BYTES = 1024 * 1024
const MANIFEST_NAME = 'manifest.json'
const BACKUP_MANIFEST_NOTE = '不含 admin.json、credentials.key、sessions.json、run/ 或 logs/；恢复至全新安装需重新初始化管理员并重新输入凭据。'
const DAILY_KEEP = 7
const WEEKLY_KEEP = 4
const WHITELIST: ReadonlySet<string> = new Set(BACKUP_FILE_NAMES)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isBackupFileName(value: string): value is BackupFileName {
  return WHITELIST.has(value)
}

function isBackupKind(value: unknown): value is BackupKind {
  return value === 'manual' || value === 'daily' || value === 'weekly'
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || !Number.isFinite(Date.parse(value))) return false
  // Canonical ISO timestamps sort lexicographically, which prune relies on.
  return new Date(value).toISOString() === value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Stop at a file boundary without interrupting an in-flight filesystem call. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new BackupError('备份操作已取消。')
}

function safeTimestamp(at: Date): string {
  return at.toISOString().replace(/[:.]/g, '-')
}

/** Hash a regular file. Callers perform their own type and symlink checks. */
function sha256OfFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Parse and validate a manifest without trusting any field from disk. */
function parseManifest(text: string): BackupManifest {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new BackupError('manifest.json 不是有效的 JSON 文档。')
  }
  if (!isRecord(value)) throw new BackupError('manifest.json 的结构不正确。')
  if (typeof value.version !== 'string' || value.version.trim() === '') {
    throw new BackupError('manifest.json 缺少版本。')
  }
  if (!isTimestamp(value.createdAt)) throw new BackupError('manifest.json 的创建时间不正确。')
  const legacy = value.kind === undefined && value.containsCredentials === undefined
  if (legacy && value.auto !== undefined && typeof value.auto !== 'boolean') {
    throw new BackupError('manifest.json 的旧版自动备份标记不正确。')
  }
  let kind: BackupKind
  if (legacy) {
    kind = value.auto === true ? 'daily' : 'manual'
  } else {
    if (!isBackupKind(value.kind)) throw new BackupError('manifest.json 的备份类型不正确。')
    kind = value.kind
  }
  if (!legacy && typeof value.containsCredentials !== 'boolean') {
    throw new BackupError('manifest.json 缺少凭据标记。')
  }
  if (!isRecord(value.files)) throw new BackupError('manifest.json 的文件清单不正确。')

  const files: Record<string, BackupFileEntry> = {}
  for (const [name, entry] of Object.entries(value.files)) {
    if (!isBackupFileName(name)) throw new BackupError('manifest.json 包含不允许的文件。')
    if (!isRecord(entry) || typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
      throw new BackupError(`manifest.json 中 ${name} 的校验值不正确。`)
    }
    if (typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new BackupError(`manifest.json 中 ${name} 的大小不正确。`)
    }
    files[name] = { sha256: entry.sha256, bytes: entry.bytes }
  }
  const containsCredentials = files['credentials.json'] !== undefined
  if (!legacy && value.containsCredentials !== containsCredentials) {
    throw new BackupError('manifest.json 的凭据标记与文件清单不一致。')
  }
  if (value.credentialKeyId !== undefined && (typeof value.credentialKeyId !== 'string' || !SHA256_PATTERN.test(value.credentialKeyId))) {
    throw new BackupError('manifest.json 的凭据密钥指纹不正确。')
  }
  if (!containsCredentials && value.credentialKeyId !== undefined) {
    throw new BackupError('manifest.json 在无凭据文件时记录了密钥指纹。')
  }
  if (value.sanitized !== undefined && typeof value.sanitized !== 'boolean') {
    throw new BackupError('manifest.json 的清理标记不正确。')
  }
  if (value.note !== undefined && typeof value.note !== 'string') {
    throw new BackupError('manifest.json 的说明不正确。')
  }

  let restored: string[] | undefined
  if (value.restored !== undefined) {
    if (!Array.isArray(value.restored)) throw new BackupError('manifest.json 的恢复记录不正确。')
    const seen = new Set<string>()
    restored = []
    for (const name of value.restored) {
      if (typeof name !== 'string' || !isBackupFileName(name) || files[name] === undefined || seen.has(name)) {
        throw new BackupError('manifest.json 的恢复记录包含无效文件。')
      }
      seen.add(name)
      restored.push(name)
    }
  }
  let skipped: string[] | undefined
  if (value.skipped !== undefined) {
    if (!Array.isArray(value.skipped)) throw new BackupError('manifest.json 的跳过记录不正确。')
    const seen = new Set<string>()
    skipped = []
    for (const name of value.skipped) {
      if (typeof name !== 'string' || !isBackupFileName(name) || files[name] === undefined || seen.has(name)) {
        throw new BackupError('manifest.json 的跳过记录包含无效文件。')
      }
      if (restored?.includes(name) === true) throw new BackupError('manifest.json 同时记录恢复与跳过同一文件。')
      seen.add(name)
      skipped.push(name)
    }
  }
  if (value.restoredAt !== undefined && !isTimestamp(value.restoredAt)) {
    throw new BackupError('manifest.json 的恢复时间不正确。')
  }

  return {
    version: value.version,
    createdAt: value.createdAt,
    kind,
    files,
    containsCredentials,
    ...(typeof value.credentialKeyId === 'string' ? { credentialKeyId: value.credentialKeyId } : {}),
    ...(typeof value.sanitized === 'boolean' ? { sanitized: value.sanitized } : {}),
    ...(typeof value.note === 'string' ? { note: value.note } : {}),
    ...(restored === undefined ? {} : { restored }),
    ...(skipped === undefined ? {} : { skipped }),
    ...(typeof value.restoredAt === 'string' ? { restoredAt: value.restoredAt } : {}),
  }
}

/** Verify that a path is a regular file, not a symlink, with the expected bytes. */
function verifyFile(file: string, expected: BackupFileEntry): void {
  const info = lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new BackupError('备份文件不是普通文件。')
  if (info.size !== expected.bytes) throw new BackupError('备份文件大小与清单不一致。')
  if (sha256OfFile(file) !== expected.sha256) throw new BackupError('备份文件校验值不一致。')
}

/** Flush a copied file before it is published by rename. */
function syncFile(file: string): void {
  // Windows FlushFileBuffers requires a writable handle; opening read-only can
  // fail with EPERM even for a perfectly healthy file.
  const fd = openSync(file, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Best-effort directory fsync; Windows relies on NTFS journaling instead. */
function syncDirectory(file: string): void {
  if (process.platform === 'win32') return
  let fd: number | undefined
  try {
    fd = openSync(dirname(file), 'r')
    fsyncSync(fd)
  } catch {
    // The file itself has already been flushed. Some filesystems do not permit
    // opening a directory for fsync, which must not turn a good copy into a failure.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Already closed.
      }
    }
  }
}

/** Copy one regular file into an already-private staging directory. */
function copyIntoStaging(source: string, target: string): void {
  const info = lstatSync(source)
  if (!info.isFile() || info.isSymbolicLink()) throw new BackupError('源文件不是普通文件。')
  copyFileSync(source, target, fsConstants.COPYFILE_EXCL)
  chmodSync(target, 0o600)
  syncFile(target)
}

/**
 * Copy a file by writing a sibling temporary file and renaming it over the
 * destination. The destination is never truncated in place.
 */
function copyFileAtomic(source: string, target: string): void {
  const info = lstatSync(source)
  if (!info.isFile() || info.isSymbolicLink()) throw new BackupError('恢复源文件不是普通文件。')
  const temp = join(dirname(target), `.${basename(target)}-${process.pid}-${randomUUID()}.tmp`)
  try {
    copyFileSync(source, temp, fsConstants.COPYFILE_EXCL)
    chmodSync(temp, 0o600)
    syncFile(temp)
    renameSync(temp, target)
    syncDirectory(target)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The copy may have failed before creating the temporary file.
    }
    throw error
  }
}

/** Ensure a JSON document is parseable before a restore is accepted. */
function assertJsonFile(file: string): void {
  try {
    JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (error) {
    throw new BackupError(`恢复后的 JSON 文件无法解析：${errorMessage(error)}`, { cause: error })
  }
}

/**
 * Creates, inspects, restores and rotates backups for one server layout.
 *
 * All methods are synchronous: the files involved are small, and the job queue
 * already serializes backup work. Synchronous operations also make the
 * verify/copy/rename sequence easier to reason about.
 */
export class BackupService {
  readonly #layout: Layout
  readonly #version: string
  readonly #log: BackupLogger
  readonly #audit: BackupAuditor
  readonly #onRestored: (() => void) | undefined

  constructor(options: BackupServiceOptions) {
    if (options.version.trim() === '') throw new BackupError('备份服务版本不能为空。')
    this.#layout = options.layout
    this.#version = options.version
    this.#log = options.log
    // The runtime auditor accepts string events, but its public union has not yet
    // been widened for backup.restore_failed. Keep that compatibility cast at this
    // single dependency boundary rather than weakening every audit call site.
    const write = options.audit.write as BackupAuditor['write']
    this.#audit = {
      write(event, detail): void {
        write.call(options.audit, event, detail)
      },
    }
    this.#onRestored = options.onRestored
  }

  /** Resolve a whitelisted name to its live file in this layout. */
  #sourceFile(name: BackupFileName): string {
    switch (name) {
      case 'config.json':
        return this.#layout.configFile
      case 'state.json':
        return join(this.#layout.dataDir, 'state.json')
      case 'jobs.json':
        return this.#layout.jobsFile
      case 'monitors.json':
        return this.#layout.monitorsFile
      case 'auto-tasks.json':
        return this.#layout.autoTasksFile
      case 'reply-identities.json':
        return this.#layout.identitiesFile
      case 'credentials.json':
        return this.#layout.credentialsFile
    }
  }

  /** Refuse to copy legacy plaintext secrets or an unverifiable config document. */
  #assertPortableConfig(sources: readonly BackupSource[]): void {
    const config = sources.find((source) => source.name === 'config.json')
    if (config === undefined) return
    let value: unknown
    try {
      value = JSON.parse(readFileSync(config.source, 'utf8')) as unknown
    } catch (error) {
      throw new BackupError('config.json 无法解析，拒绝创建可能含明文秘密的备份。', { cause: error })
    }
    if (!isRecord(value)) throw new BackupError('config.json 顶层不是对象，拒绝备份。')
    for (const field of ['tiebaCookie', 'llmApiKey']) {
      const secret = value[field]
      if (typeof secret === 'string' ? secret.trim() !== '' : secret !== undefined && secret !== null) {
        throw new BackupError(`config.json 仍含明文旧字段 ${field}；请先迁移至凭据存储或清除后再备份。`)
      }
    }
  }

  /** Return a non-secret fingerprint, or undefined when no key file exists. */
  #credentialKeyId(): string | undefined {
    try {
      const info = lstatSync(this.#layout.credentialsKey)
      if (info.isSymbolicLink() || !info.isFile()) throw new BackupError('credentials.key 不是普通文件。')
      return sha256OfFile(this.#layout.credentialsKey)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error instanceof BackupError ? error : new BackupError('无法读取凭据密钥指纹。', { cause: error })
    }
  }

  /** Keep corrupt config evidence outside backups before using a safe placeholder. */
  #quarantineCorruptConfig(raw: string): void {
    const aside = `${this.#layout.configFile}.corrupt-${safeTimestamp(new Date())}-${randomUUID()}`
    writeFileAtomic(aside, raw, { mode: 0o600 })
  }

  /** Sanitize pre-restore config without ever copying legacy plaintext into backups. */
  #preparePreRestoreSources(sources: readonly BackupSource[]): { sources: BackupSource[]; sanitized: boolean } {
    let sanitized = false
    const prepared = sources.map((source): BackupSource => {
      if (source.name !== 'config.json') return source
      let raw: string
      try {
        raw = readFileSync(source.source, 'utf8')
      } catch (error) {
        throw new BackupError('无法读取当前配置，拒绝创建恢复前快照。', { cause: error })
      }
      let value: unknown
      try {
        value = JSON.parse(raw) as unknown
      } catch {
        this.#quarantineCorruptConfig(raw)
        sanitized = true
        return { ...source, contents: '{}\n' }
      }
      if (!isRecord(value)) {
        this.#quarantineCorruptConfig(raw)
        sanitized = true
        return { ...source, contents: '{}\n' }
      }
      let changed = false
      for (const field of ['tiebaCookie', 'llmApiKey']) {
        const secret = value[field]
        if (typeof secret === 'string' ? secret.trim() !== '' : secret !== undefined && secret !== null) {
          delete value[field]
          changed = true
        }
      }
      if (!changed) return source
      sanitized = true
      return { ...source, contents: `${JSON.stringify(value, null, 2)}\n` }
    })
    return { sources: prepared, sanitized }
  }

  /**
   * Existing whitelist files. Normal backups refuse every non-file path except
   * ENOENT; pre-restore snapshots may skip directories so a target conflict can
   * still be exercised and rolled back safely.
   */
  #existingSources(strictTypes = true): BackupSource[] {
    const out: BackupSource[] = []
    for (const name of BACKUP_FILE_NAMES) {
      const source = this.#sourceFile(name)
      let info
      try {
        info = lstatSync(source)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new BackupError(`无法读取待备份文件 ${name}。`, { cause: error })
      }
      if (info.isSymbolicLink()) throw new BackupError(`拒绝备份符号链接：${name}。`)
      if (!info.isFile()) {
        if (strictTypes) throw new BackupError(`白名单路径不是普通文件：${name}。`)
        continue
      }
      out.push({ name, source, bytes: info.size })
    }
    return out
  }

  /** Create the backups root if needed, refusing a symlink or non-directory. */
  #ensureBackupsDirectory(): void {
    try {
      const info = lstatSync(this.#layout.backupsDir)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new BackupError('备份目录不是普通目录。')
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error instanceof BackupError ? error : new BackupError('备份目录不可访问。', { cause: error })
      }
    }
    try {
      mkdirSync(this.#layout.backupsDir, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new BackupError('无法创建备份目录。', { cause: error })
    }
  }

  /** Resolve a strict one-level backup name without following symbolic links. */
  #backupDirectory(name: string): string {
    if (typeof name !== 'string' || !SAFE_BACKUP_NAME.test(name)) {
      throw new BackupError('备份名称不合法。')
    }
    let parent
    try {
      parent = lstatSync(this.#layout.backupsDir)
    } catch {
      throw new BackupError('备份目录不存在或不可访问。')
    }
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new BackupError('备份目录不是普通目录。')
    }
    const dir = join(this.#layout.backupsDir, name)
    let info
    try {
      info = lstatSync(dir)
    } catch {
      throw new BackupError('备份不存在或不可访问。')
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new BackupError('备份不是普通目录。')
    }
    return dir
  }

  /** Read only the manifest, with no file-content hashing. */
  #readManifest(dir: string): { manifest: BackupManifest; text: string } {
    let dirInfo
    try {
      dirInfo = lstatSync(dir)
    } catch {
      throw new BackupError('备份目录不可访问。')
    }
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
      throw new BackupError('备份不是普通目录。')
    }
    const file = join(dir, MANIFEST_NAME)
    let info
    try {
      info = lstatSync(file)
    } catch {
      throw new BackupError('无法读取 manifest.json。')
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new BackupError('manifest.json 不是普通文件。')
    if (info.size > MAX_MANIFEST_BYTES) throw new BackupError('manifest.json 超出允许大小。')
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      throw new BackupError('无法读取 manifest.json。')
    }
    return { manifest: parseManifest(text), text }
  }

  /** Full inspection used by verify, restore and prune. */
  #inspect(name: string): Inspection {
    try {
      const dir = this.#backupDirectory(name)
      const { manifest, text } = this.#readManifest(dir)
      for (const entry of readdirSync(dir)) {
        if (entry !== MANIFEST_NAME && manifest.files[entry] === undefined) {
          throw new BackupError('备份目录包含清单之外的文件。')
        }
      }
      for (const [fileName, expected] of Object.entries(manifest.files)) {
        if (!isBackupFileName(fileName)) throw new BackupError('备份文件不在白名单内。')
        try {
          verifyFile(join(dir, fileName), expected)
        } catch (error) {
          throw new BackupError(`备份文件 ${fileName} 校验失败：${errorMessage(error)}`, { cause: error })
        }
      }
      return { valid: true, dir, manifest, manifestText: text }
    } catch (error) {
      return { valid: false, error: errorMessage(error) }
    }
  }

  /** Write a small, path-free audit record without letting logging break a restore. */
  #writeAudit(
    event: 'backup.created' | 'backup.restored' | 'backup.restore_failed',
    detail: Record<string, unknown>,
  ): void {
    try {
      this.#audit.write(event, detail)
    } catch (error) {
      this.#log.warn(`写入备份审计事件失败：${errorMessage(error)}`)
    }
  }

  /** Internal snapshot writer shared by normal and pre-restore backups. */
  #createSnapshot(
    kind: BackupKind,
    prefix: 'backup' | 'pre-restore',
    recordAudit: boolean,
    signal?: AbortSignal,
  ): string {
    if (!isBackupKind(kind)) throw new BackupError('备份类型不正确。')
    throwIfAborted(signal)
    this.#ensureBackupsDirectory()
    const preRestore = prefix === 'pre-restore'
    let sources = this.#existingSources(!preRestore)
    let sanitized = false
    if (preRestore) {
      const prepared = this.#preparePreRestoreSources(sources)
      sources = prepared.sources
      sanitized = prepared.sanitized
    } else {
      this.#assertPortableConfig(sources)
    }
    throwIfAborted(signal)
    const needed = sources.reduce((total, source) => total + source.bytes, 0) * 2 + MAX_MANIFEST_BYTES
    assertWritableSpace(this.#layout.backupsDir, needed)

    const createdAt = new Date().toISOString()
    const name = prefix === 'pre-restore'
      ? `pre-restore-${safeTimestamp(new Date(createdAt))}-${randomUUID()}`
      : `${safeTimestamp(new Date(createdAt))}-${kind}-${randomUUID()}`
    const staging = join(this.#layout.backupsDir, `.${prefix}-staging-${randomUUID()}`)
    const finalDir = join(this.#layout.backupsDir, name)
    const files: Record<string, BackupFileEntry> = {}
    let published = false
    try {
      mkdirSync(staging, { mode: 0o700 })
      for (const source of sources) {
        throwIfAborted(signal)
        const target = join(staging, source.name)
        if (source.contents === undefined) copyIntoStaging(source.source, target)
        else writeFileAtomic(target, source.contents, { mode: 0o600 })
        throwIfAborted(signal)
        const info = statSync(target)
        files[source.name] = { sha256: sha256OfFile(target), bytes: info.size }
      }
      throwIfAborted(signal)
      const manifest: BackupManifest = {
        version: this.#version,
        createdAt,
        kind,
        files,
        containsCredentials: files['credentials.json'] !== undefined,
        ...(files['credentials.json'] === undefined ? {} : { credentialKeyId: this.#credentialKeyId() }),
        ...(sanitized ? { sanitized: true } : {}),
        note: BACKUP_MANIFEST_NOTE,
      }
      writeJson(join(staging, MANIFEST_NAME), manifest, { mode: 0o600 })
      throwIfAborted(signal)
      renameSync(staging, finalDir)
      published = true
      syncDirectory(finalDir)
    } catch (error) {
      if (!published) {
        try {
          rmSync(staging, { recursive: true, force: true })
        } catch (cleanupError) {
          this.#log.error(`清理备份暂存目录失败：${errorMessage(cleanupError)}`)
        }
      }
      throw new BackupError(`备份创建失败：${errorMessage(error)}`, { cause: error })
    }

    const bytes = Object.values(files).reduce((total, entry) => total + entry.bytes, 0)
    if (recordAudit) {
      this.#writeAudit('backup.created', {
        name,
        kind,
        files: Object.keys(files).length,
        bytes,
        containsCredentials: files['credentials.json'] !== undefined,
      })
    }
    this.#log.info(`备份完成：${name}（${Object.keys(files).length} 个文件，${bytes} 字节）`)
    return name
  }

  /**
   * Create a manual, daily or weekly backup and return its directory name.
   * Existing whitelisted files are copied byte-for-byte; missing files are omitted.
   */
  create(kind: BackupKind, options: BackupOperationOptions = {}): string {
    return this.#createSnapshot(kind, 'backup', true, options.signal)
  }

  /**
   * List backups from their manifests only, newest first.
   * A damaged manifest is visible as an invalid row rather than hidden.
   */
  list(): readonly BackupListEntry[] {
    let entries
    try {
      const root = lstatSync(this.#layout.backupsDir)
      if (!root.isDirectory() || root.isSymbolicLink()) return []
      entries = readdirSync(this.#layout.backupsDir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: BackupListEntry[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_BACKUP_NAME.test(entry.name)) continue
      const base = {
        name: entry.name,
        createdAt: '',
        kind: 'unknown' as const,
        files: 0,
        bytes: 0,
        valid: false,
        error: null as string | null,
      }
      try {
        const { manifest } = this.#readManifest(join(this.#layout.backupsDir, entry.name))
        const files = Object.values(manifest.files)
        out.push({
          ...base,
          createdAt: manifest.createdAt,
          kind: manifest.kind,
          files: files.length,
          bytes: files.reduce((total, file) => total + file.bytes, 0),
          valid: true,
          error: null,
        })
      } catch (error) {
        out.push({ ...base, error: errorMessage(error) })
      }
    }
    return out.sort((left, right) => {
      const byDate = right.createdAt.localeCompare(left.createdAt)
      return byDate === 0 ? right.name.localeCompare(left.name) : byDate
    })
  }

  /** Verify the name, manifest, whitelist, file sizes and SHA-256 digests. */
  verify(name: string): BackupVerification {
    const result = this.#inspect(name)
    return result.valid ? { valid: true } : { valid: false, error: result.error ?? '备份校验失败。' }
  }

  /** Decide whether credential ciphertext can be restored safely with the live key. */
  #shouldSkipCredentials(manifest: BackupManifest): boolean {
    if (manifest.files['credentials.json'] === undefined) return false
    const currentKeyId = this.#credentialKeyId()
    if (currentKeyId === undefined) return true
    if (manifest.credentialKeyId === undefined) {
      throw new BackupError('备份缺少凭据密钥指纹，拒绝恢复 credentials.json。')
    }
    if (currentKeyId !== manifest.credentialKeyId) {
      throw new BackupError('当前凭据密钥与备份指纹不匹配，拒绝整个恢复；请重新填写凭据。')
    }
    return false
  }

  /** Restore verified pre-restore files atomically, rolling back on any failure. */
  restore(name: string, options: BackupRestoreOptions): BackupRestoreResult {
    if (options?.confirmed !== true) throw new BackupError('恢复备份必须明确确认。')
    const signal = options.signal
    throwIfAborted(signal)
    let preRestore: string | undefined
    let applied: BackupFileName[] = []
    let skipped: BackupFileName[] = []
    let manifestChanged = false
    let originalManifestText: string | undefined
    let sourceDir: string | undefined

    try {
      const source = this.#inspect(name)
      if (!source.valid || source.dir === undefined || source.manifest === undefined || source.manifestText === undefined) {
        throw new BackupError(source.error ?? '备份校验失败。')
      }
      sourceDir = source.dir
      const manifest = source.manifest
      throwIfAborted(signal)
      const skipCredentials = this.#shouldSkipCredentials(manifest)
      const currentSources = this.#existingSources(false)
      const currentBytes = currentSources.reduce((total, source) => total + source.bytes, 0)
      const backupBytes = Object.values(manifest.files).reduce((total, entry) => total + entry.bytes, 0)
      // Peak usage includes the pre-restore snapshot, the new live copy and a
      // full rollback copy. Four times the larger set is deliberately conservative.
      assertWritableSpace(this.#layout.backupsDir, Math.max(currentBytes, backupBytes) * 4 + MAX_MANIFEST_BYTES)
      throwIfAborted(signal)
      preRestore = this.#createSnapshot('manual', 'pre-restore', false, signal)
      const pre = this.#inspect(preRestore)
      if (!pre.valid || pre.dir === undefined || pre.manifest === undefined) {
        throw new BackupError(pre.error ?? '恢复前备份校验失败。')
      }

      applied = []
      skipped = []
      for (const fileName of BACKUP_FILE_NAMES) {
        if (manifest.files[fileName] === undefined) continue
        if (fileName === 'credentials.json' && skipCredentials) {
          skipped.push(fileName)
          continue
        }
        throwIfAborted(signal)
        copyFileAtomic(join(source.dir, fileName), this.#sourceFile(fileName))
        applied.push(fileName)
        throwIfAborted(signal)
      }

      // Hash and JSON validation happen after every replacement. A bad document
      // that happens to match a forged manifest must still never be accepted.
      for (const fileName of applied) {
        throwIfAborted(signal)
        const expected = manifest.files[fileName]
        if (expected === undefined) throw new BackupError(`备份清单缺少 ${fileName}。`)
        try {
          verifyFile(this.#sourceFile(fileName), expected)
        } catch (error) {
          throw new BackupError(`恢复文件 ${fileName} 校验失败：${errorMessage(error)}`, { cause: error })
        }
        if (fileName.endsWith('.json')) assertJsonFile(this.#sourceFile(fileName))
      }

      throwIfAborted(signal)
      originalManifestText = source.manifestText
      writeJson(join(source.dir, MANIFEST_NAME), {
        ...manifest,
        restored: [...applied],
        skipped: [...skipped],
        restoredAt: new Date().toISOString(),
      }, { mode: 0o600 })
      manifestChanged = true
      const afterManifestWrite = this.#inspect(name)
      if (!afterManifestWrite.valid) throw new BackupError(afterManifestWrite.error ?? '恢复记录写入后校验失败。')

      throwIfAborted(signal)
      this.#writeAudit('backup.restored', { name, preRestore, restored: [...applied], skipped: [...skipped] })
      if (skipped.includes('credentials.json')) this.#log.warn('凭据密文未恢复，请重新填写。')
      this.#onRestored?.()
      this.#log.warn(`备份已恢复：${name}；恢复前数据保存在 ${preRestore}。请按服务安排重启。`)
      return { name, preRestore, restored: [...applied], skipped: [...skipped] }
    } catch (error) {
      const rollbackErrors: string[] = []
      if (preRestore !== undefined && applied.length > 0) {
        try {
          this.#rollback(preRestore, applied)
        } catch (rollbackError) {
          rollbackErrors.push(errorMessage(rollbackError))
        }
      }
      if (manifestChanged && originalManifestText !== undefined && sourceDir !== undefined) {
        try {
          writeFileAtomic(join(sourceDir, MANIFEST_NAME), originalManifestText, { mode: 0o600 })
        } catch (manifestError) {
          rollbackErrors.push(`恢复记录回滚失败：${errorMessage(manifestError)}`)
        }
      }
      this.#writeAudit('backup.restore_failed', {
        name,
        ...(preRestore === undefined ? {} : { preRestore }),
        restored: [...applied],
        skipped: [...skipped],
        rollbackOk: rollbackErrors.length === 0,
        ...(rollbackErrors.length === 0 ? {} : { rollbackErrors }),
        error: errorMessage(error),
      })
      this.#log.error(`备份恢复失败：${errorMessage(error)}`)
      if (rollbackErrors.length > 0) {
        throw new BackupError(`备份恢复失败，且回滚未完全成功：${rollbackErrors.join('；')}`, { cause: error })
      }
      throw error instanceof BackupError ? error : new BackupError(`备份恢复失败：${errorMessage(error)}`, { cause: error })
    }
  }

  /** Restore exactly the pre-restore state of files touched by this attempt. */
  #rollback(preRestore: string, applied: readonly BackupFileName[]): void {
    const pre = this.#inspect(preRestore)
    if (!pre.valid || pre.dir === undefined || pre.manifest === undefined) {
      throw new BackupError(pre.error ?? '恢复前备份不可用。')
    }
    for (const fileName of applied) {
      const target = this.#sourceFile(fileName)
      const expected = pre.manifest.files[fileName]
      if (expected !== undefined) {
        copyFileAtomic(join(pre.dir, fileName), target)
        continue
      }
      // The file did not exist before restore. Removing the newly introduced copy
      // is part of restoring the prior state, unlike deleting unrelated live files.
      try {
        unlinkSync(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new BackupError(`无法移除恢复新建的文件 ${fileName}。`, { cause: error })
        }
      }
    }
    for (const [fileName, expected] of Object.entries(pre.manifest.files)) {
      if (!isBackupFileName(fileName)) throw new BackupError('恢复前备份包含无效文件。')
      try {
        verifyFile(this.#sourceFile(fileName), expected)
      } catch (error) {
        throw new BackupError(`回滚文件 ${fileName} 校验失败：${errorMessage(error)}`, { cause: error })
      }
    }
    for (const fileName of applied) {
      if (pre.manifest.files[fileName] !== undefined) continue
      try {
        lstatSync(this.#sourceFile(fileName))
        throw new BackupError(`回滚后仍存在恢复新建的文件 ${fileName}。`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  /**
   * Delete only verified daily/weekly backups beyond their retention limits.
   * Manual, pre-restore, malformed and unverifiable backups are always retained.
   *
   * @returns the names successfully removed
   */
  prune(): readonly string[] {
    const candidates: { daily: BackupListEntry[]; weekly: BackupListEntry[] } = { daily: [], weekly: [] }
    for (const entry of this.list()) {
      if (!entry.valid || (entry.kind !== 'daily' && entry.kind !== 'weekly')) continue
      const verification = this.#inspect(entry.name)
      if (!verification.valid) continue
      candidates[entry.kind].push(entry)
    }
    const removed: string[] = []
    for (const kind of ['daily', 'weekly'] as const) {
      const keep = kind === 'daily' ? DAILY_KEEP : WEEKLY_KEEP
      const ordered = [...candidates[kind]].sort((left, right) => {
        const byDate = right.createdAt.localeCompare(left.createdAt)
        return byDate === 0 ? right.name.localeCompare(left.name) : byDate
      })
      for (const entry of ordered.slice(keep)) {
        try {
          // Re-check immediately before deletion so a replaced directory or
          // symlink is never recursively removed.
          const verification = this.#inspect(entry.name)
          if (!verification.valid || verification.manifest?.kind !== kind) continue
          rmSync(this.#backupDirectory(entry.name), { recursive: true, force: true })
          removed.push(entry.name)
          this.#log.info(`已清理旧备份：${entry.name}`)
        } catch (error) {
          this.#log.warn(`旧备份保留（无法验证或删除）：${entry.name}：${errorMessage(error)}`)
        }
      }
    }
    const removedNames = new Set(removed)
    const retained = this.list().filter((entry) => !removedNames.has(entry.name))
    const permanent = retained.filter((entry) => entry.kind === 'manual' || entry.kind === 'unknown' || !entry.valid)
    if (permanent.length > 0) {
      const bytes = permanent.reduce((total, entry) => total + entry.bytes, 0)
      this.#log.warn(`当前永久保留 ${permanent.length} 份手动、预备或不可验证备份，共 ${bytes} 字节；请定期检查空间。`)
    }
    return removed
  }
}
