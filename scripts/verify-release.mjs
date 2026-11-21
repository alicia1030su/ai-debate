/**
 * The files a release contains, and the claim each one makes.
 *
 * Run with `node scripts/verify-release.mjs` after a build. It is the last gate
 * before a tag: everything here is checked against the artefact that will be
 * uploaded, not against a source tree.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const docsOnly = process.argv.includes('--docs-only')

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

const exe = join(root, 'dist', 'AI-Debate-windows-x64.exe')
const tgz = join(root, 'dist', 'ai-debate-linux-x64.tgz')

check('版本号是语义化版本', /^\d+\.\d+\.\d+$/.test(version), version)
check('LICENSE 存在且是 AGPL', existsSync(join(root, 'LICENSE')) && readFileSync(join(root, 'LICENSE'), 'utf8').includes('GNU AFFERO GENERAL PUBLIC LICENSE'))
check('NOTICE 记录了来源', existsSync(join(root, 'NOTICE')) && readFileSync(join(root, 'NOTICE'), 'utf8').includes('dsh-ai-debate'))

if (!docsOnly) {
  if (process.platform === 'win32') {
    check('Windows EXE 存在', existsSync(exe))
    if (existsSync(exe)) {
      const size = statSync(exe).size
      check('Windows EXE 体积合理（>50MB，含 Node 运行时）', size > 50 * 1024 * 1024, `${(size / 1024 / 1024).toFixed(1)} MB`)
      const run = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 30_000 })
      check('Windows EXE 可运行', run.status === 0, (run.stdout ?? '').trim())
      check('Windows EXE 报出的版本与 package.json 一致', (run.stdout ?? '').includes(version), version)
      const sha = createHash('sha256').update(readFileSync(exe)).digest('hex')
      const sidecar = existsSync(`${exe}.sha256`) ? readFileSync(`${exe}.sha256`, 'utf8') : ''
      check('EXE 有配套 SHA256 且一致', sidecar.includes(sha), sha.slice(0, 32))
    }
  }

  if (existsSync(tgz)) {
    const size = statSync(tgz).size
    check('Linux TGZ 体积合理', size > 20 * 1024 * 1024, `${(size / 1024 / 1024).toFixed(1)} MB`)
    const sha = createHash('sha256').update(readFileSync(tgz)).digest('hex')
    const sidecar = existsSync(`${tgz}.sha256`) ? readFileSync(`${tgz}.sha256`, 'utf8') : ''
    check('TGZ 有配套 SHA256 且一致', sidecar.includes(sha), sha.slice(0, 32))
  } else {
    process.stdout.write('· Linux TGZ 不在这里构建（需要在 Linux runner 上运行 packaging/linux/build.mjs）\n')
  }
}

const docs = [
  'install-windows.md',
  'install-linux.md',
  'security.md',
  'migration.md',
  'differences.md',
  'known-issues.md',
  'architecture.md',
  'automation-architecture.md',
  'reliability-v0.2.1.md',
]
for (const doc of docs) check(`文档 ${doc} 存在`, existsSync(join(root, 'docs', doc)))

const versionDocs = [
  `architecture-v${version}.md`,
  `reliability-v${version}.md`,
  `security-audit-v${version}.md`,
  `upgrade-v${version}.md`,
  `acceptance-v${version}.md`,
  `release-notes-v${version}.md`,
]
for (const doc of versionDocs) {
  const file = join(root, 'docs', doc)
  const contents = existsSync(file) ? readFileSync(file, 'utf8') : ''
  check(`版本文档 ${doc} 存在且非空`, contents.trim() !== '')
  check(`版本文档 ${doc} 标明 v${version}`, contents.includes(`v${version}`) || contents.includes(version))
}

const failed = checks.filter((item) => !item.ok)
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} 项通过\n`)
if (failed.length > 0) process.exit(1)
