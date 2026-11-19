#!/usr/bin/env bash
#
# Linux acceptance: install the archive for real, start the installed service,
# complete the core workflow over HTTP, restart and prove the state survived.
#
# Run on a throw-away machine or a CI runner:
#   sudo ./test/acceptance/linux-install.sh dist/ai-debate-linux-x64.tgz
#
# It deliberately uses the *installed* path (/opt/ai-debate/bin/ai-debate) rather
# than the extracted one, because "the tarball contains a working binary" and "the
# installer produces a working service" are different claims.
set -euo pipefail

ARCHIVE="${1:-dist/ai-debate-linux-x64.tgz}"
PORT=17862
MOCK_PORT=17863
WORK="$(mktemp -d)"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "✔ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "✖ $1"; }

cleanup() {
  [[ -n "${SERVICE_PID:-}" ]] && kill "${SERVICE_PID}" 2>/dev/null || true
  [[ -n "${MOCK_PID:-}" ]] && kill "${MOCK_PID}" 2>/dev/null || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

if [[ ! -f "${ARCHIVE}" ]]; then
  echo "找不到安装包：${ARCHIVE}" >&2
  exit 1
fi

# A mock OpenAI-compatible endpoint so the model step is real HTTP, not a stub.
# When the service runs inside a container that shares the host network (the CI
# systemd job), the caller starts this on the host and passes AI_DEBATE_MOCK_URL.
if [[ -n "${AI_DEBATE_MOCK_URL:-}" ]]; then
  echo "使用外部模型地址 ${AI_DEBATE_MOCK_URL}"
  MOCK_PID=""
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

echo "== 解压并安装 =="
mkdir -p "${WORK}/pkg"
tar -xzf "${ARCHIVE}" -C "${WORK}/pkg"
( cd "${WORK}/pkg/ai-debate-linux-x64" && sha256sum -c SHA256SUMS --quiet ) && pass "安装包 SHA256 校验" || fail "安装包 SHA256 校验"

SYSTEMD=0
if [[ "$(id -u)" -eq 0 ]]; then
  if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
    SYSTEMD=1
    echo "== 检测到运行中的 systemd：走真实安装（含开机自启）=="
    # Default paths on purpose: the unit sets ProtectSystem=strict and whitelists
    # /opt + /var/lib, so installing into a temp directory would leave the service
    # unable to write its own data — a harness failure, not a product one.
    ( cd "${WORK}/pkg/ai-debate-linux-x64" && ./install.sh --host 127.0.0.1 --port "${PORT}" ) \
      && pass "安装脚本执行（systemd 模式）" || fail "安装脚本执行"
    STATE_DIR="/var/lib/ai-debate"
    BIN="/opt/ai-debate/bin/ai-debate"
    # The real proof: systemd says the unit is active, not that we spawned a process.
    for _ in $(seq 1 40); do
      if systemctl is-active --quiet ai-debate; then break; fi
      sleep 0.5
    done
    systemctl is-active --quiet ai-debate && pass "systemctl 报告服务 active" || fail "systemctl 报告服务 active"
    systemctl is-enabled --quiet ai-debate && pass "systemd 已 enable（开机自启）" || fail "systemd 已 enable"
  else
    echo "== 没有运行中的 systemd：退化为手工启动 =="
    ( cd "${WORK}/pkg/ai-debate-linux-x64" && ./install.sh --host 127.0.0.1 --port "${PORT}" --data-dir "${WORK}/data" --prefix "${WORK}/opt" --no-start ) \
      && pass "安装脚本执行" || fail "安装脚本执行"
    STATE_DIR="${WORK}/data"
    BIN="${WORK}/opt/bin/ai-debate"
  fi
else
  echo "非 root：跳过 install.sh，直接使用解压出的二进制"
  STATE_DIR="${WORK}/data"
  BIN="${WORK}/pkg/ai-debate-linux-x64/bin/ai-debate"
fi

[[ -x "${BIN}" ]] && pass "程序可执行" || fail "程序缺失"

echo "== 启动已安装的程序 =="
if [[ "${SYSTEMD}" -eq 1 ]]; then
  # systemd owns the process; the config file written by install.sh points at the
  # same data directory, so this exercises the real unit rather than a copy of it.
  SERVICE_PID=""
else
  AI_DEBATE_HOME="${STATE_DIR}" "${BIN}" serve --port "${PORT}" > "${WORK}/service.log" 2>&1 &
  SERVICE_PID=$!
fi

ready=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
[[ "${ready}" -eq 1 ]] && pass "服务启动并响应 /healthz" || { fail "服务启动"; cat "${WORK}/service.log"; exit 1; }

JAR="${WORK}/cookies.txt"
api() {
  local method="$1" path="$2" body="${3:-}"
  curl -sS -b "${JAR}" -c "${JAR}" -X "${method}" \
    -H 'content-type: application/json' -H "origin: http://127.0.0.1:${PORT}" \
    ${body:+--data "${body}"} \
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
[[ -n "${SESSION}" ]] && pass "导入并确认讨论" || fail "导入讨论"

GEN=$(api POST /api/ai-debate/action "{\"action\":\"manual-generate\",\"sessionId\":\"${SESSION}\",\"targetPostId\":\"c2\"}")
CANDIDATE=$(node -e 'const j=JSON.parse(process.argv[1]);console.log(j.candidateId||"")' "${GEN}")
[[ -n "${CANDIDATE}" ]] && pass "生成候选" || fail "生成候选"

api POST /api/ai-debate/action "{\"action\":\"manual-edit\",\"sessionId\":\"${SESSION}\",\"candidateId\":\"${CANDIDATE}\",\"text\":\"你举的例子只能说明有人这样，不能代表所有人。\"}" >/dev/null
api POST /api/ai-debate/action "{\"action\":\"manual-approve\",\"sessionId\":\"${SESSION}\",\"candidateId\":\"${CANDIDATE}\",\"approvedText\":\"你举的例子只能说明有人这样，不能代表所有人。\"}" | grep -q '"ok":true' && pass "人工批准" || fail "人工批准"

echo "== 重启，验证持久化 =="
if [[ "${SYSTEMD}" -eq 1 ]]; then
  systemctl restart ai-debate
  sleep 1
else
  kill "${SERVICE_PID}"; wait "${SERVICE_PID}" 2>/dev/null || true
  AI_DEBATE_HOME="${STATE_DIR}" "${BIN}" serve --port "${PORT}" >> "${WORK}/service.log" 2>&1 &
  SERVICE_PID=$!
fi
ready=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
[[ "${ready}" -eq 1 ]] && pass "重启后服务可用" || fail "重启后服务"

api GET /api/ai-debate/settings | grep -q '"status":"ready"' && pass "重启后会话仍有效" || fail "重启后会话"
grep -q "${SESSION}" "${STATE_DIR}/state.json" && pass "重启后会话数据仍在" || fail "重启后数据"

if [[ "${SYSTEMD}" -eq 1 ]]; then
  echo "== 强制 kill -9，验证 systemd 自动拉起 =="
  MAIN_PID=$(systemctl show -p MainPID --value ai-debate)
  [[ -n "${MAIN_PID}" && "${MAIN_PID}" != "0" ]] && pass "读到服务主进程 PID" || fail "读到服务主进程 PID"
  kill -9 "${MAIN_PID}" 2>/dev/null || true
  restarted=0
  for _ in $(seq 1 40); do
    NEW_PID=$(systemctl show -p MainPID --value ai-debate)
    if [[ -n "${NEW_PID}" && "${NEW_PID}" != "0" && "${NEW_PID}" != "${MAIN_PID}" ]] && systemctl is-active --quiet ai-debate; then
      restarted=1; break
    fi
    sleep 0.5
  done
  [[ "${restarted}" -eq 1 ]] && pass "进程被 kill -9 后由 systemd 自动拉起" || fail "进程被 kill -9 后由 systemd 自动拉起"
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 && pass "拉起后再次可服务" || fail "拉起后再次可服务"

  echo "== 卸载（保留数据）=="
  ( cd "${WORK}/pkg/ai-debate-linux-x64" && ./uninstall.sh ) >/dev/null 2>&1 || true
  systemctl is-active --quiet ai-debate && fail "卸载后服务仍活动" || pass "卸载后服务已停止"
  [[ -f "${STATE_DIR}/state.json" ]] && pass "卸载保留用户数据" || fail "卸载保留用户数据"

  echo "== 重新安装并启动，验证升级不丢数据 =="
  ( cd "${WORK}/pkg/ai-debate-linux-x64" && ./install.sh --host 127.0.0.1 --port "${PORT}" ) >/dev/null 2>&1
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  grep -q "${SESSION}" "${STATE_DIR}/state.json" && pass "重新安装后历史数据仍在" || fail "重新安装后历史数据仍在"
  if [[ -f "${STATE_DIR}/monitors.json" ]]; then
    pass "监控配置文件随数据目录保留"
  else
    echo "  （本次运行未创建监控目标，跳过 monitors.json 检查）"
  fi
fi

echo
echo "${PASS}/$((PASS + FAIL)) 项通过"
[[ "${FAIL}" -eq 0 ]] || exit 1
