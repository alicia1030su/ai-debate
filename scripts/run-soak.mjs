#!/usr/bin/env node
/**
 * Cross-platform supervisor for the resumable v0.2.2 soak.
 *
 * The child may SIGKILL itself at a persisted safe point. This supervisor counts
 * that interruption, restarts the child with --resume, and stops at the original
 * wall-clock deadline. A normal child failure is propagated, never retried into
 * a fake pass.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CHILD = join(ROOT, 'test', 'stress', 'soak-v022.ts')

function parse(argv) {
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
  const number = (name, fallback, minimum = 0) => {
    const raw = values.get(name)
    if (raw === undefined) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < minimum) throw new Error(`--${name} 必须是 >= ${minimum} 的数字`)
    return parsed
  }
  return {
    args: [...argv],
    seconds: number('seconds', 86_400, 0.001),
    killEvery: number('kill-every', 0),
    noKill: flags.has('no-kill'),
    stateFile: values.get('state-file'),
    report: values.get('report'),
  }
}

function childArguments(original, stateFile, seconds, resume, deadline) {
  const forwarded = []
  for (let index = 0; index < original.length; index += 1) {
    const entry = original[index]
    if (entry === '--seconds' || entry === '--state-file' || entry === '--deadline') {
      index += 1
      continue
    }
    if (entry.startsWith('--seconds=') || entry.startsWith('--state-file=') || entry.startsWith('--deadline=')) continue
    forwarded.push(entry)
  }
  forwarded.push(
    `--seconds=${Math.max(0.001, seconds)}`,
    `--state-file=${stateFile}`,
    `--deadline=${deadline}`,
  )
  if (resume) forwarded.push('--resume')
  return forwarded
}

function runChild(args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', CHILD, ...args], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
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
    child.on('error', (error) => resolveRun({ code: null, signal: null, stdout, stderr: `${stderr}\n${error.stack ?? error.message}` }))
    child.on('close', (code, signal) => resolveRun({ code, signal, stdout, stderr }))
  })
}

function parseReport(stdout) {
  const text = stdout.trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    // Node warnings can precede the JSON. Try the last JSON object rather
    // than guessing from the first '{' in a warning message.
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

function atomicJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.runner-tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

function updateStateRestarts(stateFile, restarts) {
  if (!existsSync(stateFile)) return
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (typeof state.restarts === 'number' && state.restarts < restarts) {
      state.restarts = restarts
      atomicJson(stateFile, state)
    }
  } catch {
    // The child report remains authoritative; a supervisor bookkeeping failure
    // must not turn a completed soak into a fabricated success.
  }
}

function failureReport(options, stateFile, startedAt, endedAt, restarts, attempts, message, childReport, stderr) {
  return {
    ...(childReport ?? {
      schemaVersion: 1,
      tool: 'soak-v022',
      status: 'failed',
      originalStartedAt: new Date(startedAt).toISOString(),
      actualStartedAt: new Date(startedAt).toISOString(),
      actualEndedAt: new Date(endedAt).toISOString(),
      wallClockSeconds: Number(((endedAt - startedAt) / 1000).toFixed(3)),
      cumulativeSeconds: Number(((endedAt - startedAt) / 1000).toFixed(3)),
      requestedSeconds: options.seconds,
      resumed: restarts > 0,
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
      restarts,
      kills: 0,
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
      identities: { total: 0, claimed: 0, candidate: 0, ignored: 0, fallback: 0 },
      invariants: { supervisorChildSucceeded: false },
      invariantFailures: [message],
      limitations: ['子进程未产生完整报告。'],
    }),
    status: 'failed',
    restarts: Math.max(restarts, childReport?.restarts ?? 0),
    completed: false,
    invariantFailures: [...new Set([...(childReport?.invariantFailures ?? []), message])],
    supervisor: {
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      wallClockSeconds: Number(((endedAt - startedAt) / 1000).toFixed(3)),
      attempts,
      restarts,
      platform: process.platform,
      ...(stderr === '' ? {} : { stderrTail: stderr.slice(-2_000) }),
    },
    actualStartedAt: new Date(startedAt).toISOString(),
    actualEndedAt: new Date(endedAt).toISOString(),
    wallClockSeconds: Number(((endedAt - startedAt) / 1000).toFixed(3)),
  }
}

async function main() {
  const options = parse(process.argv.slice(2))
  const startedAt = Date.now()
  const deadline = startedAt + options.seconds * 1000
  const stateFile = options.stateFile === undefined
    ? join(mkdtempSync(join(tmpdir(), 'ai-debate-soak-runner-')), 'soak-state.json')
    : resolve(options.stateFile)
  const canKill = options.killEvery > 0 && !options.noKill
  let restarts = 0
  let attempts = 0

  while (Date.now() < deadline) {
    attempts += 1
    const remainingSeconds = Math.max(0.001, (deadline - Date.now()) / 1000)
    const args = childArguments(options.args, stateFile, remainingSeconds, attempts > 1, deadline)
    if (!canKill) args.push('--no-kill')
    const result = await runChild(args)
    const endedAt = Date.now()
    const report = parseReport(result.stdout)
    const interrupted = result.signal === 'SIGKILL' || result.code === 137 || (canKill && result.signal !== null)

    if (interrupted && endedAt < deadline) {
      restarts += 1
      continue
    }
    if (interrupted && endedAt >= deadline) {
      restarts += 1
      const message = 'soak 在 supervisor deadline 到达时被中断，未产生完成报告'
      const failed = failureReport(options, stateFile, startedAt, endedAt, restarts, attempts, message, report, result.stderr)
      updateStateRestarts(stateFile, restarts)
      process.stdout.write(`${JSON.stringify(failed, null, 2)}\n`)
      if (options.report !== undefined) {
        try {
          atomicJson(resolve(options.report), failed)
        } catch (error) {
          process.stderr.write(`无法写入 supervisor 报告：${String(error)}\n`)
          process.exitCode = 1
        }
      }
      process.exitCode = 1
      return
    }

    if (result.code === 0 && report?.status === 'passed' && report.completed === true) {
      report.restarts = Math.max(restarts, report.restarts ?? 0)
      report.requestedSeconds = options.seconds
      report.supervisor = {
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        wallClockSeconds: Number(((endedAt - startedAt) / 1000).toFixed(3)),
        attempts,
        restarts,
        platform: process.platform,
      }
      report.actualStartedAt = report.supervisor.startedAt
      report.actualEndedAt = report.supervisor.endedAt
      report.wallClockSeconds = report.supervisor.wallClockSeconds
      updateStateRestarts(stateFile, restarts)
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      if (options.report !== undefined) {
        try {
          atomicJson(resolve(options.report), report)
        } catch (error) {
          process.stderr.write(`无法写入 supervisor 报告：${String(error)}\n`)
          process.exitCode = 1
        }
      }
      return
    }

    const message = result.code === 1 && report !== undefined
      ? 'soak 子进程报告不变量失败'
      : `soak 子进程异常退出（code=${String(result.code)}, signal=${String(result.signal)}）`
    const failed = failureReport(options, stateFile, startedAt, endedAt, restarts, attempts, message, report, result.stderr)
    updateStateRestarts(stateFile, restarts)
    if (options.report !== undefined) atomicJson(resolve(options.report), failed)
    process.stdout.write(`${JSON.stringify(failed, null, 2)}\n`)
    process.exitCode = 1
    return
  }

  const endedAt = Date.now()
  const message = 'supervisor deadline 到达，但子进程没有产生完成报告'
  const failed = failureReport(options, stateFile, startedAt, endedAt, restarts, attempts, message, undefined, '')
  process.stdout.write(`${JSON.stringify(failed, null, 2)}\n`)
  if (options.report !== undefined) {
    try {
      atomicJson(resolve(options.report), failed)
    } catch (error) {
      process.stderr.write(`无法写入 supervisor 报告：${String(error)}\n`)
      process.exitCode = 1
    }
  }
  process.exitCode = 1
}

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
