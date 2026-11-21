/**
 * The audit trail.
 *
 * A separate file from the operational log on purpose: the log is for debugging and
 * rotates by size, while this answers "who did what, when" and must survive a busy
 * afternoon. Each line is one JSON object, already redacted, so it can be shipped to
 * a collector or read with `tail -f` without a parser.
 *
 * It is append-only but not tamper-proof — anyone who can write the data directory
 * can edit it. That limit is stated in `docs/security.md` instead of being implied
 * away by the word "audit".
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type AuditEvent =
  | 'admin.created'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.throttled'
  | 'auth.logout'
  | 'auth.password_changed'
  | 'service.shutdown'
  | 'service.restart'
  | 'backup.created'
  | 'backup.restored'
  | 'backup.restore_failed'
  | 'backup.verified'
  | 'diagnostic.exported'
  | 'legacy.scanned'
  | 'legacy.imported'
  | 'autostart.changed'
  | 'settings.write_failed'
  | 'monitor.created'
  | 'monitor.updated'
  | 'monitor.removed'
  | 'monitor.toggled'
  | 'automation.paused'
  | 'automation.resumed'
  | 'monitor.scanned'
  | 'queue.recovered'
  | 'queue.pruned'
  | 'queue.reaped'
  | 'queue.retried'
  | 'store.corrupt'
  | 'store.restored'
  | 'store.migrated'
  | 'store.migrate_failed'

export interface Auditor {
  write(event: AuditEvent, detail?: Record<string, unknown>): void
}

export function createAuditor(file: string, redact: (text: string) => string = (text) => text): Auditor {
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch {
    // A missing directory will surface as a write failure below; the caller only
    // ever warns, because an audit write must not break the request it records.
  }
  return {
    write(event, detail = {}) {
      const record = { at: new Date().toISOString(), event, ...detail }
      let line: string
      try {
        line = redact(JSON.stringify(record))
      } catch {
        line = JSON.stringify({ at: record.at, event, detail: '（无法序列化）' })
      }
      try {
        appendFileSync(file, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
      } catch {
        // Never throw from the audit path.
      }
    },
  }
}
