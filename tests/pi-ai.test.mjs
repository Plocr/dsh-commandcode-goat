import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_OPENAI_COMPAT,
  LLM_PI_AI_NS,
  SYNC_CODES,
  SyncError,
  buildRouteProfile,
  piAiSection,
  readPiAiValue,
  syncPlan,
  upsertProvider,
} from '../lib/pi-ai.js'

/** Apply one `{op,path,value}` op the way the settings service does. */
function applyOp(section, op) {
  const [head, ...rest] = op.path
  if (head === undefined) return op.op === 'unset' ? {} : { ...op.value }
  if (rest.length === 0) {
    if (op.op === 'set') return { ...section, [head]: op.value }
    const { [head]: _removed, ...kept } = section
    return kept
  }
  const child = section[head]
  const base = child !== null && typeof child === 'object' && !Array.isArray(child) ? child : {}
  return { ...section, [head]: applyOp(base, { ...op, path: rest }) }
}

/**
 * A stand-in for the settings service, faithful about the three things this
 * plugin depends on: `describe` returns resolved sections, `mutate` applies
 * path ops, and a write carries the revision it read.
 */
function fakeSettings({ value = {}, writable = true, registered = true, conflicts = 0, onMutate, entries } = {}) {
  const state = { value, revision: 7, writes: [], remainingConflicts: conflicts }
  return {
    writable,
    get value() {
      return state.value
    },
    get writes() {
      return state.writes
    },
    describe() {
      if (!registered) return []
      return entries ?? [{
        ns: LLM_PI_AI_NS,
        value: state.value,
        revision: state.revision,
        schema: { type: 'object', dict: { providers: {} } },
      }]
    },
    async mutate(ns, ops, revision) {
      state.writes.push({ ns, ops, revision })
      if (state.remainingConflicts > 0) {
        state.remainingConflicts -= 1
        state.revision += 1
        throw Object.assign(new Error(`namespace "${ns}" changed since it was read`), { code: 'SETTINGS_CONFLICT' })
      }
      onMutate?.(ops)
      for (const op of ops) state.value = applyOp(state.value, op)
      state.revision += 1
      return state.value
    },
  }
}

const ENTRIES = [
  { id: 'vendor/a', name: 'A', input: ['text'] },
  { id: 'claude-b', name: 'B', input: ['text', 'image'] },
]

describe('buildRouteProfile', () => {
  it('states everything a route needs to be served', () => {
    const profile = buildRouteProfile({ key: 'commandcode-goat-autosync', route: 'openai', entries: ENTRIES, plan: 'goat' })
    assert.equal(profile.api, 'openai-completions')
    assert.equal(profile.apiKeyEnv, 'COMMANDCODE_API_KEY')
    assert.equal(profile.baseURL, 'https://api.commandcode.ai/provider/v1')
    assert.equal(profile.models, ENTRIES)
    assert.deepEqual(profile.compat, DEFAULT_OPENAI_COMPAT)
    assert.equal(profile.displayName, 'Command Code GOAT')
  })

  it('never writes a compat block the protocol does not offer', () => {
    for (const route of ['anthropic', 'responses']) {
      const profile = buildRouteProfile({ key: `commandcode-pro-${route}`, route, entries: ENTRIES, plan: 'pro' })
      assert.equal('compat' in profile, false, `${route} must not carry compat`)
    }
    assert.equal(buildRouteProfile({ key: 'k', route: 'anthropic', entries: ENTRIES, plan: 'pro' }).api, 'anthropic-messages')
    assert.equal(buildRouteProfile({ key: 'k', route: 'responses', entries: ENTRIES, plan: 'pro' }).api, 'openai-responses')
  })

  it('honours a deployment override, and treats an empty one as absent', () => {
    const overridden = buildRouteProfile({
      key: 'k',
      route: 'openai',
      entries: ENTRIES,
      plan: 'max',
      cfg: { targetApiKeyEnv: 'MY_KEY', targetBaseURL: 'https://gateway.test/v1', targetCompat: { thinkingFormat: 'deepseek' } },
    })
    assert.equal(overridden.apiKeyEnv, 'MY_KEY')
    assert.equal(overridden.baseURL, 'https://gateway.test/v1')
    assert.deepEqual(overridden.compat, { thinkingFormat: 'deepseek' })

    // Schemastery materializes an absent `targetCompat` as `{}`, which states
    // nothing — it must not replace the reasoning-enabling default.
    const empty = buildRouteProfile({ key: 'k', route: 'openai', entries: ENTRIES, plan: 'max', cfg: { targetCompat: {} } })
    assert.deepEqual(empty.compat, DEFAULT_OPENAI_COMPAT)
  })
})

describe('piAiSection', () => {
  it('returns undefined when the service or the namespace is absent', () => {
    assert.equal(piAiSection(undefined), undefined)
    assert.equal(piAiSection({}), undefined)
    assert.equal(piAiSection(fakeSettings({ registered: false })), undefined)
  })

  it('finds the section under a renamed row', () => {
    // dsh 0.1.7 keys a settings section by the row the profile composed it
    // under, and the profile owns that id — so the section is identified by the
    // `providers` dict its schema carries when the shipped id is not there.
    const renamed = fakeSettings({
      entries: [{ ns: 'pi-ai', revision: 3, value: { providers: {} }, schema: { type: 'object', dict: { providers: {} } } }],
    })
    assert.equal(piAiSection(renamed)?.ns, 'pi-ai')
  })

  it('reads an empty section when the provider serves nothing yet', () => {
    assert.deepEqual(readPiAiValue(fakeSettings({ value: {} })), {})
  })
})

describe('upsertProvider', () => {
  it('creates a route that does not exist yet', async () => {
    const settings = fakeSettings()
    const profile = buildRouteProfile({ key: 'commandcode-goat-autosync', route: 'openai', entries: ENTRIES, plan: 'goat' })
    const result = await upsertProvider({ settings, key: 'commandcode-goat-autosync', profile })
    assert.deepEqual(result, { key: 'commandcode-goat-autosync', count: 2, created: true })
    assert.deepEqual(settings.writes[0].ops, [
      { op: 'set', path: ['providers', 'commandcode-goat-autosync'], value: profile },
    ])
    assert.equal(settings.value.providers['commandcode-goat-autosync'].models.length, 2)
  })

  it('passes the revision it read to the write', async () => {
    const settings = fakeSettings()
    await upsertProvider({ settings, key: 'k', profile: { models: [] } })
    assert.equal(settings.writes[0].revision, 7)
  })

  it('refreshes an existing route without touching the user\u2019s key, base URL or compat', async () => {
    const existing = {
      apiKeyEnv: 'MY_KEY',
      baseURL: 'https://my.proxy/v1',
      api: 'openai-completions',
      compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: false },
      models: [{ id: 'stale' }],
    }
    const settings = fakeSettings({ value: { providers: { 'commandcode-goat-autosync': existing } } })
    const profile = buildRouteProfile({ key: 'commandcode-goat-autosync', route: 'openai', entries: ENTRIES, plan: 'goat' })
    const result = await upsertProvider({ settings, key: 'commandcode-goat-autosync', profile })

    assert.equal(result.created, false)
    assert.deepEqual(settings.writes[0].ops, [
      { op: 'set', path: ['providers', 'commandcode-goat-autosync', 'displayName'], value: 'Command Code GOAT' },
      { op: 'set', path: ['providers', 'commandcode-goat-autosync', 'models'], value: ENTRIES },
    ])
    const written = settings.value.providers['commandcode-goat-autosync']
    assert.equal(written.apiKeyEnv, 'MY_KEY')
    assert.equal(written.baseURL, 'https://my.proxy/v1')
    assert.deepEqual(written.compat, { thinkingFormat: 'deepseek', supportsReasoningEffort: false })
    assert.deepEqual(written.models, ENTRIES)
  })

  it('leaves a display name the user chose alone', async () => {
    const settings = fakeSettings({
      value: { providers: { k: { displayName: '我的网关', api: 'openai-completions', baseURL: 'x', apiKeyEnv: 'A', models: [] } } },
    })
    await upsertProvider({ settings, key: 'k', profile: buildRouteProfile({ key: 'k', route: 'openai', entries: ENTRIES, plan: 'goat' }) })
    assert.equal(settings.value.providers.k.displayName, '我的网关')
  })

  it('fills in a compat dict schemastery left empty', async () => {
    const settings = fakeSettings({ value: { providers: { k: { api: 'openai-completions', baseURL: 'x', apiKeyEnv: 'A', compat: {}, models: [] } } } })
    const profile = buildRouteProfile({ key: 'k', route: 'openai', entries: ENTRIES, plan: 'goat' })
    await upsertProvider({ settings, key: 'k', profile })
    assert.deepEqual(settings.value.providers.k.compat, DEFAULT_OPENAI_COMPAT)
  })

  it('refuses to overwrite a route the user built with modelOverrides', async () => {
    const settings = fakeSettings({ value: { providers: { k: { modelOverrides: { 'x/y': { contextWindow: 1000 } } } } } })
    await assert.rejects(
      () => upsertProvider({ settings, key: 'k', profile: buildRouteProfile({ key: 'k', route: 'openai', entries: ENTRIES, plan: 'goat' }) }),
      (error) => {
        assert.ok(error instanceof SyncError)
        assert.equal(error.code, SYNC_CODES.overrides)
        assert.match(error.message, /modelOverrides/)
        return true
      },
    )
    assert.equal(settings.writes.length, 0)
  })

  it('resyncs a route whose modelOverrides the settings service materialized as an empty dict', async () => {
    // `settings.describe()` returns the section schemastery already parsed, and
    // schemastery turns an absent dict into `{}`. Reading the *presence* of the
    // key instead of its content made every re-sync of an existing route refuse
    // itself with "declares modelOverrides" — on a route that declared none.
    const settings = fakeSettings({
      value: {
        providers: {
          k: {
            api: 'openai-completions',
            baseURL: 'https://api.commandcode.ai/provider/v1',
            apiKeyEnv: 'COMMANDCODE_API_KEY',
            compat: { thinkingFormat: 'openai', supportsReasoningEffort: true },
            modelOverrides: {},
            models: [],
          },
        },
      },
    })
    const profile = buildRouteProfile({ key: 'k', route: 'openai', entries: ENTRIES, plan: 'goat' })
    const result = await upsertProvider({ settings, key: 'k', profile })
    assert.equal(result.created, false)
    assert.deepEqual(settings.value.providers.k.models, ENTRIES)
  })

  it('retries once when the section moved under it', async () => {
    const settings = fakeSettings({ conflicts: 1 })
    const result = await upsertProvider({ settings, key: 'k', profile: { models: ENTRIES } })
    assert.equal(result.created, true)
    assert.equal(settings.writes.length, 2)
    assert.equal(settings.writes[1].revision, 8, 'the second attempt re-read the moved revision')
  })

  it('reports a conflict that survives the retry as a coded failure', async () => {
    const settings = fakeSettings({ conflicts: 5 })
    await assert.rejects(
      () => upsertProvider({ settings, key: 'k', profile: { models: [] } }),
      (error) => error.code === SYNC_CODES.conflict,
    )
  })

  it('refuses to write where there is nowhere to write', async () => {
    await assert.rejects(() => upsertProvider({ settings: undefined, key: 'k', profile: {} }), (error) => error.code === SYNC_CODES.noSettings)
    await assert.rejects(
      () => upsertProvider({ settings: fakeSettings({ registered: false }), key: 'k', profile: {} }),
      (error) => {
        assert.equal(error.code, SYNC_CODES.noProvider)
        assert.match(error.message, /llm-pi-ai/)
        return true
      },
    )
    await assert.rejects(
      () => upsertProvider({ settings: fakeSettings({ writable: false }), key: 'k', profile: {} }),
      (error) => error.code === SYNC_CODES.readOnly,
    )
  })

  it('turns a provider-plugin rejection into a coded failure with its message', async () => {
    const settings = fakeSettings({
      onMutate() {
        throw new Error('llm-pi-ai: provider "k" model "vendor/a" needs an api')
      },
    })
    await assert.rejects(
      () => upsertProvider({ settings, key: 'k', profile: { models: [] } }),
      (error) => {
        assert.equal(error.code, SYNC_CODES.rejected)
        assert.match(error.message, /needs an api/)
        return true
      },
    )
  })
})

describe('syncPlan', () => {
  const routes = { openai: ENTRIES, anthropic: [], responses: [] }

  it('writes the routes that hold models and reports the empty ones as skipped', async () => {
    const settings = fakeSettings()
    const result = await syncPlan({ settings, plan: 'goat', routes })
    assert.equal(result.routes.length, 1)
    assert.equal(result.routes[0].key, 'commandcode-goat-autosync')
    assert.deepEqual(result.skipped, ['anthropic', 'responses'])
  })

  it('writes a second route for a tier that holds Claude models', async () => {
    const settings = fakeSettings()
    const result = await syncPlan({ settings, plan: 'pro', routes: { openai: [], anthropic: ENTRIES, responses: [] } })
    assert.deepEqual(result.routes.map((route) => route.key), ['commandcode-pro-anthropic'])
    assert.equal(settings.value.providers['commandcode-pro-anthropic'].api, 'anthropic-messages')
  })

  it('reports an empty selection rather than creating an unservable route', async () => {
    const settings = fakeSettings()
    await assert.rejects(
      () => syncPlan({ settings, plan: 'goat', routes: { openai: [], anthropic: [], responses: [] } }),
      (error) => {
        assert.equal(error.code, SYNC_CODES.nothing)
        assert.match(error.message, /GOAT/)
        return true
      },
    )
    assert.equal(settings.writes.length, 0)
  })
})
