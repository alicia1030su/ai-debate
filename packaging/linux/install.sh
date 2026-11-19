#!/usr/bin/env bash
#
# AI Debate — Linux installer.
#
# Installs a standalone systemd service. It does not require Node.js, DSH, Docker
# or Python, and it never deletes user data: an upgrade replaces the binary and the
# unit file only. Uninstalling keeps /var/lib/ai-debate unless --purge is passed.
#
#   sudo ./install.sh                     # 127.0.0.1:17860
#   sudo ./install.sh --host 0.0.0.0 --port 18080
#   sudo ./install.sh --no-start
#
set -euo pipefail

APP_NAME="ai-debate"
APP_USER="ai-debate"
PREFIX="/opt/ai-debate"
DATA_DIR="/var/lib/ai-debate"
CONF_DIR="/etc/ai-debate"
UNIT="/etc/systemd/system/${APP_NAME}.service"
HOST="127.0.0.1"
PORT="17860"
START=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --host <addr>     listen address (default 127.0.0.1; 0.0.0.0 exposes the console
                    to the network — administrator login is still required, but read
                    docs/security.md first)
  --port <port>     listen port (default 17860)
  --data-dir <dir>  state directory (default /var/lib/ai-debate)
  --prefix <dir>    install prefix (default /opt/ai-debate)
  --no-start        install but do not enable/start the service
  -h, --help        this text
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:?}"; shift 2 ;;
    --prefix) PREFIX="${2:?}"; shift 2 ;;
    --no-start) START=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 运行：sudo ./install.sh" >&2
  exit 1
fi

if [[ ! -x "${SCRIPT_DIR}/bin/ai-debate" ]]; then
  echo "安装包不完整：找不到 bin/ai-debate" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "这个安装脚本依赖 systemd。没有 systemd 的环境可以手动运行：bin/ai-debate serve" >&2
  exit 1
fi

echo "== 检查安装包 =="
if [[ -f "${SCRIPT_DIR}/SHA256SUMS" ]]; then
  ( cd "${SCRIPT_DIR}" && sha256sum -c SHA256SUMS --quiet ) || {
    echo "SHA256 校验失败，安装包可能已损坏或被篡改。" >&2
    exit 1
  }
  echo "校验通过"
fi

echo "== 创建系统用户与目录 =="
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${DATA_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
fi
install -d -m 0755 "${PREFIX}" "${PREFIX}/bin"
install -d -m 0750 -o "${APP_USER}" -g "${APP_USER}" "${DATA_DIR}"
install -d -m 0750 -o "${APP_USER}" -g "${APP_USER}" "${CONF_DIR}"

echo "== 停止旧服务（如果存在）=="
if systemctl is-active --quiet "${APP_NAME}" 2>/dev/null; then
  systemctl stop "${APP_NAME}"
fi

echo "== 安装程序 =="
install -m 0755 "${SCRIPT_DIR}/bin/ai-debate" "${PREFIX}/bin/ai-debate"

if [[ -f "${CONF_DIR}/ai-debate.env" ]]; then
  echo "== 保留已有配置 ${CONF_DIR}/ai-debate.env =="
else
  cat > "${CONF_DIR}/ai-debate.env" <<EOF
# AI Debate service configuration. Edited by the administrator; read at start-up.
AI_DEBATE_HOST=${HOST}
AI_DEBATE_PORT=${PORT}
AI_DEBATE_HOME=${DATA_DIR}
AI_DEBATE_LOG_LEVEL=info
EOF
  chmod 0640 "${CONF_DIR}/ai-debate.env"
  chown "${APP_USER}:${APP_USER}" "${CONF_DIR}/ai-debate.env"
fi

echo "== 安装 systemd 单元 =="
install -m 0644 "${SCRIPT_DIR}/systemd/ai-debate.service" "${UNIT}"
sed -i "s|@PREFIX@|${PREFIX}|g; s|@DATA_DIR@|${DATA_DIR}|g; s|@CONF_DIR@|${CONF_DIR}|g; s|@APP_USER@|${APP_USER}|g" "${UNIT}"

systemctl daemon-reload

if [[ "${START}" -eq 1 ]]; then
  echo "== 启动服务 =="
  systemctl enable --now "${APP_NAME}"
  sleep 2
  systemctl --no-pager --full status "${APP_NAME}" || true
fi

cat <<EOF

安装完成。

  管理页面   http://${HOST}:${PORT}/
  首次打开   设置管理员账号（至少 10 位密码）
  服务状态   systemctl status ${APP_NAME}
  查看日志   journalctl -u ${APP_NAME} -f   或   ${PREFIX}/bin/ai-debate logs
  停止服务   systemctl stop ${APP_NAME}
  启动服务   systemctl start ${APP_NAME}
  重启服务   systemctl restart ${APP_NAME}
  数据目录   ${DATA_DIR}   （升级与卸载都不会删除）
  配置文件   ${CONF_DIR}/ai-debate.env

远程访问：默认只监听 127.0.0.1。若确需远程，改 AI_DEBATE_HOST 后重启，
并先阅读 docs/security.md —— 管理接口没有任何「仅内网所以放行」的例外。
EOF
