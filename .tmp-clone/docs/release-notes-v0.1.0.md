# AI Debate v0.1.0

第一个独立版本。从 DSH 插件（dsh-ai-debate v0.3.0）迁移而来，**不再需要 DSH**，也不再需要用户自己安装 Node.js。

## 下载

| 平台 | 文件 | 用法 |
|------|------|------|
| Windows x64 | `AI-Debate-windows-x64.exe` | 双击运行，浏览器自动打开 `http://127.0.0.1:17860/` |
| Linux x64 (Ubuntu/Debian) | `ai-debate-linux-x64.tgz` | 解压后 `sudo ./install.sh`，安装为 systemd 服务 |

同一 Release 附带 `SHA256SUMS.txt`。下载后请先校验：

```bash
sha256sum -c SHA256SUMS.txt        # Linux
certutil -hashfile AI-Debate-windows-x64.exe SHA256   # Windows
```

## 这个版本包含什么

- **完整的辩论工作流**：讨论导入与解析、评论链与目标识别、立场分析与争议归纳、人格与论证策略、候选生成/编辑/重新评估、安全检查、人工批准与复制。
- **11 个配置页签**：账号、模型、人格、发表策略、审批、平台、能力验证、发表工作台、离线导入、安全、运行状态。顺序、字段与交互与原插件一致。
- **独立运行**：自带 HTTP 服务、配置存储、加密凭据存储、管理员认证、后台任务队列、日志与备份。
- **后台常驻**：关闭浏览器不影响服务；进程重启后会话、候选、审批、台账与队列从磁盘恢复。
- **双平台一致体验**：Windows EXE 与 Linux 服务跑的是同一套代码与服务端。

## 安全相关的默认值

- 默认只监听 `127.0.0.1`，管理接口默认不对外。
- 首次打开必须创建管理员账号（至少 10 位密码）。
- API Key 与平台 Cookie 使用 AES-256-GCM 加密落盘，不回显、不进日志、不进备份。
- 真实发表必须人工批准，且**不进后台队列、不自动重试**。
- 登录失败限流、会话 `HttpOnly + SameSite=Strict`、同源校验。
- 未验证的平台能力保持不可用，界面上不会出现可点的发表按钮。

## 升级与数据

- 从 v0.1.0 起的数据在 `%LOCALAPPDATA%\ai-debate`（Windows）或 `/var/lib/ai-debate`（Linux）。
- 升级只替换程序，不删除数据，不覆盖已有 `ai-debate.env`。
- 旧 DSH 插件的数据默认不读、不改、不删；导入需要在页面里主动触发。

## 已知限制

见 `docs/known-issues.md`。要点：ARM64 未构建、无内置 TLS、无代码签名、无多用户。

## 许可证

AGPL-3.0-only。来源说明见 `NOTICE`。
