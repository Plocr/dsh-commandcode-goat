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
const NS = 'dsh-commandcode-goat'

/**
 * A React stand-in. The card is rendered by calling it as a plain function in
 * these tests, so the hooks only have to answer once: a state setter that does
 * nothing and a snapshot read that returns what the store holds.
 */
function reactShim() {
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
    useState: (initial) => [initial, () => {}],
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
function browserContext({ locale = 'zh' } = {}) {
  const dictionaries = {}
  const registrations = []
  const injectedSlots = []
  const scopeValue = {
    value: { plan: 'goat', webSearch: false, autoSync: false, enableUsageTool: true, autoSyncIntervalMs: 21_600_000 },
    user: {},
    base: {},
    revision: 1,
  }
  const effects = []
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
    settingsScope: {
      bind: ({ namespace }) => ({
        namespace,
        getSnapshot: () => scopeValue,
        subscribe: () => () => {},
        set: async () => {},
        unset: async () => {},
      }),
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
  const context = { ctx, registrations, injectedSlots, dictionaries, effects, scopeValue }
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
 */
function primitivesShim(react) {
  const control = (tag) => (props) => react.createElement(tag, props)
  return {
    Button: control('x-button'),
    Tag: control('x-tag'),
    Switch: control('x-switch'),
    Input: control('x-input'),
    Pill: control('x-pill'),
    IconRefreshOutline16: control('x-icon-refresh'),
    IconCordisPluginOutline14: control('x-icon-plugin'),
    IconWarningOutline16: control('x-icon-warning'),
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

describe('bundle shape', () => {
  it('registers under the package name and injects only the services it uses', async () => {
    const { entry } = await loadBundle()
    assert.equal(entry.id, NS)
    assert.equal(typeof entry.factory, 'function')
    const exports = entry.factory(() => reactShim())
    assert.deepEqual(exports.inject, ['slots', 'locale', 'settingsScope'])
    assert.equal(typeof exports.apply, 'function')
  })

  it('registers into both plugin seats this build offers', async () => {
    const { entry } = await loadBundle()
    const exports = entry.factory((name) => {
      assert.equal(name, 'react')
      return reactShim()
    })
    const { ctx, registrations, injectedSlots } = browserContext()
    exports.apply(ctx)

    // `settings.plugins.tab` is the tab in Settings → Plugins, `plugins.item`
    // is the page in the Plugins sidebar panel. Registering only the second
    // leaves the plugin reachable but not where it is looked for.
    assert.deepEqual(injectedSlots, ['settings.plugins.tab', 'plugins.item'])
    assert.deepEqual(registrations.map((entry_) => entry_.slot), ['settings.plugins.tab', 'plugins.item'])
    for (const registration of registrations) {
      assert.equal(registration.options.id, NS)
      assert.equal(registration.options.name, registration.slot)
      assert.equal(registration.options.locale, NS)
      assert.equal(typeof registration.options.order, 'number')
      assert.equal(typeof registration.options.label, 'function')
      assert.equal(typeof registration.component, 'function')
    }
    const [tab, item] = registrations
    assert.equal(tab.options.label(), 'Command Code')
    assert.equal(item.options.label(), 'Command Code 订阅接入')
    // The settings tab always renders the page; the panel entry answers both
    // views it is dispatched with.
    assert.match(textOf(tab.component({ ...tab.face })).join(' '), /订阅档位/)
    assert.match(textOf(item.component({ view: 'summary', ...item.face })).join(' '), /尚未创建供应商/)
    assert.match(textOf(item.component({ view: 'page', ...item.face })).join(' '), /订阅档位/)
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
  /** Mount the card and answer its bridge calls from `responses`. */
  async function mount(responses) {
    const { entry, react } = await loadBundle()
    const exports = entry.factory(() => react)
    const { ctx, registrations } = browserContext()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      const path = String(url).replace('/api/dsh-commandcode-goat', '')
      const body = responses[path]
      if (body === undefined) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ ok: true, value: body }) }
    }
    try {
      exports.apply(ctx)
      await settle()
      return registrations
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  /** The Settings tab's component and the face the slot would pass it. */
  const settingsTab = (registrations) => registrations.find((entry_) => entry_.slot === 'settings.plugins.tab')
  /** The sidebar panel's entry, which is dispatched per view. */
  const panelItem = (registrations) => registrations.find((entry_) => entry_.slot === 'plugins.item')

  const DESCRIBE = {
    version: '0.4.0',
    plan: 'goat',
    plans: ['goat', 'pro', 'max'],
    apiKeyEnv: 'COMMANDCODE_API_KEY',
    hasKey: true,
    writable: true,
    targets: {
      openai: { key: 'commandcode-goat-autosync', created: true, models: 43 },
      anthropic: { key: 'commandcode-goat-anthropic', created: false, models: 0 },
      responses: { key: 'commandcode-goat-responses', created: false, models: 0 },
    },
    search: { registered: true, enabled: false },
  }
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
    assert.match(text, /commandcode-goat-autosync/)
    assert.match(text, /创建 \/ 更新/)
    assert.match(text, /账户用量/)
    assert.match(text, /ada/)
    assert.match(text, /已用 12 \/ 上限 60/)
    assert.match(text, /用本账户提供 web_search/)
    assert.match(text, /原始响应/)
  })

  it('states every quota as a percentage with the figures behind it', async () => {
    const { component, face } = settingsTab(await mount({ '/describe': DESCRIBE, '/usage': USAGE }))
    const text = textOf(component({ ...face })).join(' ')
    assert.match(text, /月度额度/)
    // The rolling windows lead and the monthly pool closes the group: the two
    // that move within a day are what the reader checks first.
    assert.ok(text.indexOf('5 小时窗口') < text.indexOf('每周窗口'))
    assert.ok(text.indexOf('每周窗口') < text.indexOf('月度额度'))
    // the monthly pool is a remaining balance, so its share is spent/(spent+left)
    assert.match(text, /0\.02%/)
    // each window states used/cap directly: 12 of 60, and 6 of 60
    assert.match(text, /20%/)
    assert.match(text, /10%/)
    // the figures stay beside the percentage, at two places rather than the
    // service's full precision
    assert.match(text, /69\.99/)
    assert.doesNotMatch(text, /69\.985238253/)
    assert.match(text, /已用 12 \/ 上限 60/)
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
    const svg = findAll(tree, 'svg')
    assert.equal(svg.length, 1, 'the header mark is one inline svg')
    assert.equal(svg[0].props.viewBox, '0 0 24 24')
    assert.match(textOf(tree).join(' '), /v0\.4\.0/)
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
      assert.equal(switches.length, 4)
      assert.deepEqual(switches.map((node) => node.props.label).sort(), [
        '为推理模型写入思考档位',
        '定时自动同步',
        '注册 commandcode_usage 工具',
        '用本账户提供 web_search',
      ])
      for (const node of switches) {
        assert.equal(typeof node.props.onChange, 'function')
        assert.equal(typeof node.props.checked, 'boolean')
      }

      // the tier picker is a pill group with exactly the current tier active
      const pills = findAll(tree, 'x-pill')
      assert.deepEqual(pills.map((node) => node.props.children), ['GOAT', 'Pro', 'Max'])
      assert.deepEqual(pills.map((node) => node.props.active === true), [true, false, false])

      // the sync action is the primary button, and a missing key is a danger tag
      const primary = findAll(tree, 'x-button').find((node) => node.props.variant === 'primary')
      assert.ok(primary, 'the sync action is a primary button')
      // the icon travels as a prop, not as a child, so it is asserted on the
      // button that carries it rather than found by walking the tree
      assert.ok(primary.props.icon !== undefined, 'and it carries an icon')
      assert.ok(findAll(tree, 'x-tag').some((node) => node.props.tone === 'danger'))
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
    assert.deepEqual(PLANS.map((plan) => plan.value), ['goat', 'pro', 'max'])
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
    const { formatAmount } = exports.__internals
    assert.equal(formatAmount(1.51498977), '1.51')
    assert.equal(formatAmount(14), '14')
    assert.equal(formatAmount(0.5), '0.5')
    assert.equal(formatAmount(undefined), '0')
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
})
