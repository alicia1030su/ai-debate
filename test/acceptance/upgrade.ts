/**
 * In-place upgrade acceptance: a released v0.2.1 data directory -> current build.
 *
 * The primary path runs the real v0.2.1 Release executable when
 * `AI_DEBATE_V021_BIN` is set (or the documented local attachment exists), lets
 * that binary create the administrator, settings, monitor and encrypted
 * credentials through HTTP, then opens the same directory with the current
 * build. A separate v0.2.0 scenario remains as a compatibility regression.
 *
 * Some records cannot be produced honestly without a live platform/model:
 * core sessions/candidates/approvals, deterministic monitor cursors and queue
 * rows are seeded offline after the old process stops. The report names every
 * such seed. Fixture runs are labelled as fixture runs; they are never reported
 * as evidence that the real Release attachment was exercised.
 *
 * Usage:
 *   node --experimental-transform-types test/acceptance/upgrade.ts
 *   AI_DEBATE_V021_BIN=.tmp-data/v021-real/AI-Debate-windows-x64.exe \
 *     node --experimental-transform-types test/acceptance/upgrade.ts
 *   AI_DEBATE_V020_BIN=/path/to/v0.2.0.exe \
 *     node --experimental-transform-types test/acceptance/upgrade.ts
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { AuthService } from '../../packages/server/src/auth.ts'
import { BACKUP_FILE_NAMES, BackupService } from '../../packages/server/src/backup.ts'
import { CredentialStore } from '../../packages/server/src/credential-store.ts'
import { layoutOf } from '../../packages/server/src/paths.ts'

const CURRENT_PORT = 17921
const LEGACY_PORT = 17920
const DEFAULT_V021_BIN = join(process.cwd(), '.tmp-data', 'v021-real', 'AI-Debate-windows-x64.exe')
const USERNAME = 'upgrade-owner'
const PASSWORD = 'upgrade-pass-2026'
const MONITOR_NAME = '旧版监控目标'
const THREAD_ID = '123456'
const SESSION_ID = 'upgrade-session-1'
const CANDIDATE_222 = 'upgrade-candidate-222'
const CANDIDATE_333 = 'upgrade-candidate-333'
const SECRET_VALUES = {
  AI_DEBATE_LLM_API_KEY: 'v021-upgrade-LLM-secret-DO-NOT-USE-0123456789',
  AI_DEBATE_TIEBA_COOKIE: 'v021-upgrade-TIEBA-cookie-DO-NOT-USE-9876543210',
} as const

type LegacyVersion = '0.2.0' | '0.2.1'
type JsonObject = Record<string, any>

interface CheckResult {
  readonly name: string
  readonly ok: boolean
  readonly detail?: string
}

interface FileDigest {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

interface LegacySource {
  readonly version: LegacyVersion
  readonly mode: 'real' | 'fixture'
  readonly binaryPath?: string
  readonly binarySha256?: string
  readonly versionOutput?: string
  readonly requested: boolean
  readonly error?: string
  readonly httpWrites?: Record<string, number>
  readonly offlineSeeds: readonly string[]
}

interface ScenarioSummary {
  readonly version: LegacyVersion
  readonly source: LegacySource
  readonly dataDir: string
  readonly stateSha256: string
  readonly beforeFiles: readonly FileDigest[]
  readonly identityMigration: 'migrated' | 'failed' | 'not-applicable'
  readonly modelCalls: number
}

interface RunningService {
  readonly child: ChildProcess
  log(): string
}

const results: CheckResult[] = []
const scenarioSummaries: ScenarioSummary[] = []

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

function note(message: string): void {
  process.stdout.write(`  · ${message}\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function sha256(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

function readJson(file: string): JsonObject {
  return JSON.parse(readFileSync(file, 'utf8')) as JsonObject
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function snapshotFiles(root: string): FileDigest[] {
  const files: FileDigest[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full)
      } else if (entry.isFile()) {
        const contents = readFileSync(full)
        files.push({ path: relative(root, full), bytes: contents.length, sha256: sha256(contents) })
      }
    }
  }
  visit(root)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function printInventory(source: LegacySource, files: readonly FileDigest[]): void {
  process.stdout.write(`\n[${source.version}] 来源：${source.mode === 'real' ? '真实 Release 二进制' : 'fixture（真实附件未验证）'}\n`)
  if (source.binaryPath !== undefined) process.stdout.write(`  二进制：${source.binaryPath}\n`)
  if (source.binarySha256 !== undefined) process.stdout.write(`  二进制 SHA256：${source.binarySha256}\n`)
  if (source.versionOutput !== undefined) process.stdout.write(`  版本输出：${source.versionOutput.replace(/\r?\n/g, ' | ')}\n`)
  if (source.error !== undefined) process.stdout.write(`  来源降级原因：${source.error}\n`)
  process.stdout.write(`  离线植入：${source.offlineSeeds.join('；')}\n`)
  process.stdout.write('  升级前文件清单（SHA256）：\n')
  for (const file of files) {
    process.stdout.write(`    ${file.sha256}  ${String(file.bytes).padStart(8)}  ${file.path}\n`)
  }
}

/** A tiny cookie-carrying client; one instance belongs to one server process. */
class HttpClient {
  #cookie = ''

  constructor(private readonly base: string) {}

  async call(path: string, options: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
    const response = await fetch(`${this.base}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        origin: this.base,
        ...(this.#cookie === '' ? {} : { cookie: this.#cookie }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    const text = await response.text()
    let body: any = undefined
    try {
      body = text === '' ? undefined : JSON.parse(text)
    } catch {
      body = text
    }
    const setCookie = response.headers.get('set-cookie')
    const match = setCookie === null ? null : /ai_debate_session=([^;]+)/.exec(setCookie)
    if (match !== null) this.#cookie = `ai_debate_session=${match[1] as string}`
    return { status: response.status, body }
  }
}

function currentVersion(): string {
  if (typeof process.env.AI_DEBATE_CURRENT_VERSION === 'string' && process.env.AI_DEBATE_CURRENT_VERSION !== '') {
    return process.env.AI_DEBATE_CURRENT_VERSION as string
  }
  try {
    const manifest = readJson(join(process.cwd(), 'package.json'))
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function startCurrent(dataDir: string): RunningService {
  const binary = process.env.AI_DEBATE_BIN
  const command = binary ?? process.execPath
  const args = [
    ...(binary === undefined ? [join(process.cwd(), 'dist', 'ai-debate.cjs')] : []),
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(CURRENT_PORT),
    '--data-dir',
    dataDir,
    '--log-level',
    'warn',
  ]
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, AI_DEBATE_HOME: dataDir },
  })
  let log = ''
  child.stdout?.on('data', (chunk: Buffer) => { log += chunk.toString('utf8') })
  child.stderr?.on('data', (chunk: Buffer) => { log += chunk.toString('utf8') })
  return { child, log: () => log }
}

async function waitHealthy(service: RunningService, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (service.child.exitCode !== null) return false
    try {
      const response = await fetch(`http://127.0.0.1:${CURRENT_PORT}/healthz`)
      if (response.ok) return true
    } catch {
      // Not listening yet.
    }
    await sleep(250)
  }
  return false
}

async function stop(service: RunningService | undefined): Promise<void> {
  if (service === undefined || service.child.exitCode !== null) return
  service.child.kill('SIGTERM')
  for (let index = 0; index < 60; index += 1) {
    if (service.child.exitCode !== null) return
    await sleep(100)
  }
  service.child.kill('SIGKILL')
  for (let index = 0; index < 20; index += 1) {
    if (service.child.exitCode !== null) return
    await sleep(100)
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(100)
  }
  return predicate()
}

/** Inspect, but do not trust, an operator-supplied old executable. */
function resolveLegacySource(version: LegacyVersion): LegacySource {
  const explicit = version === '0.2.1' ? process.env.AI_DEBATE_V021_BIN : process.env.AI_DEBATE_V020_BIN
  const candidate = explicit ?? (version === '0.2.1' ? DEFAULT_V021_BIN : undefined)
  const offlineSeeds = [
    'state.json 会话/候选/批准/去重台账',
    'auto-tasks.json 待审核与终态行',
    'monitors.json 确定性 cursor/lastScan/compensation/platformState',
    ...(version === '0.2.1' ? ['backups/ 两个 v0.2.1 auto manifest'] : []),
  ]
  if (candidate === undefined || !existsSync(candidate)) {
    return {
      version,
      mode: 'fixture',
      requested: explicit !== undefined,
      offlineSeeds,
      ...(candidate === undefined ? {} : { error: `本地附件尚不可运行：${candidate}` }),
    }
  }
  const binaryPath = resolve(candidate)
  try {
    const binarySha256 = sha256(readFileSync(binaryPath))
    const env = { ...process.env }
    delete env.AI_DEBATE_VERSION
    const output = spawnSync(binaryPath, ['--version'], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    const versionOutput = `${output.stdout ?? ''}${output.stderr ?? ''}`.trim()
    const error = output.error !== undefined
      ? output.error.message
      : output.status !== 0
        ? `--version 退出码 ${String(output.status)}`
        : !new RegExp(`\\b${version.replace('.', '\\.')}\\b`).test(versionOutput)
          ? `版本输出不包含 ${version}`
          : undefined
    return {
      version,
      mode: error === undefined ? 'real' : 'fixture',
      binaryPath,
      binarySha256,
      versionOutput,
      requested: explicit !== undefined,
      offlineSeeds,
      ...(error === undefined ? {} : { error }),
    }
  } catch (error) {
    return {
      version,
      mode: 'fixture',
      binaryPath,
      requested: explicit !== undefined,
      offlineSeeds,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function stateFixture(now: string): JsonObject {
  const text222 = '旧版候选 222：个例不能代表整体。'
  const text333 = '旧版候选 333：请给出可核对的样本。'
  return {
    version: 1,
    sessions: [{
      id: SESSION_ID,
      platform: 'tieba',
      threadId: THREAD_ID,
      threadUrl: `https://tieba.baidu.com/p/${THREAD_ID}`,
      threadTitle: '升级验收旧会话',
      forumName: '升级验收吧',
      ownerKey: USERNAME,
      ownerName: '楼主',
      opponentKey: 'rival',
      opponentName: '对方',
      disputeFloorPostId: '111',
      disputeFloorNumber: 1,
      triggerPostId: '222',
      state: 'REVIEWING',
      statusText: '等待人工审核',
      persona: { style: '克制', intensity: 0.6, maxLength: 300 },
      candidates: [
        {
          replyId: CANDIDATE_222,
          text: text222,
          strategy: 'point_out_contradiction',
          targetPostId: '222',
          candidateVersion: 1,
          textHash: sha256(text222),
          confidence: 0.7,
          violations: [],
          notes: ['v0.2.1 离线验收候选'],
          approved: false,
          createdAt: now,
        },
        {
          replyId: CANDIDATE_333,
          text: text333,
          strategy: 'ask_for_evidence',
          targetPostId: '333',
          candidateVersion: 1,
          textHash: sha256(text333),
          confidence: 0.7,
          violations: [],
          notes: ['v0.2.1 离线验收候选'],
          approved: true,
          createdAt: now,
        },
      ],
      comments: [
        { postId: '222', kind: 'floor', authorName: '对方', identity: 'verified', text: '你身边的例子不能代表所有人。' },
        { postId: '333', kind: 'floor', authorName: '对方', identity: 'verified', text: '请给出可核对的样本。' },
      ],
      readQuality: { floorsRead: 3, nestedRead: 0, truncated: false, reasons: [], observationOverflow: [] },
      publishedPostIds: [],
      sentTexts: [],
      createdAt: now,
      updatedAt: now,
    }],
    dedupe: [{
      key: `tieba:${THREAD_ID}:${USERNAME}:111`,
      platform: 'tieba',
      threadId: THREAD_ID,
      ownerKey: USERNAME,
      triggerPostId: '111',
      sessionId: SESSION_ID,
      firstSeenAt: now,
      publishState: 'confirmed',
      publishedPostId: 'legacy-published-111',
      decidedAt: now,
    }],
    usage: [],
    security: [],
    approvals: [{
      id: 'upgrade-approval-333',
      sessionId: SESSION_ID,
      candidateId: CANDIDATE_333,
      platform: 'tieba',
      targetPostId: '333',
      publishingAccount: USERNAME,
      textHash: sha256(text333),
      candidateVersion: 1,
      assessmentFingerprint: sha256('v021-upgrade-assessment'),
      grantedBy: USERNAME,
      grantedAt: now,
    }],
    verification: [],
  }
}

function monitorFixture(version: LegacyVersion, now: string): JsonObject {
  const monitor: JsonObject = {
    id: version === '0.2.1' ? 'v021-monitor-1' : 'legacy-monitor-1',
    name: MONITOR_NAME,
    platform: 'tieba',
    url: `https://tieba.baidu.com/p/${THREAD_ID}`,
    threadId: THREAD_ID,
    enabled: false,
    intervalSec: 300,
    createdAt: now,
    updatedAt: now,
    lastCheckAt: now,
    lastSuccessAt: now,
    seen: ['111', '222', '333'],
    baselineAt: now,
    counters: {
      discovered: 3,
      analyzed: 1,
      candidates: 2,
      failures: 0,
      day: now.slice(0, 10),
      todayDiscovered: 3,
      todayCandidates: 2,
      todayFailures: 0,
    },
  }
  if (version === '0.2.1') {
    monitor.platformState = 'rate_limited'
    monitor.blockedReason = '升级验收 fixture：保留旧平台状态'
    monitor.compensationHours = 36
    monitor.lastCompensationAt = now
    monitor.cursor = {
      fingerprints: { '111': 'fp-111', '222': 'fp-222', '333': 'fp-333' },
      lastSeenPostId: '333',
      lastSeenAt: now,
      lastCompleteScanAt: now,
      lastScanAt: now,
      lastCoverage: 'tail',
    }
    monitor.lastScan = {
      at: now,
      complete: true,
      coverage: 'tail',
      pagesRead: 2,
      totalPages: 2,
      repliesSeen: 3,
    }
    monitor.changes = [{ at: now, postId: '222', kind: 'edited', note: '升级验收旧差异记录' }]
  }
  return { version: version === '0.2.1' ? 2 : 1, monitors: [monitor] }
}

function seedAdmin(dataDir: string): void {
  const layout = layoutOf(dataDir)
  const auth = new AuthService({
    adminFile: layout.adminFile,
    sessionsFile: layout.sessionsFile,
    log: { info: () => undefined, warn: () => undefined },
    loopbackOnlySetup: true,
  })
  auth.load()
  auth.createAdmin(USERNAME, PASSWORD)
}

async function seedFixtureCredentials(dataDir: string): Promise<void> {
  const layout = layoutOf(dataDir)
  const credentials = new CredentialStore({
    file: layout.credentialsFile,
    keyFile: layout.credentialsKey,
    log: { warn: () => undefined },
  })
  credentials.load()
  for (const [ref, value] of Object.entries(SECRET_VALUES)) await credentials.set(ref, value)
}

function seedFixture(dataDir: string, version: LegacyVersion, modelPort: number): void {
  mkdirSync(dataDir, { recursive: true })
  const now = new Date().toISOString()
  writeJson(join(dataDir, 'config.json'), {
    llmBaseUrl: `http://127.0.0.1:${modelPort}/v1`,
    llmModel: version === '0.2.1' ? 'v021-upgrade-model' : 'legacy-model',
    llmSource: 'custom',
    llmProtocol: 'chat',
    maxFloorPages: 42,
  })
  writeJson(join(dataDir, 'monitors.json'), monitorFixture(version, now))
  writeJson(join(dataDir, 'jobs.json'), { version: 1, paused: false, jobs: [] })
  seedAdmin(dataDir)
}

/** Let the released binary write the records it can write without a live account. */
async function seedWithRealBinary(dataDir: string, source: LegacySource, modelPort: number): Promise<LegacySource> {
  const binary = source.binaryPath
  if (binary === undefined) throw new Error(source.error ?? '旧版二进制路径为空')
  const base = `http://127.0.0.1:${LEGACY_PORT}`
  const env: NodeJS.ProcessEnv = { ...process.env, AI_DEBATE_HOME: dataDir }
  delete env.AI_DEBATE_VERSION
  const child = spawn(binary, [
    'serve', '--host', '127.0.0.1', '--port', String(LEGACY_PORT), '--data-dir', dataDir, '--log-level', 'warn',
  ], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  })
  let log = ''
  child.stdout?.on('data', (chunk: Buffer) => { log += chunk.toString('utf8') })
  child.stderr?.on('data', (chunk: Buffer) => { log += chunk.toString('utf8') })
  const service: RunningService = { child, log: () => log }
  try {
    const healthy = await waitUntil(async (): Promise<boolean> => {
      try {
        return (await fetch(`${base}/healthz`)).ok
      } catch {
        return false
      }
    }, 30_000)
    if (!healthy) throw new Error(`旧版二进制未能启动：${log.slice(-600)}`)
    const client = new HttpClient(base)
    const writes: Record<string, number> = {}
    const post = async (name: string, path: string, body: unknown): Promise<void> => {
      const response = await client.call(path, { method: 'POST', body })
      writes[name] = response.status
    }
    await post('setup', '/api/ai-debate/auth/setup', { username: USERNAME, password: PASSWORD })
    await post('settings', '/api/ai-debate/settings', {
      set: {
        llmBaseUrl: `http://127.0.0.1:${modelPort}/v1`,
        llmModel: source.version === '0.2.1' ? 'v021-upgrade-model' : 'legacy-model',
        llmSource: 'custom',
        llmProtocol: 'chat',
        maxFloorPages: 42,
      },
    })
    if (source.version === '0.2.1') {
      for (const [ref, value] of Object.entries(SECRET_VALUES)) {
        await post(`secret:${ref}`, '/api/ai-debate/secrets', { ref, value })
      }
    }
    await post('monitor', '/api/ai-debate/automation/monitors', {
      url: `https://tieba.baidu.com/p/${THREAD_ID}`,
      name: MONITOR_NAME,
      intervalSec: 300,
    })
    const failed = Object.entries(writes).filter(([, status]) => status !== 200)
    if (failed.length > 0) throw new Error(`旧版 HTTP 写入失败：${failed.map(([name, status]) => `${name}=${status}`).join(', ')}`)
    return { ...source, httpWrites: writes }
  } finally {
    await stop(service)
  }
}

/** Add deterministic records that require either a live platform or an offline fixture. */
function seedOfflineRecords(dataDir: string, version: LegacyVersion): void {
  const now = new Date().toISOString()
  const monitorFile = join(dataDir, 'monitors.json')
  const monitorDocument = readJson(monitorFile)
  const monitors = Array.isArray(monitorDocument.monitors) ? monitorDocument.monitors as JsonObject[] : []
  const monitor = monitors[0]
  if (monitor === undefined) throw new Error('旧版没有写出任何监控目标')
  const fixture = (monitorFixture(version, now).monitors as JsonObject[])[0] as JsonObject
  for (const [key, value] of Object.entries(fixture)) {
    if (key === 'id' || key === 'name' || key === 'url' || key === 'threadId' || key === 'platform' || key === 'intervalSec') continue
    monitor[key] = value
  }
  monitor.enabled = false
  monitor.updatedAt = now
  monitorDocument.version = version === '0.2.1' ? 2 : 1
  writeJson(monitorFile, monitorDocument)

  const reviewTask: JsonObject = {
    id: 'upgrade-task-review',
    kind: 'generate',
    monitorId: monitor.id,
    postId: '333',
    sessionId: SESSION_ID,
    dedupeKey: version === '0.2.1' ? `generate:${String(monitor.id)}:333` : `generate:${SESSION_ID}:333`,
    state: 'needs_review',
    attempts: 1,
    maxAttempts: 2,
    createdAt: now,
    updatedAt: now,
    nextRunAt: now,
    startedAt: now,
    finishedAt: now,
    logs: [{ at: now, level: 'info', message: '旧版候选已生成，等待审核' }],
  }
  const doneTask: JsonObject = {
    id: 'upgrade-task-done',
    kind: 'probe',
    monitorId: monitor.id,
    dedupeKey: `probe:${String(monitor.id)}`,
    state: 'completed',
    attempts: 1,
    maxAttempts: 4,
    createdAt: now,
    updatedAt: now,
    nextRunAt: now,
    finishedAt: now,
    logs: [],
  }
  const tasks: JsonObject[] = [reviewTask, doneTask]
  if (version === '0.2.1') {
    reviewTask.modelCall = { startedAt: now, finishedAt: now, candidateId: CANDIDATE_333 }
    tasks.unshift({
      id: 'upgrade-task-recover',
      kind: 'generate',
      monitorId: monitor.id,
      postId: '222',
      sessionId: SESSION_ID,
      dedupeKey: `generate:${String(monitor.id)}:222`,
      state: 'running',
      attempts: 1,
      maxAttempts: 2,
      createdAt: now,
      updatedAt: now,
      nextRunAt: now,
      startedAt: now,
      leaseToken: 'v021-expired-lease-token',
      leaseExpiresAt: now,
      heartbeatAt: now,
      modelCall: { startedAt: now, finishedAt: now, candidateId: CANDIDATE_222 },
      logs: [{ at: now, level: 'info', message: '旧版进程在生成完成后退出' }],
    })
  }
  writeJson(join(dataDir, 'auto-tasks.json'), {
    version: version === '0.2.1' ? 2 : 1,
    paused: true,
    tasks,
  })
  writeJson(join(dataDir, 'state.json'), stateFixture(now))
  if (!existsSync(join(dataDir, 'jobs.json'))) {
    writeJson(join(dataDir, 'jobs.json'), { version: 1, paused: false, jobs: [] })
  }
}

/** Build the exact old backup manifest shape: config/state/jobs plus auto:boolean. */
function seedLegacyBackups(dataDir: string): void {
  const root = join(dataDir, 'backups')
  mkdirSync(root, { recursive: true })
  for (const [name, auto, createdAt] of [
    ['v021-legacy-auto', true, '2026-01-01T00:00:00.000Z'],
    ['v021-legacy-manual', false, '2026-01-02T00:00:00.000Z'],
  ] as const) {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    const files: Record<string, { sha256: string; bytes: number }> = {}
    for (const fileName of ['config.json', 'state.json', 'jobs.json']) {
      const contents = readFileSync(join(dataDir, fileName))
      writeFileSync(join(dir, fileName), contents)
      files[fileName] = { sha256: sha256(contents), bytes: contents.length }
    }
    writeJson(join(dir, 'manifest.json'), {
      version: '0.2.1',
      createdAt,
      auto,
      files,
      note: 'v0.2.1 旧版清单 fixture；不含凭据、口令与会话',
    })
  }
}

async function prepareScenario(source: LegacySource, modelPort: number): Promise<{ dataDir: string; source: LegacySource }> {
  const dataDir = mkdtempSync(join(tmpdir(), `ai-debate-upgrade-${source.version.replace('.', '')}-`))
  let prepared = source
  if (source.mode === 'real') {
    try {
      prepared = await seedWithRealBinary(dataDir, source, modelPort)
    } catch (error) {
      rmSync(dataDir, { recursive: true, force: true })
      mkdirSync(dataDir, { recursive: true })
      seedFixture(dataDir, source.version, modelPort)
      prepared = { ...source, mode: 'fixture', error: error instanceof Error ? error.message : String(error) }
    }
  } else {
    seedFixture(dataDir, source.version, modelPort)
  }
  if (source.version === '0.2.1' && prepared.mode === 'fixture') await seedFixtureCredentials(dataDir)
  seedOfflineRecords(dataDir, source.version)
  if (source.version === '0.2.1') seedLegacyBackups(dataDir)
  return { dataDir, source: prepared }
}

async function verifyDecryptedCredentials(dataDir: string, prefix: string): Promise<void> {
  const layout = layoutOf(dataDir)
  const store = new CredentialStore({
    file: layout.credentialsFile,
    keyFile: layout.credentialsKey,
    log: { warn: () => undefined },
  })
  const loaded = store.load()
  check(`${prefix} 凭据库与密钥可加载`, loaded.loaded && !loaded.corrupt)
  for (const [ref, expected] of Object.entries(SECRET_VALUES)) {
    const resolved = await store.resolve(ref)
    check(`${prefix} 凭据密文可解密：${ref}`, resolved?.value === expected, resolved?.source ?? 'missing')
  }
  const ciphertext = readFileSync(layout.credentialsFile, 'utf8')
  check(`${prefix} credentials.json 不含明文测试值`, Object.values(SECRET_VALUES).every((value) => !ciphertext.includes(value)))
}

function inspectIdentities(dataDir: string, prefix: string): 'migrated' | 'failed' {
  const file = join(dataDir, 'reply-identities.json')
  if (!existsSync(file)) {
    check(`${prefix} 启动自动生成 reply-identities.json`, false, '迁移模块未接线或启动迁移失败')
    return 'failed'
  }
  const document = readJson(file)
  check(`${prefix} 身份迁移完成标记已落盘`, document.migration?.state === 'complete' && typeof document.migration?.completedAt === 'string')
  const entries = Array.isArray(document.entries) ? document.entries as JsonObject[] : []
  const byPost = new Map(entries.map((entry) => [String(entry.postId), entry]))
  const candidate222 = byPost.get('222')
  const candidate333 = byPost.get('333')
  const candidatesMigrated = candidate222?.state === 'candidate' && candidate333?.state === 'candidate'
  check(
    `${prefix} 旧候选回复已迁移为全局 candidate 身份`,
    candidatesMigrated,
    `222=${String(candidate222?.state)} 333=${String(candidate333?.state)}`,
  )
  const seenIgnored = byPost.get('111')?.state === 'ignored'
  check(`${prefix} 仅 seen 的旧回复迁移为 ignored`, seenIgnored)
  const noReplayableClaims = entries.every((entry) => entry.state !== 'claimed')
  check(`${prefix} 旧 seen 回复没有遗留为可重放的 claimed`, noReplayableClaims)
  const migratedTasks = (readJson(join(dataDir, 'auto-tasks.json')).tasks ?? []) as JsonObject[]
  const tasksBackfilled = migratedTasks.find((task) => task.id === 'upgrade-task-review')?.identityKey === `stable:tieba:${THREAD_ID}:333`
    && migratedTasks.find((task) => task.id === 'upgrade-task-recover')?.identityKey === `stable:tieba:${THREAD_ID}:222`
  check(`${prefix} 旧任务已回填全局身份键`, tasksBackfilled)
  const migrationComplete = document.migration?.state === 'complete' && typeof document.migration?.completedAt === 'string'
  return candidatesMigrated && seenIgnored && noReplayableClaims && tasksBackfilled && migrationComplete ? 'migrated' : 'failed'
}

async function runScenario(source: LegacySource, model: { port: number; calls(): number }): Promise<void> {
  const prefix = `[${source.version}]`
  const { dataDir, source: prepared } = await prepareScenario(source, model.port)
  const beforeFiles = snapshotFiles(dataDir)
  printInventory(prepared, beforeFiles)
  if (source.mode === 'real') {
    check(
      `${prefix} 真实旧版 HTTP 数据目录生成成功`,
      prepared.mode === 'real',
      prepared.mode === 'real' ? JSON.stringify(prepared.httpWrites) : prepared.error,
    )
  }
  const stateFile = join(dataDir, 'state.json')
  const stateHashBefore = sha256(readFileSync(stateFile))
  const credentialsHashBefore = source.version === '0.2.1' && existsSync(join(dataDir, 'credentials.json'))
    ? sha256(readFileSync(join(dataDir, 'credentials.json')))
    : undefined
  let service: RunningService | undefined
  let identityMigration: ScenarioSummary['identityMigration'] = source.version === '0.2.1' ? 'failed' : 'not-applicable'
  const modelCallsBefore = model.calls()
  try {
    service = startCurrent(dataDir)
    const healthy = await waitHealthy(service)
    check(`${prefix} 当前构建能在旧目录启动`, healthy, healthy ? undefined : service.log().slice(-800))
    if (!healthy) return
    const health = await fetch(`http://127.0.0.1:${CURRENT_PORT}/healthz`).then((response) => response.json()) as JsonObject
    check(`${prefix} 当前构建版本可识别`, health.version === currentVersion(), `health=${String(health.version)} expected=${currentVersion()}`)
    const client = new HttpClient(`http://127.0.0.1:${CURRENT_PORT}`)
    const repeatedSetup = await client.call('/api/ai-debate/auth/setup', {
      method: 'POST', body: { username: 'someone-else', password: 'another-pass-2026' },
    })
    check(`${prefix} 旧管理员未被重建/覆盖`, repeatedSetup.status === 409, `status=${repeatedSetup.status}`)
    const login = await client.call('/api/ai-debate/auth/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } })
    check(`${prefix} 旧管理员可直接登录`, login.status === 200, `status=${login.status}`)
    if (login.status !== 200) return

    const expectedModel = source.version === '0.2.1' ? 'v021-upgrade-model' : 'legacy-model'
    const settings = await client.call('/api/ai-debate/settings')
    const values = settings.body?.values ?? {}
    check(`${prefix} 非默认模型配置保留`, values.llmModel === expectedModel, `llmModel=${String(values.llmModel)}`)
    check(`${prefix} 非默认数值配置保留`, values.maxFloorPages === 42, `maxFloorPages=${String(values.maxFloorPages)}`)
    check(`${prefix} 自定义模型地址保留`, typeof values.llmBaseUrl === 'string' && values.llmBaseUrl.includes('127.0.0.1'))

    const monitorsResponse = await client.call('/api/ai-debate/automation/monitors')
    const monitors = (monitorsResponse.body?.monitors ?? []) as JsonObject[]
    const legacy = monitors.find((monitor) => monitor.name === MONITOR_NAME)
    const diskMonitor = legacy?.id === undefined
      ? undefined
      : (readJson(join(dataDir, 'monitors.json')).monitors as JsonObject[]).find((monitor) => monitor.id === legacy.id)
    check(`${prefix} 旧监控目标保留`, legacy !== undefined, `count=${monitors.length}`)
    check(`${prefix} 监控 ID/间隔/启用状态保留`, legacy?.id !== undefined && legacy.intervalSec === 300 && legacy.enabled === false)
    check(`${prefix} 监控计数保留`, legacy?.counters?.discovered === 3 && legacy?.counters?.candidates === 2, JSON.stringify(legacy?.counters))
    check(`${prefix} 旧 seen 列表保留`, Array.isArray(diskMonitor?.seen) && diskMonitor.seen.join(',') === '111,222,333')
    if (source.version === '0.2.1') {
      check(`${prefix} v0.2.1 cursor 完整保留`, diskMonitor?.cursor?.lastCompleteScanAt !== undefined && diskMonitor?.cursor?.lastSeenPostId === '333' && diskMonitor?.cursor?.fingerprints?.['222'] === 'fp-222' && legacy?.lastCompleteScanAt === diskMonitor?.cursor?.lastCompleteScanAt)
      check(`${prefix} v0.2.1 lastScan 完整保留`, legacy?.lastScan?.complete === true && legacy?.lastScan?.pagesRead === 2)
      check(`${prefix} v0.2.1 补偿字段保留`, legacy?.compensationHours === 36 && legacy?.lastCompensationAt !== undefined)
      check(`${prefix} v0.2.1 platformState 保留`, legacy?.platformState === 'rate_limited')
      check(`${prefix} v0.2.1 changes 保留`, Array.isArray(diskMonitor?.changes) && diskMonitor.changes.length === 1 && Array.isArray(legacy?.recentChanges) && legacy.recentChanges.length === 1)
    } else {
      check(`${prefix} v0.2.0 监控迁移到 version 2`, readJson(join(dataDir, 'monitors.json')).version === 2)
      check(`${prefix} v0.2.0 缺失补偿字段补默认 24`, legacy?.compensationHours === 24)
      check(`${prefix} v0.2.0 缺失 cursor 不伪造`, diskMonitor?.cursor === undefined)
    }

    const tasksResponse = await client.call('/api/ai-debate/automation/tasks?limit=50')
    const tasks = (tasksResponse.body?.tasks ?? []) as JsonObject[]
    const review = tasks.find((task) => task.id === 'upgrade-task-review')
    const done = tasks.find((task) => task.id === 'upgrade-task-done')
    check(`${prefix} 旧待审核任务保留`, review?.state === 'needs_review', `count=${tasks.length}`)
    check(`${prefix} 旧已完成任务保留`, done?.state === 'completed')
    if (source.version === '0.2.1') {
      check(`${prefix} 旧 modelCall 字段保留`, review?.modelCall?.candidateId === CANDIDATE_333)
      const recovered = tasks.find((task) => task.id === 'upgrade-task-recover')
      check(`${prefix} 中断任务恢复且旧租约清除`, recovered?.state === 'pending' && recovered?.leaseToken === undefined && recovered?.recoveredAt !== undefined)
      const status = await client.call('/api/ai-debate/automation/status')
      check(`${prefix} 恢复记录可查询`, status.body?.recovered === 1 && status.body?.uncertain === 0)
    }

    const workbench = await client.call(`/api/ai-debate/workbench?sessionId=${SESSION_ID}`)
    const candidates = Array.isArray(workbench.body?.candidates) ? workbench.body.candidates as JsonObject[] : []
    check(`${prefix} 核心旧会话可读`, workbench.status === 200 && workbench.body?.sessionId === SESSION_ID)
    check(`${prefix} 核心旧候选可读且未重复`, candidates.length === 2 && candidates.some((item) => item.replyId === CANDIDATE_222) && candidates.some((item) => item.replyId === CANDIDATE_333), `count=${candidates.length}`)
    const stateAfterBoot = readJson(stateFile)
    const sessionsAfterBoot = Array.isArray(stateAfterBoot.sessions) ? stateAfterBoot.sessions as JsonObject[] : []
    const approvalsAfterBoot = Array.isArray(stateAfterBoot.approvals) ? stateAfterBoot.approvals as JsonObject[] : []
    check(`${prefix} 核心旧批准记录仍在`, approvalsAfterBoot.some((approval) => approval.id === 'upgrade-approval-333' && approval.candidateId === CANDIDATE_333))
    check(`${prefix} 核心旧会话候选仍在`, sessionsAfterBoot[0]?.id === SESSION_ID && Array.isArray(sessionsAfterBoot[0]?.candidates) && sessionsAfterBoot[0].candidates.length === 2)
    check(`${prefix} 升级未改写 state.json`, sha256(readFileSync(stateFile)) === stateHashBefore, stateHashBefore.slice(0, 12))

    if (source.version === '0.2.1') {
      await verifyDecryptedCredentials(dataDir, prefix)
      const settingsText = JSON.stringify(settings.body)
      check(`${prefix} 设置 API 不回显完整凭据`, Object.values(SECRET_VALUES).every((value) => !settingsText.includes(value)))
      const secretRows = Array.isArray(settings.body?.secrets) ? settings.body.secrets as JsonObject[] : []
      check(`${prefix} 设置 API 报告凭据来自加密库`, Object.entries(SECRET_VALUES).every(([ref]) => secretRows.some((row) => row.ref === ref && row.configured === true && row.source === 'store')))
      check(`${prefix} 启动未改写凭据密文`, sha256(readFileSync(join(dataDir, 'credentials.json'))) === credentialsHashBefore)
      identityMigration = inspectIdentities(dataDir, prefix)

      const backups = await client.call('/api/ai-debate/backups')
      const rows = Array.isArray(backups.body?.backups) ? backups.body.backups as JsonObject[] : []
      const auto = rows.find((row) => row.name === 'v021-legacy-auto')
      const manual = rows.find((row) => row.name === 'v021-legacy-manual')
      check(`${prefix} 旧 auto:true manifest 可列出为 daily`, auto?.valid === true && auto?.kind === 'daily')
      check(`${prefix} 旧 auto:false manifest 可列出为 manual`, manual?.valid === true && manual?.kind === 'manual')
      for (const name of ['v021-legacy-auto', 'v021-legacy-manual']) {
        const verified = await client.call(`/api/ai-debate/backups/${name}/verify`, { method: 'POST', body: {} })
        check(`${prefix} 旧备份可校验：${name}`, verified.status === 200 && verified.body?.valid === true)
      }
    }

    if (source.version === '0.2.1') {
      const callsBefore = model.calls()
      const resumed = await client.call('/api/ai-debate/automation/resume', { method: 'POST', body: {} })
      check(`${prefix} 升级后队列可恢复`, resumed.status === 200)
      let recoveryTask: JsonObject | undefined
      const settled = await waitUntil(async () => {
        const response = await client.call('/api/ai-debate/automation/tasks?limit=50')
        const rows = (response.body?.tasks ?? []) as JsonObject[]
        recoveryTask = rows.find((task) => task.id === 'upgrade-task-recover')
        return recoveryTask?.state === 'needs_review'
      }, 30_000)
      // Read the ledger only once, after HTTP polling finishes. Tightly polling
      // the file from this process used to amplify Windows rename sharing
      // violations and make the acceptance itself a write-contention source.
      const recoveryIdentities = readJson(join(dataDir, 'reply-identities.json')).identities
      const recoveryStatus = await client.call('/api/ai-debate/automation/status')
      const recoveryDiagnostics = JSON.stringify({
        task: recoveryTask,
        identities: recoveryIdentities,
        status: recoveryStatus.body,
        serviceLogTail: service.log().slice(-2_000),
        modelCalls: model.calls() - callsBefore,
      })
      check(
        `${prefix} 恢复任务复用旧候选而不重复生成`,
        settled && model.calls() === callsBefore,
        settled ? `modelCalls=${model.calls() - callsBefore}` : recoveryDiagnostics.slice(-4_000),
      )
      check(`${prefix} 复用旧候选后 state.json 仍不变`, sha256(readFileSync(stateFile)) === stateHashBefore)
      await client.call('/api/ai-debate/automation/pause', { method: 'POST', body: {} })
    }

    const created = await client.call('/api/ai-debate/automation/monitors', {
      method: 'POST', body: { url: 'https://tieba.baidu.com/p/654321', name: '升级后新增' },
    })
    check(`${prefix} 升级后仍可新增监控`, created.status === 200, `status=${created.status}`)

    await stop(service)
    service = startCurrent(dataDir)
    const healthyAgain = await waitHealthy(service)
    check(`${prefix} 升级后二次启动`, healthyAgain, healthyAgain ? undefined : service.log().slice(-500))
    if (!healthyAgain) return
    const loginAgain = await client.call('/api/ai-debate/auth/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } })
    check(`${prefix} 二次启动后管理员仍可登录`, loginAgain.status === 200)
    const monitorsAgain = await client.call('/api/ai-debate/automation/monitors')
    const listAgain = (monitorsAgain.body?.monitors ?? []) as JsonObject[]
    check(`${prefix} 二次启动后旧监控仍在`, listAgain.some((monitor) => monitor.name === MONITOR_NAME))
    check(`${prefix} 二次启动后新增监控也在`, listAgain.some((monitor) => monitor.name === '升级后新增'), `count=${listAgain.length}`)
    check(`${prefix} 二次启动未改写 state.json`, sha256(readFileSync(stateFile)) === stateHashBefore)

    await stop(service)
    service = undefined
    const taskFile = join(dataDir, 'auto-tasks.json')
    const goodTasks = readFileSync(taskFile)
    writeFileSync(taskFile, goodTasks.subarray(0, Math.floor(goodTasks.length / 2)))
    service = startCurrent(dataDir)
    const bootedAfterCorruption = await waitHealthy(service)
    check(`${prefix} 任务台账损坏时仍可启动`, bootedAfterCorruption)
    if (bootedAfterCorruption) {
      await client.call('/api/ai-debate/auth/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } })
      const status = await client.call('/api/ai-debate/automation/status')
      const loadErrors = Array.isArray(status.body?.loadErrors) ? status.body.loadErrors as string[] : []
      const entries = readdirSync(dataDir)
      check(`${prefix} 损坏被识别或从 .bak 恢复`, loadErrors.length > 0 || entries.includes('auto-tasks.json.bak'), loadErrors.join(' / ').slice(0, 160))
      check(`${prefix} 损坏文件被另存`, entries.some((name) => name.includes('.corrupt-')))
      const recoveredTasks = await client.call('/api/ai-debate/automation/tasks?limit=50')
      const rows = Array.isArray(recoveredTasks.body?.tasks) ? recoveredTasks.body.tasks as JsonObject[] : []
      check(`${prefix} .bak 恢复后待审核任务仍在`, rows.some((task) => task.id === 'upgrade-task-review' && task.state === 'needs_review'))
    }
    await stop(service)
    service = undefined
    writeFileSync(taskFile, goodTasks)

    if (source.version === '0.2.1') {
      const layout = layoutOf(dataDir)
      const backups = new BackupService({
        layout,
        version: currentVersion(),
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        audit: { write: () => undefined },
      })
      const existing = BACKUP_FILE_NAMES.filter((name) => {
        const file = name === 'state.json' ? stateFile : join(dataDir, name)
        return existsSync(file)
      })
      const restored = backups.restore('v021-legacy-manual', { confirmed: true })
      check(`${prefix} 旧 manifest 可恢复 config/state/jobs`, JSON.stringify(restored.restored) === JSON.stringify(['config.json', 'state.json', 'jobs.json']), restored.restored.join(','))
      check(`${prefix} 恢复前快照覆盖全部现有白名单文件`, existing.every((name) => readJson(join(layout.backupsDir, restored.preRestore, 'manifest.json')).files[name] !== undefined), existing.join(','))
      check(`${prefix} 恢复前快照完整可校验`, backups.verify(restored.preRestore).valid)
      check(`${prefix} 旧备份恢复后 state.json 未变`, sha256(readFileSync(stateFile)) === stateHashBefore)
    }

    service = startCurrent(dataDir)
    const finalBoot = await waitHealthy(service)
    check(`${prefix} 恢复/损坏修复后最终启动`, finalBoot)
    if (finalBoot) {
      const finalLogin = await client.call('/api/ai-debate/auth/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } })
      check(`${prefix} 最终启动后登录与台账可读`, finalLogin.status === 200 && sha256(readFileSync(stateFile)) === stateHashBefore)
    }
  } finally {
    await stop(service)
    rmSync(dataDir, { recursive: true, force: true })
  }
  scenarioSummaries.push({
    version: source.version,
    source: prepared,
    dataDir,
    stateSha256: stateHashBefore,
    beforeFiles,
    identityMigration,
    modelCalls: model.calls() - modelCallsBefore,
  })
}

/** A model endpoint that counts calls. A correct upgrade must not call it for old candidates. */
async function startModelTrap(): Promise<{ server: Server; port: number; calls(): number }> {
  let calls = 0
  const server = createServer((request, response) => {
    calls += 1
    request.resume()
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'upgrade acceptance must reuse old candidates, not call the model' }))
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  return {
    server,
    port: typeof address === 'object' && address !== null ? address.port : 0,
    calls: (): number => calls,
  }
}

async function main(): Promise<void> {
  const model = await startModelTrap()
  try {
    for (const version of ['0.2.1', '0.2.0'] as const) {
      const source = resolveLegacySource(version)
      if (source.mode === 'real') {
        check(`v${version} 真实二进制版本与 SHA256 已核验`, true, `${source.binarySha256?.slice(0, 16)}… ${source.versionOutput}`)
      } else if (source.requested) {
        check(`v${version} 指定二进制可用`, false, source.error ?? '未知错误')
        note(`v${version} 已降级为 fixture；不得把本次结果当作真实附件升级证据。`)
      } else {
        check(`v${version} 来源明确标注为 fixture（真实附件未验证）`, true)
      }
      await runScenario(source, model)
    }
  } finally {
    await new Promise<void>((resolvePromise, reject) => {
      model.server.close((error) => error === undefined ? resolvePromise() : reject(error))
    })
  }

  const passed = results.filter((entry) => entry.ok).length
  process.stdout.write(`\n${passed}/${results.length} 项通过\n`)
  process.stdout.write('验收摘要：\n')
  for (const summary of scenarioSummaries) {
    process.stdout.write(JSON.stringify({
      version: summary.version,
      source: summary.source.mode,
      binarySha256: summary.source.binarySha256,
      versionOutput: summary.source.versionOutput,
      stateSha256: summary.stateSha256,
      identityMigration: summary.identityMigration,
      httpWrites: summary.source.httpWrites,
      offlineSeeds: summary.source.offlineSeeds,
    }))
    process.stdout.write('\n')
  }
  const realV021 = scenarioSummaries.find((summary) => summary.version === '0.2.1')?.source.mode === 'real'
  if (!realV021) process.stdout.write('阻塞：真实 v0.2.1 Release 附件未验证；fixture 通过不等于正式附件升级通过。\n')
  if (passed !== results.length) process.exitCode = 1
}

await main()
