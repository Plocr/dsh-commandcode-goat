import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, describe, it } from 'node:test'

/**
 * Every browser context built in this file, so the intervals a mounted card
 * starts can be cleared once the file's tests are done — otherwise a pending
 * timer would hold the test runner open.
 */
const liveContexts = []
after(() => {
  for (const context of liveContexts) {
    for (const effect of [...context.effects].reverse()) effect.dispose?.()
  }
  liveContexts.length = 0
})

const CLIENT_PATH = new URL('../lib/client.js', import.meta.url)
/**
 * The settings section, which since dsh 0.1.7 is the *profile row id* this
 * bundle's patch declares — not a namespace the plugin registers.
 */
const NS = 'commandcode-goat'

/**
 * A React stand-in. The card is rendered by calling it as a plain function in
 * these tests, so the hooks only have to answer once: a state setter that does
 * nothing and a snapshot read that returns what the store holds.
 */
/**
 * Initial values handed back by successive `useState` calls in one render.
 * Empty means every state starts at the value its component passed; a test
 * that needs a disclosure already open sets it (the card's states are, in
 * order: the advanced disclosure, the providers disclosure, then the tab
 * selected in the merged provider card).
 */
let useStateValues = []

/**
 * Hold the card's three states where a test wants them, across every render.
 *
 * The React stand-in hands its values out by call order and never rewinds, so
 * a single set only survives the first render — and a test that renders,
 * clicks a control and renders again would silently get the card's own initial
 * states back on the second pass. Repeating the triple keeps the phases aligned
 * however many times a test renders.
 */
function statesFor([advanced, providers, tab], renders = 6) {
  return Array.from({ length: renders }, () => [advanced, providers, tab]).flat()
}

function reactShim() {
  let call = 0
  return {
    // React hands children to a component *through props*, so the element this
    // produces has to carry them in both places: `props.children` for a
    // function component to read, `children` for the renderer to walk.
    createElement: (type, props, ...children) => {
      const merged = { ...(props ?? {}) }
      const given = children.flat().filter((child) => child !== undefined && child !== null && child !== false)
      if (given.length > 0) merged.children = given.length === 1 ? given[0] : given
      // What React renders as this element's children: the child arguments, or
      // whatever `props.children` already carried when the element was created
      // with none — the shape `createElement(Tag, props)` produces inside a
      // component that merely forwards its props.
      const kids = given.length > 0
        ? given
        : (merged.children === undefined ? [] : [].concat(merged.children))
      return { type, props: merged, children: kids }
    },
    useState: (initial) => [call < useStateValues.length ? useStateValues[call++] : initial, () => {}],
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
}

/** Materialize the bundle the way the client module loader does. */
async function loadBundle() {
  const source = await readFile(CLIENT_PATH, 'utf8')
  let registered
  const previousWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        registered = entry
      },
    },
  }
  try {
    // The bundle is a classic script assigning onto `window`, not a module.
    const run = new Function('window', 'require', source)
    const react = reactShim()
    run(globalThis.window, (name) => {
      if (name === 'react') return react
      throw new Error(`the bundle must not require ${name}`)
    })
  } finally {
    globalThis.window = previousWindow
  }
  assert.ok(registered, 'the bundle registered no module')
  return { entry: registered, react: reactShim() }
}

/** A browser context covering the three services the card injects. */
function browserContext({ locale = 'zh', scopeValue: scopeOverride } = {}) {
  const dictionaries = {}
  const registrations = []
  const injectedSlots = []
  const scopeValue = scopeOverride ?? {
    value: { plan: 'goat', webSearch: false, autoSync: false, enableUsageTool: true, autoSyncIntervalMs: 21_600_000 },
    user: {},
    base: {},
    revision: 1,
  }
  const effects = []
  const requestedEntries = []
  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => dispose?.()
    },
    locale: {
      register(ns, dict) {
        dictionaries[ns] = dict
      },
      // The real `bind` resolves a key through the *active* language pack, so
      // a package registers `{ zh, en }` rather than one flat dictionary.
      bind: (ns) => (key) => {
        const pack = dictionaries[ns]
        const value = pack?.[locale]?.[key]
        return value === undefined ? key : value
      },
      getSnapshot: () => ({ active: locale, revision: 1 }),
    },
    // dsh 0.1.7: the settings service is `configForms`, and it hands out one
    // shared form per host plugin entry id rather than per registered namespace.
    configForms: {
      get(entryId) {
        requestedEntries.push(entryId)
        return {
          entryId,
          getSnapshot: () => scopeValue,
          subscribe: () => () => {},
          set: async () => {},
          unset: async () => {},
        }
      },
    },
    slots: {
      inject(name, callback) {
        injectedSlots.push(name)
        callback()
      },
      register(options, component) {
        // The slot resolves the entry's face and spreads it into the props,
        // which is exactly what rendering the component directly must mimic.
        registrations.push({ slot: options.name, options, component, face: options.inject?.() ?? {} })
        return () => {}
      },
    },
  }
  const context = { ctx, registrations, injectedSlots, dictionaries, effects, scopeValue, requestedEntries }
  liveContexts.push(context)
  return context
}

/**
 * Every string in a rendered element tree, in order.
 *
 * Element objects hold their type unevaluated, so this is a minimal renderer:
 * a function type is called with its props, which is what React would do. That
 * is enough to assert on the copy the card produces without a DOM.
 */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(textOf)
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return textOf(node.children ?? [])
}

/** Wait for the card's initial bridge reads to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The `require` a factory receives: react, and the shell's controls when asked. */
function requireFor(react, primitives) {
  return (name) => {
    if (name === 'react') return react
    if (name === '@deepseek-ai/dsh-client-ui-primitives' && primitives !== undefined) return primitives
    throw new Error(`the bundle must not require ${name}`)
  }
}

/**
 * A stand-in for the shell's control set. Each control renders a host element
 * of its own tag so a test can find it and read the props it was handed.
 *
 * The icon names are the real ones the primitives package exports — the card
 * used to ask for `…Outline16`, which no build has ever shipped, so every icon
 * silently resolved to undefined and the card drew text-only buttons. A shell
 * with no icon at all is covered by the fallback path (the other tests), and the
 * legacy spelling has its own test below.
 */
function primitivesShim(react) {
  const control = (tag) => (props) => react.createElement(tag, props)
  return {
    Button: control('x-button'),
    Tag: control('x-tag'),
    Switch: control('x-switch'),
    Input: control('x-input'),
    Pill: control('x-pill'),
    SegmentedControl: control('x-segmented'),
    SegmentedTabs: control('x-tabs'),
    IconRefreshOutlineRegular: control('x-icon-refresh'),
    IconWarningOutlineRegular: control('x-icon-warning'),
    IconCheckOutlineRegular: control('x-icon-check'),
  }
}

/** Every element of one host tag in a rendered tree. */
function findAll(node, tag, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, tag, found)
    return found
  }
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (node.type === tag) {
    found.push(node)
    return found
  }
  if (typeof node.type === 'function') {
    findAll(node.type(node.props), tag, found)
    return found
  }
  return findAll(node.children ?? [], tag, found)
}

/** Every element carrying one class, so a test can find a block by its role. */
function findByClass(node, className, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) findByClass(child, className, found)
    return found
  }
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (typeof node.props?.className === 'string' && node.props.className.split(' ').includes(className)) {
    found.push(node)
  }
  if (typeof node.type === 'function') {
    findByClass(node.type(node.props), className, found)
    return found
  }
  return findByClass(node.children ?? [], className, found)
}

describe('bundle shape', () => {
  it('registers under the package name and injects only the services it uses', async () => {
    const { entry } = await loadBundle()
    // The bundle's module id is its package name; the settings *section* it
    // edits is the entry id above, which is a different string.
    assert.equal(entry.id, 'dsh-commandcode-goat')
    assert.equal(typeof entry.factory, 'function')
    const exports = entry.factory(() => reactShim())
    assert.deepEqual(exports.inject, ['slots', 'locale', 'configForms'])
    assert.equal(typeof exports.apply, 'function')
  })

  it('registers into every plugin seat this build offers', async () => {
    const { entry } = await loadBundle()
    const exports = entry.factory((name) => {
      assert.equal(name, 'react')
      return reactShim()
    })
    const { ctx, registrations, injectedSlots } = browserContext()
    exports.apply(ctx)

    // `settings.plugins.tab` is the tab in Settings → Plugins; `plugins.item`
    // is the card in the Plugins sidebar panel's official group; the last two
    // are the seats the panel added for a bundle's *own* configuration, opened
    // from the bundle's card or from the 配置 control on its row. A card that
    // registers only the first two is reachable but not where the panel looks,
    // which is how a plugin ends up installed and apparently inert.
    const seats = ['settings.plugins.tab', 'plugins.item', 'plugins.bundle.config', 'plugins.row.config']
    assert.deepEqual(injectedSlots, seats)
    assert.deepEqual(registrations.map((entry_) => entry_.slot), seats)

    const [tab, item, bundle, row] = registrations
    // The list seats are keyed by the registration id; the configuration seats
    // by the strings the Plugins page addresses them with — the bundle by its
    // npm package name, the row by `<package name>#<row id>`.
    assert.equal(tab.options.id, NS)
    assert.equal(item.options.id, NS)
    assert.equal(bundle.options.key, 'dsh-commandcode-goat')
    assert.equal(row.options.key, 'dsh-commandcode-goat#commandcode-goat')
    // The row id in that key is the one this bundle's patch declares, so a
    // profile that renames the row breaks the address in exactly one place.
    assert.equal(row.options.key, `dsh-commandcode-goat#${NS}`)

    for (const registration of registrations) {
      assert.equal(registration.options.name, registration.slot)
      assert.equal(registration.options.locale, NS)
      assert.equal(typeof registration.options.order, 'number')
      assert.equal(typeof registration.options.label, 'function')
      assert.equal(typeof registration.component, 'function')
    }
    assert.equal(tab.options.label(), 'Command Code')
    assert.equal(item.options.label(), 'Command Code 订阅接入')

    // The settings tab always renders the page; every panel seat answers both
    // views it is dispatched with.
    assert.match(textOf(tab.component({ ...tab.face })).join(' '), /订阅档位/)
    for (const seat of [item, bundle, row]) {
      assert.match(textOf(seat.component({ view: 'summary', ...seat.face })).join(' '), /尚未创建供应商/)
      assert.match(textOf(seat.component({ view: 'page', ...seat.face })).join(' '), /订阅档位/)
    }
  })

  it('no longer uses the slot this build removed', async () => {
    const { entry } = await loadBundle()
    const exports = entry.factory(() => reactShim())
    const { ctx, injectedSlots } = browserContext()
    exports.apply(ctx)
    assert.equal(injectedSlots.includes('settings.plugin.item'), false)
  })

  it('registers both dictionaries for the active locale to choose from', async () => {
    const { entry } = await loadBundle()
    const exports = entry.factory(() => reactShim())
    const { ctx, dictionaries } = browserContext()
    exports.apply(ctx)
    assert.deepEqual(Object.keys(dictionaries[NS]), ['zh', 'en'])
    assert.equal(dictionaries[NS].en.title, 'Command Code subscription')
  })

  it('labels the card in the deployment\u2019s language', async () => {
    const { entry } = await loadBundle()
    const exports = entry.factory(() => reactShim())
    const { ctx, registrations } = browserContext({ locale: 'en' })
    exports.apply(ctx)
    const tab = registrations.find((entry_) => entry_.slot === 'settings.plugins.tab')
    assert.equal(tab.options.label(), 'Command Code')
    const item = registrations.find((entry_) => entry_.slot === 'plugins.item')
    assert.equal(item.options.label(), 'Command Code subscription')
  })
})

describe('rendering', () => {
  /**
   * Mount the card and answer its bridge calls from `responses`, leaving the
   * fetch stub installed so a test can drive a control that talks to the host
   * and read back the request it made. The caller restores `globalThis.fetch`.
   */
  async function mountWithCalls(responses) {
    const { entry, react } = await loadBundle()
    const exports = entry.factory(() => react)
    const { ctx, registrations } = browserContext()
    const calls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, options) => {
      const path = String(url).replace('/api/dsh-commandcode-goat', '')
      calls.push({ path, body: options?.body })
      const body = responses[path]
      if (body === undefined) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ ok: true, value: body }) }
    }
    try {
      exports.apply(ctx)
      await settle()
    } catch (error) {
      globalThis.fetch = originalFetch
      throw error
    }
    return { registrations, calls, originalFetch }
  }

  /** Mount for a test that only reads the rendered tree. */
  async function mount(responses) {
    const mounted = await mountWithCalls(responses)
    globalThis.fetch = mounted.originalFetch
    return mounted.registrations
  }

  /** The Settings tab's component and the face the slot would pass it. */
  const settingsTab = (registrations) => registrations.find((entry_) => entry_.slot === 'settings.plugins.tab')
  /** The sidebar panel's entry, which is dispatched per view. */
  const panelItem = (registrations) => registrations.find((entry_) => entry_.slot === 'plugins.item')

  /**
   * The four tiers, verbatim from the frozen 0.7.0 bridge contract: quota and
   * documentation per tier, which tier the config is on, and which tier the
   * account's own subscription maps to.
   */
  const TIERS = [
    {
      plan: 'go',
      title: 'Go',
      provider: 'Command | go',
      docURL: 'https://commandcode.ai/docs/plans/go',
      variants: [{ label: 'Go', price: 1, fiveHour: 3, weekly: 6, monthly: 10 }],
      models: 53,
      live: 53,
      selected: false,
      subscribed: false,
      source: null,
      routes: [],
    },
    {
      plan: 'goat',
      title: 'GOAT',
      provider: 'Command | goat',
      docURL: 'https://commandcode.ai/docs/plans/goat',
      variants: [{ label: 'GOAT', price: 10, fiveHour: 14, weekly: 35, monthly: 70 }],
      models: 43,
      live: 43,
      selected: true,
      subscribed: true,
      source: 'organization',
      routes: ['openai'],
    },
    {
      plan: 'pro',
      title: 'Pro',
      provider: 'Command | pro',
      docURL: 'https://commandcode.ai/docs/plans/pro',
      variants: [{ label: 'Pro', price: 20, fiveHour: 16, weekly: 40, monthly: 80 }],
      models: 61,
      live: 60,
      selected: false,
      subscribed: false,
      source: null,
      routes: [],
    },
    {
      plan: 'max',
      title: 'Max',
      provider: 'Command | max',
      docURL: 'https://commandcode.ai/docs/plans/max',
      // Two sizes, so the card cannot describe Max with one figure alone.
      variants: [
        { label: 'Max 10×', price: 100, fiveHour: 45, weekly: 90, monthly: 150, premiumMonthly: 100 },
        { label: 'Max 20×', price: 200, fiveHour: 90, weekly: 180, monthly: 300, premiumMonthly: 200 },
      ],
      // Nobody has synced yet in this fixture, so both counts are null.
      models: null,
      live: null,
      selected: false,
      subscribed: false,
      source: null,
      routes: [],
    },
  ]
  const DESCRIBE = {
    entryId: 'commandcode-goat',
    version: '0.7.0',
    plan: 'goat',
    plans: ['go', 'goat', 'pro', 'max'],
    apiKeyEnv: 'COMMANDCODE_API_KEY',
    usageBaseURL: 'https://api.commandcode.ai',
    hasKey: true,
    keySource: 'environment',
    writable: true,
    targets: {
      openai: { key: 'commandcode-goat-autosync', slot: 'openai', channel: 'AutoSync', api: 'openai-completions', created: true, models: 43, displayName: 'Command | goat' },
      anthropic: { key: 'commandcode-goat-anthropic', slot: 'anthropic', channel: 'Anthropic', api: '', created: false, models: 0, displayName: 'Command | goat · Claude' },
      responses: { key: 'commandcode-goat-responses', slot: 'responses', channel: 'Responses', api: '', created: false, models: 0, displayName: 'Command | goat · Responses' },
    },
    tiers: TIERS,
    subscription: {
      plan: 'goat',
      title: 'GOAT',
      planId: 'individual-goat',
      status: 'active',
      source: 'organization',
      personalPlanId: 'individual-goat',
      organizationPlanId: 'individual-goat',
    },
    stale: [],
    search: { registered: true, enabled: false },
  }
  /** One route another tier left behind, as `describe.stale` states it. */
  const STALE = { key: 'commandcode-pro-autosync', plan: 'pro', slot: 'openai', models: 72 }
  const USAGE = {
    failures: [],
    account: { id: 'u1', userName: 'ada' },
    plan: { name: 'GOAT', status: 'active' },
    usage: { completedCount: 38, totalCount: 40, successRate: 0.95, totalCost: 1.25, totalTokensIn: 1000, totalTokensOut: 20, totalCredits: 0.014761747, totalMonthlyCredits: 0.014761747, periodBasis: 'billing-period' },
    // Both rolling windows, with distinct figures: a fixture that carried only
    // one of them left the weekly row untested and made an ordering assertion
    // pass for the wrong reason.
    credits: {
      monthlyCredits: 69.985238253,
      purchasedCredits: 0,
      freeCredits: 0,
      fiveHour: { used: 12, cap: 60, exceeded: false },
      weekly: { used: 6, cap: 60, exceeded: false },
    },
    raw: { usage: { totalCount: 40 }, credits: { windowLimits: { fiveHour: { cap: 60 } } } },
  }

  it('summarizes the generated providers in the summary view', async () => {
    const { component, face } = panelItem(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
    const text = textOf(component({ view: 'summary', ...face })).join('')
    assert.match(text, /GOAT/)
    assert.match(text, /43/)
  })

  it('says so when nothing has been created yet', async () => {
    const empty = { ...DESCRIBE, targets: Object.fromEntries(Object.entries(DESCRIBE.targets).map(([route, target]) => [route, { ...target, created: false, models: 0 }])) }
    const { component, face } = panelItem(await mount({ '/describe': empty, '/usage': USAGE }))
    const text = textOf(component({ view: 'summary', ...face })).join('')
    assert.match(text, /尚未创建供应商/)
  })

  it('renders the page view with the tier selector, targets and usage', async () => {
    const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
    const text = textOf(component({ view: 'page', ...face })).join(' ')
    assert.match(text, /订阅档位/)
    // The provider names are detail and sit behind a disclosure; what leads is
    // how many models the tier produced.
    assert.match(text, /已获取 43 个模型/)
    assert.doesNotMatch(text, /commandcode-goat-autosync/)
    assert.match(text, /创建 \/ 更新/)
    assert.match(text, /账户用量/)
    assert.match(text, /ada/)
    assert.match(text, /已用 \$12 \/ 上限 \$60/)
    assert.match(text, /用本账户提供 web_search/)
    assert.match(text, /原始响应/)
  })

  /** The tabs of the merged provider card, in strip order. */
  const tabsOf = (tree) => findAll(tree, 'button').filter((node) => node.props.role === 'tab')
  /** The tier cards, in the order the host stated them. */
  const tierNodes = (tree) => findByClass(tree, 'ccg-tier')

  it('renders one provider card with a tab per protocol, not a row per slot', async () => {
    useStateValues = statesFor([false, true, null])
    try {
      const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
      const tree = component({ ...face })
      const text = textOf(tree).join(' ')

      // The provider is named once, above the strip: the two routes used to be
      // two rows whose keys differed by a suffix the reader had to decode.
      assert.match(text, /Command \| goat/)
      assert.deepEqual(tabsOf(tree).map((node) => textOf(node).join('')), ['AutoSync', 'Anthropic', 'Responses'])
      // The selected panel states that one route: its key, its protocol, its
      // state and its model count.
      assert.match(text, /commandcode-goat-autosync/)
      assert.match(text, /openai-completions/)
      assert.match(text, /已创建/)
      assert.match(text, /43 个模型/)
      assert.match(text, /API 密钥配置在生成的供应商上/)
      // The other slots are behind their own tab, not printed as extra rows.
      assert.doesNotMatch(text, /commandcode-goat-anthropic/)
      assert.doesNotMatch(text, /commandcode-goat-responses/)
    } finally {
      useStateValues = []
    }
  })

  it('restates the selected tier’s figures where its routes are listed', async () => {
    // The options section compares all four tiers; the targets section repeats
    // the one in use, beside the keys it produced, and no other — a second copy
    // of the other three would be the duplication this card exists to remove.
    useStateValues = statesFor([false, true, null])
    try {
      const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
      const tree = component({ ...face })
      const targets = findByClass(tree, 'ccg-card').find((node) => findByClass(node, 'ccg-provider').length > 0)
      assert.ok(targets !== undefined, 'the targets disclosure is open')
      const inTargets = findByClass(targets, 'ccg-tier')
      assert.equal(inTargets.length, 1)
      const text = textOf(inTargets[0]).join(' ')
      assert.match(text, /GOAT/)
      assert.match(text, /Command \| goat/)
      // Its documentation link and its default quota come with it.
      assert.deepEqual(findAll(inTargets[0], 'a').map((node) => node.props.href), ['https://commandcode.ai/docs/plans/goat'])
      assert.match(text, /\$70/)
      // The tier in use needs no switch button: it is already the one selected.
      assert.deepEqual(findAll(inTargets[0], 'button'), [])
    } finally {
      useStateValues = []
    }
  })

  it('shows one protocol at a time, on the tab the reader selected', async () => {
    useStateValues = statesFor([false, true, 'anthropic'])
    try {
      const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
      const text = textOf(component({ ...face })).join(' ')
      assert.match(text, /commandcode-goat-anthropic/)
      assert.match(text, /未创建/)
      assert.doesNotMatch(text, /commandcode-goat-autosync/)
      // A route that does not exist states no protocol and no model count: the
      // host writes both when it writes the route, and a zero here would read
      // as a route that exists and serves nothing.
      assert.doesNotMatch(text, /openai-completions/)
      assert.doesNotMatch(text, /0 个模型/)
    } finally {
      useStateValues = []
    }
  })

  it('still names a route from a host too old to describe its targets', async () => {
    // A 0.6.x host reports a slot's state without a key or a protocol. The card
    // falls back to the key this plugin would write rather than rendering a
    // blank where the key belongs.
    const describe = { ...DESCRIBE, tiers: undefined, plans: undefined, targets: { openai: { created: false, models: 0 } } }
    useStateValues = statesFor([false, true, null])
    try {
      const { component, face } = settingsTab(await mount({ '/describe': describe, '/usage': USAGE }))
      const tree = component({ ...face })
      const text = textOf(tree).join(' ')
      assert.equal(textOf(findByClass(tree, 'ccg-providerName')[0]).join(''), 'Command | goat')
      assert.match(text, /commandcode-goat-autosync/)
      assert.match(text, /未创建/)
      // Nothing invented about a route the host has not written.
      assert.doesNotMatch(text, /openai-completions/)
    } finally {
      useStateValues = []
    }
  })

  it('keeps the tabs reachable from the keyboard, not only by pointer', async () => {
    useStateValues = statesFor([false, true, null])
    try {
      const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
      const tabs = tabsOf(component({ ...face }))
      assert.equal(tabs.length, 3)
      for (const tab of tabs) {
        assert.equal(tab.props.role, 'tab')
        assert.equal(typeof tab.props['aria-selected'], 'boolean')
        assert.equal(typeof tab.props.onClick, 'function')
        assert.equal(typeof tab.props.onKeyDown, 'function')
      }
      // Exactly the selected tab is in the tab order, which is what a tablist
      // means: Tab leaves the strip, the arrow keys move inside it.
      assert.deepEqual(tabs.map((tab) => tab.props['aria-selected']), [true, false, false])
      assert.deepEqual(tabs.map((tab) => tab.props.tabIndex), [0, -1, -1])
    } finally {
      useStateValues = []
    }
  })

  it('tells a reader to restart when the host cannot describe tiers at all', async () => {
    // The card is re-read from disk on every page load; the host half only when
    // the process starts. So after an update the card can be newer than the host
    // serving it, and a host from before this feature answers with `plans` and
    // no `tiers` at all. "Wait for the first sync" would then be a promise no
    // sync can keep, and the reader goes looking for a problem that is a restart.
    // Verbatim what a 0.6.1 host answers, read off the running process: no
    // `tiers`, three plans, and targets without a channel or a protocol.
    const old = {
      ...DESCRIBE,
      version: '0.6.1',
      tiers: undefined,
      plans: ['goat', 'pro', 'max'],
      targets: {
        openai: { key: 'commandcode-goat-autosync', created: true, models: 74 },
        anthropic: { key: 'commandcode-goat-anthropic', created: true, models: 10 },
        responses: { key: 'commandcode-goat-responses', created: false, models: 0 },
      },
    }
    const { component, face } = settingsTab(await mount({ '/describe': old, '/usage': USAGE }))
    const tree = component({ ...face })
    const text = textOf(tree).join(' ')

    assert.match(text, /宿主半侧还是 v0\.6\.1 的进程/)
    assert.doesNotMatch(text, /要等第一次同步读过目录才知道/)
    // The tiers it can name are still listed, with their provider names and
    // their switch buttons; only the figures that need the newer host are gone.
    const tiers = tierNodes(tree)
    assert.deepEqual(tiers.map((tier) => textOf(tier)[0]), ['GOAT', 'Pro', 'Max'])
    assert.deepEqual(tiers.map((tier) => textOf(tier)[1]), ['Command | goat', 'Command | pro', 'Command | max'])
  })

  it('describes every tier with its quota, its models and its documentation', async () => {
    const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
    const tree = component({ ...face })
    const text = textOf(tree).join(' ')

    const tiers = tierNodes(tree)
    assert.equal(tiers.length, 4, 'one card per tier the host described')
    for (const [index, tier] of tiers.entries()) {
      const tierText = textOf(tier).join(' ')
      assert.ok(tierText.includes(TIERS[index].title), `${TIERS[index].plan} is titled`)
      assert.ok(tierText.includes(TIERS[index].provider), `${TIERS[index].plan} names its provider`)
    }

    // Max is sold as two sizes, so the card states both rather than describing
    // a plan the reader may not be on.
    assert.match(text, /Max 10×/)
    assert.match(text, /Max 20×/)
    assert.match(text, /\$100 \/ 月/)
    assert.match(text, /\$200 \/ 月/)
    // The figures behind the price, each under its own name.
    assert.match(text, /月费 \$10 \/ 月/)
    assert.match(text, /5 小时窗口 \$14/)
    assert.match(text, /每周窗口 \$35/)
    assert.match(text, /月度余额 \$70/)
    assert.match(text, /高级额度 \$100/)
    // A tier nobody has synced yet says so instead of printing a zero.
    assert.match(text, /这档有多少模型，要等第一次同步读过目录才知道。/)
    assert.match(text, /43 个模型，其中 43 个在线/)

    // The citation is what makes the quota checkable.
    assert.match(text, /档位说明/)
    const links = findAll(tree, 'a')
    assert.deepEqual(links.map((node) => node.props.href), TIERS.map((tier) => tier.docURL))
    for (const link of links) {
      assert.equal(link.props.target, '_blank')
      assert.equal(link.props.rel, 'noreferrer')
    }
  })

  it('marks the tier in use and the tier the account pays for', async () => {
    const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
    const [go, goat, pro] = tierNodes(component({ ...face }))
    assert.match(textOf(goat).join(' '), /当前档位/)
    assert.match(textOf(goat).join(' '), /账户订阅（组织）/)
    for (const tier of [go, pro]) {
      assert.doesNotMatch(textOf(tier).join(' '), /当前档位/)
      assert.doesNotMatch(textOf(tier).join(' '), /账户订阅/)
    }
  })

  it('offers a switch per tier, and never switches from the card body', async () => {
    const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
    const [go, goat, pro, max] = tierNodes(component({ ...face }))

    // The body is not a control: the pills above remain the only way to stage a
    // tier, so clicking the figures cannot change the configuration they state.
    for (const tier of [go, goat, pro, max]) assert.equal(tier.props.onClick, undefined)

    const buttonIn = (tier) => findAll(tier, 'button')[0]
    assert.equal(buttonIn(goat), undefined, 'the configured tier needs no switch to itself')
    for (const tier of [go, pro, max]) {
      assert.equal(textOf(buttonIn(tier)).join(''), '切换到此档位')
    }

    buttonIn(pro).props.onClick()
    assert.equal(face.store.getSnapshot().fields.plan, 'pro')
    assert.equal(face.store.getSnapshot().dirty, true)
  })

  it('names the account\u2019s own tier when the config writes another one', async () => {
    // The state this card exists to explain: the account is subscribed to Pro,
    // the plugin writes GOAT, and nothing is broken.
    const describe = {
      ...DESCRIBE,
      subscription: { ...DESCRIBE.subscription, plan: 'pro', title: 'Pro', source: 'personal' },
      tiers: TIERS.map((tier) => ({
        ...tier,
        selected: tier.plan === 'goat',
        subscribed: tier.plan === 'pro',
        source: tier.plan === 'pro' ? 'personal' : null,
      })),
    }
    const { component, face } = settingsTab(await mount({ '/describe': describe, '/usage': USAGE }))
    const tree = component({ ...face })
    const text = textOf(tree).join(' ')

    // The header states the account's plan and which subscription it is.
    assert.match(text, /Pro（个人）/)
    // And one line names both, so the reader does not have to diff them.
    assert.match(text, /账户订阅是 Pro 档，插件当前写的是 GOAT 档/)

    const notice = findByClass(tree, 'ccg-notice')
      .find((node) => textOf(node).join(' ').includes('账户订阅是'))
    const switchButton = findAll(notice, 'button')[0]
    assert.equal(textOf(switchButton).join(''), '切回账户订阅的档位')
    switchButton.props.onClick()
    assert.equal(face.store.getSnapshot().fields.plan, 'pro')

    // The Pro card carries the tag that says why its button reads differently.
    const pro = tierNodes(tree).find((tier) => textOf(tier).join(' ').includes('Command | pro'))
    assert.match(textOf(pro).join(' '), /账户订阅（个人）/)
  })

  it('stays silent about a subscription that could not be read', async () => {
    const describe = {
      ...DESCRIBE,
      subscription: null,
      // Nothing is subscribed in this fixture either, so any remaining
      // subscription wording would be the card inventing one.
      tiers: TIERS.map((tier) => ({ ...tier, subscribed: false, source: null })),
    }
    const { component, face } = settingsTab(await mount({ '/describe': describe, '/usage': USAGE }))
    const text = textOf(component({ ...face })).join(' ')
    assert.doesNotMatch(text, /账户订阅/)
    assert.doesNotMatch(text, /（组织）/)
    assert.doesNotMatch(text, /（个人）/)
  })

  it('lists the routes another tier left behind, above the provider card', async () => {
    useStateValues = statesFor([false, true, null])
    try {
      const describe = { ...DESCRIBE, stale: [STALE] }
      const { component, face } = settingsTab(await mount({ '/describe': describe, '/usage': USAGE }))
      const text = textOf(component({ ...face })).join(' ')
      assert.match(text, /其他档位的残留路由/)
      assert.match(text, /commandcode-pro-autosync/)
      assert.match(text, /属于 Pro 档/)
      assert.match(text, /72 个模型/)
      // Above the merged card: the leftovers are what the reader came down here
      // to find. The tier cards higher up name their providers too, so the
      // comparison starts at the leftover block rather than at the whole page.
      const staleAt = text.indexOf('其他档位的残留路由')
      assert.ok(staleAt >= 0)
      assert.ok(text.indexOf('Command | goat', staleAt) > staleAt)
    } finally {
      useStateValues = []
    }
  })

  it('says there is nothing stale rather than drawing an empty block', async () => {
    useStateValues = statesFor([false, true, null])
    try {
      const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
      const tree = component({ ...face })
      assert.match(textOf(tree).join(' '), /没有其他档位的残留路由/)
      assert.equal(findByClass(tree, 'ccg-stale').length, 0)
    } finally {
      useStateValues = []
    }
  })

  it('clears the leftovers through the bridge, then re-reads the routes', async () => {
    useStateValues = statesFor([false, true, null])
    const mounted = await mountWithCalls({
      '/describe': { ...DESCRIBE, stale: [STALE] },
      '/usage': USAGE,
      '/prune': { plan: 'goat', removed: ['commandcode-pro-autosync'], kept: ['commandcode-goat-autosync'] },
    })
    try {
      const tab = mounted.registrations.find((entry_) => entry_.slot === 'settings.plugins.tab')
      const prune = findAll(tab.component({ ...tab.face }), 'button')
        .find((node) => textOf(node).join('') === '清理残留')
      assert.ok(prune, 'the leftover block offers a way to clear it')

      await prune.props.onClick()
      await settle()
      const call = mounted.calls.find((entry_) => entry_.path === '/prune')
      assert.ok(call, 'the button posts to /prune')
      // No plan travels with it: the host removes what its own config calls
      // stale, not what this card has staged and not saved.
      assert.deepEqual(JSON.parse(call.body), {})
      assert.deepEqual(tab.face.store.getSnapshot().prune.result?.removed, ['commandcode-pro-autosync'])
      // The list that justified the button is the thing that just changed, so
      // the status is re-read rather than kept.
      assert.ok(mounted.calls.filter((entry_) => entry_.path === '/describe').length >= 2)
    } finally {
      useStateValues = []
      globalThis.fetch = mounted.originalFetch
    }
  })

  it('states every quota as a percentage with the figures behind it', async () => {
    const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
    const text = textOf(component({ ...face })).join(' ')
    assert.match(text, /月度余额/)
    // The rolling windows lead and the monthly pool closes the group: the two
    // that move within a day are what the reader checks first.
    assert.ok(text.indexOf('5 小时窗口') < text.indexOf('每周窗口'))
    assert.ok(text.indexOf('每周窗口') < text.indexOf('月度余额'))
    // the monthly pool is a remaining balance, so its share is spent/(spent+left)
    assert.match(text, /0\.02%/)
    // each window states used/cap directly: 12 of 60, and 6 of 60
    assert.match(text, /20%/)
    assert.match(text, /10%/)
    // the figures stay beside the share, rounded rather than at the service's
    // full precision
    assert.match(text, /\$69\.99/)
    assert.doesNotMatch(text, /69\.985238253/)
    assert.match(text, /已用 \$12 \/ 上限 \$60/)

    // Reading order inside one meter: label, its share, then the figures — and
    // the figures are money, because these caps are a fifth and a half of the
    // monthly grant rather than counters of anything.
    assert.ok(text.indexOf('5 小时窗口') < text.indexOf('20%'))
    assert.ok(text.indexOf('20%') < text.indexOf('已用 $12 / 上限 $60'))
    assert.match(text, /可用 \$69\.99 · 本期已用 \$0\.01/)
  })

  it('names both halves of every ratio instead of writing a bare a / b', async () => {
    const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
    const text = textOf(component({ ...face })).join(' ')
    // The request figure is a count, not a share of itself: 40, never 38/40.
    assert.match(text, /本期请求 40/)
    assert.doesNotMatch(text, /38\/40/)
    // The token figure states the total, and says which half is which.
    assert.match(text, /本期 Token 1\.0k/)
    assert.match(text, /输入 1\.0k · 输出 20/)
    // No *unspaced* digit-joined ratio survives anywhere on the panel — the
    // shape that reads as a fraction with an unnamed denominator. The window
    // rows keep a slash, but name both of its sides.
    assert.doesNotMatch(text, /\d+\/\d+/)
  })

  it('carries its own mark and says which build is loaded', async () => {
    const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
    const tree = component({ ...face })
    // The header's mark is the only svg inside the header; the two disclosures
    // draw their own chevrons, so counting every svg on the page would pin the
    // wrong thing.
    const header = findByClass(tree, 'ccg-head')[0]
    const mark = findAll(header, 'svg')
    assert.equal(mark.length, 1, 'the header mark is one inline svg')
    assert.equal(mark[0].props.viewBox, '0 0 24 24')
    assert.equal(mark[0].props['aria-hidden'], 'true')
    // And the disclosures draw a glyph rather than typing one: `▸`/`▾` are font
    // dependent and are a tofu box on a platform whose UI font lacks them.
    assert.equal(findByClass(tree, 'ccg-disclosureMark').length, 2)
    assert.match(textOf(tree).join(' '), /v0\.7\.0/)
  })

  it('treats a host that cannot name its build as the stale host it is', async () => {
    // The bridge never omits `version`: it forwards the host's own, which falls
    // back to the literal string `unknown`. Reading only an absent field as
    // stale left the restart notice unreachable and printed `vunknown` — a
    // version number that is not one — in exactly the state the notice explains.
    const unknown = { ...DESCRIBE, version: 'unknown' }
    const { component, face } = settingsTab(await mount({ '/describe': unknown, '/usage': USAGE }))
    const text = textOf(component({ ...face })).join(' ')
    assert.match(text, /宿主半侧没有上报版本/)
    assert.match(text, /v\?/)
    assert.doesNotMatch(text, /vunknown/)
  })

  it('says a refused status read out loud instead of drawing an empty card', async () => {
    // `state.statusError` used to live only inside the collapsed providers
    // disclosure, so a failed POST /describe read as "no provider created yet".
    const { component, face } = settingsTab(await mount({ '/usage': USAGE }))
    const text = textOf(component({ ...face })).join(' ')
    assert.match(text, /错误: HTTP 404/)
  })

  it('heads a failed usage read with a sentence, not with a function', async () => {
    // Two entries were written under `usageFailed`: the message and a counter.
    // The counter won, so this headline interpolated a *function* and printed
    // its source over the panel — in the commonest first-run state there is,
    // an account with no key stored yet.
    const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE }))
    const text = textOf(component({ ...face })).join(' ')
    assert.match(text, /读取失败: HTTP 404/)
    assert.doesNotMatch(text, /=>/)
  })

  it('reads an absent sweep setting the way the host does', async () => {
    // `pruneOtherPlans` defaults to on in the host schema; a card that read the
    // same absent field as off would draw the switch unset while the host kept
    // deleting the previous tier's routes.
    const { entry, react } = await loadBundle()
    const exports = entry.factory(requireFor(react, primitivesShim(react)))
    const { ctx, registrations } = browserContext({
      scopeValue: { value: { plan: 'goat' }, user: {}, base: {}, revision: 1 },
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      const path = String(url).replace('/api/dsh-commandcode-goat', '')
      return { ok: true, status: 200, json: async () => ({ ok: true, value: path === '/describe' ? DESCRIBE : USAGE }) }
    }
    try {
      exports.apply(ctx)
      await settle()
      const tab = registrations.find((entry_) => entry_.slot === 'settings.plugins.tab')
      const sweep = findAll(tab.component({ ...tab.face }), 'x-switch')
        .find((node) => node.props.label === '切档后清理其他档位的路由')
      assert.ok(sweep, 'the sweep has a switch of its own')
      assert.equal(sweep.props.checked, true, 'absent means on')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('labels every advanced control, and keeps its hint with it', async () => {
    const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
    useStateValues = statesFor([true, false, null])
    try {
      const tree = component({ ...face })
      const labels = findAll(tree, 'label')
      const ids = labels.map((node) => node.props.htmlFor)
      assert.ok(ids.length >= 6, 'every advanced field has a real label')
      for (const id of ids) assert.match(id, /^ccg-field-/)
      // The extra-ids sentence describes the extra-ids box, so it sits under it
      // rather than under all six fields as a section footnote.
      const extra = findByClass(tree, 'ccg-fieldHint')
      assert.equal(extra.length, 1)
      assert.equal(extra[0].props.id, 'ccg-field-extraIds-hint')
      assert.match(textOf(extra[0]).join(''), /逗号或换行分隔/)
      assert.equal(labels.find((node) => node.props.htmlFor === 'ccg-field-extraIds').props.children, '额外模型 ID')
    } finally {
      useStateValues = []
    }
  })

  it('offers an interval the composition states even when it is not a preset', async () => {
    // A controlled select whose value matches no option silently shows the first
    // one, so a profile syncing every fifteen minutes would read as "1h".
    const { entry, react } = await loadBundle()
    const exports = entry.factory(requireFor(react, primitivesShim(react)))
    const { ctx, registrations } = browserContext({
      scopeValue: { value: { plan: 'goat', autoSync: true, autoSyncIntervalMs: 900_000 }, user: {}, base: {}, revision: 1 },
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      const path = String(url).replace('/api/dsh-commandcode-goat', '')
      return { ok: true, status: 200, json: async () => ({ ok: true, value: path === '/describe' ? DESCRIBE : USAGE }) }
    }
    try {
      exports.apply(ctx)
      await settle()
      const tab = registrations.find((entry_) => entry_.slot === 'settings.plugins.tab')
      // The interval control is a plain `<select>` in both paths, so it is found
      // by tag rather than through the shell's control set.
      const node = findAll(tab.component({ ...tab.face }), 'select')[0]
      assert.equal(node.props.value, '900000')
      assert.deepEqual(node.props.children.map((option) => option.props.value), [
        '3600000', '10800000', '21600000', '43200000', '86400000', '900000',
      ])
      assert.equal(node.props.children[5].props.children, '15m')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('re-reads the host when the reader asks for a reload', async () => {
    // The header button says "re-read"; it used to re-read only the local draft,
    // so pressing it could not change a pixel unless something was typed.
    const mounted = await mountWithCalls({ '/describe': DESCRIBE, '/usage': USAGE })
    try {
      const tab = mounted.registrations.find((entry_) => entry_.slot === 'settings.plugins.tab')
      const before = mounted.calls.length
      await tab.face.actions.reload()
      const after = mounted.calls.slice(before).map((entry_) => entry_.path)
      assert.ok(after.includes('/describe'), 'a reload asks the host again')
      assert.ok(after.includes('/usage'))
      // Discarding a draft is a different action with its own name: it must not
      // spend a round trip.
      const mark = mounted.calls.length
      tab.face.actions.discard()
      assert.deepEqual(mounted.calls.slice(mark), [])
    } finally {
      globalThis.fetch = mounted.originalFetch
    }
  })

  it('says which leftovers the sweep refused to remove', async () => {
    // A route carrying modelOverrides is a hand edit this plugin will not
    // overwrite. Reporting only the removal count answered "removed 0" while the
    // row the button named was still on screen.
    useStateValues = statesFor([false, true, null])
    const mounted = await mountWithCalls({
      '/describe': { ...DESCRIBE, stale: [STALE] },
      '/usage': USAGE,
      '/prune': { plan: 'goat', removed: [], kept: ['commandcode-goat-autosync'], protected: ['commandcode-pro-autosync'] },
    })
    try {
      const tab = mounted.registrations.find((entry_) => entry_.slot === 'settings.plugins.tab')
      const prune = findAll(tab.component({ ...tab.face }), 'button')
        .find((node) => textOf(node).join('') === '清理残留')
      await prune.props.onClick()
      await settle()
      const text = textOf(tab.component({ ...tab.face })).join(' ')
      assert.match(text, /已清理 0 条残留路由/)
      assert.match(text, /保留了 commandcode-pro-autosync/)
      assert.match(text, /modelOverrides/)
    } finally {
      useStateValues = []
      globalThis.fetch = mounted.originalFetch
    }
  })

  it('warns when the host half is older than the card', async () => {
    // The client half is re-read from disk on every page load; the host half
    // only at boot, so this mismatch is reachable and otherwise looks exactly
    // like "the fix did not work".
    const stale = { ...DESCRIBE }
    delete stale.version
    const { component, face } = settingsTab(await mount({ '/describe': stale, '/usage': USAGE }))
    const text = textOf(component({ ...face })).join(' ')
    assert.match(text, /宿主半侧没有上报版本/)
    assert.match(text, /v\?/)
  })

  it('counts a window reset down from milliseconds, not from seconds', async () => {
    // The API states `resetAt` in epoch milliseconds; reading it as seconds
    // rendered "20694172d 16h 后重置".
    const usage = { ...USAGE, credits: { ...USAGE.credits, fiveHour: { used: 12, cap: 60, exceeded: false, resetAt: Date.now() + 5 * 3600 * 1000 } } }
    const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': usage }))
    const text = textOf(component({ ...face })).join(' ')
    assert.match(text, /[45]h \d+m 后重置/)
    assert.doesNotMatch(text, /\d{6,}d /)
  })

  it('says that a rolling window opens on first use, so its countdown can restart', async () => {
    // These windows are anchored to the first request after the previous one
    // elapsed, not to a fixed clock: without the line, a countdown that starts
    // when someone begins working reads as the card resetting the quota itself.
    const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
    assert.match(textOf(component({ ...face })).join(' '), /窗口由「上一个窗口结束后的第一个请求」开出/)
    // Nothing to explain when the account reports no capped window.
    const noWindows = { ...USAGE, credits: { monthlyCredits: USAGE.credits.monthlyCredits, purchasedCredits: 0, freeCredits: 0 } }
    const bare = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': noWindows }))
    const bareText = textOf(bare.component({ ...bare.face })).join(' ')
    assert.match(bareText, /月度余额/)
    assert.doesNotMatch(bareText, /窗口由/)
  })

  it('states where the key was found instead of contradicting the usage panel', async () => {
    const viaEnvironment = { ...DESCRIBE, keySource: 'environment', apiKeyEnv: 'MY_KEY' }
    const { component, face } = settingsTab(await mount({ '/describe': viaEnvironment, '/usage': USAGE }))
    assert.match(textOf(component({ ...face })).join(' '), /密钥已配置（环境变量）/)
  })

  it('says where it looked when the key really is missing', async () => {
    const missing = { ...DESCRIBE, hasKey: false, keySource: 'none' }
    const { component, face } = settingsTab(await mount({ '/describe': missing, '/usage': USAGE }))
    const text = textOf(component({ ...face })).join(' ')
    assert.match(text, /密钥未配置/)
    assert.match(text, /凭据库和环境变量里都没有找到 COMMANDCODE_API_KEY/)
  })

  it('drives the shell\u2019s own controls when the shell serves them', async () => {
    const { entry, react } = await loadBundle()
    const exports = entry.factory(requireFor(react, primitivesShim(react)))
    const { ctx, registrations } = browserContext()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      const path = String(url).replace('/api/dsh-commandcode-goat', '')
      const value = path === '/describe' ? { ...DESCRIBE, hasKey: false, keySource: 'none' } : USAGE
      return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
    }
    try {
      exports.apply(ctx)
      await settle()
      const tab = registrations.find((entry_) => entry_.slot === 'settings.plugins.tab')
      const tree = tab.component({ ...tab.face })

      // one switch per boolean field, each carrying its own accessible name
      const switches = findAll(tree, 'x-switch')
      assert.equal(switches.length, 5)
      assert.deepEqual(switches.map((node) => node.props.label).sort(), [
        '为推理模型写入思考档位',
        '切档后清理其他档位的路由',
        '注册 commandcode_usage 工具',
        '用本账户提供 web_search',
        '自动创建与同步',
      ])
      for (const node of switches) {
        assert.equal(typeof node.props.onChange, 'function')
        assert.equal(typeof node.props.checked, 'boolean')
      }

      // the tier picker is the shell's own segmented control, not a pill group
      // of the card's invention
      const picker = findAll(tree, 'x-segmented')
      assert.equal(picker.length, 1, 'the picker is the shell segmented control')
      assert.deepEqual(picker[0].props.options.map((option) => option.label), ['Go', 'GOAT', 'Pro', 'Max'])
      assert.deepEqual(picker[0].props.options.map((option) => option.value), ['go', 'goat', 'pro', 'max'])
      assert.equal(picker[0].props.value, 'goat')
      assert.equal(typeof picker[0].props.onChange, 'function')
      assert.equal(findAll(tree, 'x-pill').length, 0, 'no hand-rolled pill group survives')

      // the sync action is the primary button, and a missing key is a danger tag
      const primary = findAll(tree, 'x-button').find((node) => node.props.variant === 'primary')
      assert.ok(primary, 'the sync action is a primary button')
      // the icon travels as a prop, not as a child, so it is asserted on the
      // button that carries it rather than found by walking the tree. Resolving
      // it proves the card asked for a name this shell actually exports: it used
      // to ask for `IconRefreshOutline16`, which exists in no build, so the
      // guard above silently rendered a text-only button.
      const icon = primary.props.icon
      assert.equal(typeof icon?.type, 'function', 'and it carries an icon')
      assert.equal(icon.type(icon.props).type, 'x-icon-refresh', 'the icon is the shell\u2019s own artwork')
      assert.ok(findAll(tree, 'x-tag').some((node) => node.props.tone === 'danger'))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('finds the shell\u2019s icons under the legacy spelling too', async () => {
    // A shell that ever shipped `…Outline16` still gets its icons: the legacy
    // name is the last candidate, not the only one.
    const { entry, react } = await loadBundle()
    const legacy = (props) => react.createElement('x-icon-legacy', props)
    const primitives = { ...primitivesShim(react), IconRefreshOutline16: legacy, IconCheckOutline16: legacy }
    delete primitives.IconRefreshOutlineRegular
    delete primitives.IconCheckOutlineRegular
    const exports = entry.factory(requireFor(react, primitives))
    const { ctx, registrations } = browserContext()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      const path = String(url).replace('/api/dsh-commandcode-goat', '')
      const value = path === '/describe' ? DESCRIBE : USAGE
      return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
    }
    try {
      exports.apply(ctx)
      await settle()
      const tab = registrations.find((entry_) => entry_.slot === 'settings.plugins.tab')
      const tree = tab.component({ ...tab.face })
      assert.ok(findAll(tree, 'x-icon-legacy').length > 0, 'the legacy export is still found')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('draws the tier picker itself when the shell serves no segmented control', async () => {
    // The fallback is not a lesser control: same geometry, same tokens, and the
    // pressed segment is stated to assistive tech.
    const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
    const tree = component({ ...face })
    const group = findByClass(tree, 'ccg-segments')
    assert.equal(group.length, 1)
    assert.equal(group[0].props['aria-label'], '订阅档位')
    const segments = findByClass(tree, 'ccg-segment')
    assert.deepEqual(segments.map((node) => textOf(node).join('')), ['Go', 'GOAT', 'Pro', 'Max'])
    assert.deepEqual(segments.map((node) => node.props['aria-pressed']), [false, true, false, false])
    segments[0].props.onClick()
    assert.equal(face.store.getSnapshot().fields.plan, 'go')
  })

  it('says a refused write instead of claiming the draft was saved', async () => {
    // `set`/`unset` resolve to a boolean — whether the Host accepted the write.
    // Awaiting them and discarding the answer is what let the card print
    // "已保存" over a write that never landed and then put the old values back.
    const { entry, react } = await loadBundle()
    const exports = entry.factory(requireFor(react, primitivesShim(react)))
    const { ctx, registrations, scopeValue } = browserContext({
      scopeValue: {
        value: { plan: 'goat', autoSync: false },
        user: {},
        base: {},
        revision: 1,
      },
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      const path = String(url).replace('/api/dsh-commandcode-goat', '')
      return { ok: true, status: 200, json: async () => ({ ok: true, value: path === '/describe' ? DESCRIBE : USAGE }) }
    }
    try {
      exports.apply(ctx)
      await settle()
      const tab = registrations.find((entry_) => entry_.slot === 'settings.plugins.tab')
      tab.face.actions.edit('plan', 'pro')
      assert.equal(tab.face.store.getSnapshot().dirty, true)
      await tab.face.actions.save()
      const state = tab.face.store.getSnapshot()
      assert.notEqual(state.phase, 'saved', 'a refused write is never "saved"')
      assert.match(String(state.error), /plan/)
      // Nothing moved: the read-back still describes the section as it stands.
      assert.equal(state.fields.plan, 'goat')
      assert.equal(scopeValue.value.plan, 'goat')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  /**
   * The two halves have to agree about an absent `autoSync`, or the card lies.
   *
   * The host reads a missing field as "on", because the whole point of the
   * default is that a fresh install produces the provider row by itself. A card
   * that read the same absent field as "off" would draw the switch unset while
   * the host kept writing routes — the one combination where the user cannot
   * tell which half is wrong.
   */
  it('reads an absent auto-sync setting the way the host does', async () => {
    const { entry, react } = await loadBundle()
    const exports = entry.factory(requireFor(react, primitivesShim(react)))
    // A snapshot from before the default existed: no `autoSync` key at all.
    const { ctx, registrations } = browserContext({
      scopeValue: { value: { plan: 'goat' }, user: {}, base: {}, revision: 1 },
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      const path = String(url).replace('/api/dsh-commandcode-goat', '')
      const value = path === '/describe' ? { ...DESCRIBE, hasKey: false, keySource: 'none' } : USAGE
      return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
    }
    try {
      exports.apply(ctx)
      await settle()
      const tab = registrations.find((entry_) => entry_.slot === 'settings.plugins.tab')
      const autoSync = findAll(tab.component({ ...tab.face }), 'x-switch')
        .find((node) => node.props.label === '自动创建与同步')
      assert.ok(autoSync, 'the auto-sync switch is rendered')
      assert.equal(autoSync.props.checked, true, 'absent means on')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('pure helpers', () => {
  it('are exposed for the card and for these tests', async () => {
    const { entry } = await loadBundle()
    const exports = entry.factory(() => reactShim())
    const { parseIds, percentOf, formatDuration, formatCount, formatMoney, sameList, providerKey, PLANS } = exports.__internals
    assert.deepEqual(parseIds('a, b\nc  '), ['a', 'b', 'c'])
    assert.deepEqual(parseIds(''), [])
    assert.equal(percentOf({ used: 1, cap: 4 }), 25)
    assert.equal(percentOf({ used: 1, cap: 0 }), 0)
    assert.equal(percentOf(undefined), 0)
    assert.equal(formatDuration(45), '45s')
    assert.equal(formatDuration(3 * 3600 + 12 * 60), '3h 12m')
    assert.equal(formatDuration(30 * 3600), '1d 6h')
    assert.equal(formatCount(2_500), '2.5k')
    assert.equal(formatCount(1_500_000), '1.5M')
    assert.equal(formatMoney(1.23456), '$1.23')
    assert.equal(formatMoney(0.1234), '$0.1234')
    assert.equal(sameList([1, 2], [1, 2]), true)
    assert.equal(sameList([1], [1, 2]), false)
    assert.equal(providerKey('goat', 'openai'), 'commandcode-goat-autosync')
    assert.equal(providerKey('goat', 'anthropic'), 'commandcode-goat-anthropic')
    assert.deepEqual(PLANS.map((plan) => plan.value), ['go', 'goat', 'pro', 'max'])
    assert.deepEqual(PLANS.map((plan) => plan.title), ['Go', 'GOAT', 'Pro', 'Max'])
  })

  it('draws one tab per route slot the host reports, in creation order', async () => {
    const { entry } = await loadBundle()
    const exports = entry.factory(() => reactShim())
    const { providerTabs } = exports.__internals
    // The host states the slots and what to call them; the order is ours, so a
    // map that arrives shuffled still reads openai, anthropic, responses.
    const tabs = providerTabs({
      responses: { key: 'commandcode-goat-responses', channel: 'Responses' },
      openai: { key: 'commandcode-goat-autosync', channel: 'AutoSync' },
    })
    assert.deepEqual(tabs.map((tab) => [tab.slot, tab.label]), [['openai', 'AutoSync'], ['responses', 'Responses']])
    // a host that names a slot differently is followed, not overridden
    assert.equal(providerTabs({ openai: { channel: 'Beta' } })[0].label, 'Beta')
    // one too old to send a channel still gets a label, never a raw slot name
    assert.equal(providerTabs({ openai: {} })[0].label, 'AutoSync')
    // a host that reports no targets at all still has three protocols to show
    assert.deepEqual(providerTabs(undefined).map((tab) => tab.slot), ['openai', 'anthropic', 'responses'])
    assert.deepEqual(providerTabs(null).map((tab) => tab.slot), ['openai', 'anthropic', 'responses'])
    // and a slot only that host knows is kept, after the ones we share
    assert.deepEqual(providerTabs({ openai: {}, gemini: {} }).map((tab) => tab.slot), ['openai', 'gemini'])
  })

  it('reads a build number, and knows when there is not one', async () => {
    // The bridge forwards the host's own version, which falls back to the
    // literal string `unknown` rather than to a missing field — so "absent" is
    // not the only unknown state, and treating it as the only one made the
    // restart notice unreachable.
    const { entry } = await loadBundle()
    const exports = entry.factory(() => reactShim())
    const { statusVersion } = exports.__internals
    assert.equal(statusVersion({ version: '0.7.1' }), '0.7.1')
    assert.equal(statusVersion({ version: 'unknown' }), undefined)
    assert.equal(statusVersion({ version: '' }), undefined)
    assert.equal(statusVersion({}), undefined)
    assert.equal(statusVersion(undefined), undefined)
  })

  it('names a tier\u2019s provider from the contract, and derives it without one', async () => {
    const { entry } = await loadBundle()
    const exports = entry.factory(() => reactShim())
    const { providerName, providerDisplayName, planTitle } = exports.__internals
    assert.equal(providerDisplayName('goat', 'openai'), 'Command | goat')
    assert.equal(providerDisplayName('goat', 'anthropic'), 'Command | goat · Claude')
    assert.equal(providerDisplayName('max', 'responses'), 'Command | max · Responses')
    assert.equal(planTitle('goat'), 'GOAT')
    assert.equal(planTitle('it-does-not-exist'), 'it-does-not-exist')

    // the tier card's own provider name leads
    const tiers = [{ plan: 'goat', title: 'GOAT', provider: 'Command | goat' }]
    assert.equal(providerName({ tiers }, 'goat'), 'Command | goat')
    // then the name the routes carry, for a host too old to send `tiers`
    assert.equal(providerName({ targets: { openai: { displayName: 'Command | goat · Claude' } } }, 'goat'), 'Command | goat · Claude')
    // and failing both, the naming rule this module already mirrors
    assert.equal(providerName({}, 'max'), 'Command | max')
  })

  it('renders tier cards from `plans` when the host is too old to send `tiers`', async () => {
    const { entry } = await loadBundle()
    const exports = entry.factory(() => reactShim())
    const { tierList } = exports.__internals
    const tiers = [{ plan: 'go', title: 'Go' }]
    assert.deepEqual(tierList({ tiers }), tiers)
    assert.deepEqual(tierList({ plans: ['go', 'pro'] }).map((tier) => [tier.plan, tier.title]), [['go', 'Go'], ['pro', 'Pro']])
    assert.deepEqual(tierList({ tiers: [] }), [])
    assert.deepEqual(tierList(null), [])
    assert.deepEqual(tierList(undefined), [])
  })

  it('keeps a tier\u2019s quota in one order and drops what the host did not state', async () => {
    const { entry } = await loadBundle()
    const exports = entry.factory(() => reactShim())
    const { tierQuotaRows, tierVariants } = exports.__internals
    // order: the price, the two rolling windows, the monthly pool, the premium
    // half the Max sizes split out
    assert.deepEqual(
      tierQuotaRows({ price: 100, fiveHour: 45, weekly: 90, monthly: 150, premiumMonthly: 100 }).map((row) => row.key),
      ['price', 'fiveHour', 'weekly', 'monthly', 'premiumMonthly'],
    )
    // a figure the host omits is left out rather than printed as a zero
    assert.deepEqual(tierQuotaRows({ price: 10, weekly: 35 }), [{ key: 'price', value: 10 }, { key: 'weekly', value: 35 }])
    assert.deepEqual(tierQuotaRows({ price: null, monthly: 'x' }), [])
    assert.deepEqual(tierQuotaRows(undefined), [])
    // one entry per size, and an entry that is not one is dropped
    assert.deepEqual(tierVariants({ variants: [{ label: 'Max 10×' }, null, { label: 'Max 20×' }] }).map((variant) => variant.label), ['Max 10×', 'Max 20×'])
    assert.deepEqual(tierVariants({}), [])
  })

  it('describes the leftovers of a tier switch without inventing rows', async () => {
    const { entry } = await loadBundle()
    const exports = entry.factory(() => reactShim())
    const { staleRoutes } = exports.__internals
    const rows = staleRoutes([
      { key: 'commandcode-pro-autosync', plan: 'pro', slot: 'openai', models: 72 },
      { key: '', plan: 'go' },
      { plan: 'goat' },
      null,
    ])
    // the tier title travels with the row, so the card never prints the bare
    // plan id and leaves the mapping to the reader
    assert.deepEqual(rows, [{ key: 'commandcode-pro-autosync', plan: 'pro', slot: 'openai', models: 72, title: 'Pro' }])
    assert.deepEqual(staleRoutes(undefined), [])
    assert.deepEqual(staleRoutes([]), [])
  })

  it('knows when the account\u2019s plan and the configured tier disagree', async () => {
    const { entry } = await loadBundle()
    const exports = entry.factory(() => reactShim())
    const { subscriptionMismatch, subscriptionTagText } = exports.__internals
    const goat = { plan: 'goat', title: 'GOAT', source: 'organization' }
    assert.equal(subscriptionMismatch(goat, 'pro'), 'goat')
    assert.equal(subscriptionMismatch(goat, 'goat'), null)
    assert.equal(subscriptionMismatch(null, 'goat'), null)
    // a plan id the host could not map is not a mismatch: the account and the
    // config are not known to disagree, and the card does not guess
    assert.equal(subscriptionMismatch({ title: 'GOAT' }, 'goat'), null)
    assert.equal(subscriptionTagText(null, { subscriptionPersonal: (title) => title }), null)
    assert.equal(subscriptionTagText({ plan: 'goat', title: 'GOAT' }, { subscriptionPersonal: (title) => `${title}!` }), 'GOAT')
  })

  it('formats a share at the precision its magnitude deserves', async () => {
    const { entry } = await loadBundle()
    const exports = entry.factory(() => reactShim())
    const { formatPercent, percentValue } = exports.__internals
    // a quota barely touched must not round away to a flat zero
    assert.equal(formatPercent(percentValue(0.014761747, 70)), '0.02%')
    assert.equal(formatPercent(percentValue(1.5, 14)), '11%')
    assert.equal(formatPercent(percentValue(12, 60)), '20%')
    assert.equal(formatPercent(percentValue(0, 70)), '0%')
    // clamped, because a provider can report a spend past its cap
    assert.equal(formatPercent(percentValue(80, 60)), '100%')
    assert.equal(percentValue(1, 0), 0)
    // the figures beside a quota are trimmed the same way
    // A quota figure is money: whole dollars stay whole, fractions take two
    // places, and something too small for two keeps a third rather than reading
    // as zero.
    const { formatDollars } = exports.__internals
    assert.equal(formatDollars(0.211532321), '$0.21')
    assert.equal(formatDollars(14), '$14')
    assert.equal(formatDollars(66.572462096), '$66.57')
    assert.equal(formatDollars(0.0012), '$0.001')
    assert.equal(formatDollars(undefined), '$0')
  })
})

describe('copy', () => {
  /** The two dictionaries and the field specs the card labels itself from. */
  async function mountCopy() {
    const { entry, react } = await loadBundle()
    const exports = entry.factory(() => react)
    const { ctx, registrations, dictionaries } = browserContext({ locale: 'zh' })
    exports.apply(ctx)
    return { dictionaries, internals: exports.__internals, registrations }
  }

  it('keeps the two languages in step', async () => {
    const { dictionaries } = await mountCopy()
    const [zh, en] = [dictionaries[NS].zh, dictionaries[NS].en]
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
    for (const [key, value] of Object.entries(zh)) {
      assert.equal(typeof value, typeof en[key], `${key} has a different shape in en`)
    }
  })

  it('labels every field with a real entry, never with a raw field name', async () => {
    const { dictionaries, internals } = await mountCopy()
    const zh = dictionaries[NS].zh
    // A missing entry would fall through to the field name, which is what the
    // card would then render on screen — so "the copy resolved" means "the
    // resolved value is not the key that was asked for".
    for (const spec of internals.TEXT_FIELDS) {
      const copy = spec.copy ?? spec.key
      assert.ok(zh[copy] !== undefined, `no copy for text field ${spec.key} (looked up ${copy})`)
      assert.notEqual(zh[copy], copy)
    }
    for (const field of internals.BOOL_FIELDS) {
      const copy = internals.BOOL_COPY[field] ?? field
      assert.ok(zh[copy] !== undefined, `no copy for switch ${field} (looked up ${copy})`)
      assert.notEqual(zh[copy], copy)
    }
  })

  it('uses every boolean field the save loop writes', async () => {
    const { dictionaries, internals } = await mountCopy()
    const zh = dictionaries[NS].zh
    for (const field of internals.BOOL_FIELDS) {
      assert.ok(internals.BOOL_COPY[field] !== undefined, `${field} has no label mapping`)
      assert.ok(zh[internals.BOOL_COPY[field]] !== undefined)
    }
  })

  it('labels every quota figure the tier cards print', async () => {
    const { dictionaries, internals } = await mountCopy()
    const zh = dictionaries[NS].zh
    // A quota row is looked up through this table, so a key without an entry
    // would put its own name on screen beside a dollar figure.
    for (const copy of Object.values(internals.QUOTA_COPY)) {
      assert.ok(zh[copy] !== undefined, `no copy for the ${copy} row`)
      assert.notEqual(zh[copy], copy)
    }
  })

  it('assembles one tier size per line, with the figures the vendor states', async () => {
    const { dictionaries, internals } = await mountCopy()
    const t = dictionaries[NS].zh
    // Max is sold as two sizes: one line each, both on screen.
    assert.equal(
      internals.quotaLine(t, { label: 'Max 10×', price: 100, fiveHour: 45, weekly: 90, monthly: 150, premiumMonthly: 100 }),
      'Max 10× · 月费 $100 / 月 · 5 小时窗口 $45 · 每周窗口 $90 · 月度余额 $150 · 高级额度 $100',
    )
    assert.equal(
      internals.quotaLine(t, { label: 'Max 20×', price: 200, fiveHour: 90, weekly: 180, monthly: 300, premiumMonthly: 200 }),
      'Max 20× · 月费 $200 / 月 · 5 小时窗口 $90 · 每周窗口 $180 · 月度余额 $300 · 高级额度 $200',
    )
    // A tier with no premium pool simply does not mention one.
    assert.equal(
      internals.quotaLine(t, { label: 'GOAT', price: 10, fiveHour: 14, weekly: 35, monthly: 70 }),
      'GOAT · 月费 $10 / 月 · 5 小时窗口 $14 · 每周窗口 $35 · 月度余额 $70',
    )
    assert.equal(internals.quotaLine(t, {}), '')
  })

  it('states a tier\u2019s model count, or says nobody has looked yet', async () => {
    const { dictionaries, internals } = await mountCopy()
    const t = dictionaries[NS].zh
    assert.deepEqual(internals.tierModelLine({ models: 53, live: 53 }, t), { unknown: false, text: '53 个模型，其中 53 个在线' })
    // A host that counts the catalog but not the live list still answers half
    // the question, and says only that half.
    assert.deepEqual(internals.tierModelLine({ models: 53, live: null }, t), { unknown: false, text: '53 个模型' })
    assert.deepEqual(internals.tierModelLine({ models: null, live: null }, t), { unknown: true, text: t.tierModelsUnknown })
  })

  it('names the account\u2019s own plan, and only the part the host read', async () => {
    const { dictionaries, internals } = await mountCopy()
    const t = dictionaries[NS].zh
    assert.equal(internals.subscriptionTagText({ plan: 'goat', title: 'GOAT', source: 'organization' }, t), 'GOAT（组织）')
    assert.equal(internals.subscriptionTagText({ plan: 'goat', title: 'GOAT', source: 'personal' }, t), 'GOAT（个人）')
    // A title the host stated with no source behind it is repeated without a
    // claim about which subscription it is.
    assert.equal(internals.subscriptionTagText({ plan: 'goat', title: 'GOAT' }, t), 'GOAT')
    // A plan id with no title still names the tier the host mapped it to.
    assert.equal(internals.subscriptionTagText({ plan: 'max', source: 'personal' }, t), 'Max（个人）')
  })

  it('tells the reader which tier a leftover route belongs to', async () => {
    const { dictionaries, internals } = await mountCopy()
    const t = dictionaries[NS].zh
    assert.equal(t.staleTier(internals.staleRoutes([{ key: 'commandcode-pro-autosync', plan: 'pro' }])[0].title), '属于 Pro 档')
    assert.equal(t.pruneResult(2), '已清理 2 条残留路由')
    assert.equal(t.subscriptionNotice('GOAT', 'Pro'), '账户订阅是 GOAT 档，插件当前写的是 Pro 档。')
  })
})
