#!/usr/bin/env bash
#
# AI Debate — Linux uninstaller.
#
# Removes the binary, the unit file and the service user. User data in
# /var/lib/ai-debate is kept by default: an uninstall is not a delete.
#
#   sudo ./uninstall.sh            # keep data
#   sudo ./uninstall.sh --purge    # also delete /var/lib/ai-debate and /etc/ai-debate
#
set -euo pipefail

APP_NAME="ai-debate"
APP_USER="ai-debate"
PREFIX="/opt/ai-debate"
DATA_DIR="/var/lib/ai-debate"
CONF_DIR="/etc/ai-debate"
UNIT="/etc/systemd/system/${APP_NAME}.service"
PURGE=0

for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    -h|--help)
      echo "Usage: uninstall.sh [--purge]"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 运行：sudo ./uninstall.sh" >&2
  exit 1
fi

echo "== 停止并禁用服务 =="
systemctl disable --now "${APP_NAME}" 2>/dev/null || true
rm -f "${UNIT}"
systemctl daemon-reload || true

echo "== 删除程序 =="
rm -rf "${PREFIX}"

if [[ "${PURGE}" -eq 1 ]]; then
  echo "== --purge：删除数据与配置 =="
  rm -rf "${DATA_DIR}" "${CONF_DIR}"
  if id -u "${APP_USER}" >/dev/null 2>&1; then
    userdel "${APP_USER}" 2>/dev/null || true
  fi
  echo "数据目录与配置已删除。"
else
  echo "== 保留数据 =="
  echo "数据目录 ${DATA_DIR} 与配置 ${CONF_DIR} 已保留。"
  echo "需要彻底删除时重新运行：sudo ./uninstall.sh --purge"
fi

echo "卸载完成。"
