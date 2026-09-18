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

/** One namespace's descriptor, redacted so secrets never leave the host. */
export function describeNamespace(settings, ns) {
  const descriptors = settings?.describe?.({ redactSecrets: true })
  if (!Array.isArray(descriptors)) return undefined
  return descriptors.find((descriptor) => String(descriptor?.ns) === ns)
}

/** The current `llm-pi-ai` section value, or an empty section when unserved. */
export function readPiAiValue(settings) {
  return describeNamespace(settings, LLM_PI_AI_NS)?.value ?? {}
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
    displayName: cfg.targetDisplayName ?? `Command Code ${PLAN_TITLES[plan] ?? plan ?? ''}`.trim(),
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
  if (existing.modelOverrides !== undefined) {
    throw new SyncError(
      SYNC_CODES.overrides,
      `llm-pi-ai route "${key}" declares modelOverrides, which cannot be combined with a generated models list; remove it or point this plugin at a different target`,
    )
  }
  const ops = []
  for (const field of ['apiKeyEnv', 'baseURL', 'api', 'displayName']) {
    if (existing[field] === undefined || existing[field] === '') {
      ops.push({ op: 'set', path: ['providers', key, field], value: profile[field] })
    }
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
 * Create or refresh one route.
 *
 * @param request - `{ settings, key, profile }`.
 * @returns `{ key, count, created }`.
 * @throws {SyncError} when settings cannot be written or the write is refused.
 */
export async function upsertProvider({ settings, key, profile }) {
  if (settings === undefined || settings === null) {
    throw new SyncError(SYNC_CODES.noSettings, 'the settings service is not available in this deployment')
  }
  if (describeNamespace(settings, LLM_PI_AI_NS) === undefined) {
    throw new SyncError(
      SYNC_CODES.noProvider,
      `the "${LLM_PI_AI_NS}" settings section is not served here, so there is nowhere to write a provider route; load @deepseek-ai/dsh-llm-pi-ai in this profile`,
    )
  }
  if (settings.writable === false) {
    throw new SyncError(SYNC_CODES.readOnly, 'this deployment mounts a read-only settings provider')
  }

  const current = readPiAiValue(settings)
  const providers = current?.providers
  const existing = providers !== undefined && providers !== null && typeof providers === 'object' ? providers[key] : undefined
  const ops = refreshOps(key, profile, existing)

  // Two attempts: a concurrent write to any other namespace section moves the
  // revision, and re-reading is enough to land on the next one.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const descriptor = describeNamespace(settings, LLM_PI_AI_NS)
    const revision = typeof descriptor?.revision === 'number' ? descriptor.revision : undefined
    try {
      await settings.mutate(LLM_PI_AI_NS, ops, revision)
      return { key, count: profile.models.length, created: existing === undefined }
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
  throw new SyncError(SYNC_CODES.conflict, `llm-pi-ai changed on every attempt while writing "${key}"`)
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
