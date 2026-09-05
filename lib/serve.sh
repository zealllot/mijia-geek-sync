#!/usr/bin/env bash
#
# mgs serve <网关> —— 在本机开一个模式看板，浏览器上直观看各种模式参数。
#
#   mgs serve 1302                  起服务并打开浏览器
#   mgs serve 1302 --init-config    从活着的网关生成一份语义地图骨架（打到 stdout）
#
# 这是给**你自己**用的入口，用本机的 node 和本机的 xgg。
# 给住户的是 tools/build-app.sh 打出来的 .app —— 同一份代码，自带 Node 运行时。
#
# 看板只读规则启用状态和变量当前值，只有配置里显式声明成 toggle 的变量能写。
# 它永远不改规则的启用状态 —— 那是 mgs enable 的事。
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

GW="${1:?用法: mgs serve <网关名|http://地址> [--init-config] [--port N]}"
shift
mgs_setup "$GW"

PORT=7391
INIT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --init-config) INIT=1 ;;
    --port) PORT="${2:?--port 后面要给端口}"; shift ;;
    *) die "不认识的参数: $1" ;;
  esac
  shift
done

DASH="$MGS_ROOT/dashboard"
STATE="$(mgs_data_dir "$GW")/dashboard"
mkdir -p "$STATE"

export MGS_DASH_BASE_URL="$XGG_BASE_URL"
export MGS_DASH_XGG="$MGS_XGG"
export MGS_DASH_STATE_DIR="$STATE"
export MGS_DASH_CONFIG="${MGS_DASH_CONFIG:-$STATE/dashboard.json}"
export MGS_DASH_PORT="$PORT"
export MGS_DASH_RUNTIME_VARS="$(mgs_cfg "','.join(cfg.get('runtimeVars', []))")"

if [ -n "$INIT" ]; then
  # 骨架里 toggle 的判定用配置里的 runtimeVars —— 那是你自己声明过的
  # 「这些是运行时状态」，不是程序猜的。
  exec node "$DASH/server.mjs" --init-config
fi

echo "网关 $XGG_BASE_URL"
echo "配置 $MGS_DASH_CONFIG$([ -f "$MGS_DASH_CONFIG" ] || echo "（还没有 —— 扁平只读模式；跑 mgs serve $GW --init-config 生成骨架）")"

# 服务把带 token 的地址打在第一行，读到就开浏览器。
node "$DASH/server.mjs" | while IFS= read -r line; do
  echo "$line"
  case "$line" in
    READY\ *|ALREADY_RUNNING\ *) open "${line#* }" ;;
  esac
done
