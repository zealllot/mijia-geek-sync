// 改规则图里的一个阈值常量 —— 看板唯一会写规则的地方。
//
// 区阈值不是变量，是 deviceGet 节点上的字面量 `v1`（deviceGet 的比较值只收
// 字面量，不能引用变量）。所以要在页面上改它，只能改图。
//
// 这是看板唯一越过「只写变量」那条线的操作，所以两头都上锁：
// 写之前把补丁做到最小，写之后回读整张图逐字段比对。

// xgg 的 updateNode 是 `{ ...existingNode, ...patch }` —— **props 不深合并**
// （只有 cfg 深合并一层）。只传 {props:{v1:N}} 会把 did/siid/piid/operator
// 全抹掉，剩下一个残废的 deviceGet。所以要把原 props 整个带上，只换 v1。
//
// cfg.pos 也必须带：不带的话 updateNode 会跑一遍 card geometry 重算，
// 把节点坐标改掉。坐标是期望状态的一部分（README：「坐标存在文件里，
// 所以不需要 rule layout」），被改了下次 pull 就是一个假 diff。
export function buildThresholdPatch(node, value) {
  return {
    props: { ...node.props, v1: value },
    cfg: { pos: node.cfg?.pos },
  };
}

// 写完之后回读，逐字段比对。返回「不该变却变了」的清单，空数组才算干净。
//
// 「只改了这一个」不能靠嘴保证 —— 这是在别人家里改正在跑的自动化。
export function unexpectedChanges(before, after, nodeId, want) {
  const bad = [];
  const byId = (g) => new Map((g.nodes ?? []).map((n) => [n.id, n]));
  const b = byId(before), a = byId(after);

  for (const [id, node] of b) {
    const now = a.get(id);
    if (!now) { bad.push(`节点 ${id} 不见了`); continue; }

    for (const key of new Set([...Object.keys(node), ...Object.keys(now)])) {
      if (key === 'props' && id === nodeId) continue;   // 目标节点的 props 单独查
      if (same(node[key], now[key])) continue;
      bad.push(`节点 ${id} 的 ${key} 变了`);
    }
  }
  for (const id of a.keys()) if (!b.has(id)) bad.push(`多出来一个节点 ${id}`);

  // 目标节点：v1 必须变成想要的值，其余字段一个都不能动。
  const target = a.get(nodeId), was = b.get(nodeId);
  if (target && was) {
    if (target.props?.v1 !== want) {
      bad.push(`节点 ${nodeId} 的阈值还是 ${was.props?.v1}，没变成 ${want}`);
    }
    for (const key of new Set([...Object.keys(was.props ?? {}), ...Object.keys(target.props ?? {})])) {
      if (key === 'v1') continue;
      if (!same(was.props?.[key], target.props?.[key])) bad.push(`节点 ${nodeId} 的 props.${key} 变了`);
    }
  }
  return bad;
}

// 规则自己的 cfg 不比 —— 网关每次写入都会刷新它的时间戳。
function same(x, y) {
  return JSON.stringify(x) === JSON.stringify(y);
}
