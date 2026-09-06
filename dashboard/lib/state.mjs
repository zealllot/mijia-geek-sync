import { evaluateVerdict } from './verdict.mjs';
import { evaluateRoom } from './room.mjs';

// 把「语义地图 + 网关快照」合成前端直接能画的视图模型。
//
// 合成放在服务端，前端只管渲染 —— blockers 求值和白名单判定各自只有一份实现，
// 而且都在能跑 node:test 的地方。
export function buildView(config, snapshot) {
  if (!config) return flatView(snapshot);
  return mappedView(config, snapshot);
}

// 有配置时：按配置的分组和顺序出卡片，值从快照里取。
function mappedView(config, snapshot) {
  const groups = config.groups.map((g) => {
    const verdict = g.verdict ? evaluateVerdict(g.verdict, snapshot) : null;
    return {
      title: g.title,
      verdict,
      // 只有「就是它挡住的」那一张值得高亮。
      // 「开着」不值得 —— 开着是常态，一屏里五块都亮就等于没有高亮。
      cards: g.cards.map((c) => {
        const card = hydrate(c, snapshot);
        return verdict?.cause && refOf(card) === verdict.cause ? { ...card, culprit: true } : card;
      }),
    };
  });

  // 白名单记的是「允许写**什么**」，不只是「**谁**能写」。
  //
  // 只校验身份的话，POST {id:'ziDongHua', value:999} 会被原样写进网关 ——
  // 它确实在白名单里。开关只收它声明过的那两个值，数值只收界内的数。
  const writable = {};
  for (const c of config.groups.flatMap((g) => g.cards)) {
    // applyWith：写完这个变量，服务端紧跟着发一次脉冲。
    //
    // 极客版的 varChange 对同一个变量只监听得到一次，所以规则那边用了
    // 「写 1 → 执行链第一步写回 0」的翻转法。代价是「改参数」和「让它生效」
    // 变成两步 —— 那第二步不该让人自己记着去戳。
    //
    // 脉冲的目标**不进白名单**：它由服务端发，页面不能直接写，
    // 不然这就成了一个谁都能戳的裸开关。
    const apply = c.applyWith ? { applyWith: c.applyWith } : {};
    if (c.kind === 'toggle') writable[`${c.scope}.${c.id}`] = { kind: 'toggle', on: c.on, off: c.off, ...apply };
    if (c.kind === 'number') writable[`${c.scope}.${c.id}`] = { kind: 'number', min: c.min, max: c.max, ...apply };
  }

  const floorplan = floorplanOf(config, snapshot);

  return {
    groups,
    floorplan,
    headline: floorplan ? headlineOf(floorplan.rooms) : null,
    unmapped: unmappedOf(config, snapshot),
    writable,
    fetchedAt: snapshot.fetchedAt,
  };
}

// 逐间求值。位置原样带出去 —— 前端只负责画，不算布局。
function floorplanOf(config, snapshot) {
  const fp = config.floorplan;
  if (!fp) return null;
  return {
    columns: fp.columns,
    rows: fp.rows,
    rooms: fp.rooms.map((r) => ({ ...r, ...evaluateRoom(r, snapshot) })),
  };
}

// 顶部那句话。受阻的排在前面 —— 「够亮了」不是毛病，不该抢标题。
function headlineOf(rooms) {
  const blocked = rooms.filter((r) => r.state === 'blocked');
  if (!blocked.length) return { title: null, state: 'clear', say: '一切正常', alsoBlocked: [] };
  return {
    title: blocked[0].title,
    state: 'blocked',
    say: blocked[0].say,
    alsoBlocked: blocked.slice(1).map((r) => r.title),
  };
}

// 兜底：所有没被任何卡片引用到的变量和规则。
//
// 哪天加了新规则忘了改地图，信息不会凭空消失 —— 只是没归类。
// 没有这一层的话，看板会安静地漏掉住户最需要看的那一条。
function unmappedOf(config, snapshot) {
  const cards = config.groups.flatMap((g) => g.cards);
  const seenVars = new Set(
    cards.filter((c) => c.kind !== 'rule').map((c) => `${c.scope}.${c.id}`),
  );
  const seenRules = new Set(cards.filter((c) => c.kind === 'rule').map((c) => c.ruleId));

  const variables = [];
  for (const [scope, vars] of Object.entries(snapshot.variables)) {
    for (const [id, v] of Object.entries(vars)) {
      if (seenVars.has(`${scope}.${id}`)) continue;
      variables.push({ scope, id, value: v.value, type: v.type, title: v.name || id });
    }
  }

  const rules = Object.values(snapshot.rules)
    .filter((r) => !seenRules.has(r.id))
    .map((r) => ({ ruleId: r.id, title: r.name || r.id, enable: r.enable }));

  return { variables, rules };
}

// 把一张配置里的卡片和快照里的实时值合成一张可渲染的卡片。
// missing 的意义和 verdict 里的 unresolved 一样：配置引用了网关上已经没有的东西时，
// 页面要把这张卡显示成「坏了」，而不是显示一个空值让人以为读到了。
function hydrate(card, snapshot) {
  if (card.kind === 'rule') {
    const r = snapshot.rules[card.ruleId];
    return r ? { ...card, enable: r.enable } : { ...card, missing: true };
  }
  const v = snapshot.variables[card.scope]?.[card.id];
  return v ? { ...card, value: v.value, type: v.type } : { ...card, missing: true };
}

// 无配置时的降级：按 scope 列出全部变量，再加一组规则。
//
// 全部只读 —— 「哪些变量是可以翻的模式」这个信息只存在于配置里，扁平模式下猜不出来。
// 在别人家里猜错等于把住户正在生效的状态清掉，所以默认不给写。
function flatView(snapshot) {
  const groups = Object.entries(snapshot.variables).map(([scope, vars]) => ({
    title: scope,
    verdict: null,
    cards: Object.entries(vars).map(([id, v]) => ({
      kind: 'readonly',
      title: v.name || id,
      scope,
      id,
      value: v.value,
      type: v.type,
    })),
  }));

  groups.push({
    title: '规则',
    verdict: null,
    cards: Object.values(snapshot.rules).map((r) => ({
      kind: 'rule',
      title: r.name || r.id,
      ruleId: r.id,
      enable: r.enable,
    })),
  });

  return { groups, floorplan: null, headline: null, unmapped: null, writable: {}, fetchedAt: snapshot.fetchedAt };
}

// 写入闸门。
//
// 可写集合只来自配置里显式声明成 toggle 的卡片。这是白名单不是黑名单：
// 即使有人绕过页面直接 POST 任意 scope/id，也只能改事先批准过的那几个。
// 扁平模式下白名单是空的，所以什么都写不了 —— 那正是想要的默认。
export function assertWritable(writable, scope, id, value) {
  const ref = `${scope}.${id}`;
  const rule = writable[ref];
  if (!rule) throw new Error(`${ref} 不在可写白名单里`);

  if (rule.kind === 'toggle') {
    if (value !== rule.on && value !== rule.off) {
      throw new Error(`${ref} 是开关，只能是 ${rule.on} 或 ${rule.off}`);
    }
    return;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${ref} 要填数字`);
  }
  if (rule.min !== undefined && value < rule.min) throw new Error(`${ref} 要在 ${rule.min} 到 ${rule.max} 之间`);
  if (rule.max !== undefined && value > rule.max) throw new Error(`${ref} 要在 ${rule.min} 到 ${rule.max} 之间`);
}

function refOf(card) {
  return card.kind === 'rule' ? `rule.${card.ruleId}` : `${card.scope}.${card.id}`;
}
