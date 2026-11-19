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
  readonly controlFile: string
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
    controlFile: join(dir, 'run', 'control.json'),
  }
}

/** Create every directory the product writes to. */
export function ensureLayout(layout: Layout): void {
  for (const dir of [layout.dataDir, layout.backupsDir, layout.logsDir, layout.runDir]) {
    mkdirSync(dir, { recursive: true })
  }
}
