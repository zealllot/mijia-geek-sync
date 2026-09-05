#!/usr/bin/env bash
#
# mgs pull <网关> —— 全量拉取：规则图 + 变量声明。
#
# 产出：
#   <dataDir>/<网关>/graph/<规则id>_<名字>.json   每条规则的原生图（能直接推回去）
#   <dataDir>/<网关>/variables.json                全部 scope 的变量声明
#
# 全量 = 本地 graph/ 先清空再写，这样网关上删掉的规则本地也会消失，
# git diff 里能直接看出来。
#
# variables.json 里存的是**声明**（scope / id / type / name / 初值），不是运行时值：
#   配置类（亮度、色温、各种阈值）→ 记录当前值当初值，改文件即改配置
#   状态类（配置里 runtimeVars 匹配的，以及全部规则域变量）→ 初值记 null，
#     因为它们的值由规则在运行中改写，部署时绝不能覆盖
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

GW="${1:?用法: mgs pull <网关名|http://地址>}"
mgs_setup "$GW"
DATADIR="$(mgs_data_dir "$GW")"; GRAPHDIR="$DATADIR/graph"
mkdir -p "$GRAPHDIR"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

echo "网关 $XGG_BASE_URL  →  $DATADIR"

x_retry "$TMP/list.json" rule list || exit 1
IDS=$(python3 -c "import json;print(' '.join(r['id'] for r in json.load(open('$TMP/list.json'))['rules']))")

rm -f "$GRAPHDIR"/*.json
n=0; fail=0
for id in $IDS; do
  if ! x_retry "$TMP/v.json" rule view "$id"; then fail=$((fail+1)); continue; fi
  TMP="$TMP" OUTDIR="$GRAPHDIR" python3 - "$id" <<'PY'
import json,os,re,sys
d = json.load(open(os.environ['TMP'] + '/v.json')); d.pop('ok', None)
name = ((d.get('cfg') or {}).get('userData') or {}).get('name') or 'unnamed'
slug = re.sub(r'[^\w一-鿿.-]+', '_', name).strip('_')[:60]
json.dump(d, open(f"{os.environ['OUTDIR']}/{sys.argv[1]}_{slug}.json", 'w', encoding='utf-8'),
          ensure_ascii=False, indent=2, sort_keys=True)
PY
  n=$((n+1))
done
echo "  规则 $n 条${fail:+（失败 $fail）}"

x_retry "$TMP/scopes.json" variable list || exit 1
: > "$TMP/vars.ndjson"
for s in $(python3 -c "import json;print(' '.join(json.load(open('$TMP/scopes.json'))['scopes']))"); do
  x_retry "$TMP/vs.json" variable get "$s" && python3 -c "
import json;d=json.load(open('$TMP/vs.json')).get('variables',{})
print(json.dumps({'scope':'$s','variables':d},ensure_ascii=False))" >> "$TMP/vars.ndjson"
done

TMP="$TMP" OUT="$DATADIR/variables.json" RT="$(mgs_runtime_patterns)" python3 - <<'PY'
import json,os,re
pats = os.environ.get('RT') or r'^xgg.*Init$'
RUNTIME = re.compile(pats)
out = {}
for line in open(os.environ['TMP'] + '/vars.ndjson', encoding='utf-8'):
    rec = json.loads(line); sc = rec['scope']
    for vid, v in sorted(rec['variables'].items()):
        runtime = sc.startswith('R') or bool(RUNTIME.match(vid))
        out.setdefault(sc, {})[vid] = {
            "type": v.get('type'),
            "name": (v.get('userData') or {}).get('name'),
            "initial": None if runtime else v.get('value'),
            **({"runtime": True} if runtime else {}),
        }
json.dump(out, open(os.environ['OUT'], 'w', encoding='utf-8'),
          ensure_ascii=False, indent=2, sort_keys=True)
total = sum(len(v) for v in out.values())
rt = sum(1 for s in out.values() for v in s.values() if v.get('runtime'))
print(f"  变量 {total} 个 / {len(out)} 个 scope（{rt} 个是运行时状态，部署不碰其值）")
PY

bash "$(dirname "${BASH_SOURCE[0]}")/fmt.sh" "$GRAPHDIR"/*.json >/dev/null 2>&1 || true
echo "下一步：git diff 看清楚 → mgs deploy $GW --dry-run"
