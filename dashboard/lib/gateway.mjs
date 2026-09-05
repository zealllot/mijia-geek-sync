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

// 把一个 ok:false 的响应变成异常。
//
// callXgg 有意让 ok:false 原样返回（那是确定的答案，不该重试），但**读取路径**
// 绝不能拿它当数据用：未登录时 variable watch 返回 ok:false，
// normalizeSnapshot 会把缺失的 variables 退成 {}，于是「没登录」被伪装成
// 「网关上什么都没有」，页面理直气壮地显示「一切正常，0 项」。
export function unwrap(data, what) {
  if (data?.ok === false) {
    const e = new Error(`${what}：${data.error?.message ?? data.error?.code ?? '网关拒绝了'}`);
    e.code = data.error?.code;
    throw e;
  }
  return data;
}

import { spawn } from 'node:child_process';

// 真正的子进程调用。
//
// 直接 node <cli.js>，不用 npx —— 实测 npx 每次多 0.54 秒（0.66s vs 0.12s）。
// XGG_NO_REFRESH_HINT / XGG_NO_NEXT_HINT 必须设，否则 xgg 的提示文字会混进 JSON。
export function makeGateway({ nodeBin, xggCli, baseUrl, snapshotsDir, timeoutMs = 20_000 }) {
  const baseEnv = {
    ...process.env,
    XGG_BASE_URL: baseUrl,
    XGG_AGENT_MODE: '1',
    XGG_NO_REFRESH_HINT: '1',
    XGG_NO_NEXT_HINT: '1',
    ...(snapshotsDir ? { XGG_SNAPSHOTS_DIR: snapshotsDir } : {}),
  };

  // extraEnv 存在只为登录码：它必须走环境变量而不是 argv。
  // xgg 自己的 --help 就警告 --code 对父进程和 shell history 可见。
  const run = (args, extraEnv = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(nodeBin, [xggCli, ...args], {
        env: { ...baseEnv, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.resume();

      // xgg 自己有 --timeout，但子进程本身可能卡住。
      // 硬杀掉并给一个结构化错误，好过把 HTTP 请求挂死。
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`xgg ${args[0]} ${args[1] ?? ''} 超过 ${timeoutMs}ms 没返回`));
      }, timeoutMs);

      child.on('error', (e) => (clearTimeout(timer), reject(e)));
      child.on('close', () => (clearTimeout(timer), resolve(out)));
    });

  return {
    // 一轮完整刷新只有 2 次子进程调用：variable watch 一次拿全 scope。
    async snapshot() {
      const [watchOut, ruleListOut] = await Promise.all([
        callXgg(['variable', 'watch'], { run }).then((d) => unwrap(d, 'variable watch')),
        callXgg(['rule', 'list'], { run }).then((d) => unwrap(d, 'rule list')),
      ]);
      return normalizeSnapshot(watchOut, ruleListOut);
    },

    // 拉全部规则图。只在 --init-config 时用一次 —— 抠闸门和阈值要看图本身，
    // 而 rule list 只给启用状态。
    async graphs() {
      const list = unwrap(await callXgg(['rule', 'list'], { run }), 'rule list');
      const out = {};
      for (const r of list.rules ?? []) {
        out[r.id] = unwrap(await callXgg(['rule', 'view', r.id], { run }), `rule view ${r.id}`);
      }
      return out;
    },

    async status() {
      return callXgg(['status'], { run });
    },

    async login(code) {
      return callXgg(['login'], { run: (args) => run(args, { XGG_LOGIN_CODE: code }), attempts: 1 });
    },

    // 保留 xgg 默认的写前快照。在别人家里改他正在生效的状态，得有回头路。
    async setVariable({ scope, id, value, type }) {
      return callXgg(
        ['variable', 'set-value', '--scope', scope, '--id', id, '--value', String(value), '--type', type],
        { run, attempts: 1 },
      );
    },
  };
}
