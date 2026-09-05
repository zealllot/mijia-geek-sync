# mgs dashboard —— 极客版模式看板

**在住户自己的 Mac 上开一个本地网页，一眼看出「客厅为什么不亮」。**

## 为什么

住户问「1302 的客厅为什么不亮了」时，答案分散在三处：某条规则被停用了、
某个模式变量被置位了、或者灯本身坏了。前两处只存在中枢里，
要回答就得打开米家 App 翻自动化画布 —— 而画布是给编辑规则用的，不是给诊断用的。

`mgs` 已经能把这些读出来，但它是命令行工具，住户用不了。
看板把同一批数据变成一个不需要任何知识就能看懂的页面。

## 边界

做：

- 规则的启用状态（**只读**）
- 变量的当前值（模式变量**可以翻**）
- 一句话结论：「客厅灯光 · 观影模式开着，会压制自动亮灯」

不做：

- **设备层**。灯在不在线、亮度是多少、灯组掉没掉，都在米家 App 侧。
  看板只回答「自动化该不该让它亮」，不回答「灯本身好不好」。
- **改规则的启用状态**。这继承 `mgs` 的第一条不变量：
  「把规则部署上去」和「让它开始跑」是两个决定。启用只能从 `mgs enable` 发生，
  不能从住户家里的一个网页发生。

## 三条不变量

**1. 只有白名单里的变量能写。**
可写集合来自配置里显式声明为 `toggle` 的卡片。不是「任意 scope/id 都能写」——
即使有人直接 POST 任意参数，也只能改事先批准过的那几个。

**2. 不做乐观更新。**
写完立刻重读并回显网关的真实值。网关拒绝了、或者规则马上把它改回去了，
页面上要看得出来，不能显示一个其实没生效的开关。

**3. 只绑 `127.0.0.1`。**
不绑 `0.0.0.0`。住户家 WiFi 上的其他设备不该能翻他家的模式开关。

## 架构

```
浏览器 ──HTTP──> dashboard/server.mjs ──spawn──> xgg ──WebSocket RPC──> 中枢
         127.0.0.1                      子进程
```

**服务端用 Node，且必须以子进程方式调 xgg。**

用 Node 是因为打包成 .app 时要自带运行时：xgg 硬要求 Node ≥ 20.11，
而 macOS 12.3 起不再自带 python3。既然 Node 无论如何要带，
再带一个 Python 就是白花的第二份体积和第二份复杂度。

**子进程边界不能破。** xgg 是 GPL-3.0，mgs 是 MIT，这个组合成立**只**因为
两者是独立进程。`import '@eyaeya/xgg-cli/dist/program.js'` 会让 mgs 变成衍生作品，
整个仓库得改成 GPL。所以哪怕 in-process 调用更快，也只能 spawn。

## 目录

```
dashboard/
  server.mjs            HTTP 服务入口
  lib/
    gateway.mjs         spawn xgg + 解析 + 重试
    state.mjs           单飞缓存 + 视图模型合成
    verdict.mjs         结论求值（纯函数）
    config.mjs          加载 / 生成语义地图
    autostart.mjs       LaunchAgent 装卸
  public/index.html     零构建前端
  test/*.test.mjs       node:test
tools/build-app.sh      打包 .app（自带 Node）
```

零 npm 依赖 —— 只用 Node 标准库。仓库的 `.gitignore` 有意不跟踪 `package.json`
（README 让使用者自己 `npm i @eyaeya/xgg-cli@2.1.0`），所以看板不能引入需要它的东西。

两个入口，同一份代码：

- `mgs serve <网关>` —— 在你自己机器上跑，用本地 Node 和本地 xgg
- `MijiaDashboard.app` —— 给住户，自带 Node 和 xgg

## 数据层

五个动作，全部经由 xgg 子进程：

| 动作 | 命令 | 线上返回 |
|---|---|---|
| 读全部变量当前值 | `variable watch` | `{op,ts,iso,scopes[],variables{scope:{id:{type,value,name}}},errors{}}` |
| 读规则启用状态 | `rule list` | `{rules:[{id,enable,userData:{name}}]}` |
| 写模式变量 | `variable set-value` | `{ok,scope,id,value,snapshot}` |
| 登录 | `login` | `{ok,...}` |
| 探活 | `status` | `{ok,...}` 或 `{ok:false,error:{code:"AUTH_REQUIRED"}}` |

`variable watch` 的快照模式一次调用就拿全 scope，不需要先 `variable list` 再逐个
`variable get`。所以一轮完整刷新只有 **2 次**子进程调用。

**从 `lib/common.sh` 继承的教训**，逐条抄进来：

- 重试判据是「能解析成 JSON」，**不是响应长度**。
  早期 `mgs` 用「小于 60 字节 = 失败」，在一台没有规则域变量的中枢上
  把合法的 32 字节响应当成了失败。
- 设 `XGG_NO_REFRESH_HINT=1 XGG_NO_NEXT_HINT=1`，否则提示文字会混进 JSON。
- 直接 `node <cli.js>`，不用 `npx`（每次多 0.54 秒）。

**一条和 `common.sh` 不同的**：`common.sh` 在 `ok === false` 时也重试三次。
看板不能这么做 —— 未登录时 `AUTH_REQUIRED` 是个确定的答案，
每 10 秒的轮询重试三次纯属浪费。所以：**解析失败或空输出才重试，
结构化的 `ok:false` 立刻返回**，由调用方决定怎么处理。

**单飞缓存。** 住户开三个浏览器标签页不该等于三倍网关压力。
10 秒 TTL，同一时刻只有一次在途拉取，所有请求共享同一个结果。

**硬超时。** xgg 自己有 `--timeout 10000`，但子进程本身可能卡住。
20 秒没退出就 kill，返回一个结构化错误而不是把 HTTP 请求挂死。

## 语义地图

一份**可选**的 `dashboard.json`。没有它，看板就是扁平模式：
按 scope 列出所有变量、所有规则的启用状态。装上去就能用，零配置。

有它的时候，页面按房间/关注点分组，并给出结论。格式是纯数据 ——
无表达式求值、无代码执行，住户那台机器上它就是一张查找表。

```json
{
  "refreshSeconds": 10,
  "groups": [
    {
      "title": "客厅",
      "verdict": {
        "blockers": [
          { "rule": "20260822110", "enabled": false, "say": "规则「光亮灯灭」被停用了" },
          { "scope": "global", "id": "xggCinema", "equals": 1, "say": "观影模式开着，会压制自动亮灯" }
        ],
        "ok": "一切正常，应该会自动亮"
      },
      "cards": [
        { "kind": "toggle",   "title": "灯光自动化", "scope": "global", "id": "xggLivingAuto", "on": 1, "off": 0 },
        { "kind": "readonly", "title": "照度阈值",   "scope": "global", "id": "xggLivingLux" },
        { "kind": "rule",     "title": "光亮灯灭",   "ruleId": "20260822110" }
      ]
    }
  ]
}
```

卡片三种：`toggle` 可写、`readonly` 只显示值、`rule` 显示规则启用状态（只读）。

**结论（verdict）是这个看板里唯一「有想法」的部分。** 光给一堆开关不解决问题：
住户问「客厅为什么不亮」，如果页面回他二十个开关让他自己找，
那和打开米家 App 翻画布没有本质区别。`blockers` 按顺序求值，
第一个命中的就是页面顶部那行大字；都不命中就说 `ok`。
求值在服务端做，纯函数，可测。

**扁平兜底。** 所有没被任何卡片引用到的变量和规则，落到页面底部
一个折叠的「未归类」区。哪天加了新规则忘了改地图，信息不会凭空消失 —— 只是没归类。

**骨架自动生成。** `mgs serve <网关> --init-config` 从活着的网关拉一次，
把每个运行时变量生成一张 `toggle` 卡、每条规则生成一张 `rule` 卡，
按 scope 分组输出。真实变量名都填好了，人只需要改中文标题和写 `blockers`。

## HTTP 接口

`node:http`，零依赖，绑 `127.0.0.1`。

```
GET  /                  index.html
GET  /api/state         { ok, loggedIn, groups[], unmapped, fetchedAt, errors }
POST /api/login         { code }              → xgg login
POST /api/variable      { scope, id, value }  → set-value + 立刻重读
GET  /api/autostart     { enabled }
POST /api/autostart     { enabled }           → 装 / 卸 LaunchAgent
```

`/api/state` 在服务端就把语义地图和实时数据合成完毕，前端只管渲染。
前端不需要知道 `dashboard.json` 的格式，也不实现 `blockers` 求值 ——
逻辑只有一份，而且在服务端可以测。

## 安全

**CSRF。** 本地 HTTP 服务的经典问题：住户浏览器里任何一个网页都能往
`127.0.0.1` 发 POST。启动时生成一个随机 token，`open` 的 URL 带上它，
所有写接口校验。比检查 `Origin` 头更硬，也不依赖浏览器行为。

**登录码。** 走 `XGG_LOGIN_CODE` 环境变量传给子进程，**不进 argv**
（xgg 自己的 `--help` 明确警告 argv 对父进程和 shell history 可见）。
不落盘、不写日志、不回显。

**写入审计。** 每次 `set-value` 追加一行到
`~/Library/Application Support/MijiaDashboard/writes.log`：时间、scope、id、旧值、新值。
在别人家里改他正在生效的状态，得留痕。
xgg 自己的写前快照（`XGG_SNAPSHOTS_DIR`）保留默认开启。

## 打包与部署

`tools/build-app.sh --arch arm64|x64` 在你机器上跑，产出 `MijiaDashboard-<arch>.zip`：

1. 下载对应架构的 Node 官方 tarball，**校验 SHA256**（官方 `SHASUMS256.txt`）
2. `npm i @eyaeya/xgg-cli@2.1.0` 到暂存目录
3. 组装 bundle，写 `Info.plist`
4. 打包

架构要显式给 —— 这是给**别人**机器打的包，不能默认用本机架构。

```
MijiaDashboard.app/Contents/
  MacOS/launcher          bash：选端口 → 起 node → 等就绪 → open URL → 前台等待
  Resources/node/bin/node 自带运行时
  Resources/app/          server.mjs + public/ + xgg
  Resources/LICENSES.md   GPL-3.0 合规：附 xgg 许可与源码获取途径
```

**配置和状态分开。** bundle 内部是只读的（换版本会被整个替换），
用户可写的东西放 `~/Library/Application Support/MijiaDashboard/`：
`dashboard.json`、`gateway.json`、`writes.log`。

**Gatekeeper。** 未签名，通过网络传过去会带 quarantine 标记，
住户首次打开要去「系统设置 → 隐私与安全性」点「仍要打开」。
已确认这个一次性成本可接受，所以不做签名公证。

**不常驻。** 默认双击才起、退出就停。页面设置里有一个「开机自启」开关，
打开时装一个 LaunchAgent。分寸交给住户自己拿 ——
一个一直连着别人家网关的后台进程，不该是默认。

代价：会话闲置会过期，所以隔久了打开大概率要重新输一次 6 位码。
这不是异常路径，是**常态**，登录卡片必须设计得像首屏而不像报错。

## 考虑过但没做

**`variable watch --follow`。** 能以 NDJSON 流式推送变化，页面可以近实时。
没做的原因：它内部是 800ms 一轮，对网关压力反而比 10 秒轮询大得多，
还多一个要看管的常驻子进程（会话一断就得重启它）。
诊断「客厅为什么不亮」用不着秒级。

**Node 服务直接 `import` xgg。** 更快，但会破掉 GPL 子进程边界。见「架构」。

**Swift 菜单栏 app。** 体验更好（登录状态常驻可见），但要装 Xcode、
代码量大一个数量级，而且未签名的原生 app 被 Gatekeeper 拦得更凶。

**局域网访问（手机上看）。** 需要绑 `0.0.0.0` 加真正的鉴权。
先看「一台 Mac 上够不够用」。

**设备层实时状态、历史曲线、多网关切换。** YAGNI。

## 测试

`node:test`，零依赖。可测的是纯逻辑：

- `verdict.mjs` —— 给一份假快照和一份地图，断言结论文案
- `state.mjs` —— 合成视图模型；未归类项的兜底；单飞缓存不重复拉取
- `config.mjs` —— 地图缺失时的扁平降级；骨架生成
- `gateway.mjs` —— 重试判据（空输出重试、`ok:false` 不重试）、超时、白名单

测不了的是真网关交互 —— 那靠在 1302 上实操验证。
