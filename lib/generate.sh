#!/usr/bin/env bash
#
# mgs generate <网关> —— 从 home.toml 生成这户的全部规则图。
#
#   mgs generate 1302                    生成到 <dataDir>/<网关>/graph/
#   mgs generate 1302 --out /tmp/gen     生成到别处（回归比对用，不动真文件）
#   mgs generate 1302 --prune-generated  连同「上次生过、这次没有了」的一起删
#
# 全程离线，不连网关 —— 设备能力来自 `mgs survey` 存下的 devices.json。
# 每生成一条立刻 `xgg rule validate --body` 校验，拼错了当场就知道。
#
# **阈值和延时不由生成器拥有**（见 docs/adr/0001）：本地已有这条规则的图就沿用
# 图里的当前值，只有新建的区才用 home.toml 里的初值。所以重新生成的 diff 里
# 只会出现结构变化。
#
# **只碰生成清单里的规则。** 手建的规则（generated.json 里没有的）永不触碰。
set -uo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$LIB/common.sh"
ROOT="$(cd "$LIB/.." && pwd)"

GW="${1:?用法: mgs generate <网关> [--out 目录] [--prune-generated]}"; shift
OUT=""; PRUNE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out 要给目录}"; shift 2 ;;
    --prune-generated) PRUNE=1; shift ;;
    *) die "不认识的参数: $1" ;;
  esac
done

DATADIR="$(mgs_data_dir "$GW")"
HOME_TOML="$(dirname "$DATADIR")/../homes/$GW.toml"
[ -f "$HOME_TOML" ] || HOME_TOML="$PWD/homes/$GW.toml"
[ -f "$HOME_TOML" ] || die "找不到 $GW 的 home.toml（找过 homes/$GW.toml）"
[ -f "$DATADIR/devices.json" ] || die "$DATADIR/devices.json 不在 —— 先跑 mgs survey $GW"

GRAPHDIR="${OUT:-$DATADIR/graph}"

# 往一个**从没被生成器管过**的目录里写，会把新旧两套编号混在一起，
# 而且分不清哪些该归生成器。这是实测踩过的坑：拿 1301 试生成时，
# 20 条旧规则和 20 条新规则同时躺在目录里，deploy 会把两套都推上去。
if [ -z "$OUT" ] && [ -d "$GRAPHDIR" ] && [ ! -f "$GRAPHDIR/generated.json" ] \
   && ls "$GRAPHDIR"/*.json >/dev/null 2>&1; then
  die "$GRAPHDIR 里已经有规则，但没有生成清单 —— 那些是手建的。
  想先看看生成什么样：mgs generate $GW --out /tmp/gen
  确认要把这户交给生成器管：先把 graph/ 清空，或者手工放一份 generated.json"
fi

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT

echo "从 $HOME_TOML 生成 → $GRAPHDIR"
python3 "$ROOT/tools/generate.py" "$HOME_TOML" "$DATADIR/devices.json" "$STAGE" \
  "$GRAPHDIR/generated.json" || exit 1

# 沿用图里现有的阈值与延时（ADR-0001）
if [ -z "$OUT" ] && [ -d "$GRAPHDIR" ]; then
  STAGE="$STAGE" OLD="$GRAPHDIR" python3 - <<'PY'
import json, os, glob
stage, old = os.environ['STAGE'], os.environ['OLD']
prev = {}
for f in glob.glob(os.path.join(old, '*.json')):
    if os.path.basename(f) == 'generated.json':
        continue
    g = json.load(open(f, encoding='utf-8'))
    prev[g['id']] = {n['id']: n for n in g.get('nodes', [])}

kept = 0
for f in glob.glob(os.path.join(stage, '2026*.json')):
    g = json.load(open(f, encoding='utf-8'))
    old_nodes = prev.get(g['id'])
    if not old_nodes:
        continue
    changed = False
    for n in g['nodes']:
        o = old_nodes.get(n['id'])
        if not o or o['type'] != n['type']:
            continue
        # 只沿用这三样 —— 阈值、延时、循环间隔。别的都归生成器。
        for k in ('v1', 'timeout', 'interval'):
            if k in n['props'] and k in (o.get('props') or {}) and n['props'][k] != o['props'][k]:
                if isinstance(o['props'][k], (int, float)):
                    n['props'][k] = o['props'][k]
                    if n['cfg'].get('unit') and k in ('timeout', 'interval'):
                        v = o['props'][k]
                        for unit, size in (('hour', 3600000), ('min', 60000), ('s', 1000)):
                            if v % size == 0:
                                n['cfg']['value'], n['cfg']['unit'] = v // size, unit
                                break
                    changed = True
    if changed:
        kept += 1
        json.dump(g, open(f, 'w', encoding='utf-8'), ensure_ascii=False, indent=2, sort_keys=True)
        open(f, 'a', encoding='utf-8').write('\n')
print(f"  {kept} 条沿用了图里现有的阈值/延时（home.toml 里的只是初值）")
PY
fi

# 逐条离线校验
XGG="$(mgs_xgg_bin)" || exit 1
bad=0
for f in "$STAGE"/2026*.json; do
  errs=$(node "$XGG" rule validate --body "$f" 2>&1 | python3 -c "
import json,sys
try:
    d=json.loads(sys.stdin.read())
    for i in d.get('issues',[]):
        if i.get('severity')=='error': print(f\"    {i['path']}: {i['message']}\")
    print('COUNT', d.get('summary',{}).get('errors',0))
except Exception as e: print('COUNT 1'); print('    校验器没给出可解析的回复')")
  n=$(echo "$errs" | sed -n 's/^COUNT //p')
  if [ "${n:-1}" != 0 ]; then
    echo "  ✗ $(basename "$f")"; echo "$errs" | grep -v '^COUNT'
    bad=$((bad+1))
  fi
done
[ "$bad" = 0 ] || die "$bad 条没通过校验 —— 一条都不落盘"

mkdir -p "$GRAPHDIR"
# 生成清单：决定哪些规则归生成器。不在清单里的是手建的，永不触碰。
OLDMAN="$GRAPHDIR/generated.json"
if [ -f "$OLDMAN" ]; then
  OLDMAN="$OLDMAN" NEWMAN="$STAGE/generated.json" GRAPHDIR="$GRAPHDIR" PRUNE="$PRUNE" python3 - <<'PY'
import json, os, glob
oldm = json.load(open(os.environ['OLDMAN'], encoding='utf-8'))
newm = json.load(open(os.environ['NEWMAN'], encoding='utf-8'))
old, new = oldm.get('rules', {}), newm.get('rules', {})
gone = sorted(set(old) - set(new))
prune = os.environ['PRUNE'] == '1'
if gone:
    print("  上次生过、这次 home.toml 里没有了：")
    for rid in gone:
        hit = glob.glob(os.path.join(os.environ['GRAPHDIR'], f'{rid}_*.json'))
        print(f"    {rid} {os.path.basename(hit[0]) if hit else rid}")
        if prune:
            for f in hit:
                os.remove(f)
    if not prune:
        # **孤儿留在清单里**：这次写完清单就忘掉的话，下次再也发现不了它们，
        # 「该删没删」会变成一个没人知道的隐性状态。
        print("  加 --prune-generated 才删。删掉之后还要 mgs deploy --prune 才会从网关上消失。")
        for rid in gone:
            new[rid] = old[rid]
        newm['rules'] = new
        json.dump(newm, open(os.environ['NEWMAN'], 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=2, sort_keys=True)
PY
fi

cp "$STAGE"/*.json "$GRAPHDIR/"
n=$(ls "$GRAPHDIR"/2026*.json 2>/dev/null | wc -l | tr -d ' ')
echo "  $n 条，全部通过离线校验"
echo
echo "下一步：git diff 看清楚 → mgs lint $GW → mgs deploy $GW --dry-run"
