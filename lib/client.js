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
 *   - Its own settings go through `ctx.settingsScope`, which is revision-fenced
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

    const NS = 'dsh-commandcode-goat'
    const BRIDGE = '/api/dsh-commandcode-goat'
    const DEFAULT_SOURCE_URL = 'https://api.commandcode.ai/provider/v1/models'
    const DEFAULT_CATALOG_URL = 'https://commandcode.ai/docs/plans/goat'
    const DEFAULT_BASE_URL = 'https://api.commandcode.ai/provider/v1'
    const DEFAULT_ALPHA_BASE_URL = 'https://api.commandcode.ai'
    const DEFAULT_API_KEY_ENV = 'COMMANDCODE_API_KEY'

    const PLANS = [
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

    // ── copy ────────────────────────────────────────────────────────────────
    const zh = {
      title: 'Command Code 订阅接入',
      tabLabel: 'Command Code',
      intro: '把 Command Code 订阅接成 DSH 的模型供应商；聊天、搜索、用量共用一把密钥。',
      summaryPending: '尚未创建供应商',
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
      usageRequests: '请求',
      usageCost: '成本',
      usageTokens: 'Token',
      usageFiveHour: '5 小时窗口',
      usageWeekly: '每周窗口',
      usageCredits: '额度',
      usageResets: (text) => `${text} 后重置`,
      usageExceeded: '已用尽',
      usageRaw: '原始响应',
      search: '用本账户提供 web_search',
      searchHint: '开启后，模型的联网搜索走 Command Code 的同一把密钥，无需再配置 DSH 自己的搜索密钥。若部署已在 cordis.yml 里指定了别的搜索供应商，本开关不会抢占。',
      searchHeld: '已有其它搜索供应商被显式指定，本插件未抢占选择权。',
      autoSync: '定时自动同步',
      autoSyncHint: '按所选间隔刷新生成的模型列表，让上游新增的模型自动出现。',
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
      error: '错误',
      settingsUnavailable: '当前部署没有提供可写的设置服务。',
    }
    const en = {
      title: 'Command Code subscription',
      tabLabel: 'Command Code',
      intro: 'Publish a Command Code subscription as DSH providers; chat, search and usage share one key.',
      summaryPending: 'No provider created yet',
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
      usageCost: 'Cost',
      usageTokens: 'Tokens',
      usageFiveHour: '5-hour window',
      usageWeekly: 'Weekly window',
      usageCredits: 'Credits',
      usageResets: (text) => `resets in ${text}`,
      usageExceeded: 'exceeded',
      usageRaw: 'Raw response',
      search: 'Serve web_search from this account',
      searchHint: 'Lets the model search the web with the same Command Code credential, so no separate DSH search key is needed. A deployment that named its search provider in cordis.yml keeps that choice.',
      searchHeld: 'Another search provider is explicitly selected, so this plugin left the selection alone.',
      autoSync: 'Scheduled auto-sync',
      autoSyncHint: 'Refresh the generated model list on a timer so newly published models appear on their own.',
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
      '.ccg-headIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;background:var(--dsw-alias-bg-layer-4,rgba(127,127,127,.18));color:var(--dsw-alias-brand-primary,inherit)}',
      '.ccg-headText{min-width:0;flex:1 1 auto}',
      '.ccg-headTitle{margin:0;font-size:15px;font-weight:600;line-height:1.3;color:var(--dsw-alias-label-primary,inherit)}',
      '.ccg-headIntro{margin:4px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,inherit)}',
      '.ccg-headTags{flex:none;display:inline-flex;align-items:center;gap:6px;padding-top:2px}',
      // sections
      '.ccg-section{display:flex;flex-direction:column;gap:10px}',
      '.ccg-sectionHead{display:flex;align-items:baseline;gap:8px}',
      '.ccg-sectionTitle{margin:0;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,inherit)}',
      '.ccg-sectionNote{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}',
      '.ccg-panel{display:flex;flex-direction:column;gap:12px;padding:14px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent)}',
      '.ccg-panel-flush{padding:0;border:0;background:none}',
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
      '.ccg-notice{display:flex;gap:8px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08))}',
      // plan picker
      '.ccg-pills{display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:999px;background:var(--dsw-alias-bg-layer-4,rgba(127,127,127,.16))}',
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
      // usage
      '.ccg-window{display:flex;flex-direction:column;gap:6px}',
      '.ccg-bar{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-4,rgba(127,127,127,.2));overflow:hidden}',
      '.ccg-barFill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,#4D6BFE);transition:width .3s ease}',
      '.ccg-barFull{background:var(--dsw-alias-state-error-primary,#d9534f)}',
      '.ccg-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}',
      '.ccg-metric{display:flex;flex-direction:column;gap:2px}',
      '.ccg-metricLabel{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}',
      '.ccg-metricValue{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
      // raw / summary
      '.ccg-pre{margin:0;max-height:220px;overflow:auto;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.1));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word}',
      '.ccg-foot{display:flex;align-items:center;gap:8px;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}',
      '.ccg-summary{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}',
      // fallbacks, used only where the shell serves no primitives
      '.ccg-fbBtn{height:30px;padding:0 12px;border-radius:8px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08));color:inherit;font:inherit;font-size:12px}',
      '.ccg-fbBtn:disabled{opacity:.5;cursor:default}',
      '.ccg-fbBtnPrimary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4D6BFE);color:#fff}',
      '.ccg-fbTag{padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-4,rgba(127,127,127,.18));font-size:11px}',
      '.ccg-fbInput{flex:1 1 auto;min-width:0;height:32px;padding:0 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08));color:inherit;font:inherit;font-size:13px}',
      '.ccg-select{height:32px;min-width:110px;padding:0 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08));color:inherit;font:inherit;font-size:13px}',
      '.ccg-fbSwitch{flex:none;width:36px;height:20px;border-radius:999px;border:0;cursor:pointer;background:var(--dsw-alias-bg-layer-4,rgba(127,127,127,.35));position:relative;padding:0}',
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
    const IconPlugin = ui.IconCordisPluginOutline14 ?? ui.IconPluginPinwheelOutline16
    const IconWarning = ui.IconWarningOutline16

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
    const percentOf = (window) => (window !== undefined && window.cap > 0
      ? Math.min(Math.max(Math.round((window.used / window.cap) * 100), 0), 100)
      : 0)
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

    /** One rolling request window: what it has spent, its cap, and the reset. */
    function WindowRow(props) {
      const window = props.window
      if (window === undefined || !(window.cap > 0)) return null
      const percent = percentOf(window)
      const remaining = secondsUntil(window.resetAt)
      return h('div', { className: 'ccg-window' },
        h('div', { className: 'ccg-row' },
          h('span', { className: 'ccg-strong' }, props.label),
          h('span', { className: 'ccg-mono' }, `${window.used} / ${window.cap}`),
          window.exceeded === true ? h(Tag, { tone: 'danger' }, props.t.usageExceeded) : null,
          h('span', { className: 'ccg-spacer' }),
          remaining === undefined ? null : h('span', { className: 'ccg-muted' }, props.t.usageResets(formatDuration(remaining)))),
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
      const metric = (label, value) => h('div', { className: 'ccg-metric' },
        h('span', { className: 'ccg-metricLabel' }, label),
        h('span', { className: 'ccg-metricValue' }, value))
      return h('section', { className: 'ccg-section' },
        h('div', { className: 'ccg-sectionHead' },
          h('h4', { className: 'ccg-sectionTitle' }, t.usage),
          h('span', { className: 'ccg-spacer' }),
          h(Button, {
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
          : h('div', { className: 'ccg-panel' },
            h('div', { className: 'ccg-row' },
              h('span', { className: 'ccg-strong' },
                report.account?.userName || report.account?.name || report.account?.id || ''),
              report.plan === undefined ? null : h(Tag, { tone: 'info' }, `${t.usagePlan} ${report.plan.name}`)),
            h(WindowRow, { window: report.credits?.fiveHour, label: t.usageFiveHour, t }),
            h(WindowRow, { window: report.credits?.weekly, label: t.usageWeekly, t }),
            h('div', { className: 'ccg-metrics' },
              report.credits === undefined
                ? null
                : metric(t.usageCredits, `${formatCount(report.credits.monthlyCredits)} / ${formatCount(report.credits.purchasedCredits)} / ${formatCount(report.credits.freeCredits)}`),
              report.usage === undefined ? null : metric(t.usageRequests, `${report.usage.completedCount}/${report.usage.totalCount}`),
              report.usage === undefined ? null : metric(t.usageCost, formatMoney(report.usage.totalCost)),
              report.usage === undefined ? null : metric(t.usageTokens, `${formatCount(report.usage.totalTokensIn)} / ${formatCount(report.usage.totalTokensOut)}`)),
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
      const status = state.status
      const fields = state.fields
      const actions = props.actions
      const saving = state.phase === 'saving'
      const running = state.sync.phase === 'running'
      const syncResult = state.sync.result
      const planTitle = PLANS.find((plan) => plan.value === fields.plan)?.title ?? fields.plan

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

      return h('div', { className: 'ccg-root' },
        h('header', { className: 'ccg-head' },
          h('span', { className: 'ccg-headIcon' }, IconPlugin === undefined ? null : h(IconPlugin, { size: 18 })),
          h('div', { className: 'ccg-headText' },
            h('h3', { className: 'ccg-headTitle' }, t.title),
            h('p', { className: 'ccg-headIntro' }, t.intro)),
          h('div', { className: 'ccg-headTags' },
            h(Tag, null, planTitle),
            status === undefined || status === null
              ? null
              : status.hasKey === true
                ? h(Tag, null, status.keySource === 'environment' ? t.keyReadyEnv : t.keyReady)
                : h(Tag, { tone: 'danger' }, t.keyMissing))),

        // ── tier and the two actions that act on it ────────────────────────
        h('section', { className: 'ccg-section' },
          h('div', { className: 'ccg-sectionHead' },
            h('h4', { className: 'ccg-sectionTitle' }, t.plan),
            h('span', { className: 'ccg-spacer' }),
            state.overrides.plan === true ? h(Tag, null, t.overridden) : null),
          h('div', { className: 'ccg-row' },
            h('div', { className: 'ccg-pills' },
              PLANS.map((plan) => h(Pill, {
                key: plan.value,
                active: fields.plan === plan.value,
                onClick: () => actions.edit('plan', plan.value),
              }, plan.title))),
            h('span', { className: 'ccg-spacer' }),
            h(Button, {
              variant: 'primary',
              size: 'sm',
              disabled: running,
              icon: IconRefresh === undefined ? null : h(IconRefresh, null),
              onClick: () => actions.sync(),
            }, running ? t.syncing : t.sync),
            h(Button, { size: 'sm', onClick: () => actions.reload() }, t.refresh),
            state.phase === 'saved' ? h('span', { className: 'ccg-ok' }, t.saved) : null),
          h('p', { className: 'ccg-hint' }, t.planHint),
          state.error === undefined || state.error === null ? null : problem(`${t.error}: ${state.error}`),
          state.sync.error === undefined || state.sync.error === null ? null : problem(`${t.error}: ${state.sync.error}`),
          syncResult === undefined
            ? null
            : h('div', { className: 'ccg-panel' },
              h('div', { className: 'ccg-row' },
                h(Tag, { tone: 'info' }, syncResult.dryRun === true ? t.syncDryRun : t.syncDone),
                h('span', { className: 'ccg-muted' }, t.syncResult(syncResult.live ?? 0, syncResult.plan ?? fields.plan))),
              h('div', { className: 'ccg-fields' },
                Object.entries(syncResult.counts ?? {}).map(([key, count]) => h('div', { key, className: 'ccg-field' },
                  h('span', { className: 'ccg-fieldLabel ccg-mono' }, key),
                  h('span', { className: 'ccg-fieldControl ccg-muted' }, t.models(count))))),
              Array.isArray(syncResult.skipped) && syncResult.skipped.length > 0
                ? h('p', { className: 'ccg-hint' }, t.syncSkipped(syncResult.skipped.join(', ')))
                : null,
              Array.isArray(syncResult.diagnostics) && syncResult.diagnostics.length > 0
                ? h('div', { className: 'ccg-section' },
                  h('h4', { className: 'ccg-sectionTitle' }, t.syncDiagnostics),
                  syncResult.diagnostics.map((line, index) => h('p', { key: index, className: 'ccg-hint' }, line)))
                : null)),

        // ── what the tier writes into, and whether its key is there ────────
        h('section', { className: 'ccg-section' },
          h('div', { className: 'ccg-sectionHead' },
            h('h4', { className: 'ccg-sectionTitle' }, t.targets),
            h('span', { className: 'ccg-spacer' }),
            status === undefined || status === null
              ? null
              : status.writable === false
                ? h(Tag, { tone: 'danger' }, t.settingsUnavailable)
                : null),
          status === undefined || status === null
            ? h('p', { className: 'ccg-hint' }, state.statusError ?? t.summaryPending)
            : h('div', { className: 'ccg-panel' },
              h('div', { className: 'ccg-fields' },
                Object.entries(status.targets ?? {}).map(([route, target]) => h('div', { key: route, className: 'ccg-field' },
                  h('span', { className: 'ccg-fieldLabel ccg-mono' }, target.key),
                  h('div', { className: 'ccg-fieldControl' },
                    target.created ? h(Tag, { tone: 'info' }, t.created) : h(Tag, null, t.missing),
                    target.created ? h('span', { className: 'ccg-muted' }, t.models(target.models)) : null)))),
              h('p', { className: 'ccg-hint' }, t.keyWhere),
              status.hasKey === true
                ? h('p', { className: 'ccg-hint' }, t.keyWhereEnv(status.apiKeyEnv ?? DEFAULT_API_KEY_ENV))
                : h('p', { className: 'ccg-hint' }, t.keyMissingHint(status.apiKeyEnv ?? DEFAULT_API_KEY_ENV)))),

        h(UsagePanel, { t, usage: state.usage, onRefresh: () => actions.refreshUsage() }),

        // ── the switches ───────────────────────────────────────────────────
        h('section', { className: 'ccg-section' },
          h('div', { className: 'ccg-sectionHead' }, h('h4', { className: 'ccg-sectionTitle' }, t.options)),
          h('div', { className: 'ccg-panel ccg-panel-flush' },
            toggle('webSearch'),
            status?.search?.held === true ? h('p', { className: 'ccg-hint' }, t.searchHeld) : null,
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
            toggle('enableUsageTool'))),

        h('section', { className: 'ccg-section' },
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => setAdvanced(!advanced) },
            `${advanced ? '▾' : '▸'} ${t.advanced}`),
          advanced
            ? h('div', { className: 'ccg-panel' },
              h('div', { className: 'ccg-fields' }, TEXT_FIELDS.map(textRow)),
              h('p', { className: 'ccg-hint' }, t.extraIdsHint),
              h('p', { className: 'ccg-muted' }, `dsh-commandcode-goat v${status?.version ?? '?'}`))
            : null),

        state.dirty === true
          ? h('div', { className: 'ccg-foot' },
            h(Button, { variant: 'primary', size: 'sm', disabled: saving, onClick: () => actions.save() },
              saving ? t.saving : t.save),
            h(Button, { size: 'sm', onClick: () => actions.reload() }, t.discard))
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
      const scope = ctx.settingsScope?.bind({ namespace: NS })
      const store = createStore({
        fields: {
          plan: 'goat',
          webSearch: false,
          autoSync: false,
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
          autoSync: value.autoSync === true,
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
          store.update({ status: await callBridge('/describe', {}), statusError: null })
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
          await refreshStatus()
        } catch (error) {
          store.update({
            sync: { phase: 'idle', result: undefined, error: error instanceof Error ? error.message : String(error) },
          })
          // A refused sync is exactly when the route list and the key state are
          // worth re-reading, so the card cannot report a stale reason twice.
          await refreshStatus()
        }
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

      if (scope?.subscribe) ctx.effect(() => scope.subscribe(() => sync()))
      sync()
      void refreshStatus()
      void refreshUsage()

      return { store, actions: { edit, save, reset, reload: sync, sync: runSync, refreshUsage, refreshStatus } }
    }

    // ── registration ────────────────────────────────────────────────────────
    exports.inject = ['slots', 'locale', 'settingsScope']

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
       * The card is registered into both seats this build offers a plugin, and
       * they are genuinely different surfaces:
       *
       *   - `settings.plugins.tab` — a tab inside **Settings → Plugins**. This
       *     is where someone goes looking for a plugin's configuration, and it
       *     is the seat the first-party plugin inventory uses.
       *   - `plugins.item` — a page in the **Plugins sidebar panel**, listed
       *     beside the shipped official plugins. The panel dispatches it twice
       *     (`view: "summary"` for the card's one-liner, `view: "page"` for the
       *     page behind it), so this entry also has to answer for the summary.
       *
       * Registering only the second one leaves the plugin reachable but not
       * where it is looked for.
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
    }

    /** Pure helpers, exposed so the test suite can pin them without React. */
    exports.__internals = {
      parseIds,
      percentOf,
      formatDuration,
      formatCount,
      formatMoney,
      sameList,
      providerKey,
      PLANS,
      TEXT_FIELDS,
      BOOL_FIELDS,
      BOOL_COPY,
    }
    return module.exports
  },
})
