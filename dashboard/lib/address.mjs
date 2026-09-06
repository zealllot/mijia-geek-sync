import { lookup } from 'node:dns/promises';

// 网关 IP 由 DHCP 分配会变，所以按 mDNS 实例名解析，失败回落到配置里的 fallback。
//
// **不走 `dns-sd`。** 那是 macOS 独有的命令，而看板也要能装在 Windows 上
// （见 docs/adr/0004）。`dns.lookup('<名>.local')` 两个平台都通 ——
// macOS 走 Bonjour，Windows 10+ 的 DNS 客户端自己解析 `.local`。
// 少一个外部命令，也少一段输出解析（那段解析这个仓库踩过两次坑）。
//
// 一条判据必须留着：**挡掉回环和 link-local**。实测查本机名时
// `dns.lookup` 返回的就是 127.0.0.1，照单全收会让工具去连自己。
export function usableAddress(list) {
  for (const { address, family } of list ?? []) {
    if (family !== 4) continue;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) continue;
    if (address.startsWith('127.') || address.startsWith('169.254.')) continue;
    return address;
  }
  return null;
}

// 解析一个 mDNS 实例名，失败返回 null。
export async function resolveMdns(instance, { timeoutSec = 4 } = {}) {
  const name = `${instance}.local`;
  try {
    // all:true —— 只看第一个会拿到回环地址（本机名就是这样）
    const found = await Promise.race([
      lookup(name, { all: true }),
      new Promise((ok) => setTimeout(() => ok(null), timeoutSec * 1000)),
    ]);
    return usableAddress(found);
  } catch {
    return null;   // 解析不到不是错误，是「该用 fallback 了」
  }
}

// 住户在登录页上填的地址。
//
// IP 是会变的（DHCP），所以这东西必须能在页面上改 —— 打包时写死一个
// 意味着地址一变住户就只能等我重新打包。
//
// mDNS 实例名比 IP 耐用：DHCP 换地址它自己会跟着走。所以两种都收，
// 认不出来的直接报错 —— 默默拼成一个坏地址只会让下一步的失败看不出原因。
export function normalizeAddress(text) {
  const t = String(text ?? '').trim().replace(/\/+$/, '');
  if (!t) throw new Error('地址填不对：是空的');

  const bare = t.replace(/^https?:\/\//, '');
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/.test(bare)) return `http://${bare}`;
  if (/^https?:\/\//.test(t)) return t;
  if (/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(t)) return `mdns://${t}`;

  throw new Error(`地址填不对：${t} —— 要么是 IP（192.168.1.100），要么是 mDNS 实例名`);
}

// 网关地址：优先 mDNS，回落 fallback。两个都没有就是配置写漏了。
export async function resolveGateway({ mdns, fallback }) {
  if (mdns) {
    const ip = await resolveMdns(mdns);
    if (ip) return `http://${ip}`;
  }
  if (fallback) return `http://${fallback}`;
  throw new Error('网关配置里既没有 mdns 也没有 fallback');
}
