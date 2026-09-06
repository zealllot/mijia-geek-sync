import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRoles } from '../lib/roles.mjs';

// 形状照着真实规则图，值是编的。
const node = (id, type, props, outputs = {}) => ({ id, type, props, outputs, cfg: {} });

// 探针：从传感器读照度写进变量
const probe = { nodes: [
  node('G0', 'deviceGetSetVar', { did: 'blt.1', dtype: 'number', id: 'luxCanTing', scope: 'global', piid: 1, siid: 3 }),
] };

// 开灯规则：两道闸门 + 照度比较
const light = { nodes: [
  node('G', 'varGet', { id: 'ziDongHua', operator: '=', scope: 'global', v1: 1, varType: 'number' }),
  node('H', 'varGet', { id: 'huiKe', operator: '=', scope: 'global', v1: 0, varType: 'number' }),
] };

// 全局参数同步：翻转变量触发，第一步写回 0，然后把参数写进灯
const sync = { nodes: [
  node('T2', 'varChange', { id: 'tongBu', operator: '=', scope: 'global', v1: 1, varType: 'number' }),
  node('Z', 'varSetNumber', { id: 'tongBu', scope: 'global', elements: [{ type: 'const', value: '0' }] }),
  node('B0', 'deviceOutput', { did: '1', dtype: 'number', id: 'quanJuLiangDu', scope: 'global', min: 1, max: 100, step: 1, siid: 2, piid: 2 }),
  node('B1', 'deviceOutput', { did: '2', dtype: 'number', id: 'quanJuLiangDu', scope: 'global', min: 5, max: 90, step: 1, siid: 2, piid: 2 }),
  node('C0', 'deviceOutput', { did: '1', dtype: 'number', id: 'quanJuSeWen', scope: 'global', min: 3000, max: 6400, step: 1, siid: 2, piid: 3 }),
] };

const graphs = { r1: probe, r2: light, r3: sync };

test('探针写进去的变量是只读快照', () => {
  // deviceGetSetVar 是「从设备读一个值写进变量」—— 那是传感器的话，人写不得。
  assert.equal(deriveRoles(graphs).get('global.luxCanTing').kind, 'readonly');
});

test('只在比较里出现、取值 0/1 的变量是模式开关', () => {
  const roles = deriveRoles(graphs);

  assert.deepEqual(roles.get('global.ziDongHua'), { kind: 'toggle', on: 1, off: 0 });
  assert.deepEqual(roles.get('global.huiKe'), { kind: 'toggle', on: 1, off: 0 });
});

test('写进设备属性的变量是数值卡，上下界从图里来', () => {
  assert.equal(deriveRoles(graphs).get('global.quanJuSeWen').kind, 'number');
});

test('多盏灯的范围取交集 —— 按最宽的写会把某盏灯写进它不认的值', () => {
  // 一盏收 1-100，另一盏只收 5-90。能安全写给所有灯的只有 5-90。
  const r = deriveRoles(graphs).get('global.quanJuLiangDu');

  assert.equal(r.min, 5);
  assert.equal(r.max, 90);
});

test('亮度带 % ，色温带 K', () => {
  const roles = deriveRoles(graphs);

  assert.equal(roles.get('global.quanJuLiangDu').unit, '%');
  assert.equal(roles.get('global.quanJuSeWen').unit, 'K');
});

test('翻转变量自己不出卡，但会变成参数卡的脉冲目标', () => {
  // 「varChange 触发 + 执行链第一步写回 0」是极客版里唯一能重复触发的写法。
  // 看板得认得出来：写完参数得替人补一脚，不然改了不生效。
  const roles = deriveRoles(graphs);

  assert.equal(roles.get('global.tongBu').kind, 'pulse');
  assert.deepEqual(roles.get('global.quanJuLiangDu').applyWith, { scope: 'global', id: 'tongBu', value: 1 });
});

test('别处还当闸门读的，就不是脉冲 —— 那是真模式', () => {
  // 观影模式在「意图」规则里也是 varChange 触发 + 写回 0，
  // 但它在好几条开灯规则里被 varGet 读作条件。真正的翻转变量（同步）从来没人读。
  const intent = { nodes: [
    node('T', 'varChange', { id: 'guanYing', operator: '=', scope: 'global', v1: 1, varType: 'number' }),
    node('Z', 'varSetNumber', { id: 'guanYing', scope: 'global', elements: [{ type: 'const', value: '0' }] }),
  ] };
  const gate = { nodes: [
    node('G', 'varGet', { id: 'guanYing', operator: '=', scope: 'global', v1: 0, varType: 'number' }),
  ] };

  assert.deepEqual(deriveRoles({ intent, gate }).get('global.guanYing'), { kind: 'toggle', on: 1, off: 0 });
});

test('同一条规则之外的参数不会被安上脉冲', () => {
  const other = { nodes: [
    node('B9', 'deviceOutput', { did: '9', dtype: 'number', id: 'duLiCanShu', scope: 'global', min: 0, max: 10, siid: 2, piid: 2 }),
  ] };

  assert.equal(deriveRoles({ ...graphs, r4: other }).get('global.duLiCanShu').applyWith, undefined);
});

test('规则域变量一概不管 —— 那是规则肚子里的状态', () => {
  const inner = { nodes: [
    node('X', 'varGet', { id: 'jiShu', operator: '=', scope: 'R20260822001', v1: 1, varType: 'number' }),
  ] };

  assert.equal(deriveRoles({ inner }).get('R20260822001.jiShu'), undefined);
});

test('比较里出现的值不止 0/1 时不当开关 —— 翻成什么都是猜', () => {
  const three = { nodes: [
    node('A', 'varGet', { id: 'changJing', operator: '=', scope: 'global', v1: 2, varType: 'number' }),
  ] };

  assert.equal(deriveRoles({ three }).get('global.changJing').kind, 'readonly');
});

test('拿不到图时返回空表，不是抛错', () => {
  assert.equal(deriveRoles(null).size, 0);
  assert.equal(deriveRoles({}).size, 0);
});

test('参数先抄进规则域变量再写设备时，上下界要跟着走一跳', () => {
  // 1301 的夜灯亮度就是这么走的：global.yeDengLiangDu → R…001.bri → 灯。
  // 只看直接写设备的那一步，会以为这个变量没人用，于是它掉进只读。
  const rule = { nodes: [
    node('S', 'varSetNumber', { id: 'bri', scope: 'R1', elements: [{ type: 'var', id: 'yeDengLiangDu', scope: 'global' }] }),
    node('B', 'deviceOutput', { did: 'g1', dtype: 'number', id: 'bri', scope: 'R1', min: 1, max: 100, step: 1, siid: 2, piid: 2 }),
  ] };

  const r = deriveRoles({ rule }).get('global.yeDengLiangDu');

  assert.equal(r.kind, 'number');
  assert.equal(r.min, 1);
  assert.equal(r.max, 100);
  assert.equal(r.unit, '%');
});
