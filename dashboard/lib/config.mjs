import { readFileSync } from 'node:fs';
import { extractLuxMap, extractRoom } from './extract.mjs';

// 语义地图的加载与校验。
//
// 地图是**可选**的：没有它，看板降级成扁平只读模式，装上去就能用。
// 但「文件不存在」和「文件写坏了」是两回事 —— 后者必须响亮地失败，
// 否则改错一个逗号会表现成「本来就没配」，页面照常显示，结论却全没了。
export function loadConfig(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }

  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} 不是合法的 JSON：${e.message}`);
  }

  validate(cfg, path);
  return cfg;
}

function validate(cfg, path) {
  if (!Array.isArray(cfg.groups)) {
    throw new Error(`${path} 里缺少 groups 数组`);
  }

  for (const g of cfg.groups) {
    for (const c of g.cards ?? []) {
      const where = `${path} 的「${g.title}」→「${c.title ?? '无标题卡片'}」`;

      if (c.kind === 'rule') {
        if (!c.ruleId) throw new Error(`${where}：rule 卡片缺 ruleId`);
        continue;
      }
      if (!c.scope || !c.id) throw new Error(`${where}：${c.kind} 卡片缺 scope 或 id`);
      if (c.kind === 'toggle' && (c.on === undefined || c.off === undefined)) {
        throw new Error(`${where}：toggle 卡片缺 on / off —— 不写清楚哪个值算开，页面不敢帮你翻`);
      }
    }
  }
}

// 从活着的网关生成一份语义地图骨架，真实变量名都填好了，
// 人只需要改中文标题、重排分组、补 verdict 的 blockers。
//
// 两条判断：
//   1. 只有匹配 mgs.json 里 runtimeVars、且取值是 0/1 的**全局**变量才生成成 toggle。
//      runtimeVars 是使用者自己声明过的「这些是运行时状态」，不是这里猜的。
//   2. 规则域变量（scope 以 R 开头）一律只读。它们是规则内部状态 ——
//      翻它们等于伸手进规则肚子里，不是住户该在看板上做的事。
export function buildSkeleton(snapshot, { runtimePatterns = [] } = {}) {
  const runtime = runtimePatterns.map((p) => new RegExp(p));

  const groups = Object.entries(snapshot.variables).map(([scope, vars]) => ({
    title: scope,
    cards: Object.entries(vars).map(([id, v]) => {
      const base = { title: v.name || id, scope, id };
      return isToggleable(scope, id, v, runtime)
        ? { kind: 'toggle', ...base, on: 1, off: 0 }
        : { kind: 'readonly', ...base };
    }),
  }));

  groups.push({
    title: '规则',
    cards: Object.values(snapshot.rules).map((r) => ({
      kind: 'rule',
      title: r.name || r.id,
      ruleId: r.id,
    })),
  });

  return { refreshSeconds: 10, groups };
}

function isToggleable(scope, id, v, runtime) {
  if (scope !== 'global') return false;
  if (v.type !== 'number') return false;
  if (v.value !== 0 && v.value !== 1) return false;
  return runtime.some((re) => re.test(id));
}

// 从规则图生成房间骨架。
//
// 阈值、闸门、照度变量全从图里抠（见 extract.mjs），人一个数都不用抄 ——
// 抄一遍只会抄错，而且改了规则不会同步。
//
// 人要给的只有两样：**网格位置**（数据里没有）和**话术**（骨架给的是机器话）。
export function buildFloorplanSkeleton(graphs, snapshot) {
  const probe = Object.values(graphs).find((g) =>
    (g?.nodes ?? []).some((n) => n.type === 'deviceGetSetVar'),
  );
  const luxMap = probe ? extractLuxMap(probe) : {};
  const globals = snapshot?.variables?.global ?? {};

  const rooms = [];
  const skipped = [];
  for (const [ruleId, graph] of Object.entries(graphs)) {
    const name = graph?.cfg?.userData?.name ?? '';
    if (!/开灯/.test(name)) continue;

    const r = extractRoom(graph, luxMap, ruleId);

    // 判据是结构不是名字：房间的人来灯亮规则一定有那对照度比较，
    // 场景规则（1302 的「全屋开灯」）没有。按名字过滤会把场景当成房间。
    if (!r.lux) {
      skipped.push({ rule: ruleId, name, why: '没有照度判定，看着像场景规则' });
      continue;
    }

    rooms.push({
      title: r.zone,
      rule: ruleId,
      col: 1,
      row: rooms.length + 1,
      chain: r.chain.map((g) => {
        const label = globals[g.id]?.name || g.id;
        // 「要等于几才放行」反推阻塞时该说什么：
        // 等于 0 才放行 → 挡住的情形是「它开着」；等于 1 才放行 → 是「它关着」。
        return { ...g, title: label, say: g.equals === 0 ? `${label}开着` : `${label}是关的` };
      }),
      ...(r.lux ? { lux: r.lux } : {}),
    });
  }

  // 位置只能人给，骨架先竖着排一列 —— 能跑，但一看就知道要挪。
  return { columns: ['186px', '296px'], rows: rooms.map(() => '110px'), rooms, skipped };
}
