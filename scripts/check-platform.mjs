#!/usr/bin/env node
/**
 * Read a real thread, once, and report exactly what happened.
 *
 * ## What this is for
 *
 * Everything else in the test suite runs against a scripted adapter, and the
 * documentation keeps saying so. This script is the other half: it talks to the
 * real platform and writes down the result — including "blocked", "login
 * required" and "the page no longer parses", which are the outcomes most likely to
 * be quietly omitted from a delivery report.
 *
 * ## What it refuses to do
 *
 * - It does not publish, log in on your behalf, solve a captcha, rotate a user
 *   agent to dodge a block, or retry a refused request. A 403 is recorded as a 403.
 * - It does not claim success when the platform returned a page it could not parse:
 *   zero parsed floors out of a non-empty page is a *failure to read*, not "an
 *   empty thread".
 *
 * ## Usage
 *
 *   node scripts/check-platform.mjs --url https://tieba.baidu.com/p/123456
 *   node scripts/check-platform.mjs --url ... --cookie-from <credential-ref>
 *
 * With no credential the read is anonymous. Some threads are readable that way and
 * some are not; the report says which one this was, because that is the fact an
 * operator needs before trusting a monitor.
 */
import { createTiebaAdapter, tiebaCanHandleUrl } from '../packages/core/lib/platforms/tieba/provider.js'
import { parseTiebaUrl } from '../packages/core/lib/platforms/tieba/url.js'

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  return process.argv[index + 1]
}

const url = arg('url') ?? process.env.AI_DEBATE_LIVE_URL
if (typeof url !== 'string' || url.trim() === '') {
  process.stdout.write(
    JSON.stringify(
      {
        ok: false,
        reason: 'no_url',
        message: '没有提供要读取的帖子链接。用法：node scripts/check-platform.mjs --url <帖子链接>',
      },
      null,
      2,
    ) + '\n',
  )
  process.exit(2)
}

if (!tiebaCanHandleUrl(url)) {
  process.stdout.write(
    JSON.stringify(
      {
        ok: false,
        reason: 'unsupported_url',
        message: '这个脚本目前只验证贴吧读取；链接看起来不属于贴吧。',
        url,
      },
      null,
      2,
    ) + '\n',
  )
  process.exit(2)
}

const startedAt = Date.now()
const ref = parseTiebaUrl(url)

// Deliberately polite and modest: this is a single manual read, not a crawl.
const adapter = createTiebaAdapter({
  settings: {
    timeoutMs: 20_000,
    retries: 0,
    pageDelayMs: 500,
    maxPages: 2,
  },
})

const report = {
  ok: false,
  platform: 'tieba',
  threadId: ref.threadId,
  url: ref.url,
  anonymous: true,
  startedAt: new Date(startedAt).toISOString(),
}

try {
  const auth = await adapter.checkAuthentication()
  report.authenticated = auth.authenticated === true
  report.account = auth.userName ?? null

  const thread = await adapter.getThread(ref)
  report.title = thread.title
  report.bodyAuthor = thread.authorName ?? null
  report.declaredReplyCount = thread.declaredReplyCount ?? null

  const page = await adapter.getReplies(ref, 1)
  report.pageOne = {
    floors: page.floors.length,
    declaredTotalPages: page.declaredTotalPages ?? null,
    declaredTotal: page.declaredTotal ?? null,
    hasMore: page.hasMore,
    pagingState: page.pagingState ?? null,
    incomplete: page.incomplete === true,
  }

  // The honest success test: a page that came back with content must parse into
  // floors. Zero floors on a page the platform served is a parser failure.
  const parsedSomething = page.floors.length > 0
  report.parse = parsedSomething ? 'ok' : thread.content.trim() === '' ? 'empty-page' : 'no-floors-parsed'

  if (page.floors.length > 0) {
    const floor = page.floors[0]
    report.sampleFloor = {
      postId: floor.postId,
      authorName: floor.authorName ?? null,
      hasAuthorId: typeof floor.authorId === 'string' && floor.authorId !== '',
      contentLength: floor.content.length,
      createdAt: floor.createdAt ?? null,
      nestedCount: floor.nestedCount ?? 0,
    }
    if ((floor.nestedCount ?? 0) > 0) {
      const nested = await adapter.getNestedReplies(ref, floor, 1)
      report.nested = {
        replies: nested.replies.length,
        declaredTotalPages: nested.declaredTotalPages ?? null,
      }
    }
  }

  report.ok = report.parse === 'ok'
  report.readOnly = true
  report.message = report.ok
    ? '读取成功。这是一次性只读检查，不代表监控已在长期运行。'
    : '平台返回了页面，但没有解析出楼层。可能是页面结构变化，也可能是被要求登录/验证。'
} catch (error) {
  const code = error?.code ?? 'unknown'
  report.errorCode = code
  report.errorStatus = error?.status ?? null
  report.errorMessage = error instanceof Error ? error.message : String(error)
  report.ok = false
  report.message =
    code === 'auth_required' || code === 'unauthorized' || code === 'forbidden'
      ? '平台要求登录或拒绝了匿名读取。这是权限事实，不是程序缺陷；需要提供有效凭据后再试。'
      : code === 'rate_limited'
        ? '平台限流。脚本不重试，以免加重限制。'
        : '读取失败，原因见 errorMessage。'
} finally {
  report.elapsedMs = Date.now() - startedAt
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exit(report.ok ? 0 : 1)
