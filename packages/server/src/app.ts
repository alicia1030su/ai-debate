/**
 * Composition root: everything the process owns, wired in one place.
 *
 * Order matters and is not arbitrary:
 *
 *   1. Files and directories first, because every later step may need to log.
 *   2. The logger, so a failure in any later step is readable.
 *   3. Configuration, credentials and the administrator account — the three
 *      stores the engine reads through the adapter.
 *   4. The job queue, because its handlers close over the stores above.
 *   5. `apply()` last: it builds the runtime, registers the seven route families
 *      and starts reading the config object. Anything it needs must already exist.
 *
 * A failure in step 5 is not fatal to the process: the server still answers
 * `/healthz` (so the launcher and systemd see "alive") and every API route returns
 * 503 with the reason. A product that refuses to start because one subsystem threw
 * is worse than one that starts and says what is broken.
 */
import { apply } from '@ai-debate/core'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AssetStore } from './assets.ts'
import { AuthService, isLoopback } from './auth.ts'
import { ConfigStore } from './config-store.ts'
import { CredentialStore } from './credential-store.ts'
import { createHttpServer } from './http.ts'
import { clearInstance, readInstance, writeInstance } from './instance.ts'
import { JobQueue } from './jobs.ts'
import { Logger, redact, type LogLevel } from './logger.ts'
import { createAuditor } from './audit.ts'
import { ensureLayout, layoutOf, tightenPermissions, type Layout } from './paths.ts'
import { WebServerRegistry } from './registry.ts'
import { createStandaloneHost } from './standalone-host.ts'
import { writeJson } from './atomic.ts'
import { MonitorStore } from './monitor/store.ts'
import { AutoTaskStore } from './monitor/tasks.ts'
import { AutomationEngine, monitorViews } from './monitor/engine.ts'
import type { DebateProductApi } from '../../core/src/product-api.ts'

export interface StartOptions {
  readonly host: string
  readonly port: number
  readonly dataDir: string
  readonly version: string
  readonly logLevel?: LogLevel
  readonly webDir?: string | undefined
  /** Override for tests: do not schedule the periodic backup. */
  readonly scheduleBackups?: boolean
  /** Global cap on concurrent background tasks (default 1). */
  readonly monitorConcurrency?: number
  /** Scheduler tick in milliseconds; tests shrink it. */
  readonly monitorTickMs?: number
  /**
   * Hostnames this deployment answers to, when `--host` cannot express them.
   *
   * The default is {@link trustedHostsFor}(`host`), which is loopback plus the bind
   * address plus whatever `AI_DEBATE_TRUSTED_HOSTS` names. A caller that already
   * knows the list — a reverse-proxy deployment read from a config document, or an
   * acceptance run that drives a `Host` header a loopback socket could not produce
   * — passes it here instead of mutating the process environment.
   */
  readonly trustedHosts?: readonly string[]
}

export interface RunningServer {
  readonly layout: Layout
  readonly log: Logger
  readonly queue: JobQueue
  readonly auth: AuthService
  readonly port: number
  readonly version: string
  readonly toolCount: number
  readonly routePaths: readonly string[]
  readonly mounted: boolean
  readonly mountError?: string
  close(): Promise<void>
}

const AUTO_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000
const KEEP_AUTO_BACKUPS = 7

function sha256OfFile(file: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return undefined
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const layout = layoutOf(options.dataDir)
  ensureLayout(layout)

  const log = new Logger({ level: options.logLevel ?? 'info', file: layout.logFile })
  const audit = createAuditor(layout.auditFile, redact)
  log.info(`AI Debate ${options.version} 启动：数据目录 ${layout.dataDir}`)
  // Best-effort owner-only ACL. Runs after the logger exists so a refusal by
  // `icacls` is visible in the log rather than swallowed.
  tightenPermissions(layout.dataDir, (message) => log.warn(message))

  const config = new ConfigStore({ file: layout.configFile, backup: layout.configBackup })
  const configLoad = config.load(log)
  if (configLoad.corrupt) log.warn('配置文件损坏，已使用空配置启动；原文件已另存')

  const credentials = new CredentialStore({ file: layout.credentialsFile, keyFile: layout.credentialsKey, log })
  credentials.load()

  const auth = new AuthService({
    adminFile: layout.adminFile,
    sessionsFile: layout.sessionsFile,
    log,
    audit,
    loopbackOnlySetup: isLoopback(options.host) || options.host === 'localhost',
  })
  const authLoad = auth.load()
  log.info(authLoad.initialized ? `管理员账号：${auth.username}` : '尚未初始化管理员账号，首次打开将进入初始化页面')

  const queue = new JobQueue({ file: layout.jobsFile, log })
  registerJobHandlers({ queue, layout, config, credentials, log, version: options.version, audit })
  const recovered = queue.start()
  if (recovered.recovered > 0) log.warn(`恢复 ${recovered.recovered} 个中断的任务`)

  const startedAt = new Date().toISOString()
  let actualPort = options.port

  const registry = new WebServerRegistry()
  const host = createStandaloneHost({
    trustedHosts: options.trustedHosts ?? trustedHostsFor(options.host),
    serverInfo: () => ({
      listen: options.host,
      port: actualPort,
      dataDir: layout.dataDir,
      version: options.version,
      startedAt,
      pid: process.pid,
    }),
    config,
    credentials,
    auth,
    audit,
    registry,
    dataDir: layout.dataDir,
    version: options.version,
    log,
  })

  const monitors = new MonitorStore({ file: layout.monitorsFile, log })
  monitors.load()
  if (monitors.loadError !== undefined) log.error(monitors.loadError)

  const autoTasks = new AutoTaskStore({ file: layout.autoTasksFile, log })
  const taskLoad = autoTasks.load()
  const recoveredTasks = autoTasks.recoverInterrupted()
  if (recoveredTasks > 0) log.warn(`恢复 ${recoveredTasks} 个中断的后台任务`)
  void taskLoad

  let productApi: DebateProductApi | undefined
  let engine: AutomationEngine | undefined

  let mounted = true
  let mountError: string | undefined
  try {
    // The adapter is structurally a plugin context; the core's exported type is
    // narrower than the object it actually reads, so the cast is at the boundary
    // and nowhere else.
    apply(host.ctx as never, config.raw, {
      onReady: (api) => {
        productApi = api
      },
    })
    log.info(`辩论引擎挂载完成：${host.tools.length} 个工具、${registry.size} 条路由`)
  } catch (error) {
    mounted = false
    mountError = error instanceof Error ? error.message : String(error)
    log.error(`辩论引擎挂载失败：${mountError}。管理接口将返回 503。`)
  }

  credentials.onChange((ref) => host.emitCredentialUpdate(ref))

  const assets = new AssetStore({ diskRoot: options.webDir })
  const assetInfo = await assets.init()
  if (assetInfo.keys === 0) {
    log.error('没有找到任何网页资源。打包产物缺少 web 资源，或开发态未先运行 npm run build:web。')
  } else {
    log.info(`网页资源：${assetInfo.keys} 个（${assetInfo.source}）`)
  }

  let closing: Promise<void> | undefined

  const legacy = {
    /** Read the old plugin's ledger without touching it. */
    scan(): { found: boolean; dir: string; sessions: number; ledger: number; approvals: number; bytes: number } {
      const dir = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'ai-debate')
      const file = join(dir, 'state.json')
      if (!existsSync(file)) return { found: false, dir, sessions: 0, ledger: 0, approvals: 0, bytes: 0 }
      try {
        const text = readFileSync(file, 'utf8')
        const parsed = JSON.parse(text) as { sessions?: unknown[]; ledger?: unknown[]; approvals?: unknown[] }
        return {
          found: true,
          dir,
          sessions: (parsed.sessions ?? []).length,
          ledger: (parsed.ledger ?? []).length,
          approvals: (parsed.approvals ?? []).length,
          bytes: text.length,
        }
      } catch {
        return { found: true, dir, sessions: 0, ledger: 0, approvals: 0, bytes: 0 }
      }
    },
    /**
     * Copy the old ledger in, refusing to merge.
     *
     * A merge would have to guess which publish records are the same event, and
     * guessing wrong re-permits a duplicate post. So this only runs into an empty
     * installation, and it copies rather than moves.
     */
    import(): { ok: boolean; message: string } {
      const scan = this.scan()
      if (!scan.found) return { ok: false, message: `没有找到旧数据（${scan.dir}）。` }
      const target = join(layout.dataDir, 'state.json')
      if (existsSync(target)) {
        try {
          const existing = JSON.parse(readFileSync(target, 'utf8')) as { sessions?: unknown[] }
          if ((existing.sessions ?? []).length > 0) {
            return { ok: false, message: '当前实例已经有会话数据，拒绝合并。请先备份并手动清理后再导入。' }
          }
        } catch {
          return { ok: false, message: '当前台账无法解析，拒绝覆盖。' }
        }
      }
      copyFileSync(join(scan.dir, 'state.json'), `${target}.pre-import-${Date.now()}`)
      copyFileSync(join(scan.dir, 'state.json'), target)
      log.warn(`已从旧插件目录导入台账：${scan.dir}（原文件保留）`)
      audit.write('legacy.imported', { dir: scan.dir, sessions: scan.sessions, ledger: scan.ledger })
      return { ok: true, message: `已导入 ${scan.sessions} 个会话、${scan.ledger} 条台账、${scan.approvals} 条审批。旧文件未改动，凭据需要重新填写。` }
    },
  }

  /**
   * What is on disk under `backups/`, newest first.
   *
   * Read on demand rather than cached: the jobs page's restore control must name a
   * directory that exists *now*, and a cached list would offer one that was pruned
   * by the auto-backup rotation an hour ago. A directory without a manifest is
   * listed with `files: 0` instead of being hidden — it is a fact on disk, and
   * hiding it would make "restore says the backup does not exist" inexplicable.
   */
  const backups = {
    list(): readonly { name: string; createdAt: string; files: number; bytes: number }[] {
      const out: { name: string; createdAt: string; files: number; bytes: number }[] = []
      let names: string[]
      try {
        names = readdirSync(layout.backupsDir)
      } catch {
        return out
      }
      for (const name of names) {
        const dir = join(layout.backupsDir, name)
        let files = 0
        let bytes = 0
        try {
          if (!statSync(dir).isDirectory()) continue
          for (const file of readdirSync(dir)) {
            const info = statSync(join(dir, file))
            if (!info.isFile()) continue
            files += 1
            bytes += info.size
          }
        } catch {
          // A directory being written or removed right now: report it as it stands.
        }
        out.push({ name, createdAt: name.startsWith('pre-restore-') ? name.slice(11) : name, files, bytes })
      }
      return out.sort((a, b) => b.name.localeCompare(a.name))
    },
  }

  const info = (): Record<string, unknown> => ({
    server: {
      version: options.version,
      pid: process.pid,
      host: options.host,
      port: actualPort,
      dataDir: layout.dataDir,
      startedAt,
      uptimeSec: Math.round(process.uptime()),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      mounted,
      ...(mountError === undefined ? {} : { mountError }),
    },
    engine: { tools: host.tools.length, routes: registry.paths() },
    store: {
      // `path`/`sizeBytes` are the two facts a "is my data where I think it is"
      // check needs, and they are answered by the engine's own directory rather
      // than by this process's guess about it.
      path: join(layout.dataDir, 'state.json'),
      sizeBytes: (() => {
        try {
          return statSync(join(layout.dataDir, 'state.json')).size
        } catch {
          return 0
        }
      })(),
      configBytes: config.sizeBytes(),
      credentialsBytes: credentials.sizeBytes(),
      queueBytes: queue.sizeBytes(),
    },
    legacy: detectLegacy(),
    backups: backups.list(),
  })

  const shutdown = (reason: string): void => {
    log.info(`收到停止请求：${reason}`)
    audit.write('service.shutdown', { reason })
    setTimeout(() => {
      void close().finally(() => process.exit(0))
    }, 250)
  }
  const restart = (reason: string): void => {
    log.info(`收到重启请求：${reason}`)
    audit.write('service.restart', { reason })
    setTimeout(() => {
      void close().finally(() => process.exit(75))
    }, 250)
  }

  const server = createHttpServer({
    auth,
    queue,
    registry,
    assets,
    log,
    version: options.version,
    dataDir: layout.dataDir,
    startedAt,
    secureCookies: false,
    host: options.host,
    port: () => actualPort,
    info,
    controlToken: readControlToken(layout) ?? writeControlToken(layout),
    legacy,
    backups,
    audit,
    automation: {
      status: (): Record<string, unknown> => ((engine?.status() ?? { paused: true, running: false, concurrency: 1, perPlatform: 1, monitors: { total: 0, enabled: 0, blocked: 0 }, tasks: {}, today: { discovered: 0, candidates: 0, failures: 0 }, queued: 0, runningTasks: 0 }) as unknown as Record<string, unknown>),
      monitors: () => monitorViews(monitors.list(), autoTasks.all()),
      tasks: (limit: number) => autoTasks.list(limit),
      reviews: () => autoTasks
        .list(400)
        .filter((task) => task.state === 'needs_review')
        .map((task) => ({
          taskId: task.id,
          monitorId: task.monitorId,
          sessionId: task.sessionId,
          postId: task.postId,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          monitorName: monitors.get(task.monitorId)?.name,
          threadUrl: monitors.get(task.monitorId)?.url,
        })),
      createMonitor: (input: { name: string; url: string; intervalSec?: number; accountLabel?: string }) => {
        const resolved = productApi === undefined ? undefined : productApi.resolveUrl(input.url)
        if (resolved === undefined) throw new Error('无法识别这个链接所属的平台。请粘贴完整的帖子链接。')
        if (monitors.findByThread(resolved.platform, resolved.threadId) !== undefined) {
          throw new Error('这个帖子已经在监控列表里了。请直接在列表里编辑它。')
        }
        const monitor = monitors.create(input, resolved)
        // A brand-new monitor gets one immediate check, so the owner sees
        // something happen instead of waiting a full interval to learn it works.
        autoTasks.enqueue({ kind: 'probe', monitorId: monitor.id, dedupeKey: `probe:${monitor.id}` })
        return monitor
      },
      updateMonitor: (id: string, patch: { name?: string; intervalSec?: number; enabled?: boolean; accountLabel?: string }) => {
        if (patch.enabled === true) monitors.clearBlock(id)
        return monitors.update(id, patch)
      },
      removeMonitor: (id: string) => monitors.remove(id),
      checkNow: (id: string) => engine?.checkNow(id) ?? { ok: false, message: '后台引擎未启动。' },
      pauseAll: () => engine?.pause(),
      resumeAll: () => engine?.resume(),
      cancelTask: (id: string) => autoTasks.cancel(id),
      loadErrors: () => [monitors.loadError, autoTasks.loadError].filter((entry): entry is string => entry !== undefined),
    },
    actions: {
      shutdown,
      restart,
      autostart: (enable) => setAutostart(enable),
    },
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      const address = server.address()
      if (address !== null && typeof address === 'object') actualPort = address.port
      resolve()
    })
  })

  writeJson(
    layout.runFile,
    {
      pid: process.pid,
      host: options.host,
      port: actualPort,
      version: options.version,
      startedAt,
      dataDir: layout.dataDir,
    },
    { mode: 0o600, backup: undefined },
  )
  writeFileSync(layout.pidFile, String(process.pid), { encoding: 'utf8', mode: 0o600 })
  writeInstance(layout.instanceFile, {
    pid: process.pid,
    host: options.host,
    port: actualPort,
    startedAt,
    version: options.version,
  })

  log.info(`监听 http://${options.host}:${actualPort}/`)

  engine = new AutomationEngine({
    monitors,
    tasks: autoTasks,
    api: () => productApi,
    log,
    ...(options.monitorConcurrency === undefined ? {} : { concurrency: options.monitorConcurrency }),
    ...(options.monitorTickMs === undefined ? {} : { tickMs: options.monitorTickMs }),
  })
  if (mounted) {
    engine.start()
  } else {
    log.warn('辩论引擎未挂载，后台挂机不启动（监控配置保留，修复后重启即可继续）')
  }

  let autoBackupTimer: NodeJS.Timeout | undefined
  if (options.scheduleBackups !== false) {
    const schedule = (): void => {
      try {
        // `payload.auto` is what makes this one eligible for rotation. The key alone
        // could not be trusted for that: a user may queue their own backup with any
        // key they like, and a manual backup must never be pruned automatically.
        queue.enqueue({ type: 'backup.create', key: `auto-backup-${new Date().toISOString().slice(0, 10)}`, payload: { auto: true } })
      } catch (error) {
        log.warn(`自动备份排队失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    autoBackupTimer = setInterval(schedule, AUTO_BACKUP_INTERVAL_MS)
    autoBackupTimer.unref?.()
    // One soon after boot, so an installation that is never left running for six
    // hours still ends up with a usable backup.
    setTimeout(() => {
      if (existsSync(join(layout.dataDir, 'state.json'))) schedule()
    }, 30_000).unref?.()
  }

  async function close(): Promise<void> {
    if (closing !== undefined) return closing
    closing = (async () => {
      if (autoBackupTimer !== undefined) clearInterval(autoBackupTimer)
      if (engine !== undefined) await engine.stop()
      await queue.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      // The run file is what "is it running" reads; leaving it behind would make a
      // stopped service look alive.
      try {
        unlinkSync(layout.runFile)
      } catch {
        // Already gone.
      }
      try {
        unlinkSync(layout.pidFile)
      } catch {
        // Already gone.
      }
      // Only remove the instance record if it is still ours: a second instance
      // that deliberately took the lock over must not have it deleted underneath.
      const instance = readInstance(layout.instanceFile)
      if (instance === undefined || instance.pid === process.pid) clearInstance(layout.instanceFile)
      log.info('服务已停止')
    })()
    return closing
  }

  return {
    layout,
    log,
    queue,
    auth,
    port: actualPort,
    version: options.version,
    toolCount: host.tools.length,
    routePaths: registry.paths(),
    mounted,
    ...(mountError === undefined ? {} : { mountError }),
    close,
  }

  function detectLegacy(): { found: boolean; dir: string; note: string } {
    const legacy = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'ai-debate')
    const found = existsSync(join(legacy, 'state.json'))
    return {
      found,
      dir: legacy,
      note: found
        ? '发现旧 DSH 插件的数据。它不会被自动读取或修改；需要的话在系统页主动导入。'
        : '没有发现旧插件数据。',
    }
  }
}

/** The four names that always mean "this machine". */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * Which Host header values this deployment answers to.
 *
 * The list is derived from the configured bind address — never from the request —
 * because a fence that trusts whatever the client claims is not a fence.
 *
 * ## Why an all-interfaces bind adds nothing
 *
 * `--host 0.0.0.0` means "reachable on some address of this machine", but it does
 * not say *which* name the browser will use. Enumerating the local interfaces
 * would answer that question by guessing: the set changes with DHCP, VPNs and
 * container bridges, and an address that happens to exist is not a name the
 * operator agreed to serve. A guessed entry also cannot be audited — the owner
 * could not tell from the settings page why a particular Host was accepted. So
 * the wildcard bind trusts only loopback, and a LAN or reverse-proxy deployment
 * names its host explicitly through `AI_DEBATE_TRUSTED_HOSTS` (comma separated).
 * That is one line of configuration in exchange for a fence whose contents are
 * exactly what a human wrote down.
 *
 * @param host the address the listener is bound to
 * @param env environment to read `AI_DEBATE_TRUSTED_HOSTS` from
 * @returns the hostnames a request's `Host` header must match
 */
export function trustedHostsFor(host: string, env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const hosts = new Set<string>(LOOPBACK_HOSTS)
  const wildcard = host === '0.0.0.0' || host === '::' || host === ''
  if (!wildcard) hosts.add(host)
  const extra = env.AI_DEBATE_TRUSTED_HOSTS
  if (typeof extra === 'string') {
    for (const entry of extra.split(',')) {
      const trimmed = entry.trim()
      if (trimmed !== '') hosts.add(trimmed)
    }
  }
  return [...hosts]
}

function readControlToken(layout: Layout): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(layout.controlFile, 'utf8')) as { token?: unknown }
    return typeof parsed.token === 'string' && parsed.token.length >= 16 ? parsed.token : undefined
  } catch {
    return undefined
  }
}

function writeControlToken(layout: Layout): string {
  const token = createHash('sha256').update(`${layout.dataDir}:${process.pid}:${Date.now()}:${Math.random()}`).digest('hex')
  writeJson(layout.controlFile, { token }, { mode: 0o600 })
  return token
}

/** Windows only: the per-user Run entry. Never touches machine-wide settings. */
export function setAutostart(enable: boolean): { ok: boolean; message: string } {
  if (process.platform !== 'win32') {
    return { ok: false, message: '开机自启只在 Windows 上由本程序管理；Linux 请用 systemctl enable ai-debate。' }
  }
  const exe = process.execPath
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
  if (!enable) {
    const result = spawnSync('reg', ['delete', key, '/v', 'AIDebate', '/f'], { stdio: 'ignore' })
    return { ok: true, message: result.status === 0 ? '已关闭开机自启。' : '开机自启本来就是关闭的。' }
  }
  const result = spawnSync('reg', ['add', key, '/v', 'AIDebate', '/t', 'REG_SZ', '/d', `"${exe}"`, '/f'], { stdio: 'ignore' })
  return result.status === 0
    ? { ok: true, message: '已开启开机自启（仅当前用户）。' }
    : { ok: false, message: '写入注册表失败，可能被安全软件拦截。' }
}

interface JobDeps {
  readonly queue: JobQueue
  readonly layout: Layout
  readonly config: ConfigStore
  readonly credentials: CredentialStore
  readonly log: Logger
  readonly version: string
  readonly audit: ReturnType<typeof createAuditor>
}

function registerJobHandlers(deps: JobDeps): void {
  const { queue, layout, config, credentials, log, version, audit } = deps

  queue.register('backup.create', async ({ payload, note }) => {
    // A scheduled backup and an owner-requested one are the same file, but only the
    // scheduled ones are subject to rotation. Without this distinction the auto
    // backup taken at 03:00 would delete the copy the owner took before restoring a
    // bad config — the one backup in the set they actually need.
    const auto = payload.auto === true
    const dir = join(layout.backupsDir, stamp())
    mkdirSync(dir, { recursive: true })
    const files = ['config.json', 'state.json', 'jobs.json']
    const entries: Record<string, { sha256: string; bytes: number }> = {}
    for (const name of files) {
      const source = join(layout.dataDir, name)
      if (!existsSync(source)) continue
      const target = join(dir, name)
      copyFileSync(source, target)
      entries[name] = { sha256: sha256OfFile(target) ?? '', bytes: statSync(target).size }
    }
    writeFileSync(
      join(dir, 'manifest.json'),
      `${JSON.stringify(
        { version, createdAt: new Date().toISOString(), auto, files: entries, note: '不含凭据、口令与会话' },
        null,
        2,
      )}\n`,
      'utf8',
    )
    note('info', `备份完成：${dir}（${Object.keys(entries).length} 个文件${auto ? '，自动备份' : ''}）`)
    audit.write('backup.created', { dir, files: Object.keys(entries).length, auto })
    if (auto) pruneAutoBackups()
  })

  /** Keep the newest N *scheduled* backups; manual ones are never deleted. */
  function pruneAutoBackups(): void {
    try {
      const auto: string[] = []
      for (const name of readdirSync(layout.backupsDir)) {
        if (!/^\d{4}-\d{2}-\d{2}T/.test(name)) continue
        try {
          const manifest = JSON.parse(readFileSync(join(layout.backupsDir, name, 'manifest.json'), 'utf8')) as {
            auto?: unknown
          }
          if (manifest.auto === true) auto.push(name)
        } catch {
          // A directory without a readable manifest cannot be proven automatic, so
          // it is left alone: deleting the wrong backup is unrecoverable.
        }
      }
      auto.sort()
      for (const name of auto.slice(0, Math.max(0, auto.length - KEEP_AUTO_BACKUPS))) {
        rmSync(join(layout.backupsDir, name), { recursive: true, force: true })
        log.info(`自动备份超过 ${KEEP_AUTO_BACKUPS} 份，已删除最旧的一份：${name}`)
      }
    } catch {
      // Pruning is housekeeping; failing it only means the disk keeps more copies.
    }
  }

  queue.register('backup.restore', async ({ payload, note }) => {
    const name = typeof payload.dir === 'string' ? payload.dir : ''
    if (!/^\d{4}-\d{2}-\d{2}T[\w-]+$/.test(name)) throw new Error('备份目录名不合法。')
    const dir = join(layout.backupsDir, name)
    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) throw new Error('这个备份缺少 manifest.json，拒绝恢复。')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files?: Record<string, { sha256?: string }> }
    for (const [file, expected] of Object.entries(manifest.files ?? {})) {
      const actual = sha256OfFile(join(dir, file))
      if (actual === undefined) throw new Error(`备份缺少文件 ${file}。`)
      if (typeof expected.sha256 === 'string' && expected.sha256 !== '' && actual !== expected.sha256) {
        throw new Error(`备份文件 ${file} 校验失败（可能已损坏）。`)
      }
    }
    // Keep the current state aside before overwriting it. A restore that cannot be
    // undone is how a bad backup destroys the good data.
    const pre = join(layout.backupsDir, `pre-restore-${stamp()}`)
    mkdirSync(pre, { recursive: true })
    for (const name of ['config.json', 'state.json', 'jobs.json']) {
      const source = join(layout.dataDir, name)
      if (existsSync(source)) copyFileSync(source, join(pre, name))
    }
    for (const name of ['config.json', 'state.json', 'jobs.json']) {
      const source = join(dir, name)
      if (existsSync(source)) copyFileSync(source, join(layout.dataDir, name))
    }
    if (existsSync(join(dir, 'config.json'))) {
      const restored = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>
      config.replaceAll(restored)
    }
    note('info', `已从 ${name} 恢复；恢复前的数据保存在 ${pre}`)
    audit.write('backup.restored', { dir: name, preRestore: pre })
    log.warn('备份已恢复，请重启服务以重新加载台账。')
  })

  queue.register('logs.rotate', async ({ note }) => {
    const target = layout.logFile
    if (!existsSync(target)) {
      note('info', '当前没有日志文件可轮转。')
      return
    }
    const previous = `${target}.1`
    if (existsSync(previous)) unlinkSync(previous)
    copyFileSync(target, previous)
    writeFileSync(target, '', 'utf8')
    note('info', `日志已轮转到 ${previous}`)
  })

  queue.register('credentials.audit', async ({ note }) => {
    const refs = credentials.configuredRefs()
    note('info', `凭据存储可解密，共 ${refs.length} 个引用：${refs.join('、') || '（空）'}`)
    for (const ref of refs) {
      const resolved = await credentials.resolve(ref)
      if (resolved === undefined) note('warn', `凭据 ${ref} 存在但无法解密。`)
    }
  })

  queue.register('storage.check', async ({ note }) => {
    const statePath = join(layout.dataDir, 'state.json')
    if (!existsSync(statePath)) {
      note('info', '还没有台账文件（尚未导入或分析过讨论）。')
      return
    }
    const text = readFileSync(statePath, 'utf8')
    const parsed = JSON.parse(text) as { sessions?: unknown[]; ledger?: unknown[]; approvals?: unknown[] }
    note(
      'info',
      `台账可解析：${(parsed.sessions ?? []).length} 个会话、${(parsed.ledger ?? []).length} 条台账、${(parsed.approvals ?? []).length} 条审批；文件 ${Math.round(text.length / 1024)} KB。`,
    )
  })
}
