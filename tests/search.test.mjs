import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_RESULTS,
  MAX_RESULTS,
  SEARCH_PROVIDER_ID,
  SEARCH_ROUTE,
  clampResults,
  makeSearchProvider,
  makeSelectionController,
  mapSearchPayload,
} from '../lib/search.js'

/** A provider whose dependencies are all answered from one mutable state object. */
function buildProvider(overrides = {}) {
  const state = {
    enabled: true,
    base: 'https://api.commandcode.ai',
    env: 'COMMANDCODE_API_KEY',
    key: 'cmd_test',
    ...overrides,
  }
  const provider = makeSearchProvider({
    isEnabled: () => state.enabled,
    apiBase: () => state.base,
    keyEnv: () => state.env,
    resolveKey: async () => state.key,
  })
  return { provider, state }
}

/** Run `body` with `fetch` replaced, restoring it afterwards. */
async function withFetch(handler, body) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return handler(url, options)
  }
  try {
    return { result: await body(), calls }
  } finally {
    globalThis.fetch = original
  }
}

describe('clampResults', () => {
  it('keeps the request inside the range the endpoint accepts', () => {
    assert.equal(clampResults(undefined), DEFAULT_RESULTS)
    assert.equal(clampResults(0), 1)
    assert.equal(clampResults(999), MAX_RESULTS)
    assert.equal(clampResults(3.4), 3)
    assert.equal(clampResults(Number.NaN), DEFAULT_RESULTS)
    assert.equal(clampResults('nope'), DEFAULT_RESULTS)
  })
})

describe('mapSearchPayload', () => {
  it('maps results, drops junk and de-duplicates by URL', () => {
    const result = mapSearchPayload({
      results: [
        { url: 'https://a.test', title: ' A ', snippet: ' first ' },
        { url: 'https://a.test', title: 'duplicate' },
        { url: '  ' },
        null,
        { url: 'https://b.test' },
      ],
    })
    assert.deepEqual(result.sources, [
      { url: 'https://a.test', title: 'A', snippet: 'first' },
      { url: 'https://b.test' },
    ])
    assert.equal(result.truncated, false)
  })

  it('answers an empty list for anything that is not the documented shape', () => {
    assert.deepEqual(mapSearchPayload(undefined).sources, [])
    assert.deepEqual(mapSearchPayload({ results: 'nope' }).sources, [])
  })
})

describe('makeSearchProvider', () => {
  it('is available only while the toggle is on and the base is usable', () => {
    const { provider, state } = buildProvider()
    assert.equal(provider.id, SEARCH_PROVIDER_ID)
    assert.equal(provider.available(), true)
    state.enabled = false
    assert.equal(provider.available(), false)
    state.enabled = true
    state.base = 'not a url'
    assert.equal(provider.available(), false)
  })

  it('does not consult the credential when answering availability', () => {
    // The seam resolves a provider synchronously, so availability must never
    // depend on an async key lookup. A missing key is reported by search().
    const { provider, state } = buildProvider({ key: undefined })
    assert.equal(provider.available(), true)
    assert.equal(state.enabled, true)
  })

  it('posts the query to the search route with the account key', async () => {
    const { provider } = buildProvider()
    const { result, calls } = await withFetch(
      async () => ({ ok: true, status: 200, json: async () => ({ results: [{ url: 'https://a.test' }] }) }),
      () => provider.search({ query: 'hello', maxResults: 99 }),
    )
    assert.equal(result.sources[0].url, 'https://a.test')
    assert.equal(calls[0].url, `https://api.commandcode.ai${SEARCH_ROUTE}`)
    assert.equal(calls[0].options.method, 'POST')
    assert.equal(calls[0].options.headers.authorization, 'Bearer cmd_test')
    assert.equal(calls[0].options.headers['x-command-code-version'], '1.44.0')
    assert.deepEqual(JSON.parse(calls[0].options.body), { query: 'hello', numResults: MAX_RESULTS })
  })

  it('tolerates a trailing slash on the base', async () => {
    const { provider } = buildProvider({ base: 'https://api.commandcode.ai/' })
    const { calls } = await withFetch(
      async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }),
      () => provider.search({ query: 'x' }),
    )
    assert.equal(calls[0].url, `https://api.commandcode.ai${SEARCH_ROUTE}`)
  })

  it('names the credential it is missing', async () => {
    const { provider } = buildProvider({ key: undefined, env: 'MY_KEY' })
    await assert.rejects(() => provider.search({ query: 'x' }), /no API key.*MY_KEY/)
  })

  it('refuses an empty query before spending a request', async () => {
    const { provider } = buildProvider()
    const { calls } = await withFetch(async () => ({ ok: true, json: async () => ({}) }), async () => {
      await assert.rejects(() => provider.search({ query: '   ' }), /needs a query/)
      await assert.rejects(() => provider.search(undefined), /needs a query/)
    })
    assert.equal(calls.length, 0)
  })

  it('reports a misconfigured base rather than a network error', async () => {
    const { provider } = buildProvider({ base: 'nonsense' })
    await assert.rejects(() => provider.search({ query: 'x' }), /not a valid URL/)
  })

  it('surfaces the provider\u2019s own error detail on a non-2xx', async () => {
    const { provider } = buildProvider()
    await withFetch(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: 'rate limited' }),
    }), async () => {
      await assert.rejects(() => provider.search({ query: 'x' }), /HTTP 429\): rate limited/)
    })
  })

  it('still names the status when the error body is not JSON', async () => {
    const { provider } = buildProvider()
    await withFetch(async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json') } }), async () => {
      await assert.rejects(() => provider.search({ query: 'x' }), /HTTP 500/)
    })
  })

  it('reports an unparseable success body as such', async () => {
    const { provider } = buildProvider()
    await withFetch(async () => ({ ok: true, status: 200, json: async () => { throw new Error('boom') } }), async () => {
      await assert.rejects(() => provider.search({ query: 'x' }), /unparseable body/)
    })
  })

  it('turns an abort into the seam\u2019s cancellation wording, not a failure', async () => {
    const { provider } = buildProvider()
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(() => provider.search({ query: 'x' }, controller.signal), /aborted/)

    await withFetch(async () => { throw new TypeError('fetch failed') }, async () => {
      await assert.rejects(() => provider.search({ query: 'x' }), /request failed: fetch failed/)
    })
  })
})

describe('makeSelectionController', () => {
  it('takes an unclaimed selection and gives it back untouched', () => {
    const web = {}
    const select = makeSelectionController(web)
    assert.equal(select(true), 'taken')
    assert.equal(web.searchProviderId, SEARCH_PROVIDER_ID)
    assert.equal(select(false), 'released')
    assert.equal('searchProviderId' in web, false, 'the field is removed, not set to undefined')
  })

  it('displaces a provider the deployment named, then restores it', () => {
    // The toggle is the user asking for this account's search. Leaving an
    // earlier selection in place would make the switch do nothing, which is
    // what a "respect the explicit config" reading of the same state gave.
    const web = { searchProviderId: 'deepseek-official' }
    const select = makeSelectionController(web)
    assert.equal(select(true), 'taken')
    assert.equal(web.searchProviderId, SEARCH_PROVIDER_ID)
    assert.equal(select(false), 'released')
    assert.equal(web.searchProviderId, 'deepseek-official')
  })

  it('is idempotent while it already owns the selection', () => {
    const web = { searchProviderId: SEARCH_PROVIDER_ID }
    const select = makeSelectionController(web)
    assert.equal(select(true), 'taken')
    assert.equal(select(true), 'taken')
    assert.equal(select(false), 'released')
    assert.equal('searchProviderId' in web, false)
  })

  it('does not clobber a selection changed while it held the seat', () => {
    const web = {}
    const select = makeSelectionController(web)
    select(true)
    web.searchProviderId = 'changed-underneath'
    assert.equal(select(false), 'released')
    assert.equal(web.searchProviderId, 'changed-underneath')
  })

  it('releasing a seat it never took is a no-op', () => {
    const web = { searchProviderId: 'other' }
    const select = makeSelectionController(web)
    assert.equal(select(false), 'released')
    assert.equal(web.searchProviderId, 'other')
  })
})
