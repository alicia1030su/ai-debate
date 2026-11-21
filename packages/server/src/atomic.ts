/**
 * Crash-safe file writes.
 *
 * Every state file this product owns is small, human-inspectable and rewritten
 * whole. That makes "write a temp file, fsync it, rename over the target" the
 * correct primitive: `rename` is atomic on both NTFS and ext4, so a process killed
 * mid-write leaves either the old file or the new one, never a half file.
 *
 * Three details are easy to get wrong and are handled here rather than at each
 * call site:
 *
 *   1. **The write must be complete.** A short write that is then renamed would
 *      replace a good file with a truncated one and report success. The loop below
 *      throws instead, and the temp file is unlinked.
 *   2. **The rename must be durable.** `fsync` on the file makes its *contents*
 *      durable, but the directory entry that points at it lives in the parent
 *      directory. Without an `fsync` on that directory, a power loss can leave the
 *      old name pointing at nothing. Linux/macOS get one; Windows has no directory
 *      handles and its rename is journaled, so it is skipped there.
 *   3. **A failed write must not damage the old file.** The target is only touched
 *      by the final rename, and a `.bak` copy is taken before that rename when the
 *      caller asks for one.
 *
 * `AtomicWriteError` carries the reason so a caller can distinguish "the disk is
 * full" (stop pretending to save) from "a permission problem" (tell the operator
 * which path).
 */
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

export type AtomicWriteFailure = 'disk_full' | 'permission' | 'io'

export class AtomicWriteError extends Error {
  readonly kind: AtomicWriteFailure
  readonly target: string

  constructor(kind: AtomicWriteFailure, target: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AtomicWriteError'
    this.kind = kind
    this.target = target
  }
}

/** Map a raw fs error onto the three cases a caller can actually act on. */
function classify(error: unknown, target: string): AtomicWriteError {
  const code = (error as { code?: unknown }).code
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new AtomicWriteError('disk_full', target, `磁盘空间不足，无法写入 ${target}`, { cause: error })
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new AtomicWriteError('permission', target, `没有写入权限：${target}（${String(code)}）`, { cause: error })
  }
  return new AtomicWriteError('io', target, `写入失败：${target}（${String(code ?? 'unknown')}）`, { cause: error })
}

/**
 * Make a rename durable.
 *
 * Opening a directory read-only and calling `fsync` is the POSIX way to flush the
 * directory entry. Windows cannot open a directory as a file descriptor, so the
 * call is skipped there — NTFS journals the rename itself.
 */
function fsyncDirectory(file: string): void {
  if (process.platform === 'win32') return
  let fd: number | undefined
  try {
    fd = openSync(dirname(file), 'r')
    fsyncSync(fd)
  } catch {
    // A directory that cannot be opened for sync is not a reason to fail a write
    // that already succeeded; the file itself is durable.
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

/** Synchronous bounded backoff for Windows rename sharing violations. */
const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 20, 30, 40, 50] as const

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isTransientWindowsRenameError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  const code = (error as { code?: unknown }).code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

function renameWithRetry(temp: string, file: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temp, file)
      return
    } catch (error) {
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]
      if (!isTransientWindowsRenameError(error) || delay === undefined) throw error
      // A concurrent reader/AV/indexer can briefly hold the target or directory
      // open on NTFS. Retry the same fully-written temp file; deleting it here
      // would turn a transient sharing violation into a lost ledger update.
      sleepSync(delay + Math.floor(Math.random() * 5))
    }
  }
}

/** Write UTF-8 text atomically, optionally keeping a backup of the previous file. */
export function writeFileAtomic(
  file: string,
  contents: string,
  options: { mode?: number; backup?: string } = {},
): void {
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  let fd: number | undefined
  try {
    fd = openSync(temp, 'w', options.mode ?? 0o600)
    const buffer = Buffer.from(contents, 'utf8')
    let offset = 0
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset)
      if (written <= 0) {
        // A short write followed by a rename would silently publish a truncated
        // document. There is no recovery from here, so it is an error.
        throw new Error(`短写：只写入 ${offset}/${buffer.length} 字节`)
      }
      offset += written
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // The write error is the one worth reporting.
      }
    }
    try {
      unlinkSync(temp)
    } catch {
      // The temp file may not exist yet.
    }
    throw error instanceof AtomicWriteError ? error : classify(error, file)
  }

  if (options.backup !== undefined && existsSync(file)) {
    try {
      copyFileSync(file, options.backup)
    } catch {
      // A backup that cannot be written must not block the real write; the next
      // successful one will restore the safety net.
    }
  }

  try {
    renameWithRetry(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The rename error is the one worth surfacing.
    }
    throw classify(error, file)
  }
  fsyncDirectory(file)

  if (options.mode !== undefined && process.platform !== 'win32') {
    try {
      chmodSync(file, options.mode)
    } catch {
      // Permission tightening is best-effort; the file is already written.
    }
  }
}

/** Write a JSON document atomically. */
export function writeJson(
  file: string,
  value: unknown,
  options: { mode?: number; backup?: string } = {},
): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options)
}

/** Read a JSON document; `undefined` when it is missing or unparseable. */
export function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** Read a JSON document, keeping the damaged original aside instead of overwriting it. */
export function readJsonQuarantine<T>(file: string): { value: T | undefined; corrupt: boolean; aside?: string } {
  if (!existsSync(file)) return { value: undefined, corrupt: false }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { value: undefined, corrupt: true }
  }
  try {
    return { value: JSON.parse(text) as T, corrupt: false }
  } catch {
    const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      copyFileSync(file, aside)
    } catch {
      // Nothing else can be done; the caller still refuses to use the file.
    }
    return { value: undefined, corrupt: true, aside }
  }
}

/**
 * Load a JSON document with its safety net.
 *
 * Order: the live file, then the backup, then "start empty". A file that parses
 * but fails the caller's own shape check is treated as corrupt by the caller, which
 * is why this returns the parsed value rather than validating it.
 */
export function readJsonWithBackup<T>(
  file: string,
  backup: string,
): { value: T | undefined; corrupt: boolean; restoredFromBackup: boolean; aside?: string } {
  const primary = readJsonQuarantine<T>(file)
  if (!primary.corrupt) {
    return { value: primary.value, corrupt: false, restoredFromBackup: false, ...(primary.aside === undefined ? {} : { aside: primary.aside }) }
  }
  const fallback = readJsonQuarantine<T>(backup)
  if (!fallback.corrupt && fallback.value !== undefined) {
    return {
      value: fallback.value,
      corrupt: true,
      restoredFromBackup: true,
      ...(primary.aside === undefined ? {} : { aside: primary.aside }),
    }
  }
  return {
    value: undefined,
    corrupt: true,
    restoredFromBackup: false,
    ...(primary.aside === undefined ? {} : { aside: primary.aside }),
  }
}

/** Free bytes on the volume that holds `path`; `undefined` when it cannot be read. */
export function freeBytes(path: string): number | undefined {
  try {
    const stats = statfsSync(path)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return undefined
  }
}

/**
 * Refuse to start a large write when the volume is nearly full.
 *
 * The check is deliberately coarse: it exists so that a full disk produces a
 * readable "no space left, nothing was saved" instead of a silently truncated
 * ledger. It does not reserve the space — another process can still fill it.
 */
export function assertWritableSpace(path: string, neededBytes: number, floorBytes = 8 * 1024 * 1024): void {
  const free = freeBytes(path)
  if (free === undefined) return
  if (free < neededBytes + floorBytes) {
    throw new AtomicWriteError(
      'disk_full',
      path,
      `磁盘剩余 ${Math.round(free / 1024 / 1024)} MB，不足以安全写入（需要约 ${Math.round((neededBytes + floorBytes) / 1024 / 1024)} MB）。本次未写入。`,
    )
  }
}
