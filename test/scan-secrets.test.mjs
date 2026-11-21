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

/** Minimal ELF64 fixture; the injected note deliberately shifts later sections. */
function elfFixture({ noteKey, addNote = noteKey !== undefined, tamperText = false } = {}) {
  const names = ['', '.text', '.rodata', ...(addNote ? ['.note.node.sea'] : []), '.shstrtab']
  const nameTable = Buffer.from(`${names.join('\0')}\0`)
  const nameOffsets = new Map()
  let cursor = 0
  for (const name of names) {
    nameOffsets.set(name, cursor)
    cursor += name.length + 1
  }
  const text = Buffer.alloc(256, 0x43)
  if (tamperText) text[17] ^= 0xff
  const rodata = Buffer.alloc(512, 0x44)
  rodata.write(runtimeKey, 64)
  const note = addNote ? Buffer.alloc(256, 0x45) : undefined
  if (note !== undefined && noteKey !== undefined) note.write(noteKey, 32)
  const contents = [
    { name: '.text', type: 1, flags: 0x6, data: text },
    { name: '.rodata', type: 1, flags: 0x2, data: rodata },
    ...(note === undefined ? [] : [{ name: '.note.node.sea', type: 7, flags: 0, data: note }]),
    { name: '.shstrtab', type: 3, flags: 0, data: nameTable },
  ]
  const headerSize = 64
  const entrySize = 64
  let offset = headerSize
  for (const section of contents) {
    offset = Math.ceil(offset / 8) * 8
    section.offset = offset
    offset += section.data.length
  }
  const sectionOffset = Math.ceil(offset / 8) * 8
  const count = contents.length + 1
  const output = Buffer.alloc(sectionOffset + count * entrySize)
  output.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0)
  output.writeUInt16LE(2, 16)
  output.writeUInt16LE(62, 18)
  output.writeUInt32LE(1, 20)
  output.writeBigUInt64LE(BigInt(sectionOffset), 40)
  output.writeUInt16LE(headerSize, 52)
  output.writeUInt16LE(entrySize, 58)
  output.writeUInt16LE(count, 60)
  output.writeUInt16LE(count - 1, 62)
  for (const section of contents) section.data.copy(output, section.offset)
  for (let index = 0; index < contents.length; index += 1) {
    const section = contents[index]
    const header = sectionOffset + (index + 1) * entrySize
    output.writeUInt32LE(nameOffsets.get(section.name), header)
    output.writeUInt32LE(section.type, header + 4)
    output.writeBigUInt64LE(BigInt(section.flags), header + 8)
    output.writeBigUInt64LE(BigInt(0x1000 + section.offset), header + 16)
    output.writeBigUInt64LE(BigInt(section.offset), header + 24)
    output.writeBigUInt64LE(BigInt(section.data.length), header + 32)
    output.writeBigUInt64LE(0n, header + 40)
    output.writeBigUInt64LE(BigInt(Math.max(1, section.data.length)), header + 48)
  }
  return output
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

test('ELF 注入移动原节后仍只忽略基线原字节', (t) => {
  const dir = fixture(t)
  const baseline = join(dir, 'node.elf')
  const target = join(dir, 'app.elf')
  writeFileSync(baseline, elfFixture())
  writeFileSync(target, elfFixture({ addNote: true }))

  const result = run(['--baseline', baseline, target])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /忽略 1 条运行时原字节匹配/)
})

test('ELF 新增 note 中的密钥必须拦截', (t) => {
  const dir = fixture(t)
  const baseline = join(dir, 'node.elf')
  const target = join(dir, 'app.elf')
  writeFileSync(baseline, elfFixture())
  writeFileSync(target, elfFixture({ noteKey: injectedKey }))

  const result = run(['--baseline', baseline, target])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /AWS access key/)
})

test('ELF 可加载节被改写必须 fail-closed', (t) => {
  const dir = fixture(t)
  const baseline = join(dir, 'node.elf')
  const target = join(dir, 'app.elf')
  writeFileSync(baseline, elfFixture())
  writeFileSync(target, elfFixture({ tamperText: true }))

  const result = run(['--baseline', baseline, target])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ELF 目标与 Node 基线可加载节匹配不足 99%/)
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
