/**
 * 模型客户端的选择：自己配置的接口，还是什么都不选。
 *
 * ## 为什么单独一个文件
 *
 * `buildLlm()` 原来只有一条路径（读配置里的 Base URL）。后来加进来「出网守卫」，
 * 再后来「宿主模型服务」随宿主一起被去掉了。把「选哪条路 + 为什么选它」摊在一个
 * 函数里，比在运行时里堆三元表达式更容易说清，也更容易测 —— 这个文件不碰磁盘、
 * 不碰网络，只拿配置和两个可注入的依赖，返回一个 `LlmClient` 或一条能读的拒绝
 * 理由。
 *
 * ## 独立版只有一条路，但分支仍然是三条
 *
 * 这个产品没有宿主，`llmSource: 'auto'` 因此一定落到 `custom`（自己的 OpenAI
 * 兼容配置）—— 没有「宿主那一侧」可选。但**分支不能因此压成一条**：
 *
 * - `llmSource: 'host'` 仍然存在（配置从旧版本带过来的人可能选过它）。把它当成
 *   不存在会静默忽略用户的选择，让他以为「切到了某个别的东西」，其实只是默认值
 *   在跑。所以它保留为一条**明确报错**的分支。
 * - `custom` 保留，因为它就是 `auto` 的目标状态，两条路共用 `customClient()`。
 *
 * 也就是说：`auto` 在有配置时返回 `custom`，在没有配置时抛 `unavailable` 并
 * 说清缺哪两项 —— 而不是返回一个 baseUrl 为空、第一次调用才炸的客户端。诊断页
 * 把这次抛错报告成 `source: 'none'`，这正是它该显示的东西。
 */

import type { ResolvedConfig } from './config.js'
import { LlmError, OpenAiCompatibleClient, type LlmClient, type OpenAiClientOptions } from './llm.js'
import { LazyHostLlmClient, type HostLlmLike } from './host-llm.js'
import type { EgressGuard } from './net-audit.js'

/** 选路需要的依赖。 */
export interface ModelSourceDeps {
  /**
   * 宿主模型服务。
   *
   * 独立版永远是 undefined —— 保留这个入口是为了让「有没有宿主」继续是一个
   * **可回答的问题**（诊断页会显示 `hostAvailable`），并让测试可以注入一个假的
   * 宿主来验证 `host` 分支的行为。
   */
  readonly host?: HostLlmLike | undefined
  /** 出网守卫；没有时不做限制（测试与旧调用方）。 */
  readonly egress?: EgressGuard | undefined
  /** 测试注入点。 */
  readonly fetchImpl?: typeof fetch
}

/** 选出来的结果，附带「为什么是它」。 */
export interface ModelSourceChoice {
  readonly client: LlmClient
  /** `host` / `custom` / `none`，用于设置页与诊断。 */
  readonly source: 'host' | 'custom' | 'none'
  /** 人读的说明：用了哪个模型的哪条路，以及为什么。 */
  readonly reason: string
}

/** 自己那份配置是否完整到可以用。 */
function customReady(config: ResolvedConfig): boolean {
  return config.llmBaseUrl.trim() !== '' && config.llmModel.trim() !== ''
}

/**
 * 选一个模型客户端，或者抛出一条带下一步动作的错误。
 *
 * 顺序（`auto`）：
 * 1. 配了 Base URL + 模型名 → 用自己那份。
 * 2. 没配，但上下文里有宿主模型（独立版不会有）→ 用宿主的。
 * 3. 都没有 → 抛 `unavailable`，并说清缺哪两项。
 *
 * `host` 与 `custom` 是强制选择：选了 `host` 就不再回落到自己的配置 —— 一个
 * 「我选了只用宿主的」的用户，不该在某次宿主故障时悄悄花掉自己另一份额度。
 */
export function chooseModelSource(config: ResolvedConfig, deps: ModelSourceDeps = {}): ModelSourceChoice {
  const wantHost = config.llmSource === 'host'
  const wantCustom = config.llmSource === 'custom'

  if (wantCustom) {
    if (!customReady(config)) {
      throw new LlmError(
        '模型来源被设为「自己配置」，但 Base URL 或模型名称还没填。请在设置里补齐这两项，或把来源改回「自动」。',
        'unavailable',
      )
    }
    return { client: customClient(config, deps), source: 'custom', reason: `自己配置的接口：${config.llmModel}` }
  }

  if (wantHost) {
    if (deps.host === undefined) {
      throw new LlmError(
        '模型来源被设为「宿主模型」，但本应用是独立运行，没有宿主模型服务可用。' +
          '请把「模型来源」改回「自动」，并在「模型」一节填上 Base URL、模型名称与 API Key。',
        'unavailable',
      )
    }
    return { client: new LazyHostLlmClient(deps.host), source: 'host', reason: '宿主模型服务（密钥由宿主持有，不读取）' }
  }

  // auto —— 没有宿主时，这就是「用自己那份」。
  if (customReady(config)) {
    return {
      client: customClient(config, deps),
      source: 'custom',
      reason: `自动选择：自己配置的接口（${config.llmModel}）`,
    }
  }
  if (deps.host !== undefined) {
    return {
      client: new LazyHostLlmClient(deps.host),
      source: 'host',
      reason: '自动选择：检测到宿主模型服务，且没有自己配置的接口（密钥由宿主持有，不读取）',
    }
  }
  throw new LlmError(
    '还没有可用的模型。请在本应用的「设置 → 模型」里填 Base URL、模型名称与 API Key，' +
      '指向任意 OpenAI 兼容接口（例如 https://api.deepseek.com/v1 或本机 http://127.0.0.1:11434/v1）。',
    'unavailable',
  )
}

/** 构造自己配置的客户端，并套上出网守卫。 */
function customClient(config: ResolvedConfig, deps: ModelSourceDeps): LlmClient {
  const options: OpenAiClientOptions = {
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
    protocol: config.llmProtocol,
    timeoutMs: config.llmTimeoutMs,
    maxRetries: config.llmRetries ?? 0,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    // 守卫包在 fetch 上：这是模型侧唯一的外呼出口，包在这里意味着没有第二条
    // 绕过它的路径（换协议、换重试都不会）。
    ...(deps.egress === undefined ? {} : { fetchImpl: deps.egress.fetch(deps.fetchImpl ?? fetch) }),
  }
  return new OpenAiCompatibleClient(options)
}
