import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveFloorplan } from '../lib/derive.mjs';

const N = (id, type, props, outputs) => ({ id, type, props, outputs });
const probe = { nodes: [
  N('S', 'loop', { interval: 300000 }, {}),
  N('G1', 'deviceGetSetVar', { did: 'sa', id: 'luxCanTing', scope: 'global' }, {}),
  N('G2', 'deviceGetSetVar', { did: 'sb', id: 'luxXuanGuan', scope: 'global' }, {}),
] };
const openRule = (zone, sensor, gates) => ({
  cfg: { enable: true, userData: { name: `${zone}_有人_开灯` } },
  nodes: [
    ...gates.map((g, i) => N(`G${i}`, 'varGet', { scope: 'global', id: g, operator: '=', v1: 0 },
      { output: [i + 1 < gates.length ? `G${i + 1}.input` : 'A3.input'] })),
    N('A3', 'deviceGet', { did: sensor, dtype: 'int', operator: '<', v1: 300 }, {}),
  ],
});
const graphs = {
  '996': probe,
  '001': openRule('餐厅', 'sa', ['ziDongHua', 'huiKe']),
  '003': openRule('玄关', 'sb', ['ziDongHua']),
  '210': { cfg: { userData: { name: '全屋开灯' } }, nodes: [] },
};
const vars = { ziDongHua: { name: '灯光自动化总开关' }, huiKe: { name: '会客模式' } };

test('房间直接从规则图推出来 —— 配置里不存闸门链', () => {
  const rooms = deriveFloorplan(graphs, vars, {});

  assert.deepEqual(rooms.map((r) => r.title), ['餐厅', '玄关']);
  assert.deepEqual(rooms[0].chain.map((g) => g.id), ['ziDongHua', 'huiKe']);
});

test('规则里加一道闸，下次推导自动带上 —— 这就是不用重打包的原因', () => {
  const before = deriveFloorplan({ ...graphs, '003': openRule('玄关', 'sb', ['ziDongHua']) }, vars, {});
  const after = deriveFloorplan({ ...graphs, '003': openRule('玄关', 'sb', ['ziDongHua', 'huiKe']) }, vars, {});

  assert.deepEqual(before[1].chain.map((g) => g.id), ['ziDongHua']);
  assert.deepEqual(after[1].chain.map((g) => g.id), ['ziDongHua', 'huiKe']);
});

test('闸门标题用变量的中文名', () => {
  const rooms = deriveFloorplan(graphs, vars, {});

  assert.deepEqual(rooms[0].chain.map((g) => g.title), ['灯光自动化总开关', '会客模式']);
});

test('覆盖层能改显示名和位置，改不了闸门', () => {
  const rooms = deriveFloorplan(graphs, vars, {
    rooms: { '001': { title: '客厅', x: 10, y: 20, w: 200, h: 100, chain: [], rule: '偷改' } },
  });

  assert.equal(rooms[0].title, '客厅');
  assert.equal(rooms[0].x, 10);
  assert.deepEqual(rooms[0].chain.map((g) => g.id), ['ziDongHua', 'huiKe']);   // 语义不许被覆盖
  assert.equal(rooms[0].rule, '001');
});

test('覆盖层能给某道闸门写人话', () => {
  const rooms = deriveFloorplan(graphs, vars, {
    rooms: { '001': { say: { huiKe: '会客模式开着，餐厅的感应停住了' } } },
  });

  assert.equal(rooms[0].chain[1].say, '会客模式开着，餐厅的感应停住了');
});

test('没写人话就退回机器话，读得懂就行', () => {
  const rooms = deriveFloorplan(graphs, vars, {});

  assert.equal(rooms[0].chain[1].say, '会客模式开着');
});

test('hide 里的规则不出现 —— 电梯口那种住户不关心的', () => {
  const rooms = deriveFloorplan(graphs, vars, { hide: ['003'] });

  assert.deepEqual(rooms.map((r) => r.title), ['餐厅']);
});

test('没给位置时竖着排，能画出来但一看就知道要挪', () => {
  const rooms = deriveFloorplan(graphs, vars, {});

  assert.equal(typeof rooms[0].x, 'number');
  assert.notEqual(rooms[0].y, rooms[1].y);
});

test('新建一个区，下次推导自己冒出来', () => {
  const rooms = deriveFloorplan({ ...graphs, '005': openRule('阳台', 'sa', ['ziDongHua']) }, vars, {});

  assert.deepEqual(rooms.map((r) => r.title), ['餐厅', '玄关', '阳台']);
});

test('场景规则不算房间', () => {
  assert.equal(deriveFloorplan(graphs, vars, {}).some((r) => r.title === '全屋开灯'), false);
});

// ---- 旧配置直接当覆盖层用，不用迁移 ----
import { overlayFromConfig } from '../lib/derive.mjs';

test('旧配置里的显示名、位置、话术自动变成覆盖层', () => {
  const cfg = { floorplan: { rooms: [
    { title: '客厅', rule: '001', x: 5, y: 6, w: 100, h: 50,
      chain: [{ id: 'huiKe', say: '会客模式开着，客厅的感应停住了' }, { id: 'ziDongHua' }],
      lux: { local: 'x', localThreshold: 1 } },
  ] } };

  const o = overlayFromConfig(cfg);

  assert.deepEqual(o.rooms['001'], {
    title: '客厅', x: 5, y: 6, w: 100, h: 50,
    say: { huiKe: '会客模式开着，客厅的感应停住了' },
  });
});

test('配置里的 chain 和 lux 不进覆盖层 —— 那正是会过期的部分', () => {
  const cfg = { floorplan: { rooms: [{ title: 'a', rule: '001', chain: [{ id: 'x' }], lux: { local: 'y' } }] } };

  const o = overlayFromConfig(cfg);

  assert.equal(o.rooms['001'].chain, undefined);
  assert.equal(o.rooms['001'].lux, undefined);
});

test('hide 带过去 —— 电梯口那种不想显示的', () => {
  assert.deepEqual(overlayFromConfig({ floorplan: { hide: ['140'] } }).hide, ['140']);
});

test('没有配置时是个空覆盖层，不是崩', () => {
  assert.deepEqual(overlayFromConfig(null), { rooms: {}, hide: [] });
});

test('默认话术要看闸门等的是哪个值', () => {
  // 「总开关 = 1」被挡住，意思是它**关着**；说成「开着」正好相反。
  // 人写了 say 就听人的，这只是没写时的兜底。
  const rule = {
    cfg: { enable: true, userData: { name: '餐厅_有人_开灯' } },
    nodes: [
      N('G0', 'varGet', { scope: 'global', id: 'ziDongHua', operator: '=', v1: 1 }, { output: ['G1.input'] }),
      N('G1', 'varGet', { scope: 'global', id: 'huiKe', operator: '=', v1: 0 }, { output: ['A3.input'] }),
      N('A3', 'deviceGet', { did: 'sa', dtype: 'int', operator: '<', v1: 300 }, {}),
    ],
  };

  const [room] = deriveFloorplan({ '996': probe, '001': rule }, vars, {});

  assert.equal(room.chain[0].say, '灯光自动化总开关是关的');
  assert.equal(room.chain[1].say, '会客模式开着');
});
