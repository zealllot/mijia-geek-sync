#!/usr/bin/env bash
# mgs 公共部分：配置加载、网关解析、xgg 调用。
set -uo pipefail

MGS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "$*" >&2; exit 1; }

# ---------- 配置 ----------
# 查找顺序：$MGS_CONFIG → ./mgs.json → ~/.mgs.json
mgs_config_path() {
  if [ -n "${MGS_CONFIG:-}" ]; then echo "$MGS_CONFIG"; return; fi
  if [ -f "./mgs.json" ]; then echo "./mgs.json"; return; fi
  echo "$HOME/.mgs.json"
}

mgs_cfg() {   # $1 = python 取值表达式，作用在 cfg 上
  local p; p="$(mgs_config_path)"
  [ -f "$p" ] || die "找不到配置 $p —— 先跑 mgs init"
  CFG="$p" python3 -c "
import json,os,sys
cfg=json.load(open(os.environ['CFG']))
try: print($1)
except Exception: print('')
"
}

# ---------- xgg ----------
# 只经由 @eyaeya/xgg-cli 与网关通信 —— 网关协议是加密二进制 WebSocket RPC，
# 没有能直接 curl 的 REST 接口，这是唯一的写入通道。
#
# 一定要直接调 cli.js，不要用 `npx --yes @eyaeya/xgg-cli@latest`：
# 实测 npx 每次多 0.54 秒（0.66s vs 0.12s），一批两百次调用就是白等两分钟；
# 而且 @latest 会让版本在项目周期内漂移。
mgs_xgg_bin() {
  local p
  p="$(mgs_cfg "cfg.get('xggBin','')")"
  [ -n "$p" ] && [ -f "$p" ] && { echo "$p"; return; }
  for p in "$MGS_ROOT/node_modules/@eyaeya/xgg-cli/dist/cli.js" \
           "./node_modules/@eyaeya/xgg-cli/dist/cli.js"; do
    [ -f "$p" ] && { echo "$p"; return; }
  done
  die "找不到 xgg —— 在本目录跑 npm i @eyaeya/xgg-cli@2.1.0，或在配置里写 xggBin"
}

x() { node "$MGS_XGG" "$@"; }

# 带重试：rule view / rule list 会偶发返空且不报错
x_retry() {   # $1=输出文件，其余=xgg 参数
  local out="$1"; shift
  local a
  for a in 1 2 3; do
    x "$@" 1>"$out" 2>/dev/null
    [ "$(wc -c <"$out")" -gt 60 ] && return 0
  done
  echo "  警告：三次都没取到内容：xgg $*" >&2
  return 1
}

# ---------- 网关 ----------
# IP 由 DHCP 分配会变，按 mDNS 实例名解析，失败回落到配置里的 fallback。
mgs_base_url() {
  local g="$1" inst fb ip
  case "$g" in http://*|https://*) echo "$g"; return 0 ;; esac
  inst="$(mgs_cfg "cfg['gateways']['$g'].get('mdns','')")"
  fb="$(mgs_cfg "cfg['gateways']['$g'].get('fallback','')")"
  [ -n "$inst$fb" ] || die "配置里没有网关 '$g'（有的是：$(mgs_cfg "' '.join(cfg.get('gateways',{}))")）"
  [ -n "$inst" ] && ip=$(dns-sd -t 3 -G v4 "$inst.local" 2>/dev/null | awk '/^[0-9]/{print $6; exit}')
  echo "http://${ip:-$fb}"
}

mgs_data_dir() {   # $1 = gateway
  local base; base="$(mgs_cfg "cfg.get('dataDir','./data')")"
  case "$1" in http://*|https://*) echo "$base/_scratch" ;; *) echo "$base/$1" ;; esac
}

mgs_setup() {   # $1 = gateway
  MGS_XGG="$(mgs_xgg_bin)" || exit 1
  export MGS_XGG
  XGG_BASE_URL="$(mgs_base_url "$1")" || exit 1
  export XGG_BASE_URL
  export XGG_AGENT_MODE=1
  export XGG_SNAPSHOTS_DIR="${XGG_SNAPSHOTS_DIR:-$PWD/snapshots}"
  export XGG_NO_REFRESH_HINT=1 XGG_NO_NEXT_HINT=1
}

# 判断一个变量是不是「运行时状态」——部署时绝不能覆盖它的值。
# 规则域（R 开头的 scope）一律算；全局的按配置里的正则清单判断。
mgs_runtime_patterns() { mgs_cfg "'|'.join(cfg.get('runtimeVars', []))"; }
