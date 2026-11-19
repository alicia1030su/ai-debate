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

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
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

  async function reload(options) {
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
      banner.textContent = `${label}完成。`
      await reload()
    }
  }

  function render() {
    if (state.failed !== '') {
      clear(stats)
      stats.appendChild(el('p', { class: 'auto-error' }, [state.failed]))
      clear(monitorList)
      clear(taskList)
      clear(reviewList)
      clear(errorList)
      return
    }
    const data = state.data
    if (data === null) return

    // ---- headline numbers, all read from the payload
    clear(stats)
    const monitors = data.monitors || { total: 0, enabled: 0, blocked: 0 }
    const today = data.today || { discovered: 0, candidates: 0, failures: 0 }
    const tasks = data.tasks || {}
    const paused = data.paused === true
    for (const [label, value, hint] of [
      ['监控目标', `${num(monitors.enabled)} / ${num(monitors.total)}`, monitors.blocked > 0 ? `${num(monitors.blocked)} 个需重新认证` : '已启用 / 全部'],
      ['今日发现', num(today.discovered), '新回复'],
      ['待审核', num(tasks.needs_review), '候选回复'],
      ['今日失败', num(today.failures), '任务'],
      ['队列', `${num(data.queued)} 等待 · ${num(data.runningTasks)} 执行中`, paused ? '已暂停' : (data.running ? '运行中' : '未启动')],
    ]) {
      stats.appendChild(
        el('div', { class: 'auto-stat' }, [
          el('div', { class: 'auto-stat-label' }, [label]),
          el('div', { class: 'auto-stat-value' }, [value]),
          el('div', { class: 'auto-stat-hint' }, [hint]),
        ]),
      )
    }

    globalToggle.textContent = paused ? '恢复全部' : '暂停全部'
    globalToggle.disabled = false

    // ---- monitors
    clear(monitorList)
    const rows = data.monitorList || []
    if (rows.length === 0) {
      monitorList.appendChild(el('p', { class: 'auto-empty' }, ['还没有监控目标。填一个帖子链接，后台就会开始盯着它。']))
    }
    for (const monitor of rows) {
      const blocked = monitor.blockedReason ? el('p', { class: 'auto-error' }, [`需重新认证：${monitor.blockedReason}`]) : null
      const toggle = el(
        'button',
        {
          class: 'shell-btn shell-btn-ghost',
          type: 'button',
          onclick: action(`/automation/monitors/${encodeURIComponent(monitor.id)}/${monitor.enabled ? 'pause' : 'resume'}`, { method: 'POST' }, monitor.enabled ? '暂停' : '恢复'),
        },
        [monitor.enabled ? '暂停' : '恢复'],
      )
      const check = el(
        'button',
        {
          class: 'shell-btn shell-btn-ghost',
          type: 'button',
          onclick: action(`/automation/monitors/${encodeURIComponent(monitor.id)}/check`, { method: 'POST' }, '立即检查'),
        },
        ['立即检查'],
      )
      const remove = el(
        'button',
        {
          class: 'shell-btn shell-btn-ghost',
          type: 'button',
          onclick: action(`/automation/monitors/${encodeURIComponent(monitor.id)}`, { method: 'DELETE' }, '删除'),
        },
        ['删除'],
      )
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
          blocked,
          el('div', { class: 'auto-row-actions' }, [toggle, check, remove]),
        ]),
      )
    }

    // ---- tasks
    clear(taskList)
    const recent = data.recentTasks || []
    if (recent.length === 0) taskList.appendChild(el('p', { class: 'auto-empty' }, ['还没有任务记录。']))
    for (const task of recent.slice(0, 20)) {
      taskList.appendChild(
        el('div', { class: 'auto-task' }, [
          el('span', { class: `auto-pill auto-pill-${task.state}` }, [task.state]),
          el('span', { class: 'auto-task-kind' }, [task.kind]),
          el('span', { class: 'auto-task-detail' }, [
            [task.postId, task.lastError].filter((part) => typeof part === 'string' && part !== '').join(' · ') || '—',
          ]),
          el('span', { class: 'auto-task-time' }, [rel(task.updatedAt)]),
        ]),
      )
    }

    // ---- reviews waiting for a human
    clear(reviewList)
    const reviews = data.reviews || []
    if (reviews.length === 0) reviewList.appendChild(el('p', { class: 'auto-empty' }, ['没有待审核的候选。']))
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

    // ---- errors that need attention
    clear(errorList)
    const failures = recent.filter((task) => task.state === 'failed' || task.state === 'blocked').slice(0, 10)
    const loadErrors = data.loadErrors || []
    if (failures.length === 0 && loadErrors.length === 0) {
      errorList.appendChild(el('p', { class: 'auto-empty' }, ['没有需要处理的错误。']))
    }
    for (const message of loadErrors) errorList.appendChild(el('p', { class: 'auto-error' }, [message]))
    for (const task of failures) {
      errorList.appendChild(
        el('div', { class: 'auto-task' }, [
          el('span', { class: `auto-pill auto-pill-${task.state}` }, [task.state]),
          el('span', { class: 'auto-task-kind' }, [task.kind]),
          el('span', { class: 'auto-task-detail' }, [task.lastError || '（未记录原因）']),
          el('span', { class: 'auto-task-time' }, [rel(task.updatedAt)]),
        ]),
      )
    }
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
        banner.textContent = '已添加，并立即排队做第一次检查。'
        await reload()
      },
    },
    ['添加监控'],
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
    stats,
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
