/**
 * Build the Windows single-file executable.
 *
 * Steps: compile core → bundle the web console → bundle the server into one CJS
 * file → build a Node SEA preparation blob (server script + web assets) → inject
 * the blob into a pristine node.exe → checksum.
 *
 * Nothing here requires the developer's machine to provide a runtime for the
 * finished artefact: the produced .exe carries the Node runtime inside it.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = join(import.meta.dirname, '..', '..')
const dist = join(root, 'dist')
const work = join(dist, 'sea-windows')
const OUT = join(dist, 'AI-Debate-windows-x64.exe')
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

function run(label, command, args, options = {}) {
  process.stdout.write(`\n▶ ${label}\n`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false, ...options })
  if (result.error) throw new Error(`${label} 无法启动：${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label} 失败（退出码 ${result.status}）`)
}

/** Collect every file under a directory as SEA asset entries keyed by POSIX-ish path. */
function collectAssets(baseDir, prefix) {
  const assets = {}
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full)
      else assets[`${prefix}/${relative(baseDir, full).split(sep).join('/')}`] = full
    }
  }
  walk(baseDir)
  return assets
}

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
mkdirSync(dist, { recursive: true })

run('构建 core', 'node', [join('scripts', 'build-core.mjs')])
run('构建 Web 控制台', 'node', [join('scripts', 'build-web.mjs')])
run('打包服务端', 'node', [join('scripts', 'bundle-server.mjs')])

const entry = join(dist, 'ai-debate.cjs')
if (!existsSync(entry)) throw new Error('缺少 dist/ai-debate.cjs，bundle-server.mjs 未产出')

const webRoot = join(dist, 'web')
if (!existsSync(join(webRoot, 'index.html'))) throw new Error('缺少 dist/web/index.html，Web 控制台未产出')

// The manifest is what the runtime uses to answer "does this asset exist" without
// guessing at key names. It is generated here rather than checked in, so it can
// never drift from the files actually embedded.
const assets = collectAssets(webRoot, 'web')
const manifest = { version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, assets: Object.keys(assets) }
const manifestPath = join(webRoot, 'manifest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
assets['web/manifest.json'] = manifestPath

const seaConfig = {
  main: entry,
  output: join(work, 'ai-debate.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
}
const seaConfigPath = join(work, 'sea-config.json')
writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2))

run('生成 SEA 准备块', process.execPath, ['--experimental-sea-config', seaConfigPath])

const target = join(work, 'ai-debate.exe')
const nodeExe = process.env.AI_DEBATE_NODE_EXE || process.execPath
copyFileSync(nodeExe, target)

const postject = join(root, 'node_modules', 'postject', 'dist', 'cli.js')
if (!existsSync(postject)) throw new Error('缺少 postject，请先 npm install')
run('注入 SEA 准备块', process.execPath, [postject, target, 'NODE_SEA_BLOB', join(work, 'ai-debate.blob'), '--sentinel-fuse', FUSE])

copyFileSync(target, OUT)
const hash = createHash('sha256').update(readFileSync(OUT)).digest('hex')
writeFileSync(`${OUT}.sha256`, `${hash}  ${basename(OUT)}\n`)
writeFileSync(join(dist, 'AI-Debate-windows-x64.sha256.txt'), `${hash}  ${basename(OUT)}\n`)

run('冒烟：--version', OUT, ['--version'])
run('冒烟：--help', OUT, ['--help'])

const size = statSync(OUT).size
process.stdout.write(`\n✔ ${basename(OUT)}  ${(size / 1024 / 1024).toFixed(1)} MB\n✔ sha256 ${hash}\n`)
