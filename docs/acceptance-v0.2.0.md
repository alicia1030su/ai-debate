# v0.2.0 验收记录

每一行都有对应的命令或 CI 运行记录。没有执行的一律标注「未执行」。

## 一、自动化结果

| 套件 | 数量 | 结果 |
|---|---|---|
| core（原辩论引擎） | 113 | 全过 |
| server（服务端） | 21 | 全过 |
| web（前端渲染） | 7 | 全过 |
| acceptance/standalone（HTTP 全流程） | 25 项 | 全过 |
| acceptance/automation（挂机链路） | 7 | 全过 |
| acceptance/recovery（进程级崩溃恢复） | 8 项 | 全过 |
| linux-install（真实 systemd） | 22 项 | 全过（CI） |

## 二、Windows 真机（本机 Windows 11，打包后的 EXE）

| 项 | 结果 | 证据 |
|---|---|---|
| 双击等价启动（无参数） | 通过 | 输出「正在启动…」「已启动：http://127.0.0.1:17860/」 |
| 无需 Node.js | 通过 | 以 `env -i`（清空 PATH）运行 `AI-Debate-windows-x64.exe serve`，`/healthz` 返回 200 |
| 关闭浏览器后继续运行 | 通过 | 服务为独立进程；浏览器只是客户端 |
| 多次启动不重复实例 | 通过 | 第二个 `serve` 输出「已有实例在运行」并退出码 3 |
| 进程被强杀后自动恢复 | 通过 | `taskkill /PID <pid> /F` 后 6 秒内 `/healthz` 再次 200（新版 uptime 归零） |
| 单文件包含网页资源 | 通过 | 日志 `网页资源：6 个（sea）`，`/assets/app.js` 200 且 318 KB |
| 数据重启后保留 | 通过 | acceptance 重启后会话仍在，`state.json` 存在 |
| 升级不覆盖数据 | 结构保证 | 安装/升级只替换 EXE；数据在 `%LOCALAPPDATA%\ai-debate` |
| 后台引擎启动 | 通过 | 日志「后台挂机引擎已启动：并发 1，每平台 1」 |

## 三、Linux 真机（GitHub `ubuntu-22.04` runner，PID 1 = systemd）

| 项 | 结果 |
|---|---|
| TGZ 解压 + SHA256SUMS 校验 | 通过 |
| `install.sh` 安装（systemd 模式，默认路径） | 通过 |
| `systemctl is-active ai-debate` = active | 通过 |
| `systemctl is-enabled` = enabled（开机自启） | 通过 |
| 服务响应 `/healthz` | 通过 |
| 页面工作流（初始化 → 配置 → 模型 → 导入 → 生成 → 批准） | 通过 |
| `systemctl restart` 后会话仍有效、数据仍在 | 通过 |
| `kill -9` 主进程 → systemd 自动拉起 | 通过 |
| 拉起后再次可服务 | 通过 |
| `uninstall.sh`（默认）停止服务并保留数据 | 通过 |
| 重新安装后历史数据仍在 | 通过 |
| 独立低权限用户 `ai-debate` | 由 unit 的 `User=ai-debate` 保证，安装脚本创建系统用户 |

CI 运行：见 `ci.yml` 的 `Package Linux archive` 任务，日志含 `22/22 项通过`。

**未执行**：Ubuntu 24.04、Debian 12 的独立虚拟机验证；ARM64 验证。

## 四、后台监控链路（脚本化平台）

`test/acceptance/automation.ts`，7 个用例：

| 用例 | 断言 |
|---|---|
| 基线 → 发现 → 分析 → 生成 → 待审核 | 首次只记录既有发言不分析；新回复产生 1 个 `needs_review` 任务与 1 个候选；重复轮询不再分析；同回复不能第二次生成 |
| 429 退避 | 进入 `retry_wait`，`nextRunAt` 延迟接近平台给的 `Retry-After`，`lastErrorKind='rate_limited'` |
| 401 暂停 | 监控 `enabled=false` 且写入 `blockedReason`，任务 `blocked`，不无限重试 |
| 崩溃恢复 | 磁盘上 `running` 被改回 `pending`，`lastErrorKind='interrupted'`；恢复后候选仍为 1 个 |
| 并发上限 | 同一目标的第二次入队被去重，只剩一个探测任务 |
| 失败分类 | auth/rate/network/permanent/owner_unbound 各自分类正确 |
| 自身发言过滤 | 主人的三种身份字段任一同名即跳过 |

**这是脚本化平台，不是真实贴吧/微博。** 平台适配器是 `FakeAdapter`，读取、分页、嵌套回复都按真实契约实现，但没有经过真实网络。

## 五、崩溃恢复（真实进程）

`test/acceptance/recovery.ts`：

1. 预埋两条 `running` 任务（一条指向已删除的监控，一条指向存在的监控）。
2. 启动打包后的真实服务。
3. 断言：两条都不再是 `running`；`lastErrorKind='interrupted'` 或「监控目标已删除」；重启后磁盘上没有遗留 `running`。

8 项全过。

## 六、安全

| 项 | 证据 |
|---|---|
| 未登录不能管理监控 | `monitor-api.test.ts`：status/monitors/tasks/create/pause 全部 401 |
| 跨站写入被拒 | 同测试：`Origin: http://evil.example` → 403 |
| SSRF 入口拦截 | `http://127.0.0.1:8080/admin`、`file:///etc/passwd`、未知域名、非 URL 全部 400，且不落库 |
| 后台不能发表 | `/automation/publish`、`/automation/approve` 返回 404（测试钉住） |
| 凭据不出现在日志 | `runtime.test.ts` 的脱敏用例；新增代码只记 post id / 错误文本 |
| 凭据不回显 | 未新增任何读取路径；仍走 `describe()` 布尔值 |
| 审批仍需人工 | 候选终态 `needs_review`；发表路径未改动 |
| 审计 | `monitor.created/updated/removed/toggled`、`automation.paused/resumed` |

## 七、无 DSH 依赖

- `scripts/assert-no-dsh.mjs`：114 个源文件、4 个清单、94 个线路文件，0 命中。
- 打包 EXE 在 `env -i` 下运行，只写数据目录。
- 运行期无 `dsh` 进程（`tasklist` 查询为空）。

## 八、真实平台能力（未验证）

| 平台 | 实际读取 | 实际发表 |
|---|---|---|
| 百度贴吧 | 未在本轮验证（需要有效 Cookie 与真实帖子） | 未验证 |
| 微博 | 未验证（依赖外部 CLI） | 未验证 |

界面上这些能力保持 `unverified` / `unavailable`，不会显示成可用。
