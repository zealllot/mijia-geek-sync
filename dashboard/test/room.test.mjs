import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRoom } from '../lib/room.mjs';

// 复刻 1302 进门/客厅 的真实闸门链（yang-home/docs/reference/dual-lux-and-manual-lock.md）：
//   总闸 ziDongHua==1 → 模式闸 guanYing==0 → 手动锁 shouDongJinMen==0
//   → 本地照度<100 或 全局照度<1000
const livingRoom = {
  title: '客厅',
  rule: '20260822160',
  chain: [
    { scope: 'global', id: 'ziDongHua', equals: 1, title: '灯光自动化总开关', say: '全屋自动化总开关是关的' },
    { scope: 'global', id: 'guanYing', equals: 0, title: '观影模式', say: '观影模式开着，会压制客厅自动亮灯' },
    { scope: 'global', id: 'shouDongJinMen', equals: 0, title: '进门手动锁', say: '进门手动锁开着' },
  ],
  lux: { local: 'luxJinMen', localThreshold: 100, global: 'luxQuanJu', zoneThreshold: 1000 },
};

const vars = (over = {}) => ({
  variables: {
    global: {
      ziDongHua: { type: 'number', value: 1 },
      guanYing: { type: 'number', value: 0 },
      shouDongJinMen: { type: 'number', value: 0 },
      luxJinMen: { type: 'number', value: 45 },
      luxQuanJu: { type: 'number', value: 620 },
      ...over,
    },
  },
  rules: {},
});

test('闸门全通且照度够暗时是「没发现阻碍」', () => {
  // 本地 45 < 100 成立 → 会开灯
  const r = evaluateRoom(livingRoom, vars());

  assert.equal(r.state, 'clear');
  assert.equal(r.say, '没发现阻碍');
});

test('某道闸门不通时是「受阻」，并给出那道的说法', () => {
  const r = evaluateRoom(livingRoom, vars({ guanYing: { type: 'number', value: 1 } }));

  assert.equal(r.state, 'blocked');
  assert.equal(r.say, '观影模式开着，会压制客厅自动亮灯');
});

test('断点之后的闸门标成「没走到这一步」，不是「通过」', () => {
  // 规则实际执行时就是在断点处停的 —— 页面不能显示后面的也检查过了。
  const r = evaluateRoom(livingRoom, vars({ guanYing: { type: 'number', value: 1 } }));

  assert.deepEqual(r.chain.map((c) => c.status), ['pass', 'break', 'skip', 'skip', 'skip']);
});

test('闸门全通但两道照度都没过时是「够亮了」，不是「受阻」', () => {
  // 本地 210 >= 100 且 全局 620 >= 1000？ 不成立 —— 换个够亮的全局值
  const r = evaluateRoom(livingRoom, vars({
    luxJinMen: { type: 'number', value: 210 },
    luxQuanJu: { type: 'number', value: 1200 },
  }));

  assert.equal(r.state, 'bright');
  assert.match(r.say, /够亮/);
});

test('照度是「或」：本地不过但全局过，仍然会开灯', () => {
  const r = evaluateRoom(livingRoom, vars({
    luxJinMen: { type: 'number', value: 210 },   // 210 >= 100，本地分支不成立
    luxQuanJu: { type: 'number', value: 620 },   // 620 < 1000，全局分支成立
  }));

  assert.equal(r.state, 'clear');
});

test('没有闸门链的房间是「未配置」', () => {
  const r = evaluateRoom({ title: '主卫' }, vars());

  assert.equal(r.state, 'unconfigured');
});

test('闸门引用了网关上没有的变量时报出来，且不算通过', () => {
  const r = evaluateRoom(livingRoom, { variables: { global: {} }, rules: {} });

  assert.deepEqual(r.unresolved, ['global.ziDongHua']);
  assert.notEqual(r.state, 'clear');
});

test('照度变量读不到时仍说「没发现阻碍」，但标明照度未知', () => {
  // 「没发现阻碍」说的是我检查过的范围，不是保证灯会亮 —— 所以照度缺失不影响这句话。
  const v = vars();
  delete v.variables.global.luxJinMen;
  delete v.variables.global.luxQuanJu;

  const r = evaluateRoom(livingRoom, v);

  assert.equal(r.state, 'clear');
  assert.equal(r.luxKnown, false);
});

test('本地照度成立时，全局那道在规则里根本不会跑，标成没走到', () => {
  // 图里 A3 成立就直接进 signalOr，A3b 只挂在 A3 的 output2 上。
  const r = evaluateRoom(livingRoom, vars({ luxJinMen: { type: 'number', value: 45 } }));

  const lux = r.chain.slice(-2);
  assert.deepEqual(lux.map((c) => c.status), ['pass', 'skip']);
});

test('两道照度都不成立时都标「不成立」，不是「断在这里」', () => {
  // 「断」意味着到此为止；两条腿是「或」，都不成立才是一起没过，说法要区分开。
  const r = evaluateRoom(livingRoom, vars({
    luxJinMen: { type: 'number', value: 210 },
    luxQuanJu: { type: 'number', value: 1200 },
  }));

  const lux = r.chain.slice(-2);
  assert.deepEqual(lux.map((c) => c.status), ['fail', 'fail']);
});

test('照度步骤带 lux 标记，好让页面换一套说法', () => {
  const r = evaluateRoom(livingRoom, vars());

  assert.deepEqual(r.chain.slice(-2).map((c) => c.kind), ['lux', 'lux']);
  assert.equal(r.chain[0].kind, 'gate');
});

const editable = {
  ...livingRoom,
  rule: '20260822160',
  lux: { ...livingRoom.lux, zoneThresholdNode: 'A3b', zoneThresholdRange: [1, 3000] },
};

test('声明了可改范围时，全局照度那一道带上改它要用的东西', () => {
  const r = evaluateRoom(editable, vars());

  assert.deepEqual(r.chain.at(-1).edit, {
    rule: '20260822160', node: 'A3b', value: 1000, min: 1, max: 3000,
  });
});

test('没声明可改范围就不可改 —— 每个房间要显式开启，不是默认能改', () => {
  const r = evaluateRoom(livingRoom, vars());

  assert.equal(r.chain.at(-1).edit, undefined);
});

test('本地照度那一道永远不可改 —— 那是全屋共用的一个数', () => {
  // 本地阈值 100 是全屋共用的舒适下限，不是按区标定的，不该让住户逐个房间去调。
  const r = evaluateRoom(editable, vars());

  assert.equal(r.chain.at(-2).edit, undefined);
});

// ---- 单阈值住户（1301 那种：没有全局照度传感器）----
const single = {
  title: '餐厅', rule: 'r1',
  chain: [{ scope: 'global', id: 'ziDongHua', equals: 1, title: '灯光自动化总开关', say: '总开关关着' }],
  lux: { local: 'luxCanTing', localThreshold: 300 },
};
const singleVars = (lux) => ({
  variables: { global: { ziDongHua: { type: 'number', value: 1 }, luxCanTing: { type: 'number', value: lux } } },
  rules: {},
});

test('单阈值：照度够暗就会开灯', () => {
  const r = evaluateRoom(single, singleVars(120));

  assert.equal(r.state, 'clear');
  assert.deepEqual(r.chain.map((c) => c.status), ['pass', 'pass']);
});

test('单阈值：照度不够暗就是「够亮了」', () => {
  const r = evaluateRoom(single, singleVars(400));

  assert.equal(r.state, 'bright');
  assert.match(r.say, /够亮/);
});

test('单阈值时只出一道照度步骤，不凭空补一道全局的', () => {
  const r = evaluateRoom(single, singleVars(120));

  assert.equal(r.chain.filter((c) => c.kind === 'lux').length, 1);
  assert.equal(r.chain.at(-1).title, '本地照度 < 300');
});

test('单阈值时照度读不到也不硬说', () => {
  const v = singleVars(120);
  delete v.variables.global.luxCanTing;

  const r = evaluateRoom(single, v);

  assert.equal(r.luxKnown, false);
  assert.equal(r.state, 'clear');
});
