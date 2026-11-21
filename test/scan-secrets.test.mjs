import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const scanner = join(root, 'scripts', 'scan-secrets.mjs')
const runtimeKey = ['AKIA', 'A'.repeat(16)].join('')
const injectedKey = ['AKIA', 'B'.repeat(16)].join('')

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-secret-scan-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function run(args) {
  return spawnSync(process.execPath, [scanner, ...args], { cwd: root, encoding: 'utf8' })
}

function binaryWithKey(key) {
  const data = Buffer.alloc(4096, 0x41)
  data[0] = 0
  data.write(key, 128)
  return data
}

test('SEA 基线原字节匹配被忽略，追加内容仍扫描', (t) => {
  const dir = fixture(t)
  const baseline = join(dir, 'node.bin')
  const target = join(dir, 'app.exe')
  writeFileSync(baseline, binaryWithKey(runtimeKey))
  writeFileSync(target, Buffer.concat([binaryWithKey(runtimeKey), Buffer.from('appended payload')]))

  const result = run(['--baseline', baseline, target])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /忽略 1 条运行时原字节匹配/)
})

test('SEA 变化区新增密钥必须拦截', (t) => {
  const dir = fixture(t)
  const baseline = join(dir, 'node.bin')
  const target = join(dir, 'app.exe')
  writeFileSync(baseline, binaryWithKey(runtimeKey))
  writeFileSync(target, Buffer.concat([binaryWithKey(runtimeKey), binaryWithKey(injectedKey)]))

  const result = run(['--baseline', baseline, target])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /AWS access key/)
})

test('SEA 基线内被改写的密钥必须拦截', (t) => {
  const dir = fixture(t)
  const baseline = join(dir, 'node.bin')
  const target = join(dir, 'app.exe')
  const changed = binaryWithKey(runtimeKey)
  changed.write(injectedKey, 128)
  writeFileSync(baseline, binaryWithKey(runtimeKey))
  writeFileSync(target, changed)

  const result = run(['--baseline', baseline, target])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /AWS access key/)
})

test('错误 Node 基线必须 fail-closed', (t) => {
  const dir = fixture(t)
  const baseline = join(dir, 'node.bin')
  const target = join(dir, 'app.exe')
  const base = Buffer.alloc(4096, 0x41)
  const app = Buffer.alloc(4096, 0x42)
  base[0] = 0
  app[0] = 0
  writeFileSync(baseline, base)
  writeFileSync(target, app)

  const result = run(['--baseline', baseline, target])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /相似度不足/)
})

test('多目标参数全部扫描，第二个目标中的秘密不能漏掉', (t) => {
  const dir = fixture(t)
  const clean = join(dir, 'clean.txt')
  const dirty = join(dir, 'dirty.txt')
  writeFileSync(clean, 'clean')
  writeFileSync(dirty, injectedKey)

  const result = run([clean, dirty])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /dirty\.txt/)
})

test('未提供基线时二进制仍按全量扫描', (t) => {
  const dir = fixture(t)
  const target = join(dir, 'app.exe')
  writeFileSync(target, binaryWithKey(runtimeKey))

  const result = run([target])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /AWS access key/)
})

test('文本目标仍按行号报告秘密', (t) => {
  const dir = fixture(t)
  const target = join(dir, 'secret.txt')
  writeFileSync(target, `first\n${injectedKey}\n`)

  const result = run([target])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /secret\.txt:2/)
})
