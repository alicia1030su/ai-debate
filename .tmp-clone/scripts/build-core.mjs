/**
 * Compile the debate engine.
 *
 * `tsc` rather than a bundler: the core tests import `../lib/*.js` (the upstream
 * project's layout), so a real emitted tree with declarations is what they expect.
 * `--incremental` is off on purpose — a stale incremental cache once hid a deleted
 * export, and a two-second full build is cheaper than that class of bug.
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = join(import.meta.dirname, '..')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

if (!existsSync(tsc)) {
  process.stderr.write('✖ 找不到本地 TypeScript，请先 npm install\n')
  process.exit(1)
}

rmSync(join(root, 'packages', 'core', 'lib'), { recursive: true, force: true })

const result = spawnSync(process.execPath, [tsc, '-p', join('packages', 'core', 'tsconfig.json')], {
  cwd: root,
  stdio: 'inherit',
})

if (result.error) {
  process.stderr.write(`✖ tsc 无法启动：${result.error.message}\n`)
  process.exit(1)
}
if (result.status !== 0) process.exit(result.status ?? 1)

process.stdout.write('✔ core 编译完成 → packages/core/lib\n')
