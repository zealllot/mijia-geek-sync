#!/usr/bin/env bash
#
# 全量对账部署 —— 让网关与本地一致。
#
#   mgs deploy 1302 --dry-run     # 只看计划（默认就该先跑这个）
#   mgs deploy 1302               # 只建/改，不删
#   mgs deploy 1302 --prune       # 连删除一起做（线上多出来的删掉）
#
# 对账内容：
#   变量  本地有网关没有 → 创建（用 variables.json 里的 initial 当初值）
#         网关有本地没有 → 删除（需 --prune）
#         两边都有       → **一律不碰值**。变量值里混着运行时状态
#                          （ziDongHua / guanYing / shouDong*…），覆盖它们等于
#                          把房主正在用的模式和手动锁清掉。要改值用 mgs var set
#   规则  本地全部 rule set 推上去
#         网关有本地没有 → 先删它的规则域变量,再删规则（需 --prune）
#
# **永不改变启用状态。** rule set 默认 cfgPreserved,线上是什么状态就保持什么状态。
# 启用/停用是独立动作：mgs enable
#
# 也不跑 rule layout —— 坐标在文件里,跑 layout 只会让下次 diff 变脏。
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

GW="${1:?用法: mgs deploy <网关名|http://地址> [--dry-run] [--prune]}"
shift
DRY=0; PRUNE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --prune)   PRUNE=1; shift ;;
    *) echo "未知参数 $1" >&2; exit 2 ;;
  esac
done
mgs_setup "$GW"
DATADIR="$(mgs_data_dir "$GW")"
GRAPHDIR="$DATADIR/graph"; VARFILE="$DATADIR/variables.json"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# ---------- 护栏：本地为空时拒绝全量部署 ----------
LOCAL_N=$(ls "$GRAPHDIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
[ "$LOCAL_N" -gt 0 ] || { echo "拒绝执行：$GRAPHDIR 里一个规则文件都没有。先跑 mgs pull" >&2; exit 1; }
[ -f "$VARFILE" ] || { echo "拒绝执行：找不到 $VARFILE。先跑 mgs pull" >&2; exit 1; }

bash "$(dirname "${BASH_SOURCE[0]}")/fmt.sh" --check "$GRAPHDIR"/*.json || {
  echo "格式检查未通过，先跑 mgs fmt $GRAPHDIR/*.json" >&2; exit 1; }

echo "网关 $XGG_BASE_URL  ·  本地 $LOCAL_N 条规则  ·  $([ $DRY = 1 ] && echo 演练 || echo 写入)$([ $PRUNE = 1 ] && echo ' + 删除线上多余项')"

# ---------- 读线上现状 ----------
x_retry "$TMP/list.json" rule list || exit 1
x_retry "$TMP/scopes.json" variable list || exit 1
: > "$TMP/hubvars.ndjson"
for s in $(python3 -c "import json;print(' '.join(json.load(open('$TMP/scopes.json'))['scopes']))"); do
  x_retry "$TMP/vs.json" variable get "$s" && \
    python3 -c "
import json;d=json.load(open('$TMP/vs.json')).get('variables',{})
print(json.dumps({'scope':'$s','ids':sorted(d)},ensure_ascii=False))" >> "$TMP/hubvars.ndjson"
done

# ---------- 算计划 ----------
GRAPHDIR="$GRAPHDIR" VARFILE="$VARFILE" TMP="$TMP" python3 - <<'PY' > "$TMP/plan.json"
import json,os,glob
G=os.environ['GRAPHDIR']; TMP=os.environ['TMP']
local_rules={}
for f in sorted(glob.glob(G+'/*.json')):
    d=json.load(open(f)); local_rules[str(d['id'])]=f
hub_rules={r['id']:r for r in json.load(open(TMP+'/list.json'))['rules']}
local_vars=json.load(open(os.environ['VARFILE']))
hub_vars={}
for line in open(TMP+'/hubvars.ndjson', encoding='utf-8'):
    r=json.loads(line); hub_vars[r['scope']]=set(r['ids'])

rules_del=sorted(set(hub_rules)-set(local_rules))
# 变量：只比对存在性
v_create=[]; v_delete=[]
for sc,vs in local_vars.items():
    for vid,meta in vs.items():
        if vid not in hub_vars.get(sc,set()): v_create.append([sc,vid,meta])
for sc,ids in hub_vars.items():
    # 属于「将被删除的规则」的 scope 单独处理（连规则一起删）
    if sc.startswith('R') and sc[1:] in rules_del: continue
    for vid in ids:
        if vid not in local_vars.get(sc,{}): v_delete.append([sc,vid])
json.dump({
 "rules_set":[[rid,local_rules[rid],hub_rules.get(rid,{}).get('enable')] for rid in sorted(local_rules)],
 "rules_del":[[rid,hub_rules[rid]['userData'].get('name'),hub_rules[rid]['enable']] for rid in rules_del],
 "vars_create":v_create,"vars_delete":sorted(v_delete),
 "scopes_del":[ 'R'+rid for rid in rules_del if 'R'+rid in hub_vars ],
}, open(1,'w',closefd=False), ensure_ascii=False)
PY

python3 - "$TMP/plan.json" <<'PY'
import json,sys
p=json.load(open(sys.argv[1]))
print(f"\n计划：")
print(f"  规则 set   {len(p['rules_set']):3d} 条（启用状态保持线上原样）")
print(f"  规则 删除  {len(p['rules_del']):3d} 条")
for rid,name,en in p['rules_del']: print(f"       - {rid} {name}  线上{'启用中' if en else '停用'}")
print(f"  变量 创建  {len(p['vars_create']):3d} 个")
for sc,vid,m in p['vars_create'][:10]: print(f"       + {sc}.{vid}  type={m.get('type')} initial={m.get('initial')}")
if len(p['vars_create'])>10: print(f"       …还有 {len(p['vars_create'])-10} 个")
print(f"  变量 删除  {len(p['vars_delete']):3d} 个")
for sc,vid in p['vars_delete'][:10]: print(f"       - {sc}.{vid}")
if len(p['vars_delete'])>10: print(f"       …还有 {len(p['vars_delete'])-10} 个")
print("  两边都有的变量：值一律不动（含运行时状态）")
PY

DEL_N=$(python3 -c "import json;p=json.load(open('$TMP/plan.json'));print(len(p['rules_del'])+len(p['vars_delete']))")
if [ "$DRY" = 1 ]; then echo; echo "演练结束，未写入任何东西。"; exit 0; fi
if [ "$DEL_N" -gt 0 ] && [ "$PRUNE" = 0 ]; then
  echo; echo "有 $DEL_N 项需要删除，但没给 --prune —— 本次只建/改，不删。"
  echo "确认上面的删除清单没问题后，加 --prune 重跑。"
fi

# ---------- 删除前先整机备份 ----------
if [ "$PRUNE" = 1 ] && [ "$DEL_N" -gt 0 ]; then
  BAK="$DATADIR/backups/pre-prune-$(date +%Y%m%d-%H%M%S).bak"
  mkdir -p "$(dirname "$BAK")"
  x backup local-export --output "$BAK" >/dev/null 2>&1 && echo "  删除前备份 → $BAK"
fi

# ---------- 1. 建缺失的变量 ----------
python3 -c "
import json;p=json.load(open('$TMP/plan.json'))
for sc,vid,m in p['vars_create']:
    init = m.get('initial'); init = 0 if init is None and m.get('type')=='number' else init
    print(sc,vid,m.get('type') or 'number', json.dumps(init,ensure_ascii=False), m.get('name') or vid, sep='\t')
" > "$TMP/vc.tsv"
while IFS=$'\t' read -r sc vid ty val name; do
  [ -n "${sc:-}" ] || continue
  r=$(x variable create --scope "$sc" --id "$vid" --type "$ty" --value "$(echo "$val" | tr -d '\"')" --name "$name" 2>&1 | grep -o '"ok":[a-z]*' | head -1)
  echo "  变量创建 $sc.$vid  $r"
done < "$TMP/vc.tsv"

# ---------- 2. 推所有规则 ----------
fail=0
python3 -c "
import json;p=json.load(open('$TMP/plan.json'))
[print(rid,f,sep='\t') for rid,f,_ in p['rules_set']]" > "$TMP/rs.tsv"
while IFS=$'\t' read -r rid f; do
  [ -n "${rid:-}" ] || continue
  r=$(x rule set --body "$f" 2>&1 | grep -v '^note:' | head -1)
  case "$r" in
    *'"ok":true'*) printf "  set %s  ok" "$rid" ;;
    *) echo "  !! set $rid 失败: $r"; fail=$((fail+1)); continue ;;
  esac
  v=$(x rule validate --rule-id "$rid" --spec-aware --timeout 30000 2>/dev/null | python3 -c "import json,sys;print(json.loads(sys.stdin.read())['summary']['errors'])" 2>/dev/null)
  l=$(x rule lint --rule-id "$rid" --strict 2>/dev/null | python3 -c "import json,sys;print(json.loads(sys.stdin.read())['summary']['errors'])" 2>/dev/null)
  echo "  validate=$v lint=$l"
  [ "${v:-1}" = 0 ] && [ "${l:-1}" = 0 ] || fail=$((fail+1))
done < "$TMP/rs.tsv"

# ---------- 3. 删除（仅 --prune） ----------
if [ "$PRUNE" = 1 ]; then
  # 规则：先删它的规则域变量（否则留下 ghost data，见 platform-findings 第四节），再删规则
  python3 -c "
import json;p=json.load(open('$TMP/plan.json'))
[print(rid) for rid,_,_ in p['rules_del']]" | while read -r rid; do
    [ -n "${rid:-}" ] || continue
    x variable delete --scope "R$rid" --all >/dev/null 2>&1
    r=$(x rule delete "$rid" 2>&1 | grep -o '"deleted":[a-z]*' | head -1)
    echo "  删规则 $rid  $r"
  done
  python3 -c "
import json;p=json.load(open('$TMP/plan.json'))
[print(sc,vid,sep='\t') for sc,vid in p['vars_delete']]" | while IFS=$'\t' read -r sc vid; do
    [ -n "${sc:-}" ] || continue
    r=$(x variable delete --scope "$sc" --id "$vid" 2>&1 | grep -o '"ok":[a-z]*' | head -1)
    echo "  删变量 $sc.$vid  $r"
  done
fi

# ---------- 4. 复核 ----------
echo
x_retry "$TMP/list2.json" rule list && python3 -c "
import json
rs=json.load(open('$TMP/list2.json'))['rules']
print(f'  网关现有 {len(rs)} 条规则，启用中 {sum(1 for r in rs if r[\"enable\"])} 条')"
[ "$fail" -gt 0 ] && { echo "有 $fail 条规则未通过"; exit 1; }
echo "完成。启用状态未改动 —— 要启用/停用用 mgs enable"
