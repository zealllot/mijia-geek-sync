#!/usr/bin/env bash
#
# 启用 / 停用规则 —— 与部署完全分开的独立动作。
#
#   mgs enable 1302                       # 只看：谁开着谁关着
#   mgs enable 1302 on  20260822110 ...   # 启用指定规则
#   mgs enable 1302 off 20260822270       # 停用
#   mgs enable 1302 on  --match 光亮灯灭    # 按名字匹配（先列出再确认）
#   mgs enable 1302 off --all             # 全停（应急）
#
# 为什么单独做一个命令：在别人家里，「把规则部署上去」和「让它开始跑」是两个决定。
# mgs deploy 永远不碰启用状态（rule set 默认 cfgPreserved），启用只能从这里发生。
#
# 注意 rule enable 自带可达性检查：图里有「永远不会被触发的输出节点」时它会拒绝启用。
# 这是好事 —— 坏规则不会以启用状态留下（20260822272 那次就是被它挡住的）。
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

GW="${1:?用法: mgs enable <网关名|http://地址> [on|off] [规则id...|--match 关键词|--all]}"
shift
ACTION="${1:-list}"; shift || true
mgs_setup "$GW"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

x_retry "$TMP/list.json" rule list || exit 1

show() {
  python3 -c "
import json
rs=sorted(json.load(open('$TMP/list.json'))['rules'], key=lambda r: r['id'])
on=[r for r in rs if r['enable']]; off=[r for r in rs if not r['enable']]
print(f'共 {len(rs)} 条 · 启用 {len(on)} · 停用 {len(off)}')
if off:
    print('停用中：')
    for r in off: print(f\"  {r['id']}  {r['userData'].get('name')}\")
"
}

if [ "$ACTION" = "list" ]; then show; exit 0; fi
case "$ACTION" in on|off) ;; *) echo "动作只能是 on / off / 不写(=只看)" >&2; exit 2 ;; esac

# 解析目标
TARGETS=""
if [ "${1:-}" = "--all" ]; then
  TARGETS=$(python3 -c "
import json
print(' '.join(r['id'] for r in json.load(open('$TMP/list.json'))['rules']))")
elif [ "${1:-}" = "--match" ]; then
  KEY="${2:?--match 后面要给关键词}"
  TARGETS=$(KEY="$KEY" python3 -c "
import json,os
k=os.environ['KEY']
print(' '.join(r['id'] for r in json.load(open('$TMP/list.json'))['rules']
                if k in (r['userData'].get('name') or '')))")
  [ -n "$TARGETS" ] || { echo "没有名字含「$KEY」的规则" >&2; exit 1; }
else
  TARGETS="$*"
fi
[ -n "$TARGETS" ] || { echo "没给目标规则" >&2; exit 2; }

echo "网关 $XGG_BASE_URL"
echo "即将${ACTION/on/启用}${ACTION/off/停用}："
for id in $TARGETS; do
  python3 -c "
import json
rs={r['id']:r for r in json.load(open('$TMP/list.json'))['rules']}
r=rs.get('$id')
print(f\"  $id  {r['userData'].get('name') if r else '（网关上没有这条）'}  当前{'启用' if r and r['enable'] else '停用'}\")"
done

for id in $TARGETS; do
  if [ "$ACTION" = on ]; then r=$(x rule enable "$id" 2>&1 | grep -v '^note:' | head -1)
  else r=$(x rule disable "$id" 2>&1 | grep -v '^note:' | head -1); fi
  case "$r" in
    *'"ok":true'*) echo "  $id  ok" ;;
    *) echo "  !! $id  $r" ;;
  esac
done

echo
x_retry "$TMP/list.json" rule list && show
