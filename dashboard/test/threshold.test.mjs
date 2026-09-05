import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThresholdPatch, unexpectedChanges } from '../lib/threshold.mjs';

// 形状照抄 1302 的真实 A3b 节点。
const node = {
  id: 'A3b',
  type: 'deviceGet',
  cfg: { name: 'deviceGet', pos: { x: 3400, y: 40, width: 532, height: 120 }, version: 1 },
  inputs: { input: null },
  outputs: { output: ['A3or.input2'], output2: [] },
  props: { did: 'blt.3.1q3qtsib84c01', dtype: 'float', operator: '<', piid: 1005, siid: 2, v1: 1000 },
};

test('补丁带上完整的 props，只把 v1 换掉', () => {
  // xgg 的 updateNode 是 { ...existingNode, ...patch } —— props 不深合并。
  // 只传 {props:{v1:800}} 会把 did/siid/piid/operator 全抹掉。
  const patch = buildThresholdPatch(node, 800);

  assert.deepEqual(patch.props, {
    did: 'blt.3.1q3qtsib84c01', dtype: 'float', operator: '<', piid: 1005, siid: 2, v1: 800,
  });
});

test('补丁带上原样的 cfg.pos，挡住坐标重算', () => {
  // 不带 cfg.pos 的话 updateNode 会跑一遍 geometry 重算，把节点坐标改掉 ——
  // 坐标是期望状态的一部分，改了下次 pull 就是一个假 diff。
  const patch = buildThresholdPatch(node, 800);

  assert.deepEqual(patch.cfg.pos, { x: 3400, y: 40, width: 532, height: 120 });
});

test('补丁不含 id / type —— xgg 会拒绝改这两样', () => {
  const patch = buildThresholdPatch(node, 800);

  assert.equal('id' in patch, false);
  assert.equal('type' in patch, false);
});

test('补丁不碰边 —— outputs 不该出现在里面', () => {
  const patch = buildThresholdPatch(node, 800);

  assert.equal('outputs' in patch, false);
  assert.equal('inputs' in patch, false);
});

// ---- 回读验证：写完之后逐字段比对 ----
// 深拷贝 —— before / after 共用同一个 cfg 对象的话，改 after 会把 before 也改了。
const graph = (v1) => structuredClone({
  id: '20260822160',
  cfg: { enable: true, userData: { name: '进门_有人_开灯' } },
  nodes: [
    { id: 'G', type: 'varGet', props: { scope: 'global', id: 'ziDongHua', operator: '=', v1: 1 }, outputs: { output: ['A3b.input'] } },
    { ...node, props: { ...node.props, v1 } },
  ],
});

test('只有目标字段变了就是干净的', () => {
  const bad = unexpectedChanges(graph(1000), graph(800), 'A3b', 800);

  assert.deepEqual(bad, []);
});

test('别的节点被动了要报出来', () => {
  const after = graph(800);
  after.nodes[0].props.v1 = 0;   // 总闸被改成了 ==0

  assert.deepEqual(unexpectedChanges(graph(1000), after, 'A3b', 800), ['节点 G 的 props 变了']);
});

test('目标节点上除了 v1 之外的字段被动了也要报', () => {
  const after = graph(800);
  after.nodes[1].cfg.pos = { x: 0, y: 0, width: 1, height: 1 };

  assert.deepEqual(unexpectedChanges(graph(1000), after, 'A3b', 800), ['节点 A3b 的 cfg 变了']);
});

test('阈值没写进去也要报 —— 别把没生效当成功', () => {
  const bad = unexpectedChanges(graph(1000), graph(1000), 'A3b', 800);

  assert.deepEqual(bad, ['节点 A3b 的阈值还是 1000，没变成 800']);
});

test('节点被删了要报', () => {
  const after = graph(800);
  after.nodes = [after.nodes[0]];

  assert.deepEqual(unexpectedChanges(graph(1000), after, 'A3b', 800), ['节点 A3b 不见了']);
});

test('规则自己的时间戳变了不算 —— 那是网关每次写入都会动的', () => {
  const before = graph(1000);
  const after = graph(800);
  after.cfg.updateTime = 1757000000;

  assert.deepEqual(unexpectedChanges(before, after, 'A3b', 800), []);
});
