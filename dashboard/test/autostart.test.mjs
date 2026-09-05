import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlist, LABEL } from '../lib/autostart.mjs';

test('plist 用绝对路径启动 node 和 server.mjs', () => {
  const xml = buildPlist({ nodeBin: '/App/node', serverJs: '/App/server.mjs', port: 7391 });

  assert.match(xml, /<string>\/App\/node<\/string>/);
  assert.match(xml, /<string>\/App\/server\.mjs<\/string>/);
});

test('plist 开机自启但不在崩溃后无限重启', () => {
  // KeepAlive 会让一个连不上网关而反复退出的服务变成刷屏的重启循环。
  const xml = buildPlist({ nodeBin: '/App/node', serverJs: '/App/server.mjs', port: 7391 });

  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(xml, /KeepAlive/);
});

test('plist 带上端口，跟前台启动用同一个', () => {
  const xml = buildPlist({ nodeBin: '/App/node', serverJs: '/App/server.mjs', port: 7391 });

  assert.match(xml, /<key>MGS_DASH_PORT<\/key>\s*<string>7391<\/string>/);
});

test('路径里的 XML 特殊字符被转义', () => {
  const xml = buildPlist({ nodeBin: '/App/no&de', serverJs: '/App/s<>.mjs', port: 1 });

  assert.match(xml, /no&amp;de/);
  assert.match(xml, /s&lt;&gt;\.mjs/);
});

test('label 是反向域名形式，卸载时靠它定位', () => {
  assert.match(LABEL, /^[a-z]+(\.[a-zA-Z0-9-]+)+$/);
});
