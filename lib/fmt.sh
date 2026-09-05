#!/usr/bin/env bash
#
# mgs fmt —— 规范化规则图 JSON，让 git diff 有意义。
#
#   mgs fmt data/home/graph/*.json            就地规范化
#   mgs fmt --check data/home/graph/*.json    只检查；不合规则非零退出（可做 pre-commit 闸）
#
# 规范内容：JSON 的 key 排序、2 空格缩进、不转义中文，外加必填字段校验。
#
# **绝不重排任何数组。** 早期版本对 nodes 和 outputs 排过序，结果那个重排被当成内容
# 写进了网关，把某个节点的扇出顺序改掉了（边的集合没变，但下发顺序变了）。
# 实测网关返回的顺序本身是稳定的，所以排序既没必要又有害。
set -uo pipefail
CHECK=0
if [ "${1:-}" = "--check" ]; then CHECK=1; shift; fi
[ $# -gt 0 ] || { echo "用法: mgs fmt [--check] <文件...>" >&2; exit 2; }

CHECK="$CHECK" python3 - "$@" <<'PY'
import json,sys,os
check = os.environ.get('CHECK') == '1'
bad = 0
for p in sys.argv[1:]:
    try: d = json.load(open(p))
    except Exception as e:
        print(f"!! {p}: 解析失败 {e}"); bad = 1; continue
    d.pop('ok', None)                       # rule view 会带 ok，body 不要
    errs = []
    if 'id' not in d: errs.append("缺 id")
    cfg = d.get('cfg') or {}
    if 'enable' not in cfg: errs.append("缺 cfg.enable")
    ud = cfg.get('userData') or {}
    if 'lastUpdateTime' not in ud: errs.append("缺 cfg.userData.lastUpdateTime（rule set 会直接拒）")
    if 'name' not in ud: errs.append("缺 cfg.userData.name")
    ids = [n.get('id') for n in d.get('nodes', [])]
    if len(ids) != len(set(ids)): errs.append("节点 id 有重复")
    known = set(ids)
    for n in d.get('nodes', []):
        for pin, targets in (n.get('outputs') or {}).items():
            for t in (targets or []):
                tgt = str(t).split('.')[0]
                if tgt not in known: errs.append(f"{n.get('id')}.{pin} 指向不存在的节点 {tgt}")
    if errs:
        print(f"!! {p}:"); [print("     " + e) for e in errs]; bad = 1; continue
    out = json.dumps(d, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if open(p, encoding='utf-8').read() == out: continue
    if check: print(f"!! {p}: 未规范化"); bad = 1
    else:
        open(p, 'w', encoding='utf-8').write(out); print(f"   规范化 {p}")
sys.exit(1 if bad else 0)
PY
