import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/gateway.mjs';

test('空输出要重试', () => {
  assert.equal(classify('').retryable, true);
});

test('解析不成 JSON 的输出要重试', () => {
  assert.equal(classify('note: something\n').retryable, true);
});

test('合法但很短的响应不算失败', () => {
  // mgs 早期用「小于 60 字节 = 失败」，在一台没有规则域变量的中枢上
  // 把这个 32 字节的合法响应当成了失败。判据必须是「能不能解析成 JSON」。
  const short = '{"ok":true,"scopes":["global"]}';
  assert.equal(short.length < 60, true);

  const c = classify(short);
  assert.equal(c.retryable, false);
  assert.deepEqual(c.data, { ok: true, scopes: ['global'] });
});

test('ok:false 是确定的答案，不重试', () => {
  // 未登录时每 10 秒的轮询都重试三次纯属浪费 —— AUTH_REQUIRED 是答案，不是故障。
  const c = classify('{"ok":false,"error":{"code":"AUTH_REQUIRED"}}');

  assert.equal(c.retryable, false);
  assert.equal(c.data.error.code, 'AUTH_REQUIRED');
});

import { normalizeSnapshot } from '../lib/gateway.mjs';

// 这两个形状是从 xgg 2.1.0 的 dist 里读出来的，不是猜的：
//   variable watch  → commands/variable.js 的 flattenForJson
//   rule list       → lib/enable.sh 在生产上用的字段
const watchOut = {
  op: 'snapshot',
  ts: 1757068800000,
  iso: '2026-09-05T10:00:00.000Z',
  scopes: ['global'],
  variables: { global: { xggCinema: { type: 'number', value: 1, name: '观影模式' } } },
  errors: {},
};
const ruleListOut = {
  rules: [{ id: '20260822110', enable: true, userData: { name: '光亮灯灭' } }],
};

test('把 xgg 的两份原始输出归一成视图层要的快照', () => {
  const s = normalizeSnapshot(watchOut, ruleListOut);

  assert.deepEqual(s.variables, {
    global: { xggCinema: { type: 'number', value: 1, name: '观影模式' } },
  });
  assert.deepEqual(s.rules, {
    '20260822110': { id: '20260822110', name: '光亮灯灭', enable: true },
  });
  assert.equal(s.fetchedAt, '2026-09-05T10:00:00.000Z');
});

test('规则没有名字时不炸，退回用 id', () => {
  const s = normalizeSnapshot(watchOut, { rules: [{ id: '20260822110', enable: false }] });

  assert.equal(s.rules['20260822110'].name, null);
  assert.equal(s.rules['20260822110'].enable, false);
});

test('把 watch 报出来的分 scope 错误带上，不能悄悄吞掉', () => {
  const s = normalizeSnapshot({ ...watchOut, errors: { R123: 'timeout' } }, ruleListOut);

  assert.deepEqual(s.errors, { R123: 'timeout' });
});

import { callXgg } from '../lib/gateway.mjs';

test('偶发返空时重试，拿到有效 JSON 就停', () => {
  // rule view / rule list 会偶发返空且不报错（退出码仍是 0）。
  let attempts = 0;
  const run = async () => {
    attempts++;
    return attempts < 3 ? '' : '{"rules":[]}';
  };

  return callXgg(['rule', 'list'], { run }).then((r) => {
    assert.deepEqual(r, { rules: [] });
    assert.equal(attempts, 3);
  });
});

test('ok:false 一次就返回，不浪费两次往返', () => {
  let attempts = 0;
  const run = async () => {
    attempts++;
    return '{"ok":false,"error":{"code":"AUTH_REQUIRED"}}';
  };

  return callXgg(['status'], { run }).then((r) => {
    assert.equal(r.error.code, 'AUTH_REQUIRED');
    assert.equal(attempts, 1);
  });
});

test('三次都拿不到有效响应就抛出结构化错误', async () => {
  let attempts = 0;
  const run = async () => {
    attempts++;
    return '';
  };

  await assert.rejects(() => callXgg(['rule', 'list'], { run }), /rule list/);
  assert.equal(attempts, 3);
});

import { unwrap } from '../lib/gateway.mjs';

test('ok:false 的响应不能被当成数据用', () => {
  // 端到端时踩到的：未登录时 variable watch 返回 ok:false，
  // normalizeSnapshot 拿到它、variables 退成 {}，
  // 于是「没登录」被伪装成了「网关上什么都没有」，页面显示「一切正常，0 项」。
  assert.throws(() => unwrap({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'No session' } }, 'variable watch'));
});

test('抛出的错误带上 code，好让调用方分辨未登录和别的故障', () => {
  try {
    unwrap({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'No session' } }, 'variable watch');
    assert.fail('应该抛出');
  } catch (e) {
    assert.equal(e.code, 'AUTH_REQUIRED');
    assert.match(e.message, /variable watch/);
  }
});

test('正常响应原样放行', () => {
  assert.deepEqual(unwrap({ rules: [] }, 'rule list'), { rules: [] });
  assert.deepEqual(unwrap({ ok: true, scopes: [] }, 'variable list'), { ok: true, scopes: [] });
});

import { xggEnv } from '../lib/gateway.mjs';

test('每次调用现取网关地址，不是启动时冻住的那个', () => {
  // 地址是 DHCP 分的，会变。住户在登录页上改完必须立刻生效 ——
  // 早期版本在 makeGateway 时就把 baseUrl 算进 env 里，改了也不认。
  let base = 'http://192.168.5.25';
  const get = () => base;

  assert.equal(xggEnv(get, '/tmp/s').XGG_BASE_URL, 'http://192.168.5.25');
  base = 'http://192.168.5.99';
  assert.equal(xggEnv(get, '/tmp/s').XGG_BASE_URL, 'http://192.168.5.99');
});

test('提示文字必须关掉，否则会混进 JSON', () => {
  const env = xggEnv(() => 'http://x', '/tmp/s');

  assert.equal(env.XGG_NO_REFRESH_HINT, '1');
  assert.equal(env.XGG_NO_NEXT_HINT, '1');
});

test('还没有地址时不编一个，让调用方去问住户', () => {
  assert.throws(() => xggEnv(() => null, '/tmp/s'), /还没有网关地址/);
});

test('stdout 空但 stderr 有合法 JSON 时，用 stderr 的', () => {
  // xgg 把**错误**写 stderr、成功写 stdout。只收 stdout 的话，
  // 所有失败都会变成「拿不到有效响应」—— 真实原因（登录码过期之类）全丢了。
  const c = classify('', '{"ok":false,"error":{"code":"AUTH_REQUIRED","message":"gateway rejected"}}');

  assert.equal(c.retryable, false);
  assert.equal(c.data.error.code, 'AUTH_REQUIRED');
});

test('stdout 有货就不看 stderr —— stderr 里常混着警告', () => {
  const c = classify('{"ok":true,"rules":[]}', '[xgg] warning: something');

  assert.deepEqual(c.data, { ok: true, rules: [] });
});

test('两边都解析不出来才算失败', () => {
  assert.equal(classify('', '[xgg] warning: not json').retryable, true);
  assert.equal(classify('', '').retryable, true);
});
