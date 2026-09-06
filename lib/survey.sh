#!/usr/bin/env bash
#
# mgs survey <网关> —— 勘查一户：设备清单 + 逐台 MIoT spec。
#
#   mgs survey 1302
#
# 产出 <dataDir>/<网关>/devices.json：每台设备的 urn，以及每个属性的
# siid / piid / 格式 / 上下界。生成器完全靠它离线工作 ——
# **必须按目标设备的真实范围写 deviceOutput**，光换 did 不换 min/max 是错的
# （1302 吊灯色温 3000-6400，别家的灯可能是 2700-6500）。
#
# 顺手猜一份 home.toml 草稿：按房间名分组，认出哪些是传感器、哪些是灯、
# 哪些是墙壁开关。草稿一定要人在现场对着走一圈改 —— 猜的是「哪台设备在哪个房间」，
# 猜不出的是「哪几盏灯该一起亮灭」。
set -uo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$LIB/common.sh"

GW="${1:?用法: mgs survey <网关>}"
mgs_setup "$GW"
DATADIR="$(mgs_data_dir "$GW")"; mkdir -p "$DATADIR"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

echo "网关 $XGG_BASE_URL  →  $DATADIR"
x_retry "$TMP/devs.json" device list || exit 1

DIDS=$(python3 -c "
import json
d=json.load(open('$TMP/devs.json'))
ds=d.get('devices', d if isinstance(d,list) else [])
if isinstance(ds,dict): ds=list(ds.values())
print(' '.join(x['did'] for x in ds if x.get('did')))")

n=0; ok=0
: > "$TMP/specs.ndjson"
for did in $DIDS; do
  n=$((n+1))
  if node "$MGS_XGG" device spec "$did" > "$TMP/one.json" 2>/dev/null; then
    python3 -c "
import json
print(json.dumps({'did':'$did','spec':json.load(open('$TMP/one.json'))},ensure_ascii=False))" >> "$TMP/specs.ndjson" && ok=$((ok+1))
  fi
  printf '\r  spec %d/%d' "$ok" "$n"
done
echo

TMP="$TMP" OUT="$DATADIR/devices.json" python3 - <<'PY'
import json, os
out = {}
for line in open(os.environ['TMP'] + '/specs.ndjson', encoding='utf-8'):
    rec = json.loads(line)
    spec = rec['spec']
    urn = spec.get('urn') or spec.get('type')
    props = {}
    for svc in spec.get('services', []):
        siid = svc.get('iid')
        for pr in svc.get('properties', []):
            piid = pr.get('iid')
            if siid is None or piid is None:
                continue
            rec2 = {'siid': siid, 'piid': piid}
            if pr.get('format'):
                rec2['fmt'] = pr['format']
            vr = pr.get('value-range') or pr.get('valueRange')
            if isinstance(vr, list) and len(vr) >= 2:
                rec2['min'], rec2['max'] = vr[0], vr[1]
                if len(vr) > 2:
                    rec2['step'] = vr[2]
            if 'write' in (pr.get('access') or []):
                rec2['write'] = True
            props[f"{siid}.{piid}"] = rec2
    out[rec['did']] = {k: v for k, v in (('urn', urn), ('props', props)) if v}
json.dump(out, open(os.environ['OUT'], 'w', encoding='utf-8'),
          ensure_ascii=False, indent=2, sort_keys=True)
print(f"  {len(out)} 台设备的 spec → {os.environ['OUT']}")
PY

echo
echo "下一步：写 homes/$GW.toml（区、目标、开关键），再 mgs generate $GW"
echo "  设备清单在 $TMP/devs.json，按房间名分组能看出个大概 ——"
echo "  但「哪几盏灯该一起亮灭」只能在现场走一圈定。"
