#!/usr/bin/env bash
#
# 把看板打包成一个自带 Node 运行时的 macOS .app，给住户双击用。
#
#   tools/build-app.sh --arch arm64 --mdns xiaomi-gateway-hub1-XXXX --fallback 192.168.5.25
#
# 为什么要自带 Node：xgg 硬要求 Node ≥ 20.11，而 macOS 从 12.3 起不再自带 python3，
# 也从来不自带 node。住户那台机器上大概率什么都没有 —— 「双击就能用」就得自带。
#
# **架构必须显式给。** 这是给别人机器打的包，用本机架构会打出一个在对面跑不起来的东西。
#
# 打出来的 .app 没有签名。通过网络传过去会带 quarantine 标记，住户首次打开要去
# 「系统设置 → 隐私与安全性」点「仍要打开」。只痛一次，之后就是纯双击。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

NODE_VERSION="${NODE_VERSION:-v24.20.0}"   # LTS。改之前先确认 nodejs.org 上有对应的 darwin 包
XGG_VERSION="2.1.0"                        # 钉死；@latest 会在项目周期内漂移
APP_NAME="模式看板"
BUNDLE_ID="com.zealllot.mijia-dashboard"

die() { echo "$*" >&2; exit 1; }

ARCH="" MDNS="" FALLBACK="" OUT="$ROOT/dist"
while [ $# -gt 0 ]; do
  case "$1" in
    --arch)     ARCH="${2:?}"; shift ;;
    --mdns)     MDNS="${2:?}"; shift ;;
    --fallback) FALLBACK="${2:?}"; shift ;;
    --out)      OUT="${2:?}"; shift ;;
    *) die "不认识的参数: $1" ;;
  esac
  shift
done

case "$ARCH" in
  arm64|x64) ;;
  "") die "要显式给 --arch arm64|x64 —— 这是给别人机器打的包，不能用本机架构去猜
     （Apple 芯片是 arm64，Intel 是 x64；让对方在「关于本机」里看一眼）" ;;
  *) die "--arch 只能是 arm64 或 x64" ;;
esac

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/mgs-build"
mkdir -p "$CACHE" "$OUT"

# ---------- 1. Node 运行时 ----------
TARBALL="node-${NODE_VERSION}-darwin-${ARCH}.tar.gz"
if [ ! -f "$CACHE/$TARBALL" ]; then
  echo "下载 $TARBALL …"
  curl -fSL --progress-bar "https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}" -o "$CACHE/$TARBALL.part" \
    || die "下载失败 —— 确认 nodejs.org/dist/${NODE_VERSION}/ 下有 darwin-${ARCH} 的包"
  mv "$CACHE/$TARBALL.part" "$CACHE/$TARBALL"
fi

# 校验和必须查 —— 这个二进制会跑在别人家的机器上。
echo "校验 SHA256 …"
WANT=$(curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" | awk -v f="$TARBALL" '$2==f{print $1}')
[ -n "$WANT" ] || die "官方 SHASUMS256.txt 里没有 $TARBALL"
GOT=$(shasum -a 256 "$CACHE/$TARBALL" | awk '{print $1}')
[ "$WANT" = "$GOT" ] || { rm -f "$CACHE/$TARBALL"; die "校验和不符：期望 ${WANT}，实得 ${GOT} —— 缓存已删，重跑一次"; }

# ---------- 2. xgg ----------
echo "装 xgg@${XGG_VERSION} …"
mkdir -p "$STAGE/xgg"
(cd "$STAGE/xgg" && npm install --silent --no-audit --no-fund --omit=dev "@eyaeya/xgg-cli@${XGG_VERSION}") \
  || die "npm install 失败"

# ---------- 3. 组装 bundle ----------
APP="$STAGE/${APP_NAME}.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app" "$APP/Contents/Resources/node"

echo "解出 node 二进制 …"
tar -xzf "$CACHE/$TARBALL" -C "$STAGE" "node-${NODE_VERSION}-darwin-${ARCH}/bin/node"
mv "$STAGE/node-${NODE_VERSION}-darwin-${ARCH}/bin" "$APP/Contents/Resources/node/bin"

cp -R "$ROOT/dashboard/server.mjs" "$ROOT/dashboard/lib" "$ROOT/dashboard/public" "$APP/Contents/Resources/app/"
mv "$STAGE/xgg" "$APP/Contents/Resources/app/xgg"

# 打包时写死的默认网关 —— **可选**。给了只是让住户第一次打开时地址已经填好；
# 他随时能在登录页上改，因为 IP 是 DHCP 分的，写死一个意味着地址一变
# 他就只能等我重新打包。登录成功用过的地址存在 Application Support，优先级更高。
if [ -z "$MDNS$FALLBACK" ]; then
  echo "  没给 --mdns / --fallback —— 住户第一次打开时自己填地址"
else
mkdir -p "$APP/Contents/Resources/app/config"
python3 - "$MDNS" "$FALLBACK" > "$APP/Contents/Resources/app/config/gateway.json" <<'PY'
import json, sys
mdns, fallback = sys.argv[1], sys.argv[2]
print(json.dumps({k: v for k, v in (('mdns', mdns), ('fallback', fallback)) if v},
                 ensure_ascii=False, indent=2))
PY
fi

cat > "$APP/Contents/MacOS/launcher" <<'LAUNCHER'
#!/bin/bash
# 起服务，等它打出带 token 的地址，然后开浏览器。
# 服务在前台跑着 —— 关掉这个 app 就等于停掉服务。
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
LOG="$HOME/Library/Logs/MijiaDashboard.log"
mkdir -p "$(dirname "$LOG")"
exec 2>>"$LOG"
echo "--- $(date) 启动 ---" >>"$LOG"

"$RES/node/bin/node" "$RES/app/server.mjs" 2>>"$LOG" | while IFS= read -r line; do
  echo "$line" >>"$LOG"
  case "$line" in
    READY\ *|ALREADY_RUNNING\ *) open "${line#* }" ;;
  esac
done
LAUNCHER
chmod +x "$APP/Contents/MacOS/launcher"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# ---------- 4. 图标 ----------
# 纯 Python 画一张 PNG 再交给 sips 转 icns —— 不引任何图形库。
# 图标要有：住户在 Dock 里靠它认出这个 app。
python3 - "$STAGE/icon.png" <<'PY'
import struct, zlib, sys
N, SS = 512, 3          # SS = 超采样倍数，用来做抗锯齿
GROUND, RING, DOT = (0x14, 0x1a, 0x1f), (0x4a, 0xde, 0x9a), (0x4a, 0xde, 0x9a)
cx = cy = N / 2
rows = []
for y in range(N):
    row = bytearray([0])
    for x in range(N):
        acc = [0, 0, 0]
        for sy in range(SS):
            for sx in range(SS):
                px, py = x + (sx + .5) / SS, y + (sy + .5) / SS
                d = ((px - cx) ** 2 + (py - cy) ** 2) ** .5
                if d < N * .17:        c = DOT
                elif N * .30 < d < N * .345: c = RING
                else:                  c = GROUND
                for i in range(3): acc[i] += c[i]
        row += bytes(a // (SS * SS) for a in acc)
    rows.append(bytes(row))

def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))

png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', N, N, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(b''.join(rows), 9))
       + chunk(b'IEND', b''))
open(sys.argv[1], 'wb').write(png)
PY
sips -s format icns "$STAGE/icon.png" --out "$APP/Contents/Resources/icon.icns" >/dev/null 2>&1 \
  || echo "  警告：图标转换失败，会用系统默认图标" >&2

# ---------- 5. GPL 合规 ----------
# 包里带着 GPL-3.0 的 xgg，分发时要附许可和取源码的途径。
cat > "$APP/Contents/Resources/LICENSES.md" <<'LIC'
# 许可

**模式看板**（mijia-geek-sync 的一部分）—— MIT。
源码：https://github.com/zealllot/mijia-geek-sync

本 app 内含 **@eyaeya/xgg-cli** 与 **@eyaeya/xgg-core**，两者均为 **GPL-3.0-or-later**。
源码：https://github.com/eyaeya/xiaomi-central-hub-gateway-cli
也可从 npm 取得：`npm pack @eyaeya/xgg-cli@2.1.0`

看板以**子进程**方式调用 xgg，不构成衍生作品；但你再分发时要遵守 xgg 自己的许可。

本 app 内含 **Node.js** 官方发行的二进制（MIT）。https://nodejs.org
LIC
cp "$ROOT/LICENSE" "$APP/Contents/Resources/LICENSE-mgs.txt" 2>/dev/null || true

# ---------- 6. 打包 ----------
ZIP="$OUT/MijiaDashboard-${ARCH}.zip"
rm -f "$ZIP"
(cd "$STAGE" && zip -qry "$ZIP" "${APP_NAME}.app")

SIZE=$(du -h "$ZIP" | awk '{print $1}')
cat <<EOF

打好了：${ZIP}  ${SIZE}

传给住户之后，告诉他：
  1. 解压，把「${APP_NAME}」拖进「应用程序」
  2. 双击。第一次会说「无法验证开发者」—— 去
     系统设置 → 隐私与安全性 → 往下翻到「已阻止使用…」→ 点「仍要打开」
  3. 之后就是纯双击。页面上填中枢地址和一次 6 位登录码
     （都在米家 App → 中枢网关 → 中枢功能 → 自动化极客版 里看得到）
     地址会记住。哪天路由器重启后连不上了，在同一个页面上改就行

日志在他机器的 ~/Library/Logs/MijiaDashboard.log
配置在 ~/Library/Application Support/MijiaDashboard/
EOF
