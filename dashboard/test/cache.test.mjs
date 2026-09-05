import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCache } from '../lib/cache.mjs';

test('同一时刻的并发请求共享一次拉取', async () => {
  let loads = 0;
  const cache = makeCache({
    ttlMs: 10_000,
    load: async () => {
      loads++;
      return 'snapshot';
    },
  });

  const [a, b, c] = await Promise.all([cache.get(), cache.get(), cache.get()]);

  assert.deepEqual([a, b, c], ['snapshot', 'snapshot', 'snapshot']);
  assert.equal(loads, 1);
});

test('TTL 内的后续请求直接用缓存', async () => {
  let loads = 0;
  let clock = 0;
  const cache = makeCache({ ttlMs: 10_000, now: () => clock, load: async () => ++loads });

  await cache.get();
  clock = 9_999;
  await cache.get();

  assert.equal(loads, 1);
});

test('TTL 过后重新拉取', async () => {
  let loads = 0;
  let clock = 0;
  const cache = makeCache({ ttlMs: 10_000, now: () => clock, load: async () => ++loads });

  await cache.get();
  clock = 10_001;
  await cache.get();

  assert.equal(loads, 2);
});

test('invalidate 之后立刻重新拉取', async () => {
  // 翻完一个开关必须马上重读 —— 不做乐观更新，页面上要显示网关的真实值。
  let loads = 0;
  const cache = makeCache({ ttlMs: 10_000, now: () => 0, load: async () => ++loads });

  await cache.get();
  cache.invalidate();
  await cache.get();

  assert.equal(loads, 2);
});

test('拉取失败不会把失败结果缓存住', async () => {
  let loads = 0;
  const cache = makeCache({
    ttlMs: 10_000,
    now: () => 0,
    load: async () => {
      loads++;
      if (loads === 1) throw new Error('网关超时');
      return 'ok';
    },
  });

  await assert.rejects(() => cache.get(), /网关超时/);
  assert.equal(await cache.get(), 'ok');
  assert.equal(loads, 2);
});
