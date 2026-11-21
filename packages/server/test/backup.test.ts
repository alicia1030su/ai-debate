/**
 * Backup centre tests.
 *
 * These use real temporary directories and real filesystem operations. The
 * failure cases deliberately damage manifests, replace a restore destination
 * with a directory, and forge a matching digest for invalid JSON so the tests
 * exercise rollback rather than a mocked copy primitive.
 */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJson } from '../src/atomic.ts'
import { createAuditor } from '../src/audit.ts'
import {
  BACKUP_FILE_NAMES,
  BackupService,
  type BackupAuditor,
  type BackupFileName,
  type BackupKind,
  type BackupManifest,
} from '../src/backup.ts'
import { CredentialStore } from '../src/credential-store.ts'
import { layoutOf, type Layout } from '../src/paths.ts'

const quiet = {
  info: (_message: string): void => undefined,
  warn: (_message: string): void => undefined,
  error: (_message: string): void => undefined,
}

interface AuditRecord {
  readonly event: string
  readonly detail?: Record<string, unknown>
}

interface Fixture {
  readonly root: string
  readonly layout: Layout
  readonly service: BackupService
  readonly events: AuditRecord[]
  readonly warnings: string[]
  restoredCalls(): number
}

function liveFile(layout: Layout, name: BackupFileName): string {
  switch (name) {
    case 'config.json':
      return layout.configFile
    case 'state.json':
      return join(layout.dataDir, 'state.json')
    case 'jobs.json':
      return layout.jobsFile
    case 'monitors.json':
      return layout.monitorsFile
    case 'auto-tasks.json':
      return layout.autoTasksFile
    case 'reply-identities.json':
      return layout.identitiesFile
    case 'credentials.json':
      return layout.credentialsFile
  }
}

function seedLayout(layout: Layout): void {
  mkdirSync(layout.dataDir, { recursive: true })
  const documents: Record<BackupFileName, unknown> = {
    'config.json': { version: 1, debate: { rounds: 3 } },
    'state.json': { version: 1, sessions: [{ id: 'session-1' }] },
    'jobs.json': { version: 1, paused: false, jobs: [] },
    'monitors.json': { version: 1, monitors: [{ id: 'monitor-1' }] },
    'auto-tasks.json': { version: 1, tasks: [{ id: 'task-1' }] },
    'reply-identities.json': { version: 1, identities: [{ id: 'identity-1' }] },
    'credentials.json': { version: 1, entries: {} },
  }
  for (const name of BACKUP_FILE_NAMES) writeJson(liveFile(layout, name), documents[name])
  writeJson(layout.adminFile, { version: 1, username: 'owner', passwordHash: 'test-hash' })
  writeFileSync(layout.credentialsKey, 'dGVzdC1rZXktbm90LWZvci1iYWNrdXA=', { mode: 0o600 })
  writeJson(layout.sessionsFile, { sessions: ['must-not-be-backed-up'] })
  writeJson(layout.configBackup, { old: true })
  writeFileSync(layout.egressFile, '{"destination":"must-not-be-backed-up"}\n')
  mkdirSync(layout.runDir, { recursive: true })
  mkdirSync(layout.logsDir, { recursive: true })
  writeJson(layout.runFile, { pid: 123 })
  writeFileSync(layout.logFile, 'private log\n')
}

function fixture(
  t: TestContext,
  options: { onRestored?: (() => void) | undefined; seed?: boolean | undefined } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ai-debate-backup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const layout = layoutOf(join(root, 'data'))
  if (options.seed !== false) seedLayout(layout)
  else mkdirSync(layout.dataDir, { recursive: true })
  const events: AuditRecord[] = []
  const warnings: string[] = []
  let restoredCalls = 0
  const audit: BackupAuditor = {
    write(event, detail): void {
      events.push({ event, ...(detail === undefined ? {} : { detail }) })
    },
  }
  const service = new BackupService({
    layout,
    version: '0.2.2',
    log: { ...quiet, warn: (message: string): void => { warnings.push(message) } },
    audit,
    onRestored: (): void => {
      restoredCalls += 1
      options.onRestored?.()
    },
  })
  return { root, layout, service, events, warnings, restoredCalls: () => restoredCalls }
}

function backupDir(layout: Layout, name: string): string {
  return join(layout.backupsDir, name)
}

function readManifest(layout: Layout, name: string): BackupManifest {
  return JSON.parse(readFileSync(join(backupDir(layout, name), 'manifest.json'), 'utf8')) as BackupManifest
}

function writeManifest(layout: Layout, name: string, manifest: BackupManifest): void {
  writeJson(join(backupDir(layout, name), 'manifest.json'), manifest)
}

function digest(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

function keepOnly(layout: Layout, names: readonly BackupFileName[]): void {
  for (const name of BACKUP_FILE_NAMES) {
    if (!names.includes(name)) rmSync(liveFile(layout, name), { force: true })
  }
}

function setCreatedAt(layout: Layout, name: string, createdAt: string): void {
  writeManifest(layout, name, { ...readManifest(layout, name), createdAt })
}

function fixedName(kind: BackupKind, suffix = '0'): string {
  return `2026-01-01T00-00-00-000Z-${kind}-00000000-0000-0000-0000-${suffix.padStart(12, '0')}`
}

test('创建：7 文件白名单、SHA-256 清单、密文原样备份且排除管理员/密钥/运行时文件', async (t) => {
  const { layout, service, events, restoredCalls } = fixture(t)
  const credentials = new CredentialStore({ file: layout.credentialsFile, keyFile: layout.credentialsKey, log: quiet })
  credentials.load()
  const plaintext = 'plaintext-secret-that-must-never-appear-in-a-backup'
  await credentials.set('AI_DEBATE_TEST_TOKEN', plaintext)
  const ciphertext = readFileSync(layout.credentialsFile)

  const name = service.create('manual')
  const dir = backupDir(layout, name)
  const manifest = readManifest(layout, name)

  assert.match(name, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-manual-[a-f0-9-]+$/)
  assert.equal(manifest.version, '0.2.2')
  assert.equal(manifest.kind, 'manual')
  assert.equal(manifest.containsCredentials, true)
  assert.equal(manifest.credentialKeyId, digest(readFileSync(layout.credentialsKey)))
  assert.match(manifest.note ?? '', /重新初始化管理员并重新输入凭据/)
  assert.ok(Number.isFinite(Date.parse(manifest.createdAt)))
  assert.deepEqual(BACKUP_FILE_NAMES, [
    'config.json',
    'state.json',
    'jobs.json',
    'monitors.json',
    'auto-tasks.json',
    'reply-identities.json',
    'credentials.json',
  ])
  assert.deepEqual(Object.keys(manifest.files), [...BACKUP_FILE_NAMES])
  assert.deepEqual(
    readdirSync(dir).sort(),
    [...BACKUP_FILE_NAMES, 'manifest.json'].sort(),
    '备份目录只能包含白名单文件与清单',
  )
  for (const fileName of BACKUP_FILE_NAMES) {
    const contents = readFileSync(join(dir, fileName))
    const expected = manifest.files[fileName]
    assert.ok(expected !== undefined)
    assert.equal(expected.bytes, contents.length)
    assert.equal(expected.sha256, digest(contents))
  }
  assert.deepEqual(readFileSync(join(dir, 'credentials.json')), ciphertext, 'AES-GCM 密文必须逐字节保留')
  assert.equal(readFileSync(join(dir, 'credentials.json'), 'utf8').includes(plaintext), false)
  assert.equal(existsSync(join(dir, 'admin.json')), false)
  assert.equal(existsSync(join(dir, 'credentials.key')), false)
  assert.equal(existsSync(join(dir, 'sessions.json')), false)
  assert.equal(existsSync(join(dir, 'run')), false)
  assert.equal(existsSync(join(dir, 'logs')), false)
  assert.equal(existsSync(join(dir, 'egress.jsonl')), false)
  assert.equal(existsSync(join(dir, 'config.json.bak')), false)
  assert.deepEqual(readdirSync(layout.backupsDir), [name], '成功后不得遗留 staging 目录')

  assert.deepEqual(service.verify(name), { valid: true })
  const listed = service.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.name, name)
  assert.equal(listed[0]?.kind, 'manual')
  assert.equal(listed[0]?.files, BACKUP_FILE_NAMES.length)
  assert.equal(listed[0]?.bytes, Object.values(manifest.files).reduce((sum, file) => sum + file.bytes, 0))
  assert.equal(listed[0]?.valid, true)
  assert.equal(listed[0]?.error, null)
  assert.equal(events.at(-1)?.event, 'backup.created')
  assert.equal(restoredCalls(), 0)
})

test('list 只读 manifest；文件被篡改时 list 仍有效但 verify 失败', (t) => {
  const { layout, service } = fixture(t)
  const name = service.create('daily')
  const file = join(backupDir(layout, name), 'config.json')
  writeFileSync(file, `${readFileSync(file, 'utf8')}tampered\n`)

  assert.equal(service.list()[0]?.valid, true, 'list 不应对文件内容做完整性校验')
  const verification = service.verify(name)
  assert.equal(verification.valid, false)
  assert.match(verification.error ?? '', /config\.json/)
})

test('损坏或含路径穿越的 manifest 被标记无效并拒绝校验', (t) => {
  const { layout, service } = fixture(t)
  const name = service.create('weekly')
  const original = readManifest(layout, name)
  const manifestPath = join(backupDir(layout, name), 'manifest.json')
  writeFileSync(manifestPath, '{not json', 'utf8')
  assert.equal(service.list()[0]?.valid, false)
  assert.equal(service.verify(name).valid, false)

  writeManifest(layout, name, original)
  writeManifest(layout, name, {
    ...original,
    files: {
      ...original.files,
      '../outside.json': { sha256: 'a'.repeat(64), bytes: 2 },
    },
  })
  assert.equal(service.list()[0]?.valid, false)
  assert.equal(service.verify(name).valid, false)

  writeManifest(layout, name, {
    ...original,
    files: {
      ...original.files,
      'admin.json': { sha256: 'a'.repeat(64), bytes: 2 },
    },
  })
  assert.equal(service.verify(name).valid, false, '旧版含管理员的备份必须拒绝恢复')

  const legacyName = '2025-01-01T00-00-00-000Z'
  mkdirSync(backupDir(layout, legacyName))
  writeFileSync(join(backupDir(layout, legacyName), 'manifest.json'), 'not json', 'utf8')
  const legacy = service.list().find((entry) => entry.name === legacyName)
  assert.equal(legacy?.valid, false, '旧目录名应保持可见，而不是从清单中消失')
  assert.equal(service.verify(legacyName).valid, false)
})

test('旧 v0.2.1 manifest：auto 映射 daily/manual，可 list、verify 与 restore', (t) => {
  const { layout, service } = fixture(t)
  mkdirSync(layout.backupsDir, { recursive: true })
  const dailyName = '2025-01-01T00-00-00-000Z'
  const manualName = '2025-01-02T00-00-00-000Z'
  const documents: Record<string, unknown> = {
    'config.json': { version: 1, legacy: 'daily' },
    'state.json': { version: 1, sessions: [] },
    'jobs.json': { version: 1, paused: false, jobs: [] },
  }
  for (const [name, auto] of [[dailyName, true], [manualName, false]] as const) {
    mkdirSync(backupDir(layout, name))
    const files: Record<string, { sha256: string; bytes: number }> = {}
    for (const [fileName, document] of Object.entries(documents)) {
      const contents = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
      writeFileSync(join(backupDir(layout, name), fileName), contents)
      files[fileName] = { sha256: digest(contents), bytes: contents.length }
    }
    writeJson(join(backupDir(layout, name), 'manifest.json'), {
      version: '0.2.1',
      createdAt: name.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z'),
      auto,
      files,
      note: '不含凭据、口令与会话',
    })
  }

  assert.equal(service.list().find((entry) => entry.name === dailyName)?.kind, 'daily')
  assert.equal(service.list().find((entry) => entry.name === manualName)?.kind, 'manual')
  assert.deepEqual(service.verify(dailyName), { valid: true })
  assert.deepEqual(service.verify(manualName), { valid: true })
  service.restore(dailyName, { confirmed: true })
  assert.deepEqual(JSON.parse(readFileSync(layout.configFile, 'utf8')), documents['config.json'])
  assert.equal(readManifest(layout, dailyName).kind, 'daily')
  assert.equal(readManifest(layout, dailyName).containsCredentials, false)
})

test('verify 与 restore 拒绝路径穿越、绝对路径和多级目录', (t) => {
  const { root, layout, service } = fixture(t)
  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeJson(join(outside, 'config.json'), { stolen: true })
  const invalidNames = [
    '../outside',
    '..\\outside',
    outside,
    'nested/backup',
    'nested\\backup',
    '.',
    '..',
    '',
  ]
  for (const name of invalidNames) {
    assert.equal(service.verify(name).valid, false, `应拒绝 ${name}`)
    assert.throws(() => service.restore(name, { confirmed: true }), /不合法|不存在/)
  }
  assert.deepEqual(JSON.parse(readFileSync(join(outside, 'config.json'), 'utf8')), { stolen: true })
  assert.equal(layout.backupsDir.startsWith(root), true)
})

test('verify 拒绝指向备份目录之外的符号链接', (t) => {
  const { root, layout, service } = fixture(t)
  const outside = join(root, 'outside')
  mkdirSync(outside)
  mkdirSync(layout.backupsDir, { recursive: true })
  writeJson(join(outside, 'manifest.json'), { version: '0.2.2' })
  const name = fixedName('manual')
  symlinkSync(outside, backupDir(layout, name), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(service.verify(name).valid, false)
  assert.throws(() => service.restore(name, { confirmed: true }), /普通目录/)

  rmSync(backupDir(layout, name))
  rmSync(layout.backupsDir, { recursive: true })
  symlinkSync(outside, layout.backupsDir, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(service.verify(name).valid, false)
  assert.deepEqual(service.list(), [], 'backups 根目录是符号链接时不得读取外部清单')
  assert.throws(() => service.create('manual'), /普通目录/)
})

test('构造：兼容现有 createAuditor 返回值', (t) => {
  const { root, layout } = fixture(t, { seed: false })
  const auditor = createAuditor(join(root, 'audit', 'events.jsonl'))
  const service = new BackupService({ layout, version: '0.2.2', log: quiet, audit: auditor })
  writeJson(layout.configFile, { version: 1 })
  assert.doesNotThrow(() => service.create('manual'))
  assert.equal(readFileSync(join(root, 'audit', 'events.jsonl'), 'utf8').includes('backup.created'), true)
})

test('AbortSignal：创建与恢复在文件边界前取消，不发布半成品', (t) => {
  const { layout, service } = fixture(t)
  keepOnly(layout, ['config.json'])
  const controller = new AbortController()
  controller.abort()
  assert.throws(() => service.create('manual', { signal: controller.signal }), /取消/)
  assert.equal(existsSync(layout.backupsDir), false, '预取消操作不得创建备份根目录')

  const name = service.create('manual')
  const before = readFileSync(layout.configFile)
  assert.throws(() => service.restore(name, { confirmed: true, signal: controller.signal }), /取消/)
  assert.deepEqual(readFileSync(layout.configFile), before)
  assert.equal(readdirSync(layout.backupsDir).some((entry) => entry.startsWith('pre-restore-')), false)
})

test('restore 必须显式确认，未确认时不创建恢复前备份', (t) => {
  const { layout, service, events, restoredCalls } = fixture(t)
  const name = service.create('manual')
  const before = readFileSync(layout.configFile)
  assert.throws(() => service.restore(name, { confirmed: false }), /确认/)
  assert.deepEqual(readFileSync(layout.configFile), before)
  assert.equal(readdirSync(layout.backupsDir).some((entry) => entry.startsWith('pre-restore-')), false)
  assert.equal(events.some((event) => event.event === 'backup.restored'), false)
  assert.equal(restoredCalls(), 0)
})

test('恢复：内容一致、保留备份中不存在的文件、生成预备份并记录 restored', (t) => {
  const { layout, service, events, restoredCalls } = fixture(t)
  keepOnly(layout, ['config.json', 'jobs.json'])
  const originalConfig = readFileSync(layout.configFile)
  const originalJobs = readFileSync(layout.jobsFile)
  const name = service.create('manual')

  writeJson(layout.configFile, { version: 1, debate: { rounds: 99 } })
  writeJson(layout.jobsFile, { version: 1, paused: true, jobs: [{ id: 'new-job' }] })
  const beforeRestoreConfig = readFileSync(layout.configFile)
  writeJson(layout.monitorsFile, { version: 1, monitors: [{ id: 'keep-me' }] })
  const untouchedMonitors = readFileSync(layout.monitorsFile)
  writeJson(layout.adminFile, { version: 1, username: 'owner', passwordHash: 'current-admin' })
  const currentAdmin = readFileSync(layout.adminFile)

  const result = service.restore(name, { confirmed: true })
  assert.equal(result.name, name)
  assert.match(result.preRestore, /^pre-restore-/)
  assert.deepEqual(result.restored, ['config.json', 'jobs.json'])
  assert.deepEqual(readFileSync(layout.configFile), originalConfig)
  assert.deepEqual(readFileSync(layout.jobsFile), originalJobs)
  assert.deepEqual(readFileSync(layout.monitorsFile), untouchedMonitors, '备份中不存在的当前文件必须保留')
  assert.deepEqual(readFileSync(layout.adminFile), currentAdmin, '同机恢复必须保留当前管理员')
  assert.equal(existsSync(layout.credentialsFile), false, '恢复不得凭空创建备份中不存在的文件')

  const pre = readManifest(layout, result.preRestore)
  assert.equal(pre.kind, 'manual')
  assert.deepEqual(readFileSync(join(backupDir(layout, result.preRestore), 'config.json')), beforeRestoreConfig)
  assert.ok(pre.files['monitors.json'] !== undefined, '预备份应覆盖当前所有白名单文件')
  assert.equal(pre.files['admin.json'], undefined, '预备份同样不得包含管理员')
  const updated = readManifest(layout, name)
  assert.deepEqual(updated.restored, ['config.json', 'jobs.json'])
  assert.ok(updated.restoredAt !== undefined)
  assert.deepEqual(service.verify(name), { valid: true })
  assert.equal(events.at(-1)?.event, 'backup.restored')
  assert.equal(events.at(-1)?.detail?.preRestore, result.preRestore)
  assert.equal(restoredCalls(), 1)
  assert.equal(readdirSync(layout.dataDir).some((entry) => entry.endsWith('.tmp')), false)
})

test('恢复排除管理员与凭据密钥：同机保留，全新安装跳过密文且需重输凭据', async (t) => {
  const { layout, service, warnings } = fixture(t)
  const credentials = new CredentialStore({ file: layout.credentialsFile, keyFile: layout.credentialsKey, log: quiet })
  credentials.load()
  await credentials.set('AI_DEBATE_PORTABLE_SECRET', 'secret-on-original-machine')
  const ciphertext = readFileSync(layout.credentialsFile)
  const originalKey = readFileSync(layout.credentialsKey)
  const name = service.create('manual')
  writeJson(layout.adminFile, { version: 1, username: 'owner', passwordHash: 'current-admin' })
  const currentAdmin = readFileSync(layout.adminFile)

  const sameKeyResult = service.restore(name, { confirmed: true })
  assert.deepEqual(sameKeyResult.skipped, [])
  assert.deepEqual(readFileSync(layout.adminFile), currentAdmin, '同机升级保留现有管理员')
  assert.deepEqual(readFileSync(layout.credentialsKey), originalKey, '同机升级保留现有凭据密钥')
  assert.deepEqual(readFileSync(layout.credentialsFile), ciphertext, '同钥恢复密文')

  rmSync(layout.adminFile)
  rmSync(layout.credentialsKey)
  rmSync(layout.credentialsFile)
  const freshResult = service.restore(name, { confirmed: true })
  assert.deepEqual(freshResult.skipped, ['credentials.json'])
  assert.equal(existsSync(layout.adminFile), false, '全新安装不得从备份恢复管理员')
  assert.equal(existsSync(layout.credentialsKey), false, '全新安装不得从备份恢复凭据密钥')
  assert.equal(existsSync(layout.credentialsFile), false, '无密钥时不得恢复不可解密的密文')
  assert.equal(warnings.some((message) => message.includes('请重新填写')), true)
  assert.deepEqual(readManifest(layout, name).skipped, ['credentials.json'])
  assert.equal(readManifest(layout, name).restored?.includes('credentials.json'), false)
})

test('凭据密钥指纹不匹配时拒绝整个恢复，且不创建预备份', async (t) => {
  const { layout, service, events } = fixture(t)
  const credentials = new CredentialStore({ file: layout.credentialsFile, keyFile: layout.credentialsKey, log: quiet })
  credentials.load()
  await credentials.set('AI_DEBATE_TEST_TOKEN', 'secret')
  const name = service.create('manual')
  writeJson(layout.configFile, { version: 1, debate: { rounds: 88 } })
  const liveConfig = readFileSync(layout.configFile)
  writeFileSync(layout.credentialsKey, randomBytes(32).toString('base64'), { mode: 0o600 })

  assert.throws(() => service.restore(name, { confirmed: true }), /指纹不匹配/)
  assert.deepEqual(readFileSync(layout.configFile), liveConfig)
  assert.equal(service.list().some((entry) => entry.name.startsWith('pre-restore-')), false)
  assert.equal(events.at(-1)?.event, 'backup.restore_failed')
})

test('生产启动顺序：load 不建 key；跨机缺 key 跳过、同 key 恢复、异 key 拒绝', async (t) => {
  const source = fixture(t)
  rmSync(source.layout.credentialsFile)
  rmSync(source.layout.credentialsKey)
  const sourceCredentials = new CredentialStore({
    file: source.layout.credentialsFile,
    keyFile: source.layout.credentialsKey,
    log: quiet,
  })
  sourceCredentials.load()
  await sourceCredentials.set('AI_DEBATE_PORTABLE_SECRET', 'secret-on-original-machine')
  const ciphertext = readFileSync(source.layout.credentialsFile)
  const originalKey = readFileSync(source.layout.credentialsKey)
  const name = source.service.create('manual')
  const manifest = readManifest(source.layout, name)
  assert.ok(manifest.files['credentials.json'] !== undefined)
  assert.equal(manifest.credentialKeyId, digest(originalKey))
  assert.equal(existsSync(join(backupDir(source.layout, name), 'credentials.key')), false)

  const makeTarget = (): Fixture => {
    const target = fixture(t, { seed: false })
    writeJson(target.layout.configFile, { version: 1, target: true })
    return target
  }
  const installBackup = (target: Fixture): void => {
    mkdirSync(target.layout.backupsDir, { recursive: true })
    cpSync(backupDir(source.layout, name), backupDir(target.layout, name), { recursive: true })
  }

  const fresh = makeTarget()
  const freshCredentials = new CredentialStore({
    file: fresh.layout.credentialsFile,
    keyFile: fresh.layout.credentialsKey,
    log: quiet,
  })
  assert.deepEqual(freshCredentials.load(), { loaded: false, corrupt: false })
  assert.equal(existsSync(fresh.layout.credentialsKey), false, '生产启动 load 不得创建临时 key')
  installBackup(fresh)
  const freshResult = fresh.service.restore(name, { confirmed: true })
  assert.deepEqual(freshResult.skipped, ['credentials.json'])
  assert.equal(existsSync(fresh.layout.credentialsKey), false)
  assert.equal(existsSync(fresh.layout.credentialsFile), false)
  assert.equal(fresh.warnings.some((message) => message.includes('请重新填写')), true)

  const keylessReader = makeTarget()
  writeFileSync(keylessReader.layout.credentialsFile, ciphertext)
  const readerCredentials = new CredentialStore({
    file: keylessReader.layout.credentialsFile,
    keyFile: keylessReader.layout.credentialsKey,
    log: quiet,
  })
  assert.deepEqual(readerCredentials.load(), { loaded: false, corrupt: true })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await readerCredentials.describe('AI_DEBATE_PORTABLE_SECRET')).configured, false)
    assert.equal(await readerCredentials.resolve('AI_DEBATE_PORTABLE_SECRET'), undefined)
    assert.equal(existsSync(keylessReader.layout.credentialsKey), false)
  }
  installBackup(keylessReader)
  assert.deepEqual(keylessReader.service.restore(name, { confirmed: true }).skipped, ['credentials.json'])
  assert.equal(existsSync(keylessReader.layout.credentialsKey), false)

  const sameKey = makeTarget()
  writeFileSync(sameKey.layout.credentialsKey, originalKey, { mode: 0o600 })
  const sameKeyCredentials = new CredentialStore({
    file: sameKey.layout.credentialsFile,
    keyFile: sameKey.layout.credentialsKey,
    log: quiet,
  })
  sameKeyCredentials.load()
  installBackup(sameKey)
  const sameKeyResult = sameKey.service.restore(name, { confirmed: true })
  assert.deepEqual(sameKeyResult.skipped, [])
  assert.deepEqual(readFileSync(sameKey.layout.credentialsFile), ciphertext)

  const mismatch = makeTarget()
  writeFileSync(mismatch.layout.credentialsKey, randomBytes(32).toString('base64'), { mode: 0o600 })
  const mismatchCredentials = new CredentialStore({
    file: mismatch.layout.credentialsFile,
    keyFile: mismatch.layout.credentialsKey,
    log: quiet,
  })
  mismatchCredentials.load()
  installBackup(mismatch)
  assert.throws(() => mismatch.service.restore(name, { confirmed: true }), /指纹不匹配/)
  assert.equal(mismatch.service.list().some((entry) => entry.name.startsWith('pre-restore-')), false)
  assert.equal(mismatch.events.at(-1)?.event, 'backup.restore_failed')
})

test('恢复中途目标目录冲突：已替换文件回滚，冲突目录保留', (t) => {
  const { layout, service, events, restoredCalls } = fixture(t)
  keepOnly(layout, ['config.json', 'jobs.json'])
  const name = service.create('manual')
  writeJson(layout.configFile, { version: 1, debate: { rounds: 77 } })
  const liveConfig = readFileSync(layout.configFile)
  rmSync(layout.jobsFile)
  mkdirSync(layout.jobsFile)

  assert.throws(() => service.restore(name, { confirmed: true }), /恢复失败/)
  assert.deepEqual(readFileSync(layout.configFile), liveConfig, '首个已恢复文件必须回滚')
  assert.equal(statSync(layout.jobsFile).isDirectory(), true)
  const pre = service.list().find((entry) => entry.name.startsWith('pre-restore-'))
  assert.ok(pre !== undefined)
  assert.deepEqual(service.verify(pre.name), { valid: true })
  assert.equal(events.at(-1)?.event, 'backup.restore_failed')
  assert.equal(events.at(-1)?.detail?.rollbackOk, true)
  assert.equal(restoredCalls(), 0)
})

test('pre-restore 清理旧明文配置；损坏原文另存 dataDir 且备份仅放安全占位', (t) => {
  const { layout, service } = fixture(t)
  keepOnly(layout, ['config.json'])
  const safeConfig = readFileSync(layout.configFile)
  const name = service.create('manual')
  const secret = 'legacy-secret-must-not-enter-backups'

  const restoreAndGetPre = (): string => {
    const before = new Set(service.list().map((entry) => entry.name))
    service.restore(name, { confirmed: true })
    const created = service.list().map((entry) => entry.name).find((entry) => !before.has(entry))
    assert.ok(created !== undefined)
    return created
  }

  writeJson(layout.configFile, { version: 1, tiebaCookie: secret, llmApiKey: '', keep: true })
  const plaintextPre = restoreAndGetPre()
  assert.equal(readManifest(layout, plaintextPre).sanitized, true)
  const sanitized = JSON.parse(readFileSync(join(backupDir(layout, plaintextPre), 'config.json'), 'utf8')) as Record<string, unknown>
  assert.equal(sanitized.tiebaCookie, undefined)
  assert.equal(sanitized.keep, true)
  assert.equal(readdirSync(layout.dataDir).some((entry) => entry.startsWith('config.json.corrupt-')), false)

  const corrupt = `{"tiebaCookie":"${secret}","broken":`
  writeFileSync(layout.configFile, corrupt, 'utf8')
  const corruptPre = restoreAndGetPre()
  assert.equal(readManifest(layout, corruptPre).sanitized, true)
  assert.deepEqual(JSON.parse(readFileSync(join(backupDir(layout, corruptPre), 'config.json'), 'utf8')), {})
  const aside = readdirSync(layout.dataDir).find((entry) => entry.startsWith('config.json.corrupt-'))
  assert.ok(aside !== undefined)
  assert.equal(readFileSync(join(layout.dataDir, aside), 'utf8'), corrupt)
  if (process.platform !== 'win32') assert.equal(statSync(join(layout.dataDir, aside)).mode & 0o777, 0o600)

  for (const dirName of readdirSync(layout.backupsDir)) {
    const dir = backupDir(layout, dirName)
    if (!statSync(dir).isDirectory()) continue
    for (const fileName of readdirSync(dir)) {
      assert.equal(readFileSync(join(dir, fileName), 'utf8').includes(secret), false, '备份目录不得含旧明文秘密')
    }
  }
  assert.deepEqual(readFileSync(layout.configFile), safeConfig, '最终应恢复到安全配置')
})

test('恢复校验：即使 manifest 摘要匹配，无效 JSON 也会逐文件回滚', (t) => {
  const { layout, service, events } = fixture(t)
  keepOnly(layout, ['config.json', 'jobs.json'])
  const name = service.create('manual')
  const invalid = Buffer.from('{"version":1,"broken":', 'utf8')
  writeFileSync(join(backupDir(layout, name), 'jobs.json'), invalid)
  const manifest = readManifest(layout, name)
  writeManifest(layout, name, {
    ...manifest,
    files: { ...manifest.files, 'jobs.json': { sha256: digest(invalid), bytes: invalid.length } },
  })
  assert.deepEqual(service.verify(name), { valid: true }, 'verify 只验证摘要，JSON 可解析性由 restore 保证')
  writeJson(layout.configFile, { version: 1, debate: { rounds: 55 } })
  writeJson(layout.jobsFile, { version: 1, paused: true, jobs: [] })
  const liveConfig = readFileSync(layout.configFile)
  const liveJobs = readFileSync(layout.jobsFile)

  assert.throws(() => service.restore(name, { confirmed: true }), /JSON/)
  assert.deepEqual(readFileSync(layout.configFile), liveConfig, '首个已恢复文件必须回滚')
  assert.deepEqual(readFileSync(layout.jobsFile), liveJobs, '触发校验失败的文件也必须回滚')
  assert.equal(events.at(-1)?.event, 'backup.restore_failed')
  assert.equal(events.at(-1)?.detail?.rollbackOk, true)
})

test('恢复后回调失败：撤销恢复并回滚 manifest 的 restored 记录', (t) => {
  const { layout, service, events } = fixture(t, {
    onRestored: (): void => {
      throw new Error('restart scheduling failed')
    },
  })
  keepOnly(layout, ['config.json'])
  const name = service.create('manual')
  rmSync(layout.configFile)

  assert.throws(() => service.restore(name, { confirmed: true }), /restart scheduling failed/)
  assert.equal(existsSync(layout.configFile), false, '恢复前不存在的文件在回滚后应重新变为不存在')
  assert.equal(readManifest(layout, name).restored, undefined)
  assert.deepEqual(service.verify(name), { valid: true })
  assert.deepEqual(events.slice(-2).map((event) => event.event), ['backup.restored', 'backup.restore_failed'])
  assert.equal(events.at(-1)?.detail?.rollbackOk, true)
})

test('prune：daily 保留 7、weekly 保留 4、manual 与不可验证备份永不删除', (t) => {
  const { layout, service, warnings } = fixture(t)
  keepOnly(layout, ['config.json'])
  const daily: string[] = []
  const weekly: string[] = []
  const manual: string[] = []
  for (let index = 0; index < 9; index += 1) {
    const name = service.create('daily')
    daily.push(name)
    setCreatedAt(layout, name, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString())
  }
  for (let index = 0; index < 6; index += 1) {
    const name = service.create('weekly')
    weekly.push(name)
    setCreatedAt(layout, name, new Date(Date.UTC(2026, 1, 1, 0, index)).toISOString())
  }
  for (let index = 0; index < 2; index += 1) {
    const name = service.create('manual')
    manual.push(name)
    setCreatedAt(layout, name, new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString())
  }

  const unverifiable = fixedName('daily', '1')
  mkdirSync(backupDir(layout, unverifiable))
  writeManifest(layout, unverifiable, {
    version: '0.2.2',
    createdAt: '2025-01-01T00:00:00.000Z',
    kind: 'daily',
    files: { 'config.json': { sha256: 'a'.repeat(64), bytes: 2 } },
    containsCredentials: false,
  })
  const malformed = fixedName('weekly', '2')
  mkdirSync(backupDir(layout, malformed))
  writeFileSync(join(backupDir(layout, malformed), 'manifest.json'), 'not json', 'utf8')

  const removed = service.prune()
  assert.deepEqual([...removed].sort(), [...daily.slice(0, 2), ...weekly.slice(0, 2)].sort())
  for (const name of [...daily.slice(2), ...weekly.slice(2), ...manual, unverifiable, malformed]) {
    assert.equal(existsSync(backupDir(layout, name)), true, `${name} 应保留`)
  }
  for (const name of removed) assert.equal(existsSync(backupDir(layout, name)), false)
  for (const name of manual) assert.deepEqual(service.verify(name), { valid: true })
  assert.equal(service.verify(unverifiable).valid, false)
  assert.equal(service.verify(malformed).valid, false)
  assert.deepEqual(service.prune(), [], '第二次轮转不应重复删除')
  assert.equal(warnings.some((message) => message.includes('永久保留')), true, '永久保留备份应有空间告警')
})

test('创建拒绝 config.json 旧明文字段，避免备份泄露秘密', (t) => {
  const { layout, service } = fixture(t)
  keepOnly(layout, ['config.json'])
  for (const field of ['tiebaCookie', 'llmApiKey']) {
    writeJson(layout.configFile, { version: 1, [field]: 'legacy-plaintext-secret' })
    assert.throws(() => service.create('manual'), new RegExp(`明文旧字段 ${field}`))
    assert.deepEqual(readdirSync(layout.backupsDir), [], '拒绝后不得发布备份或 staging')
  }
  writeFileSync(layout.configFile, '{not json', 'utf8')
  assert.throws(() => service.create('manual'), /无法解析/)
  assert.deepEqual(readdirSync(layout.backupsDir), [])
})

test('创建拒绝白名单路径是目录或符号链接，且不发布半成品', (t) => {
  const { root, layout, service } = fixture(t)
  const outside = join(root, 'outside-config')
  mkdirSync(outside)
  writeJson(join(outside, 'config.json'), { outside: true })
  rmSync(layout.configFile)
  symlinkSync(outside, layout.configFile, process.platform === 'win32' ? 'junction' : 'dir')

  assert.throws(() => service.create('manual'), /符号链接/)
  assert.deepEqual(readdirSync(layout.backupsDir), [], '失败的备份不得发布任何目录')
  assert.equal(readdirSync(layout.backupsDir).some((entry) => entry.startsWith('.')), false)

  rmSync(layout.configFile)
  mkdirSync(layout.configFile)
  assert.throws(() => service.create('manual'), /白名单路径不是普通文件/)
  assert.deepEqual(readdirSync(layout.backupsDir), [], '目录冲突同样不得发布备份')
})
