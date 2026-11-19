# Linux 安装与使用

适用于 Ubuntu 22.04/24.04、Debian 12 的 x86-64。ARM64 是后续目标，v0.1.0 未提供。

## 1. 解压与安装

```bash
tar -xzf ai-debate-linux-x64.tgz
cd ai-debate-linux-x64
sha256sum -c SHA256SUMS
sudo ./install.sh
```

安装脚本会：

1. 校验包内文件的 SHA256；
2. 创建系统用户 `ai-debate`（不可登录）；
3. 安装程序到 `/opt/ai-debate/bin/ai-debate`；
4. 创建数据目录 `/var/lib/ai-debate` 与配置目录 `/etc/ai-debate`；
5. 写入 `/etc/systemd/system/ai-debate.service`；
6. `systemctl enable --now ai-debate`。

不需要安装 Node.js、DSH、Docker 或 Python。

## 2. 可选参数

```bash
sudo ./install.sh --port 18080              # 换端口
sudo ./install.sh --host 0.0.0.0            # 允许远程（先读 docs/security.md）
sudo ./install.sh --data-dir /srv/ai-debate # 换数据目录
sudo ./install.sh --no-start                # 只安装不启动
```

默认监听 `127.0.0.1:17860`。

## 3. 首次配置

1. 在服务器本机打开 `http://127.0.0.1:17860/`（或通过 SSH 端口转发：`ssh -L 17860:127.0.0.1:17860 user@host`）。
2. 创建管理员账号（至少 10 位密码）。
3. 在「AI 模型」页填写 OpenAI 兼容接口，保存 API Key，点「测试连接」。

如果服务器没有图形界面，端口转发是最安全的首次配置方式；不要在配置完成前就把端口暴露到公网。

## 4. 服务管理

```bash
systemctl status ai-debate
sudo systemctl stop ai-debate
sudo systemctl start ai-debate
sudo systemctl restart ai-debate
journalctl -u ai-debate -f
/opt/ai-debate/bin/ai-debate logs --lines 200
/opt/ai-debate/bin/ai-debate status
```

`Restart=always` + `RestartSec=3`：进程异常退出会被 systemd 拉起；重启服务器后服务自动恢复，`state.json` 与队列从磁盘继续。

## 5. 目录与文件

| 路径 | 内容 |
|------|------|
| `/opt/ai-debate/bin/ai-debate` | 单文件程序（内含 Node 运行时与网页资源） |
| `/var/lib/ai-debate/` | 数据：配置、台账、凭据、日志、备份 |
| `/etc/ai-debate/ai-debate.env` | 监听地址、端口、数据目录 |
| `/etc/systemd/system/ai-debate.service` | systemd 单元 |

`/etc/ai-debate/ai-debate.env`：

```
AI_DEBATE_HOST=127.0.0.1
AI_DEBATE_PORT=17860
AI_DEBATE_HOME=/var/lib/ai-debate
AI_DEBATE_LOG_LEVEL=info
```

改完 `sudo systemctl restart ai-debate`。

## 6. 升级

```bash
tar -xzf ai-debate-linux-x64-new.tgz
cd ai-debate-linux-x64-new
sudo ./install.sh          # 覆盖二进制与 unit，保留数据与已有 env
```

安装脚本检测到已有 `/etc/ai-debate/ai-debate.env` 时不会覆盖它，所以升级不会重置监听地址。

## 7. 卸载

```bash
cd ai-debate-linux-x64
sudo ./uninstall.sh            # 删除程序，保留 /var/lib/ai-debate 与 /etc/ai-debate
sudo ./uninstall.sh --purge    # 连同数据与配置一起删除
```

## 8. 备份与恢复

- 页面「系统」页可以创建/恢复备份，备份内容是 `config.json` + `state.json` + `jobs.json`（**不含**凭据与口令哈希）。
- 也可以直接复制 `/var/lib/ai-debate/` 做冷备；恢复时停服务、覆盖、启动。
- 恢复前程序会先把当前文件写成 `*.pre-restore.*`，不会直接覆盖。

## 9. 常见问题

**访问 502/连接被拒绝**：`systemctl status ai-debate`；看 `journalctl -u ai-debate -n 100`。

**端口被占用**：改 env 里的 `AI_DEBATE_PORT` 后重启。

**SELinux/AppArmor 拦截**：unit 已限制可写路径为数据目录与配置目录；如自定义了数据目录，同步修改 unit 的 `ReadWritePaths`。

**看不到中文字体**：页面使用系统字体栈，缺少中文字体时安装 `fonts-noto-cjk`。
