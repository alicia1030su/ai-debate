/**
 * Render test for the built console bundle.
 *
 * This runs the *shipped artefact* — `static/assets/app.js` — inside jsdom, not
 * the sources. That is deliberate: the bundle is where the legacy page and the
 * new shell are stitched together, and the failures worth catching are exactly
 * the stitched seams (module rename, route prefix, stylesheet injection, the
 * snapshot store contract). A source-level test would pass while the bundle was
 * broken.
 *
 * The assertions are the console's minimum viable product:
 *   - the auth gate lets an authenticated session through;
 *   - the inherited card renders, with all eleven tabs;
 *   - a tab is actually interactive (aria-selected flips on click);
 *   - neither render-error escape hatch fired.
 *
 * Run: `node --test packages/web/test/render.test.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM, VirtualConsole } from 'jsdom'

const BASE_URL = 'http://127.0.0.1:17860/'
const API = '/api/ai-debate'
const BUNDLE_PATH = new URL('../static/assets/app.js', import.meta.url)
const INDEX_PATH = new URL('../static/index.html', import.meta.url)

/** Total tab count the inherited page renders (one per settings area). */
const EXPECTED_TABS = 11

/** The settings payload the card needs before it will render its tabs. */
const SETTINGS_PAYLOAD = {
  status: 'ready',
  writable: true,
  values: {},
  secrets: [],
  capabilities: { settingsService: true, credentialService: true },
}

/** The auth state that means "already signed in". */
const AUTH_STATE_SIGNED_IN = { initialized: true, authenticated: true }

const NOW = new Date().toISOString()
const NEXT_SCAN_AT = new Date(Date.now() + 300_000).toISOString()
const BACKUP_NAME = '20260817-120000-manual-abc123'
const BACKUP_ROWS = [
  {
    name: BACKUP_NAME,
    createdAt: NOW,
    kind: 'manual',
    bytes: 2048,
    valid: true,
    error: null,
  },
  {
    name: '20260816-120000-daily-def456',
    createdAt: NOW,
    kind: 'daily',
    bytes: 1024,
    valid: false,
    error: '备份文件校验值不一致',
  },
]

/** A complete v0.2.2 status payload, including fields older servers may omit. */
const AUTOMATION_PAYLOAD = {
  running: true,
  paused: false,
  queued: 1,
  runningTasks: 1,
  monitors: { total: 2, enabled: 1, blocked: 1 },
  today: { discovered: 3, candidates: 1, failures: 1 },
  tasks: { needs_review: 1 },
  queue: { used: 1, capacity: 10, oldestPendingAgeSec: 30, stuck: 0 },
  heartbeat: { healthy: true, intervalMs: 15_000, ticks: 8, lastTickAt: NOW },
  health: { heapUsedBytes: 1024, rssBytes: 2048, dataDirBytes: 4096, freeBytes: 8192 },
  backups: {
    latest: { name: BACKUP_NAME, createdAt: NOW, kind: 'manual', bytes: 2048 },
    total: 5,
    daily: 2,
    weekly: 1,
    manual: 2,
  },
  identities: { total: 1, ready: 1 },
  monitorList: [
    {
      id: 'monitor-1',
      name: '测试监控',
      platform: 'tieba',
      url: 'https://tieba.baidu.com/p/1234567890',
      enabled: true,
      intervalSec: 300,
      lastCheckAt: NOW,
      lastSuccessAt: NOW,
      platformState: 'unauthorized',
      nextScanAt: NEXT_SCAN_AT,
      scanning: true,
      retryWaitSec: 45,
      lastError: 'Cookie 已失效',
      pendingTasks: 1,
      reviewCandidates: 1,
      compensationHours: 24,
      lastScan: { complete: true, pagesRead: 1, totalPages: 1, at: NOW },
      recentChanges: [],
    },
  ],
  recentTasks: [
    {
      id: 'task-uncertain-flag',
      state: 'failed',
      kind: '分析回复',
      modelCall: { uncertain: true },
      lastError: '模型调用结果不确定',
      updatedAt: NOW,
    },
    {
      id: 'task-stuck',
      state: 'blocked',
      kind: '读取帖子',
      lastErrorKind: 'stuck',
      lastError: '任务卡死',
      updatedAt: NOW,
    },
    {
      id: 'task-interrupted',
      state: 'cancelled',
      kind: '生成候选',
      lastErrorKind: 'interrupted_uncertain',
      lastError: '中断时无法确认模型调用结果',
      updatedAt: NOW,
    },
    {
      id: 'task-ok',
      state: 'completed',
      kind: '读取帖子',
      lastErrorKind: '',
      updatedAt: NOW,
    },
  ],
  reviews: [],
  alerts: [],
  loadErrors: [],
}

/**
 * Wait until `predicate()` is truthy, or throw.
 *
 * React renders asynchronously, so every assertion has to wait for the DOM
 * instead of reading it immediately after the script runs.
 *
 * @param {() => boolean} predicate Condition to poll.
 * @param {string} description Human description used in the timeout message.
 * @param {number} [timeoutMs] Budget before giving up.
 * @returns {Promise<void>}
 */
async function waitFor(predicate, description, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${description}`)
}

/** Find a button by its visible label inside a root node. */
function findButton(root, label) {
  return [...root.querySelectorAll('button')].find((button) => button.textContent === label)
}

/** Find a stat card by its label. */
function findStat(document, label) {
  return [...document.querySelectorAll('.auto-stat')].find((stat) => stat.querySelector('.auto-stat-label')?.textContent === label)
}

/** Find a section by its heading text. */
function findSection(document, title) {
  const heading = [...document.querySelectorAll('.auto-section-title')].find((node) => node.textContent === title)
  return heading === undefined ? null : heading.closest('.auto-section')
}

/**
 * Build a fetch double that answers the routes the console boots through.
 *
 * Every response mirrors the fields the code actually reads. The diagnostic
 * success response deliberately refuses `json()`: its body is an attachment and
 * must travel through `blob()` without being rendered.
 *
 * @param {{automationStatus?: object, backups?: object[], verifyBody?: object, jobSequences?: object, jobErrors?: object, jobNetworkFailures?: number, failures?: object[]}} [options]
 * @returns {{fetch: Function, calls: string[], requests: object[]}}
 */
function createFetchDouble(options = {}) {
  const calls = []
  const requests = []
  const enqueuedJobs = new Map()
  const jobPollCounts = new Map()
  const defaultSequences = {
    'job-backup': ['queued', 'succeeded'],
    'job-restore': ['running', 'succeeded'],
  }

  const respond = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => payload,
  })

  function jobSnapshot(jobId) {
    const sequences = options.jobSequences ?? defaultSequences
    const sequence = sequences[jobId] ?? ['queued', 'succeeded']
    const poll = jobPollCounts.get(jobId) ?? 0
    jobPollCounts.set(jobId, poll + 1)
    const state = sequence[Math.min(poll, sequence.length - 1)]
    const type = enqueuedJobs.get(jobId) ?? 'backup.create'
    const error = options.jobErrors?.[jobId] ?? '后台任务执行失败'
    const successLog = type === 'backup.restore' ? '恢复完成，已自动创建恢复前备份。' : '备份完成：backup-new'
    return {
      id: jobId,
      type,
      state,
      attempts: 1,
      createdAt: NOW,
      updatedAt: NOW,
      logs:
        state === 'succeeded'
          ? [{ at: NOW, level: 'info', message: successLog }]
          : state === 'failed'
            ? [{ at: NOW, level: 'error', message: error }]
            : [],
      ...(state === 'failed' ? { lastError: error } : {}),
    }
  }

  async function fetchDouble(input, init = {}) {
    const url = typeof input === 'string' ? input : String(input && input.url)
    const method = String(init.method || 'GET').toUpperCase()
    let body
    try {
      body = init.body === undefined ? undefined : JSON.parse(init.body)
    } catch (error) {
      body = init.body
    }
    calls.push(url)
    requests.push({ url, method, body, headers: init.headers || {}, credentials: init.credentials })

    const failure = (options.failures || []).find(
      (item) => item.method === method && (url === item.path || url.endsWith(item.path)),
    )
    if (failure !== undefined) return respond({ ok: false, error: failure.error }, failure.status)

    if (url.includes('/auth/state')) return respond(AUTH_STATE_SIGNED_IN)
    if (url.includes(`${API}/settings`)) return respond(SETTINGS_PAYLOAD)
    if (url.includes(`${API}/status`)) return respond({})
    if (url === `${API}/automation/status`) return respond(options.automationStatus ?? AUTOMATION_PAYLOAD)
    if (url === `${API}/backups`) {
      if (method === 'POST') {
        enqueuedJobs.set('job-backup', 'backup.create')
        return respond(
          { ok: true, jobId: 'job-backup', deduplicated: false, message: '备份任务已排队。' },
          202,
        )
      }
      return respond({ ok: true, backups: options.backups ?? BACKUP_ROWS })
    }
    if (url === `${API}/jobs` && method === 'GET') {
      if ((options.jobNetworkFailures ?? 0) > 0) {
        options.jobNetworkFailures -= 1
        throw new Error('socket hang up')
      }
      return respond({ paused: false, jobs: [...enqueuedJobs.keys()].map(jobSnapshot), concurrency: 1 })
    }
    if (/\/backups\/[^/]+\/verify$/.test(url)) {
      return respond(options.verifyBody ?? { ok: true, valid: true, message: '备份校验通过。' })
    }
    if (/\/backups\/[^/]+\/restore$/.test(url)) {
      enqueuedJobs.set('job-restore', 'backup.restore')
      return respond(
        {
          ok: true,
          jobId: 'job-restore',
          message: '恢复任务已排队；恢复前的数据会另存为 pre-restore-<时间>。',
        },
        202,
      )
    }
    if (/\/monitors\/[^/]+\/platform-check$/.test(url)) {
      return respond({ message: '平台登录有效。' })
    }
    if (url === `${API}/diagnostics`) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => {
          throw new Error('诊断正文不应被解析为页面 JSON')
        },
        blob: async () => new Blob([JSON.stringify({ private: 'DIAGNOSTIC_PRIVATE_PAYLOAD' })], { type: 'application/json' }),
      }
    }
    return respond({})
  }

  return { fetch: fetchDouble, calls, requests }
}

/**
 * Boot the bundle in a fresh jsdom document.
 *
 * @param {{fetch: Function, calls: string[], requests: object[]}} [double] Fetch test double.
 * @returns {Promise<{dom: JSDOM, document: Document, calls: string[], requests: object[], logs: string[]}>}
 */
async function bootConsole(double = createFetchDouble()) {
  const [html, bundle] = await Promise.all([readFile(INDEX_PATH, 'utf8'), readFile(BUNDLE_PATH, 'utf8')])

  const virtualConsole = new VirtualConsole()
  const logs = []
  for (const level of ['error', 'warn', 'info', 'log', 'debug']) {
    virtualConsole.on(level, (...args) => {
      logs.push(`[${level}] ${args.map((arg) => (arg && arg.stack ? arg.stack : String(arg))).join(' ')}`)
    })
  }
  virtualConsole.on('jsdomError', (error) => {
    logs.push(`[jsdomError] ${error && error.stack ? error.stack : String(error)}`)
  })

  const dom = new JSDOM(html, {
    url: BASE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  })

  // Installed before the bundle runs: the shell wraps `window.fetch` at startup
  // to watch for expired sessions, so the double has to be in place first.
  dom.window.fetch = double.fetch

  // The document ships `<script src="/assets/app.js">`; jsdom does not fetch
  // external scripts without `resources: 'usable'`, and fetching is not what
  // this test is about. The bundle is injected inline instead.
  const script = dom.window.document.createElement('script')
  script.textContent = bundle
  dom.window.document.body.appendChild(script)

  return { dom, document: dom.window.document, calls: double.calls, requests: double.requests, logs }
}

test('console boots, authenticates and renders the card with all tabs', async (t) => {
  const { dom, document: doc, calls, logs } = await bootConsole()
  t.after(() => {
    // Closes the status-poll interval and any React timers, so the test process
    // exits on its own.
    dom.window.close()
  })

  // 1. The auth gate must have been consulted before anything rendered.
  await waitFor(
    () => doc.querySelector('.dsd-card') !== null,
    `卡片应当渲染，#app-root 内容：${doc.getElementById('app-root')?.innerHTML?.slice(0, 400) ?? '(缺失)'}`,
  )
  assert.ok(
    calls.some((url) => url.includes('/auth/state')),
    `启动时应先读取登录状态，实际请求：${JSON.stringify(calls)}`,
  )

  // 2. The card itself.
  const card = doc.querySelector('.dsd-card')
  assert.ok(card, '应当渲染出 .dsd-card')

  // 3. Every tab.
  const tabs = [...doc.querySelectorAll('.dsd-tab')]
  assert.equal(tabs.length, EXPECTED_TABS, `页签数量应为 ${EXPECTED_TABS}，实际 ${tabs.length}`)

  // 4. A tab is interactive: clicking an unselected one flips aria-selected.
  const target = tabs[1]
  const other = tabs[0]
  assert.ok(target, '应当有第二个页签可供点击')
  assert.equal(target.getAttribute('aria-selected'), 'false', '第二个页签初始应为未选中')
  assert.equal(other.getAttribute('aria-selected'), 'true', '第一个页签初始应为选中')

  target.click()
  await waitFor(
    () => target.getAttribute('aria-selected') === 'true',
    '点击第二个页签后 aria-selected 应变为 true',
  )
  assert.equal(other.getAttribute('aria-selected'), 'false', '切换后第一个页签应变为未选中')

  // 5. No render-error escape hatch fired, in the DOM or on the console.
  //
  //    Scoped to the mount point, not `document.body`: the bundle is injected as
  //    a <script> text node, so `body.textContent` contains the source of the
  //    error branch itself and would always match.
  const rendered = doc.getElementById('app-root').textContent || ''
  assert.ok(!rendered.includes('CARD-RENDER-ERROR'), '卡片渲染不应进入 CARD-RENDER-ERROR 分支')
  assert.ok(!rendered.includes('SECTION-RENDER-ERROR'), '页面渲染不应进入 SECTION-RENDER-ERROR 分支')
  const haystack = logs.join('\n')
  assert.ok(!haystack.includes('CARD-RENDER-ERROR'), `控制台不应出现 CARD-RENDER-ERROR：\n${haystack}`)
  assert.ok(!haystack.includes('SECTION-RENDER-ERROR'), `控制台不应出现 SECTION-RENDER-ERROR：\n${haystack}`)

  // 6. The stylesheet the card injects itself must carry the renamed marker —
  //    this is what the `card.css` rewrite in the build script exists for.
  const styleTag = doc.querySelector('style[data-plugin-css="ai-debate/card.css"]')
  assert.ok(styleTag, '应当注入带 ai-debate/card.css 标记的样式表')
  assert.ok((styleTag.textContent || '').includes('.dsd-card'), '注入的样式表应包含卡片样式')

  // 7. The card's own data must have come from the service, not from a
  //    hard-coded fallback: `/settings` was read at least once.
  assert.ok(
    calls.some((url) => url.includes(`${API}/settings`)),
    `卡片应读取过 /settings，实际请求：${JSON.stringify(calls)}`,
  )
})

test('a configured credential is reported as configured, not as unset', async (t) => {
  const [html, bundle] = await Promise.all([readFile(INDEX_PATH, 'utf8'), readFile(BUNDLE_PATH, 'utf8')])

  const dom = new JSDOM(html, {
    url: BASE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  })
  t.after(() => dom.window.close())

  const respond = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })

  // The server's actual shape: current ref names, redacted values only.
  const settings = {
    status: 'ready',
    writable: true,
    values: {},
    secrets: [
      {
        ref: 'AI_DEBATE_TIEBA_COOKIE',
        configured: true,
        writable: true,
        configSuperseded: false,
        fromConfigFallback: false,
        length: 64,
        tail: 'a1b2',
      },
      {
        ref: 'AI_DEBATE_LLM_API_KEY',
        configured: false,
        writable: true,
        configSuperseded: false,
        fromConfigFallback: false,
        length: 0,
      },
    ],
    capabilities: { settingsService: true, credentialService: true },
  }

  dom.window.fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input && input.url)
    if (url.includes('/auth/state')) return respond({ initialized: true, authenticated: true })
    if (url.includes(`${API}/settings`)) return respond(settings)
    return respond({})
  }

  const script = dom.window.document.createElement('script')
  script.textContent = bundle
  dom.window.document.body.appendChild(script)

  const doc = dom.window.document
  await waitFor(() => doc.querySelector('.dsd-card') !== null, '应渲染卡片')

  const appText = doc.getElementById('app-root').textContent || ''
  // The badge text comes from the page's own dictionary; the two states are
  // "Configured" / "Not configured" in English (jsdom's navigator.language).
  assert.ok(
    /Configured/.test(appText) && !/Not configured.*Not configured/.test(appText),
    `已配置的凭据不应显示为「未配置」，当前文案：${appText.slice(0, 600)}`,
  )
  // The last four characters are the only part of a secret the service ever
  // sends, and the page renders them — this is the positive half of the check.
  assert.ok(appText.includes('a1b2'), `应显示末四位 a1b2，当前文案：${appText.slice(0, 600)}`)
})

test('a 401 from the product API sends the console back to the login form', async (t) => {
  const [html, bundle] = await Promise.all([readFile(INDEX_PATH, 'utf8'), readFile(BUNDLE_PATH, 'utf8')])

  const dom = new JSDOM(html, {
    url: BASE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  })
  t.after(() => dom.window.close())

  let authenticated = true
  const respond = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })

  dom.window.fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input && input.url)
    if (url.includes('/auth/state')) {
      return respond({ initialized: true, authenticated, csrf: 'abc123' })
    }
    if (url.includes(`${API}/settings`)) {
      // The session dies between mounting the card and its first settings read.
      return authenticated ? respond(SETTINGS_PAYLOAD) : respond({ error: '未登录' }, 401)
    }
    return respond({})
  }

  const script = dom.window.document.createElement('script')
  script.textContent = bundle
  dom.window.document.body.appendChild(script)

  const doc = dom.window.document
  await waitFor(() => doc.querySelector('.dsd-card') !== null, '已登录时应先渲染卡片')

  // Expire the session, then make the page read its settings again. The tab is
  // the visible trigger: opening the approval tab re-reads `/settings`.
  authenticated = false
  doc.querySelectorAll('.dsd-tab')[4].click()

  await waitFor(() => doc.querySelector('.auth-card') !== null, '会话失效后应回到登录表单')
  assert.equal(doc.querySelector('.dsd-card'), null, '会话失效后卡片应被卸载')
  const title = doc.querySelector('.auth-title')
  assert.ok(title && title.textContent.includes('登录'), '应显示登录表单')
})

test('an edit saves as a same-origin JSON request, with no invented auth header', async (t) => {
  const [html, bundle] = await Promise.all([readFile(INDEX_PATH, 'utf8'), readFile(BUNDLE_PATH, 'utf8')])

  const dom = new JSDOM(html, {
    url: BASE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  })
  t.after(() => dom.window.close())

  const calls = []
  const settings = { ...SETTINGS_PAYLOAD, values: { ownerUserName: 'old' } }
  const respond = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })

  dom.window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input && input.url)
    calls.push({
      url,
      method: (init && init.method) || 'GET',
      headers: (init && init.headers) || {},
      credentials: init && init.credentials,
    })
    if (url.includes('/auth/state')) {
      return respond({ initialized: true, authenticated: true })
    }
    if (url.includes(`${API}/settings`)) return respond(settings)
    return respond({})
  }

  const script = dom.window.document.createElement('script')
  script.textContent = bundle
  dom.window.document.body.appendChild(script)

  const doc = dom.window.document
  await waitFor(() => doc.querySelector('.dsd-card') !== null, '应立即渲染卡片')

  // Stage an edit through React's own value setter, then save from the card's
  // footer. The footer button is the one control that enables on a staged edit —
  // the section-level footer is not rendered by `DebateCard`.
  const input = doc.querySelector('#dsd-owner-name')
  assert.ok(input, '应渲染「业主显示名」输入框')
  const valueSetter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    'value',
  ).set
  valueSetter.call(input, '张三')
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))

  const saveButton = doc.querySelector('#app-root .dsd-foot .dsd-btn-primary')
  await waitFor(() => saveButton.disabled === false, '编辑后保存按钮应可用')
  saveButton.click()

  await waitFor(
    () => calls.some((call) => call.method !== 'GET'),
    '保存应发出一次非 GET 请求',
  )
  const post = calls.find((call) => call.method !== 'GET')
  assert.ok(
    post.url.endsWith(`${API}/settings`),
    `保存应打到 /settings，实际：${post.url}`,
  )

  // The service's actual write protection is SameSite=Strict + Origin/Host +
  // a required JSON content type. A plain cross-site form cannot produce the
  // last one without a preflight the service refuses.
  const headers = post.headers || {}
  const contentTypeKey = Object.keys(headers).find((key) => key.toLowerCase() === 'content-type')
  assert.ok(contentTypeKey, `保存请求必须带 content-type，实际 headers：${JSON.stringify(headers)}`)
  assert.match(
    String(headers[contentTypeKey]),
    /^application\/json/i,
    `content-type 必须是 application/json，实际：${headers[contentTypeKey]}`,
  )

  // The other two halves come from the request being same-origin: the browser
  // attaches the `SameSite=Strict` cookie and sets `Origin` itself, and only for
  // a same-origin target. A relative path is what guarantees that — an absolute
  // URL to another host would silently be a different (credential-less) request.
  assert.ok(
    post.url.startsWith('/'),
    `保存请求必须是同源相对路径（Origin/凭据由浏览器据此决定），实际：${post.url}`,
  )

  // And no header the server never reads. A control nobody verifies is worse than
  // none: it looks like protection while adding nothing, and it is exactly what
  // would 403 every POST the moment the server started being strict.
  const csrfLike = Object.keys(headers).filter((key) => /csrf/i.test(key))
  assert.deepEqual(
    csrfLike,
    [],
    `不应自造服务端不校验的 CSRF 头，实际：${csrfLike.join(', ')}`,
  )
})

test('auth gate shows the login form when the session is not authenticated', async (t) => {
  const [html, bundle] = await Promise.all([readFile(INDEX_PATH, 'utf8'), readFile(BUNDLE_PATH, 'utf8')])
  const virtualConsole = new VirtualConsole()
  const logs = []
  virtualConsole.on('error', (...args) => logs.push(args.map(String).join(' ')))
  virtualConsole.on('jsdomError', (error) => logs.push(String(error && error.message)))

  const dom = new JSDOM(html, {
    url: BASE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  })
  t.after(() => dom.window.close())

  const respond = (payload) => ({ ok: true, status: 200, json: async () => payload })
  dom.window.fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input && input.url)
    if (url.includes('/auth/state')) return respond({ initialized: true, authenticated: false })
    return respond({})
  }

  const script = dom.window.document.createElement('script')
  script.textContent = bundle
  dom.window.document.body.appendChild(script)

  const doc = dom.window.document
  await waitFor(() => doc.querySelector('.auth-card') !== null, '应当渲染登录表单')

  assert.equal(doc.querySelector('.dsd-card'), null, '未登录时不应渲染卡片')
  const title = doc.querySelector('.auth-title')
  assert.ok(title && title.textContent.includes('登录'), `登录表单标题应含「登录」，实际 ${title && title.textContent}`)
  assert.equal(doc.querySelectorAll('.shell-input').length, 2, '登录表单应有用户名与密码两个输入框')
  const bar = doc.querySelector('.shell-bar')
  assert.ok(bar && bar.hidden, '未登录时不显示顶部栏')
  assert.deepEqual(logs, [], `登录页不应产生控制台错误：${logs.join('\n')}`)
})

test('auth gate shows the first-run form when the service is uninitialised', async (t) => {
  const [html, bundle] = await Promise.all([readFile(INDEX_PATH, 'utf8'), readFile(BUNDLE_PATH, 'utf8')])

  const dom = new JSDOM(html, {
    url: BASE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  })
  t.after(() => dom.window.close())

  dom.window.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ initialized: false, authenticated: false }),
  })

  const script = dom.window.document.createElement('script')
  script.textContent = bundle
  dom.window.document.body.appendChild(script)

  const doc = dom.window.document
  await waitFor(() => doc.querySelector('.auth-card') !== null, '应当渲染初始化表单')

  const title = doc.querySelector('.auth-title')
  assert.ok(title && title.textContent.includes('初始化'), `标题应含「初始化」，实际 ${title && title.textContent}`)
  assert.equal(doc.querySelectorAll('.shell-input').length, 3, '初始化表单应有用户名、密码、确认密码三个输入框')
})

test('自动挂机页：展示 v0.2.2 状态并接通登录检查、备份与诊断操作', async (t) => {
  const { dom, document: doc, calls, requests, logs } = await bootConsole()
  t.after(() => dom.window.close())

  await waitFor(() => doc.querySelector('.dsd-card') !== null, '配置卡片应先渲染')
  const navs = [...doc.querySelectorAll('.shell-nav')]
  assert.equal(navs.length, 2, '顶栏应有两个主视图入口')
  const autoNav = navs.find((node) => node.textContent === '自动挂机')
  assert.ok(autoNav, '应有「自动挂机」入口')
  autoNav.click()

  await waitFor(() => doc.querySelectorAll('.auto-backup').length === BACKUP_ROWS.length, '备份列表应按真实数据渲染')
  assert.equal(doc.querySelector('.dsd-card'), null, '切走后配置卡片应被卸载，而不是隐藏')
  assert.ok(calls.includes(`${API}/automation/status`), '应读取真实自动挂机状态')
  assert.ok(calls.includes(`${API}/backups`), '应读取真实备份列表')

  // Ten headline cards: the original nine plus the uncertain-task count.
  assert.equal(doc.querySelectorAll('.auto-stat').length, 10, '应保留九个统计卡并新增「不确定任务」')
  assert.equal(findStat(doc, '不确定任务')?.querySelector('.auto-stat-value')?.textContent, '3')

  const monitor = doc.querySelector('.auto-monitor')
  assert.ok(monitor, '应渲染监控行')
  assert.equal(monitor.querySelector('.auto-platform-state')?.getAttribute('data-state'), 'unauthorized')
  assert.match(monitor.textContent, /未登录/)
  assert.match(monitor.textContent, /下次扫描/)
  assert.match(monitor.textContent, /扫描中 是/)
  assert.match(monitor.textContent, /重试等待 45 秒/)
  assert.match(monitor.textContent, /最近错误：Cookie 已失效/)
  assert.ok(findButton(monitor, '检查登录'), '监控行应有「检查登录」按钮')

  const healthText = doc.querySelector('.auto-health')?.textContent || ''
  assert.ok(healthText.includes(BACKUP_NAME), '运行状态应展示最近备份')
  assert.match(healthText, /每日备份2/)
  assert.match(healthText, /每周备份1/)
  assert.match(healthText, /手动备份2/)

  const backupSection = findSection(doc, '备份中心')
  assert.ok(backupSection, '应有「备份中心」区块')
  assert.ok(findButton(backupSection, '立即备份'), '备份中心应有「立即备份」按钮')
  assert.equal(backupSection.querySelectorAll('.auto-backup').length, 2, '应展示两个备份')
  assert.match(backupSection.textContent, /清单有效/)
  assert.match(backupSection.textContent, /清单异常/)
  assert.match(backupSection.textContent, /备份文件校验值不一致/)

  findButton(monitor, '检查登录').click()
  await waitFor(() => doc.querySelector('.auto-banner')?.textContent.includes('平台登录有效'), '应显示后端登录检查消息')
  assert.ok(
    requests.some((request) => request.method === 'POST' && request.url === `${API}/automation/monitors/monitor-1/platform-check`),
    '检查登录应调用真实 platform-check 接口',
  )

  findButton(backupSection, '立即备份').click()
  await waitFor(() => /排队/.test(doc.querySelector('.auto-banner')?.textContent || ''), '入队后应显示排队状态')
  assert.equal(backupSection.querySelector('[data-action="backup-now"]').disabled, true, '等待后台任务时按钮应保持禁用')
  assert.ok(!doc.querySelector('.auto-banner').textContent.includes('成功'), 'HTTP 202 入队不得误报成功')
  const createBackup = requests.find((request) => request.method === 'POST' && request.url === `${API}/backups`)
  assert.deepEqual(createBackup?.body, { kind: 'manual' }, '立即备份应发送 {kind:"manual"}')
  await waitFor(() => doc.querySelector('.auto-banner')?.textContent.includes('立即备份成功'), '后台任务成功后才应显示成功')
  assert.ok(requests.some((request) => request.method === 'GET' && request.url === `${API}/jobs`), '应轮询后台任务状态')
  await waitFor(
    () => calls.filter((url) => url === `${API}/backups`).length >= 2,
    '后台备份成功后应刷新备份列表',
  )

  await waitFor(() => backupSection.querySelectorAll('.auto-backup').length === 2, '备份后应刷新列表')
  findButton(backupSection.querySelector('.auto-backup'), '校验').click()
  await waitFor(() => doc.querySelector('.auto-banner')?.textContent.includes('备份校验通过'), '应显示后端校验消息')
  assert.ok(
    requests.some((request) => request.method === 'POST' && request.url === `${API}/backups/${BACKUP_NAME}/verify`),
    '校验应调用对应备份的 verify 接口',
  )

  let confirmation = ''
  dom.window.confirm = (message) => {
    confirmation = message
    return false
  }
  await waitFor(() => backupSection.querySelectorAll('.auto-backup').length === 2, '校验后应刷新列表')
  findButton(backupSection.querySelector('.auto-backup'), '恢复').click()
  assert.match(confirmation, /覆盖当前数据/)
  assert.match(confirmation, /自动.*备份/)
  assert.ok(!requests.some((request) => request.url.endsWith('/restore')), '取消确认后不得发出恢复请求')

  dom.window.confirm = () => true
  findButton(backupSection.querySelector('.auto-backup'), '恢复').click()
  await waitFor(() => /排队|执行中/.test(doc.querySelector('.auto-banner')?.textContent || ''), '恢复入队后应显示排队或执行状态')
  assert.ok(!doc.querySelector('.auto-banner').textContent.includes('成功'), '恢复入队不得误报成功')
  const restore = requests.find((request) => request.method === 'POST' && request.url.endsWith('/restore'))
  assert.equal(restore?.url, `${API}/backups/${BACKUP_NAME}/restore`)
  assert.deepEqual(restore?.body, { confirmed: true }, '恢复应发送确认标记')
  await waitFor(() => doc.querySelector('.auto-banner')?.textContent.includes('恢复成功'), '恢复后台任务成功后才应显示成功')

  const downloads = []
  const blobs = []
  dom.window.URL.createObjectURL = (blob) => {
    blobs.push(blob)
    return 'blob:ai-debate-diagnostics'
  }
  dom.window.URL.revokeObjectURL = () => {}
  dom.window.HTMLAnchorElement.prototype.click = function captureDownload() {
    downloads.push({ name: this.download, href: this.href })
  }
  findButton(findSection(doc, '运行状态'), '导出诊断报告').click()
  await waitFor(() => downloads.length === 1, '应触发诊断报告下载')
  assert.match(downloads[0].name, /^ai-debate-diagnostics-.+\.json$/)
  assert.equal(downloads[0].href, 'blob:ai-debate-diagnostics')
  assert.equal(blobs.length, 1)
  assert.equal(blobs[0].type, 'application/json')
  assert.ok(
    requests.some((request) => request.method === 'GET' && request.url === `${API}/diagnostics` && request.credentials === 'same-origin'),
    '诊断导出应调用真实 diagnostics 接口',
  )
  assert.match(doc.querySelector('.auto-banner')?.textContent || '', /诊断报告已导出/)
  assert.ok(!doc.getElementById('app-root').textContent.includes('DIAGNOSTIC_PRIVATE_PAYLOAD'), '诊断正文不得渲染到页面')

  // Switching back restores the inherited card with its eleven tabs.
  const configNav = navs.find((node) => node.textContent === '配置')
  assert.ok(configNav)
  configNav.click()
  await waitFor(() => doc.querySelector('.dsd-card') !== null, '切回后配置卡片应重新渲染')
  assert.equal(doc.querySelectorAll('.dsd-tab').length, EXPECTED_TABS, '原有 11 个页签必须完整保留')
  assert.deepEqual(logs.filter((line) => line.includes('RENDER-ERROR')), [], '不应出现渲染错误')
})

test('自动挂机页：新增操作失败时显示后端错误', async (t) => {
  const double = createFetchDouble({
    failures: [
      { path: '/monitors/monitor-1/platform-check', method: 'POST', status: 400, error: '登录检查被拒绝' },
      { path: '/backups', method: 'POST', status: 500, error: '备份创建失败' },
      { path: '/verify', method: 'POST', status: 422, error: '备份校验失败' },
      { path: '/restore', method: 'POST', status: 409, error: '备份无法恢复' },
      { path: '/diagnostics', method: 'GET', status: 500, error: '诊断报告生成失败' },
    ],
  })
  const { dom, document: doc, requests } = await bootConsole(double)
  t.after(() => {
    dom.window.close()
    delete dom.window.URL.createObjectURL
    delete dom.window.URL.revokeObjectURL
  })

  await waitFor(() => doc.querySelector('.dsd-card') !== null, '配置卡片应先渲染')
  findButton(doc, '自动挂机').click()
  await waitFor(() => doc.querySelectorAll('.auto-backup').length === 2, '备份列表应渲染')

  findButton(doc.querySelector('.auto-monitor'), '检查登录').click()
  await waitFor(() => doc.querySelector('.auto-banner')?.textContent.includes('登录检查被拒绝'), '登录检查应显示后端错误')

  const backupSection = findSection(doc, '备份中心')
  findButton(backupSection, '立即备份').click()
  await waitFor(() => doc.querySelector('.auto-banner')?.textContent.includes('备份创建失败'), '备份应显示后端错误')

  await waitFor(() => backupSection.querySelectorAll('.auto-backup').length === 2, '失败后应刷新备份列表')
  findButton(backupSection.querySelector('.auto-backup'), '校验').click()
  await waitFor(() => doc.querySelector('.auto-banner')?.textContent.includes('备份校验失败'), '校验应显示后端错误')

  dom.window.confirm = () => true
  findButton(backupSection.querySelector('.auto-backup'), '恢复').click()
  await waitFor(() => doc.querySelector('.auto-banner')?.textContent.includes('备份无法恢复'), '恢复应显示后端错误')

  findButton(findSection(doc, '运行状态'), '导出诊断报告').click()
  await waitFor(() => doc.querySelector('.auto-banner')?.textContent.includes('诊断报告生成失败'), '诊断导出应显示后端错误')
  assert.ok(requests.some((request) => request.url === `${API}/diagnostics`), '失败的诊断导出也应调用真实接口')
})

test('自动挂机页：恢复成功后服务重启，轮询能跨过瞬时断线确认终态', async (t) => {
  const { dom, document: doc } = await bootConsole(
    createFetchDouble({
      jobNetworkFailures: 2,
      jobSequences: { 'job-restore': ['running', 'succeeded'] },
    }),
  )
  t.after(() => dom.window.close())

  await waitFor(() => doc.querySelector('.dsd-card') !== null, '配置卡片应先渲染')
  findButton(doc, '自动挂机').click()
  await waitFor(() => doc.querySelectorAll('.auto-backup').length === 2, '备份列表应渲染')
  dom.window.confirm = () => true
  findButton(findSection(doc, '备份中心').querySelector('.auto-backup'), '恢复').click()
  await waitFor(() => doc.querySelector('.auto-banner')?.textContent.includes('服务重启中'), '重启瞬时断线应显示等待状态')
  await waitFor(() => doc.querySelector('.auto-banner')?.textContent.includes('恢复成功'), '服务恢复后应确认后台任务成功')
})

test('自动挂机页：备份后台任务失败时显示 job 错误而不是入队成功', async (t) => {
  const { dom, document: doc, requests } = await bootConsole(
    createFetchDouble({
      jobSequences: { 'job-backup': ['running', 'failed'] },
      jobErrors: { 'job-backup': '磁盘空间不足，备份创建失败' },
    }),
  )
  t.after(() => dom.window.close())

  await waitFor(() => doc.querySelector('.dsd-card') !== null, '配置卡片应先渲染')
  findButton(doc, '自动挂机').click()
  await waitFor(() => doc.querySelectorAll('.auto-backup').length === 2, '备份列表应渲染')
  findButton(findSection(doc, '备份中心'), '立即备份').click()
  await waitFor(
    () => doc.querySelector('.auto-banner')?.textContent.includes('磁盘空间不足'),
    '后台任务失败应显示 job.lastError',
  )
  assert.ok(!doc.querySelector('.auto-banner').textContent.includes('成功'), '失败任务不得显示成功')
  assert.ok(requests.some((request) => request.method === 'GET' && request.url === `${API}/jobs`), '应轮询后台任务状态')
})

test('自动挂机页：校验返回 valid:false 时显示后端错误', async (t) => {
  const { dom, document: doc } = await bootConsole(
    createFetchDouble({ verifyBody: { valid: false, error: '校验发现备份文件损坏' } }),
  )
  t.after(() => dom.window.close())

  await waitFor(() => doc.querySelector('.dsd-card') !== null, '配置卡片应先渲染')
  findButton(doc, '自动挂机').click()
  await waitFor(() => doc.querySelectorAll('.auto-backup').length === 2, '备份列表应渲染')
  findButton(findSection(doc, '备份中心').querySelector('.auto-backup'), '校验').click()
  await waitFor(
    () => doc.querySelector('.auto-banner')?.textContent.includes('校验发现备份文件损坏'),
    'HTTP 200 的语义校验失败也应显示后端错误',
  )
})

test('自动挂机页：缺失字段显示破折号而不是伪造的零', async (t) => {
  const { dom, document: doc } = await bootConsole(createFetchDouble({ automationStatus: {}, backups: [] }))
  t.after(() => dom.window.close())

  await waitFor(() => doc.querySelector('.dsd-card') !== null, '配置卡片应先渲染')
  findButton(doc, '自动挂机').click()
  await waitFor(() => findStat(doc, '不确定任务') !== undefined, '不确定任务卡应渲染')
  assert.equal(findStat(doc, '不确定任务').querySelector('.auto-stat-value')?.textContent, '—')
  assert.match(findSection(doc, '备份中心')?.textContent || '', /还没有备份/)
  assert.match(doc.querySelector('.auto-health')?.textContent || '', /最近备份—/)
})
