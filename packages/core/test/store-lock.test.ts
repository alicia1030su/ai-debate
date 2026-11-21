/** Deterministic lock-ownership and durable-read regressions for the v0.2.2 soak. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DebateStore, type StoredCandidate, type StoredSession, type StoreData } from '../lib/store.js'

function makeStore(lockTimeoutMs = 50): { dir: string; store: DebateStore } {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-store-lock-'))
  return { dir, store: new DebateStore({ dir, lockTimeoutMs }) }
}

function makeSession(id: string, createdAt: string, updatedAt = createdAt): StoredSession {
  return {
    id,
    platform: 'faketieba',
    threadId: 'thread-1',
    threadTitle: '锁回归测试帖',
    threadUrl: 'https://fake.example/p/thread-1',
    forumName: '测试吧',
    ownerKey: 'owner',
    opponentKey: 'rival',
    disputeFloorPostId: 'f1',
    disputeFloorNumber: 1,
    triggerPostId: 'r1',
    persona: { style: '直接', intensity: 3, maxLength: 200 },
    candidates: [],
    publishedPostIds: [],
    sentTexts: [],
    state: 'REVIEWING',
    statusText: '等待生成',
    createdAt,
    updatedAt,
  }
}

function makeCandidate(): StoredCandidate {
  return {
    replyId: 'candidate-1',
    text: '未落盘的幽灵候选',
    strategy: 'direct_rebuttal',
    targetPostId: 'r1',
    candidateVersion: 1,
    textHash: 'hash-1',
    confidence: 0.8,
    violations: [],
    notes: [],
    approved: false,
    createdAt: '2026-11-21T06:00:00.000Z',
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await once(child, 'exit')
}

test('release 读锁瞬时失败会重试，下一次 mutate 不留活 PID wedge', async (t) => {
  const { dir, store } = makeStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await store.ready()

  const originalRead = fs.readFile
  let releaseReads = 0
  t.mock.method(fs, 'readFile', (async (...args: unknown[]) => {
    if (String(args[0]).endsWith('state.json.lock')) {
      releaseReads += 1
      if (releaseReads === 1) {
        throw Object.assign(new Error('injected transient lock read failure'), { code: 'EIO' })
      }
    }
    return Reflect.apply(originalRead, fs, args)
  }) as typeof fs.readFile)

  await store.mutate((data) => ({ ...data, sessions: [makeSession('s1', '2026-11-21T06:00:00.000Z')] }))
  assert.equal(existsSync(`${store.path}.lock`), false)
  assert.ok(releaseReads >= 2, 'release 必须重试读取，而不是把 EIO 当成锁已消失')
  assert.equal(store.lockReleaseError, undefined)

  await store.mutate((data) => ({
    ...data,
    sessions: data.sessions.map((session) => ({ ...session, statusText: '第二次写入成功' })),
  }))
  assert.equal(store.getSession('s1')?.statusText, '第二次写入成功')
  assert.equal(store.hasUnsavedChanges, false)
})

test('release 持续失败只记录诊断；已 persist 成功不 dirty，下次 acquire 回收同进程孤儿', async (t) => {
  const { dir, store } = makeStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await store.ready()

  const originalRead = fs.readFile
  let failReleaseReads = true
  t.mock.method(fs, 'readFile', (async (...args: unknown[]) => {
    if (failReleaseReads && String(args[0]).endsWith('state.json.lock')) {
      throw Object.assign(new Error('injected persistent lock read failure'), { code: 'EPERM' })
    }
    return Reflect.apply(originalRead, fs, args)
  }) as typeof fs.readFile)

  await store.mutate((data) => ({ ...data, sessions: [makeSession('s1', '2026-11-21T06:00:00.000Z')] }))
  assert.equal(store.hasUnsavedChanges, false, '锁清理失败不得覆盖持久化成功')
  assert.equal(store.unsavedReason, undefined)
  assert.match(store.lockReleaseError ?? '', /无法确认状态写入锁的所有权/)
  assert.equal(existsSync(`${store.path}.lock`), true)

  const orphan = JSON.parse(readFileSync(`${store.path}.lock`, 'utf8')) as { pid: number; token: string }
  assert.equal(orphan.pid, process.pid)
  failReleaseReads = false

  await store.mutate((data) => ({
    ...data,
    sessions: data.sessions.map((session) => ({ ...session, statusText: '孤儿锁已回收' })),
  }))
  assert.equal(store.getSession('s1')?.statusText, '孤儿锁已回收')
  assert.equal(store.hasUnsavedChanges, false)
  assert.equal(store.lockReleaseError, undefined)
  assert.equal(existsSync(`${store.path}.lock`), false)
})

test('主锁 rename 成功后 graveyard 读取失败不 wedge，也不误报 persist 失败', async (t) => {
  const { dir, store } = makeStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await store.ready()

  const originalRead = fs.readFile
  let failGraveyardReads = true
  t.mock.method(fs, 'readFile', (async (...args: unknown[]) => {
    if (failGraveyardReads && String(args[0]).endsWith('.release')) {
      throw Object.assign(new Error('injected graveyard read failure'), { code: 'EIO' })
    }
    return Reflect.apply(originalRead, fs, args)
  }) as typeof fs.readFile)

  await store.mutate((data) => ({ ...data, sessions: [makeSession('s1', '2026-11-21T06:00:00.000Z')] }))
  assert.equal(store.hasUnsavedChanges, false)
  assert.match(store.lockReleaseError ?? '', /injected graveyard read failure/)
  assert.equal(existsSync(`${store.path}.lock`), false, '主锁路径必须已经释放')

  failGraveyardReads = false
  await store.mutate((data) => ({
    ...data,
    sessions: data.sessions.map((session) => ({ ...session, statusText: 'graveyard 不影响下一次写入' })),
  }))
  assert.equal(store.getSession('s1')?.statusText, 'graveyard 不影响下一次写入')
  assert.equal(store.lockReleaseError, undefined)
})

test('主锁 rename 成功后 graveyard 删除失败只保留诊断文件', async (t) => {
  const { dir, store } = makeStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await store.ready()

  const originalUnlink = fs.unlink
  let failGraveyardDeletes = true
  t.mock.method(fs, 'unlink', (async (...args: unknown[]) => {
    if (failGraveyardDeletes && String(args[0]).endsWith('.release')) {
      throw Object.assign(new Error('injected graveyard delete failure'), { code: 'EPERM' })
    }
    return Reflect.apply(originalUnlink, fs, args)
  }) as typeof fs.unlink)

  await store.mutate((data) => ({ ...data, sessions: [makeSession('s1', '2026-11-21T06:00:00.000Z')] }))
  assert.equal(store.hasUnsavedChanges, false)
  assert.match(store.lockReleaseError ?? '', /injected graveyard delete failure/)
  assert.equal(existsSync(`${store.path}.lock`), false)

  failGraveyardDeletes = false
  await store.mutate((data) => ({
    ...data,
    sessions: data.sessions.map((session) => ({ ...session, statusText: '删除诊断不影响主路径' })),
  }))
  assert.equal(store.getSession('s1')?.statusText, '删除诊断不影响主路径')
  assert.equal(store.lockReleaseError, undefined)
})

test('rename 后 token 不匹配时保留 peer 锁，绝不删除无法恢复的字节', async (t) => {
  const { dir, store } = makeStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await store.ready()

  const peerBody = JSON.stringify({ pid: process.pid, at: Date.now(), token: 'peer-after-rename' })
  const originalRename = fs.rename
  t.mock.method(fs, 'rename', (async (...args: unknown[]) => {
    const result = await Reflect.apply(originalRename, fs, args)
    if (String(args[0]) === `${store.path}.lock` && String(args[1]).endsWith('.release')) {
      // Simulate a peer's bytes winning the live path immediately before our
      // rename, so the moved file itself carries a token that is not ours.
      writeFileSync(String(args[1]), peerBody)
      writeFileSync(`${store.path}.lock`, peerBody)
    }
    return result
  }) as typeof fs.rename)

  await store.mutate((data) => ({ ...data, sessions: [makeSession('s1', '2026-11-21T06:00:00.000Z')] }))
  assert.equal(store.hasUnsavedChanges, false)
  assert.equal(store.lockReleaseError, undefined)
  const graveyard = readdirSync(dir).find((name) => name.endsWith('.release'))
  assert.ok(graveyard !== undefined, '无法恢复的 peer 字节必须保留为诊断')
  assert.equal(JSON.parse(readFileSync(join(dir, graveyard), 'utf8')).token, 'peer-after-rename')
  assert.equal(JSON.parse(readFileSync(`${store.path}.lock`, 'utf8')).token, 'peer-after-rename')
})

test('transact 已提交后 release 失败不得改为 dirty 或拒绝返回值', async (t) => {
  const { dir, store } = makeStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await store.ready()

  const originalRead = fs.readFile
  let failReleaseReads = true
  t.mock.method(fs, 'readFile', (async (...args: unknown[]) => {
    if (failReleaseReads && String(args[0]).endsWith('.release')) {
      throw Object.assign(new Error('injected transact release failure'), { code: 'EIO' })
    }
    return Reflect.apply(originalRead, fs, args)
  }) as typeof fs.readFile)

  const result = await store.transact((data) => ({
    commit: { ...data, sessions: [makeSession('s1', '2026-11-21T06:00:00.000Z')] },
    value: 'committed-value',
  }))
  assert.equal('committed' in result, true)
  if ('committed' in result) assert.equal(result.value, 'committed-value')
  assert.equal(store.hasUnsavedChanges, false)
  assert.match(store.lockReleaseError ?? '', /injected transact release failure/)
  assert.equal(existsSync(`${store.path}.lock`), false)
  failReleaseReads = false
  assert.equal((await store.readPersistedSession('s1'))?.id, 's1')
})

test('同进程另一个 store 不能抢占仍活跃的已注册 token', async (t) => {
  const { dir, store } = makeStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await store.ready()

  const persistTarget = store as unknown as { persist(data: StoreData): Promise<void> }
  const originalPersist = persistTarget.persist.bind(store)
  let signalPersistStarted: () => void = () => undefined
  const persistStarted = new Promise<void>((resolveStarted) => {
    signalPersistStarted = resolveStarted
  })
  let releasePersist: () => void = () => undefined
  const persistGate = new Promise<void>((resolveGate) => {
    releasePersist = resolveGate
  })
  t.mock.method(persistTarget, 'persist', async (data: StoreData) => {
    signalPersistStarted()
    await persistGate
    await originalPersist(data)
  })

  const first = store.mutate((data) => ({
    ...data,
    sessions: [makeSession('first', '2026-11-21T06:00:00.000Z')],
  }))
  await persistStarted

  const peer = new DebateStore({ dir, lockTimeoutMs: 30 })
  await peer.ready()
  await assert.rejects(
    () => peer.mutate((data) => ({ ...data, sessions: [makeSession('peer', '2026-11-21T06:01:00.000Z')] })),
    /状态写入锁被占用/,
  )
  assert.equal(existsSync(store.path), false, '活跃锁被抢占时不得发生写入')

  releasePersist()
  await first
  assert.equal(existsSync(`${store.path}.lock`), false)
  assert.deepEqual((await store.readPersistedSnapshot()).sessions.map((session) => session.id), ['first'])
})

test('候选写入失败后持久读不返回 dirty 内存中的幽灵候选', async (t) => {
  const { dir, store } = makeStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await store.ready()
  await store.mutate((data) => ({ ...data, sessions: [makeSession('s1', '2026-11-21T06:00:00.000Z')] }))

  t.mock.method(
    store as unknown as { persist(data: StoreData): Promise<void> },
    'persist',
    async () => {
      throw Object.assign(new Error('injected candidate persist failure'), { code: 'EIO' })
    },
  )

  await assert.rejects(() => store.mutate((data) => ({
    ...data,
    sessions: data.sessions.map((session) => ({ ...session, candidates: [makeCandidate()] })),
  })), /状态写入失败/)
  assert.equal(store.hasUnsavedChanges, true)
  assert.equal(store.getSession('s1')?.candidates.length, 1, 'mutate 契约保留 attempted document')

  assert.equal((await store.readPersistedSession('s1'))?.candidates.length, 0)
  assert.equal((await store.readPersistedSnapshot()).sessions[0]?.candidates.length, 0)
  assert.equal(store.hasUnsavedChanges, true, '持久读不得清掉 dirty 状态')
  assert.equal(store.getSession('s1')?.candidates.length, 1, '持久读不得改写 dirty 内存')
})

test('持久读等待同实例已经排队的写入，并观察到最终文档', async (t) => {
  const { dir, store } = makeStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await store.ready()

  const first = store.mutate((data) => ({
    ...data,
    sessions: [makeSession('s1', '2026-11-21T06:00:00.000Z')],
  }))
  const second = store.mutate((data) => ({
    ...data,
    sessions: data.sessions.map((session) => ({ ...session, statusText: 'queued write committed' })),
  }))
  const durable = store.readPersistedSnapshot()

  await Promise.all([first, second])
  const document = await durable
  assert.equal(document.sessions[0]?.statusText, 'queued write committed')
  assert.equal(store.hasUnsavedChanges, false)
})

test('持久 thread 读取按 createdAt 降序，而不是 updatedAt', async (t) => {
  const { dir, store } = makeStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await store.ready()
  await store.mutate((data) => ({
    ...data,
    sessions: [
      makeSession('older', '2026-11-20T06:00:00.000Z', '2026-11-22T06:00:00.000Z'),
      makeSession('newer', '2026-11-21T06:00:00.000Z', '2026-11-21T07:00:00.000Z'),
    ],
  }))

  assert.deepEqual(
    (await store.readPersistedSessionsForThread('thread-1')).map((session) => session.id),
    ['newer', 'older'],
  )
})

test('其他活进程的 token 即使很旧也绝不抢占', async (t) => {
  const { dir, store } = makeStore(30)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await store.ready()

  const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  t.after(async () => stopChild(child))
  const token = 'other-live-process-token'
  writeFileSync(`${store.path}.lock`, JSON.stringify({
    pid: child.pid,
    at: Date.now() - 10 * 60_000,
    token,
  }), 'utf8')

  await assert.rejects(
    () => store.mutate((data) => ({ ...data, sessions: [makeSession('s1', '2026-11-21T06:00:00.000Z')] })),
    /状态写入锁被占用/,
  )
  assert.equal(child.exitCode, null)
  assert.equal(JSON.parse(readFileSync(`${store.path}.lock`, 'utf8')).token, token)
  assert.equal(existsSync(store.path), false)
})
