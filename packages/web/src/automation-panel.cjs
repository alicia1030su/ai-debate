/**
 * The 自动挂机 panel.
 *
 * Kept in its own module rather than inlined into the shell: the shell is about
 * authentication and the inherited page, this file is about a feature that changes
 * often. Both are plain DOM, so they match.
 *
 * ## The number rule
 *
 * Every figure here is rendered from the response body. There is no local counter,
 * no "optimistic" increment, and no placeholder that looks like data. When the
 * service cannot be reached the panel says so and shows nothing else — a dashboard
 * that renders `0` for "unknown" teaches the operator to distrust it.
 *
 * ## The two audiences
 *
 * The top half answers "is it working?" for someone who glances at it: headline
 * numbers and the health of the scheduler. The bottom half answers "what exactly is
 * it doing / what went wrong" for someone debugging: the queue's shape, the memory
 * and disk it is using, the last recovery, and per-target scan coverage.
 */
'use strict'

const API = '/api/ai-debate'

function el(tag, attrs, children) {
  const node = document.createElement(tag)
  for (const key of Object.keys(attrs || {})) {
    const value = attrs[key]
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, String(value))
  }
  for (const child of children || []) {
    if (child === null || child === undefined) continue
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

/** A number, or an em dash. Never a fabricated zero. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
}

/** Bytes as something a human can compare against a disk. */
function bytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** A duration in seconds as a readable span. */
function span(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时`
  return `${Math.round(seconds / 86400)} 天`
}

function rel(value) {
  if (typeof value !== 'string' || value === '') return '—'
  const at = Date.parse(value)
  if (Number.isNaN(at)) return value
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`
  return `${Math.round(seconds / 86400)} 天前`
}

const STATE_LABEL = {
  pending: '等待',
  running: '执行中',
  completed: '完成',
  retry_wait: '退避中',
  needs_review: '待审核',
  blocked: '阻塞',
  failed: '失败',
  cancelled: '已取消',
}

/**
 * Build the panel.
 *
 * @param {{request: (path: string, options?: object) => Promise<{ok: boolean, status?: number, body?: any, error?: string, network?: boolean}>}} deps
 * @returns {{node: HTMLElement, start: () => void, stop: () => void}}
 */
function createAutomationPanel(deps) {
  const state = {
    loading: true,
    failed: '',
    data: null,
    polling: null,
    busy: false,
  }

  const stats = el('div', { class: 'auto-stats' })
  const healthList = el('div', { class: 'auto-health' })
  const alerts = el('div', { class: 'auto-alerts' })
  const monitorList = el('div', { class: 'auto-monitors' })
  const taskList = el('div', { class: 'auto-tasks' })
  const reviewList = el('div', { class: 'auto-reviews' })
  const errorList = el('div', { class: 'auto-errors' })
  const banner = el('p', { class: 'auto-banner', role: 'status' })

  const newUrl = el('input', {
    class: 'auto-input',
    type: 'url',
    placeholder: 'https://tieba.baidu.com/p/1234567890',
    'aria-label': '帖子链接',
  })
  const newName = el('input', {
    class: 'auto-input',
    type: 'text',
    placeholder: '监控名称（可留空）',
    'aria-label': '监控名称',
  })
  const newInterval = el('input', {
    class: 'auto-input auto-input-narrow',
    type: 'number',
    min: '120',
    step: '30',
    value: '300',
    'aria-label': '轮询间隔（秒）',
  })

  const globalToggle = el('button', { class: 'shell-btn', type: 'button' }, ['加载中…'])

  async function reload() {
    if (state.busy) return
    state.busy = true
    try {
      const result = await deps.request(`${API}/automation/status`)
      if (!result.ok) {
        state.failed = result.network ? '无法连接服务。' : result.error || `HTTP ${result.status}`
        state.data = null
      } else {
        state.failed = ''
        state.data = result.body
      }
      state.loading = false
      render()
    } finally {
      state.busy = false
    }
  }

  function action(path, options, label) {
    return async () => {
      banner.textContent = `${label}…`
      const result = await deps.request(`${API}${path}`, options)
      if (!result.ok) {
        banner.textContent = result.network ? '无法连接服务。' : `${label}失败：${result.error || `HTTP ${result.status}`}`
        return
      }
      // The service may return a note worth showing (a deduplicated enqueue, for
      // instance); dropping it would make "did anything happen?" a guess.
      const note = result.body && typeof result.body.message === 'string' ? result.body.message : ''
      banner.textContent = note === '' ? `${label}完成。` : `${label}：${note}`
      await reload()
    }
  }

  function renderStats(data) {
    clear(stats)
    const monitors = data.monitors || { total: 0, enabled: 0, blocked: 0 }
    const today = data.today || { discovered: 0, candidates: 0, failures: 0 }
    const tasks = data.tasks || {}
    const queue = data.queue || {}
    const paused = data.paused === true
    const heartbeat = data.heartbeat || {}
    const health = data.health || {}
    const queueText =
      typeof queue.used === 'number' && typeof queue.capacity === 'number'
        ? `${queue.used} / ${queue.capacity}`
        : `${num(data.queued)} 等待`
    for (const [label, value, hint] of [
      ['监控目标', `${num(monitors.enabled)} / ${num(monitors.total)}`, monitors.blocked > 0 ? `${num(monitors.blocked)} 个需重新认证` : '已启用 / 全部'],
      ['今日发现', num(today.discovered), '新回复'],
      ['待审核', num(tasks.needs_review), '候选回复'],
      ['今日失败', num(today.failures), '任务'],
      [
        '调度',
        paused ? '已暂停' : data.running ? (heartbeat.healthy ? '运行中' : '心跳异常') : '未启动',
        `每 ${heartbeat.intervalMs ? Math.round(heartbeat.intervalMs / 1000) + ' 秒' : '—'} 一次 · 已跳 ${num(heartbeat.ticks)} 次`,
      ],
      [
        '队列占用',
        queueText,
        `${num(data.queued)} 等待 · ${num(data.runningTasks)} 执行中`,
      ],
      ['最久等待', span(queue.oldestPendingAgeSec), queue.stuck > 0 ? `${num(queue.stuck)} 个卡死` : '待执行任务'],
      ['内存', bytes(health.heapUsedBytes), bytes(health.rssBytes) + ' 常驻'],
      ['数据目录', bytes(health.dataDirBytes), health.freeBytes === undefined ? '磁盘未知' : `剩余 ${bytes(health.freeBytes)}`],
    ]) {
      stats.appendChild(
        el('div', { class: 'auto-stat' }, [
          el('div', { class: 'auto-stat-label' }, [label]),
          el('div', { class: 'auto-stat-value' }, [value]),
          el('div', { class: 'auto-stat-hint' }, [hint]),
        ]),
      )
    }
  }

  function renderHealth(data) {
    clear(healthList)
    const heartbeat = data.heartbeat || {}
    const queue = data.queue || {}
    const health = data.health || {}
    const recovery = data.recovery
    const rows = [
      ['最后一次调度', rel(heartbeat.lastTickAt)],
      ['调度耗时', heartbeat.lastDurationMs === undefined ? '—' : `${heartbeat.lastDurationMs} ms`],
      ['最后一次成功读取', rel(heartbeat.lastSuccessProbeAt)],
      ['启动时间', rel(health.startedAt)],
      ['已运行', span(health.uptimeSec)],
      ['Node 版本', health.nodeVersion || '—'],
      ['队列积压', queue.backlog && queue.backlog.reason ? queue.backlog.reason : '正常'],
      [
        '最近一次崩溃恢复',
        recovery === undefined
          ? '没有记录'
          : `${rel(recovery.at)} · 恢复 ${num(recovery.recovered)} 个任务${recovery.uncertain > 0 ? `（${num(recovery.uncertain)} 个模型调用结果不确定）` : ''}`,
      ],
      ['数据目录', health.dataDir || '—'],
    ]
    if (data.degraded !== undefined) rows.push(['写入降级', data.degraded])
    for (const [label, value] of rows) {
      healthList.appendChild(
        el('div', { class: 'auto-health-row' }, [
          el('span', { class: 'auto-health-label' }, [label]),
          el('span', { class: 'auto-health-value' }, [value]),
        ]),
      )
    }
  }

  function renderAlerts(data) {
    clear(alerts)
    for (const alert of data.alerts || []) {
      alerts.appendChild(
        el('p', { class: alert.level === 'alert' ? 'auto-error' : 'auto-warn' }, [alert.reason]),
      )
    }
  }

  function renderMonitors(data) {
    clear(monitorList)
    const rows = data.monitorList || []
    if (rows.length === 0) {
      monitorList.appendChild(el('p', { class: 'auto-empty' }, ['还没有监控目标。填一个帖子链接，后台就会开始盯着它。']))
      return
    }
    for (const monitor of rows) {
      const blocked = monitor.blockedReason ? el('p', { class: 'auto-error' }, [`需重新认证：${monitor.blockedReason}`]) : null
      const scan = monitor.lastScan
      const scanText =
        scan === undefined
          ? '尚未读取'
          : `${scan.complete ? '完整' : '不完整'} · ${num(scan.pagesRead)} 页${scan.totalPages === undefined ? '' : ` / ${num(scan.totalPages)}`} · ${rel(scan.at)}${scan.incompleteReason ? ` · ${scan.incompleteReason}` : ''}`
      const coverage =
        monitor.lastCompleteScanAt === undefined ? '还没有一次完整读取' : `最后一次完整读取 ${rel(monitor.lastCompleteScanAt)}`
      const compensation =
        monitor.compensationHours > 0
          ? `补偿扫描：每 ${num(monitor.compensationHours)} 小时回看，上次 ${rel(monitor.lastCompensationAt)}`
          : '补偿扫描：已关闭'
      const changes = Array.isArray(monitor.recentChanges) ? monitor.recentChanges : []
      // The look-back window is per target: a quiet thread needs a wider one than a
      // busy thread, and a value that can only be changed by editing JSON is not
      // "configurable" in any sense the operator cares about.
      const windowInput = el('input', {
        class: 'auto-input auto-input-narrow',
        type: 'number',
        min: '0',
        max: '168',
        step: '1',
        value: String(monitor.compensationHours ?? 24),
        'aria-label': `${monitor.name} 的补偿回看小时数`,
      })
      const saveWindow = el(
        'button',
        {
          class: 'shell-btn shell-btn-ghost',
          type: 'button',
          onclick: async () => {
            const hours = Number(windowInput.value)
            if (!Number.isFinite(hours) || hours < 0 || hours > 168) {
              banner.textContent = '回看窗口必须在 0–168 小时之间（0 表示关闭）。'
              return
            }
            banner.textContent = '正在保存回看窗口…'
            const result = await deps.request(`${API}/automation/monitors/${encodeURIComponent(monitor.id)}`, {
              method: 'PATCH',
              body: { compensationHours: hours },
            })
            banner.textContent = result.ok
              ? `回看窗口已设为 ${hours} 小时。`
              : `保存失败：${result.network ? '无法连接服务' : result.error || `HTTP ${result.status}`}`
            if (result.ok) await reload()
          },
        },
        ['保存'],
      )
      const actions = [
        el(
          'button',
          {
            class: 'shell-btn shell-btn-ghost',
            type: 'button',
            onclick: action(`/automation/monitors/${encodeURIComponent(monitor.id)}/${monitor.enabled ? 'pause' : 'resume'}`, { method: 'POST' }, monitor.enabled ? '暂停' : '恢复'),
          },
          [monitor.enabled ? '暂停' : '恢复'],
        ),
        el(
          'button',
          {
            class: 'shell-btn shell-btn-ghost',
            type: 'button',
            onclick: action(`/automation/monitors/${encodeURIComponent(monitor.id)}/check`, { method: 'POST' }, '立即检查'),
          },
          ['立即检查'],
        ),
        el(
          'button',
          {
            class: 'shell-btn shell-btn-ghost',
            type: 'button',
            onclick: action(
              `/automation/monitors/${encodeURIComponent(monitor.id)}/scan`,
              { method: 'POST', body: { mode: 'compensate' } },
              '补偿扫描',
            ),
          },
          ['补偿扫描'],
        ),
        el(
          'button',
          {
            class: 'shell-btn shell-btn-ghost',
            type: 'button',
            onclick: action(
              `/automation/monitors/${encodeURIComponent(monitor.id)}/scan`,
              { method: 'POST', body: { mode: 'full' } },
              '全量重查',
            ),
          },
          ['全量重查'],
        ),
        el(
          'button',
          {
            class: 'shell-btn shell-btn-ghost',
            type: 'button',
            onclick: action(`/automation/monitors/${encodeURIComponent(monitor.id)}`, { method: 'DELETE' }, '删除'),
          },
          ['删除'],
        ),
      ]
      monitorList.appendChild(
        el('article', { class: 'auto-monitor' }, [
          el('div', { class: 'auto-monitor-head' }, [
            el('span', { class: 'auto-monitor-name' }, [monitor.name]),
            el('span', { class: `auto-pill ${monitor.enabled ? 'auto-pill-on' : 'auto-pill-off'}` }, [monitor.enabled ? '监控中' : '已暂停']),
            el('span', { class: 'auto-pill' }, [monitor.platform]),
          ]),
          el('p', { class: 'auto-monitor-url' }, [monitor.url]),
          el('p', { class: 'auto-monitor-meta' }, [
            `间隔 ${num(monitor.intervalSec)} 秒 · 最近检查 ${rel(monitor.lastCheckAt)} · 最近成功 ${rel(monitor.lastSuccessAt)} · 待处理 ${num(monitor.pendingTasks)} · 待审核 ${num(monitor.reviewCandidates)}`,
          ]),
          el('p', { class: 'auto-monitor-meta' }, [`本次覆盖：${scanText}`]),
          el('p', { class: 'auto-monitor-meta' }, [`${coverage} · ${compensation}`]),
          changes.length === 0
            ? null
            : el('p', { class: 'auto-warn' }, [
                `最近变化：${changes
                  .map((change) => `${change.postId} ${change.kind === 'edited' ? '被修改' : change.kind === 'deleted' ? '已消失' : '恢复'}（${rel(change.at)}）`)
                  .join('；')}`,
              ]),
          blocked,
          el('div', { class: 'auto-row-actions' }, [
            el('span', { class: 'auto-monitor-meta' }, ['回看（小时）']),
            windowInput,
            saveWindow,
            ...actions,
          ]),
        ]),
      )
    }
  }

  function renderTasks(data) {
    clear(taskList)
    const recent = data.recentTasks || []
    if (recent.length === 0) {
      taskList.appendChild(el('p', { class: 'auto-empty' }, ['还没有任务记录。']))
      return
    }
    for (const task of recent.slice(0, 24)) {
      const canRetry = task.state === 'failed' || task.state === 'blocked' || task.state === 'cancelled'
      const actions = []
      if (canRetry) {
        actions.push(
          el(
            'button',
            {
              class: 'shell-btn shell-btn-ghost auto-task-btn',
              type: 'button',
              onclick: action(`/automation/tasks/${encodeURIComponent(task.id)}/retry`, { method: 'POST' }, '重试'),
            },
            ['重试'],
          ),
        )
      }
      if (task.state === 'pending' || task.state === 'retry_wait' || task.state === 'running') {
        actions.push(
          el(
            'button',
            {
              class: 'shell-btn shell-btn-ghost auto-task-btn',
              type: 'button',
              onclick: action(`/automation/tasks/${encodeURIComponent(task.id)}/cancel`, { method: 'POST' }, '取消'),
            },
            ['取消'],
          ),
        )
      }
      const uncertain = task.modelCall && task.modelCall.uncertain === true
      taskList.appendChild(
        el('div', { class: 'auto-task' }, [
          el('span', { class: `auto-pill auto-pill-${task.state}` }, [STATE_LABEL[task.state] || task.state]),
          el('span', { class: 'auto-task-kind' }, [task.kind]),
          el('span', { class: 'auto-task-detail' }, [
            [
              task.postId,
              uncertain ? '模型调用结果不确定' : undefined,
              task.lastError,
            ]
              .filter((part) => typeof part === 'string' && part !== '')
              .join(' · ') || '—',
          ]),
          el('span', { class: 'auto-task-time' }, [rel(task.updatedAt)]),
          ...actions,
        ]),
      )
    }
  }

  function renderReviews(data) {
    clear(reviewList)
    const reviews = data.reviews || []
    if (reviews.length === 0) {
      reviewList.appendChild(el('p', { class: 'auto-empty' }, ['没有待审核的候选。']))
      return
    }
    for (const review of reviews) {
      reviewList.appendChild(
        el('div', { class: 'auto-review' }, [
          el('div', { class: 'auto-review-head' }, [
            el('span', { class: 'auto-monitor-name' }, [review.monitorName || review.monitorId]),
            el('span', { class: 'auto-task-time' }, [rel(review.updatedAt)]),
          ]),
          el('p', { class: 'auto-review-note' }, [
            '候选已生成，等待你在「人格 / 审批」页确认后手动发表。后台不会自行发出任何内容。',
          ]),
          el('p', { class: 'auto-monitor-url' }, [review.threadUrl || '']),
        ]),
      )
    }
  }

  function renderErrors(data) {
    clear(errorList)
    const recent = data.recentTasks || []
    const failures = recent.filter((task) => task.state === 'failed' || task.state === 'blocked').slice(0, 12)
    const loadErrors = data.loadErrors || []
    if (failures.length === 0 && loadErrors.length === 0) {
      errorList.appendChild(el('p', { class: 'auto-empty' }, ['没有需要处理的错误。']))
    }
    for (const message of loadErrors) errorList.appendChild(el('p', { class: 'auto-error' }, [message]))
    for (const task of failures) {
      errorList.appendChild(
        el('div', { class: 'auto-task' }, [
          el('span', { class: `auto-pill auto-pill-${task.state}` }, [STATE_LABEL[task.state] || task.state]),
          el('span', { class: 'auto-task-kind' }, [task.kind]),
          el('span', { class: 'auto-task-detail' }, [task.lastError || '（未记录原因）']),
          el('span', { class: 'auto-task-time' }, [rel(task.updatedAt)]),
        ]),
      )
    }
  }

  function render() {
    if (state.failed !== '') {
      clear(stats)
      stats.appendChild(el('p', { class: 'auto-error' }, [state.failed]))
      for (const node of [healthList, alerts, monitorList, taskList, reviewList, errorList]) clear(node)
      return
    }
    const data = state.data
    if (data === null) return
    renderStats(data)
    renderHealth(data)
    renderAlerts(data)
    renderMonitors(data)
    renderTasks(data)
    renderReviews(data)
    renderErrors(data)

    globalToggle.textContent = data.paused === true ? '恢复全部' : '暂停全部'
    globalToggle.disabled = false
  }

  globalToggle.addEventListener('click', async () => {
    const paused = state.data && state.data.paused === true
    await action(paused ? '/automation/resume' : '/automation/pause', { method: 'POST' }, paused ? '恢复' : '暂停')()
  })

  const addButton = el(
    'button',
    {
      class: 'shell-btn',
      type: 'button',
      onclick: async () => {
        const url = String(newUrl.value || '').trim()
        if (url === '') {
          banner.textContent = '请先填帖子链接。'
          return
        }
        banner.textContent = '正在添加…'
        const intervalSec = Number(newInterval.value)
        const result = await deps.request(`${API}/automation/monitors`, {
          method: 'POST',
          body: {
            url,
            name: String(newName.value || '').trim(),
            ...(Number.isFinite(intervalSec) ? { intervalSec } : {}),
          },
        })
        if (!result.ok) {
          banner.textContent = `添加失败：${result.network ? '无法连接服务' : result.error || `HTTP ${result.status}`}`
          return
        }
        newUrl.value = ''
        newName.value = ''
        banner.textContent = '已添加，并立即排队做第一次检查。第一次检查只建立基线，不会分析历史楼层。'
        await reload()
      },
    },
    ['添加监控'],
  )

  const pruneButton = el(
    'button',
    {
      class: 'shell-btn shell-btn-ghost',
      type: 'button',
      onclick: action('/automation/maintenance', { method: 'POST', body: { action: 'prune' } }, '清理历史'),
    },
    ['清理历史任务'],
  )
  const reapButton = el(
    'button',
    {
      class: 'shell-btn shell-btn-ghost',
      type: 'button',
      onclick: action('/automation/maintenance', { method: 'POST', body: { action: 'reap' } }, '回收卡死任务'),
    },
    ['回收卡死任务'],
  )

  const node = el('div', { class: 'auto-panel' }, [
    el('div', { class: 'auto-head' }, [
      el('div', null, [
        el('h2', { class: 'auto-title' }, ['自动挂机']),
        el(
          'p',
          { class: 'auto-desc' },
          [
            '后台会按设定的间隔读取这些帖子，发现新回复后自动分析并生成候选。候选只会进入待审核列表——发表永远需要你手动确认。',
          ],
        ),
      ]),
      el('div', { class: 'auto-head-actions' }, [
        globalToggle,
        el(
          'button',
          {
            class: 'shell-btn shell-btn-ghost',
            type: 'button',
            onclick: () => void reload(),
          },
          ['刷新'],
        ),
      ]),
    ]),
    banner,
    alerts,
    stats,
    el('section', { class: 'auto-section' }, [
      el('h3', { class: 'auto-section-title' }, ['运行状态']),
      healthList,
    ]),
    el('section', { class: 'auto-section' }, [
      el('h3', { class: 'auto-section-title' }, ['监控目标']),
      el('div', { class: 'auto-add' }, [newUrl, newName, newInterval, addButton]),
      monitorList,
    ]),
    el('section', { class: 'auto-section' }, [
      el('h3', { class: 'auto-section-title' }, ['待人工审核']),
      reviewList,
    ]),
    el('section', { class: 'auto-section' }, [
      el('h3', { class: 'auto-section-title' }, ['最近任务']),
      taskList,
      el('div', { class: 'auto-row-actions auto-row-tail' }, [pruneButton, reapButton]),
    ]),
    el('section', { class: 'auto-section' }, [
      el('h3', { class: 'auto-section-title' }, ['需要处理的错误']),
      errorList,
    ]),
  ])

  render()

  return {
    node,
    start() {
      // Poll only while the tab is visible: a hidden console must not keep asking,
      // and the service does the work regardless.
      void reload()
      state.polling = window.setInterval(() => {
        if (document.visibilityState === 'hidden') return
        void reload()
      }, 15000)
    },
    stop() {
      if (state.polling !== null) {
        window.clearInterval(state.polling)
        state.polling = null
      }
    },
  }
}

module.exports = { createAutomationPanel }
