import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildEntries,
  fetchCatalog,
  fetchModelList,
  parseCatalogPayload,
  parseModelListPayload,
  planCatalogSummary,
  providerKey,
  routeForModel,
  routeProtocol,
  slugify,
  tierAvailability,
  tierCounts,
} from '../lib/catalog.js'

/** Build a page in the shape the plan page actually serves. */
function rscPage(chunks) {
  return chunks
    .map((chunk) => `self.__next_f.push([1,"${chunk.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"])`)
    .join('\n')
}

const CATALOG_ENTRY = (overrides) => ({
  slug: 'model-one',
  id: 'vendor/model-one',
  name: 'Model One',
  vendor: 'Vendor',
  contextWindow: 200000,
  reasoning: true,
  vision: true,
  minPlanName: 'Go',
  caps: { text: true, vision: true, reasoning: true },
  ...overrides,
})

describe('parseModelListPayload', () => {
  it('normalizes the documented shape', () => {
    const models = parseModelListPayload({
      data: [
        { id: 'a/b', name: 'B', context_length: 1000, supported_endpoints: ['/chat/completions'] },
        { id: 'c/d', context_length: 2000 },
      ],
    })
    assert.deepEqual(models, [
      { id: 'a/b', name: 'B', contextWindow: 1000, supportedEndpoints: ['/chat/completions'] },
      { id: 'c/d', name: 'c/d', contextWindow: 2000 },
    ])
  })

  it('drops entries without an id and de-duplicates', () => {
    const models = parseModelListPayload({ data: [{ name: 'x' }, { id: 'a/b' }, { id: 'a/b' }, { id: '   ' }] })
    assert.deepEqual(models.map((model) => model.id), ['a/b'])
  })

  it('rejects a body that is not the documented envelope', () => {
    assert.throws(() => parseModelListPayload({ models: [] }), /expected \{ data: \[\.\.\.\] \}/)
  })

  it('ignores a context length that is not a positive number', () => {
    const [model] = parseModelListPayload({ data: [{ id: 'a', context_length: 0 }] })
    assert.equal('contextWindow' in model, false)
  })
})

describe('parseCatalogPayload', () => {
  it('reads the array out of the RSC payload', () => {
    const catalog = [CATALOG_ENTRY(), CATALOG_ENTRY({ id: 'vendor/two', slug: 'two', minPlanName: 'Pro' })]
    const page = rscPage(['prefix ', JSON.stringify(catalog), ' trailing [not json]'])
    const parsed = parseCatalogPayload(page)
    assert.equal(parsed.length, 2)
    assert.equal(parsed[0].id, 'vendor/model-one')
    assert.equal(parsed[1].minPlanName, 'Pro')
  })

  it('joins fragments split across chunk boundaries', () => {
    const catalog = [CATALOG_ENTRY()]
    const json = JSON.stringify(catalog)
    const page = rscPage([json.slice(0, 10), json.slice(10)])
    assert.equal(parseCatalogPayload(page)[0].id, 'vendor/model-one')
  })

  it('turns the "$undefined" placeholder into null', () => {
    const page = rscPage([`[{"slug":"a","outputCost":0,"deal":"$undefined"}]`])
    assert.equal(parseCatalogPayload(page)[0].deal, null)
  })

  it('stops at the end of the array rather than the end of the payload', () => {
    const page = rscPage([`[{"slug":"a"}]\n[{"slug":"b"}]`])
    assert.deepEqual(parseCatalogPayload(page), [{ slug: 'a' }])
  })

  it('fails loudly when the payload is missing', () => {
    assert.throws(() => parseCatalogPayload('<html></html>'), /no RSC payload/)
    assert.throws(() => parseCatalogPayload(rscPage(['nothing here'])), /no model catalog array/)
    assert.throws(() => parseCatalogPayload(rscPage(['[{"slug":"a"}'])), /unterminated/)
  })
})

describe('routeForModel', () => {
  it('prefers the endpoints the gateway states', () => {
    assert.equal(routeForModel({ id: 'x', supportedEndpoints: ['/messages'] }), 'anthropic')
    assert.equal(routeForModel({ id: 'x', supportedEndpoints: ['/chat/completions'] }), 'openai')
    assert.equal(routeForModel({ id: 'x', supportedEndpoints: ['/responses'] }), 'responses')
  })

  it('prefers chat when a model answers on several endpoints', () => {
    assert.equal(routeForModel({ id: 'x', supportedEndpoints: ['/messages', '/chat/completions'] }), 'openai')
    assert.equal(routeForModel({ id: 'x', supportedEndpoints: ['/responses', '/chat/completions'] }), 'openai')
  })

  it('falls back to the vendor and the id prefix when the field is absent', () => {
    assert.equal(routeForModel({ id: 'claude-sonnet-5' }), 'anthropic')
    assert.equal(routeForModel({ id: 'x' }, { vendor: 'Anthropic' }), 'anthropic')
    assert.equal(routeForModel({ id: 'x' }, { vendor: 'DeepSeek' }), 'openai')
  })

  it('maps every route to a protocol the provider plugin declares', () => {
    assert.equal(routeProtocol('openai'), 'openai-completions')
    assert.equal(routeProtocol('anthropic'), 'anthropic-messages')
    assert.equal(routeProtocol('responses'), 'openai-responses')
    assert.throws(() => routeProtocol('nope'), /unknown route/)
    assert.throws(() => providerKey('goat', 'nope'), /unknown route/)
  })

  it('names providers after the tier and the route', () => {
    assert.equal(providerKey('goat', 'openai'), 'commandcode-goat-autosync')
    assert.equal(providerKey('pro', 'anthropic'), 'commandcode-pro-anthropic')
    assert.equal(providerKey('max', 'responses'), 'commandcode-max-responses')
  })
})

describe('buildEntries', () => {
  const apiList = [
    { id: 'vendor/model-one', name: 'Model One', contextWindow: 200000, supportedEndpoints: ['/chat/completions'] },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1000000, supportedEndpoints: ['/messages'] },
    { id: 'vendor/pro-only', name: 'Pro Only', contextWindow: 500000, supportedEndpoints: ['/chat/completions'] },
    { id: 'vendor/top-tier', name: 'Top Tier', contextWindow: 900000, supportedEndpoints: ['/chat/completions'] },
  ]
  const catalog = [
    CATALOG_ENTRY(),
    CATALOG_ENTRY({ id: 'claude-sonnet-5', slug: 'claude-sonnet-5', name: 'Claude Sonnet 5', vendor: 'Anthropic', minPlanName: 'Pro' }),
    CATALOG_ENTRY({ id: 'vendor/pro-only', slug: 'pro-only', name: 'Pro Only', minPlanName: 'Pro' }),
    CATALOG_ENTRY({ id: 'vendor/top-tier', slug: 'top-tier', name: 'Top Tier', minPlanName: 'Max' }),
  ]

  it('splits routes and filters by the cumulative tier', () => {
    const goat = buildEntries({ apiList, catalog, plan: 'goat' })
    assert.deepEqual(goat.routes.openai.map((entry) => entry.id), ['vendor/model-one'])
    assert.deepEqual(goat.routes.anthropic, [])
    assert.deepEqual(goat.routes.responses, [])

    const pro = buildEntries({ apiList, catalog, plan: 'pro' })
    assert.deepEqual(pro.routes.openai.map((entry) => entry.id), ['vendor/model-one', 'vendor/pro-only'])
    assert.deepEqual(pro.routes.anthropic.map((entry) => entry.id), ['claude-sonnet-5'])

    const max = buildEntries({ apiList, catalog, plan: 'max' })
    assert.deepEqual(max.routes.openai.map((entry) => entry.id), ['vendor/model-one', 'vendor/pro-only', 'vendor/top-tier'])
  })

  it('serves a Go subscriber only the Go tier', () => {
    // `go` is a tier of its own, and it used to be one this build did not know:
    // selecting it threw inside the membership test instead of selecting less.
    const go = buildEntries({ apiList, catalog, plan: 'go' })
    assert.deepEqual(go.routes.openai.map((entry) => entry.id), ['vendor/model-one'])
    assert.deepEqual(go.routes.anthropic, [])
    assert.match(go.diagnostics.join(' '), /above the Go tier/)
  })

  it('states capabilities the catalog actually declares', () => {
    const { routes } = buildEntries({ apiList, catalog, plan: 'goat' })
    const [model] = routes.openai
    assert.deepEqual(model.input, ['text', 'image'])
    assert.equal('reasoningEfforts' in model, false)
    assert.equal(model.name, 'Model One')
    assert.equal(model.contextWindow, 200000)
  })

  it('blocks reasoning parameters the catalog says a model cannot take', () => {
    const silent = [CATALOG_ENTRY({ reasoning: false, vision: false, caps: { text: true, vision: false, reasoning: false } })]
    const { routes } = buildEntries({
      apiList: [{ id: 'vendor/model-one', name: 'Model One', supportedEndpoints: ['/chat/completions'] }],
      catalog: silent,
      plan: 'goat',
    })
    assert.equal(routes.openai[0].reasoningEfforts, false)
    assert.deepEqual(routes.openai[0].input, ['text'])
  })

  it('writes the identity effort map only when asked', () => {
    const { routes } = buildEntries({ apiList, catalog, plan: 'goat', includeReasoningEfforts: true })
    assert.deepEqual(routes.openai[0].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
  })

  it('takes the catalog capability over a renamed id, by slug or by name', () => {
    const renamed = [{ id: 'vendor/model-1', name: 'Model One', supportedEndpoints: ['/chat/completions'] }]
    const { routes } = buildEntries({ apiList: renamed, catalog, plan: 'goat' })
    assert.deepEqual(routes.openai[0].input, ['text', 'image'])
  })

  it('publishes extra ids on the OpenAI-shaped route only', () => {
    const { routes } = buildEntries({ apiList, catalog, plan: 'goat', extraIds: ['private/x', 'vendor/model-one', '  '] })
    assert.deepEqual(routes.openai.map((entry) => entry.id), ['private/x', 'vendor/model-one'])
    assert.deepEqual(routes.anthropic, [])
  })

  it('degrades to the plain list when the catalog is empty, and says so', () => {
    const { routes, diagnostics } = buildEntries({ apiList, catalog: [], plan: 'goat' })
    assert.equal(routes.openai.length, 3)
    assert.equal(routes.anthropic.length, 1)
    assert.match(diagnostics.join('\n'), /capability catalog unavailable/)
  })

  it('admits an unindexed model but reports that its tier is unchecked', () => {
    const { routes, diagnostics } = buildEntries({
      apiList: [...apiList, { id: 'vendor/brand-new', supportedEndpoints: ['/chat/completions'] }],
      catalog,
      plan: 'goat',
    })
    assert.ok(routes.openai.some((entry) => entry.id === 'vendor/brand-new'))
    assert.match(diagnostics.join('\n'), /not in the capability catalog/)
    assert.match(diagnostics.join('\n'), /were left out/)
  })

  it('trusts the flat capability field over a stale caps entry', () => {
    const drifted = [CATALOG_ENTRY({ reasoning: false, vision: false, caps: { vision: true, reasoning: true } })]
    const listed = [{ id: 'vendor/model-one', supportedEndpoints: ['/chat/completions'] }]
    const { routes } = buildEntries({ apiList: listed, catalog: drifted, plan: 'goat' })
    assert.deepEqual(routes.openai[0].input, ['text'])
    assert.equal(routes.openai[0].reasoningEfforts, false)
  })

  it('keeps a tier it does not recognize out of every tier but the top one', () => {
    const future = [CATALOG_ENTRY({ minPlanName: 'Ultra' })]
    const listed = [{ id: 'vendor/model-one', name: 'Model One', supportedEndpoints: ['/chat/completions'] }]
    assert.equal(buildEntries({ apiList: listed, catalog: future, plan: 'pro' }).routes.openai.length, 0)
    assert.equal(buildEntries({ apiList: listed, catalog: future, plan: 'max' }).routes.openai.length, 1)
    assert.match(buildEntries({ apiList: listed, catalog: future, plan: 'pro' }).diagnostics.join('\n'), /tier this build does not know/)
  })

  it('survives a malformed list', () => {
    const { routes } = buildEntries({ apiList: [null, {}, { id: '' }, 'nope'], catalog, plan: 'goat' })
    assert.deepEqual(routes, { openai: [], anthropic: [], responses: [] })
  })
})

describe('planCatalogSummary', () => {
  const catalog = [
    CATALOG_ENTRY({ minPlanName: 'Go' }),
    CATALOG_ENTRY({ minPlanName: 'GOAT' }),
    CATALOG_ENTRY({ minPlanName: 'Pro' }),
    CATALOG_ENTRY({ minPlanName: 'Max' }),
  ]

  it('counts cumulatively', () => {
    assert.equal(planCatalogSummary(catalog, 'goat'), 2)
    assert.equal(planCatalogSummary(catalog, 'pro'), 3)
    assert.equal(planCatalogSummary(catalog, 'max'), 4)
  })

  it('keeps Go out of GOAT, which the prefix would otherwise lose', () => {
    // `Go` and `GOAT` are different tiers whose names share a prefix, and a
    // subscriber to one is not entitled to the other's models.
    assert.equal(planCatalogSummary(catalog, 'go'), 1)
  })

  it('counts a tier this build has never heard of towards the top tier only', () => {
    const future = [...catalog, CATALOG_ENTRY({ minPlanName: 'Ultra' })]
    assert.equal(planCatalogSummary(future, 'go'), 1)
    assert.equal(planCatalogSummary(future, 'goat'), 2)
    assert.equal(planCatalogSummary(future, 'max'), 5)
  })
})

describe('tierCounts', () => {
  it('answers nothing for a catalog that carries no tiers', () => {
    // A zero here would be a claim that the tier grants nothing, which is a
    // different statement from "not read yet".
    assert.equal(tierCounts([]), undefined)
    assert.equal(tierCounts(undefined), undefined)
  })

  it('counts every tier in one pass', () => {
    const catalog = [
      CATALOG_ENTRY({ minPlanName: 'Go' }),
      CATALOG_ENTRY({ minPlanName: 'Go' }),
      CATALOG_ENTRY({ minPlanName: 'GOAT' }),
      CATALOG_ENTRY({ minPlanName: 'Pro' }),
    ]
    assert.deepEqual(tierCounts(catalog), { go: 2, goat: 3, pro: 4, max: 4 })
  })
})

describe('tierAvailability', () => {
  const catalog = [
    CATALOG_ENTRY({ id: 'vendor/go-model', name: 'Go Model', minPlanName: 'Go' }),
    CATALOG_ENTRY({ id: 'vendor/goat-model', name: 'Goat Model', minPlanName: 'GOAT' }),
  ]

  it('states both numbers per tier: what the catalog grants and what is being served', () => {
    const rows = tierAvailability({
      catalog,
      // The GOAT-tier model is announced on the plan page but not served yet.
      apiList: [{ id: 'vendor/go-model' }],
    })
    assert.deepEqual(rows, [
      { plan: 'go', models: 1, live: 1 },
      { plan: 'goat', models: 2, live: 1 },
      { plan: 'pro', models: 2, live: 1 },
      { plan: 'max', models: 2, live: 1 },
    ])
  })

  it('answers null rather than zero for a source that has not been read', () => {
    assert.deepEqual(tierAvailability({}), [
      { plan: 'go', models: null, live: null },
      { plan: 'goat', models: null, live: null },
      { plan: 'pro', models: null, live: null },
      { plan: 'max', models: null, live: null },
    ])
    assert.deepEqual(tierAvailability({ catalog, apiList: [] })[1], { plan: 'goat', models: 2, live: null })
  })

  it('counts a model the catalog does not describe against every tier, as the sync does', () => {
    const rows = tierAvailability({ catalog, apiList: [{ id: 'vendor/go-model' }, { id: 'private/model' }] })
    assert.deepEqual(rows.map((row) => row.live), [2, 2, 2, 2])
  })
})

describe('slugify', () => {
  it('normalizes the punctuation that differs between an id and a slug', () => {
    assert.equal(slugify('poolside/laguna-s-2.1-free'), 'poolside-laguna-s-2-1-free')
    assert.equal(slugify('  Meituan/LongCat-2.0:free '), 'meituan-longcat-2-0-free')
  })
})

describe('fetchers', () => {
  const withFetch = async (handler, run) => {
    const original = globalThis.fetch
    globalThis.fetch = handler
    try {
      return await run()
    } finally {
      globalThis.fetch = original
    }
  }

  it('fetchModelList parses a 200 and passes the signal through', async () => {
    const controller = new AbortController()
    let seen
    const models = await withFetch(async (url, options) => {
      seen = { url, signal: options.signal }
      return { ok: true, json: async () => ({ data: [{ id: 'a/b' }] }) }
    }, () => fetchModelList('https://example.test/models', controller.signal))
    assert.equal(models[0].id, 'a/b')
    assert.equal(seen.url, 'https://example.test/models')
    assert.equal(seen.signal, controller.signal)
  })

  it('fetchCatalog parses a 200 body', async () => {
    const page = rscPage([JSON.stringify([CATALOG_ENTRY()])])
    const catalog = await withFetch(async () => ({ ok: true, text: async () => page }), () => fetchCatalog('https://example.test/goat'))
    assert.equal(catalog.length, 1)
  })

  it('both fetchers report a non-2xx as a failure naming the status', async () => {
    await withFetch(async () => ({ ok: false, status: 503, statusText: 'Unavailable' }), async () => {
      await assert.rejects(() => fetchModelList('https://example.test/models'), /HTTP 503 Unavailable/)
      await assert.rejects(() => fetchCatalog('https://example.test/goat'), /HTTP 503 Unavailable/)
    })
  })
})
