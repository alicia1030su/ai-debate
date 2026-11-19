# `packages/web` — 独立 Web 控制台

浏览器端产物：把原 DSH 插件的产品页（7101 行、11 个页签、502 条文案）**原样继承**，外面套一层独立服务需要的外壳（认证门 + 顶栏 + 服务灯）。

## 构建

```bash
node scripts/build-web.mjs          # 生成 legacy-body.cjs + 打包 app.js + 复制 theme.css
node --test packages/web/test/render.test.mjs   # jsdom 渲染验收
```

`npm run build:web` 等价于前者。

产物（`packages/web/static/assets/`，由脚本产出，**不要手写**）：

| 文件 | 说明 |
|------|------|
| `app.js` | IIFE 单文件包，含 React 18 + 产品页 + 外壳 |
| `app.js.map` | sourcemap |
| `theme.css` | 从 `static/theme.css` 复制 |

## 目录

```
packages/web/
├─ vendor-legacy-client.cjs   # 输入，永不修改（转换源）
├─ src/
│  ├─ legacy-body.cjs         # ★生成：从 vendor 切出的 factory 体
│  ├─ snapshot-store.cjs      # 三方法快照 store，替代宿主 Immer 版
│  └─ entry.cjs               # 外壳：宿主 shim + 认证门 + 顶栏 + 服务灯
├─ static/
│  ├─ index.html              # #shell > #app-auth + #app-root
│  ├─ theme.css               # 14 个 --dsw-alias-* 令牌（浅/深色）+ 外壳样式
│  └─ assets/                 # 构建产物
└─ test/render.test.mjs       # jsdom 验收：跑的是 app.js 本身
```

## 转换做了什么（`scripts/build-web.mjs`）

用字符串切片从 `factory: (require) => {` 切到最后一个 `return module.exports`，边界缺失即报错退出，切片后做 `new Function()` 语法自检。然后在 body 上做且只做 7 处替换（每处带期望命中次数，不符即整次失败、不写输出）：

| 替换 | 次数 |
|------|------|
| `require('@deepseek-ai/dsh-client-store')` → `require('./snapshot-store.cjs')` | 1 |
| `'/api/dsh-ai-debate'` → `'/api/ai-debate'` | 1 |
| `'DSH_AI_DEBATE_TIEBA_COOKIE'` → `'AI_DEBATE_TIEBA_COOKIE'` | 1 |
| `'DSH_AI_DEBATE_LLM_API_KEY'` → `'AI_DEBATE_LLM_API_KEY'` | 1 |
| `dsh-ai-debate/card.css` → `ai-debate/card.css` | 2 |
| `tag.dataset.plugin = 'dsh-ai-debate'` → `'ai-debate'` | 1 |
| `[dsh-ai-debate]` → `[ai-debate]` | 2 |

> 凭据 ref 的改名是**功能必需**，不是洁癖：页面按 `ref` **精确匹配** `view.secrets[]`（`secretOf`），而核心 `packages/core/src/secrets.ts` 早以 `AI_DEBATE_*` 名字回答。若停留在旧名字，已配置的 Cookies/API Key 会显示成「未配置」，写路径也会静默失效。`test/render.test.mjs` 的第 2 条测试专门钉住这一点。

`ctx.effect(() => ctx.locale.register(...), ...)` 那一行**保留不动**——外壳提供的假 ctx 里 `locale.register` 是合法实现。

## 与服务端的契约

外壳调用以下路由（`docs/architecture.md` §6 是权威定义）：

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/ai-debate/auth/state` | 启动第一个调用。**别名**：`/api/ai-debate/auth/session`（§6.2 的名字）。外壳两者都试，先答非 404 的赢 |
| POST | `/api/ai-debate/auth/setup` | 首启，`{username, password}` |
| POST | `/api/ai-debate/auth/login` | `{username, password}` |
| POST | `/api/ai-debate/auth/logout` | 退出 |
| GET | `/api/ai-debate/status` | 顶栏服务灯，30 s 一次（页面隐藏时跳过） |

`auth/state` 响应字段（外壳只读这三个）：

```json
{ "initialized": true, "authenticated": true, "username": "owner", "csrf": "<32 hex>" }
```

- `initialized:false` → 渲染「首次初始化」表单（用户名 / 密码 / 确认密码）
- `initialized:true, authenticated:false` → 渲染登录表单
- `initialized:true, authenticated:true` → 渲染主界面

**CSRF**：非 GET 请求会带 `x-ai-debate-csrf`。当前服务端（`packages/server/src/http.ts`）**尚未校验**这个头——它用 `SameSite=Strict` cookie + Origin/Host 同源校验 + JSON content-type 就够挡住跨站——但 `docs/architecture.md` §6.2 / T2 要求会话绑定 token，所以外壳**已经按终局契约发头**：`auth/state` 返回 `csrf` 时用它，首启用字面量 `setup`，两者都没有时不发（旧服务不受影响）。服务端补上校验时前端零改动。

**会话失效**：产品路由返回 401/403 → 卸载卡片、回到登录表单、清空 CSRF。网络错误显示「无法连接服务」并提供重试。

**首启令牌**：非回环地址初始化时服务端要求一次性令牌（`packages/server/src/auth.ts` 的 `setupAllowed`）。外壳默认不显示该字段；初始化失败且错误文案提到「令牌/token」时，**自动重渲染出该输入框**并把已填的用户名带回去，不让用户对着一条提到不存在控件的报错发呆。

### `/status` 需要承载的两个字段

产品页的「诊断与状态」页签有 3 处 DSH 专属措辞，字典在 `legacy-body.cjs` 内部不可达。**约定由服务端在 `/status` 里补字段承载**，页面零改动：

| 字段 | 页面用法 | 服务端应返回 |
|------|----------|--------------|
| `dshVersion` | `t('dshVersion')` 标签 = 「DSH 版本」/「DSH version」，值是 `status.dshVersion \|\| '—'` | **运行版本**（如 `"0.1.0"`）。字段名沿用历史拼写，但语义已是「服务版本」，前端文案由服务端字典迁移任务统一改名（见 `docs/architecture.md` R10） |
| `storePathSource` / `dshHome` | 「数据目录来源」行 | `storeDirSource`（`'env' \| 'default' \| 'legacy'`）+ 可选 `dshHome`（旧 profile 变量，独立服务下留空即可） |

另外 `pluginVersion` / `storePath` / `sessions` / `publishLedger` / `usage` / `rateLimit` / `recentErrors` 也都从 `/status` 读，形状见产品页 `StatusSection`。

### `/settings` 契约（页面首屏依赖）

```json
{
  "status": "ready",
  "writable": true,
  "values": {},
  "secrets": [],
  "capabilities": { "settingsService": true, "credentialService": true }
}
```

`secrets[]` 每项：`{ref, configured, writable, configSuperseded, fromConfigFallback, length, tail?, source?}`。`ref` **必须**是新命名 `AI_DEBATE_TIEBA_COOKIE` / `AI_DEBATE_LLM_API_KEY`（`packages/core/src/secrets.ts` 已定，页面按 `ref` 精确匹配）。旧名字只在**入站**被 `normalizeSecretRef` 接受，出站一律新名字。**不返回任何明文凭据值**，只返回 `length` 与 `tail`（末四位）。

## 已知的坑（转换过程中发现）

1. **esbuild 会把 `require` 参数改名**。`factory: (require) => {...}` 里的 `require('react')` 是**运行时参数**，esbuild 把它改写成 `require2(...)` 并保留原样调用（不会被当成模块解析去打 node_modules）。已验证：故意写一个不存在的模块路径，打包不报错。所以 `legacy-body.cjs` 里的 require 是安全的。
2. **`subscribe` 回调必须无参调用**。`useSectionState` 把 `store.getSnapshot()` 包在闭包里；但页面另外还有两处直接传 `setState` 的风险路径，实现上统一用无参 notify（`snapshot-store.cjs` 已注释说明）。
3. **`document.title` 副作用**：`DebateSection` 有 `useEffect` 改 `document.title`（未保存时加 `*`）。外壳不渲染 `DebateSection`（那是设置侧栏的堆叠页），只渲染 `DebateCard`，所以不会触发；但 jsdom 测试里如果渲染 Section 要注意。
4. **`navigator.language` 决定整页语言**。无 zh 前缀即英文。jsdom 默认 `en-US`，因此测试断言的页签文案是英文——这是正确行为，不是 bug。测试走 `aria-selected` 而不是文案，正是为了不绑死语言。
5. **卡片会自己往 `<head>` 注入 `<style data-plugin-css="ai-debate/card.css">`**。`theme.css` 只提供令牌与外壳样式，不重复卡片样式；两者合起来才是完整观感。
6. **`dsd-foot-sticky` 在独立页面里会一直贴住视口**。原来它贴的是 DSH 设置面板的滚动容器。`theme.css` 里对 `#app-root .dsd-foot-sticky` 复位为 `static`。
7. **页签 10「安全与防注入」的中文标签键是 `tabSecurity`**，英文字典里漏了这个键（渲染出字面量 `tabSecurity`）。这是上游遗留，转换不改字典；`docs/architecture.md` R10 是统一改名任务，可以顺带补上。

## 静态资源契约（给服务端）

`packages/web/static/` 下的内容整体对外提供，路径一一对应：

| 文件 | 对外路径 | 缓存建议 |
|------|----------|----------|
| `index.html` | `/` | `no-store` |
| `assets/app.js` | `/assets/app.js` | `max-age=31536000, immutable` |
| `assets/theme.css` | `/assets/theme.css` | 同上 |
| `manifest.json` | 不对外 | 打包器用它列出要嵌进二进制的资源键（`web/<相对路径>`） |

`manifest.json` 由构建脚本生成（`scripts/web-manifest.mjs`），**不要手写**：单文件可执行里没有目录可遍历，服务端只能按清单找资源，手写清单与产物不一致就是「样式丢失」这一类线上事故。清单里的键已带 `web/` 前缀，与服务端 `AssetStore` 的约定一致。

`static/theme.css` 是**源文件**，`assets/theme.css` 是它每次构建时的副本（`index.html` 引用后者，因为只有 `assets/` 下的资源才拿 immutable 缓存头）。要改样式改源文件，不要改副本。

**CSP**：`script-src 'self'` 足够（页面无内联脚本），但 `style-src` 必须允许内联——卡片启动时自己注入 `<style>`，React 还会写 `style` 属性。即 `style-src 'self' 'unsafe-inline'`。

## 测试

`node --test packages/web/test/render.test.mjs` 跑 6 条，全部跑**打包产物** `static/assets/app.js`：

1. 已登录态：渲染 `.dsd-card`、11 个 `.dsd-tab`、点击第二个页签后 `aria-selected` 翻转、`#app-root` 内无 `CARD-RENDER-ERROR` / `SECTION-RENDER-ERROR`、注入样式表带新标记、`/settings` 真被读取。
2. 凭据配置态：`secrets[].ref` 用新名字时，页面显示「Configured」与末四位，不回退成「Not configured」。**这条钉的是 ref 改名**（把 build 里那两条替换撤掉，此测试立刻红）。
3. 会话过期：卡片渲染后 `/settings` 返回 401 → 卡片被卸载、回到登录表单。
4. CSRF：编辑一个字段并点保存 → 发出的 POST `/api/ai-debate/settings` 带 `x-ai-debate-csrf: <auth/state 返回的 csrf>`。
5. 未登录态：渲染登录表单（2 个输入框）、不渲染卡片、顶栏隐藏、无控制台错误。
6. 未初始化态：渲染初始化表单（3 个输入框）。

断言范围**限定在 `#app-root` 内**：bundle 是被内联注入的 `<script>`，`document.body.textContent` 会包含 bundle 源码本身（源码里就有 `'CARD-RENDER-ERROR:'` 字面量），全 body 断言永远为真。
