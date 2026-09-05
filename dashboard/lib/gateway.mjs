// 与中枢通信的唯一通道：spawn xgg 子进程。
//
// 必须是子进程，不能 import。xgg 是 GPL-3.0，mgs 是 MIT，这个组合成立**只**因为
// 两者是独立进程 —— in-process 调用会让 mgs 变成衍生作品。

// 判断一次 xgg 输出该不该重试。
//
// 判据是「能不能解析成 JSON」，**不是响应长度**：mgs 早期用「小于 60 字节 = 失败」，
// 在一台没有规则域变量的中枢上把合法的 32 字节响应当成了失败。
//
// 和 lib/common.sh 的一处不同：common.sh 在 ok===false 时也重试三次，
// 看板不能这么做 —— 未登录时 AUTH_REQUIRED 是个确定的答案，
// 每 10 秒的轮询重试三次纯属浪费。解析成功就返回，由调用方决定怎么处理。
export function classify(stdout) {
  const text = stdout.trim();
  if (!text) return { retryable: true, reason: 'empty' };

  try {
    return { retryable: false, data: JSON.parse(text) };
  } catch {
    return { retryable: true, reason: 'unparseable' };
  }
}

// 把 xgg 的两份原始输出归一成视图层要的快照。
//
// 两个形状都是从 xgg 2.1.0 的 dist 里读出来的，不是猜的：
//   variable watch → { op, ts, iso, scopes[], variables{scope:{id:{type,value,name}}}, errors{} }
//   rule list      → { rules: [{ id, enable, userData: { name } }] }
export function normalizeSnapshot(watchOut, ruleListOut) {
  const rules = {};
  for (const r of ruleListOut.rules ?? []) {
    rules[r.id] = { id: r.id, name: r.userData?.name ?? null, enable: r.enable };
  }

  return {
    variables: watchOut.variables ?? {},
    rules,
    errors: watchOut.errors ?? {},
    fetchedAt: watchOut.iso ?? new Date().toISOString(),
  };
}

// 带重试地调一次 xgg，返回解析后的 JSON。
//
// run 注入进来是为了能测重试逻辑本身 —— 真正的实现在 spawnXgg 里。
export async function callXgg(args, { run, attempts = 3 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const c = classify(await run(args));
    if (!c.retryable) return c.data;
    last = c.reason;
  }
  throw new Error(`xgg ${args.join(' ')}：${attempts} 次都没拿到有效响应（${last}）`);
}
