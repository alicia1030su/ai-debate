/**
 * Refuse to publish credentials, cookies or user state.
 *
 * Runs on tracked files only: a build artefact that happens to contain a token is
 * not a repository leak, but a committed one is. The patterns are deliberately
 * narrow — a false positive here blocks a release, so each rule targets a shape
 * that only a real secret has.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const RULES = [
  { name: 'Tieba cookie', re: /(?:^|[^A-Za-z0-9])BDUSS(?:_BF)?=[A-Za-z0-9%._-]{16,}/ },
  { name: 'Weibo cookie', re: /SUB=(?:_2A25)?[A-Za-z0-9%._-]{20,}/ },
  { name: 'OpenAI-style key', re: /sk-[A-Za-z0-9_-]{24,}/ },
  { name: 'Bearer token', re: /Bearer\s+[A-Za-z0-9._-]{30,}/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
]

/** Paths that are allowed to *describe* the patterns, not carry them. */
const ALLOW = new Set([
  // Documents the patterns themselves.
  'scripts/scan-secrets.mjs',
  'test/acceptance/fixtures/README.md',
])

/**
 * Two modes:
 *
 *   - no argument: scan the tracked files, which is what CI runs on every push.
 *   - one directory: scan that tree, which is how a *built archive* is checked
 *     before it is published. Tracked files can be clean while an artefact carries
 *     something that was never committed.
 */
const rootArg = process.argv[2]

/** Every regular file under `dir`, relative to `dir`, following no symlinks. */
function walk(dir, prefix = '', out = [], depth = 0) {
  if (depth > 8 || out.length > 5000) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) walk(join(dir, entry.name), rel, out, depth + 1)
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

const files =
  typeof rootArg === 'string' && rootArg !== ''
    ? walk(rootArg)
    : execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
        .split('\0')
        .filter(Boolean)
        .filter((file) => !ALLOW.has(file))
const base = typeof rootArg === 'string' && rootArg !== '' ? rootArg : ''

const MAX_BYTES = 4 * 1024 * 1024
const findings = []

for (const file of files) {
  const full = base === '' ? file : join(base, file)
  let size
  try {
    size = statSync(full).size
  } catch {
    continue
  }
  if (size > MAX_BYTES) continue
  let text
  try {
    text = readFileSync(full, 'utf8')
  } catch {
    continue
  }
  // Binary blobs (fonts, images, the node binary) are not text and are not where a
  // credential would be committed in a readable form.
  if (text.includes('\0')) continue
  for (const rule of RULES) {
    const match = rule.re.exec(text)
    if (match === null) continue
    const index = match.index
    const line = text.slice(0, index).split('\n').length
    findings.push(`${file}:${line}  ${rule.name}`)
  }
}

if (findings.length > 0) {
  process.stderr.write('✖ 发现疑似凭据，禁止发布：\n')
  for (const finding of findings) process.stderr.write(`  ${finding}\n`)
  process.exit(1)
}

process.stdout.write(
  base === ''
    ? `✔ 凭据扫描通过（${files.length} 个受版本控制的文件）\n`
    : `✔ 凭据扫描通过（${files.length} 个文件，目录 ${base}）\n`,
)
