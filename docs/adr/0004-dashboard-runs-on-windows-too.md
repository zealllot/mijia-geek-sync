# 看板要能装在 Windows 上，平台差异收进一层

住户的电脑不一定是 Mac。看板本体（node + 单文件前端）本来就跟平台无关，
钉死在 macOS 上的只有四处：状态目录、开机自启、mDNS 解析、打包脚本。
把前三处收进 `dashboard/lib/platform.mjs`，第四处再写一个 `tools/build-win.sh`。

| | macOS | Windows |
|---|---|---|
| 状态目录 | `~/Library/Application Support/MijiaDashboard` | `%APPDATA%\MijiaDashboard` |
| 开机自启 | LaunchAgent plist + `launchctl` | 「启动」文件夹里放一个 `.cmd`，关掉＝删文件 |
| 交付形态 | `.app`，解压拖进「应用程序」双击 | 文件夹 + `模式看板.cmd`，解压双击 |
| 首次拦截 | Gatekeeper「仍要打开」 | SmartScreen「更多信息 → 仍要运行」 |

**mDNS 不再走 `dns-sd`。** Windows 上没有这个命令，而
`dns.lookup('<实例名>.local')` 在两边都通 —— macOS 走 Bonjour，
Windows 10+ 的 DNS 客户端自己解析 `.local`。实测本机名能解析出地址。
少一个外部命令、少一段输出解析（那段解析这个仓库踩过两次坑），
两个平台共用同一份代码。

原来那道「挡掉 `127.` 和 `169.254.`」的判断必须留着：
实测查本机名时 `dns.lookup` 返回的就是 `127.0.0.1`。
`all: true` 拿全部地址再筛，别只看第一个。
