/** Pin HTTP 403 body diagnosis to the shared fault-classification vocabulary. */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifyFault } from '../lib/fault-classify.js'
import { HttpClient } from '../lib/platforms/http.js'
import { PlatformError } from '../lib/types.js'
import type { DnsResolver } from '../lib/net-audit.js'

const PUBLIC_DNS: DnsResolver = async (_hostname, family) =>
  family === 4 ? [{ address: '93.184.216.34', family: 4 }] : []

const MARKERS = [
  'captcha',
  '验证码',
  '安全验证',
  '人机验证',
  'verify you are human',
  'verify you are a human',
  '异常流量',
  '访问受限',
  'wappass.baidu.com',
  '百度安全验证，请输入验证码',
] as const

function useFetch(t: TestContext, body: string): void {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(body, { status: 403 })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = original
    assert.equal(calls, 1, '403 captcha 是策略拒绝，不得由 HTTP 层重试')
  })
}

test('403 防漂移：HTTP 与 fault classifier 对每个验证标记给出一致结论', async (t) => {
  for (const marker of MARKERS) {
    await t.test(marker, async (child) => {
      useFetch(child, `<html><body>${marker}</body></html>`)
      await assert.rejects(
        () => new HttpClient({ retries: 2, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/p/123'),
        (error: unknown) => {
          assert.ok(error instanceof PlatformError)
          assert.equal(error.code, 'captcha')
          assert.equal(error.status, 403)
          assert.equal(error.retryable, false)
          return true
        },
      )
      const fault = classifyFault({ status: 403, message: marker, hasCredential: true })
      assert.equal(fault.kind, 'challenge')
      assert.equal(fault.retryable, false)
    })
  }
})

test('403 防漂移：真实抓包验证页在两层都归为 challenge，正文不进入错误消息', async (t) => {
  const body = readFileSync(new URL('./fixtures/real/challenge-403.html', import.meta.url), 'utf8')
  useFetch(t, body)
  await assert.rejects(
    () => new HttpClient({ retries: 2, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/p/123'),
    (error: unknown) => {
      assert.ok(error instanceof PlatformError)
      assert.equal(error.code, 'captcha')
      assert.equal(error.message.includes('<html'), false)
      assert.equal(error.message.includes('wapp_pass'), false)
      return true
    },
  )
  assert.equal(classifyFault({ status: 403, message: body, hasCredential: true }).kind, 'challenge')
})

test('403 防漂移：没有验证标记的普通拒绝不被误判为 captcha', async (t) => {
  useFetch(t, 'This resource is forbidden.')
  await assert.rejects(
    () => new HttpClient({ retries: 2, resolver: PUBLIC_DNS }).request('https://tieba.baidu.com/p/123'),
    (error: unknown) => error instanceof PlatformError
      && error.code === 'forbidden'
      && error.status === 403
      && error.retryable === false,
  )
  assert.equal(classifyFault({ status: 403, code: 'forbidden', message: 'This resource is forbidden.', hasCredential: true }).kind, 'platform_refused')
})
