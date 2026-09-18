/**
 * Command Code plan catalog — model discovery and mapping.
 *
 * Pure module: no Cordis, no DSH, no I/O beyond the two fetchers, so every
 * parsing and mapping rule below is unit-testable with plain `node --test`.
 *
 * It answers three questions:
 *
 *   1. Which models does Command Code serve right now, and on which wire
 *      protocol does each one live?
 *   2. Which of those are inside the subscription tier the user selected?
 *   3. What does `llm-pi-ai` need to hear about each model — context window,
 *      input modalities, whether reasoning may be sent at all?
 *
 * Two upstream sources are joined:
 *
 *   - `GET /provider/v1/models` — the live, authoritative list. Each entry
 *     carries `id`, `name`, `context_length` and, since the gateway update of
 *     2026-09, `supported_endpoints`. That last field is the *routing truth*:
 *     a Claude model sent to `/chat/completions` is rejected with 400, and an
 *     id-prefix heuristic only approximates the same answer.
 *   - The GOAT plan docs page — the official per-model capability catalog
 *     (`reasoning` / `vision` / `caps` / `minPlanName`), which the models
 *     endpoint does not expose at all. It is embedded in the page's React
 *     Server Components payload, so it is read from there.
 *
 * The docs catalog is an *enrichment*: if it cannot be fetched or parsed, the
 * live list alone still produces a serviceable route set, minus capability
 * metadata and tier filtering. Callers report that as a degraded sync.
 */

/** Live model list (OpenAI-shaped `{ data: [...] }`). */
export const DEFAULT_SOURCE_URL = 'https://api.commandcode.ai/provider/v1/models'
/** GOAT plan page, whose RSC payload carries the capability catalog. */
export const DEFAULT_CATALOG_URL = 'https://commandcode.ai/docs/plans/goat'
/** Chat base: everything under `/provider/v1` speaks one of the chat protocols. */
export const DEFAULT_BASE_URL = 'https://api.commandcode.ai/provider/v1'
/** API root. Usage and search live on `/alpha/*`, outside the chat base. */
export const DEFAULT_ALPHA_BASE_URL = 'https://api.commandcode.ai'
/** Credential reference the generated routes resolve their key through. */
export const DEFAULT_API_KEY_ENV = 'COMMANDCODE_API_KEY'

/** Selectable subscription tiers, cheapest first. */
export const PLANS = ['goat', 'pro', 'max']

/** Display names for the tiers, in the vendor's own spelling. */
export const PLAN_TITLES = { goat: 'GOAT', pro: 'Pro', max: 'Max' }

/**
 * Tier membership, expressed the way the official pages express it: a tier
 * *includes* every model whose `minPlanName` it is at or above. `max` is the
 * top tier, so it admits every catalog entry including ones naming a tier
 * this build has never heard of.
 */
const PLAN_MIN = {
  goat: new Set(['Go', 'GOAT']),
  pro: new Set(['Go', 'GOAT', 'Pro']),
  max: null,
}

/** Every `minPlanName` the catalog is known to use. */
const KNOWN_MIN_PLANS = new Set(['Go', 'GOAT', 'Pro', 'Max'])

/**
 * The three wire protocols a `llm-pi-ai` route can declare, keyed by the route
 * slot this module sorts models into. `suffix` is the generated provider name's
 * tail: `commandcode-<plan>-<suffix>`.
 */
export const ROUTES = {
  openai: { protocol: 'openai-completions', suffix: 'autosync' },
  anthropic: { protocol: 'anthropic-messages', suffix: 'anthropic' },
  responses: { protocol: 'openai-responses', suffix: 'responses' },
}

/** Route slots in the order a sync creates them. */
export const ROUTE_ORDER = ['openai', 'anthropic', 'responses']

/** The `llm-pi-ai` provider key one tier's route is written to. */
export function providerKey(plan, route) {
  const entry = ROUTES[route]
  if (entry === undefined) throw new TypeError(`unknown route ${JSON.stringify(route)}`)
  return `commandcode-${plan}-${entry.suffix}`
}

/** The wire protocol one route slot speaks. */
export function routeProtocol(route) {
  const entry = ROUTES[route]
  if (entry === undefined) throw new TypeError(`unknown route ${JSON.stringify(route)}`)
  return entry.protocol
}

/** Lowercase, punctuation-free form used to match ids against catalog slugs. */
export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Which route one model belongs on.
 *
 * `supported_endpoints` from the live list decides whenever it is present,
 * because it is the gateway stating its own terms. The order below matters:
 * a model served on both chat and messages endpoints is taken as OpenAI-shaped
 * — that is the wider protocol and the one whose request shape the model's
 * non-Anthropic siblings share. The catalog's `vendor` and an id prefix are
 * only reached for a gateway that predates the field.
 *
 * @param model - live-list entry (`id`, optional `supportedEndpoints`).
 * @param catalogEntry - matching catalog entry, when one was found.
 * @returns the route slot to sort this model into.
 */
export function routeForModel(model, catalogEntry) {
  const endpoints = Array.isArray(model?.supportedEndpoints) ? model.supportedEndpoints : []
  if (endpoints.length > 0) {
    if (endpoints.includes('/chat/completions')) return 'openai'
    if (endpoints.includes('/responses')) return 'responses'
    if (endpoints.includes('/messages')) return 'anthropic'
  }
  const id = String(model?.id ?? '')
  if (catalogEntry?.vendor === 'Anthropic' || id.startsWith('claude')) return 'anthropic'
  return 'openai'
}

/**
 * Parse the live `/provider/v1/models` body.
 *
 * @param payload - parsed JSON.
 * @returns one normalized entry per model, in vendor order.
 * @throws {TypeError} when the body is not the documented `{ data: [...] }`.
 */
export function parseModelListPayload(payload) {
  const list = payload?.data
  if (!Array.isArray(list)) {
    throw new TypeError('unexpected /provider/v1/models response: expected { data: [...] }')
  }
  const seen = new Set()
  const models = []
  for (const raw of list) {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const contextWindow = Number(raw.context_length ?? raw.contextWindow)
    models.push({
      id,
      name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id,
      ...Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {},
      ...Array.isArray(raw.supported_endpoints)
        ? { supportedEndpoints: raw.supported_endpoints.filter((endpoint) => typeof endpoint === 'string') }
        : {},
    })
  }
  return models
}

/** Fetch and parse the live model list. */
export async function fetchModelList(url, signal) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, ...(signal ? { signal } : {}) })
  if (!response.ok) throw new Error(`fetch ${url} failed: HTTP ${response.status} ${response.statusText}`)
  return parseModelListPayload(await response.json())
}

/**
 * Extract the capability catalog from the GOAT plan page.
 *
 * The page is a Next.js App Router document, so its data arrives as a stream
 * of `self.__next_f.push([1,"…"])` chunks whose payloads are JSON-escaped
 * fragments of one long string. Concatenating the unescaped fragments yields
 * the serialized RSC payload, inside which the catalog is a top-level array
 * beginning `[{"slug":`. The slice is then read with a string-aware bracket
 * scan — a naive `lastIndexOf(']')` would run past the array into whatever the
 * page carries next — and `"$undefined"` placeholders become `null` so the
 * result is valid JSON.
 *
 * @param html - the raw page body.
 * @returns the catalog entries as published.
 * @throws {Error} when the page carries no recognizable payload.
 */
export function parseCatalogPayload(html) {
  const text = String(html ?? '')
  const chunks = []
  for (const match of text.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
    chunks.push(match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
  }
  if (chunks.length === 0) throw new Error('no RSC payload found in the plan page')

  const joined = chunks.join('')
  const start = joined.indexOf('[{"slug":')
  if (start < 0) throw new Error('the plan page carries no model catalog array')

  let depth = 0
  let index = start
  let inString = false
  let escaped = false
  for (; index < joined.length; index += 1) {
    const char = joined[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) break
    }
  }
  if (depth !== 0) throw new Error('the plan page catalog array is unterminated')

  const json = joined.slice(start, index + 1).replace(/"\$undefined"/g, 'null')
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error(`the plan page catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed)) throw new Error('the plan page catalog is not an array')
  return parsed
}

/** Fetch and parse the capability catalog. */
export async function fetchCatalog(url, signal) {
  const response = await fetch(url, { headers: { accept: 'text/html' }, ...(signal ? { signal } : {}) })
  if (!response.ok) throw new Error(`fetch ${url} failed: HTTP ${response.status} ${response.statusText}`)
  return parseCatalogPayload(await response.text())
}

/** Index the catalog by both published id and slug. */
function indexCatalog(catalog) {
  const byId = new Map()
  const bySlug = new Map()
  const byName = new Map()
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.id === 'string' && entry.id !== '' && !byId.has(entry.id)) byId.set(entry.id, entry)
    if (typeof entry.slug === 'string' && entry.slug !== '') {
      const slug = slugify(entry.slug)
      if (!bySlug.has(slug)) bySlug.set(slug, entry)
    }
    if (typeof entry.name === 'string' && entry.name !== '' && !byName.has(entry.name)) byName.set(entry.name, entry)
  }
  return { byId, bySlug, byName }
}

/**
 * Find the catalog entry describing one live model: exact id, then the id's
 * slug form against the published slug, then the display name — the vendor
 * renames ids between releases, so a strict id join keeps working only until
 * the next rename.
 */
function matchCatalogEntry(index, model) {
  return index.byId.get(model.id)
    ?? index.bySlug.get(slugify(model.id))
    ?? index.byName.get(model.name)
}

/** Whether a catalog entry sits inside the selected tier. */
function withinPlan(entry, plan) {
  if (entry === undefined) return { included: true, reason: 'unindexed' }
  if (plan === 'max') return { included: true, reason: 'tier' }
  const min = PLAN_MIN[plan]
  if (min === null) return { included: true, reason: 'tier' }
  const minPlanName = entry.minPlanName
  if (typeof minPlanName !== 'string' || minPlanName === '') return { included: true, reason: 'unindexed' }
  if (!KNOWN_MIN_PLANS.has(minPlanName)) return { included: false, reason: 'unknown-tier' }
  return { included: min.has(minPlanName), reason: 'tier' }
}

/**
 * The capability fields one model contributes to `llm-pi-ai`.
 *
 * Only what the sources actually state is written. `llm-pi-ai` treats an
 * absent `input` as "text" and an absent `reasoningEfforts` as "keep the
 * installed catalog's answer", so an unenriched model stays honestly
 * under-claimed instead of gaining invented capabilities.
 */
function capabilities(entry, includeReasoningEfforts) {
  const fields = {}
  if (entry === undefined) return { input: ['text'], fields }

  // The catalog carries `vision` / `reasoning` as flat fields and the same two
  // answers again inside `caps`. They agree in the published data; the flat
  // field is the one the plan tables are generated from, so it wins when a
  // future revision lets them drift, and `caps` is the fallback.
  const stated = (flat, nested) => (typeof entry[flat] === 'boolean' ? entry[flat] : entry.caps?.[nested] === true)
  const vision = stated('vision', 'vision') === true
  const reasoning = stated('reasoning', 'reasoning')
  fields.input = vision ? ['text', 'image'] : ['text']

  if (reasoning === false) {
    // The vendor states the model cannot think; blocking the parameter is the
    // only way to stop the harness sending one the gateway would reject.
    fields.reasoningEfforts = false
  } else if (reasoning === true && includeReasoningEfforts === true) {
    // The catalog marks capability but publishes no per-level wire values, so
    // this opt-in states the identity mapping across the levels the vendor's
    // own catalog advertises. Without it, the route-level compat switch
    // decides, which is what the vendor's docs describe.
    fields.reasoningEfforts = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
  }
  return fields
}

/**
 * Build the `llm-pi-ai` model entries for one tier.
 *
 * @param request - `{ apiList, catalog, plan, extraIds, includeReasoningEfforts }`.
 * @returns `{ routes, diagnostics }` — `routes` holds one sorted, possibly
 *   empty array per route slot; `diagnostics` lists what the sync could not
 *   state about the list it just wrote, for the caller to surface.
 */
export function buildEntries({ apiList, catalog, plan = 'goat', extraIds = [], includeReasoningEfforts = false }) {
  const index = indexCatalog(catalog)
  const routes = { openai: [], anthropic: [], responses: [] }
  const diagnostics = []
  let excluded = 0
  let unindexed = 0
  let unknownTier = 0

  for (const model of Array.isArray(apiList) ? apiList : []) {
    if (model === null || typeof model !== 'object' || typeof model.id !== 'string' || model.id === '') continue
    const entry = matchCatalogEntry(index, model)
    const gate = withinPlan(entry, plan)
    if (!gate.included) {
      excluded += 1
      if (gate.reason === 'unknown-tier') unknownTier += 1
      continue
    }
    if (gate.reason === 'unindexed') unindexed += 1

    const route = routeForModel(model, entry)
    const item = { id: model.id }
    const name = entry?.name ?? model.name
    if (typeof name === 'string' && name !== '' && name !== model.id) item.name = name
    const contextWindow = model.contextWindow ?? entry?.contextWindow
    if (Number.isFinite(contextWindow) && contextWindow > 0) item.contextWindow = contextWindow
    Object.assign(item, capabilities(entry, includeReasoningEfforts))
    routes[route].push(item)
  }

  // Private ids outside the published catalog always belong on the OpenAI-shaped
  // route: they are the user's own deployment detail, and nothing can route
  // them by capability because nothing describes them.
  const known = new Set((Array.isArray(apiList) ? apiList : []).map((model) => model?.id))
  for (const raw of Array.isArray(extraIds) ? extraIds : []) {
    const id = String(raw ?? '').trim()
    if (id === '' || known.has(id)) continue
    known.add(id)
    routes.openai.push({ id, input: ['text'] })
  }

  for (const route of ROUTE_ORDER) routes[route].sort((left, right) => left.id.localeCompare(right.id))

  if (!Array.isArray(catalog) || catalog.length === 0) {
    diagnostics.push('capability catalog unavailable: reasoning and vision are unstated, and every model is treated as inside the selected tier')
  } else {
    if (unindexed > 0) diagnostics.push(`${unindexed} model(s) are not in the capability catalog: capabilities unstated and tier unchecked`)
    if (unknownTier > 0) diagnostics.push(`${unknownTier} model(s) name a subscription tier this build does not know, so they were left out of ${plan}`)
  }
  if (excluded > 0) diagnostics.push(`${excluded} model(s) sit above the ${PLAN_TITLES[plan] ?? plan} tier and were left out`)

  return { routes, diagnostics }
}

/**
 * Count what the catalog offers per tier, without needing the live list — what
 * the settings card shows when explaining what a tier would select.
 */
export function planCatalogSummary(catalog, plan) {
  const counts = { goat: 0, pro: 0, max: 0 }
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (entry === null || typeof entry !== 'object') continue
    const min = typeof entry.minPlanName === 'string' ? entry.minPlanName : ''
    if (min === 'Max') counts.max += 1
    else if (min === 'Pro') counts.pro += 1
    else if (min === 'GOAT' || min === 'Go') counts.goat += 1
    else counts.max += 1
  }
  return {
    goat: counts.goat,
    pro: counts.goat + counts.pro,
    max: counts.goat + counts.pro + counts.max,
  }[plan] ?? 0
}
