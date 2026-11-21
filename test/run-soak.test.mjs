import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  childArguments,
  classifyInterruption,
  parse,
  readState,
  runChild,
  validatePassedReport,
  writeReportWithHash,
} from '../scripts/run-soak.mjs'

function state(overrides = {}) {
  return {
    version: 2,
    startedAt: '2026-01-01T00:00:00.000Z',
    lastTickAt: new Date().toISOString(),
    completed: false,
    invariantFailures: [],
    kills: 1,
    restarts: 1,
    activeMs: 4_000,
    maxTickActiveMs: 1_000,
    tickActiveLimitMs: 15_000,
    drainTimeoutMs: 300_000,
    drainSeconds: 0,
    drainTimedOut: false,
    faults: {
      counts: { process_kill: { actual: 1, skipped: 0 } },
      recent: [{ kind: 'process_kill', outcome: 'actual', at: new Date().toISOString(), detail: 'pid=1234' }],
    },
    ...overrides,
  }
}

function options(overrides = {}) {
  return {
    seconds: 4,
    maxStateAgeMs: 15_000,
    startupGraceMs: 30_000,
    maxRestartGapMs: 30_000,
    maxTickActiveMs: 15_000,
    drainTimeoutMs: 300_000,
    maxTotalDowntimeMs: 1_800_000,
    maxRestarts: 1_000,
    ...overrides,
  }
}

function stats(overrides = {}) {
  return {
    attempts: 2,
    restarts: 1,
    kills: 1,
    activeMs: 4_000,
    maxTickActiveMs: 1_000,
    tickActiveLimitMs: 15_000,
    drainTimeoutMs: 300_000,
    drainSeconds: 0,
    drainTimedOut: false,
    maxTotalDowntimeMs: 1_800_000,
    maxRestarts: 1_000,
    maxStateAgeMs: 15_000,
    maxRestartGapLimitMs: 30_000,
    downtimeMs: 50,
    maxRestartGapMs: 50,
    unplannedInterruptions: 0,
    watchdog: {
      triggered: false,
      reason: '',
      samples: 1,
      missingEvents: 0,
      staleEvents: 0,
      maxObservedStateAgeMs: 10,
      maxSteadyStateAgeMs: 10,
      maxTickGapMs: 10,
    },
    ...overrides,
  }
}

function report(overrides = {}) {
  const numbers = {
    wallClockSeconds: 4.1,
    cumulativeSeconds: 4.1,
    requestedSeconds: 4,
    killEverySeconds: 1,
    noKill: false,
    monitors: 4,
    threads: 1,
    seed: 7,
    iterations: 10,
    scans: 2,
    analyses: 1,
    generations: 1,
    modelCalls: 1,
    candidates: 1,
    failures: 0,
    retries: 0,
    restarts: 1,
    kills: 1,
    activeSeconds: 4,
    maxTickActiveMs: 1_000,
    tickActiveLimitMs: 15_000,
    drainTimeoutMs: 300_000,
    drainSeconds: 0,
    drainTimedOut: false,
    memoryPeakMb: 20,
    heapFinalMb: 20,
    peakQueue: 1,
    queueCapacity: 1_500,
    queueAtEnd: 0,
    peakLedger: 2,
    ledgerRowsAtEnd: 2,
    pendingAtEnd: 0,
    duplicateCandidates: 0,
    lostTasks: 0,
    convergenceLag: 0,
    convergenceLagPeak: 0,
    stuckIdentity: 0,
    authBlockedIdentity: 0,
    coreLockTimeouts: 0,
    cursorRegressions: 0,
    completedTaskReexecutions: 0,
    unrecordedInterruptions: 0,
    unhandledErrors: 0,
    sharedThreadGroups: 0,
    maxMonitorsPerThread: 1,
    totalRepliesCreated: 1,
    storeWriteFailures: 0,
    storeRestores: 0,
    storeCorruptions: 0,
    degradedDiskSessions: 0,
    undegradedDiskSessions: 0,
    recoveredDiskBlockers: 0,
    backlogSessions: 0,
    operatorResumes: 0,
    queueRejections: 0,
    prunedRows: 0,
  }
  const invariants = {
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
  }
  return {
    schemaVersion: 1,
    tool: 'soak-v022',
    status: 'passed',
    originalStartedAt: '2026-01-01T00:00:00.000Z',
    actualStartedAt: '2026-01-01T00:00:00.000Z',
    actualEndedAt: '2026-01-01T00:00:04.100Z',
    stateFile: '/tmp/state.json',
    dataDir: '/tmp/state.json.data',
    resumed: true,
    resumedAfterFailure: false,
    cpuUsage: { userMicros: 1, systemMicros: 1, percent: 0 },
    identities: { total: 1, claimed: 0, candidate: 1, ignored: 0, fallback: 0 },
    engine: { queued: 0, runningTasks: 0 },
    faults: { process_kill: { actual: 1, skipped: 0 } },
    recentFaults: [],
    diskTargets: [],
    diskStoreActual: {},
    diskStoreSkipped: {},
    lockTimeoutEvents: [],
    acknowledgedFailures: [],
    limitations: [],
    invariants,
    invariantFailures: [],
    completed: true,
    ...numbers,
    ...overrides,
  }
}

test('supervisor 拒绝裸 137、SIGTERM、spawn error 与陈旧状态', () => {
  const now = Date.now()
  assert.equal(classifyInterruption({ code: 137, signal: null }, {
    canKill: true, before: undefined, after: undefined, pid: 1234, now, maxStateAgeMs: 15_000,
  }).planned, false)
  assert.equal(classifyInterruption({ code: null, signal: 'SIGTERM' }, {
    canKill: true, before: undefined, after: state(), pid: 1234, now, maxStateAgeMs: 15_000,
  }).planned, false)
  assert.equal(classifyInterruption({ code: 137, signal: null }, {
    canKill: true, before: undefined, after: state({ lastTickAt: new Date(now - 60_000).toISOString() }), pid: 1234, now, maxStateAgeMs: 15_000,
  }).planned, false)
  assert.equal(classifyInterruption({ code: 137, signal: null }, {
    canKill: true, before: undefined, after: state({ version: 1 }), pid: 1234, now, maxStateAgeMs: 15_000,
  }).planned, false)
})

test('supervisor 只接受带 PID、持久计数与新鲜 active 的计划杀死', () => {
  const now = Date.now()
  const before = state({ kills: 0, restarts: 0, activeMs: 3_000, faults: { counts: { process_kill: { actual: 0, skipped: 0 } }, recent: [] } })
  const after = state()
  assert.equal(classifyInterruption({ code: 137, signal: null }, {
    canKill: true, before, after, pid: 1234, now, maxStateAgeMs: 15_000,
  }).planned, true)
  assert.equal(classifyInterruption({ code: 137, signal: null }, {
    canKill: true, before, after: state({ activeMs: 2_999 }), pid: 1234, now, maxStateAgeMs: 15_000,
  }).planned, false)
  assert.equal(classifyInterruption({ code: 137, signal: null }, {
    canKill: true, before, after: state({ faults: { counts: { process_kill: { actual: 0, skipped: 0 } }, recent: [] } }), pid: 1234, now, maxStateAgeMs: 15_000,
  }).planned, false)
  assert.equal(classifyInterruption({ code: 137, signal: null }, {
    canKill: true, before, after: state({ faults: { counts: { process_kill: { actual: 1, skipped: 0 } }, recent: [{ kind: 'process_kill', outcome: 'actual', detail: 'pid=9999' }] } }), pid: 1234, now, maxStateAgeMs: 15_000,
  }).planned, false)
  assert.equal(classifyInterruption({ code: 137, signal: null }, {
    canKill: true, before, after: state({ drainTimedOut: true }), pid: 1234, now, maxStateAgeMs: 15_000,
  }).planned, false)
  const { drainTimeoutMs: _drainTimeoutMs, ...withoutDrain } = state()
  assert.equal(classifyInterruption({ code: 137, signal: null }, {
    canKill: true, before, after: withoutDrain, pid: 1234, now, maxStateAgeMs: 15_000,
  }).planned, false)
})

test('supervisor 拒绝 active 不足、字段缺失、计数不一致与假 PASS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-runner-test-'))
  try {
    const stateFile = join(dir, 'state.json')
    writeFileSync(stateFile, JSON.stringify(state({ completed: true })))
    writeFileSync(`${stateFile}.supervisor.json`, JSON.stringify({ schemaVersion: 1, completed: true, ...stats() }))
    assert.deepEqual(validatePassedReport(report({ stateFile }), options(), stats(), stateFile), [])
    assert.ok(validatePassedReport(report({ stateFile, activeSeconds: 3.999 }), options(), stats(), stateFile).some((message) => message.includes('activeSeconds')))
    assert.ok(validatePassedReport(report({ stateFile, lostTasks: 1 }), options(), stats(), stateFile).some((message) => message.includes('lostTasks')))
    assert.ok(validatePassedReport(report({ stateFile, coreLockTimeouts: 1 }), options(), stats(), stateFile).some((message) => message.includes('coreLockTimeouts')))
    assert.ok(validatePassedReport(report({ stateFile, stuckIdentity: 1 }), options(), stats(), stateFile).some((message) => message.includes('stuckIdentity')))
    assert.ok(validatePassedReport(report({ stateFile, drainTimedOut: true }), options(), stats(), stateFile).some((message) => message.includes('排空超时')))
    assert.ok(validatePassedReport(report({ stateFile, drainTimeoutMs: 1 }), options(), stats(), stateFile).some((message) => message.includes('排空超时参数')))
    assert.ok(validatePassedReport(report({ stateFile, drainSeconds: 0.001 }), options(), stats(), stateFile).some((message) => message.includes('drainSeconds')))
    const missingDrainState = state({ completed: true })
    delete missingDrainState.drainSeconds
    writeFileSync(stateFile, JSON.stringify(missingDrainState))
    assert.ok(validatePassedReport(report({ stateFile }), options(), stats(), stateFile).some((message) => message.includes('drainSeconds 缺失')))
    writeFileSync(stateFile, JSON.stringify(state({ completed: true })))
    assert.ok(validatePassedReport(report({ stateFile, queueAtEnd: 1 }), options(), stats(), stateFile).some((message) => message.includes('排队或运行任务')))
    assert.ok(validatePassedReport(report({ stateFile, engine: { queued: 0, runningTasks: 1 } }), options(), stats(), stateFile).some((message) => message.includes('排队或运行任务')))
    assert.ok(validatePassedReport(report({ stateFile, kills: 2 }), options(), stats(), stateFile).some((message) => message.includes('kills')))
    const missing = report({ stateFile })
    delete missing.maxTickActiveMs
    assert.ok(validatePassedReport(missing, options(), stats(), stateFile).some((message) => message.includes('maxTickActiveMs')))
    assert.ok(validatePassedReport(report({ stateFile }), options(), stats({ activeMs: 3_500 }), stateFile).some((message) => message.includes('active 时长不足')))
    assert.ok(validatePassedReport(report({ stateFile }), options({ maxTotalDowntimeMs: 10 }), stats(), stateFile).some((message) => message.includes('总 downtime')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fake child 裸 137 不产生可归因状态，真实自 kill 写入 PID 证据', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-runner-child-'))
  try {
    const bare = join(dir, 'bare.mjs')
    writeFileSync(bare, 'process.exit(137)\n')
    const bareResult = await runChild([], { childPath: bare, stateFile: join(dir, 'bare-state.json') })
    assert.equal(bareResult.code, 137)
    assert.equal(readState(join(dir, 'bare-state.json')), undefined)

    const planned = join(dir, 'planned.mjs')
    const stateFile = join(dir, 'planned-state.json')
    writeFileSync(planned, `
      import { writeFileSync } from 'node:fs'
      const stateArg = process.argv.find((arg) => arg.startsWith('--state-file='))
      const stateFile = stateArg.slice('--state-file='.length)
      const payload = ${JSON.stringify(state({ faults: { counts: { process_kill: { actual: 1, skipped: 0 } }, recent: [{ kind: 'process_kill', outcome: 'actual', detail: 'pid=placeholder' }] } }))}
      payload.faults.recent[0].detail = 'pid=' + process.pid
      writeFileSync(stateFile, JSON.stringify(payload))
      process.exit(137)
    `)
    const plannedResult = await runChild([`--state-file=${stateFile}`], { childPath: planned, stateFile })
    assert.equal(classifyInterruption(plannedResult, {
      canKill: true,
      before: undefined,
      after: readState(stateFile),
      pid: plannedResult.pid,
      now: Date.now(),
      maxStateAgeMs: 15_000,
    }).planned, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('报告写入原子文件并生成匹配的 SHA256 sidecar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-runner-hash-'))
  try {
    const file = join(dir, 'report.json')
    const value = report()
    const hash = writeReportWithHash(file, value)
    assert.equal(readFileSync(file, 'utf8'), `${JSON.stringify(value, null, 2)}\n`)
    assert.equal(readFileSync(`${file}.sha256`, 'utf8'), `${hash}  report.json\n`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('supervisor 参数解析拒绝非法阈值并完整透传排空参数', () => {
  assert.equal(parse(['--seconds=4', '--max-restarts=10']).maxRestarts, 10)
  assert.throws(() => parse(['--max-state-age-ms=0']), /max-state-age-ms/)
  assert.throws(() => parse(['--max-tick-active-ms=1.5']), /max-tick-active-ms/)
  assert.throws(() => parse(['--drain-timeout-ms=1.5']), /drain-timeout-ms/)
  const forwarded = childArguments([
    '--seconds=99', '--state-file', '/old/state.json', '--deadline=1', '--max-tick-active-ms=1',
    '--drain-timeout-ms', '1', '--no-kill', '--monitors=20', '--seed=7',
  ], '/new/state.json', 4, true, 1234, 2_000, 5_000)
  assert.deepEqual(forwarded, [
    '--monitors=20', '--seed=7', '--seconds=4', '--state-file=/new/state.json', '--deadline=1234',
    '--max-tick-active-ms=2000', '--drain-timeout-ms=5000', '--resume',
  ])
})

test('supervisor 拒绝复用陈旧状态目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-runner-stale-'))
  try {
    const stateFile = join(dir, 'state.json')
    writeFileSync(stateFile, '{}\n')
    const result = spawnSync(process.execPath, [
      'scripts/run-soak.mjs', '--seconds=1', '--no-kill', `--state-file=${stateFile}`,
    ], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /必须使用全新状态目录/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
