import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, buildSkeleton } from '../lib/config.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mgs-dash-'));

test('配置文件不存在时返回 null，交给扁平模式降级', () => {
  assert.equal(loadConfig(join(dir, '不存在.json')), null);
});

test('配置文件语法坏掉时抛错，不静默降级', () => {
  // 静默降级会让人以为「本来就没配」，改错一个逗号却查不出来。
  const p = join(dir, 'broken.json');
  writeFileSync(p, '{ "groups": [ }');

  assert.throws(() => loadConfig(p), /broken\.json/);
});

test('toggle 卡片缺 on/off 时抛错并指出是哪张卡', () => {
  const p = join(dir, 'incomplete.json');
  writeFileSync(p, JSON.stringify({ groups: [{ title: '客厅', cards: [{ kind: 'toggle', title: '观影模式', scope: 'global', id: 'xggCinema' }] }] }));

  assert.throws(() => loadConfig(p), /观影模式/);
});

test('合法配置原样读出来', () => {
  const cfg = { groups: [{ title: '客厅', cards: [{ kind: 'rule', title: '光亮灯灭', ruleId: '1' }] }] };
  const p = join(dir, 'good.json');
  writeFileSync(p, JSON.stringify(cfg));

  assert.deepEqual(loadConfig(p), cfg);
});

const snapshot = {
  fetchedAt: '2026-09-05T10:00:00.000Z',
  variables: {
    global: {
      xggCinema: { type: 'number', value: 1, name: '观影模式' },
      xggLivingLux: { type: 'number', value: 50, name: '客厅照度阈值' },
    },
    R20260822110: { step: { type: 'number', value: 3, name: '当前步骤' } },
  },
  rules: { '20260822110': { id: '20260822110', name: '光亮灯灭', enable: true } },
};

test('骨架把匹配 runtimeVars 的 0/1 全局变量生成成可翻的开关', () => {
  const cfg = buildSkeleton(snapshot, { runtimePatterns: ['^xggCinema$'] });

  const card = cfg.groups.find((g) => g.title === 'global').cards.find((c) => c.id === 'xggCinema');
  assert.deepEqual(card, { kind: 'toggle', title: '观影模式', scope: 'global', id: 'xggCinema', on: 1, off: 0 });
});

test('骨架把不匹配 runtimeVars 的全局变量生成成只读', () => {
  const cfg = buildSkeleton(snapshot, { runtimePatterns: ['^xggCinema$'] });

  const card = cfg.groups.find((g) => g.title === 'global').cards.find((c) => c.id === 'xggLivingLux');
  assert.equal(card.kind, 'readonly');
});

test('规则域变量一律只读，绝不生成成可翻的开关', () => {
  // R 开头的 scope 是规则内部状态。翻它们等于伸手进规则肚子里，
  // 不是住户该在看板上做的事 —— 哪怕 mgs 把它们算作运行时变量。
  const cfg = buildSkeleton(snapshot, { runtimePatterns: ['.*'] });

  const group = cfg.groups.find((g) => g.title === 'R20260822110');
  assert.equal(group.cards.every((c) => c.kind === 'readonly'), true);
});

test('骨架把全部规则生成成一组只读卡片', () => {
  const cfg = buildSkeleton(snapshot, { runtimePatterns: [] });

  assert.deepEqual(cfg.groups.find((g) => g.title === '规则').cards, [
    { kind: 'rule', title: '光亮灯灭', ruleId: '20260822110' },
  ]);
});

test('生成的骨架自己能通过校验', () => {
  const p = join(dir, 'skeleton.json');
  writeFileSync(p, JSON.stringify(buildSkeleton(snapshot, { runtimePatterns: ['^xgg'] })));

  assert.doesNotThrow(() => loadConfig(p));
});

import { buildFloorplanSkeleton } from '../lib/config.mjs';

const probe = { nodes: [
  { id: 'S1', type: 'loop', props: { interval: 300000 } },
  { id: 'G1', type: 'deviceGetSetVar', props: { did: 'sg', id: 'luxQuanJu', scope: 'global' } },
  { id: 'G2', type: 'deviceGetSetVar', props: { did: 'sa', id: 'luxJinMen', scope: 'global' } },
] };
const open = { cfg: { userData: { name: '进门_有人_开灯' } }, nodes: [
  { id: 'G',  type: 'varGet',    props: { scope: 'global', id: 'ziDongHua', operator: '=', v1: 1 }, outputs: { output: ['G2.input'] } },
  { id: 'G2', type: 'varGet',    props: { scope: 'global', id: 'guanYing', operator: '=', v1: 0 }, outputs: { output: ['A3.input'] } },
  { id: 'A3', type: 'deviceGet', props: { did: 'sa', dtype: 'int', operator: '<', v1: 100 }, outputs: { output2: ['A3b.input'] } },
  { id: 'A3b', type: 'deviceGet', props: { did: 'sg', dtype: 'float', operator: '<', v1: 1000 }, outputs: {} },
] };
const names = { variables: { global: {
  ziDongHua: { type: 'number', value: 1, name: '灯光自动化总开关' },
  guanYing: { type: 'number', value: 0, name: '观影模式' },
} } };

test('骨架从探针和开灯规则生成房间，一个数都不用手写', () => {
  const fp = buildFloorplanSkeleton({ '20260822996': probe, '20260822160': open }, names);

  assert.equal(fp.rooms.length, 1);
  assert.deepEqual(fp.rooms[0].lux, {
    local: 'luxJinMen', localThreshold: 100, localThresholdNode: 'A3',
    global: 'luxQuanJu', zoneThreshold: 1000, zoneThresholdNode: 'A3b',
  });
  assert.equal(fp.rooms[0].rule, '20260822160');
});

test('闸门的标题用变量的中文名，不是变量 id', () => {
  const fp = buildFloorplanSkeleton({ '20260822996': probe, '20260822160': open }, names);

  assert.deepEqual(fp.rooms[0].chain.map((g) => g.title), ['灯光自动化总开关', '观影模式']);
});

test('闸门的说法按「要等于几才放行」反推：等于 0 就是「开着会挡」', () => {
  const fp = buildFloorplanSkeleton({ '20260822996': probe, '20260822160': open }, names);

  assert.deepEqual(fp.rooms[0].chain.map((g) => g.say), ['灯光自动化总开关是关的', '观影模式开着']);
});

test('房间先竖着排一列，位置留给人去挪', () => {
  // 网格位置是数据里没有的东西，只能人给。骨架先给个能用的排法。
  const fp = buildFloorplanSkeleton({ '20260822996': probe, '20260822160': open }, names);

  assert.deepEqual([fp.rooms[0].col, fp.rooms[0].row], [1, 1]);
  assert.equal(Array.isArray(fp.columns), true);
});

test('没有照度判定的「开灯」规则是场景，不是房间', () => {
  // 1302 的 20260822210_全屋开灯 是个场景规则。按名字含「开灯」来过滤会把它当成房间。
  const scene = { cfg: { userData: { name: '全屋开灯' } }, nodes: [
    { id: 'A', type: 'varGet', props: { scope: 'global', id: 'ziDongHua', operator: '=', v1: 1 }, outputs: {} },
  ] };

  const fp = buildFloorplanSkeleton({ '20260822996': probe, '20260822160': open, '20260822210': scene }, names);

  assert.deepEqual(fp.rooms.map((r) => r.title), ['进门']);
});

test('被跳过的「开灯」规则要报出来，不能悄悄吞掉', () => {
  const scene = { cfg: { userData: { name: '全屋开灯' } }, nodes: [] };

  const fp = buildFloorplanSkeleton({ '20260822996': probe, '20260822160': open, '20260822210': scene }, names);

  assert.deepEqual(fp.skipped, [{ rule: '20260822210', name: '全屋开灯', why: '没有照度判定，看着像场景规则' }]);
});

test('number 卡片缺 min/max 时抛错', () => {
  // 没有上下界就等于「能写任意数」——在别人家里，那可能让灯变成谁都没见过的状态。
  const p2 = join(dir, 'nobounds.json');
  writeFileSync(p2, JSON.stringify({ groups: [{ title: '全屋', cards: [
    { kind: 'number', title: '全局亮度', scope: 'global', id: 'quanJuLiangDu' },
  ] }] }));

  assert.throws(() => loadConfig(p2), /全局亮度/);
});

test('number 卡片有 min/max 时通过', () => {
  const p2 = join(dir, 'bounds.json');
  writeFileSync(p2, JSON.stringify({ groups: [{ title: '全屋', cards: [
    { kind: 'number', title: '全局亮度', scope: 'global', id: 'quanJuLiangDu', min: 1, max: 100 },
  ] }] }));

  assert.doesNotThrow(() => loadConfig(p2));
});

test('min 比 max 大是配置写反了，要挡住', () => {
  const p2 = join(dir, 'flipped.json');
  writeFileSync(p2, JSON.stringify({ groups: [{ title: '全屋', cards: [
    { kind: 'number', title: '全局色温', scope: 'global', id: 'quanJuSeWen', min: 6500, max: 2700 },
  ] }] }));

  assert.throws(() => loadConfig(p2), /写反/);
});
