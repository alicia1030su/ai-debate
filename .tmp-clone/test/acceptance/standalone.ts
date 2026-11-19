/**
 * End-to-end acceptance against a real process.
 *
 * This is the test the release criteria actually describe: start the server the way
 * a user does, create the first administrator, configure a model, import a
 * discussion, generate a candidate against a mock OpenAI-compatible endpoint, edit
 * and approve it, then restart the process and prove the state survived.
 *
 * It talks HTTP and nothing else. That is deliberate: the point is to prove the
 * shipped surface works, not that the modules can call each other.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const PORT = 17901
const MOCK_PORT = 17902
const DATA_DIR = mkdtempSync(join(tmpdir(), 'ai-debate-accept-'))
const PASSWORD = 'acceptance-pass-2026'
const USERNAME = 'owner'

interface Result {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

const results: Result[] = []
let cookie = ''

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${detail === '' ? '' : ` — ${detail}`}\n`)
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.auth !== false && cookie !== '') headers.cookie = cookie
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const setCookie = response.headers.getSetCookie?.() ?? []
  if (setCookie.length > 0) {
    const value = setCookie[0]?.split(';')[0] ?? ''
    if (value !== '') cookie = value
  }
  let parsed: Record<string, unknown> = {}
  try {
    parsed = (await response.json()) as Record<string, unknown>
  } catch {
    parsed = {}
  }
  return { status: response.status, body: parsed }
}

/** A tiny OpenAI-compatible endpoint that answers with a valid generation JSON. */
function startMockModel(): Promise<Server> {
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      raw += chunk
    })
    request.on('end', () => {
      // The prompt names the target post id; echo whatever id it names so the
      // engine's "did the model answer the right person" check can pass honestly.
      const targetMatch = /post id[：: ]*([A-Za-z0-9:_-]+)/.exec(raw)
      const target = targetMatch?.[1] ?? 'local:1'
      const draft = {
        status: 'ok',
        owner_position: '对方的结论建立在个例上。',
        opponent_position: '年轻人不能吃苦。',
        main_dispute: '能否用个别现象概括整体。',
        latest_argument: '用身边例子否定整体结论。',
        response_target_id: target,
        strategy: 'point_out_contradiction',
        confidence: 0.7,
        uncertainties: [],
        reply: '你举的例子只能说明有人这样，不能说明所有人都这样。',
      }
      const payload = {
        id: 'mock-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify(draft) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    })
  })
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)))
}

function startService(): { child: ChildProcess; log: () => string } {
  // `AI_DEBATE_BIN` lets the same acceptance run against the packaged executable,
  // which is the artefact users actually get.
  const binary = process.env.AI_DEBATE_BIN
  const command = binary ?? process.execPath
  const args = [
    ...(binary === undefined ? [join(process.cwd(), 'dist', 'ai-debate.cjs')] : []),
    'serve',
    '--port',
    String(PORT),
    '--data-dir',
    DATA_DIR,
  ]
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AI_DEBATE_HOME: DATA_DIR },
  })
  let log = ''
  const collect = (chunk: Buffer): void => {
    log += chunk.toString('utf8')
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  return { child, log: () => log }
}

async function waitForHealth(timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/healthz`)
      if (response.ok) return true
    } catch {
      // Not up yet.
    }
    await delay(250)
  }
  return false
}

const mock = await startMockModel()
let service = startService()

try {
  record('服务启动', await waitForHealth(), `127.0.0.1:${PORT}`)

  const state = await call('/api/ai-debate/auth/state')
  record('首次运行未初始化', state.body.initialized === false, JSON.stringify(state.body))

  const denied = await call('/api/ai-debate/settings', { auth: false })
  record('未登录访问设置被拒', denied.status === 401, `HTTP ${denied.status}`)

  const setup = await call('/api/ai-debate/auth/setup', {
    method: 'POST',
    body: { username: USERNAME, password: PASSWORD },
    auth: false,
  })
  record('初始化管理员并自动登录', setup.status === 200 && cookie !== '', `HTTP ${setup.status}`)

  const secondSetup = await call('/api/ai-debate/auth/setup', {
    method: 'POST',
    body: { username: 'x', password: 'another-pass-1234' },
    auth: false,
  })
  record('重复初始化被拒', secondSetup.status === 409, `HTTP ${secondSetup.status}`)

  const settings = await call('/api/ai-debate/settings')
  record('登录后读取配置', settings.status === 200 && settings.body.status === 'ready', `HTTP ${settings.status}`)

  const saved = await call('/api/ai-debate/settings', {
    method: 'POST',
    body: { set: { llmBaseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, llmModel: 'mock-model', llmSource: 'custom', llmProtocol: 'chat' } },
  })
  record('保存模型配置', saved.status === 200, `HTTP ${saved.status}`)

  const secret = await call('/api/ai-debate/secrets', {
    method: 'POST',
    body: { ref: 'AI_DEBATE_LLM_API_KEY', value: 'sk-acceptance-0123456789' },
  })
  const settingsAfter = await call('/api/ai-debate/settings')
  const shown = JSON.stringify(settingsAfter.body)
  record('保存 API Key', secret.status === 200, `HTTP ${secret.status}`)
  record('API Key 不回显', !shown.includes('sk-acceptance-0123456789'), shown.slice(0, 80))

  const probe = await call('/api/ai-debate/action', { method: 'POST', body: { action: 'test-llm' } })
  record('测试模型连接', probe.status === 200 && (probe.body.ok === true || probe.body.ok === 'true'), JSON.stringify(probe.body).slice(0, 120))

  const discussion = {
    root: { author: '楼主', text: '现在的年轻人根本不愿意吃苦，一点委屈都受不了。我公司今年招的五个应届生，三个月走了四个。' },
    comments: [
      { id: 'c1', author: '路人甲', text: '你说得太绝对了。我身边很多人加班到很晚，我表弟在工厂两班倒干了两年。', replyTo: 'root' },
      { id: 'c2', author: '楼主', text: '那是他们不敢拒绝，不是能吃苦。真让他们连续一个月每天十二小时，早就跑了。', replyTo: 'c1' },
      { id: 'c3', author: '路人乙', text: '你只说了你们公司五个人的情况，就推到现在所有年轻人身上，这个样本太小了。', replyTo: 'c2' },
      { id: 'c4', author: '楼主', text: '样本小不代表方向错。我做了十年管理，见过的年轻人一批不如一批。', replyTo: 'c3' },
    ],
  }

  const preview = await call('/api/ai-debate/action', {
    method: 'POST',
    body: { action: 'manual-preview', kind: 'json', content: JSON.stringify(discussion), title: '验收讨论' },
  })
  record('导入预览', preview.status === 200 && preview.body.ok === true, JSON.stringify(preview.body).slice(0, 140))

  const confirm = await call('/api/ai-debate/action', {
    method: 'POST',
    body: {
      action: 'manual-confirm',
      kind: 'json',
      content: JSON.stringify(discussion),
      title: '验收讨论',
      ownerName: '楼主',
      targetPostId: 'c2',
    },
  })
  record('确认导入', confirm.status === 200 && confirm.body.ok === true, JSON.stringify(confirm.body).slice(0, 160))
  const sessionId = String(confirm.body.sessionId ?? '')

  let candidateId = ''
  if (sessionId !== '') {
    const generated = await call('/api/ai-debate/action', {
      method: 'POST',
      body: { action: 'manual-generate', sessionId, targetPostId: 'c2' },
    })
    candidateId = String((generated.body.candidate as { id?: string } | undefined)?.id ?? generated.body.candidateId ?? '')
    record('生成候选', generated.status === 200 && generated.body.ok === true, JSON.stringify(generated.body).slice(0, 200))
  } else {
    record('生成候选', false, '没有拿到 sessionId')
  }

  if (candidateId !== '') {
    const edited = await call('/api/ai-debate/action', {
      method: 'POST',
      body: { action: 'manual-edit', sessionId, candidateId, text: '你举的例子只能说明有人这样，不能代表所有人。' },
    })
    record('编辑候选', edited.status === 200, JSON.stringify(edited.body).slice(0, 140))

    const approved = await call('/api/ai-debate/action', {
      method: 'POST',
      body: { action: 'manual-approve', sessionId, candidateId, approvedText: '你举的例子只能说明有人这样，不能代表所有人。' },
    })
    record('人工批准', approved.status === 200 && approved.body.ok === true, JSON.stringify(approved.body).slice(0, 160))

    const copied = await call('/api/ai-debate/action', {
      method: 'POST',
      body: { action: 'manual-copy', sessionId, candidateId },
    })
    record('复制正文', copied.status === 200, JSON.stringify(copied.body).slice(0, 120))
  } else {
    record('编辑候选', false, '缺少 candidateId')
    record('人工批准', false, '缺少 candidateId')
    record('复制正文', false, '缺少 candidateId')
  }

  const status = await call('/api/ai-debate/status')
  record('运行状态可读', status.status === 200, `HTTP ${status.status}`)

  const system = await call('/api/ai-debate/system/status')
  record('系统接口', system.status === 200 && typeof system.body.server === 'object', `HTTP ${system.status}`)

  const job = await call('/api/ai-debate/system/action', { method: 'POST', body: { action: 'backup' } })
  record('创建备份任务', job.status === 200 && job.body.ok === true, JSON.stringify(job.body).slice(0, 120))

  // Restart the process and prove the state is on disk, not in memory.
  const statePath = join(DATA_DIR, 'state.json')
  record('台账已落盘', existsSync(statePath), statePath)
  const sessionsBefore = JSON.parse(readFileSync(statePath, 'utf8')) as { sessions?: unknown[] }

  process.stdout.write('\n… 重启服务，验证状态持久化\n')
  service.child.kill()
  await delay(1500)
  service = startService()
  const restarted = await waitForHealth()
  record('重启后服务可用', restarted, '')

  const afterRestart = await call('/api/ai-debate/settings')
  record('重启后会话仍有效', afterRestart.status === 200, `HTTP ${afterRestart.status}`)

  const stateAfter = JSON.parse(readFileSync(statePath, 'utf8')) as { sessions?: unknown[] }
  record(
    '重启后会话数据仍在',
    (stateAfter.sessions ?? []).length === (sessionsBefore.sessions ?? []).length && (stateAfter.sessions ?? []).length > 0,
    `${(stateAfter.sessions ?? []).length} 个会话`,
  )

  const traversal = await fetch(`http://127.0.0.1:${PORT}/assets/..%2f..%2fconfig.json`)
  record('静态资源路径穿越被拒', traversal.status === 404 || traversal.status === 403, `HTTP ${traversal.status}`)

  const crossSite = await fetch(`http://127.0.0.1:${PORT}/api/ai-debate/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example', cookie },
    body: JSON.stringify({ set: {} }),
  })
  record('跨站写入被拒', crossSite.status === 403, `HTTP ${crossSite.status}`)
} finally {
  service.child.kill()
  mock.close()
  await delay(400)
  if (process.env.AI_DEBATE_KEEP_DATA !== '1') rmSync(DATA_DIR, { recursive: true, force: true })
}

const failed = results.filter((result) => !result.ok)
process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`)
if (failed.length > 0) {
  process.stdout.write(`失败项：${failed.map((item) => item.name).join('、')}\n`)
  process.stdout.write(`\n服务日志：\n${service.log().slice(-4000)}\n`)
  process.exit(1)
}
process.exit(0)
