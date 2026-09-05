// 从规则图里抠出房间的闸门链和照度阈值。
//
// 目的是让 `--init-config` 生成的骨架**一个数都不用手写** —— 阈值和闸门
// 本来就写在图里，人再抄一遍只会抄错，而且改了规则不会同步。
//
// 按节点**类型**抠，不按节点 id。id（G / G2 / M / A3 / A3b）是 1302 那批规则
// 自己的命名约定，换一户就不成立；类型是平台定的。
export function extractLuxMap(probeGraph) {
  const map = {};
  for (const n of probeGraph?.nodes ?? []) {
    if (n.type !== 'deviceGetSetVar') continue;
    if (n.props?.scope !== 'global') continue;
    map[n.props.did] = n.props.id;
  }
  return map;
}

export function extractRoom(graph, luxMap, ruleId) {
  const name = graph?.cfg?.userData?.name ?? '';
  const warnings = [];

  const nodes = graph?.nodes ?? [];

  // 照度 = 数值型 deviceGet 的 `<` 比较。布尔型那个是「本区灯已灭」，读的是灯不是传感器。
  const cmps = nodes.filter(
    (n) => n.type === 'deviceGet' && n.props?.operator === '<' && n.props?.dtype !== 'boolean',
  );

  // 闸门 = **能走到照度比较**的全局 varGet 等值节点。
  //
  // 判据必须是拓扑，不能是文档顺序，也不能是节点 id：
  //   - 1302 图里 A4（读 yeJian）排在最前面，但它是输出段的昼夜分支 ——
  //     夜间用夜灯亮度、白天用正常亮度。按顺序抠会把它当闸门，
  //     于是白天 yeJian=0 时页面说「受阻：夜间模式不是 1」，全错。
  //   - varChange 长得也像，但它是「变量一变就触发」的触发器，不是放行条件。
  const reach = reachability(nodes);
  const luxIds = new Set(cmps.map((n) => n.id));
  const chain = [];
  for (const n of nodes) {
    if (n.type !== 'varGet') continue;
    const p = n.props ?? {};
    if (p.scope !== 'global' || p.operator !== '=') continue;
    if (![...(reach.get(n.id) ?? [])].some((id) => luxIds.has(id))) continue;
    chain.push({ scope: 'global', id: p.id, equals: p.v1, title: p.id, say: `${p.id} 不是 ${p.v1}` });
  }

  let lux = null;
  if (cmps.length >= 2) {
    const [a, b] = cmps;
    const localVar = luxMap[a.props.did];
    const globalVar = luxMap[b.props.did];
    if (!localVar) warnings.push(`${a.props.did} 不在照度探针里，抠不出本地照度变量`);
    if (!globalVar) warnings.push(`${b.props.did} 不在照度探针里，抠不出全局照度变量`);
    if (localVar && globalVar) {
      // 节点 id 一并带出来：阈值是图里的常量，要在看板上改就得知道改哪个节点。
      lux = {
        local: localVar, localThreshold: a.props.v1, localThresholdNode: a.id,
        global: globalVar, zoneThreshold: b.props.v1, zoneThresholdNode: b.id,
      };
    }
  }

  return { zone: name.split('_')[0] || name, rule: ruleId, chain, lux, warnings };
}

// 每个节点能到达的节点集合。边存在节点的 outputs 里：{ output: ["G2.input"], ... }
function reachability(nodes) {
  const next = new Map();
  for (const n of nodes) {
    const to = new Set();
    for (const pins of Object.values(n.outputs ?? {})) {
      for (const edge of pins ?? []) to.add(String(edge).split('.')[0]);
    }
    next.set(n.id, to);
  }

  const memo = new Map();
  const walk = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return new Set();   // 图里允许自环，别转死
    seen.add(id);
    const out = new Set();
    for (const d of next.get(id) ?? []) {
      out.add(d);
      for (const dd of walk(d, seen)) out.add(dd);
    }
    memo.set(id, out);
    return out;
  };

  for (const n of nodes) walk(n.id);
  return memo;
}
