#!/usr/bin/env python3
"""比对两批规则图的结构，用来验证生成器。

    python3 tools/compare-graphs.py <真实 graph 目录> <生成的目录>

比什么：节点类型的多重集、每条边的「源类型 → 目标类型」、以及每个节点的关键
props（设备、属性、比较值、变量）。
不比什么：节点 id、画布坐标、节点顺序 —— 那些不影响执行，
而且极客版自己也会重排。
"""
import json, sys, os, glob, collections, re

KEEP = ("did", "siid", "piid", "v1", "value", "id", "scope", "operator",
        "timeout", "interval", "hour", "minute", "varType")


def sig(n):
    p = n.get("props") or {}
    # 规则域 scope 里带着规则 id（R20260822001）。按名字配对时两边编号本来就不同，
    # 归一化掉，不然每条区规则都会因为这个假差异刷屏。
    def norm(v):
        return re.sub(r"^R\d+$", "R#", str(v))
    parts = [n["type"]]
    for k in KEEP:
        if k in p:
            v = p[k]
            if isinstance(v, list):
                v = ",".join(map(str, v))
            parts.append(f"{k}={norm(v)}")
    if p.get("elements"):
        parts.append("expr=" + ",".join(
            str(e.get("value", e.get("id", "?"))) for e in p["elements"]))
    if p.get("arguments"):
        parts.append("args=" + ",".join(str(a.get("v1")) for a in p["arguments"]))
    return " ".join(parts)


def profile(g):
    # nop 是画布上的便签，人手写的注释，不参与执行 —— 比结构时不算数
    ns = [n for n in g["nodes"] if n["type"] != "nop"]
    by_id = {n["id"]: n for n in ns}
    nodes = collections.Counter(sig(n) for n in ns)
    edges = collections.Counter()
    for n in ns:
        for pin, targets in (n.get("outputs") or {}).items():
            for t in targets or []:
                tid = t.split(".")[0]
                if tid in by_id:
                    edges[f"{n['type']}.{pin} → {by_id[tid]['type']}"] += 1
    return nodes, edges


def load(d):
    out = {}
    for f in glob.glob(os.path.join(d, "*.json")):
        if os.path.basename(f) == "generated.json":
            continue
        g = json.load(open(f, encoding="utf-8"))
        out[g["id"]] = (g["cfg"]["userData"]["name"], g)
    return out


def main(real_dir, gen_dir, by="id"):
    real, gen = load(real_dir), load(gen_dir)
    if by == "name":
        # 1301 用的是早期编号（001-012），生成器用的是 1302 那套三位法。
        # 那户不重生，所以编号对不上不算问题 —— 按规则名配对来比结构。
        real = {v[0]: (v[0], v[1]) for v in real.values()}
        gen = {v[0]: (v[0], v[1]) for v in gen.values()}
    only_real = sorted(set(real) - set(gen))
    only_gen = sorted(set(gen) - set(real))
    same = sorted(set(real) & set(gen))

    identical = 0
    for rid in same:
        rname, rg = real[rid]
        gname, gg = gen[rid]
        rn, re_ = profile(rg)
        gn, ge = profile(gg)
        dn, de = rn - gn, gn - rn
        dm = {k: v for k, v in (re_ - ge).items()}
        dp = {k: v for k, v in (ge - re_).items()}
        if not dn and not de and not dm and not dp and rname == gname:
            identical += 1
            continue
        print(f"\n【{rid}】{rname}" + (f"  ← 生成的叫「{gname}」" if rname != gname else ""))
        for label, d in (("真实有、生成没有", dn), ("生成有、真实没有", de)):
            for k, v in sorted(d.items()):
                print(f"    {label}  {v}× {k[:120]}")
        for label, d in (("边少了", dm), ("边多了", dp)):
            for k, v in sorted(d.items()):
                print(f"    {label}  {v}× {k}")

    print(f"\n{'='*60}")
    print(f"完全一致 {identical} / {len(same)} 条")
    if only_real:
        print(f"只有真实有（生成器没覆盖）: {len(only_real)}")
        for r in only_real:
            print(f"    {r} {real[r][0]}")
    if only_gen:
        print(f"只有生成有（编号对不上）: {len(only_gen)}")
        for r in only_gen:
            print(f"    {r} {gen[r][0]}")


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    main(*sys.argv[1:])
