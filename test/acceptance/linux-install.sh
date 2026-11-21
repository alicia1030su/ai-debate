#!/usr/bin/env bash
#
# Linux acceptance: install the archive for real, exercise the path policy, start
# the installed service, complete the core workflow over HTTP, prove crash and
# controlled-restart recovery, preserve data across upgrade/uninstall, and verify
# that purge requires a second confirmation.
#
# Run on a throw-away machine or CI runner:
#   sudo ./test/acceptance/linux-install.sh dist/ai-debate-linux-x64.tgz
#
set -euo pipefail

ARCHIVE="${1:-dist/ai-debate-linux-x64.tgz}"
PORT=17862
MOCK_PORT=17863
WORK="$(mktemp -d)"
TOKEN="acceptance-$$"
PASS=0
FAIL=0
INSTALLED=0
SERVICE_PID=""
MOCK_PID=""
SYSTEMD=0
PREFIX=""
DATA_DIR=""
CONF_DIR=""
METADATA_FILE=""
BIN=""
PKG_DIR=""
INSTALL_ENV=()
unset AI_DEBATE_INSTALL_TEST AI_DEBATE_INSTALL_TEST_ROOT

pass() { PASS=$((PASS + 1)); echo "✔ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "✖ $1"; }
skip() { echo "  （跳过：$1）"; }

cleanup() {
  if [[ "$INSTALLED" -eq 1 && -x "${PKG_DIR}/uninstall.sh" ]]; then
    ( cd "$PKG_DIR" && env "${INSTALL_ENV[@]}" ./uninstall.sh ) >/dev/null 2>&1 || true
  fi
  [[ -n "$SERVICE_PID" ]] && kill "$SERVICE_PID" 2>/dev/null || true
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null || true
  rm -rf -- "$WORK"
}
trap cleanup EXIT

if [[ ! -f "$ARCHIVE" ]]; then
  echo "找不到安装包：$ARCHIVE" >&2
  exit 1
fi
ARCHIVE="$(realpath -m -- "$ARCHIVE")"

if [[ "$(id -u)" -eq 0 ]]; then
  if [[ -f /etc/systemd/system/ai-debate.service ]]; then
    echo "检测到已有 /etc/systemd/system/ai-debate.service；验收只能在干净的一次性主机运行。" >&2
    exit 1
  fi
  if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
    SYSTEMD=1
    PREFIX="/opt/ai-debate/${TOKEN}/ai-debate"
    DATA_DIR="/srv/ai-debate/${TOKEN}/ai-debate"
    CONF_DIR="/etc/ai-debate/${TOKEN}"
    METADATA_FILE="/etc/ai-debate/.install-paths"
  else
    TEST_ROOT="${WORK}/test-root"
    install -d -m 0700 -o root -g root "$TEST_ROOT"
    INSTALL_ENV=(AI_DEBATE_INSTALL_TEST=1 "AI_DEBATE_INSTALL_TEST_ROOT=${TEST_ROOT}")
    PREFIX="${TEST_ROOT}/prefix/ai-debate"
    DATA_DIR="${TEST_ROOT}/data/ai-debate"
    CONF_DIR="${TEST_ROOT}/conf/ai-debate"
    METADATA_FILE="${TEST_ROOT}/.install-paths"
  fi
else
  DATA_DIR="${WORK}/data"
  PREFIX="${WORK}/opt"
  CONF_DIR="${WORK}/conf"
fi

echo "== 解压并校验安装包 =="
mkdir -p "${WORK}/pkg"
tar -xzf "$ARCHIVE" -C "${WORK}/pkg"
PKG_DIR="${WORK}/pkg/ai-debate-linux-x64"
( cd "$PKG_DIR" && sha256sum -c SHA256SUMS --quiet ) && pass "安装包 SHA256 校验" || fail "安装包 SHA256 校验"
[[ -f "${PKG_DIR}/common.sh" ]] && pass "安装包包含共享路径策略" || fail "安装包缺少 common.sh"

expect_rejected() {
  local label="$1" output status
  shift
  output="${WORK}/rejected.log"
  if ( cd "$PKG_DIR" && env "${INSTALL_ENV[@]}" ./install.sh "$@" ) >"$output" 2>&1; then
    fail "$label（安装脚本错误地接受了恶意路径）"
  else
    status=$?
    if [[ "$status" -eq 2 ]]; then
      pass "$label"
    else
      fail "$label（退出码 ${status}，预期 2）"
      cat "$output"
    fi
  fi
}

if [[ "$(id -u)" -eq 0 ]]; then
  echo "== 恶意路径必须失败 =="
  # No test override here: these prove the production allowlist itself.
  expect_rejected "拒绝系统根 prefix" --prefix / --no-start
  expect_rejected "拒绝 /opt 共享目录" --prefix /opt --no-start
  expect_rejected "拒绝 /usr/local 共享目录" --prefix /usr/local --no-start
  expect_rejected "拒绝不以应用名结尾的 prefix" --prefix /opt/ai-debate-data --no-start
  expect_rejected "拒绝 /var/lib 共享目录" --data-dir /var/lib --no-start
  expect_rejected "拒绝 /etc/ai-debate-data" --data-dir /etc/ai-debate-data --no-start
  expect_rejected "拒绝 /srv 共享目录" --data-dir /srv --no-start
  expect_rejected "拒绝 /etc 共享目录" --conf-dir /etc --no-start
  expect_rejected "拒绝相对路径" --data-dir relative/ai-debate --no-start
  expect_rejected "拒绝换行/控制字符" --prefix $'/opt/ai-debate\nforged' --no-start
  expect_rejected "拒绝 shell/systemd 元字符" --prefix '/opt/ai-debate/ai-debate;false' --no-start
  expect_rejected "拒绝三个目录互相嵌套" \
    --prefix /opt/ai-debate/nested/ai-debate \
    --data-dir /opt/ai-debate/nested/ai-debate/data \
    --conf-dir /etc/ai-debate/nested --no-start

  NEST_ROOT="${WORK}/nest-root"
  install -d -m 0700 "$NEST_ROOT"
  if ( cd "$PKG_DIR" && env AI_DEBATE_INSTALL_TEST=1 "AI_DEBATE_INSTALL_TEST_ROOT=${NEST_ROOT}" \
      ./install.sh --prefix "${NEST_ROOT}/app" --data-dir "${NEST_ROOT}/app/data" \
      --conf-dir "${NEST_ROOT}/conf" --no-start ) >"${WORK}/nested.log" 2>&1; then
    fail "测试模式下仍须拒绝互相嵌套的目录"
  else
    pass "测试模式下仍须拒绝互相嵌套的目录"
  fi

  OUTSIDE="${WORK}/outside"
  install -d -m 0700 "$OUTSIDE"
  if [[ "$SYSTEMD" -eq 1 ]]; then
    install -d -m 0755 /var/lib/ai-debate
    ESCAPE_LINK="/var/lib/ai-debate/${TOKEN}-escape"
    ln -s "$OUTSIDE" "$ESCAPE_LINK"
    expect_rejected "拒绝符号链接逃逸出数据根目录" --data-dir "$ESCAPE_LINK" --no-start
    rm -f -- "$ESCAPE_LINK"
  else
    install -d -m 0700 "${TEST_ROOT}/links"
    ESCAPE_LINK="${TEST_ROOT}/links/data"
    ln -s "$OUTSIDE" "$ESCAPE_LINK"
    expect_rejected "拒绝符号链接逃逸出测试根目录" --data-dir "$ESCAPE_LINK" --no-start
  fi
fi

# A mock OpenAI-compatible endpoint so the model step is real HTTP, not a stub.
if [[ -n "${AI_DEBATE_MOCK_URL:-}" ]]; then
  echo "使用外部模型地址 ${AI_DEBATE_MOCK_URL}"
else
  node -e '
const http = require("node:http");
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const m = /post id[：: ]*([A-Za-z0-9:_-]+)/.exec(body);
    const draft = {
      status: "ok",
      owner_position: "对方的结论建立在个例上。",
      opponent_position: "年轻人不能吃苦。",
      main_dispute: "能否用个别现象概括整体。",
      latest_argument: "用身边例子否定整体结论。",
      response_target_id: m ? m[1] : "local:1",
      strategy: "point_out_contradiction",
      confidence: 0.7,
      uncertainties: [],
      reply: "你举的例子只能说明有人这样，不能说明所有人都这样。"
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(draft) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
});
server.listen('"${MOCK_PORT}"', "127.0.0.1");
' &
  MOCK_PID=$!
  sleep 1
fi

INSTALL_ARGS=(--host 127.0.0.1 --port "$PORT" --prefix "$PREFIX" --data-dir "$DATA_DIR" --conf-dir "$CONF_DIR")
if [[ "$(id -u)" -eq 0 ]]; then
  echo "== 自定义路径安装 =="
  if [[ "$SYSTEMD" -eq 1 ]]; then
    echo "运行中的 systemd：使用应用专属生产路径"
  else
    echo "没有运行中的 systemd：使用显式 0700 测试根目录"
  fi
  ( cd "$PKG_DIR" && env "${INSTALL_ENV[@]}" ./install.sh "${INSTALL_ARGS[@]}" ) \
    && { pass "自定义路径安装成功"; INSTALLED=1; } \
    || { fail "自定义路径安装"; exit 1; }
  BIN="${PREFIX}/bin/ai-debate"
  [[ -x "$BIN" ]] && pass "程序安装到自定义 prefix" || fail "自定义 prefix 中程序缺失"
  [[ "$(stat -c '%U:%G:%a' "$PREFIX")" == "root:root:755" ]] \
    && pass "prefix 为 root:root 0755" || fail "prefix 权限不正确"
  [[ "$(stat -c '%U:%G:%a' "$DATA_DIR")" == "ai-debate:ai-debate:750" ]] \
    && pass "数据目录归服务用户且权限 0750" || fail "数据目录权限不正确"
  [[ "$(stat -c '%U:%G:%a' "$CONF_DIR")" == "root:root:755" ]] \
    && pass "配置目录由 root 拥有" || fail "配置目录权限不正确"
  [[ "$(stat -c '%U:%G:%a' "${CONF_DIR}/ai-debate.env")" == "root:ai-debate:640" ]] \
    && pass "env 为 root:ai-debate 0640" || fail "env 权限不正确"
  [[ -f /etc/systemd/system/ai-debate.service ]] && pass "已安装渲染后的 systemd unit" || fail "systemd unit 未安装"
  [[ "$(stat -c '%U:%G:%a' "$METADATA_FILE")" == "root:root:640" ]] \
    && grep -Fqx "AI_DEBATE_PREFIX=${PREFIX}" "$METADATA_FILE" \
    && grep -Fqx "AI_DEBATE_HOME=${DATA_DIR}" "$METADATA_FILE" \
    && grep -Fqx "AI_DEBATE_CONF_DIR=${CONF_DIR}" "$METADATA_FILE" \
    && pass "安装元数据记录自定义路径且权限正确" || fail "安装元数据缺失或不正确"

  echo "== 卸载器必须拒绝被篡改的系统目录 =="
  cp /etc/systemd/system/ai-debate.service "${WORK}/good.service"
  sed -i 's|^Environment=AI_DEBATE_HOME=.*|Environment=AI_DEBATE_HOME=/var/lib|' /etc/systemd/system/ai-debate.service
  if ( cd "$PKG_DIR" && env "${INSTALL_ENV[@]}" ./uninstall.sh --purge --confirm-purge ) >"${WORK}/evil-uninstall.log" 2>&1; then
    fail "卸载器错误地接受了系统数据目录"
  else
    [[ -d "$DATA_DIR" && -d "$CONF_DIR" && -d "$PREFIX" ]] \
      && pass "卸载器拒绝系统目录且未删除任何内容" || fail "卸载器拒绝后仍删除了内容"
  fi
  cp "${WORK}/good.service" /etc/systemd/system/ai-debate.service
  chmod 0644 /etc/systemd/system/ai-debate.service

  if command -v logrotate >/dev/null 2>&1 && [[ -d /etc/logrotate.d ]]; then
    [[ -f /etc/logrotate.d/ai-debate ]] && pass "已安装日志轮转配置" || fail "日志轮转配置缺失"
    grep -Fq "${DATA_DIR}/logs/*.log" /etc/logrotate.d/ai-debate \
      && grep -Fq "${DATA_DIR}/logs/*.jsonl" /etc/logrotate.d/ai-debate \
      && grep -Fq "${DATA_DIR}/egress.jsonl" /etc/logrotate.d/ai-debate \
      && pass "logrotate 覆盖 server/audit/egress 自定义路径" || fail "logrotate 路径不完整"
    [[ "$(stat -c '%U:%G:%a' /etc/logrotate.d/ai-debate)" == "root:ai-debate:640" ]] \
      && pass "logrotate 策略为 root:ai-debate 0640" || fail "logrotate 策略权限不正确"
    if logrotate --debug /etc/logrotate.d/ai-debate >"${WORK}/logrotate.log" 2>&1; then
      pass "logrotate --debug 接受渲染配置"
    else
      fail "logrotate --debug 失败"
      cat "${WORK}/logrotate.log"
    fi
  else
    skip "本机没有 logrotate"
  fi

  if command -v systemd-analyze >/dev/null 2>&1; then
    if systemd-analyze verify /etc/systemd/system/ai-debate.service >"${WORK}/verify.log" 2>&1; then
      pass "systemd-analyze verify 接受自定义 unit"
    else
      fail "systemd-analyze verify 拒绝自定义 unit"
      cat "${WORK}/verify.log"
    fi
    cp /etc/systemd/system/ai-debate.service "${WORK}/invalid.service"
    printf '\nType=definitely-invalid-service-type\n' >> "${WORK}/invalid.service"
    if systemd-analyze verify "${WORK}/invalid.service" >"${WORK}/invalid-verify.log" 2>&1; then
      fail "systemd-analyze verify 对非法 unit 错误地返回 0"
    else
      pass "systemd-analyze verify 对非法 unit 返回非零"
    fi
  else
    skip "本机没有 systemd-analyze"
  fi
else
  echo "非 root：跳过安装脚本，直接使用解压出的二进制"
  BIN="${PKG_DIR}/bin/ai-debate"
fi

[[ -x "$BIN" ]] && pass "程序可执行" || fail "程序缺失"

wait_ready() {
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

echo "== 启动已安装的程序 =="
if [[ "$SYSTEMD" -eq 1 ]]; then
  for _ in $(seq 1 40); do
    systemctl is-active --quiet ai-debate && break
    sleep 0.5
  done
  systemctl is-active --quiet ai-debate && pass "systemctl 报告服务 active" || { fail "systemd 服务未 active"; exit 1; }
  systemctl is-enabled --quiet ai-debate && pass "systemd 已 enable（开机自启）" || fail "systemd 未 enable"
  [[ "$(systemctl show -p User --value ai-debate)" == "ai-debate" ]] \
    && pass "服务以独立低权限用户运行" || fail "服务用户不是 ai-debate"
  [[ "$(systemctl show -p Restart --value ai-debate)" == "on-failure" ]] \
    && pass "Restart=on-failure" || fail "Restart 策略不正确"
  [[ "$(systemctl show -p SuccessExitStatus --value ai-debate)" == "75" ]] \
    && pass "SuccessExitStatus=75" || fail "SuccessExitStatus 不是 75"
  [[ "$(systemctl show -p RestartForceExitStatus --value ai-debate)" == "75" ]] \
    && pass "RestartForceExitStatus=75" || fail "RestartForceExitStatus 不是 75"
  [[ "$(systemctl show -p ReadWritePaths --value ai-debate)" == "$DATA_DIR" ]] \
    && pass "ReadWritePaths 仅包含数据目录" || fail "ReadWritePaths 范围不正确"
  [[ "$(systemctl show -p ProtectSystem --value ai-debate)" == "strict" ]] \
    && pass "ProtectSystem=strict" || fail "ProtectSystem 不是 strict"
else
  AI_DEBATE_HOME="$DATA_DIR" "$BIN" serve --port "$PORT" > "${WORK}/service.log" 2>&1 &
  SERVICE_PID=$!
fi

if wait_ready; then
  pass "服务启动并响应 /healthz"
else
  fail "服务启动"
  [[ -f "${WORK}/service.log" ]] && cat "${WORK}/service.log"
  exit 1
fi

JAR="${WORK}/cookies.txt"
api() {
  local method="$1" path="$2" body="${3:-}"
  local -a body_args=()
  if [[ -n "$body" ]]; then
    body_args=(--data "$body")
  fi
  curl -sS -b "${JAR}" -c "${JAR}" -X "$method" \
    -H 'content-type: application/json' -H "origin: http://127.0.0.1:${PORT}" \
    "${body_args[@]}" \
    "http://127.0.0.1:${PORT}${path}"
}

[[ "$(curl -s "http://127.0.0.1:${PORT}/api/ai-debate/auth/state" | grep -c '"initialized":false')" -ge 1 ]] \
  && pass "首次运行未初始化" || fail "首次运行状态"

api POST /api/ai-debate/auth/setup '{"username":"owner","password":"linux-accept-2026"}' >/dev/null
[[ -s "${JAR}" ]] && pass "初始化管理员并取得会话" || fail "初始化管理员"

api GET /api/ai-debate/settings | grep -q '"status":"ready"' && pass "读取配置" || fail "读取配置"

MOCK_BASE="${AI_DEBATE_MOCK_URL:-http://127.0.0.1:${MOCK_PORT}}"
api POST /api/ai-debate/settings "{\"set\":{\"llmBaseUrl\":\"${MOCK_BASE}/v1\",\"llmModel\":\"mock-model\",\"llmSource\":\"custom\"}}" >/dev/null
api POST /api/ai-debate/secrets '{"ref":"AI_DEBATE_LLM_API_KEY","value":"sk-linux-acceptance-123"}' >/dev/null
api POST /api/ai-debate/action '{"action":"test-llm"}' | grep -q '"ok":true' && pass "模型连接测试" || fail "模型连接测试"

DISCUSSION='{"root":{"author":"楼主","text":"现在的年轻人根本不愿意吃苦，一点委屈都受不了。我公司今年招的五个应届生，三个月走了四个。"},"comments":[{"id":"c1","author":"路人甲","text":"你说得太绝对了。我身边很多人加班到很晚，我表弟在工厂两班倒干了两年。","replyTo":"root"},{"id":"c2","author":"楼主","text":"那是他们不敢拒绝，不是能吃苦。真让他们连续一个月每天十二小时，早就跑了。","replyTo":"c1"},{"id":"c3","author":"路人乙","text":"你只说了你们公司五个人的情况，就推到现在所有年轻人身上，这个样本太小了。","replyTo":"c2"},{"id":"c4","author":"楼主","text":"样本小不代表方向错。我做了十年管理，见过的年轻人一批不如一批。","replyTo":"c3"}]}'

CONFIRM=$(api POST /api/ai-debate/action "$(node -e 'const d=process.argv[1];console.log(JSON.stringify({action:"manual-confirm",kind:"json",content:d,title:"Linux 验收",ownerName:"楼主",targetPostId:"c2"}))' "${DISCUSSION}")")
SESSION=$(node -e 'const j=JSON.parse(process.argv[1]);console.log(j.sessionId||"")' "${CONFIRM}")
[[ -n "$SESSION" ]] && pass "导入并确认讨论" || fail "导入讨论"

GEN=$(api POST /api/ai-debate/action "{\"action\":\"manual-generate\",\"sessionId\":\"${SESSION}\",\"targetPostId\":\"c2\"}")
CANDIDATE=$(node -e 'const j=JSON.parse(process.argv[1]);console.log(j.candidateId||"")' "${GEN}")
[[ -n "$CANDIDATE" ]] && pass "生成候选" || fail "生成候选"

api POST /api/ai-debate/action "{\"action\":\"manual-edit\",\"sessionId\":\"${SESSION}\",\"candidateId\":\"${CANDIDATE}\",\"text\":\"你举的例子只能说明有人这样，不能代表所有人。\"}" >/dev/null
api POST /api/ai-debate/action "{\"action\":\"manual-approve\",\"sessionId\":\"${SESSION}\",\"candidateId\":\"${CANDIDATE}\",\"approvedText\":\"你举的例子只能说明有人这样，不能代表所有人。\"}" | grep -q '"ok":true' && pass "人工批准" || fail "人工批准"

printf 'upgrade-%s\n' "$TOKEN" > "${DATA_DIR}/upgrade-marker"

echo "== 重启，验证持久化 =="
if [[ "$SYSTEMD" -eq 1 ]]; then
  systemctl restart ai-debate
else
  kill "$SERVICE_PID"; wait "$SERVICE_PID" 2>/dev/null || true
  AI_DEBATE_HOME="$DATA_DIR" "$BIN" serve --port "$PORT" >> "${WORK}/service.log" 2>&1 &
  SERVICE_PID=$!
fi
if wait_ready; then
  pass "重启后服务可用"
else
  fail "重启后服务"
  exit 1
fi
api GET /api/ai-debate/settings | grep -q '"status":"ready"' && pass "重启后会话仍有效" || fail "重启后会话"
grep -q "$SESSION" "${DATA_DIR}/state.json" && pass "重启后会话数据仍在" || fail "重启后数据"

if [[ "$SYSTEMD" -eq 1 ]]; then
  echo "== SIGKILL 自动恢复 =="
  MAIN_PID=$(systemctl show -p MainPID --value ai-debate)
  [[ -n "$MAIN_PID" && "$MAIN_PID" != "0" ]] && pass "读到服务主进程 PID" || fail "读到服务主进程 PID"
  kill -9 "$MAIN_PID" 2>/dev/null || true
  restarted=0
  for _ in $(seq 1 60); do
    NEW_PID=$(systemctl show -p MainPID --value ai-debate)
    if [[ -n "$NEW_PID" && "$NEW_PID" != "0" && "$NEW_PID" != "$MAIN_PID" ]] && systemctl is-active --quiet ai-debate; then
      restarted=1; break
    fi
    sleep 0.5
  done
  [[ "$restarted" -eq 1 ]] && pass "进程被 kill -9 后由 systemd 自动拉起" || fail "进程被 kill -9 后未自动拉起"
  wait_ready && pass "拉起后再次可服务" || fail "拉起后不可服务"

  echo "== 受控 exit 75 自动恢复 =="
  MAIN_PID=$(systemctl show -p MainPID --value ai-debate)
  if AI_DEBATE_HOME="$DATA_DIR" "$BIN" restart >"${WORK}/restart.log" 2>&1; then
    pass "CLI 受控重启请求被接受"
  else
    fail "CLI 受控重启请求失败"
    cat "${WORK}/restart.log"
  fi
  restarted=0
  for _ in $(seq 1 60); do
    NEW_PID=$(systemctl show -p MainPID --value ai-debate)
    if [[ -n "$NEW_PID" && "$NEW_PID" != "0" && "$NEW_PID" != "$MAIN_PID" ]] && systemctl is-active --quiet ai-debate; then
      restarted=1; break
    fi
    sleep 0.5
  done
  [[ "$restarted" -eq 1 ]] && pass "受控 exit 75 后由 systemd 自动恢复" || fail "受控 exit 75 后未自动恢复"
  exit75_logged=0
  for _ in $(seq 1 20); do
    if journalctl -u ai-debate --since '-3 min' --no-pager 2>/dev/null | grep -q 'status=75'; then
      exit75_logged=1
      break
    fi
    sleep 0.5
  done
  if [[ "$exit75_logged" -eq 1 ]]; then
    pass "journal 确认主进程以 75 退出"
  else
    fail "journal 未确认 exit 75"
  fi
  wait_ready && pass "受控重启后再次可服务" || fail "受控重启后不可服务"

  echo "== 显式停止不应被自动拉起 =="
  systemctl stop ai-debate
  sleep 4
  if systemctl is-active --quiet ai-debate; then
    fail "显式 systemctl stop 后服务仍活动"
  else
    pass "显式 systemctl stop 后保持停止"
  fi
  systemctl start ai-debate
  wait_ready && pass "显式 start 后服务恢复" || fail "显式 start 后服务未恢复"

  echo "== 升级保留自定义路径与数据 =="
  # Deliberately omit every path flag: the installer must recover them from the unit.
  ( cd "$PKG_DIR" && ./install.sh --host 127.0.0.1 --port "$PORT" ) >"${WORK}/upgrade-install.log" 2>&1 \
    && pass "省略路径参数的升级安装成功" || { fail "升级安装失败"; cat "${WORK}/upgrade-install.log"; exit 1; }
  [[ "$(systemctl show -p ReadWritePaths --value ai-debate)" == "$DATA_DIR" ]] \
    && pass "升级保留自定义 DATA_DIR" || fail "升级丢失自定义 DATA_DIR"
  if grep -Fqx "ExecStart=${PREFIX}/bin/ai-debate serve" /etc/systemd/system/ai-debate.service \
    && [[ -x "${PREFIX}/bin/ai-debate" ]]; then
    pass "升级保留自定义 PREFIX"
  else
    fail "升级丢失自定义 PREFIX"
    grep -F 'ExecStart=' /etc/systemd/system/ai-debate.service || true
  fi
  grep -q "$TOKEN" "${DATA_DIR}/upgrade-marker" && pass "升级保留用户数据" || fail "升级丢失用户数据"
  wait_ready && pass "升级后服务可用" || fail "升级后服务不可用"

  echo "== 卸载保留数据 =="
  ( cd "$PKG_DIR" && ./uninstall.sh ) >"${WORK}/uninstall.log" 2>&1 \
    && pass "卸载脚本读取自定义路径并成功" || { fail "卸载失败"; cat "${WORK}/uninstall.log"; exit 1; }
  INSTALLED=0
  systemctl is-active --quiet ai-debate && fail "卸载后服务仍活动" || pass "卸载后服务已停止"
  [[ ! -e "$PREFIX" ]] && pass "卸载删除自定义 prefix" || fail "自定义 prefix 未删除"
  [[ -f "${DATA_DIR}/state.json" && -f "${CONF_DIR}/ai-debate.env" ]] \
    && pass "卸载保留数据与配置" || fail "卸载删除或丢失数据/配置"
  [[ -f "$METADATA_FILE" ]] && grep -Fqx "AI_DEBATE_HOME=${DATA_DIR}" "$METADATA_FILE" \
    && pass "卸载保留自定义路径元数据供后续 purge 使用" || fail "自定义路径元数据未保留"
  [[ ! -e /etc/logrotate.d/ai-debate ]] && pass "卸载清理 logrotate 策略" || fail "logrotate 策略未清理"

  echo "== purge 二次确认 =="
  if ( cd "$PKG_DIR" && ./uninstall.sh --purge ) </dev/null >"${WORK}/purge-denied.log" 2>&1; then
    fail "非交互 purge 无二次确认时错误地成功"
  else
    grep -Fq "$DATA_DIR" "${WORK}/purge-denied.log" \
      && [[ -f "${DATA_DIR}/state.json" ]] \
      && pass "缺少二次确认时读取元数据拒绝 purge 且保留数据" || fail "缺少二次确认时未识别自定义数据目录"
  fi

  echo "== 重新安装并验证历史数据 =="
  ( cd "$PKG_DIR" && ./install.sh "${INSTALL_ARGS[@]}" ) >"${WORK}/reinstall.log" 2>&1 \
    && { pass "重新安装成功"; INSTALLED=1; } \
    || { fail "重新安装失败"; cat "${WORK}/reinstall.log"; exit 1; }
  wait_ready && pass "重新安装后服务可用" || fail "重新安装后服务不可用"
  grep -q "$SESSION" "${DATA_DIR}/state.json" && pass "重新安装后历史数据仍在" || fail "重新安装后历史数据丢失"

  echo "== 确认后的 purge =="
  ( cd "$PKG_DIR" && ./uninstall.sh --purge --confirm-purge ) >"${WORK}/purge.log" 2>&1 \
    && { pass "二次确认后的 purge 成功"; INSTALLED=0; } \
    || { fail "purge 失败"; cat "${WORK}/purge.log"; exit 1; }
  [[ ! -e "$DATA_DIR" && ! -e "$CONF_DIR" && ! -e "$PREFIX" ]] \
    && pass "purge 删除自定义数据、配置与程序目录" || fail "purge 未清理全部自定义目录"
  [[ ! -e "$METADATA_FILE" ]] && pass "purge 删除安装路径元数据" || fail "purge 后仍残留安装元数据"
  rmdir "/opt/ai-debate/${TOKEN}" 2>/dev/null || true
elif [[ "$INSTALLED" -eq 1 ]]; then
  echo "== 无 systemd：验证卸载读取测试 unit/env =="
  kill "$SERVICE_PID"; wait "$SERVICE_PID" 2>/dev/null || true
  SERVICE_PID=""
  ( cd "$PKG_DIR" && env "${INSTALL_ENV[@]}" ./uninstall.sh ) >"${WORK}/uninstall.log" 2>&1 \
    && { pass "无 systemd 卸载成功"; INSTALLED=0; } \
    || { fail "无 systemd 卸载失败"; cat "${WORK}/uninstall.log"; exit 1; }
  [[ -f "${DATA_DIR}/state.json" && -f "${CONF_DIR}/ai-debate.env" && ! -e "$PREFIX" ]] \
    && pass "无 systemd 卸载保留数据与配置" || fail "无 systemd 卸载路径处理错误"
  [[ -f "$METADATA_FILE" ]] && pass "无 systemd 卸载保留测试路径元数据" || fail "无 systemd 测试路径元数据缺失"
  if ( cd "$PKG_DIR" && env "${INSTALL_ENV[@]}" ./uninstall.sh --purge ) </dev/null >"${WORK}/purge-denied.log" 2>&1; then
    fail "无 systemd purge 无确认时错误地成功"
  else
    grep -Fq "$DATA_DIR" "${WORK}/purge-denied.log" \
      && [[ -f "${DATA_DIR}/state.json" ]] \
      && pass "无 systemd purge 从元数据识别自定义路径并要求确认" || fail "无 systemd purge 未识别自定义路径"
  fi
else
  skip "非 root 环境不验证 systemd 自动恢复与安装/卸载"
fi

echo
echo "${PASS}/$((PASS + FAIL)) 项通过"
[[ "$FAIL" -eq 0 ]] || exit 1
