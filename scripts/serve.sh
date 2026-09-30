#!/usr/bin/env bash
# 本地服务管理：前后端常驻启动/停止/健康检查
# 用法: ./scripts/serve.sh start|stop|restart|status
# 背景: 直接 `(npm run dev &)` 起的进程会随父 shell 退出被回收，
#       必须用 nohup + 独立 PID 文件才能常驻。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

RUN_DIR="$ROOT/.run"
LOG_DIR="$ROOT/.run/logs"
VITE_PID="$RUN_DIR/vite.pid"
API_PID="$RUN_DIR/api.pid"
VITE_PORT="${VITE_PORT:-5173}"
API_PORT="${API_PORT:-8123}"

TOKEN_FILE="$RUN_DIR/bridge.token"
mkdir -p "$RUN_DIR" "$LOG_DIR"

# 桥接令牌：首次生成后持久化，三处（后端/前端/MCP）共用同一个。
# 不设 BRIDGE_TOKEN 时后端会 fail-closed 拒绝所有桥接请求，这是有意的。
bridge_token() {
  if [[ -z "${BRIDGE_TOKEN:-}" && -s "$TOKEN_FILE" ]]; then
    BRIDGE_TOKEN="$(cat "$TOKEN_FILE")"
  fi
  if [[ -z "${BRIDGE_TOKEN:-}" ]]; then
    BRIDGE_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf '%s' "$BRIDGE_TOKEN" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
  fi
  export BRIDGE_TOKEN
  export VITE_BRIDGE_TOKEN="$BRIDGE_TOKEN"
}

alive() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

port_up() { curl -s -m 3 -o /dev/null "http://127.0.0.1:$1" 2>/dev/null; }

start_vite() {
  bridge_token
  if alive "$VITE_PID"; then echo "vite 已在运行 (pid $(cat "$VITE_PID"))"; return; fi
  nohup npm run dev -- --port "$VITE_PORT" --host \
    > "$LOG_DIR/vite.log" 2>&1 &
  echo $! > "$VITE_PID"
  disown 2>/dev/null
  echo "vite 已启动 (pid $(cat "$VITE_PID")) -> http://localhost:$VITE_PORT/"
}

start_api() {
  bridge_token
  # 8123 常年被 ~/AI/bin/ai-daemon.py 反向代理占用（它托管各项目后端）。
  # 已有服务在跑就只健康检查，不要重复拉起 uvicorn 造成端口冲突。
  if alive "$API_PID"; then echo "api 已在运行 (pid $(cat "$API_PID"))"; return; fi
  if port_up "$API_PORT"; then
    echo "api 已被本机服务代理接管 (:$API_PORT)，跳过自启"
    if ! curl -s -m 3 "http://127.0.0.1:$API_PORT/bridge/health" | grep -q '"enabled":true'; then
      echo "  ⚠ 代理后的后端桥接未启用（旧代码或未带 BRIDGE_TOKEN），Agent 桥接不可用；需重启代理托管的后端"
    fi
    return
  fi
  local py="backend/.venv/bin/python"
  [[ -x "$py" ]] || py="python3"
  nohup "$py" -m uvicorn backend.main:app --host 0.0.0.0 --port "$API_PORT" \
    > "$LOG_DIR/api.log" 2>&1 &
  echo $! > "$API_PID"
  disown 2>/dev/null
  echo "api 已启动 (pid $(cat "$API_PID")) -> http://127.0.0.1:$API_PORT/health"
}

stop_one() {
  local pidfile="$1" name="$2"
  # 不动 ai-daemon 代理（不是本项目进程）
  if ! alive "$pidfile"; then echo "$name 未运行 (可能由外部代理托管)"; rm -f "$pidfile"; return; fi
  local pid; pid="$(cat "$pidfile")"
  pkill -P "$pid" 2>/dev/null
  kill "$pid" 2>/dev/null
  sleep 1
  kill -9 "$pid" 2>/dev/null
  rm -f "$pidfile"
  echo "$name 已停止"
}

wait_up() {
  local port="$1" name="$2" mode="${3:-port}" tries=30
  while (( tries-- > 0 )); do
    if port_up "$port"; then
      # api 需校验响应体确属本项目，避免撞到占用同端口的其它服务
      if [[ "$mode" == "health" ]]; then
        if curl -s -m 3 "http://127.0.0.1:$port/health" 2>/dev/null | grep -q '"ok"'; then
          echo "$name 健康检查通过 (:$port)"; return 0
        fi
      else
        echo "$name 可访问 (:$port)"; return 0
      fi
    fi
    sleep 1
  done
  echo "$name 启动超时 (:$port)，见 $LOG_DIR"
  return 1
}

case "${1:-start}" in
  start)
    start_vite; start_api
    wait_up "$VITE_PORT" vite port
    wait_up "$API_PORT" api health
    echo "桥接令牌 (.run/bridge.token, 三处共用): $(cut -c1-8)…$(printf '%s' "$BRIDGE_TOKEN" | tail -c 5)"
    ;;
  stop)
    stop_one "$VITE_PID" vite
    stop_one "$API_PID" api
    ;;
  restart)
    "$0" stop; sleep 1; "$0" start
    ;;
  status)
    alive "$VITE_PID" && echo "vite: 运行 (pid $(cat "$VITE_PID"))" || echo "vite: 未运行"
    alive "$API_PID"  && echo "api:  运行 (pid $(cat "$API_PID"))"  || echo "api:  未运行"
    port_up "$VITE_PORT" && echo "  -> :$VITE_PORT 可访问" || echo "  -> :$VITE_PORT 不可访问"
    port_up "$API_PORT"  && echo "  -> :$API_PORT 可访问"  || echo "  -> :$API_PORT 不可访问"
    curl -s -m 3 "http://127.0.0.1:$API_PORT/bridge/health" 2>/dev/null | grep -q '"enabled":true' \
      && echo "  -> 桥接鉴权: 已启用" || echo "  -> 桥接鉴权: 未启用（Agent 桥接将不可用）"
    ;;
  *)
    echo "用法: $0 start|stop|restart|status"; exit 1
    ;;
esac
