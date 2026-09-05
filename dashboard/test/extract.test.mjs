import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLuxMap, extractRoom } from '../lib/extract.mjs';

// 形状照抄 1302 的真实规则图，但传感器 id 和数值是合成的 ——
// 住户的规则数据不进这个公开仓库（data/ 被 gitignore 也是同一个理由）。
const probeGraph = {
  nodes: [
    { id: 'S1', type: 'loop', props: { interval: 300000 } },
    { id: 'G1', type: 'deviceGetSetVar', props: { did: 'sensor-global', id: 'luxQuanJu', scope: 'global' } },
    { id: 'G2', type: 'deviceGetSetVar', props: { did: 'sensor-a', id: 'luxJinMen', scope: 'global' } },
  ],
};

// 接线照抄真实图：闸门串在照度之前，昼夜分支挂在照度之后。
const N = (id, type, props, outputs) => ({ id, type, props, outputs });
const openGraph = {
  cfg: { enable: true, userData: { name: '进门_有人_开灯' } },
  nodes: [
    N('A4',  'varGet',    { scope: 'global', id: 'yeJian', operator: '=', v1: 1 }, { output: ['O1.input'], output2: ['O2.input'] }),
    N('G',   'varGet',    { scope: 'global', id: 'ziDongHua', operator: '=', v1: 1 }, { output: ['G2.input'], output2: [] }),
    N('G2',  'varGet',    { scope: 'global', id: 'guanYing', operator: '=', v1: 0 }, { output: ['M.input'], output2: [] }),
    N('M',   'varGet',    { scope: 'global', id: 'shouDongJinMen', operator: '=', v1: 0 }, { output: ['A2.input'], output2: [] }),
    N('A2',  'deviceGet', { did: 'light-1', dtype: 'boolean', operator: '=', v1: false }, { output: ['A3.input'], output2: [] }),
    N('A3',  'deviceGet', { did: 'sensor-a', dtype: 'int', operator: '<', v1: 100 }, { output: ['A3or.input'], output2: ['A3b.input'] }),
    N('A3b', 'deviceGet', { did: 'sensor-global', dtype: 'float', operator: '<', v1: 1000 }, { output: ['A3or.input2'], output2: [] }),
    N('A3or', 'signalOr', {}, { output: ['A4.input'] }),
    N('X1',  'varChange', { scope: 'global', id: 'guanYing', operator: '=', v1: 0 }, { output: ['G.input'], output2: [] }),
  ],
};

test('从探针规则建出「传感器 → 照度变量」的映射', () => {
  assert.deepEqual(extractLuxMap(probeGraph), { 'sensor-global': 'luxQuanJu', 'sensor-a': 'luxJinMen' });
});

test('把开灯规则里的闸门按图中顺序抠成链', () => {
  const r = extractRoom(openGraph, extractLuxMap(probeGraph), '20260822160');

  assert.deepEqual(r.chain.map((g) => [g.id, g.equals]), [
    ['ziDongHua', 1], ['guanYing', 0], ['shouDongJinMen', 0],
  ]);
});

test('varChange 是触发器不是闸门，不能混进链里', () => {
  // X1 也是读 guanYing 的，但它是「变量一变就触发」，不是「必须等于某值才放行」。
  const r = extractRoom(openGraph, extractLuxMap(probeGraph), '20260822160');

  assert.equal(r.chain.length, 3);
});

test('两道照度比较抠成阈值，并映射到对应的照度变量', () => {
  const r = extractRoom(openGraph, extractLuxMap(probeGraph), '20260822160');

  assert.deepEqual(r.lux, {
    local: 'luxJinMen', localThreshold: 100, localThresholdNode: 'A3',
    global: 'luxQuanJu', zoneThreshold: 1000, zoneThresholdNode: 'A3b',
  });
});

test('布尔型 deviceGet 是「灯已灭」，不是照度，要跳过', () => {
  // A2 读的是灯本身。极客版读不到设备属性，所以看板复刻不了这一道。
  const r = extractRoom(openGraph, extractLuxMap(probeGraph), '20260822160');

  assert.equal(r.lux.localThreshold, 100);
  assert.equal(r.chain.some((g) => g.id === 'light-1'), false);
});

test('区名从规则名里取', () => {
  assert.equal(extractRoom(openGraph, {}, '20260822160').zone, '进门');
});

test('传感器没在探针里出现时不编造变量名，报出来', () => {
  const r = extractRoom(openGraph, { 'sensor-global': 'luxQuanJu' }, '20260822160');

  assert.equal(r.lux, null);
  assert.deepEqual(r.warnings, ['sensor-a 不在照度探针里，抠不出本地照度变量']);
});

test('照度之后的 varGet 是昼夜分支，不是闸门', () => {
  // 1302 的 A4 读 yeJian：夜间用夜灯亮度、白天用正常亮度。它在「决定要开灯」之后。
  // 按文档顺序抠会把它当闸门 —— 白天 yeJian=0 时页面就会说「受阻：夜间模式不是 1」，全错。
  // 判据只能是拓扑：闸门是能走到照度比较的那些。
  const r = extractRoom(openGraph, extractLuxMap(probeGraph), '20260822160');

  assert.equal(r.chain.some((g) => g.id === 'yeJian'), false);
});

test('把阈值所在的节点 id 也带出来 —— 要改它就得知道改哪个节点', () => {
  const r = extractRoom(openGraph, extractLuxMap(probeGraph), '20260822160');

  assert.equal(r.lux.zoneThresholdNode, 'A3b');
  assert.equal(r.lux.localThresholdNode, 'A3');
});
