/**
 * Bundle the server into one CommonJS file.
 *
 * The SEA preparation step needs a single script with no import machinery, so the
 * bundle is CJS and every `node:*` import stays external (Node provides them; a
 * bundled copy of `node:fs` does not exist).
 *
 * The version is injected with `--define` rather than read from a file at run time:
 * inside a SEA there is no `package.json` next to the binary, and a version string
 * that silently becomes "0.0.0-unknown" is exactly the kind of quiet wrong answer
 * this project keeps trying to avoid.
 */
import { build } from 'esbuild'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DIST = path.join(ROOT, 'dist')
const WEB_SRC = path.join(ROOT, 'packages', 'web', 'static')
const WEB_OUT = path.join(DIST, 'web')

async function copyTree(from, to, files = []) {
  for (const name of await readdir(from)) {
    const source = path.join(from, name)
    const target = path.join(to, name)
    const info = await stat(source)
    if (info.isDirectory()) {
      await mkdir(target, { recursive: true })
      await copyTree(source, target, files)
    } else {
      await copyFile(source, target)
      files.push(target)
    }
  }
  return files
}

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
await mkdir(DIST, { recursive: true })
await mkdir(WEB_OUT, { recursive: true })
const copied = await copyTree(WEB_SRC, WEB_OUT)

const assets = copied.map((file) => `web/${path.relative(WEB_OUT, file).split(path.sep).join('/')}`)
await writeFile(path.join(WEB_OUT, 'manifest.json'), `${JSON.stringify({ version: pkg.version, assets }, null, 2)}\n`)

const result = await build({
  entryPoints: [path.join(ROOT, 'apps', 'desktop', 'src', 'main.ts')],
  outfile: path.join(DIST, 'ai-debate.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['node:sea'],
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  define: {
    'process.env.AI_DEBATE_VERSION': JSON.stringify(pkg.version),
    __AI_DEBATE_VERSION__: JSON.stringify(pkg.version),
  },
  logLevel: 'warning',
})

if (result.errors.length > 0) {
  process.stderr.write(`${result.errors.map((error) => error.text).join('\n')}\n`)
  process.exit(1)
}

const size = (await stat(path.join(DIST, 'ai-debate.cjs'))).size
const digest = createHash('sha256').update(await readFile(path.join(DIST, 'ai-debate.cjs'))).digest('hex').slice(0, 16)
process.stdout.write(`✔ dist/ai-debate.cjs  ${(size / 1024).toFixed(0)} KB  sha256:${digest}\n`)
process.stdout.write(`✔ dist/web  ${assets.length} 个静态资源\n`)
