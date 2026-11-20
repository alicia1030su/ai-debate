#!/usr/bin/env bash
#
# AI Debate — Linux uninstaller.
#
# Recovers the installed paths from the unit and environment file. It never
# sources those files. Data and configuration are kept unless --purge is followed
# by an explicit second confirmation.
#
#   sudo ./uninstall.sh
#   sudo ./uninstall.sh --purge --confirm-purge
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
PURGE=0
CONFIRM_PURGE=0

usage() {
  cat <<'EOF'
Usage: uninstall.sh [--purge --confirm-purge]

Without --purge, removes the program, unit and logrotate policy but keeps all data
and configuration. --purge requires --confirm-purge as a second, explicit
confirmation; an interactive terminal may instead type the displayed DELETE line.

Installed PREFIX, DATA_DIR and CONF_DIR are read from the existing unit/env. They
are validated against the same production path policy as install.sh before any
recursive deletion. Test installs must pass the same AI_DEBATE_INSTALL_TEST_ROOT.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --confirm-purge) CONFIRM_PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
if [[ "$CONFIRM_PURGE" -eq 1 && "$PURGE" -eq 0 ]]; then
  echo "--confirm-purge 只能与 --purge 一起使用。" >&2
  exit 2
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 运行：sudo ./uninstall.sh" >&2
  exit 1
fi

optional_unit_value() {
  read_unit_value "$1" "$2" "$3" 0
}

UNIT_PREFIX=""
UNIT_DATA=""
UNIT_WORKDIR=""
UNIT_CONF=""
if [[ -f "$UNIT" ]]; then
  EXISTING_EXEC="$(read_unit_value "$UNIT" ExecStart "ExecStart")" || exit $?
  if [[ "$EXISTING_EXEC" != */bin/ai-debate\ serve ]]; then
    echo "已安装 unit 的 ExecStart 不是 AI Debate，拒绝删除：$EXISTING_EXEC" >&2
    exit 2
  fi
  UNIT_PREFIX="${EXISTING_EXEC%/bin/ai-debate serve}"
  UNIT_CONF_RAW="$(read_unit_value "$UNIT" EnvironmentFile "EnvironmentFile")" || exit $?
  if [[ "$UNIT_CONF_RAW" != */ai-debate.env ]]; then
    echo "已安装 unit 的 EnvironmentFile 不是 ai-debate.env，拒绝删除：$UNIT_CONF_RAW" >&2
    exit 2
  fi
  UNIT_CONF="${UNIT_CONF_RAW%/ai-debate.env}"
  if UNIT_DATA="$(optional_unit_value "$UNIT" Environment=AI_DEBATE_HOME "AI_DEBATE_HOME")"; then
    :
  else
    READ_STATUS=$?
    if [[ "$READ_STATUS" -eq 2 ]]; then
      exit 2
    fi
    UNIT_DATA=""
  fi
  if UNIT_WORKDIR="$(optional_unit_value "$UNIT" WorkingDirectory "WorkingDirectory")"; then
    :
  else
    READ_STATUS=$?
    if [[ "$READ_STATUS" -eq 2 ]]; then
      exit 2
    fi
    UNIT_WORKDIR=""
  fi
  PREFIX="$UNIT_PREFIX"
  CONF_DIR="$UNIT_CONF"
  if [[ -n "$UNIT_DATA" ]]; then
    DATA_DIR="$UNIT_DATA"
  elif [[ -n "$UNIT_WORKDIR" ]]; then
    DATA_DIR="$UNIT_WORKDIR"
  fi
fi

ENV_FILE="${CONF_DIR}/ai-debate.env"
ENV_DATA=""
if [[ -e "$ENV_FILE" || -L "$ENV_FILE" ]]; then
  if [[ -L "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
    echo "配置文件必须是普通文件，拒绝删除：$ENV_FILE" >&2
    exit 2
  fi
  if ENV_DATA="$(read_env_value "$ENV_FILE" AI_DEBATE_HOME "AI_DEBATE_HOME")"; then
    if [[ -z "$UNIT_DATA" ]]; then
      DATA_DIR="$ENV_DATA"
    fi
  else
    READ_STATUS=$?
    if [[ "$READ_STATUS" -ne 1 ]]; then
      exit "$READ_STATUS"
    fi
  fi
fi

validate_deployment_paths "$PREFIX" "$DATA_DIR" "$CONF_DIR" || exit $?

# Every independent record must agree. A tampered or half-upgraded installation
# must fail closed rather than delete a directory inferred from only one record.
for recorded_data in "$UNIT_DATA" "$UNIT_WORKDIR" "$ENV_DATA"; do
  if [[ -n "$recorded_data" ]]; then
    recorded_canonical="$(canonical_deployment_path "已记录的数据目录" "$recorded_data")" || exit $?
    if [[ "$recorded_canonical" != "$DATA_DIR" ]]; then
      echo "unit/env 中的数据目录不一致（${recorded_canonical} != ${DATA_DIR}），拒绝卸载。" >&2
      exit 2
    fi
  fi
done

if [[ "$PURGE" -eq 1 && "$CONFIRM_PURGE" -eq 0 ]]; then
  if [[ -t 0 ]]; then
    printf '即将永久删除数据目录 %s 与配置目录 %s\n' "$DATA_DIR" "$CONF_DIR" >&2
    printf '请输入 DELETE %s %s 确认：' "$DATA_DIR" "$CONF_DIR" >&2
    IFS= read -r CONFIRM_LINE || true
    if [[ "${CONFIRM_LINE:-}" != "DELETE ${DATA_DIR} ${CONF_DIR}" ]]; then
      echo "确认不匹配，已取消卸载。" >&2
      exit 1
    fi
  else
    echo "非交互环境下 --purge 还必须附带 --confirm-purge；未删除任何内容。" >&2
    exit 1
  fi
fi

echo "== 停止并禁用服务 =="
if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now "${APP_NAME}" 2>/dev/null || true
fi
rm -f -- "$UNIT"
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload 2>/dev/null || true
fi
rm -f -- "$LOGROTATE"

# Revalidate immediately before privileged recursive deletion.
validate_deployment_paths "$PREFIX" "$DATA_DIR" "$CONF_DIR" || exit $?

echo "== 删除程序 =="
if [[ -e "$PREFIX" || -L "$PREFIX" ]]; then
  if [[ -L "$PREFIX" || ! -d "$PREFIX" ]]; then
    echo "安装目录不是真实目录，拒绝递归删除：$PREFIX" >&2
    exit 2
  fi
  rm -rf -- "$PREFIX"
fi

if [[ "$PURGE" -eq 1 ]]; then
  echo "== --purge：删除数据与配置 =="
  for delete_dir in "$DATA_DIR" "$CONF_DIR"; do
    if [[ -e "$delete_dir" || -L "$delete_dir" ]]; then
      if [[ -L "$delete_dir" || ! -d "$delete_dir" ]]; then
        echo "待删除目录不是真实目录，拒绝递归删除：$delete_dir" >&2
        exit 2
      fi
      rm -rf -- "$delete_dir"
    fi
  done
  if id -u "${APP_USER}" >/dev/null 2>&1; then
    userdel "${APP_USER}" 2>/dev/null || true
  fi
  echo "数据目录 ${DATA_DIR} 与配置目录 ${CONF_DIR} 已删除。"
else
  echo "== 保留数据 =="
  echo "数据目录 ${DATA_DIR} 与配置 ${CONF_DIR} 已保留。"
  echo "需要彻底删除时重新运行：sudo ./uninstall.sh --purge --confirm-purge"
fi

echo "卸载完成。"
