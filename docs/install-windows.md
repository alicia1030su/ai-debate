# Windows 安装与使用

## 1. 运行条件

- Windows 10 1809+ / Windows 11，x64。
- 不需要安装 Node.js、DSH、Docker、Python 或任何运行库。
- 不需要管理员权限。程序只写当前用户的数据目录。

## 2. 首次运行

1. 双击 `AI-Debate-windows-x64.exe`。
2. 程序检查本机是否已有实例：
   - 没有：以独立进程启动 HTTP 服务，然后打开默认浏览器。
   - 已有：只打开浏览器，不重复启动。
3. 浏览器进入 `http://127.0.0.1:17860/`。
4. 第一次打开会要求**创建管理员账号**（用户名 + 至少 10 位密码）。这个账号只保存在本机。
5. 在「AI 模型」页填写 OpenAI 兼容接口的 Base URL、模型名，并在凭据栏保存 API Key。
6. 点「测试连接」，成功后即可使用。

关掉浏览器不会停止服务：它是独立后台进程，重新打开页面状态还在。

服务由 `supervise` 守护：异常退出会按 1 秒 → 30 秒退避自动重启，`--stop` 是干净退出，守护不会再拉起。

## 3. 自动挂机

1. 顶栏点「自动挂机」。
2. 粘贴要监控的帖子链接，设轮询间隔（最低 120 秒），点「添加监控」。
3. 第一次检查只建立基线（不会去分析历史楼层）。
4. 之后有新人发言时，后台自动分析并生成候选，出现在「待人工审核」。
5. 候选仍需到「审批」页确认后才能手动发表。

暂停全局或单个目标都在这一页；日志与队列状态看「系统」页。

## 4. 命令行

同一个 EXE 支持子命令（在 PowerShell 或资源管理器地址栏执行）：

```powershell
.\AI-Debate-windows-x64.exe --status      # 是否在运行、端口、PID、数据目录
.\AI-Debate-windows-x64.exe --stop         # 停止后台服务
.\AI-Debate-windows-x64.exe --restart      # 重启后台服务
.\AI-Debate-windows-x64.exe --logs         # 打印最近 200 行日志
.\AI-Debate-windows-x64.exe --open         # 只打开浏览器
.\AI-Debate-windows-x64.exe --port 18080   # 换端口启动（之后固定使用该端口）
.\AI-Debate-windows-x64.exe --version
```

开机自启默认**关闭**。需要时在「系统」页勾选，或执行：

```powershell
.\AI-Debate-windows-x64.exe --autostart on
.\AI-Debate-windows-x64.exe --autostart off
```

它只写当前用户的 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，不碰系统级启动项，不需要管理员权限。

## 5. 数据目录

默认 `%LOCALAPPDATA%\ai-debate\`：

| 文件 | 内容 |
|------|------|
| `config.json` | 配置（不含明文密钥） |
| `state.json` | 会话、候选、发表台账、审批记录 |
| `credentials.json` / `credentials.key` | 加密后的 Cookie 与 API Key |
| `admin.json` | 管理员口令哈希（scrypt） |
| `sessions.json` | 登录会话（只存哈希） |
| `jobs.json` | 维护任务队列（备份/轮转等） |
| `monitors.json` | 监控目标与游标 |
| `auto-tasks.json` | 后台挂机任务台账 |
| `backups/` | 手动与自动备份 |
| `logs/server.log` | 运行日志（已脱敏） |

用 `AI_DEBATE_HOME` 环境变量或 `--data-dir` 可以换位置。

## 6. 升级

用新版本 EXE 覆盖旧文件即可。数据目录不动，配置与会话保留。旧版本不会被自动删除。

## 7. 卸载

1. 先 `--stop`（或关闭开机自启）。
2. 删除 EXE。
3. 需要清空数据时再手动删除 `%LOCALAPPDATA%\ai-debate\`。

卸载程序本身不会删除数据目录。

## 8. 常见问题

**双击后浏览器没打开**：手动访问 `http://127.0.0.1:17860/`。若打不开，执行 `--status` 看是否启动失败，再 `--logs` 看原因。

**端口被占用**：`--port 18080` 换一个端口。程序会把端口记在数据目录里。

**忘记密码**：停止服务，删除 `admin.json`，重启后重新初始化。会话与配置不受影响（`state.json` 不动）。

**杀毒软件报警**：EXE 由 Node SEA 打包，是未签名的自解压式单文件程序，可能被启发式规则误报。可核对发布页上的 SHA256 后再决定是否放行。
