import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHouses, pickHouse, houseFile } from '../lib/houses.mjs';

const raw = [
  { id: '1302', name: '1302', mdns: 'xiaomi-gateway-hub1', fallback: '192.168.5.25' },
  { id: '1301', name: '1301 楼下', fallback: '192.168.5.33' },
];

test('干净的房屋清单原样收下', () => {
  assert.deepEqual(sanitizeHouses(raw), raw);
});

test('id 要能安全地拼进文件名 —— 挡住路径穿越', () => {
  // id 会变成 dashboard.<id>.json，不挡的话等于让配置指定读写哪个文件。
  assert.deepEqual(sanitizeHouses([{ id: '../../etc/x', name: 'x', fallback: '1.2.3.4' }]), []);
  assert.deepEqual(sanitizeHouses([{ id: 'a/b', name: 'x', fallback: '1.2.3.4' }]), []);
});

test('既没 mdns 也没 fallback 的丢掉 —— 不知道连哪', () => {
  assert.deepEqual(sanitizeHouses([{ id: 'x', name: 'x' }]), []);
});

test('缺名字就用 id 顶上', () => {
  assert.equal(sanitizeHouses([{ id: '1302', fallback: '1.2.3.4' }])[0].name, '1302');
});

test('重复的 id 只留第一个', () => {
  const out = sanitizeHouses([
    { id: 'a', name: '前一个', fallback: '1.1.1.1' },
    { id: 'a', name: '后一个', fallback: '2.2.2.2' },
  ]);
  assert.deepEqual(out.map((h) => h.name), ['前一个']);
});

test('不是数组就当没有', () => {
  assert.deepEqual(sanitizeHouses(null), []);
  assert.deepEqual(sanitizeHouses({ id: 'x' }), []);
});

// ---- 选哪一户 ----
test('记着的那户还在就用它', () => {
  assert.equal(pickHouse(sanitizeHouses(raw), '1301').id, '1301');
});

test('记着的那户没了就退回第一户，不是报错', () => {
  // 配置里删掉一户之后，看板不该打不开。
  assert.equal(pickHouse(sanitizeHouses(raw), '已经删掉的').id, '1302');
});

test('一户都没有时返回 null，让调用方走单户模式', () => {
  assert.equal(pickHouse([], 'x'), null);
});

// ---- 每户自己的文件 ----
test('每户的配置和外观各存一份', () => {
  assert.equal(houseFile('/state', 'dashboard', '1302'), '/state/dashboard.1302.json');
  assert.equal(houseFile('/state', 'layout', '1301'), '/state/layout.1301.json');
});

test('单户模式（没有 id）用不带后缀的文件名 —— 跟现在的包兼容', () => {
  assert.equal(houseFile('/state', 'dashboard', null), '/state/dashboard.json');
});
