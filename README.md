# dsh-commandcode-goat

DSH 插件：把 **Command Code 订阅（GOAT / Pro / Max）** 接成 DeepSeek Harness 的模型供应商，并附带账户用量与联网搜索——全部走同一把账户密钥。

```sh
dsh plugin --profile web add link:<本仓库根目录>
```

安装后重启该 profile。**等十几秒**，`commandcode-goat-autosync` 会自己出现在 **设置 → 模型** 里——进去填上 API 密钥就能用，不需要先找到本插件的卡片。

要改档位、开搜索、看用量时再打开卡片（位置见下文《卡片在哪里》）。

---

## 这个插件不自己写适配器

> **版本要求：dsh ≥ 0.1.7-alpha.2；已在 0.1.7-rc.2 上逐项验证。** 0.1.7 把设置子系统换掉了（见文末《0.1.7 迁移》），0.5.0 起只支持新接口。0.6.0 起默认自动创建供应商，并注册到 rc.2 新增的插件配置席位。

它**不实现 `LlmAdapter`**。它把供应商 profile 写进第一方插件 `llm-pi-ai` 的设置命名空间，由 harness 自带的适配器去服务这些路由。

这样做的原因是：流式分片、工具调用、思考参数分发、图片处理、历史回放这些逻辑都在 `llm-pi-ai` 里实现并测试过。外部适配器要把同一套协议重新推导一遍，还得跨版本保持正确；而一份 profile 只需要陈述事实——用哪个端点、哪种协议、哪些模型、各自什么能力。

代价是：生成的供应商属于 `llm-pi-ai`，不属于本插件。所以同步必须**幂等且克制**——它只刷新 `models` 列表，绝不覆盖某条路由上已有的 `apiKeyEnv`、`baseURL`、`compat`、`displayName`；你把密钥填在 **设置 → 模型** 里之后，后续每次同步都不会动它。

但它不该被藏在一个按钮后面。**`autoSync` 默认开启**：装完重启，插件在十几秒后自己把供应商创建出来，于是 **设置 → 模型** 里有了那一行，也就有了填密钥的地方。这一条是踩出来的——默认关掉时，用户装完插件、重启、打开模型列表，什么都没多出来，插件看起来像装坏了，而不是像在等一个按钮。

---

## 两个上游数据源

| 来源 | 提供什么 | 失败时 |
|---|---|---|
| `GET /provider/v1/models` | 实时模型列表，以及**路由真相**——每个模型声明自己支持哪些端点 | 同步失败并报错（没有列表就无从生成） |
| `commandcode.ai/docs/plans/goat` 页面内嵌的目录 | 列表没有的能力信息：能否思考、是否支持图片、各自的最低订阅档位 | 降级：照常生成，但不写能力、不做档位过滤，并在结果里给出提示 |

第二个源是抓取页面的 RSC 载荷（Next.js 的流式数据），不是文档化的 API，所以解析失败只会降级、不会中断同步。

---

## 档位与生成的供应商

档位是**累计包含**的（由目录里的 `minPlanName` 决定，与官方说明一致：Pro 含 GOAT 全部）：

| 档位 | 生成的供应商 | 协议 |
|---|---|---|
| `goat` | `commandcode-goat-autosync` | `openai-completions` |
| `pro` | `commandcode-pro-autosync` + `commandcode-pro-anthropic` | 同上 + `anthropic-messages` |
| `max` | `commandcode-max-autosync` + `commandcode-max-anthropic` | 同上 |

每个档位写自己的供应商，互不覆盖：切换档位后旧档位原样保留，要清理需手动删除。

**为什么要拆两个路由：** Command Code 对 Claude 系列只在 `/messages`（Anthropic 格式）上服务，把 Claude 的 id 发到 `/chat/completions` 会直接 400。拆分依据是列表里的 `supported_endpoints` 字段——那是网关自己声明的，比按 id 前缀猜要可靠。若某个模型只支持 `/responses`，会生成第三个供应商 `commandcode-<档位>-responses`。

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

额度以**百分比**呈现：窗口直接给出 `used` / `cap`，月度池则只给出「余额」与「本期已用」，分母由两者相加得出——服务端从不直接给总量。百分比紧跟标签，金额以小字落在同一行右侧。取整按量级走（`0.02%` 不会被抹成 `0%`，`20.4%` 也不需要多余精度）。

这些金额是**美元**，不是请求数。官方字段名写的是 `credits`，但 5 小时上限 14 与每周上限 35 恰好是每月约 70 的**五分之一和二分之一**——一套典型的「月额度 + 滚动节流」设计——而窗口里的 `used` 与该时段内请求的成本一致。所以卡片直接给 `$` 金额，不再写「额度」这种含糊的单位。

面板上任何形如 `a / b` 的数字都会说明 `b` 是什么：请求数是**一个数**（失败时另起一项写「失败 n」），Token 给**总量**，输入/输出拆开写在下面标注清楚。只有在两半都标明的场合才用斜杠。

**每个端点独立降级**：某个端点临时失败只显示一条说明，不会清空整块；只有四个端点以同一方式全失败时，才会指出一个原因（密钥无效 / 服务不可用 / 网络不通）。

模型也可以自己读：插件注册了 `commandcode_usage` 工具（可在卡片里关闭）。

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

卡片的阅读顺序是固定的几块：抬头 → **一行状态**（绿色的「已获取 N 个模型」，以及密钥是否配好）→ 订阅档位 → 账户用量 → 选项 → 「目标供应商」「高级」两个折叠块。每块都是同一个形状：带边框的盒子，第一行是它的标题，右侧放这一块的动作（重新读取 / 创建更新 / 刷新用量）。生成的供应商名字默认折叠——那是排查时才需要的东西，平时只需要知道拿到了多少个模型。

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
| `catalogURL` | `https://commandcode.ai/docs/plans/goat` | 能力目录页；抓取失败只降级 |
| `plan` | `goat` | 档位：`goat` / `pro` / `max` |
| `targetApiKeyEnv` | `COMMANDCODE_API_KEY` | 生成的路由读取哪把凭据 |
| `targetBaseURL` | `https://api.commandcode.ai/provider/v1` | 聊天基地址 |
| `targetCompat` | `{thinkingFormat: "openai", supportsReasoningEffort: true}` | OpenAI 路由的 compat 覆盖 |
| `extraIds` | `[]` | 目录之外的私有模型 id，写入 OpenAI 路由 |
| `includeReasoningEfforts` | `false` | 为推理模型写入思考档位映射 |
| `autoSync` | `true` | 首次加载后自动创建一次，并按间隔刷新。关掉则只在卡片里点「创建 / 更新」时写入 |
| `autoSyncIntervalMs` | `6h`（最小 60s） | 自动同步间隔；改动在下一次排期时生效 |
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

**为什么 goat 档没有 `commandcode-goat-anthropic`？**
该档位不含任何 Claude 模型，所以不会生成 Anthropic 路由——空路由会被 `llm-pi-ai` 拒绝。

**同步之后模型列表变了，但会话里看不到新模型？**
设置文件的热重载会生效，但浏览器里的模型选择器可能需要刷新页面。

**更新了插件，但界面是新的、行为还是旧的（或卡片标题旁写着 `v?`）？**
插件有**两半**：浏览器半侧（`lib/client.js`）每次打开页面都从磁盘重新读取，宿主半侧（`lib/index.js` 等）只在启动时被 Node `import` 一次。所以 `pnpm update` 之后只刷新页面，会出现「新卡片 + 旧宿主」的混合状态——看起来就像修复没生效。卡片头部会显示宿主的版本号，宿主太旧没上报版本时直接显示 `v?` 并给出提示。这种情况**必须完全退出 DSH Desktop（含托盘）再启动**。

**想改生成供应商的密钥或地址？**
在 **设置 → 模型** 里直接改。下次同步只刷新 `models`，不会动你写过的 `apiKeyEnv`、`baseURL`、`compat`、`displayName`。反过来，如果某个路由上已经写了 `modelOverrides`，同步会拒绝并说明原因——那两者不能共存，插件不会悄悄覆盖你的配置。

**安全性？**
卡片调用的三个端点都是 POST-only 且仅限本机回环：校验对端地址、`Host` 头，以及（浏览器发送时）`Origin` 必须与之一致，`Sec-Fetch-Site: cross-site` 直接拒绝。密钥不在浏览器里；用量报告是宿主侧读取后的结果。

---

## 开发

```sh
npm install           # 只需要 @deepseek-ai/schemastery（其实就是 dsh 自带的那份）
npm test              # 163 个用例，全部离线，不需要网络
npm run verify:live   # 对真实服务跑一遍：模型列表、目录解析、档位统计、端点探活
```

目录结构：

```
lib/
  index.js     Host 半侧：设置分节、同步编排、自动同步、用量工具、装配
  catalog.js   纯函数：列表解析、目录解析、路由判定、档位过滤、能力映射
  pi-ai.js     纯函数：profile 构造 + 带版本栅栏的写入
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

这两个改动的取舍是刻意的：**默认自动写一次，比让人先找到按钮更符合「装一个插件」的预期**；而写入本身仍然是幂等的、可见的、可在 **设置 → 模型** 里直接改的。要恢复成「只在点按钮时写」，把 `autoSync` 设成 `false` 即可。

架构参考了 [CJYLZS/dsh-commandcode-provider](https://github.com/CJYLZS/dsh-commandcode-provider)（MIT）——「把模型写进 `llm-pi-ai` 而不是自己写适配器」这个判断来自它，档位拆分、目录抓取、用量面板的做法也是。

在此基础上本版本做了这些改动：

- **路由依据换成 `supported_endpoints`**：网关自述的端点优先，vendor / id 前缀只作为老网关的兜底。
- **卡片注册到 `plugins.item`**：`settings.plugin.item` 在 dsh 0.1.6-alpha.2 已经不存在，用旧名字的卡片永远不会渲染。
- **卡片自己的设置走 `settingsScope`**：只有跨命名空间的写入（生成供应商）和需要密钥的读取（同步、用量）才经过 bridge。
- **不抢占显式指定的搜索供应商**。
- **写入前检查 `modelOverrides` 冲突**，而不是让 `llm-pi-ai` 抛一个难懂的校验错误。
- **结构化错误码**（`fetch-failed` / `settings-read-only` / `provider-plugin-missing` / `target-has-model-overrides` …），卡片直接展示。
- **163 个离线用例**，外加一份对真实服务的验证脚本。

---

## English

Publishes a **Command Code** subscription (GOAT / Pro / Max) as DSH model providers, with account usage and web search on the same credential.

It owns no LLM adapter: it writes provider profiles into the first-party `llm-pi-ai` settings section, so streaming, tool calling, reasoning and image handling come from the adapter the harness already ships. Two upstream sources are joined — the live `GET /provider/v1/models` list, which states each model's supported endpoints and is therefore the routing truth, and the capability catalog embedded in the GOAT plan page, which states thinking, vision and minimum plan tier. A dead model list fails the sync; a dead catalog only degrades it.

Tiers are cumulative and each writes its own providers, so switching never overwrites the previous tier. Claude models are routed to an `anthropic-messages` provider and everything else to `openai-completions`, decided by the gateway's own `supported_endpoints` rather than an id prefix. Reasoning parameters are blocked for models the vendor marks as non-reasoning, and never invented for the rest.

The card lives in the sidebar **Plugins** panel — as an entry in the official group, on the bundle's own detail page, and behind the **Configure** control on the bundle's row — plus a tab under **Settings → Plugins**. It shows the generated providers, a live usage dashboard (5-hour and weekly windows, credits, request/cost/token totals) and the account key state. The provider row is created automatically a few seconds after the profile starts (set `autoSync: false` to make every write explicit); the API key is configured on that generated provider in **Settings → Models**, not in the card. Web search is optional and will not displace a provider the deployment named explicitly.

```sh
dsh plugin --profile web add link:<path to this repository>
npm test            # 163 offline cases
npm run verify:live # probe the real upstreams and account endpoints
```

MIT. Architecture inspired by [CJYLZS/dsh-commandcode-provider](https://github.com/CJYLZS/dsh-commandcode-provider) (MIT); see the section above for what differs.
