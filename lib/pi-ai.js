/**
 * Writing Command Code models into the `llm-pi-ai` settings section.
 *
 * This plugin owns no LLM adapter. It publishes *provider profiles* into the
 * first-party provider plugin's namespace, which means the streaming, tool
 * calling, reasoning and image handling come from the adapter the harness
 * already ships and tests, and the generated routes appear wherever a provider
 * route appears — the model selector and Settings → Models.
 *
 * The rules that shape every write below come from the `llm-pi-ai` profile
 * schema (`packages/llm/llm-pi-ai`):
 *
 *   - `providers` is a dict keyed by route, not a list.
 *   - `api`, `baseURL` and a full `models` list are what let a route exist that
 *     the installed catalog does not describe; without them nothing can be
 *     served.
 *   - `models` *replaces* the served catalog, and cannot be combined with
 *     `modelOverrides`.
 *   - `compat` fields are protocol-gated: `thinkingFormat` and
 *     `supportsReasoningEffort` exist only on `openai-completions`, so writing
 *     them onto the Anthropic route would be refused.
 *
 * Everything here is pure except `upsertProvider` and `syncPlan`, which take
 * the settings service as an argument so tests can drive a stub.
 */

import { DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, PLAN_TITLES, providerKey, routeProtocol, ROUTE_ORDER } from './catalog.js'
import { isGeneratedDisplayName, parseGeneratedKey, providerDisplayName } from './plans.js'

/** The first-party provider plugin's settings namespace. */
export const LLM_PI_AI_NS = 'llm-pi-ai'

/**
 * The reasoning switches an OpenAI-compatible gateway needs. Command Code's
 * `/chat/completions` route speaks the OpenAI reasoning vocabulary, and the
 * harness otherwise refuses to send a thinking parameter at all.
 */
export const DEFAULT_OPENAI_COMPAT = { thinkingFormat: 'openai', supportsReasoningEffort: true }

/** Stable failure codes the settings card renders as text. */
export const SYNC_CODES = {
  noSettings: 'settings-unavailable',
  noProvider: 'provider-plugin-missing',
  readOnly: 'settings-read-only',
  noKey: 'no-api-key',
  conflict: 'settings-conflict',
  overrides: 'target-has-model-overrides',
  rejected: 'settings-rejected',
  fetch: 'fetch-failed',
  nothing: 'nothing-to-write',
}

/** An expected sync failure carrying a code the card can explain. */
export class SyncError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SyncError'
    this.code = code
  }
}

/**
 * The provider plugin's settings section, under whatever id the profile gave
 * its row.
 *
 * Since dsh 0.1.7 a settings section *is* a plugin entry: `describe()` returns
 * one descriptor per composed row keyed by that row's id, and a write targets
 * the entry's own Config. So the route profiles live under the id of the row
 * that composes `llm-pi-ai` — `llm-pi-ai` in the shipped base bundle, but the
 * profile owns that id, so a rename is honoured rather than assumed. The
 * fallback identifies the section by the `providers` dict its schema carries.
 */
export function piAiSection(settings) {
  const descriptors = settings?.describe?.({ redactSecrets: true })
  if (!Array.isArray(descriptors)) return undefined
  return descriptors.find((descriptor) => String(descriptor?.ns) === LLM_PI_AI_NS)
    ?? descriptors.find((descriptor) => descriptor?.schema?.dict?.providers !== undefined)
}

/** The current `llm-pi-ai` section value, or an empty section when unserved. */
export function readPiAiValue(settings) {
  return piAiSection(settings)?.value ?? {}
}

/**
 * The provider profile one tier's route should hold.
 *
 * `apiKeyEnv`, `baseURL` and `api` are the fields that let a route exist at
 * all; on a route that already carries them, {@link refreshOps} leaves the
 * user's values in place and only this profile's *shape* decides what a
 * not-yet-configured route starts from.
 *
 * @param request - `{ key, route, entries, plan, cfg }`. `cfg` carries the
 *   optional deployment overrides (`targetApiKeyEnv`, `targetBaseURL`,
 *   `targetCompat`).
 * @returns the profile as it would be written to a route that has none yet.
 */
export function buildRouteProfile({ key, route, entries, plan, cfg = {} }) {
  const protocol = routeProtocol(route)
  const profile = {
    apiKeyEnv: typeof cfg.targetApiKeyEnv === 'string' && cfg.targetApiKeyEnv !== '' ? cfg.targetApiKeyEnv : DEFAULT_API_KEY_ENV,
    displayName: cfg.targetDisplayName ?? providerDisplayName(plan, route),
    api: protocol,
    baseURL: typeof cfg.targetBaseURL === 'string' && cfg.targetBaseURL !== '' ? cfg.targetBaseURL : DEFAULT_BASE_URL,
    models: entries,
  }
  if (route === 'openai') {
    // Only the completions protocol offers these switches; sending them on
    // another route is refused by the provider plugin's own validation.
    const override = cfg.targetCompat
    profile.compat = override !== undefined && override !== null && Object.keys(override).length > 0
      ? override
      : { ...DEFAULT_OPENAI_COMPAT }
  }
  return profile
}

/** The ops that bring one existing route up to date without touching user choices. */
function refreshOps(key, profile, existing) {
  if (existing === undefined || existing === null || typeof existing !== 'object') {
    return [{ op: 'set', path: ['providers', key], value: profile }]
  }
  // `settings.describe()` hands back the section schemastery already *parsed*,
  // and schemastery materializes an absent dict as `{}` — so "no overrides"
  // arrives as an empty object, not as `undefined`. Reading the presence of
  // the key rather than its content made every re-sync of an existing route
  // refuse itself. Only a populated dict is a real conflict, because only a
  // populated one genuinely cannot coexist with a generated `models` list.
  const overrides = existing.modelOverrides
  if (overrides !== null && typeof overrides === 'object' && Object.keys(overrides).length > 0) {
    throw new SyncError(
      SYNC_CODES.overrides,
      `llm-pi-ai route "${key}" declares modelOverrides, which cannot be combined with a generated models list; remove it or point this plugin at a different target`,
    )
  }
  const ops = []
  for (const field of ['apiKeyEnv', 'baseURL', 'api']) {
    if (existing[field] === undefined || existing[field] === '') {
      ops.push({ op: 'set', path: ['providers', key, field], value: profile[field] })
    }
  }
  // The display name is the one field a re-sync has a reason to *replace*: it
  // is what the reader sees in Settings → Models, and the two routes of one
  // tier used to share it, which made them read as a duplicate provider. Only a
  // name this plugin generated is refreshed; one the reader typed is theirs.
  const currentName = existing.displayName
  if (currentName === undefined || currentName === ''
    || (isGeneratedDisplayName(currentName) && currentName !== profile.displayName)) {
    ops.push({ op: 'set', path: ['providers', key, 'displayName'], value: profile.displayName })
  }
  // A compat dict schemastery materialized as `{}` states nothing, so it is
  // replaced; a populated one is the user's decision and is left alone.
  const compat = existing.compat
  const compatEmpty = compat === undefined
    || compat === null
    || (typeof compat === 'object' && Object.keys(compat).length === 0)
  if (profile.compat !== undefined && compatEmpty) {
    ops.push({ op: 'set', path: ['providers', key, 'compat'], value: profile.compat })
  }
  ops.push({ op: 'set', path: ['providers', key, 'models'], value: profile.models })
  return ops
}

/**
 * Write one op list into the provider plugin's section.
 *
 * Two attempts, because a concurrent write to any other namespace section
 * moves the revision and re-reading is enough to land on the next one. Shared
 * by the upsert and the prune below so the two cannot disagree about what a
 * conflict is or about which failure code it carries.
 *
 * @throws {SyncError} with the code the card explains.
 */
async function applyOps(settings, section, ops, what) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const descriptor = piAiSection(settings)
    const revision = typeof descriptor?.revision === 'number' ? descriptor.revision : undefined
    try {
      // The section's own id, which is the row the profile composed it under.
      await settings.mutate(String(section.ns), ops, revision)
      return
    } catch (error) {
      const code = error?.code
      const message = error instanceof Error ? error.message : String(error)
      const conflict = code === 'SETTINGS_CONFLICT' || /conflict/i.test(message)
      if (conflict && attempt === 0) continue
      if (conflict) throw new SyncError(SYNC_CODES.conflict, `llm-pi-ai changed while writing: ${message}`)
      if (error instanceof SyncError) throw error
      throw new SyncError(SYNC_CODES.rejected, message)
    }
  }
  throw new SyncError(SYNC_CODES.conflict, `llm-pi-ai changed on every attempt while writing ${what}`)
}

/**
 * The section a write targets, or the coded failure explaining why there is none.
 *
 * @throws {SyncError} when the deployment serves no writable settings section.
 */
function writableSection(settings) {
  if (settings === undefined || settings === null) {
    throw new SyncError(SYNC_CODES.noSettings, 'the settings service is not available in this deployment')
  }
  const section = piAiSection(settings)
  if (section === undefined) {
    throw new SyncError(
      SYNC_CODES.noProvider,
      `the "${LLM_PI_AI_NS}" settings section is not served here, so there is nowhere to write a provider route; load @deepseek-ai/dsh-llm-pi-ai in this profile`,
    )
  }
  if (settings.writable === false) {
    throw new SyncError(SYNC_CODES.readOnly, 'this deployment mounts a read-only settings provider')
  }
  return section
}

/**
 * The sections whose config still names one of these route keys.
 *
 * A generated route is not only a provider row: the profile's own config can
 * point at it — the default-model row names a provider, and the subagent model
 * list names one per entry. Removing a route therefore can strand a reference,
 * and a reference to a provider that no longer exists is a model picker that
 * silently loses its default. Reading every other section and saying which ones
 * still name a key is what turns that into a sentence instead of a mystery.
 *
 * Only the plugin's own target section is skipped: it is the one that just
 * stopped naming them.
 *
 * @param request - `{ settings, keys }`.
 * @returns one `"<section id>: <keys>"` line per section that still refers to one.
 */
export function sectionsReferencing(settings, keys) {
  const wanted = (Array.isArray(keys) ? keys : []).filter((key) => typeof key === 'string' && key !== '')
  if (wanted.length === 0) return []
  const descriptors = settings?.describe?.({ redactSecrets: true })
  if (!Array.isArray(descriptors)) return []
  const hits = []
  for (const descriptor of descriptors) {
    const ns = String(descriptor?.ns ?? '')
    if (ns === '' || ns === LLM_PI_AI_NS) continue
    let text
    try {
      text = JSON.stringify(descriptor?.value ?? {})
    } catch {
      continue
    }
    const named = wanted.filter((key) => text.includes(key))
    if (named.length > 0) hits.push(`${ns}: ${named.join(', ')}`)
  }
  return hits
}

/**
 * Create or refresh one route.
 *
 * @param request - `{ settings, key, profile }`.
 * @returns `{ key, count, created }`.
 * @throws {SyncError} when settings cannot be written or the write is refused.
 */
export async function upsertProvider({ settings, key, profile }) {
  const section = writableSection(settings)
  const current = readPiAiValue(settings)
  const providers = current?.providers
  const existing = providers !== undefined && providers !== null && typeof providers === 'object' ? providers[key] : undefined
  const ops = refreshOps(key, profile, existing)

  await applyOps(settings, section, ops, `"${key}"`)
  return { key, count: profile.models.length, created: existing === undefined }
}

/**
 * Delete the generated routes that belong to a tier other than this one.
 *
 * Every tier writes its own set of provider keys, which is what keeps a switch
 * from overwriting anything — and also what leaves the previous tier's routes
 * behind forever. Those are the ghost providers this exists to remove: after a
 * move from Pro to GOAT the account no longer has Pro, so a `Command | pro` row
 * in Settings → Models is a provider that can only fail, listed beside the one
 * that works, under a nearly identical name.
 *
 * The match is deliberately narrow. Only keys this plugin generates are
 * considered at all ({@link parseGeneratedKey}), and a route carrying
 * `modelOverrides` is left alone and reported instead: that is a hand edit this
 * plugin promised never to overwrite, and deleting it would be the one
 * irreversible thing here.
 *
 * @param request - `{ settings, plan, keys }`. `keys` limits the sweep to a
 *   known set (the bridge's prune); absent, every generated key is examined.
 * @returns `{ plan, removed, kept, protected }`.
 */
export async function pruneGeneratedRoutes({ settings, plan, keys }) {
  const section = writableSection(settings)
  const providers = readPiAiValue(settings)?.providers ?? {}
  const scope = Array.isArray(keys) ? new Set(keys) : undefined

  const removed = []
  const kept = []
  const protectedKeys = []
  for (const key of Object.keys(providers)) {
    const parsed = parseGeneratedKey(key)
    if (parsed === undefined) continue
    if (scope !== undefined && !scope.has(key)) continue
    if (parsed.plan === plan) {
      kept.push(key)
      continue
    }
    const overrides = providers[key]?.modelOverrides
    if (overrides !== null && typeof overrides === 'object' && Object.keys(overrides).length > 0) {
      protectedKeys.push(key)
      continue
    }
    removed.push(key)
  }
  if (removed.length === 0) return { plan, removed, kept, protected: protectedKeys }

  // One mutate for the whole sweep: a partial prune would leave the section in
  // a state nobody asked for, and the settings service applies an op list
  // atomically.
  await applyOps(settings, section, removed.map((key) => ({ op: 'unset', path: ['providers', key] })), removed.join(', '))
  return { plan, removed, kept, protected: protectedKeys }
}

/**
 * Write one tier's whole route set.
 *
 * Only routes that received models are written. A tier that holds no Claude
 * model therefore creates no Anthropic route at all, rather than an empty
 * route the provider plugin would refuse.
 *
 * @param request - `{ settings, plan, routes, cfg }`.
 * @returns `{ plan, routes: [{key, route, count, created}], skipped: [route] }`.
 */
export async function syncPlan({ settings, plan, routes, cfg = {} }) {
  const written = []
  const skipped = []
  for (const route of ROUTE_ORDER) {
    const entries = routes?.[route] ?? []
    if (entries.length === 0) {
      skipped.push(route)
      continue
    }
    const key = providerKey(plan, route)
    const profile = buildRouteProfile({ key, route, entries, plan, cfg })
    const result = await upsertProvider({ settings, key, profile })
    written.push({ ...result, route })
  }
  if (written.length === 0) {
    throw new SyncError(SYNC_CODES.nothing, `the ${PLAN_TITLES[plan] ?? plan} tier selected no models; check the subscription tier and the source URL`)
  }
  return { plan, routes: written, skipped }
}
