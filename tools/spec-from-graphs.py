#!/usr/bin/env python3
"""从已有的规则图里反推设备属性表，给离线回归用。

正式路径是 `mgs survey`（联机跑 `xgg device spec`）。但拿现有两户做回归时
网关够不着，而规则图里的 deviceOutput / deviceGet 节点本身就带着
siid / piid / min / max —— 那正是当初 xgg 从 spec 合成进去的。

    python3 tools/spec-from-graphs.py <graph 目录> > devices.json
"""
import json, sys, glob, os

def main(graph_dir):
    devs = {}

    def slot(did):
        return devs.setdefault(did, {"props": {}})

    for f in sorted(glob.glob(os.path.join(graph_dir, "*.json"))):
        g = json.load(open(f, encoding="utf-8"))
        for n in g.get("nodes", []):
            p = n.get("props") or {}
            did, siid, piid = p.get("did"), p.get("siid"), p.get("piid")
            if not did:
                continue

            # cfg.urn 是设备节点的必填项（校验器会查）。
            # 要在 piid 判断**之前**记 —— 无线开关只作为事件触发出现，
            # 那种节点有 eiid 没有 piid，按属性来筛会把它整台漏掉。
            urn = (n.get("cfg") or {}).get("urn")
            if urn:
                slot(did)["urn"] = urn

            if siid is None or piid is None:
                continue

            key = f"{siid}.{piid}"
            rec = slot(did)["props"].setdefault(key, {"siid": siid, "piid": piid})
            for k in ("min", "max", "step"):
                if isinstance(p.get(k), (int, float)):
                    rec[k] = p[k]
            # dtype 是**按节点类型**定的，不是属性的固有属性：
            # 比较节点（deviceGet / deviceInput）写 spec 的格式 int/float/bool，
            # 而变量写入节点（deviceGetSetVar / deviceOutput 变量形态）一律写 number。
            # 混着记会把 number 当成属性格式塞进 deviceGet，校验器报 Invalid dtype。
            if p.get("dtype") and n["type"] in ("deviceGet", "deviceInput"):
                rec["fmt"] = p["dtype"]
            # 出现在 deviceOutput 里 = 可写
            if n["type"] == "deviceOutput":
                rec["write"] = True

    json.dump(devs, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
    print()

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
