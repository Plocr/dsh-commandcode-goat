/**
 * dsh-commandcode-goat — browser half.
 *
 * One card, registered into the Plugins page's `plugins.item` slot under this
 * plugin's settings namespace. The slot is keyed, and the page dispatches it
 * twice per entry: once with `view: "summary"` for the line under the card
 * title, and once with `view: "page"` for the page behind it. Both come here.
 *
 * The module output is the loader's lazy-CJS factory shape
 * (`window.__ModuleLoader__.load({ id, factory })`) because the client bundle
 * preset that produces it is not published; out-of-tree bundles reproduce it
 * by hand. Executing this file only *registers* the factory — every side
 * effect, including the stylesheet below, runs when the factory materializes.
 *
 * What the card can and cannot do is not an accident:
 *
 *   - Its own settings go through `ctx.configForms`, which is revision-fenced
 *     and writes only the user layer, so a hand-edited `cordis.yml` still wins.
 *   - Everything else — status, sync, usage — goes through the host's loopback
 *     bridge, because those need the account key or the settings service, and
 *     neither belongs in a tab.
 */

window.__ModuleLoader__.load({
  id: 'dsh-commandcode-goat',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /**
     * The settings section this card edits.
     *
     * Since dsh 0.1.7 a section *is* a plugin entry, so the key is the row id
     * this bundle's patch declares — not a namespace the plugin registers. The
     * host reports its own row id through the bridge and the card rebinds if a
     * profile named the row differently; this constant is only the starting
     * guess.
     */
    const NS = 'commandcode-goat'
    const BRIDGE = '/api/dsh-commandcode-goat'

    /**
     * The two keys the Plugins page addresses this bundle's own configuration
     * by, since dsh 0.1.7-rc.2 moved a third-party bundle's config page here.
     *
     * The page declares three seats and keys them differently: `plugins.item`
     * by the registration `id`, `plugins.bundle.config` by the **bundle's npm
     * package name**, and `plugins.row.config` by `<package name>#<row id>`.
     * The row id is the one this bundle's `cordis.patch.yml` declares, which is
     * also the settings namespace — so the card's three seats all name the same
     * configuration, and a profile that renamed the row only has to be honoured
     * once.
     */
    const PACKAGE_NAME = 'dsh-commandcode-goat'
    const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${NS}`
    const DEFAULT_SOURCE_URL = 'https://api.commandcode.ai/provider/v1/models'
    const DEFAULT_CATALOG_URL = 'https://commandcode.ai/docs/plans/goat'
    const DEFAULT_BASE_URL = 'https://api.commandcode.ai/provider/v1'
    const DEFAULT_ALPHA_BASE_URL = 'https://api.commandcode.ai'
    const DEFAULT_API_KEY_ENV = 'COMMANDCODE_API_KEY'
    /** How often the account panel re-reads the account while the card is open. */
    const USAGE_REFRESH_MS = 60_000

    /**
     * The tiers, cheapest first, under the titles the vendor sells them by.
     *
     * Four rather than the three the card used to offer: Go is a real
     * subscription and an account can be on it, which is exactly the state the
     * card has to be able to explain when the plugin is pointed at another
     * tier. The order is the host's own (`describe.plans`), so the pills and
     * the tier cards cannot disagree about what "next tier up" means.
     */
    const PLANS = [
      { value: 'go', title: 'Go' },
      { value: 'goat', title: 'GOAT' },
      { value: 'pro', title: 'Pro' },
      { value: 'max', title: 'Max' },
    ]
    const AUTO_SYNC_CHOICES = [
      { value: 60 * 60 * 1000, title: '1h' },
      { value: 3 * 60 * 60 * 1000, title: '3h' },
      { value: 6 * 60 * 60 * 1000, title: '6h' },
      { value: 12 * 60 * 60 * 1000, title: '12h' },
      { value: 24 * 60 * 60 * 1000, title: '24h' },
    ]

    /** The route tail each wire protocol is published under. */
    const ROUTE_SUFFIX = { openai: 'autosync', anthropic: 'anthropic', responses: 'responses' }
    /** The provider key one tier's route is written to, mirrored from the host. */
    const providerKey = (plan, route) => `commandcode-${plan}-${ROUTE_SUFFIX[route] ?? ROUTE_SUFFIX.openai}`

    /**
     * The route slots in creation order, and what the card calls each one.
     *
     * The host states a slot's channel itself (`describe.targets[slot].channel`)
     * and that is what the card renders; this table is the fallback for a host
     * too old to send one, so a slot never reaches the screen unnamed.
     */
    const ROUTE_ORDER = ['openai', 'anthropic', 'responses']
    const ROUTE_LABELS = { openai: 'AutoSync', anthropic: 'Anthropic', responses: 'Responses' }
    /**
     * What a tier's provider name carries per slot, mirrored from the host.
     *
     * Two slots of one tier are one subscription over two protocols, so the
     * name has to say which protocol, or Settings → Models shows two rows that
     * read as the same provider written twice.
     */
    const CHANNEL_SUFFIX = { openai: '', anthropic: ' · Claude', responses: ' · Responses' }
    const providerDisplayName = (plan, route) => `Command | ${plan}${CHANNEL_SUFFIX[route] ?? ''}`
    /** The human title of a tier id, falling back to the id the host used. */
    const planTitle = (value) => PLANS.find((entry) => entry.value === value)?.title ?? String(value ?? '')

    // ── copy ────────────────────────────────────────────────────────────────
    const zh = {
      title: 'Command Code 订阅接入',
      tabLabel: 'Command Code',
      intro: '把 Command Code 订阅接成 DSH 的模型供应商；聊天、搜索、用量共用一把密钥。',
      summaryPending: '尚未创建供应商',
      modelsReady: (n) => `已获取 ${n} 个模型`,
      summaryReady: (plan, count) => `${plan} 档 · ${count} 个模型`,
      plan: '订阅档位',
      planHint: '档位累计包含：Pro 含 GOAT 全部，Max 含全部模型。每个档位写入独立供应商，切换不会覆盖旧档位。',
      sync: '创建 / 更新',
      syncing: '同步中…',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      discard: '放弃修改',
      refresh: '重新读取',
      targets: '目标供应商',
      created: '已创建',
      missing: '未创建',
      models: (n) => `${n} 个模型`,
      keyReady: '密钥已配置',
      keyReadyEnv: '密钥已配置（环境变量）',
      keyMissing: '密钥未配置',
      keyMissingHint: (name) => `凭据库和环境变量里都没有找到 ${name}。去 设置 → 模型 给生成的供应商填一次，或用环境变量启动。`,
      keyWhere: 'API 密钥配置在生成的供应商上，不在本卡片里：设置 → 模型 → 选择上表中的供应商 → 填写 API 密钥。',
      keyWhereEnv: (name) => `也可以启动前设置环境变量 ${name}。`,
      usage: '账户用量',
      usageRefresh: '刷新用量',
      usageLoading: '读取中…',
      usageEmpty: '还没有数据。',
      usageFailed: '读取失败',
      usagePlan: '套餐',
      usageRequests: '本期请求',
      usageFailed: (n) => `失败 ${n}`,
      usageCost: '本期成本',
      usageTokens: '本期 Token',
      usageTokenSplit: (input, output) => `输入 ${input} · 输出 ${output}`,
      usageFiveHour: '5 小时窗口',
      usageWeekly: '每周窗口',
      usageCreditsMonthly: '月度余额',
      usageMonthlyDetail: (left, used) => `可用 ${left} · 本期已用 ${used}`,
      usageWindowDetail: (used, cap) => `已用 ${used} / 上限 ${cap}`,
      usageCreditsPurchased: '购买余额',
      usageCreditsFree: '赠送余额',
      usageResets: (text) => `${text} 后重置`,
      usageWindowNote: '窗口由「上一个窗口结束后的第一个请求」开出：之后固定 5 小时 / 7 天，继续使用不会顺延，额度也不会带进下一个窗口。',
      usageExceeded: '已用尽',
      usageRaw: '原始响应',
      search: '用本账户提供 web_search',
      searchHint: '开启后，模型的联网搜索改走 Command Code 的同一把密钥，无需再配置 DSH 自己的搜索密钥；关闭则把搜索供应商恢复成原来的那个。',
      hostStale: '宿主半侧没有上报版本，说明它还是更新前的进程，修复不会生效。请完全退出 DSH Desktop（含托盘）后重新启动。',
      autoSync: '自动创建与同步',
      autoSyncHint: '启动后自动创建一次，并按所选间隔刷新——装完重启就能在「设置 → 模型」里看到本账户的供应商并填密钥。关掉后只在点「创建 / 更新」时写入。',
      autoSyncInterval: '同步间隔',
      options: '选项',
      advanced: '高级',
      sourceURL: '模型列表地址',
      catalogURL: '能力目录地址',
      targetBaseURL: '聊天接口地址',
      usageBaseURL: '用量/搜索接口地址',
      apiKeyEnv: '凭据变量名',
      extraIds: '额外模型 ID',
      extraIdsHint: '逗号或换行分隔，写入 OpenAI 形态的供应商。',
      includeReasoningEfforts: '为推理模型写入思考档位',
      includeReasoningEffortsHint: '官方目录只标注模型能否思考，不提供各档位的线上取值。开启后按 low/medium/high/xhigh/max 的同一映射写入。',
      usageTool: '注册 commandcode_usage 工具',
      usageToolHint: '允许模型在对话中读取本账户的套餐与额度。',
      reset: '恢复默认',
      overridden: '已覆盖',
      syncDryRun: '预演',
      syncDone: '同步完成',
      syncResult: (live, plan) => `上游 ${live} 个模型，已写入 ${plan} 档`,
      syncSkipped: (routes) => `未生成：${routes}`,
      syncDiagnostics: '提示',
      protocol: '接入协议',
      targetTabs: '协议通道',
      tierCards: '各档位额度',
      tierModels: (models, live) => `${models} 个模型，其中 ${live} 个在线`,
      tierModelsUnknown: '这档有多少模型，要等第一次同步读过目录才知道。',
      tierDoc: '档位说明',
      tierSelected: '当前档位',
      tierSwitch: '切换到此档位',
      tierSwitchSubscribed: '切回账户订阅的档位',
      subscribedPersonal: '账户订阅（个人）',
      subscribedOrganization: '账户订阅（组织）',
      subscribedUnknown: '账户订阅',
      quotaPrice: '月费',
      quotaPriceValue: (money) => `${money} / 月`,
      quotaPremiumMonthly: '高级额度',
      subscriptionPersonal: (title) => `${title}（个人）`,
      subscriptionOrganization: (title) => `${title}（组织）`,
      subscriptionNotice: (subscribed, configured) => `账户订阅是 ${subscribed} 档，插件当前写的是 ${configured} 档。`,
      stale: '其他档位的残留路由',
      staleHint: '切档后旧档位的供应商还留在「设置 → 模型」里；清理只删这些残留，不动当前档位。',
      staleEmpty: '没有其他档位的残留路由。',
      staleTier: (title) => `属于 ${title} 档`,
      prune: '清理残留',
      pruning: '清理中…',
      pruneResult: (n) => `已清理 ${n} 条残留路由`,
      error: '错误',
      settingsUnavailable: '当前部署没有提供可写的设置服务。',
    }
    const en = {
      title: 'Command Code subscription',
      tabLabel: 'Command Code',
      intro: 'Publish a Command Code subscription as DSH providers; chat, search and usage share one key.',
      summaryPending: 'No provider created yet',
      modelsReady: (n) => `${n} models available`,
      summaryReady: (plan, count) => `${plan} · ${count} models`,
      plan: 'Subscription tier',
      planHint: 'Tiers are cumulative: Pro includes all of GOAT, Max includes everything. Each tier writes its own providers, so switching never overwrites the previous one.',
      sync: 'Create / Update',
      syncing: 'Syncing…',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      discard: 'Discard',
      refresh: 'Reload',
      targets: 'Target providers',
      created: 'created',
      missing: 'not created',
      models: (n) => `${n} models`,
      keyReady: 'Key configured',
      keyReadyEnv: 'Key configured (environment)',
      keyMissing: 'No key',
      keyMissingHint: (name) => `Neither the credential store nor the environment holds ${name}. Store it on the generated provider in Settings → Models, or export it before launch.`,
      keyWhere: 'The API key lives on the generated provider, not in this card: Settings → Models → the provider named above → API key.',
      keyWhereEnv: (name) => `Alternatively export ${name} before launch.`,
      usage: 'Account usage',
      usageRefresh: 'Refresh usage',
      usageLoading: 'Loading…',
      usageEmpty: 'No data yet.',
      usageFailed: 'Could not read usage',
      usagePlan: 'Plan',
      usageRequests: 'Requests',
      usageFailed: (n) => `${n} failed`,
      usageCost: 'Cost',
      usageTokens: 'Tokens',
      usageTokenSplit: (input, output) => `${input} in · ${output} out`,
      usageFiveHour: '5-hour window',
      usageWeekly: 'Weekly window',
      usageCreditsMonthly: 'Monthly balance',
      usageMonthlyDetail: (left, used) => `${left} left · ${used} used this period`,
      usageWindowDetail: (used, cap) => `${used} used / ${cap} max`,
      usageCreditsPurchased: 'Purchased',
      usageCreditsFree: 'Free',
      usageResets: (text) => `resets in ${text}`,
      usageWindowNote: 'A window opens on your first request after the previous one elapsed: it then runs a fixed 5 hours / 7 days. Later requests neither extend it nor carry credit into the next window.',
      usageExceeded: 'exceeded',
      usageRaw: 'Raw response',
      search: 'Serve web_search from this account',
      searchHint: 'While on, the model searches with the same Command Code credential, so no separate DSH search key is needed; turning it off restores the search provider that was selected before.',
      hostStale: 'The host half reported no version, so it is still the process from before the update and none of the fixes are live. Quit DSH Desktop completely (including the tray) and start it again.',
      autoSync: 'Automatic create & sync',
      autoSyncHint: 'Create the provider on startup and refresh it on the chosen interval, so the row appears in Settings → Models without a click. Turn it off to write only when Create / Update is pressed.',
      autoSyncInterval: 'Interval',
      options: 'Options',
      advanced: 'Advanced',
      sourceURL: 'Model list URL',
      catalogURL: 'Capability catalog URL',
      targetBaseURL: 'Chat base URL',
      usageBaseURL: 'Usage/search base URL',
      apiKeyEnv: 'Credential name',
      extraIds: 'Extra model ids',
      extraIdsHint: 'Comma or newline separated; written to the OpenAI-shaped provider.',
      includeReasoningEfforts: 'Declare thinking levels for reasoning models',
      includeReasoningEffortsHint: 'The official catalog only marks whether a model can think, not the wire value per level. Enabling writes the identity mapping across low/medium/high/xhigh/max.',
      usageTool: 'Register the commandcode_usage tool',
      usageToolHint: "Lets the model read this account's plan and limits during a conversation.",
      reset: 'Reset',
      overridden: 'overridden',
      syncDryRun: 'Dry run',
      syncDone: 'Sync complete',
      syncResult: (live, plan) => `${live} models upstream, written to the ${plan} tier`,
      syncSkipped: (routes) => `Not generated: ${routes}`,
      syncDiagnostics: 'Notes',
      protocol: 'Protocol',
      targetTabs: 'Protocol channel',
      tierCards: 'Tier quotas',
      tierModels: (models, live) => `${models} models, ${live} live`,
      tierModelsUnknown: 'How many models this tier admits is known once a sync has read the catalog.',
      tierDoc: 'Tier details',
      tierSelected: 'Current tier',
      tierSwitch: 'Switch to this tier',
      tierSwitchSubscribed: 'Switch back to the subscribed tier',
      subscribedPersonal: 'Account subscription (personal)',
      subscribedOrganization: 'Account subscription (organization)',
      subscribedUnknown: 'Account subscription',
      quotaPrice: 'Monthly price',
      quotaPriceValue: (money) => `${money} / month`,
      quotaPremiumMonthly: 'Premium balance',
      subscriptionPersonal: (title) => `${title} (personal)`,
      subscriptionOrganization: (title) => `${title} (organization)`,
      subscriptionNotice: (subscribed, configured) => `The account is subscribed to ${subscribed}, while the plugin writes the ${configured} tier.`,
      stale: 'Routes left by another tier',
      staleHint: 'Switching tiers leaves the previous one in Settings → Models. Removing clears only those leftovers, never the configured tier.',
      staleEmpty: 'No routes left over from another tier.',
      staleTier: (title) => `${title} tier`,
      prune: 'Remove leftovers',
      pruning: 'Removing…',
      pruneResult: (n) => `Removed ${n} left-over routes`,
      error: 'Error',
      settingsUnavailable: 'This deployment serves no writable settings provider.',
    }

    // ── styles ──────────────────────────────────────────────────────────────
    /**
     * Layout only. Every control comes from the harness's own primitives below,
     * so nothing here restates a button, a switch or a chip — what is left is
     * the page structure those controls sit in, expressed in the same design
     * tokens the shipped cards use.
     */
    const CSS = [
      '.ccg-root{display:flex;flex-direction:column;gap:20px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,inherit)}',
      // header
      '.ccg-head{display:flex;align-items:flex-start;gap:12px}',
      '.ccg-headIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-brand-primary,inherit)}',
      '.ccg-headText{min-width:0;flex:1 1 auto}',
      '.ccg-headTitle{margin:0;font-size:15px;font-weight:600;line-height:1.3;color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-headIntro{margin:4px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,inherit)}',
      '.ccg-headTags{flex:none;display:inline-flex;align-items:center;gap:6px;padding-top:2px}',
      // sections
      // One repeated unit for every block: a bordered box whose first row is its
      // own title. The card used to alternate between floating and boxed
      // sections, which is most of why it read as ragged.
      '.ccg-card{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:12px}',
      '.ccg-cardHead{display:flex;align-items:center;gap:8px;min-height:22px}',
      '.ccg-cardTitle{margin:0;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,inherit)}',
      '.ccg-status{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:rgba(60,157,92,.15);color:var(--dsw-alias-state-success-primary,#3c9d5c)}',
      '.ccg-section{display:flex;flex-direction:column;gap:10px}',
      '.ccg-disclosure{display:flex;align-items:center;gap:8px;width:100%;padding:8px 2px;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;font-weight:600;letter-spacing:.02em;line-height:1.5;text-align:left;cursor:pointer}',
      '.ccg-disclosure:hover{color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-disclosure:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4D6BFE);outline-offset:2px}',
      '.ccg-disclosureMark{flex:0 0 10px;color:var(--dsw-alias-label-tertiary,inherit)}',
      // rows
      '.ccg-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ccg-row-top{align-items:flex-start}',
      '.ccg-spacer{flex:1 1 auto}',
      '.ccg-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-muted{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}',
      '.ccg-strong{font-weight:600}',
      '.ccg-hint{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,inherit)}',
      '.ccg-error{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary,#d9534f);white-space:pre-wrap}',
      '.ccg-ok{font-size:12px;color:var(--dsw-alias-state-success-primary,#3c9d5c)}',
      '.ccg-notice{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08))}',
      '.ccg-noticeText{flex:1 1 auto;min-width:0;margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit)}',
      '.ccg-noticeAction{flex:none}',
      // A card body is a stack. These are written into the JSX in nine places,
      // and until this rule existed every block inside one of them sat flush
      // against the next: the pills, the switches, the meters and the tier
      // cards were all spaced by nothing.
      '.ccg-cardBody{display:flex;flex-direction:column;gap:12px}',
      // plan picker
      '.ccg-pills{display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:999px;background:var(--dsw-alias-bg-layer-3)}',
      // fields
      '.ccg-fields{display:flex;flex-direction:column;gap:2px}',
      '.ccg-field{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}',
      '.ccg-field:first-child{border-top:0}',
      '.ccg-fieldLabel{flex:0 0 168px;font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}',
      '.ccg-fieldControl{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:8px}',
      // switches
      '.ccg-switch{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}',
      '.ccg-switch:first-child{border-top:0}',
      '.ccg-switchText{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.ccg-switchTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,inherit)}',
      // the merged provider card: one tier, one tab per protocol
      '.ccg-provider{display:flex;flex-direction:column;gap:10px;padding:12px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
      '.ccg-providerHead{display:flex;align-items:center;gap:8px;min-width:0}',
      '.ccg-providerName{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);word-break:break-all}',
      '.ccg-tabs{display:flex;align-items:center;flex-wrap:wrap;gap:2px;padding:3px;border-radius:10px;background:var(--dsw-alias-bg-module-platform)}',
      '.ccg-tab{padding:4px 10px;border:0;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;font-weight:500;line-height:1.5;cursor:pointer}',
      '.ccg-tab:hover{color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-tab:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4D6BFE));outline-offset:1px}',
      // The selected tab is a raised surface on the track, the same pairing the
      // shell's own segmented tabs use, so it reads as selected in both themes
      // without a colour of our own.
      '.ccg-tab[aria-selected=true]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary,inherit);font-weight:600}',
      '.ccg-tabPanel{display:flex;flex-direction:column;gap:6px}',
      // the ghost routes a tier switch leaves behind
      '.ccg-stale{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-3)}',
      '.ccg-staleTitle{font-weight:600;color:var(--dsw-alias-state-warn-label,inherit)}',
      '.ccg-staleRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      // one card per tier, in the options section
      '.ccg-tiers{display:flex;flex-direction:column;gap:8px}',
      '.ccg-tier{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));border-radius:10px}',
      '.ccg-tierSelected{border-color:var(--dsw-alias-brand-primary,#4D6BFE)}',
      '.ccg-tierHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ccg-tierTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-tierFoot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ccg-quota{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit)}',
      '.ccg-link{font-size:12px;color:var(--dsw-alias-link,inherit);text-decoration:none}',
      '.ccg-link:hover{text-decoration:underline}',
      // usage
      // A meter is four cells in a 2x2 grid, so every row's numbers land in the
      // same two columns instead of drifting with the length of its label.
      '.ccg-meter{display:grid;grid-template-columns:minmax(0,1fr) max-content;align-items:center;gap:6px 12px}',
      '.ccg-meterHead{grid-area:1/1;display:flex;align-items:center;gap:8px;min-width:0}',
      // Fixed label and share columns, so the shares line up down the panel and
      // the reset countdowns start at the same x.
      '.ccg-meterLabel{flex:0 0 86px;font-weight:600}',
      '.ccg-meterDetail{grid-area:1/2;text-align:right;font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);font-variant-numeric:tabular-nums;white-space:nowrap}',
      // The bar spans both columns: fixed geometry, so all of them start and end
      // together however wide the figures beside them happen to be.
      '.ccg-bar{grid-area:2/1/3/-1;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}',
      '.ccg-barFill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,#4D6BFE);transition:width .3s ease}',
      '.ccg-barFull{background:var(--dsw-alias-state-error-primary,#d9534f)}',
      '.ccg-percent{flex:0 0 48px;text-align:right;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}',
      '.ccg-metric{display:flex;flex-direction:column;gap:2px}',
      '.ccg-metricLabel{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}',
      '.ccg-metricValue{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-metricDetail{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}',
      // raw / summary
      '.ccg-pre{margin:0;max-height:220px;overflow:auto;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.1));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word}',
      '.ccg-foot{display:flex;align-items:center;gap:8px;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}',
      '.ccg-summary{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}',
      // fallbacks, used only where the shell serves no primitives
      '.ccg-fbBtn{height:30px;padding:0 12px;border-radius:8px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08));color:inherit;font:inherit;font-size:12px}',
      '.ccg-fbBtn:disabled{opacity:.5;cursor:default}',
      '.ccg-fbBtnPrimary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4D6BFE);color:#fff}',
      '.ccg-fbTag{padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);font-size:11px}',
      '.ccg-fbInput{flex:1 1 auto;min-width:0;height:32px;padding:0 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08));color:inherit;font:inherit;font-size:13px}',
      '.ccg-select{height:32px;min-width:110px;padding:0 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08));color:inherit;font:inherit;font-size:13px}',
      '.ccg-fbSwitch{flex:none;width:36px;height:20px;border-radius:999px;border:0;cursor:pointer;background:var(--dsw-alias-bg-layer-3);position:relative;padding:0}',
      '.ccg-fbSwitchOn{background:var(--dsw-alias-brand-primary,#4D6BFE)}',
      '.ccg-fbSwitch span{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s ease}',
      '.ccg-fbSwitchOn span{left:18px}',
    ].join('')
    const TAG_ID = `${NS}/client.css`
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG_ID)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
    const h = React.createElement

    /**
     * The harness's own control set.
     *
     * A lazy bundle may require it because the shell pre-registers it as a seed
     * instance, the same way `react` arrives — which is why no dependency has to
     * be declared for it. The guard is for a shell that does not serve it: the
     * card then falls back to plain controls carrying the same accessible names
     * rather than failing to materialize at all.
     */
    const ui = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives') ?? {}
      } catch {
        return {}
      }
    })()

    const Button = ui.Button ?? (({ variant, className, children, ...rest }) =>
      h('button', { type: 'button', className: `ccg-fbBtn${variant === 'primary' ? ' ccg-fbBtnPrimary' : ''} ${className ?? ''}`, ...rest }, children))
    const Tag = ui.Tag ?? (({ tone, className, children }) => h('span', { className: `ccg-fbTag ${className ?? ''}`, 'data-tone': tone }, children))
    const Switch = ui.Switch ?? (({ checked, onChange, label, disabled, title, className }) => h('button', {
      type: 'button',
      role: 'switch',
      'aria-checked': checked,
      'aria-label': label,
      title,
      disabled,
      className: `ccg-fbSwitch${checked ? ' ccg-fbSwitchOn' : ''} ${className ?? ''}`,
      onClick: () => onChange(!checked),
    }, h('span', null)))
    const Input = ui.Input ?? (({ className, ...rest }) => h('input', { className: `ccg-fbInput ${className ?? ''}`, ...rest }))
    const Pill = ui.Pill ?? (({ active, className, children, onClick }) => h('button', {
      type: 'button',
      className: `ccg-fbTag ${active ? 'ccg-fbBtnPrimary' : ''} ${className ?? ''}`,
      onClick,
      disabled: onClick === undefined,
    }, children))
    const IconRefresh = ui.IconRefreshOutline16
    const IconWarning = ui.IconWarningOutline16
    const IconCheck = ui.IconCheckOutline14 ?? ui.IconCheckOutline16

    // ── store ───────────────────────────────────────────────────────────────
    /** A minimal `useSyncExternalStore`-compatible store. */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set: (next) => {
          value = next
          for (const listener of listeners) listener()
        },
        update: (patch) => {
          value = { ...value, ...patch }
          for (const listener of listeners) listener()
        },
      }
    }

    // ── host bridge ─────────────────────────────────────────────────────────
    /**
     * Call one bridge endpoint.
     *
     * The bridge answers 200 with `{ok:false}` for expected failures and a
     * non-200 only for a request it refused outright, so both paths are read
     * here and turned into one thrown message.
     */
    async function callBridge(path, body) {
      const response = await fetch(`${BRIDGE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || payload?.ok === false) throw new Error(payload?.message ?? `HTTP ${response.status}`)
      return payload.value
    }

    // ── formatting ──────────────────────────────────────────────────────────
    const formatMoney = (value) => {
      const amount = Number(value ?? 0)
      return `$${amount.toFixed(Math.abs(amount) < 1 ? 4 : 2)}`
    }
    const formatCount = (value) => {
      const n = Number(value ?? 0)
      if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
      return String(n)
    }
    /**
     * A dollar figure for a quota.
     *
     * These are money, not counters: the five-hour cap of 14 and the weekly cap
     * of 35 are exactly a fifth and a half of the ~70 the plan grants each
     * month, and a window's `used` tracks the cost of the requests inside it.
     * Whole dollars stay whole — a plan's limits are round numbers — anything
     * else takes two places, and a value too small for two keeps a third so it
     * never reads as zero.
     */
    const formatDollars = (value) => {
      const n = Number(value ?? 0)
      if (!Number.isFinite(n)) return '$0'
      if (Number.isInteger(n)) return `$${n}`
      const rounded = Math.round(Math.abs(n) * 100) / 100
      return rounded >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`
    }
    /** How much of a quota is spent, as a number in 0–100. */
    const percentValue = (used, total) => (total > 0 ? Math.min(Math.max((used / total) * 100, 0), 100) : 0)
    /**
     * A percentage at the precision its magnitude deserves: a quota barely
     * touched reads as "0.02%" rather than being rounded away to "0%", and a
     * large one does not claim more precision than it has.
     */
    const formatPercent = (value) => {
      const n = Math.max(Math.min(value, 100), 0)
      if (n === 0) return '0%'
      if (n < 1) return `${n.toFixed(2)}%`
      if (n < 10) return `${n.toFixed(1)}%`
      return `${Math.round(n)}%`
    }
    const percentOf = (window) => (window === undefined ? 0 : percentValue(window.used, window.cap))
    const formatDuration = (seconds) => {
      const total = Math.max(Math.round(Number(seconds) || 0), 0)
      if (total < 60) return `${total}s`
      const minutes = Math.floor(total / 60)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}h ${minutes % 60}m`
      return `${Math.floor(hours / 24)}d ${hours % 24}h`
    }
    /** Seconds remaining until a window's `resetAt`, which the API states in milliseconds. */
    const secondsUntil = (resetAt) => (typeof resetAt === 'number' && resetAt > 0
      ? Math.max(Math.round((resetAt - Date.now()) / 1000), 0)
      : undefined)

    // ── what `describe` says, read defensively ──────────────────────────────
    /**
     * The tabs the merged provider card shows: one per route slot the host
     * reports, in creation order.
     *
     * The slot list comes from `describe.targets` rather than from a constant,
     * so a host that grows a fourth protocol shows up here without a client
     * release. A host that reports no targets at all still has three routes to
     * talk about, and the slots are fixed by the protocols the account is
     * served over, so the strip falls back to the known order instead of going
     * empty.
     */
    function providerTabs(targets) {
      const source = targets !== null && typeof targets === 'object' ? targets : {}
      const present = Object.keys(source)
      const slots = present.length === 0
        ? [...ROUTE_ORDER]
        : [...ROUTE_ORDER.filter((slot) => present.includes(slot)), ...present.filter((slot) => !ROUTE_ORDER.includes(slot))]
      return slots.map((slot) => ({
        slot,
        // The host's own channel name when it sends one; the local table is the
        // fallback for a host that sends no channel at all.
        label: typeof source[slot]?.channel === 'string' && source[slot].channel !== ''
          ? source[slot].channel
          : ROUTE_LABELS[slot] ?? slot,
        target: source[slot] ?? {},
      }))
    }

    /**
     * The tiers the options section renders, in the host's order.
     *
     * `describe.tiers` is the whole card: quota, documentation, and which tier
     * the account's own subscription is on. A host older than that field
     * reports only `plans`, and the cards still render from those, without
     * quota or a link, rather than the section disappearing.
     */
    function tierList(status) {
      const tiers = Array.isArray(status?.tiers) ? status.tiers.filter((tier) => tier !== null && typeof tier === 'object') : []
      if (tiers.length > 0) return tiers
      const plans = Array.isArray(status?.plans) && status.plans.length > 0 ? status.plans : []
      return plans.map((plan) => ({ plan, title: planTitle(plan) }))
    }

    /** The sizes one tier is sold in, cheapest first. Not every host states any. */
    function tierVariants(tier) {
      const variants = Array.isArray(tier?.variants) ? tier.variants : []
      return variants.filter((variant) => variant !== null && typeof variant === 'object')
    }

    /** Which dictionary entry labels each quota figure. */
    const QUOTA_COPY = {
      price: 'quotaPrice',
      fiveHour: 'usageFiveHour',
      weekly: 'usageWeekly',
      monthly: 'usageCreditsMonthly',
      premiumMonthly: 'quotaPremiumMonthly',
    }

    /**
     * One size's quota as labelled rows, in a fixed order: the price, the two
     * rolling windows, the monthly pool, then the premium half the Max sizes
     * split out.
     *
     * A figure the host did not state is left out rather than printed as a
     * zero, and an unknown key is dropped rather than labelled with itself:
     * the card does not put a raw field name in front of a reader.
     */
    function tierQuotaRows(variant) {
      const rows = []
      for (const key of Object.keys(QUOTA_COPY)) {
        const value = variant?.[key]
        if (typeof value === 'number' && Number.isFinite(value)) rows.push({ key, value })
      }
      return rows
    }

    /** One quota figure. The price is money per month; every cap is money. */
    const quotaValue = (key, value, t) => (key === 'price' ? t.quotaPriceValue(formatDollars(value)) : formatDollars(value))

    /**
     * One size of a tier as a single line: its own label, then every figure the
     * vendor states for it.
     *
     * One line per size is deliberate: Max is sold as 10x and 20x, and a card
     * that rendered only the first would quietly describe a plan the reader may
     * not be on.
     */
    function quotaLine(t, variant) {
      const parts = [String(variant?.label ?? '')]
      for (const row of tierQuotaRows(variant)) parts.push(`${t[QUOTA_COPY[row.key]]} ${quotaValue(row.key, row.value, t)}`)
      return parts.filter((part) => part.trim() !== '').join(' · ')
    }

    /**
     * What a tier's model count reads as, and whether it is an answer at all.
     *
     * `models` is what the tier admits, `live` how many of those the live model
     * list currently serves. Before any sync has read the catalog both are
     * null, and the card says that instead of printing a zero, which would read
     * as "this tier has no models" rather than "nobody has looked yet".
     */
    function tierModelLine(tier, t) {
      const models = Number.isFinite(tier?.models) ? tier.models : null
      const live = Number.isFinite(tier?.live) ? tier.live : null
      if (models === null) return { unknown: true, text: t.tierModelsUnknown }
      if (live === null) return { unknown: false, text: t.models(models) }
      return { unknown: false, text: t.tierModels(models, live) }
    }

    /**
     * The generated routes that belong to another tier, as rows.
     *
     * The host states them in `describe.stale`; the card adds the tier's human
     * title, because a row reading `commandcode-pro-autosync` beside the bare
     * word `pro` still makes the reader do the mapping themselves.
     */
    function staleRoutes(stale) {
      if (!Array.isArray(stale)) return []
      return stale
        .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.key === 'string' && entry.key !== '')
        .map((entry) => ({
          key: entry.key,
          plan: String(entry.plan ?? ''),
          slot: String(entry.slot ?? ''),
          models: Number.isFinite(entry.models) ? entry.models : null,
          title: planTitle(entry.plan),
        }))
    }

    /** The tier the account's own subscription maps to, or null when it is unknown. */
    const subscriptionPlan = (subscription) => (typeof subscription?.plan === 'string' && subscription.plan !== '' ? subscription.plan : null)
    /** Which subscription the host reported: the organization's or the personal one. */
    const subscriptionSource = (subscription) => (subscription?.source === 'organization' ? 'organization' : subscription?.source === 'personal' ? 'personal' : null)

    /**
     * The account's own plan as a header tag, e.g. `GOAT（组织）`.
     *
     * Which subscription it is belongs in the tag: an organization seat and a
     * personal one are the same tier name over different billing, and a reader
     * who cannot tell them apart cannot tell which one the card is describing.
     * Null when no subscription was read, so the header stays silent rather
     * than claiming "unknown".
     */
    function subscriptionTagText(subscription, t) {
      if (subscription === null || subscription === undefined || typeof subscription !== 'object') return null
      const title = String(subscription.title ?? '').trim() !== '' ? subscription.title : planTitle(subscription.plan)
      if (title === undefined || title === null || String(title) === '') return null
      const source = subscriptionSource(subscription)
      if (source === 'organization') return t.subscriptionOrganization(title)
      if (source === 'personal') return t.subscriptionPersonal(title)
      // No source: state the name the host read without claiming which
      // subscription it belongs to, because those are different billings.
      return String(title)
    }

    /**
     * The tier the account says it is on when that is not the tier in use.
     *
     * This is the one state the card exists to explain: the account's
     * subscription is what it is, the config says another tier, and nothing is
     * broken. The reader just has to be told which two facts disagree.
     */
    function subscriptionMismatch(subscription, plan) {
      const subscribed = subscriptionPlan(subscription)
      return subscribed === null || subscribed === plan ? null : subscribed
    }

    /** The provider name the configured tier's routes carry. */
    function providerName(status, plan) {
      const tier = tierList(status).find((entry) => entry.plan === plan)
      if (typeof tier?.provider === 'string' && tier.provider !== '') return tier.provider
      // A host that states no tiers still names the route it wrote the models
      // to, and that name is what Settings → Models shows the reader.
      const routeName = status?.targets?.openai?.displayName
      if (typeof routeName === 'string' && routeName !== '') return routeName
      // Neither: the naming rule this module already mirrors, so the card never
      // prints a bare key as its title.
      return providerDisplayName(plan, 'openai')
    }

    // ── field specs ─────────────────────────────────────────────────────────
    /** Text-shaped fields, in card order. `kind` drives how a save writes them. */
    const TEXT_FIELDS = [
      // `copy` names the dictionary entry; it differs from the field name
      // wherever the two would not read the same (`targetApiKeyEnv` is
      // labelled by `apiKeyEnv`). Falling through to the field name would
      // render the raw key on screen.
      { key: 'targetApiKeyEnv', kind: 'text', copy: 'apiKeyEnv', fallback: DEFAULT_API_KEY_ENV },
      { key: 'sourceURL', kind: 'text', fallback: DEFAULT_SOURCE_URL },
      { key: 'catalogURL', kind: 'text', fallback: DEFAULT_CATALOG_URL },
      { key: 'targetBaseURL', kind: 'text', fallback: DEFAULT_BASE_URL },
      { key: 'usageBaseURL', kind: 'text', fallback: DEFAULT_ALPHA_BASE_URL },
      { key: 'extraIds', kind: 'list' },
    ]
    /** Boolean fields, in card order. */
    const BOOL_FIELDS = ['webSearch', 'autoSync', 'includeReasoningEfforts', 'enableUsageTool']
    /** The dictionary entry each boolean field is labelled by. */
    const BOOL_COPY = {
      webSearch: 'search',
      autoSync: 'autoSync',
      includeReasoningEfforts: 'includeReasoningEfforts',
      enableUsageTool: 'usageTool',
    }
    /** Fields the draft tracks for the override badge. */
    const DRAFT_KEYS = ['plan', 'autoSyncIntervalMs', ...BOOL_FIELDS, ...TEXT_FIELDS.map((spec) => spec.key)]

    /** Parse an extra-ids draft into the array the host schema accepts. */
    function parseIds(text) {
      return String(text ?? '')
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter((item) => item !== '')
    }

    /** Structural comparison for the list-valued field. */
    const sameList = (left, right) => left.length === right.length && left.every((item, index) => item === right[index])

    // ── components ──────────────────────────────────────────────────────────
    /** One labelled field: its control, an override badge and that badge's reset. */
    function Row(props) {
      return h('div', { className: 'ccg-field' },
        h('span', { className: 'ccg-fieldLabel' }, props.label),
        h('div', { className: 'ccg-fieldControl' },
          props.children,
          props.overridden === true ? h(Tag, null, props.t.overridden) : null,
          props.overridden === true
            ? h(Button, { size: 'sm', onClick: props.onReset }, props.t.reset)
            : null))
    }

    /**
     * The plugin's own mark: a terminal prompt — a chevron and a caret — drawn
     * here from two strokes rather than borrowed from the vendor, so it is
     * unambiguously this project's to license while still reading as "command
     * line" at the 18px the header renders it at. The tile behind it comes from
     * the header, which supplies the colour.
     */
    function CommandCodeMark(props) {
      const size = props?.size ?? 18
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('path', { d: 'M6 7.5 10.5 12 6 16.5' }),
      h('path', { d: 'M12.5 16.5H18' }))
    }

    /**
     * One quota line: its label, the share consumed, a bar, and — for a rolling
     * window — when it resets.
     *
     * The percentage leads because the share is the question a quota answers;
     * the absolute figures stay beside it in smaller type so the number can be
     * checked rather than taken on trust.
     */
    /**
     * A folded section: a left-aligned title row that opens its content.
     *
     * Drawn from plain elements rather than the shell's Button, three of whose
     * own styles fight this use — it stretches to the row, centres its label,
     * and paints a background, so a folded section read as a centred call to
     * action. A disclosure header is a heading; it should look like the title
     * row inside the boxes above it, which is what this reproduces.
     */
    function Disclosure(props) {
      const open = props.open === true
      return h('section', { className: 'ccg-section' },
        h('button', {
          type: 'button',
          className: 'ccg-disclosure',
          'aria-expanded': open,
          onClick: props.onToggle,
        },
        h('span', { className: 'ccg-disclosureMark', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
        h('span', null, props.title)),
        open ? props.children : null)
    }

    function MeterRow(props) {
      const percent = props.percent
      return h('div', { className: 'ccg-meter' },
        h('div', { className: 'ccg-meterHead' },
          h('span', { className: 'ccg-meterLabel' }, props.label),
          h('span', { className: 'ccg-percent' }, formatPercent(percent)),
          props.exceeded === true ? h(Tag, { tone: 'danger' }, props.t.usageExceeded) : null,
          props.resetText === undefined ? null : h('span', { className: 'ccg-muted' }, props.resetText)),
        props.detail === undefined ? null : h('span', { className: 'ccg-meterDetail' }, props.detail),
        h('div', { className: 'ccg-bar' },
          h('div', {
            className: `ccg-barFill${percent >= 100 ? ' ccg-barFull' : ''}`,
            style: { width: `${percent}%` },
          })))
    }

    /** The account panel: identity, plan, windows, credits and period totals. */
    function UsagePanel(props) {
      const t = props.t
      const usage = props.usage
      const report = usage.report
      const busy = usage.phase === 'loading'
      /**
       * One figure. The optional third line exists because a bare `a / b` makes
       * the reader guess what `b` is — an input/output split, a share of a
       * total, or two unrelated numbers. Every ratio on this panel names both
       * of its halves.
       */
      const metric = (label, value, detail) => h('div', { className: 'ccg-metric' },
        h('span', { className: 'ccg-metricLabel' }, label),
        h('span', { className: 'ccg-metricValue' }, value),
        detail === undefined ? null : h('span', { className: 'ccg-metricDetail' }, detail))
      /**
       * The monthly pool as a quota. The service states it as a *remaining*
       * balance beside the amount spent this period, never as a total, so the
       * denominator is the two added together.
       */
      const monthlyLeft = report?.credits?.monthlyCredits ?? 0
      const monthlyUsed = report?.usage?.totalMonthlyCredits ?? report?.usage?.totalCredits ?? 0
      const monthly = report?.credits === undefined
        ? undefined
        : { left: monthlyLeft, used: monthlyUsed, percent: percentValue(monthlyUsed, monthlyLeft + monthlyUsed) }
      /**
       * Whether any rolling window is on screen, so its note has something to
       * explain. The note is here because these windows open on the first
       * request after the previous one elapsed rather than on a fixed clock: a
       * countdown that starts when someone begins working is the documented
       * behaviour, and without the line it reads as a plugin that resets the
       * quota by itself.
       */
      const windowCount = [report?.credits?.fiveHour, report?.credits?.weekly]
        .filter((window) => window !== undefined && window.cap > 0).length
      /** A rolling window as a quota line, or nothing when it states no cap. */
      const windowMeter = (window, label) => {
        if (window === undefined || !(window.cap > 0)) return null
        const remaining = secondsUntil(window.resetAt)
        return h(MeterRow, {
          key: label,
          label,
          percent: percentOf(window),
          detail: t.usageWindowDetail(formatDollars(window.used), formatDollars(window.cap)),
          exceeded: window.exceeded === true,
          resetText: remaining === undefined ? undefined : t.usageResets(formatDuration(remaining)),
          t,
        })
      }
      return h('section', { className: 'ccg-card' },
        h('div', { className: 'ccg-cardHead' },
          h('h4', { className: 'ccg-cardTitle' }, t.usage),
          h('span', { className: 'ccg-spacer' }),
          h(Button, {
            variant: 'outline',
            size: 'sm',
            icon: IconRefresh === undefined ? null : h(IconRefresh, null),
            disabled: busy,
            onClick: props.onRefresh,
          }, busy ? t.usageLoading : t.usageRefresh)),
        usage.error === undefined || usage.error === null
          ? null
          : h('p', { className: 'ccg-error' }, `${t.usageFailed}: ${usage.error}`),
        report === undefined
          ? (busy ? null : h('p', { className: 'ccg-hint' }, t.usageEmpty))
          : h('div', { className: 'ccg-cardBody' },
            h('div', { className: 'ccg-row' },
              h('span', { className: 'ccg-strong' },
                report.account?.userName || report.account?.name || report.account?.id || ''),
              report.plan === undefined ? null : h(Tag, { tone: 'info' }, `${t.usagePlan} ${report.plan.name}`)),
            // The two rolling windows bracket the near term, so they lead; the
            // monthly pool is the slowest-moving number and reads last.
            windowMeter(report.credits?.fiveHour, t.usageFiveHour),
            windowMeter(report.credits?.weekly, t.usageWeekly),
            windowCount > 0 ? h('p', { className: 'ccg-hint' }, t.usageWindowNote) : null,
            monthly === undefined
              ? null
              : h(MeterRow, {
                label: t.usageCreditsMonthly,
                percent: monthly.percent,
                detail: t.usageMonthlyDetail(formatDollars(monthly.left), formatDollars(monthly.used)),
                t,
              }),
            h('div', { className: 'ccg-metrics' },
              report.credits === undefined || !(report.credits.purchasedCredits > 0)
                ? null
                : metric(t.usageCreditsPurchased, formatDollars(report.credits.purchasedCredits)),
              report.credits === undefined || !(report.credits.freeCredits > 0)
                ? null
                : metric(t.usageCreditsFree, formatDollars(report.credits.freeCredits)),
              report.usage === undefined
                ? null
                : metric(
                  t.usageRequests,
                  formatCount(report.usage.totalCount),
                  report.usage.failedCount > 0 ? t.usageFailed(report.usage.failedCount) : undefined,
                ),
              report.usage === undefined ? null : metric(t.usageCost, formatMoney(report.usage.totalCost)),
              report.usage === undefined
                ? null
                : metric(
                  t.usageTokens,
                  // A host older than this field reports only the halves, and
                  // "0" beside a real split would be worse than either.
                  formatCount(
                    Number.isFinite(report.usage.totalTokens)
                      ? report.usage.totalTokens
                      : (report.usage.totalTokensIn ?? 0) + (report.usage.totalTokensOut ?? 0),
                  ),
                  t.usageTokenSplit(formatCount(report.usage.totalTokensIn), formatCount(report.usage.totalTokensOut)),
                )),
            Array.isArray(report.failures) && report.failures.length > 0
              ? h('p', { className: 'ccg-hint' }, report.failures.join(' · '))
              : null,
            report.raw === undefined
              ? null
              : h('details', null,
                h('summary', { className: 'ccg-muted' }, t.usageRaw),
                h('pre', { className: 'ccg-pre' }, JSON.stringify(report.raw, null, 2)))))
    }

    /** The full page behind one Plugins-page card. */
    function CommandCodeCard(props) {
      const t = props.t
      const state = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
      const [advanced, setAdvanced] = React.useState(false)
      const [providersOpen, setProvidersOpen] = React.useState(false)
      /**
       * Which protocol's panel the merged provider card shows. Null means "the
       * first tab the host described", so a describe that renames its slots
       * still opens on a real one rather than on a slot that is gone.
       */
      const [providerTab, setProviderTab] = React.useState(null)
      const status = state.status
      const fields = state.fields
      const actions = props.actions
      const saving = state.phase === 'saving'
      const running = state.sync.phase === 'running'
      const syncResult = state.sync.result
      /**
       * Everything the tier has produced, as one number. This is the question
       * the card exists to answer, and for most readers the only thing worth
       * knowing about the generated providers — their names and per-route
       * states live behind a disclosure further down.
       */
      const modelsFound = Object.values(status?.targets ?? {})
        .filter((target) => target.created)
        .reduce((total, target) => total + target.models, 0)

      const textRow = (spec) => h(Row, {
        key: spec.key,
        label: t[spec.copy ?? spec.key],
        t,
        overridden: state.overrides[spec.key] === true,
        onReset: () => actions.reset(spec.key),
      }, h(Input, {
        value: fields[spec.key] ?? '',
        placeholder: spec.fallback ?? '',
        onChange: (event) => actions.edit(spec.key, event.target.value),
      }))

      /**
       * One switch: its dictionary entry, the sentence explaining it, and the
       * control. The field name and the copy key differ wherever they would not
       * read the same (`webSearch` is labelled by `search`), so the mapping
       * decides both the label and which hint belongs underneath.
       */
      const toggle = (key) => {
        const copy = BOOL_COPY[key] ?? key
        return h('div', { className: 'ccg-switch', key },
          h('div', { className: 'ccg-switchText' },
            h('span', { className: 'ccg-switchTitle' }, t[copy]),
            h('p', { className: 'ccg-hint' }, t[`${copy}Hint`] ?? '')),
          h(Switch, {
            checked: fields[key] === true,
            label: t[copy],
            disabled: saving,
            onChange: (next) => actions.edit(key, next),
          }))
      }

      /** A failure the reader can act on, in the one place the card keeps them. */
      const problem = (text) => h('div', { className: 'ccg-notice' },
        IconWarning === undefined ? null : h(IconWarning, { size: 16 }),
        h('p', { className: 'ccg-error' }, text))

      /** What the last sync did, when there was one. */
      const syncSummary = () => {
        if (syncResult === undefined) return null
        return h('div', { className: 'ccg-cardBody' },
          h('div', { className: 'ccg-row' },
            h(Tag, { tone: 'info' }, syncResult.dryRun === true ? t.syncDryRun : t.syncDone),
            h('span', { className: 'ccg-muted' }, t.syncResult(syncResult.live ?? 0, syncResult.plan ?? fields.plan)),
          ),
          Array.isArray(syncResult.skipped) && syncResult.skipped.length > 0
            ? h('p', { className: 'ccg-hint' }, t.syncSkipped(syncResult.skipped.join(', ')))
            : null,
          Array.isArray(syncResult.diagnostics) && syncResult.diagnostics.length > 0
            ? syncResult.diagnostics.map((line, index) => h('p', { key: index, className: 'ccg-hint' }, line))
            : null,
        )
      }

      /** The account's own plan as the host read it, or null when it could not. */
      const subscription = status?.subscription ?? null
      const subscriptionTag = subscriptionTagText(subscription, t)
      /**
       * The tier the account's subscription maps to but the config is not using.
       *
       * This is the one mismatch a reader cannot see coming: they bought a
       * subscription, installed the plugin, and the card says the account is on
       * GOAT while the plugin writes Pro. Naming both here is the whole fix.
       */
      const subscribedPlan = subscriptionMismatch(subscription, fields.plan)
      const subscribedTier = subscribedPlan === null ? undefined : tierList(status).find((tier) => tier.plan === subscribedPlan)

      /**
       * The tab strip of the merged provider card.
       *
       * Arrow keys are part of what `role="tab"` promises a keyboard user, so
       * they move the selection rather than only the pointer.
       */
      const tabStrip = (tabs, active) => {
        const move = (event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
          const step = event.key === 'ArrowRight' ? 1 : -1
          const index = tabs.findIndex((tab) => tab.slot === active.slot)
          setProviderTab(tabs[(index + step + tabs.length) % tabs.length].slot)
        }
        return h('div', { className: 'ccg-tabs', role: 'tablist', 'aria-label': t.targetTabs },
          tabs.map((tab) => h('button', {
            key: tab.slot,
            type: 'button',
            role: 'tab',
            id: `ccg-tab-${tab.slot}`,
            className: `ccg-tab${tab.slot === active.slot ? ' ccg-tabActive' : ''}`,
            'aria-selected': tab.slot === active.slot,
            // Only the selected tab stays in the tab order, which is what a
            // tablist is: Tab leaves the strip, the arrows move inside it.
            tabIndex: tab.slot === active.slot ? 0 : -1,
            onClick: () => setProviderTab(tab.slot),
            onKeyDown: move,
          }, tab.label)))
      }

      /** One slot: the key it is written to, its protocol, and where its key lives. */
      const tabPanel = (tab) => {
        const target = tab.target ?? {}
        const created = target.created === true
        const key = typeof target.key === 'string' && target.key !== '' ? target.key : providerKey(fields.plan, tab.slot)
        const api = typeof target.api === 'string' ? target.api : ''
        return h('div', { className: 'ccg-tabPanel', role: 'tabpanel', 'aria-labelledby': `ccg-tab-${tab.slot}` },
          h('div', { className: 'ccg-row' },
            h('span', { className: 'ccg-mono' }, key),
            h('span', { className: 'ccg-spacer' }),
            created ? h(Tag, { tone: 'info' }, t.created) : h(Tag, null, t.missing)),
          // A route that was never created states no protocol: the host writes
          // that field when it writes the route, and naming one here would
          // describe a route the host has not decided about.
          api === ''
            ? null
            : h('div', { className: 'ccg-row' },
              h('span', { className: 'ccg-muted' }, t.protocol),
              h('span', { className: 'ccg-mono' }, api)),
          created ? h('span', { className: 'ccg-muted' }, t.models(Number.isFinite(target.models) ? target.models : 0)) : null,
          h('p', { className: 'ccg-hint' }, t.keyWhere),
          status.hasKey === true
            ? h('p', { className: 'ccg-hint' }, t.keyWhereEnv(status.apiKeyEnv ?? DEFAULT_API_KEY_ENV))
            : null)
      }

      /**
       * The generated providers: one card, one tab per route slot.
       *
       * The section used to render a row per slot, so a single subscription
       * read as two providers whose keys differed by a suffix, and the reader
       * had to work out that `commandcode-goat-autosync` and
       * `commandcode-goat-anthropic` are one tier over two protocols. The name
       * is stated once here and the protocol, which is the only thing that
       * actually differs, is the tab.
       */
      const providerCard = () => {
        const tabs = providerTabs(status.targets)
        const active = tabs.find((tab) => tab.slot === providerTab) ?? tabs[0]
        return h('div', { className: 'ccg-provider' },
          h('div', { className: 'ccg-providerHead' },
            h('span', { className: 'ccg-providerName' }, providerName(status, fields.plan))),
          tabStrip(tabs, active),
          tabPanel(active))
      }

      /**
       * The routes another tier left behind.
       *
       * These are the ghosts of a tier switch: the host writes the new tier's
       * routes and leaves the old ones in llm-pi-ai, where they keep showing up
       * in Settings → Models beside the live ones. One muted line when there are
       * none, because the absence answers the same question.
       */
      const staleBlock = () => {
        const rows = staleRoutes(status.stale)
        const removed = state.prune.result?.removed
        return h('div', { className: 'ccg-section' },
          rows.length === 0
            ? h('p', { className: 'ccg-muted' }, t.staleEmpty)
            : h('div', { className: 'ccg-stale' },
              h('div', { className: 'ccg-row' },
                h('span', { className: 'ccg-staleTitle' }, t.stale),
                h('span', { className: 'ccg-spacer' }),
                h(Button, {
                  variant: 'outline',
                  size: 'sm',
                  disabled: state.prune.phase === 'running',
                  onClick: () => actions.prune(),
                }, state.prune.phase === 'running' ? t.pruning : t.prune)),
              h('p', { className: 'ccg-hint' }, t.staleHint),
              rows.map((row) => h('div', { key: row.key, className: 'ccg-staleRow' },
                h('span', { className: 'ccg-mono' }, row.key),
                h(Tag, null, t.staleTier(row.title)),
                row.models === null ? null : h('span', { className: 'ccg-muted' }, t.models(row.models))))),
          // The result outlives the list it describes: a prune that emptied
          // `stale` still has to say what it removed.
          Array.isArray(removed) ? h('p', { className: 'ccg-hint' }, t.pruneResult(removed.length)) : null)
      }

      /**
       * One tier, as a card.
       *
       * Its body carries no click handler on purpose: the plan pills above are
       * the control that stages a tier, and a card that switched the tier when
       * clicked would make the figures it prints the trigger for changing them.
       * The button is the one switch, and it belongs to the tier it names.
       */
      const tierCard = (tier) => {
        const selected = tier.selected === true
        const subscribed = tier.subscribed === true
        const models = tierModelLine(tier, t)
        // A host that states an empty string stated nothing; the card would
        // otherwise render a blank heading where the tier's name belongs.
        const title = typeof tier.title === 'string' && tier.title !== '' ? tier.title : planTitle(tier.plan)
        const provider = typeof tier.provider === 'string' && tier.provider !== ''
          ? tier.provider
          : providerDisplayName(tier.plan, 'openai')
        return h('div', { key: tier.plan, className: `ccg-tier${selected ? ' ccg-tierSelected' : ''}` },
          h('div', { className: 'ccg-tierHead' },
            h('span', { className: 'ccg-tierTitle' }, title),
            h('span', { className: 'ccg-muted' }, provider),
            h('span', { className: 'ccg-spacer' }),
            selected ? h(Tag, { tone: 'info' }, t.tierSelected) : null,
            subscribed
              ? h(Tag, null, tier.source === 'organization'
                ? t.subscribedOrganization
                : tier.source === 'personal'
                  ? t.subscribedPersonal
                  : t.subscribedUnknown)
              : null),
          h('p', { className: models.unknown ? 'ccg-muted' : 'ccg-hint' }, models.text),
          tierVariants(tier).map((variant, index) => h('p', {
            key: variant.label ?? index,
            className: 'ccg-quota',
          }, quotaLine(t, variant))),
          h('div', { className: 'ccg-tierFoot' },
            typeof tier.docURL === 'string' && tier.docURL !== ''
              ? h('a', { className: 'ccg-link', href: tier.docURL, target: '_blank', rel: 'noreferrer' }, t.tierDoc)
              : null,
            h('span', { className: 'ccg-spacer' }),
            tier.plan === fields.plan
              ? null
              // The subscribed tier is the one the account already pays for, so
              // its button says which fix it is.
              : h(Button, {
                size: 'sm',
                variant: subscribed ? 'primary' : 'outline',
                onClick: () => actions.edit('plan', tier.plan),
              }, subscribed ? t.tierSwitchSubscribed : t.tierSwitch)))
      }

      /** Every tier the host described, in its own order, cheapest first. */
      const tierCards = () => {
        const tiers = tierList(status)
        if (tiers.length === 0) return null
        return h('div', { className: 'ccg-tiers' },
          h('span', { className: 'ccg-cardTitle' }, t.tierCards),
          tiers.map(tierCard))
      }

      /**
       * The selected tier, restated where its routes are listed.
       *
       * The options section compares all four; this is the one they narrow down
       * to, printed beside the keys it produced so the reader sees what the
       * mounted routes actually grant. Only the selected tier appears here — the
       * other three are what the section above is for, and printing them twice
       * is the duplication this card exists to remove.
       */
      const selectedTierBlock = () => {
        const tier = tierList(status).find((entry) => entry.plan === fields.plan)
        return tier === undefined ? null : h('div', { className: 'ccg-tiers' }, tierCard(tier))
      }

      return h('div', { className: 'ccg-root' },
        h('header', { className: 'ccg-head' },
          h('span', { className: 'ccg-headIcon' }, h(CommandCodeMark, { size: 18 })),
          h('div', { className: 'ccg-headText' },
            h('h3', { className: 'ccg-headTitle' }, t.title),
            h('p', { className: 'ccg-headIntro' }, t.intro)),
          h('div', { className: 'ccg-headTags' },
            // The account's own plan belongs beside the build number: it is
            // what the reader believes they are paying for, and the tier the
            // plugin writes is stated in the section below.
            subscriptionTag === null ? null : h(Tag, null, subscriptionTag),
            h('span', { className: 'ccg-muted' }, `v${status?.version ?? '?'}`))),

        // The one line worth reading: what the tier produced, and whether its
        // key is there. Everything else about the generated providers is
        // detail, and detail lives behind the disclosure below.
        h('div', { className: 'ccg-row' },
          modelsFound > 0
            ? h('span', { className: 'ccg-status' },
              IconCheck === undefined ? null : h(IconCheck, { size: 14 }),
              t.modelsReady(modelsFound))
            : h(Tag, null, t.summaryPending),
          status === undefined || status === null
            ? null
            : status.hasKey === true
              ? h(Tag, null, status.keySource === 'environment' ? t.keyReadyEnv : t.keyReady)
              : h(Tag, { tone: 'danger' }, t.keyMissing),
          status?.writable === false ? h(Tag, { tone: 'danger' }, t.settingsUnavailable) : null),

        // The account and the config disagreeing is not an error, so it is a
        // notice rather than a problem: nothing is broken, the reader is just
        // pointed at the wrong tier. It carries the switch itself, because the
        // next thing they will want is to be on the tier they pay for.
        subscribedPlan === null
          ? null
          : h('div', { className: 'ccg-notice' },
            h('p', { className: 'ccg-noticeText' },
              t.subscriptionNotice(planTitle(subscribedPlan), planTitle(fields.plan))),
            subscribedTier === undefined
              ? null
              : h('span', { className: 'ccg-noticeAction' },
                h(Button, {
                  size: 'sm',
                  variant: 'outline',
                  onClick: () => actions.edit('plan', subscribedPlan),
                }, t.tierSwitchSubscribed))),

        // The explanation for a missing key stays in the open: it is the one
        // detail a reader needs while something is actually wrong, and the
        // disclosure further down is exactly where they would not look.
        status !== undefined && status !== null && status.hasKey !== true
          ? h('p', { className: 'ccg-hint' }, t.keyMissingHint(status.apiKeyEnv ?? DEFAULT_API_KEY_ENV))
          : null,

        // A card newer than the process serving it is a real and confusing
        // state: the client half is re-read from disk on every page load, the
        // host half only at boot. Say so instead of letting the reader conclude
        // that a fix did nothing.
        status !== undefined && status !== null && status.version === undefined ? problem(t.hostStale) : null,
        state.error === undefined || state.error === null ? null : problem(`${t.error}: ${state.error}`),
        state.sync.error === undefined || state.sync.error === null ? null : problem(`${t.error}: ${state.sync.error}`),
        state.prune.error === undefined || state.prune.error === null ? null : problem(`${t.error}: ${state.prune.error}`),

        // ── tier and the two actions that act on it ────────────────────────
        h('section', { className: 'ccg-card' },
          h('div', { className: 'ccg-cardHead' },
            h('h4', { className: 'ccg-cardTitle' }, t.plan),
            state.overrides.plan === true ? h(Tag, null, t.overridden) : null,
            h('span', { className: 'ccg-spacer' }),
            state.phase === 'saved' ? h('span', { className: 'ccg-ok' }, t.saved) : null,
            h(Button, { variant: 'outline', size: 'sm', disabled: running, onClick: () => actions.reload() }, t.refresh),
            h(Button, {
              variant: 'primary',
              size: 'sm',
              disabled: running,
              icon: IconRefresh === undefined ? null : h(IconRefresh, null),
              onClick: () => actions.sync(),
            }, running ? t.syncing : t.sync)),
          h('div', { className: 'ccg-cardBody' },
            h('div', { className: 'ccg-pills' },
              PLANS.map((plan) => h(Pill, {
                key: plan.value,
                active: fields.plan === plan.value,
                onClick: () => actions.edit('plan', plan.value),
              }, plan.title))),
            h('p', { className: 'ccg-hint' }, t.planHint),
            syncSummary(),
          ),
        ),

        h(UsagePanel, { t, usage: state.usage, onRefresh: () => actions.refreshUsage() }),

        // ── the switches ───────────────────────────────────────────────────
        h('section', { className: 'ccg-card' },
          h('div', { className: 'ccg-cardHead' }, h('h4', { className: 'ccg-cardTitle' }, t.options)),
          h('div', { className: 'ccg-cardBody' },
            toggle('webSearch'),
            toggle('autoSync'),
            fields.autoSync === true
              ? h('div', { className: 'ccg-field' },
                h('span', { className: 'ccg-fieldLabel' }, t.autoSyncInterval),
                h('div', { className: 'ccg-fieldControl' },
                  h('select', {
                    className: 'ccg-select',
                    value: String(fields.autoSyncIntervalMs),
                    onChange: (event) => actions.edit('autoSyncIntervalMs', Number(event.target.value)),
                  }, AUTO_SYNC_CHOICES.map((choice) => h('option', { key: choice.value, value: String(choice.value) }, choice.title)))))
              : null,
            toggle('includeReasoningEfforts'),
            toggle('enableUsageTool'),
            tierCards())),

        // ── the generated providers, folded away ───────────────────────────
        // Their names are only interesting when something is wrong with them;
        // the line under the header already answers "did it work". What is left
        // here is the selected tier's own figures, whatever another tier left
        // behind, and the one merged provider card.
        h(Disclosure, { title: t.targets, open: providersOpen, onToggle: () => setProvidersOpen(!providersOpen) },
          h('div', { className: 'ccg-card' },
            h('div', { className: 'ccg-cardBody' },
              status === undefined || status === null
                ? h('p', { className: 'ccg-hint' }, state.statusError ?? t.summaryPending)
                : selectedTierBlock(),
              status === undefined || status === null ? null : staleBlock(),
              status === undefined || status === null ? null : providerCard()))),

        h(Disclosure, { title: t.advanced, open: advanced, onToggle: () => setAdvanced(!advanced) },
          h('div', { className: 'ccg-card' },
            h('div', { className: 'ccg-cardBody' },
              h('div', { className: 'ccg-fields' }, TEXT_FIELDS.map(textRow)),
              h('p', { className: 'ccg-hint' }, t.extraIdsHint),
              h('p', { className: 'ccg-muted' }, `dsh-commandcode-goat v${status?.version ?? '?'}`)))),

        state.dirty === true
          ? h('div', { className: 'ccg-foot' },
            h(Button, { variant: 'primary', size: 'sm', disabled: saving, onClick: () => actions.save() },
              saving ? t.saving : t.save),
            h(Button, { variant: 'outline', size: 'sm', onClick: () => actions.reload() }, t.discard))
          : null)
    }

    /** The one-liner the Plugins page shows under the card title. */
    function CommandCodeSummary(props) {
      const t = props.t
      const state = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
      const status = state.status
      const planValue = status?.plan ?? state.fields.plan
      const plan = PLANS.find((entry) => entry.value === planValue)?.title ?? planValue
      const created = status === undefined || status === null
        ? []
        : Object.values(status.targets ?? {}).filter((target) => target.created)
      if (created.length === 0) return h('span', { className: 'ccg-summary' }, t.summaryPending)
      const models = created.reduce((total, target) => total + target.models, 0)
      return h('span', { className: 'ccg-summary' }, t.summaryReady(plan, models))
    }

    // ── controller ──────────────────────────────────────────────────────────
    /**
     * Owns the card's staged draft, the writes it makes through the client
     * settings scope, and the host data it mirrors.
     */
    function createController(ctx, dictionary) {
      /**
       * The form for this plugin's own entry, and the entry id it is bound to.
       *
       * `configForms.get(id)` returns the shared form for a host plugin entry,
       * keyed by that entry's row id. The id is the profile's to choose, so the
       * card starts from the one its patch declares and rebinds when the host
       * reports a different one.
       */
      let entryId = NS
      let scope = ctx.configForms?.get(entryId)
      let unsubscribeScope
      const bind = (id) => {
        if (typeof id !== 'string' || id === '' || id === entryId) return
        unsubscribeScope?.()
        entryId = id
        scope = ctx.configForms?.get(id)
        if (scope?.subscribe) unsubscribeScope = scope.subscribe(() => sync())
        sync()
      }
      const store = createStore({
        fields: {
          plan: 'goat',
          webSearch: false,
          autoSync: true,
          autoSyncIntervalMs: 6 * 60 * 60 * 1000,
          includeReasoningEfforts: false,
          enableUsageTool: true,
        },
        overrides: {},
        dirty: false,
        phase: 'idle',
        error: null,
        status: null,
        statusError: null,
        sync: { phase: 'idle', result: undefined, error: null },
        prune: { phase: 'idle', result: undefined, error: null },
        usage: { phase: 'idle', report: undefined, error: null },
      })

      /**
       * What a save would do for one field: nothing, a write, or a clear.
       *
       * Comparing against the *resolved* value rather than the user layer is
       * what keeps a save from writing an override that states what the
       * composition already said — and clearing an emptied text field back to
       * the layer below, rather than storing an empty string that means
       * something else to the host.
       */
      const planFor = (key, staged) => {
        const snapshot = scope?.getSnapshot()
        const resolved = snapshot?.value?.[key]
        const user = snapshot?.user
        const overridden = user !== undefined && Object.hasOwn(user, key)
        const spec = TEXT_FIELDS.find((field) => field.key === key)

        if (BOOL_FIELDS.includes(key)) {
          return staged === (resolved === true) ? undefined : { write: 'set', value: staged === true }
        }
        if (spec === undefined) {
          return staged === resolved ? undefined : { write: 'set', value: staged }
        }
        if (spec.kind === 'list') {
          const list = parseIds(staged)
          if (list.length === 0) return overridden ? { write: 'unset' } : undefined
          return sameList(list, Array.isArray(resolved) ? resolved : []) ? undefined : { write: 'set', value: list }
        }
        const text = String(staged ?? '').trim()
        if (text === '') return overridden ? { write: 'unset' } : undefined
        return text === resolved ? undefined : { write: 'set', value: text }
      }

      /** Pull the resolved section back into the staged draft. */
      const sync = () => {
        if (!scope || typeof scope.getSnapshot !== 'function') return
        const snapshot = scope.getSnapshot()
        const value = snapshot?.value ?? {}
        const user = snapshot?.user ?? {}
        const fields = {
          plan: value.plan ?? 'goat',
          webSearch: value.webSearch === true,
          // Absent means "on", matching the host's schema default: the plugin
          // exists to make the subscription selectable, and a route that is
          // never created is a plugin that looks like it did nothing.
          autoSync: value.autoSync !== false,
          autoSyncIntervalMs: value.autoSyncIntervalMs ?? 6 * 60 * 60 * 1000,
          includeReasoningEfforts: value.includeReasoningEfforts === true,
          enableUsageTool: value.enableUsageTool !== false,
        }
        for (const spec of TEXT_FIELDS) {
          fields[spec.key] = spec.kind === 'list'
            ? (Array.isArray(value[spec.key]) ? value[spec.key].join(', ') : '')
            : (value[spec.key] ?? '')
        }
        const overrides = {}
        for (const key of DRAFT_KEYS) overrides[key] = Object.hasOwn(user, key)
        store.update({ fields, overrides, dirty: false })
      }

      const edit = (key, next) => {
        const fields = { ...store.getSnapshot().fields, [key]: next }
        store.update({ fields, dirty: true, phase: 'idle', error: null })
      }

      const refreshStatus = async () => {
        try {
          const status = await callBridge('/describe', {})
          store.update({ status, statusError: null })
          // The profile owns the row id, so the form to bind is whatever the
          // host says it composed — not the id this bundle shipped with.
          bind(status?.entryId)
        } catch (error) {
          store.update({ status: null, statusError: error instanceof Error ? error.message : String(error) })
        }
      }

      const save = async () => {
        if (!scope) {
          store.update({ error: dictionary().settingsUnavailable })
          return
        }
        store.update({ phase: 'saving', error: null })
        const staged = store.getSnapshot().fields
        const failures = []
        for (const [key, value] of Object.entries(staged)) {
          const plan = planFor(key, value)
          if (plan === undefined) continue
          try {
            if (plan.write === 'unset') await scope.unset(key)
            else await scope.set(key, plan.value)
          } catch (error) {
            failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        sync()
        await refreshStatus()
        store.update({
          phase: failures.length === 0 ? 'saved' : 'idle',
          error: failures.length === 0 ? null : failures.join('\n'),
        })
      }

      const reset = async (key) => {
        if (!scope) return
        try {
          await scope.unset(key)
          sync()
        } catch (error) {
          store.update({ error: error instanceof Error ? error.message : String(error) })
        }
      }

      const runSync = async (dryRun) => {
        store.update({ sync: { phase: 'running', result: undefined, error: null } })
        try {
          const result = await callBridge('/sync', { dryRun: dryRun === true })
          store.update({ sync: { phase: 'idle', result, error: null } })
          // `refreshUsage` also re-reads the status, so one call after an action
          // leaves every panel describing the same moment.
          await refreshUsage()
        } catch (error) {
          store.update({
            sync: { phase: 'idle', result: undefined, error: error instanceof Error ? error.message : String(error) },
          })
          // A refused sync is exactly when the route list and the key state are
          // worth re-reading, so the card cannot report a stale reason twice.
          await refreshStatus()
        }
      }

      /**
       * Remove the routes another tier left behind.
       *
       * No plan travels with the request: the host removes what its own config
       * calls stale, which is not necessarily what this card has staged and not
       * saved. The status is re-read straight after, because the list that
       * justified the button is the thing that just changed.
       */
      const prune = async () => {
        store.update({ prune: { phase: 'running', result: undefined, error: null } })
        try {
          const result = await callBridge('/prune')
          store.update({ prune: { phase: 'idle', result, error: null } })
        } catch (error) {
          store.update({
            prune: { phase: 'idle', result: undefined, error: error instanceof Error ? error.message : String(error) },
          })
        }
        await refreshStatus()
      }

      const refreshUsage = async () => {
        const previous = store.getSnapshot().usage.report
        store.update({ usage: { phase: 'loading', report: previous, error: null } })
        try {
          store.update({ usage: { phase: 'ready', report: await callBridge('/usage', {}), error: null } })
        } catch (error) {
          store.update({
            usage: { phase: 'error', report: previous, error: error instanceof Error ? error.message : String(error) },
          })
        }
        // Reading the account is also the moment to re-check whether its key
        // resolves: the credential document is loaded and hot-reloaded by the
        // host, so a pill that said "not configured" a moment ago may be stale.
        await refreshStatus()
      }

      if (scope?.subscribe) unsubscribeScope = scope.subscribe(() => sync())
      ctx.effect(() => () => unsubscribeScope?.())
      sync()
      void refreshStatus()
      void refreshUsage()

      /**
       * The windows move on their own, so the panel re-reads them on a cadence
       * rather than only when asked. The tick is skipped while the document is
       * hidden and re-run on the way back, which keeps a backgrounded card from
       * spending requests or showing a countdown that stopped being true.
       */
      ctx.effect(() => {
        const visible = () => typeof document === 'undefined' || document.hidden !== true
        const timer = setInterval(() => {
          if (visible()) void refreshUsage()
        }, USAGE_REFRESH_MS)
        const onVisibilityChange = () => {
          if (visible()) void refreshUsage()
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibilityChange)
        }
        return () => {
          clearInterval(timer)
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibilityChange)
          }
        }
      }, 'dsh-commandcode-goat: usage cadence')

      return { store, actions: { edit, save, reset, reload: sync, sync: runSync, prune, refreshUsage, refreshStatus } }
    }

    // ── registration ────────────────────────────────────────────────────────
    exports.inject = ['slots', 'locale', 'configForms']

    exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-commandcode-goat: dictionaries')
      const bound = ctx.locale.bind(NS)
      /**
       * The active locale's dictionary as an object, resolved fresh on every
       * face read: entries are either finished strings or formatting
       * functions, and the card reads them by name. Resolving here rather than
       * caching means a locale change reaches the next render.
       */
      const dictionary = () => {
        const entries = {}
        for (const key of Object.keys(zh)) {
          const value = bound(key)
          entries[key] = value === undefined || value === null ? key : value
        }
        return entries
      }
      const controller = createController(ctx, dictionary)
      const face = () => ({ store: controller.store, actions: controller.actions, t: dictionary() })

      /**
       * The card is registered into every seat this build offers a plugin, and
       * they are genuinely different surfaces:
       *
       *   - `settings.plugins.tab` — a tab inside **Settings → Plugins**. This
       *     is where someone goes looking for a plugin's configuration, and it
       *     is the seat the first-party plugin inventory uses.
       *   - `plugins.item` — a page in the **Plugins sidebar panel**, listed
       *     beside the shipped official plugins. The panel dispatches it twice
       *     (`view: "summary"` for the card's one-liner, `view: "page"` for the
       *     page behind it), so this entry also has to answer for the summary.
       *   - `plugins.bundle.config` / `plugins.row.config` — the seats the
       *     Plugins panel added for a bundle's *own* configuration, opened from
       *     the bundle's card or from the **配置** control on its row. A card
       *     that registers only the first two is reachable but not where the
       *     panel now looks, which is the difference between a plugin someone
       *     configures and one they conclude did nothing after installing it.
       *
       * Every seat renders the same card from the same controller, so they
       * cannot disagree about state. The non-`page` views — the item card's
       * one-liner, and a row page that falls back to it when the package has no
       * description — get the summary instead, which needs no controls.
       */
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: NS,
        order: 50,
        label: () => bound('tabLabel'),
        locale: NS,
        inject: face,
      }, (props) => h(CommandCodeCard, props)))

      ctx.slots.inject('plugins.item', () => ctx.slots.register({
        name: 'plugins.item',
        id: NS,
        order: 60,
        label: () => bound('title'),
        locale: NS,
        inject: face,
      }, (props) => (props.view === 'page' ? h(CommandCodeCard, props) : h(CommandCodeSummary, props))))

      /**
       * The bundle key is the package name, so this one page covers the whole
       * bundle. It is registered without `id` — the ledger reads `key` here,
       * and an `id` would be a second name for the same page.
       */
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: PACKAGE_NAME,
        order: 60,
        label: () => bound('title'),
        locale: NS,
        inject: face,
      }, (props) => (props.view === 'page' ? h(CommandCodeCard, props) : h(CommandCodeSummary, props))))

      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: ROW_CONFIG_KEY,
        order: 60,
        label: () => bound('title'),
        locale: NS,
        inject: face,
      }, (props) => (props.view === 'page' ? h(CommandCodeCard, props) : h(CommandCodeSummary, props))))
    }

    /** Pure helpers, exposed so the test suite can pin them without React. */
    exports.__internals = {
      parseIds,
      percentOf,
      percentValue,
      formatPercent,
      formatDollars,
      formatDuration,
      formatCount,
      formatMoney,
      sameList,
      providerKey,
      providerDisplayName,
      providerTabs,
      providerName,
      planTitle,
      tierList,
      tierVariants,
      tierQuotaRows,
      quotaLine,
      tierModelLine,
      staleRoutes,
      subscriptionTagText,
      subscriptionMismatch,
      PLANS,
      ROUTE_ORDER,
      ROUTE_LABELS,
      QUOTA_COPY,
      TEXT_FIELDS,
      BOOL_FIELDS,
      BOOL_COPY,
    }
    return module.exports
  },
})
