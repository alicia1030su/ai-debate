#!/usr/bin/env bash
#
# AI Debate — Linux installer.
#
# Installs a standalone systemd service. It does not require Node.js, DSH, Docker
# or Python. Upgrades replace the binary and unit only; uninstalling keeps data and
# configuration unless an explicit, confirmed --purge is requested.
#
#   sudo ./install.sh
#   sudo ./install.sh --host 0.0.0.0 --port 18080
#   sudo ./install.sh --no-start
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

PREFIX="$DEFAULT_PREFIX"
DATA_DIR="$DEFAULT_DATA_DIR"
CONF_DIR="$DEFAULT_CONF_DIR"
UNIT="/etc/systemd/system/${APP_NAME}.service"
LOGROTATE="/etc/logrotate.d/${APP_NAME}"
HOST="127.0.0.1"
PORT="17860"
START=1
PREFIX_SET=0
DATA_SET=0
CONF_SET=0
TEMP_FILES=()

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --host <addr>     listen address (default 127.0.0.1; 0.0.0.0 exposes the console
                    to the network — administrator login is still required, but read
                    docs/security.md first)
  --port <port>     listen port (default 17860)
  --prefix <dir>    install prefix (default /opt/ai-debate)
  --data-dir <dir>  state directory (default /var/lib/ai-debate)
  --conf-dir <dir>  configuration directory (default /etc/ai-debate)
  --no-start        install but do not enable/start the service
  -h, --help        this text

Production paths are restricted to application-owned locations:
  prefix:   /opt/ai-debate or /usr/local/ai-debate (custom descendants must end in ai-debate)
  data-dir: /var/lib/ai-debate or /srv/ai-debate (descendants allowed)
  conf-dir: /etc/ai-debate (descendants allowed)
The three canonical paths may not be equal or nested. Symlinks that escape these
locations, whitespace, control characters and systemd metacharacters are rejected.

Acceptance tests may set AI_DEBATE_INSTALL_TEST=1 and
AI_DEBATE_INSTALL_TEST_ROOT=<root-owned 0700 mktemp directory>. This explicitly
opts into scratch paths and is never inferred from the current directory.
EOF
}

require_option_value() {
  if [[ $# -lt 2 || -z "$2" ]]; then
    echo "选项 $1 缺少参数。" >&2
    usage >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) require_option_value "$@"; HOST="$2"; shift 2 ;;
    --port) require_option_value "$@"; PORT="$2"; shift 2 ;;
    --data-dir) require_option_value "$@"; DATA_DIR="$2"; DATA_SET=1; shift 2 ;;
    --prefix) require_option_value "$@"; PREFIX="$2"; PREFIX_SET=1; shift 2 ;;
    --conf-dir) require_option_value "$@"; CONF_DIR="$2"; CONF_SET=1; shift 2 ;;
    --no-start) START=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 运行：sudo ./install.sh" >&2
  exit 1
fi

cleanup_temp_files() {
  local file
  for file in "${TEMP_FILES[@]}"; do
    rm -f -- "$file"
  done
}
trap cleanup_temp_files EXIT

# An upgrade without repeated path flags must keep the paths recorded by the
# installed unit. Values are parsed, never sourced, because the unit is writable
# only by root but must still not become a shell execution vector.
if [[ -f "$UNIT" ]]; then
  EXISTING_EXEC="$(read_unit_value "$UNIT" ExecStart "ExecStart")" || exit $?
  if [[ "$EXISTING_EXEC" != */bin/ai-debate\ serve ]]; then
    echo "已安装 unit 的 ExecStart 不是 AI Debate：$EXISTING_EXEC" >&2
    exit 2
  fi
  if [[ "$PREFIX_SET" -eq 0 ]]; then
    PREFIX="${EXISTING_EXEC%/bin/ai-debate serve}"
  fi
  if [[ "$CONF_SET" -eq 0 ]]; then
    UNIT_CONF_FILE="$(read_unit_value "$UNIT" EnvironmentFile "EnvironmentFile")" || exit $?
    if [[ "$UNIT_CONF_FILE" != */ai-debate.env ]]; then
      echo "已安装 unit 的 EnvironmentFile 不是 ai-debate.env：$UNIT_CONF_FILE" >&2
      exit 2
    fi
    CONF_DIR="${UNIT_CONF_FILE%/ai-debate.env}"
  fi
  if [[ "$DATA_SET" -eq 0 ]]; then
    if UNIT_HOME="$(read_unit_value "$UNIT" Environment=AI_DEBATE_HOME "AI_DEBATE_HOME" 0)"; then
      DATA_DIR="$UNIT_HOME"
    else
      READ_STATUS=$?
      if [[ "$READ_STATUS" -eq 2 ]]; then
        exit 2
      fi
      if UNIT_WORKDIR="$(read_unit_value "$UNIT" WorkingDirectory "WorkingDirectory" 0)"; then
        DATA_DIR="$UNIT_WORKDIR"
      else
        READ_STATUS=$?
        if [[ "$READ_STATUS" -eq 2 ]]; then
          exit 2
        fi
        echo "已安装 unit 缺少唯一的 AI_DEBATE_HOME 或 WorkingDirectory。" >&2
        exit 2
      fi
    fi
  fi
fi

if [[ "$DATA_SET" -eq 0 && -f "${CONF_DIR}/ai-debate.env" ]]; then
  if [[ -L "${CONF_DIR}/ai-debate.env" ]]; then
    echo "拒绝读取符号链接配置文件：${CONF_DIR}/ai-debate.env" >&2
    exit 2
  fi
  if EXISTING_HOME="$(read_env_value "${CONF_DIR}/ai-debate.env" AI_DEBATE_HOME "AI_DEBATE_HOME")"; then
    if [[ "$DATA_SET" -eq 0 ]]; then
      DATA_DIR="$EXISTING_HOME"
    fi
  else
    READ_STATUS=$?
    if [[ "$READ_STATUS" -ne 1 ]]; then
      exit "$READ_STATUS"
    fi
  fi
fi

validate_deployment_paths "$PREFIX" "$DATA_DIR" "$CONF_DIR" || exit $?
if [[ -n "${AI_DEBATE_INSTALL_TEST_ROOT:-}" ]]; then
  echo "提示：启用显式测试路径模式，根目录 ${AI_DEBATE_INSTALL_TEST_ROOT}；不得用于生产安装。" >&2
fi

if [[ -f "${CONF_DIR}/ai-debate.env" ]]; then
  if [[ -L "${CONF_DIR}/ai-debate.env" || ! -f "${CONF_DIR}/ai-debate.env" ]]; then
    echo "配置文件必须是普通文件：${CONF_DIR}/ai-debate.env" >&2
    exit 2
  fi
  if EXISTING_HOME="$(read_env_value "${CONF_DIR}/ai-debate.env" AI_DEBATE_HOME "AI_DEBATE_HOME")"; then
    EXISTING_HOME_CANONICAL="$(canonical_deployment_path "已有配置的数据目录" "$EXISTING_HOME")" || exit $?
    if [[ "$EXISTING_HOME_CANONICAL" != "$DATA_DIR" ]]; then
      echo "已有 env 的数据目录 ${EXISTING_HOME_CANONICAL} 与本次安装的 ${DATA_DIR} 不同；为避免数据分裂，已中止。" >&2
      echo "升级时请省略 --data-dir，或先由管理员显式迁移配置。" >&2
      exit 2
    fi
  else
    READ_STATUS=$?
    if [[ "$READ_STATUS" -ne 1 ]]; then
      exit "$READ_STATUS"
    fi
  fi
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "端口必须是 1–65535 的整数：$PORT" >&2
  exit 2
fi
if [[ ! "$HOST" =~ ^[A-Za-z0-9._:/-]+$ ]]; then
  echo "监听地址含非法字符：$HOST" >&2
  exit 2
fi

if [[ ! -x "${SCRIPT_DIR}/bin/ai-debate" || ! -f "${SCRIPT_DIR}/systemd/ai-debate.service" || ! -f "${SCRIPT_DIR}/logrotate/ai-debate" ]]; then
  echo "安装包不完整：找不到 bin/ai-debate、systemd/ai-debate.service 或 logrotate/ai-debate" >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  HAS_SYSTEMD=1
else
  HAS_SYSTEMD=0
  echo "提示：这个环境没有运行中的 systemd。程序、配置与 unit 会安装，但不会自动开机自启。"
fi

echo "== 检查磁盘空间 =="
# 200 MB covers the binary (~90 MB) plus a season of logs and the first backups.
DISK_PROBE="$PREFIX"
while [[ ! -e "$DISK_PROBE" ]]; do
  DISK_PROBE="$(dirname -- "$DISK_PROBE")"
done
if ! AVAIL_KB=$(df -Pk -- "$DISK_PROBE" 2>/dev/null | awk 'NR==2 {print $4}') || [[ ! "$AVAIL_KB" =~ ^[0-9]+$ ]]; then
  echo "无法确认 ${DISK_PROBE} 的磁盘余量，安装已中止。" >&2
  exit 1
fi
if (( AVAIL_KB < 204800 )); then
  echo "磁盘剩余不足 200 MB（${AVAIL_KB} KB），安装已中止，未写入任何文件。" >&2
  exit 1
fi
echo "磁盘空间充足（${AVAIL_KB} KB 可用）"

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
install -d -m 0755 -o root -g root "${PREFIX}" "${PREFIX}/bin"
install -d -m 0750 -o "${APP_USER}" -g "${APP_USER}" "${DATA_DIR}"
install -d -m 0755 -o root -g root "${CONF_DIR}"
install -d -m 0755 -o root -g root /etc/systemd/system

# Re-resolve after mkdir/chown: a path that changed while it was being created is
# not allowed to redirect the remaining privileged operations.
validate_deployment_paths "$PREFIX" "$DATA_DIR" "$CONF_DIR" || exit $?

echo "== 安装程序 =="
install -m 0755 -o root -g root "${SCRIPT_DIR}/bin/ai-debate" "${PREFIX}/bin/ai-debate"
for document in README.md LICENSE NOTICE; do
  if [[ -f "${SCRIPT_DIR}/${document}" ]]; then
    install -m 0644 -o root -g root "${SCRIPT_DIR}/${document}" "${PREFIX}/${document}"
  fi
done

if [[ -f "${CONF_DIR}/ai-debate.env" ]]; then
  echo "== 保留已有配置 ${CONF_DIR}/ai-debate.env =="
  chown root:"${APP_USER}" "${CONF_DIR}/ai-debate.env"
  chmod 0640 "${CONF_DIR}/ai-debate.env"
else
  ENV_TEMP="$(mktemp "${CONF_DIR}/.ai-debate.env.XXXXXX")"
  TEMP_FILES+=("$ENV_TEMP")
  cat > "$ENV_TEMP" <<EOF
# AI Debate service configuration. Edited by the administrator; read at start-up.
AI_DEBATE_HOST=${HOST}
AI_DEBATE_PORT=${PORT}
AI_DEBATE_HOME=${DATA_DIR}
AI_DEBATE_LOG_LEVEL=info
EOF
  chown root:"${APP_USER}" "$ENV_TEMP"
  chmod 0640 "$ENV_TEMP"
  mv -f -- "$ENV_TEMP" "${CONF_DIR}/ai-debate.env"
fi

UNIT_TEMP="$(mktemp --suffix=.service /etc/systemd/system/ai-debate.XXXXXX)"
TEMP_FILES+=("$UNIT_TEMP")
render_template "${SCRIPT_DIR}/systemd/ai-debate.service" "$UNIT_TEMP"
if command -v systemd-analyze >/dev/null 2>&1; then
  echo "== 校验 systemd 单元 =="
  if ! systemd-analyze verify "$UNIT_TEMP"; then
    echo "systemd 单元校验失败，未替换已有 unit。" >&2
    exit 1
  fi
fi

if command -v logrotate >/dev/null 2>&1 && [[ -d /etc/logrotate.d ]]; then
  echo "== 安装日志轮转配置 =="
  LOGROTATE_TEMP="$(mktemp /etc/logrotate.d/.ai-debate.XXXXXX)"
  TEMP_FILES+=("$LOGROTATE_TEMP")
  render_template "${SCRIPT_DIR}/logrotate/ai-debate" "$LOGROTATE_TEMP"
  chown root:"${APP_USER}" "$LOGROTATE_TEMP"
  chmod 0640 "$LOGROTATE_TEMP"
  mv -f -- "$LOGROTATE_TEMP" "$LOGROTATE"
  # The service appends by path on every write and has no HUP/USR1 reopen handler;
  # copytruncate is therefore intentional. Active logs must remain service-writable.
  shopt -s nullglob
  for log_file in "${DATA_DIR}"/logs/*.log "${DATA_DIR}"/logs/*.jsonl "${DATA_DIR}/egress.jsonl"; do
    if [[ -f "$log_file" && ! -L "$log_file" ]]; then
      chown "${APP_USER}:${APP_USER}" "$log_file"
      chmod 0640 "$log_file"
    fi
  done
  shopt -u nullglob
fi

echo "== 停止旧服务（如果存在） =="
if [[ "$HAS_SYSTEMD" -eq 1 ]] && systemctl is-active --quiet "${APP_NAME}" 2>/dev/null; then
  systemctl stop "${APP_NAME}"
fi

echo "== 安装 systemd 单元 =="
chown root:root "$UNIT_TEMP"
chmod 0644 "$UNIT_TEMP"
mv -f -- "$UNIT_TEMP" "$UNIT"
if [[ "$HAS_SYSTEMD" -eq 1 ]]; then
  systemctl daemon-reload
  if [[ "$START" -eq 1 ]]; then
    echo "== 启动服务 =="
    systemctl enable --now "${APP_NAME}"
    sleep 2
    systemctl --no-pager --full status "${APP_NAME}" || true
  fi
else
  echo "== 没有 systemd：跳过启用与启动 =="
  echo "   安装位置：${PREFIX}/bin/ai-debate"
  echo "   手动启动：AI_DEBATE_HOME=${DATA_DIR} ${PREFIX}/bin/ai-debate serve"
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
  数据目录   ${DATA_DIR}   （升级与未确认的卸载都不会删除）
  配置文件   ${CONF_DIR}/ai-debate.env

远程访问：默认只监听 127.0.0.1。若确需远程，改 AI_DEBATE_HOST 后重启，
并先阅读 docs/security.md —— 管理接口没有任何「仅内网所以放行」的例外。
EOF
