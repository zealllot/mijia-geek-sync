#!/usr/bin/env bash
#
# mgs lint —— 拿看板的眼睛看一遍这户的规则图。
#
#   mgs lint <网关>
#
# 看板不读配置文件里抄来的信息，它**直接从规则图推**：哪些是区、闸门链是什么、
# 哪个变量是模式开关、哪个是参数、参数的上下界是多少（见 dashboard/lib/roles.mjs）。
# 推导认的是结构不是名字，所以自动化写成什么样，看板就理解成什么样。
#
# 这条命令把推导结果打出来，让「改完自动化」和「看板变成什么样」在一个屏幕里对上，
# 不用装一遍看板才知道少认了一个区。
#
# 全程只读本地文件，不连网关 —— 先 `mgs pull`。
set -uo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$LIB/common.sh"

# 不调 mgs_setup —— 那会去解析网关地址。lint 只读本地文件，不该碰网络。
GW="${1:?用法: mgs lint <网关>}"

DATADIR="$(mgs_data_dir "$GW")"
[ -d "$DATADIR/graph" ] || die "$DATADIR/graph 不存在 —— 先 mgs pull $GW"

DASH="$(cd "$LIB/.." && pwd)/dashboard"
DATADIR="$DATADIR" DASH="$DASH" node --input-type=module -e '
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.DATADIR, dash = process.env.DASH;
const { deriveFloorplan } = await import(join(dash, "lib/derive.mjs"));
const { deriveRoles } = await import(join(dash, "lib/roles.mjs"));

const G = join(dir, "graph");
const graphs = {};
for (const f of readdirSync(G)) {
  if (f.endsWith(".json")) graphs[f.replace(/_.*/, "").replace(".json", "")] = JSON.parse(readFileSync(join(G, f), "utf8"));
}
const vars = existsSync(join(dir, "variables.json"))
  ? JSON.parse(readFileSync(join(dir, "variables.json"), "utf8")).global ?? {}
  : {};

const name = (id) => vars[id]?.name ?? id;

// ---------- 区 ----------
const rooms = deriveFloorplan(graphs, vars, {});
console.log(`区 ${rooms.length} 个`);
for (const r of rooms) {
  const lux = r.lux.zoneThreshold !== undefined
    ? `本地<${r.lux.localThreshold} 或 全局<${r.lux.zoneThreshold}`
    : `本地<${r.lux.localThreshold}`;
  console.log(`  ${r.title.padEnd(6)} ${r.chain.map((g) => `${g.title}=${g.equals}`).join(" → ")} → ${lux}`);
}

// 名字里带「开灯」但没推成区的 —— 多半是少了照度判定，看板会当成场景规则跳过。
const missed = Object.entries(graphs).filter(([id, g]) =>
  /开灯/.test(g?.cfg?.userData?.name ?? "") && !rooms.some((r) => r.rule === id));
if (missed.length) {
  console.log(`\n  这几条名字里带「开灯」但没被当成区（看板里不会出现）：`);
  for (const [id, g] of missed) console.log(`    ${id} ${g.cfg.userData.name} —— 图里没有照度比较`);
}

// ---------- 变量 ----------
const roles = deriveRoles(graphs);
const bucket = { toggle: [], number: [], readonly: [], pulse: [] };
for (const [ref, r] of roles) bucket[r.kind]?.push([ref.slice(7), r]);

console.log(`\n模式开关 ${bucket.toggle.length} 个（看板上可以翻）`);
for (const [id] of bucket.toggle) console.log(`  ${id.padEnd(20)} ${name(id)}`);

console.log(`\n参数 ${bucket.number.length} 个（看板上可以改，上下界从 deviceOutput 节点来）`);
for (const [id, r] of bucket.number) {
  console.log(`  ${id.padEnd(20)} ${String(name(id)).padEnd(12)} ${r.min}-${r.max}${r.unit ?? ""}${r.applyWith ? `  写完自动脉冲 ${r.applyWith.id}` : ""}`);
}

if (bucket.pulse.length) {
  console.log(`\n翻转变量 ${bucket.pulse.length} 个（看板不显示，写完参数由服务端自动发）`);
  for (const [id] of bucket.pulse) console.log(`  ${id.padEnd(20)} ${name(id)}`);
}

// ---------- 认不出的 ----------
// 图里一次都没出现过的全局变量。看板会把它们扔进「未归类」显示成只读 ——
// 不是错误，但如果你以为某个开关能在看板上按，这里就是它没出现的原因。
const unseen = Object.keys(vars).filter((id) => !roles.has(`global.${id}`));
if (unseen.length) {
  console.log(`\n没在任何规则图里出现的全局变量 ${unseen.length} 个（看板里只读）`);
  for (const id of unseen) console.log(`  ${id.padEnd(20)} ${name(id)}`);
}

const guessed = [...roles].filter(([, r]) => r.kind === "readonly").length;
console.log(`\n只读 ${guessed} 个（探针写的快照、或者取值不止 0/1 的多档变量）`);
'
