#!/usr/bin/env bash
#
# 把看板打包成一个自带 Node 的 Windows 文件夹，给住户解压后双击。
#
#   单户：tools/build-win.sh --config data/1302/dashboard.json
#   多户：tools/build-win.sh --houses houses.json \
#           --house-config 1302:data/1302/dashboard.json \
#           --house-config 1301:data/1301/dashboard.json
#
# 跟 build-app.sh 是一对：住户的电脑不一定是 Mac（见 docs/adr/0004）。
# 内容完全一样，差别只在外壳 —— 那边是 .app + LaunchAgent，
# 这边是文件夹 + 双击的 .cmd + 「启动」文件夹里的 .cmd。
#
# **在 Mac 上就能打**：只是解压一个 win-x64 的 node 再拼文件，不编译任何东西。
#
# 打出来的东西没有签名。住户首次运行会撞 SmartScreen ——
# 「更多信息 → 仍要运行」，跟 macOS 的 Gatekeeper 一个性质，只痛一次。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

NODE_VERSION="${NODE_VERSION:-v24.20.0}"
XGG_VERSION="2.1.0"                        # 钉死；@latest 会在项目周期内漂移
APP_NAME="模式看板"

die() { echo "$*" >&2; exit 1; }

ARCH="x64" MDNS="" FALLBACK="" CONFIG="" HOUSES="" OUT="$ROOT/dist"
HOUSE_CONFIGS=()
HOUSE_LAYOUTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --arch)     ARCH="${2:?}"; shift ;;
    --mdns)     MDNS="${2:?}"; shift ;;
    --fallback) FALLBACK="${2:?}"; shift ;;
    --config)   CONFIG="${2:?}"; shift ;;
    --houses)   HOUSES="${2:?}"; shift ;;
    --house-config) HOUSE_CONFIGS+=("${2:?}"); shift ;;
    --house-layout) HOUSE_LAYOUTS+=("${2:?}"); shift ;;
    --out)      OUT="${2:?}"; shift ;;
    *) die "不认识的参数: $1" ;;
  esac
  shift
done

# Windows 的架构默认 x64 —— ARM 版 Windows 极少见，撞上了再显式给。
case "$ARCH" in
  x64|arm64) ;;
  *) die "--arch 只能是 x64 或 arm64" ;;
esac

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/mgs-build"
mkdir -p "$CACHE" "$OUT"

# ---------- Node ----------
ZIP="node-${NODE_VERSION}-win-${ARCH}.zip"
if [ ! -f "$CACHE/$ZIP" ]; then
  echo "下载 Node ${NODE_VERSION} (win-${ARCH}) …"
  curl -fL --progress-bar -o "$CACHE/$ZIP.tmp" \
    "https://nodejs.org/dist/${NODE_VERSION}/${ZIP}" \
    || die "下载失败 —— 确认 nodejs.org/dist/${NODE_VERSION}/ 下有 win-${ARCH} 的包"
  mv "$CACHE/$ZIP.tmp" "$CACHE/$ZIP"
fi

# 校验和：从官方 SHASUMS256.txt 取，别信下载下来的东西
SUMS="$CACHE/SHASUMS256-${NODE_VERSION}.txt"
[ -f "$SUMS" ] || curl -fsL -o "$SUMS" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" \
  || die "取不到校验和文件"
want=$(awk -v f="$ZIP" '$2==f {print $1}' "$SUMS")
[ -n "$want" ] || die "SHASUMS256.txt 里没有 $ZIP"
got=$(shasum -a 256 "$CACHE/$ZIP" | awk '{print $1}')
[ "$want" = "$got" ] || die "Node 包校验和对不上：想要 $want，拿到 $got"

APP="$STAGE/$APP_NAME"
mkdir -p "$APP/app" "$APP/node"

echo "解出 node.exe …"
unzip -qo "$CACHE/$ZIP" -d "$STAGE/nodesrc"
cp "$STAGE/nodesrc/node-${NODE_VERSION}-win-${ARCH}/node.exe" "$APP/node/node.exe" \
  || die "包里没找到 node.exe"

# ---------- xgg ----------
# 只经由 @eyaeya/xgg-cli 与网关通信，而且**必须是子进程**：
# xgg 是 GPL-3.0，在进程内 import 会让这个 MIT 项目变成派生作品。
echo "装 xgg ${XGG_VERSION} …"
mkdir -p "$STAGE/xgg"
(cd "$STAGE/xgg" && npm init -y >/dev/null 2>&1 \
  && npm i --omit=dev --no-audit --no-fund "@eyaeya/xgg-cli@${XGG_VERSION}" >/dev/null 2>&1) \
  || die "装 xgg 失败"
mv "$STAGE/xgg" "$APP/app/xgg"

cp -R "$ROOT/dashboard/server.mjs" "$ROOT/dashboard/lib" "$ROOT/dashboard/public" "$APP/app/"

# ---------- 配置 ----------
if [ -n "$MDNS$FALLBACK" ]; then
  mkdir -p "$APP/app/config"
  python3 - "$MDNS" "$FALLBACK" > "$APP/app/config/gateway.json" <<'PY'
import json, sys
mdns, fallback = sys.argv[1], sys.argv[2]
print(json.dumps({k: v for k, v in (('mdns', mdns), ('fallback', fallback)) if v},
                 ensure_ascii=False, indent=2))
PY
fi

if [ -n "$HOUSES" ]; then
  [ -f "$HOUSES" ] || die "找不到 ${HOUSES}"
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$HOUSES" || die "${HOUSES} 不是合法的 JSON"
  mkdir -p "$APP/app/config"
  cp "$HOUSES" "$APP/app/config/houses.json"
  echo "  房屋: $(python3 -c "
import json,sys
print(', '.join(h.get('name', h['id']) for h in json.load(open(sys.argv[1]))))" "$HOUSES")"

  for hc in ${HOUSE_CONFIGS[@]+"${HOUSE_CONFIGS[@]}"}; do
    id="${hc%%:*}"; f="${hc#*:}"
    [ -f "$f" ] || die "找不到 ${f}"
    python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" || die "${f} 不是合法的 JSON"
    cp "$f" "$APP/app/config/dashboard.${id}.json"
    echo "    ${id} ← $(basename "$f")"
  done
  for hl in ${HOUSE_LAYOUTS[@]+"${HOUSE_LAYOUTS[@]}"}; do
    id="${hl%%:*}"; f="${hl#*:}"
    [ -f "$f" ] || die "找不到 ${f}"
    python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" || die "${f} 不是合法的 JSON"
    cp "$f" "$APP/app/config/layout.${id}.json"
    echo "    ${id} 外观 ← $(basename "$f")"
  done

  python3 - "$HOUSES" "$APP/app/config" <<'PYHC'
import json, os, sys
houses, cfgdir = json.load(open(sys.argv[1])), sys.argv[2]
miss = [h.get('name', h['id']) for h in houses
        if not os.path.exists(os.path.join(cfgdir, f"dashboard.{h['id']}.json"))]
if miss:
    print(f"  !! 这几户没给配置，打开会是扁平只读：{', '.join(miss)}", file=sys.stderr)
PYHC
fi

if [ -n "$CONFIG" ]; then
  [ -f "$CONFIG" ] || die "找不到配置 ${CONFIG}"
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$CONFIG" || die "${CONFIG} 不是合法的 JSON"
  mkdir -p "$APP/app/config"
  cp "$CONFIG" "$APP/app/config/dashboard.json"
elif [ -z "$HOUSES" ]; then
  echo "  !! 没给 --config 也没给 --houses —— 住户打开会是扁平只读模式" >&2
fi

# ---------- 启动器 ----------
# 跟 macOS 那边的 launcher 同一套：起服务，等它打出带 token 的地址，再开浏览器。
# 用 CRLF —— .cmd 用 LF 的话某些 Windows 版本会把整行连着下一行一起读。
python3 - "$APP/$APP_NAME.cmd" <<'PY'
import sys
# 不用 `for /f` 读服务的输出 —— 那个会**等命令跑完**才处理，
# 而服务永不退出，浏览器就永远打不开。改成让服务自己开（MGS_DASH_OPEN=1）。
lines = [
    '@echo off',
    'chcp 65001 >nul',
    'rem 模式看板 —— 双击这个文件启动。',
    'rem 服务只绑 127.0.0.1，别人连不进来。关掉这个窗口就退出。',
    'setlocal',
    'cd /d "%~dp0"',
    'set MGS_DASH_PORT=7391',
    'set MGS_DASH_OPEN=1',
    'node\\node.exe app\\server.mjs',
    'echo.',
    'echo 看板已退出。按任意键关闭这个窗口。',
    'pause >nul',
]
open(sys.argv[1], 'w', encoding='utf-8', newline='\r\n').write('\n'.join(lines) + '\n')
PY

# 说明书。住户看到的第一样东西，写清楚 SmartScreen 那一下。
python3 - "$APP/请先读我.txt" <<'PY'
import sys
text = """模式看板

怎么用
  1. 把整个「模式看板」文件夹拖到任意位置（比如桌面或 D 盘）
  2. 双击里面的「模式看板.cmd」
  3. 第一次会弹「Windows 已保护你的电脑」——
     点「更多信息」，再点「仍要运行」。只有第一次会问。
  4. 浏览器自己会打开。页面上填中枢地址和一次 6 位登录码
     （都在米家 App → 中枢网关 → 中枢功能 → 自动化极客版 里看得到）

要注意的
  · 那个黑色的命令行窗口就是服务本身，关掉它看板就停了。可以最小化。
  · 地址会记住。哪天路由器重启后连不上了，在同一个页面上改就行。
  · 服务只绑 127.0.0.1，同一个 WiFi 上的别人连不进来。

配置存在
  %APPDATA%\\MijiaDashboard
"""
open(sys.argv[1], 'w', encoding='utf-8', newline='\r\n').write(text)
PY

cp "$ROOT/LICENSE" "$APP/LICENSE-mgs.txt" 2>/dev/null || true
cat > "$APP/LICENSES.md" <<'LIC'
# 第三方组件

- **Node.js**（`node/node.exe`）—— MIT，见 https://github.com/nodejs/node
- **@eyaeya/xgg-cli**（`app/xgg/`）—— **GPL-3.0**。作为独立子进程调用，
  源码见 https://www.npmjs.com/package/@eyaeya/xgg-cli
- 本项目本体 —— MIT，见 LICENSE-mgs.txt
LIC

ZIPOUT="$OUT/MijiaDashboard-win-${ARCH}.zip"
rm -f "$ZIPOUT"
(cd "$STAGE" && zip -qry "$ZIPOUT" "$APP_NAME")
SIZE=$(du -h "$ZIPOUT" | cut -f1 | tr -d ' ')

cat <<EOF

打好了：$ZIPOUT  ${SIZE}

传给住户之后，告诉他：
  1. 解压，把「模式看板」文件夹拖到桌面
  2. 双击里面的「模式看板.cmd」
  3. 第一次会弹「Windows 已保护你的电脑」→「更多信息」→「仍要运行」
  4. 之后就是纯双击。页面上填中枢地址和一次 6 位登录码，地址会记住

配置在他机器的 %APPDATA%\\MijiaDashboard
EOF
