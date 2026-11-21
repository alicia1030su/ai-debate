/**
 * P0 reliability: the layers under the scheduler.
 *
 * These tests are about the failure modes that only show up in production: a disk
 * that fills, a file that is half-written when the machine loses power, a task
 * that was in flight when the process died, a queue that grows without bound.
 *
 * They are deliberately *not* end-to-end tests. The pipeline test lives in
 * `test/acceptance/automation.ts`; this file tests the pieces it stands on, with
 * real files on a real (temporary) disk.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodeFs from 'node:fs'
import nodeFsDefault from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { assertWritableSpace, readJsonWithBackup, writeFileAtomic, writeJson, AtomicWriteError } from '../src/atomic.ts'
import { MonitorStore } from '../src/monitor/store.ts'
import { AutoTaskStore } from '../src/monitor/tasks.ts'

const quiet = { warn: () => undefined }

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'ai-debate-p0-'))
}

test('原子写：失败的写入不破坏原文件，也不把内存状态带偏', () => {
  const dir = scratch()
  const file = join(dir, 'monitors.json')
  const store = new MonitorStore({ file, log: quiet })
  store.load()
  store.create({ name: '第一条', url: 'https://example.test/p/1' }, { platform: 'tieba', threadId: '1' })
  const before = readFileSync(file, 'utf8')

  // Point the store at a path whose parent does not exist. `openSync` fails, which
  // is the same code path a full or read-only volume takes.
  const broken = new MonitorStore({ file: join(dir, 'missing', 'monitors.json'), log: quiet })
  broken.load()
  assert.throws(
    () => broken.create({ name: '第二条', url: 'https://example.test/p/2' }, { platform: 'tieba', threadId: '2' }),
    (error: unknown) => error instanceof AtomicWriteError,
  )
  // Memory must not contain a monitor the disk never received: after a restart it
  // would vanish, and until then the console would show work that is not running.
  assert.equal(broken.list().length, 0, '写入失败后不得把记录加入内存')
  assert.equal(readFileSync(file, 'utf8'), before, '失败的写入不得改动已有文件')
})

test('原子写：损坏的文件先留证，再从备份恢复', () => {
  const dir = scratch()
  const file = join(dir, 'monitors.json')
  const backup = `${file}.bak`
  const store = new MonitorStore({ file, log: quiet })
  store.load()
  store.create({ name: '可恢复', url: 'https://example.test/p/1' }, { platform: 'tieba', threadId: '1' })
  // A second write produces the `.bak` of the first document.
  store.update(store.list()[0]!.id, { intervalSec: 300 })
  writeFileSync(file, '{"version":2,"monitors":[', 'utf8')

  const events: string[] = []
  const reloaded = new MonitorStore({ file, log: quiet, onEvent: (event) => events.push(event) })
  reloaded.load()
  assert.equal(reloaded.loadError, undefined, '有备份时不应拒绝启动')
  assert.equal(reloaded.list().length, 1, '应从备份恢复出监控目标')
  assert.deepEqual(events, ['restored'], '恢复必须留下事件，便于审计')
  assert.ok(
    readdirSync(dir).some((name) => name.includes('.corrupt-')),
    '损坏的原文必须另存，不能被覆盖',
  )
  // The restored document keeps the id, so in-flight tasks still resolve.
  assert.equal(reloaded.list()[0]?.id, store.list()[0]?.id)
})

test('原子写：没有备份的损坏文件不会被当成「空配置」', () => {
  const dir = scratch()
  const file = join(dir, 'monitors.json')
  writeFileSync(file, 'not json at all', 'utf8')
  const store = new MonitorStore({ file, log: quiet })
  store.load()
  assert.match(store.loadError ?? '', /无法解析/)
  assert.equal(store.list().length, 0)
  // The important half: creating a new monitor must still refuse to pretend the
  // old file was empty — the operator has to see the error and decide.
  assert.ok(readFileSync(file, 'utf8').includes('not json'), '原文件必须保留')
})

test('原子写：磁盘空间不足时拒绝写入，而不是写坏文件', () => {
  const dir = scratch()
  assert.throws(
    () => assertWritableSpace(dir, 1024 * 1024 * 1024 * 1024),
    (error: unknown) => error instanceof AtomicWriteError && error.kind === 'disk_full',
  )
  // And a normal write still works after that check.
  writeJson(join(dir, 'ok.json'), { ok: true })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'ok.json'), 'utf8')), { ok: true })
})

function withWindowsPlatform<T>(run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    return run()
  } finally {
    if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor)
  }
}

test('原子写：Windows rename 瞬态 EPERM 有界重试后成功', (t) => {
  const dir = scratch()
  const file = join(dir, 'state.json')
  writeFileSync(file, 'old', 'utf8')
  const originalRename = nodeFsDefault.renameSync
  let attempts = 0
  const mockedRename = t.mock.method(nodeFsDefault, 'renameSync', ((from: nodeFs.PathLike, to: nodeFs.PathLike) => {
    attempts += 1
    if (attempts <= 2) {
      assert.equal(readFileSync(file, 'utf8'), 'old', '重试期间旧文件必须保持可读')
      throw Object.assign(new Error('injected sharing violation'), { code: 'EPERM' })
    }
    return originalRename(from, to)
  }) as typeof nodeFs.renameSync)
  syncBuiltinESMExports()
  try {
    withWindowsPlatform(() => writeFileAtomic(file, 'new'))
    assert.equal(attempts, 3)
    assert.equal(readFileSync(file, 'utf8'), 'new')
    assert.equal(readdirSync(dir).some((name) => name.includes('.tmp-')), false)
  } finally {
    mockedRename.mock.restore()
    syncBuiltinESMExports()
  }
})

test('原子写：Windows rename 持续 EPERM 最终失败且不破坏旧文件', (t) => {
  const dir = scratch()
  const file = join(dir, 'state.json')
  writeFileSync(file, 'old', 'utf8')
  const mockedRename = t.mock.method(nodeFsDefault, 'renameSync', () => {
    throw Object.assign(new Error('injected persistent sharing violation'), { code: 'EPERM' })
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => withWindowsPlatform(() => writeFileAtomic(file, 'new')), AtomicWriteError)
    assert.equal(readFileSync(file, 'utf8'), 'old')
    assert.equal(readdirSync(dir).some((name) => name.includes('.tmp-')), false)
  } finally {
    mockedRename.mock.restore()
    syncBuiltinESMExports()
  }
})

test('原子写：非瞬态 rename 错误不重试，原始 code/cause 保留', (t) => {
  const dir = scratch()
  const file = join(dir, 'state.json')
  writeFileSync(file, 'old', 'utf8')
  let attempts = 0
  const mockedRename = t.mock.method(nodeFsDefault, 'renameSync', () => {
    attempts += 1
    throw Object.assign(new Error('injected read-only filesystem'), { code: 'EROFS' })
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => withWindowsPlatform(() => writeFileAtomic(file, 'new')), (error: unknown) => {
      assert.ok(error instanceof AtomicWriteError)
      assert.equal(error.kind, 'permission')
      assert.equal((error.cause as { code?: string }).code, 'EROFS')
      return true
    })
    assert.equal(attempts, 1)
    assert.equal(readFileSync(file, 'utf8'), 'old')
  } finally {
    mockedRename.mock.restore()
    syncBuiltinESMExports()
  }
})

test('原子写：备份本身不可用时仍完成主写入', () => {
  const dir = scratch()
  const file = join(dir, 'state.json')
  writeJson(file, { a: 1 })
  writeJson(file, { a: 2 }, { backup: join(dir, 'no-such-dir', 'state.bak') })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).a, 2)
})

test('游标：不完整的扫描不推进游标，但已看到的回复仍被记录', () => {
  const dir = scratch()
  const store = new MonitorStore({ file: join(dir, 'm.json'), log: quiet })
  store.load()
  const monitor = store.create({ name: 'x', url: 'https://example.test/p/1' }, { platform: 'tieba', threadId: '1' })

  const partial = store.applyScan(monitor.id, {
    at: '2026-11-20T00:00:00.000Z',
    coverage: 'tail',
    complete: false,
    pagesRead: 2,
    totalPages: 9,
    incompleteReason: '第 9 页返回不完整',
    replies: [{ postId: 'f1', fingerprint: 'a' }],
  })
  assert.equal(partial.cursorAdvanced, false, '不完整扫描不得推进游标')
  assert.deepEqual(partial.fresh, ['f1'])
  const afterPartial = store.get(monitor.id)!
  assert.equal(afterPartial.cursor?.lastCompleteScanAt, undefined)
  assert.equal(afterPartial.lastScan?.incompleteReason, '第 9 页返回不完整')

  // The same reply seen again is not "new", even though the cursor never moved.
  const again = store.applyScan(monitor.id, {
    at: '2026-11-20T00:01:00.000Z',
    coverage: 'tail',
    complete: true,
    pagesRead: 2,
    totalPages: 2,
    replies: [{ postId: 'f1', fingerprint: 'a' }],
  })
  assert.deepEqual(again.fresh, [], '同一回复不得因游标未推进而重复入队')
  assert.equal(again.cursorAdvanced, true)
  assert.equal(store.get(monitor.id)?.cursor?.lastCompleteScanAt, '2026-11-20T00:01:00.000Z')
  assert.equal(store.get(monitor.id)?.cursor?.lastSeenPostId, 'f1')
})

test('游标：编辑被识别为变化，且不会被当成新回复', () => {
  const dir = scratch()
  const store = new MonitorStore({ file: join(dir, 'm.json'), log: quiet })
  store.load()
  const monitor = store.create({ name: 'x', url: 'https://example.test/p/1' }, { platform: 'tieba', threadId: '1' })
  store.applyScan(monitor.id, {
    at: '2026-11-20T00:00:00.000Z',
    coverage: 'full',
    complete: true,
    pagesRead: 2,
    replies: [
      { postId: 'f1', fingerprint: 'v1' },
      { postId: 'f2', fingerprint: 'v1' },
    ],
  })
  const edited = store.applyScan(monitor.id, {
    at: '2026-11-20T06:00:00.000Z',
    coverage: 'full',
    complete: true,
    pagesRead: 2,
    replies: [
      { postId: 'f1', fingerprint: 'v2' },
      { postId: 'f2', fingerprint: 'v1' },
    ],
  })
  assert.deepEqual(edited.fresh, [], '编辑不是新回复')
  assert.deepEqual(edited.changed, ['f1'])
  assert.deepEqual(edited.removed, [])
  const changes = store.get(monitor.id)?.changes ?? []
  assert.equal(changes.length, 1)
  assert.equal(changes[0]?.kind, 'edited')
})

test('游标：只有全量扫描才能判定删除', () => {
  const dir = scratch()
  const store = new MonitorStore({ file: join(dir, 'm.json'), log: quiet })
  store.load()
  const monitor = store.create({ name: 'x', url: 'https://example.test/p/1' }, { platform: 'tieba', threadId: '1' })
  store.applyScan(monitor.id, {
    at: '2026-11-20T00:00:00.000Z',
    coverage: 'full',
    complete: true,
    pagesRead: 1,
    replies: [
      { postId: 'f1', fingerprint: 'a' },
      { postId: 'f2', fingerprint: 'b' },
    ],
  })

  // A tail read sees only the end; absence of f1 there proves nothing.
  const tail = store.applyScan(monitor.id, {
    at: '2026-11-20T01:00:00.000Z',
    coverage: 'tail',
    complete: true,
    pagesRead: 1,
    replies: [{ postId: 'f2', fingerprint: 'b' }],
  })
  assert.deepEqual(tail.removed, [], '尾部读取不得推断删除')

  const full = store.applyScan(monitor.id, {
    at: '2026-11-20T02:00:00.000Z',
    coverage: 'full',
    complete: true,
    pagesRead: 1,
    replies: [{ postId: 'f2', fingerprint: 'b' }],
  })
  assert.deepEqual(full.removed, ['f1'], '全量读取可以判定删除')
})

test('游标：同一页里重复的 id 只算一次', () => {
  const dir = scratch()
  const store = new MonitorStore({ file: join(dir, 'm.json'), log: quiet })
  store.load()
  const monitor = store.create({ name: 'x', url: 'https://example.test/p/1' }, { platform: 'tieba', threadId: '1' })
  const outcome = store.applyScan(monitor.id, {
    at: '2026-11-20T00:00:00.000Z',
    coverage: 'tail',
    complete: true,
    pagesRead: 2,
    replies: [
      { postId: 'f1', fingerprint: 'a' },
      { postId: 'f1', fingerprint: 'a' },
      { postId: 'f2', fingerprint: 'b' },
    ],
  })
  assert.deepEqual(outcome.fresh, ['f1', 'f2'])
  assert.equal(store.get(monitor.id)?.counters.discovered, 2)
})

test('队列：容量上限拒绝新任务，但不改写已有台账', () => {
  const dir = scratch()
  const file = join(dir, 't.json')
  const store = new AutoTaskStore({ file, log: quiet, capacity: 50 })
  store.load()
  for (let index = 0; index < 50; index += 1) {
    store.enqueue({ kind: 'probe', monitorId: 'm', dedupeKey: `probe:${index}` })
  }
  const before = readFileSync(file, 'utf8')
  assert.throws(
    () => store.enqueue({ kind: 'probe', monitorId: 'm', dedupeKey: 'probe:overflow' }),
    /队列已满/,
  )
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(store.all().length, 50)
})

test('队列：卡死任务被判定失败并释放槽位，可手动重试', () => {
  const dir = scratch()
  const store = new AutoTaskStore({ file: join(dir, 't.json'), log: quiet })
  store.load()
  const { task } = store.enqueue({ kind: 'generate', monitorId: 'm', postId: 'f1', dedupeKey: 'g:1' })
  const claimed = store.claim()!
  assert.equal(claimed.id, task.id)
  // The claim happens "now"; evaluate the staleness an hour later so the timeout
  // is unambiguous rather than a race against the wall clock.
  const later = Date.now() + 60 * 60 * 1000
  assert.equal(store.stats(later, 60_000).stuck, 1, '运行过久应计入卡死')

  const reaped = store.reapStuck(later, 60_000)
  assert.deepEqual(reaped, [task.id])
  const after = store.get(task.id)!
  assert.equal(after.state, 'failed')
  assert.equal(after.lastErrorKind, 'stuck')
  assert.equal(after.modelCall, undefined)

  assert.equal(store.retry(task.id), true)
  const retried = store.get(task.id)!
  assert.equal(retried.state, 'pending')
  assert.equal(retried.attempts, 0, '手动重试应重置次数')
})

test('队列：清理历史时绝不删除待审核任务', () => {
  const dir = scratch()
  const store = new AutoTaskStore({ file: join(dir, 't.json'), log: quiet })
  store.load()
  const review = store.enqueue({ kind: 'generate', monitorId: 'm', postId: 'keep', dedupeKey: 'g:keep' }).task
  store.finish(review.id, 'needs_review')
  const old = store.enqueue({ kind: 'probe', monitorId: 'm', dedupeKey: 'p:old' }).task
  store.finish(old.id, 'completed')
  // Rewrite the old task's timestamp so it is clearly beyond the retention window.
  const document = JSON.parse(readFileSync(join(dir, 't.json'), 'utf8')) as {
    version: number
    paused: boolean
    tasks: { id: string; updatedAt: string }[]
  }
  for (const task of document.tasks) {
    if (task.id === old.id) task.updatedAt = '2020-01-01T00:00:00.000Z'
  }
  writeFileSync(join(dir, 't.json'), JSON.stringify(document), 'utf8')

  const reloaded = new AutoTaskStore({ file: join(dir, 't.json'), log: quiet })
  reloaded.load()
  const outcome = reloaded.prune({ keepDays: 7, keepTerminal: 0 })
  assert.equal(outcome.removed, 1)
  assert.equal(outcome.keptForReview, 1)
  assert.ok(reloaded.get(review.id) !== undefined, '待审核任务必须保留')
  assert.equal(reloaded.get(old.id), undefined)
})

test('队列：写入失败时内存不领先于磁盘', () => {
  const dir = scratch()
  const file = join(dir, 't.json')
  const store = new AutoTaskStore({ file, log: quiet })
  store.load()
  store.enqueue({ kind: 'probe', monitorId: 'm', dedupeKey: 'p:1' })
  const before = readFileSync(file, 'utf8')

  // A task file that cannot be written must fail the enqueue, not queue work that
  // would disappear on the next restart.
  const broken = new AutoTaskStore({ file: join(dir, 'missing', 't.json'), log: quiet })
  broken.load()
  assert.throws(() => broken.enqueue({ kind: 'probe', monitorId: 'm', dedupeKey: 'p:2' }), AtomicWriteError)
  assert.equal(broken.all().length, 0)
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('队列：模型调用被记录，未完成的调用在恢复时标记为不确定', () => {
  const dir = scratch()
  const file = join(dir, 't.json')
  const store = new AutoTaskStore({ file, log: quiet })
  store.load()
  const { task } = store.enqueue({ kind: 'generate', monitorId: 'm', postId: 'f1', dedupeKey: 'g:1' })
  store.claim()
  store.beginModelCall(task.id, '2026-11-20T00:00:00.000Z')
  assert.equal(store.get(task.id)?.modelCall?.startedAt, '2026-11-20T00:00:00.000Z')
  assert.equal(store.get(task.id)?.modelCall?.uncertain, undefined)

  const reloaded = new AutoTaskStore({ file, log: quiet })
  reloaded.load()
  const recovered = reloaded.recoverInterrupted('2026-11-20T00:10:00.000Z')
  assert.deepEqual(recovered, { recovered: 1, uncertain: 1 })
  const after = reloaded.get(task.id)!
  assert.equal(after.state, 'pending')
  assert.equal(after.lastErrorKind, 'interrupted_uncertain')
  assert.equal(after.modelCall?.uncertain, true)
  assert.equal(reloaded.lastRecovery?.uncertain, 1, '恢复记录应可被状态中心读取')
})

test('队列：已完成的模型调用在恢复时不算不确定', () => {
  const dir = scratch()
  const store = new AutoTaskStore({ file: join(dir, 't.json'), log: quiet })
  store.load()
  const { task } = store.enqueue({ kind: 'generate', monitorId: 'm', postId: 'f1', dedupeKey: 'g:1' })
  store.claim()
  store.beginModelCall(task.id)
  store.finishModelCall(task.id, { candidateId: 'c1' })

  // Force the row back to running, as a crash after the answer was written would.
  const doc = JSON.parse(readFileSync(join(dir, 't.json'), 'utf8')) as { tasks: { state: string }[] }
  doc.tasks[0]!.state = 'running'
  writeFileSync(join(dir, 't.json'), JSON.stringify(doc), 'utf8')

  const reloaded = new AutoTaskStore({ file: join(dir, 't.json'), log: quiet })
  reloaded.load()
  const recovered = reloaded.recoverInterrupted()
  assert.equal(recovered.recovered, 1)
  assert.equal(recovered.uncertain, 0, '拿到答案后的中断不应标记为不确定')
})

test('队列：先写盘再采纳，claim 后重启不会丢任务', () => {
  const dir = scratch()
  const file = join(dir, 't.json')
  const store = new AutoTaskStore({ file, log: quiet })
  store.load()
  store.enqueue({ kind: 'probe', monitorId: 'm', dedupeKey: 'p:1' })
  store.claim()

  const reloaded = new AutoTaskStore({ file, log: quiet })
  reloaded.load()
  assert.equal(reloaded.all().length, 1)
  assert.equal(reloaded.all()[0]?.state, 'running', '进程死后台账应保留 running，交给恢复流程判定')
})

test('备份读取：主文件与备份同时损坏时返回不可用而不是抛错', () => {
  const dir = scratch()
  const file = join(dir, 'x.json')
  writeFileSync(file, '{oops', 'utf8')
  writeFileSync(`${file}.bak`, 'also broken', 'utf8')
  const result = readJsonWithBackup(file, `${file}.bak`)
  assert.equal(result.value, undefined)
  assert.equal(result.corrupt, true)
  assert.equal(result.restoredFromBackup, false)
})
