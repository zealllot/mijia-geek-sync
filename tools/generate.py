#!/usr/bin/env python3
"""从 home.toml 生成一户的全部规则图。

    python3 tools/generate.py <home.toml> <devices.json> <输出目录> [上次的 generated.json]

节点不手写：每种节点从 shapes/ 里那份「形状」深拷一份再填值（见 ADR-0002）。
形状是从真实规则图里抠出来的，所以 schema 天然对；拼错了由
`xgg rule validate --body` 在生成的当场兜住。

结构上的两条规律不用配，直接推：
  · 「本区灯组已灭」判断用的就是第一个目标的 did
  · 关灯规则的闸门 = 开灯闸门 − 手动锁 − 昼夜分支
"""
import json, sys, os, copy, tomllib, re

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHAPES = os.path.join(HERE, "shapes")

# 存在传感器的两种型号在不同 siid/piid 上报存在与照度。
# 认不出来就报错 —— 猜一个只会生出一条永远不触发的规则。
# ed01 传感器（1301 玄关/沙发/餐厅、1302 全部）走 s2/p1096 与 s4/p1077；
# 领普 ES5（1301 阳台/厨房/洗衣房）走 s2/p1078 与 s2/p1005。
# 认不出来就报错 —— 猜一个只会生出一条永远不触发的规则。
PRESENCE = [(2, 1096), (2, 1078), (2, 1)]
LUX = [(4, 1077), (2, 1005)]


def shape(t):
    with open(os.path.join(SHAPES, f"{t}.json"), encoding="utf-8") as f:
        return json.load(f)


class Graph:
    """一张规则图。节点从形状库来，边写在源节点的 outputs 里。"""

    def __init__(self, rule_id, name):
        self.id = rule_id
        self.name = name
        self.nodes = []
        self._by_id = {}
        self._n = 0

    def add(self, type_, props=None, nid=None, urn=None):
        n = shape(type_)
        self._n += 1
        n["id"] = nid or f"N{self._n}"
        cfg = n.get("cfg") or {}
        # 设备卡必须带 spec 的 urn，校验器会查；没有就早点炸，别等推到网关
        if "urn" in cfg:
            if not urn:
                raise ValueError(f"{self.id} 的 {type_} 节点缺 urn（devices.json 里没有这台设备？）")
            cfg["urn"] = urn
        n["cfg"] = cfg
        # props **整体替换**，不在形状的示例值上叠加。
        # deviceOutput 有两种形态（写字面值 value / 写变量 id+scope+min/max），
        # 叠加会让两种的键混在一起，校验器直接拒。形状提供的是结构，不是默认值。
        p = dict(props or {})
        # preload 是形状带的行为默认（规则启用时先查一次）。
        # 但它只对**属性型**触发有效 —— 事件型（无线开关按键、中枢虚拟事件）
        # 带上它会被校验器拒，那种触发本来也没有「当前值」可查。
        if "preload" in (n.get("props") or {}) and "preload" not in p and "piid" in p:
            p["preload"] = n["props"]["preload"]
        # 形状里的占位符没被填上就是漏了参数，早点炸掉
        for k, v in p.items():
            if isinstance(v, str) and v.startswith("{{"):
                raise ValueError(f"{self.id} 的 {type_} 节点漏填了 {k}")
        n["props"] = p

        # delay / loop 的时长在 cfg 和 props 里各存一份，校验器要求两边一致。
        # 只改 props 的话会被拒 —— 这一处是形状库带出来的隐性耦合。
        dur = p.get("timeout", p.get("interval"))
        if dur is not None and n["cfg"].get("unit"):
            n["cfg"]["value"], n["cfg"]["unit"] = pretty_duration(dur)

        n["outputs"] = {k: [] for k in (n.get("outputs") or {})}
        self.nodes.append(n)
        self._by_id[n["id"]] = n
        return n["id"]

    def wire(self, src, dst, out="output", inp="input"):
        self._by_id[src]["outputs"].setdefault(out, []).append(f"{dst}.{inp}")

    def layout(self):
        """按拓扑给每个节点一个坐标。

        画布坐标不影响执行，但 cfg.pos 是校验器的必填项，而且人打开极客版
        要能看懂 —— 全堆在原点等于给自己下次排查设障。
        深度决定列，同深度的往下排。"""
        depth = {n["id"]: 0 for n in self.nodes}
        for _ in range(len(self.nodes)):        # 边不多，跑满即收敛
            for n in self.nodes:
                for targets in (n.get("outputs") or {}).values():
                    for t in targets:
                        tid = t.split(".")[0]
                        if tid in depth:
                            depth[tid] = max(depth[tid], depth[n["id"]] + 1)
        row = {}
        for n in self.nodes:
            d = depth[n["id"]]
            pos = n["cfg"]["pos"]
            pos["x"] = 40 + d * 780
            pos["y"] = 40 + row.get(d, 0) * 200
            row[d] = row.get(d, 0) + 1

    def json(self, enable=True):
        self.layout()
        return {
            "cfg": {
                "enable": enable,
                "id": self.id,
                "uiType": "graph",
                "userData": {
                    "lastUpdateTime": 0,
                    "name": self.name,
                    "transform": {"k": 1, "x": 0, "y": 0},
                    "version": "1.0.0",
                },
            },
            "id": self.id,
            "nodes": self.nodes,
        }


class Home:
    def __init__(self, toml_path, devices_path, manifest=None):
        with open(toml_path, "rb") as f:
            self.cfg = tomllib.load(f)
        with open(devices_path, encoding="utf-8") as f:
            self.devices = json.load(f)

        self.prefix = self.cfg["prefix"]
        self.house = self.cfg.get("house", {})
        self.zones = self.cfg.get("zone", [])
        self.scenes = self.cfg.get("scene", [])
        self.guest = set(self.house.get("guestMode", {}).get("zones", []))

        self.slots = self.assign_slots(manifest)
        for z in self.zones:
            z["_i"] = self.slots[z["key"]]
            z.setdefault("rule", z["name"])

    def assign_slots(self, manifest):
        """区 → 槽位（规则 id 里的那一位）。**一旦分配就固定**。

        按区在 toml 里的顺序编号是错的：删掉中间一个区，后面所有区的规则 id
        全部前移，于是 deploy 会把一屋子规则删了重建 —— 而那是在别人家里。
        所以槽位记进生成清单，新区只取没被占的最小号。"""
        old = (manifest or {}).get("slots", {})
        used = {v for k, v in old.items() if any(z["key"] == k for z in self.zones)}
        out = {}
        for z in self.zones:
            if z["key"] in old:
                out[z["key"]] = old[z["key"]]
        for z in self.zones:
            if z["key"] in out:
                continue
            free = next((i for i in range(1, 10) if i not in used), None)
            if free is None:
                raise ValueError("区超过 9 个了 —— 三位编号放不下，得手工分配（见设计文档）")
            out[z["key"]] = free
            used.add(free)
        return out

    # ---------- 设备 ----------

    def urn(self, did):
        u = self.devices.get(did.split(":")[0], {}).get("urn")
        if not u:
            raise ValueError(f"devices.json 里没有 {did} 的 urn —— 先跑 mgs survey")
        return u

    def prop(self, did, cands):
        """在候选 (siid, piid) 里找这台设备真有的那个。"""
        props = self.devices.get(did, {}).get("props", {})
        for siid, piid in cands:
            if f"{siid}.{piid}" in props:
                return props[f"{siid}.{piid}"]
        return None

    def dimmable(self, target):
        did = target.split(":")[0]
        props = self.devices.get(did, {}).get("props", {})
        return "2.2" in props and "2.3" in props

    def proxy(self, z):
        """「本区灯已灭」判断用哪盏。默认第一个目标，但未必 ——
        1302 进门区用的是吊灯，而目标列表第一个是灯带。"""
        return z.get("proxy") or z["lights"][0]

    def off_lights(self, z):
        """关灯要关的。默认就是开灯那些，但常常更多 ——
        感应只开两盏，关的时候要把这个区所有可能亮着的都关掉（包括手动开的）。"""
        return z.get("offLights") or z["lights"]

    def on_prop(self, target):
        """开关属性：目标写成 did:siid 时那个 siid 就是要合的那一路。"""
        did, _, siid = target.partition(":")
        return did, (int(siid) if siid else 2), 1

    # ---------- 闸门 ----------

    def gates(self, z, with_lock=True):
        """开灯链上的闸门。能推的都推，配置里只写例外。"""
        out = []
        if z.get("master", True):
            out.append(("ziDongHua", 1))
        for s in self.scenes:
            if s.get("zone") == z["key"]:
                out.append((s["var"], 0))
        if z["key"] in self.guest:
            out.append(("huiKe", 0))
        if with_lock and z.get("switches") and self.house.get("manualLock"):
            out.append((lock_var(z["key"]), 0))
        return out

    def night(self, z):
        """分不分昼夜：目标全是哑灯时没得分，其余听配置（默认分）。"""
        if not any(self.dimmable(t) for t in z["lights"]):
            return False
        return z.get("night", True)

    # ---------- 区规则 ----------

    def zone_on(self, z):
        g = Graph(f"{self.prefix}1{z['_i']}0", f"{z['rule']}_有人_开灯")
        sensor = z["sensor"]
        pres = self.prop(sensor, PRESENCE)
        lux = self.prop(sensor, LUX)
        if not pres or not lux:
            raise ValueError(f"{z['name']}：传感器 {sensor} 认不出存在或照度属性")

        trig = g.add("deviceInput", {
            "did": sensor, "dtype": "int", "operator": "include",
            "siid": pres["siid"], "piid": pres["piid"], "v1": [1],
        }, nid="A1", urn=self.urn(sensor))

        head = trig
        # 1302 的区规则每 60 秒重评估一次；1301 没有这一段。
        recheck = z.get("recheck", self.house.get("recheck"))
        scene_vars = [s["var"] for s in self.scenes if s.get("zone") == z["key"]]
        if recheck:
            lp0 = g.add("onLoad", {}, nid="L0")
            lp = g.add("loop", {"interval": ms(recheck)}, nid="L1")
            # 定时重评估**或**场景刚退出时，都去查一次「有人吗」。
            # 少了后面那一路，睡眠模式一关灯不会自己亮 —— 得等下一个周期，
            # 而人这时候正站在屋里。
            if scene_vars:
                wake = g.add("signalOr", {}, nid="LO")
                g.wire(lp, wake, "output", "input0")
                for k, var in enumerate(scene_vars, start=1):
                    vc = g.add("varChange", {"id": var, "scope": "global", "operator": "=",
                                             "v1": 0, "varType": "number", "preload": False},
                               nid=f"X{k}")
                    g.wire(vc, wake, "output", f"input{k}")
            else:
                wake = lp        # 没有场景的区不必多接一个单路的「或」
            chk = g.add("deviceGet", {
                "did": sensor, "dtype": "int", "operator": "include",
                "siid": pres["siid"], "piid": pres["piid"], "v1": [1],
            }, nid="L2", urn=self.urn(sensor))
            g.wire(wake, chk)
            join = g.add("signalOr", {}, nid="L3")
            g.wire(lp0, lp, "output", "start")
            g.wire(trig, join, "output", "input0")
            g.wire(chk, join, "output", "input1")
            head = join

        prev = head
        for i, (var, val) in enumerate(self.gates(z)):
            nid = g.add("varGet", {"id": var, "scope": "global", "operator": "=",
                                   "v1": val, "varType": "number"}, nid=f"G{i}")
            g.wire(prev, nid)
            prev = nid

        # 本区灯组已灭
        did0, siid0, piid0 = self.on_prop(self.proxy(z))
        off = g.add("deviceGet", {"did": did0, "dtype": "boolean", "operator": "=",
                                  "siid": siid0, "piid": piid0, "v1": False}, nid="A2", urn=self.urn(did0))
        g.wire(prev, off)

        local = g.add("deviceGet", {"did": sensor, "dtype": lux.get("fmt", "int"),
                                    "operator": "<", "siid": lux["siid"],
                                    "piid": lux["piid"], "v1": z["lux"]}, nid="A3", urn=self.urn(sensor))
        g.wire(off, local)

        gl = self.house.get("globalLux")
        if gl and z.get("luxGlobal") is not None:
            glp = self.prop(gl, LUX)
            either = g.add("signalOr", {}, nid="A3or")
            glob = g.add("deviceGet", {"did": gl, "dtype": glp.get("fmt", "float"),
                                       "operator": "<", "siid": glp["siid"],
                                       "piid": glp["piid"], "v1": z["luxGlobal"]}, nid="A3b", urn=self.urn(gl))
            g.wire(local, either, "output", "input0")
            g.wire(local, glob, "output2")
            g.wire(glob, either, "output", "input1")
            lux_end = either
        else:
            lux_end = local

        # 昼夜分支：夜间用夜灯参数，白天用全局参数
        scope = f"R{g.id}"
        if self.night(z):
            br = g.add("varGet", {"id": "yeJian", "scope": "global", "operator": "=",
                                  "v1": 1, "varType": "number"}, nid="A4")
            g.wire(lux_end, br)
            n_bri = g.add("varSetNumber", {"id": "bri", "scope": scope,
                                           "elements": [var_ref("yeDengLiangDu")]}, nid="A5")
            n_cct = g.add("varSetNumber", {"id": "cct", "scope": scope,
                                           "elements": [var_ref("yeDengSeWen")]}, nid="A6")
            d_bri = g.add("varSetNumber", {"id": "bri", "scope": scope,
                                           "elements": [var_ref("quanJuLiangDu")]}, nid="A7")
            d_cct = g.add("varSetNumber", {"id": "cct", "scope": scope,
                                           "elements": [var_ref("quanJuSeWen")]}, nid="A8")
            join = g.add("signalOr", {}, nid="A9")
            g.wire(br, n_bri); g.wire(n_bri, n_cct); g.wire(n_cct, join, "output", "input0")
            g.wire(br, d_bri, "output2"); g.wire(d_bri, d_cct); g.wire(d_cct, join, "output", "input1")
            fire = join
        elif any(self.dimmable(t) for t in z["lights"]):
            d_bri = g.add("varSetNumber", {"id": "bri", "scope": scope,
                                           "elements": [var_ref("quanJuLiangDu")]}, nid="A7")
            d_cct = g.add("varSetNumber", {"id": "cct", "scope": scope,
                                           "elements": [var_ref("quanJuSeWen")]}, nid="A8")
            g.wire(lux_end, d_bri); g.wire(d_bri, d_cct)
            fire = d_cct
        else:
            fire = lux_end

        for j, t in enumerate(z["lights"], start=1):
            did, siid, piid = self.on_prop(t)
            on = g.add("deviceOutput", {"did": did, "siid": siid,
                                        "piid": piid, "value": True}, nid=f"O{j}a", urn=self.urn(did))
            g.wire(fire, on, "output", "trigger")
            if self.dimmable(t):
                for k, (pp, vv) in enumerate([("2.2", "bri"), ("2.3", "cct")]):
                    spec = self.devices[did]["props"][pp]
                    o = g.add("deviceOutput", dict(spec, did=did, dtype="number",
                                                   id=vv, scope=scope), nid=f"O{j}{'bc'[k]}", urn=self.urn(did))
                    o_node = g._by_id[o]
                    o_node["props"].pop("write", None)
                    g.wire(fire, o, "output", "trigger")
        return g

    def zone_off(self, z):
        g = Graph(f"{self.prefix}1{z['_i']}1", f"{z['rule']}_无人_关灯")
        sensor = z["sensor"]
        pres = self.prop(sensor, PRESENCE)

        trig = g.add("deviceInput", {"did": sensor, "dtype": "int", "operator": "include",
                                     "siid": pres["siid"], "piid": pres["piid"], "v1": [0]}, nid="D1", urn=self.urn(sensor))
        prev = trig
        # 关灯不看手动锁：住户手动开的灯，没人了照样该关。
        for i, (var, val) in enumerate(self.gates(z, with_lock=False)):
            nid = g.add("varGet", {"id": var, "scope": "global", "operator": "=",
                                   "v1": val, "varType": "number"}, nid=f"G{i}")
            g.wire(prev, nid)
            prev = nid

        d = g.add("delay", {"timeout": ms(z["delay"])}, nid="D2")
        g.wire(prev, d)
        again = g.add("deviceGet", {"did": sensor, "dtype": "int", "operator": "include",
                                    "siid": pres["siid"], "piid": pres["piid"], "v1": [0]}, nid="D3", urn=self.urn(sensor))
        g.wire(d, again)

        for j, t in enumerate(self.off_lights(z), start=1):
            did, siid, piid = self.on_prop(t)
            o = g.add("deviceOutput", {"did": did, "siid": siid,
                                       "piid": piid, "value": False}, nid=f"E{j}", urn=self.urn(did))
            g.wire(again, o, "output", "trigger")
        return g

    # ---------- 户级 ----------

    def probe(self):
        g = Graph(f"{self.prefix}996", "探针_照度快照")
        start = g.add("onLoad", {}, nid="S0")
        lp = g.add("loop", {"interval": ms(self.house.get("probe", "5min"))}, nid="S1")
        # 启动时先采一次，之后每隔 interval 采 —— 少了 onLoad 那条边，
        # 中枢重启后到第一个周期之间照度全是空的，那段时间开灯规则会误判。
        g.wire(start, lp, "output", "start")
        join = g.add("signalOr", {}, nid="S2")
        g.wire(start, join, "output", "input0")
        g.wire(lp, join, "output", "input1")

        prev, seen = join, set()
        targets = []
        if self.house.get("globalLux"):
            targets.append(("luxQuanJu", self.house["globalLux"]))
        for z in self.zones:
            var = z.get("luxVar") or f"lux{cap(z['key'])}"
            targets.append((var, z["sensor"]))

        for i, (var, did) in enumerate(targets):
            if did in seen:      # 一个传感器喂几个区时只采一次
                continue
            seen.add(did)
            p = self.prop(did, LUX)
            nid = g.add("deviceGetSetVar", {"did": did, "dtype": "number", "id": var,
                                            "scope": "global", "siid": p["siid"],
                                            "piid": p["piid"]}, nid=f"P{i}", urn=self.urn(did))
            g.wire(prev, nid)
            prev = nid
        return g

    def night_mode(self):
        g = Graph(f"{self.prefix}100", "夜间模式_切换")
        on_h, on_m = hhmm(self.house.get("nightAt", "21:30"))
        off_h, off_m = hhmm(self.house.get("morningAt", "06:00"))

        a1 = g.add("alarmClock", {"hour": on_h, "minute": on_m, "second": 0,
                                  "isSunset": False, "type": "periodicAlarm", "filter": {}}, nid="T1")
        s1 = g.add("varSetNumber", {"id": "yeJian", "scope": "global",
                                    "elements": [const(1)]}, nid="G1")
        g.wire(a1, s1)

        a2 = g.add("alarmClock", {"hour": off_h, "minute": off_m, "second": 0,
                                  "isSunset": False, "type": "periodicAlarm", "filter": {}}, nid="T2")
        s2 = g.add("varSetNumber", {"id": "yeJian", "scope": "global",
                                    "elements": [const(0)]}, nid="G2")
        g.wire(a2, s2)
        if self.guest:      # 早上顺带退会客
            s3 = g.add("varSetNumber", {"id": "huiKe", "scope": "global",
                                        "elements": [const(0)]}, nid="G3")
            g.wire(s2, s3)
        return g

    def morning_reset(self):
        g = Graph(f"{self.prefix}101", "定时_早上十点归位")
        h, m = hhmm(self.house.get("resetAt", "10:00"))
        a = g.add("alarmClock", {"hour": h, "minute": m, "second": 0, "isSunset": False,
                                 "type": "periodicAlarm", "filter": {}}, nid="T1")
        prev = a
        # 归位 = 开总闸 + 退掉所有模式
        resets = [("ziDongHua", 1)]
        if self.guest:
            resets.append(("huiKe", 0))
        resets += [(s["var"], 0) for s in self.scenes]
        for i, (var, val) in enumerate(resets, start=1):
            nid = g.add("varSetNumber", {"id": var, "scope": "global",
                                         "elements": [const(val)]}, nid=f"G{i}")
            g.wire(prev, nid)
            prev = nid
        return g

    def hub_event(self, g, label, nid):
        return g.add("deviceInput", {
            "did": self.house["hub"], "siid": 4, "eiid": 1,
            "arguments": [{"dtype": "string", "operator": "=", "piid": 1, "v1": label}],
        }, nid=nid, urn=self.urn(self.house["hub"]))

    def master_switch(self):
        g = Graph(f"{self.prefix}200", "灯光自动化_总开关")
        for i, (label, val) in enumerate([("灯光自动化开", 1), ("灯光自动化关", 0)], start=1):
            t = self.hub_event(g, label, f"T{i}")
            s = g.add("varSetNumber", {"id": "ziDongHua", "scope": "global",
                                       "elements": [const(val)]}, nid=f"G{i}")
            g.wire(t, s)
        return g

    def all_lights(self, on):
        rid = f"{self.prefix}21{0 if on else 1}"
        g = Graph(rid, "全屋开灯" if on else "全屋关灯")
        t = self.hub_event(g, "全屋开灯" if on else "全屋关灯", "T1")

        # 手动指令永远可用 —— 这两条不装 ziDongHua 闸门。
        # 开全屋灯时关掉自动化（免得感应马上又把它关了），关全屋灯时打开。
        sets = [("ziDongHua", 0)] if on else [("ziDongHua", 1)] + \
               ([("huiKe", 0)] if self.guest else [])
        prev = t
        for i, (var, val) in enumerate(sets, start=1):
            nid = g.add("varSetNumber", {"id": var, "scope": "global",
                                         "elements": [const(val)]}, nid=f"G{i}")
            g.wire(prev, nid)
            prev = nid

        # 灯从**触发**直接分叉，跟置变量并行 —— 串在变量后面的话，
        # 变量那一步出问题会连带整批灯都不动，而手动指令必须最可靠。
        for j, tgt in enumerate(self.house.get("allLights", []), start=1):
            did, siid, piid = self.on_prop(tgt)
            o = g.add("deviceOutput", {"did": did, "siid": siid,
                                       "piid": piid, "value": bool(on)}, nid=f"O{j}a", urn=self.urn(did))
            g.wire(t, o, "output", "trigger")
            if on and self.dimmable(tgt):
                for k, (pp, vv) in enumerate([("2.2", "quanJuLiangDu"), ("2.3", "quanJuSeWen")]):
                    spec = self.devices[did]["props"][pp]
                    o2 = g.add("deviceOutput", dict(spec, did=did, dtype="number",
                                                    id=vv, scope="global"), nid=f"O{j}{'bc'[k]}", urn=self.urn(did))
                    g._by_id[o2]["props"].pop("write", None)
                    g.wire(t, o2, "output", "trigger")
        return g

    def guest_light(self):
        g = Graph(f"{self.prefix}220", "会客灯")
        t = self.hub_event(g, "会客灯", "T1")
        sets = [("huiKe", 1)]
        # 会客要把被压住的那些区的手动锁和场景清掉，不然会客结束后感应失灵
        for zk in sorted(self.guest):
            z = next((x for x in self.zones if x["key"] == zk), None)
            if z and z.get("switches") and self.house.get("manualLock"):
                sets.append((lock_var(zk), 0))
            for s in self.scenes:
                if s.get("zone") == zk:
                    sets.append((s["var"], 0))
        prev = t
        for i, (var, val) in enumerate(sets, start=1):
            nid = g.add("varSetNumber", {"id": var, "scope": "global",
                                         "elements": [const(val)]}, nid=f"G{i}")
            g.wire(prev, nid)
            prev = nid

        for j, tgt in enumerate(self.house.get("guestLights", []), start=1):
            did, siid, piid = self.on_prop(tgt)
            o = g.add("deviceOutput", {"did": did, "siid": siid,
                                       "piid": piid, "value": True}, nid=f"O{j}a", urn=self.urn(did))
            g.wire(t, o, "output", "trigger")
            if self.dimmable(tgt):
                for k, (pp, vv) in enumerate([("2.2", "quanJuLiangDu"), ("2.3", "quanJuSeWen")]):
                    spec = self.devices[did]["props"][pp]
                    o2 = g.add("deviceOutput", dict(spec, did=did, dtype="number",
                                                    id=vv, scope="global"), nid=f"O{j}{'bc'[k]}", urn=self.urn(did))
                    g._by_id[o2]["props"].pop("write", None)
                    g.wire(t, o2, "output", "trigger")
        return g

    def sync_params(self):
        """全局参数同步。翻转变量触发，第一步写回 0 —— 极客版的变量监听只响一次。"""
        g = Graph(f"{self.prefix}260", "全局参数_同步到所有灯")
        t = g.add("varChange", {"id": "tongBu", "scope": "global", "operator": "=",
                                "v1": 1, "varType": "number", "preload": True}, nid="T1")
        back = g.add("varSetNumber", {"id": "tongBu", "scope": "global",
                                      "elements": [const(0)]}, nid="Z")
        g.wire(t, back)

        prev = back
        for j, tgt in enumerate(self.house.get("allLights", []), start=1):
            if not self.dimmable(tgt):
                continue
            did, siid, piid = self.on_prop(tgt)
            # 只同步开着的灯：给关着的灯写亮度会把它点亮
            # 每盏灯的检查都从写回那一步**并联**分叉，不串成一条链 ——
            # 串起来的话，中间任何一盏灯离线都会让后面的灯收不到新参数。
            chk = g.add("deviceGet", {"did": did, "dtype": "boolean", "operator": "=",
                                      "siid": siid, "piid": piid, "v1": True}, nid=f"C{j}", urn=self.urn(did))
            g.wire(back, chk)
            for k, (pp, vv) in enumerate([("2.2", "quanJuLiangDu"), ("2.3", "quanJuSeWen")]):
                spec = self.devices[did]["props"][pp]
                o = g.add("deviceOutput", dict(spec, did=did, dtype="number",
                                               id=vv, scope="global"), nid=f"O{j}{'bc'[k]}", urn=self.urn(did))
                g._by_id[o]["props"].pop("write", None)
                g.wire(chk, o, "output", "trigger")
        return g

    # ---------- 手动锁 / 光亮灯灭 ----------

    def manual_lock(self, z):
        g = Graph(f"{self.prefix}25{z['_i'] - 1}", f"手动锁_{z['rule']}")
        join = g.add("signalOr", {}, nid="J")
        for i, key in enumerate(z["switches"]):
            did, _, siid = key.partition(":")
            t = g.add("deviceInput", {"did": did, "siid": int(siid), "eiid": 1,
                                      "arguments": []}, nid=f"P{i+1}", urn=self.urn(did))
            g.wire(t, join, "output", f"input{i}")
        s = g.add("varSetNumber", {"id": lock_var(z["key"]), "scope": "global",
                                   "elements": [const(1)]}, nid="S1")
        g.wire(join, s)

        # 人走了就解锁：没有这一步，动过一次墙壁开关就永久失去感应
        pres = self.prop(z["sensor"], PRESENCE)
        gone = g.add("deviceInput", {"did": z["sensor"], "dtype": "int", "operator": "include",
                                     "siid": pres["siid"], "piid": pres["piid"], "v1": [0]}, nid="C1", urn=self.urn(z["sensor"]))
        d = g.add("delay", {"timeout": ms(z.get("unlock", z["delay"]))}, nid="C2")
        again = g.add("deviceGet", {"did": z["sensor"], "dtype": "int", "operator": "include",
                                    "siid": pres["siid"], "piid": pres["piid"], "v1": [0]}, nid="C3", urn=self.urn(z["sensor"]))
        clr = g.add("varSetNumber", {"id": lock_var(z["key"]), "scope": "global",
                                     "elements": [const(0)]}, nid="S2")
        g.wire(gone, d); g.wire(d, again); g.wire(again, clr)
        return g

    def light_off_when_bright(self, z):
        """光亮灯灭：天亮了把还亮着的灯关掉。"""
        g = Graph(f"{self.prefix}27{z['_i'] - 1}", f"光亮灯灭_{z['rule']}")
        start = g.add("onLoad", {}, nid="L0")
        lp = g.add("loop", {"interval": ms(self.house.get("brightCheck", "60s"))}, nid="L1")
        g.wire(start, lp, "output", "start")

        prev = lp
        for i, (var, val) in enumerate(self.gates(z)):
            nid = g.add("varGet", {"id": var, "scope": "global", "operator": "=",
                                   "v1": val, "varType": "number"}, nid=f"G{i}")
            g.wire(prev, nid)
            prev = nid

        did0, siid0, piid0 = self.on_prop(self.proxy(z))
        lit = g.add("deviceGet", {"did": did0, "dtype": "boolean", "operator": "=",
                                  "siid": siid0, "piid": piid0, "v1": True}, nid="D5", urn=self.urn(did0))
        g.wire(prev, lit)

        # 两道照度是**且**，不是或：开灯时任一暗就开，关灯要两个都亮才关。
        # 反过来会在只有一处见光时把灯关掉，人还在屋里。
        lux = self.prop(z["sensor"], LUX)
        bright = g.add("deviceGet", {"did": z["sensor"], "dtype": lux.get("fmt", "int"),
                                     "operator": ">", "siid": lux["siid"], "piid": lux["piid"],
                                     "v1": z["luxOff"]}, nid="D6", urn=self.urn(z["sensor"]))
        g.wire(lit, bright)
        gl = self.house.get("globalLux")
        if gl and z.get("luxOffGlobal") is not None:
            glp = self.prop(gl, LUX)
            gb = g.add("deviceGet", {"did": gl, "dtype": glp.get("fmt", "float"), "operator": ">",
                                     "siid": glp["siid"], "piid": glp["piid"],
                                     "v1": z["luxOffGlobal"]}, nid="D7", urn=self.urn(gl))
            g.wire(bright, gb)
            bright = gb
        for j, t in enumerate(self.off_lights(z), start=1):
            did, siid, piid = self.on_prop(t)
            o = g.add("deviceOutput", {"did": did, "siid": siid,
                                       "piid": piid, "value": False}, nid=f"E{j}", urn=self.urn(did))
            g.wire(bright, o, "output", "trigger")
        return g

    # ---------- 场景 ----------

    def scene_intent(self, s, i):
        """意图规则：只改模式变量，不碰设备。

        拆成意图/执行是极客版逼出来的：变量监听只响一次，所以「谁来改这个模式」
        和「模式变了做什么」必须分开写（见 ADR 与 README）。"""
        g = Graph(f"{self.prefix}23{i}", f"{s['name']}_意图")
        n = 0

        if s.get("on"):
            join = g.add("signalOr", {}, nid="J1")
            for k, trig in enumerate(s["on"]):
                n += 1
                g.wire(self.trigger(g, trig, f"V{n}"), join, "output", f"input{k}")
            g.wire(join, self.set_var(g, s["var"], 1, "S1"))

        if s.get("off"):
            join = g.add("signalOr", {}, nid="J0")
            for k, trig in enumerate(s["off"]):
                n += 1
                g.wire(self.trigger(g, trig, f"V{n}"), join, "output", f"input{k}")
            g.wire(join, self.set_var(g, s["var"], 0, "S0"))

        # 切换型：同一个键按一下切换。看代理灯亮不亮来决定往哪切 ——
        # 直接读模式变量的话，住户手动关了灯之后按键会「关上加关」。
        z = next((x for x in self.zones if x["key"] == s.get("zone")), None)
        for k, trig in enumerate(s.get("toggle", [])):
            n += 1
            t = self.trigger(g, trig, f"V{n}")
            did, siid, piid = self.on_prop(self.proxy(z) if z else s["proxy"])
            look = g.add("deviceGet", {"did": did, "dtype": "boolean", "operator": "=",
                                       "siid": siid, "piid": piid, "v1": True},
                         nid=f"T{k}", urn=self.urn(did))
            g.wire(t, look)
            g.wire(look, self.set_var(g, s["var"], 1, f"TU{k}"))          # 灯亮着 → 进场景
            g.wire(look, self.set_var(g, s["var"], 0, f"TD{k}"), "output2")  # 灯灭着 → 退出

        # 到点自动退出。翻转变量那套的另一半：进场景时起一个延时，
        # 到点再确认还在场景里才退 —— 中途手动退过就不该再动它。
        if s.get("timeout"):
            c = g.add("varChange", {"id": s["var"], "scope": "global", "operator": "=",
                                    "v1": 1, "varType": "number", "preload": False}, nid="D0")
            d = g.add("delay", {"timeout": ms(s["timeout"])}, nid="D1")
            still = g.add("varGet", {"id": s["var"], "scope": "global", "operator": "=",
                                     "v1": 1, "varType": "number"}, nid="D2")
            g.wire(c, d); g.wire(d, still)
            g.wire(still, self.set_var(g, s["var"], 0, "D3"))
        return g

    def set_var(self, g, var, val, nid):
        return g.add("varSetNumber", {"id": var, "scope": "global",
                                      "elements": [const(val)]}, nid=nid)

    def scene_exec(self, s, i):
        g = Graph(f"{self.prefix}24{i}", f"{s['name']}_执行")
        n = 0
        for val, key, tag in ((1, "do", "I"), (0, "undo", "O")):
            if not s.get(key):
                continue
            t = g.add("varChange", {"id": s["var"], "scope": "global", "operator": "=",
                                    "v1": val, "varType": "number", "preload": val == 1},
                      nid=f"C{val}")
            n = self.actions(g, s, s[key], t, n, tag)
        return g

    def actions(self, g, s, steps, prev, n, tag):
        # 进出场景都要清这个区的手动锁 —— 不清的话场景结束后感应就失灵了
        z = next((x for x in self.zones if x["key"] == s.get("zone")), None)
        if z and z.get("switches") and self.house.get("manualLock"):
            clr = self.set_var(g, lock_var(z["key"]), 0, f"{tag}L")
            g.wire(prev, clr)
        for step in steps:
            for tgt in step.get("targets", []):
                n += 1
                did, siid, piid = self.on_prop(tgt)
                act = step["act"]
                if act in ("关灯", "关窗帘"):
                    o = g.add("deviceOutput", {"did": did, "siid": siid,
                                               "piid": piid, "value": False}, nid=f"{tag}{n}", urn=self.urn(did))
                    g.wire(prev, o, "output", "trigger")
                elif act in ("开灯", "开窗帘"):
                    o = g.add("deviceOutput", {"did": did, "siid": siid,
                                               "piid": piid, "value": True}, nid=f"{tag}{n}", urn=self.urn(did))
                    g.wire(prev, o, "output", "trigger")
                    if act == "开灯" and self.dimmable(tgt):
                        for k, (pp, key) in enumerate([("2.2", "bri"), ("2.3", "cct")]):
                            v = step.get(key)
                            if v is None:
                                continue
                            spec = self.devices[did]["props"][pp]
                            props = dict(spec, did=did, dtype="number")
                            if isinstance(v, str):
                                props.update(id=v, scope="global")
                            else:
                                props.update(value=v)
                            o2 = g.add("deviceOutput", props, nid=f"{tag}{n}{'bc'[k]}", urn=self.urn(did))
                            g._by_id[o2]["props"].pop("write", None)
                            g.wire(prev, o2, "output", "trigger")
                elif act == "清手动锁":
                    o = g.add("varSetNumber", {"id": lock_var(tgt), "scope": "global",
                                               "elements": [const(0)]}, nid=f"{tag}{n}")
                    g.wire(prev, o)
                    prev = o
                else:
                    raise ValueError(f"不认识的动作「{act}」—— 词汇只有 关灯/开灯/开窗帘/关窗帘/清手动锁")
        return n

    def trigger(self, g, spec, nid):
        """触发源写法： did:siid click | did:siid prop <piid>=<v>"""
        parts = spec.split()
        did, _, siid = parts[0].partition(":")
        if len(parts) >= 3 and parts[1] == "prop":
            piid, _, v = parts[2].partition("=")
            return g.add("deviceInput", {"did": did, "dtype": "int", "operator": "include",
                                         "siid": int(siid), "piid": int(piid),
                                         "v1": [int(v)]}, nid=nid, urn=self.urn(did))
        return g.add("deviceInput", {"did": did, "siid": int(siid), "eiid": 1,
                                     "arguments": []}, nid=nid, urn=self.urn(did))

    # ---------- 全部 ----------

    def all_rules(self):
        out = []
        for z in self.zones:
            out.append((f"zone:{z['key']}:on", self.zone_on(z)))
            out.append((f"zone:{z['key']}:off", self.zone_off(z)))
            if z.get("switches") and self.house.get("manualLock"):
                out.append((f"lock:{z['key']}", self.manual_lock(z)))
            if self.house.get("lightOff") and z.get("luxOff") is not None:
                out.append((f"bright:{z['key']}", self.light_off_when_bright(z)))
        out.append(("house:probe", self.probe()))
        out.append(("house:night", self.night_mode()))
        out.append(("house:reset", self.morning_reset()))
        if self.house.get("hub"):
            out.append(("house:master", self.master_switch()))
            out.append(("house:allon", self.all_lights(True)))
            out.append(("house:alloff", self.all_lights(False)))
            if self.guest:
                out.append(("house:guest", self.guest_light()))
        out.append(("house:sync", self.sync_params()))
        for i, s in enumerate(self.scenes):
            out.append((f"scene:{s['var']}:intent", self.scene_intent(s, i)))
            if s.get("do"):
                out.append((f"scene:{s['var']}:exec", self.scene_exec(s, i)))
        return out


# ---------- 小工具 ----------

def pretty_duration(msv):
    """毫秒 → (数, 单位)，挑能整除的最大单位。极客版的卡片就是这么存的。"""
    # 单位只认 ms / s / min / hour —— 写 "h" 会被校验器拒
    for unit, size in (("hour", 3600000), ("min", 60000), ("s", 1000)):
        if msv % size == 0:
            return msv // size, unit
    return msv, "ms"


def cap(s):
    return s[0].upper() + s[1:]

def lock_var(key):
    return f"shouDong{cap(key)}"

def const(v):
    return {"type": "const", "value": str(v)}

def var_ref(name, scope="global"):
    return {"type": "var", "id": name, "scope": scope}

def ms(v):
    if isinstance(v, (int, float)):
        return int(v)
    m = re.fullmatch(r"(\d+)(ms|s|min|h)", str(v).strip())
    if not m:
        raise ValueError(f"时长写不对：{v}（要像 60s / 2min）")
    n, unit = int(m.group(1)), m.group(2)
    return n * {"ms": 1, "s": 1000, "min": 60000, "h": 3600000}[unit]

def hhmm(v):
    h, _, m = str(v).partition(":")
    return int(h), int(m)


def main(toml_path, devices_path, outdir, manifest_path=None):
    prev = None
    if manifest_path and os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as f:
            prev = json.load(f)

    home = Home(toml_path, devices_path, prev)
    os.makedirs(outdir, exist_ok=True)
    rules = {}
    for tag, g in home.all_rules():
        path = os.path.join(outdir, f"{g.id}_{g.name}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(g.json(), f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write("\n")
        rules[g.id] = tag

    # 槽位也写进清单 —— 下次生成靠它保持编号稳定。
    # 删掉的区的槽位**留在清单里**：号码不回收，免得新区捡到旧号，
    # 让网关日志里同一个 id 前后指两个不同的区。
    slots = dict((prev or {}).get("slots", {}))
    slots.update(home.slots)
    with open(os.path.join(outdir, "generated.json"), "w", encoding="utf-8") as f:
        json.dump({"slots": slots, "rules": rules}, f,
                  ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    print(f"生成 {len(rules)} 条 → {outdir}")


if __name__ == "__main__":
    if len(sys.argv) not in (4, 5):
        sys.exit(__doc__)
    main(*sys.argv[1:])
