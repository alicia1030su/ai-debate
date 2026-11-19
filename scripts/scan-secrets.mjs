/**
 * Refuse to publish credentials, cookies or user state.
 *
 * Runs on tracked files only: a build artefact that happens to contain a token is
 * not a repository leak, but a committed one is. The patterns are deliberately
 * narrow — a false positive here blocks a release, so each rule targets a shape
 * that only a real secret has.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'

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
const ALLOW = new Set(['scripts/scan-secrets.mjs', 'test/acceptance/fixtures/README.md'])

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => !ALLOW.has(file))

const MAX_BYTES = 4 * 1024 * 1024
const findings = []

for (const file of files) {
  let size
  try {
    size = statSync(file).size
  } catch {
    continue
  }
  if (size > MAX_BYTES) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
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

process.stdout.write(`✔ 凭据扫描通过（${files.length} 个受版本控制的文件）\n`)
