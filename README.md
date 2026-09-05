# mijia-geek-sync

**把米家自动化极客版的规则变成能进 git 的文件，然后全量对账推回去。**

极客版的规则只存在中枢里，改动靠在网页画布上拖节点，没有版本控制、没有 diff、没有 review。
这个工具把它变成：拉下来是文件 → 改文件 → 看 `git diff` → 推回去。

底层通过 [`@eyaeya/xgg-cli`](https://github.com/eyaeya/xiaomi-central-hub-gateway-cli)（GPL-3.0）
与中枢通信 —— 中枢协议是加密二进制 WebSocket RPC，没有能直接 curl 的接口，xgg 是目前唯一可用的通道。

## 为什么

原来用 xgg 是**命令式**的：一个节点一次 `rule node add`，一条边一次 `rule edge add`。
一条 30 节点的规则要约 60 次调用。实测一批改动 190 次调用跑了 6 分半。

更糟的是**非原子** —— 中间某次调用瞬时失败，就留下一条缺节点的半成品规则，
而 `rule validate` 还会报 `errors: 0`（因为「某个节点没有下游」在图论上不算错误）。

`mgs` 改成**声明式**：期望状态放文件里，一条规则一次 `rule set --body` 整图提交。

| | 命令式 | mgs |
|---|---|---|
| 一条 30 节点规则 | ~60 次调用 | **1 次** |
| 部署一条 20 节点规则（实测） | ~80 秒 | **3.1 秒** |
| 拉 3 条规则（实测） | — | **0.69 秒** |
| 原子性 | 会留半成品 | 要么全落地要么不落地 |
| 能 diff | 否 | 是 |

## 安装

```bash
git clone https://github.com/zealllot/mijia-geek-sync.git
cd mijia-geek-sync
npm i @eyaeya/xgg-cli@2.1.0      # 钉死版本；@latest 会在项目周期内漂移
ln -s "$PWD/mgs" /usr/local/bin/mgs
```

需要：Node 18+、Python 3、macOS 或 Linux（mDNS 解析用 `dns-sd`，Linux 上换 `avahi-resolve` 或直接写 fallback IP）。

## 用法

```bash
mgs init                          # 生成 mgs.json，填网关地址
mgs pull   home                   # 全量拉：规则图 + 变量声明
#   改 data/home/graph/*.json，git diff 看清楚
mgs deploy home --dry-run         # 只看计划
mgs deploy home                   # 建/改，不删
mgs deploy home --prune           # 连线上多余的规则/变量一起删
mgs enable home                   # 看谁开着谁关着
mgs enable home on 20260822110    # 启用
mgs enable home off --match 观影   # 按名字停用
```

**每次操作都要一个 6 位登录码**（米家 App → 中枢网关 → 中枢功能 → 自动化极客版）。
会话闲置会过期，凭证不落盘，所以**做不了无人值守的 CI**。

## 三条不变量

**1. `deploy` 永不改变规则的启用状态。**
`rule set` 默认 `cfgPreserved`，线上是启用就保持启用、是停用就保持停用。
文件里的 `cfg.enable` 是**记录，不是控制**。启用是单独的决定，走 `mgs enable`。

在别人家里动自动化时，「把规则部署上去」和「让它开始跑」必须是两个决定。

**2. `deploy` 永不覆盖已存在变量的值。**
极客版的变量里混着两类东西：

| 例子 | 性质 | 部署时 |
|---|---|---|
| 全局亮度、色温、各区照度阈值 | 配置 | 缺了就按文件里的初值创建 |
| 「自动化总开关」「睡眠模式」「手动锁」 | **运行时状态** | **绝不碰** |

覆盖第二类等于把住户正在生效的模式清掉。`mgs pull` 会按配置里的 `runtimeVars` 正则
把这类变量的初值记成 `null` 并打 `runtime: true`，顺带避免每次 pull 产生假 diff。
规则域变量（scope 以 `R` 开头）一律算运行时。

**3. 不给 `--prune` 就绝不删。**
`--prune` 之前会自动做一次整机备份；本地 `graph/` 为空时直接拒绝执行
（防止一次失败的 pull 把中枢清空）。删规则时先删它的规则域变量再删规则，不留 ghost data。

## 踩过的坑（都已固化进代码）

**原生 body 和 CLI 参数是两套语言。** `rule view` 返回的原生图能直接 `rule set` 推回去，
但字段名和 `rule node add` 的参数对不上：

```
--var-id X   →  "id": "X"
--op eq      →  "operator": "="
--expr 1     →  "elements": [{"type":"const","value":"1"}]
```

所以**新节点要从真实节点克隆形状，不要手写** —— 猜的会被 schema 拒（好在它拒得很明确）。

**格式化绝不能重排数组。** 早期版本为了让 diff 稳定，对 `nodes` 和 `outputs` 排了序，
结果那个重排被当成内容写进了中枢，把某个节点的**扇出顺序**改掉了（边的集合没变，
但下发顺序变了）。实测中枢返回的顺序本身是稳定的，所以排序既没必要又有害。
现在只排序 JSON 的 key。

**别把 xgg 的输出接进 `head`。** SIGPIPE 会把文件截成 0 字节，而且不报错。

**`rule view` / `rule list` 会偶发返空且不报错。** 所有读取都带大小检查 + 重试。

**`validate` 和 `lint --strict` 查的不是一回事。** `validate` 查 pin、颜色、fan-in、
spec 和量程；`lint --strict` 还会查**卡片不可达**（某个输出永远不会被触发）。
批量改动后两个都要跑 —— 只看 `validate` 会漏掉「节点压根没加进去」。
`rule enable` 自己也跑可达性检查并拒绝启用坏图，这是个很有用的兜底。

**坐标存在文件里，所以不需要 `rule layout`。** 节点位置是期望状态的一部分，
每次部署都一样，diff 干净。

## 限制

- 只覆盖**规则图和变量**。设备、灯组、传感器参数都在米家 App 侧，本工具碰不到。
- 依赖 xgg（非官方、逆向）。米家固件或前端一升级就可能失效。
- 鉴权必须人工取码，所以没有无人值守的可能。
- 只在自动化极客版 `ai-config-v5`（2026-04 构建）上验证过。

## 许可

MIT。本工具以子进程方式调用 GPL-3.0 的 xgg，不构成衍生作品；但你分发时要遵守 xgg 自己的许可。
