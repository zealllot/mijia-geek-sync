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

// ---- 渐变背景 ----
test('渐变背景收两个颜色和一个角度', () => {
  const out = sanitizeLayout({ background: { kind: 'gradient', from: '#6b7fa8', to: '#2a3550', angle: 160 } });

  assert.deepEqual(out.background, { kind: 'gradient', from: '#6b7fa8', to: '#2a3550', angle: 160 });
});

test('渐变的颜色也必须是十六进制', () => {
  assert.equal(sanitizeLayout({ background: { kind: 'gradient', from: 'url(x)', to: '#000000' } }).background, undefined);
});

test('角度夹在 0–360，缺了给个默认', () => {
  assert.equal(sanitizeLayout({ background: { kind: 'gradient', from: '#000000', to: '#ffffff', angle: 999 } }).background.angle, 360);
  assert.equal(sanitizeLayout({ background: { kind: 'gradient', from: '#000000', to: '#ffffff' } }).background.angle, 160);
});

// ---- 主题：卡片底色 / 边框 / 圆角 / 透明度 ----
test('主题收颜色、圆角和透明度', () => {
  const out = sanitizeLayout({ theme: { panel: '#1a2430', panelAlpha: 0.6, line: '#33414b', radius: 12, ink: '#e0e6ea' } });

  assert.deepEqual(out.theme, { panel: '#1a2430', panelAlpha: 0.6, line: '#33414b', radius: 12, ink: '#e0e6ea' });
});

test('主题里的颜色不是十六进制就丢掉那一项，不是整个丢', () => {
  // 一个颜色写坏了不该让其他设置全没。
  const out = sanitizeLayout({ theme: { panel: 'red;x:1', line: '#33414b', radius: 8 } });

  assert.equal(out.theme.panel, undefined);
  assert.equal(out.theme.line, '#33414b');
  assert.equal(out.theme.radius, 8);
});

test('圆角和透明度夹在可用范围', () => {
  const out = sanitizeLayout({ theme: { radius: 999, panelAlpha: 5 } });

  assert.equal(out.theme.radius, 32);
  assert.equal(out.theme.panelAlpha, 1);
});

test('主题里全是垃圾时不留空壳', () => {
  assert.equal(sanitizeLayout({ theme: { panel: 'x', line: 'y' } }).theme, undefined);
});

// ---- 丢掉什么要说出来 ----
import { layoutProblems } from '../lib/layout.mjs';

test('选了图片但没图名时，说出来而不是默默丢掉', () => {
  // 用户选了「图片」还没传就点保存 —— 静默丢弃会让他以为存上了。
  const bad = layoutProblems({ background: { kind: 'image', image: '' } });

  assert.deepEqual(bad, ['背景选了图片，但还没传图']);
});

test('颜色写坏了也说出来', () => {
  assert.deepEqual(layoutProblems({ background: { kind: 'color', color: 'blue' } }), ['背景颜色不是十六进制（比如 #3b4a6b）']);
  assert.deepEqual(layoutProblems({ background: { kind: 'gradient', from: '#000000', to: 'x' } }), ['渐变的两个颜色都要是十六进制']);
});

test('位置写坏了报出是哪一个', () => {
  assert.deepEqual(
    layoutProblems({ rooms: { 客厅: { x: 'a', y: 0, w: 1, h: 1 }, 主卧: { x: 0, y: 0, w: 10, h: 10 } } }),
    ['「客厅」的位置不是数字'],
  );
});

test('干净的东西不报', () => {
  assert.deepEqual(layoutProblems({
    background: { kind: 'gradient', from: '#8e9dc4', to: '#3b4a6b', angle: 160 },
    rooms: { 客厅: { x: 0, y: 0, w: 100, h: 50 } },
    theme: { panel: '#20293c', radius: 14 },
  }), []);
});

test('压根没提到的东西不报', () => {
  assert.deepEqual(layoutProblems({ rooms: { 客厅: { x: 0, y: 0, w: 100, h: 50 } } }), []);
});

// ---- 位置按规则 id 存，不按房间名 ----
const named = {
  floorplan: { rooms: [{ title: '客厅', rule: '20260822005' }] },
  groups: [],
};

test('位置优先按规则 id 认 —— 改房间名不该把摆好的位置弄丢', () => {
  // 早先按房间名存，「沙发」改成「客厅」之后那一格就成孤儿了。
  const out = applyLayout(named, { rooms: { '20260822005': { x: 40, y: 50, w: 200, h: 100 } } });

  assert.equal(out.floorplan.rooms[0].x, 40);
});

test('旧的按名字存的还认 —— 已经拖好的布局不能一升级就没', () => {
  const out = applyLayout(named, { rooms: { 客厅: { x: 7, y: 8, w: 90, h: 40 } } });

  assert.equal(out.floorplan.rooms[0].x, 7);
});

test('两种都在时以规则 id 为准', () => {
  const out = applyLayout(named, { rooms: {
    '20260822005': { x: 40, y: 50, w: 200, h: 100 },
    客厅: { x: 7, y: 8, w: 90, h: 40 },
  } });

  assert.equal(out.floorplan.rooms[0].x, 40);
});

test('没有规则的房间还是按名字认', () => {
  const noRule = { floorplan: { rooms: [{ title: '主卫' }] }, groups: [] };
  const out = applyLayout(noRule, { rooms: { 主卫: { x: 3, y: 4, w: 80, h: 30 } } });

  assert.equal(out.floorplan.rooms[0].x, 3);
});
