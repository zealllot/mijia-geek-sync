// 单飞缓存：住户开三个浏览器标签页不该等于三倍网关压力。
//
// 同一时刻只有一次在途拉取，所有等待者共享同一个 promise；
// 拉取失败不入缓存，否则一次网络抖动会被冻住整个 TTL。
export function makeCache({ ttlMs, load, now = Date.now }) {
  let inflight = null;
  let value = null;
  let at = -Infinity;

  return {
    async get() {
      if (value !== null && now() - at <= ttlMs) return value;
      if (inflight) return inflight;

      inflight = load()
        .then((v) => {
          value = v;
          at = now();
          return v;
        })
        .finally(() => {
          inflight = null;
        });

      return inflight;
    },

    // 写完一个变量后调用：不做乐观更新，下一次读必须回到网关取真实值。
    invalidate() {
      value = null;
      at = -Infinity;
    },
  };
}
