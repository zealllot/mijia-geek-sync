import { execFile } from 'node:child_process';

// 网关 IP 由 DHCP 分配会变，所以按 mDNS 实例名解析，失败回落到配置里的 fallback。
//
// 解析 dns-sd 的输出有两个坑，lib/common.sh 各踩了一半：
//
//   1. `...STARTING...` 那行也以数字开头。用 /^[0-9]/ 取第一行会匹配到它，
//      打印出空的地址列就退出 —— 于是解析从来不成功，只是有 fallback 兜着看不出来。
//   2. 第一条 Add 可能是回环地址（解析本机名时 127.0.0.1 排在前面）。
//      取「第一条 Add」会让工具去连自己。
//
// 所以判据是：A/R 列必须是 Add，地址列必须是像样的 IPv4，且不是回环或 link-local。
export function parseDnsSd(stdout) {
  for (const line of stdout.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f[1] !== 'Add') continue;

    const addr = f[5];
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(addr ?? '')) continue;
    if (addr.startsWith('127.') || addr.startsWith('169.254.')) continue;

    return addr;
  }
  return null;
}

// 解析一个 mDNS 实例名，失败返回 null。
export function resolveMdns(instance, { timeoutSec = 4 } = {}) {
  return new Promise((resolve) => {
    execFile(
      'dns-sd',
      ['-t', String(timeoutSec), '-G', 'v4', `${instance}.local`],
      { timeout: (timeoutSec + 2) * 1000 },
      (_err, stdout) => resolve(parseDnsSd(stdout ?? '')),
    );
  });
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
