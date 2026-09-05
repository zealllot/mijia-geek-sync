// 页面上摆出来的外观：房间和卡片的位置、背景。
//
// **和 dashboard.json 分开存。** 那份是手写、进 git 的语义地图（房间叫什么、
// 闸门链是什么、阈值能改到多少）；这份是**这一台机器的外观**。
// 分开之后住户怎么摆都不会跟你的配置打架，你也不用为了他挪了个房间去改 git。
//
// layout.json 是**页面写的**，所以读回来时当不可信输入清洗一遍。

export const DEFAULT_ROOM = { w: 186, h: 110 };
const GAP = 8;
const MAX = 4000;

// 位置覆盖上去，语义一个字都不许改。
export function applyLayout(config, layout) {
  if (!config) return config;
  const rooms = layout?.rooms ?? {};
  const tiles = layout?.tiles ?? {};

  const out = { ...config };

  if (config.floorplan) {
    out.floorplan = {
      ...config.floorplan,
      rooms: config.floorplan.rooms.map((r, i) => ({
        ...r,
        ...fallback(r, i),
        ...pick(rooms[r.title]),      // 只取位置四个字段 —— layout 不该能改语义
      })),
    };
  }

  if (config.groups) {
    out.groups = config.groups.map((g) => ({
      ...g,
      cards: g.cards.map((c) => ({ ...c, ...pick(tiles[cardRef(c)]) })),
    }));
  }
  return out;
}

export function cardRef(c) {
  return c.kind === 'rule' ? `rule.${c.ruleId}` : `${c.scope}.${c.id}`;
}

// 配置里没给位置就竖着排一列 —— 能画出来，而且一看就知道该去挪。
function fallback(room, i) {
  return {
    x: room.x ?? 0,
    y: room.y ?? i * (DEFAULT_ROOM.h + GAP),
    w: room.w ?? DEFAULT_ROOM.w,
    h: room.h ?? DEFAULT_ROOM.h,
  };
}

function pick(p) {
  if (!p) return {};
  const out = {};
  for (const k of ['x', 'y', 'w', 'h']) if (typeof p[k] === 'number') out[k] = p[k];
  return out;
}

// ---------- 清洗 ----------
export function sanitizeLayout(raw) {
  const out = {};
  const rooms = clean(raw?.rooms);
  const tiles = clean(raw?.tiles);
  if (rooms) out.rooms = rooms;
  if (tiles) out.tiles = tiles;

  const bg = cleanBackground(raw?.background);
  if (bg) out.background = bg;
  return out;
}

function clean(map) {
  if (!map || typeof map !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    // 四个字段缺一不可、必须是数 —— 半个位置画不出来，整条丢掉。
    if (!v || ['x', 'y', 'w', 'h'].some((f) => typeof v[f] !== 'number' || !Number.isFinite(v[f]))) continue;
    out[k] = {
      x: clamp(v.x, 0, MAX), y: clamp(v.y, 0, MAX),
      w: clamp(v.w, 40, MAX), h: clamp(v.h, 24, MAX),
    };
  }
  return Object.keys(out).length ? out : null;
}

function cleanBackground(bg) {
  if (!bg || typeof bg !== 'object') return undefined;

  if (bg.kind === 'color') {
    // 这个值会进 style —— 不挡的话等于让页面往 CSS 里写任意串。
    return /^#[0-9a-fA-F]{6}$/.test(bg.color ?? '') ? { kind: 'color', color: bg.color } : undefined;
  }

  if (bg.kind === 'image') {
    // 文件名会被拼进路径去读盘，挡住路径穿越。
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(bg.image ?? '') || bg.image.includes('..')) return undefined;
    return {
      kind: 'image',
      image: bg.image,
      blur: clamp(Number(bg.blur) || 0, 0, 40),
      dim: clamp(Number(bg.dim) || 0, 0, 0.95),
    };
  }
  return undefined;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(n * 100) / 100));
}
