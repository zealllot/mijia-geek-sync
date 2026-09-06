import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeGroups, rebuildGroups } from '../lib/groups.mjs';

const snapshot = {
  variables: {
    global: {
      ziDongHua: { type: 'number', value: 1, name: '灯光自动化总开关' },
      huiKe: { type: 'number', value: 0, name: '会客模式' },
      quanJuLiangDu: { type: 'number', value: 100, name: '全局亮度' },
      quanJuSeWen: { type: 'number', value: 4000, name: '全局色温' },
      tongBu: { type: 'number', value: 0, name: '同步灯光参数' },
      luxQuanJu: { type: 'number', value: 830, name: '照度快照_luxQuanJu' },
      biaoTi: { type: 'string', value: 'x', name: '某个字符串' },
    },
  },
  rules: { 20260822001: { id: '20260822001', name: '餐厅开灯', enable: true } },
};

// ---------- 清洗 ----------
// 分组是**页面写回来的**，跟 layout.json 一样当不可信输入。

test('标题去空白，空标题整组丢掉', () => {
  const out = sanitizeGroups([
    { title: '  全屋模式 ', refs: ['global.huiKe'] },
    { title: '   ', refs: ['global.ziDongHua'] },
  ]);

  assert.deepEqual(out, [{ title: '全屋模式', refs: ['global.huiKe'] }]);
});

test('同一个 ref 只留第一次出现的那组', () => {
  // 一张卡同时属于两个分组的话，写白名单时会重复，而且人也说不清它在哪。
  const out = sanitizeGroups([
    { title: 'A', refs: ['global.huiKe', 'global.ziDongHua'] },
    { title: 'B', refs: ['global.huiKe'] },
  ]);

  assert.deepEqual(out[0].refs, ['global.huiKe', 'global.ziDongHua']);
  assert.deepEqual(out[1].refs, []);
});

test('形状不对的 ref 丢掉', () => {
  const out = sanitizeGroups([{ title: 'A', refs: ['global.huiKe', '../../etc/passwd', 42, ''] }]);

  assert.deepEqual(out[0].refs, ['global.huiKe']);
});

test('空分组留着 —— 新建一个还没往里放东西是正常的', () => {
  assert.deepEqual(sanitizeGroups([{ title: '新分类', refs: [] }]), [{ title: '新分类', refs: [] }]);
});

// ---------- 重建 ----------

test('已有卡片的定义原样保留，页面改不了它的语义', () => {
  // 页面只送 ref，不送卡片定义 —— 不然它就能把 min/max 送成任意值，
  // 而 min/max 正是写入白名单的边界。
  const config = { groups: [{ title: '全屋模式', cards: [
    { kind: 'number', title: '全局亮度', scope: 'global', id: 'quanJuLiangDu', min: 1, max: 100, unit: '%',
      applyWith: { scope: 'global', id: 'tongBu', value: 1 } },
  ] }] };

  const { groups } = rebuildGroups([{ title: '灯光', refs: ['global.quanJuLiangDu'] }], config, snapshot);

  assert.deepEqual(groups[0].cards[0], config.groups[0].cards[0]);
  assert.equal(groups[0].title, '灯光');
});

test('新进来的 0/1 数值变量生成成开关', () => {
  const { groups } = rebuildGroups([{ title: 'A', refs: ['global.huiKe'] }], { groups: [] }, snapshot);

  assert.deepEqual(groups[0].cards[0], { kind: 'toggle', title: '会客模式', scope: 'global', id: 'huiKe', on: 1, off: 0 });
});

test('不是 0/1 的数值只生成只读卡 —— 没有上下界就不该能写', () => {
  const { groups } = rebuildGroups([{ title: 'A', refs: ['global.luxQuanJu'] }], { groups: [] }, snapshot);

  assert.equal(groups[0].cards[0].kind, 'readonly');
});

test('字符串变量只读', () => {
  const { groups } = rebuildGroups([{ title: 'A', refs: ['global.biaoTi'] }], { groups: [] }, snapshot);

  assert.equal(groups[0].cards[0].kind, 'readonly');
});

test('规则 ref 生成规则卡', () => {
  const { groups } = rebuildGroups([{ title: 'A', refs: ['rule.20260822001'] }], { groups: [] }, snapshot);

  assert.deepEqual(groups[0].cards[0], { kind: 'rule', title: '餐厅开灯', ruleId: '20260822001' });
});

test('网关上没有的 ref 丢掉，不生成坏卡片', () => {
  const { groups } = rebuildGroups([{ title: 'A', refs: ['global.buCunZai', 'rule.999'] }], { groups: [] }, snapshot);

  assert.deepEqual(groups[0].cards, []);
});

test('分组的 verdict 按标题跟着走', () => {
  const config = { groups: [{ title: '全屋模式', verdict: { blockers: [] }, cards: [] }] };

  const { groups } = rebuildGroups([{ title: '全屋模式', refs: [] }], config, snapshot);

  assert.deepEqual(groups[0].verdict, { blockers: [] });
});

// ---------- 挪出去再挪回来 ----------

test('挪出分组的卡片定义进 retired，挪回来时原样恢复', () => {
  // 手写的 min/max/unit/applyWith 是猜不回来的。挪出去就丢，
  // 等于「拖错一下，一个能用的滑块永久变成只读」。
  const config = { groups: [{ title: '全屋模式', cards: [
    { kind: 'number', title: '全局亮度', scope: 'global', id: 'quanJuLiangDu', min: 1, max: 100, unit: '%' },
  ] }] };

  const step1 = rebuildGroups([{ title: '全屋模式', refs: [] }], config, snapshot);
  assert.deepEqual(step1.groups[0].cards, []);
  assert.equal(step1.retired.length, 1);

  const step2 = rebuildGroups(
    [{ title: '全屋模式', refs: ['global.quanJuLiangDu'] }],
    { groups: step1.groups, retired: step1.retired },
    snapshot,
  );

  assert.deepEqual(step2.groups[0].cards[0], config.groups[0].cards[0]);
  assert.equal(step2.retired.length, 0);
});

test('retired 不会无限长', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    kind: 'readonly', title: `t${i}`, scope: 'global', id: `v${i}`,
  }));

  const { retired } = rebuildGroups([], { groups: [], retired: many }, snapshot);

  assert.ok(retired.length <= 100, `retired 有 ${retired.length} 条`);
});

// ---------- 图里推出来的角色 ----------
import { applyRoles, autoGroups } from '../lib/groups.mjs';

const roles = new Map([
  ['global.quanJuSeWen', { kind: 'number', min: 3000, max: 6400, unit: 'K', applyWith: { scope: 'global', id: 'tongBu', value: 1 } }],
  ['global.ziDongHua', { kind: 'toggle', on: 1, off: 0 }],
  ['global.tongBu', { kind: 'pulse' }],
  ['global.luxQuanJu', { kind: 'readonly' }],
]);

test('图里的范围比手写的窄时，按图里的收紧', () => {
  // 手写的是 2700-6500，而图里所有灯的交集是 3000-6400 ——
  // 按手写的那份，住户能把某盏灯写进一个它不认的值。
  const cfg = { groups: [{ title: 'A', cards: [
    { kind: 'number', title: '全局色温', scope: 'global', id: 'quanJuSeWen', min: 2700, max: 6500, unit: 'K' },
  ] }] };

  const c = applyRoles(cfg, roles).groups[0].cards[0];

  assert.equal(c.min, 3000);
  assert.equal(c.max, 6400);
  assert.equal(c.title, '全局色温');   // 标题还是人写的
});

test('手写的范围更窄时不放宽 —— 人可能是故意收着的', () => {
  const cfg = { groups: [{ title: 'A', cards: [
    { kind: 'number', title: '全局色温', scope: 'global', id: 'quanJuSeWen', min: 4000, max: 5000, unit: 'K' },
  ] }] };

  const c = applyRoles(cfg, roles).groups[0].cards[0];

  assert.equal(c.min, 4000);
  assert.equal(c.max, 5000);
});

test('配置没写 applyWith 时用图里推出来的', () => {
  const cfg = { groups: [{ title: 'A', cards: [
    { kind: 'number', title: '全局色温', scope: 'global', id: 'quanJuSeWen', min: 3000, max: 6400 },
  ] }] };

  assert.deepEqual(applyRoles(cfg, roles).groups[0].cards[0].applyWith, { scope: 'global', id: 'tongBu', value: 1 });
});

test('翻转变量的卡片一律撤掉 —— 它归服务端发', () => {
  const cfg = { groups: [{ title: 'A', cards: [
    { kind: 'toggle', title: '同步', scope: 'global', id: 'tongBu', on: 1, off: 0 },
    { kind: 'toggle', title: '总开关', scope: 'global', id: 'ziDongHua', on: 1, off: 0 },
  ] }] };

  assert.deepEqual(applyRoles(cfg, roles).groups[0].cards.map((c) => c.id), ['ziDongHua']);
});

test('挪进来的新卡片按图里的角色生成，不用人补 min/max', () => {
  const { groups } = rebuildGroups([{ title: 'A', refs: ['global.quanJuSeWen'] }], { groups: [] }, snapshot, roles);

  assert.deepEqual(groups[0].cards[0], {
    kind: 'number', title: '全局色温', scope: 'global', id: 'quanJuSeWen',
    min: 3000, max: 6400, unit: 'K', applyWith: { scope: 'global', id: 'tongBu', value: 1 },
  });
});

test('翻转变量挪不进任何分组', () => {
  const { groups } = rebuildGroups([{ title: 'A', refs: ['global.tongBu'] }], { groups: [] }, snapshot, roles);

  assert.deepEqual(groups[0].cards, []);
});

// ---------- 一户新装上来 ----------

test('没有分组时按角色自动分：模式一组，参数一组', () => {
  // 新一户装上去就该是分好的，不该让人先在页面上挪三十个方块。
  const out = autoGroups(roles, snapshot);

  assert.deepEqual(out.map((g) => g.title), ['全屋模式', '参数']);
  assert.deepEqual(out[0].cards.map((c) => c.id), ['ziDongHua']);
  assert.deepEqual(out[1].cards.map((c) => c.id), ['quanJuSeWen']);
});

test('自动分组里没有只读和翻转变量', () => {
  const flat = autoGroups(roles, snapshot).flatMap((g) => g.cards.map((c) => c.id));

  assert.ok(!flat.includes('tongBu'));
  assert.ok(!flat.includes('luxQuanJu'));
});
