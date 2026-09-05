import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateVerdict } from '../lib/verdict.mjs';

// 一份最小的线上快照：一条启用的规则，两个模式变量。
const snapshot = {
  rules: { '20260822110': { id: '20260822110', name: '光亮灯灭', enable: true } },
  variables: { global: { xggCinema: { type: 'number', value: 0, name: '观影模式' } } },
};

test('没有任何 blocker 命中时给出 ok 文案', () => {
  const v = evaluateVerdict(
    {
      blockers: [{ scope: 'global', id: 'xggCinema', equals: 1, say: '观影模式开着' }],
      ok: '一切正常，应该会自动亮',
    },
    snapshot,
  );

  assert.deepEqual(v, { blocked: false, say: '一切正常，应该会自动亮', cause: null, unresolved: [] });
});

test('变量等于指定值时命中该 blocker', () => {
  const cinemaOn = {
    ...snapshot,
    variables: { global: { xggCinema: { type: 'number', value: 1, name: '观影模式' } } },
  };

  const v = evaluateVerdict(
    {
      blockers: [{ scope: 'global', id: 'xggCinema', equals: 1, say: '观影模式开着，会压制自动亮灯' }],
      ok: '一切正常',
    },
    cinemaOn,
  );

  assert.deepEqual(v, { blocked: true, say: '观影模式开着，会压制自动亮灯', cause: 'global.xggCinema', unresolved: [] });
});

test('规则被停用时命中该 blocker', () => {
  const disabled = {
    ...snapshot,
    rules: { '20260822110': { id: '20260822110', name: '光亮灯灭', enable: false } },
  };

  const v = evaluateVerdict(
    { blockers: [{ rule: '20260822110', enabled: false, say: '规则「光亮灯灭」被停用了' }], ok: '一切正常' },
    disabled,
  );

  assert.deepEqual(v, { blocked: true, say: '规则「光亮灯灭」被停用了', cause: 'rule.20260822110', unresolved: [] });
});

test('规则启用着时不命中「被停用」的 blocker', () => {
  const v = evaluateVerdict(
    { blockers: [{ rule: '20260822110', enabled: false, say: '规则被停用了' }], ok: '一切正常' },
    snapshot,
  );

  assert.equal(v.blocked, false);
});

test('blocker 引用了网关上不存在的变量时，把它报成未解析而不是静默放行', () => {
  const v = evaluateVerdict(
    { blockers: [{ scope: 'global', id: 'xggGone', equals: 1, say: '不会命中' }], ok: '一切正常' },
    snapshot,
  );

  assert.equal(v.blocked, false);
  assert.deepEqual(v.unresolved, ['global.xggGone']);
});

test('blocker 引用了网关上不存在的规则时同样报成未解析', () => {
  const v = evaluateVerdict(
    { blockers: [{ rule: '99999999999', enabled: false, say: '不会命中' }], ok: '一切正常' },
    snapshot,
  );

  assert.deepEqual(v.unresolved, ['rule.99999999999']);
});

test('全部引用都解析得到时 unresolved 是空的', () => {
  const v = evaluateVerdict(
    { blockers: [{ scope: 'global', id: 'xggCinema', equals: 1, say: 'x' }], ok: '一切正常' },
    snapshot,
  );

  assert.deepEqual(v.unresolved, []);
});

test('命中时一并报出是哪一项造成的，好让页面把它高亮出来', () => {
  const cinemaOn = {
    ...snapshot,
    variables: { global: { xggCinema: { type: 'number', value: 1, name: '观影模式' } } },
  };

  const v = evaluateVerdict(
    { blockers: [{ scope: 'global', id: 'xggCinema', equals: 1, say: '观影模式开着' }], ok: '正常' },
    cinemaOn,
  );

  assert.equal(v.cause, 'global.xggCinema');
});

test('规则造成的阻塞报出规则引用', () => {
  const disabled = { ...snapshot, rules: { '20260822110': { id: '20260822110', name: '光亮灯灭', enable: false } } };

  const v = evaluateVerdict({ blockers: [{ rule: '20260822110', enabled: false, say: 'x' }], ok: '正常' }, disabled);

  assert.equal(v.cause, 'rule.20260822110');
});

test('没被挡住时没有 cause', () => {
  const v = evaluateVerdict({ blockers: [{ scope: 'global', id: 'xggCinema', equals: 1, say: 'x' }], ok: '正常' }, snapshot);

  assert.equal(v.cause, null);
});
