/**
 * Crash-safe file writes.
 *
 * Every state file this product owns is small, human-inspectable and rewritten
 * whole. That makes "write a temp file, fsync it, rename over the target" the
 * correct primitive: `rename` is atomic on both NTFS and ext4, so a process killed
 * mid-write leaves either the old file or the new one, never a half file.
 *
 * The one thing this deliberately does *not* do is merge. A caller that wants to
 * preserve the previous contents must copy it first — `writeJson` keeps one `.bak`
 * for exactly that, because a corrupted config on a customer machine is otherwise
 * unrecoverable.
 */
import { existsSync, readFileSync, renameSync, copyFileSync, openSync, fsyncSync, closeSync, unlinkSync, chmodSync, writeSync } from 'node:fs'

/** Write UTF-8 text atomically, creating a backup of the previous file. */
export function writeFileAtomic(file: string, contents: string, options: { mode?: number; backup?: string } = {}): void {
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  const fd = openSync(temp, 'w', options.mode ?? 0o600)
  try {
    // fsync before rename: on Linux a rename without it can leave a zero-length
    // file after a power loss, which then looks like "the ledger was empty".
    const buffer = Buffer.from(contents, 'utf8')
    let offset = 0
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset)
      if (written <= 0) break
      offset += written
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
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
    renameSync(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp file is already gone or unremovable; the rename error is the one
      // worth surfacing.
    }
    throw error
  }
  if (options.mode !== undefined && process.platform !== 'win32') {
    try {
      chmodSync(file, options.mode)
    } catch {
      // Permission tightening is best-effort; the file is already written.
    }
  }
}

/** Write a JSON document atomically. */
export function writeJson(file: string, value: unknown, options: { mode?: number; backup?: string } = {}): void {
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
export function readJsonQuarantine<T>(file: string): { value: T | undefined; corrupt: boolean } {
  if (!existsSync(file)) return { value: undefined, corrupt: false }
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')) as T, corrupt: false }
  } catch {
    const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      copyFileSync(file, aside)
    } catch {
      // Nothing else can be done; the caller still refuses to use the file.
    }
    return { value: undefined, corrupt: true }
  }
}
