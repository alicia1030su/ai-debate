/**
 * Where the product keeps its files.
 *
 * One resolver, so "the data directory" is never guessed twice. The order is:
 * an explicit `--data-dir`, then `AI_DEBATE_HOME`, then the platform default under
 * the user's own profile. Nothing here needs administrator rights, and nothing
 * here reads a DSH directory: the old plugin's state is only touched by the
 * explicit import flow.
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

export interface Layout {
  readonly dataDir: string
  readonly configFile: string
  readonly configBackup: string
  readonly credentialsFile: string
  readonly credentialsKey: string
  readonly adminFile: string
  readonly sessionsFile: string
  readonly jobsFile: string
  readonly egressFile: string
  readonly backupsDir: string
  readonly logsDir: string
  readonly logFile: string
  readonly auditFile: string
  readonly runDir: string
  readonly pidFile: string
  readonly runFile: string
  /**
   * The single-instance record.
   *
   * Separate from `run/server.json` because the two answer different questions:
   * the run file is "where is the service I started", which a client reads; this
   * one is "may I start at all", which is only consulted before binding. Keeping
   * one file for both would mean a status read could be confused with a lock.
   */
  readonly instanceFile: string
  readonly controlFile: string
  /** Monitoring targets and their cursors (v0.2.0). */
  readonly monitorsFile: string
  /** Background task ledger for the monitoring pipeline (v0.2.0). */
  readonly autoTasksFile: string
}

/** The platform default data directory. */
export function defaultDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return join(base, 'ai-debate')
  }
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'ai-debate')
  const xdg = env.XDG_DATA_HOME
  if (typeof xdg === 'string' && isAbsolute(xdg)) return join(xdg, 'ai-debate')
  return join(homedir(), '.local', 'share', 'ai-debate')
}

/** Resolve the data directory from an explicit flag, the environment, or the default. */
export function resolveDataDir(options: {
  readonly flag?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly platform?: NodeJS.Platform | undefined
} = {}): string {
  const env = options.env ?? process.env
  if (typeof options.flag === 'string' && options.flag.trim() !== '') return resolve(options.flag.trim())
  const fromEnv = env.AI_DEBATE_HOME
  if (typeof fromEnv === 'string' && isAbsolute(fromEnv) && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return defaultDataDir(options.platform ?? process.platform, env)
}

/** The full file layout for one data directory. */
export function layoutOf(dataDir: string): Layout {
  const dir = resolve(dataDir)
  return {
    dataDir: dir,
    configFile: join(dir, 'config.json'),
    configBackup: join(dir, 'config.json.bak'),
    credentialsFile: join(dir, 'credentials.json'),
    credentialsKey: join(dir, 'credentials.key'),
    adminFile: join(dir, 'admin.json'),
    sessionsFile: join(dir, 'sessions.json'),
    jobsFile: join(dir, 'jobs.json'),
    egressFile: join(dir, 'egress.jsonl'),
    backupsDir: join(dir, 'backups'),
    logsDir: join(dir, 'logs'),
    logFile: join(dir, 'logs', 'server.log'),
    auditFile: join(dir, 'logs', 'audit.jsonl'),
    runDir: join(dir, 'run'),
    pidFile: join(dir, 'run', 'server.pid'),
    runFile: join(dir, 'run', 'server.json'),
    instanceFile: join(dir, 'run', 'instance.lock'),
    monitorsFile: join(dir, 'monitors.json'),
    autoTasksFile: join(dir, 'auto-tasks.json'),
    controlFile: join(dir, 'run', 'control.json'),
  }
}

/** Create every directory the product writes to. */
export function ensureLayout(layout: Layout): void {
  for (const dir of [layout.dataDir, layout.backupsDir, layout.logsDir, layout.runDir]) {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * Best-effort restriction of the data directory to its owner.
 *
 * The directory holds a credential key next to its ciphertext, an administrator
 * password hash and a publish ledger, so "another local account can read it" is a
 * real loss. On Windows the mechanism is an ACL: drop inherited entries and grant
 * the current user full control, which leaves other accounts and `Everyone` out.
 *
 * Failure is a warning, never a refusal. `icacls` is absent from some stripped
 * Windows images, a directory on a FAT volume has no ACLs at all, and a container
 * may run as an account the tool cannot name — in all three cases the product still
 * works and the honest response is to say so, not to refuse to start.
 *
 * @param dir the data directory to tighten
 * @param warn where to report a failure; defaults to the process stderr
 */
export function tightenPermissions(dir: string, warn: (message: string) => void = () => undefined): void {
  if (process.platform !== 'win32') return
  const user = process.env.USERNAME
  if (typeof user !== 'string' || user.trim() === '') return
  try {
    const result = spawnSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user.trim()}:(OI)(CI)F`], {
      stdio: 'ignore',
      timeout: 5000,
    })
    if (result.status !== 0) {
      warn(`无法收紧数据目录的访问权限（icacls 退出码 ${String(result.status)}）。文件仍可正常使用。`)
    }
  } catch (error) {
    warn(`无法收紧数据目录的访问权限：${error instanceof Error ? error.message : String(error)}`)
  }
}
