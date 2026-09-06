import { join } from 'node:path';

// 多户：一户 = 一个网关 + 一份语义地图 + 一套外观。
//
// 三样都得跟着切 —— 两户的房间、闸门链、平面图位置都不一样。
// 会话不用管：xgg 的会话本来就是按网关分条存的，切过去登录过就直接能用。
//
// 没有 houses.json 就是单户模式，文件名不带后缀 —— 跟已经发出去的包兼容。

// id 会被拼进文件名（dashboard.<id>.json），所以必须挡住路径穿越：
// 不挡的话等于让配置指定读写哪个文件。
const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/;

export function sanitizeHouses(raw) {
  if (!Array.isArray(raw)) return [];

  const out = [];
  const seen = new Set();
  for (const h of raw) {
    if (!h || !SAFE_ID.test(h.id ?? '')) continue;
    if (seen.has(h.id)) continue;              // 重复的只留第一个
    if (!h.mdns && !h.fallback) continue;      // 不知道连哪，留着没用

    seen.add(h.id);
    out.push({
      id: h.id,
      name: String(h.name || h.id),
      ...(h.mdns ? { mdns: String(h.mdns) } : {}),
      ...(h.fallback ? { fallback: String(h.fallback) } : {}),
    });
  }
  return out;
}

// 记着的那户没了就退回第一户 —— 配置里删掉一户之后，看板不该打不开。
export function pickHouse(houses, wantedId) {
  if (!houses.length) return null;
  return houses.find((h) => h.id === wantedId) ?? houses[0];
}

export function houseFile(dir, kind, id) {
  return join(dir, id ? `${kind}.${id}.json` : `${kind}.json`);
}
