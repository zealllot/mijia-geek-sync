// 看板本体跟平台无关（node + 一个单文件前端）。钉死在某个系统上的只有三处：
// 状态目录、开机自启、mDNS 解析。全收在这里。
//
// 见 docs/adr/0004。

import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const IS_WINDOWS = platform() === 'win32';
export const APP_NAME = 'MijiaDashboard';

// 住户机器上存配置和外观的地方。
//
//   macOS    ~/Library/Application Support/MijiaDashboard
//   Windows  %APPDATA%\MijiaDashboard
//   其他     ~/.config/MijiaDashboard
export function stateDir() {
  if (IS_WINDOWS) {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), APP_NAME);
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_NAME);
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), APP_NAME);
}

// ---------- 开机自启 ----------
//
// 默认是**关**的：一个一直连着别人家网关的后台进程，不该是默认。
// 两个平台都要**可见、可撤销** —— 关掉就是删一个文件，不进注册表。

export const LABEL = 'com.zealllot.mijia-dashboard';

function plistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function startupCmdPath() {
  const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
    '模式看板.cmd');
}

export function autostartPath() {
  return IS_WINDOWS ? startupCmdPath() : plistPath();
}

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
</dict>
</plist>
`;
}

// Windows 的等价物：往「启动」文件夹放一个 .cmd。
// 关掉＝删文件，住户自己也能在「任务管理器 → 启动」里看到并关掉。
// 不建 .lnk —— 那要走 COM 或 PowerShell，多一层依赖只为了一个图标。
export function buildStartupCmd({ nodeBin, serverJs, port }) {
  return [
    '@echo off',
    'rem 模式看板 —— 开机自启。删掉这个文件就不再自启。',
    `set MGS_DASH_PORT=${port}`,
    `start "" /min "${nodeBin}" "${serverJs}"`,
    '',
  ].join('\r\n');
}

export function autostartEnabled() {
  return existsSync(autostartPath());
}

export function setAutostart(on, { nodeBin, serverJs, port }) {
  const p = autostartPath();

  if (!on) {
    if (!IS_WINDOWS && existsSync(p)) {
      try { execFileSync('launchctl', ['unload', p], { stdio: 'ignore' }); } catch { /* 没装载过 */ }
    }
    if (existsSync(p)) unlinkSync(p);
    return false;
  }

  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, IS_WINDOWS
    ? buildStartupCmd({ nodeBin, serverJs, port })
    : buildPlist({ nodeBin, serverJs, port }));
  if (!IS_WINDOWS) {
    try { execFileSync('launchctl', ['load', p], { stdio: 'ignore' }); } catch { /* 下次开机也会生效 */ }
  }
  return true;
}

// ---------- 开浏览器 ----------
//
// macOS 那边由 .app 的 launcher 脚本读服务的 READY 行再 `open`。
// Windows 上不能照搬：`.cmd` 里的 `for /f` 会**等命令跑完**才处理输出，
// 而服务永远不退出 —— 浏览器就永远打不开。所以那边由服务自己开。
export function openCommand(url) {
  if (IS_WINDOWS) return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  if (platform() === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

export function openBrowser(url) {
  const { cmd, args } = openCommand(url);
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;   // 开不了不是故障，地址已经打在标准输出上了
  }
}
