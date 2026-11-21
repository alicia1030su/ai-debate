/** Lock ownership and durable-read boundary regressions from the v0.2.2 soak failure. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore, emptyStore, type StoreData, type StoredSession } from '../lib/store.js'

function tempStore(lockTimeoutMs = 30): { dir: string; store: DebateStore } {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-store-recovery-'))
  return { dir, store: new DebateStore({ dir, lockTimeoutMs }) }
}

function session(id = 's1'): StoredSession {
  const now = new Date().toISOString()
  return {
    id,
    platform: 'faketieba',
    threadId: 't017',
    threadTitle: '恢复测试帖',
    threadUrl: 'https://fake.example/p/t017',
    ownerKey: 'owner',
    ownerName: '楼主',
    opponentKey: 'rival',
    opponentName: '对方',
    triggerPostId: 'r1',
    persona: { style: '直接', intensity: 3, maxLength: 200 },
    comments: [],
    readQuality: { floorsRead: 0, nestedRead: 0, truncated: false, reasons: [], observationOverflow: [] },
    sentTexts: [],
    candidates: [],
    state: 'REVIEWING',
    statusText: '等待生成',
    publishedPostIds: [],
    createdAt: now,
    updatedAt: now,
  }
}

function candidate(replyId = 'c1', targetPostId = 'r1') {
  return {
    replyId,
    text: '候选正文',
    strategy: 'direct_rebuttal' as const,
    targetPostId,
    textHash: 'hash',
    confidence: 0.8,
    violations: [],
    notes: [],
    createdAt: new Date().toISOString(),
    approved: false,
    candidateVersion: 1,
  }
}

test('锁 release：首次读取瞬时失败会重试，不留下活 PID wedge', async (t) => {
  const { dir, store } = tempStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await store.ready()

  const originalRead = fs.readFile
  let lockReads = 0
  t.mock.method(fs, 'readFile', (async (...args: unknown[]) => {
    if (String(args[0]).includes('state.json.lock')) {
      lockReads += 1
      if (lockReads === 2) {
        throw Object.assign(new Error('injected transient release read failure'), { code: 'EIO' })
      }
    }
    return Reflect.apply(originalRead, fs, args)
  }) as typeof fs.readFile)

  await store.mutate((data) => ({ ...data, sessions: [session()] }))
  assert.equal(existsSync(`${store.path}.lock`), false, 'release 重试成功后必须删除自己的锁')
  assert.ok(lockReads >= 3, 'release 必须重新读取并确认所有权，而不是把 EIO 当成已释放')

  await store.mutate((data) => ({
    ...data,
    sessions: data.sessions.map((row) => row.id === 's1' ? { ...row, statusText: '第二次写入成功' } : row),
  }))
  assert.equal(store.getSession('s1')?.statusText, '第二次写入成功')
  assert.equal(store.hasUnsavedChanges, false)
})

test('锁 release：token 不匹配时不得删除锁路径', async (t) => {
  const { dir, store } = tempStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await store.ready()

  const originalRead = fs.readFile
  let lockReads = 0
  t.mock.method(fs, 'readFile', (async (...args: unknown[]) => {
    if (String(args[0]).includes('state.json.lock')) {
      lockReads += 1
      if (lockReads === 2) {
        return JSON.stringify({ pid: process.pid, at: Date.now(), token: 'peer-owner' })
      }
    }
    return Reflect.apply(originalRead, fs, args)
  }) as typeof fs.readFile)

  await store.mutate((data) => ({ ...data, sessions: [session()] }))
  const raw = readFileSync(`${store.path}.lock`, 'utf8')
  assert.equal(lockReads, 2)
  assert.notEqual(JSON.parse(raw).token, 'peer-owner', '测试桩只改变 release 的观察，不应改写真实锁文件')
  assert.equal(existsSync(`${store.path}.lock`), true, '所有权不明确时不能 unlink')
})

test('持久读边界：dirty 内存候选不得被当作磁盘候选', async (t) => {
  const { dir, store } = tempStore(20)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await store.ready()
  await store.mutate((data) => ({ ...data, sessions: [session()] }))
  t.mock.method(
    store as unknown as { persist(data: StoreData): Promise<void> },
    'persist',
    async () => {
      throw Object.assign(new Error('injected candidate persist failure'), { code: 'EIO' })
    },
  )

  await assert.rejects(() => store.mutate((data) => ({
    ...data,
    sessions: data.sessions.map((row) => row.id === 's1' ? { ...row, candidates: [candidate()] } : row),
  })), /状态写入失败/)

  assert.equal(store.hasUnsavedChanges, true)
  assert.equal(store.getSession('s1')?.candidates.length, 1, 'mutate 契约仍保留 attempted document')
  assert.equal((await store.readPersistedSession('s1'))?.candidates.length, 0, '持久读必须忽略 dirty 内存')
  assert.equal((await store.readPersistedSnapshot()).sessions[0]?.candidates.length, 0)

  const reloaded = new DebateStore({ dir })
  await reloaded.ready()
  assert.equal(reloaded.getSession('s1')?.candidates.length, 0, '重载磁盘后不得出现幽灵候选')
  assert.deepEqual(reloaded.snapshot().sessions.map((row) => row.id), ['s1'])
  assert.notDeepEqual(reloaded.snapshot(), emptyStore())
})
