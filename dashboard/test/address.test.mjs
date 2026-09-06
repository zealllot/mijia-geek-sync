import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usableAddress, normalizeAddress } from '../lib/address.mjs';

// mDNS 解析改走 node 的系统解析器（macOS 的 Bonjour / Windows 的 DNS 客户端），
// 不再调 `dns-sd`。但「挡掉回环」那条判据必须留着 —— 见下面第一条。

test('挡掉回环，取真正的局域网地址', () => {
  // 这是实测：查本机名时 dns.lookup 第一条返回的就是 127.0.0.1。
  // 照单全收会让工具去连自己。
  const got = usableAddress([
    { address: '127.0.0.1', family: 4 },
    { address: '192.168.5.58', family: 4 },
  ]);

  assert.equal(got, '192.168.5.58');
});

test('挡掉 link-local', () => {
  // 169.254.x 是没拿到 DHCP 时自己编的地址，连不上任何东西。
  assert.equal(usableAddress([{ address: '169.254.3.4', family: 4 }]), null);
});

test('只要 IPv4', () => {
  assert.equal(usableAddress([{ address: 'fe80::1', family: 6 }]), null);
});

test('一条都没有时返回 null，交给 fallback', () => {
  assert.equal(usableAddress([]), null);
  assert.equal(usableAddress(null), null);
});

// ---- 住户在登录页上填的地址 ----

test('IP 补上 http://', () => {
  assert.equal(normalizeAddress('192.168.5.25'), 'http://192.168.5.25');
  assert.equal(normalizeAddress('192.168.5.25:8080'), 'http://192.168.5.25:8080');
});

test('实例名变成 mdns://', () => {
  assert.equal(normalizeAddress('xiaomi-gateway-hub1'), 'mdns://xiaomi-gateway-hub1');
});

test('认不出来的直接报错，不默默拼一个坏地址', () => {
  // 默默拼成坏地址只会让下一步的失败看不出原因。
  assert.throws(() => normalizeAddress(''), /空的/);
  assert.throws(() => normalizeAddress('这是什么'), /地址填不对/);
});
