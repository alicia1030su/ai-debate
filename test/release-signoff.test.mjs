import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runViewArguments, sha256, verifyReleaseSignoff } from '../scripts/verify-release-signoff.mjs'

const REQUIRED_FREEZE_FILES = [
  'package.json',
  'package-lock.json',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  'packages/core/src/store.ts',
  'packages/core/src/runtime.ts',
  'packages/core/src/index.ts',
  'packages/core/src/product-api.ts',
  'packages/server/src/monitor/engine.ts',
  'scripts/run-soak.mjs',
  'scripts/verify-release-signoff.mjs',
  'test/stress/soak-v022.ts',
  'test/run-soak.test.mjs',
  'test/release-signoff.test.mjs',
]
const REQUIRED_JOBS = [
  'Credential and privacy scan',
  'Test (windows-latest)',
  'Test (ubuntu-22.04)',
  'Test (ubuntu-24.04)',
  'Upgrade from real v0.2.1 (v0.2.0 compatibility)',
  'Package Windows executable',
  'Package and install (ubuntu-24.04)',
  'Package and install (ubuntu-22.04)',
  'Soak (short, CI)',
  'Debian 12 binary compatibility (no systemd)',
]

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function write(root, path, contents) {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, contents)
}

function json(root, path, value) {
  write(root, path, `${JSON.stringify(value, null, 2)}\n`)
}

function successfulRun(candidateCommit, overrides = {}) {
  return {
    headSha: candidateCommit,
    status: 'completed',
    conclusion: 'success',
    jobs: REQUIRED_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success', completedAt: '2026-11-22T11:59:00Z' })),
    ...overrides,
  }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ai-debate-signoff-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '-q')
  git(root, 'config', 'user.name', 'Signoff Test')
  git(root, 'config', 'user.email', 'signoff@example.invalid')
  for (const path of REQUIRED_FREEZE_FILES) write(root, path, `frozen ${path}\n`)
  write(root, 'README.md', 'candidate\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'candidate')
  const candidateCommit = git(root, 'rev-parse', 'HEAD')

  const freezeLines = REQUIRED_FREEZE_FILES.map((path) => `${sha256(readFileSync(join(root, path)))}  ${path}`)
  const freezeBytes = `${freezeLines.join('\n')}\n`
  write(root, 'docs/evidence/freeze.txt', freezeBytes)

  const soak = {
    schemaVersion: 1,
    tool: 'soak-v022',
    status: 'passed',
    completed: true,
    monitors: 1_000,
    threads: 25,
    seed: 1,
    requestedSeconds: 86_400,
    killEverySeconds: 300,
    noKill: false,
    resumed: true,
    resumedAfterFailure: false,
    drainTimeoutMs: 300_000,
    drainSeconds: 5,
    drainTimedOut: false,
    queueAtEnd: 0,
    pendingAtEnd: 0,
    engine: { queued: 0, runningTasks: 0 },
    actualStartedAt: '2026-11-20T12:00:00.000Z',
    actualEndedAt: '2026-11-21T12:00:20.000Z',
    wallClockSeconds: 86_420,
    activeSeconds: 86_410,
    downtimeSeconds: 10,
    maxTickActiveMs: 1_200,
    tickActiveLimitMs: 15_000,
    maxTickGapMs: 1_500,
    kills: 286,
    restarts: 286,
    faults: { process_kill: { actual: 286, skipped: 0 } },
    supervisor: {
      startedAt: '2026-11-20T12:00:00.000Z',
      endedAt: '2026-11-21T12:00:20.000Z',
      wallClockSeconds: 86_420,
      activeSeconds: 86_410,
      downtimeSeconds: 10,
      maxRestartGapMs: 500,
      maxTickGapMs: 1_500,
      maxTickActiveMs: 1_200,
      tickActiveLimitMs: 15_000,
      drainTimeoutMs: 300_000,
      drainSeconds: 5,
      drainTimedOut: false,
      maxTotalDowntimeMs: 1_800_000,
      maxRestarts: 1_000,
      maxStateAgeMs: 15_000,
      maxRestartGapLimitMs: 30_000,
      attempts: 287,
      restarts: 286,
      kills: 286,
      unplannedInterruptions: 0,
      watchdog: {
        triggered: false,
        reason: '',
        samples: 300,
        missingEvents: 0,
        staleEvents: 0,
        maxObservedStateAgeMs: 1_000,
        maxSteadyStateAgeMs: 1_000,
        maxTickGapMs: 1_500,
      },
    },
    duplicateCandidates: 0,
    lostTasks: 0,
    convergenceLag: 0,
    stuckIdentity: 0,
    coreLockTimeouts: 0,
    cursorRegressions: 0,
    completedTaskReexecutions: 0,
    unrecordedInterruptions: 0,
    unhandledErrors: 0,
    invariants: {
      uniqueReplyCandidates: true,
      completedTasksNotReexecuted: true,
      cursorNeverRegresses: true,
      interruptedTasksRecorded: true,
      queueWithinCapacity: true,
      heapWithinThreshold: true,
      noUnhandledErrors: true,
      noCoreLockTimeouts: true,
      noLostTasks: true,
      noStuckIdentity: true,
      noIdentityLedgerDrift: true,
      noTaskLedgerDrift: true,
      noStoreCorruption: true,
      diskFailuresDegraded: true,
      activeTicksWithinLimit: true,
      drainConverged: true,
    },
    invariantFailures: [],
  }
  json(root, 'docs/evidence/soak-report.json', soak)
  json(root, 'docs/evidence/soak-supervisor.json', {
    schemaVersion: 1,
    startedAt: soak.supervisor.startedAt,
    requestedSeconds: 86_400,
    effectiveDeadline: '2026-11-21T12:00:10.000Z',
    completed: true,
    attempts: 287,
    restarts: 286,
    kills: 286,
    activeMs: 86_410_000,
    maxTickActiveMs: 1_200,
    tickActiveLimitMs: 15_000,
    drainTimeoutMs: 300_000,
    drainSeconds: 5,
    drainTimedOut: false,
    maxTotalDowntimeMs: 1_800_000,
    maxRestarts: 1_000,
    maxStateAgeMs: 15_000,
    maxRestartGapLimitMs: 30_000,
    downtimeMs: 10_000,
    maxRestartGapMs: 500,
    unplannedInterruptions: 0,
    watchdog: {
      triggered: false,
      reason: '',
      samples: 300,
      missingEvents: 0,
      staleEvents: 0,
      maxObservedStateAgeMs: 1_000,
      maxSteadyStateAgeMs: 1_000,
      maxTickGapMs: 1_500,
    },
  })
  const qa = {
    schemaVersion: 1,
    tool: 'ai-debate-qa',
    version: '0.2.2',
    status: 'PASS',
    candidateCommit,
    suites: {
      typecheck: 'pass',
      core: { passed: 227, failed: 0 },
      server: { passed: 166, failed: 0 },
      web: { passed: 12, failed: 0 },
      standalone: { passed: 27, failed: 0 },
      automation: { passed: 8, failed: 0 },
      recovery: { passed: 8, failed: 0 },
      paging: { passed: 7, failed: 0 },
      upgrade: { passed: 97, failed: 0, identityMigration: 'migrated', modelCalls: 0 },
      soakSelfTests: { passed: 8, failed: 0 },
      supervisor: { passed: 6, failed: 0 },
      secrets: { passed: 12, failed: 0 },
    },
    finalExeUpgrade: {
      sha256: 'a'.repeat(64),
      runs: Array.from({ length: 5 }, () => ({ passed: 97, failed: 0, modelCalls: 0, sha256: 'a'.repeat(64) })),
    },
  }
  json(root, 'docs/evidence/qa-report.json', qa)
  const signoff = {
    schemaVersion: 1,
    version: '0.2.2',
    status: 'GO',
    tag: 'v0.2.2',
    candidateCommit,
    freeze: { path: 'docs/evidence/freeze.txt', sha256: sha256(Buffer.from(freezeBytes)) },
    soak: {
      reportPath: 'docs/evidence/soak-report.json',
      reportSha256: sha256(readFileSync(join(root, 'docs/evidence/soak-report.json'))),
      supervisorStatePath: 'docs/evidence/soak-supervisor.json',
      supervisorStateSha256: sha256(readFileSync(join(root, 'docs/evidence/soak-supervisor.json'))),
      wallClockSeconds: soak.wallClockSeconds,
      activeSeconds: soak.activeSeconds,
      downtimeSeconds: soak.downtimeSeconds,
      maxTickActiveMs: soak.maxTickActiveMs,
      maxTickGapMs: soak.maxTickGapMs,
      drainTimeoutMs: soak.drainTimeoutMs,
      drainSeconds: soak.drainSeconds,
      drainTimedOut: soak.drainTimedOut,
      kills: soak.kills,
      restarts: soak.restarts,
    },
    qa: {
      runId: 123,
      runUrl: 'https://github.com/example/ai-debate/actions/runs/123',
      headSha: candidateCommit,
      conclusion: 'success',
      requiredJobs: REQUIRED_JOBS,
      reportPath: 'docs/evidence/qa-report.json',
      reportSha256: sha256(readFileSync(join(root, 'docs/evidence/qa-report.json'))),
    },
    thresholds: {
      minWallClockSeconds: 86_400,
      minActiveSeconds: 86_400,
      maxTickActiveMs: 15_000,
      maxTickGapMs: 15_000,
      maxTotalDowntimeMs: 1_800_000,
      maxRestarts: 1_000,
      maxRestartGapMs: 30_000,
      maxDrainSeconds: 300,
    },
  }
  json(root, 'docs/release-signoff-v0.2.2.json', signoff)
  git(root, 'add', 'docs')
  git(root, 'commit', '-qm', 'signoff evidence')
  const tagCommit = git(root, 'rev-parse', 'HEAD')
  return { root, candidateCommit, tagCommit, signoff }
}

function verify(context, run = successfulRun(context.candidateCommit)) {
  const previous = process.env.GITHUB_REPOSITORY
  process.env.GITHUB_REPOSITORY = 'example/ai-debate'
  try {
    return verifyReleaseSignoff({
      root: context.root,
      currentCommit: context.tagCommit,
      expectedCandidateCommit: context.candidateCommit,
      expectedReleaseCommit: context.tagCommit,
      runVerifier: () => run,
    })
  } finally {
    if (previous === undefined) delete process.env.GITHUB_REPOSITORY
    else process.env.GITHUB_REPOSITORY = previous
  }
}

test('有效签字：候选树、冻结字节、Soak、QA 与 CI 精确匹配', (t) => {
  const context = fixture(t)
  const result = verify(context)
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('签字拒绝被篡改的 Soak 证据字节', (t) => {
  const context = fixture(t)
  write(context.root, 'docs/evidence/soak-report.json', '{"status":"passed","completed":true}\n')
  const result = verify(context)
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /Soak 报告 SHA256/)
})

test('签字拒绝 Tag 修改产品/构建文件', (t) => {
  const context = fixture(t)
  write(context.root, 'package.json', '{"version":"9.9.9"}\n')
  git(context.root, 'add', 'package.json')
  git(context.root, 'commit', '-qm', 'unsafe product change')
  const result = verifyReleaseSignoff({
    root: context.root,
    currentCommit: git(context.root, 'rev-parse', 'HEAD'),
    runVerifier: () => successfulRun(context.candidateCommit),
  })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /产品\/构建文件/)
})

test('gh run view 参数只请求真实支持字段', () => {
  const args = runViewArguments(123)
  assert.deepEqual(args, ['run', 'view', '123', '--json', 'headSha,conclusion,status,jobs'])
  const fields = args[args.indexOf('--json') + 1].split(',')
  assert.ok(!fields.includes('updatedAt'))
  assert.ok(!fields.includes('completedAt'))
})

test('签字拒绝 CI 状态、job 状态与完成时间不一致', (t) => {
  const context = fixture(t)
  assert.match(verify(context, successfulRun('b'.repeat(40))).errors.join('\n'), /CI headSha/)
  assert.match(verify(context, successfulRun(context.candidateCommit, { status: 'in_progress' })).errors.join('\n'), /CI status/)
  assert.match(verify(context, successfulRun(context.candidateCommit, { conclusion: 'failure' })).errors.join('\n'), /CI conclusion/)

  const missingJob = successfulRun(context.candidateCommit)
  missingJob.jobs.pop()
  assert.match(verify(context, missingJob).errors.join('\n'), /job 集合/)

  const runningJob = successfulRun(context.candidateCommit)
  runningJob.jobs[0].status = 'in_progress'
  assert.match(verify(context, runningJob).errors.join('\n'), /CI job .* status/)

  const failedJob = successfulRun(context.candidateCommit)
  failedJob.jobs[0].conclusion = 'failure'
  assert.match(verify(context, failedJob).errors.join('\n'), /CI job .* conclusion/)

  const missingJobCompleted = successfulRun(context.candidateCommit)
  delete missingJobCompleted.jobs[0].completedAt
  assert.match(verify(context, missingJobCompleted).errors.join('\n'), /CI job .* completedAt/)

  const invalidJobCompleted = successfulRun(context.candidateCommit)
  invalidJobCompleted.jobs[0].completedAt = 'not-a-date'
  assert.match(verify(context, invalidJobCompleted).errors.join('\n'), /CI job .* completedAt/)

  const mismatchedRunCompleted = successfulRun(context.candidateCommit, { completedAt: '2026-11-22T12:00:01Z' })
  assert.match(verify(context, mismatchedRunCompleted).errors.join('\n'), /completedAt 与必需 job 完成时间不一致/)
  const matchingRunCompleted = successfulRun(context.candidateCommit, { completedAt: '2026-11-22T11:59:00Z' })
  assert.equal(verify(context, matchingRunCompleted).ok, true)

  const extraJob = successfulRun(context.candidateCommit)
  extraJob.jobs.push({ name: 'Unexpected', status: 'completed', conclusion: 'success', completedAt: '2026-11-22T11:59:00Z' })
  assert.match(verify(context, extraJob).errors.join('\n'), /job 集合/)

  const duplicateJob = successfulRun(context.candidateCommit)
  duplicateJob.jobs[duplicateJob.jobs.length - 1].name = duplicateJob.jobs[0].name
  assert.match(verify(context, duplicateJob).errors.join('\n'), /job 名称重复/)
})

test('签字拒绝阈值篡改、严格不变量非零与 QA 最终 EXE 复验次数不足', (t) => {
  const context = fixture(t)
  const signoffPath = join(context.root, 'docs/release-signoff-v0.2.2.json')
  const signoff = JSON.parse(readFileSync(signoffPath, 'utf8'))
  signoff.thresholds.minActiveSeconds = 86_411
  json(context.root, 'docs/release-signoff-v0.2.2.json', signoff)
  assert.match(verify(context).errors.join('\n'), /minActiveSeconds/)

  const qaPath = join(context.root, 'docs/evidence/qa-report.json')
  const qa = JSON.parse(readFileSync(qaPath, 'utf8'))
  qa.finalExeUpgrade.runs.pop()
  json(context.root, 'docs/evidence/qa-report.json', qa)
  const updated = JSON.parse(readFileSync(signoffPath, 'utf8'))
  updated.thresholds.minActiveSeconds = 86_400
  updated.qa.reportSha256 = sha256(readFileSync(qaPath))
  json(context.root, 'docs/release-signoff-v0.2.2.json', updated)
  assert.match(verify(context).errors.join('\n'), /至少 5 次/)
})

test('签字拒绝排空超时、截止后仍有任务与严格不变量非零', (t) => {
  const context = fixture(t)
  const reportPath = join(context.root, 'docs/evidence/soak-report.json')
  const signoffPath = join(context.root, 'docs/release-signoff-v0.2.2.json')
  const original = JSON.parse(readFileSync(reportPath, 'utf8'))
  const mutateSoak = (mutate) => {
    const soak = structuredClone(original)
    mutate(soak)
    json(context.root, 'docs/evidence/soak-report.json', soak)
    const signoff = JSON.parse(readFileSync(signoffPath, 'utf8'))
    signoff.soak.reportSha256 = sha256(readFileSync(reportPath))
    json(context.root, 'docs/release-signoff-v0.2.2.json', signoff)
    return verify(context).errors.join('\n')
  }
  assert.match(mutateSoak((soak) => { soak.drainTimedOut = true }), /drainTimedOut/)
  assert.match(mutateSoak((soak) => { soak.queueAtEnd = 1 }), /queueAtEnd/)
  assert.match(mutateSoak((soak) => { soak.engine.runningTasks = 1 }), /engine.runningTasks/)
  assert.match(mutateSoak((soak) => { soak.coreLockTimeouts = 1 }), /coreLockTimeouts/)
  assert.match(mutateSoak((soak) => { soak.lostTasks = 1 }), /lostTasks/)
  assert.match(mutateSoak((soak) => { soak.stuckIdentity = 1 }), /stuckIdentity/)
  assert.match(mutateSoak((soak) => { soak.invariants.drainConverged = false }), /drainConverged/)
})

test('签字拒绝任一固定发布阈值被改写', (t) => {
  const context = fixture(t)
  const reportPath = join(context.root, 'docs/evidence/soak-report.json')
  const supervisorPath = join(context.root, 'docs/evidence/soak-supervisor.json')
  const qaPath = join(context.root, 'docs/evidence/qa-report.json')
  const signoffPath = join(context.root, 'docs/release-signoff-v0.2.2.json')
  const originalSignoff = JSON.parse(readFileSync(signoffPath, 'utf8'))
  const refreshAllHashes = () => {
    const signoff = JSON.parse(readFileSync(signoffPath, 'utf8'))
    signoff.soak.reportSha256 = sha256(readFileSync(reportPath))
    signoff.soak.supervisorStateSha256 = sha256(readFileSync(supervisorPath))
    signoff.qa.reportSha256 = sha256(readFileSync(qaPath))
    json(context.root, 'docs/release-signoff-v0.2.2.json', signoff)
  }
  for (const [key, expected] of Object.entries(originalSignoff.thresholds)) {
    const signoff = structuredClone(originalSignoff)
    signoff.thresholds[key] = expected + 1
    json(context.root, 'docs/release-signoff-v0.2.2.json', signoff)
    refreshAllHashes()
    const result = verify(context)
    assert.equal(result.ok, false, `阈值 ${key} 被改写后仍通过`)
    assert.match(result.errors.join('\n'), new RegExp(`签字阈值 ${key}`))
  }
})

test('签字拒绝旧报告标识与 report/persisted/signoff 逐字段漂移', (t) => {
  const context = fixture(t)
  const reportPath = join(context.root, 'docs/evidence/soak-report.json')
  const supervisorPath = join(context.root, 'docs/evidence/soak-supervisor.json')
  const qaPath = join(context.root, 'docs/evidence/qa-report.json')
  const signoffPath = join(context.root, 'docs/release-signoff-v0.2.2.json')
  const originalReport = JSON.parse(readFileSync(reportPath, 'utf8'))
  const originalSupervisor = JSON.parse(readFileSync(supervisorPath, 'utf8'))
  const originalSignoff = JSON.parse(readFileSync(signoffPath, 'utf8'))
  const reset = () => {
    json(context.root, 'docs/evidence/soak-report.json', originalReport)
    json(context.root, 'docs/evidence/soak-supervisor.json', originalSupervisor)
    json(context.root, 'docs/release-signoff-v0.2.2.json', originalSignoff)
  }
  const refreshAllHashes = () => {
    const signoff = JSON.parse(readFileSync(signoffPath, 'utf8'))
    signoff.soak.reportSha256 = sha256(readFileSync(reportPath))
    signoff.soak.supervisorStateSha256 = sha256(readFileSync(supervisorPath))
    signoff.qa.reportSha256 = sha256(readFileSync(qaPath))
    json(context.root, 'docs/release-signoff-v0.2.2.json', signoff)
  }
  const assertRejected = (label, mutate) => {
    reset()
    const report = structuredClone(originalReport)
    const supervisor = structuredClone(originalSupervisor)
    const signoff = structuredClone(originalSignoff)
    mutate({ report, supervisor, signoff })
    json(context.root, 'docs/evidence/soak-report.json', report)
    json(context.root, 'docs/evidence/soak-supervisor.json', supervisor)
    json(context.root, 'docs/release-signoff-v0.2.2.json', signoff)
    refreshAllHashes()
    const result = verify(context)
    assert.equal(result.ok, false, `${label} 刷新 SHA 后仍通过`)
    assert.ok(result.errors.length > 0, `${label} 缺少拒绝原因`)
  }

  for (const field of ['schemaVersion', 'tool']) {
    assertRejected(`report.${field} 缺失`, ({ report }) => { delete report[field] })
    assertRejected(`report.${field} 篡改`, ({ report }) => { report[field] = field === 'schemaVersion' ? 2 : 'old-soak' })
  }

  const persistedMutations = {
    schemaVersion: (value) => { value.schemaVersion = 2 },
    completed: (value) => { value.completed = false },
    startedAt: (value) => { value.startedAt = '2026-11-20T11:59:59.000Z' },
    requestedSeconds: (value) => { value.requestedSeconds = 86_401 },
    attempts: (value) => { value.attempts += 1 },
    restarts: (value) => { value.restarts += 1 },
    kills: (value) => { value.kills += 1 },
    unplannedInterruptions: (value) => { value.unplannedInterruptions = 1 },
    activeMs: (value) => { value.activeMs += 1 },
    maxTickActiveMs: (value) => { value.maxTickActiveMs += 1 },
    tickActiveLimitMs: (value) => { value.tickActiveLimitMs += 1 },
    drainTimeoutMs: (value) => { value.drainTimeoutMs += 1 },
    drainSeconds: (value) => { value.drainSeconds += 1 },
    drainTimedOut: (value) => { value.drainTimedOut = true },
    downtimeMs: (value) => { value.downtimeMs += 1 },
    maxRestartGapMs: (value) => { value.maxRestartGapMs += 1 },
    maxTotalDowntimeMs: (value) => { value.maxTotalDowntimeMs += 1 },
    maxRestarts: (value) => { value.maxRestarts += 1 },
    maxStateAgeMs: (value) => { value.maxStateAgeMs += 1 },
    maxRestartGapLimitMs: (value) => { value.maxRestartGapLimitMs += 1 },
    'watchdog.triggered': (value) => { value.watchdog.triggered = true },
    'watchdog.missingEvents': (value) => { value.watchdog.missingEvents = 1 },
    'watchdog.staleEvents': (value) => { value.watchdog.staleEvents = 1 },
    'watchdog.maxTickGapMs': (value) => { value.watchdog.maxTickGapMs = 60_000 },
    'watchdog.maxSteadyStateAgeMs': (value) => { value.watchdog.maxSteadyStateAgeMs = 16_000 },
  }
  for (const [field, mutate] of Object.entries(persistedMutations)) {
    assertRejected(`persisted supervisor.${field}`, ({ supervisor }) => mutate(supervisor))
  }

  const embeddedMutations = {
    startedAt: (value) => { value.startedAt = '2026-11-20T11:59:59.000Z' },
    attempts: (value) => { value.attempts += 1 },
    restarts: (value) => { value.restarts += 1 },
    kills: (value) => { value.kills += 1 },
    unplannedInterruptions: (value) => { value.unplannedInterruptions = 1 },
    activeSeconds: (value) => { value.activeSeconds += 1 },
    downtimeSeconds: (value) => { value.downtimeSeconds += 1 },
    wallClockSeconds: (value) => { value.wallClockSeconds += 1 },
    maxTickActiveMs: (value) => { value.maxTickActiveMs += 1 },
    tickActiveLimitMs: (value) => { value.tickActiveLimitMs += 1 },
    maxTickGapMs: (value) => { value.maxTickGapMs += 1 },
    drainTimeoutMs: (value) => { value.drainTimeoutMs += 1 },
    drainSeconds: (value) => { value.drainSeconds += 1 },
    drainTimedOut: (value) => { value.drainTimedOut = true },
    maxRestartGapMs: (value) => { value.maxRestartGapMs += 1 },
    maxTotalDowntimeMs: (value) => { value.maxTotalDowntimeMs += 1 },
    maxRestarts: (value) => { value.maxRestarts += 1 },
    maxStateAgeMs: (value) => { value.maxStateAgeMs += 1 },
    maxRestartGapLimitMs: (value) => { value.maxRestartGapLimitMs += 1 },
    'watchdog.triggered': (value) => { value.watchdog.triggered = true },
    'watchdog.missingEvents': (value) => { value.watchdog.missingEvents = 1 },
    'watchdog.staleEvents': (value) => { value.watchdog.staleEvents = 1 },
    'watchdog.maxTickGapMs': (value) => { value.watchdog.maxTickGapMs = 60_000 },
    'watchdog.maxSteadyStateAgeMs': (value) => { value.watchdog.maxSteadyStateAgeMs = 16_000 },
  }
  for (const [field, mutate] of Object.entries(embeddedMutations)) {
    assertRejected(`report.supervisor.${field}`, ({ report }) => mutate(report.supervisor))
  }

  for (const field of ['wallClockSeconds', 'activeSeconds', 'downtimeSeconds', 'maxTickActiveMs', 'maxTickGapMs', 'drainTimeoutMs', 'drainSeconds', 'drainTimedOut', 'kills', 'restarts']) {
    assertRejected(`signoff.soak.${field}`, ({ signoff }) => {
      signoff.soak[field] = typeof signoff.soak[field] === 'boolean' ? true : signoff.soak[field] + 1
    })
  }
})

test('签字拒绝非法 kills/restarts/attempts 计数类型', (t) => {
  const context = fixture(t)
  const reportPath = join(context.root, 'docs/evidence/soak-report.json')
  const supervisorPath = join(context.root, 'docs/evidence/soak-supervisor.json')
  const qaPath = join(context.root, 'docs/evidence/qa-report.json')
  const signoffPath = join(context.root, 'docs/release-signoff-v0.2.2.json')
  const originalReport = JSON.parse(readFileSync(reportPath, 'utf8'))
  const originalSupervisor = JSON.parse(readFileSync(supervisorPath, 'utf8'))
  const originalSignoff = JSON.parse(readFileSync(signoffPath, 'utf8'))
  const infinity = '__INFINITY__'
  const encode = (value) => `${JSON.stringify(value, (_key, entry) => entry === Number.POSITIVE_INFINITY ? infinity : entry, 2).replaceAll(`"${infinity}"`, '1e999')}\n`
  const writeEncoded = (path, value) => writeFileSync(path, encode(value))
  const reset = () => {
    json(context.root, 'docs/evidence/soak-report.json', originalReport)
    json(context.root, 'docs/evidence/soak-supervisor.json', originalSupervisor)
    json(context.root, 'docs/release-signoff-v0.2.2.json', originalSignoff)
  }
  const refreshAllHashes = () => {
    const signoff = JSON.parse(readFileSync(signoffPath, 'utf8'))
    signoff.soak.reportSha256 = sha256(readFileSync(reportPath))
    signoff.soak.supervisorStateSha256 = sha256(readFileSync(supervisorPath))
    signoff.qa.reportSha256 = sha256(readFileSync(qaPath))
    writeEncoded(signoffPath, signoff)
  }
  const assertRejected = (label, mutate, expected = /有限、非负、安全整数/) => {
    reset()
    const report = structuredClone(originalReport)
    const supervisor = structuredClone(originalSupervisor)
    const signoff = structuredClone(originalSignoff)
    mutate({ report, supervisor, signoff })
    writeEncoded(reportPath, report)
    writeEncoded(supervisorPath, supervisor)
    writeEncoded(signoffPath, signoff)
    refreshAllHashes()
    const result = verify(context)
    assert.equal(result.ok, false, `${label} 刷新 SHA 后仍通过`)
    assert.match(result.errors.join('\n'), expected)
  }

  const variants = [
    { name: '字符串', value: '0', attempts: '01' },
    { name: 'null', value: null, attempts: 1 },
    { name: '负数', value: -1, attempts: 0 },
    { name: '小数', value: 0.5, attempts: 1.5 },
    { name: 'Infinity', value: infinity, attempts: infinity },
    { name: '超安全整数', value: Number.MAX_SAFE_INTEGER + 1, attempts: Number.MAX_SAFE_INTEGER + 2 },
  ]
  for (const variant of variants) {
    assertRejected(variant.name, ({ report, supervisor, signoff }) => {
      report.kills = variant.value
      report.restarts = variant.value
      report.faults.process_kill.actual = variant.value
      report.supervisor.kills = variant.value
      report.supervisor.restarts = variant.value
      report.supervisor.attempts = variant.attempts
      supervisor.kills = variant.value
      supervisor.restarts = variant.value
      supervisor.attempts = variant.attempts
      signoff.soak.kills = variant.value
      signoff.soak.restarts = variant.value
    })
  }

  assertRejected('超过 maxRestarts 边界', ({ report, supervisor, signoff }) => {
    report.kills = 1_001
    report.restarts = 1_001
    report.faults.process_kill.actual = 1_001
    report.supervisor.kills = 1_001
    report.supervisor.restarts = 1_001
    report.supervisor.attempts = 1_002
    supervisor.kills = 1_001
    supervisor.restarts = 1_001
    supervisor.attempts = 1_002
    signoff.soak.kills = 1_001
    signoff.soak.restarts = 1_001
  }, /超过 286/)

  reset()
  const nanReport = structuredClone(originalReport)
  nanReport.kills = '__NAN__'
  nanReport.restarts = '__NAN__'
  nanReport.faults.process_kill.actual = '__NAN__'
  writeFileSync(reportPath, encode(nanReport).replaceAll('"__NAN__"', 'NaN'))
  const nanSupervisor = structuredClone(originalSupervisor)
  nanSupervisor.kills = null
  nanSupervisor.restarts = null
  nanSupervisor.attempts = 1
  writeEncoded(supervisorPath, nanSupervisor)
  const nanSignoff = structuredClone(originalSignoff)
  nanSignoff.soak.kills = null
  nanSignoff.soak.restarts = null
  writeEncoded(signoffPath, nanSignoff)
  refreshAllHashes()
  const nanResult = verify(context)
  assert.equal(nanResult.ok, false, 'NaN 非法 JSON 刷新 SHA 后仍通过')
  assert.ok(nanResult.errors.length > 0, 'NaN 非法 JSON 缺少拒绝原因')

  const locations = [
    ['report.kills', ({ report }) => { report.kills = '0' }],
    ['report.restarts', ({ report }) => { report.restarts = null }],
    ['report.faults.process_kill.actual', ({ report }) => { report.faults.process_kill.actual = -1 }],
    ['report.supervisor.kills', ({ report }) => { report.supervisor.kills = 0.5 }],
    ['report.supervisor.restarts', ({ report }) => { report.supervisor.restarts = '0' }],
    ['report.supervisor.attempts', ({ report }) => { report.supervisor.attempts = null }],
    ['persisted.kills', ({ supervisor }) => { supervisor.kills = '0' }],
    ['persisted.restarts', ({ supervisor }) => { supervisor.restarts = -1 }],
    ['persisted.attempts', ({ supervisor }) => { supervisor.attempts = 0.5 }],
    ['signoff.soak.kills', ({ signoff }) => { signoff.soak.kills = null }],
    ['signoff.soak.restarts', ({ signoff }) => { signoff.soak.restarts = '0' }],
  ]
  for (const [label, mutate] of locations) assertRejected(label, mutate)
})

test('签字拒绝 watchdog 与时间截止线完整性篡改', (t) => {
  const context = fixture(t)
  const reportPath = join(context.root, 'docs/evidence/soak-report.json')
  const supervisorPath = join(context.root, 'docs/evidence/soak-supervisor.json')
  const qaPath = join(context.root, 'docs/evidence/qa-report.json')
  const signoffPath = join(context.root, 'docs/release-signoff-v0.2.2.json')
  const originalReport = JSON.parse(readFileSync(reportPath, 'utf8'))
  const originalSupervisor = JSON.parse(readFileSync(supervisorPath, 'utf8'))
  const originalSignoff = JSON.parse(readFileSync(signoffPath, 'utf8'))
  const infinity = '__INFINITY__'
  const encode = (value) => `${JSON.stringify(value, (_key, entry) => entry === Number.POSITIVE_INFINITY ? infinity : entry, 2).replaceAll(`"${infinity}"`, '1e999')}\n`
  const writeEncoded = (path, value) => writeFileSync(path, encode(value))
  const reset = () => {
    json(context.root, 'docs/evidence/soak-report.json', originalReport)
    json(context.root, 'docs/evidence/soak-supervisor.json', originalSupervisor)
    json(context.root, 'docs/release-signoff-v0.2.2.json', originalSignoff)
  }
  const refreshAllHashes = () => {
    const signoff = JSON.parse(readFileSync(signoffPath, 'utf8'))
    signoff.soak.reportSha256 = sha256(readFileSync(reportPath))
    signoff.soak.supervisorStateSha256 = sha256(readFileSync(supervisorPath))
    signoff.qa.reportSha256 = sha256(readFileSync(qaPath))
    writeEncoded(signoffPath, signoff)
  }
  const assertRejected = (label, mutate) => {
    reset()
    const report = structuredClone(originalReport)
    const supervisor = structuredClone(originalSupervisor)
    const signoff = structuredClone(originalSignoff)
    mutate({ report, supervisor, signoff })
    writeEncoded(reportPath, report)
    writeEncoded(supervisorPath, supervisor)
    writeEncoded(signoffPath, signoff)
    refreshAllHashes()
    const result = verify(context)
    assert.equal(result.ok, false, `${label} 刷新 SHA 后仍通过`)
    assert.ok(result.errors.length > 0, `${label} 缺少拒绝原因`)
  }

  const watchdogMutations = {
    'samples=0': (watchdog) => { watchdog.samples = 0 },
    'samples<attempts': (watchdog) => { watchdog.samples = 1 },
    'samples=字符串': (watchdog) => { watchdog.samples = '281' },
    'samples=null': (watchdog) => { watchdog.samples = null },
    'samples=负数': (watchdog) => { watchdog.samples = -1 },
    'samples=小数': (watchdog) => { watchdog.samples = 1.5 },
    'samples=Infinity': (watchdog) => { watchdog.samples = infinity },
    'missingEvents=1': (watchdog) => { watchdog.missingEvents = 1 },
    'staleEvents=1': (watchdog) => { watchdog.staleEvents = 1 },
    'maxObservedStateAgeMs=-1': (watchdog) => { watchdog.maxObservedStateAgeMs = -1 },
    'maxSteadyStateAgeMs=Infinity': (watchdog) => { watchdog.maxSteadyStateAgeMs = infinity },
    'maxTickGapMs=-1': (watchdog) => { watchdog.maxTickGapMs = -1 },
  }
  for (const [label, mutate] of Object.entries(watchdogMutations)) {
    assertRejected(`watchdog ${label}`, ({ report, supervisor }) => {
      mutate(report.supervisor.watchdog)
      mutate(supervisor.watchdog)
    })
  }

  assertRejected('非法 endedAt', ({ report }) => {
    report.supervisor.endedAt = 'not-a-date'
    report.actualEndedAt = 'not-a-date'
  })
  assertRejected('endedAt 早于 startedAt', ({ report }) => {
    report.supervisor.endedAt = '2026-11-20T11:59:59.000Z'
    report.actualEndedAt = '2026-11-20T11:59:59.000Z'
  })
  assertRejected('actualStartedAt 不一致', ({ report }) => {
    report.actualStartedAt = '2026-11-20T11:59:59.000Z'
  })
  assertRejected('actualEndedAt 不一致', ({ report }) => {
    report.actualEndedAt = '2026-11-21T12:00:21.000Z'
  })
  assertRejected('wallClockSeconds 与时间差不一致', ({ report, signoff }) => {
    report.wallClockSeconds = 86_421
    report.supervisor.wallClockSeconds = 86_421
    signoff.soak.wallClockSeconds = 86_421
  })
  assertRejected('effectiveDeadline 缺少 downtimeMs', ({ supervisor }) => {
    supervisor.effectiveDeadline = '2026-11-21T12:00:00.000Z'
  })
  assertRejected('effectiveDeadline=2099', ({ supervisor }) => {
    supervisor.effectiveDeadline = '2099-01-01T00:00:00.000Z'
  })
  assertRejected('effectiveDeadline 早于允许范围', ({ supervisor }) => {
    supervisor.effectiveDeadline = '2026-11-21T11:59:59.000Z'
  })
  assertRejected('effectiveDeadline 晚于结束时间', ({ supervisor }) => {
    supervisor.effectiveDeadline = '2026-11-21T12:00:21.000Z'
  })
})

test('签字拒绝 Soak 工作负载与跨字段一致性篡改', (t) => {
  const context = fixture(t)
  const reportPath = join(context.root, 'docs/evidence/soak-report.json')
  const supervisorPath = join(context.root, 'docs/evidence/soak-supervisor.json')
  const qaPath = join(context.root, 'docs/evidence/qa-report.json')
  const signoffPath = join(context.root, 'docs/release-signoff-v0.2.2.json')
  const originalReport = JSON.parse(readFileSync(reportPath, 'utf8'))
  const originalSupervisor = JSON.parse(readFileSync(supervisorPath, 'utf8'))
  const originalSignoff = JSON.parse(readFileSync(signoffPath, 'utf8'))
  const refreshAllHashes = () => {
    const signoff = JSON.parse(readFileSync(signoffPath, 'utf8'))
    signoff.soak.reportSha256 = sha256(readFileSync(reportPath))
    signoff.soak.supervisorStateSha256 = sha256(readFileSync(supervisorPath))
    signoff.qa.reportSha256 = sha256(readFileSync(qaPath))
    json(context.root, 'docs/release-signoff-v0.2.2.json', signoff)
  }
  const assertRejected = (label, mutate) => {
    json(context.root, 'docs/evidence/soak-report.json', originalReport)
    json(context.root, 'docs/evidence/soak-supervisor.json', originalSupervisor)
    json(context.root, 'docs/release-signoff-v0.2.2.json', originalSignoff)
    const report = structuredClone(originalReport)
    const supervisor = structuredClone(originalSupervisor)
    const signoff = structuredClone(originalSignoff)
    mutate({ report, supervisor, signoff })
    json(context.root, 'docs/evidence/soak-report.json', report)
    json(context.root, 'docs/evidence/soak-supervisor.json', supervisor)
    json(context.root, 'docs/release-signoff-v0.2.2.json', signoff)
    refreshAllHashes()
    const result = verify(context)
    assert.equal(result.ok, false, `${label} 刷新 SHA 后仍通过`)
    assert.ok(result.errors.length > 0, `${label} 缺少拒绝原因`)
  }

  assertRejected('删除 threads', ({ report }) => { delete report.threads })
  assertRejected('threads=1', ({ report }) => { report.threads = 1 })
  assertRejected('零计划 kill', ({ report, supervisor, signoff }) => {
    report.kills = 0
    report.restarts = 0
    report.faults.process_kill.actual = 0
    report.supervisor.kills = 0
    report.supervisor.restarts = 0
    report.supervisor.attempts = 1
    report.supervisor.watchdog.samples = 1
    supervisor.kills = 0
    supervisor.restarts = 0
    supervisor.attempts = 1
    supervisor.watchdog.samples = 1
    signoff.soak.kills = 0
    signoff.soak.restarts = 0
  })
  assertRejected('wallClock 多 10 秒', ({ report, signoff }) => {
    const endedAt = new Date(Date.parse(report.supervisor.endedAt) + 10_000).toISOString()
    report.actualEndedAt = endedAt
    report.supervisor.endedAt = endedAt
    report.wallClockSeconds += 10
    report.supervisor.wallClockSeconds += 10
    signoff.soak.wallClockSeconds += 10
  })
  assertRejected('activeSeconds 超过 wallClockSeconds', ({ report, supervisor, signoff }) => {
    report.activeSeconds += 10
    report.supervisor.activeSeconds += 10
    supervisor.activeMs += 10_000
    signoff.soak.activeSeconds += 10
  })
  assertRejected('endedAt 超出 drain 窗口', ({ report, supervisor, signoff }) => {
    const endedAt = new Date(Date.parse(report.supervisor.endedAt) + 311_000).toISOString()
    report.actualEndedAt = endedAt
    report.supervisor.endedAt = endedAt
    report.wallClockSeconds += 311
    report.supervisor.wallClockSeconds += 311
    report.activeSeconds += 311
    report.supervisor.activeSeconds += 311
    supervisor.activeMs += 311_000
    signoff.soak.wallClockSeconds += 311
    signoff.soak.activeSeconds += 311
  })
})
