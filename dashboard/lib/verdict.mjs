// 结论求值 —— 看板里唯一「有想法」的部分。
//
// blockers 按顺序求值，第一个命中的就是页面顶部那行大字；都不命中就说 ok。
// 纯数据、纯函数：住户那台机器上没有表达式求值，也没有代码执行。
//
// unresolved 是这里最要紧的一件事：如果配置引用了网关上已经不存在的变量或规则
// （改了名、删了规则），blocker 就永远不会命中，页面会理直气壮地说「一切正常」。
// 那是最坏的一种错 —— 看板存在的意义就是被信任。所以引用解析不到时要报出来，
// 让页面把结论标成不可信，而不是假装没事。
export function evaluateVerdict(verdict, snapshot) {
  const unresolved = [];
  let hit = null;

  for (const b of verdict.blockers ?? []) {
    const target = resolve(b, snapshot);
    if (target === undefined) {
      unresolved.push(refOf(b));
      continue;
    }
    if (hit === null && matches(b, target)) hit = b;
  }

  // cause 让页面知道该高亮哪一块瓦片。
  // 「开着」不值得高亮 —— 开着是常态；「这一项就是原因」才值得。
  return hit
    ? { blocked: true, say: hit.say, cause: refOf(hit), unresolved }
    : { blocked: false, say: verdict.ok, cause: null, unresolved };
}

function resolve(b, snapshot) {
  return b.rule !== undefined
    ? snapshot.rules?.[b.rule]
    : snapshot.variables?.[b.scope]?.[b.id];
}

function matches(b, target) {
  return b.rule !== undefined ? target.enable === b.enabled : target.value === b.equals;
}

function refOf(b) {
  return b.rule !== undefined ? `rule.${b.rule}` : `${b.scope}.${b.id}`;
}
