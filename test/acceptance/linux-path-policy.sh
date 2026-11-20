#!/usr/bin/env bash
#
# Static Linux deployment-policy checks. No root, systemd, archive or service is
# required; this is the fallback verification for hosts without an init system.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../../packaging/linux/common.sh
source "${ROOT}/packaging/linux/common.sh"

PASS=0
FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

pass() { PASS=$((PASS + 1)); echo "✔ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "✖ $1"; }

expect_valid() {
  local label="$1" prefix="$2" data_dir="$3" conf_dir="$4"
  if validate_deployment_paths "$prefix" "$data_dir" "$conf_dir" >"${WORK}/out" 2>&1; then
    pass "$label"
  else
    fail "$label"
    cat "${WORK}/out"
  fi
}

expect_invalid() {
  local label="$1" prefix="$2" data_dir="$3" conf_dir="$4"
  if validate_deployment_paths "$prefix" "$data_dir" "$conf_dir" >"${WORK}/out" 2>&1; then
    fail "$label（错误地接受）"
  else
    pass "$label"
  fi
}

unset AI_DEBATE_INSTALL_TEST AI_DEBATE_INSTALL_TEST_ROOT
expect_valid "默认生产路径" /opt/ai-debate /var/lib/ai-debate /etc/ai-debate
expect_valid "备用 prefix 与自定义数据/配置子目录" \
  /usr/local/ai-debate /srv/ai-debate/site-a /etc/ai-debate/site-a
expect_valid "prefix 应用专属实例子目录" \
  /opt/ai-debate/site-a/ai-debate /var/lib/ai-debate/site-a /etc/ai-debate/site-a
expect_invalid "拒绝系统根" / /var/lib/ai-debate /etc/ai-debate
expect_invalid "拒绝 /opt 共享目录" /opt /var/lib/ai-debate /etc/ai-debate
expect_invalid "拒绝 /usr/local 共享目录" /usr/local /var/lib/ai-debate /etc/ai-debate
expect_invalid "拒绝非应用名结尾的 prefix" /opt/ai-debate-data /var/lib/ai-debate /etc/ai-debate
expect_invalid "拒绝 prefix 逃逸到 /srv" /srv/apps/ai-debate /var/lib/ai-debate /etc/ai-debate
expect_invalid "拒绝 /var/lib 共享目录" /opt/ai-debate /var/lib /etc/ai-debate
expect_invalid "拒绝 /etc/ai-debate-data" /opt/ai-debate /etc/ai-debate-data /etc/ai-debate
expect_invalid "拒绝 /srv 共享目录" /opt/ai-debate /srv /etc/ai-debate
expect_invalid "拒绝 /etc 共享目录" /opt/ai-debate /var/lib/ai-debate /etc
expect_invalid "拒绝配置目录逃逸" /opt/ai-debate /var/lib/ai-debate /etc/other
expect_invalid "拒绝相对路径" relative/ai-debate /var/lib/ai-debate /etc/ai-debate
expect_invalid "拒绝换行/控制字符" $'/opt/ai-debate\nforged' /var/lib/ai-debate /etc/ai-debate
expect_invalid "拒绝 shell/systemd 元字符" '/opt/ai-debate/ai-debate;false' /var/lib/ai-debate /etc/ai-debate
expect_invalid "拒绝 ReadWritePaths 逗号" /opt/ai-debate '/var/lib/ai-debate,a' /etc/ai-debate

if ln -s "$WORK/outside" "$WORK/escape" 2>/dev/null; then
  ESCAPED="$(realpath -m -- "$WORK/escape")"
  expect_invalid "拒绝符号链接解析后的逃逸路径" /opt/ai-debate "$ESCAPED" /etc/ai-debate
else
  echo "  （跳过符号链接创建：当前 Windows 账号无 symlink 权限；仍校验白名单外真实路径）"
  expect_invalid "拒绝规范化后的白名单外路径" /opt/ai-debate "$WORK/outside" /etc/ai-debate
fi

if AI_DEBATE_INSTALL_TEST_ROOT="$WORK" validate_deployment_paths \
  "$WORK/prefix" "$WORK/data" "$WORK/conf" >"${WORK}/out" 2>&1; then
  fail "测试根目录不能隐式放宽生产策略"
else
  pass "测试根目录不能隐式放宽生产策略"
fi

cat > "$WORK/ai-debate.service" <<EOF
[Service]
EnvironmentFile=-/etc/ai-debate/ai-debate.env
Environment=AI_DEBATE_HOME=/srv/ai-debate/site-a
WorkingDirectory=/srv/ai-debate/site-a
ExecStart=/opt/ai-debate/site-a/ai-debate serve
EOF
if [[ "$(read_unit_value "$WORK/ai-debate.service" EnvironmentFile EnvironmentFile)" == "/etc/ai-debate/ai-debate.env" ]] \
  && [[ "$(read_unit_value "$WORK/ai-debate.service" Environment=AI_DEBATE_HOME AI_DEBATE_HOME)" == "/srv/ai-debate/site-a" ]] \
  && [[ "$(read_unit_value "$WORK/ai-debate.service" ExecStart ExecStart)" == "/opt/ai-debate/site-a/ai-debate serve" ]]; then
  pass "unit 路径可安全解析且不 source/eval"
else
  fail "unit 路径解析不正确"
fi

printf '\nEnvironment=AI_DEBATE_HOME=/srv/ai-debate/other\n' >> "$WORK/ai-debate.service"
if read_unit_value "$WORK/ai-debate.service" Environment=AI_DEBATE_HOME AI_DEBATE_HOME >"${WORK}/out" 2>&1; then
  fail "重复 unit 设置必须失败"
else
  pass "重复 unit 设置必须失败"
fi

if read_unit_value "$WORK/ai-debate.service" MissingKey MissingKey 0 >"${WORK}/out" 2>&1; then
  fail "可选 unit 设置缺失时应返回非零"
else
  [[ "$?" -eq 1 ]] && pass "可选 unit 设置缺失与重复可区分" || fail "可选 unit 设置缺失状态码不正确"
fi
if read_unit_value "$WORK/ai-debate.service" Environment=AI_DEBATE_HOME AI_DEBATE_HOME 0 >"${WORK}/out" 2>&1; then
  fail "可选 unit 设置重复时仍须失败"
else
  [[ "$?" -eq 2 ]] && pass "可选 unit 设置重复仍失败关闭" || fail "可选 unit 设置重复状态码不正确"
fi

cat > "$WORK/ai-debate.env" <<EOF
AI_DEBATE_HOME=/srv/ai-debate/site-a
EOF
if [[ "$(read_env_value "$WORK/ai-debate.env" AI_DEBATE_HOME AI_DEBATE_HOME)" == "/srv/ai-debate/site-a" ]]; then
  pass "env 路径可安全解析且不 source/eval"
else
  fail "env 路径解析不正确"
fi

if [[ "$(AI_DEBATE_INSTALL_TEST=1 AI_DEBATE_INSTALL_TEST_ROOT=/tmp/example install_metadata_path)" == "/tmp/example/.install-paths" ]] \
  && [[ "$(install_metadata_path)" == "/etc/ai-debate/.install-paths" ]]; then
  pass "安装元数据在测试与生产模式中使用不同安全位置"
else
  fail "安装元数据路径不正确"
fi

PREFIX='/opt/ai-debate/@DATA_DIR@/ai-debate'
DATA_DIR='/srv/ai-debate/site-a'
CONF_DIR='/etc/ai-debate/site-a'
printf 'ExecStart=@PREFIX@/bin/ai-debate serve\nReadWritePaths=@DATA_DIR@\nUser=@APP_USER@\n' > "$WORK/template"
render_template "$WORK/template" "$WORK/rendered"
if grep -Fqx "ExecStart=${PREFIX}/bin/ai-debate serve" "$WORK/rendered" \
  && grep -Fqx "ReadWritePaths=${DATA_DIR}" "$WORK/rendered" \
  && grep -Fqx 'User=ai-debate' "$WORK/rendered"; then
  pass "模板单遍渲染且插入值不会被二次替换"
else
  fail "模板渲染不正确"
fi

if grep -q '^Restart=on-failure$' "${ROOT}/packaging/linux/ai-debate.service" \
  && grep -q '^SuccessExitStatus=75$' "${ROOT}/packaging/linux/ai-debate.service" \
  && grep -q '^RestartForceExitStatus=75$' "${ROOT}/packaging/linux/ai-debate.service" \
  && grep -q '^StartLimitIntervalSec=60$' "${ROOT}/packaging/linux/ai-debate.service" \
  && grep -q '^StartLimitBurst=10$' "${ROOT}/packaging/linux/ai-debate.service" \
  && grep -q '^ReadWritePaths=@DATA_DIR@$' "${ROOT}/packaging/linux/ai-debate.service" \
  && grep -q '^ProtectSystem=strict$' "${ROOT}/packaging/linux/ai-debate.service"; then
  pass "systemd 模板限定失败重启与唯一可写目录"
else
  fail "systemd 模板安全策略不正确"
fi

if grep -Fq '@DATA_DIR@/logs/*.log' "${ROOT}/packaging/linux/ai-debate.logrotate" \
  && grep -Fq '@DATA_DIR@/logs/*.jsonl' "${ROOT}/packaging/linux/ai-debate.logrotate" \
  && grep -Fq '@DATA_DIR@/egress.jsonl' "${ROOT}/packaging/linux/ai-debate.logrotate" \
  && grep -q '^    copytruncate$' "${ROOT}/packaging/linux/ai-debate.logrotate"; then
  pass "logrotate 模板覆盖实际日志并使用 copytruncate"
else
  fail "logrotate 模板不完整"
fi

echo
echo "${PASS}/$((PASS + FAIL)) 项通过"
[[ "$FAIL" -eq 0 ]]
