#!/bin/sh
# Agent Runner 本地服务：静态页面 + 实时数据 SSE + Multica 桥接
# 用法：scripts/service.sh start|stop|restart|status
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PORT=${PORT:-8796}
HOST=${HOST:-127.0.0.1}
RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/agent-runner.pid"
LOG_FILE="$RUN_DIR/agent-runner.log"
mkdir -p "$RUN_DIR"

is_running() {
  [ -f "$PID_FILE" ] || return 1
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

start() {
  if is_running; then
    echo "已在运行：pid $(cat "$PID_FILE") · http://$HOST:$PORT/"
    return 0
  fi
  rm -f "$PID_FILE"
  cd "$ROOT" || exit 1
  PORT="$PORT" HOST="$HOST" nohup node scripts/serve.mjs >>"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  i=0
  while [ "$i" -lt 50 ]; do
    if curl -fsS "http://$HOST:$PORT/api/live/dataset" -o /dev/null 2>/dev/null; then
      echo "已启动：http://$HOST:$PORT/ · pid $(cat "$PID_FILE")"
      return 0
    fi
    sleep 0.2
    i=$((i + 1))
  done
  echo "启动超时，检查日志：$LOG_FILE" >&2
  return 1
}

stop() {
  if ! is_running; then
    echo "未运行"
    rm -f "$PID_FILE"
    return 0
  fi
  pid=$(cat "$PID_FILE")
  kill "$pid" 2>/dev/null || true
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 25 ]; do sleep 0.2; i=$((i + 1)); done
  if kill -0 "$pid" 2>/dev/null; then
    echo "进程 $pid 未退出，请手动检查" >&2
    return 1
  fi
  rm -f "$PID_FILE"
  echo "已停止"
}

status() {
  if is_running; then
    echo "运行中：pid $(cat "$PID_FILE") · http://$HOST:$PORT/"
    curl -fsS "http://$HOST:$PORT/api/live/dataset" -o /dev/null 2>/dev/null \
      && echo "实时数据：可访问" || echo "实时数据：不可访问"
  else
    echo "未运行"
    return 1
  fi
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "用法：$0 start|stop|restart|status" >&2; exit 1 ;;
esac
