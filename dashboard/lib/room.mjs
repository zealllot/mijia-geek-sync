// 按房间求值「自动化通不通」。
//
// 这一层复刻的是 1302 开灯规则里真实的闸门链
// （yang-home/docs/reference/dual-lux-and-manual-lock.md）：
//
//   G   总闸    ziDongHua == 1          （电梯口/电梯玄关没这道）
//   G2  模式闸  观影/睡眠 == 0
//   M   手动闸  该区手动 == 0
//   A3  本地照度 < 本地阈值  ──或── A3b 全局照度 < 区阈值
//
// 整条链读的全是全局变量，所以看板能完整复刻。唯一复刻不了的是规则里的
// A2「本区灯已灭」—— 那是 deviceGet 设备属性，极客版的接口读不到。
// 对「客厅为什么不亮」这个问题不影响：人来问的时候灯本来就是灭的。
//
// 四种状态，而且**「够亮了」和「受阻」必须分开**：前者是自动化判断对了，
// 后者才是有东西压着它。混成一种会让住户去关一个根本没问题的开关。
export function evaluateRoom(room, snapshot) {
  if (!room.chain?.length) {
    return { state: 'unconfigured', say: '未配置', chain: [], lux: null, unresolved: [] };
  }

  const unresolved = [];
  const chain = [];
  let broke = null;

  for (const gate of room.chain) {
    const v = snapshot.variables?.[gate.scope]?.[gate.id];
    const ref = `${gate.scope}.${gate.id}`;

    if (broke) {
      chain.push({ title: gate.title, ref, status: 'skip' });
      continue;
    }
    if (v === undefined) {
      unresolved.push(ref);
      chain.push({ title: gate.title, ref, status: 'missing' });
      broke = { say: `配置引用的 ${ref} 在网关上不存在`, missing: true };
      continue;
    }

    const pass = v.value === gate.equals;
    chain.push({ title: gate.title, ref, value: v.value, status: pass ? 'pass' : 'break' });
    if (!pass) broke = gate;
  }

  const lux = readLux(room, snapshot);
  for (const step of luxSteps(room, lux, broke !== null)) chain.push(step);

  if (broke) {
    return {
      state: broke.missing ? 'unknown' : 'blocked',
      say: broke.say,
      chain, lux, unresolved,
      luxKnown: lux !== null,
    };
  }

  // 照度两道是「或」：任一成立就开灯。都不成立才是「够亮了」。
  if (lux && !(lux.localValue < lux.localThreshold) && !(lux.globalValue < lux.zoneThreshold)) {
    return { state: 'bright', say: '够亮了，自动化判断不需要开', chain, lux, unresolved, luxKnown: true };
  }

  // 「没发现阻碍」说的是我检查过的范围，不是保证灯会亮 —— 所以照度读不到也照说。
  return { state: 'clear', say: '没发现阻碍', chain, lux, unresolved, luxKnown: lux !== null };
}

function readLux(room, snapshot) {
  const l = room.lux;
  if (!l) return null;
  const local = snapshot.variables?.global?.[l.local];
  const global = snapshot.variables?.global?.[l.global];
  if (local === undefined || global === undefined) return null;
  return {
    localValue: local.value, localThreshold: l.localThreshold,
    globalValue: global.value, zoneThreshold: l.zoneThreshold,
  };
}

function luxSteps(room, lux, skipped) {
  const l = room.lux;
  if (!l) return [];
  const mk = (title, ref, value, ok) => ({
    title, ref: value === undefined ? ref : `${ref} = ${value}`,
    status: skipped ? 'skip' : (value === undefined ? 'missing' : (ok ? 'pass' : 'break')),
  });
  if (!lux) return [mk(`本地照度 < ${l.localThreshold}`, l.local), mk(`全局照度 < ${l.zoneThreshold}`, l.global)];
  return [
    mk(`本地照度 < ${l.localThreshold}`, l.local, lux.localValue, lux.localValue < l.localThreshold),
    mk(`全局照度 < ${l.zoneThreshold}`, l.global, lux.globalValue, lux.globalValue < l.zoneThreshold),
  ];
}
