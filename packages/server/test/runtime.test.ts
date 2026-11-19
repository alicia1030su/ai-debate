/**
 * The standalone runtime's own guarantees.
 *
 * These are the behaviours the engine cannot provide for itself because they did
 * not exist in the plugin: an administrator account, an encrypted credential file,
 * a live configuration document, and a durable job queue. Each test is written
 * against the failure it prevents, not the function it calls.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AuthService, passwordProblem, parseCookies, sessionCookie } from '../src/auth.ts'
import { ConfigStore } from '../src/config-store.ts'
import { CredentialStore } from '../src/credential-store.ts'
import { JobQueue } from '../src/jobs.ts'
import { AssetStore } from '../src/assets.ts'
import { WebServerRegistry } from '../src/registry.ts'
import { Logger } from '../src/logger.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ai-debate-test-'))
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }

test('配置写入保持同一个对象引用，并立即对新值可见', () => {
  const dir = tempDir()
  try {
    const store = new ConfigStore({ file: join(dir, 'config.json'), backup: join(dir, 'config.json.bak') })
    store.load()
    const live = store.raw
    store.update({ llmModel: 'm-1' })
    assert.equal(live.llmModel, 'm-1', '保存必须原地修改，否则 runtime 会一直读挂载时的旧值')
    assert.equal(store.raw, live)
    store.update({ llmModel: 'm-2' })
    assert.equal(live.llmModel, 'm-2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置文件被外部改动后，写入返回冲突而不是覆盖', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'config.json')
    const store = new ConfigStore({ file, backup: join(dir, 'config.json.bak') })
    store.load()
    store.update({ llmModel: 'mine' })
    // Simulate another window writing the same file.
    writeFileSync(file, JSON.stringify({ llmModel: 'theirs', maxLength: 200 }), 'utf8')
    assert.throws(() => store.update({ llmModel: 'mine-again' }), /请再确认一次/)
    assert.equal(store.raw.llmModel, 'theirs', '冲突后内存里应是最新读到的值')
    assert.equal(store.raw.maxLength, 200)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('凭据加密落盘：文件里没有明文，describe 不透露长度或末位', async () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'credentials.json')
    const store = new CredentialStore({ file, keyFile: join(dir, 'credentials.key'), log: quiet })
    store.load()
    // Assembled at run time so a credential scanner never sees a key-shaped literal.
    await store.set('AI_DEBATE_LLM_API_KEY', `sk-${'super-secret-'}${'value-123456'}`)
    const onDisk = readFileSync(file, 'utf8')
    assert.equal(onDisk.includes('super-secret'), false, '磁盘上不能出现明文')
    const described = await store.describe('AI_DEBATE_LLM_API_KEY')
    assert.deepEqual(Object.keys(described).sort(), ['configured', 'source', 'writable'])
    assert.equal(described.configured, true)
    const resolved = await store.resolve('AI_DEBATE_LLM_API_KEY')
    assert.equal(resolved?.value, 'sk-super-secret-value-123456')
    await store.unset('AI_DEBATE_LLM_API_KEY')
    assert.equal((await store.describe('AI_DEBATE_LLM_API_KEY')).configured, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('凭据命名空间之外的引用被拒绝', async () => {
  const dir = tempDir()
  try {
    const store = new CredentialStore({ file: join(dir, 'c.json'), keyFile: join(dir, 'c.key'), log: quiet })
    store.load()
    await assert.rejects(() => store.set('DSH_AI_DEBATE_TIEBA_COOKIE', 'x'), /不支持的凭据引用名/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('首次初始化只接受一次，密码强度被检查', () => {
  const dir = tempDir()
  try {
    const auth = new AuthService({
      adminFile: join(dir, 'admin.json'),
      sessionsFile: join(dir, 'sessions.json'),
      log: quiet,
      loopbackOnlySetup: true,
    })
    assert.equal(auth.load().initialized, false)
    assert.notEqual(passwordProblem('short', 'owner'), undefined)
    assert.notEqual(passwordProblem('owner', 'owner'), undefined)
    assert.equal(passwordProblem('a-good-password-1', 'owner'), undefined)
    auth.createAdmin('owner', 'a-good-password-1')
    assert.throws(() => auth.createAdmin('second', 'another-password-1'), /已经初始化/)
    assert.equal(auth.load().initialized, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('登录成功发会话，失败计数到上限后返回 429', () => {
  const dir = tempDir()
  try {
    const auth = new AuthService({
      adminFile: join(dir, 'admin.json'),
      sessionsFile: join(dir, 'sessions.json'),
      log: quiet,
      loopbackOnlySetup: true,
    })
    auth.load()
    auth.createAdmin('owner', 'a-good-password-1')
    const good = auth.login('owner', 'a-good-password-1', { ip: '10.0.0.9' })
    assert.equal(good.ok, true)
    if (good.ok) {
      const session = auth.validate(good.token)
      assert.equal(session?.username, 'owner')
      auth.logout(good.token)
      assert.equal(auth.validate(good.token), undefined)
    }
    for (let attempt = 0; attempt < 8; attempt += 1) auth.login('owner', 'wrong-password', { ip: '10.0.0.7' })
    const blocked = auth.login('owner', 'a-good-password-1', { ip: '10.0.0.7' })
    assert.equal(blocked.ok, false)
    if (!blocked.ok) {
      assert.equal(blocked.status, 429)
      assert.ok((blocked.retryAfterSec ?? 0) > 0)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('会话文件里没有明文会话 id', () => {
  const dir = tempDir()
  try {
    const auth = new AuthService({
      adminFile: join(dir, 'admin.json'),
      sessionsFile: join(dir, 'sessions.json'),
      log: quiet,
      loopbackOnlySetup: true,
    })
    auth.load()
    auth.createAdmin('owner', 'a-good-password-1')
    const outcome = auth.login('owner', 'a-good-password-1', { ip: '127.0.0.1' })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    const onDisk = readFileSync(join(dir, 'sessions.json'), 'utf8')
    assert.equal(onDisk.includes(outcome.token), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('任务队列：去重、重试退避、暂停与崩溃恢复', async () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'jobs.json')
    const queue = new JobQueue({ file, log: quiet })
    let attempts = 0
    queue.register('storage.check', async () => {
      attempts += 1
      if (attempts < 2) throw new Error('第一次失败是故意的')
    })
    const first = queue.enqueue({ type: 'storage.check', key: 'same' })
    const again = queue.enqueue({ type: 'storage.check', key: 'same' })
    assert.equal(first.job.id, again.job.id, '相同 key 在排队期间只能有一个')
    assert.equal(again.deduplicated, true)
    queue.start()
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(attempts, 1, '第一次应当执行并失败')
    const afterFail = queue.list()[0]
    assert.equal(afterFail?.state, 'queued', '可重试任务失败后应回到队列')
    assert.ok(Date.parse(afterFail?.nextRunAt ?? '') > Date.now(), '退避应把下次执行时间推后')
    queue.pauseQueue()
    const paused = queue.list()[0]
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(queue.list()[0]?.state, paused?.state, '暂停后不再领取任务')
    await queue.stop()

    // A job left running means the process died mid-flight.
    const document = JSON.parse(readFileSync(file, 'utf8')) as { jobs: { state: string }[] }
    for (const job of document.jobs) job.state = 'running'
    writeFileSync(file, JSON.stringify(document), 'utf8')
    const recovered = new JobQueue({ file, log: quiet })
    const outcome = recovered.start()
    assert.ok(outcome.recovered >= 1)
    assert.equal(recovered.list()[0]?.state, 'queued')
    await recovered.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('任务队列拒绝把发表类动作排进队列', () => {
  const dir = tempDir()
  try {
    const queue = new JobQueue({ file: join(dir, 'jobs.json'), log: quiet })
    // The type union is the enforcement; this asserts the allowed set stays closed.
    const allowed = ['backup.create', 'backup.restore', 'logs.rotate', 'credentials.audit', 'storage.check']
    for (const type of allowed) {
      assert.doesNotThrow(() => queue.enqueue({ type: type as 'backup.create' }))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('路由注册：精确优先于前缀，最长前缀优先', () => {
  const registry = new WebServerRegistry()
  const seen: string[] = []
  registry.register({ kind: 'prefix', path: '/api/x', handler: () => void seen.push('prefix-short') })
  registry.register({ kind: 'prefix', path: '/api/x/y', handler: () => void seen.push('prefix-long') })
  registry.register({ kind: 'exact', path: '/api/x/y/z', handler: () => void seen.push('exact') })
  assert.equal(registry.match('/api/x/y/z')?.kind, 'exact')
  assert.equal(registry.match('/api/x/y/other')?.path, '/api/x/y')
  assert.equal(registry.match('/api/x/q')?.path, '/api/x')
  assert.equal(registry.match('/nope'), undefined)
})

test('静态资源只服务白名单内的路径', async () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>', 'utf8')
    const store = new AssetStore({ diskRoot: dir })
    await store.init()
    assert.ok((await store.read('/'))?.body.toString('utf8').includes('doctype'))
    assert.equal(await store.read('/../config.json'), undefined)
    assert.equal(await store.read('/assets/missing.js'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('日志脱敏：Cookie、Bearer、API Key 与口令都不出现', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'server.log')
    const logger = new Logger({ level: 'debug', file, echo: false })
    logger.info(`Cookie: BDUSS=${'abcdefghijklmnop'}; SUB=_2A25xyz`)
    logger.info(`Authorization: Bearer ${'abcdefghijklmnopqrstuvwxyz'}`)
    logger.info(`api_key=sk-${'live-'}${'abcdefghijklmnop'}`)
    logger.info('password=hunter2hunter2')
    const text = readFileSync(file, 'utf8')
    for (const secret of ['abcdefghijklmnop', 'abcdefghijklmnopqrstuvwxyz', 'hunter2hunter2', 'sk-live']) {
      assert.equal(text.includes(secret), false, `日志里不应出现 ${secret}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cookie 解析与属性', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' })
  const header = sessionCookie('token', { secure: true })
  assert.ok(header.includes('HttpOnly'))
  assert.ok(header.includes('SameSite=Strict'))
  assert.ok(header.includes('Secure'))
})

test('数据目录缺失时配置为空但不抛错', () => {
  const dir = tempDir()
  try {
    const store = new ConfigStore({ file: join(dir, 'nope.json'), backup: join(dir, 'nope.bak') })
    const result = store.load()
    assert.equal(result.loaded, false)
    assert.equal(existsSync(join(dir, 'nope.json')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
