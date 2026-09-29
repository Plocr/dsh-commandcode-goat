# dsh-commandcode-goat

DSH 插件：把 **Command Code 订阅（Go / GOAT / Pro / Max）** 接成 DeepSeek Harness 的模型供应商，并附带账户用量与联网搜索——全部走同一把账户密钥。

```sh
dsh plugin --profile web add link:<本仓库根目录>
```

安装后重启该 profile。**等十几秒**，`commandcode-goat-autosync` 会自己出现在 **设置 → 模型** 里（名字显示为 `Command | goat`）——进去填上 API 密钥就能用，不需要先找到本插件的卡片。

要改档位、开搜索、看用量时再打开卡片（位置见下文《卡片在哪里》）。

---

## 这个插件不自己写适配器

> **版本要求：dsh ≥ 0.1.7-alpha.2；已在 0.1.7-rc.2 上逐项验证。** 0.1.7 把设置子系统换掉了（见文末《0.1.7 迁移》），0.5.0 起只支持新接口。0.6.0 起默认自动创建供应商，并注册到 rc.2 新增的插件配置席位。

它**不实现 `LlmAdapter`**。它把供应商 profile 写进第一方插件 `llm-pi-ai` 的设置命名空间，由 harness 自带的适配器去服务这些路由。

这样做的原因是：流式分片、工具调用、思考参数分发、图片处理、历史回放这些逻辑都在 `llm-pi-ai` 里实现并测试过。外部适配器要把同一套协议重新推导一遍，还得跨版本保持正确；而一份 profile 只需要陈述事实——用哪个端点、哪种协议、哪些模型、各自什么能力。

代价是：生成的供应商属于 `llm-pi-ai`，不属于本插件。所以同步必须**幂等且克制**——它只刷新 `models` 列表，绝不覆盖某条路由上已有的 `apiKeyEnv`、`baseURL`、`compat`；你把密钥填在 **设置 → 模型** 里之后，后续每次同步都不会动它。`displayName` 是唯一的例外，且只改**本插件自己写过**的名字（`Command | <档位>` 这类，含 0.6.x 的旧名 `Command Code GOAT`）：0.6.x 给同一档位的两条路由起了同一个名字，而 harness 的「设置 → 模型」是**一条路由一行**，于是同名的两行看起来像重复的供应商——这正是 0.7.0 要修掉的显示问题。你自己改过的名字不会被覆盖。

但它不该被藏在一个按钮后面。**`autoSync` 默认开启**：装完重启，插件在十几秒后自己把供应商创建出来，于是 **设置 → 模型** 里有了那一行，也就有了填密钥的地方。这一条是踩出来的——默认关掉时，用户装完插件、重启、打开模型列表，什么都没多出来，插件看起来像装坏了，而不是像在等一个按钮。

---

## 两个上游数据源

| 来源 | 提供什么 | 失败时 |
|---|---|---|
| `GET /provider/v1/models` | 实时模型列表，以及**路由真相**——每个模型声明自己支持哪些端点 | 同步失败并报错（没有列表就无从生成） |
| `commandcode.ai/docs/plans/<档位>` 页面内嵌的目录 | 列表没有的能力信息：能否思考、是否支持图片、各自的最低订阅档位 | 降级：照常生成，但不写能力、不做档位过滤，并在结果里给出提示 |

第二个源是抓取页面的 RSC 载荷（Next.js 的流式数据），不是文档化的 API，所以解析失败只会降级、不会中断同步。

**目录页按档位跟随。** Go、GOAT、Pro 三页内嵌的是同一份目录，Max 页则完全没有这个数组——所以 Max 档会退回到 GOAT 页去读，并在结果里说明自己退回了哪一页，而不是悄悄降级成一次没有能力的同步。你在 `catalogURL` 里自己填的地址不会被跟随逻辑替换。

---

## 档位与生成的供应商

四档，**累计包含**（由目录里的 `minPlanName` 决定，与官方说明一致）。`Go` 和 `GOAT` 是两个字面前缀相撞的档位，所以判定用的是集合而不是 `startsWith`：Go 订阅者拿不到 GOAT 的模型。

| 档位 | 默认额度（5h / 周 / 月） | 价格 | 目录里的模型数 |
|---|---|---|---|
| `go` | $3 / $6 / $10 | $1/月 | 53 |
| `goat` | $14 / $35 / $70 | $10/月 | 63 |
| `pro` | $16 / $40 / $80 | $20/月 | 77 |
| `max` | $45 / $90 / $150 + $100（Max 10×）；$90 / $180 / $300 + $200（Max 20×） | $100 / $200 每月 | 85 |

这些数字写在 `lib/plans.js` 里，并在卡片上各自附一条官方页面链接——它们是文档中的**默认额度**，账户真实的窗口数值以用量面板（读 `/alpha/*`）为准。模型数由目录实时统计，卡片在第一次同步之前显示「未知」而不是 0。

生成的供应商 key 与显示名：

| 档位 | key | 显示名 | 协议 |
|---|---|---|---|
| 任意 | `commandcode-<档位>-autosync` | `Command \| <档位>` | `openai-completions` |
| 任意 | `commandcode-<档位>-anthropic` | `Command \| <档位> · Claude` | `anthropic-messages` |
| 任意 | `commandcode-<档位>-responses` | `Command \| <档位> · Responses` | `openai-responses` |

档位 id 一律小写：`Command | go`、`Command | goat`、`Command | pro`、`Command | max`。

**为什么要拆两个路由：** Command Code 对 Claude 系列只在 `/messages`（Anthropic 格式）上服务，把 Claude 的 id 发到 `/chat/completions` 会直接 400。拆分依据是列表里的 `supported_endpoints` 字段——那是网关自己声明的，比按 id 前缀猜要可靠。若某个模型只支持 `/responses`，会生成第三个供应商 `commandcode-<档位>-responses`。

**「只挂载一个」是怎么做到的。** `llm-pi-ai` 的协议是**一条路由一种协议**，而 Claude 只认 `/messages`，所以同一个档位的两条通道在底层必须各自存在——这一点改不了。能改的是**看起来有几个**：

- 插件自己的卡片把两条通道收进**一张**「目标供应商」卡片，内部用页签区分 `AutoSync` / `Anthropic`（截图里那种「两个一模一样的 Command Code GOAT」在卡片上不会再出现）；
- 两条通道的显示名不同（`Command | goat` 与 `Command | goat · Claude`），所以 harness 自带的「设置 → 模型」里也不再是两行同名条目。那一页由 harness 渲染、一条路由一行，插件无法让它合并成一行——能做的是让两行各自可辨认。

**切换档位会清掉旧档位（只在点「创建 / 更新」时）。** 每个档位写自己的 key，互不覆盖；但账号上只有一个生效订阅，所以旧的档位留下的就是幽灵配置（点进去必然失败，名字还几乎一样）。因此**点「创建 / 更新」**写入新档位之后，插件会**删除本插件生成的、属于其它档位的路由**，并在结果里列出删了哪些。两条边界：只认 `commandcode-<档位>-<通道>` 这种精确形状（你自己起的路由名不会被误删），带 `modelOverrides` 的路由只报告、不删除（那是你手改过的）。不想要这个行为就把 `pruneOtherPlans` 设成 `false`。

后台的自动同步**只写不删**：删除别人的配置是按钮的事，放进定时任务会在你正切换档位时动手；而一个 profile 若组合了两行来分别发布两个档位，两行会在启动时互相删掉对方的路由。

清理会顺手检查**还有没有别处在引用被删掉的路由**（profile 的默认模型行、子代理的模型白名单都会按名字指向某个供应商），有的话在结果里点名是哪一节——否则表现就是「默认模型莫名其妙没了」。

## 映射规则（上游 → llm-pi-ai）

| 上游 | 写入的字段 |
|---|---|
| `context_length` / `contextWindow` | `contextWindow` |
| `vision: true` | `input: ["text", "image"]`（否则 `["text"]`） |
| `reasoning: false` | `reasoningEfforts: false`——禁止 harness 发送思考参数 |
| `reasoning: true` | 默认不写，交给路由级 `compat.supportsReasoningEffort` |
| `minPlanName` | 按所选档位过滤 |
| `supported_endpoints` | 决定进哪个路由 |

官方目录只标注模型能否思考，不提供各档位的线上取值，所以插件**不臆造**档位映射。需要时可在卡片里打开「为推理模型写入思考档位」，它会写入 low/medium/high/xhigh/max 的同一映射（opt-in）。

---

## 账户用量

卡片直接展示账户状态，数据在宿主侧读取，密钥不出本机：

| 端点 | 内容 |
|---|---|
| `/alpha/whoami` | 账户与组织身份 |
| `/alpha/usage/summary` | 当前周期的请求、成功率、成本、Token 汇总 |
| `/alpha/billing/credits` | 额度余额、5 小时窗口、每周窗口 |
| `/alpha/billing/subscriptions` | 订阅套餐与状态 |

这些端点没有公开文档，是官方 CLI 实际调用的那一组（本仓库用真实服务验证过：无 key 时全部返回 401 而不是 404）。因此每个字段都按「读不到就当没有」处理，原始响应整体保留。

**订阅来源的优先级是「组织 > 个人」。** `/alpha/billing/subscriptions` 返回的是**单个**订阅对象——也就是说同一时刻只有一个生效订阅，不存在两个 Plan 并存的业务状态。唯一的重叠情形是：账号既有个人的订阅，又属于某个组织，而组织自己也有订阅。这时插件用 `?orgId=` 查组织订阅（也就是生效的那个），并在**另一次尽力而为**的调用里读一次个人订阅，只为了能在卡片上说清「生效的是 Max（组织），底下还有一份个人的 GOAT」。这一次额外调用的失败被单独收集，不会把一份完好的报告变成「服务不可用」，也不会影响 `blocked` 的判定。

卡片会把账号订阅的档位标出来（`GOAT（个人）` / `Pro（组织）`）。**它与当前档位不一致时，插件不会自己改档位**——档位只有你手动切换才变，卡片只给出「切换到 Pro」这一个一键修复，避免插件在你没要求的时候改写供应商。

额度以**百分比**呈现：窗口直接给出 `used` / `cap`，月度池则只给出「余额」与「本期已用」，分母由两者相加得出——服务端从不直接给总量。百分比紧跟标签，金额以小字落在同一行右侧。取整按量级走（`0.02%` 不会被抹成 `0%`，`20.4%` 也不需要多余精度）。

这些金额是**美元**，不是请求数。官方字段名写的是 `credits`，但 5 小时上限 14 与每周上限 35 恰好是每月约 70 的**五分之一和二分之一**——一套典型的「月额度 + 滚动节流」设计——而窗口里的 `used` 与该时段内请求的成本一致。所以卡片直接给 `$` 金额，不再写「额度」这种含糊的单位。

面板上任何形如 `a / b` 的数字都会说明 `b` 是什么：请求数是**一个数**（失败时另起一项写「失败 n」），Token 给**总量**，输入/输出拆开写在下面标注清楚。只有在两半都标明的场合才用斜杠。

**每个端点独立降级**：某个端点临时失败只显示一条说明，不会清空整块；只有前四个端点以同一方式全失败时，才会指出一个原因（密钥无效 / 服务不可用 / 网络不通）。

模型也可以自己读：插件注册了 `commandcode_usage` 工具（可在卡片里关闭，**改完立即生效**——注销和注册都跟着那次设置写入走）。

## 联网搜索

原版 dsh 的 `web_search` 由 DeepSeek 的 Messages API 提供，需要**另一把** `DEEPSEEK_API_KEY`。开启本插件的开关后，搜索改由 Command Code 的 `/alpha/web-search` 提供——同一把账户密钥，一个订阅同时覆盖聊天和搜索。

开关的语义是**直接接管**：打开就用本账户搜索，关掉就把原来的搜索供应商（官方那个，或你在 `cordis.yml` / `$DSH_WEB_SEARCH_PROVIDER` 里指定的那个）原样放回去。原理上搜索供应商由 `ctx.web` 的 `searchProviderId` 在每次调用时决定，且没有公开的 setter，所以插件直接写这个字段并记住被它顶掉的那个值——只在仍然持有该席位时才还原，避免把你中途改过的选择覆盖回去。

---

## 安装

### 方式一：桌面端自带的插件面板（推荐）

侧边栏打开 **插件** 面板 → 右上角 **添加插件** → 粘贴下面任意一种 spec：

```
github:Plocr/dsh-commandcode-goat
https://github.com/Plocr/dsh-commandcode-goat
```

安装器接受的形式（`@deepseek-ai/dsh-plugin-manager` 的 `parseInstallSpec`）：`github:owner/repo` 之类的 git 简写、git 仓库 URL、`.tgz` / `.tar.gz` 压缩包（本地绝对路径或 http 地址）、本地绝对路径，以及 npm 上的包名。装完按提示重启，**改 bundle 成员不会热生效**。

### 方式二：命令行

```bat
:: 安装（本地目录热链接；改完代码重构建即生效，无需重装）
:: <本仓库根目录> = 含 package.json 的那个文件夹，Windows 上写绝对路径
dsh plugin --profile web add link:<本仓库根目录>

:: 只验证层、不启动
dsh --profile web --dump-config

:: 启动 / 重启（Bundle 成员变化不会热生效）
dsh web

:: 桌面端用的是 dsh-workbench profile
dsh plugin --profile dsh-workbench add link:<本仓库根目录>
```

命令行安装 GitHub 版本：

```bat
set "DSH_HOME=%APPDATA%\DSH Desktop\dsh-home"
dsh plugin --profile dsh-workbench add github:Plocr/dsh-commandcode-goat
```

## 卡片在哪里

本插件把自己的页面注册进**四个**官方席位，四个都会出现，都是同一张卡片、同一份状态：

| 位置 | 怎么找 | 从哪个版本起 |
|---|---|---|
| **侧边栏「插件」面板 → 「官方」分组** | 面板里点 `Command Code 订阅接入` 这一项 | 0.5.0 |
| **侧边栏「插件」面板 → 已安装 → 点开 `dsh-commandcode-goat`** | 组合包详情页顶部就是本卡片 | 0.6.0 |
| **同上 → 该组合包的行 `commandcode-goat` → 「配置」** | 行页面多出一个「配置」控件，打开同一张卡片 | 0.6.0 |
| **设置 → 插件（rc.2 里叫「内置插件」）→ `Command Code` 标签页** | 设置面板左侧选「插件」，顶部标签页里选 `Command Code` | 0.5.0 |

后两个是 dsh 0.1.7-rc.2 为**组合包自己的配置**新开的席位：`plugins.bundle.config` 以包名为键，`plugins.row.config` 以 `<包名>#<行 id>` 为键——也就是 `dsh-commandcode-goat#commandcode-goat`。rc.2 把第三方插件的配置页挪到了侧边栏「插件」面板，所以只注册前两个席位的版本是「够得着、但不在你会去看的地方」。

如果你只看到了「已安装」分组里的包名，说明你看的是包列表而不是插件的页面——点开那个组合包，卡片就在详情页上。

卡片的阅读顺序是固定的几块：抬头 → **一行状态**（绿色的「已获取 N 个模型」，以及密钥是否配好）→ **订阅档位**（含四档对照卡：各档可用模型数、默认额度、官方文档链接）→ 账户用量 → **选项**（开关＋同一组档位卡）→ **「目标供应商」**（一张合并卡，内部用 `AutoSync` / `Anthropic` 页签切换通道，并列出其它档位残留的路由与一键清理）→「高级」。每块都是同一个形状：带边框的盒子，第一行是它的标题，右侧放这一块的动作（重新读取 / 创建更新 / 刷新用量）。

## 配置 API 密钥

密钥配在**生成的供应商**上，不在本卡片里：

1. 进入 **设置 → 模型**；
2. 找到 `commandcode-goat-autosync`（或你档位对应的供应商），点编辑；
3. 粘贴 Command Code API Key 并保存。

聊天、搜索、用量卡片共用这一把。也可以启动前 `set COMMANDCODE_API_KEY=cmd_xxx`（变量名可用 `targetApiKeyEnv` 改）。

## 配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `sourceURL` | `https://api.commandcode.ai/provider/v1/models` | 实时模型列表 |
| `catalogURL` | `https://commandcode.ai/docs/plans/goat` | 能力目录页。保持默认时按当前档位跟随（Go / GOAT / Pro 各自那一页），Max 页没有该数组，会自动退回到 GOAT 页并在结果里说明；你自己填的地址则原样使用。抓取失败只降级 |
| `plan` | `goat` | 档位：`go` / `goat` / `pro` / `max` |
| `targetApiKeyEnv` | `COMMANDCODE_API_KEY` | 生成的路由读取哪把凭据 |
| `targetBaseURL` | `https://api.commandcode.ai/provider/v1` | 聊天基地址 |
| `targetCompat` | `{thinkingFormat: "openai", supportsReasoningEffort: true}` | OpenAI 路由的 compat 覆盖 |
| `extraIds` | `[]` | 目录之外的私有模型 id，写入 OpenAI 路由 |
| `includeReasoningEfforts` | `false` | 为推理模型写入思考档位映射 |
| `autoSync` | `true` | 首次加载后自动创建一次，并按间隔刷新。关掉则只在卡片里点「创建 / 更新」时写入 |
| `autoSyncIntervalMs` | `6h`（最小 60s） | 自动同步间隔；改动在下一次排期时生效 |
| `pruneOtherPlans` | `true` | 点「创建 / 更新」后删除本插件生成的、属于其它档位的路由，并在结果里列出；带 `modelOverrides` 的只报告不删除。后台自动同步不清理 |
| `webSearch` | `false` | 用本账户提供 `web_search` |
| `usageBaseURL` | `https://api.commandcode.ai` | `/alpha/*` 用量与搜索的 API 根 |
| `enableUsageTool` | `true` | 注册 `commandcode_usage` 工具 |
| `enableBridge` | `true` | 提供设置卡片调用的 loopback 端点 |

---

## 常见问题

**装完插件，`设置 → 模型` 里没有 Command Code 那一行？**
0.6.0 起不需要你做什么：重启 profile 后等十几秒，插件会自己创建供应商。如果一直不出现，按这个顺序查：

1. 卡片里的错误行——`fetch-failed` 说明读不到模型列表（网络或代理），`provider-plugin-missing` 说明这个 profile 没加载 `llm-pi-ai`，没地方可写；
2. 是不是把 `autoSync` 关掉了——关掉之后就只在点「创建 / 更新」时写入；
3. 宿主半侧还是旧进程。宿主代码只在启动时被 `import` 一次，**装完插件必须重启 profile**，改代码之后也必须完全退出 DSH Desktop（含托盘）再启动。

**卡片显示「尚未创建供应商」，点创建没反应？**
先看卡片里的错误行。常见两类：`fetch-failed`（读不到模型列表，通常是网络或代理）与 `provider-plugin-missing`（该 profile 没加载 `llm-pi-ai`，就没有地方可写）。

**为什么 goat 档只有一条路由？**
该档位不含任何 Claude 模型，所以不会生成 Anthropic 路由——空路由会被 `llm-pi-ai` 拒绝。`go` 档同理（Claude 系列最低从 GOAT 档起）。`pro` / `max` 会各生成一条 `commandcode-<档位>-anthropic`。

**「设置 → 模型」里出现了两条几乎同名的 Command Code？**
那是同一档位的两条通道：`commandcode-goat-autosync`（普通模型）与 `commandcode-goat-anthropic`（Claude 模型，上游只在 `/messages` 上服务它们）。0.7.0 起两条通道的显示名不同（`Command | goat` / `Command | goat · Claude`），本插件卡片里则合并成一张卡、用页签切换。harness 自带的「设置 → 模型」是**一条路由一行**，插件无法让那一页合并——所以名字必须能区分。

**换档位之后，旧的 Command Code 供应商还在？**
点一次「创建 / 更新」：0.7.0 起它会删掉其它档位残留的路由（`pruneOtherPlans`）。也可以点「目标供应商」区里的一键清理。若仍然残留，检查是不是把这开关关了，或者那条路由带着 `modelOverrides`——它会被保留并在结果里点名。后台自动同步不清理，这是刻意的。

**同步之后模型列表变了，但会话里看不到新模型？**
设置文件的热重载会生效，但浏览器里的模型选择器可能需要刷新页面。

**更新了插件，但界面是新的、行为还是旧的（或卡片标题旁写着 `v?`）？**
插件有**两半**：浏览器半侧（`lib/client.js`）每次打开页面都从磁盘重新读取，宿主半侧（`lib/index.js` 等）只在启动时被 Node `import` 一次。所以 `pnpm update` 之后只刷新页面，会出现「新卡片 + 旧宿主」的混合状态——看起来就像修复没生效。卡片头部会显示宿主的版本号，宿主太旧没上报版本时直接显示 `v?` 并给出提示。这种情况**必须完全退出 DSH Desktop（含托盘）再启动**。

**各档位的卡片是空的，只写着「要等第一次同步读过目录才知道」？**
先看卡片最上面有没有一条「宿主半侧还是 v0.6.x 的进程」的提示。有的话就是上面那种混合状态：旧宿主根本不上报各档位的模型数和额度，等多久都不会出现——重启即可。没有那条提示，说明宿主是新的、只是还没读到能力目录（15 秒后的首次同步会读；卡片在打开时也会自己去读一次，所以通常一两秒内就有数字）。

**想改生成供应商的密钥或地址？**
在 **设置 → 模型** 里直接改。下次同步只刷新 `models`，不会动你写过的 `apiKeyEnv`、`baseURL`、`compat`、`displayName`——唯一的例外是**本插件自己写过的**显示名：0.6.x 的 `Command Code GOAT` 会在下次同步时更新成 `Command | goat`，否则升级后那两条同名的路由会一直留着。反过来，如果某个路由上已经写了 `modelOverrides`，同步会拒绝并说明原因——那两者不能共存，插件不会悄悄覆盖你的配置。

**安全性？**
卡片调用的四个端点都是 POST-only 且仅限本机回环：校验对端地址、`Host` 头，以及（浏览器发送时）`Origin` 必须与之一致，`Sec-Fetch-Site: cross-site` 直接拒绝。密钥不在浏览器里；用量报告是宿主侧读取后的结果。

---

## 开发

```sh
npm install           # 只需要 @deepseek-ai/schemastery（其实就是 dsh 自带的那份）
npm test              # 265 个用例，全部离线，不需要网络
npm run verify:live   # 对真实服务跑一遍：模型列表、目录解析、档位统计、端点探活
```

目录结构：

```
lib/
  index.js     Host 半侧：设置分节、同步编排、自动同步、用量工具、装配
  catalog.js   纯函数：列表解析、目录解析、路由判定、档位过滤、能力映射、档位计数
  plans.js     纯函数：档位元数据（显示名、文档链接、默认额度）、生成 key 的解析
  pi-ai.js     纯函数：profile 构造 + 带版本栅栏的写入 + 其它档位路由的清理
  usage.js     纯函数：账户端点读取与归一化
  search.js    纯函数：搜索供应商与选择权接管
  bridge.js    回环端点
  client.js    浏览器半侧：一张设置卡片（lazy-CJS bundle）
tests/
  *.test.mjs   单元与集成用例
  live.mjs     对真实服务的验证脚本
```

---

## 与参考项目的关系

## 0.1.7 迁移

0.1.7-alpha 重写了设置子系统，这个插件依赖的三件事都变了。0.5.0 已按新接口重写；如果你的 dsh 还停在 0.1.6，请用 0.4.8。

| 0.1.6 及以前 | 0.1.7 起 | 插件怎么改的 |
|---|---|---|
| 插件用 `settings.installSection()` / `settings.register()` **注册一个设置命名空间** | 服务换成 `SettingsForms`，**没有注册这回事**：每个插件的 `Config` 就是它的表单，`describe()` 按 **profile 行 id** 返回一份描述 | 删掉整段注册逻辑；`Config` 的每个字段加 `.volatile()` |
| 普通字段就是值 | 标了 `.volatile()` 的字段拿到的是**活引用**（`{ get() }`），用户在别处改完就地更新，插件不重挂载 | `normalizeConfig()` 逐字段 `get()`；用 `ctx.on('loader/volatile-update')` 重算派生状态 |
| 只有 `installSection` 注册过的命名空间能写 | 只有 **volatile 字段**能被写；`settings.mutate(ns, …)` 里的 `ns` 是**行 id**，写的是那一行自己的 config | 源同步仍然写 `llm-pi-ai` 那一行（它的 `providers` 本来就是 volatile），但行 id 改为从 `describe()` 里找，而不是硬编码 |
| 浏览器半侧的设置服务叫 `ctx.settingsScope` | 改名为 **`ctx.configForms`**，`get(entryId)` 按**行 id** 取表单 | 卡片改为 `ctx.configForms.get(entryId)`，并在宿主上报的行 id 与本地常量不一致时自动重绑 |

排查时注意：**行 id 由 profile 决定**。本插件的 patch 声明的是 `commandcode-goat`；如果哪次 dump-config 里这行被改名，插件会自己找到（宿主通过 bridge 上报行 id，卡片据此重绑）。

### 0.1.7-rc.2 适配（0.6.0）

`0.1.7-rc.1` / `rc.2` 在 `alpha.2` 之后一天多才发布，而本插件当时是按 `alpha.2` 写的——DSH Desktop 在 `nightly` 通道上自动升级到 `rc.2` 之后，插件就停在了一个它没测过的宿主上。

逐包对照下来，**rc.2 没有破坏本插件依赖的任何接口**：`settings.describe()` / `mutate()`、`llm-pi-ai` 的 `providers` volatile 字典、`ctx.web` 的 `registerSearchProvider` / `searchProviderId`、`webServer.register`、`tools.register`、`credentials.resolve`、`loader/volatile-update` 全部原样可用（`dsh-credentials`、`dsh-settings`、`dsh-web`、`dsh-client-modules`、`dsh-client-ui-slots` 的代码逐字节未变）。真正要改的是两处**约定**：

| 项 | rc.2 的约定 | 0.6.0 的改法 |
|---|---|---|
| 第三方插件的配置页在哪 | 侧边栏「插件」面板声明三个席位：`plugins.item`（按注册 id）、`plugins.bundle.config`（按组合包包名）、`plugins.row.config`（按 `<包名>#<行 id>`） | 四个席位全注册，键分别是 `commandcode-goat`、`dsh-commandcode-goat`、`dsh-commandcode-goat#commandcode-goat` |
| 装完就该能用 | `llm-pi-ai` 是**休眠挂载**：settings 分节不提供 profile 时，一条路由都不注册 | `autoSync` 默认开启，首次加载后自动创建一次 |

还有一处是设计缺陷、不是版本差异：自动同步的开关和间隔都是 volatile 字段（卡片能就地改），而旧实现把它们的值在挂载时捕获了一次——于是关掉开关要重启 profile 才生效，改间隔同理。0.6.0 改成每次 tick 现读，间隔在下一轮排期生效。

### 0.7.0：Go 档、单一呈现、跨档清理

| 问题 | 0.7.0 的改法 |
|---|---|
| 选 `plan: go` 直接抛错 | 目录里的 `minPlanName` 一直有 `Go`，而代码里的档位表没有这一档，于是判定时读到 `undefined.has(...)`。补上 `go` 档，并把「Go 与 GOAT 共享前缀」这件事从字符串前缀改成集合判定 |
| 「设置 → 模型」里两个一模一样的 `Command Code GOAT` | 同一档位的两条通道曾经共用一个显示名，而那一页是一条路由一行。显示名改为 `Command | <档位>` 与 `Command | <档位> · Claude`（旧名会在下次同步时更新），卡片里则合并成一张带页签的卡片 |
| 切换档位后旧档位的供应商留在列表里 | 写完之后扫一遍，删除本插件生成的、属于其它档位的路由（精确 key 匹配；带 `modelOverrides` 的只报告） |
| 卡片里各块挤在一起 | 用了 9 次却从未定义的 `.ccg-cardBody` 补上样式；顺手把主题里并不存在的 `--dsw-alias-bg-layer-4` 换成实际存在的 `--dsw-alias-bg-layer-3` |
| 个人订阅与组织订阅并存时说不清用的是哪一个 | 额外读一次个人订阅，卡片写明生效档位及其来源，并在与当前档位不一致时给出一键切换（不会自动改） |
| Max 档同步总是「能力目录读取失败」 | 目录页按档位跟随，失败时退回 GOAT 页并说明 |

### 0.7.1：一次审查发现的缺陷，以及向官方设计语言靠拢

审查（宿主半侧、浏览器半侧、数据层各一遍）之后的修法与改动：

| 问题 | 0.7.1 的改法 |
|---|---|
| 卡片上所有图标都不显示 | 卡片向 shell 要 `IconRefreshOutline16` / `IconWarningOutline16` / `IconCheckOutline14`，而 `dsh-client-ui-primitives` 从来没有这些名字——它导出的是 `<Subject>OutlineRegular\|Medium`，尺寸是 prop。因为每个调用点都写了「拿不到就渲染 null」，失败是静默的：按钮、告警、状态胶囊全都只是少了图标。改成按真实名字解析，旧拼写留作最后的候选 |
| 保存成功提示会在写入被拒时也出现 | `configForms` 的 `set`/`unset` 解析出一个布尔值（宿主是否接受这次写入），而卡片只 catch 抛错、把返回值丢了。于是修订冲突、只读部署、`memory` 持久化这些「返回 false 但不抛」的情况一律显示「已保存」，下一次读取再把旧值放回去。现在按返回值判定，失败按字段逐条列出；只读部署另有一句专门的话 |
| 用量面板把函数源码当错误信息打印 | 字典里 `usageFailed` 写了两次（一次是文案、一次是计数函数），后者覆盖前者，于是「读取失败: …」这行插值出一个函数、原样打印 `(n) => \`失败 ${n}\``。计数改名 `usageFailedCount`。这也是没有密钥时最常见的那一屏 |
| 宿主版本是 `unknown` 时，重启提示永远不出现、标题写着 `vunknown` | bridge 从不下发缺失的 `version`，它下发字符串 `unknown`。只把「字段不存在」当作未知，于是那条解释「混合状态」的提示不可达。现在 `''` / `unknown` 同样按未知处理，两种提示互斥 |
| `/describe` 失败时只显示「尚未创建供应商」 | `statusError` 之前只渲染在**折叠着**的「目标供应商」区里。现在和其它失败一样在顶部报出来 |
| 关掉「注册 commandcode_usage 工具」要重启才生效 | `enableUsageTool` 是 volatile 字段，卡片不重挂插件就能改，而注册只发生在一个挂载时读一次的 `if` 里。改成注册/注销跟着 volatile 事件走（`tools.register` 返回的正是注销器） |
| 「重新读取」按钮重新读取不了任何东西 | 它调的 `sync()` 只把本地草稿重新读一遍，不会重新问宿主。拆成两个动作：`reload` 重新拉 `/describe` + `/usage`，`discard` 保留给底部「放弃修改」 |
| 60 秒轮询与卡片开不开无关 | 定时器属于 controller，随插件加载就开跑，唯一的闸门是 `document.hidden`（那是标签页可见性，不是卡片是否打开）。每次 tick 是 5 个上游请求加一次 `/describe`，从不打开插件页的会话也一样发。现在闸门是「卡片根节点在不在 DOM 里」 |
| 目录读不到时，后台同步会把所有模型都写进当前档位且无人知晓 | 降级本身是刻意的（失败关闭会让一次文档页抖动就整天不更新），但后台 tick 丢掉了报告，日志里也没有痕迹。现在后台 tick 在能力目录不可用时打一条 warn |
| 切档后清理残留，只报告删了几条 | 带 `modelOverrides` 的路由会被保留——这正是按钮点了却「没删掉」的原因。结果里的 `protected` 以前没人读，现在卡片点名列出 |
| 账号已选过本插件作为搜索供应商时，卸载会删掉这个选择 | `previous` 只在字段不等于自己时记录，于是部署自己配的 `searchProvider: commandcode` 被当作「我们写的」并在卸载时删除。改为只在真的写入过时才归还 |
| 目录里没写 `reasoning` 的模型被断言为「不能思考」 | `stated()` 只可能返回布尔：两处都没写时返回 `false`，而 `reasoningEfforts: false` 在 `llm-pi-ai` 里是一条主动断言。改成三态，没人说就不写 |
| 高级区每个输入框都没有可访问名字 | 标签是兄弟 `<span>`，输入框没有 id。改成官方 `fields.module.css` 的结构：真 `<label for>`、控件带 id、说明用 `aria-describedby` 指过去 |
| 额外模型 ID 的说明挂在整段末尾 | 它描述的是那一个输入框，现在跟在那个字段下面 |
| 自动同步间隔不在预设里时，下拉框显示成第一项 | 受控 `<select>` 的 value 匹配不到任何 option 时会显示第一项，于是「15 分钟」读成「1h」。现在把当前值补成一个选项 |
| `pruneOtherPlans` 在界面上没有入口 | 宿主 schema 里一直有、卡片里一直没暴露，想关掉只能手改组合文件。选项区补上开关 |
| 卡片在「插件」面板里标题、图标、摘要各出现两次 | 面板自己会先画 20px 的页面标题和这卡片 summary 视图那一行，然后才渲染 page 视图，而卡片又画了一遍自己的标题和介绍。面板的三个席位改为只保留账号档位与版本两个胶囊；「设置 → 插件」那个页签上没有标题，仍用完整头部 |
| 胶囊、开关、进度条比旁边的官方控件更「方」 | shell 给所有元素套了 superellipse 圆角，而 `border-radius:50%` 和胶囊圆角会被它压变形——官方的 Tag/Pill/Switch/StateDot 都在自己的样式表里写 `corner-shape:round` 退出。卡片补上同样的退出 |
| 卡片自己发明了一套分段控件 | 档位选择改用 shell 的 `SegmentedControl`，协议通道页签改用 `SegmentedTabs`；shell 不提供这些组件时，回退版本按同一套 token 复刻同样的几何与状态 |
| 卡片自己的表面色、圆角、字号和 shell 不一致 | 卡片表面换成官方的 settings card 三件套（`settings-card-stroke` / `settings-card-fill` / `radius-xl`），错误文本改用 `--dsw-alias-label-error`（`state-error-primary` 是填充色），硬编码的 9/10px 圆角换成 `--dsw-radius-*`，并补上 `prefers-reduced-motion` 分支 |

另外补了三处防御：窗口的 `cap` 由服务端给出前先判断有限值（NaN 会同时毁掉百分比和进度条宽度）、`modelsFound` 的求和只累加有限值（`undefined` 会让标题在路由存在时显示「尚未创建」）、`usage.js` 的 `num()` 接受数字字符串（把 `"70"` 读成 0 是「你还有额度」这个方向上的错）。

**已知的、刻意保留的取舍**：`successRate` 的百分比/分数二义性（服务实测发百分比，但 0.95 这种值也按分数读，测试固定了两种读法）；能力目录读不到时的降级策略仍是「全部按当前档位处理」。这两处都要么需要上游给单位，要么会把一次文档页抖动放大成整天不更新。

这两个改动的取舍是刻意的：**默认自动写一次，比让人先找到按钮更符合「装一个插件」的预期**；而写入本身仍然是幂等的、可见的、可在 **设置 → 模型** 里直接改的。要恢复成「只在点按钮时写」，把 `autoSync` 设成 `false` 即可。

架构参考了 [CJYLZS/dsh-commandcode-provider](https://github.com/CJYLZS/dsh-commandcode-provider)（MIT）——「把模型写进 `llm-pi-ai` 而不是自己写适配器」这个判断来自它，档位拆分、目录抓取、用量面板的做法也是。

在此基础上本版本做了这些改动：

- **路由依据换成 `supported_endpoints`**：网关自述的端点优先，vendor / id 前缀只作为老网关的兜底。
- **卡片注册到 `plugins.item`**：`settings.plugin.item` 在 dsh 0.1.6-alpha.2 已经不存在，用旧名字的卡片永远不会渲染。
- **卡片自己的设置走 `settingsScope`**：只有跨命名空间的写入（生成供应商）和需要密钥的读取（同步、用量）才经过 bridge。
- **不抢占显式指定的搜索供应商**。
- **写入前检查 `modelOverrides` 冲突**，而不是让 `llm-pi-ai` 抛一个难懂的校验错误。
- **结构化错误码**（`fetch-failed` / `settings-read-only` / `provider-plugin-missing` / `target-has-model-overrides` …），卡片直接展示。
- **265 个离线用例**，外加一份对真实服务的验证脚本。

---

## English

Publishes a **Command Code** subscription (Go / GOAT / Pro / Max) as DSH model providers, with account usage and web search on the same credential.

It owns no LLM adapter: it writes provider profiles into the first-party `llm-pi-ai` settings section, so streaming, tool calling, reasoning and image handling come from the adapter the harness already ships. Two upstream sources are joined — the live `GET /provider/v1/models` list, which states each model's supported endpoints and is therefore the routing truth, and the capability catalog embedded in the plan page, which states thinking, vision and minimum plan tier. A dead model list fails the sync; a dead catalog only degrades it. The catalog is read from the selected tier's own page, falling back to the GOAT page for Max, whose page publishes no catalog array.

Tiers are cumulative and each writes its own providers. Claude models are routed to an `anthropic-messages` provider and everything else to `openai-completions`, decided by the gateway's own `supported_endpoints` rather than an id prefix — which means one tier needs two routes, and no protocol can serve both. What a reader sees is one card: the plugin's own card merges the channels behind tabs, and the routes carry distinct names (`Command | goat`, `Command | goat · Claude`) so the harness's one-row-per-route Models page no longer shows two identical entries. Pressing **Create / Update** then deletes the routes of any *other* tier this plugin generated, so switching a plan leaves no provider behind that the account cannot use; the background auto-sync writes but never deletes. Reasoning parameters are blocked for models the vendor marks as non-reasoning, and never invented for the rest.

The account's own subscription is stated beside the configured tier, organization over personal, and a mismatch offers a one-click switch rather than changing anything by itself.

The card lives in the sidebar **Plugins** panel — as an entry in the official group, on the bundle's own detail page, and behind the **Configure** control on the bundle's row — plus a tab under **Settings → Plugins**. It shows a card per tier with its model count, its price and its documented default quota, a merged target-provider card with one tab per channel, a live usage dashboard (5-hour and weekly windows, credits, request/cost/token totals) and the account key state. The provider row is created automatically a few seconds after the profile starts (set `autoSync: false` to make every write explicit); the API key is configured on that generated provider in **Settings → Models**, not in the card. Web search is optional and will not displace a provider the deployment named explicitly.

```sh
dsh plugin --profile web add link:<path to this repository>
npm test            # 248 offline cases
npm run verify:live # probe the real upstreams and account endpoints
```

MIT. Architecture inspired by [CJYLZS/dsh-commandcode-provider](https://github.com/CJYLZS/dsh-commandcode-provider) (MIT); see the section above for what differs.
