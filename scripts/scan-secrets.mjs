/**
 * Refuse to publish credentials, cookies or user state.
 *
 * Modes:
 *   - no target: scan tracked files (CI on every push).
 *   - one or more files/directories: scan those artefacts before publication.
 *   - --baseline <node-binary>: for an explicitly named SEA executable, ignore
 *     only matches whose exact bytes already exist at the same offset in the
 *     trusted Node runtime. Every changed or appended byte is still scanned.
 *     A target that is not demonstrably derived from the baseline fails closed.
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
  'scripts/scan-secrets.mjs',
  'test/acceptance/fixtures/README.md',
])

const MAX_TEXT_BYTES = 4 * 1024 * 1024
const BINARY_CHUNK_BYTES = 4 * 1024 * 1024
const BINARY_OVERLAP_BYTES = 4096
const MIN_BASELINE_SIMILARITY = 0.99

function parseArgs(argv) {
  const targets = []
  let baseline
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--baseline') {
      baseline = argv[index + 1]
      if (baseline === undefined || baseline === '') throw new Error('--baseline 需要一个文件路径')
      index += 1
    } else if (arg.startsWith('--baseline=')) {
      baseline = arg.slice('--baseline='.length)
      if (baseline === '') throw new Error('--baseline 需要一个文件路径')
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('用法: node scripts/scan-secrets.mjs [--baseline <node-binary>] [文件或目录 ...]\n')
      process.exit(0)
    } else {
      targets.push(arg)
    }
  }
  return { targets, baseline }
}

/** Every regular file under dir, relative to dir, following no symlinks. */
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

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((file) => !ALLOW.has(file))
    .map((file) => ({ full: file, label: file, skipLarge: true, allowBaseline: false }))
}

function explicitFiles(targets) {
  const files = []
  for (const target of targets) {
    const info = statSync(target)
    if (info.isFile()) {
      files.push({ full: target, label: target, skipLarge: false, allowBaseline: true })
    } else if (info.isDirectory()) {
      for (const rel of walk(target)) {
        files.push({ full: join(target, rel), label: join(target, rel), skipLarge: true, allowBaseline: false })
      }
    } else {
      throw new Error(`目标不是普通文件或目录: ${target}`)
    }
  }
  return files
}

function validateBaseline(target, baseline) {
  if (target.length < baseline.length) {
    throw new Error('SEA 目标小于 Node 基线，拒绝按基线扫描')
  }
  let same = 0
  for (let index = 0; index < baseline.length; index += 1) {
    if (target[index] === baseline[index]) same += 1
  }
  const similarity = same / baseline.length
  if (similarity < MIN_BASELINE_SIMILARITY) {
    throw new Error(`SEA 目标与 Node 基线相似度不足 ${(MIN_BASELINE_SIMILARITY * 100).toFixed(0)}%，拒绝按基线扫描`)
  }
  return similarity
}

function* matches(text, expression) {
  const global = new RegExp(expression.source, `${expression.flags}g`)
  yield* text.matchAll(global)
}

function scanBuffer(data, label, baseline, allowBaseline) {
  const binary = data.includes(0)
  const findings = []
  const seen = new Set()
  let ignoredBaselineMatches = 0
  let baselineSimilarity

  if (allowBaseline && baseline !== undefined && binary) {
    baselineSimilarity = validateBaseline(data, baseline)
  }

  if (!binary) {
    const text = data.toString('utf8')
    for (const rule of RULES) {
      for (const match of matches(text, rule.re)) {
        const line = text.slice(0, match.index).split('\n').length
        findings.push(`${label}:${line}  ${rule.name}`)
      }
    }
    return { findings, ignoredBaselineMatches, baselineSimilarity }
  }

  for (let offset = 0; offset < data.length; offset += BINARY_CHUNK_BYTES) {
    const end = Math.min(data.length, offset + BINARY_CHUNK_BYTES + BINARY_OVERLAP_BYTES)
    const text = data.subarray(offset, end).toString('latin1')
    for (const rule of RULES) {
      for (const match of matches(text, rule.re)) {
        const start = offset + match.index
        const key = `${rule.name}:${start}`
        if (seen.has(key)) continue
        seen.add(key)
        const matchEnd = start + match[0].length
        if (baselineSimilarity !== undefined && matchEnd <= baseline.length) {
          const unchanged = data.subarray(start, matchEnd).equals(baseline.subarray(start, matchEnd))
          if (unchanged) {
            ignoredBaselineMatches += 1
            continue
          }
        }
        findings.push(`${label}@${start}  ${rule.name}`)
      }
    }
  }
  return { findings, ignoredBaselineMatches, baselineSimilarity }
}

function main() {
  const { targets, baseline: baselinePath } = parseArgs(process.argv.slice(2))
  const tracked = targets.length === 0
  const files = tracked ? trackedFiles() : explicitFiles(targets)
  const baseline = baselinePath === undefined ? undefined : readFileSync(baselinePath)
  const findings = []
  let ignoredBaselineMatches = 0
  let baselineComparisons = 0
  let scanned = 0

  for (const file of files) {
    let size
    try {
      size = statSync(file.full).size
    } catch {
      continue
    }
    if (file.skipLarge && size > MAX_TEXT_BYTES) continue
    let data
    try {
      data = readFileSync(file.full)
    } catch {
      continue
    }
    scanned += 1
    const result = scanBuffer(data, file.label, baseline, file.allowBaseline)
    findings.push(...result.findings)
    ignoredBaselineMatches += result.ignoredBaselineMatches
    if (result.baselineSimilarity !== undefined) baselineComparisons += 1
  }

  if (findings.length > 0) {
    process.stderr.write('✖ 发现疑似凭据，禁止发布：\n')
    for (const finding of findings) process.stderr.write(`  ${finding}\n`)
    process.exit(1)
  }

  const scope = tracked
    ? `${scanned} 个受版本控制的文件`
    : `${scanned} 个目标文件`
  const baselineNote = baselineComparisons === 0
    ? ''
    : `；${baselineComparisons} 个 SEA 目标按 Node 基线差分，忽略 ${ignoredBaselineMatches} 条运行时原字节匹配`
  process.stdout.write(`✔ 凭据扫描通过（${scope}${baselineNote}）\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`✖ 凭据扫描失败: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
