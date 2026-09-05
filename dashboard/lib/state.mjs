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

  // 白名单：只有配置里显式声明成 toggle 的变量能写。
  // 不是「任意 scope/id 都能写」—— 即使有人直接 POST 任意参数，
  // 也只能改事先批准过的那几个。
  const writable = config.groups
    .flatMap((g) => g.cards)
    .filter((c) => c.kind === 'toggle')
    .map((c) => `${c.scope}.${c.id}`);

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

  return { groups, floorplan: null, headline: null, unmapped: null, writable: [], fetchedAt: snapshot.fetchedAt };
}

// 写入闸门。
//
// 可写集合只来自配置里显式声明成 toggle 的卡片。这是白名单不是黑名单：
// 即使有人绕过页面直接 POST 任意 scope/id，也只能改事先批准过的那几个。
// 扁平模式下白名单是空的，所以什么都写不了 —— 那正是想要的默认。
export function assertWritable(writable, scope, id) {
  const ref = `${scope}.${id}`;
  if (!writable.includes(ref)) {
    throw new Error(`${ref} 不在可写白名单里`);
  }
}

function refOf(card) {
  return card.kind === 'rule' ? `rule.${card.ruleId}` : `${card.scope}.${card.id}`;
}
