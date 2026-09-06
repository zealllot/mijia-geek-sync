// 从规则图推每个全局变量「是什么」。
//
// 这是看板和 mgs 绑得最深的一处：规则图里已经写着答案，不用人再抄一遍。
//
//   deviceGetSetVar  从设备读一个值写进变量   → 传感器快照，只读
//   deviceOutput     把变量写进设备属性       → 参数，而且节点上带 min/max/step
//   varGet/varChange 拿变量做等值判断         → 闸门；取值只有 0/1 就是模式开关
//   varChange 触发 + 第一步写回 0             → 翻转变量，是脉冲目标，自己不出卡
//
// 从图里推比让人写配置强的地方不只是省事：
// 全局色温那张卡人手写的是 2700-6500，而图里那盏灯只收 3000-6400。
// 按人写的那份，住户能把灯写进一个它不认的值。

// 米家的灯：siid 2 / piid 2 是亮度，piid 3 是色温。
// 认不出来就不给单位 —— 单位只是好看，猜错了反而误导。
const UNITS = { '2.2': '%', '2.3': 'K' };

export function deriveRoles(graphs) {
  const roles = new Map();
  if (!graphs) return roles;

  const probe = new Set();                 // 探针写的
  const compared = new Map();              // ref → 比较里出现过的值
  const outputs = new Map();               // ref → [{min,max,step,siid,piid}]
  const flips = new Set();                 // 「varChange 触发 + 写回 0」的
  const read = new Set();                  // 被 varGet 读作条件的
  const applyWith = new Map();             // ref → 该跟哪个脉冲一起发
  const alias = new Map();                 // 规则域 ref → 抄自哪些全局 ref（可能不止一个）

  for (const g of Object.values(graphs)) {
    const nodes = g?.nodes ?? [];

    // 这条规则是不是「翻转变量」那一套：varChange 触发，执行链第一步写回 0。
    const flip = nodes.find((n) => n.type === 'varChange' && n.props?.v1 === 1
      && nodes.some((w) => w.type === 'varSetNumber' && w.props?.id === n.props.id
        && w.props?.scope === n.props.scope && constOf(w) === 0));

    if (flip && global_(flip.props)) flips.add(ref(flip.props));

    // 「把一个全局变量抄进规则域变量」—— 参数往往这么走一跳再写进设备，
    // 上下界写在下一跳的 deviceOutput 上。只看直接写设备的那步，
    // 会以为这个参数没人用，于是它掉进只读，住户就改不了了。
    for (const n of nodes) {
      const p = n.props ?? {};
      const src = n.type === 'varSetNumber' && p.elements?.length === 1 && p.elements[0]?.type === 'var'
        ? p.elements[0] : null;
      // **一个中转变量可以有好几个来源**：同一条规则里，夜间分支把夜灯亮度抄进 bri，
      // 白天分支把全局亮度抄进同一个 bri。只记最后一个，前面那个参数就永远推不出来。
      if (src && global_(src) && p.id && p.scope) push(alias, `${p.scope}.${p.id}`, ref(src));
    }

    for (const n of nodes) {
      const p = n.props ?? {};
      if (!global_(p)) continue;

      if (n.type === 'deviceGetSetVar') probe.add(ref(p));

      if (n.type === 'deviceOutput' && p.id) record(ref(p), p);

      if ((n.type === 'varGet' || n.type === 'varChange') && p.operator === '=') {
        push(compared, ref(p), p.v1);
        if (n.type === 'varGet') read.add(ref(p));
      }
    }

    // 写设备的那个 id 可能是规则域的中转变量 —— 顺着别名回到全局变量身上。
    for (const n of nodes) {
      const p = n.props ?? {};
      if (n.type !== 'deviceOutput' || !p.id || !p.scope || global_(p)) continue;
      for (const from of alias.get(`${p.scope}.${p.id}`) ?? []) record(from, p);
    }

    function record(r, p) {
      push(outputs, r, { min: p.min, max: p.max, step: p.step, siid: p.siid, piid: p.piid });
      // 同一条规则里被脉冲带起来的参数 —— 写完它得补一脚，不然不生效。
      if (flip) applyWith.set(r, { scope: flip.props.scope, id: flip.props.id, value: 1 });
    }
  }

  // 纯脉冲 = 翻转写法，而且**从来没人把它读作条件**。
  //
  // 光看「varChange 触发 + 写回 0」不够：观影模式的「意图」规则也是这个形状，
  // 但它在好几条开灯规则里被 varGet 读作闸门 —— 那是住户要按的真模式，
  // 判成脉冲就等于把它从页面上藏起来。同步变量则从头到尾没有一处 varGet。
  const pulses = new Set([...flips].filter((r) => !read.has(r)));

  for (const r of new Set([...probe, ...compared.keys(), ...outputs.keys(), ...pulses])) {
    roles.set(r, classify(r, { probe, compared, outputs, pulses, applyWith }));
  }
  return roles;
}

function classify(r, { probe, compared, outputs, pulses, applyWith }) {
  // 翻转变量自己不出卡：它由服务端在写完参数后发，页面直接戳它等于一个裸开关。
  if (pulses.has(r)) return { kind: 'pulse' };

  // 探针写的是传感器读数。人写进去只会被下一次采样盖掉。
  if (probe.has(r)) return { kind: 'readonly' };

  const outs = outputs.get(r);
  if (outs?.length) {
    // **取交集**：一个变量写给好几盏灯时，只有交集里的值对每盏都合法。
    const min = Math.max(...outs.map((o) => num(o.min, -Infinity)));
    const max = Math.min(...outs.map((o) => num(o.max, Infinity)));
    if (Number.isFinite(min) && Number.isFinite(max) && min <= max) {
      const unit = UNITS[`${outs[0].siid}.${outs[0].piid}`];
      return {
        kind: 'number', min, max,
        ...(unit ? { unit } : {}),
        ...(applyWith.has(r) ? { applyWith: applyWith.get(r) } : {}),
      };
    }
  }

  const vals = compared.get(r);
  // 只在 0/1 之间比较的才是开关。出现过别的值就说明它是多档场景 ——
  // 那时候「翻一下」翻成什么都是猜。
  if (vals?.length && vals.every((v) => v === 0 || v === 1)) return { kind: 'toggle', on: 1, off: 0 };

  return { kind: 'readonly' };
}

// 规则域变量（scope 以 R 开头）一概不管：那是规则内部状态，
// 翻它等于伸手进规则肚子里，不是住户该在看板上做的事。
function global_(p) {
  return p?.scope === 'global' && Boolean(p.id);
}

function ref(p) {
  return `${p.scope}.${p.id}`;
}

function constOf(n) {
  const e = n.props?.elements;
  return e?.length === 1 && e[0]?.type === 'const' ? Number(e[0].value) : undefined;
}

function push(map, k, v) {
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(v);
}

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
