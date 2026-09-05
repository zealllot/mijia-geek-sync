import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDnsSd } from '../lib/address.mjs';

// 这份是真机上 `dns-sd -t 4 -G v4 <name>.local` 的原样输出，不是编的。
const real = `DATE: ---Sat 05 Sep 2026---
19:36:36.284  ...STARTING...
Timestamp     A/R  Flags         IF  Hostname                               Address                                      TTL
19:36:36.285  Add  40000003       1  zealllot-MacBook-Pro-2024.local.       127.0.0.1                                    4500
19:36:36.285  Add  40000002      14  zealllot-MacBook-Pro-2024.local.       192.168.5.58                                 4500
`;

test('跳过 ...STARTING... 那行', () => {
  // 它也以数字开头。common.sh 里的 awk '/^[0-9]/{print $6; exit}' 就栽在这 ——
  // 匹配到它、打印空的第 6 列、退出，于是 mDNS 解析从来没成功过。
  assert.notEqual(parseDnsSd(real), '');
});

test('跳过回环地址，取真正的局域网地址', () => {
  // 第一条 Add 是 127.0.0.1。取「第一条」会让工具去连自己。
  assert.equal(parseDnsSd(real), '192.168.5.58');
});

test('一条都没解析到时返回 null，交给 fallback', () => {
  assert.equal(parseDnsSd('DATE: ---Sat 05 Sep 2026---\n19:36:06.268  ...STARTING...\n'), null);
});

test('跳过 link-local 地址', () => {
  const linkLocal = `Timestamp     A/R  Flags         IF  Hostname          Address          TTL
19:36:36.285  Add  40000003       1  gw.local.         169.254.1.2      4500
19:36:36.285  Add  40000002      14  gw.local.         192.168.5.25     4500
`;
  assert.equal(parseDnsSd(linkLocal), '192.168.5.25');
});

test('忽略 Rmv 行（服务下线通告）', () => {
  const withRmv = `Timestamp     A/R  Flags         IF  Hostname          Address          TTL
19:36:36.285  Rmv  40000003      14  gw.local.         192.168.5.99     4500
19:36:36.285  Add  40000002      14  gw.local.         192.168.5.25     4500
`;
  assert.equal(parseDnsSd(withRmv), '192.168.5.25');
});
