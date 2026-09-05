#!/usr/bin/env bash
# mgs init —— 生成配置骨架
set -uo pipefail
P="${MGS_CONFIG:-./mgs.json}"
[ -f "$P" ] && { echo "${P} 已存在，没有覆盖。"; exit 0; }
cat > "$P" <<'JSON'
{
  "gateways": {
    "home": { "mdns": "xiaomi-gateway-hub1-XXXX", "fallback": "192.168.1.100" }
  },
  "dataDir": "./data",
  "xggBin": "",
  "runtimeVars": [
    "^xgg.*Init$"
  ]
}
JSON
cat <<EOF
已生成 ${P}，去改两处：

  gateways.home.mdns      米家 App → 中枢网关 → 中枢功能 → 自动化极客版 能看到 IP；
                          实例名用 \`dns-sd -t 5 -B _miot-central._tcp local.\` 查
  gateways.home.fallback  上面那个 IP（DHCP 会变，所以优先走 mDNS）

runtimeVars 是**运行时状态变量**的正则清单 —— 这些变量的值由规则在运行中改写，
部署时绝不能覆盖（否则会把正在生效的模式、手动锁之类清掉）。
规则域变量（scope 以 R 开头）自动算作运行时，不用列。

配置里不含凭证：每次操作都要从米家 App 现取 6 位登录码。
EOF
