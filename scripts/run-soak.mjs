#!/usr/bin/env node
/**
 * Cross-platform supervisor for the resumable v0.2.2 soak.
 *
 * A child may kill itself only at a persisted safe point. The supervisor resumes
 * only when durable state proves that exact child PID recorded one planned
 * process_kill and incremented both kill counters. Bare exit 137, external
 * signals, spawn errors, missing/stale state and watchdog failures are fatal.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CHILD = join(ROOT, 'test', 'stress', 'soak-v022.ts')
const WATCHDOG_POLL_MS = 1_000
const SUPERVISOR_VERSION = 1

export function parse(argv) {
  const values = new Map()
  const flags = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]
    if (!entry.startsWith('--')) continue
    const equals = entry.indexOf('=')
    if (equals >= 0) {
      values.set(entry.slice(2, equals), entry.slice(equals + 1))
    } else {
      const name = entry.slice(2)
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        values.set(name, next)
        index += 1
      } else {
        flags.add(name)
      }
    }
  }
  const number = (name, fallback, minimum = 0, integer = false) => {
    const raw = values.get(name)
    if (raw === undefined) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < minimum || (integer && !Number.isInteger(parsed))) {
      throw new Error(`--${name} 必须是 >= ${minimum}${integer ? ' 的整数' : ' 的数字'}`)
    }
    return parsed
  }
  return {
    args: [...argv],
    seconds: number('seconds', 86_400, 0.001),
    killEvery: number('kill-every', 0),
    noKill: flags.has('no-kill'),
    stateFile: values.get('state-file'),
    report: values.get('report'),
    maxStateAgeMs: number('max-state-age-ms', 15_000, 250),
    startupGraceMs: number('startup-grace-ms', 30_000, 250),
    maxRestartGapMs: number('max-restart-gap-ms', 30_000, 250),
    maxTickActiveMs: number('max-tick-active-ms', 15_000, 250, true),
    drainTimeoutMs: number('drain-timeout-ms', 300_000, 250, true),
    maxTotalDowntimeMs: number('max-total-downtime-ms', 1_800_000, 0),
    maxRestarts: number('max-restarts', 1_000, 0),
  }
}

export function childArguments(original, stateFile, seconds, resume, deadline, maxTickActiveMs, drainTimeoutMs) {
  const forwarded = []
  const skipWithValue = new Set(['seconds', 'state-file', 'deadline', 'max-state-age-ms', 'startup-grace-ms', 'max-restart-gap-ms', 'max-tick-active-ms', 'drain-timeout-ms', 'max-total-downtime-ms', 'max-restarts'])
  for (let index = 0; index < original.length; index += 1) {
    const entry = original[index]
    if (skipWithValue.has(entry.slice(2))) {
      index += 1
      continue
    }
    if ([...skipWithValue].some((name) => entry.startsWith(`--${name}=`))) continue
    if (entry === '--no-kill') continue
    forwarded.push(entry)
  }
  forwarded.push(
    `--seconds=${Math.max(0.001, seconds)}`,
    `--state-file=${stateFile}`,
    `--deadline=${deadline}`,
    `--max-tick-active-ms=${maxTickActiveMs}`,
    `--drain-timeout-ms=${drainTimeoutMs}`,
  )
  if (resume) forwarded.push('--resume')
  return forwarded
}

export function readState(file) {
  if (!existsSync(file)) return undefined
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'))
    return state !== null && typeof state === 'object' ? state : undefined
  } catch {
    return undefined
  }
}

function countOf(state, name) {
  const value = state?.faults?.counts?.[name]?.actual ?? state?.faults?.[name]?.actual
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stateAgeMs(state, now) {
  const tick = Date.parse(state?.lastTickAt ?? '')
  return Number.isFinite(tick) ? Math.max(0, now - tick) : Number.POSITIVE_INFINITY
}

export function classifyInterruption(result, options) {
  const { canKill, before, after, pid, now, maxStateAgeMs } = options
  if (!canKill) return { planned: false, reason: '本次运行未启用计划内进程杀死' }
  if (result.signal !== 'SIGKILL' && result.code !== 137) {
    return { planned: false, reason: `非计划内信号/退出：signal=${String(result.signal)} code=${String(result.code)}` }
  }
  if (after === undefined) return { planned: false, reason: '子进程退出后缺少可解析的持久状态文件' }
  if (after.version !== 2) return { planned: false, reason: `持久 Soak 状态版本不是 v2：${String(after.version)}` }
  for (const key of ['activeMs', 'maxTickActiveMs', 'tickActiveLimitMs']) {
    if (typeof after[key] !== 'number' || !Number.isFinite(after[key]) || after[key] < 0) {
      return { planned: false, reason: `持久 active 字段 ${key} 缺失或无效` }
    }
  }
  if (after.maxTickActiveMs > after.tickActiveLimitMs) return { planned: false, reason: '持久 maxTickActiveMs 超过上限' }
  for (const key of ['drainTimeoutMs', 'drainSeconds']) {
    if (typeof after[key] !== 'number' || !Number.isFinite(after[key]) || after[key] < 0) {
      return { planned: false, reason: `持久排空字段 ${key} 缺失或无效` }
    }
  }
  if (after.drainTimeoutMs < 250) return { planned: false, reason: '持久排空超时上限无效' }
  if (typeof after.drainTimedOut !== 'boolean' || after.drainTimedOut || after.drainSeconds !== 0) {
    return { planned: false, reason: '计划杀死只能发生在截止排空开始之前' }
  }
  if (typeof before?.activeMs === 'number' && after.activeMs < before.activeMs) return { planned: false, reason: '持久 activeMs 倒退' }
  if (typeof before?.maxTickActiveMs === 'number' && after.maxTickActiveMs < before.maxTickActiveMs) return { planned: false, reason: '持久 maxTickActiveMs 倒退' }
  if (after.completed === true) return { planned: false, reason: '持久状态显示子进程已完成，不能把退出解释为计划内杀死' }
  if (!Array.isArray(after.invariantFailures) || after.invariantFailures.length > 0) {
    return { planned: false, reason: '持久状态缺少不变量列表或已包含不变量失败' }
  }
  const beforeKills = typeof before?.kills === 'number' ? before.kills : 0
  const beforeProcessKills = countOf(before, 'process_kill')
  if (after.kills !== beforeKills + 1) {
    return { planned: false, reason: `持久 kills 未按计划增加：${beforeKills} -> ${String(after.kills)}` }
  }
  if (countOf(after, 'process_kill') !== beforeProcessKills + 1) {
    return { planned: false, reason: `持久 process_kill.actual 未按计划增加：${beforeProcessKills} -> ${countOf(after, 'process_kill')}` }
  }
  const age = stateAgeMs(after, now)
  if (!Number.isFinite(age) || age > maxStateAgeMs) {
    return { planned: false, reason: `计划杀死后的状态不新鲜：${Number.isFinite(age) ? `${age}ms` : 'lastTickAt 无效'}` }
  }
  const records = Array.isArray(after.faults?.recent) ? after.faults.recent : []
  const matchingPid = records.some((record) =>
    record?.kind === 'process_kill' && record?.outcome === 'actual' && typeof record.detail === 'string' && record.detail.includes(`pid=${pid}`),
  )
  if (!matchingPid) return { planned: false, reason: `持久 process_kill 记录不包含退出的子进程 PID=${String(pid)}` }
  return { planned: true }
}

export function runChild(args, options = {}) {
  const stateFile = options.stateFile
  const childPath = options.childPath ?? CHILD
  const maxStateAgeMs = options.maxStateAgeMs ?? 15_000
  const startupGraceMs = options.startupGraceMs ?? 30_000
  return new Promise((resolveRun) => {
    const startedAt = Date.now()
    const child = spawn(process.execPath, ['--experimental-transform-types', childPath, ...args], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let spawnError = ''
    let settled = false
    let watchdogReason = ''
    let watchdogTriggered = false
    let samples = 0
    let missingEvents = 0
    let staleEvents = 0
    let maxObservedStateAgeMs = 0
    let maxSteadyStateAgeMs = 0
    let maxTickGapMs = 0
    let lastTickAtMs
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000)
    })
    const observeState = (state, now, steady) => {
      if (state === undefined) return
      samples += 1
      const age = stateAgeMs(state, now)
      if (Number.isFinite(age)) {
        maxObservedStateAgeMs = Math.max(maxObservedStateAgeMs, age)
        if (steady) maxSteadyStateAgeMs = Math.max(maxSteadyStateAgeMs, age)
      }
      const tick = Date.parse(state.lastTickAt ?? '')
      if (Number.isFinite(tick)) {
        if (lastTickAtMs !== undefined) maxTickGapMs = Math.max(maxTickGapMs, tick - lastTickAtMs)
        lastTickAtMs = tick
      }
    }
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearInterval(watchdog)
      const endedAt = Date.now()
      observeState(stateFile === undefined ? undefined : readState(stateFile), endedAt, endedAt - startedAt > startupGraceMs)
      if (lastTickAtMs !== undefined) maxTickGapMs = Math.max(maxTickGapMs, endedAt - lastTickAtMs)
      resolveRun({
        pid: child.pid,
        startedAt,
        endedAt,
        code,
        signal,
        stdout,
        stderr,
        spawnError,
        watchdog: {
          triggered: watchdogTriggered,
          reason: watchdogReason,
          samples,
          missingEvents,
          staleEvents,
          maxObservedStateAgeMs,
          maxSteadyStateAgeMs,
          maxTickGapMs,
        },
      })
    }
    const watchdog = setInterval(() => {
      if (settled || stateFile === undefined) return
      const now = Date.now()
      const steady = now - startedAt > startupGraceMs
      const state = readState(stateFile)
      if (state === undefined) {
        if (steady) {
          missingEvents += 1
          watchdogReason ||= `子进程启动 ${startupGraceMs}ms 后仍未生成可解析状态文件`
          watchdogTriggered = true
          child.kill('SIGTERM')
        }
        return
      }
      observeState(state, now, steady)
      const age = stateAgeMs(state, now)
      if (steady && (!Number.isFinite(age) || age > maxStateAgeMs)) {
        staleEvents += 1
        watchdogReason ||= `子进程状态心跳过期：${Number.isFinite(age) ? `${age}ms` : 'lastTickAt 无效'}`
        watchdogTriggered = true
        child.kill('SIGTERM')
      }
    }, WATCHDOG_POLL_MS)
    watchdog.unref?.()
    child.on('error', (error) => {
      spawnError = error.stack ?? error.message
      stderr += `${stderr === '' ? '' : '\n'}${spawnError}`
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

export function parseReport(stdout) {
  const text = stdout.trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    for (let start = text.lastIndexOf('\n{'); start >= 0; start = text.lastIndexOf('\n{', start - 1)) {
      try {
        return JSON.parse(text.slice(start + 1))
      } catch {
        // Keep looking for the final report object.
      }
    }
    return undefined
  }
}

function atomicBytes(file, bytes) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.runner-tmp-${process.pid}`
  writeFileSync(temp, bytes)
  renameSync(temp, file)
}

function atomicJson(file, value) {
  atomicBytes(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function writeReportWithHash(file, report) {
  const bytes = `${JSON.stringify(report, null, 2)}\n`
  atomicBytes(file, bytes)
  const hash = createHash('sha256').update(bytes).digest('hex')
  atomicBytes(`${file}.sha256`, `${hash}  ${file.split(/[\\/]/).at(-1)}\n`)
  return hash
}

function updateStateProgress(stateFile, stats) {
  const state = readState(stateFile)
  if (state === undefined || typeof state.restarts !== 'number') throw new Error('无法更新 Soak 持久进度')
  state.restarts = stats.restarts
  // The supervisor observes the complete child lifetime, including the final
  // durable write and process teardown that the child cannot persist after exit.
  state.activeMs = stats.activeMs
  atomicJson(stateFile, state)
}

function emptyWatchdog() {
  return { triggered: false, reason: '', samples: 0, missingEvents: 0, staleEvents: 0, maxObservedStateAgeMs: 0, maxSteadyStateAgeMs: 0, maxTickGapMs: 0 }
}

function supervisorMeta(startedAt, endedAt, stats, stderr) {
  return {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    wallClockSeconds: Number(((endedAt - startedAt) / 1000).toFixed(3)),
    activeSeconds: Number((stats.activeMs / 1000).toFixed(3)),
    downtimeSeconds: Number((stats.downtimeMs / 1000).toFixed(3)),
    maxRestartGapMs: stats.maxRestartGapMs,
    maxTickGapMs: stats.watchdog.maxTickGapMs,
    maxTickActiveMs: stats.maxTickActiveMs,
    tickActiveLimitMs: stats.tickActiveLimitMs,
    drainTimeoutMs: stats.drainTimeoutMs,
    drainSeconds: stats.drainSeconds,
    drainTimedOut: stats.drainTimedOut,
    maxTotalDowntimeMs: stats.maxTotalDowntimeMs,
    maxRestarts: stats.maxRestarts,
    maxStateAgeMs: stats.maxStateAgeMs,
    maxRestartGapLimitMs: stats.maxRestartGapLimitMs,
    attempts: stats.attempts,
    restarts: stats.restarts,
    kills: stats.kills,
    unplannedInterruptions: stats.unplannedInterruptions,
    watchdog: { ...stats.watchdog },
    platform: process.platform,
    ...(stderr === '' ? {} : { stderrTail: stderr.slice(-2_000) }),
  }
}

function persistSupervisor(stateFile, startedAt, requestedSeconds, effectiveDeadline, stats, completed) {
  atomicJson(`${stateFile}.supervisor.json`, {
    schemaVersion: SUPERVISOR_VERSION,
    startedAt: new Date(startedAt).toISOString(),
    requestedSeconds,
    effectiveDeadline: new Date(effectiveDeadline).toISOString(),
    completed,
    ...stats,
    watchdog: { ...stats.watchdog },
  })
}

function failureReport(options, stateFile, startedAt, endedAt, stats, message, childReport, stderr) {
  const supervisor = supervisorMeta(startedAt, endedAt, stats, stderr)
  return {
    ...(childReport ?? {
      schemaVersion: 1,
      tool: 'soak-v022',
      status: 'failed',
      originalStartedAt: new Date(startedAt).toISOString(),
      actualStartedAt: new Date(startedAt).toISOString(),
      actualEndedAt: new Date(endedAt).toISOString(),
      wallClockSeconds: supervisor.wallClockSeconds,
      cumulativeSeconds: supervisor.wallClockSeconds,
      requestedSeconds: options.seconds,
      resumed: stats.restarts > 0,
      resumedAfterFailure: false,
      monitors: 0,
      threads: 0,
      seed: 0,
      stateFile,
      dataDir: `${stateFile}.data`,
      iterations: 0,
      scans: 0,
      analyses: 0,
      generations: 0,
      modelCalls: 0,
      candidates: 0,
      failures: 1,
      retries: 0,
      restarts: stats.restarts,
      kills: stats.kills,
      activeSeconds: supervisor.activeSeconds,
      maxTickActiveMs: supervisor.maxTickActiveMs,
      tickActiveLimitMs: supervisor.tickActiveLimitMs,
      drainTimeoutMs: supervisor.drainTimeoutMs,
      drainSeconds: 0,
      drainTimedOut: false,
      memoryPeakMb: 0,
      heapFinalMb: 0,
      cpuUsage: { userMicros: 0, systemMicros: 0, percent: 0 },
      peakQueue: 0,
      queueCapacity: 0,
      queueAtEnd: 0,
      peakLedger: 0,
      ledgerRowsAtEnd: 0,
      pendingAtEnd: 0,
      duplicateCandidates: 0,
      lostTasks: 0,
      convergenceLag: 0,
      convergenceLagPeak: 0,
      stuckIdentity: 0,
      authBlockedIdentity: 0,
      coreLockTimeouts: 0,
      lockTimeoutEvents: [],
      cursorRegressions: 0,
      completedTaskReexecutions: 0,
      unrecordedInterruptions: 0,
      unhandledErrors: 0,
      completed: false,
      sharedThreadGroups: 0,
      maxMonitorsPerThread: 0,
      totalRepliesCreated: 0,
      faults: {},
      recentFaults: [],
      diskTargets: ['auto_tasks', 'monitors', 'identities'],
      diskStoreActual: { auto_tasks: 0, monitors: 0, identities: 0 },
      diskStoreSkipped: { auto_tasks: 0, monitors: 0, identities: 0 },
      orphanSweepMs: 0,
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
      acknowledgedFailures: [],
      identities: { total: 0, claimed: 0, candidate: 0, ignored: 0, fallback: 0 },
      invariants: { supervisorChildSucceeded: false },
      invariantFailures: [message],
      limitations: ['子进程未产生完整报告。'],
    }),
    status: 'failed',
    restarts: stats.restarts,
    kills: stats.kills,
    completed: false,
    invariantFailures: [...new Set([...(childReport?.invariantFailures ?? []), message])],
    supervisor,
    actualStartedAt: supervisor.startedAt,
    actualEndedAt: supervisor.endedAt,
    wallClockSeconds: supervisor.wallClockSeconds,
    activeSeconds: supervisor.activeSeconds,
    downtimeSeconds: supervisor.downtimeSeconds,
    maxTickGapMs: supervisor.maxTickGapMs,
  }
}

const REQUIRED_REPORT_NUMBERS = [
  'wallClockSeconds', 'cumulativeSeconds', 'requestedSeconds', 'killEverySeconds', 'monitors', 'threads', 'seed',
  'iterations', 'scans', 'analyses', 'generations', 'modelCalls', 'candidates', 'failures',
  'retries', 'restarts', 'kills', 'activeSeconds', 'maxTickActiveMs', 'tickActiveLimitMs', 'drainTimeoutMs', 'drainSeconds', 'memoryPeakMb', 'heapFinalMb', 'peakQueue', 'queueCapacity',
  'queueAtEnd', 'peakLedger', 'ledgerRowsAtEnd', 'pendingAtEnd', 'duplicateCandidates',
  'lostTasks', 'convergenceLag', 'convergenceLagPeak', 'stuckIdentity', 'authBlockedIdentity',
  'coreLockTimeouts', 'cursorRegressions', 'completedTaskReexecutions', 'unrecordedInterruptions',
  'unhandledErrors', 'sharedThreadGroups', 'maxMonitorsPerThread', 'totalRepliesCreated',
  'storeWriteFailures', 'storeRestores', 'storeCorruptions', 'degradedDiskSessions',
  'undegradedDiskSessions', 'recoveredDiskBlockers', 'backlogSessions', 'operatorResumes',
  'queueRejections', 'prunedRows',
]
const REQUIRED_REPORT_STRINGS = ['originalStartedAt', 'actualStartedAt', 'actualEndedAt', 'stateFile', 'dataDir']
const REQUIRED_INVARIANTS = [
  'uniqueReplyCandidates', 'completedTasksNotReexecuted', 'cursorNeverRegresses',
  'interruptedTasksRecorded', 'queueWithinCapacity', 'heapWithinThreshold',
  'noUnhandledErrors', 'noCoreLockTimeouts', 'noLostTasks', 'noStuckIdentity',
  'noIdentityLedgerDrift', 'noTaskLedgerDrift', 'noStoreCorruption',
  'diskFailuresDegraded', 'activeTicksWithinLimit', 'drainConverged',
]

export function validatePassedReport(report, options, stats, stateFile) {
  const failures = []
  if (report?.schemaVersion !== 1 || report?.tool !== 'soak-v022') failures.push('报告 schema/tool 缺失或不匹配')
  if (report?.status !== 'passed') failures.push('子进程报告 status 不是 passed')
  if (report?.completed !== true) failures.push('子进程报告 completed 不是 true')
  for (const key of REQUIRED_REPORT_NUMBERS) {
    if (typeof report?.[key] !== 'number' || !Number.isFinite(report[key])) failures.push(`报告字段 ${key} 缺失或不是有限数字`)
  }
  for (const key of REQUIRED_REPORT_STRINGS) {
    if (typeof report?.[key] !== 'string' || report[key] === '') failures.push(`报告字段 ${key} 缺失或为空`)
  }
  for (const key of ['noKill', 'resumed', 'resumedAfterFailure', 'drainTimedOut']) {
    if (typeof report?.[key] !== 'boolean') failures.push(`报告字段 ${key} 缺失或不是布尔值`)
  }
  for (const key of ['faults', 'recentFaults', 'diskTargets', 'diskStoreActual', 'diskStoreSkipped', 'lockTimeoutEvents', 'acknowledgedFailures', 'limitations']) {
    if (report?.[key] === undefined) failures.push(`报告字段 ${key} 缺失`)
  }
  if (report?.cpuUsage === undefined || typeof report.cpuUsage !== 'object') failures.push('报告 cpuUsage 缺失')
  if (report?.identities === undefined || typeof report.identities !== 'object') failures.push('报告 identities 缺失')
  if (report?.engine === undefined || typeof report.engine !== 'object') failures.push('报告 engine 缺失')
  if (!Array.isArray(report?.invariantFailures) || report.invariantFailures.length > 0) failures.push('子进程报告包含不变量失败')
  if (report?.invariants === undefined || typeof report.invariants !== 'object') failures.push('报告 invariants 缺失')
  else {
    for (const key of REQUIRED_INVARIANTS) {
      if (report.invariants[key] !== true) failures.push(`不变量 ${key} 缺失或不为 true`)
    }
  }
  for (const key of [
    'duplicateCandidates', 'lostTasks', 'convergenceLag', 'stuckIdentity', 'coreLockTimeouts',
    'cursorRegressions', 'completedTaskReexecutions', 'unrecordedInterruptions', 'unhandledErrors',
  ]) {
    if (report?.[key] !== 0) failures.push(`严格不变量 ${key} 不为 0`)
  }
  if ((report?.wallClockSeconds ?? 0) < options.seconds - 0.01) failures.push(`墙钟时长不足：${String(report?.wallClockSeconds)} < ${options.seconds}`)
  if (stats.activeMs < options.seconds * 1000 - 10) failures.push(`连续 active 时长不足：${(stats.activeMs / 1000).toFixed(3)} < ${options.seconds}`)
  if (report?.drainTimeoutMs !== options.drainTimeoutMs) failures.push('Soak 排空超时参数与 supervisor 不一致')
  if (report?.drainSeconds !== stats.drainSeconds || report?.drainTimedOut !== stats.drainTimedOut) failures.push('Soak 排空结果与 supervisor 不一致')
  if (report?.drainTimedOut !== false) failures.push('Soak 截止排空超时')
  if ((report?.drainSeconds ?? Number.POSITIVE_INFINITY) > options.drainTimeoutMs / 1000) failures.push('Soak 排空时长超过阈值')
  if (report?.queueAtEnd !== 0 || report?.pendingAtEnd !== 0
    || report?.engine?.queued !== 0 || report?.engine?.runningTasks !== 0) {
    failures.push('Soak 截止后仍有排队或运行任务')
  }
  if (stats.downtimeMs > stats.restarts * options.maxRestartGapMs) failures.push('重启总间隔超过单次上限乘积')
  if (stats.downtimeMs > options.maxTotalDowntimeMs) failures.push(`总 downtime 超过 ${options.maxTotalDowntimeMs}ms`)
  if (stats.restarts > options.maxRestarts) failures.push(`重启次数超过 ${options.maxRestarts}`)
  if (stats.maxRestartGapMs > options.maxRestartGapMs) failures.push(`单次重启间隔超过 ${options.maxRestartGapMs}ms`)
  if (stats.maxTickActiveMs > options.maxTickActiveMs) failures.push(`持久 maxTickActiveMs 超过 ${options.maxTickActiveMs}ms`)
  if (stats.watchdog.maxTickGapMs > options.maxStateAgeMs) failures.push(`最大 tick 间隔超过 ${options.maxStateAgeMs}ms`)
  if (stats.unplannedInterruptions !== 0) failures.push(`存在 ${stats.unplannedInterruptions} 次未归因中断`)
  if (stats.watchdog.triggered || stats.watchdog.missingEvents > 0 || stats.watchdog.staleEvents > 0) failures.push('supervisor 心跳看门狗触发')
  if (stats.watchdog.maxSteadyStateAgeMs > options.maxStateAgeMs) failures.push(`观测到稳定期状态心跳年龄超过 ${options.maxStateAgeMs}ms`)
  if (stats.attempts !== stats.restarts + 1) failures.push('attempts 与 restarts 不一致')
  if (stats.kills !== stats.restarts) failures.push('kills 与 restarts 不一致')
  if (report?.kills !== stats.kills || report?.restarts !== stats.restarts) failures.push('报告 kills/restarts 与 supervisor 不一致')
  if (countOf(report, 'process_kill') !== stats.kills) failures.push('报告 process_kill.actual 与 kills 不一致')
  const state = readState(stateFile)
  if (state === undefined) failures.push('最终状态文件缺失或不可解析')
  else {
    if (state.version !== 2) failures.push('最终持久状态不是 Soak v2')
    if (state.completed !== true) failures.push('最终持久状态未标记 completed')
    if (state.activeMs !== stats.activeMs || state.maxTickActiveMs !== stats.maxTickActiveMs) failures.push('最终持久 active 与 supervisor 不一致')
    if (state.tickActiveLimitMs !== options.maxTickActiveMs) failures.push('最终持久 tick active 上限与参数不一致')
    if (state.drainTimeoutMs !== options.drainTimeoutMs || state.drainTimedOut !== false) failures.push('最终持久排空状态不一致或超时')
    if (typeof state.drainSeconds !== 'number' || !Number.isFinite(state.drainSeconds) || state.drainSeconds < 0) failures.push('最终持久 drainSeconds 缺失或无效')
    if (Math.abs((report?.drainSeconds ?? Number.POSITIVE_INFINITY) * 1000 - state.drainSeconds) > 0.5) failures.push('报告 drainSeconds 与持久状态不一致')
    if (Math.abs((report?.activeSeconds ?? 0) * 1000 - state.activeMs) > 0.5) failures.push('报告 activeSeconds 与持久状态不一致')
    if (state.kills !== stats.kills) failures.push('最终持久状态 kills 与 supervisor 不一致')
    if (countOf(state, 'process_kill') !== stats.kills) failures.push('最终持久状态 process_kill.actual 与 kills 不一致')
    if (!Array.isArray(state.invariantFailures) || state.invariantFailures.length > 0) failures.push('最终持久状态包含不变量失败')
    if (stateAgeMs(state, Date.now()) > options.maxStateAgeMs) failures.push('最终持久状态心跳不新鲜')
  }
  const persisted = readState(`${stateFile}.supervisor.json`)
  if (persisted?.schemaVersion !== SUPERVISOR_VERSION || persisted.completed !== true) failures.push('supervisor 持久累计缺失或未完成')
  else {
    for (const key of ['attempts', 'restarts', 'kills', 'activeMs', 'maxTickActiveMs', 'tickActiveLimitMs', 'drainTimeoutMs', 'drainSeconds', 'drainTimedOut', 'maxTotalDowntimeMs', 'maxRestarts', 'maxStateAgeMs', 'maxRestartGapLimitMs', 'downtimeMs', 'maxRestartGapMs', 'unplannedInterruptions']) {
      if (persisted[key] !== stats[key]) failures.push(`supervisor 持久字段 ${key} 与内存不一致`)
    }
    if (persisted.watchdog?.maxTickGapMs !== stats.watchdog.maxTickGapMs) failures.push('supervisor 持久 maxTickGapMs 不一致')
  }
  return failures
}

function emitFailure(options, stateFile, startedAt, endedAt, effectiveDeadline, stats, message, report, stderr) {
  try {
    persistSupervisor(stateFile, startedAt, options.seconds, effectiveDeadline, stats, false)
  } catch (error) {
    message += `；supervisor 状态持久化失败：${String(error)}`
  }
  const failed = failureReport(options, stateFile, startedAt, endedAt, stats, message, report, stderr)
  if (options.report !== undefined) {
    try {
      writeReportWithHash(resolve(options.report), failed)
    } catch (error) {
      process.stderr.write(`无法写入 supervisor 报告：${String(error)}\n`)
      process.exitCode = 1
    }
  }
  process.stdout.write(`${JSON.stringify(failed, null, 2)}\n`)
  process.exitCode = 1
}

async function main() {
  const options = parse(process.argv.slice(2))
  const startedAt = Date.now()
  let effectiveDeadline = startedAt + options.seconds * 1000
  const stateFile = options.stateFile === undefined
    ? join(mkdtempSync(join(tmpdir(), 'ai-debate-soak-runner-')), 'soak-state.json')
    : resolve(options.stateFile)
  if (existsSync(stateFile) || existsSync(`${stateFile}.supervisor.json`)) {
    throw new Error(`Soak 状态或 supervisor 累计已存在：${stateFile}；正式长跑必须使用全新状态目录`)
  }
  const canKill = options.killEvery > 0 && !options.noKill
  const stats = {
    attempts: 0,
    restarts: 0,
    kills: 0,
    activeMs: 0,
    maxTickActiveMs: 0,
    tickActiveLimitMs: options.maxTickActiveMs,
    drainTimeoutMs: options.drainTimeoutMs,
    drainSeconds: 0,
    drainTimedOut: false,
    maxTotalDowntimeMs: options.maxTotalDowntimeMs,
    maxRestarts: options.maxRestarts,
    maxStateAgeMs: options.maxStateAgeMs,
    maxRestartGapLimitMs: options.maxRestartGapMs,
    downtimeMs: 0,
    maxRestartGapMs: 0,
    unplannedInterruptions: 0,
    watchdog: emptyWatchdog(),
  }
  let before = readState(stateFile)
  let previousEndedAt

  while (Date.now() < effectiveDeadline) {
    const attemptStartedAt = Date.now()
    if (previousEndedAt !== undefined) {
      const gap = attemptStartedAt - previousEndedAt
      stats.downtimeMs += gap
      stats.maxRestartGapMs = Math.max(stats.maxRestartGapMs, gap)
      if (stats.downtimeMs > options.maxTotalDowntimeMs || stats.maxRestartGapMs > options.maxRestartGapMs || stats.restarts >= options.maxRestarts) {
        emitFailure(options, stateFile, startedAt, attemptStartedAt, effectiveDeadline, stats, '重启 downtime 或次数超过上限', undefined, '')
        return
      }
      effectiveDeadline += gap
    }
    stats.attempts += 1
    const remainingSeconds = Math.max(0.001, (effectiveDeadline - attemptStartedAt) / 1000)
    const args = childArguments(options.args, stateFile, remainingSeconds, stats.attempts > 1, effectiveDeadline, options.maxTickActiveMs, options.drainTimeoutMs)
    if (!canKill) args.push('--no-kill')
    const result = await runChild(args, options)
    const endedAt = Date.now()
    previousEndedAt = endedAt
    const report = parseReport(result.stdout)
    stats.drainSeconds = typeof report?.drainSeconds === 'number' && Number.isFinite(report.drainSeconds) && report.drainSeconds >= 0
      ? report.drainSeconds
      : 0
    stats.drainTimedOut = report?.drainTimedOut === true
    const after = readState(stateFile)
    if (after?.version === 2 && typeof after.activeMs === 'number' && Number.isFinite(after.activeMs)
      && typeof after.maxTickActiveMs === 'number' && Number.isFinite(after.maxTickActiveMs)) {
      if (after.activeMs < stats.activeMs || after.maxTickActiveMs < stats.maxTickActiveMs) {
        stats.unplannedInterruptions += 1
        emitFailure(options, stateFile, startedAt, endedAt, effectiveDeadline, stats, '持久 active/maxTickActiveMs 倒退', report, result.stderr)
        return
      }
      stats.activeMs += Math.max(0, endedAt - result.startedAt)
      stats.maxTickActiveMs = after.maxTickActiveMs
      stats.tickActiveLimitMs = after.tickActiveLimitMs
    } else if (result.code === 0 || result.signal === 'SIGKILL' || result.code === 137) {
      stats.unplannedInterruptions += 1
      emitFailure(options, stateFile, startedAt, endedAt, effectiveDeadline, stats, '子进程退出后缺少有效 Soak v2 active 状态', report, result.stderr)
      return
    }
    stats.watchdog.samples += result.watchdog.samples
    stats.watchdog.missingEvents += result.watchdog.missingEvents
    stats.watchdog.staleEvents += result.watchdog.staleEvents
    stats.watchdog.maxObservedStateAgeMs = Math.max(stats.watchdog.maxObservedStateAgeMs, result.watchdog.maxObservedStateAgeMs)
    stats.watchdog.maxSteadyStateAgeMs = Math.max(stats.watchdog.maxSteadyStateAgeMs, result.watchdog.maxSteadyStateAgeMs)
    stats.watchdog.maxTickGapMs = Math.max(stats.watchdog.maxTickGapMs, result.watchdog.maxTickGapMs)
    if (result.watchdog.triggered && !stats.watchdog.triggered) {
      stats.watchdog.triggered = true
      stats.watchdog.reason = result.watchdog.reason
    }
    try {
      persistSupervisor(stateFile, startedAt, options.seconds, effectiveDeadline, stats, false)
    } catch (error) {
      stats.unplannedInterruptions += 1
      emitFailure(options, stateFile, startedAt, endedAt, effectiveDeadline, stats, `无法持久累计 supervisor 状态：${String(error)}`, report, result.stderr)
      return
    }
    const interruption = classifyInterruption(result, {
      canKill,
      before,
      after,
      pid: result.pid,
      now: endedAt,
      maxStateAgeMs: options.maxStateAgeMs,
    })
    const lookedInterrupted = result.signal !== null || result.code === 137 || result.spawnError !== ''
    if (lookedInterrupted && !interruption.planned) {
      stats.unplannedInterruptions += 1
      emitFailure(options, stateFile, startedAt, endedAt, effectiveDeadline, stats, `不可归因的子进程中断：${interruption.reason}`, report, result.stderr)
      return
    }
    if (interruption.planned) {
      stats.restarts += 1
      stats.kills += 1
      if (endedAt >= effectiveDeadline) {
        emitFailure(options, stateFile, startedAt, endedAt, effectiveDeadline, stats, 'soak 在 effective deadline 到达时被计划杀死，未产生完成报告', report, result.stderr)
        return
      }
      try {
        updateStateProgress(stateFile, stats)
        persistSupervisor(stateFile, startedAt, options.seconds, effectiveDeadline, stats, false)
      } catch (error) {
        stats.unplannedInterruptions += 1
        emitFailure(options, stateFile, startedAt, endedAt, effectiveDeadline, stats, `无法更新持久 Soak 进度：${String(error)}`, report, result.stderr)
        return
      }
      before = readState(stateFile)
      continue
    }

    if (result.code === 0 && report?.status === 'passed' && report.completed === true) {
      const supervisor = supervisorMeta(startedAt, endedAt, stats, result.stderr)
      report.restarts = stats.restarts
      report.kills = stats.kills
      report.requestedSeconds = options.seconds
      report.supervisor = supervisor
      report.actualStartedAt = supervisor.startedAt
      report.actualEndedAt = supervisor.endedAt
      report.wallClockSeconds = supervisor.wallClockSeconds
      report.activeSeconds = supervisor.activeSeconds
      report.maxTickActiveMs = supervisor.maxTickActiveMs
      report.tickActiveLimitMs = supervisor.tickActiveLimitMs
      report.downtimeSeconds = supervisor.downtimeSeconds
      report.maxTickGapMs = supervisor.maxTickGapMs
      try {
        updateStateProgress(stateFile, stats)
        persistSupervisor(stateFile, startedAt, options.seconds, effectiveDeadline, stats, true)
      } catch (error) {
        stats.unplannedInterruptions += 1
        emitFailure(options, stateFile, startedAt, endedAt, effectiveDeadline, stats, `无法写入最终 supervisor 状态：${String(error)}`, report, result.stderr)
        return
      }
      const failures = validatePassedReport(report, options, stats, stateFile)
      if (failures.length > 0) {
        emitFailure(options, stateFile, startedAt, endedAt, effectiveDeadline, stats, `supervisor 拒绝假通过：${failures.join('；')}`, report, result.stderr)
        return
      }
      try {
        if (options.report !== undefined) {
          const hash = writeReportWithHash(resolve(options.report), report)
          process.stderr.write(`soak report SHA256: ${hash}\n`)
        }
      } catch (error) {
        emitFailure(options, stateFile, startedAt, endedAt, effectiveDeadline, stats, `无法写入最终 Soak 报告：${String(error)}`, report, result.stderr)
        return
      }
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }

    const message = result.code === 1 && report !== undefined
      ? 'soak 子进程报告不变量失败'
      : `soak 子进程异常退出（code=${String(result.code)}, signal=${String(result.signal)}）`
    emitFailure(options, stateFile, startedAt, endedAt, effectiveDeadline, stats, message, report, result.stderr)
    return
  }

  emitFailure(options, stateFile, startedAt, Date.now(), effectiveDeadline, stats, 'effective deadline 到达，但子进程没有产生完成报告', undefined, '')
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    const report = {
      schemaVersion: 1,
      tool: 'soak-v022',
      status: 'failed',
      actualStartedAt: new Date().toISOString(),
      actualEndedAt: new Date().toISOString(),
      wallClockSeconds: 0,
      completed: false,
      invariantFailures: [message],
      limitations: ['supervisor 在子进程启动前失败。'],
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.stderr.write(`soak supervisor 失败：${message}\n`)
    process.exitCode = 1
  })
}
