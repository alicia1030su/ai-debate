/** Legacy reply-identity migration: precedence, backfill, idempotence and fail-closed writes. */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReplyIdentityStore } from '../src/monitor/identities.ts'
import { migrateLegacyReplyIdentities } from '../src/monitor/migrate.ts'
import { AutoTaskStore } from '../src/monitor/tasks.ts'

const quiet = { warn: () => undefined }
const NOW = '2026-01-01T00:00:00.000Z'

interface Fixture {
  readonly root: string
  readonly monitorsFile: string
  readonly tasksFile: string
  readonly stateFile: string
  readonly identityFile: string
  readonly identities: ReplyIdentityStore
  readonly tasks: AutoTaskStore
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function hash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ai-debate-migrate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const monitorsFile = join(root, 'monitors.json')
  const tasksFile = join(root, 'auto-tasks.json')
  const stateFile = join(root, 'state.json')
  const identityFile = join(root, 'reply-identities.json')
  const identities = new ReplyIdentityStore({ file: identityFile, log: quiet })
  const tasks = new AutoTaskStore({ file: tasksFile, log: quiet })
  identities.load()
  return { root, monitorsFile, tasksFile, stateFile, identityFile, identities, tasks }
}

function run(item: Fixture, now = '2026-01-01T00:00:00.000Z') {
  return migrateLegacyReplyIdentities({
    monitorsFile: item.monitorsFile,
    tasksFile: item.tasksFile,
    stateFile: item.stateFile,
    identities: item.identities,
    tasks: item.tasks,
    now,
    log: quiet,
  })
}

function monitor(id: string, threadId: string, seen: string[], fingerprints: Record<string, string> = {}) {
  return {
    id,
    platform: 'tieba',
    threadId,
    seen,
    cursor: { fingerprints },
  }
}

function task(id: string, kind: string, state: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind,
    monitorId: 'm1',
    dedupeKey: `${kind}:${id}`,
    state,
    attempts: 0,
    maxAttempts: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    nextRunAt: '2026-01-01T00:00:00.000Z',
    logs: [],
    ...extra,
  }
}

test('迁移：candidate 优先、重复 monitor 合并、core-only 会话使用 legacy 来源', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, {
    version: 2,
    monitors: [
      monitor('m1', 't1', ['1', '2', '3'], { '2': 'cursor-2' }),
      monitor('m2', 't1', ['2', '4'], { '4': 'cursor-4' }),
    ],
  })
  writeJson(item.tasksFile, { version: 2, paused: true, tasks: [] })
  writeJson(item.stateFile, {
    version: 1,
    sessions: [
      { id: 's1', platform: 'tieba', threadId: 't1', candidates: [{ replyId: 'c2', targetPostId: '2' }] },
      { id: 's2', platform: 'tieba', threadId: 't2', candidates: [{ replyId: 'c9', targetPostId: '9' }] },
    ],
    dedupe: [],
  })

  const result = run(item)
  assert.equal(result.identityWritten, true)
  assert.equal(result.identities, 5)
  assert.equal(result.candidates, 2)
  assert.equal(result.ignored, 3)
  assert.equal(item.identities.get('stable:tieba:t1:2')?.state, 'candidate')
  assert.equal(item.identities.get('stable:tieba:t1:2')?.sessionId, 's1')
  assert.equal(item.identities.get('stable:tieba:t1:2')?.candidateId, 'c2')
  assert.equal(item.identities.get('stable:tieba:t1:2')?.fingerprint, 'cursor-2')
  assert.equal(item.identities.get('stable:tieba:t1:2')?.monitorId, 'm1')
  assert.equal(item.identities.get('stable:tieba:t1:4')?.fingerprint, 'cursor-4')
  assert.equal(item.identities.get('stable:tieba:t2:9')?.monitorId, 'legacy:tieba:t2')
  assert.match(item.identities.get('stable:tieba:t1:1')?.fingerprint ?? '', /^legacy-[a-f0-9]{32}$/)
})

test('迁移：活跃任务 claimed、终态无候选 ignored、批任务回填且 candidate 覆盖 active', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, { version: 2, monitors: [monitor('m1', 't1', ['1', '2', '3', '4', '5', '6', '7', '8', '9'])] })
  writeJson(item.tasksFile, {
    version: 2,
    paused: true,
    tasks: [
      task('pending', 'analyze', 'pending', { postId: '4' }),
      task('running', 'generate', 'running', { postId: '5' }),
      task('blocked', 'analyze', 'blocked', { postId: '6' }),
      task('retry', 'analyze', 'retry_wait', { postIds: ['7', '8'] }),
      task('done', 'generate', 'completed', { postId: '9' }),
      task('review', 'generate', 'needs_review', { postId: '2' }),
    ],
  })
  writeJson(item.stateFile, {
    version: 1,
    sessions: [{ id: 's1', platform: 'tieba', threadId: 't1', candidates: [
      { replyId: 'c2', targetPostId: '2' },
      { replyId: 'c8', targetPostId: '8' },
    ] }],
    dedupe: [],
  })
  item.tasks.load()

  const result = run(item)
  assert.equal(result.tasksBackfilled, 6)
  assert.equal(result.claimed, 4)
  assert.equal(result.candidates, 2)
  assert.equal(result.ignored, 3)
  for (const postId of ['4', '5', '6', '7']) {
    assert.equal(item.identities.get(`stable:tieba:t1:${postId}`)?.state, 'claimed')
  }
  assert.equal(item.identities.get('stable:tieba:t1:8')?.state, 'candidate')
  assert.equal(item.identities.get('stable:tieba:t1:9')?.state, 'ignored')
  assert.equal(item.tasks.get('pending')?.identityKey, 'stable:tieba:t1:4')
  assert.deepEqual(item.tasks.get('retry')?.identityKeys, ['stable:tieba:t1:7', 'stable:tieba:t1:8'])
  assert.equal(item.tasks.get('retry')?.identityKey, undefined)
  const activeKeys = new Set(item.tasks.all().flatMap((entry) => [
    ...(entry.identityKey === undefined ? [] : [entry.identityKey]),
    ...(entry.identityKeys ?? []),
  ]))
  assert.deepEqual(item.identities.orphans(activeKeys), [], '活跃身份回填后不得被 orphan 恢复重放')
})

test('迁移：仅 monitor seen 的旧回复标 ignored，不能再次认领分析', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, { version: 2, monitors: [monitor('m1', 't1', ['11', '12'], { '12': 'fp-12' })] })
  writeJson(item.tasksFile, { version: 2, paused: true, tasks: [] })
  writeJson(item.stateFile, { version: 1, sessions: [], dedupe: [] })
  item.tasks.load()

  run(item)
  const claimed = item.identities.claim({
    platform: 'tieba', threadId: 't1', postId: '11', quality: 'stable', fingerprint: 'new-read', monitorId: 'm1',
  })
  assert.equal(claimed.fresh, false)
  assert.equal(claimed.identity.state, 'ignored')
  assert.equal(claimed.identity.lastError, 'legacy-seen')
})

test('迁移：v0.2.0/v0.2.1 dedupeKey 在缺少 postId 时仍能恢复回复身份', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, { version: 2, monitors: [monitor('m1', 't1', [])] })
  writeJson(item.tasksFile, {
    version: 2,
    paused: true,
    tasks: [
      task('old-session', 'generate', 'completed', { monitorId: 'missing', sessionId: 's0', dedupeKey: 'generate:s0:12' }),
      task('old-monitor', 'analyze', 'pending', { monitorId: 'missing', dedupeKey: 'analyze:m1:13' }),
    ],
  })
  writeJson(item.stateFile, {
    version: 1,
    sessions: [{ id: 's0', platform: 'tieba', threadId: 't1', candidates: [] }],
    dedupe: [],
  })
  item.tasks.load()

  const result = run(item)
  assert.equal(result.tasksBackfilled, 2)
  assert.equal(item.identities.get('stable:tieba:t1:12')?.state, 'ignored')
  assert.equal(item.identities.get('stable:tieba:t1:13')?.state, 'claimed')
  assert.equal(item.tasks.get('old-session')?.identityKey, 'stable:tieba:t1:12')
  assert.equal(item.tasks.get('old-monitor')?.identityKey, 'stable:tieba:t1:13')
})

test('迁移：重启幂等，不重写身份台账也不重复回填任务', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, { version: 2, monitors: [monitor('m1', 't1', ['1', '2'])] })
  writeJson(item.tasksFile, { version: 2, paused: true, tasks: [task('active', 'analyze', 'pending', { postId: '2' })] })
  writeJson(item.stateFile, { version: 1, sessions: [], dedupe: [] })
  item.tasks.load()
  assert.equal(run(item).identityWritten, true)
  const identityHash = hash(item.identityFile)
  const taskHash = hash(item.tasksFile)

  const identities = new ReplyIdentityStore({ file: item.identityFile, log: quiet })
  const tasks = new AutoTaskStore({ file: item.tasksFile, log: quiet })
  identities.load()
  tasks.load()
  const again = migrateLegacyReplyIdentities({
    monitorsFile: item.monitorsFile,
    tasksFile: item.tasksFile,
    stateFile: item.stateFile,
    identities,
    tasks,
    now: '2026-01-02T00:00:00.000Z',
    log: quiet,
  })
  assert.equal(again.identityWritten, false)
  assert.equal(again.tasksBackfilled, 0)
  assert.equal(hash(item.identityFile), identityHash)
  assert.equal(hash(item.tasksFile), taskHash)
})

test('迁移：state.json 损坏必须熔断，不得写出不完整身份或回填任务', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, { version: 2, monitors: [monitor('m1', 't1', ['1'])] })
  writeJson(item.tasksFile, { version: 2, paused: true, tasks: [task('active', 'analyze', 'pending', { postId: '2' })] })
  writeFileSync(item.stateFile, '{"sessions":[broken', 'utf8')
  item.tasks.load()
  const before = hash(item.tasksFile)

  assert.throws(() => run(item), /state\.json 无法解析/)
  assert.equal(existsSync(item.identityFile), false)
  assert.equal(hash(item.tasksFile), before)
  assert.equal(item.tasks.get('active')?.identityKey, undefined)
})

test('迁移：身份写入失败 fail-closed，任务台账不得先被回填', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-debate-migrate-fail-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const blocker = join(root, 'not-a-directory')
  writeFileSync(blocker, 'blocked', 'utf8')
  const monitorsFile = join(root, 'monitors.json')
  const tasksFile = join(root, 'auto-tasks.json')
  const stateFile = join(root, 'state.json')
  const identities = new ReplyIdentityStore({ file: join(blocker, 'reply-identities.json'), log: quiet })
  const tasks = new AutoTaskStore({ file: tasksFile, log: quiet })
  writeJson(monitorsFile, { version: 2, monitors: [monitor('m1', 't1', ['1'])] })
  writeJson(tasksFile, { version: 2, paused: true, tasks: [task('active', 'analyze', 'pending', { postId: '2' })] })
  writeJson(stateFile, { version: 1, sessions: [], dedupe: [] })
  tasks.load()
  const before = hash(tasksFile)

  assert.throws(() => migrateLegacyReplyIdentities({
    monitorsFile, tasksFile, stateFile, identities, tasks, log: quiet,
  }))
  assert.equal(hash(tasksFile), before)
  assert.equal(tasks.get('active')?.identityKey, undefined)
})

test('迁移：身份先写、任务回填失败可抛错，下一次启动只补任务不覆盖身份', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, { version: 2, monitors: [monitor('m1', 't1', ['1', '2'])] })
  writeJson(item.tasksFile, { version: 2, paused: true, tasks: [task('active', 'analyze', 'pending', { postId: '2' })] })
  writeJson(item.stateFile, { version: 1, sessions: [], dedupe: [] })
  item.tasks.load()
  const identityPath = item.identityFile
  class FailingTaskStore extends AutoTaskStore {
    override backfillIdentityKeys(_assignments: ReadonlyMap<string, readonly string[]>, _at?: string): number {
      throw new Error('task ledger write failed')
    }
  }
  const failingTasks = new FailingTaskStore({ file: item.tasksFile, log: quiet })
  failingTasks.load()

  assert.throws(() => migrateLegacyReplyIdentities({
    monitorsFile: item.monitorsFile,
    tasksFile: item.tasksFile,
    stateFile: item.stateFile,
    identities: item.identities,
    tasks: failingTasks,
    log: quiet,
  }), /task ledger write failed/)
  assert.equal(existsSync(identityPath), true, '身份台账必须先持久化')
  assert.equal(item.identities.get('stable:tieba:t1:2')?.state, 'claimed')
  assert.equal(item.identities.migration, undefined, '任务回填失败时不得提前标记完成')

  const identities = new ReplyIdentityStore({ file: identityPath, log: quiet })
  const tasks = new AutoTaskStore({ file: item.tasksFile, log: quiet })
  identities.load()
  tasks.load()
  const repaired = migrateLegacyReplyIdentities({
    monitorsFile: item.monitorsFile,
    tasksFile: item.tasksFile,
    stateFile: item.stateFile,
    identities,
    tasks,
    log: quiet,
  })
  assert.equal(repaired.identityWritten, false)
  assert.equal(repaired.tasksBackfilled, 1)
  assert.equal(tasks.get('active')?.identityKey, 'stable:tieba:t1:2')
  assert.equal(identities.migration?.state, 'complete')
  assert.equal(repaired.completed, true)
})

test('迁移：候选冲突按 task modelCall→published→approved→最新版本决策', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, { version: 2, monitors: [monitor('m1', 't1', [])] })
  writeJson(item.tasksFile, {
    version: 2,
    paused: true,
    tasks: [task('review', 'generate', 'needs_review', {
      postId: '4',
      modelCall: { startedAt: NOW, candidateId: 'c-ref' },
    })],
  })
  writeJson(item.stateFile, {
    version: 1,
    sessions: [{ id: 's1', platform: 'tieba', threadId: 't1', candidates: [
      { replyId: 'c-approved', targetPostId: '2', approved: true, candidateVersion: 1 },
      { replyId: 'c-published', targetPostId: '2', publishedPostId: 'published-2', candidateVersion: 1 },
      { replyId: 'c-old', targetPostId: '3', candidateVersion: 1 },
      { replyId: 'c-new', targetPostId: '3', candidateVersion: 2 },
      { replyId: 'c-ref', targetPostId: '4', candidateVersion: 1 },
      { replyId: 'c-approved-4', targetPostId: '4', approved: true, candidateVersion: 1 },
    ] }],
  })

  run(item)
  assert.equal(item.identities.get('stable:tieba:t1:2')?.candidateId, 'c-published')
  assert.equal(item.identities.get('stable:tieba:t1:3')?.candidateId, 'c-new')
  assert.equal(item.identities.get('stable:tieba:t1:4')?.candidateId, 'c-ref')
})

test('迁移：同版本无证据候选冲突必须熔断，不能按文件顺序任意选择', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, { version: 2, monitors: [monitor('m1', 't1', [])] })
  writeJson(item.tasksFile, { version: 2, paused: true, tasks: [] })
  writeJson(item.stateFile, {
    version: 1,
    sessions: [{ id: 's1', platform: 'tieba', threadId: 't1', candidates: [
      { replyId: 'c-a', targetPostId: '2', candidateVersion: 1 },
      { replyId: 'c-b', targetPostId: '2', candidateVersion: 1 },
    ] }],
  })
  assert.throws(() => run(item), /无法证明优先级/)
  assert.equal(existsSync(item.identityFile), false)
})

test('迁移：多个已批准候选冲突时熔断，不覆盖已完成台账', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, { version: 2, monitors: [monitor('m1', 't1', [])] })
  writeJson(item.tasksFile, { version: 2, paused: true, tasks: [] })
  writeJson(item.stateFile, { version: 1, sessions: [{ id: 's1', platform: 'tieba', threadId: 't1', candidates: [] }] })
  run(item)
  const before = hash(item.identityFile)
  writeJson(item.stateFile, {
    version: 1,
    sessions: [{ id: 's1', platform: 'tieba', threadId: 't1', candidates: [
      { replyId: 'c1', targetPostId: '2', approved: true, candidateVersion: 1 },
      { replyId: 'c2', targetPostId: '2', approved: true, candidateVersion: 1 },
    ] }],
  })

  assert.throws(() => run(item), /无法证明优先级/)
  assert.equal(hash(item.identityFile), before)
})

test('迁移：监控与会话上下文冲突、缺失上下文、非法候选都必须熔断', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, { version: 2, monitors: [monitor('m1', 't1', []), monitor('m2', 't2', [])] })
  writeJson(item.tasksFile, { version: 2, paused: true, tasks: [task('conflict', 'analyze', 'pending', { monitorId: 'm1', sessionId: 's2', postId: '2' })] })
  writeJson(item.stateFile, { version: 1, sessions: [{ id: 's2', platform: 'tieba', threadId: 't2', candidates: [] }] })
  assert.throws(() => run(item), /指向不同帖子/)

  writeJson(item.tasksFile, { version: 2, paused: true, tasks: [task('missing', 'analyze', 'pending', { monitorId: 'gone', postId: '2' })] })
  assert.throws(() => run(item), /找不到监控或核心会话上下文/)

  writeJson(item.tasksFile, { version: 2, paused: true, tasks: [] })
  writeJson(item.stateFile, { version: 1, sessions: [{ id: 's1', platform: 'tieba', threadId: 't1', candidates: [{ targetPostId: '2' }] }] })
  assert.throws(() => run(item), /replyId/)
  assert.equal(existsSync(item.identityFile), false)
})

test('迁移：state 缺失但任务引用会话或 modelCall 候选时必须熔断', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, { version: 2, monitors: [monitor('m1', 't1', [])] })
  writeJson(item.tasksFile, {
    version: 2,
    paused: true,
    tasks: [task('active', 'analyze', 'pending', { sessionId: 's1', postId: '2' })],
  })
  rmSync(item.stateFile, { force: true })
  assert.throws(() => run(item), /state\.json 不存在/)
  assert.equal(existsSync(item.identityFile), false)

  writeJson(item.tasksFile, {
    version: 2,
    paused: true,
    tasks: [task('active', 'generate', 'needs_review', {
      postId: '2',
      modelCall: { startedAt: NOW, candidateId: 'c2' },
    })],
  })
  assert.throws(() => run(item), /state\.json 不存在/)
})

test('迁移：畸形源行与 JSON 解析错误都熔断，且错误消息不回显损坏正文', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, { version: 2, monitors: [null] })
  writeJson(item.tasksFile, { version: 2, paused: true, tasks: [] })
  writeJson(item.stateFile, { version: 1, sessions: [] })
  assert.throws(() => run(item), /monitors\[0\] 不是对象/)

  writeJson(item.monitorsFile, { version: 2, monitors: [] })
  writeFileSync(item.stateFile, '{"sessions":[{"secret":"LEAKED-FRAGMENT"}', 'utf8')
  assert.throws(() => run(item), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /state\.json 无法解析（JSON 语法错误）/)
    assert.equal(error.message.includes('LEAKED-FRAGMENT'), false)
    return true
  })
})

test('迁移：既有身份与重建状态冲突时熔断，不覆盖已有台账', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, { version: 2, monitors: [monitor('m1', 't1', [])] })
  writeJson(item.tasksFile, { version: 2, paused: true, tasks: [] })
  writeJson(item.stateFile, {
    version: 1,
    sessions: [{ id: 's1', platform: 'tieba', threadId: 't1', candidates: [{ replyId: 'c2', targetPostId: '2' }] }],
  })
  run(item)
  const before = hash(item.identityFile)
  writeJson(item.tasksFile, {
    version: 2,
    paused: true,
    tasks: [task('done', 'generate', 'completed', { postId: '2' })],
  })
  writeJson(item.stateFile, { version: 1, sessions: [{ id: 's1', platform: 'tieba', threadId: 't1', candidates: [] }] })
  assert.throws(() => run(item), /既有回复身份与重建结果冲突/)
  assert.equal(hash(item.identityFile), before)
})

test('迁移：完成标记写失败时任务已回填，下一次只补标记不重复回填', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, { version: 2, monitors: [monitor('m1', 't1', ['1'])] })
  writeJson(item.tasksFile, { version: 2, paused: true, tasks: [task('active', 'analyze', 'pending', { postId: '2' })] })
  writeJson(item.stateFile, { version: 1, sessions: [], dedupe: [] })
  item.tasks.load()
  class FailingCompleteStore extends ReplyIdentityStore {
    override completeMigration(): void {
      throw new Error('migration marker write failed')
    }
  }
  const identities = new FailingCompleteStore({ file: item.identityFile, log: quiet })
  identities.load()

  assert.throws(() => migrateLegacyReplyIdentities({
    monitorsFile: item.monitorsFile,
    tasksFile: item.tasksFile,
    stateFile: item.stateFile,
    identities,
    tasks: item.tasks,
  }), /migration marker write failed/)
  assert.equal(item.tasks.get('active')?.identityKey, 'stable:tieba:t1:2')
  assert.equal(identities.migration, undefined)
  const taskHash = hash(item.tasksFile)

  const repairedIdentities = new ReplyIdentityStore({ file: item.identityFile, log: quiet })
  const repairedTasks = new AutoTaskStore({ file: item.tasksFile, log: quiet })
  repairedIdentities.load()
  repairedTasks.load()
  const repaired = migrateLegacyReplyIdentities({
    monitorsFile: item.monitorsFile,
    tasksFile: item.tasksFile,
    stateFile: item.stateFile,
    identities: repairedIdentities,
    tasks: repairedTasks,
  })
  assert.equal(repaired.tasksBackfilled, 0)
  assert.equal(hash(item.tasksFile), taskHash)
  assert.equal(repairedIdentities.migration?.state, 'complete')
})

test('迁移：合法的 probe/compensate 类型可完成迁移，但不产生回复身份', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, { version: 2, monitors: [monitor('m1', 't1', [])] })
  writeJson(item.tasksFile, {
    version: 2,
    paused: true,
    tasks: [
      task('probe', 'probe', 'pending'),
      task('compensate', 'compensate', 'pending'),
    ],
  })
  writeJson(item.stateFile, { version: 1, sessions: [], dedupe: [] })

  const result = run(item)
  assert.equal(result.completed, true)
  assert.equal(result.identities, 0)
  assert.equal(result.tasksBackfilled, 0)
  assert.equal(item.identities.migration?.state, 'complete')
})

test('迁移：未知任务 kind 熔断，错误脱敏且不写身份或完成标记', (t) => {
  const item = fixture(t)
  const secretKind = 'future-kind-LEAKED-SECRET'
  writeJson(item.monitorsFile, { version: 2, monitors: [monitor('m1', 't1', ['1'])] })
  writeJson(item.tasksFile, {
    version: 2,
    paused: true,
    tasks: [task('unknown', secretKind, 'pending', { postId: '2' })],
  })
  writeJson(item.stateFile, { version: 1, sessions: [], dedupe: [] })
  item.tasks.load()
  const taskHash = hash(item.tasksFile)

  assert.throws(() => run(item), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /auto-tasks\.json\.tasks\[0\]\.kind 不是受支持的任务类型/)
    assert.equal(error.message.includes(secretKind), false)
    return true
  })
  assert.equal(existsSync(item.identityFile), false)
  assert.equal(item.identities.migration, undefined)
  assert.equal(hash(item.tasksFile), taskHash)
  assert.equal(item.tasks.get('unknown')?.identityKey, undefined)
})

test('迁移：同源完成标记快路径也严格校验任务 kind，不能认证未知类型', (t) => {
  const item = fixture(t)
  const secretKind = 'marker-bypass-LEAKED-SECRET'
  writeJson(item.monitorsFile, { version: 2, monitors: [] })
  writeJson(item.tasksFile, {
    version: 2,
    paused: true,
    tasks: [task('unknown', secretKind, 'pending')],
  })
  writeJson(item.stateFile, { version: 1, sessions: [], dedupe: [] })
  item.identities.completeMigration({
    state: 'complete',
    completedAt: NOW,
    sources: {
      state: hash(item.stateFile),
      monitors: hash(item.monitorsFile),
      tasks: hash(item.tasksFile),
    },
  })
  const identityHash = hash(item.identityFile)
  const taskHash = hash(item.tasksFile)

  assert.throws(() => run(item), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /不是受支持的任务类型/)
    assert.equal(error.message.includes(secretKind), false)
    return true
  })
  assert.equal(hash(item.identityFile), identityHash)
  assert.equal(hash(item.tasksFile), taskHash)
})

test('迁移：完成标记让同源重启无写入，源变化只做安全增量', (t) => {
  const item = fixture(t)
  writeJson(item.monitorsFile, { version: 2, monitors: [monitor('m1', 't1', ['1'])] })
  writeJson(item.tasksFile, { version: 2, paused: true, tasks: [] })
  writeJson(item.stateFile, {
    version: 1,
    sessions: [{ id: 's1', platform: 'tieba', threadId: 't1', candidates: [{ replyId: 'c2', targetPostId: '2' }] }],
  })
  const first = run(item)
  assert.equal(first.completed, true)
  assert.equal(item.identities.migration?.state, 'complete')
  const identityHash = hash(item.identityFile)

  const identities = new ReplyIdentityStore({ file: item.identityFile, log: quiet })
  const tasks = new AutoTaskStore({ file: item.tasksFile, log: quiet })
  identities.load()
  tasks.load()
  const again = migrateLegacyReplyIdentities({
    monitorsFile: item.monitorsFile,
    tasksFile: item.tasksFile,
    stateFile: item.stateFile,
    identities,
    tasks,
    now: '2026-01-02T00:00:00.000Z',
  })
  assert.equal(again.alreadyComplete, true)
  assert.equal(hash(item.identityFile), identityHash)

  writeJson(item.stateFile, {
    version: 1,
    sessions: [{ id: 's1', platform: 'tieba', threadId: 't1', candidates: [
      { replyId: 'c2', targetPostId: '2' },
      { replyId: 'c4', targetPostId: '4' },
    ] }],
  })
  const incremental = migrateLegacyReplyIdentities({
    monitorsFile: item.monitorsFile,
    tasksFile: item.tasksFile,
    stateFile: item.stateFile,
    identities,
    tasks,
    now: '2026-01-03T00:00:00.000Z',
  })
  assert.equal(incremental.alreadyComplete, false)
  assert.equal(incremental.identityWritten, false)
  assert.equal(incremental.identitiesAdded, 1)
  assert.equal(identities.get('stable:tieba:t1:1')?.state, 'ignored', '旧证据不得被增量覆盖')
  assert.equal(identities.get('stable:tieba:t1:4')?.state, 'candidate')
  assert.equal(identities.migration?.state, 'complete')
})
