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
