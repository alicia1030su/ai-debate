# AI Debate v0.1.0 架构决策记录（ADR · as-built）

> 状态：**v1.1，按已落地的实现校准**。每条决策写：Context / Decision / Consequences / Alternatives（含否决理由）。
> 标记：`Accepted` 已采纳 ｜ `Accepted-with-risk` 采纳但保留风险 ｜ `Superseded` 已被后续决策替换
> 索引见文末。与 `architecture.md` §13 的偏离/缺口编号（D-n / G-n）互相对应。

---

## ADR-001 复用 `apply()` + 独立宿主适配器，而不是重写装配根

**Status**：Accepted（已落地）

**Context**

`packages/core/src/index.ts` 的 `apply(ctx, config)` 约 2700 行，其中 `settingsRouteDeps` 约 1000 行是产品的**全部**业务 API 面：它把 7 条路由需要 28 个顶层回调（`platforms/security/refreshSecrets/config/credentials/overlay/credentialState/acceptSecret*/settings/namespace/testModel/probeHostLlm/probeEgress/checkLogin/previewPersonas/diagnostics/approve/pendingApprovals/manualImport (11 个方法)/platformDiagnostics/verification/analyzeThread/generateCandidates/publishApproved/editCandidate/workbench/runVerification`）逐个接到业务函数。

这些接线里至少 12 个是**安全相关**的，且代码注释写明了接错会怎样：`approve` 只能由浏览器会话触达（agent 没有客户端指向它）、`manualImport` 七步必须整块存在或整块缺席、`publishApproved` 必须走 `runPublish` 而不是另写路径、`pendingApprovals` 必须异步重读磁盘（缓存会谎报「没有待批」）。

**Decision**

适配器（`packages/server/src/standalone-host.ts`，203 行）提供核心想要的宿主面：

- 服务（经 `ctx.get`）：`settings`、`credentials`、`connection`、`webServer`、`paths`、`appInfo`、`appServer`；`llm` **永不提供**
- 上下文成员：`tools.register`（收集 name + 真 disposer）、`systemPrompt.section`（noop + noop disposer）、`logger()`、`effect()`（同步执行 + 收集 disposer）、`inject()`（同步立即调用一次）、`on()`（只接 `credentials/reference-updated`）

`apply()` 的改动被限制为：命名空间改名、`config.ts` 换一行 import、`store-dir.ts` 换目录来源、`host.ts` 新增 `AppServerService`（注入 `trustedHosts`/`info()`）。**装配逻辑一行未改**。

**Consequences**

- 40 多个接线决定零改动；上游语义断言（尤其审批与去重）不需要重新验证。
- 业务只有**一个**出口：`settingsRouteDeps`。页面、CLI、队列都走它，没有第二套。
- 负面：适配器成了单点。它对 Cordis 的语义做了简化（无服务热替换、`inject` 只触发一次），若核心将来依赖这些行为会静默失效。
- 负面：`hostLlmOf` 永远拿不到宿主的 `llm`（独立版本来就没有），那段分支成了死代码。保留的理由：删它要改 `model-source.ts` 与其测试，收益不抵风险。

**Alternatives**

| 方案 | 否决理由 |
|------|----------|
| 另写 composition root（把 1000 行接线重写） | 等于把上游 8 个已修漏洞（`humanApproved` 布尔、approval 无快照、publish 绕过能力门、跨进程台账覆盖…）重新做一遍，且没有测试能证明没退步 |
| core 暴露 `createProductApi(deps)`，server 自己组装 | deps 里 20+ 成员依赖 `apply()` 闭包内的 `credentialMirror`/`runtimeView`/`platforms`，外部组装只能再导出内部对象，耦合更差 |
| 把 `index.ts` 拆成 10 个模块再重写 | 纯重构；收益是可读性，风险是打乱隐式顺序（出网钩子必须在注册中心之后、store 必须在 `buildRuntime` 之前） |

---

## ADR-002 前端用「切片 + 7 条改写」，保留整段 `apply()`，而不是重写成 React

**Status**：Accepted（已落地；取代最初「12 条规则 + 删 apply」的方案，见 Superseded ADR-002-old 说明）

**Context**

`packages/web/vendor-legacy-client.cjs` 7101 行：11 个页签、约 5900 行 `h()` 组件树、502 条文案、`CardStore`（25 个方法、4 组三态读模型）、`CARD_CSS`（120 行，依赖 14 个 `--dsw-alias-*`），以及与宿主耦合的 5 处（`__ModuleLoader__` 外壳、`require('react')`、`require('@deepseek-ai/dsh-client-store')`、`apply(ctx)` 里的 slot/locale 注册、`dshVersion` 文案）。

`apply()` 在页面里的唯一**真实**作用是 `ensureStyles()`——把 `CARD_CSS` 注入 `<head>`。

**Decision**

`scripts/build-web.mjs`：

1. 用**字符串偏移**（`indexOf` / `lastIndexOf`）切出 `factory: (require) => { … return module.exports }` 之间的整段，不用正则（300 KB 模板字符串会吃错区域）。
2. 只做 7 条改写，每条带 `expected` 次数断言（命中数不符 → 整次构建失败，不写文件）。7 条分别是：快照库 `require`、API 前缀、两个凭据 ref 字面量、`card.css` 标识（2 处）、`dataset.plugin`、console 前缀（2 处）。
3. 用 `new Function('exports','require','module','__filename','__dirname', code)` 做**语法校验**：截断/改错在建包时就失败，而不是浏览器白屏。
4. 生成的 `src/legacy-body.cjs` **保留 `apply()` 原封不动**；外壳提供 `createHostContext()`（真执行 `effect`、`inject` 立即回调、`register` 返回 callable），让 `apply()` 跑完并注入样式。

**Consequences**

- 页面一行未删、一个组件未改：0 UI 语义漂移，30+ 个历史 UI 缺陷（「侧栏漏挂工作台导致主流程不可达」「Map 进快照让表单全失效」等）全部继承。
- 生成物 ≈ 原文件行数，验收可以 diff；不存在「改错了哪一段」的模糊地带。
- 负面：`legacy-body.cjs` 是 6900 行单文件，无法按页签懒加载（minify 后 318 KB，gzip 后约 80 KB，可接受）。
- 负面：生成物与手写外壳风格不一致（4 空格/`h()` vs 2 空格/DOM），物理隔离在 `src/generated`-style 命名里。

**Alternatives**

| 方案 | 否决理由 |
|------|----------|
| 用 React 重写 11 个面板 | 5900 行组件 + 4 组三态读模型 + 502 条文案；必然重新引入「失败读成空列表」「异常白屏」等已修复缺陷，且没有测试覆盖新实现 |
| 直接把 CJS 当 `vendor.js` 加载并长期维护一个假 `__ModuleLoader__` | 等于在浏览器里永久维护假宿主；`require` 在浏览器不存在，仍需 shim |
| 把每个 section 拆成独立文件 | 要先确定 `h`/`td`/`store` 的闭包边界，属重构；收益是可读性，风险高于 v0.1.0 需要 |

---

## ADR-003 打包用 Node SEA，而不是 pkg / nexe

**Status**：Accepted-with-risk（脚本已落地；`bundle-server.mjs` 缺失见 G2）

**Context**

需求：Windows 单文件 EXE + Linux TGZ，不要求用户安装 Node。本机实测（Node 22.22.2）：`--experimental-sea-config` 生成 blob ✅、postject 注入后 EXE 可运行（约 87 MB）✅、`node:sea.getAsset()` 读到内嵌资源 ✅、HTTP 可监听 ✅。

已知约束：SEA **不能加载原生 addon**；注入到 CJS bundle 后 `import.meta` 受限；blob 需在构建机上有对应平台的官方 Node 二进制。

**Decision**

`esbuild → 单 CJS → sea-config → blob → 复制官方 node → postject`，Web 资源作为 SEA assets（`web/index.html`、`web/assets/app.js`、`web/assets/theme.css`、`web/manifest.json`）。

产品级硬约束（写进 `architecture.md` §10 与 CI）：

1. **零原生依赖**（没有 SQLite/bcrypt/argon2/keytar/sharp）
2. **不使用 `import.meta`** 做必需路径（`diagnostics.ts` 的版本改为「SEA `package.json` 资源 → 注入常量 → `0.0.0-unknown`」三级兜底）
3. **不使用动态 `require(变量)`**（唯一例外 `weibo-cli` 是 `execFile` 子进程，不受影响）

**Consequences**

- 官方路径、不需编译 Node、字面意义的单文件；`isSea()` 一个分支同时支持「开发读磁盘 / 生产读内嵌」。
- 负面：88–95 MB（Node 运行时占大头）。
- 负面：「跨平台只能在 CI 验证」——本机只能验本平台；用 CI 的 `--version`/`--help`/`curl /healthz` 兜。
- 风险：SEA 在不同 Node 版本有 API 微调（`getAsset` 参数、fuse 名）。锁 Node 22.18.0，CI 固定。
- 若未来需要 SQLite 或系统钥匙串：改「外置 helper 进程」而非放弃 SEA。

**Alternatives**：`pkg`（已归档、Node 22 支持不可靠）、`nexe`（源码编译 Node 20–40 min/平台）、让用户装 Node（违反需求）、Tauri/Electron（为一个浏览器能做的事引入 100 MB WebView）。

---

## ADR-004 配置用「零依赖 schema 构建器 + 同一个活对象」，不用 schemastery

**Status**：Accepted（已落地；比最初「新建 config-schema.ts 元数据」更省）

**Context**

上游 `config.ts` 用 `@deepseek-ai/schemastery`（唯一运行时依赖）定义 `Config`，理由只是「宿主的 Settings 面板要读这个对象」。但 `resolveConfig()` 一直是**手写**的防御式解析（逐字段 `readString/readNumber/clampNumber` + 默认值 + 区间），`settings-routes.ts` 另有 `EDITABLE_FIELDS` 白名单与 `coerceField` 强制。

**Decision**

- 新增 `packages/core/src/schema.ts`（170 行）：`object/string/number/boolean/const/union` + 链式 `default/min/max/role/volatile`，**只描述、不校验**（注释写明：再实现一个校验器就会出现第二个真相源，与 `resolveConfig` 漂移）。
- `config.ts` **只换一行 import**；`Config`/`DEFAULT_CONFIG`/`resolveConfig`/`splitIds` 全部保留（`index.ts` 继续导出 `Config`）。
- 持久层由 server 的 `ConfigStore` 负责：它持有**同一个** raw 对象（`this.#values`），`update()` 原地改属性 —— 这就是「改完立刻生效、无需重挂」的全部机制；启动时 `apply(host.ctx, config.raw)` 传的就是这个对象。
- 拒绝静默覆盖：`ConfigStore` 写前比对磁盘文件 sha256 与上次读到的 hash，不一致抛 conflict（页面已有 `409 → conflict` 文案）。损坏的 `config.json` 改名 `*.corrupt-<ts>` 另存后用空配置启动。

**Consequences**

- 去掉唯一运行时依赖 → 供应链面收敛到零；上游所有字段定义**一个都没动**（零语义漂移）。
- 不需要维护两份字段清单，也不需要用测试锁 `CONFIG_FIELDS` 与 `EDITABLE_FIELDS` 一致（白名单仍在核心，仍是唯一写入裁决者）。
- 负面：`Config`（描述对象）与 `resolveConfig`（真解析）仍是两处，但它们**从不互相校验**，因此不会产生「表单拒绝保存、运行时却接受」的矛盾。
- 负面：`revision` 只是内存计数，真正的冲突判据是文件 hash（这一点在代码注释里写明，避免误用）。

**Alternatives**

| 方案 | 否决理由 |
|------|----------|
| 保留 schemastery | 一个只为「宿主设置面板能读」而存在的依赖，独立版没有消费者 |
| zod / ajv | 引入新依赖（60–120 KB）；已有手写解析，不需要第二个校验器 |
| YAML（沿用 `cordis.patch.yml`） | 用户会手改配置：`on→true`、`0123→83` 这类类型陷阱会制造真实损坏；JSON 有明确解析错误 |
| 新建 `config-schema.ts` 元数据表（最初设计） | 要在 4 个地方（`config.ts` 字段、`DEFAULT_CONFIG`、`EDITABLE_FIELDS`、新元数据表）保持一致，纯增加漂移面；`schema.ts` 让原调用点原封不动 |

---

## ADR-005 凭据用 AES-256-GCM + 同目录密钥，每个 ref 一条密封记录

**Status**：Accepted-with-risk（已落地）

**Context**

要保护两类秘密：贴吧 Cookie（泄漏即可冒充用户发帖）与模型 API Key（可刷额度）。威胁分三层：①文件被误传（网盘/备份/AV/提交 git）②备份迁移过程 ③同用户身份的恶意进程。上游把凭据交给宿主的凭据库，独立版必须自带。

**Decision**

- `credentials.json`：`{version:1, entries:{ [ref]: {iv, tag, data} }}`，**每个 ref 一条 GCM 密封记录**；AAD = ref 名（把 A 的密文搬到 B 会解密失败）。
- 密钥 `credentials.key`：32 B 随机，首次生成，0600（Windows 用 `icacls` 收紧，失败只 warn）。
- ref 白名单：只接受 `AI_DEBATE_*` 且 `[A-Z0-9_]`；未知 ref **抛错**（防止核心将来加字段时写错命名空间，静默写进影子存储）。
- `describe()` 只回答 `configured/source/writable`，**不回长度、不回尾 4 位**。上游那套 `length/tail` 的 DTO 在核心仍在，但本产品不提供额外信息 → 页面不可能显示「已配置 · 长度 0」这类谎言。
- `set/unset` 成功后 `onChange(ref)` → `app.ts` → `host.emitCredentialUpdate(ref)` → 核心 `refreshSecrets()` → 重建平台适配器（cookie jar 必须立刻换掉）。
- 备份**永不**包含 `credentials.*`、`admin.json`、`sessions.json`。

**Consequences**

- 零原生依赖（纯 `node:crypto`），SEA 可用；GCM 自带完整性，篡改 1 字节即抛错而不是返回垃圾。
- 单条损坏不影响其它条；改一条不重写整块。
- 负面：密钥与密文同机同用户 → **不防同用户攻击者**。这不是疏忽，是取舍，写在 `security.md` §3 与 §9。
- 负面：换机/重装需重录凭据（备份不含密钥）。UI 明示。

**Alternatives**：系统钥匙串（`keytar` 是 .node；Linux headless 无 keyring 时静默失败）、口令派生密钥（与开机自启冲突，改密要重加密全部凭据）、明文 + 0600（网上/备份里就是明文，而这正是最容易被截图外传的东西）、不缓存明文（核心 `resolveConfig` 是同步的，必须可同步读——这正是 `CredentialMirror` 存在的理由）。

---

## ADR-006 认证：单管理员 + scrypt + HttpOnly/SameSite=Strict 会话 + 同源/JSON 写保护

**Status**：Accepted（已落地；取代最初「会话绑定 CSRF 自定义头」的方案）

**Context**

上游 `settings-routes.ts` 的认证是**注入**的（`deps.authorize`，实现挂在 DSH Connection）。独立版必须换掉它，但不能削弱已有的围栏：`isTrustedRequest` 已做 Host 精确匹配 + Origin 同源 + `sec-fetch-site`。

**Decision**

1. **单管理员**：`admin.json` 不存在 → `POST /auth/setup`；存在后 409，接口关闭。
2. **口令**：`scrypt` N=16384, r=8, p=1, keylen=64, salt 16 B；`timingSafeEqual`；`params`（`iterations`）随记录落盘以便将来升级；强度：≥10 字符 + 非弱口令；用户名 3–64 且限字符集。
3. **会话**：32 B 随机 → Cookie 明文 `ai_debate_session`；磁盘只存 `sha256(id)`；`HttpOnly; SameSite=Strict; Path=/`，TLS 时加 `Secure`；12h 空闲 / 7d 绝对 / 最多 8 条。
4. **CSRF**：**不用自定义头**。改用三层：`SameSite=Strict`（跨站请求不携带 cookie）+ 全局 `crossSiteReason`（`sec-fetch-site: cross-site` 直接 403；`Origin` 存在且 ≠ `Host` 即 403）+ **写请求必须 `content-type: application/json`**（跨站 HTML 表单无法发送该类型，而 JSON 的跨站发送需要 CORS 预检，本服务从不批准）。
5. **首启**：未初始化时，loopback 对端可直接初始化；**非回环监听**必须出示启动日志里的一次性 token（10 分钟有效、初始化后立即失效）。
6. **限流**：per-IP 与 per-username 双维，15 分钟窗口 8 次；超限 429 + `Retry-After`。
7. **改密**：撤销全部会话并要求重新登录；**退出**撤销当前会话并清 cookie。
8. **控制令牌**：`run/control.json`（0600）里的 token 只允许 `system/status` 与 `system/action` 两个路径 —— CLI 没有浏览器会话但要能停掉自己启动的服务，而能读该文件的进程本来就能删 `state.json`。

**Consequences**

- 零认证库；全部 `node:crypto` + 约 375 行；不引入 JWT（无法撤销、易误配 alg/密钥）。
- `deps.authorize` 签名不变 → 核心 7 条路由**一行未改**就获得新认证。
- 负面：忘记口令的唯一恢复是「手工删 `admin.json` 重新初始化」（文档写明）。这是本地产品的正确取舍：口令恢复只能靠物理访问。
- 负面：会话表在内存 + 落盘（重启即全部登出；更安全）。
- 负面：限流计数只在内存（重启清零，见 R6）。

**As-built 复核（实测，2026-11-19）**

- 三层防护**确实生效**：`crossSiteReason` 拦 `sec-fetch-site: cross-site` 与 `Origin≠Host`；写请求无 `application/json` 被 415 拒。
- **但发现一处不一致（G13）**：`packages/web/src/entry.cjs` 里带着 `x-ai-debate-csrf` 头与 `csrfToken` 逻辑，而 `/auth/state` 从不返回 `csrf`（实测响应只有 `initialized/authenticated/version`），`packages/server/src` 里也**没有任何** `csrf` 校验代码 —— 这个头永远不会被发出，也不会被检查。它不是漏洞（三层已覆盖），但会让读代码的人误以为存在 token 校验。
- **已处理**：前端 token 机制已删除（`grep -c csrf packages/web/src/entry.cjs` = 0），`security.md` §2 与实现一致。会话守卫（401/403 → 回登录页）保留。

**Alternatives**

| 方案 | 否决理由 |
|------|----------|
| 会话绑定 CSRF 头（最初设计） | 生成页面自己发请求，加头要改生成物（违反 ADR-002 的「不改页面」）；而同源+JSON+Strict 已覆盖 CSRF，多一层只是多一处要维护 |
| 现在补实现 CSRF token | 要动 `/auth/state` + 服务端校验 + 页面注入三处，换来的保护与现状重叠；且新增一层就有新增一层的误判面 |
| JWT | 无法服务端撤销；`alg` 误配是经典漏洞；本地产品不需要无状态 |
| HTTP Basic | 每请求传口令；无法撤销单会话；UX 差 |
| 只靠 loopback（无认证） | 本机任何进程都有 loopback 地址，而产品持有 Cookie 与 API Key —— 上游代码里有整段注释解释这一点 |
| 复用 DSH Connection | 那是宿主内部模块，不随产品分发 |

---

## ADR-007 队列是「家务队列」，不含 analyze/generate/verify，更不含 publish

**Status**：Accepted（已落地；**取代**最初「队列承载三类业务任务 + `DebateProductApi` 交付 7 个入口」的方案）

**Context**

需求要求「持久化队列、重启恢复、失败重试与退避、可观测、手动暂停/恢复、防重复执行、限流与资源上限、异常退出安全恢复」，同时「真实发表仍必须人工批准，未验证的发布能力保持禁用」。上游核心的事实：`runPublish` 已有单次批准记录（绑定 session+candidate+platform+target+account+bodyHash+version，`consumedAt` 单次、30 min 过期）+ 去重台账（**先写后发**）+ 能力矩阵门 + 导入会话硬拒；核心**没有**后台调度器（注释明确「the plugin has no background scheduler」）。

**Decision**

1. `JobType` 是**封闭集合**：`backup.create` / `backup.restore` / `logs.rotate` / `credentials.audit` / `storage.check`。不含 analyze/generate/verify/publish。
2. **publish 永远不进队列**：它走核心 `/action` 的 `publish-approved`，同步、人工在场、结果立即可见。
3. 分析和生成是**交互动作**：由页面点按钮 → `/action` 同步执行，状态由服务端返回，页面不靠本地推测。
4. `backup.restore` **崩溃后置 failed**（理由写进 job 的 `lastError`），永不自动重跑；其它类型 `running → queued`（`attempts+1`）。
5. 退避 `5s × 2^(n-1)` 上限 5 min；`maxAttempts` 默认 3；队列上限 200；并发 1；单任务超时 5 min；每任务日志 40 行；`jobs.json` 原子写 + `.bak`。
6. 去重按 `key`：同 key 且已 `queued/running/paused` → 返回既有 job（`deduplicated: true`）。
7. **不存在 `DebateProductApi`**：`apply()` 没有第三参，队列不调业务函数 —— 业务出口仍只有 `settingsRouteDeps`。

**Consequences**

- 不可逆操作永远不会被「重试逻辑」二次触发。这是队列设计的第一目标。
- 业务只有一个出口（ADR-001 要保护的性质），没有「队列路径 vs 页面路径」两套行为。
- 负面：没有「批量后台生成」。这是**产品要求**（人工批准），不是缺陷。
- 负面：崩溃后的 `restore` 需要人工处理（数量极少）。
- 负面：若将来真要「后台跑整篇分析」，需要新增一个 handler + 一个不重试的写保护；当前代码的封闭集合会让这件事显式化（新增类型必须同时决定 `RETRYABLE` 归属）。

**Alternatives**

| 方案 | 否决理由 |
|------|----------|
| 队列承载 analyze/generate/verify + `DebateProductApi`（最初设计） | ①分析/生成搬进队列后，UI 状态从「服务端事实」变成「本地推测」，刷新/断线就会不一致；②新增 `apply()` 第三参 = 第二个业务出口，与 ADR-001 的单出口性质冲突；③verify 是写操作，队列化后必须引入 `maxAttempts=1` + 崩溃转 `needs_confirmation` 的额外状态机，收益低 |
| 用 SQLite 做队列 | 原生依赖 → SEA 不可用（ADR-003） |
| 内存队列 + 启动重建 | 直接违反「重启恢复」与「异常退出安全恢复」 |
| 所有任务（含 publish）都进队列 | 把不可逆写入交给重试逻辑；「批准」的语义是「人在场看着它发」，排队后这条语义消失 |

---

## ADR-008 状态目录：平台默认 + `AI_DEBATE_HOME`，旧 DSH 目录只探测不迁移

**Status**：Accepted（目录逻辑已落地；**导入复制未实现**，G1）

**Context**

上游 `store-dir.ts` 的顺序是 `config.storeDir → host 目录服务 → DSH_HOME → ~/.dsh/ai-debate`，并有「新目录为空但旧目录有数据 → 抛错拒绝启动」的保护。那条保护在独立版会让老用户第一次打开就 500。

**Decision**

- 核心侧顺序：`config.storeDir` → host 探测（server 注入 `paths.dataDir`）→ `AI_DEBATE_HOME`（绝对才接受）→ 平台默认（Windows `%LOCALAPPDATA%\ai-debate`；Linux `$XDG_DATA_HOME/ai-debate` 否则 `~/.local/share/ai-debate`；macOS `~/Library/Application Support/ai-debate`）。`StoreDirSource = configured|env|default`。
- server 侧：`--data-dir` → `AI_DEBATE_HOME` → 同上平台默认。
- 旧目录 `legacyDshStoreDir()` 保留，**只用于探测**（`detectLegacy()` 返回 `{found, dir, note}`，`/system/status` 的 `legacy` 字段）。启动时若新目录与旧目录**都**有 `state.json` → 抛错（明确拒绝合并），让用户自己决定。
- **不做**自动迁移；`migration.md` 承诺的「dryRun → 确认 → 仅空台账时复制」是 G1 要补的实现。

**Consequences**

- 老用户不会因目录冲突起不来；也不会被「偷偷读了旧数据」坑。
- 负面：多一条「用户可能永远不导入」的路径（可接受：数据还在旧目录，没被删）。
- 负面：文档承诺了导入功能而实现只有探测 → **文档与实现不一致**，是 G1 的成因，必须在发布前补齐（或改文档，但改文档等于承认迁移不可用）。

**Alternatives**：保留抛错保护（独立版首启 500）、自动迁移（静默合并台账 → 重复发表风险）、把数据放安装目录（`Program Files` 不可写；卸载带走数据）。

---

## ADR-009 默认只监听 loopback，但信任主机表可注入（为反代留接缝）

**Status**：Accepted（已落地）

**Context**

核心的信任围栏 `isTrustedRequest(request, trustedHosts)` 是**精确主机名匹配**（默认 `127.0.0.1`/`localhost`/`[::1]`/`::1`），且明确「永不从 `Host` 头自动扩宽」——那正是 DNS rebinding 防线。上游后来把「peer 地址必须是回环」从围栏里移走，理由是「只监听 loopback 是**listener** 的属性，内核会拒绝非本机连接」。

**Decision**

- CLI 默认 `--host 127.0.0.1`；允许改（`--host 0.0.0.0` 或指定网卡）——这是 `security.md` §6 的远程访问路径。
- 可信主机表由 server 通过 `appServer` 服务注入（`host.ts` 的 `appServerOf`），核心**不会**自己从请求头推断。
- **不内置 TLS 终止**；远程必须走反代，且反代必须原样转发 `Host`/`Origin`（否则同源校验会拒，这是设计意图）。
- 非回环监听时，首启必须出示一次性 token（ADR-006）。

**As-built 复核（实测，2026-11-19）—— 曾只落地一半，已补齐**

- 首次复核发现：核心侧有注入点，但 `standalone-host.ts` 没提供 `appServer`，`trustedHosts` 因此回落到「仅 loopback 名」，`--host 0.0.0.0` 下 `Host: 192.168.1.20` / `debate.example.com` 请求 `/settings` 全部 **403**。
- **已修复**：适配器现在提供 `appServer: { trustedHosts, info() }`；`trustedHostsFor(host, env)` 从**绑定地址**推导（`0.0.0.0` 不推导任何具体网卡名）+ `AI_DEBATE_TRUSTED_HOSTS`（逗号分隔）显式追加；`info()` 补齐设置页的进程事实块。
- 复验（`dist/ai-debate.cjs serve --host 0.0.0.0`）：env 列出 `192.168.1.20,debate.example.com` → 两者 `/settings` 均 **401**（放行，只缺会话）；未列出的 `evil.example.com` → **403**；**不设 env 时 LAN Host 仍 403**（fail-closed 保持）。
- 残留：`secureCookies` 仍硬编码 `false`（无内置 TLS 时正确），TLS 分支保留待反代场景启用。

**Consequences**

- 默认行为与需求一致（只监听 127.0.0.1）；同时不堵死「我在自己局域网用手机看工作台」这个真实需求。
- 负面：`0.0.0.0` + 无反代 = 口令在明文 HTTP 上传输。文档明确写「程序不会替你假装它是安全的」，并把「如何正确远程」写成 4 步。
- 负面：`secureCookies` 目前硬编码 `false`（因为没有 TLS），`sessionCookie` 的 `Secure` 分支已实现但未启用。

**Alternatives**：硬性只允许 loopback（更好的一致性，但会让反代路径无法工作，而反代是安全远程的唯一正确方式）；内置自签 TLS（证书管理/浏览器警告是一整块工作量，且用户仍可能点「继续」）。

---

## ADR-010 备份 = 目录 + manifest（sha256），内容含数据不含身份

**Status**：Accepted（已落地；与最初「单个 JSON」不同）

**Context**

备份三个用途：换机迁移、误操作回滚、升级前快照。若把 `credentials.json` + `credentials.key` 一起打包，备份文件就是「可直接解密凭据的容器」；若带 `admin.json`，备份泄漏等于口令哈希泄漏（可离线爆破）。

**Decision**

- 备份是 **`backups/<YYYY-MM-DDTHH-mm-ss>/` 目录**，含 `config.json`、`state.json`、`jobs.json`（存在才复制）+ `manifest.json`（每文件 `sha256` + `bytes` + 一句「不含凭据、口令与会话」）。
- **不含** `credentials.*`、`admin.json`、`sessions.json`、`run/*`。
- 恢复：先校验 manifest 里每个文件的 sha256（不匹配 → 拒绝），再把当前三份文件复制到 `backups/pre-restore-<ts>/`，然后覆盖；恢复后**要求重启**（台账在内存里有缓存）。
- 自动备份：6h 一次 + 启动 30s 后首次（有 `state.json` 才跑）；保留最近 7 份自动备份。
- `backup.restore` 崩溃 → 置 `failed`，不重跑（ADR-007 第 4 条）。

**Consequences**

- 备份可以被用户自由分享/上传而不泄漏凭据；逐文件可校验、可人工打开检查。
- 负面：迁移多两步（重录凭据 + 重新登录）。这是用户会感谢的取舍。
- 负面：备份是目录不是单文件，传输时需打包（文档写明可直接 `cp -r`）。

**Alternatives**：单 JSON（不可逐文件校验、部分损坏无法定位）、备份含密钥（一个上传到论坛的「配置备份」就泄漏 Cookie）、备份加密（要用户选口令/记口令/unseal 流程，对单用户本地产品过重）。

---

## ADR-011 零第三方运行时依赖

**Status**：Accepted（已落地）

**Context**

SEA 要求零原生 addon；供应链攻击在本类产品上是现实风险（持有用户 Cookie 与 API Key）；包体直接决定 EXE 大小。

**Decision**

运行时依赖 **0 个**：只用 `node:fs/http/crypto/os/path/child_process/url`（+ `node:sea` 动态 import）。构建期依赖 5 个：`typescript`、`esbuild`、`postject`、`jsdom`（仅测试）、`@types/node`（+ `react`/`react-dom` 打进 web bundle，服务端不需要）。

**Consequences**

- `npm audit` 永远干净；EXE 里没有第三方代码；许可证义务只剩自身 AGPL（+ NOTICE 里的上游来源）。
- 负面：HTTP 路由、cookie、密码学、并发、原子写都要自己写（server 约 2800 行）。已通过「复用核心的 `isTrustedRequest`/`WebRoute`/`readJsonBody` 语义」把工作量压到可控。
- 负面：没有成熟的 ORM/校验库，「自己写」意味着每条规则都要有测试（见 G7）。

**Alternatives**：express + helmet + cookie-parser（+5 MB、3 条供应链、body 解析语义与核心冲突、helmet 默认 CSP 与内联样式冲突）；fastify + 插件（schema 编译在 SEA 下有额外风险）。

---

## ADR-012 命名空间一次性切换，只保留「显式导入用」的旧常量

**Status**：Accepted（已落地；部分清理未完成，G3）

**Context**

需求：API 前缀与产品名统一为 `ai-debate` / AI Debate，不再出现 DSH 前缀（来源说明除外）。同时要处理「老用户已有 DSH 凭据 ref」。

**Decision**

- 路由前缀 `/api/ai-debate/*`；**不保留旧路径别名**（保留 = 两套围栏要同步维护）。
- 凭据 ref `AI_DEBATE_TIEBA_COOKIE` / `AI_DEBATE_LLM_API_KEY`；旧名保留为**常量** `LEGACY_COOKIE_REF` / `LEGACY_LLM_KEY_REF`，用途只有一个：让「显式导入」知道要找什么。**没有任何代码路径会隐式读取旧 ref**（注释写明理由：一个偷偷伸手去旧安装取秘密的产品，与一个从不知道边界在哪的产品无法区分）。
- 唯一保留 DSH 字样的地方：注释里的来源说明、`store-dir.ts` 的 `legacyDshStoreDir()`（文件系统事实）、`secrets.ts` 的 `LEGACY_*`、`NOTICE`/`docs`。
- 许可证：AGPL-3.0-only（派生作品义务）；`NOTICE` 写上游来源。

**Consequences**

- `assert-no-dsh.mjs` 用四条检查锁住：无 `@deepseek-ai/*` import、清单无依赖、无旧 API 前缀、打包二进制在无 DSH 环境下可 `--version`。
- 负面：正在用 DSH 版的老用户需重录 Cookie（UI/文档明示）。
- 负面：`tools.ts` 仍有 6 处 `dsh-ai-debate`（用户可见文案指向不存在的路径）——**G3**，发布前必须清。

**Alternatives**：保留旧路径别名（旧路径会成为「忘记加新校验」的藏身处）；双 ref 读取（「我清除了凭据」会变成假象）。

---

## ADR-013 前端外壳用原生 DOM，只有继承页面用 React

**Status**：Accepted（已落地；取代最初「外壳也用 React」的方案）

**Context**

外壳只需要 5 件事：查认证态、首启表单、登录表单、顶栏（用户名/服务灯/退出）、把 React 挂到 `#app-root`。

**Decision**

`src/entry.cjs`（704 行）用原生 DOM 构建外壳；继承页面由 `ReactDOMClient.createRoot(#app-root)` 拥有。两者在**不同节点**上（`#app-auth` / `#app-root`），清空一个不会掀掉另一个。

**Consequences**

- bundle 不必为 4 个按钮 + 2 个表单再拉一份 React 应用；认证门的正确性不受旧页面容器生命周期影响。
- 「服务端消息里的 `<` 原样显示」是结构性的：外壳只用 `textContent`，没有 `innerHTML`。
- 负面：外壳与页面的写法不一致（DOM vs `h()`），新人需要知道两套都在同一个 bundle 里。
- 负面：会话失效靠 `window.fetch` 包装器实现（生成页面自带请求，没有钩子可插）。包装器是唯一单一位置，也是唯一「隐式全局」的机制。

**Alternatives**：外壳也用 React（+一份 React 运行时、认证门与旧页面耦合、三个文件变六个）；用 hash 路由库（多一个依赖，为 4 个视图不值）。

---

## ADR-014 快照库本地化（40 行替身），不复用 Immer 版

**Status**：Accepted（已落地）

**Context**

`CardStore` 只用 `createSnapshotStore(initial)` 的 `getSnapshot/subscribe/set`。上游实现（`@deepseek-ai/dsh-client-store`）内部走 Immer 并对快照做结构校验 —— 那正是「`Map` 进了快照 → 每次 `set()` 抛 `[Immer] error 2` → 整个表单失效」事故的来源。页面已把 `Map` 扁平化成 `{draftSize, draftFields}`（注释写明）。

**Decision**

`packages/web/src/snapshot-store.cjs`（约 40 行）：持有快照、`set(next)` 若引用相同直接返回、否则替换并**无参**通知监听器（`setState` 直传时带参会被当成「设成那个值」，第一次 publish 就会清空卡片）。`subscribe` 返回取消函数。无 Immer、无深冻结。

**Consequences**

- 零依赖；语义与页面用法一致；事故根因消失。
- 负面：**削弱了一道保护**（不再拒绝非法类型的快照）。缓解：页面已扁平化；`projection()` 的注释是文档；如需更强可以加 dev-only 类型断言，但不必引入 Immer。
- 负面：无法再跑「快照可被 Immer 接受」那类测试（`client-snapshot-boundary.test.ts` 不在迁移范围）。

**Alternatives**：引入 immer（为一个已被绕开的限制引入依赖与同一类失败模式）；改 `CardStore` 用 `useState`（要改 25 个方法与所有 panel 的读法，语义漂移风险高）；保留 DSH 包（违反 ADR-012）。

---

## ADR-015 所有文档「version + 原子写 + 损坏隔离」，不静默重建

**Status**：Accepted（已落地）

**Context**

`config.json` / `credentials.json` / `admin.json` / `sessions.json` / `jobs.json` 都需要：崩溃不留半截文件、可与 CLI/用户脚本共存、未来可迁移。

**Decision**

- 每个文档都有 `version: 1`（迁移入口）。
- 写：`<file>.tmp-<pid>-<rand>` → `fsync` → `rename` →（可选）保留 `.bak`；`mode 0600`。
- 读：JSON 解析失败 → **改名 `<file>.corrupt-<ts>` 另存**（保留证据）+ warn + 用空文档启动。**永不静默删除或重建**（那会把「台账丢了」显示成「从没发表过」）。
- `state.json` 沿用核心自己的实现（原子写 + `.bak` + 跨进程咨询锁 + 去重），server 只读不重写。

**Consequences**

- 与核心的台账语义一致（核心的 `assertStateWritable` 也拒绝 0 字节文件）。
- 负面：Windows 上目录 `fsync` 行为与 POSIX 不同 → 只做文件 `fsync` + `rename`（NTFS 的 rename 是元数据事务）。
- 负面：`.corrupt-*` 文件会累积（数量极少；用户可自行清理）。

**Alternatives**：lowdb（引入依赖且没有我们要的锁/fsync 控制）；一任务一文件（200 上限下无必要）；WAL（对 MB 级文档过重）。

---

## ADR-016 v0.1.0 明确不做（范围冻结）

**Status**：Accepted

| 项 | 为什么现在不做 |
|----|----------------|
| 内置 TLS 终止 | 见 ADR-009：反代是正确路径；证书管理是独立工作量 |
| 多用户 / 角色 / 多租户 | 产品定位是单用户本地工具；引入后所有路由的授权模型都要重写 |
| 工具执行 HTTP 口（`/tools/:name`） | 独立版没有 agent；开放它等于给外部一个「自带 confirm 的发表通道」 |
| 自动发表（含「批准后自动发」） | 需求明确人工批准；核心的批准记录是 30 min 单次，自动发会产生「批了但没发」的悬空态 |
| 微博发布能力 | 微博 provider 只声明读取；发表需 Open Platform 授权。能力矩阵如实报 `unavailable`（界面不会出现可点的发表按钮） |
| 数据合并（DSH 旧台账 + 新台账） | 见 ADR-008：重复发表风险 > 迁移便利 |
| Windows 代码签名 | 要证书（成本 + 身份验证）；文档说明 SmartScreen，预留签名脚本 |
| 自动更新 | 要签名与更新通道；v0.1.0 用「下载新版本覆盖，数据不动」 |
| SQLite / 系统钥匙串 | 原生依赖 → 破坏 SEA 单文件（ADR-003/005） |
| 第三个语言 | 502 条文案 × 2 已够；边际收益低 |

---

## ADR-017 「测试通过」与「扫描通过」必须是诚实的

**Status**：Accepted（发现两处不诚实的绿灯，均已列为阻断项）

**Context**

复核时实跑了两条被写进 README/CI 的命令：

1. `npm test` → 输出 `1..0`、`# tests 0`、**exit 0**。根 `test` 脚本的 glob 是 `test/**/*.test.ts`，而 `test/` 下只有 `acceptance/standalone.ts`（不是 `.test.ts`）；真正的测试在 `packages/*/test/`。于是「测试通过」什么都没跑。
2. `node scripts/scan-secrets.mjs` → **exit 1**，命中 `packages/server/test/runtime.test.ts` 的两行：一个 `sk-` 前缀的假 key、一段 `BDUSS=` 形态的假 cookie。它们**故意**是夹具（验证「密文不落盘」与「日志打码」），但字面形态与真实凭据一致 —— 所以扫描器（正确地）拦了它。

**Decision**

- 根 `npm test` 改为**串行跑四条**（`test:core`、`test:server`、`test:web`、`acceptance`），任一非零即整体非零。（已落地，实测 113+20+6+25 全绿。）
- 凭据扫描：**最终采用的修法是文件级 `ALLOW` 白名单**（`scripts/scan-secrets.mjs`、`test/acceptance/fixtures/README.md`、`packages/server/test/runtime.test.ts`），而不是我建议的「夹具改运行时拼接」。
  - 这样做的**代价**：这三个文件从此不再被扫描 —— 往里写一个真凭据不会被发现。它是「文件级」而非「目录级」，影响面比「跳过所有 `test/`」小得多，但仍是豁免。
  - **保留意见**：如果后续有人往这三个文件加真实值，扫描器不会拦。建议在 `runtime.test.ts` 顶部加一行注释重申「本文件内的凭据形态必须是假值」，并在 code review 时人工看一眼这三处 diff。

**Consequences**

- 两条命令的退出码从此可作准；CI 的准入判断（`secrets-scan` + `verify`）才有意义。
- 负面：扫描器可能因「拼接后仍匹配」而误报，需要用「改一条真形态字符串必须仍被拦」的反向断言守住（WP8.1 验收第 2 条）。

**Alternatives**

| 方案 | 否决理由 |
|---|---|
| 在扫描器里跳过 `**/test/**` | 给发布准入开洞；测试文件同样会被提交、同样可能含真凭据 |
| 删掉 `npm test` 脚本、只留三条 | 读者的肌肉记忆还在；保留一条诚实的聚合命令更好 |
| 把夹具改成注释掉的字符串 | 测试就失去意义（不再真的调用加密/打码路径） |

---

## Superseded：被替换的早期方案（保留记录）

| 原编号 | 被替换的方案 | 现在的方案 | 原因 |
|--------|--------------|------------|------|
| 002-old | 「12 条转换规则，删 `apply()` 与 `exports`」 | ADR-002（切片 + 7 条改写 + 宿主 shim） | 不删代码就没机会删错；`apply()` 的唯一必要行为（注入样式）保留下来，画布行数可 diff |
| 004-old | 「新建 `config-schema.ts` 字段元数据」 | ADR-004（`schema.ts` 构建器 + 活对象） | 元数据表会与 `DEFAULT_CONFIG`/`EDITABLE_FIELDS` 三方漂移；构建器让原调用点零改动 |
| 005-old | 「`secrets.json` 单块密文」 | ADR-005（每 ref 一条密封记录） | 单条损坏不连坐；改一条不重写整块；AAD 使搬移失效 |
| 006-old | 「会话绑定 CSRF 自定义头」 | ADR-006（Strict + 同源 + 强制 JSON） | 加头要改生成页面（违反 ADR-002）；三层已有覆盖 |
| 007-old | 「队列承载 analyze/generate/verify + `DebateProductApi`」 | ADR-007（家务队列，业务单出口） | 避免第二业务出口；交互动作不该排队；verify 是写操作 |
| 010-old | 「备份是单个 JSON」 | ADR-010（目录 + manifest） | 可逐文件校验；可人工检查 |
| 013-old | 「web 目录结构含 `main.jsx`/`App.jsx`/7 个面板组件」 | ADR-013（原生 DOM 外壳 + 单文件 entry） | 外壳只有 4 个视图；第二个 React 应用无收益 |

---

## 决策索引

| ADR | 主题 | 状态 | 关联实现 | 相关缺口 |
|-----|------|------|----------|----------|
| 001 | 复用 `apply()` + 适配器 | Accepted | `server/src/standalone-host.ts` | — |
| 002 | 前端切片 + 7 条改写 | Accepted | `scripts/build-web.mjs`、`web/src/legacy-body.cjs` | — |
| 003 | SEA 打包 | Accepted-with-risk | `packaging/*/build.mjs` | **G2**（`bundle-server.mjs` 缺失） |
| 004 | 零依赖 schema + 活配置对象 | Accepted | `core/src/schema.ts`、`server/src/config-store.ts` | — |
| 005 | AES-256-GCM + 每 ref 密封 | Accepted-with-risk | `server/src/credential-store.ts` | — |
| 006 | 单管理员 + scrypt + Strict/同源/JSON | Accepted | `server/src/auth.ts`、`server/src/http.ts` | 已修（G13：前端 token 死代码已删） |
| 007 | 家务队列 + 发表不进队列 | Accepted | `server/src/jobs.ts` | 已有测试（`runtime.test.ts` 覆盖去重/退避/崩溃恢复/拒收发表类） |
| 008 | 平台默认目录 + 旧数据只探测 | Accepted | `core/src/store-dir.ts`、`server/src/paths.ts` | **G1**（导入未实现） |
| 009 | 默认 loopback + 可信主机可注入 | Accepted | `core/src/settings-routes.ts`、`core/src/host.ts`、`server/src/app.ts` 的 `trustedHostsFor()` | 已修（G11 已复验） |
| 010 | 备份目录 + manifest，不含身份 | Accepted | `server/src/app.ts`（job handlers） | — |
| 011 | 零运行时依赖 | Accepted | 全部 | — |
| 012 | 命名空间一次性切换 | Accepted | `core/src/secrets.ts`、`settings-routes.ts` | **G3**（tools.ts 残留） |
| 013 | 原生 DOM 外壳 | Accepted | `web/src/entry.cjs` | — |
| 014 | 快照库本地化 | Accepted | `web/src/snapshot-store.cjs` | — |
| 015 | version + 原子写 + 损坏隔离 | Accepted | `server/src/atomic.ts` | — |
| 016 | v0.1.0 范围冻结 | Accepted | — | — |
| 017 | 测试与扫描必须诚实 | Accepted | `package.json` scripts、`scripts/scan-secrets.mjs`、测试夹具 | 已修（G10 用文件级 ALLOW，G12 改为串行四条） |
