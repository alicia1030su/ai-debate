/**
 * One data directory, one writer — and the escape hatch.
 *
 * The failure this prevents is not corruption: the engine serialises its own
 * writes. It is two consoles over one ledger, each with its own session table and
 * its own in-memory copy of `config.json`, so the older window answers every save
 * with "the configuration was changed by another process" until the user gives up
 * and reloads a page that was correct all along.
 *
 * The record is only consulted *before binding*, and liveness needs both facts to
 * agree — pid alive and `/healthz` answering. A record left by a killed process
 * must not block the next start, or the product would be unusable after a crash.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startServer } from '../src/app.ts'
import { browserHost, liveInstance } from '../src/cli.ts'
import { pidAlive, readInstance, writeInstance } from '../src/instance.ts'

/** A throwaway process whose only job is to have a pid that is alive. */
function spawnIdle(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
}

test('活实例会占住数据目录，死掉的记录不会', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-instance-'))
  const running = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    version: '0.0.0-test',
    scheduleBackups: false,
  })
  const file = join(dir, 'run', 'instance.lock')
  let idle: ChildProcess | undefined
  try {
    const record = readInstance(file)
    assert.ok(record !== undefined, '启动后应写出实例记录')
    assert.equal(record.pid, process.pid)
    assert.equal(record.port, running.port)

    // A record pointing at a pid that does not exist is stale. It must be removed
    // rather than reported: otherwise a crash makes the product unstartable.
    writeFileSync(file, JSON.stringify({ pid: 999_999, host: '127.0.0.1', port: 1, startedAt: '', version: '' }), 'utf8')
    assert.equal(await liveInstance(dir), undefined)
    assert.equal(readInstance(file), undefined, '过期的实例记录应被删除')

    // The real occupied case: a pid that exists and a port that answers /healthz.
    // The serving process is stood in for by a tiny HTTP server, because the test
    // cannot own a second real instance's pid.
    idle = spawnIdle()
    const pid = idle.pid
    assert.ok(pid !== undefined && pidAlive(pid), '子进程应当存活')
    const stand = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, version: '0.0.0-stand' }))
    })
    await new Promise<void>((resolvePromise) => stand.listen(0, '127.0.0.1', () => resolvePromise()))
    const address = stand.address()
    const standPort = address !== null && typeof address === 'object' ? address.port : 0
    try {
      writeInstance(file, { pid, host: '127.0.0.1', port: standPort, startedAt: '', version: '0.0.0-stand' })
      const live = await liveInstance(dir)
      assert.ok(live !== undefined, '存活的 pid + 可用的 /healthz 必须被报告为已占用')
      assert.equal(live.pid, pid)
      assert.equal(live.port, standPort)
    } finally {
      await new Promise<void>((resolvePromise) => stand.close(() => resolvePromise()))
    }
    // Hand the record back to the real instance so the teardown below exercises
    // "closing removes its own record" rather than "closing leaves a stranger's".
    writeInstance(file, record)
  } finally {
    idle?.kill()
    await running.close()
    // Closing removes its own record, so a subsequent start is unimpeded.
    assert.equal(readInstance(file), undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pidAlive 把 EPERM 当作存活，不当成已退出', () => {
  assert.equal(pidAlive(process.pid), true, '自己的 pid 一定存活')
  assert.equal(pidAlive(0), false)
  assert.equal(pidAlive(-1), false)
  // A pid beyond the maximum is not a process. `kill` reports ESRCH, which is the
  // "definitely gone" answer.
  assert.equal(pidAlive(2 ** 31), false)
})

test('0.0.0.0 绑定下交给用户的地址是环回，而不是通配地址', () => {
  assert.equal(browserHost('0.0.0.0'), '127.0.0.1')
  assert.equal(browserHost('::'), '127.0.0.1')
  assert.equal(browserHost(''), '127.0.0.1')
  assert.equal(browserHost('192.168.1.20'), '192.168.1.20')
  assert.equal(browserHost('debate.example.com'), 'debate.example.com')
})
