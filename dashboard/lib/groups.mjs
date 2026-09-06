// 分组：住户在页面上自己建分类、把「未归类」里的东西挪进去。
//
// **页面只送 ref，不送卡片定义。** 卡片定义决定写入白名单的边界
// （开关认哪两个值、数值的 min/max），让页面送定义等于让它自己定边界。
// 所以这里只收「哪几个 ref 归哪一组」，定义要么沿用配置里已有的，
// 要么按快照里的类型生成一张保守的卡。

const MAX_GROUPS = 16;
const MAX_REFS = 80;
const MAX_RETIRED = 100;
const TITLE_MAX = 24;

// ref 会被当成键去查快照，也会写进配置文件 —— 形状挡死。
const REF = /^[A-Za-z0-9_.:-]{1,80}$/;

export function sanitizeGroups(raw) {
  if (!Array.isArray(raw)) return [];

  const seen = new Set();   // 一张卡只能属于一组
  const out = [];

  for (const g of raw.slice(0, MAX_GROUPS)) {
    const title = String(g?.title ?? '').trim().slice(0, TITLE_MAX);
    if (!title) continue;

    const refs = [];
    for (const r of Array.isArray(g?.refs) ? g.refs.slice(0, MAX_REFS) : []) {
      if (typeof r !== 'string' || !REF.test(r) || seen.has(r)) continue;
      seen.add(r);
      refs.push(r);
    }
    out.push({ title, refs });
  }
  return out;
}

export function cardRef(c) {
  return c.kind === 'rule' ? `rule.${c.ruleId}` : `${c.scope}.${c.id}`;
}

// 把「哪几个 ref 归哪一组」变回完整的 config.groups。
//
// 定义的来源按顺序：现在的分组里 → retired 里 → 按快照生成。
export function rebuildGroups(wanted, config, snapshot, roles) {
  const known = new Map();
  for (const c of (config?.groups ?? []).flatMap((g) => g.cards ?? [])) known.set(cardRef(c), c);
  for (const c of config?.retired ?? []) if (!known.has(cardRef(c))) known.set(cardRef(c), c);

  const verdicts = new Map((config?.groups ?? []).map((g) => [g.title, g.verdict]));

  const used = new Set();
  const groups = wanted.map((g) => {
    const cards = [];
    for (const ref of g.refs) {
      if (roles?.get(ref)?.kind === 'pulse') continue;   // 翻转变量不出卡
      const card = known.get(ref) ?? synthesize(ref, snapshot, roles);
      if (!card) continue;          // 网关上没有这东西了
      used.add(ref);
      cards.push(card);
    }
    const verdict = verdicts.get(g.title);
    return verdict ? { title: g.title, verdict, cards } : { title: g.title, cards };
  });

  // 挪出去的定义存起来 —— 手写的 min/max/unit/applyWith 猜不回来，
  // 丢掉等于「拖错一下，一个能用的滑块永久变成只读」。
  const retired = [...known.entries()]
    .filter(([ref]) => !used.has(ref))
    .map(([, c]) => c)
    .slice(-MAX_RETIRED);

  return { groups, retired };
}

// 生成的卡片一律保守：能确定是 0/1 的数值才给开关，其余只读。
// number 卡要 min/max 才能写，而上下界猜不出来 —— 猜错就是「能写任意数」。
function synthesize(ref, snapshot, roles) {
  if (ref.startsWith('rule.')) {
    const r = snapshot?.rules?.[ref.slice(5)];
    return r ? { kind: 'rule', title: r.name || r.id, ruleId: r.id } : null;
  }

  const i = ref.indexOf('.');
  if (i < 0) return null;
  const scope = ref.slice(0, i), id = ref.slice(i + 1);
  const v = snapshot?.variables?.[scope]?.[id];
  if (!v) return null;

  const base = { title: v.name || id, scope, id };

  // 图里推出来的角色最准 —— 上下界、单位、脉冲目标都在规则图里写着（见 roles.mjs）。
  const role = roles?.get(ref);
  if (role?.kind === 'number') {
    return { kind: 'number', ...base, min: role.min, max: role.max,
      ...(role.unit ? { unit: role.unit } : {}),
      ...(role.applyWith ? { applyWith: role.applyWith } : {}) };
  }
  if (role?.kind === 'toggle') return { kind: 'toggle', ...base, on: role.on, off: role.off };
  if (role) return { kind: 'readonly', ...base };

  // 推不出角色时（拉不到图）只能看类型，那就保守到底：只有 0/1 才敢给开关。
  return v.type === 'number' && (v.value === 0 || v.value === 1)
    ? { kind: 'toggle', ...base, on: 1, off: 0 }
    : { kind: 'readonly', ...base };
}

// 把图里推出来的角色盖到配置上。
//
// **范围只收紧不放宽。** 图里是所有灯的交集，人写的可能过宽（1301/1302 的色温
// 手写 2700-6500，而实际交集是 3000-6400）；人也可能是故意写窄的，那就听人的。
// 两边取更紧的那个，两种情况都不会把住户放进一个灯不认的值。
export function applyRoles(config, roles) {
  if (!config?.groups || !roles?.size) return config;

  return {
    ...config,
    groups: config.groups.map((g) => ({
      ...g,
      cards: g.cards.flatMap((c) => {
        const role = roles.get(cardRef(c));
        if (!role) return [c];
        if (role.kind === 'pulse') return [];      // 脉冲归服务端发，页面不该有这张卡

        if (c.kind === 'number' && role.kind === 'number') {
          return [{
            ...c,
            min: Math.max(c.min, role.min),
            max: Math.min(c.max, role.max),
            unit: c.unit ?? role.unit,
            applyWith: c.applyWith ?? role.applyWith,
          }];
        }
        return [c];
      }),
    })),
  };
}

// 一户新装上来、还没人分过组时，按角色分一份。
//
// 不这么做的话，新一户打开是「未归类 35 项」—— 得先在页面上挪三十个方块
// 才能用，而那正是这套东西想省掉的事。
export function autoGroups(roles, snapshot) {
  const modes = [], params = [];

  for (const [scope, vars] of Object.entries(snapshot?.variables ?? {})) {
    for (const id of Object.keys(vars)) {
      const ref = `${scope}.${id}`;
      const kind = roles?.get(ref)?.kind;
      if (kind !== 'toggle' && kind !== 'number') continue;      // 只读和脉冲不进
      (kind === 'toggle' ? modes : params).push(synthesize(ref, snapshot, roles));
    }
  }

  return [
    ...(modes.length ? [{ title: '全屋模式', cards: modes }] : []),
    ...(params.length ? [{ title: '参数', cards: params }] : []),
  ];
}
