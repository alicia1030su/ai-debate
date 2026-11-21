/**
 * Composition root: everything the process owns, wired in one place.
 *
 * Order matters and is not arbitrary:
 *
 *   1. Files and directories first, because every later step may need to log.
 *   2. The logger, so a failure in any later step is readable.
 *   3. Configuration, credentials and the administrator account — the three
 *      stores the engine reads through the adapter.
 *   4. The job queue and monitor ledgers, because their handlers and migration
 *      close over the stores above.
 *   5. Legacy reply-identity migration, before automation can observe a monitor.
 *   6. `apply()` last: it builds the runtime, registers the seven route families
 *      and starts reading the config object. Anything it needs must already exist.
 *
 * A failure in step 5 or 6 is not fatal to the process: the server still answers
 * `/healthz` (so the launcher and systemd see "alive") and every API route returns
 * 503 with the reason. A product that refuses to start because one subsystem threw
 * is worse than one that starts and says what is broken.
 */
import { apply } from '@ai-debate/core'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
import { freeBytes, writeJson } from './atomic.ts'
import { MonitorStore } from './monitor/store.ts'
import { AutoTaskStore } from './monitor/tasks.ts'
import { AutomationEngine, classifyFailure, monitorViews, type EngineStatus } from './monitor/engine.ts'
import { ReplyIdentityStore } from './monitor/identities.ts'
import { migrateLegacyReplyIdentities } from './monitor/migrate.ts'
import { BackupService, type BackupListEntry, type BackupKind } from './backup.ts'
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
  /** Send Secure session cookies. Enable only when the browser uses HTTPS. */
  readonly secureCookies?: boolean
  /** Test seam: receive shutdown exit codes instead of terminating the process. */
  readonly exitProcess?: ((code: number) => void) | undefined
  /** Test seam: delay before a controlled shutdown/restart. */
  readonly restartDelayMs?: number
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
  /** Automation is circuit-broken when legacy identity migration cannot finish. */
  readonly automationDisabled?: string
  close(): Promise<void>
}

const AUTO_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000

interface BackupSummary {
  readonly total: number
  readonly daily: number
  readonly weekly: number
  readonly manual: number
  readonly latest: { readonly name: string; readonly createdAt: string; readonly kind: string; readonly bytes: number } | null
  readonly invalid: number
}

function summarizeBackups(entries: readonly BackupListEntry[]): BackupSummary {
  const latest = entries.find((entry) => entry.valid)
  return {
    total: entries.length,
    daily: entries.filter((entry) => entry.kind === 'daily').length,
    weekly: entries.filter((entry) => entry.kind === 'weekly').length,
    manual: entries.filter((entry) => entry.kind === 'manual').length,
    latest: latest === undefined ? null : { name: latest.name, createdAt: latest.createdAt, kind: latest.kind, bytes: latest.bytes },
    invalid: entries.filter((entry) => !entry.valid).length,
  }
}

/** Size of one file, or zero when it does not exist (or is not readable). */
function fileSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/**
 * Total size of the files directly inside `dir`.
 *
 * Deliberately not recursive into subdirectories other than `logs` and `backups`:
 * the number exists to answer "is my data directory growing without bound", and a
 * full walk on every status poll would itself be a cost. A failure to read a file
 * is skipped rather than failing the whole number.
 */
function dirSize(dir: string): number {
  let total = 0
  const stack = [dir]
  let guard = 0
  while (stack.length > 0 && guard < 2000) {
    const current = stack.pop() as string
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      guard += 1
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        // `backups` holds rotated copies; including them answers "how much disk
        // does this service use", which is the question being asked.
        if (entry.name === 'backups' || entry.name === 'logs' || current === dir) stack.push(full)
        continue
      }
      try {
        total += statSync(full).size
      } catch {
        // A file that vanished between readdir and stat contributes nothing.
      }
    }
  }
  return total
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

  const configuredTrustedHosts = options.trustedHosts ?? trustedHostsFor(options.host)
  const loopbackNames = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
  // A loopback *bind* does not prove the browser is local: a reverse proxy accepts
  // remote users and connects to us from 127.0.0.1. If the operator named any
  // non-loopback Host, first-run setup must require the one-time token just like a
  // directly exposed listener.
  const loopbackOnlySetup =
    (isLoopback(options.host) || options.host === 'localhost') &&
    configuredTrustedHosts.every((entry) => loopbackNames.has(entry))
  const auth = new AuthService({
    adminFile: layout.adminFile,
    sessionsFile: layout.sessionsFile,
    log,
    audit,
    loopbackOnlySetup,
  })
  const authLoad = auth.load()
  log.info(authLoad.initialized ? `管理员账号：${auth.username}` : '尚未初始化管理员账号，首次打开将进入初始化页面')

  const queue = new JobQueue({ file: layout.jobsFile, receiptFile: join(layout.runDir, 'job-receipts.json'), log })
  let engine: AutomationEngine | undefined
  let restoreCompleted = false
  const backupService = new BackupService({
    layout,
    version: options.version,
    log,
    audit,
    onRestored: (): void => {
      restoreCompleted = true
    },
  })
  registerJobHandlers({
    queue,
    layout,
    credentials,
    log,
    backups: backupService,
    stopEngine: async (): Promise<boolean> => {
      if (engine === undefined) return false
      try {
        await engine.stop()
        if (engine.status().runningTasks > 0) throw new Error('后台任务未能在停机期限内结束，拒绝恢复。')
        return true
      } catch (error) {
        engine.start()
        throw error
      }
    },
    restartEngine: (): boolean => {
      if (engine === undefined) return false
      engine.start()
      return engine.status().running
    },
    restartAfterRestore: (): void => restart('备份恢复完成，需要重新加载台账与监控内存态'),
  })
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

  const monitors = new MonitorStore({
    file: layout.monitorsFile,
    log,
    onEvent: (event, detail) => {
      if (event === 'write_failed') log.error(`监控配置写入失败：${String(detail.reason ?? '')}`)
      else if (event === 'corrupt') audit.write('store.corrupt', { file: String(detail.file ?? '') })
      else if (event === 'restored') audit.write('store.restored', { file: String(detail.file ?? '') })
    },
  })
  const monitorLoad = monitors.load()
  if (monitors.loadError !== undefined) log.error(monitors.loadError)
  if (monitorLoad.migrated) {
    log.info('监控配置已从 v0.2.0 结构升级；旧字段保留，新字段按默认值补齐')
    audit.write('store.migrated', { file: 'monitors.json' })
    // Writing it back once means the next start reads the current shape instead of
    // re-running the same defaults forever. A failure here is not fatal: the
    // in-memory document is already usable, and a read-only data directory should
    // still let the service start and report the problem.
    try {
      monitors.save()
    } catch (error) {
      log.warn(`监控配置迁移未能写回：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const identities = new ReplyIdentityStore({
    file: layout.identitiesFile,
    log,
    onEvent: (event, detail) => {
      if (event === 'write_failed') log.error(`全局回复身份写入失败：${String(detail.reason ?? '')}`)
      else if (event === 'corrupt') audit.write('store.corrupt', { file: String(detail.file ?? '') })
      else if (event === 'restored') audit.write('store.restored', { file: String(detail.file ?? '') })
    },
  })
  identities.load()
  if (identities.loadError !== undefined) log.error(identities.loadError)

  const autoTasks = new AutoTaskStore({
    file: layout.autoTasksFile,
    log,
    ...(process.env.AI_DEBATE_QUEUE_CAPACITY === undefined
      ? {}
      : { capacity: Number(process.env.AI_DEBATE_QUEUE_CAPACITY) }),
    onEvent: (event, detail) => {
      if (event === 'write_failed') log.error(`任务台账写入失败：${String(detail.reason ?? '')}`)
      else if (event === 'corrupt') audit.write('store.corrupt', { file: String(detail.file ?? '') })
      else if (event === 'restored') audit.write('store.restored', { file: String(detail.file ?? '') })
      else if (event === 'pruned') audit.write('queue.pruned', detail)
    },
  })
  autoTasks.load()
  const recovery = autoTasks.recoverInterrupted()
  if (recovery.recovered > 0) {
    log.warn(`恢复 ${recovery.recovered} 个中断的后台任务，其中 ${recovery.uncertain} 个模型调用结果不确定`)
    audit.write('queue.recovered', { recovered: recovery.recovered, uncertain: recovery.uncertain })
  }

  // Rebuild the global reply fence only when the durable ledger is absent or an
  // old analyze/generate task still lacks its identity key. A completed upgrade
  // must not re-read an unrelated, later-corrupted core ledger on every boot.
  const needsIdentityMigration = !existsSync(layout.identitiesFile)
    || autoTasks.all().some((task) => (task.kind === 'analyze' || task.kind === 'generate')
      && !((typeof task.identityKey === 'string' && task.identityKey.trim() !== '')
        || (task.identityKeys?.some((key) => key.trim() !== '') ?? false)))
  let identityMigrationError: string | undefined
  try {
    if (monitors.loadError !== undefined) throw new Error(monitors.loadError)
    if (autoTasks.loadError !== undefined) throw new Error(autoTasks.loadError)
    if (identities.loadError !== undefined) throw new Error(identities.loadError)
    if (identities.restoredFromBackup) {
      throw new Error('全局回复身份台账从备份恢复后尚未落盘，拒绝在不稳定的身份边界上启动。')
    }
    if (needsIdentityMigration) {
      const migration = migrateLegacyReplyIdentities({
        monitorsFile: layout.monitorsFile,
        tasksFile: layout.autoTasksFile,
        stateFile: join(layout.dataDir, 'state.json'),
        identities,
        tasks: autoTasks,
        log,
      })
      log.info(
        `回复身份迁移完成：${migration.identities} 条身份（新增 ${migration.identitiesAdded}、候选 ${migration.candidates}、占用 ${migration.claimed}、忽略 ${migration.ignored}），回填 ${migration.tasksBackfilled} 个任务`,
      )
      audit.write('store.migrated', {
        file: 'reply-identities.json',
        identityWritten: migration.identityWritten,
        alreadyComplete: migration.alreadyComplete,
        identities: migration.identities,
        identitiesAdded: migration.identitiesAdded,
        candidates: migration.candidates,
        claimed: migration.claimed,
        ignored: migration.ignored,
        tasksBackfilled: migration.tasksBackfilled,
        errors: migration.errors,
        warnings: migration.warnings,
      })
    }
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/[。.]$/, '')
    identityMigrationError = `回复身份迁移失败：${detail}`
    log.error(`${identityMigrationError}。后台挂机已熔断，修复数据后重启即可恢复。`)
    audit.write('store.migrate_failed', { file: 'reply-identities.json', reason: identityMigrationError })
  }

  let productApi: DebateProductApi | undefined

  if (identityMigrationError !== undefined) {
    // Keep the management/settings surface mounted, but make every core write
    // path fail explicitly instead of silently bypassing the unfinished fence.
    const connection = (host.ctx as {
      get?: (name: string) => unknown
    }).get?.('connection') as { requestRejection(request: { headers: unknown }): 401 | 403 | undefined } | undefined
    const blocked = (request: IncomingMessage, response: ServerResponse): void => {
      const rejection = connection?.requestRejection(request)
      const status = rejection ?? 503
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({
        error: rejection === 401
          ? 'unauthorized: 需要已登录的会话。'
          : rejection === 403
            ? 'forbidden: 会话校验未通过。'
            : `身份迁移未完成，核心操作已禁用：${identityMigrationError}`,
      }))
    }
    for (const path of ['/api/ai-debate/workbench', '/api/ai-debate/action', '/api/ai-debate/approve']) {
      registry.register({ kind: 'exact', path, handler: blocked })
    }
    log.error(`身份迁移未完成，自动化与核心写操作已熔断：${identityMigrationError}`)
  }

  let mounted = true
  let mountError: string | undefined
  try {
    // The adapter is structurally a plugin context; the core's exported type is
    // narrower than the object it actually reads, so the cast is at the boundary
    // and nowhere else.
    apply(host.ctx as never, config.raw, {
      // One authoritative tree for every durable artefact. A config `storeDir`
      // must not be able to fork the core ledger away from the server's backups.
      storeDir: layout.dataDir,
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

  /** Read backups on demand so a just-pruned directory is never offered. */
  const backups = {
    list: (): readonly BackupListEntry[] => backupService.list(),
    verify: (name: string) => backupService.verify(name),
  }

  const loadErrors = (): readonly string[] => [
    ...(monitors.loadError === undefined ? [] : [monitors.loadError]),
    ...(autoTasks.loadError === undefined ? [] : [autoTasks.loadError]),
    ...(monitors.saveError === undefined ? [] : [monitors.saveError]),
    ...(autoTasks.saveError === undefined ? [] : [autoTasks.saveError]),
    ...(identities.loadError === undefined ? [] : [identities.loadError]),
    ...(identities.saveError === undefined ? [] : [identities.saveError]),
    ...(identityMigrationError === undefined ? [] : [identityMigrationError]),
  ]

  const fallbackEngineStatus: EngineStatus = {
    paused: true,
    running: false,
    concurrency: 1,
    perPlatform: 1,
    monitors: { total: 0, enabled: 0, blocked: 0 },
    tasks: {},
    today: { discovered: 0, candidates: 0, failures: 0 },
    queued: 0,
    runningTasks: 0,
    heartbeat: { ticks: 0, intervalMs: 0, healthy: false },
    queue: {
      capacity: 0,
      used: 0,
      byState: {
        pending: 0,
        running: 0,
        completed: 0,
        retry_wait: 0,
        needs_review: 0,
        blocked: 0,
        failed: 0,
        cancelled: 0,
      },
      oldestPendingAgeSec: 0,
      longestRunningSec: 0,
      stuck: 0,
      backlog: { level: 'ok' },
    },
    alerts: [],
  }

  const automationStatus = (): Record<string, unknown> => {
    const raw = engine?.status() ?? fallbackEngineStatus
    const status: EngineStatus = {
      ...raw,
      ...(raw.lastError === undefined ? {} : { lastError: redact(raw.lastError) }),
      ...(raw.degraded === undefined ? {} : { degraded: redact(raw.degraded) }),
      queue: {
        ...raw.queue,
        backlog: {
          ...raw.queue.backlog,
          ...(raw.queue.backlog.reason === undefined ? {} : { reason: redact(raw.queue.backlog.reason) }),
        },
      },
      alerts: raw.alerts.map((alert) => ({ ...alert, reason: redact(alert.reason) })),
    }
    const recovery = status.recovery ?? { at: startedAt, recovered: 0, uncertain: 0 }
    return {
      ...status,
      ...(identityMigrationError === undefined ? {} : { degraded: identityMigrationError, identityMigrationError }),
      backups: summarizeBackups(backupService.list()),
      recovery,
      recovered: recovery.recovered,
      uncertain: recovery.uncertain,
    }
  }

  /** A secret-free support bundle computed on demand. */
  const diagnostics = (): Record<string, unknown> => {
    const queueSnapshot = queue.snapshot()
    return {
      version: options.version,
      startedAt,
      server: {
        running: closing === undefined,
        mounted,
        restorePendingRestart: restoreCompleted,
        ...(mountError === undefined ? {} : { mountError: redact(mountError) }),
        ...(identityMigrationError === undefined ? {} : { automationDisabled: redact(identityMigrationError) }),
      },
      queue: {
        paused: queueSnapshot.paused,
        persistenceSuspended: queueSnapshot.persistenceSuspended,
        concurrency: queueSnapshot.concurrency,
        counts: queueSnapshot.counts,
        jobs: queueSnapshot.jobs.map((job) => ({
          id: job.id,
          type: job.type,
          state: job.state,
          attempts: job.attempts,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          ...(job.lastError === undefined ? {} : { lastError: redact(job.lastError) }),
        })),
      },
      storage: {
        errors: loadErrors().map((message) => redact(message)),
        stateBytes: fileSize(join(layout.dataDir, 'state.json')),
        configBytes: config.sizeBytes(),
        credentialsBytes: credentials.sizeBytes(),
        queueBytes: queue.sizeBytes(),
      },
      automation: automationStatus(),
      monitors: monitors.list().map((monitor) => ({
        id: monitor.id,
        name: monitor.name,
        platform: monitor.platform,
        enabled: monitor.enabled,
        platformState: monitor.platformState,
        lastSuccessAt: monitor.lastSuccessAt,
        ...(monitor.lastError === undefined ? {} : { lastError: redact(monitor.lastError) }),
      })),
      tasks: autoTasks.list(200).map((task) => ({
        id: task.id,
        kind: task.kind,
        monitorId: task.monitorId,
        state: task.state,
        attempts: task.attempts,
        updatedAt: task.updatedAt,
        recoveredAt: task.recoveredAt,
        uncertain: task.modelCall?.uncertain === true,
        ...(task.lastErrorKind === undefined ? {} : { lastErrorKind: task.lastErrorKind }),
      })),
      backups: summarizeBackups(backupService.list()),
    }
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

  /**
   * Runtime facts the console shows but the engine does not own.
   *
   * Computed on request rather than sampled on a timer: a background sampler would
   * itself be a thing that can leak, and these are four cheap syscalls.
   */
  const health = (): Record<string, unknown> => {
    const memory = process.memoryUsage()
    let dataDirBytes: number | undefined
    try {
      dataDirBytes = dirSize(layout.dataDir)
    } catch {
      dataDirBytes = undefined
    }
    return {
      startedAt,
      uptimeSec: Math.round(process.uptime()),
      nodeVersion: process.version,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      rssBytes: memory.rss,
      externalBytes: memory.external,
      dataDir: layout.dataDir,
      ...(dataDirBytes === undefined ? {} : { dataDirBytes }),
      ...(freeBytes(layout.dataDir) === undefined ? {} : { freeBytes: freeBytes(layout.dataDir) as number }),
      monitorsBytes: fileSize(layout.monitorsFile),
      tasksBytes: fileSize(layout.autoTasksFile),
      stateBytes: fileSize(join(layout.dataDir, 'state.json')),
    }
  }

  function shutdown(reason: string): void {
    log.info(`收到停止请求：${reason}`)
    audit.write('service.shutdown', { reason })
    setTimeout(() => {
      void close().finally(() => (options.exitProcess ?? process.exit)(0))
    }, Math.max(0, options.restartDelayMs ?? 250))
  }
  function restart(reason: string): void {
    log.info(`收到重启请求：${reason}`)
    audit.write('service.restart', { reason })
    setTimeout(() => {
      void close().finally(() => (options.exitProcess ?? process.exit)(75))
    }, Math.max(0, options.restartDelayMs ?? 250))
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
    secureCookies: options.secureCookies ?? process.env.AI_DEBATE_SECURE_COOKIES === '1',
    host: options.host,
    trustedHosts: options.trustedHosts ?? trustedHostsFor(options.host),
    port: () => actualPort,
    info,
    diagnostics,
    controlToken: readControlToken(layout) ?? writeControlToken(layout),
    legacy,
    backups,
    audit,
    automation: {
      status: automationStatus,
      health,
      identities: () => identities.stats(),
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
      updateMonitor: (
        id: string,
        patch: { name?: string; intervalSec?: number; enabled?: boolean; accountLabel?: string; compensationHours?: number },
      ) => {
        if (patch.enabled === true) monitors.clearBlock(id)
        return monitors.update(id, patch)
      },
      removeMonitor: (id: string) => monitors.remove(id),
      platformCheck: async (id: string): Promise<Record<string, unknown>> => {
        const monitor = monitors.get(id)
        if (monitor === undefined) return { ok: false, notFound: true, error: '监控目标不存在。' }
        if (productApi === undefined) return { ok: false, error: '辩论引擎未挂载，无法执行只读平台探测。' }
        try {
          const result = await productApi.probe({ url: monitor.url, mode: 'tail' })
          return {
            ok: true,
            platform: result.platform,
            threadId: result.threadId,
            title: result.title,
            complete: result.complete,
            pagesRead: result.pagesRead,
            repliesSeen: result.replies.length,
            scan: result.scan,
          }
        } catch (error) {
          const failure = classifyFailure(error)
          return {
            ok: false,
            platformState: failure.platformState ?? 'adapter_error',
            error: redact(failure.message),
          }
        }
      },
      checkNow: (id: string) => engine?.checkNow(id) ?? { ok: false, message: '后台引擎未启动。' },
      scanNow: (id: string, mode: 'compensate' | 'full') =>
        engine?.scanNow(id, mode) ?? { ok: false, message: '后台引擎未启动。' },
      pauseAll: () => engine?.pause(),
      resumeAll: () => engine?.resume(),
      cancelTask: (id: string) => autoTasks.cancel(id),
      retryTask: (id: string) => autoTasks.retry(id),
      /** Housekeeping the console can trigger: history trim and stuck reaping. */
      maintenance: (action: 'prune' | 'reap') => {
        if (action === 'prune') {
          const outcome = autoTasks.prune()
          audit.write('queue.pruned', { removed: outcome.removed, keptForReview: outcome.keptForReview, by: 'operator' })
          return { ok: true, ...outcome }
        }
        const reaped = autoTasks.reapStuck()
        if (reaped.length > 0) audit.write('queue.reaped', { count: reaped.length })
        return { ok: true, reaped: reaped.length }
      },
      loadErrors,
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

  if (mounted && identityMigrationError === undefined) {
    engine = new AutomationEngine({
      monitors,
      tasks: autoTasks,
      identities,
      api: () => productApi,
      log,
      ...(options.monitorConcurrency === undefined ? {} : { concurrency: options.monitorConcurrency }),
      ...(options.monitorTickMs === undefined ? {} : { tickMs: options.monitorTickMs }),
      ...(process.env.AI_DEBATE_TASK_TIMEOUT_MS === undefined
        ? {}
        : { taskTimeoutMs: Number(process.env.AI_DEBATE_TASK_TIMEOUT_MS) }),
      ...(process.env.AI_DEBATE_COMPENSATION_MS === undefined
        ? {}
        : { compensationEveryMs: Number(process.env.AI_DEBATE_COMPENSATION_MS) }),
    })
    engine.start()
  } else if (!mounted) {
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
    ...(identityMigrationError === undefined ? {} : { automationDisabled: identityMigrationError }),
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
  // `--no-browser`: an autostart entry that opens a tab at every login is the kind
  // of "feature" people disable and then distrust. The service starts, hidden.
  const result = spawnSync('reg', ['add', key, '/v', 'AIDebate', '/t', 'REG_SZ', '/d', `"${exe}" --no-browser`, '/f'], {
    stdio: 'ignore',
  })
  return result.status === 0
    ? { ok: true, message: '已开启开机自启（仅当前用户）。' }
    : { ok: false, message: '写入注册表失败，可能被安全软件拦截。' }
}

interface JobDeps {
  readonly queue: JobQueue
  readonly layout: Layout
  readonly credentials: CredentialStore
  readonly log: Logger
  readonly backups: BackupService
  readonly stopEngine: () => Promise<boolean>
  readonly restartEngine: () => boolean
  readonly restartAfterRestore: () => void
}

function registerJobHandlers(deps: JobDeps): void {
  const { queue, layout, credentials, log, backups, stopEngine, restartEngine, restartAfterRestore } = deps

  queue.register('backup.create', async ({ payload, note, signal }) => {
    const requested = payload.kind
    const kind: BackupKind = payload.auto === true
      ? 'daily'
      : requested === 'manual' || requested === 'daily' || requested === 'weekly'
        ? requested
        : 'manual'
    const name = backups.create(kind, { signal })
    note('info', `备份完成：${name}（${kind}）`)
    if (kind !== 'manual') backups.prune()
  })

  queue.register('backup.restore', async ({ jobId, payload, note, signal }) => {
    const name = typeof payload.name === 'string' ? payload.name : ''
    let persistenceSuspended = false
    let engineStopped = false
    let queuePaused = false
    try {
      engineStopped = await stopEngine()
      queue.pauseQueue({ persist: false })
      queuePaused = true
      queue.suspendPersistence()
      persistenceSuspended = true
      const result = backups.restore(name, { confirmed: payload.confirmed === true, signal })
      if (result.skipped.includes('credentials.json')) {
        note('warn', '凭据密文未恢复，请重新填写。')
      }
      note('info', `已从 ${result.name} 恢复；恢复前数据保存在 ${result.preRestore}。服务将重启。`)
      if (!queue.recordSucceededReceipt(jobId, '备份恢复成功，服务将重启')) {
        log.error('备份恢复成功，但任务凭证写入失败；仍将重启以保证恢复结果生效。')
      }
      restartAfterRestore()
    } catch (error) {
      if (persistenceSuspended) queue.resumePersistence()
      if (queuePaused) queue.resumeQueue({ persist: false })
      const engineRunning = engineStopped ? restartEngine() : true
      const engineState = engineStopped
        ? engineRunning ? '后台引擎已重新启动' : '后台引擎重启失败'
        : '后台引擎仍在运行'
      const detail = `恢复失败：${error instanceof Error ? error.message : String(error)}。${engineState}，队列已恢复运行；请检查后重试。`
      note('error', detail)
      queue.recordFailedReceipt(jobId, detail)
      log.error(`备份恢复失败，${engineState}：${detail}`)
      throw new Error(detail, { cause: error })
    }
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
