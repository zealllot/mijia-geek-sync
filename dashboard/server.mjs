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
import { loadConfig, buildSkeleton } from './lib/config.mjs';
import { resolveGateway } from './lib/address.mjs';
import { autostartEnabled, setAutostart } from './lib/autostart.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.MGS_DASH_STATE_DIR
  || join(homedir(), 'Library', 'Application Support', 'MijiaDashboard');
const CONFIG_PATH = process.env.MGS_DASH_CONFIG || join(STATE_DIR, 'dashboard.json');
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
async function baseUrl() {
  if (process.env.MGS_DASH_BASE_URL) return process.env.MGS_DASH_BASE_URL;
  // 用户可写的配置优先；.app 里带一份打包时写死的默认值兜底。
  // bundle 内部是只读的（换版本会被整个替换），所以真正的配置放 Application Support。
  for (const p of [join(STATE_DIR, 'gateway.json'), join(HERE, 'config', 'gateway.json')]) {
    if (existsSync(p)) return resolveGateway(JSON.parse(readFileSync(p, 'utf8')));
  }
  throw new Error(`还没配网关：写一份 ${join(STATE_DIR, 'gateway.json')}，内容形如 {"mdns":"...","fallback":"192.168.1.100"}`);
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
  baseUrl: await baseUrl(),
  snapshotsDir: join(STATE_DIR, 'snapshots'),
});

// 语义地图每次读盘：文件小，而且这样改完配置刷新页面就生效，不用重启。
function config() {
  return loadConfig(CONFIG_PATH);
}

const cache = makeCache({ ttlMs: 10_000, load: () => gw.snapshot() });

// ---------- --init-config ----------
if (process.argv.includes('--init-config')) {
  const runtimePatterns = (process.env.MGS_DASH_RUNTIME_VARS || '').split(',').filter(Boolean);
  const skeleton = buildSkeleton(await gw.snapshot(), { runtimePatterns });
  process.stdout.write(JSON.stringify(skeleton, null, 2) + '\n');
  process.exit(0);
}

// ---------- HTTP ----------
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

async function readBody(req) {
  let s = '';
  for await (const c of req) {
    s += c;
    if (s.length > 64 * 1024) throw new Error('请求体过大');
  }
  return s ? JSON.parse(s) : {};
}

const routes = {
  async 'GET /api/state'() {
    let snapshot;
    try {
      snapshot = await cache.get();
    } catch (e) {
      // 会话过期是常态不是异常 —— 页面要把它当首屏，不是报错。
      if (e.code === 'AUTH_REQUIRED') return { ok: false, loggedIn: false };
      return { ok: false, loggedIn: null, error: e.message };
    }

    const view = buildView(config(), snapshot);
    return { ok: true, loggedIn: true, ...view, gatewayErrors: snapshot.errors };
  },

  async 'POST /api/login'(req) {
    const { code } = await readBody(req);
    if (!/^\d{6}$/.test(String(code ?? ''))) return { ok: false, error: '登录码是 6 位数字' };

    const r = await gw.login(String(code));
    if (r.ok === false) return { ok: false, error: r.error?.message ?? '登录失败，码可能已经用过或过期了' };

    cache.invalidate();
    return { ok: true };
  },

  async 'POST /api/variable'(req) {
    const { scope, id, value } = await readBody(req);
    const snapshot = await cache.get();
    const view = buildView(config(), snapshot);

    // 白名单：只有配置里显式声明成 toggle 的变量能写。
    assertWritable(view.writable, scope, id);

    const before = snapshot.variables[scope]?.[id];
    if (!before) throw new Error(`${scope}.${id} 在网关上不存在`);

    const r = await gw.setVariable({ scope, id, value, type: before.type });
    if (r.ok === false) return { ok: false, error: r.error?.message ?? '网关拒绝了这次写入' };

    // 在别人家里改他正在生效的状态，得留痕。
    appendFileSync(
      join(STATE_DIR, 'writes.log'),
      `${new Date().toISOString()}\t${scope}.${id}\t${JSON.stringify(before.value)} → ${JSON.stringify(value)}\n`,
    );

    // 不做乐观更新：立刻重读，页面显示网关的真实值。
    cache.invalidate();
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

  if (!url.pathname.startsWith('/api/')) return send(res, 404, { ok: false, error: 'not found' });

  const given = req.headers['x-dash-token'] || url.searchParams.get('t');
  if (given !== TOKEN) return send(res, 403, { ok: false, error: 'token 不对 —— 从应用图标重新打开一次' });

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
