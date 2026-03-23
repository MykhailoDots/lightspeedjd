#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PID_FILE="${ROOT_DIR}/.lightspeed-web.pid"
LOG_FILE="${ROOT_DIR}/.lightspeed-web.log"
SCREEN_SESSION_NAME="${LSK_WEB_SCREEN_SESSION:-lightspeed-web}"

load_env_file() {
  local file="$1"
  if [[ -f "${file}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${file}"
    set +a
  fi
}

load_env_file "${ROOT_DIR}/.env"
load_env_file "${ROOT_DIR}/.env.local"

required_vars=(
  LSK_CLIENT_ID
  LSK_CLIENT_SECRET
  LSK_REFRESH_TOKEN
  LSK_REDIRECT_URI
  LSK_BUSINESS_LOCATION_ID_1
)

require_env() {
  local missing=()
  for key in "${required_vars[@]}"; do
    if [[ -z "${!key:-}" ]]; then
      missing+=("${key}")
    fi
  done

  if (( ${#missing[@]} > 0 )); then
    echo "Missing env vars: ${missing[*]}"
    exit 1
  fi
}

read_pid() {
  cat "${PID_FILE}" 2>/dev/null || true
}

find_screen_id() {
  if ! command -v screen >/dev/null 2>&1; then
    return 0
  fi
  (screen -ls 2>/dev/null || true) | awk -v session="${SCREEN_SESSION_NAME}" '
    $1 ~ ("[0-9]+\\." session "$") { split($1, parts, "."); print parts[1]; exit }
  '
}

is_screen_running() {
  [[ -n "$(find_screen_id)" ]]
}

is_running() {
  local pid
  pid="$(read_pid)"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
    return 0
  fi

  if is_screen_running; then
    return 0
  fi

  return 1
}

get_wifi_ip() {
  ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "127.0.0.1"
}

find_url_in_log() {
  grep -Eo 'http://localhost:[0-9]+' "${LOG_FILE}" 2>/dev/null | tail -n1 || true
}

check_health_on_port() {
  local port="$1"
  curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1
}

wait_for_health() {
  local max_attempts=25
  local attempt=1
  local base_port="${LSK_WEB_PORT:-8787}"

  while (( attempt <= max_attempts )); do
    local url
    url="$(find_url_in_log)"
    if [[ -n "${url}" ]] && check_health_on_port "${url##*:}"; then
      echo "${url}"
      return 0
    fi

    local port
    for port in $(seq "${base_port}" "$((base_port + 12))"); do
      if check_health_on_port "${port}"; then
        echo "http://localhost:${port}"
        return 0
      fi
    done

    sleep 1
    ((attempt++))
  done

  return 1
}

kill_orphan_web_processes() {
  # Clean stale detached workers from previous runs.
  pkill -f "scripts/lightspeed-web.ts" >/dev/null 2>&1 || true
  pkill -f "npm exec tsx ./scripts/lightspeed-web.ts" >/dev/null 2>&1 || true
  pkill -f "npx tsx ./scripts/lightspeed-web.ts" >/dev/null 2>&1 || true
}

stop_server() {
  local stopped_any=0

  if is_screen_running; then
    screen -S "${SCREEN_SESSION_NAME}" -X quit >/dev/null 2>&1 || true
    stopped_any=1
    sleep 0.5
  fi

  local pid
  pid="$(read_pid)"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
    pkill -TERM -P "${pid}" 2>/dev/null || true
    kill "${pid}" 2>/dev/null || true
    sleep 1
    if kill -0 "${pid}" 2>/dev/null; then
      pkill -KILL -P "${pid}" 2>/dev/null || true
      kill -9 "${pid}" 2>/dev/null || true
    fi
    stopped_any=1
  fi

  rm -f "${PID_FILE}"
  kill_orphan_web_processes

  if (( stopped_any == 0 )); then
    echo "Not running."
  else
    echo "Stopped."
  fi
}

start_server() {
  require_env
  cd "${ROOT_DIR}"

  if is_running; then
    local pid
    pid="$(read_pid)"
    if [[ -z "${pid}" ]] && is_screen_running; then
      pid="$(find_screen_id)"
    fi
    local local_url
    local_url="$(find_url_in_log)"
    echo "Already running (supervisor pid ${pid}) ${local_url}"
    return 0
  fi

  : > "${LOG_FILE}"

  local runner_cmd
  if command -v bun >/dev/null 2>&1; then
    runner_cmd="bun run lightspeed:web"
  elif [[ -x "${ROOT_DIR}/node_modules/.bin/tsx" ]]; then
    runner_cmd="'${ROOT_DIR}/node_modules/.bin/tsx' ./scripts/lightspeed-web.ts"
  else
    runner_cmd="npx tsx ./scripts/lightspeed-web.ts"
  fi

  if command -v screen >/dev/null 2>&1; then
    screen -dmS "${SCREEN_SESSION_NAME}" bash -lc "
      cd '${ROOT_DIR}'
      while true; do
        ${runner_cmd} >> '${LOG_FILE}' 2>&1
        code=\$?
        echo \"[\$(date '+%Y-%m-%d %H:%M:%S')] [watchdog] web exited with code \${code}; restarting in 2s\" >> '${LOG_FILE}'
        sleep 2
      done
    "

    sleep 1
    local screen_pid
    screen_pid="$(find_screen_id)"
    if [[ -z "${screen_pid}" ]]; then
      echo "Failed to start screen watchdog session."
      tail -n 120 "${LOG_FILE}" || true
      exit 1
    fi
    echo "${screen_pid}" > "${PID_FILE}"
  else
    nohup bash -lc "
      cd '${ROOT_DIR}'
      while true; do
        ${runner_cmd} >> '${LOG_FILE}' 2>&1
        code=\$?
        echo \"[\$(date '+%Y-%m-%d %H:%M:%S')] [watchdog] web exited with code \${code}; restarting in 2s\" >> '${LOG_FILE}'
        sleep 2
      done
    " >/dev/null 2>&1 &

    local pid="$!"
    echo "${pid}" > "${PID_FILE}"
    sleep 1

    if ! kill -0 "${pid}" 2>/dev/null; then
      echo "Failed to start watchdog process."
      tail -n 120 "${LOG_FILE}" || true
      exit 1
    fi
  fi

  local local_url
  if ! local_url="$(wait_for_health)"; then
    echo "Watchdog is running but web health check failed."
    tail -n 120 "${LOG_FILE}" || true
    exit 1
  fi

  local wifi_ip
  wifi_ip="$(get_wifi_ip)"
  local wifi_url="${local_url/localhost/${wifi_ip}}"

  local pid
  pid="$(read_pid)"
  echo "Started watchdog (pid ${pid})"
  if is_screen_running; then
    echo "Screen session: ${SCREEN_SESSION_NAME}"
  fi
  echo "Local URL: ${local_url}"
  echo "Wi-Fi URL: ${wifi_url}"
}

status_server() {
  if ! is_running; then
    echo "Not running."
    return 1
  fi

  local pid
  pid="$(read_pid)"
  if [[ -z "${pid}" ]] && is_screen_running; then
    pid="$(find_screen_id)"
  fi
  local local_url
  local_url="$(wait_for_health || true)"
  if [[ -z "${local_url}" ]]; then
    local_url="$(find_url_in_log)"
  fi
  if [[ -z "${local_url}" ]]; then
    local_url="http://localhost:${LSK_WEB_PORT:-8787}"
  fi
  local wifi_ip
  wifi_ip="$(get_wifi_ip)"
  local wifi_url="${local_url/localhost/${wifi_ip}}"

  echo "Running (watchdog pid ${pid})"
  echo "Local URL: ${local_url}"
  echo "Wi-Fi URL: ${wifi_url}"
  if curl -fsS "${local_url}/health" >/dev/null 2>&1; then
    echo "Health: OK"
  else
    echo "Health: DOWN"
    return 1
  fi
}

logs_server() {
  tail -n 120 "${LOG_FILE}" || true
}

restart_server() {
  stop_server
  start_server
}

command="${1:-up}"
case "${command}" in
  up) start_server ;;
  down) stop_server ;;
  restart) restart_server ;;
  status) status_server ;;
  logs) logs_server ;;
  *)
    echo "Usage: $0 {up|down|restart|status|logs}"
    exit 1
    ;;
esac
