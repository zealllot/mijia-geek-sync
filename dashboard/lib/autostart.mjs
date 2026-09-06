// 开机自启。两个平台的做法不同，都收在 platform.mjs 里 —— 这里只管
// 「拿哪个 node、跑哪个脚本、哪个端口」，那三样跟平台无关。
//
// 默认是**关**的：一个一直连着别人家网关的后台进程，不该是默认。
// 分寸交给住户自己拿 —— 页面设置里有这个开关。

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  autostartEnabled as enabled,
  setAutostart as apply,
  autostartPath,
  buildPlist,
  buildStartupCmd,
  LABEL,
} from './platform.mjs';

export { autostartPath, buildPlist, buildStartupCmd, LABEL };

export function autostartEnabled() {
  return enabled();
}

export function setAutostart(on, { port }) {
  apply(on, {
    nodeBin: process.execPath,
    serverJs: join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs'),
    port,
  });
}
