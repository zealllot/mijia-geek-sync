# 住户配置生成器

把「给一户配自动化 + 看板」这件事固化下来：从踩点到交付走一条固定的路，
规则由 `home.toml` 生成而不是在极客版里一条条画。

术语见 [CONTEXT.md](../../../CONTEXT.md)。三条已决定的取舍见
[ADR-0001](../../adr/0001-generator-owns-structure-gateway-owns-tuned-values.md)、
[ADR-0002](../../adr/0002-shape-library-not-graph-templates.md)、
[ADR-0003](../../adr/0003-home-file-is-toml.md)。

## 为什么

现在配一户的成本几乎全在「在米家 App 里手建 17–39 条规则」上，
而这些规则高度重复：N 个区 × 2 条，加上八条户级规则。
两户的规则结构一模一样，差别只在 did、阈值、有没有手动锁这些参数上。

看板那半已经不用配了 —— 它从规则图现推房间、闸门链、变量角色和参数上下界。
所以只要规则能生成，「配一户」就只剩下**走一圈把区和设备对上号**这一件真正需要人的事。

## 分工

```
mijia-geek-sync/（公开）        shapes/ 节点形状库（已脱敏）
                               lib/generate.sh 生成器
                               lib/survey.sh   勘查
                               docs/新一户.md  现场作业单

<某户>-home/（私有，无远端）     homes/<户>.toml       人写的那份
                               data/<户>/devices.json 勘查产出，进 git
                               data/<户>/graph/*.json 生成 + 手建混放
                               data/<户>/generated.json 生成清单
```

模板脱敏：`shapes/` 里只留节点结构，did、设备名、房间名全部换成占位符。
结构不是住户隐私，did 和设备名是。

## home.toml

```toml
prefix = "20260907"          # 规则 id 前缀，首次生成的日期，永不改

[[zone]]
name   = "客厅"                      # 住户叫法，进看板
rule   = "沙发"                      # 规则里叫法，可省（默认同 name）
key    = "shaFa"                     # ASCII 短名，机器拿它拼变量名
sensor = "blt.3.1ptb0rqc10001"       # 沙发人体存在
lights = ["group.2086698094947209217", "2021697966"]
switches = ["2157621828:3"]          # 控这个区的墙壁开关键，决定手动锁挂几个触发
lux    = 150                         # 本地照度阈值，初值
luxGlobal = 412                      # 全局照度阈值，初值；没有 globalLux 时忽略
delay  = "2min"                      # 初值
at     = [2, 1]                      # 平面图第 2 行第 1 列

[zone.say]
huiKe = "会客模式开着"                 # 这道闸挡住时说的人话

[house]
manualLock = true                    # 生成 手动锁_<区>
lightOff   = true                    # 生成 光亮灯灭_<区>
guestMode  = true                    # 生成 会客灯
globalLux  = "blt.3.1q3qp5fol0001"   # 全屋照度参考；写了才生双阈值那条腿

[[scene]]
name = "主卧睡眠"
var  = "zhuWoShuiMian"
zone = "zhuWo"
on   = ["887520276:2 prop 2=1", "1191772046:4 click"]
off  = ["1191772046:4 double"]
  [[scene.do]]
  act = "关灯"
  targets = ["主卧灯带", "阳台灯组"]
  [[scene.do]]
  act = "关窗帘"
  targets = ["主卧窗帘"]

[floorplan]
cols = 3
hide = ["电梯口", "电梯玄关"]
```

**双阈值是户级开关。** `[house] globalLux` 声明了全屋参考传感器，每个区就生
「本地 < 区阈值 **或** 全局 < 区的全局阈值」两条腿（1302 的形状）；不声明就只生本地那一道
（1301 的形状）。一个开关分开两户已有的两种形状。

**一个传感器可以喂几个区。** 区是按「灯一起亮灭」划的，不是按传感器 ——
一个存在传感器覆盖沙发和餐桌、但灯分两组，就是两个区共用一个 `sensor`。
探针按传感器去重（同一个 did 只采一次），后一个区写 `luxVar` 指向前一个区的照度变量。

**动作词汇只有四个**：关灯 / 开灯到参数 / 开窗帘 / 关窗帘。
词汇外的场景手建，生成器不碰它们（不在生成清单里）。

## 规则 id

`<prefix>` + 三位，沿用 1302 已经在用的规律：

| | 含义 |
|---|---|
| `10x` | 户级定时（0 夜间模式切换，1 早十点归位） |
| `1i x` | 区 i：0 开灯，1 关灯（i = 1..9） |
| `200` / `21x` / `220` | 总开关 / 全屋开灯关灯 / 会客灯 |
| `23x` / `24x` | 场景意图 / 场景执行 |
| `25i` / `27i` | 手动锁_区 i / 光亮灯灭_区 i |
| `260` | 全局参数同步 |
| `99x` | 探针 |

**区最多 9 个。** 超过就手工分配 —— 两户分别是 6 和 7 个，还有余量，
真撞上再说，不为假想的第十个区把编号变得难读。

变量名由 `key` 拼出来：`lux{Key}`、`shouDong{Key}`、`{key}ShuiMian`；
共用传感器的区用 `luxVar` 显式指向别人的照度变量。

## 生成

```
mgs survey  <户>     联机一次：拉设备清单 + 逐台 spec → devices.json
                     顺手按 roomName/model 猜一份 home.toml 草稿
mgs generate <户>     离线：home.toml + devices.json → graph/*.json
                     每条生成完 xgg rule validate --body
                     顺带产出 dashboard.json（显示名、位置、hide、话术）
mgs lint    <户>     用看板的眼睛看一遍推导结果
mgs deploy  <户>     在他家局域网内，先 --dry-run
```

设备能力（能不能调光调色温、属性在哪个 siid/piid、范围多少）来自 `devices.json`
里存的 spec —— 生成器必须按目标设备的真实范围写 `deviceOutput`，
光换 did 不换 min/max 是错的（1302 吊灯色温 3000–6400，别家的灯可能是 2700–6500）。

**阈值和延时不由生成器拥有**（ADR-0001）：本地已有这条规则的图就沿用图里的当前值，
只有新建的区才用 toml 里的初值。所以重新生成的 diff 里只会出现结构变化。

**生成清单**决定所有权：`generated.json` 里的 id 归生成器，重生时重写；
不在清单里的是手建的，永不触碰。toml 里删掉一个区，生成器会把上次生过、
这次没有的列出来让人确认，加 `--prune-generated` 才删。

## 验收

1302 当回归样本：把它的实际情况写成 `home.toml`，生成到临时目录跟现有 43 条 diff。
结构一致就算生成器对了；节点顺序和画布坐标不同无所谓；少一道闸说明模型漏了维度。
**不部署** —— 1301/1302 继续手管，生成器只服务新户。

## 现场

`docs/新一户.md` 是作业单，一次上门跑完：

1. 进门前：要房主准备什么（关掉冲突的旧自动化、极客版登录码）
2. `mgs survey` → 草稿
3. 走一圈改草稿：区怎么划、每个区的灯和开关键
4. `mgs generate` → `validate` → `mgs lint`
5. `mgs deploy --dry-run` → `deploy`
6. 装看板，逐区走一遍验收
7. 交付说明书，说清楚下次上门做什么

回家后等几天日志，用 `scripts/lux-history.sh` 那套标定阈值 ——
阈值不能在配置当天定，因为要的是「灯灭时的环境照度」，得攒样本。
