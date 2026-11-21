# AI Debate v0.2.2 内部安全审计记录

> 性质：发布前内部代码审计与回归证据整理，**不是第三方渗透测试，也不是正式安全签字**。
>
> 审计基线：UTC 2026-11-21 12:03:04 的最终冻结候选，版本 `0.2.2`；B1–B4 与 Soak/持久化架构复审 **IS_PASS YES**。v0.2.2 CI 全 job 已通过，全新连续 24h Soak 正在运行，最终资产下载复验与正式 Release 尚未完成，当前仍为 **NO-GO**。
>
> 范围：认证/会话、凭据、备份恢复、HTTP 运维面、自动挂机、贴吧读取、Linux 部署与发布门禁。
>
> 结论边界：在已审路径中，未发现“未认证直接发表”“API 回显明文凭据”或“备份默认包含密钥/管理员/会话”的实现。真实平台、真实远程部署与最终 Release 资产仍未完成验收，不能据此宣称整体无风险。

## 1. 资产与信任边界

| 资产 | 存放/传输 | 主要威胁 | 主要控制 |
|---|---|---|---|
| 管理员口令 | `admin.json` 仅存 scrypt 哈希 | 爆破、弱口令 | 强度校验、双维限流、恒定时间比较 |
| 浏览器会话 | Cookie；磁盘仅存 SHA-256 | 窃取、CSRF、XSS | HttpOnly、SameSite=Strict、可选 Secure、CSP、同源检查 |
| 平台 Cookie / 模型 Key | `credentials.json` AES-256-GCM 密文 | 备份泄漏、日志泄漏、同用户读取 | 独立密钥、AAD 绑 ref、脱敏、白名单 |
| `credentials.key` | 独立文件，POSIX 0600，Windows 尽力 ACL | 与密文同时泄漏 | 不进入备份；恢复用非秘密指纹判断兼容性 |
| 核心台账/候选/批准 | `state.json` | 篡改、重复发表、丢失 | 原子写、单实例约束、先写后发、一次性批准 |
| 监控/任务/身份 | 三个 JSON 台账 | 重复调用、丢任务、伪造游标 | 先写盘再采纳、租约、全局身份、完整性强约束 |
| 运维接口 | 本机 HTTP 或反向代理 | 未授权备份/恢复/诊断 | 会话鉴权、Host/Origin/JSON 围栏、control token 最小权限 |
| Linux 服务 | root 安装、`ai-debate` 运行 | 路径注入、提权、误删 | systemd 沙箱、路径白名单、双重 purge 确认 |

### 1.1 明示的非目标

- 不防御同一操作系统用户下的其他进程；该进程能读密钥，也能读浏览器 Cookie。
- 不提供多用户、角色、2FA 或系统钥匙串绑定。
- 不内置 TLS；直接公网明文 HTTP 不被认为是安全部署。
- 审计日志不是防篡改存储；能写数据目录的人可以改它。
- Windows EXE 未代码签名。
- 不承诺多实例部署安全。

## 2. 审计方法

### 2.1 人工代码审查

重点审查以下路径的调用顺序、失败分支与数据出口：

- `packages/server/src/auth.ts`：首启、口令、会话、限流、Cookie。
- `credential-store.ts`：密钥生命周期、AES-GCM、缺失/损坏密钥、ACL。
- `http.ts`：Host、同源、JSON、control token、备份/诊断/自动挂机路由。
- `app.ts`：组合根、受信 Host、恢复停机、自动备份、诊断数据构造。
- `backup.ts`：白名单、manifest、符号链接、空间、指纹、回滚、轮转。
- `monitor/*`、`core/src/probe.ts`、`tieba/adapter.ts`、`platforms/http.ts`：SSRF 入口、游标、限流、诊断与秘密出口。
- `packaging/linux/*`：路径策略、unit 渲染、systemd 权限、logrotate、卸载。
- `.github/workflows/*`：发布门禁、资产校验、秘密扫描与不可覆盖策略。

### 2.2 自动化证据

| 方法 | 结果 | 边界 |
|---|---|---|
| `node scripts/scan-secrets.mjs` | 通过，扫描 **235 个受版本控制文件**；扫描器回归 **12/12**；PE 同偏移与 ELF 节级 Node 基线差分均有回归 | 只识别既定秘密形态；不是数据流证明，且有 §5 R-17 的静默边界 |
| server 测试 | **CI 全量 166/166，fail 0**；迁移 38/38、终态恢复 60/60 | 本机历史快照 164/164 完成于最终 server-only 写序修复前，命令输出后本机安全策略附注拦截，未重试；最终计数以 CI 为准。写序修复后 monitor-engine 47/47 |
| core 测试 | **227/227 通过**；B1 四文件定向 **74/74** | 含贴吧分页、manual 重定向/Cookie 隔离、私网/metadata 拒绝、DNS 固定、Abort/429 边界 |
| web 测试 | **12/12 通过** | 含自动挂机、备份错误、诊断与未知值展示 |
| standalone | **27/27 通过** | 含认证、跨站、路径穿越、备份与重启持久化 |
| automation / recovery / paging | **8/8、8 项、7/7 通过** | 平台为脚本化 double，不是真实账号 |
| upgrade | **97/97 通过，`migrated`，`modelCalls=0`** | 真实 v0.2.1 EXE；v0.2.0 仍为 fixture |
| 类型与差异检查 | **`tsc --noEmit`、`git diff --check`、`git diff --cached --check` 均通过** | 最终冻结候选；最终 Tag 复验待回填 |
| v0.2.2 CI | 全 job 通过：运行 `44907546464`，提交 `a119b5d0772c77cd62c9058dbeb2e6ee87ac64fb` | 最终 Tag 与 Release 工作流复验 |

### 2.3 未使用的证据

- 未使用真实贴吧/微博账号。
- 未连接真实模型服务。
- 未在可写 Windows 注册表主机上验证自启。
- 未在 Debian 12 真实 systemd 上验证生命周期。
- 未对最终 v0.2.2 EXE/TGZ 做发布后下载核验。

因此，fixture 通过、静态审查通过与真实环境验证必须分开陈述。

## 3. 已修或已核实的控制项

| 编号 | 问题/控制 | 当前实现 | 可核验证据 |
|---|---|---|---|
| SEC-01 | 备份可能把管理员、密钥或会话带出机器 | 固定七文件白名单；含 `credentials.json` 密文，排除 `credentials.key/admin.json/sessions.json/run/logs` | `backup.ts: BACKUP_FILE_NAMES`；`backup.test.ts` 白名单断言 |
| SEC-02 | 旧配置可能含明文 Cookie/Key | 正常备份拒绝非空 `tiebaCookie/llmApiKey`；恢复前快照清理旧明文字段并另存损坏原文 | `backup.test.ts` 明文拒绝与 pre-restore 清理用例 |
| SEC-03 | 恢复覆盖 live 数据后失败无法回退 | 源校验 → 空间预检 → pre-restore → 逐文件原子替换 → 再校验 → 失败回滚 | `backup.test.ts` 目录冲突、无效 JSON、回调失败用例 |
| SEC-04 | 缺密钥/异密钥恢复可能产生不可用密文 | 启动不建临时 key；缺 key 跳过凭据；指纹匹配恢复；异 key 拒绝整个恢复 | `backup.test.ts` 生产启动顺序用例；`backup-http.test.ts` |
| SEC-05 | 恢复时旧队列可能覆盖 `jobs.json` | 停止引擎、暂停队列、`suspendPersistence()`；成功恢复写独立 receipt；失败回滚后恢复队列并真正重启引擎 | `backup-http.test.ts`、`job-receipts.test.ts` 与 QA 恢复失败 ticks 探针 |
| SEC-06 | HTTPS 反代无法强制 Secure Cookie | `--secure-cookies` / `AI_DEBATE_SECURE_COOKIES=1`，默认关闭；仅 HTTPS 部署开启 | `cli.ts`、`http.ts`、`backup-http.test.ts` Secure 断言 |
| SEC-07 | 运维面权限过宽 | backups/diagnostics/automation 仅会话；control token 仅回环状态与停止/重启 | `backup-http.test.ts` 401/403 与 control 边界 |
| SEC-08 | 诊断可能泄漏秘密 | 诊断只含状态、计数、大小与脱敏错误；测试断言 secret/key/cookie/control token 均不出现 | `app.ts: diagnostics()`；`backup-http.test.ts` |
| SEC-09 | 首启与 DNS rebinding | Host 白名单先于认证；回环 Host 才免一次性 token；token 10 分钟过期；初始化后接口关闭 | `http.ts`、`auth.ts`、`host-trust.test.ts` |
| SEC-10 | 平台读取失败被误判或加深风控 | 429 保留 Retry-After；401/403/captcha 暂停；楼中楼通道冷却后走内联降级 | `tieba-paging.test.ts`、`automation.ts`、`tieba/adapter.ts` |
| SEC-11 | 后台可能越权发表 | `DebateProductApi` 无 publish；`JobType` 封闭；自动挂机无 publish 路由；候选终态待审核 | `product-api.ts`、`jobs.ts`、`automation.ts` 拒绝用例 |
| SEC-12 | Linux 路径注入/误删系统目录 | 生产路径白名单、realpath、禁元字符、三目录禁嵌套；unit/env 只解析不 source/eval；purge 双确认 | `common.sh`、`install.sh`、`uninstall.sh`、`linux-path-policy.sh` |
| SEC-13 | systemd 将受控重启当失败或停止后拉起 | `Restart=on-failure` + `SuccessExitStatus=75` + `RestartForceExitStatus=75`；正常停止 0 | `ai-debate.service`、CI unit 断言 |
| SEC-14 | 服务以 root 运行或可写全盘 | 专用 `ai-debate` 用户；`ProtectSystem=strict`；唯一 `ReadWritePaths`；`NoNewPrivileges` 等 | `ai-debate.service`、`linux-install.sh` 权限断言 |
| SEC-15 | 凭据文件缺失密钥时被新密钥静默覆盖 | 保留 sealed entries 与另存证据；describe/resolve 不创建新 key；提示重填 | `credential-store.ts`、server 凭据测试 |
| SEC-16 | 平台重定向绕过出网钩子或污染 Cookie | manual 逐跳、每跳 fetch 前校验、最多 5 跳；跨域剥离凭据并隔离 `Set-Cookie`；首次 socket lookup 固定 A/AAAA 并复用，同源重定向不重复解析，新 host 逐跳校验，策略变严仍复验；策略拒绝不重试 | Core 227/227、B1 四文件定向 74/74，含 `platform-http.test.ts` 与 `net-audit-egress.test.ts` |
| SEC-17 | 损坏 receipt 毒化诊断或无限膨胀 | 全字段严格校验；2 MiB/50 条/40 日志上限；非法 receipt 忽略并保留现场 | `server/test/job-receipts.test.ts` 14/14 |

## 4. 关键安全流程复核

### 4.1 认证与 CSRF

- 口令：scrypt `N=16384, r=8, p=1`，16 字节盐，`timingSafeEqual`。
- 会话：32 字节随机 id，磁盘只存 SHA-256；空闲 12 小时、绝对 7 天、最多 8 条。
- Cookie：`HttpOnly; SameSite=Strict; Path=/`；`secureCookies=true` 时加 `Secure`。
- 写请求：`Sec-Fetch-Site: cross-site` 或 Origin/Host 不匹配直接 403；有 body 时必须 `application/json`；body 上限 1 MiB。
- CSP：`script-src 'self'`、`frame-ancestors 'none'`、`base-uri 'none'`、`form-action 'self'`，无内联脚本。

### 4.2 凭据与备份

AES-256-GCM 使用随机 12 字节 IV，AAD 绑定 `AI_DEBATE_*` ref。`describe()` 只回答是否可解密，不返回长度或尾号。日志与审计在写入前脱敏。

备份含密文但不含密钥，因此**备份仍须保密**。密钥与备份同时泄漏即可解密；同机恢复保留原管理员与密钥，新机器需重新初始化管理员并重填凭据。

### 4.3 自动挂机与 SSRF

新建监控先用核心 `resolveUrl()` 解析，必须命中已注册平台；内网地址、`file://`、未知域名不落库。后台接口与会话同级鉴权，control token 不能启动监控。

`HttpClient` 使用 `redirect: 'manual'` 逐跳执行重定向，每一跳在 `fetch` 前重新执行出网策略；跨域剥离 `Cookie`/`Authorization`/`Referer`/`Origin`，跨域响应 `Set-Cookie` 进入独立 redirect jar，不污染后续同源请求。`EgressBlockedError` 原样传播，不包装为 network、不重试、不发表。全模式私网/回环/link-local/metadata 拒绝与 DNS rebinding socket 级固定已通过 Core 227/227 回归：首次 socket lookup 固定 A/AAAA，后续连接复用；生产 fetch 使用 dispatcher 时同源重定向不重复解析；新 host 逐跳校验；出网策略变严仍重新验证。预检公网、建连私网的 rebinding 在 socket 前拒绝，本机服务 0 命中。精确边界：`isPinned` 仅在至少一次成功通过策略校验的 socket lookup 后返回 `true`；忽略 dispatcher 的自定义/注入 fetch 不会触发真实 socket lookup，既不能固定地址，也不能依靠 `isPinned` 跳过后续预检。代理配置兼容与 CookieJar 属性模型仍是剩余边界。

### 4.4 发表

真实发表不在维护队列，也不在后台 API。批准记录绑定会话、候选、平台、目标、账号、正文哈希与版本，一次性消费；去重台账先写后发。贴吧登录态真实发表未在本环境验证，能力描述保持诚实，不把未验证路径当成可用。

## 5. 剩余风险

严重度为本审计对“默认单机部署”的判断；远程/公网部署会提高相关风险。

| 编号 | 严重度 | 剩余风险 | 影响 | 缓解/发布立场 |
|---|---|---|---|---|
| R-01 | 高（远程部署） | 无内置 TLS | 直接暴露时口令与会话可被网络窃听 | 默认回环；远程必须反代 TLS，并开启 Secure Cookie；不得直接公网明文 |
| R-02 | 高（备份泄漏） | 备份含凭据密文 | 密文与密钥同时泄漏即可解密 | 密钥不入备份；备份按敏感数据保管；文档与 UI 明示 |
| R-03 | 中 | 无系统钥匙串 | 同用户进程可读密钥并解密 | 明示非目标；POSIX 0600 与 Windows ACL 尽力加固 |
| R-04 | 中 | 身份迁移源台账损坏或候选冲突 | 若忽略错误并以空身份启动，可能重放旧回复 | 启动前严格迁移；state/上下文/候选冲突时熔断；身份/监控源不可读时自动化与核心/手工分析接口熔断，服务与健康检查仍可用 |
| R-05 | 中 | 真实平台路径未验证 | 风控、页面变更、鉴权与限流行为可能与 fixture 不同 | 诊断、冷却、失败分类；未验证能力保持 unavailable |
| R-06 | 中 | Windows EXE 未签名 | SmartScreen/杀软误报或供应链可信度不足 | 发布 SHA256；不伪造签名；用户核验后放行 |
| R-07 | 中（已修复） | 自定义/注入 fetch 忽略 dispatcher；代理/TLS 兼容；CookieJar 属性模型 | 默认 dispatcher 路径的 DNS 固定已闭环，但调用方绕过 dispatcher 时不会触发真实 socket lookup，只剩预检，其他兼容边界仍存在 | B1 已修复并通过 B1–B4 复审：首次 socket lookup 固定 A/AAAA、后续复用、生产 fetch 使用 dispatcher 时同源重定向不重复解析、新 host 逐跳校验、策略变严仍复验；`isPinned` 仅在成功策略校验的 lookup 后为 true；Core 227/227、B1 四文件定向 74/74 |
| R-08 | 中 | 审计日志未防篡改 | 有本地写权限者可改历史 | 明示限制；关键状态另有台账；需要时外部收集 |
| R-09 | 中 | 维护队列写失败只记日志 | `jobs.json` 内存态可能领先磁盘，重启后回退 | 原子写保护旧文件；恢复路径挂起持久化；不等同后台任务 fail-closed |
| R-10 | 中 | 租约与实例记录不是分布式锁 | 强行多实例可重复执行 | 明确单实例；不宣称多实例安全 |
| R-11 | 低–中 | logrotate `copytruncate` | truncate/append 之间可能丢少量日志 | 限制频率与体积；关键审计/台账独立持久化 |
| R-12 | 低 | 登录限流只在内存 | 重启后计数清零 | 重启需本机权限；审计失败尝试 |
| R-13 | 低 | 无 2FA、单管理员 | 口令泄漏即可获得全部权限 | 强口令、会话上限、改密撤销全部会话 |
| R-14 | 低 | control token 使用非密码学随机输入生成 | 不应作为远程安全凭据 | 仅回环 + 需能读 0600 数据目录；权限最小化 |
| R-15 | 低 | Windows ACL/icacls 失败只告警 |  stripped/FAT/受限主机可能未收紧目录 | 日志明确告警；文档建议核对 ACL |
| R-16 | 低 | 讨论正文会发送到用户配置的模型端点 | 第三方模型可见对话内容 | 由用户显式配置；出网策略与审计；隐私提示 |
| R-17 | 低 | 秘密扫描存在静默边界 | 允许文件误存凭据或超大/过深目录可能漏扫 | 默认整文件豁免 scanner 与 fixtures README；目录模式跳过 >4 MiB、深度>8、文件数>5000；SEA 二进制通过 `--baseline` 单独差分：PE 同偏移原字节；ELF 按节名/大小配对并要求至少 99% 可加载代码/静态数据字节一致，只忽略对应字节完全相同的原匹配，新增/改写字节仍拦截 |
| R-18 | 高（已修复，待长跑复验） | core 锁 release 瞬时读失败曾留下活 PID 锁；dirty 内存候选曾被自动化 session 当作持久证据；恢复既有候选曾重复累计 monitor 计数；发现任务写失败后游标曾仍推进 | 曾导致活进程锁长期占用、`coreLockTimeouts=3`、candidate/磁盘不一致、升级计数漂移与 `lostTasks=1` | 已修复：同 PID 孤儿 token 回收、token CAS release、durable-only 读取、幽灵候选无模型收敛、仅新生成候选计数、identity → analysis task → cursor 写序；monitor-engine 47/47、真实升级 97/97、60 秒高磁盘故障压力测试通过；最终 24h 正在运行 |

## 6. 未验证项

以下项目**没有通过证据**，不得在发布说明中写成已完成：

1. 真实贴吧登录、读取、分页、楼中楼、429/401/403 与真实发表。
2. 真实微博账号与外部 CLI 的长期读取。
3. Windows `HKCU\...\Run` 自启写入/关闭/重启；构建机 `reg.exe` 被主机策略拦截。
4. Debian 12 真实 systemd 生命周期；容器无 init，只能证明安装与二进制兼容。
5. 独立 Ubuntu/Debian 虚拟机上的升级、杀进程恢复与卸载。
6. 最终冻结候选的连续 24 小时 Soak 结果；该长跑于 UTC `2026-11-21T12:05:15.222Z` 启动，当前正在运行。历史 302.081s 失败与 5553.25 秒 `lostTasks=1` 失败现场均保留，不能作为通过证据。
7. 最终 Tag 与 Release 工作流；v0.2.2 CI 全部 job 已通过（运行 `44907546464`，提交 `a119b5d0772c77cd62c9058dbeb2e6ee87ac64fb`），但 Tag 驱动的正式 Release 门禁仍待执行。
8. 最终 Windows EXE 与 Linux TGZ 的发布后下载复验；CI 已构建双平台资产，既有本机 EXE 是最终修复前资产。正式附件 SHA256/GitHub digest/Latest 尚未完成，EXE 未代码签名。
9. 真实平台恶意重定向样本与长期真实运行行为。
10. 最终 commit/tag 上的 Release 工作流全量测试、类型检查与资产复验；冻结候选本地门禁与 CI 已通过，Tag 驱动轮次仍待执行。

## 7. 复现命令

```bash
# 秘密形态扫描
node scripts/scan-secrets.mjs

# 类型检查（最终验收必须通过）
npm run typecheck

# 安全相关回归
npm run test:core
npm run test:server
npm run test:web
npm run acceptance
npm run test:automation
npm run test:recovery
npm run test:paging
npm run test:upgrade
npm run test:soak:v022

# Linux 部署策略（无需 root/systemd）
bash test/acceptance/linux-path-policy.sh

# 完整 Linux 生命周期（一次性 root 主机）
sudo bash test/acceptance/linux-install.sh dist/ai-debate-linux-x64.tgz
```

在受限构建机上，若重建钩子被环境策略阻断，应直接生成 core lib 后使用 `npm run --ignore-scripts <suite>` 复跑，并如实记录所用命令；不能把环境阻断写成产品通过。

## 8. 发布前必须回填

| 项目 | 状态 | 回填要求 |
|---|---|---|
| 最终架构复审 | **IS_PASS YES，B1–B4 与 Soak/持久化阻断全部关闭** | 正式 Tag 保持相同实现与证据 |
| 类型与差异检查 | 最终冻结候选通过 | 最终 Tag 与 CI 退出码 0 |
| 24h Soak | **最终冻结候选正在运行** | 连续 24h 不变量、重启、内存、队列/台账峰值与报告路径 |
| Soak/持久化阻断 | 已修复并复审通过 | 最终 24h 与 CI 复验 |
| CI | **全 job 通过**：运行 `44907546464`，提交 `a119b5d0772c77cd62c9058dbeb2e6ee87ac64fb` | 最终 Tag 与 Release 工作流复验 |
| 身份迁移 | 97/97 `migrated`；迁移 20/20、身份 13/13、启动 5/5，合计 38/38 | 最终 Tag 与 CI `upgrade-real` 链接 |
| 正式资产 | CI 已构建双平台资产并通过安装/恢复/秘密扫描；既有本机旧 EXE 非最终资产 | 最终下载 SHA256、GitHub digest 与 Latest |
| 真实平台 | 未验证 | 实号与恶意重定向结果或明确未覆盖 |
| Windows 自启 | 环境受限，注册表自启未计通过 | 可写主机结果或明确未覆盖 |
| Debian systemd | 未验证 | 真实 init 结果或明确未覆盖 |
| 风险接受 | 未签字 | 产品负责人对 R-01–R-18 的接受/缓解决定 |

**当前审计结论：B1–B4 与 Soak/持久化阻断已修复并通过最终架构复审；v0.2.2 CI 全 job 已通过，最终冻结候选的连续 24h Soak 正在运行，双平台资产下载复验与 Latest 尚未完成，当前仍为 NO-GO，不能授权正式发布。**
