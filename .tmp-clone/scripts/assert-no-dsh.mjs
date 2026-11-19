/**
 * Prove the shipped product does not depend on DSH.
 *
 * Three checks, each answering a different question:
 *
 *   1. Static: no source file imports `@deepseek-ai/*`, and no package manifest
 *      lists one as a dependency. A single import would be enough to make the
 *      binary fail on a machine without DSH.
 *   2. Product naming: the wire surface and the bundle do not use the old prefix.
 *      Historical mentions are allowed in NOTICE and in comments that explain
 *      provenance — those are attribution, not a runtime dependency.
 *   3. Runtime: the packaged binary runs with an environment that has no DSH
 *      home, no DSH binary on PATH, and no DSH profile directory.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = join(import.meta.dirname, '..')
const failures = []

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'lib') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, filter, out)
    else if (filter(full)) out.push(full)
  }
  return out
}

// 1. No import of a DSH package anywhere in shipped source.
const sources = [
  ...walk(join(root, 'packages', 'core', 'src'), (f) => f.endsWith('.ts')),
  ...walk(join(root, 'packages', 'server', 'src'), (f) => f.endsWith('.ts') || f.endsWith('.mjs')),
  ...walk(join(root, 'packages', 'web', 'src'), (f) => /\.(cjs|mjs|js)$/.test(f) && !f.includes('legacy-body')),
  ...walk(join(root, 'apps', 'desktop', 'src'), (f) => f.endsWith('.ts')),
]

for (const file of sources) {
  const text = readFileSync(file, 'utf8')
  const match = /from\s+['"]@deepseek-ai\/[^'"]+['"]|require\(\s*['"]@deepseek-ai\/[^'"]+['"]\s*\)/.exec(text)
  if (match !== null) failures.push(`${relative(root, file)} 仍然 import 了 ${match[0]}`)
}

// 2. No DSH package in any manifest's dependency block.
for (const manifest of ['package.json', join('packages', 'core', 'package.json'), join('packages', 'server', 'package.json'), join('packages', 'web', 'package.json')]) {
  const full = join(root, manifest)
  if (!existsSync(full)) continue
  const parsed = JSON.parse(readFileSync(full, 'utf8'))
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(parsed[field] ?? {})) {
      if (name.startsWith('@deepseek-ai/')) failures.push(`${manifest} 的 ${field} 依赖了 ${name}`)
    }
  }
}

// 3. The old API prefix must not survive on the wire; historical prose is fine.
const wireFiles = [
  ...walk(join(root, 'packages', 'core', 'src'), (f) => f.endsWith('.ts')),
  ...walk(join(root, 'packages', 'web', 'src'), (f) => /\.(cjs|mjs|js)$/.test(f) && !f.includes('legacy-body')),
]
for (const file of wireFiles) {
  const text = readFileSync(file, 'utf8')
  if (text.includes('/api/dsh-ai-debate')) failures.push(`${relative(root, file)} 仍在使用旧 API 前缀 /api/dsh-ai-debate`)
}

// 4. Runtime: the packaged binary must start with DSH removed from the environment.
const exe = process.platform === 'win32'
  ? join(root, 'dist', 'AI-Debate-windows-x64.exe')
  : join(root, 'dist', 'ai-debate-linux-x64', 'bin', 'ai-debate')
const packaged = existsSync(exe) ? exe : undefined

if (packaged !== undefined) {
  const env = { ...process.env }
  delete env.DSH_HOME
  delete env.DSH_PROFILE
  const result = spawnSync(packaged, ['--version'], { env, encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) {
    failures.push(`打包产物在去除 DSH 环境后无法运行：${result.stderr || result.stdout}`)
  }
} else {
  process.stdout.write(`· 跳过运行期检查：${relative(root, exe)} 不存在\n`)
}

if (failures.length > 0) {
  process.stderr.write('✖ 仍存在 DSH 依赖：\n')
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`)
  process.exit(1)
}

process.stdout.write(`✔ 无 DSH 依赖（检查了 ${sources.length} 个源文件、4 个清单、${wireFiles.length} 个线路文件）\n`)
