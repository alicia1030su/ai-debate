/** Global reply identity and durable task lease tests. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReplyIdentityStore, replyIdentityKey, type ReplyIdentity } from '../src/monitor/identities.ts'
import { AutoTaskStore } from '../src/monitor/tasks.ts'

const quiet = { warn: () => undefined }
const NOW = '2026-01-01T00:00:00.000Z'
function scratch(): string { return mkdtempSync(join(tmpdir(), 'ai-debate-identity-')) }

function identityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'stable:tieba:t1:p1',
    platform: 'tieba',
    threadId: 't1',
    postId: 'p1',
    quality: 'stable',
    fingerprint: 'fp1',
    monitorId: 'm1',
    state: 'claimed',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function writeIdentityDocument(file: string, document: unknown): string {
  const contents = `${JSON.stringify(document, null, 2)}\n`
  writeFileSync(file, contents, 'utf8')
  return contents
}

test('全局身份：稳定 ID 与内容回退使用不同命名空间', () => {
  const stable = replyIdentityKey({ platform: 'tieba', threadId: 't1', postId: 'p1', quality: 'stable', fingerprint: 'x' })
  const fallback = replyIdentityKey({ platform: 'tieba', threadId: 't1', postId: 'p1', quality: 'fallback', fingerprint: 'x' })
  assert.equal(stable, 'stable:tieba:t1:p1')
  assert.equal(fallback, 'fallback:tieba:t1:x')
  assert.notEqual(stable, fallback)
  assert.throws(() => replyIdentityKey({ platform: '', threadId: 't', postId: 'p', quality: 'stable', fingerprint: '' }))
  assert.throws(() => replyIdentityKey({ platform: 'tieba', threadId: 't', postId: '', quality: 'stable', fingerprint: '' }))
})

test('全局身份：第二个监控与重启后都不能重新认领同一条回复', () => {
  const dir = scratch()
  const file = join(dir, 'identities.json')
  const first = new ReplyIdentityStore({ file, log: quiet })
  first.load()
  const input = { platform: 'tieba', threadId: 't1', postId: 'p1', quality: 'stable' as const, fingerprint: 'a', monitorId: 'm1' }
  const one = first.claim(input)
  const two = first.claim({ ...input, monitorId: 'm2' })
  assert.equal(one.fresh, true)
  assert.equal(two.fresh, false)
  assert.equal(two.identity.key, one.identity.key)
  assert.equal(two.identity.monitorId, 'm1')

  const reloaded = new ReplyIdentityStore({ file, log: quiet })
  reloaded.load()
  const three = reloaded.claim({ ...input, monitorId: 'm3' })
  assert.equal(three.fresh, false)
  assert.equal(reloaded.all().length, 1)
})

test('全局身份：候选与忽略状态跨重启保留，orphan 只返回无活跃任务的 claim', () => {
  const dir = scratch()
  const file = join(dir, 'identities.json')
  const store = new ReplyIdentityStore({ file, log: quiet })
  store.load()
  const base = { platform: 'tieba', threadId: 't1', quality: 'stable' as const, fingerprint: 'a', monitorId: 'm1' }
  const claimed = store.claim({ ...base, postId: 'p1' }).identity
  store.claim({ ...base, postId: 'p2' })
  store.claim({ ...base, postId: 'p3' })
  store.markCandidate(store.claim({ ...base, postId: 'p2' }).identity.key, { candidateId: 'c2', sessionId: 's2' })
  store.markIgnored(store.claim({ ...base, postId: 'p3' }).identity.key, 'safety')
  assert.deepEqual(store.orphans(new Set([claimed.key])).map((entry) => entry.postId), [])
  assert.equal(store.stats().candidate, 1)
  assert.equal(store.stats().ignored, 1)

  const reloaded = new ReplyIdentityStore({ file, log: quiet })
  reloaded.load()
  assert.equal(reloaded.get(claimed.key)?.state, 'claimed')
  assert.equal(reloaded.stats().candidate, 1)
  assert.equal(reloaded.stats().ignored, 1)
})

test('全局身份：损坏文件从备份恢复并留下事件', () => {
  const dir = scratch()
  const file = join(dir, 'identities.json')
  const store = new ReplyIdentityStore({ file, log: quiet })
  store.load()
  store.claim({ platform: 'tieba', threadId: 't1', postId: 'p1', quality: 'stable', fingerprint: 'a', monitorId: 'm1' })
  store.claim({ platform: 'tieba', threadId: 't1', postId: 'p2', quality: 'stable', fingerprint: 'b', monitorId: 'm1' })
  writeFileSync(file, '{broken', 'utf8')
  const events: string[] = []
  const reloaded = new ReplyIdentityStore({ file, log: quiet, onEvent: (event) => events.push(event) })
  reloaded.load()
  assert.equal(reloaded.loadError, undefined)
  assert.equal(reloaded.restoredFromBackup, true)
  assert.equal(reloaded.all().length, 1)
  assert.deepEqual(events, ['restored'])
})

test('全局身份：迁移完成标记跨重启保留，运行时 claim 不清除标记', () => {
  const dir = scratch()
  const file = join(dir, 'identities.json')
  const store = new ReplyIdentityStore({ file, log: quiet })
  store.load()
  store.completeMigration({
    state: 'complete',
    completedAt: '2026-01-01T00:00:00.000Z',
    sources: { state: null, monitors: null, tasks: null },
  })
  store.claim({ platform: 'tieba', threadId: 't1', postId: 'p1', quality: 'stable', fingerprint: 'a', monitorId: 'm1' })

  const reloaded = new ReplyIdentityStore({ file, log: quiet })
  reloaded.load()
  assert.equal(reloaded.loadError, undefined)
  assert.equal(reloaded.migration?.state, 'complete')
  assert.equal(reloaded.all().length, 1)
})

test('全局身份：非法迁移完成标记视为损坏，不以未知迁移状态启动', () => {
  const dir = scratch()
  const file = join(dir, 'identities.json')
  writeFileSync(file, JSON.stringify({
    version: 1,
    entries: [],
    migration: { state: 'pending', completedAt: 'not-a-date', sources: {} },
  }), 'utf8')
  const store = new ReplyIdentityStore({ file, log: quiet })
  store.load()
  assert.match(store.loadError ?? '', /无法解析或结构不认识/)
})

test('全局身份：严格文档校验接受稳定与无稳定 ID 的回退身份', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'identities.json')
  const store = new ReplyIdentityStore({ file, log: quiet })
  store.load()
  store.claim({ platform: 'tieba', threadId: 't1', postId: 'p1', quality: 'stable', fingerprint: 'fp1', monitorId: 'm1' })
  store.claim({ platform: 'tieba', threadId: 't1', postId: '', quality: 'fallback', fingerprint: 'content-hash', monitorId: 'm1' })

  const reloaded = new ReplyIdentityStore({ file, log: quiet })
  reloaded.load()
  assert.equal(reloaded.loadError, undefined)
  assert.equal(reloaded.stats().total, 2)
  assert.equal(reloaded.stats().fallback, 1)
  assert.equal(reloaded.get('fallback:tieba:t1:content-hash')?.postId, '')
})

test('全局身份：文档版本、派生键与可选字符串不一致时拒绝加载且保留原文件', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const invalidDocuments: ReadonlyArray<readonly [string, unknown]> = [
    ['缺少版本', { entries: [identityRow()] }],
    ['未知版本', { version: 2, entries: [identityRow()] }],
    ['顶层不是对象', null],
    ['顶层是数组', []],
    ['平台与键不一致', { version: 1, entries: [identityRow({ key: 'stable:other:t1:p1' })] }],
    ['帖子与键不一致', { version: 1, entries: [identityRow({ key: 'stable:tieba:t1:p2' })] }],
    ['质量与键不一致', { version: 1, entries: [identityRow({ quality: 'fallback' })] }],
    ['回退指纹与键不一致', { version: 1, entries: [identityRow({
      key: 'fallback:tieba:t1:other', quality: 'fallback', postId: '',
    })] }],
    ['稳定身份缺少回复 ID', { version: 1, entries: [identityRow({ postId: '', key: 'stable:tieba:t1:' })] }],
    ['平台含首尾空白', { version: 1, entries: [identityRow({ platform: ' tieba' })] }],
    ['监控 ID 是数字', { version: 1, entries: [identityRow({ monitorId: 7 })] }],
    ['会话 ID 是空白', { version: 1, entries: [identityRow({ sessionId: ' ' })] }],
    ['候选 ID 含首尾空白', { version: 1, entries: [identityRow({ state: 'candidate', candidateId: ' c1 ' })] }],
    ['候选状态缺少候选 ID', { version: 1, entries: [identityRow({ state: 'candidate' })] }],
    ['忽略状态缺少原因', { version: 1, entries: [identityRow({ state: 'ignored' })] }],
    ['忽略原因是对象', { version: 1, entries: [identityRow({ state: 'ignored', lastError: { reason: 'forged' } })] }],
    ['占用状态的原因是数字', { version: 1, entries: [identityRow({ lastError: 7 })] }],
    ['重复派生键', { version: 1, entries: [identityRow(), identityRow()] }],
  ]

  for (const [index, [name, document]] of invalidDocuments.entries()) {
    const file = join(dir, `invalid-${index}.json`)
    const before = writeIdentityDocument(file, document)
    const store = new ReplyIdentityStore({ file, log: quiet })
    store.load()
    assert.match(store.loadError ?? '', /无法解析或结构不认识/, name)
    assert.deepEqual(store.all(), [], name)
    assert.equal(store.get('stable:tieba:t1:p1'), undefined, name)
    assert.equal(readFileSync(file, 'utf8'), before, `${name} 不得改写原文件`)
  }
})

test('全局身份：核心不可读时伪造 candidateId 也必须在加载阶段拒绝', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const forgedIds: readonly unknown[] = [42, { replyId: 'forged' }, null, '']
  for (const [index, candidateId] of forgedIds.entries()) {
    for (const [stateIndex, state] of ['candidate', 'claimed'].entries()) {
      const file = join(dir, `forged-${index}-${stateIndex}.json`)
      const before = writeIdentityDocument(file, {
        version: 1,
        entries: [identityRow({ state, candidateId, sessionId: 'forged-session' })],
      })
      const store = new ReplyIdentityStore({ file, log: quiet })
      store.load()
      assert.match(store.loadError ?? '', /无法解析或结构不认识/)
      assert.deepEqual(store.all(), [], '非法候选证据不得进入 engine 可读索引')
      assert.equal(store.get('stable:tieba:t1:p1'), undefined)
      assert.equal(readFileSync(file, 'utf8'), before)
    }
  }
})

test('全局身份：非法运行时写入与迁移写入均拒绝，不能覆盖合法台账', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'identities.json')
  const store = new ReplyIdentityStore({ file, log: quiet })
  store.load()
  const input = { platform: 'tieba', threadId: 't1', postId: 'p1', quality: 'stable' as const, fingerprint: 'fp1', monitorId: 'm1' }
  const key = store.claim(input).identity.key
  const before = readFileSync(file, 'utf8')
  const invalidWrites: ReadonlyArray<readonly [string, () => void]> = [
    ['claim 监控 ID', () => store.claim({ ...input, postId: 'p2', monitorId: 7 as unknown as string })],
    ['claim 时间', () => store.claim({ ...input, postId: 'p2' }, 'not-a-date')],
    ['attachSession', () => store.attachSession(key, 7 as unknown as string)],
    ['候选 ID 是对象', () => store.markCandidate(key, { candidateId: {} as unknown as string })],
    ['候选 ID 为空', () => store.markCandidate(key, { candidateId: '' })],
    ['候选缺少 ID', () => store.markCandidate(key, {} as { candidateId: string })],
    ['忽略原因为空', () => store.markIgnored(key, '')],
    ['忽略原因是空白', () => store.markIgnored(key, ' ')],
    ['忽略原因是对象', () => store.markIgnored(key, {} as unknown as string)],
  ]
  for (const [name, write] of invalidWrites) {
    assert.throws(write, /无效|不一致|重复/, name)
    assert.equal(readFileSync(file, 'utf8'), before, `${name} 不得改写台账`)
  }

  const forged = identityRow({ key: 'stable:tieba:t1:p2', postId: 'p2', monitorId: 7 }) as unknown as ReplyIdentity
  assert.throws(() => store.mergeForMigration([forged]), /无效|不一致|重复/)
  assert.throws(() => store.replaceAllForMigration([forged]), /无效|不一致|重复/)
  assert.equal(readFileSync(file, 'utf8'), before)
  const newFile = join(dir, 'new-identities.json')
  const fresh = new ReplyIdentityStore({ file: newFile, log: quiet })
  assert.throws(() => fresh.replaceAllForMigration([forged]), /无效|不一致|重复/)
  assert.equal(existsSync(newFile), false)
  assert.throws(() => store.completeMigration({
    state: 'complete',
    completedAt: NOW,
    sources: { state: 7 as unknown as string, monitors: null, tasks: null },
  }), /迁移完成标记无效/)
  assert.equal(readFileSync(file, 'utf8'), before)

  store.markCandidate(key, { candidateId: 'c1' })
  store.markIgnored(key, 'safety')
  const reloaded = new ReplyIdentityStore({ file, log: quiet })
  reloaded.load()
  assert.equal(reloaded.loadError, undefined)
  assert.equal(reloaded.get(key)?.state, 'ignored')
  assert.equal(reloaded.get(key)?.lastError, 'safety')
})

test('全局身份：已拒绝加载的损坏台账不能被后续 claim 或完成标记静默覆盖', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'identities.json')
  const before = writeIdentityDocument(file, {
    version: 1,
    entries: [identityRow({ state: 'candidate', candidateId: { forged: true } })],
  })
  const store = new ReplyIdentityStore({ file, log: quiet })
  store.load()
  assert.match(store.loadError ?? '', /无法解析或结构不认识/)

  assert.throws(() => store.claim({
    platform: 'tieba', threadId: 't1', postId: 'p2', quality: 'stable', fingerprint: 'fp2', monitorId: 'm1',
  }), /加载失败，拒绝覆盖原文件/)
  assert.throws(() => store.completeMigration({
    state: 'complete',
    completedAt: NOW,
    sources: { state: null, monitors: null, tasks: null },
  }), /加载失败，拒绝覆盖原文件/)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.deepEqual(store.all(), [])
})

test('任务租约：心跳续租，过期任务被回收，错误 token 不能续租', () => {
  const dir = scratch()
  const store = new AutoTaskStore({ file: join(dir, 'tasks.json'), log: quiet })
  store.load()
  const { task } = store.enqueue({ kind: 'probe', monitorId: 'm1', dedupeKey: 'p1' })
  const base = Date.now()
  const claimed = store.claim(base, 100)!
  assert.equal(claimed.state, 'running')
  assert.ok(claimed.leaseToken !== undefined)
  assert.equal(claimed.leaseExpiresAt, new Date(base + 100).toISOString())
  assert.equal(store.renewLease(task.id, 'wrong-token', base + 50, 100), false)
  assert.equal(store.renewLease(task.id, claimed.leaseToken, base + 50, 100), true)
  assert.equal(store.get(task.id)?.leaseExpiresAt, new Date(base + 150).toISOString())
  assert.equal(store.stats(base + 100, 100).stuck, 0)
  assert.equal(store.stats(base + 200, 100).stuck, 1)
  assert.deepEqual(store.reapStuck(base + 200, 100), [task.id])
  const reaped = store.get(task.id)!
  assert.equal(reaped.state, 'failed')
  assert.equal(reaped.lastErrorKind, 'stuck')
  assert.equal(reaped.leaseToken, undefined)
})

test('任务租约：重启后 running 被恢复且旧租约清除', () => {
  const dir = scratch()
  const file = join(dir, 'tasks.json')
  const store = new AutoTaskStore({ file, log: quiet })
  store.load()
  const { task } = store.enqueue({ kind: 'generate', monitorId: 'm1', postId: 'p1', identityKey: 'stable:tieba:t:p1', dedupeKey: 'g1' })
  store.claim()
  store.beginModelCall(task.id)
  const reloaded = new AutoTaskStore({ file, log: quiet })
  reloaded.load()
  const recovered = reloaded.recoverInterrupted()
  assert.deepEqual(recovered, { recovered: 1, uncertain: 1 })
  const after = reloaded.get(task.id)!
  assert.equal(after.state, 'pending')
  assert.equal(after.leaseToken, undefined)
  assert.equal(after.modelCall?.uncertain, true)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).lastRecovery.uncertain, 1)
})
