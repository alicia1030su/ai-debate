/**
 * Build the Linux x86-64 archive.
 *
 * Runs on the platform it targets: the SEA blob is injected into the *running*
 * node binary, which is then the standalone executable. Cross-building from
 * Windows would produce a Windows binary with a Linux label.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = join(import.meta.dirname, '..', '..')
const dist = join(root, 'dist')
const stage = join(dist, 'pkg-linux', 'ai-debate-linux-x64')
const work = join(dist, 'sea-linux')
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
const OUT = join(dist, 'ai-debate-linux-x64.tgz')

function run(label, command, args) {
  process.stdout.write(`\n▶ ${label}\n`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false })
  if (result.error) throw new Error(`${label} 无法启动：${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label} 失败（退出码 ${result.status}）`)
}

function collectAssets(baseDir, prefix) {
  const assets = {}
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else assets[`${prefix}/${relative(baseDir, full).split(sep).join('/')}`] = full
    }
  }
  walk(baseDir)
  return assets
}

if (process.platform !== 'linux') {
  process.stderr.write('✖ 这个脚本必须在 Linux x86-64 上运行（GitHub Actions ubuntu runner 或 Linux 主机）。\n')
  process.exit(2)
}
if (process.arch !== 'x64') {
  process.stderr.write(`✖ 当前架构是 ${process.arch}，v0.1.0 只发布 x64。\n`)
  process.exit(2)
}

rmSync(stage, { recursive: true, force: true })
rmSync(work, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
mkdirSync(work, { recursive: true })
mkdirSync(join(stage, 'bin'), { recursive: true })
mkdirSync(join(stage, 'systemd'), { recursive: true })
mkdirSync(join(stage, 'logrotate'), { recursive: true })

run('构建 core', 'node', [join('scripts', 'build-core.mjs')])
run('构建 Web 控制台', 'node', [join('scripts', 'build-web.mjs')])
run('打包服务端', 'node', [join('scripts', 'bundle-server.mjs')])

const entry = join(dist, 'ai-debate.cjs')
if (!existsSync(entry)) throw new Error('缺少 dist/ai-debate.cjs')
const webRoot = join(dist, 'web')
if (!existsSync(join(webRoot, 'index.html'))) throw new Error('缺少 dist/web/index.html')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const assets = collectAssets(webRoot, 'web')
const manifestPath = join(webRoot, 'manifest.json')
writeFileSync(manifestPath, JSON.stringify({ version: pkg.version, assets: Object.keys(assets) }, null, 2))
assets['web/manifest.json'] = manifestPath

const seaConfigPath = join(work, 'sea-config.json')
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    { main: entry, output: join(work, 'ai-debate.blob'), disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets },
    null,
    2,
  ),
)
run('生成 SEA 准备块', process.execPath, ['--experimental-sea-config', seaConfigPath])

const binary = join(stage, 'bin', 'ai-debate')
copyFileSync(process.execPath, binary)
const postject = join(root, 'node_modules', 'postject', 'dist', 'cli.js')
run('注入 SEA 准备块', process.execPath, [postject, binary, 'NODE_SEA_BLOB', join(work, 'ai-debate.blob'), '--sentinel-fuse', FUSE])
spawnSync('chmod', ['+x', binary])

for (const file of ['install.sh', 'uninstall.sh']) {
  copyFileSync(join(root, 'packaging', 'linux', file), join(stage, file))
  spawnSync('chmod', ['+x', join(stage, file)])
}
copyFileSync(join(root, 'packaging', 'linux', 'ai-debate.service'), join(stage, 'systemd', 'ai-debate.service'))
copyFileSync(join(root, 'packaging', 'linux', 'ai-debate.logrotate'), join(stage, 'logrotate', 'ai-debate'))
copyFileSync(join(root, 'README.md'), join(stage, 'README.md'))
copyFileSync(join(root, 'LICENSE'), join(stage, 'LICENSE'))
copyFileSync(join(root, 'NOTICE'), join(stage, 'NOTICE'))
if (existsSync(join(root, 'docs'))) {
  mkdirSync(join(stage, 'docs'), { recursive: true })
  for (const name of readdirSync(join(root, 'docs'))) {
    const src = join(root, 'docs', name)
    if (statSync(src).isFile() && name.endsWith('.md')) copyFileSync(src, join(stage, 'docs', name))
  }
}

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else files.push(full)
  }
}
walk(stage)
const lines = files
  .filter((file) => !file.endsWith('SHA256SUMS'))
  .sort()
  .map((file) => `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${relative(stage, file).split(sep).join('/')}`)
writeFileSync(join(stage, 'SHA256SUMS'), lines.join('\n') + '\n')

run('打包 tar.gz', 'tar', ['-czf', OUT, '-C', join(dist, 'pkg-linux'), 'ai-debate-linux-x64'])

const hash = createHash('sha256').update(readFileSync(OUT)).digest('hex')
writeFileSync(`${OUT}.sha256`, `${hash}  ai-debate-linux-x64.tgz\n`)

// The archive must be installable, not merely built: unpack it in a scratch
// prefix and prove the binary runs there without the development tree.
const smoke = join(dist, 'smoke-linux')
rmSync(smoke, { recursive: true, force: true })
mkdirSync(smoke, { recursive: true })
run('解包冒烟', 'tar', ['-xzf', OUT, '-C', smoke])
run('冒烟：--version', join(smoke, 'ai-debate-linux-x64', 'bin', 'ai-debate'), ['--version'])

const size = statSync(OUT).size
process.stdout.write(`\n✔ ai-debate-linux-x64.tgz  ${(size / 1024 / 1024).toFixed(1)} MB\n✔ sha256 ${hash}\n`)
