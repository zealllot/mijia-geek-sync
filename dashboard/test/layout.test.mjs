import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLayout, sanitizeLayout, DEFAULT_ROOM } from '../lib/layout.mjs';

const config = {
  floorplan: { rooms: [
    { title: '客厅', rule: 'r1' },
    { title: '主卧', rule: 'r2', x: 10, y: 20, w: 200, h: 100 },
  ] },
  groups: [{ title: '全屋模式', cards: [
    { kind: 'toggle', title: '总开关', scope: 'global', id: 'ziDongHua', on: 1, off: 0 },
    { kind: 'rule', title: '光亮灯灭', ruleId: '20260822110' },
  ] }],
};

test('没有 layout 时房间用配置里的位置，缺了就给个默认位', () => {
  const out = applyLayout(config, null);

  assert.deepEqual(out.floorplan.rooms[1].x, 10);
  assert.equal(typeof out.floorplan.rooms[0].x, 'number');   // 缺位置也得有个能画的值
  assert.equal(out.floorplan.rooms[0].w, DEFAULT_ROOM.w);
});

test('layout 里的位置覆盖配置里的', () => {
  const out = applyLayout(config, { rooms: { 主卧: { x: 500, y: 600, w: 300, h: 150 } } });

  assert.deepEqual(
    { x: out.floorplan.rooms[1].x, y: out.floorplan.rooms[1].y, w: out.floorplan.rooms[1].w, h: out.floorplan.rooms[1].h },
    { x: 500, y: 600, w: 300, h: 150 },
  );
});

test('layout 只覆盖位置，不能改语义', () => {
  // layout.json 是这台机器的外观，不该能改房间归哪条规则、闸门链是什么。
  const out = applyLayout(config, { rooms: { 主卧: { x: 5, y: 5, w: 100, h: 50, rule: '被篡改', chain: [] } } });

  assert.equal(out.floorplan.rooms[1].rule, 'r2');
  assert.equal(out.floorplan.rooms[1].chain, undefined);
});

test('卡片按 scope.id 认位置，规则卡按 rule.<id>', () => {
  const out = applyLayout(config, { tiles: {
    'global.ziDongHua': { x: 0, y: 0, w: 240, h: 60 },
    'rule.20260822110': { x: 250, y: 0, w: 240, h: 60 },
  } });

  assert.equal(out.groups[0].cards[0].w, 240);
  assert.equal(out.groups[0].cards[1].x, 250);
});

test('layout 里提到不存在的房间时忽略，不凭空造一个', () => {
  const out = applyLayout(config, { rooms: { 不存在的房间: { x: 0, y: 0, w: 10, h: 10 } } });

  assert.deepEqual(out.floorplan.rooms.map((r) => r.title), ['客厅', '主卧']);
});

// ---- 清洗：layout.json 是页面写的，得当成不可信输入 ----
test('负数和超大值被夹到合理范围', () => {
  const out = sanitizeLayout({ rooms: { 客厅: { x: -50, y: 3, w: 999999, h: 0 } } });

  assert.equal(out.rooms['客厅'].x, 0);
  assert.equal(out.rooms['客厅'].w <= 4000, true);
  assert.equal(out.rooms['客厅'].h >= 24, true);
});

test('非数值的位置整条丢掉', () => {
  // 半个位置画不出来。整条丢掉之后 rooms 就空了，那一层键也不留。
  const out = sanitizeLayout({ rooms: { 客厅: { x: 'abc', y: 0, w: 100, h: 50 } } });

  assert.equal(out.rooms, undefined);
});

test('背景只收认识的几种', () => {
  assert.equal(sanitizeLayout({ background: { kind: 'image', image: 'bg.jpg', blur: 4, dim: 0.5 } }).background.kind, 'image');
  assert.equal(sanitizeLayout({ background: { kind: 'color', color: '#123456' } }).background.color, '#123456');
  assert.equal(sanitizeLayout({ background: { kind: '不认识的' } }).background, undefined);
});

test('颜色必须是十六进制，挡住往 CSS 里塞东西', () => {
  // 这个值会进 style 属性 —— 不挡的话等于让页面往 CSS 里写任意串。
  assert.equal(sanitizeLayout({ background: { kind: 'color', color: 'red;background:url(x)' } }).background, undefined);
});

test('模糊和变暗夹在可用范围内', () => {
  const out = sanitizeLayout({ background: { kind: 'image', image: 'a.png', blur: 999, dim: -3 } });

  assert.equal(out.background.blur, 40);
  assert.equal(out.background.dim, 0);
});

test('图片文件名必须干净，挡住路径穿越', () => {
  assert.equal(sanitizeLayout({ background: { kind: 'image', image: '../../etc/passwd' } }).background, undefined);
});
