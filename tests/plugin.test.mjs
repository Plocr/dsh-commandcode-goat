import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Config, SETTINGS_NS, SYNC_TIMEOUT_MS, apply, normalizeConfig } from '../lib/index.js'

const LLM_PI_AI = 'llm-pi-ai'
const BRIDGE_PREFIX = '/api/dsh-commandcode-goat'

/**
 * A cordis context stand-in, faithful about the four calls this plugin makes:
 * `inject` (only when every named service is present), `get`, `effect`, and
 * service properties on the context itself.
 */
function mockContext(services = {}) {
  const effects = []
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    // The profile row this plugin was composed under: since dsh 0.1.7 that id
    // is also this plugin's settings namespace.
    fiber: { entry: { options: { id: 'commandcode-goat' } } },
    ...services,
    get(name) {
      return this[name]
    },
    inject(names, callback) {
      if (!names.every((name) => this[name] !== undefined)) return
      callback(this)
    },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => dispose?.()
    },
    on() {},
  }
  return { ctx, effects }
}

/**
 * The dsh 0.1.7 settings service: `describe()` returns one descriptor per
 * composed entry, keyed by the entry's row id, and `mutate()` writes that
 * entry's own config. There is no namespace registration to record any more.
 */
function mockSettings({ writable = true, entries } = {}) {
  const state = { mutations: [] }
  const settings = {
    writable,
    state,
    describe: () => entries ?? [
      { ns: LLM_PI_AI, revision: 1, value: { providers: {} }, schema: { type: 'object', dict: { providers: {} } } },
      { ns: 'commandcode-goat', revision: 1, value: {} },
    ],
    async mutate(ns, ops, revision) {
      state.mutations.push({ ns, ops, revision })
      return {}
    },
  }
  return settings
}

/** A webServer recording routes and answering their removal. */
function mockWebServer() {
  const state = { routes: [], removed: [] }
  return {
    state,
    register(route) {
      state.routes.push(route)
      return () => state.removed.push(route.path)
    },
  }
}

/** The web seam, recording the provider it was handed. */
function mockWeb({ selected } = {}) {
  const state = { providers: [], disposed: 0 }
  const web = {
    state,
    registerSearchProvider(provider) {
      state.providers.push(provider)
      return () => { state.disposed += 1 }
    },
  }
  if (selected !== undefined) web.searchProviderId = selected
  return web
}

/** The tool registry, recording definitions. */
function mockTools() {
  const state = { tools: [] }
  return { state, register: (definition) => state.tools.push(definition) }
}

/** Run `body` with a stubbed `fetch`, restoring it afterwards. */
async function withFetch(handler, body) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await body()
  } finally {
    globalThis.fetch = original
  }
}

/** A plan page carrying one catalog array, in the shape the page serves. */
function goatPage(entries) {
  const json = JSON.stringify(entries).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `<script>self.__next_f.push([1,"${json}"])</script>`
}

const API_BODY = {
  data: [
    { id: 'vendor/model-one', name: 'Model One', context_length: 200000, supported_endpoints: ['/chat/completions'] },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context_length: 1000000, supported_endpoints: ['/messages'] },
  ],
}
const CATALOG_ENTRIES = [
  { slug: 'model-one', id: 'vendor/model-one', name: 'Model One', vendor: 'Vendor', contextWindow: 200000, reasoning: true, vision: true, minPlanName: 'Go' },
  { slug: 'claude-sonnet-5', id: 'claude-sonnet-5', name: 'Claude Sonnet 5', vendor: 'Anthropic', contextWindow: 1000000, reasoning: true, vision: true, minPlanName: 'Pro' },
]

/** Answer the two upstream sources, and nothing else. */
function upstreamFetch() {
  return async (url) => {
    if (String(url).includes('/provider/v1/models')) {
      return { ok: true, status: 200, json: async () => API_BODY }
    }
    return { ok: true, status: 200, text: async () => goatPage(CATALOG_ENTRIES) }
  }
}

describe('Config', () => {
  it('resolves the documented defaults', () => {
    // Read through `normalizeConfig`, because a volatile field resolves to a
    // live reference rather than to its value.
    const resolved = normalizeConfig(Config({}))
    assert.equal(resolved.plan, 'goat')
    assert.equal(resolved.sourceURL, 'https://api.commandcode.ai/provider/v1/models')
    assert.equal(resolved.catalogURL, 'https://commandcode.ai/docs/plans/goat')
    assert.equal(resolved.usageBaseURL, 'https://api.commandcode.ai')
    assert.equal(resolved.autoSync, false)
    assert.equal(resolved.webSearch, false)
    assert.equal(resolved.includeReasoningEfforts, false)
    assert.equal(resolved.enableUsageTool, true)
    assert.equal(resolved.enableBridge, true)
    assert.deepEqual(resolved.extraIds, [])
    assert.equal(resolved.autoSyncIntervalMs, 6 * 60 * 60 * 1000)
  })

  it('rejects a tier that is not offered', () => {
    assert.equal(normalizeConfig(Config({ plan: 'pro' })).plan, 'pro')
    assert.throws(() => Config({ plan: 'ultra' }))
  })

  it('satisfies the Standard Schema interface Cordis validates against', () => {
    assert.equal(typeof Config['~standard']?.validate, 'function')
  })
})

describe('normalizeConfig', () => {
  it('reads an empty string as "use the default", which the schema cannot express', () => {
    const resolved = normalizeConfig({ targetApiKeyEnv: '   ', targetBaseURL: '', sourceURL: '' })
    assert.equal(resolved.targetApiKeyEnv, 'COMMANDCODE_API_KEY')
    assert.equal(resolved.targetBaseURL, 'https://api.commandcode.ai/provider/v1')
    assert.equal(resolved.sourceURL, 'https://api.commandcode.ai/provider/v1/models')
  })

  it('clamps the auto-sync cadence and drops blank extra ids', () => {
    assert.equal(normalizeConfig({ autoSyncIntervalMs: 10 }).autoSyncIntervalMs, 6 * 60 * 60 * 1000)
    assert.equal(normalizeConfig({ autoSyncIntervalMs: 120_000 }).autoSyncIntervalMs, 120_000)
    assert.deepEqual(normalizeConfig({ extraIds: ['a', '  ', 7] }).extraIds, ['a'])
  })

  it('falls back to goat for an unknown tier', () => {
    assert.equal(normalizeConfig({ plan: 'ultra' }).plan, 'goat')
  })
})

describe('apply', () => {
  it('loads in a profile with no services at all', () => {
    const { ctx } = mockContext()
    assert.doesNotThrow(() => apply(ctx, Config({})))
  })

  it('marks every field volatile, which is what makes it configurable', () => {
    // dsh 0.1.7 projects a form — and accepts a write — only for fields carrying
    // this marker, so an unmarked field is silently unconfigurable.
    for (const [key, field] of Object.entries(Config.dict)) {
      assert.equal(field.meta?.volatile, true, `${key} is not volatile`)
    }
  })

  it('reports the entry id its form binds to', async () => {
    const settings = mockSettings()
    const webServer = mockWebServer()
    const { ctx } = mockContext({ settings, webServer })
    apply(ctx, Config({}))
    const route = webServer.state.routes.find((entry) => entry.path.endsWith('/describe'))
    const res = bridgeResponse()
    await route.handler(bridgeRequest(), res)
    assert.equal(JSON.parse(res.body).value.entryId, 'commandcode-goat')
  })

  it('registers the bridge and the search provider, and takes the search selection', () => {
    const settings = mockSettings()
    const webServer = mockWebServer()
    const web = mockWeb()
    const { ctx } = mockContext({ settings, webServer, web })
    apply(ctx, Config({ webSearch: true }))

    assert.deepEqual(webServer.state.routes.map((route) => route.path), [
      `${BRIDGE_PREFIX}/describe`,
      `${BRIDGE_PREFIX}/sync`,
      `${BRIDGE_PREFIX}/usage`,
    ])
    assert.equal(web.state.providers.length, 1)
    assert.equal(web.state.providers[0].id, 'commandcode')
    assert.equal(web.searchProviderId, 'commandcode')
  })

  it('leaves the search selection alone until the toggle is on', () => {
    const web = mockWeb()
    const { ctx } = mockContext({ settings: mockSettings(), web })
    apply(ctx, Config({ webSearch: false }))
    assert.equal('searchProviderId' in web, false)
    assert.equal(web.state.providers[0].available(), false)
  })

  it('takes the search seat when the toggle is on, even over a named provider', () => {
    const web = mockWeb({ selected: 'deepseek-official' })
    const { ctx, effects } = mockContext({ settings: mockSettings(), web })
    apply(ctx, Config({ webSearch: true }))
    assert.equal(web.searchProviderId, 'commandcode')
    for (const effect of [...effects].reverse()) effect.dispose?.()
    assert.equal(web.searchProviderId, 'deepseek-official', 'and hands it back on unload')
  })

  it('releases the web provider and the selection when the fiber unloads', () => {
    const web = mockWeb()
    const webServer = mockWebServer()
    const { ctx, effects } = mockContext({ settings: mockSettings(), web, webServer })
    apply(ctx, Config({ webSearch: true }))
    assert.equal(web.searchProviderId, 'commandcode')
    for (const effect of [...effects].reverse()) effect.dispose?.()
    assert.equal(web.state.disposed, 1)
    assert.equal('searchProviderId' in web, false)
    assert.deepEqual(webServer.state.removed, [
      `${BRIDGE_PREFIX}/describe`,
      `${BRIDGE_PREFIX}/sync`,
      `${BRIDGE_PREFIX}/usage`,
    ])
  })

  it('does not register a bridge the deployment turned off', () => {
    const webServer = mockWebServer()
    const { ctx } = mockContext({ settings: mockSettings(), webServer })
    apply(ctx, Config({ enableBridge: false }))
    assert.equal(webServer.state.routes.length, 0)
  })

  it('registers the usage tool with an output the registry accepts', () => {
    const tools = mockTools()
    const { ctx } = mockContext({ settings: mockSettings(), tools })
    apply(ctx, Config({}))
    assert.equal(tools.state.tools.length, 1)
    const tool = tools.state.tools[0]
    assert.equal(tool.name, 'commandcode_usage')
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.deepEqual(tool.output.render({}, 'hello'), [{ type: 'text', text: 'hello' }])
    assert.equal(tool.parameters.type, 'object')
  })

  it('omits the usage tool when the deployment turned it off', () => {
    const tools = mockTools()
    const { ctx } = mockContext({ settings: mockSettings(), tools })
    apply(ctx, Config({ enableUsageTool: false }))
    assert.equal(tools.state.tools.length, 0)
  })
})

/** A request good enough for the bridge guard. */
function bridgeRequest(body = '{}') {
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body)
    },
  }
}

/** A response that records what was written. */
function bridgeResponse() {
  return {
    statusCode: undefined,
    setHeader() {},
    end(text) {
      this.body = text
    },
  }
}

describe('the sync the bridge drives', () => {
  /** Mount the plugin and hand back one bridge route. */
  function mount(config = {}) {
    const settings = mockSettings()
    const webServer = mockWebServer()
    const { ctx } = mockContext({ settings, webServer })
    apply(ctx, Config(config))
    return {
      settings,
      route: (suffix) => webServer.state.routes.find((entry) => entry.path === `${BRIDGE_PREFIX}${suffix}`),
    }
  }

  /** Drive one route and return the parsed answer. */
  async function drive(route, body) {
    const res = bridgeResponse()
    await route.handler(bridgeRequest(body), res)
    return JSON.parse(res.body)
  }

  it('writes one provider profile per route that holds models', async () => {
    const { settings, route } = mount({ plan: 'pro' })
    const payload = await withFetch(upstreamFetch(), () => drive(route('/sync')))
    assert.equal(payload.ok, true)
    // One write per route: each route reaches the provider plugin as a single
    // atomic section, so a tier that gains an Anthropic route cannot leave the
    // OpenAI one half-written.
    assert.deepEqual(settings.state.mutations.map((mutation) => mutation.ns), [LLM_PI_AI, LLM_PI_AI])
    const [openaiOp] = settings.state.mutations[0].ops
    const [anthropicOp] = settings.state.mutations[1].ops
    assert.equal(openaiOp.path.join('.'), 'providers.commandcode-pro-autosync')
    assert.equal(anthropicOp.path.join('.'), 'providers.commandcode-pro-anthropic')

    const openai = openaiOp.value
    assert.equal(openai.api, 'openai-completions')
    assert.equal(openai.baseURL, 'https://api.commandcode.ai/provider/v1')
    assert.equal(openai.apiKeyEnv, 'COMMANDCODE_API_KEY')
    assert.deepEqual(openai.compat, { thinkingFormat: 'openai', supportsReasoningEffort: true })
    assert.deepEqual(openai.models.map((model) => model.id), ['vendor/model-one'])
    assert.deepEqual(openai.models[0].input, ['text', 'image'])

    const anthropic = anthropicOp.value
    assert.equal(anthropic.api, 'anthropic-messages')
    assert.equal('compat' in anthropic, false)
    assert.deepEqual(anthropic.models.map((model) => model.id), ['claude-sonnet-5'])
  })

  it('writes nothing on a dry run but still reports the counts', async () => {
    const { settings, route } = mount({ plan: 'goat' })
    const payload = await withFetch(upstreamFetch(), () => drive(route('/sync'), '{"dryRun":true}'))
    assert.equal(settings.state.mutations.length, 0)
    assert.equal(payload.value.dryRun, true)
    assert.equal(payload.value.live, 2)
    assert.deepEqual(payload.value.counts, {
      'commandcode-goat-autosync': 1,
      'commandcode-goat-anthropic': 0,
      'commandcode-goat-responses': 0,
    })
  })

  it('degrades a dead capability catalog into a diagnostic, not a failure', async () => {
    const { route } = mount({ plan: 'goat' })
    const payload = await withFetch(async (url) => (String(url).includes('/provider/v1/models')
      ? { ok: true, status: 200, json: async () => API_BODY }
      : { ok: false, status: 500, statusText: 'Server Error' }), () => drive(route('/sync')))
    assert.equal(payload.ok, true)
    assert.equal(payload.value.catalog.available, false)
    assert.match(payload.value.diagnostics.join('\n'), /capability catalog could not be read/)
  })

  it('reports an unreachable model list as a coded failure', async () => {
    const { settings, route } = mount()
    const payload = await withFetch(async () => ({ ok: false, status: 503, statusText: 'Unavailable' }), () => drive(route('/sync')))
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'fetch-failed')
    assert.match(payload.message, /could not read the model list/)
    assert.equal(settings.state.mutations.length, 0)
  })

  it('reports a read-only deployment rather than silently doing nothing', async () => {
    const webServer = mockWebServer()
    const { ctx } = mockContext({ settings: mockSettings({ writable: false }), webServer })
    apply(ctx, Config({}))
    const route = webServer.state.routes.find((entry) => entry.path === `${BRIDGE_PREFIX}/sync`)
    const payload = await withFetch(upstreamFetch(), () => drive(route))
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'settings-read-only')
  })

  it('bounds its own network work with a timeout signal', () => {
    assert.ok(SYNC_TIMEOUT_MS > 0 && SYNC_TIMEOUT_MS <= 120_000)
  })
})

describe('the usage tool', () => {
  it('returns a labelled summary a model can read', async () => {
    const tools = mockTools()
    const { ctx } = mockContext({ settings: mockSettings(), tools })
    apply(ctx, Config({}))
    const tool = tools.state.tools[0]
    const originalKey = process.env.COMMANDCODE_API_KEY
    process.env.COMMANDCODE_API_KEY = 'cmd_test'
    try {
      const text = await withFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          user: { id: 'u1', userName: 'ada' },
          planId: 'individual-goat',
          totalCount: 4,
          completedCount: 4,
          successRate: 1,
          totalCost: 0.5,
          totalTokensIn: 100,
          totalTokensOut: 20,
        }),
      }), () => tool.execute({}, {}))
      assert.match(text, /account: ada/)
      assert.match(text, /"failures": \[\]/)
    } finally {
      if (originalKey === undefined) delete process.env.COMMANDCODE_API_KEY
      else process.env.COMMANDCODE_API_KEY = originalKey
    }
  })

  it('names the missing credential instead of throwing a raw error', async () => {
    const tools = mockTools()
    const { ctx } = mockContext({ settings: mockSettings(), tools })
    apply(ctx, Config({ targetApiKeyEnv: 'CC_GOAT_TEST_MISSING' }))
    const originalKey = process.env.CC_GOAT_TEST_MISSING
    delete process.env.CC_GOAT_TEST_MISSING
    try {
      await assert.rejects(
        () => tools.state.tools[0].execute({}, {}),
        /no "CC_GOAT_TEST_MISSING" credential is configured/,
      )
    } finally {
      if (originalKey !== undefined) process.env.CC_GOAT_TEST_MISSING = originalKey
    }
  })
})
