#!/usr/bin/env node
/**
 * Verify the machine-readable v0.2.2 release sign-off.
 *
 * The sign-off is documentation committed after the product candidate has passed
 * CI and the continuous soak. It binds that candidate commit, the exact freeze
 * bytes, the exact soak/QA evidence bytes, and the successful CI run. A release
 * tag may add documentation only; every product/build-input path must remain
 * byte- and mode-identical to the signed candidate.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SIGNOFF_PATH = 'docs/release-signoff-v0.2.2.json'
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
const PROTECTED_PATHS = [
  '.github',
  'packages',
  'scripts',
  'test',
  'packaging',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'LICENSE',
  'NOTICE',
  'README.md',
]
const REQUIRED_SOAK_INVARIANTS = [
  'uniqueReplyCandidates', 'completedTasksNotReexecuted', 'cursorNeverRegresses',
  'interruptedTasksRecorded', 'queueWithinCapacity', 'heapWithinThreshold',
  'noUnhandledErrors', 'noCoreLockTimeouts', 'noLostTasks', 'noStuckIdentity',
  'noIdentityLedgerDrift', 'noTaskLedgerDrift', 'noStoreCorruption',
  'diskFailuresDegraded', 'activeTicksWithinLimit', 'drainConverged',
]
const RELEASE_THRESHOLDS = Object.freeze({
  minWallClockSeconds: 86_400,
  minActiveSeconds: 86_400,
  maxTickActiveMs: 15_000,
  maxTickGapMs: 15_000,
  maxTotalDowntimeMs: 1_800_000,
  maxRestarts: 1_000,
  maxRestartGapMs: 30_000,
  maxDrainSeconds: 300,
})
const STRICT_INVARIANTS = [
  'duplicateCandidates',
  'lostTasks',
  'convergenceLag',
  'stuckIdentity',
  'coreLockTimeouts',
  'cursorRegressions',
  'completedTaskReexecutions',
  'unrecordedInterruptions',
  'unhandledErrors',
]

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function readJson(root, path) {
  const full = resolve(root, path)
  if (!full.startsWith(`${resolve(root)}${process.platform === 'win32' ? '\\' : '/'}`) && full !== resolve(root)) {
    throw new Error(`证据路径越界：${path}`)
  }
  if (!existsSync(full)) throw new Error(`证据文件不存在：${path}`)
  return JSON.parse(readFileSync(full, 'utf8'))
}

function readEvidenceBytes(root, path) {
  if (typeof path !== 'string' || path === '' || isAbsolute(path)) throw new Error(`证据路径无效：${String(path)}`)
  const full = resolve(root, path)
  const docs = resolve(root, 'docs')
  if (full !== docs && !full.startsWith(`${docs}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`证据必须位于 docs/：${path}`)
  }
  if (!existsSync(full)) throw new Error(`证据文件不存在：${path}`)
  return readFileSync(full)
}

function requireNumber(value, label, minimum = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${label} 缺失或小于 ${minimum}`)
  }
}

function requireCount(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是有限、非负、安全整数`)
  }
  if (value > maximum) throw new Error(`${label} 超过 ${maximum}`)
}

function requireIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`${label} 必须是 ISO UTC 时间`)
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${label} 必须是有效 ISO UTC 时间`)
  return parsed
}

function requireWatchdog(watchdog, label) {
  if (watchdog === undefined || watchdog === null || typeof watchdog !== 'object') throw new Error(`${label} 缺失`)
  requireCount(watchdog.samples, `${label}.samples`)
  if (watchdog.samples === 0) throw new Error(`${label}.samples 必须大于 0`)
  requireCount(watchdog.missingEvents, `${label}.missingEvents`)
  requireCount(watchdog.staleEvents, `${label}.staleEvents`)
  requireEqual(watchdog.missingEvents, 0, `${label}.missingEvents`)
  requireEqual(watchdog.staleEvents, 0, `${label}.staleEvents`)
  requireNumber(watchdog.maxObservedStateAgeMs, `${label}.maxObservedStateAgeMs`)
  requireNumber(watchdog.maxSteadyStateAgeMs, `${label}.maxSteadyStateAgeMs`)
  requireCount(watchdog.maxTickGapMs, `${label}.maxTickGapMs`)
  requireEqual(watchdog.triggered, false, `${label}.triggered`)
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} 不一致：${String(actual)} != ${String(expected)}`)
}

function parseFreeze(bytes) {
  const files = new Map()
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line)
    if (match === null) continue
    files.set(match[2].replaceAll('\\', '/'), match[1])
  }
  return files
}

function verifyFreeze(root, signoff) {
  const bytes = readEvidenceBytes(root, signoff.freeze?.path)
  requireEqual(sha256(bytes), signoff.freeze?.sha256, 'freeze SHA256')
  const files = parseFreeze(bytes)
  for (const path of REQUIRED_FREEZE_FILES) {
    if (!files.has(path)) throw new Error(`freeze 缺少关键文件：${path}`)
  }
  for (const [path, expected] of files) {
    const full = resolve(root, path)
    if (!existsSync(full)) throw new Error(`freeze 文件不存在：${path}`)
    requireEqual(sha256(readFileSync(full)), expected, `freeze 文件 ${path}`)
  }
}

function verifySoak(root, signoff) {
  const thresholds = signoff.thresholds ?? {}
  for (const [key, expected] of Object.entries(RELEASE_THRESHOLDS)) {
    requireNumber(thresholds[key], `签字阈值 ${key}`, 0)
    requireEqual(thresholds[key], expected, `签字阈值 ${key}`)
  }

  const reportBytes = readEvidenceBytes(root, signoff.soak?.reportPath)
  requireEqual(sha256(reportBytes), signoff.soak?.reportSha256, 'Soak 报告 SHA256')
  const report = JSON.parse(reportBytes.toString('utf8'))
  requireEqual(report.schemaVersion, 1, 'Soak schemaVersion')
  requireEqual(report.tool, 'soak-v022', 'Soak tool')
  requireEqual(report.status, 'passed', 'Soak status')
  requireEqual(report.completed, true, 'Soak completed')
  requireEqual(report.monitors, 1_000, 'Soak monitors')
  requireEqual(report.threads, 25, 'Soak threads')
  requireEqual(report.seed, 1, 'Soak seed')
  requireEqual(report.requestedSeconds, 86_400, 'Soak requestedSeconds')
  requireEqual(report.killEverySeconds, 300, 'Soak killEverySeconds')
  requireEqual(report.noKill, false, 'Soak noKill')
  requireNumber(report.drainTimeoutMs, 'Soak drainTimeoutMs', 250)
  requireEqual(report.drainTimeoutMs, RELEASE_THRESHOLDS.maxDrainSeconds * 1000, 'Soak 排空超时阈值')
  requireEqual(report.drainTimedOut, false, 'Soak drainTimedOut')
  requireNumber(report.drainSeconds, 'Soak drainSeconds')
  if (report.drainSeconds > RELEASE_THRESHOLDS.maxDrainSeconds) throw new Error('Soak 排空时长超过签字阈值')
  for (const key of ['queueAtEnd', 'pendingAtEnd']) requireEqual(report[key], 0, `Soak ${key}`)
  requireEqual(report.engine?.queued, 0, 'Soak engine.queued')
  requireEqual(report.engine?.runningTasks, 0, 'Soak engine.runningTasks')
  requireNumber(report.wallClockSeconds, 'Soak wallClockSeconds', RELEASE_THRESHOLDS.minWallClockSeconds)
  requireNumber(report.activeSeconds, 'Soak activeSeconds', RELEASE_THRESHOLDS.minActiveSeconds)
  requireNumber(report.downtimeSeconds, 'Soak downtimeSeconds')
  requireNumber(report.maxTickActiveMs, 'Soak maxTickActiveMs')
  requireNumber(report.tickActiveLimitMs, 'Soak tickActiveLimitMs')
  requireEqual(report.tickActiveLimitMs, RELEASE_THRESHOLDS.maxTickActiveMs, 'Soak tickActiveLimitMs')
  requireNumber(report.maxTickGapMs, 'Soak maxTickGapMs')
  if (report.maxTickActiveMs > RELEASE_THRESHOLDS.maxTickActiveMs) throw new Error('Soak maxTickActiveMs 超过签字阈值')
  if (report.maxTickGapMs > RELEASE_THRESHOLDS.maxTickGapMs) throw new Error('Soak maxTickGapMs 超过签字阈值')
  if (report.downtimeSeconds * 1000 > RELEASE_THRESHOLDS.maxTotalDowntimeMs) throw new Error('Soak downtime 超过签字阈值')
  const maxExpectedKills = Math.ceil(report.requestedSeconds / report.killEverySeconds) - 2
  const minExpectedKills = maxExpectedKills - 1
  for (const [key, label] of [
    ['restarts', 'Soak restarts'],
    ['kills', 'Soak kills'],
  ]) {
    requireCount(report[key], label, maxExpectedKills)
    if (report[key] < minExpectedKills) throw new Error(`${label} 低于计划 kill 覆盖下界 ${minExpectedKills}`)
  }
  requireCount(report.faults?.process_kill?.actual, 'Soak process_kill.actual', maxExpectedKills)
  if (report.faults.process_kill.actual < minExpectedKills) throw new Error(`Soak process_kill.actual 低于计划 kill 覆盖下界 ${minExpectedKills}`)
  requireCount(report.faults?.process_kill?.skipped, 'Soak process_kill.skipped')
  requireEqual(report.faults.process_kill.skipped, 0, 'Soak process_kill.skipped')
  requireEqual(report.kills, report.restarts, 'Soak kills/restarts')
  requireEqual(report.faults.process_kill.actual, report.kills, 'Soak process_kill.actual')
  requireEqual(report.resumed, true, 'Soak resumed')
  requireEqual(report.resumedAfterFailure, false, 'Soak resumedAfterFailure')
  for (const key of STRICT_INVARIANTS) requireEqual(report[key], 0, `Soak ${key}`)
  if (!Array.isArray(report.invariantFailures) || report.invariantFailures.length !== 0) throw new Error('Soak invariantFailures 非空')
  if (report.invariants === undefined || typeof report.invariants !== 'object') throw new Error('Soak invariants 缺失')
  for (const key of REQUIRED_SOAK_INVARIANTS) requireEqual(report.invariants[key], true, `Soak invariant ${key}`)
  if (Object.values(report.invariants).some((value) => value !== true)) throw new Error('Soak invariants 非全 true')

  const embedded = report.supervisor
  if (embedded === undefined || embedded === null || typeof embedded !== 'object') throw new Error('Soak report.supervisor 缺失')
  const startedAtMs = requireIsoTimestamp(embedded.startedAt, 'report.supervisor startedAt')
  const endedAtMs = requireIsoTimestamp(embedded.endedAt, 'report.supervisor endedAt')
  if (endedAtMs < startedAtMs) throw new Error('report.supervisor endedAt 早于 startedAt')
  requireEqual(report.actualStartedAt, embedded.startedAt, 'Soak actualStartedAt')
  requireEqual(report.actualEndedAt, embedded.endedAt, 'Soak actualEndedAt')
  requireNumber(embedded.wallClockSeconds, 'report.supervisor wallClockSeconds')
  const elapsedSeconds = (endedAtMs - startedAtMs) / 1000
  if (Math.abs(embedded.wallClockSeconds - elapsedSeconds) > 0.001) throw new Error('report.supervisor wallClockSeconds 与起止时间不一致')
  requireCount(embedded.attempts, 'report.supervisor attempts', RELEASE_THRESHOLDS.maxRestarts + 1)
  requireCount(embedded.restarts, 'report.supervisor restarts', RELEASE_THRESHOLDS.maxRestarts)
  requireCount(embedded.kills, 'report.supervisor kills', RELEASE_THRESHOLDS.maxRestarts)
  requireEqual(embedded.kills, report.kills, 'report.supervisor kills')
  requireEqual(embedded.restarts, report.restarts, 'report.supervisor restarts')
  requireEqual(embedded.attempts, report.restarts + 1, 'report.supervisor attempts')
  requireEqual(embedded.unplannedInterruptions, 0, 'report.supervisor unplannedInterruptions')
  requireEqual(embedded.activeSeconds, report.activeSeconds, 'report.supervisor activeSeconds')
  requireEqual(embedded.downtimeSeconds, report.downtimeSeconds, 'report.supervisor downtimeSeconds')
  requireEqual(embedded.wallClockSeconds, report.wallClockSeconds, 'report.supervisor wallClockSeconds')
  requireEqual(embedded.maxTickActiveMs, report.maxTickActiveMs, 'report.supervisor maxTickActiveMs')
  requireEqual(embedded.tickActiveLimitMs, report.tickActiveLimitMs, 'report.supervisor tickActiveLimitMs')
  requireEqual(embedded.maxTickGapMs, report.maxTickGapMs, 'report.supervisor maxTickGapMs')
  requireEqual(embedded.drainTimeoutMs, report.drainTimeoutMs, 'report.supervisor drainTimeoutMs')
  requireEqual(embedded.drainSeconds, report.drainSeconds, 'report.supervisor drainSeconds')
  requireEqual(embedded.drainTimedOut, report.drainTimedOut, 'report.supervisor drainTimedOut')
  requireEqual(embedded.maxTotalDowntimeMs, RELEASE_THRESHOLDS.maxTotalDowntimeMs, 'report.supervisor maxTotalDowntimeMs')
  requireEqual(embedded.maxRestarts, RELEASE_THRESHOLDS.maxRestarts, 'report.supervisor maxRestarts')
  requireEqual(embedded.maxStateAgeMs, RELEASE_THRESHOLDS.maxTickGapMs, 'report.supervisor maxStateAgeMs')
  requireEqual(embedded.maxRestartGapLimitMs, RELEASE_THRESHOLDS.maxRestartGapMs, 'report.supervisor maxRestartGapLimitMs')
  requireNumber(embedded.maxRestartGapMs, 'report.supervisor maxRestartGapMs')
  if (embedded.maxRestartGapMs > RELEASE_THRESHOLDS.maxRestartGapMs) throw new Error('Soak 单次重启间隔超过签字阈值')
  requireWatchdog(embedded.watchdog, 'report.supervisor watchdog')
  if (embedded.watchdog.samples < embedded.attempts) throw new Error('report.supervisor watchdog.samples 小于 attempts')
  if (embedded.watchdog.maxSteadyStateAgeMs > RELEASE_THRESHOLDS.maxTickGapMs) throw new Error('Soak 稳定期状态心跳年龄超过签字阈值')

  const supervisorBytes = readEvidenceBytes(root, signoff.soak?.supervisorStatePath)
  requireEqual(sha256(supervisorBytes), signoff.soak?.supervisorStateSha256, 'supervisor 状态 SHA256')
  const supervisor = JSON.parse(supervisorBytes.toString('utf8'))
  requireEqual(supervisor.schemaVersion, 1, 'supervisor schemaVersion')
  requireEqual(supervisor.completed, true, 'supervisor completed')
  requireEqual(supervisor.startedAt, embedded.startedAt, 'supervisor 持久 startedAt')
  requireEqual(supervisor.requestedSeconds, report.requestedSeconds, 'supervisor 持久 requestedSeconds')
  requireCount(supervisor.downtimeMs, 'supervisor 持久 downtimeMs')
  const effectiveDeadlineMs = requireIsoTimestamp(supervisor.effectiveDeadline, 'supervisor 持久 effectiveDeadline')
  const earliestDeadlineMs = startedAtMs + report.requestedSeconds * 1000
  const expectedDeadlineMs = earliestDeadlineMs + supervisor.downtimeMs
  const latestDeadlineMs = earliestDeadlineMs + RELEASE_THRESHOLDS.maxTotalDowntimeMs
  if (effectiveDeadlineMs !== expectedDeadlineMs) throw new Error('supervisor 持久 effectiveDeadline 与 downtimeMs 不一致')
  if (effectiveDeadlineMs < earliestDeadlineMs || effectiveDeadlineMs > latestDeadlineMs) {
    throw new Error('supervisor 持久 effectiveDeadline 超出允许范围')
  }
  if (effectiveDeadlineMs > endedAtMs) throw new Error('supervisor 持久 effectiveDeadline 晚于报告结束时间')
  const postDeadlineMs = endedAtMs - effectiveDeadlineMs
  const drainMs = report.drainSeconds * 1000
  if (postDeadlineMs < drainMs - 1) throw new Error('Soak 截止后时长小于 drainSeconds')
  if (postDeadlineMs > drainMs + RELEASE_THRESHOLDS.maxTickActiveMs + 5_000) throw new Error('Soak 截止后排空窗口超出允许范围')
  requireCount(supervisor.attempts, 'supervisor 持久 attempts', RELEASE_THRESHOLDS.maxRestarts + 1)
  requireCount(supervisor.restarts, 'supervisor 持久 restarts', RELEASE_THRESHOLDS.maxRestarts)
  requireCount(supervisor.kills, 'supervisor 持久 kills', RELEASE_THRESHOLDS.maxRestarts)
  for (const key of [
    'attempts', 'restarts', 'kills', 'unplannedInterruptions', 'maxTickActiveMs', 'tickActiveLimitMs',
    'drainTimeoutMs', 'drainSeconds', 'drainTimedOut', 'maxTotalDowntimeMs', 'maxRestarts',
    'maxStateAgeMs', 'maxRestartGapLimitMs', 'maxRestartGapMs',
  ]) {
    requireEqual(supervisor[key], embedded[key], `supervisor 持久 ${key}`)
  }
  requireCount(supervisor.activeMs, 'supervisor 持久 activeMs')
  requireEqual(supervisor.activeMs, embedded.activeSeconds * 1000, 'supervisor 持久 activeMs')
  requireEqual(supervisor.downtimeMs, embedded.downtimeSeconds * 1000, 'supervisor 持久 downtimeMs')
  const elapsedMs = endedAtMs - startedAtMs
  if (supervisor.activeMs > elapsedMs) throw new Error('supervisor 持久 activeMs 超过 elapsedMs')
  if (supervisor.downtimeMs > elapsedMs) throw new Error('supervisor 持久 downtimeMs 超过 elapsedMs')
  const overheadMs = elapsedMs - supervisor.activeMs - supervisor.downtimeMs
  if (overheadMs < 0 || overheadMs > 5_000) throw new Error('supervisor 时间会计 overheadMs 超出允许范围')
  requireWatchdog(supervisor.watchdog, 'supervisor 持久 watchdog')
  for (const key of ['samples', 'missingEvents', 'staleEvents', 'maxObservedStateAgeMs', 'maxSteadyStateAgeMs', 'maxTickGapMs']) {
    requireEqual(supervisor.watchdog[key], embedded.watchdog[key], `supervisor 持久 watchdog.${key}`)
  }
  if (supervisor.watchdog.samples < supervisor.attempts) throw new Error('supervisor 持久 watchdog.samples 小于 attempts')
  requireEqual(supervisor.watchdog.maxTickGapMs, report.maxTickGapMs, 'supervisor 持久 watchdog.maxTickGapMs 与报告')
  if (supervisor.watchdog.maxSteadyStateAgeMs > RELEASE_THRESHOLDS.maxTickGapMs) throw new Error('Soak 持久稳定期状态心跳年龄超过签字阈值')

  requireCount(signoff.soak?.kills, '签字 Soak kills', RELEASE_THRESHOLDS.maxRestarts)
  requireCount(signoff.soak?.restarts, '签字 Soak restarts', RELEASE_THRESHOLDS.maxRestarts)
  for (const key of ['wallClockSeconds', 'activeSeconds', 'downtimeSeconds', 'maxTickActiveMs', 'maxTickGapMs', 'drainTimeoutMs', 'drainSeconds', 'drainTimedOut', 'kills', 'restarts']) {
    requireEqual(signoff.soak?.[key], report[key], `签字 Soak ${key}`)
  }
}

function verifyQaReport(root, signoff) {
  const bytes = readEvidenceBytes(root, signoff.qa?.reportPath)
  requireEqual(sha256(bytes), signoff.qa?.reportSha256, 'QA 报告 SHA256')
  const report = JSON.parse(bytes.toString('utf8'))
  requireEqual(report.schemaVersion, 1, 'QA schemaVersion')
  requireEqual(report.tool, 'ai-debate-qa', 'QA tool')
  requireEqual(report.version, '0.2.2', 'QA version')
  requireEqual(report.status, 'PASS', 'QA status')
  requireEqual(report.candidateCommit, signoff.candidateCommit, 'QA candidateCommit')
  const suites = report.suites ?? {}
  for (const key of ['typecheck', 'core', 'server', 'web', 'standalone', 'automation', 'recovery', 'paging', 'upgrade', 'soakSelfTests', 'supervisor', 'secrets']) {
    if (suites[key] === undefined) throw new Error(`QA 缺少套件：${key}`)
  }
  requireEqual(suites.typecheck, 'pass', 'QA typecheck')
  for (const [key, minimum] of Object.entries({ core: 227, server: 166, web: 12, standalone: 27, automation: 8, recovery: 8, paging: 7, upgrade: 97, soakSelfTests: 8, supervisor: 6, secrets: 12 })) {
    requireNumber(suites[key]?.passed, `QA ${key}.passed`, minimum)
    requireEqual(suites[key]?.failed, 0, `QA ${key}.failed`)
  }
  requireEqual(suites.upgrade.identityMigration, 'migrated', 'QA upgrade identityMigration')
  requireEqual(suites.upgrade.modelCalls, 0, 'QA upgrade modelCalls')
  if (typeof report.finalExeUpgrade?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(report.finalExeUpgrade.sha256)) {
    throw new Error('QA 最终 EXE SHA256 缺失或无效')
  }
  if (!Array.isArray(report.finalExeUpgrade?.runs) || report.finalExeUpgrade.runs.length < 5) {
    throw new Error('QA 缺少至少 5 次最终 EXE 升级复验')
  }
  for (const [index, run] of report.finalExeUpgrade.runs.entries()) {
    requireNumber(run.passed, `finalExeUpgrade[${index}].passed`, 97)
    requireEqual(run.failed, 0, `finalExeUpgrade[${index}].failed`)
    requireEqual(run.modelCalls, 0, `finalExeUpgrade[${index}].modelCalls`)
    requireEqual(run.sha256, report.finalExeUpgrade.sha256, `finalExeUpgrade[${index}].sha256`)
  }
}

export function runViewArguments(runId) {
  return ['run', 'view', String(runId), '--json', 'headSha,conclusion,status,jobs']
}

function defaultRunVerifier(repo, runId) {
  const output = execFileSync('gh', [...runViewArguments(runId), '--repo', repo], {
    encoding: 'utf8',
    env: process.env,
  })
  return JSON.parse(output)
}

function verifyGithubRun(signoff, runVerifier) {
  const repo = process.env.GITHUB_REPOSITORY
  if (typeof repo !== 'string' || repo === '') throw new Error('缺少 GITHUB_REPOSITORY')
  requireNumber(signoff.qa?.runId, 'QA runId', 1)
  requireEqual(signoff.qa?.headSha, signoff.candidateCommit, '签字 QA headSha')
  requireEqual(signoff.qa?.conclusion, 'success', '签字 QA conclusion')
  if (!Array.isArray(signoff.qa?.requiredJobs) || signoff.qa.requiredJobs.length !== REQUIRED_JOBS.length
    || [...signoff.qa.requiredJobs].sort().join('\n') !== [...REQUIRED_JOBS].sort().join('\n')) {
    throw new Error('签字 QA requiredJobs 与必需 job 集合不一致')
  }
  const run = runVerifier(repo, signoff.qa.runId)
  requireEqual(run.status, 'completed', 'CI status')
  requireEqual(run.headSha, signoff.candidateCommit, 'CI headSha')
  requireEqual(run.conclusion, 'success', 'CI conclusion')
  if (!Array.isArray(run.jobs) || run.jobs.length !== REQUIRED_JOBS.length) {
    throw new Error(`CI job 集合不是精确的 ${REQUIRED_JOBS.length} 项`)
  }
  const jobs = new Map()
  for (const job of run.jobs) {
    if (jobs.has(job.name)) throw new Error(`CI job 名称重复：${job.name}`)
    jobs.set(job.name, job)
  }
  if (jobs.size !== REQUIRED_JOBS.length) throw new Error(`CI job 集合不是精确的 ${REQUIRED_JOBS.length} 项`)
  let derivedCompletedAtMs = 0
  for (const name of REQUIRED_JOBS) {
    const job = jobs.get(name)
    if (job === undefined) throw new Error(`CI 缺少必需 job：${name}`)
    requireEqual(job.status, 'completed', `CI job ${name} status`)
    requireEqual(job.conclusion, 'success', `CI job ${name} conclusion`)
    if (typeof job.completedAt !== 'string' || Number.isNaN(Date.parse(job.completedAt))) {
      throw new Error(`CI job ${name} completedAt 缺失或无效`)
    }
    derivedCompletedAtMs = Math.max(derivedCompletedAtMs, Date.parse(job.completedAt))
  }
  if (run.completedAt !== undefined) {
    if (typeof run.completedAt !== 'string' || Number.isNaN(Date.parse(run.completedAt))) {
      throw new Error('CI completedAt 缺失或无效')
    }
    if (Date.parse(run.completedAt) !== derivedCompletedAtMs) throw new Error('CI completedAt 与必需 job 完成时间不一致')
  }
}

function verifyCommitBinding(root, signoff, currentCommit) {
  if (typeof signoff.candidateCommit !== 'string' || !/^[0-9a-f]{40}$/.test(signoff.candidateCommit)) {
    throw new Error('candidateCommit 缺失或不是完整 SHA')
  }
  if (!/^[0-9a-f]{40}$/.test(currentCommit)) throw new Error('当前 Tag commit 不是完整 SHA')
  execFileSync('git', ['merge-base', '--is-ancestor', signoff.candidateCommit, currentCommit], { cwd: root })
  const changed = git(root, ['diff', '--name-only', '-z', signoff.candidateCommit, currentCommit])
    .split('\0')
    .filter((path) => path !== '')
  if (changed.length === 0) throw new Error('Tag 与候选 commit 完全相同，无法包含后生成的签字证据')
  for (const path of changed) {
    if (!path.startsWith('docs/')) throw new Error(`Tag 修改了签字允许范围之外的产品/构建文件：${path}`)
  }
  execFileSync('git', ['diff', '--quiet', signoff.candidateCommit, currentCommit, '--', ...PROTECTED_PATHS], { cwd: root })
}

export function verifyReleaseSignoff(options = {}) {
  const root = options.root ?? ROOT
  const errors = []
  try {
    const signoff = readJson(root, options.signoffPath ?? SIGNOFF_PATH)
    requireEqual(signoff.schemaVersion, 1, '签字 schemaVersion')
    requireEqual(signoff.version, '0.2.2', '签字 version')
    requireEqual(signoff.status, 'GO', '签字 status')
    requireEqual(signoff.tag, 'v0.2.2', '签字 tag')
    if (options.expectedCandidateCommit !== undefined) requireEqual(signoff.candidateCommit, options.expectedCandidateCommit, 'RELEASE_CANDIDATE_COMMIT')
    if (options.expectedReleaseCommit !== undefined) requireEqual(options.currentCommit ?? git(root, ['rev-parse', 'HEAD']), options.expectedReleaseCommit, 'RELEASE_TAG_COMMIT')
    verifyCommitBinding(root, signoff, options.currentCommit ?? git(root, ['rev-parse', 'HEAD']))
    verifyFreeze(root, signoff)
    verifySoak(root, signoff)
    verifyQaReport(root, signoff)
    verifyGithubRun(signoff, options.runVerifier ?? defaultRunVerifier)
    return { ok: true, signoff, errors }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
    return { ok: false, errors }
  }
}

function main() {
  const result = verifyReleaseSignoff({
    expectedCandidateCommit: process.env.RELEASE_CANDIDATE_COMMIT,
    expectedReleaseCommit: process.env.RELEASE_TAG_COMMIT,
  })
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`发布签字复验失败：${error}\n`)
    process.exitCode = 1
    return
  }
  const currentCommit = git(ROOT, ['rev-parse', 'HEAD'])
  const tagObject = typeof process.env.TAG === 'string' && process.env.TAG !== ''
    ? git(ROOT, ['rev-parse', `refs/tags/${process.env.TAG}`])
    : currentCommit
  if (process.env.GITHUB_ENV !== undefined) {
    appendFileSync(process.env.GITHUB_ENV, `RELEASE_CANDIDATE_COMMIT=${result.signoff.candidateCommit}\nRELEASE_TAG_COMMIT=${currentCommit}\nRELEASE_TAG_OBJECT=${tagObject}\n`, 'utf8')
  }
  if (process.env.GITHUB_OUTPUT !== undefined) {
    appendFileSync(process.env.GITHUB_OUTPUT, `candidate_commit=${result.signoff.candidateCommit}\ntag_commit=${currentCommit}\ntag_object=${tagObject}\n`, 'utf8')
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    tag: result.signoff.tag,
    candidateCommit: result.signoff.candidateCommit,
    tagCommit: currentCommit,
    tagObject,
    qaRunId: result.signoff.qa.runId,
    soakWallClockSeconds: result.signoff.soak.wallClockSeconds,
    soakActiveSeconds: result.signoff.soak.activeSeconds,
  }, null, 2)}\n`)
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`发布签字复验失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
