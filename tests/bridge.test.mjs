import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BRIDGE_PREFIX, MAX_BODY_BYTES, isLoopbackRequest, makeBridgeRoutes, readJsonBody } from '../lib/bridge.js'

const LLM_PI_AI = 'llm-pi-ai'

/** A request good enough for the guard and the body reader. */
function request(overrides = {}) {
  const { body = '{}', ...rest } = overrides
  const chunks = typeof body === 'string' ? [Buffer.from(body)] : body
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    ...rest,
  }
}

/** A response that records what was written. */
function response() {
  return {
    statusCode: undefined,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(text) {
      this.body = text
    },
    get json() {
      return this.body === undefined ? undefined : JSON.parse(this.body)
    },
  }
}

/** Drive one route by suffix. */
async function call(routes, suffix, req) {
  const route = routes.find((entry) => entry.path === `${BRIDGE_PREFIX}${suffix}`)
  assert.ok(route, `no route for ${suffix}`)
  const res = response()
  await route.handler(req, res)
  return res
}

/** The host facts the bridge reads, all stubbed. */
function deps(overrides = {}) {
  const state = {
    settings: {
      writable: true,
      describe: () => [
        { ns: LLM_PI_AI, revision: 3, value: { providers: { 'commandcode-goat-autosync': { models: [{ id: 'a' }, { id: 'b' }] } } } },
      ],
    },
    ...overrides,
  }
  return {
    state,
    config: () => ({ plan: 'goat', targetApiKeyEnv: 'COMMANDCODE_API_KEY', usageBaseURL: 'https://api.commandcode.ai' }),
    settings: () => state.settings,
    targetKeys: () => ({ openai: 'commandcode-goat-autosync', anthropic: 'commandcode-goat-anthropic', responses: 'commandcode-goat-responses' }),
    sync: async () => ({ plan: 'goat', live: 3, counts: { 'commandcode-goat-autosync': 3 }, diagnostics: [] }),
    usage: async () => ({ failures: [], plan: { name: 'GOAT' } }),
    search: () => ({ registered: true, enabled: false, selected: undefined, held: false }),
    keyState: async () => ({ configured: true, source: 'credentials', envName: 'COMMANDCODE_API_KEY' }),
  }
}

describe('isLoopbackRequest', () => {
  it('accepts a plain loopback request', () => {
    assert.equal(isLoopbackRequest(request()), true)
    assert.equal(isLoopbackRequest(request({ socket: { remoteAddress: '::1' } })), true)
    assert.equal(isLoopbackRequest(request({ socket: { remoteAddress: '::ffff:127.0.0.1' } })), true)
    assert.equal(isLoopbackRequest(request({ headers: { host: 'localhost:3080' } })), true)
  })

  it('refuses a request from anywhere else', () => {
    assert.equal(isLoopbackRequest(request({ socket: { remoteAddress: '10.0.0.4' } })), false)
    assert.equal(isLoopbackRequest(request({ socket: {} })), false)
    assert.equal(isLoopbackRequest(request({ headers: { host: 'evil.test' } })), false)
    assert.equal(isLoopbackRequest(request({ headers: { host: '127.0.0.1.evil.test' } })), false)
    assert.equal(isLoopbackRequest(request({ headers: {} })), false)
    assert.equal(isLoopbackRequest(request({ headers: { host: 'not a host' } })), false)
  })

  it('refuses a cross-site fetch even from loopback', () => {
    assert.equal(isLoopbackRequest(request({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } })), false)
  })

  it('requires a stated origin to match the host', () => {
    assert.equal(isLoopbackRequest(request({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } })), true)
    assert.equal(isLoopbackRequest(request({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' } })), false)
    assert.equal(isLoopbackRequest(request({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.test' } })), false)
    assert.equal(isLoopbackRequest(request({ headers: { host: '127.0.0.1:3080', origin: 'garbage' } })), false)
  })
})

describe('readJsonBody', () => {
  it('reads an object, and treats an empty body as an empty object', async () => {
    assert.deepEqual(await readJsonBody(request({ body: '{"a":1}' })), { a: 1 })
    assert.deepEqual(await readJsonBody(request({ body: '' })), {})
  })

  it('answers undefined for everything it cannot accept', async () => {
    assert.equal(await readJsonBody(request({ body: '{oops' })), undefined)
    assert.equal(await readJsonBody(request({ body: '[1,2]' })), undefined)
    assert.equal(await readJsonBody(request({ body: 'null' })), undefined)
  })

  it('refuses a body past the limit without buffering all of it', async () => {
    const chunks = [Buffer.alloc(MAX_BODY_BYTES), Buffer.alloc(MAX_BODY_BYTES)]
    assert.equal(await readJsonBody(request({ body: chunks })), undefined)
  })
})

describe('makeBridgeRoutes', () => {
  it('registers one POST route per endpoint', () => {
    const routes = makeBridgeRoutes(deps())
    assert.deepEqual(routes.map((route) => route.path), [
      `${BRIDGE_PREFIX}/describe`,
      `${BRIDGE_PREFIX}/sync`,
      `${BRIDGE_PREFIX}/usage`,
    ])
    assert.ok(routes.every((route) => route.kind === 'exact'))
  })

  it('refuses a request from another machine', async () => {
    const routes = makeBridgeRoutes(deps())
    const res = await call(routes, '/describe', request({ socket: { remoteAddress: '10.0.0.9' } }))
    assert.equal(res.statusCode, 403)
    assert.equal(res.json.code, 'loopback-only')
  })

  it('refuses anything but POST', async () => {
    const routes = makeBridgeRoutes(deps())
    const res = await call(routes, '/describe', request({ method: 'GET' }))
    assert.equal(res.statusCode, 405)
    assert.equal(res.json.code, 'method-not-allowed')
  })

  it('refuses a body it cannot parse', async () => {
    const routes = makeBridgeRoutes(deps())
    const res = await call(routes, '/describe', request({ body: '{oops' }))
    assert.equal(res.statusCode, 400)
    assert.equal(res.json.code, 'malformed-request')
  })

  it('describes the plan, the targets and the credential state', async () => {
    const routes = makeBridgeRoutes(deps())
    const res = await call(routes, '/describe', request())
    assert.equal(res.statusCode, 200)
    const value = res.json.value
    assert.equal(value.plan, 'goat')
    assert.deepEqual(value.plans, ['goat', 'pro', 'max'])
    assert.equal(value.hasKey, true)
    assert.equal(value.writable, true)
    assert.deepEqual(value.targets.openai, { key: 'commandcode-goat-autosync', created: true, models: 2 })
    assert.deepEqual(value.targets.anthropic, { key: 'commandcode-goat-anthropic', created: false, models: 0 })
    assert.equal(value.search.registered, true)
  })

  it('reports no key rather than failing when the credential does not resolve', async () => {
    const routes = makeBridgeRoutes({ ...deps(), keyState: async () => ({ configured: false, source: 'none', envName: 'COMMANDCODE_API_KEY' }) })
    const res = await call(routes, '/describe', request())
    assert.equal(res.json.value.hasKey, false)
    assert.equal(res.json.value.keySource, 'none')
  })

  it('reports no key rather than failing when resolution throws', async () => {
    const routes = makeBridgeRoutes({ ...deps(), keyState: async () => { throw new Error('no provider') } })
    const res = await call(routes, '/describe', request())
    assert.equal(res.json.value.hasKey, false)
  })

  it('states where the key came from, so the pill cannot contradict the usage panel', async () => {
    const environment = makeBridgeRoutes({ ...deps(), keyState: async () => ({ configured: true, source: 'environment', envName: 'MY_KEY' }) })
    const res = await call(environment, '/describe', request())
    assert.equal(res.json.value.hasKey, true)
    assert.equal(res.json.value.keySource, 'environment')
    assert.equal(res.json.value.apiKeyEnv, 'MY_KEY')
  })

  it('survives a deployment with no settings service at all', async () => {
    const routes = makeBridgeRoutes({ ...deps(), settings: () => undefined })
    const res = await call(routes, '/describe', request())
    assert.equal(res.statusCode, 200)
    assert.equal(res.json.value.writable, false)
    assert.equal(res.json.value.targets.openai.created, false)
  })

  it('returns the sync report as the value', async () => {
    const routes = makeBridgeRoutes(deps())
    const res = await call(routes, '/sync', request({ body: '{"dryRun":true}' }))
    assert.equal(res.json.ok, true)
    assert.equal(res.json.value.live, 3)
  })

  it('turns a coded failure into a 200 the card can read', async () => {
    const routes = makeBridgeRoutes({
      ...deps(),
      sync: async () => { throw Object.assign(new Error('nothing to write'), { code: 'nothing-to-write' }) },
    })
    const res = await call(routes, '/sync', request())
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json, { ok: false, code: 'nothing-to-write', message: 'nothing to write' })
  })

  it('reports an uncoded throw as an internal failure', async () => {
    const routes = makeBridgeRoutes({ ...deps(), sync: async () => { throw 'plain string' } })
    const res = await call(routes, '/sync', request())
    assert.deepEqual(res.json, { ok: false, code: 'internal', message: 'plain string' })
  })

  it('forwards a usage base override and defaults it away', async () => {
    const seen = []
    const routes = makeBridgeRoutes({ ...deps(), usage: async (base) => { seen.push(base); return { failures: [] } } })
    await call(routes, '/usage', request({ body: '{"baseURL":"https://proxy.test"}' }))
    await call(routes, '/usage', request({ body: '{"baseURL":"   "}' }))
    await call(routes, '/usage', request())
    assert.deepEqual(seen, ['https://proxy.test', undefined, undefined])
  })
})
