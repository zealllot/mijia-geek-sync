// 极客版模式看板 —— 本地 HTTP 服务。
//
//   node server.mjs                 起服务
//   node server.mjs --init-config   从活着的网关生成一份语义地图骨架，打到 stdout
//
// 只绑 127.0.0.1。住户家 WiFi 上的其他设备不该能翻他家的模式开关。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { makeGateway } from './lib/gateway.mjs';
import { makeCache } from './lib/cache.mjs';
import { buildView, assertWritable } from './lib/state.mjs';
import { loadConfig, buildSkeleton, buildFloorplanSkeleton, applyLiveThresholds } from './lib/config.mjs';
import { buildThresholdPatch, unexpectedChanges } from './lib/threshold.mjs';
import { applyLayout, sanitizeLayout, layoutProblems } from './lib/layout.mjs';
import { normalizeAddress, resolveMdns } from './lib/address.mjs';
import { autostartEnabled, setAutostart } from './lib/autostart.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.MGS_DASH_STATE_DIR
  || join(homedir(), 'Library', 'Application Support', 'MijiaDashboard');
// 语义地图的查找顺序：环境变量 → 住户机器上的那份 → .app 里打包进去的默认。
// 三个都没有就是扁平只读模式（装上就能用，但看不到房间和结论）。
//
// **每次现算，不在启动时定死** —— 不然把新配置丢进 Application Support 之后
// 不重启就不认，人会以为「放了没用」。
function configPath() {
  return process.env.MGS_DASH_CONFIG
    || [join(STATE_DIR, 'dashboard.json'), join(HERE, 'config', 'dashboard.json')].find((p) => existsSync(p))
    || join(STATE_DIR, 'dashboard.json');
}
const PORT = Number(process.env.MGS_DASH_PORT || 7391);

mkdirSync(STATE_DIR, { recursive: true });

// ---------- token ----------
// 本地 HTTP 服务的经典问题：住户浏览器里任何一个网页都能往 127.0.0.1 发请求。
// 持久化 token（不是每次启动重生成）好处是住户可以直接收藏这个地址。
function loadToken() {
  const p = join(STATE_DIR, 'token');
  if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  const t = randomBytes(24).toString('hex');
  writeFileSync(p, t, { mode: 0o600 });
  chmodSync(p, 0o600);
  return t;
}
const TOKEN = loadToken();

// ---------- 网关地址 ----------
//
// IP 是 DHCP 分的，会变 —— 所以地址必须能在登录页上改，而且改完立刻生效。
// 打包时写死一个意味着地址一变，住户就只能等我重新打包。
//
// 三层：住户上次**登录成功**用的 → .app 里打包时写死的默认 → 空（让他自己填）。
const LAYOUT_FILE = join(STATE_DIR, 'layout.json');

// 外观（位置、背景）跟语义配置分开存 —— 见 lib/layout.mjs。
function loadLayout() {
  try { return sanitizeLayout(JSON.parse(readFileSync(LAYOUT_FILE, 'utf8'))); } catch { return {}; }
}

const ADDRESS_FILE = join(STATE_DIR, 'address.json');

// 地址被环境变量钉住 = `mgs serve` 那条路径：地址是 common.sh 解析好传进来的，
// 登录页不该再问一遍。.app 那边没有这个变量，地址就归住户填。
const PINNED = Boolean(process.env.MGS_DASH_BASE_URL);
let lastTried = null;   // 住户这次填的，即使登录失败也留着，好让他改错字
let currentBase = null; // 已经解析成 http:// 的那个

function savedAddress() {
  try { return JSON.parse(readFileSync(ADDRESS_FILE, 'utf8')).input || null; } catch { return null; }
}

// 打包时写死的默认。整个文件缺失是正常的 —— 住户自己填就行。
function bundledDefault() {
  const p = join(HERE, 'config', 'gateway.json');
  if (!existsSync(p)) return null;
  try {
    const g = JSON.parse(readFileSync(p, 'utf8'));
    return g.mdns || g.fallback || null;
  } catch { return null; }
}

// 登录页该预填什么。
function suggestion() {
  return lastTried ?? savedAddress() ?? bundledDefault() ?? '';
}

// 钉住时不带 address 字段 —— 前端据此决定要不要画地址输入框。
function askAddress() {
  return PINNED ? {} : { address: suggestion() };
}

// mDNS 实例名比 IP 耐用 —— DHCP 换地址它自己会跟着走。
async function resolveToBase(normalized) {
  if (!normalized.startsWith('mdns://')) return normalized;
  const inst = normalized.slice(7);
  const ip = await resolveMdns(inst);
  if (!ip) throw new Error(`mDNS 解析不到「${inst}」—— 换成填 IP 试试`);
  return `http://${ip}`;
}

function xggCli() {
  if (process.env.MGS_DASH_XGG) return process.env.MGS_DASH_XGG;
  for (const p of [
    join(HERE, 'xgg', 'node_modules', '@eyaeya', 'xgg-cli', 'dist', 'cli.js'),
    join(HERE, '..', 'node_modules', '@eyaeya', 'xgg-cli', 'dist', 'cli.js'),
  ]) if (existsSync(p)) return p;
  throw new Error('找不到 xgg —— 设 MGS_DASH_XGG 指向 cli.js');
}

const gw = makeGateway({
  nodeBin: process.execPath,
  xggCli: xggCli(),
  baseUrl: () => currentBase,          // 现取，不冻住
  snapshotsDir: join(STATE_DIR, 'snapshots'),
});

// 启动时先按上次的地址试一把 —— agent 进程要是还活着，住户不用重新登录。
// 解析不出来不是错误，只是意味着登录页要让他填。
if (process.env.MGS_DASH_BASE_URL) {
  currentBase = process.env.MGS_DASH_BASE_URL;
} else if (suggestion()) {
  try { currentBase = await resolveToBase(normalizeAddress(suggestion())); } catch { currentBase = null; }
}

// 语义地图每次读盘：文件小，而且这样改完配置刷新页面就生效，不用重启。
function config() {
  return loadConfig(configPath());
}

const cache = makeCache({ ttlMs: 10_000, load: () => gw.snapshot() });

// 规则图单独缓存：阈值写在图里，但它是配置、几乎不变，所以 5 分钟拉一次就够。
// 只拉 floorplan 里用到的那几条，不是全部三十几条。
const graphCache = makeCache({
  ttlMs: 5 * 60_000,
  load: () => gw.graphsFor([...new Set((config()?.floorplan?.rooms ?? []).map((r) => r.rule).filter(Boolean))]),
});

// 图里所有节点的 v1，键是 `<规则>.<节点>`。读不到就返回 null（没登录时会这样），
// 那时用配置里的兜底值。
async function liveThresholds() {
  const rooms = config()?.floorplan?.rooms ?? [];
  if (!rooms.some((r) => r.lux?.zoneThresholdNode)) return null;
  try {
    const graphs = await graphCache.get();
    const out = {};
    for (const [ruleId, g] of Object.entries(graphs)) {
      for (const n of g.nodes ?? []) if (n.props?.v1 !== undefined) out[`${ruleId}.${n.id}`] = n.props.v1;
    }
    return out;
  } catch { return null; }
}

// ---------- --init-config ----------
if (process.argv.includes('--init-config')) {
  if (!currentBase) {
    process.stderr.write('还没有网关地址 —— 设 MGS_DASH_BASE_URL，或者先在页面上登录一次\n');
    process.exit(2);
  }
  const runtimePatterns = (process.env.MGS_DASH_RUNTIME_VARS || '').split(',').filter(Boolean);
  const snap = await gw.snapshot();
  const skeleton = buildSkeleton(snap, { runtimePatterns });

  // 房间那层要看规则图本身（闸门和阈值都写在图里），比快照多一轮拉取。
  process.stderr.write('拉规则图（抠闸门和阈值）…\n');
  skeleton.floorplan = buildFloorplanSkeleton(await gw.graphs(), snap);
  process.stderr.write(`  ${skeleton.floorplan.rooms.length} 个房间 —— 位置要你自己挪，话术要你自己改\n`);

  process.stdout.write(JSON.stringify(skeleton, null, 2) + '\n');
  process.exit(0);
}

// ---------- HTTP ----------
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

// 上限按路由给。普通 JSON 64KB 足够；背景图走 base64，一张 186KB 的图
// 编码后就有 250KB —— 用同一个上限会在真正的图片检查之前先炸。
async function readBody(req, maxBytes = 64 * 1024) {
  let s = '';
  for await (const c of req) {
    s += c;
    if (s.length > maxBytes) {
      throw new Error(`请求体过大（超过 ${Math.round(maxBytes / 1024)}KB）`);
    }
  }
  return s ? JSON.parse(s) : {};
}

const routes = {
  async 'GET /api/state'() {
    // 还没有地址：这不是故障，是第一次用（或者 .app 没打包默认地址）。
    if (!currentBase) return { ok: false, loggedIn: false, ...askAddress() };

    let snapshot;
    try {
      snapshot = await cache.get();
    } catch (e) {
      // 会话过期是常态不是异常 —— 页面要把它当首屏，不是报错。
      if (e.code === 'AUTH_REQUIRED') return { ok: false, loggedIn: false, ...askAddress() };
      return { ok: false, loggedIn: null, error: e.message, ...askAddress() };
    }

    const view = buildView(
      applyLayout(applyLiveThresholds(config(), await liveThresholds()), loadLayout()),
      snapshot,
    );
    return { ok: true, loggedIn: true, ...view, layout: loadLayout(), gatewayErrors: snapshot.errors };
  },

  async 'POST /api/login'(req) {
    const { address, code } = await readBody(req);
    if (!/^\d{6}$/.test(String(code ?? ''))) return { ok: false, error: '登录码是 6 位数字' };

    if (PINNED) {
      const r = await gw.login(String(code));
      if (r.ok === false) return { ok: false, error: r.error?.message ?? '登录失败，码可能已经用过或过期了' };
      cache.invalidate();
      return { ok: true };
    }

    // 住户填的地址留着，登录失败也留 —— 好让他在页面上改错字，
    // 而不是被打回到上一个（已经连不上的）地址。
    const input = String(address ?? '').trim() || suggestion();
    lastTried = input;

    let base;
    try {
      base = await resolveToBase(normalizeAddress(input));
    } catch (e) {
      return { ok: false, error: e.message, address: input };
    }
    currentBase = base;

    const r = await gw.login(String(code));
    if (r.ok === false) {
      // **不保存** —— 存一个连不上的地址会把下次的默认值弄坏。
      return { ok: false, error: r.error?.message ?? '登录失败，码可能已经用过或过期了', address: input };
    }

    // 只有登录成功才落盘，而且存住户填的原文（可能是 mDNS 实例名），不是解析后的 IP。
    writeFileSync(ADDRESS_FILE, JSON.stringify({ input, base }, null, 2), { mode: 0o600 });
    lastTried = null;
    cache.invalidate();
    return { ok: true };
  },

  async 'POST /api/variable'(req) {
    const { scope, id, value } = await readBody(req);
    const snapshot = await cache.get();
    const view = buildView(config(), snapshot);

    // 白名单校验的是「允许写**什么**」：开关只收它声明过的两个值，
    // 数值只收界内的数。只校验身份的话，往开关里 POST 999 也会被写进网关。
    const num = typeof value === 'number' ? value : Number(value);
    assertWritable(view.writable, scope, id, Number.isNaN(num) ? value : num);

    const before = snapshot.variables[scope]?.[id];
    if (!before) throw new Error(`${scope}.${id} 在网关上不存在`);

    const r = await gw.setVariable({ scope, id, value: num, type: before.type });
    if (r.ok === false) return { ok: false, error: r.error?.message ?? '网关拒绝了这次写入' };

    // 在别人家里改他正在生效的状态，得留痕。
    appendFileSync(
      join(STATE_DIR, 'writes.log'),
      `${new Date().toISOString()}\t${scope}.${id}\t${JSON.stringify(before.value)} → ${JSON.stringify(num)}\n`,
    );

    // 脉冲：极客版的 varChange 只监听得到一次，规则那边用「写 1 → 执行链第一步
    // 写回 0」的翻转法绕开。所以改完参数要紧跟一发，否则灯不动 ——
    // 这一步由服务端做，不指望人记着自己去戳。
    const apply = view.writable[`${scope}.${id}`]?.applyWith;
    if (apply) {
      const t = snapshot.variables[apply.scope]?.[apply.id];
      if (!t) {
        return { ok: false, error: `值写进去了，但同步变量 ${apply.scope}.${apply.id} 在网关上不存在 —— 灯不会动` };
      }
      const pulse = await gw.setVariable({ scope: apply.scope, id: apply.id, value: apply.value, type: t.type });
      if (pulse.ok === false) {
        return { ok: false, error: `值写进去了，但同步没发出去：${pulse.error?.message ?? '网关拒绝'} —— 灯不会动` };
      }
      appendFileSync(
        join(STATE_DIR, 'writes.log'),
        `${new Date().toISOString()}\t${apply.scope}.${apply.id}\t同步脉冲 → ${JSON.stringify(apply.value)}\n`,
      );
    }

    // 不做乐观更新：立刻重读，页面显示网关的真实值。
    cache.invalidate();
    return { ok: true };
  },

  async 'GET /api/layout'() {
    return { ok: true, layout: loadLayout() };
  },

  // 页面写的，所以清洗一遍再落盘 —— 位置会进 style，颜色会进 CSS 变量。
  async 'POST /api/layout'(req) {
    const raw = await readBody(req);
    const bad = layoutProblems(raw);

    // 丢了必须说。静默丢弃正是「保存了但没生效」这类问题的来源。
    if (bad.length) return { ok: false, error: bad.join('；') };

    const clean = sanitizeLayout(raw);
    writeFileSync(LAYOUT_FILE, JSON.stringify(clean, null, 2));
    return { ok: true, layout: clean };
  },

  // 背景图。存进 Application Support，页面用 /bg?t=… 取。
  async 'POST /api/background'(req) {
    const { dataUrl } = await readBody(req, 12 * 1024 * 1024);   // base64 比原图大约三分之一
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
    if (!m) return { ok: false, error: '只收 png / jpeg / webp' };

    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 6 * 1024 * 1024) return { ok: false, error: `图太大了（${(buf.length / 1048576).toFixed(1)}MB），压到 6MB 以内` };

    // 用时间戳做文件名：换图时旧的 /bg 缓存不会顶掉新图。
    const name = `background-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    writeFileSync(join(STATE_DIR, name), buf);

    // **只存文件，不碰 layout.json** —— 落盘是「保存」那一步的事。
    // 上传就写盘的话，用户点「取消」也取消不掉已经传上去的图。
    return { ok: true, image: name };
  },

  // 看板唯一会写规则图的地方。
  //
  // 区阈值不是变量（deviceGet 的比较值只收字面量），所以改它只能改图。
  // 两头上锁：补丁做到最小（threshold.mjs），写完回读整张图逐字段比对。
  async 'POST /api/threshold'(req) {
    const { rule, node, value } = await readBody(req);
    const rooms = config()?.floorplan?.rooms ?? [];

    // 白名单：只能改 floorplan 里声明过的那一个 (规则, 节点)。
    const room = rooms.find((r) => r.rule === rule && r.lux?.zoneThresholdNode === node);
    if (!room) return { ok: false, error: `${rule}.${node} 不在可改的阈值清单里` };

    // 没声明上下界就不给改 —— 每个房间必须显式开启，不是默认能改。
    const range = room.lux.zoneThresholdRange;
    if (!Array.isArray(range) || typeof range[0] !== 'number' || typeof range[1] !== 'number') {
      return { ok: false, error: `${room.title} 的阈值没有声明可改范围，不给改` };
    }
    const v = Number(value);
    if (!Number.isFinite(v)) return { ok: false, error: '要填数字' };
    if (v < range[0] || v > range[1]) return { ok: false, error: `要在 ${range[0]} 到 ${range[1]} 之间` };

    const before = await gw.graph(rule);
    const target = (before.nodes ?? []).find((n) => n.id === node);
    if (!target) return { ok: false, error: `规则 ${rule} 上没有节点 ${node}` };
    const was = target.props?.v1;
    if (was === v) return { ok: true };

    const r = await gw.updateNode(rule, node, buildThresholdPatch(target, v));
    if (r.ok === false) return { ok: false, error: r.error?.message ?? '网关拒绝了这次写入' };

    // 回读比对。「只改了阈值这一个」不能靠嘴保证 —— 这是在别人家里改正在跑的自动化。
    const after = await gw.graph(rule);
    const bad = unexpectedChanges(before, after, node, v);

    appendFileSync(
      join(STATE_DIR, 'writes.log'),
      `${new Date().toISOString()}\t规则 ${rule} 节点 ${node} 阈值\t${was} → ${v}` +
        `${bad.length ? `\t!! 意外改动：${bad.join('；')}` : ''}\n`,
    );

    graphCache.invalidate();
    cache.invalidate();

    if (bad.length) {
      return { ok: false, error: `阈值写进去了，但改动不止这一处：${bad.join('；')}。` +
        `快照在 ${join(STATE_DIR, 'snapshots')}，用 mgs pull 对一下。` };
    }
    return { ok: true };
  },

  // 脚本型 .app 在 Dock 上不一定收得到 Cmd-Q，所以页面上给一个明确的出口。
  async 'POST /api/quit'() {
    setTimeout(() => process.exit(0), 120);
    return { ok: true };
  },

  async 'GET /api/autostart'() {
    return { ok: true, enabled: autostartEnabled() };
  },

  async 'POST /api/autostart'(req) {
    const { enabled } = await readBody(req);
    setAutostart(Boolean(enabled), { port: PORT });
    return { ok: true, enabled: autostartEnabled() };
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(res, 200, readFileSync(join(HERE, 'public', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
  }

  const guarded = url.pathname.startsWith('/api/') || url.pathname === '/bg';
  if (!guarded) return send(res, 404, { ok: false, error: 'not found' });

  // CSS 的 url() 带不了自定义头，所以 /bg 的 token 走查询串。
  const given = req.headers['x-dash-token'] || url.searchParams.get('t');
  if (given !== TOKEN) return send(res, 403, { ok: false, error: 'token 不对 —— 从应用图标重新打开一次' });

  if (url.pathname === '/bg') {
    // 编辑中还没保存的图也要能预览，所以允许用 ?img= 指名。
    const asked = url.searchParams.get('img');
    const bg = asked && /^background-\d+\.(png|jpg|webp)$/.test(asked)
      ? { kind: 'image', image: asked }
      : loadLayout().background;
    if (bg?.kind !== 'image') return send(res, 404, { ok: false, error: 'no background' });
    const p = join(STATE_DIR, bg.image);
    if (!existsSync(p)) return send(res, 404, { ok: false, error: 'no background' });
    const type = bg.image.endsWith('.png') ? 'image/png' : bg.image.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    return res.end(readFileSync(p));
  }

  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { ok: false, error: 'not found' });

  try {
    send(res, 200, await handler(req));
  } catch (e) {
    send(res, 200, { ok: false, error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // 已经有一份在跑 —— 第二次双击就该只是打开浏览器，而不是起第二个服务。
    process.stdout.write(`ALREADY_RUNNING http://127.0.0.1:${PORT}/?t=${TOKEN}\n`);
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`READY http://127.0.0.1:${PORT}/?t=${TOKEN}\n`);
});
