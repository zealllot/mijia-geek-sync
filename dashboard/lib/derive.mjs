import { extractLuxMap, extractRoom } from './extract.mjs';

// 房间**从规则图现推**，不存进配置。
//
// 配置里原来混了两类东西：闸门链、阈值、照度变量、哪条规则是哪个区（规则图说了算，
// 你一改自动化就变），和房间叫什么、摆在哪、话怎么说（人说了算，只有想改才变）。
// 第一类存进配置就会过期 —— 而过期的后果是静默错答：图里加了一道闸，
// 配置不知道，那道闸挡住时页面照样说「没发现阻碍」。
//
// 看板本来就每隔几分钟拉一次规则图（为了读阈值），所以第一类现推几乎不要钱，
// 而且规则一变几分钟内自己就跟上 —— 不用重抠、重打包、重装。
//
// 配置只剩薄薄一层「人写的覆盖」：显示名、位置、话术、藏哪几个。

const DEFAULT = { w: 200, h: 116, gap: 8 };

export function deriveFloorplan(graphs, vars, overlay) {
  const hide = new Set(overlay?.hide ?? []);
  const over = overlay?.rooms ?? {};

  const probe = Object.values(graphs ?? {}).find((g) =>
    (g?.nodes ?? []).some((n) => n.type === 'deviceGetSetVar'));
  const luxMap = probe ? extractLuxMap(probe) : {};

  const rooms = [];
  for (const [ruleId, graph] of Object.entries(graphs ?? {})) {
    if (hide.has(ruleId)) continue;
    const name = graph?.cfg?.userData?.name ?? '';
    if (!/开灯/.test(name)) continue;

    const r = extractRoom(graph, luxMap, ruleId);
    if (!r.lux) continue;                     // 没有照度判定 = 场景规则，不是房间

    const o = over[ruleId] ?? {};
    rooms.push({
      // 人写的部分：显示名、位置
      title: o.title || r.zone,
      x: o.x ?? 0,
      y: o.y ?? rooms.length * (DEFAULT.h + DEFAULT.gap),
      w: o.w ?? DEFAULT.w,
      h: o.h ?? DEFAULT.h,
      // 机器推的部分：**覆盖层改不了**，不然又回到会过期的老路
      rule: ruleId,
      chain: r.chain.map((g) => ({
        ...g,
        title: vars?.[g.id]?.name ?? g.id,
        // 话术可以覆盖；没写就退回机器话 —— 读得懂就行，只是不如手写的顺。
        // 兜底得看这道闸等的是哪个值：「总开关 = 1」被挡住是它**关着**，
        // 一律说「开着」正好说反。
        say: o.say?.[g.id] ?? sayOf(vars?.[g.id]?.name ?? g.id, g.equals),
      })),
      lux: r.lux,
    });
  }
  return rooms;
}

// 旧配置（带完整闸门链的那种）直接当覆盖层用 —— 不用迁移，也不用改已发出去的包。
// 只取人写的那几样：显示名、位置、话术。chain 和 lux **不取**，
// 那正是会过期的部分，现推。
export function overlayFromConfig(cfg) {
  const rooms = {};
  for (const r of cfg?.floorplan?.rooms ?? []) {
    if (!r.rule) continue;
    const say = {};
    for (const g of r.chain ?? []) if (g.say && g.id) say[g.id] = g.say;

    rooms[r.rule] = {
      ...(r.title !== undefined ? { title: r.title } : {}),
      ...Object.fromEntries(['x', 'y', 'w', 'h'].filter((k) => r[k] !== undefined).map((k) => [k, r[k]])),
      ...(Object.keys(say).length ? { say } : {}),
    };
  }
  return { rooms, hide: cfg?.floorplan?.hide ?? [] };
}

function sayOf(name, equals) {
  return equals === 1 ? `${name}是关的` : `${name}开着`;
}
