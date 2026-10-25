#!/bin/sh
# 让本机 ~/.localhost-proxy 的 80 端口 Nginx 加载 agent-runner 路由。
# 只有第一次或改过 nginx.conf 后需要执行；需要管理员密码。
set -eu

CONF_DIR="$HOME/.localhost-proxy"
sh "$CONF_DIR/gen-index.sh"
sudo /usr/local/bin/nginx -t -p "$CONF_DIR" -c "$CONF_DIR/nginx.conf"
sudo launchctl kickstart -k system/dev.localhost.proxy
sleep 0.5
curl -fsS http://agent-runner.localhost/ -o /dev/null
curl -fsS http://agent-runner.localhost/api/live/dataset -o /dev/null
echo "入口已生效："
echo "  http://agent-runner.localhost/"
echo "  http://localhost/agent-runner/"
