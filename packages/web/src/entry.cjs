'use strict'
/**
 * Standalone web console for AI Debate.
 *
 * The product page itself is inherited verbatim from the upstream plugin
 * (`vendor-legacy-client.cjs`, converted to `legacy-body.cjs` by
 * `scripts/build-web.mjs`). This file adds the two things a standalone service
 * needs and a host-plugin never did:
 *
 *   1. A tiny host shim, so `plugin.apply()` runs at all. Its only real job is
 *      `ensureStyles()`, which injects the card's stylesheet into `<head>`;
 *      the slot/locale registrations are no-ops here because there is no shell
 *      to register into.
 *   2. The product shell around the card: authentication gate, top bar, and the
 *      React mount point.
 *
 * The shell is written with plain DOM calls on purpose. Adding a second React
 * application just to draw four buttons and two forms would double the bundle
 * for no behaviour, and it would put the auth gate's correctness at the mercy
 * of whatever the legacy page does to its container.
 */

const React = require('react')
const ReactDOMClient = require('react-dom/client')
const { createSnapshotStore } = require('./snapshot-store.cjs')
const factory = require('./legacy-body.cjs')

/** Route family owned by the standalone service. */
const API_BASE = '/api/ai-debate'
/**
 * Session probe, in preference order.
 *
 * `/auth/state` is this console's contract. `/auth/session` is the name in
 * `docs/architecture.md` §6.2, and both may exist while the server is being
 * built out. The first path that answers anything other than 404 wins and is
 * remembered, so a service that implements only one spelling still boots.
 */
const AUTH_STATE_PATHS = [API_BASE + '/auth/state', API_BASE + '/auth/session']
const AUTH_SETUP_URL = API_BASE + '/auth/setup'
const AUTH_LOGIN_URL = API_BASE + '/auth/login'
const AUTH_LOGOUT_URL = API_BASE + '/auth/logout'
const STATUS_URL = API_BASE + '/status'

/** Header the service requires on every unsafe request. */
const CSRF_HEADER = 'x-ai-debate-csrf'
/** The value that unlocks first-run setup, before any session exists. */
const CSRF_SETUP = 'setup'

/** Resolved session-probe path; `null` until one has answered. */
let authStatePath = null

/**
 * The session's CSRF token.
 *
 * Held here rather than on `globalThis` because the shell's `fetch` wrapper is
 * the one place that injects it: the inherited page builds its own `headers`
 * object and has no hook to add a header, so rewriting that would mean editing
 * generated code. One owner, one injection point.
 */
let csrfToken = ''

/** How often the top-bar dot re-checks the service. */
const STATUS_POLL_MS = 30000


/**
 * Build the inherited product page.
 *
 * The factory only ever asks for two modules. Anything else is a programming
 * error in the vendored file and must fail loudly here rather than resolve to
 * `undefined` and blow up mid-render with a message nobody can trace.
 *
 * @param {(name: string) => unknown} requireImpl Module resolver handed to the body.
 * @returns {{apply: Function, DebateCard: Function, DebateSection: Function}} Plugin exports.
 */
function createPlugin(requireImpl) {
  return factory(requireImpl)
}

const plugin = createPlugin((name) => {
  if (name === 'react') return React
  if (name === './snapshot-store.cjs') return { createSnapshotStore }
  throw new Error(`[ai-debate] 不认识的模块依赖：${name}`)
})

// --------------------------------------------------------------------- shims

/** A disposer that does nothing. */
function noop() {}

/**
 * The smallest host context that lets `plugin.apply()` finish.
 *
 * Every member is a real implementation of the host contract, not a stub that
 * returns `undefined`: `effect` must run its callback (that is how the locale
 * dictionaries and slot registrations get set up), and both `inject` and
 * `register` must hand back callables because the page returns them to
 * `effect` as disposers.
 *
 * @returns {object} Host context for `apply`.
 */
function createHostContext() {
  return {
    effect(effect) {
      const dispose = typeof effect === 'function' ? effect() : undefined
      return typeof dispose === 'function' ? dispose : noop
    },
    locale: {
      register() {
        return noop
      },
    },
    slots: {
      inject(_name, callback) {
        if (typeof callback === 'function') callback()
        return noop
      },
      register() {
        return noop
      },
    },
    logger: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    },
  }
}

/**
 * Run `apply` once, so the card's stylesheet lands in `<head>`.
 *
 * Failure is logged, never thrown: a stylesheet problem must not cost the owner
 * the whole console, and the card renders (unstyled) without it.
 *
 * @returns {void}
 */
let pluginApplied = false
function ensurePluginApplied() {
  if (pluginApplied) return
  pluginApplied = true
  try {
    plugin.apply(createHostContext())
  } catch (error) {
    console.warn('[ai-debate] 卡片样式注入失败，界面将以无样式状态继续：', error)
  }
}

// ----------------------------------------------------------------- DOM helpers

/**
 * Create an element with text and attributes in one call.
 *
 * Text always goes through `textContent`; nothing in this shell ever builds
 * markup from a string, so a server message containing `<` is shown literally
 * instead of being parsed as HTML.
 *
 * @param {string} tag Tag name.
 * @param {Record<string, string>} [attrs] Attributes to set as properties.
 * @param {(Node|string)[]} [children] Children, strings become text nodes.
 * @returns {HTMLElement} The new element.
 */
function el(tag, attrs, children) {
  const node = document.createElement(tag)
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key]
      if (value === undefined || value === null || value === false) continue
      node.setAttribute(key, value === true ? '' : String(value))
    }
  }
  if (children) {
    for (const child of children) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
    }
  }
  return node
}

/** Remove every child of a node. */
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

// ------------------------------------------------------------------ service API

/**
 * One JSON request against the service.
 *
 * Never throws: every failure mode is returned as `{ok:false}` with a message
 * the UI can show verbatim. `network:true` is the one case where there is no
 * server message to show, and it is exactly the case a caller must distinguish
 * — "the service is down" and "the service said no" need different words.
 *
 * @param {string} url Absolute path on this origin.
 * @param {{method?: string, body?: unknown, csrf?: string}} [options] Request options.
 * @returns {Promise<{ok: boolean, status: number, network: boolean, data: any, error: string}>}
 */
async function requestJson(url, options) {
  const method = (options && options.method) || 'GET'
  const init = {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  }
  if (options && options.body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  if (method !== 'GET') {
    // The service rejects unsafe requests without this header. `setup` is the
    // only value that works before a session exists; once there is a session,
    // its token is used. See `docs/architecture.md` §6.2 and threat T1/T2.
    //
    // Login deliberately sends nothing when no token is known yet: it is the
    // call that *creates* the session, so the service cannot be requiring a
    // session-bound token on it, and sending a bogus one would be worse than
    // sending none.
    const token = (options && options.csrf) || csrfToken
    if (token) init.headers[CSRF_HEADER] = token
  }

  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    return { ok: false, status: 0, network: true, data: undefined, error: '无法连接服务' }
  }

  let payload
  try {
    payload = await response.json()
  } catch (error) {
    payload = undefined
  }

  if (!response.ok) {
    const retryAfter = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('retry-after')
      : null
    const base =
      payload && typeof payload.error === 'string' && payload.error !== ''
        ? payload.error
        : `HTTP ${response.status}`
    const message = retryAfter ? `${base}（请 ${retryAfter} 秒后重试）` : base
    return { ok: false, status: response.status, network: false, data: payload, error: message }
  }

  const data = payload && typeof payload === 'object' ? payload : {}
  return { ok: true, status: response.status, network: false, data, error: '' }
}

/**
 * Read the session state, trying each known probe path in turn.
 *
 * A path is "known" once it answers something other than 404; from then on only
 * that path is asked, so the console does not pay two round trips per poll.
 *
 * @returns {Promise<{ok: boolean, status: number, network: boolean, error: string,
 *   initialized: boolean, authenticated: boolean, username: string}>}
 */
async function fetchAuthState() {
  const candidates = authStatePath === null ? AUTH_STATE_PATHS : [authStatePath]

  let last = null
  for (const path of candidates) {
    const result = await requestJson(path)
    if (result.status !== 404) {
      authStatePath = path
      last = result
      break
    }
    last = result
  }

  if (last === null) {
    return {
      ok: false,
      status: 0,
      network: true,
      error: '无法连接服务',
      initialized: false,
      authenticated: false,
      username: '',
    }
  }
  if (!last.ok) {
    return {
      ok: false,
      status: last.status,
      network: last.network,
      error: last.error,
      initialized: false,
      authenticated: false,
      username: '',
    }
  }

  const data = last.data
  csrfToken = typeof data.csrf === 'string' ? data.csrf : ''

  return {
    ok: true,
    status: last.status,
    network: false,
    error: '',
    initialized: data.initialized === true,
    authenticated: data.authenticated === true,
    username: typeof data.username === 'string' ? data.username : '',
  }
}

// ------------------------------------------------------------------- shell state

/** Shell nodes, resolved once in `start()`. */
const nodes = {
  shell: null,
  bar: null,
  barStatus: null,
  barStatusDot: null,
  barStatusText: null,
  barUser: null,
  logout: null,
  authHost: null,
  appRoot: null,
  cardRoot: null,
}

/** Which view is on screen: `'boot' | 'error' | 'auth' | 'main'`. */
let currentView = 'boot'
/** Set while a re-render is already scheduled by the session guard. */
let sessionExpiryHandled = false
/** Interval id for the status dot. */
let statusTimer = null

// ------------------------------------------------------------------ shell views

/** Show or hide the top bar. */
function setBarVisible(visible) {
  if (!nodes.bar) return
  nodes.bar.hidden = !visible
}

/**
 * Set the service dot.
 *
 * @param {'ok'|'warn'|'bad'|'idle'} state Dot state.
 * @param {string} label Text shown next to the dot.
 */
function setServiceState(state, label) {
  if (!nodes.barStatus || !nodes.barStatusDot || !nodes.barStatusText) return
  nodes.barStatusDot.dataset.state = state
  nodes.barStatusText.textContent = label
  nodes.barStatus.title = label
}

/**
 * Swap the content area to a shell-owned view.
 *
 * The auth side and the React card live in separate nodes so that clearing one
 * can never pull the rug from under the other: React owns `#app-root` outright
 * between `createRoot` and `unmount`.
 *
 * @param {'auth'|'main'} which Which node should be visible.
 */
function showNode(which) {
  if (!nodes.authHost || !nodes.appRoot) return
  nodes.authHost.hidden = which !== 'auth'
  nodes.appRoot.hidden = which !== 'main'
}

/** Render the "connecting" placeholder. */
function renderLoading() {
  currentView = 'boot'
  setBarVisible(false)
  showNode('auth')
  clear(nodes.authHost)
  nodes.authHost.appendChild(
    el('div', { class: 'shell-center' }, [
      el('div', { class: 'shell-spinner', 'aria-hidden': 'true' }),
      el('p', { class: 'shell-muted' }, ['正在连接服务…']),
    ]),
  )
}

/**
 * Render the "cannot reach the service" view with a retry control.
 *
 * @param {string} detail Message from the failure.
 */
function renderUnreachable(detail) {
  currentView = 'error'
  setBarVisible(false)
  showNode('auth')
  clear(nodes.authHost)

  const retry = el('button', { class: 'shell-btn shell-btn-primary', type: 'button' }, ['重试'])
  retry.addEventListener('click', () => {
    void boot()
  })

  nodes.authHost.appendChild(
    el('div', { class: 'shell-center' }, [
      el('section', { class: 'auth-card' }, [
        el('h1', { class: 'auth-title' }, ['无法连接服务']),
        el('p', { class: 'auth-desc' }, ['本地服务没有响应。请确认 AI Debate 服务仍在运行，然后重试。']),
        el('p', { class: 'auth-error', role: 'alert' }, [detail || '无法连接服务']),
        retry,
      ]),
    ]),
  )
}

/**
 * Render the first-run / login form.
 *
 * @param {'setup'|'login'} mode Which form to show.
 * @param {string} [message] Error text to preselect.
 */
function renderAuthForm(mode, message) {
  currentView = 'auth'
  setBarVisible(false)
  showNode('auth')
  clear(nodes.authHost)

  const isSetup = mode === 'setup'
  const errorNode = el('p', { class: 'auth-error', role: 'alert' }, [message || ''])

  const username = el('input', {
    class: 'shell-input',
    type: 'text',
    name: 'username',
    autocomplete: 'username',
    spellcheck: 'false',
    required: 'required',
  })
  const password = el('input', {
    class: 'shell-input',
    type: 'password',
    name: 'password',
    autocomplete: isSetup ? 'new-password' : 'current-password',
    required: 'required',
  })
  const confirm = isSetup
    ? el('input', {
        class: 'shell-input',
        type: 'password',
        name: 'confirm',
        autocomplete: 'new-password',
        required: 'required',
      })
    : null

  const submit = el('button', { class: 'shell-btn shell-btn-primary', type: 'submit' }, [
    isSetup ? '初始化并进入' : '登录',
  ])

  const form = el('form', { class: 'auth-form', novalidate: 'novalidate' }, [
    el('label', { class: 'shell-field' }, [el('span', { class: 'shell-label' }, ['用户名']), username]),
    el('label', { class: 'shell-field' }, [el('span', { class: 'shell-label' }, ['密码']), password]),
    confirm
      ? el('label', { class: 'shell-field' }, [
          el('span', { class: 'shell-label' }, ['确认密码']),
          confirm,
        ])
      : null,
    errorNode,
    submit,
  ].filter((node) => node !== null))

  /**
   * Validate, submit, then re-read the auth state.
   *
   * The re-read is not ceremony: a 200 on `/auth/login` only says the password
   * was right, while what the shell needs to know is who it is now and whether
   * the cookie survived. Asking the same endpoint the boot path asks keeps one
   * definition of "signed in".
   */
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    errorNode.textContent = ''

    const name = username.value.trim()
    if (name === '') {
      errorNode.textContent = '请填写用户名'
      username.focus()
      return
    }
    if (password.value === '') {
      errorNode.textContent = '请填写密码'
      password.focus()
      return
    }
    if (confirm && password.value !== confirm.value) {
      errorNode.textContent = '两次输入的密码不一致'
      confirm.focus()
      return
    }

    submit.disabled = true
    submit.textContent = isSetup ? '正在初始化…' : '正在登录…'

    void (async () => {
      const result = await requestJson(isSetup ? AUTH_SETUP_URL : AUTH_LOGIN_URL, {
        method: 'POST',
        // `username` is advisory: the service owns a single local owner and may
        // ignore it, but shipping it means a multi-account service can be added
        // later without changing this form.
        body: { username: name, password: password.value },
        // Setup runs before any session exists, and `setup` is the one CSRF
        // value the service accepts at that point.
        csrf: isSetup ? CSRF_SETUP : undefined,
      })

      if (!result.ok) {
        errorNode.textContent = result.network
          ? '无法连接服务，请检查服务是否在运行。'
          : result.error
        submit.disabled = false
        submit.textContent = isSetup ? '初始化并进入' : '登录'
        return
      }

      const state = await fetchAuthState()
      if (!state.ok) {
        errorNode.textContent = state.network ? '无法连接服务' : state.error
        submit.disabled = false
        submit.textContent = isSetup ? '初始化并进入' : '登录'
        return
      }
      if (!state.authenticated) {
        errorNode.textContent = isSetup ? '初始化已完成，但会话没有建立，请重新登录。' : '登录未生效，请重试。'
        renderAuthForm('login', errorNode.textContent)
        return
      }
      enterMain(state)
    })()
  })

  nodes.authHost.appendChild(
    el('div', { class: 'shell-center' }, [
      el('section', { class: 'auth-card' }, [
        el('h1', { class: 'auth-title' }, [isSetup ? '首次初始化' : '登录 AI Debate']),
        el('p', { class: 'auth-desc' }, [
          isSetup
            ? '为这台机器上的 AI Debate 设置一个管理员账号。账号只用于本机访问，不会被发送到任何外部服务。'
            : '请输入管理员账号以继续。',
        ]),
        form,
      ]),
    ]),
  )

  username.focus()
}

/** Render the authenticated shell: top bar plus the inherited card. */
function enterMain(state) {
  currentView = 'main'
  ensurePluginApplied()
  setBarVisible(true)
  // Drop the auth form rather than merely hiding it: a hidden password input
  // keeps the typed password in the DOM for as long as the page lives.
  clear(nodes.authHost)
  showNode('main')

  if (nodes.barUser) {
    nodes.barUser.textContent = state.username || ''
    nodes.barUser.hidden = state.username === ''
  }

  if (nodes.cardRoot === null) {
    nodes.cardRoot = ReactDOMClient.createRoot(nodes.appRoot)
  }
  nodes.cardRoot.render(React.createElement(plugin.DebateCard))

  sessionExpiryHandled = false
  startStatusPolling()
}

/** Tear the card down and return to the login form. */
function leaveMain(message) {
  stopStatusPolling()
  if (nodes.cardRoot !== null) {
    nodes.cardRoot.unmount()
    nodes.cardRoot = null
  }
  clear(nodes.appRoot)
  // The token belonged to the session that just ended. Keeping it would make the
  // next login's requests carry a credential the service has already revoked.
  csrfToken = ''
  renderAuthForm('login', message)
}

/**
 * Session guard, installed as a `fetch` wrapper.
 *
 * The inherited page owns its own requests, so there is no hook in it for
 * either of the two things the standalone service requires:
 *
 *   - **CSRF.** Every unsafe request must carry `x-ai-debate-csrf`. The page
 *     builds its own `headers` object and cannot know that; adding the header
 *     here covers saves, secret writes, approvals and every action button in one
 *     place, without touching generated code.
 *   - **Expiry.** A 401/403 means the cookie is gone. Nothing in the page can
 *     act on that, so the shell takes the user back to the login form.
 *
 * Both rules live in this one function so they cannot drift apart.
 */
function installSessionGuard() {
  if (typeof window.fetch !== 'function') return
  const nativeFetch = window.fetch

  window.fetch = function guardedFetch(input, init) {
    const url = typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : ''
    const isProductApi = url.indexOf(API_BASE + '/') !== -1
    const isAuthRoute = url.indexOf(API_BASE + '/auth/') !== -1
    const method = String((init && init.method) || 'GET').toUpperCase()

    // Copy rather than mutate: `init` belongs to the caller, and a page that
    // reuses one init object across requests must not accumulate headers.
    let nextInit = init
    if (isProductApi && !isAuthRoute && method !== 'GET' && csrfToken !== '') {
      nextInit = Object.assign({}, init, { headers: withCsrfHeader(init && init.headers) })
    }

    return nativeFetch.call(this, input, nextInit).then((response) => {
      if (isProductApi && !isAuthRoute && (response.status === 401 || response.status === 403)) {
        onSessionExpired()
      }
      return response
    })
  }
}

/**
 * Copy a `headers` value with the CSRF header added.
 *
 * `init.headers` may be a plain object, an array of pairs or a `Headers`
 * instance depending on who built the request; all three are normalised rather
 * than assumed, because the caller here is code this shell does not own. The
 * `Headers` branch goes through the instance's own constructor, so it works in
 * an environment that has `Headers` but no global binding for it.
 *
 * @param {HeadersInit|undefined} headers Existing headers.
 * @returns {Record<string, string> | object} A copy with the token added.
 */
function withCsrfHeader(headers) {
  if (
    headers &&
    typeof headers.get === 'function' &&
    typeof headers.set === 'function' &&
    typeof headers.constructor === 'function'
  ) {
    const copy = new headers.constructor(headers)
    copy.set(CSRF_HEADER, csrfToken)
    return copy
  }
  const merged = {}
  if (Array.isArray(headers)) {
    for (const pair of headers) merged[pair[0]] = pair[1]
  } else if (headers && typeof headers === 'object') {
    for (const key of Object.keys(headers)) merged[key] = headers[key]
  }
  for (const key of Object.keys(merged)) {
    if (key.toLowerCase() === CSRF_HEADER) delete merged[key]
  }
  merged[CSRF_HEADER] = csrfToken
  return merged
}

/** React to a lost session exactly once per expiry. */
function onSessionExpired() {
  if (currentView !== 'main' || sessionExpiryHandled) return
  sessionExpiryHandled = true
  leaveMain('登录状态已失效，请重新登录。')
}

// ------------------------------------------------------------------- service dot

/** Probe `/status` and paint the dot. */
async function pollStatus() {
  const result = await requestJson(STATUS_URL)
  if (result.ok) setServiceState('ok', '服务正常')
  else if (result.network) setServiceState('bad', '服务不可达')
  else if (result.status === 401 || result.status === 403) setServiceState('bad', '登录已失效')
  else setServiceState('warn', '服务异常')
}

/** Start the periodic service probe. */
function startStatusPolling() {
  stopStatusPolling()
  void pollStatus()
  statusTimer = window.setInterval(() => {
    if (document.visibilityState === 'hidden') return
    void pollStatus()
  }, STATUS_POLL_MS)
}

/** Stop the periodic service probe. */
function stopStatusPolling() {
  if (statusTimer !== null) {
    window.clearInterval(statusTimer)
    statusTimer = null
  }
}

// ------------------------------------------------------------------------- boot

/**
 * Resolve a node by id, creating the two the shell owns when absent.
 *
 * `index.html` ships `#shell > #app-root`. The top bar and the auth host are
 * built here so that the served HTML stays a document, not a half-written
 * view that a stale browser cache could disagree with.
 */
function resolveNodes() {
  const shell = document.getElementById('shell') || document.body
  nodes.shell = shell

  let appRoot = document.getElementById('app-root')
  if (appRoot === null) {
    appRoot = el('div', { id: 'app-root' })
    shell.appendChild(appRoot)
  }
  nodes.appRoot = appRoot

  const authHost = el('div', { id: 'app-auth', class: 'app-auth' })
  shell.insertBefore(authHost, appRoot)
  nodes.authHost = authHost

  const statusDot = el('span', { class: 'shell-dot', 'data-state': 'idle', 'aria-hidden': 'true' })
  const statusText = el('span', { class: 'shell-dot-text' }, ['检测中'])
  const barStatus = el(
    'span',
    { class: 'shell-status', title: '服务状态', role: 'status' },
    [statusDot, statusText],
  )
  const barUser = el('span', { class: 'shell-user', hidden: 'hidden' }, [''])
  const systemLink = el(
    'a',
    {
      class: 'shell-link',
      href: STATUS_URL,
      target: '_blank',
      rel: 'noreferrer',
      title: '打开服务状态（JSON）',
    },
    ['系统'],
  )
  const logout = el('button', { class: 'shell-btn shell-btn-ghost', type: 'button' }, ['退出'])

  const bar = el('header', { class: 'shell-bar', hidden: 'hidden' }, [
    el('div', { class: 'shell-bar-left' }, [el('span', { class: 'shell-brand' }, ['AI Debate'])]),
    el('div', { class: 'shell-bar-right' }, [barUser, barStatus, systemLink, logout]),
  ])

  shell.insertBefore(bar, authHost)

  nodes.bar = bar
  nodes.barStatus = barStatus
  nodes.barStatusDot = statusDot
  nodes.barStatusText = statusText
  nodes.barUser = barUser
  nodes.logout = logout

  logout.addEventListener('click', () => {
    void doLogout()
  })
}

/** Log out and fall back to the login form. */
async function doLogout() {
  if (nodes.logout) nodes.logout.disabled = true
  const result = await requestJson(AUTH_LOGOUT_URL, { method: 'POST' })
  if (nodes.logout) nodes.logout.disabled = false
  if (!result.ok) {
    // Keep the console usable: a failed logout means the session is still
    // there, so pretending otherwise would just bounce off the next request.
    setServiceState('warn', result.network ? '无法连接服务' : `退出失败：${result.error}`)
    return
  }
  leaveMain('')
}

/** Read the auth state and show the matching view. */
async function boot() {
  renderLoading()
  const state = await fetchAuthState()

  if (!state.ok) {
    if (state.status === 401 || state.status === 403) {
      renderAuthForm('login', '')
      return
    }
    renderUnreachable(state.error)
    return
  }

  if (!state.initialized) {
    renderAuthForm('setup', '')
    return
  }
  if (!state.authenticated) {
    renderAuthForm('login', '')
    return
  }
  enterMain(state)
}

/** Wire the shell into the served document. */
function start() {
  try {
    if (!document.getElementById('shell') && !document.getElementById('app-root')) {
      console.warn('[ai-debate] 页面缺少 #shell / #app-root，未挂载控制台。')
      return
    }
    resolveNodes()
    installSessionGuard()
    void boot()
  } catch (error) {
    console.error('[ai-debate] 控制台启动失败：', error)
    throw error
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start)
} else {
  start()
}

// Exported for tests and for the packager's smoke check; the browser ignores it.
module.exports = { plugin, boot }
