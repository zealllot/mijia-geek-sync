import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// 开机自启，装一个 LaunchAgent。
//
// 默认是**关**的：一个一直连着别人家网关的后台进程，不该是默认。
// 分寸交给住户自己拿 —— 页面设置里有这个开关。
export const LABEL = 'com.zealllot.mijia-dashboard';

const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 故意不写 KeepAlive：连不上网关时服务会退出，KeepAlive 会把它变成刷屏的重启循环。
// 开机跑一次就够，住户随时能双击图标再起。
export function buildPlist({ nodeBin, serverJs, port }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodeBin)}</string>
    <string>${esc(serverJs)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MGS_DASH_PORT</key>
    <string>${esc(port)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export function autostartEnabled() {
  return existsSync(PLIST);
}

export function setAutostart(enabled, { port }) {
  if (!enabled) {
    if (!existsSync(PLIST)) return;
    try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch {}
    unlinkSync(PLIST);
    return;
  }

  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(
    PLIST,
    buildPlist({
      nodeBin: process.execPath,
      serverJs: join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs'),
      port,
    }),
  );
  try { execFileSync('launchctl', ['load', PLIST], { stdio: 'ignore' }); } catch {}
}
