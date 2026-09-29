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
    /** How long the "saved" confirmation stays up before it stops being news. */
    const SAVED_BADGE_MS = 4_000

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
    /**
     * The interval options, plus the configured value when it is not one of them.
     *
     * The host accepts any interval at or above its one-minute floor, and this
     * card promises that a hand-edited `cordis.yml` still wins. A controlled
     * `<select>` whose value matches no option silently displays the first one,
     * so a profile syncing every fifteen minutes would read as "1h" here.
     */
    function intervalChoices(current) {
      if (AUTO_SYNC_CHOICES.some((choice) => choice.value === current)) {
        return AUTO_SYNC_CHOICES.map((choice) => h('option', { key: choice.value, value: String(choice.value) }, choice.title))
      }
      const title = Number.isFinite(current) ? formatDuration(current / 1000) : String(current)
      return [
        ...AUTO_SYNC_CHOICES.map((choice) => h('option', { key: choice.value, value: String(choice.value) }, choice.title)),
        h('option', { key: 'custom', value: String(current) }, title),
      ]
    }

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
      // Distinct from `usageFailed` above. Two entries under one key is one
      // entry: the later function won, so the sentence that leads a failed read
      // interpolated a *function* and printed its source —
      // "(n) => `失败 ${n}`: …" — over the panel in the commonest first-run
      // state there is, an account with no key yet.
      usageFailedCount: (n) => `失败 ${n}`,
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
      hostOld: (version) => `宿主半侧还是 ${version} 的进程，而这张卡片已经更新：各档位的模型数与默认额度要等宿主也更新后才会出现。请完全退出 DSH Desktop（含托盘）再启动一次。`,
      autoSync: '自动创建与同步',
      autoSyncHint: '启动后自动创建一次，并按所选间隔刷新——装完重启就能在「设置 → 模型」里看到本账户的供应商并填密钥。关掉后只在点「创建 / 更新」时写入。',
      autoSyncInterval: '同步间隔',
      // The sweep is a host field with no other home in the UI: without this
      // switch the only way to stop it deleting the previous tier's routes was
      // to hand-edit the composition.
      pruneOtherPlans: '切档后清理其他档位的路由',
      pruneOtherPlansHint: '切到新档位并同步后，删掉本插件为旧档位生成的路由，免得「设置 → 模型」里留着一条已经用不了的供应商。只删本插件生成的键；带 modelOverrides 的路由会保留并列出。',
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
      pruneKept: (keys) => `保留了 ${keys}：它们带 modelOverrides，是手工改过的，本插件不会覆盖。`,
      error: '错误',
      settingsUnavailable: '当前部署没有提供可写的设置服务。',
      settingsReadOnly: '当前部署的设置是只读的，改动不会保存。',
      writeRefused: '宿主没有接受这次写入。',
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
      // See the zh dictionary: a second entry under `usageFailed` replaced the
      // message with a function and printed its source.
      usageFailedCount: (n) => `${n} failed`,
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
      hostOld: (version) => `The host half is still the ${version} process while this card has already been updated: each tier's model count and default quota can only appear once the host is updated too. Quit DSH Desktop completely (including the tray) and start it again.`,
      autoSync: 'Automatic create & sync',
      autoSyncHint: 'Create the provider on startup and refresh it on the chosen interval, so the row appears in Settings → Models without a click. Turn it off to write only when Create / Update is pressed.',
      autoSyncInterval: 'Interval',
      // The sweep is a host field with no other home in the UI: without this
      // switch the only way to stop it deleting the previous tier's routes was
      // to hand-edit the composition.
      pruneOtherPlans: 'Remove the other tiers\u2019 routes after a switch',
      pruneOtherPlansHint: 'After switching tier and syncing, delete the routes this plugin generated for the old one, so Settings → Models does not keep a provider the account can no longer use. Only keys this plugin generated are touched; a route carrying modelOverrides is kept and listed.',
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
      pruneKept: (keys) => `Kept ${keys}: they declare modelOverrides, which is a hand edit this plugin does not overwrite.`,
      error: 'Error',
      settingsUnavailable: 'This deployment serves no writable settings provider.',
      settingsReadOnly: 'This deployment serves settings read-only, so nothing here would be saved.',
      writeRefused: 'the host did not accept this write',
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
      '.ccg-headIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-brand-primary,inherit)}',
      '.ccg-headText{min-width:0;flex:1 1 auto}',
      '.ccg-headTitle{margin:0;font-size:15px;font-weight:600;line-height:1.3;color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-headIntro{margin:4px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,inherit)}',
      // The same two facts, on the seats where the shell already drew the title:
      // a right-aligned row rather than a second heading. Beside a real header
      // they belong on the title's own line, as they always did.
      '.ccg-headEnd{display:flex;align-items:center;justify-content:flex-end;gap:8px}',
      '.ccg-headInline{flex:none;padding-top:2px}',
      // A tag that carries a leading glyph: the shell's tag is an inline-flex
      // box with no gap of its own, so a check mark would sit flush against the
      // first word without this.
      '.ccg-tagIcon{gap:4px}',
      '.ccg-tagIcon svg{flex:none}',
      // sections
      // One repeated unit for every block: a bordered box whose first row is its
      // own title. The card used to alternate between floating and boxed
      // sections, which is most of why it read as ragged.
      // The surface every block sits on, taken from the shell's own settings
      // card: the same .5px stroke, the same fill, the same corner. A card that
      // invents its own border colour reads as a plugin's panel dropped into
      // the page rather than as one more card in it.
      '.ccg-card{display:flex;flex-direction:column;gap:12px;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,rgba(127,127,127,.22)));border-radius:var(--dsw-radius-xl,20px);background:var(--dsw-alias-settings-card-fill,transparent)}',
      '.ccg-cardHead{display:flex;align-items:center;gap:8px;min-height:22px}',
      '.ccg-cardTitle{margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-section{display:flex;flex-direction:column;gap:10px}',
      // A folded section header is a heading, and it wears the shell's own
      // disclosure chrome: a 16px leading box, a 6px gap, and a 13px title on
      // the secondary label step. The leading glyph is drawn, not typed —
      // `▸`/`▾` are font-dependent and sit on a different baseline in every
      // platform's UI font.
      '.ccg-disclosure{display:flex;align-items:center;gap:6px;width:100%;min-height:24px;padding:0;border:0;background:none;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:13px;font-weight:500;line-height:24px;text-align:left;cursor:pointer}',
      '.ccg-disclosure:hover{color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-disclosure:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4D6BFE));outline-offset:2px;border-radius:var(--dsw-radius-sm,8px)}',
      '.ccg-disclosureMark{flex:0 0 16px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,inherit);transition:transform 120ms ease}',
      '.ccg-disclosureMarkOpen{transform:rotate(90deg)}',
      // rows
      '.ccg-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ccg-spacer{flex:1 1 auto}',
      '.ccg-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-muted{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}',
      '.ccg-strong{font-weight:600}',
      '.ccg-hint{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,inherit)}',
      // Error *text* wears the label token, not the state fill: the shell keeps
      // `--dsw-alias-label-error` for exactly this, and `state-error-primary` is
      // the colour a filled surface or a stroke uses.
      '.ccg-error{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#d9534f));white-space:pre-wrap;overflow-wrap:anywhere}',
      '.ccg-ok{font-size:12px;color:var(--dsw-alias-state-success-primary,#3c9d5c)}',
      '.ccg-notice{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08))}',
      '.ccg-notice > svg{flex:none;color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary,inherit))}',
      '.ccg-noticeText{flex:1 1 auto;min-width:0;margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit)}',
      '.ccg-noticeAction{flex:none}',
      // A card body is a stack. These are written into the JSX in nine places,
      // and until this rule existed every block inside one of them sat flush
      // against the next: the pills, the switches, the meters and the tier
      // cards were all spaced by nothing.
      '.ccg-cardBody{display:flex;flex-direction:column;gap:12px}',
      // plan picker — the shell's segmented control, reproduced here only for a
      // shell that serves none: same track, same 28px segment, same raised
      // indicator sliding under the chosen one. The capsule this replaces was
      // the card's own invention and read as a different control family beside
      // the shell's square-cornered surfaces.
      '.ccg-segments{position:relative;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3))}',
      '.ccg-segment{box-sizing:border-box;height:28px;padding:0 16px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;cursor:pointer;transition:color 120ms ease}',
      '.ccg-segment:hover:not(:disabled){color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-segment:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4D6BFE));outline-offset:-2px}',
      '.ccg-segment:disabled{cursor:default;opacity:.4}',
      '.ccg-segment[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary,inherit);box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.08))}',
      // fields — the shell's own settings-field shape: a label row, the control,
      // then the hint that belongs to that field, with one hairline between
      // fields. The fixed 168px label column this replaces pushed every control
      // to the same x and left the hint for the last field floating under all of
      // them, where it read as a footnote to the section.
      '.ccg-fields{display:flex;flex-direction:column}',
      '.ccg-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
      '.ccg-field + .ccg-field{border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}',
      '.ccg-fieldHead{display:flex;align-items:center;gap:8px;min-width:0}',
      '.ccg-fieldLabel{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-fieldReset{border:0;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer}',
      '.ccg-fieldReset:hover{color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-fieldReset:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4D6BFE));outline-offset:2px;border-radius:var(--dsw-radius-xs,4px)}',
      '.ccg-fieldControl{display:flex;align-items:center;gap:8px;min-width:0}',
      '.ccg-fieldHint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,inherit)}',
      // switches
      '.ccg-switch{display:flex;align-items:flex-start;gap:12px;padding:12px 0}',
      // A divider belongs between any two stacked rows of the section, whichever
      // shape the row above happens to be: the auto-sync interval is a `.field`
      // and the switch under it is a `.switch`, so matching like-for-like alone
      // would leave those two flush against each other.
      '.ccg-switch + .ccg-switch,.ccg-field + .ccg-switch{border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}',
      '.ccg-switchText{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.ccg-switchTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,inherit)}',
      // the merged provider card: one tier, one tab per protocol
      '.ccg-provider{display:flex;flex-direction:column;gap:10px;padding:12px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-2)}',
      '.ccg-providerHead{display:flex;align-items:center;gap:8px;min-width:0}',
      '.ccg-providerName{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);word-break:break-all}',
      '.ccg-tabs{display:grid;padding:4px;border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-module-platform)}',
      '.ccg-tab{box-sizing:border-box;height:34px;padding:0 12px;border:0;border-radius:var(--dsw-radius-md,12px);background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer}',
      '.ccg-tab:hover{color:var(--dsw-alias-label-primary,inherit)}',
      // The shell's own segmented strip underlines the focused tab rather than
      // ringing it: the selection is already drawn by the raised segment, and a
      // second outline around it reads as two selections.
      '.ccg-tab:focus-visible{outline:none;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:4px}',
      // The raised segment is the shell's indicator: one step up in surface, one
      // hairline in from the track, and the only 600-weight label in the strip.
      '.ccg-tab[aria-selected=true]{border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary,inherit);font-weight:600}',
      '.ccg-tabPanel{display:flex;flex-direction:column;gap:6px}',
      // the ghost routes a tier switch leaves behind
      '.ccg-stale{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-3)}',
      '.ccg-staleTitle{font-weight:600;color:var(--dsw-alias-state-warn-label,inherit)}',
      '.ccg-staleRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      // one card per tier, in the options section
      '.ccg-tiers{display:flex;flex-direction:column;gap:8px}',
      '.ccg-tier{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));border-radius:var(--dsw-radius-md,12px)}',
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
      // `corner-shape:round` is not decoration: the shell gives every element a
      // superellipse corner (`--dsw-corner-shape`), and a superellipse *deforms*
      // full-round shapes, so the shipped Tag, Pill, Switch and StateDot each
      // opt out of it in their own sheet. Without the same opt-out a pill here
      // is visibly squarer than the pill beside it in the same toolbar.
      '.ccg-bar{grid-area:2/1/3/-1;height:6px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-layer-3);overflow:hidden}',
      '.ccg-barFill{height:100%;border-radius:999px;corner-shape:round;background:var(--dsw-alias-brand-primary,#4D6BFE);transition:width .3s ease}',
      '.ccg-barFull{background:var(--dsw-alias-state-error-primary,#d9534f)}',
      '.ccg-percent{flex:0 0 48px;text-align:right;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}',
      '.ccg-metric{display:flex;flex-direction:column;gap:2px}',
      '.ccg-metricLabel{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}',
      '.ccg-metricValue{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-metricDetail{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}',
      // raw / summary
      '.ccg-pre{margin:0;max-height:220px;overflow:auto;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.1));font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word}',
      '.ccg-foot{display:flex;align-items:center;gap:8px;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}',
      '.ccg-summary{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}',
      // fallbacks, used only where the shell serves no primitives. Each one
      // reproduces the geometry *and* the palette of the control it stands in
      // for, so a shell without the package still draws the same card rather
      // than a coarser approximation of it.
      '.ccg-fbBtn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md,12px);background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:14px;line-height:22px;cursor:pointer}',
      '.ccg-fbBtnSm{height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);font-size:12px;line-height:18px}',
      '.ccg-fbBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}',
      '.ccg-fbBtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4D6BFE));outline-offset:1px}',
      '.ccg-fbBtn:disabled{opacity:.4;cursor:not-allowed}',
      '.ccg-fbBtnOutline{border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35))}',
      '.ccg-fbBtnPrimary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4D6BFE));color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.ccg-fbBtnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#4D6BFE))}',
      '.ccg-fbBtnIcon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px}',
      '.ccg-fbTag{display:inline-flex;align-items:center;border-radius:999px;corner-shape:round;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap}',
      '.ccg-fbTag[data-tone=outline]{border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary,inherit)}',
      '.ccg-fbTag[data-tone=solid]{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
      '.ccg-fbTag[data-tone=neutral]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary,inherit)}',
      '.ccg-fbTag[data-tone=quiet]{color:var(--dsw-alias-label-tertiary,inherit)}',
      '.ccg-fbTag[data-tone=success]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.ccg-fbTag[data-tone=info]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary)}',
      '.ccg-fbTag[data-tone=warning]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.ccg-fbTag[data-tone=danger]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.ccg-fbInput{flex:1 1 auto;min-width:0;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.35));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08)));color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px}',
      '.ccg-fbInput::placeholder{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary,inherit))}',
      '.ccg-fbInput:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.ccg-select{height:32px;min-width:110px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.35));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08)));color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px}',
      '.ccg-select:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.ccg-fbSwitch{flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;cursor:pointer;background:var(--dsw-alias-border-l3);position:relative}',
      '.ccg-fbSwitch:disabled{cursor:default;opacity:.5}',
      '.ccg-fbSwitch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4D6BFE));outline-offset:2px}',
      '.ccg-fbSwitchOn{background:var(--dsw-alias-brand-primary,#4D6BFE)}',
      '.ccg-fbSwitch span{position:absolute;top:2px;left:2px;display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform 120ms ease}',
      '.ccg-fbSwitchOn span{transform:translateX(16px)}',
      // Motion is decoration here: the bar's width, the disclosure's rotation and
      // the segment's colour all read the same without it. Every shipped module
      // that animates ships this block; a card inside those pages should too.
      '@media (prefers-reduced-motion: reduce){.ccg-barFill,.ccg-disclosureMark,.ccg-segment,.ccg-tab,.ccg-fbSwitch span{transition:none}}',
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

    /**
     * The fallbacks below are the shell's controls rewritten from its own CSS,
     * and they take the same props. Two of those props are not DOM attributes —
     * `size` and `icon` — so each fallback has to consume them: spreading them
     * onto a `<button>` renders `size="sm"` and `icon="[object Object]"` into
     * the markup and loses the icon entirely.
     */
    const Button = ui.Button ?? (({ variant, size, icon, className, children, disabled, ...rest }) =>
      h('button', {
        type: 'button',
        disabled,
        className: [
          'ccg-fbBtn',
          size === 'sm' ? 'ccg-fbBtnSm' : '',
          variant === 'primary' ? 'ccg-fbBtnPrimary' : variant === 'outline' ? 'ccg-fbBtnOutline' : '',
          className ?? '',
        ].filter((name) => name !== '').join(' '),
        ...rest,
      }, icon === undefined || icon === null ? null : h('span', { className: 'ccg-fbBtnIcon' }, icon), children))
    const Tag = ui.Tag ?? (({ tone = 'outline', className, children }) => h('span', { className: `ccg-fbTag ${className ?? ''}`, 'data-tone': tone }, children))
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
    /** The shell's segmented control, and the tab strip it draws with pills. */
    const SegmentedControl = ui.SegmentedControl
    const SegmentedTabs = ui.SegmentedTabs

    /**
     * Resolve one of the shell's icons by the names a shipped build exports.
     *
     * The primitives package names its artwork `<Subject><Weight>` — `Regular`
     * is the one-pixel stroke, `Medium` the 1.3px one — and takes the size as a
     * *prop*, so no export has ever carried the size in its name. This bundle
     * asked for `IconRefreshOutline16`, `IconWarningOutline16` and
     * `IconCheckOutline16`/`…14`, none of which exist: every lookup answered
     * undefined, and because each call site guards with `icon === undefined ?
     * null : …` the card degraded silently into text-only buttons and notices.
     * Nothing failed; the icons were simply never there.
     *
     * Candidates are tried in order, most-likely first, and the historical
     * `…16`/`…14` spellings stay last so a shell that did ship one still wins.
     */
    const iconOf = (...names) => {
      for (const name of names) {
        const found = ui[name]
        if (found !== undefined && found !== null) return found
      }
      return undefined
    }
    const IconRefresh = iconOf('IconRefreshOutlineRegular', 'IconRefreshOutlineMedium', 'IconRefreshOutline16')
    const IconWarning = iconOf('IconWarningOutlineRegular', 'IconWarningOutlineMedium', 'IconWarningOutline16')
    const IconCheck = iconOf('IconCheckOutlineRegular', 'IconCheckOutlineMedium', 'IconCheckOutline14', 'IconCheckOutline16')

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
    /**
     * How much of a quota is spent, as a number in 0–100.
     *
     * Non-finite inputs answer 0 rather than propagating: `NaN` here would reach
     * both the label and the bar's `width`, which renders as "NaN%" beside a bar
     * with no width — a quota that reads as broken rather than as unknown.
     */
    const percentValue = (used, total) => {
      const spent = Number(used)
      const cap = Number(total)
      if (!Number.isFinite(spent) || !Number.isFinite(cap) || cap <= 0) return 0
      return Math.min(Math.max((spent / cap) * 100, 0), 100)
    }
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
     * The build the host half reported, or undefined when it cannot say one.
     *
     * The bridge never omits the field: it forwards the host's own version, and
     * that falls back to the literal string `unknown` when the manifest cannot be
     * read. Treating "absent" as the only unknown state meant the restart notice
     * could never fire and the header printed `vunknown` — a version number that
     * is not one — in exactly the state the notice exists for.
     */
    function statusVersion(status) {
      const value = status?.version
      return typeof value === 'string' && value !== '' && value !== 'unknown' ? value : undefined
    }

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
      { key: 'extraIds', kind: 'list', hint: 'extraIdsHint' },
    ]
    /** Boolean fields, in card order. */
    const BOOL_FIELDS = ['webSearch', 'autoSync', 'pruneOtherPlans', 'includeReasoningEfforts', 'enableUsageTool']
    /** The dictionary entry each boolean field is labelled by. */
    const BOOL_COPY = {
      webSearch: 'search',
      autoSync: 'autoSync',
      pruneOtherPlans: 'pruneOtherPlans',
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

    /** The DOM id of one advanced field's control, so its label can point at it. */
    const fieldId = (key) => `ccg-field-${key}`

    // ── components ──────────────────────────────────────────────────────────
    /**
     * One labelled field, in the shape the shell's own settings form uses: the
     * label and its badges on one row, the control under them, and the hint that
     * belongs to *this* field under that.
     *
     * The reset is a text button rather than a bordered one — the same choice
     * `fields.module.css` makes, because a field that carries a user override
     * would otherwise grow a second button-sized control beside the one it is
     * describing.
     */
    function Row(props) {
      const overridden = props.overridden === true
      const hintId = props.id === undefined ? undefined : `${props.id}-hint`
      return h('div', { className: 'ccg-field' },
        h('div', { className: 'ccg-fieldHead' },
          // A real `<label for>` where the caller gave the control an id, as the
          // shell's own settings fields do: a sibling span leaves the input with
          // no accessible name at all, and "edit text, blank" is what a screen
          // reader then announces for every field in this section.
          props.id === undefined
            ? h('span', { className: 'ccg-fieldLabel' }, props.label)
            : h('label', { className: 'ccg-fieldLabel', htmlFor: props.id }, props.label),
          overridden ? h(Tag, { tone: 'neutral' }, props.t.overridden) : null,
          overridden
            ? h('button', { type: 'button', className: 'ccg-fieldReset', onClick: props.onReset }, props.t.reset)
            : null),
        h('div', { className: 'ccg-fieldControl' }, props.children),
        props.hint === undefined ? null : h('p', { className: 'ccg-fieldHint', id: hintId }, props.hint))
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
    /**
     * The disclosure's leading glyph: one chevron, rotated a quarter turn when
     * the section is open.
     *
     * Drawn rather than typed. The `▸`/`▾` pair this replaces is a pair of
     * font glyphs, and the platform UI font is not guaranteed to have either —
     * where it does not, the reader gets a tofu box in the one place that says
     * the section can be opened.
     */
    function DisclosureMark(props) {
      return h('span', {
        className: `ccg-disclosureMark${props.open === true ? ' ccg-disclosureMarkOpen' : ''}`,
        'aria-hidden': 'true',
      }, h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        focusable: 'false',
      }, h('path', { d: 'M9 5.5 15.5 12 9 18.5' })))
    }

    function Disclosure(props) {
      const open = props.open === true
      return h('section', { className: 'ccg-section' },
        h('button', {
          type: 'button',
          className: 'ccg-disclosure',
          'aria-expanded': open,
          onClick: props.onToggle,
        },
        h(DisclosureMark, { open }),
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
       * The account panel reads a report the host assembled, so a sub-object
       * that arrives as `null` rather than absent must not take the whole card
       * down with it — there is no error boundary above this, and a render
       * throw blanks every section, not just this one.
       */
      const credits = report?.credits ?? undefined
      const usageTotals = report?.usage ?? undefined
      const plan = report?.plan ?? undefined
      const account = report?.account ?? undefined
      /**
       * The monthly pool as a quota. The service states it as a *remaining*
       * balance beside the amount spent this period, never as a total, so the
       * denominator is the two added together.
       */
      const monthlyLeft = credits?.monthlyCredits ?? 0
      const monthlyUsed = usageTotals?.totalMonthlyCredits ?? usageTotals?.totalCredits ?? 0
      const monthly = credits === undefined
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
      const windowCount = [credits?.fiveHour, credits?.weekly]
        .filter((window) => window !== null && window !== undefined && window.cap > 0).length
      /** A rolling window as a quota line, or nothing when it states no cap. */
      const windowMeter = (window, label) => {
        if (window === null || window === undefined || !(window.cap > 0)) return null
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
        // `role="status"` so a failure that arrives while the reader is looking
        // somewhere else is announced rather than only painted.
        usage.error === undefined || usage.error === null
          ? null
          : h('p', { className: 'ccg-error', role: 'status' }, `${t.usageFailed}: ${usage.error}`),
        report === undefined
          ? (busy ? null : h('p', { className: 'ccg-hint' }, t.usageEmpty))
          : h('div', { className: 'ccg-cardBody' },
            h('div', { className: 'ccg-row' },
              h('span', { className: 'ccg-strong' },
                account?.userName || account?.name || account?.id || ''),
              plan === undefined ? null : h(Tag, { tone: 'info' }, `${t.usagePlan} ${plan.name}`)),
            // The two rolling windows bracket the near term, so they lead; the
            // monthly pool is the slowest-moving number and reads last.
            windowMeter(credits?.fiveHour, t.usageFiveHour),
            windowMeter(credits?.weekly, t.usageWeekly),
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
              credits === undefined || !(credits.purchasedCredits > 0)
                ? null
                : metric(t.usageCreditsPurchased, formatDollars(credits.purchasedCredits)),
              credits === undefined || !(credits.freeCredits > 0)
                ? null
                : metric(t.usageCreditsFree, formatDollars(credits.freeCredits)),
              usageTotals === undefined
                ? null
                : metric(
                  t.usageRequests,
                  formatCount(usageTotals.totalCount),
                  usageTotals.failedCount > 0 ? t.usageFailedCount(usageTotals.failedCount) : undefined,
                ),
              usageTotals === undefined ? null : metric(t.usageCost, formatMoney(usageTotals.totalCost)),
              usageTotals === undefined
                ? null
                : metric(
                  t.usageTokens,
                  // A host older than this field reports only the halves, and
                  // "0" beside a real split would be worse than either.
                  formatCount(
                    Number.isFinite(usageTotals.totalTokens)
                      ? usageTotals.totalTokens
                      : (usageTotals.totalTokensIn ?? 0) + (usageTotals.totalTokensOut ?? 0),
                  ),
                  t.usageTokenSplit(formatCount(usageTotals.totalTokensIn), formatCount(usageTotals.totalTokensOut)),
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
      /** Whether this seat renders its own header, or the shell prints one above. */
      const chrome = props.chrome !== false
      /** The build the host reported, or undefined when it could not say one. */
      const version = statusVersion(status)
      /**
       * A card newer than the process serving it.
       *
       * The client half is re-read from disk on every page load, the host half
       * only at boot, so this state is reachable after every update — and it is
       * otherwise indistinguishable from "the fix did nothing".
       */
      const hostStale = status !== undefined && status !== null && version === undefined
      /**
       * Everything the tier has produced, as one number. This is the question
       * the card exists to answer, and for most readers the only thing worth
       * knowing about the generated providers — their names and per-route
       * states live behind a disclosure further down.
       *
       * Only the create states and a stated count contribute. A target the host
       * reports as created without a count makes the *sum* unknown, not zero, and
       * `undefined` would poison it into NaN — which reads as "nothing has been
       * created" beside routes that exist.
       */
      const modelsFound = Object.values(status?.targets ?? {})
        .filter((target) => target !== null && typeof target === 'object' && target.created === true)
        .reduce((total, target) => total + (Number.isFinite(target.models) ? target.models : 0), 0)

      const textRow = (spec) => h(Row, {
        key: spec.key,
        id: fieldId(spec.key),
        label: t[spec.copy ?? spec.key],
        hint: spec.hint === undefined ? undefined : t[spec.hint],
        t,
        overridden: state.overrides[spec.key] === true,
        onReset: () => actions.reset(spec.key),
      }, h(Input, {
        id: fieldId(spec.key),
        'aria-describedby': spec.hint === undefined ? undefined : `${fieldId(spec.key)}-hint`,
        value: fields[spec.key] ?? '',
        placeholder: spec.fallback ?? '',
        disabled: saving,
        onChange: (event) => actions.edit(spec.key, event.target.value),
      }))

      /**
       * The tier picker: one value out of four, drawn with the shell's own
       * segmented control wherever the shell serves one.
       *
       * `SegmentedControl` is the component the shell itself uses to pick one
       * of a few values with a raised indicator sliding under the choice, and it
       * brings the roving tab stop and the arrow-key walk with it. The fallback
       * below reproduces its geometry from the same tokens, so the picker is the
       * same control either way.
       */
      const planPicker = () => {
        if (SegmentedControl !== undefined) {
          return h(SegmentedControl, {
            id: 'ccg-plan',
            value: fields.plan,
            options: PLANS.map((plan) => ({ value: plan.value, label: plan.title })),
            label: t.plan,
            disabled: saving,
            onChange: (next) => actions.edit('plan', next),
          })
        }
        return h('div', { className: 'ccg-segments', role: 'group', 'aria-label': t.plan },
          PLANS.map((plan) => h('button', {
            key: plan.value,
            type: 'button',
            className: 'ccg-segment',
            'aria-pressed': fields.plan === plan.value,
            disabled: saving,
            onClick: () => actions.edit('plan', plan.value),
          }, plan.title)))
      }

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
        // `role="status"` so a failure that arrives without a click — a failed
        // background read, a refused sync — is announced rather than only drawn.
        h('p', { className: 'ccg-error', role: 'status' }, text))

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
       * The tab strip of the merged provider card: one tab per protocol slot.
       *
       * The shell's `SegmentedTabs` is what this strip *is* — equal-width tabs
       * over caller-owned panels, with the sliding indicator, the roving tab
       * stop and the Left/Right/Home/End walk all built in. The hand-rolled
       * version below it stays as the fallback and reproduces the same contract:
       * `role="tab"`, `aria-selected`, `aria-controls` naming the panel, only
       * the selected tab in the tab order, and arrow keys that move within the
       * strip rather than leaving it.
       */
      const tabId = (slot) => `ccg-tab-${slot}`
      const panelId = (slot) => `ccg-panel-${slot}`
      const tabStrip = (tabs, active) => {
        if (SegmentedTabs !== undefined) {
          return h(SegmentedTabs, {
            items: tabs.map((tab) => ({ value: tab.slot, label: tab.label, id: tabId(tab.slot), panelId: panelId(tab.slot) })),
            value: active.slot,
            onChange: (slot) => setProviderTab(slot),
            label: t.targetTabs,
          })
        }
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
            id: tabId(tab.slot),
            className: 'ccg-tab',
            'aria-selected': tab.slot === active.slot,
            'aria-controls': panelId(tab.slot),
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
        return h('div', {
          className: 'ccg-tabPanel',
          role: 'tabpanel',
          id: panelId(tab.slot),
          'aria-labelledby': tabId(tab.slot),
          tabIndex: -1,
        },
        h('div', { className: 'ccg-row' },
          h('span', { className: 'ccg-mono' }, key),
          h('span', { className: 'ccg-spacer' }),
          created ? h(Tag, { tone: 'info' }, t.created) : h(Tag, { tone: 'outline' }, t.missing)),
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
        /**
         * The leftovers the sweep refused to touch.
         *
         * A route carrying `modelOverrides` is a hand edit this plugin promised
         * never to overwrite, so it is left in place and reported instead. The
         * result has always carried that list; the card used to print only the
         * removal count, so pressing 清理残留 over such a route answered
         * "已清理 0 条残留路由" while the row it named stayed on screen.
         */
        const kept = state.prune.result?.protected
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
                h(Tag, { tone: 'outline' }, t.staleTier(row.title)),
                row.models === null ? null : h('span', { className: 'ccg-muted' }, t.models(row.models))))),
          // The result outlives the list it describes: a prune that emptied
          // `stale` still has to say what it removed — and what it would not.
          Array.isArray(removed) ? h('p', { className: 'ccg-hint' }, t.pruneResult(removed.length)) : null,
          Array.isArray(kept) && kept.length > 0
            ? h('p', { className: 'ccg-hint' }, t.pruneKept(kept.join(', ')))
            : null)
      }

      /**
       * One tier, as a card.
       *
       * Its body carries no click handler on purpose: the tier picker above is
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
            // Exactly one tag per group names the current selection, which is
            // what the shell reserves its `solid` tone for; the subscription is
            // a different fact about the same tier and wears `info`.
            selected ? h(Tag, { tone: 'solid' }, t.tierSelected) : null,
            subscribed
              ? h(Tag, { tone: 'info' }, tier.source === 'organization'
                ? t.subscribedOrganization
                : tier.source === 'personal'
                  ? t.subscribedPersonal
                  : t.subscribedUnknown)
              : null),
          // A host that cannot describe its tiers is not waiting for a sync: no
          // sync will ever add the field, and telling the reader to wait for one
          // sends them looking for a problem that is a restart away.
          hostTooOld ? null : h('p', { className: models.unknown ? 'ccg-muted' : 'ccg-hint' }, models.text),
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

      /**
       * Whether the host half predates the tier descriptions.
       *
       * The client half is re-read from disk on every page load; the host half
       * only when the process starts. Between an update and the next restart the
       * card is therefore newer than the process serving it, and the tiers it
       * renders come from the `plans` fallback: names and buttons, no model
       * counts, no quota, no documentation links. That state is *not* "wait for
       * the first sync" — no sync can add a field the running code does not
       * know — so it says what it actually is.
       *
       * It is checked only when the build *is* known: a host that cannot say
       * which build it is has told us everything it can, and the notice below
       * already covers that case. Printing both would be two sentences for one
       * problem.
       */
      const hostTiers = Array.isArray(status?.tiers) && status.tiers.length > 0
      const hostTooOld = hostStale === false && status !== undefined && status !== null && !hostTiers
        && Array.isArray(status.plans) && status.plans.length > 0

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
        /**
         * The card's own header, but only where nothing above it already says
         * the same thing.
         *
         * The Plugins panel draws `item.label` as a 20px page title and this
         * card's *summary* view as the 14px line under it, then renders the page
         * view below — so the header below those two printed
         * "Command Code 订阅接入" a second time, in a third size, with the intro
         * sentence duplicated as prose. The `settings.plugins.tab` seat has no
         * such title above it, which is why that one seat still asks for the
         * full header; the panel seats keep only the two facts nothing else
         * states — which subscription the account is on, and which build.
         */
        chrome
          ? h('header', { className: 'ccg-head' },
            h('span', { className: 'ccg-headIcon' }, h(CommandCodeMark, { size: 18 })),
            h('div', { className: 'ccg-headText' },
              h('h3', { className: 'ccg-headTitle' }, t.title),
              h('p', { className: 'ccg-headIntro' }, t.intro)),
            h('div', { className: 'ccg-headEnd ccg-headInline' },
              subscriptionTag === null ? null : h(Tag, { tone: 'neutral' }, subscriptionTag),
              h('span', { className: 'ccg-muted' }, `v${version ?? '?'}`)))
          : h('div', { className: 'ccg-headEnd' },
            subscriptionTag === null ? null : h(Tag, { tone: 'neutral' }, subscriptionTag),
            h('span', { className: 'ccg-muted' }, `v${version ?? '?'}`)),

        // The one line worth reading: what the tier produced, and whether its
        // key is there. Everything else about the generated providers is
        // detail, and detail lives behind the disclosure below.
        h('div', { className: 'ccg-row' },
          modelsFound > 0
            ? h(Tag, { tone: 'success', className: 'ccg-tagIcon' }, [
              IconCheck === undefined ? null : h(IconCheck, { key: 'icon', size: 14 }),
              t.modelsReady(modelsFound),
            ])
            : h(Tag, { tone: 'outline' }, t.summaryPending),
          status === undefined || status === null
            ? null
            : status.hasKey === true
              ? h(Tag, { tone: 'success' }, status.keySource === 'environment' ? t.keyReadyEnv : t.keyReady)
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

        // A host that cannot describe its tiers is the same class of state, one
        // version later: the card renders, the tiers it lists are real, and the
        // figures that belong beside them can only appear after a restart. This
        // is the notice that turns "why is every tier blank" into a restart.
        hostTooOld
          ? problem(t.hostOld(`v${version}`))
          : null,

        // A card newer than the process serving it is a real and confusing
        // state: the client half is re-read from disk on every page load, the
        // host half only at boot. Say so instead of letting the reader conclude
        // that a fix did nothing.
        hostStale ? problem(t.hostStale) : null,
        // A refused read is a state the reader has to be told about: without
        // this the card said "no provider created yet" and drew `v?`, which is
        // the *absence* of a provider, not the absence of an answer.
        state.statusError === undefined || state.statusError === null
          ? null
          : problem(`${t.error}: ${state.statusError}`),
        state.error === undefined || state.error === null ? null : problem(`${t.error}: ${state.error}`),
        state.sync.error === undefined || state.sync.error === null ? null : problem(`${t.error}: ${state.sync.error}`),
        state.prune.error === undefined || state.prune.error === null ? null : problem(`${t.error}: ${state.prune.error}`),

        // ── tier and the two actions that act on it ────────────────────────
        h('section', { className: 'ccg-card' },
          h('div', { className: 'ccg-cardHead' },
            h('h4', { className: 'ccg-cardTitle' }, t.plan),
            state.overrides.plan === true ? h(Tag, { tone: 'neutral' }, t.overridden) : null,
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
            planPicker(),
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
            toggle('pruneOtherPlans'),
            fields.autoSync === true
              ? h(Row, {
                id: fieldId('autoSyncIntervalMs'),
                label: t.autoSyncInterval,
                t,
                overridden: state.overrides.autoSyncIntervalMs === true,
                onReset: () => actions.reset('autoSyncIntervalMs'),
              }, h('select', {
                id: fieldId('autoSyncIntervalMs'),
                className: 'ccg-select',
                value: String(fields.autoSyncIntervalMs),
                disabled: saving,
                onChange: (event) => actions.edit('autoSyncIntervalMs', Number(event.target.value)),
              }, intervalChoices(fields.autoSyncIntervalMs)))
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
              // Each field carries its own hint now. The extra-ids sentence used
              // to sit here, under all six fields, where it read as a footnote to
              // the section rather than as the explanation of the one text box it
              // describes.
              h('div', { className: 'ccg-fields' }, TEXT_FIELDS.map(textRow)),
              h('p', { className: 'ccg-muted' }, `dsh-commandcode-goat v${version ?? '?'}`)))),

        state.dirty === true
          ? h('div', { className: 'ccg-foot' },
            h(Button, { variant: 'primary', size: 'sm', disabled: saving, onClick: () => actions.save() },
              saving ? t.saving : t.save),
            h(Button, { variant: 'outline', size: 'sm', onClick: () => actions.discard() }, t.discard))
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
        : Object.values(status.targets ?? {}).filter((target) => target !== null && typeof target === 'object' && target.created === true)
      if (created.length === 0) return h('span', { className: 'ccg-summary' }, t.summaryPending)
      // Same guard as the header's count: `undefined + n` is NaN, and "NaN
      // models" in the Plugins list is worse than a slightly low number.
      const models = created.reduce((total, target) => total + (Number.isFinite(target.models) ? target.models : 0), 0)
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
          pruneOtherPlans: true,
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
          // Same convention as `autoSync`: the host's schema default is on, and
          // the card must read an absent field the way the host does.
          pruneOtherPlans: value.pruneOtherPlans !== false,
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

      /**
       * Write one field and report whether the Host actually took it.
       *
       * `set`/`unset` resolve to a **boolean** — "whether the Host accepted the
       * write, after any recovery read" — and answer `false` for a refused
       * mutation (revision conflict, a namespace this deployment cannot write)
       * as well as for a form whose persistence is `memory`, without throwing.
       * Awaiting them and discarding the answer is what let the card print
       * "已保存 / Saved" over a write that never landed, and then quietly put the
       * old values back on the next read.
       */
      const write = async (op, key, value) => {
        const accepted = op === 'unset' ? await scope.unset(key) : await scope.set(key, value)
        if (accepted !== true) throw new Error(dictionary().writeRefused)
      }

      const save = async () => {
        if (!scope) {
          store.update({ error: dictionary().settingsUnavailable })
          return
        }
        if (scope.getSnapshot?.()?.writable === false) {
          store.update({ error: dictionary().settingsReadOnly })
          return
        }
        store.update({ phase: 'saving', error: null })
        const staged = store.getSnapshot().fields
        const failures = []
        for (const [key, value] of Object.entries(staged)) {
          const plan = planFor(key, value)
          if (plan === undefined) continue
          try {
            await write(plan.write, key, plan.value)
          } catch (error) {
            failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        sync()
        await refreshStatus()
        if (failures.length > 0) {
          store.update({ phase: 'idle', error: failures.join('\n') })
          return
        }
        store.update({ phase: 'saved', error: null })
        // The badge celebrates one write, it does not describe a state. Without
        // this it stayed on screen for the rest of the session, including past a
        // later sync failure, which reads as "everything is fine" at the exact
        // moment it is not. `unref` where the runtime has it, so a pending
        // confirmation never holds a process open.
        const handle = setTimeout(() => {
          if (store.getSnapshot().phase === 'saved') store.update({ phase: 'idle' })
        }, SAVED_BADGE_MS)
        if (typeof handle?.unref === 'function') handle.unref()
      }

      const reset = async (key) => {
        if (!scope) return
        try {
          await write('unset', key)
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
       * rather than only when asked.
       *
       * The tick is gated on the card actually being on screen. `document.hidden`
       * alone only says the *tab* is in front; this controller lives for the
       * whole session and is shared by four seats, so before this gate every
       * session issued the account's five upstream requests every minute —
       * whether or not anyone had ever opened the plugin's page. The card's own
       * root element is what "open" means here, and it is readable without
       * involving React.
       */
      ctx.effect(() => {
        const onScreen = () => typeof document === 'undefined'
          || (document.hidden !== true && document.querySelector('.ccg-root') !== null)
        const timer = setInterval(() => {
          if (onScreen()) void refreshUsage()
        }, USAGE_REFRESH_MS)
        const onVisibilityChange = () => {
          if (onScreen()) void refreshUsage()
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

      /**
       * Re-read everything the host knows: the draft, the routes and the account.
       *
       * The header's 重新读取 / Reload button means "ask again", and the local
       * re-read it used to do could not change a single pixel unless the draft
       * was dirty. Discarding a draft is a different action and keeps its own
       * name, so the footer button still says 放弃修改 / Discard.
       */
      const reload = async () => {
        sync()
        await Promise.all([refreshStatus(), refreshUsage()])
      }

      return { store, actions: { edit, save, reset, reload, discard: sync, sync: runSync, prune, refreshUsage, refreshStatus } }
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
       *
       * The three panel seats pass `chrome: false`, because the panel draws the
       * plugin's label as a 20px page title and this card's *summary* as the line
       * beneath it before rendering the page view: a card that also drew its own
       * title and intro printed both a second time an inch lower. Only the
       * Settings tab, which has no title above it, keeps the full header.
       */
      /** The card's own header, for the one seat that has no title above it. */
      const page = (props) => h(CommandCodeCard, props)
      /** The same card under a shell that already printed the plugin's name. */
      const pageWithoutHeader = (props) => h(CommandCodeCard, { ...props, chrome: false })
      /** Every seat answers both views the panel dispatches it with. */
      const view = (Card) => (props) => (props.view === 'page' ? Card(props) : h(CommandCodeSummary, props))

      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: NS,
        order: 50,
        label: () => bound('tabLabel'),
        locale: NS,
        inject: face,
      }, page))

      ctx.slots.inject('plugins.item', () => ctx.slots.register({
        name: 'plugins.item',
        id: NS,
        order: 60,
        label: () => bound('title'),
        locale: NS,
        inject: face,
      }, view(pageWithoutHeader)))

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
      }, view(pageWithoutHeader)))

      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: ROW_CONFIG_KEY,
        order: 60,
        label: () => bound('title'),
        locale: NS,
        inject: face,
      }, view(pageWithoutHeader)))
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
      statusVersion,
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
