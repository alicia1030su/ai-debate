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

/**
 * Build a fetch double that answers the routes the console boots through.
 *
 * Every response mirrors the two fields the code actually reads — `ok`/`status`
 * and `json()` — so a page that starts depending on a third field fails here
 * rather than in production.
 *
 * @returns {{fetch: Function, calls: string[]}} The double and the call log.
 */
function createFetchDouble() {
  const calls = []

  const respond = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })

  async function fetchDouble(input) {
    const url = typeof input === 'string' ? input : String(input && input.url)
    calls.push(url)

    if (url.includes('/auth/state')) return respond(AUTH_STATE_SIGNED_IN)
    if (url.includes('/api/ai-debate/settings')) return respond(SETTINGS_PAYLOAD)
    if (url.includes('/api/ai-debate/status')) return respond({})
    return respond({})
  }

  return { fetch: fetchDouble, calls }
}

/**
 * Boot the bundle in a fresh jsdom document.
 *
 * @returns {Promise<{dom: JSDOM, document: Document, calls: string[], logs: string[]}>}
 */
async function bootConsole() {
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

  const double = createFetchDouble()
  // Installed before the bundle runs: the shell wraps `window.fetch` at startup
  // to watch for expired sessions, so the double has to be in place first.
  dom.window.fetch = double.fetch

  // The document ships `<script src="/assets/app.js">`; jsdom does not fetch
  // external scripts without `resources: 'usable'`, and fetching is not what
  // this test is about. The bundle is injected inline instead.
  const script = dom.window.document.createElement('script')
  script.textContent = bundle
  dom.window.document.body.appendChild(script)

  return { dom, document: dom.window.document, calls: double.calls, logs }
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
    calls.some((url) => url.includes('/api/ai-debate/settings')),
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
    if (url.includes('/api/ai-debate/settings')) return respond(settings)
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
    if (url.includes('/api/ai-debate/settings')) {
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
    if (url.includes('/api/ai-debate/settings')) return respond(settings)
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
    post.url.endsWith('/api/ai-debate/settings'),
    `保存应打到 /api/ai-debate/settings，实际：${post.url}`,
  )

  // The service's actual write protection is SameSite=Strict + Origin/Host +
  // a required JSON content type. A plain cross-site form cannot produce the
  // last one, so it is the half this client is responsible for.
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

  // And no header the server never reads. A control nobody verifies is worse
  // than none: it looks like protection while adding nothing, and it is exactly
  // what would 403 every POST the moment the server started being strict.
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
  assert.ok(title && title.textContent.includes('登录'), `登录表单标题应含「登录」，实际：${title && title.textContent}`)
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
  assert.ok(title && title.textContent.includes('初始化'), `标题应含「初始化」，实际：${title && title.textContent}`)
  assert.equal(doc.querySelectorAll('.shell-input').length, 3, '初始化表单应有用户名、密码、确认密码三个输入框')
})

test('自动挂机页：切换视图后渲染真实统计，且不丢原有 11 个页签', async (t) => {
  const { dom, document: doc, calls, logs } = await bootConsole()
  t.after(() => dom.window.close())

  await waitFor(() => doc.querySelector('.dsd-card') !== null, '配置卡片应先渲染')

  const navs = [...doc.querySelectorAll('.shell-nav')]
  assert.equal(navs.length, 2, '顶栏应有两个主视图入口')
  const autoNav = navs.find((node) => node.textContent === '自动挂机')
  assert.ok(autoNav, '应有「自动挂机」入口')

  autoNav.click()

  await waitFor(() => doc.querySelector('.auto-panel') !== null, '自动挂机面板应渲染')
  // The card is unmounted on purpose: a hidden React tree would keep polling seven
  // endpoints from a tab nobody is looking at.
  assert.equal(doc.querySelector('.dsd-card'), null, '切走后配置卡片应被卸载，而不是隐藏')
  assert.ok(
    calls.some((url) => url.includes('/automation/status')),
    `应读取真实状态，实际请求：${JSON.stringify(calls.slice(-6))}`,
  )

  // The stats are filled from an async read, so wait for them rather than reading
  // the container the moment it exists.
  await waitFor(() => doc.querySelectorAll('.auto-stat').length >= 5, '统计卡应按真实数据渲染')

  // Five headline numbers, all from the payload — the double returns `{}`, so they
  // must render as "—" or 0 rather than inventing values.
  const stats = [...doc.querySelectorAll('.auto-stat')]
  assert.ok(stats.length >= 5, `应有至少 5 个统计卡，实际 ${stats.length}`)
  for (const stat of stats) {
    assert.ok(stat.querySelector('.auto-stat-label')?.textContent, '每个统计卡都要有标签')
    assert.ok(stat.querySelector('.auto-stat-value')?.textContent, '每个统计卡都要有值')
  }

  // Empty states are stated, not left blank.
  assert.match(
    doc.querySelector('.auto-monitors')?.textContent ?? '',
    /还没有监控目标/,
    '没有监控时应给出明确空状态',
  )

  // Switching back restores the inherited card with its eleven tabs.
  const configNav = navs.find((node) => node.textContent === '配置')
  assert.ok(configNav)
  configNav.click()
  await waitFor(() => doc.querySelector('.dsd-card') !== null, '切回后配置卡片应重新渲染')
  assert.equal(doc.querySelectorAll('.dsd-tab').length, EXPECTED_TABS, '原有 11 个页签必须完整保留')

  const renderErrors = logs.filter((line) => line.includes('RENDER-ERROR'))
  assert.deepEqual(renderErrors, [], '不应出现渲染错误')
})
