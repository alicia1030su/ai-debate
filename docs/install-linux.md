# Linux 安装与使用

适用于 Ubuntu 22.04/24.04、Debian 12 的 x86-64。当前发布包只提供 x86-64，ARM64 尚未提供。

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
5. 按实际路径渲染并校验 `/etc/systemd/system/ai-debate.service`；
6. 有运行中的 systemd 时执行 `systemctl enable --now ai-debate`；容器中没有 systemd 时仍安装 unit、配置和程序，但不启用服务；
7. 记录 root 所有的安装路径元数据，普通卸载后仍可据此定位自定义目录并执行确认后的 purge。

不需要安装 Node.js、DSH、Docker 或 Python。

## 2. 可选参数与路径策略

```bash
sudo ./install.sh --port 18080              # 换端口
sudo ./install.sh --host 0.0.0.0            # 监听所有网卡（还要在 env 里写 AI_DEBATE_TRUSTED_HOSTS，见 §5）
sudo ./install.sh --data-dir /srv/ai-debate # 换数据目录
sudo ./install.sh --conf-dir /etc/ai-debate/site-a
sudo ./install.sh --prefix /usr/local/ai-debate
sudo ./install.sh --no-start                # 只安装不启动
```

默认监听 `127.0.0.1:17860`。

改成 `0.0.0.0` 只是「监听所有网卡」，并**不会**自动信任某个域名或 IP：请求的 `Host` 必须出现在 `AI_DEBATE_TRUSTED_HOSTS` 里，否则配置接口返回 403。这是故意的——一个「谁声称自己是谁就信谁」的校验等于没有校验。

### 2.1 生产路径白名单

| 目录 | 允许位置 | 自定义规则 |
|------|----------|------------|
| `prefix` | `/opt/ai-debate` 或 `/usr/local/ai-debate` | 可在上述应用根目录下创建实例子目录，但最终目录必须以 `/ai-debate` 结尾，例如 `/opt/ai-debate/site-a/ai-debate` |
| `data-dir` | `/var/lib/ai-debate` 或 `/srv/ai-debate` | 允许应用专属子目录，例如 `/srv/ai-debate/site-a` |
| `conf-dir` | `/etc/ai-debate` | 允许应用专属子目录，例如 `/etc/ai-debate/site-a` |

三个路径先解析为规范化真实路径，再检查白名单；它们不能相同或互相嵌套。以下输入会被拒绝：

- 相对路径、系统根及 `/opt`、`/usr/local`、`/var/lib`、`/srv`、`/etc` 等系统共享目录；
- 通过符号链接逃逸到白名单外的路径；
- 换行、控制字符、空白及 shell/systemd 元字符（仅允许字母、数字和 `. _ / @ : + -`）；
- 已有 `ai-debate.env` 的数据目录与本次安装不一致，以避免配置指向一个目录、unit 写入另一个目录。

安装和卸载都不会递归修改系统共享目录。数据目录为 `ai-debate:ai-debate 0750`；程序和配置目录为 `root:root 0755`；`ai-debate.env` 为 `root:ai-debate 0640`。

### 2.2 验收专用临时路径

CI/一次性验收需要把程序安装到临时目录时，必须显式设置两个变量：

```bash
TEST_ROOT="$(mktemp -d)"
chmod 0700 "$TEST_ROOT"
sudo env AI_DEBATE_INSTALL_TEST=1 AI_DEBATE_INSTALL_TEST_ROOT="$TEST_ROOT" \
  ./install.sh --prefix "$TEST_ROOT/opt" --data-dir "$TEST_ROOT/data" \
  --conf-dir "$TEST_ROOT/conf" --no-start
```

测试根目录必须位于 `/tmp` 或 `/var/tmp` 下、已存在、由 root 拥有且权限为 `0700`，三个安装路径都必须位于其内。该规则只用于验收，不能用于生产；卸载同一测试安装时也要传入相同的测试根目录。

## 3. 首次配置

1. 在服务器本机打开 `http://127.0.0.1:17860/`（或通过 SSH 端口转发：`ssh -L 17860:127.0.0.1 user@host`）。
2. 创建管理员账号（至少 10 位密码）。
3. 在「AI 模型」页填写 OpenAI 兼容接口，保存 API Key，点「测试连接」。

如果服务器没有图形界面，端口转发是最安全的首次配置方式；不要在配置完成前就把端口暴露到公网。

## 3.5 自动挂机

安装完成后，在「自动挂机」页添加要监控的帖子。后台由 systemd 托管，SSH 退出、注销、浏览器关闭都不影响；`kill -9` 会被 `Restart=on-failure` 拉起；服务器重启后自动恢复。

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

`Restart=on-failure` + `RestartSec=3`：异常退出（包括被 `kill -9`）会被 systemd 拉起。应用受控重启时先安全关闭再以退出码 `75` 退出；unit 的 `SuccessExitStatus=75` 避免把这次退出报告为失败，`RestartForceExitStatus=75` 则确保它仍然自动恢复（仅设 `SuccessExitStatus` 会让 `on-failure` 把 75 当作干净退出）。显式 `systemctl stop` 不会被重新拉起。服务器重启后服务自动恢复，`state.json` 与队列从磁盘继续。

`ProtectSystem=strict` 保持启用，`ReadWritePaths` 只包含实际的数据目录。`EnvironmentFile` 由 systemd 以 root 在降权前读取，配置目录不需要写权限。

## 5. 目录与文件

| 路径 | 内容 |
|------|------|
| `/opt/ai-debate/bin/ai-debate` | 单文件程序（内含 Node 运行时与网页资源） |
| `/var/lib/ai-debate/` | 数据：配置、台账、凭据、日志、备份、监控目标（`monitors.json`）与任务台账（`auto-tasks.json`） |
| `/etc/ai-debate/ai-debate.env` | 监听地址、端口、数据目录 |
| `/etc/systemd/system/ai-debate.service` | 按实际路径渲染的 systemd 单元 |
| `/etc/ai-debate/.install-paths` | root 所有的安装路径记录；普通卸载后保留，供后续 `--purge` 找到自定义目录 |
| `/etc/logrotate.d/ai-debate` | 按实际数据目录生成的日志轮转策略（安装 logrotate 时） |

`/etc/ai-debate/ai-debate.env`：

```
AI_DEBATE_HOST=127.0.0.1
AI_DEBATE_PORT=17860
AI_DEBATE_HOME=/var/lib/ai-debate
AI_DEBATE_LOG_LEVEL=info
# 远程/反代时列出浏览器实际访问的域名或 IP，逗号分隔；不填就只信任回环
AI_DEBATE_TRUSTED_HOSTS=debate.example.com
# 后台挂机调参（都有保守默认值，通常不必改）
AI_DEBATE_QUEUE_CAPACITY=1500      # 任务台账上限
AI_DEBATE_TASK_TIMEOUT_MS=600000   # 单个任务超过这个时间判定为卡死
AI_DEBATE_COMPENSATION_MS=21600000 # 每个目标两次补偿扫描之间的间隔（6 小时）
AI_DEBATE_JOB_CONCURRENCY=1        # 维护任务并发，不建议调大
```

改完 `sudo systemctl restart ai-debate`。

## 6. 升级

```bash
tar -xzf ai-debate-linux-x64-new.tgz
cd ai-debate-linux-x64-new
sudo ./install.sh          # 自动从已安装 unit/env 恢复自定义路径
```

安装脚本会从已有 unit 恢复 `PREFIX`、`DATA_DIR`、`CONF_DIR`，因此自定义路径升级时无需重复传参。它会覆盖二进制与 unit，但保留已有 env；如果 env 的数据目录与本次安装不一致则拒绝继续，避免数据分裂。

## 7. 卸载

```bash
cd ai-debate-linux-x64
sudo ./uninstall.sh            # 删除程序、unit、logrotate；保留数据与配置
sudo ./uninstall.sh --purge --confirm-purge  # 永久删除数据与配置
```

卸载脚本从已安装 unit/env 读取真实的 `PREFIX`、`DATA_DIR`、`CONF_DIR`，重新执行生产路径白名单校验，再清理自定义路径对应的 logrotate 配置。普通卸载会保留 root 所有的 `/etc/ai-debate/.install-paths` 路径记录，因此之后仍可直接运行确认后的 purge，无需记住自定义目录；测试安装的对应记录位于测试根目录。`--purge` 必须再带 `--confirm-purge`；在交互终端上也可以只给 `--purge`，然后完整输入显示的 `DELETE <数据目录> <配置目录>`。非交互环境下缺少第二重确认会直接失败，不删除任何内容。

## 8. 备份与恢复

- 页面「系统」页可以创建/恢复备份。备份包含 `config.json`、`state.json`、`jobs.json`、`monitors.json`、`auto-tasks.json`、`reply-identities.json` 和 `credentials.json` **密文**（存在才复制）；不包含 `credentials.key`、`admin.json` 或 `sessions.json`。
- `credentials.json` 虽然是密文，仍应作为敏感文件保管，不要公开分享。同机且密钥指纹匹配时可恢复凭据；跨机器恢复时若没有原 `credentials.key`，恢复会跳过凭据并要求重新填写 API Key 与 Cookie，管理员也需要重新初始化。若目标机器已有不同密钥，程序会拒绝整个恢复，避免写入无法解密的密文。
- 也可以直接复制 `/var/lib/ai-debate/` 做冷备。整目录复制会包含密钥、口令哈希与会话文件，必须按敏感数据保管；恢复时停服务、覆盖、启动。
- 恢复前程序会先把当前文件写成 `*.pre-restore.*`，不会直接覆盖。

## 9. 常见问题

**访问 502/连接被拒绝**：`systemctl status ai-debate`；看 `journalctl -u ai-debate -n 100`。

**端口被占用**：改 env 里的 `AI_DEBATE_PORT` 后重启。

**日志**：`journalctl -u ai-debate` 或数据目录下的 `logs/`。实际轮转文件是 `logs/server.log`、`logs/audit.jsonl` 与 `egress.jsonl`。安装 logrotate 后会按真实数据目录生成 `/etc/logrotate.d/ai-debate`（每周、超过 10 MB、保留 4 份、`copytruncate`）。应用没有 `SIGHUP`/`SIGUSR1` 重开日志处理器，因此采用 `copytruncate`；极小的截断/追加窗口可能丢失日志。策略文件权限为 `0640 root:ai-debate`，活动日志为 `0640 ai-debate:ai-debate`，保证服务可写、root 可管理。程序自己也会按 2 MB 轮转一次运行日志。

**磁盘**：`install.sh` 在安装前检查目标路径最近已存在分区是否有 200 MB 余量；无法读取余量或不足都会中止且不写任何文件。运行期的余量显示在「自动挂机」页的运行状态区。

**SELinux/AppArmor 拦截**：安装脚本已把自定义 `DATA_DIR` 渲染进 unit 的 `ReadWritePaths`，不需要手工改 unit；若系统启用了 SELinux，仍需按发行版文档为自定义数据目录设置正确的文件上下文。

**看不到中文字体**：页面使用系统字体栈，缺少中文字体时安装 `fonts-noto-cjk`。
