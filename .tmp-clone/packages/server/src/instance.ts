/**
 * One data directory, one writer.
 *
 * The engine keeps its ledger in `state.json` and already serialises its own writes,
 * so two processes cannot corrupt it. What they *can* do is make the product lie:
 * two consoles showing the same ledger, each holding its own session table, each
 * with an "already running" banner that is true only of itself. Configuration is
 * worse — the second process's in-memory copy goes stale, and every save from the
 * older window answers with the conflict message until the user reloads.
 *
 * So `serve` refuses to start when this directory already has a live instance. The
 * record is the same shape the CLI's `status` reads, and liveness is decided by two
 * facts that a stale file cannot fake: the pid still exists, and the service still
 * answers `/healthz` on the port it claims.
 *
 * The record is **not** a lock in the mutual-exclusion sense — nothing is held while
 * it exists, and no kernel primitive is involved. A determined operator can start a
 * second instance by deleting the file, which is exactly the escape hatch a
 * false-positive needs. The goal is to make the mistake impossible to make by
 * accident, not to make it impossible.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { writeJson } from './atomic.ts'

/** What a running instance tells a starting one. */
export interface InstanceRecord {
  readonly pid: number
  readonly host: string
  readonly port: number
  readonly startedAt: string
  readonly version: string
}

/** Read the instance record, or nothing when it is absent or damaged. */
export function readInstance(file: string): InstanceRecord | undefined {
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<InstanceRecord>
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined
    if (typeof parsed.port !== 'number') return undefined
    return {
      pid: parsed.pid,
      host: typeof parsed.host === 'string' ? parsed.host : '127.0.0.1',
      port: parsed.port,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      version: typeof parsed.version === 'string' ? parsed.version : '',
    }
  } catch {
    return undefined
  }
}

/**
 * Whether a process with this pid exists.
 *
 * `EPERM` counts as alive: on both Windows and Linux it means the process is there
 * and belongs to someone else, and treating it as dead would take the lock away
 * from a perfectly healthy service.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Record this process as the directory's writer. */
export function writeInstance(file: string, record: InstanceRecord): void {
  writeJson(file, record, { mode: 0o600, backup: undefined })
}

/** Forget the record, ignoring an already-absent file. */
export function clearInstance(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    // Already gone, or the directory went with it.
  }
}
