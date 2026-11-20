#!/usr/bin/env bash
#
# Shared Linux deployment path policy. Source this file; it deliberately has no
# side effects so the acceptance suite can exercise the policy without installing.

APP_NAME="ai-debate"
APP_USER="ai-debate"
DEFAULT_PREFIX="/opt/ai-debate"
DEFAULT_DATA_DIR="/var/lib/ai-debate"
DEFAULT_CONF_DIR="/etc/ai-debate"
INSTALL_METADATA_NAME=".install-paths"

# Keep paths safe in systemd's unquoted Environment=/ExecStart= syntax, in
# ReadWritePaths' comma-separated list, and in the shell tools used below.
PATH_CHARACTERS='^/[A-Za-z0-9._/@:+-]+$'

path_policy_error() {
  printf '%s\n' "$*" >&2
  return 2
}

validate_path_text() {
  local label="$1" value="$2"
  if [[ "$value" != /* ]]; then
    path_policy_error "$label 必须是绝对路径：$value"
    return $?
  fi
  if [[ ! "$value" =~ $PATH_CHARACTERS ]]; then
    path_policy_error "$label 含空白、控制字符或 systemd/shell 特殊字符，仅允许字母、数字及 . _ / @ : + -：$value"
    return $?
  fi
  return 0
}

canonical_deployment_path() {
  local label="$1" value="$2" canonical
  validate_path_text "$label" "$value" || return $?
  canonical="$(realpath -m -- "$value")" || {
    path_policy_error "$label 无法解析：$value"
    return $?
  }
  validate_path_text "$label" "$canonical" || return $?
  printf '%s\n' "$canonical"
}

is_path_within() {
  local child="$1" parent="$2"
  [[ "$child" == "$parent" || "$child" == "$parent/"* ]]
}

is_protected_system_path() {
  local value="$1"
  case "$value" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib32|/lib64|/libx32|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/usr/bin|/usr/sbin|/usr/lib|/usr/lib64|/usr/local|/var|/var/lib|/var/log|/var/cache|/var/spool|/var/tmp)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

validate_test_root() {
  local canonical mode owner
  if [[ -z "${AI_DEBATE_INSTALL_TEST_ROOT:-}" ]]; then
    return 0
  fi
  if [[ "${AI_DEBATE_INSTALL_TEST:-}" != "1" ]]; then
    path_policy_error "测试根目录必须同时设置 AI_DEBATE_INSTALL_TEST=1；生产安装不得设置这些变量。"
    return $?
  fi
  validate_path_text "测试根目录" "$AI_DEBATE_INSTALL_TEST_ROOT" || return $?
  if [[ ! -d "$AI_DEBATE_INSTALL_TEST_ROOT" || -L "$AI_DEBATE_INSTALL_TEST_ROOT" ]]; then
    path_policy_error "测试根目录必须是已有的真实目录，不能是符号链接：$AI_DEBATE_INSTALL_TEST_ROOT"
    return $?
  fi
  canonical="$(realpath -e -- "$AI_DEBATE_INSTALL_TEST_ROOT")" || return $?
  if is_protected_system_path "$canonical"; then
    path_policy_error "拒绝把系统目录作为测试根目录：$canonical"
    return $?
  fi
  if ! is_path_within "$canonical" /tmp && ! is_path_within "$canonical" /var/tmp; then
    path_policy_error "测试根目录必须位于 /tmp 或 /var/tmp 下：$canonical"
    return $?
  fi
  mode="$(stat -c '%a' -- "$canonical")" || return $?
  owner="$(stat -c '%u' -- "$canonical")" || return $?
  if [[ "$owner" != "0" || "$mode" != "700" ]]; then
    path_policy_error "测试根目录必须由 root 拥有且权限为 0700（当前 ${owner}:${mode}）：$canonical"
    return $?
  fi
  AI_DEBATE_INSTALL_TEST_ROOT="$canonical"
}

validate_production_path() {
  local label="$1" kind="$2" canonical="$3"
  case "$kind" in
    prefix)
      if [[ "$canonical" == "/opt/ai-debate" || "$canonical" == "/usr/local/ai-debate" ]] \
        || { [[ "$canonical" == /opt/ai-debate/* || "$canonical" == /usr/local/ai-debate/* ]] && [[ "$(basename -- "$canonical")" == "ai-debate" ]]; }; then
        return 0
      fi
      path_policy_error "$label 必须位于 /opt/ai-debate 或 /usr/local/ai-debate 下，且以 /ai-debate 结尾：$canonical"
      ;;
    data)
      if is_path_within "$canonical" "/var/lib/ai-debate" || is_path_within "$canonical" "/srv/ai-debate"; then
        return 0
      fi
      path_policy_error "$label 必须位于 /var/lib/ai-debate 或 /srv/ai-debate 下：$canonical"
      ;;
    conf)
      if is_path_within "$canonical" "/etc/ai-debate"; then
        return 0
      fi
      path_policy_error "$label 必须位于 /etc/ai-debate 下：$canonical"
      ;;
    *)
      path_policy_error "未知路径类型：$kind"
      ;;
  esac
  return $?
}

validate_deployment_paths() {
  local prefix="$1" data_dir="$2" conf_dir="$3"
  local canonical_prefix canonical_data canonical_conf
  validate_test_root || return $?
  canonical_prefix="$(canonical_deployment_path "安装目录" "$prefix")" || return $?
  canonical_data="$(canonical_deployment_path "数据目录" "$data_dir")" || return $?
  canonical_conf="$(canonical_deployment_path "配置目录" "$conf_dir")" || return $?

  if [[ -n "${AI_DEBATE_INSTALL_TEST_ROOT:-}" ]]; then
    if ! is_path_within "$canonical_prefix" "$AI_DEBATE_INSTALL_TEST_ROOT" \
      || ! is_path_within "$canonical_data" "$AI_DEBATE_INSTALL_TEST_ROOT" \
      || ! is_path_within "$canonical_conf" "$AI_DEBATE_INSTALL_TEST_ROOT"; then
      path_policy_error "测试安装的三个目录都必须位于测试根目录 ${AI_DEBATE_INSTALL_TEST_ROOT} 内。"
      return $?
    fi
    if [[ "$canonical_prefix" == "$AI_DEBATE_INSTALL_TEST_ROOT" \
      || "$canonical_data" == "$AI_DEBATE_INSTALL_TEST_ROOT" \
      || "$canonical_conf" == "$AI_DEBATE_INSTALL_TEST_ROOT" ]]; then
      path_policy_error "测试安装目录不能等于测试根目录本身。"
      return $?
    fi
  else
    validate_production_path "安装目录" prefix "$canonical_prefix" || return $?
    validate_production_path "数据目录" data "$canonical_data" || return $?
    validate_production_path "配置目录" conf "$canonical_conf" || return $?
  fi

  if is_path_within "$canonical_prefix" "$canonical_data" || is_path_within "$canonical_data" "$canonical_prefix" \
    || is_path_within "$canonical_prefix" "$canonical_conf" || is_path_within "$canonical_conf" "$canonical_prefix" \
    || is_path_within "$canonical_data" "$canonical_conf" || is_path_within "$canonical_conf" "$canonical_data"; then
    path_policy_error "安装目录、数据目录与配置目录不能相同或互相嵌套。"
    return $?
  fi

  PREFIX="$canonical_prefix"
  DATA_DIR="$canonical_data"
  CONF_DIR="$canonical_conf"
}

# Read one unambiguous KEY=value from a systemd unit without sourcing or eval'ing
# administrator-controlled content. EnvironmentFile's optional '-' is ignored.
# Pass 0 as the fourth argument to allow a missing key; duplicates still fail.
read_unit_value() {
  local file="$1" key="$2" label="$3" required="${4:-1}"
  local -a values=()
  local line value
  if [[ ! -f "$file" ]]; then
    path_policy_error "找不到已安装的 unit：$file"
    return $?
  fi
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*"${key}"= ]] || continue
    value="${line#*"${key}"=}"
    value="${value#-}"
    value="${value%"${value##*[![:space:]]}"}"
    [[ -n "$value" ]] && values+=("$value")
  done < "$file"
  if [[ "${#values[@]}" -eq 0 && "$required" == "0" ]]; then
    return 1
  fi
  if [[ "${#values[@]}" -ne 1 ]]; then
    path_policy_error "已安装 unit 的 ${label} 必须恰好出现一次（当前 ${#values[@]} 次）。"
    return $?
  fi
  printf '%s\n' "${values[0]}"
}

read_env_value() {
  local file="$1" key="$2" label="$3"
  local -a values=()
  local line value
  if [[ ! -f "$file" ]]; then
    return 1
  fi
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*"${key}"= ]] || continue
    value="${line#*=}"
    value="${value%"${value##*[![:space:]]}"}"
    [[ -n "$value" ]] && values+=("$value")
  done < "$file"
  if [[ "${#values[@]}" -gt 1 ]]; then
    path_policy_error "配置文件中的 ${label} 出现了多次。"
    return $?
  fi
  if [[ "${#values[@]}" -eq 1 ]]; then
    printf '%s\n' "${values[0]}"
    return 0
  fi
  return 1
}

# Render placeholders in one pass. Unlike chained sed replacements, text inserted
# for one placeholder is never interpreted as another placeholder.
render_template() {
  local source_file="$1" destination_file="$2"
  local line rest output token prefix
  while IFS= read -r line || [[ -n "$line" ]]; do
    rest="$line"
    output=""
    while [[ "$rest" =~ (@PREFIX@|@DATA_DIR@|@CONF_DIR@|@APP_USER@) ]]; do
      token="${BASH_REMATCH[1]}"
      prefix="${rest%%"$token"*}"
      output+="$prefix"
      case "$token" in
        @PREFIX@) output+="$PREFIX" ;;
        @DATA_DIR@) output+="$DATA_DIR" ;;
        @CONF_DIR@) output+="$CONF_DIR" ;;
        @APP_USER@) output+="$APP_USER" ;;
      esac
      rest="${rest#*"$token"}"
    done
    printf '%s%s\n' "$output" "$rest"
  done < "$source_file" > "$destination_file"
}

install_metadata_path() {
  if [[ -n "${AI_DEBATE_INSTALL_TEST_ROOT:-}" ]]; then
    if [[ "${AI_DEBATE_INSTALL_TEST:-}" != "1" ]]; then
      path_policy_error "测试安装元数据要求 AI_DEBATE_INSTALL_TEST=1。"
      return $?
    fi
    printf '%s/%s\n' "$AI_DEBATE_INSTALL_TEST_ROOT" "$INSTALL_METADATA_NAME"
  else
    printf '/etc/ai-debate/%s\n' "$INSTALL_METADATA_NAME"
  fi
}

# Keep a root-owned path record after a non-purge uninstall removes the unit, so
# a later confirmed purge can still find custom directories. The file is parsed
# as KEY=value data by the uninstaller, never sourced as shell code.
write_install_metadata() {
  local metadata metadata_dir temporary
  metadata="$(install_metadata_path)" || return $?
  metadata_dir="$(dirname -- "$metadata")"
  if [[ -n "${AI_DEBATE_INSTALL_TEST_ROOT:-}" ]]; then
    if [[ ! -d "$metadata_dir" || -L "$metadata_dir" ]]; then
      path_policy_error "测试元数据目录不是真实目录：$metadata_dir"
      return $?
    fi
  else
    install -d -m 0755 -o root -g root "$metadata_dir" || return $?
  fi
  if [[ -L "$metadata" ]]; then
    path_policy_error "拒绝写入符号链接安装元数据：$metadata"
    return $?
  fi
  temporary="$(mktemp "${metadata}.XXXXXX")" || return $?
  if ! {
    printf 'AI_DEBATE_PREFIX=%s\n' "$PREFIX"
    printf 'AI_DEBATE_HOME=%s\n' "$DATA_DIR"
    printf 'AI_DEBATE_CONF_DIR=%s\n' "$CONF_DIR"
  } > "$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  chown root:root "$temporary" || { rm -f -- "$temporary"; return 1; }
  chmod 0640 "$temporary" || { rm -f -- "$temporary"; return 1; }
  mv -f -- "$temporary" "$metadata"
}
