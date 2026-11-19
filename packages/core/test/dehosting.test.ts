/**
 * The de-hosting guarantees.
 *
 * Every assertion here is about a boundary rather than a feature: where state
 * lives, what the credential is called, what version is reported, and which
 * requests the settings API answers. Those are the things that must not quietly
 * drift back toward the plugin they came from, and a test is the only way that
 * stays true after the code is no longer in front of whoever edits it next.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import type { IncomingMessage } from 'node:http'

import {
  chooseStoreDir,
  legacyDshStoreDir,
  platformDefaultStoreDir,
  resolveStoreDirStrict,
  assertStateWritable,
} from '../lib/store-dir.js'
import {
  COOKIE_REF,
  LEGACY_COOKIE_REF,
  LEGACY_LLM_KEY_REF,
  LLM_KEY_REF,
  RESERVED_PLUGIN_REFS,
  SECRET_REFS,
  legacyRefOf,
  normalizeSecretRef,
} from '../lib/secrets.js'
import { candidateRefs, credentialRefFor, refBelongsToPlatform } from '../lib/platforms/credentials.js'
import { APP_VERSION, PLUGIN_VERSION } from '../lib/diagnostics.js'
import { DEFAULT_TRUSTED_HOSTS, ROUTE_PREFIX, isTrustedRequest } from '../lib/settings-routes.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { chooseModelSource } from '../lib/model-source.js'
import { hostLlmOf } from '../lib/host-llm.js'

/** The smallest object `isTrustedRequest` reads. */
function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

test('the route family is served under this product’s own prefix', () => {
  assert.equal(ROUTE_PREFIX, '/api/ai-debate')
  assert.ok(!ROUTE_PREFIX.includes('dsh'))
})

test('a same-origin request to a trusted host is admitted', () => {
  assert.equal(isTrustedRequest(request({ host: '127.0.0.1:7801', origin: 'http://127.0.0.1:7801' })), true)
})

test('a request whose Host is not in the trusted list is refused', () => {
  // The DNS-rebinding case: a name the operator never configured, arriving with
  // no Origin at all, so nothing else can catch it.
  assert.equal(isTrustedRequest(request({ host: 'evil.example:7801' })), false)
})

test('a configured LAN hostname is admitted only when it is passed in', () => {
  const headers = { host: 'workbench.lan:7801', origin: 'http://workbench.lan:7801' }
  assert.equal(isTrustedRequest(request(headers)), false)
  assert.equal(isTrustedRequest(request(headers), ['workbench.lan']), true)
})

test('the default trusted hosts are the loopback names and nothing else', () => {
  assert.deepEqual([...DEFAULT_TRUSTED_HOSTS], ['127.0.0.1', 'localhost', '[::1]', '::1'])
})

test('a cross-site fetch and a mismatched Origin are both refused', () => {
  assert.equal(isTrustedRequest(request({ host: '127.0.0.1:7801', 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(isTrustedRequest(request({ host: '127.0.0.1:7801', origin: 'http://attacker.example' })), false)
})

test('an unparseable Host is refused rather than thrown on', () => {
  assert.equal(isTrustedRequest(request({ host: 'http://[::1' })), false)
})

test('the credential references no longer carry the old product prefix', () => {
  assert.equal(COOKIE_REF, 'AI_DEBATE_TIEBA_COOKIE')
  assert.equal(LLM_KEY_REF, 'AI_DEBATE_LLM_API_KEY')
  assert.deepEqual([...SECRET_REFS], [COOKIE_REF, LLM_KEY_REF])
  for (const ref of SECRET_REFS) assert.ok(!ref.startsWith('DSH_'), ref)
})

test('the legacy names are kept, but only behind an explicit import', () => {
  assert.equal(LEGACY_COOKIE_REF, 'DSH_AI_DEBATE_TIEBA_COOKIE')
  assert.equal(LEGACY_LLM_KEY_REF, 'DSH_AI_DEBATE_LLM_API_KEY')
  assert.equal(legacyRefOf(COOKIE_REF), LEGACY_COOKIE_REF)
  assert.equal(legacyRefOf(LLM_KEY_REF), LEGACY_LLM_KEY_REF)
  // A legacy name is accepted, and lands on the current name so a value is only
  // ever stored in one place.
  assert.equal(normalizeSecretRef(LEGACY_COOKIE_REF), COOKIE_REF)
  assert.equal(normalizeSecretRef(LEGACY_LLM_KEY_REF), LLM_KEY_REF)
  assert.equal(normalizeSecretRef(COOKIE_REF), COOKIE_REF)
  assert.equal(normalizeSecretRef('SOMETHING_ELSE'), undefined)
  assert.equal(normalizeSecretRef(undefined), undefined)
})

test('both generations of name are reserved against platform claims', () => {
  for (const ref of [COOKIE_REF, LLM_KEY_REF, LEGACY_COOKIE_REF, LEGACY_LLM_KEY_REF]) {
    assert.ok(RESERVED_PLUGIN_REFS.includes(ref), ref)
  }
})

test('the derived cookie reference agrees with the literal', () => {
  assert.equal(credentialRefFor('tieba', 'cookie'), COOKIE_REF)
  assert.equal(refBelongsToPlatform(COOKIE_REF, 'tieba'), true)
  assert.equal(refBelongsToPlatform(COOKIE_REF, 'weibo'), false)
  assert.equal(refBelongsToPlatform(LLM_KEY_REF, 'llm'), false)
})

test('migration candidates name the current reference first', () => {
  const refs = candidateRefs('tieba', 'cookie')
  assert.equal(refs[0], COOKIE_REF)
  // The old spelling is still offered, so an explicit import can find it.
  assert.ok(refs.includes(LEGACY_COOKIE_REF), refs.join(', '))
})

test('the reported version is a real one, under both names', () => {
  assert.equal(PLUGIN_VERSION, APP_VERSION)
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+/)
  assert.notEqual(APP_VERSION, '0.0.0-unknown')
})

test('the platform default directory is the one convention for that platform', () => {
  assert.equal(
    platformDefaultStoreDir({
      platform: 'win32',
      home: 'C:/Users/x',
      env: { LOCALAPPDATA: 'C:/Users/x/AppData/Local' },
    }),
    // The Windows branch builds its path with path.win32, so the expectation has to
    // use the same separators — a POSIX join would pass on Windows and fail on CI.
    win32.join('C:/Users/x/AppData/Local', 'ai-debate'),
  )
  assert.equal(
    platformDefaultStoreDir({ platform: 'darwin', home: '/Users/x', env: {} }),
    '/Users/x/Library/Application Support/ai-debate',
  )
  assert.equal(
    platformDefaultStoreDir({ platform: 'linux', home: '/home/x', env: {} }),
    '/home/x/.local/share/ai-debate',
  )
  assert.equal(
    platformDefaultStoreDir({ platform: 'linux', home: '/home/x', env: { XDG_DATA_HOME: '/data' } }),
    '/data/ai-debate',
  )
})

test('AI_DEBATE_HOME wins over the convention, but only when it is absolute', () => {
  const fromEnv = chooseStoreDir({ platform: 'linux', home: '/home/x', env: { AI_DEBATE_HOME: '/srv/state' } })
  assert.equal(fromEnv.source, 'env')
  assert.equal(fromEnv.dir, '/srv/state')

  const relative = chooseStoreDir({ platform: 'linux', home: '/home/x', env: { AI_DEBATE_HOME: 'rel/state' } })
  assert.equal(relative.source, 'default', '一个相对路径会被忽略，而不是当成当前工作目录下的路径')
})

test('an explicit storeDir beats everything, even a relative one', () => {
  const chosen = chooseStoreDir({
    configured: 'state-here',
    platform: 'linux',
    home: '/home/x',
    env: { AI_DEBATE_HOME: '/srv/state' },
  })
  assert.equal(chosen.source, 'configured', 'AI_DEBATE_HOME 不能盖过显式配置')
  // A relative value resolves against the working directory — the directory the
  // process would actually use, so the page and the filesystem agree. Resolving
  // it against `home` instead would be a silent disagreement between the two.
  assert.match(chosen.dir, /state-here$/)
  assert.ok(chosen.dir.startsWith('/'), `解析结果是绝对路径：${chosen.dir}`)
  assert.equal(chosen.differsFromDefault, true)
})

test('the old plugin directory is not part of the default resolution', () => {
  const chosen = chooseStoreDir({ platform: 'linux', home: '/home/x', env: {} })
  assert.notEqual(chosen.dir, legacyDshStoreDir('/home/x', 'linux'))
  assert.ok(!chosen.dir.includes('.dsh'))
})

test('the old plugin directory is still nameable, for an explicit import', () => {
  assert.equal(legacyDshStoreDir('/home/x', 'linux'), '/home/x/.dsh/ai-debate')
})

test('two populated ledgers are reported, never merged and never thrown on', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-debate-two-'))
  try {
    const chosen = join(home, 'chosen')
    const legacy = legacyDshStoreDir(home, process.platform)
    mkdirSync(chosen, { recursive: true })
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(chosen, 'state.json'), '{"version":1}')
    writeFileSync(join(legacy, 'state.json'), '{"version":1}')

    // A throw here would surface as a 500 on the first request after install, for
    // a situation the user did not create. The resolution succeeds, uses the
    // chosen directory, and reports the other one so the page can offer an import.
    const resolved = resolveStoreDirStrict({ configured: chosen, home, env: {}, platform: process.platform })
    assert.equal(resolved.dir, chosen, '旧台账不会被读进来，也不会被合并')
    assert.equal(resolved.probe.stateExists, true)
    assert.equal(resolved.legacy.dir, legacy)
    assert.equal(resolved.legacy.exists, true)
    assert.equal(resolved.legacy.stateExists, true, '旧台账被报告出来，供显式导入')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an empty new directory next to an old ledger is a fresh start, not a refusal', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-debate-fresh-'))
  try {
    const chosen = join(home, 'chosen')
    const legacy = legacyDshStoreDir(home, process.platform)
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'state.json'), '{"version":1}')

    const resolved = resolveStoreDirStrict({ configured: chosen, home, env: {}, platform: process.platform })
    assert.equal(resolved.dir, chosen)
    assert.equal(resolved.probe.stateExists, false, '新目录还没有台账，这是全新安装而不是歧义')
    assert.equal(resolved.legacy.stateExists, true, '旧数据可导入，但不参与解析')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('when the owner points at the old directory, it is not reported as legacy', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-debate-atlegacy-'))
  try {
    const legacy = legacyDshStoreDir(home, process.platform)
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'state.json'), '{"version":1}')

    const resolved = resolveStoreDirStrict({ configured: legacy, home, env: {}, platform: process.platform })
    assert.equal(resolved.dir, legacy)
    assert.equal(resolved.legacy.exists, false, '解析目录就是旧目录时，没有「另一份」可导入')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a zero-byte state file is refused before it can be overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debate-empty-'))
  try {
    writeFileSync(join(dir, 'state.json'), '')
    assert.throws(() => assertStateWritable(dir), /0 字节/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('there is no host model service, so auto can only mean the configured endpoint', () => {
  // A standalone context: the only services are the two the engine requires.
  assert.equal(hostLlmOf({ tools: {}, systemPrompt: {} }), undefined)

  const configured = {
    ...DEFAULT_CONFIG,
    llmBaseUrl: 'https://api.example.com/v1',
    llmModel: 'example-model',
  }
  const auto = chooseModelSource(configured, { host: undefined })
  assert.equal(auto.source, 'custom', '没有宿主时，auto 必须落到自己配置的接口')
  assert.match(auto.reason, /example-model/)

  const explicit = chooseModelSource({ ...configured, llmSource: 'custom' }, { host: undefined })
  assert.equal(explicit.source, 'custom')

  // Nothing configured at all is an honest refusal, not a client with an empty
  // Base URL that fails on first use.
  assert.throws(() => chooseModelSource({ ...DEFAULT_CONFIG }, { host: undefined }), /还没有可用的模型/)

  // `host` survives as an explicit *error* rather than a silent no-op: a profile
  // that still says "use the host" must be told why that cannot work here.
  assert.throws(
    () => chooseModelSource({ ...configured, llmSource: 'host' }, { host: undefined }),
    /独立运行|没有宿主/,
  )
})
