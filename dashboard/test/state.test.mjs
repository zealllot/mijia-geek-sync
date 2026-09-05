import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildView } from '../lib/state.mjs';

const snapshot = {
  fetchedAt: '2026-09-05T10:00:00.000Z',
  rules: {
    '20260822110': { id: '20260822110', name: '光亮灯灭', enable: true },
    '20260822270': { id: '20260822270', name: '观影联动', enable: false },
  },
  variables: {
    global: {
      xggCinema: { type: 'number', value: 0, name: '观影模式' },
      xggLivingLux: { type: 'number', value: 50, name: '客厅照度阈值' },
    },
  },
};

test('没有配置时降级成扁平模式，列出全部变量和规则', () => {
  const view = buildView(null, snapshot);

  assert.deepEqual(
    view.groups.map((g) => g.title),
    ['global', '规则'],
  );
  assert.deepEqual(
    view.groups[0].cards.map((c) => [c.title, c.value]),
    [['观影模式', 0], ['客厅照度阈值', 50]],
  );
  assert.deepEqual(
    view.groups[1].cards.map((c) => [c.title, c.enable]),
    [['光亮灯灭', true], ['观影联动', false]],
  );
});

test('扁平模式下没有任何变量可写', () => {
  const view = buildView(null, snapshot);

  assert.deepEqual(view.writable, {});
  assert.equal(
    view.groups[0].cards.every((c) => c.kind === 'readonly'),
    true,
  );
});

const config = {
  groups: [
    {
      title: '客厅',
      cards: [
        { kind: 'toggle', title: '观影模式', scope: 'global', id: 'xggCinema', on: 1, off: 0 },
        { kind: 'readonly', title: '照度阈值', scope: 'global', id: 'xggLivingLux' },
        { kind: 'rule', title: '光亮灯灭', ruleId: '20260822110' },
      ],
    },
  ],
};

test('有配置时按配置分组，并给每张卡片填上网关的实时值', () => {
  const view = buildView(config, snapshot);

  assert.deepEqual(
    view.groups.map((g) => g.title),
    ['客厅'],
  );
  assert.deepEqual(view.groups[0].cards.map((c) => [c.kind, c.title, c.value ?? c.enable]), [
    ['toggle', '观影模式', 0],
    ['readonly', '照度阈值', 50],
    ['rule', '光亮灯灭', true],
  ]);
});

test('可写白名单记的是「允许写什么」，不只是「谁能写」', () => {
  const view = buildView(config, snapshot);

  assert.deepEqual(view.writable, {
    'global.xggCinema': { kind: 'toggle', on: 1, off: 0 },
  });
});

test('配置没引用到的变量和规则落进未归类区，不会凭空消失', () => {
  const view = buildView(config, snapshot);

  // xggLivingLux 和 xggCinema 都被引用了，20260822270 没有。
  assert.deepEqual(view.unmapped.rules.map((r) => r.title), ['观影联动']);
  assert.deepEqual(view.unmapped.variables, []);
});

test('配置只引用了一部分变量时，剩下的进未归类区', () => {
  const partial = { groups: [{ title: '客厅', cards: [{ kind: 'toggle', title: '观影模式', scope: 'global', id: 'xggCinema', on: 1, off: 0 }] }] };

  const view = buildView(partial, snapshot);

  assert.deepEqual(
    view.unmapped.variables.map((v) => [v.scope, v.id, v.value]),
    [['global', 'xggLivingLux', 50]],
  );
});

test('分组带 verdict 时求值并挂在分组上', () => {
  const withVerdict = {
    groups: [
      {
        title: '客厅',
        verdict: {
          blockers: [{ rule: '20260822270', enabled: false, say: '规则「观影联动」被停用了' }],
          ok: '一切正常',
        },
        cards: [],
      },
    ],
  };

  const view = buildView(withVerdict, snapshot);

  assert.deepEqual(view.groups[0].verdict, {
    blocked: true,
    say: '规则「观影联动」被停用了',
    cause: 'rule.20260822270',
    unresolved: [],
  });
});

test('卡片引用了网关上不存在的变量时标成 missing，而不是显示空值', () => {
  const stale = { groups: [{ title: '客厅', cards: [{ kind: 'readonly', title: '没了的变量', scope: 'global', id: 'xggGone' }] }] };

  const view = buildView(stale, snapshot);

  assert.equal(view.groups[0].cards[0].missing, true);
});

test('卡片引用了网关上不存在的规则时同样标成 missing', () => {
  const stale = { groups: [{ title: '客厅', cards: [{ kind: 'rule', title: '没了的规则', ruleId: '99999999999' }] }] };

  const view = buildView(stale, snapshot);

  assert.equal(view.groups[0].cards[0].missing, true);
});

test('引用存在时不标 missing', () => {
  const view = buildView(config, snapshot);

  assert.equal(view.groups[0].cards.some((c) => c.missing), false);
});

import { assertWritable } from '../lib/state.mjs';

const WL = {
  'global.xggCinema': { kind: 'toggle', on: 1, off: 0 },
  'global.xggBrightness': { kind: 'number', min: 1, max: 100 },
};

test('白名单里的开关，写它声明过的值放行', () => {
  assert.doesNotThrow(() => assertWritable(WL, 'global', 'xggCinema', 1));
  assert.doesNotThrow(() => assertWritable(WL, 'global', 'xggCinema', 0));
});

test('不在白名单里的变量拒绝写入', () => {
  assert.throws(() => assertWritable(WL, 'global', 'xggLivingLux', 1), /不在可写白名单/);
});

test('扁平模式（白名单为空）下一律拒绝写入', () => {
  assert.throws(() => assertWritable({}, 'global', 'xggCinema', 1), /不在可写白名单/);
});

test('开关只收它声明过的那两个值，别的一律拒绝', () => {
  // 只校验身份不校验值的话，POST {id:'ziDongHua', value:999} 会被原样写进网关。
  assert.throws(() => assertWritable(WL, 'global', 'xggCinema', 999), /只能是 1 或 0/);
});

test('数值超出声明的上下界要拒绝', () => {
  // 在别人家里，一个越界的亮度值可能让灯变成一个谁都没见过的状态。
  assert.doesNotThrow(() => assertWritable(WL, 'global', 'xggBrightness', 50));
  assert.throws(() => assertWritable(WL, 'global', 'xggBrightness', 0), /1 到 100/);
  assert.throws(() => assertWritable(WL, 'global', 'xggBrightness', 101), /1 到 100/);
});

test('数值必须是数，不能是别的东西', () => {
  assert.throws(() => assertWritable(WL, 'global', 'xggBrightness', 'abc'), /要填数字/);
});

test('造成阻塞的那张卡片被标成 culprit，好让页面只高亮它', () => {
  // 「开着」不值得高亮 —— 开着是常态。一屏里五块都亮就等于没有高亮。
  const cfg = {
    groups: [{
      title: '客厅',
      verdict: { blockers: [{ scope: 'global', id: 'xggCinema', equals: 0, say: '观影模式关着' }], ok: '正常' },
      cards: [
        { kind: 'toggle', title: '观影模式', scope: 'global', id: 'xggCinema', on: 1, off: 0 },
        { kind: 'readonly', title: '照度阈值', scope: 'global', id: 'xggLivingLux' },
      ],
    }],
  };

  const view = buildView(cfg, snapshot);

  assert.equal(view.groups[0].cards[0].culprit, true);
  assert.equal(view.groups[0].cards[1].culprit, undefined);
});

test('规则造成阻塞时高亮的是那条规则的卡片', () => {
  const cfg = {
    groups: [{
      title: '客厅',
      verdict: { blockers: [{ rule: '20260822270', enabled: false, say: 'x' }], ok: '正常' },
      cards: [
        { kind: 'rule', title: '光亮灯灭', ruleId: '20260822110' },
        { kind: 'rule', title: '观影联动', ruleId: '20260822270' },
      ],
    }],
  };

  const view = buildView(cfg, snapshot);

  assert.equal(view.groups[0].cards[0].culprit, undefined);
  assert.equal(view.groups[0].cards[1].culprit, true);
});

test('没被挡住时一张 culprit 都没有', () => {
  const view = buildView(config, snapshot);

  assert.equal(view.groups[0].cards.some((c) => c.culprit), false);
});

const floorplanCfg = {
  floorplan: {
    columns: ['186px', '296px'],
    rows: ['116px', '116px', '78px', '172px'],
    rooms: [
      { title: '卧室', col: 1, row: 1, chain: [{ scope: 'global', id: 'xggCinema', equals: 0, title: '观影模式', say: '观影模式开着' }] },
      { title: '客厅', col: 1, row: 2, chain: [{ scope: 'global', id: 'xggCinema', equals: 1, title: '观影模式', say: '观影模式关着' }] },
      { title: '主卫', col: 2, row: 3 },
    ],
  },
  groups: [],
};

test('配置里有 floorplan 时，视图带上逐间求值过的房间', () => {
  const view = buildView(floorplanCfg, snapshot);

  assert.deepEqual(
    view.floorplan.rooms.map((r) => [r.title, r.state]),
    [['卧室', 'clear'], ['客厅', 'blocked'], ['主卫', 'unconfigured']],
  );
});

test('房间保留网格位置，前端不用自己算', () => {
  const view = buildView(floorplanCfg, snapshot);

  assert.deepEqual(view.floorplan.rooms[2], {
    title: '主卫', col: 2, row: 3, state: 'unconfigured', say: '未配置', chain: [], lux: null, unresolved: [],
  });
});

test('顶部结论取第一个受阻的房间', () => {
  const view = buildView(floorplanCfg, snapshot);

  assert.deepEqual(view.headline, { title: '客厅', state: 'blocked', say: '观影模式关着', alsoBlocked: [] });
});

test('多个房间受阻时顶部列出其余的名字', () => {
  const two = { ...floorplanCfg, floorplan: { ...floorplanCfg.floorplan, rooms: [
    { title: '客厅', col: 1, row: 1, chain: [{ scope: 'global', id: 'xggCinema', equals: 1, title: 'x', say: '客厅受阻' }] },
    { title: '主卧', col: 1, row: 2, chain: [{ scope: 'global', id: 'xggCinema', equals: 1, title: 'x', say: '主卧受阻' }] },
  ] } };

  assert.deepEqual(buildView(two, snapshot).headline.alsoBlocked, ['主卧']);
});

test('没有房间受阻时顶部说一切正常', () => {
  const ok = { ...floorplanCfg, floorplan: { ...floorplanCfg.floorplan, rooms: [
    { title: '卧室', col: 1, row: 1, chain: [{ scope: 'global', id: 'xggCinema', equals: 0, title: 'x', say: 'y' }] },
  ] } };

  assert.equal(buildView(ok, snapshot).headline.state, 'clear');
});

test('没有 floorplan 的配置照常工作，不带房间', () => {
  const view = buildView(config, snapshot);

  assert.equal(view.floorplan, null);
  assert.equal(view.headline, null);
});
