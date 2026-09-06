import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStartupCmd, buildPlist } from '../lib/platform.mjs';

// 住户的电脑不一定是 Mac（见 docs/adr/0004）。看板本体跟平台无关，
// 只有状态目录、开机自启、mDNS 三处不同，都收在 platform.mjs。

test('Windows 的自启是一个 .cmd，删掉就不再自启', () => {
  const cmd = buildStartupCmd({ nodeBin: 'C:\\App\\node.exe', serverJs: 'C:\\App\\server.mjs', port: 7391 });

  assert.match(cmd, /MGS_DASH_PORT=7391/);
  assert.match(cmd, /C:\\App\\node\.exe/);
  // 说清楚怎么关掉 —— 住户在「启动」文件夹里看到它时得知道那是什么
  assert.match(cmd, /删掉这个文件/);
});

test('Windows 的自启用 CRLF 换行', () => {
  // .cmd 用 LF 的话，某些 Windows 版本会把整行连着下一行一起当命令读。
  const cmd = buildStartupCmd({ nodeBin: 'node.exe', serverJs: 's.mjs', port: 1 });

  assert.ok(cmd.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(cmd));
});

test('路径带空格时用引号包住', () => {
  // Windows 上「Program Files」「模式看板」这种带空格的路径是常态。
  const cmd = buildStartupCmd({
    nodeBin: 'C:\\Program Files\\模式看板\\node.exe',
    serverJs: 'C:\\Program Files\\模式看板\\server.mjs', port: 7391,
  });

  assert.match(cmd, /"C:\\Program Files\\模式看板\\node\.exe"/);
  assert.match(cmd, /"C:\\Program Files\\模式看板\\server\.mjs"/);
});

test('macOS 那边照旧是 LaunchAgent', () => {
  const xml = buildPlist({ nodeBin: '/App/node', serverJs: '/App/server.mjs', port: 7391 });

  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  // 故意不写 KeepAlive：连不上网关时服务会退出，KeepAlive 会变成刷屏的重启循环
  assert.ok(!xml.includes('KeepAlive'));
});
