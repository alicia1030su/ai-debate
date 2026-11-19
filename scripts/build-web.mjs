#!/usr/bin/env node
/**
 * Build the AI Debate web console.
 *
 * Two jobs, in order:
 *
 *   1. Convert the legacy plugin client (`packages/web/vendor-legacy-client.cjs`)
 *      into a plain CommonJS factory (`packages/web/src/legacy-body.cjs`).
 *      The legacy file is wrapped in the host's `window.__ModuleLoader__.load({...})`
 *      envelope; the page lives entirely inside `factory: (require) => { ... }`.
 *      Slicing that body out is what turns a host plugin into a library, and it
 *      is done with string offsets rather than a regex because a 300 KB file
 *      full of template literals is exactly where a greedy regex quietly eats
 *      the wrong region. If either boundary marker is missing the script fails
 *      loudly instead of writing a half-file.
 *
 *   2. Bundle `packages/web/src/entry.cjs` (shell + body + React) into
 *      `packages/web/static/assets/app.js` with esbuild.
 *
 * Run standalone: `node scripts/build-web.mjs`
 */

import { build } from 'esbuild'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const WEB_ROOT = path.join(ROOT, 'packages', 'web')

/** Legacy host plugin, verbatim, as shipped by the upstream project. */
const VENDOR_CLIENT = path.join(WEB_ROOT, 'vendor-legacy-client.cjs')
/** Generated CommonJS factory body — never edited by hand. */
const GENERATED_BODY = path.join(WEB_ROOT, 'src', 'legacy-body.cjs')
/** The standalone shell entry that imports the generated body. */
const ENTRY = path.join(WEB_ROOT, 'src', 'entry.cjs')
const STATIC_DIR = path.join(WEB_ROOT, 'static')
const ASSETS_DIR = path.join(STATIC_DIR, 'assets')
const THEME_SRC = path.join(STATIC_DIR, 'theme.css')
const THEME_OUT = path.join(ASSETS_DIR, 'theme.css')
const APP_OUT = path.join(ASSETS_DIR, 'app.js')

/** Start of the factory function body inside the legacy envelope. */
const FACTORY_OPEN = 'factory: (require) => {'
/** Last statement of that body; nothing after it belongs to the factory. */
const FACTORY_CLOSE = 'return module.exports'

/**
 * The only edits applied to the extracted body.
 *
 * Each entry carries the number of occurrences that MUST be found: a silent
 * `String.replace` that matches nothing is how a rename ships half-applied and
 * the page starts talking to a route nobody serves.
 */
const BODY_REWRITES = [
  {
    // The host's snapshot store becomes a local three-method shim.
    needle: "require('@deepseek-ai/dsh-client-store')",
    replacement: "require('./snapshot-store.cjs')",
    expected: 1,
    label: '@deepseek-ai/dsh-client-store → ./snapshot-store.cjs',
  },
  {
    // The plugin-owned route family becomes the standalone service's family.
    needle: "'/api/dsh-ai-debate'",
    replacement: "'/api/ai-debate'",
    expected: 1,
    label: '/api/dsh-ai-debate → /api/ai-debate',
  },
  {
    // Credential reference names. The core (packages/core/src/secrets.ts) owns
    // `AI_DEBATE_TIEBA_COOKIE` / `AI_DEBATE_LLM_API_KEY` and answers `/settings`
    // with those names; the page looks secrets up by *exact* `ref`, so leaving
    // the old spelling here would render a configured credential as「未配置」
    // and silently break the write path. The legacy names stay valid on input
    // (`normalizeSecretRef` maps them), but the page must speak the current one.
    // Only the two constant definitions carry the literal; every use site reads
    // through the constant.
    needle: "'DSH_AI_DEBATE_TIEBA_COOKIE'",
    replacement: "'AI_DEBATE_TIEBA_COOKIE'",
    expected: 1,
    label: 'cookie credential ref',
  },
  {
    needle: "'DSH_AI_DEBATE_LLM_API_KEY'",
    replacement: "'AI_DEBATE_LLM_API_KEY'",
    expected: 1,
    label: 'model API key credential ref',
  },
  {
    // Stylesheet identity, in both the de-dupe query and the dataset marker.
    needle: 'dsh-ai-debate/card.css',
    replacement: 'ai-debate/card.css',
    expected: 2,
    label: 'card.css marker (querySelector + dataset)',
  },
  {
    needle: "tag.dataset.plugin = 'dsh-ai-debate'",
    replacement: "tag.dataset.plugin = 'ai-debate'",
    expected: 1,
    label: 'style tag dataset.plugin',
  },
  {
    // Console prefix, so a bug report from the standalone console is greppable
    // with the same string the tests look for.
    needle: '[dsh-ai-debate]',
    replacement: '[ai-debate]',
    expected: 2,
    label: 'console prefix',
  },
  {
    // The status panel's version row used to name the host. Here the host *is*
    // this service, so the label says what the value actually is.
    needle: "dshVersion: 'DSH 版本'",
    replacement: "dshVersion: '服务版本'",
    expected: 1,
    label: 'status label (zh)',
  },
  {
    needle: "dshVersion: 'DSH version'",
    replacement: "dshVersion: 'Service version'",
    expected: 1,
    label: 'status label (en)',
  },
  {
    // "Host model" does not exist in a standalone deployment. Relabelling rather
    // than removing keeps the field, its switch and its probe button intact — the
    // page simply reports that this build has no host model, which is the truth.
    needle: "hostLlmTitle: '宿主模型服务'",
    replacement: "hostLlmTitle: '宿主模型（本构建不提供）'",
    expected: 1,
    label: 'host model title (zh)',
  },
  {
    needle: "hostLlmTitle: 'Host model service'",
    replacement: "hostLlmTitle: 'Host model (not available in this build)'",
    expected: 1,
    label: 'host model title (en)',
  },
  {
    needle: "hostLlmNone: '宿主没有提供模型服务（旧版 DSH 或未启用）。不影响「自己配置」那条路。'",
    replacement: "hostLlmNone: '独立版没有宿主模型服务。请用下方「自己配置」填写 OpenAI 兼容接口。'",
    expected: 1,
    label: 'host model hint (zh)',
  },
  {
    needle: 'hostLlmNone: \'The host exposes no model service (older DSH or disabled). This does not affect the "own endpoint" path.\'',
    replacement: "hostLlmNone: 'The standalone build has no host model. Use \"Own endpoint\" below with any OpenAI-compatible API.'",
    expected: 1,
    label: 'host model hint (en)',
  },
  {
    // The auto/own/host switch keeps all three options (removing one would
    // change the layout the acceptance compares), but the "auto" description
    // must stop promising a host model that is not there.
    needle: "llmSourceHint: '自动：自己配了接口就用它，没配就用宿主已配置的模型。宿主模型由 DSH 调用，插件不读取也不保存任何密钥。'",
    replacement: "llmSourceHint: '自动：使用下方配置的 OpenAI 兼容接口。独立版不读取也不保存除本机凭据存储之外的任何密钥。'",
    expected: 1,
    label: 'model source hint (zh)',
  },
  {
    needle: "llmSourceHint: 'Auto: use your own endpoint when configured, otherwise the model DSH already has. Host models are called by DSH; this plugin never reads or stores a key.'",
    replacement: "llmSourceHint: 'Auto: use the OpenAI-compatible endpoint configured below. This build stores keys only in the local credential store.'",
    expected: 1,
    label: 'model source hint (en)',
  },
  {
    // The directory note explained DSH profiles. The standalone equivalent is
    // "this service owns this directory", which is what the sentence now says.
    needle: "storePathNote: '会话存在这个目录里。换一个 DSH profile 时，这里可能指向别处 —— 历史会话没有消失，只是这个 profile 指向另一个目录。插件不会去扫描其他 profile 的会话。'",
    replacement: "storePathNote: '会话存在这个目录里。用 --data-dir 或 AI_DEBATE_HOME 指向别的目录时，这里会跟着变；本实例不会去扫描其它目录里的会话。'",
    expected: 1,
    label: 'store dir note (zh)',
  },
  {
    needle: "storePathNote: 'Sessions live in this directory. A different DSH profile may point somewhere else — your history is not gone, this profile just looks elsewhere. The plugin never scans other profiles.'",
    replacement: "storePathNote: 'Sessions live in this directory. Pointing --data-dir or AI_DEBATE_HOME elsewhere moves it; this instance never scans another data directory.'",
    expected: 1,
    label: 'store dir note (en)',
  },
  {
    // The source line appended the host's own environment variable when it had
    // one. The standalone service reports `appHome` instead, so this prints the
    // directory it actually resolved rather than a variable that does not exist.
    needle: "`${status.storeDirSource || '—'}${status.dshHome ? `（DSH_HOME=${status.dshHome}）` : ''}`",
    replacement: "`${status.storeDirSource || '—'}${status.appHome ? `（${status.appHome}）` : ''}`",
    expected: 1,
    label: 'store dir source detail',
  },
]

/**
 * Extract the factory body from the legacy envelope.
 *
 * @param {string} source Whole legacy file.
 * @param {string} sourcePath Path used only in error messages.
 * @returns {string} Text between the opening brace and the closing `return`.
 * @throws {Error} When either boundary marker is absent or out of order.
 */
function sliceFactoryBody(source, sourcePath) {
  const openAt = source.indexOf(FACTORY_OPEN)
  if (openAt < 0) {
    throw new Error(`[build-web] ${sourcePath}: 找不到起始标记 ${JSON.stringify(FACTORY_OPEN)}`)
  }
  const start = openAt + FACTORY_OPEN.length

  const closeAt = source.lastIndexOf(FACTORY_CLOSE)
  if (closeAt < 0) {
    throw new Error(`[build-web] ${sourcePath}: 找不到结束标记 ${JSON.stringify(FACTORY_CLOSE)}`)
  }
  if (closeAt < start) {
    throw new Error(
      `[build-web] ${sourcePath}: 结束标记出现在起始标记之前（start=${start}, close=${closeAt}）`,
    )
  }
  return source.slice(start, closeAt + FACTORY_CLOSE.length)
}

/**
 * Replace `needle` with `replacement`, asserting how many sites were touched.
 *
 * Uses `split`/`join` rather than `replace` so the count is observable and the
 * replacement text is never interpreted as a `$`-pattern.
 *
 * @param {string} text Source text.
 * @param {{needle: string, replacement: string, expected: number, label: string}} rule
 * @returns {string} Rewritten text.
 * @throws {Error} When the observed count differs from `rule.expected`.
 */
function replaceExactly(text, rule) {
  const parts = text.split(rule.needle)
  const found = parts.length - 1
  if (found !== rule.expected) {
    throw new Error(
      `[build-web] 替换「${rule.label}」期望 ${rule.expected} 处，实际找到 ${found} 处；` +
        'legacy 客户端可能已变化，请先核对再重新生成。',
    )
  }
  return parts.join(rule.replacement)
}

/**
 * Compile-check a CommonJS source without executing it.
 *
 * `new Function` parses the whole body eagerly, so a truncated slice or a
 * botched rewrite fails here rather than as a blank page in the browser.
 *
 * @param {string} code CommonJS source.
 * @throws {Error} When the source is not syntactically valid.
 */
function assertParses(code) {
  try {
    // The parameters mirror a real CommonJS wrapper; nothing is invoked.
    new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  } catch (error) {
    throw new Error(`[build-web] 生成的 legacy-body.cjs 语法不合法：${error.message}`)
  }
}

/** Generate `src/legacy-body.cjs` from the vendored legacy client. */
async function buildLegacyBody() {
  const source = await readFile(VENDOR_CLIENT, 'utf8')
  let body = sliceFactoryBody(source, VENDOR_CLIENT)

  const applied = []
  for (const rule of BODY_REWRITES) {
    const before = body
    body = replaceExactly(before, rule)
    applied.push(rule.label)
  }

  const banner = [
    "'use strict'",
    '/* AUTO-GENERATED from vendor-legacy-client.cjs — do not edit by hand. */',
    '/* Regenerate with: node scripts/build-web.mjs */',
  ].join('\n')

  const output = `${banner}\nconst __factory = (require) => {${body}\n};\n\nmodule.exports = __factory;\n`
  assertParses(output)

  await mkdir(path.dirname(GENERATED_BODY), { recursive: true })
  await writeFile(GENERATED_BODY, output, 'utf8')

  const rel = path.relative(ROOT, GENERATED_BODY)
  console.log(`[build-web] 生成 ${rel}（${formatSize(Buffer.byteLength(output))}）`)
  for (const label of applied) console.log(`[build-web]   替换：${label}`)
}

/** Bundle the shell entry into a single browser bundle. */
async function bundleApp() {
  await mkdir(ASSETS_DIR, { recursive: true })

  await build({
    entryPoints: [ENTRY],
    outfile: APP_OUT,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    sourcemap: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'none',
    logLevel: 'warning',
    // The vendored file's `zh` dictionary repeats `saving` and `saveFailed`
    // (same value both times, left over from a dictionary merge upstream). It is
    // inherited content, not something this build introduces, and it is not
    // worth failing or shouting about — the second definition wins and is
    // identical. Any *other* warning still prints.
    logOverride: { 'duplicate-object-key': 'silent' },
  })

  const info = await stat(APP_OUT)
  const rel = path.relative(ROOT, APP_OUT)
  console.log(`[build-web] 打包 ${rel}（${formatSize(info.size)}）`)
}

/**
 * Publish the stylesheet next to the bundle.
 *
 * The HTML references `/assets/theme.css` so that everything the server has to
 * serve lives in one directory; `static/theme.css` stays the editable source.
 */
async function publishTheme() {
  await mkdir(ASSETS_DIR, { recursive: true })
  await copyFile(THEME_SRC, THEME_OUT)
  const info = await stat(THEME_OUT)
  console.log(`[build-web] 复制 ${path.relative(ROOT, THEME_OUT)}（${formatSize(info.size)}）`)
}

/**
 * Human-readable byte count.
 *
 * @param {number} bytes Size in bytes.
 * @returns {string} e.g. `301.3 KB`.
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

async function main() {
  await buildLegacyBody()
  await bundleApp()
  await publishTheme()
  // No `manifest.json` is written here on purpose. The asset inventory is
  // produced by `scripts/bundle-server.mjs`, which copies this directory into
  // `dist/web` and then lists exactly what it copied (version + all six files,
  // including the map). Two producers for one file is how the checked-in
  // manifest drifted from the packaged one; this build only owns `assets/`.
  console.log('[build-web] 完成')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
