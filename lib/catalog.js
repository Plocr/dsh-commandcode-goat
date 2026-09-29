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
 *   - The plan docs page — the official per-model capability catalog
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
/**
 * Plan page carrying the capability catalog.
 *
 * The Go, GOAT and Pro pages publish the same array; the Max page publishes a
 * different payload with no catalog in it at all. `plans.js` owns the
 * per-tier candidate list and the fallback, which is why the default here is
 * the page that always answers.
 */
export const DEFAULT_CATALOG_URL = 'https://commandcode.ai/docs/plans/goat'
/** Chat base: everything under `/provider/v1` speaks one of the chat protocols. */
export const DEFAULT_BASE_URL = 'https://api.commandcode.ai/provider/v1'
/** API root. Usage and search live on `/alpha/*`, outside the chat base. */
export const DEFAULT_ALPHA_BASE_URL = 'https://api.commandcode.ai'
/** Credential reference the generated routes resolve their key through. */
export const DEFAULT_API_KEY_ENV = 'COMMANDCODE_API_KEY'

/**
 * Selectable subscription tiers, cheapest first.
 *
 * `go` is a real subscription — the vendor's billing API returns
 * `individual-go` for it — and it is the one tier whose models are *only* its
 * own: every other tier is strictly cumulative above it.
 */
export const PLANS = ['go', 'goat', 'pro', 'max']

/** Display names for the tiers, in the vendor's own spelling. */
export const PLAN_TITLES = { go: 'Go', goat: 'GOAT', pro: 'Pro', max: 'Max' }

/**
 * Tier membership, expressed the way the official pages express it: a tier
 * *includes* every model whose `minPlanName` it is at or above. `max` is the
 * top tier, so it admits every catalog entry including ones naming a tier
 * this build has never heard of.
 *
 * `Go` and `GOAT` are different tiers that share a prefix, which is exactly the
 * shape a `startsWith` test gets wrong: a Go subscriber is entitled to the
 * models the catalog marks `Go` and to none of the `GOAT` ones.
 */
const PLAN_MIN = {
  go: new Set(['Go']),
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
  // An unknown tier has no floor to compare against. `normalizeConfig` pins the
  // plan to `PLANS`, so this is only reachable for a programmatic caller — but
  // `PLAN_MIN[plan]` being absent used to fall through to `min.has(...)` and
  // throw a TypeError, which is a worse answer than "publish everything".
  const min = PLAN_MIN[plan]
  if (min === undefined || min === null) return { included: true, reason: 'tier' }
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
  //
  // The reader is deliberately tri-state. `caps?.[nested] === true` can only
  // ever answer `true` or `false`, so collapsing an entry that states *neither*
  // into `false` claimed "this model cannot think" on the vendor's behalf — and
  // an explicit `reasoningEfforts: false` is exactly that claim to `llm-pi-ai`,
  // which otherwise keeps whatever its installed catalog says. `undefined`
  // means "nobody said", and nothing is written for it.
  const stated = (flat, nested) => {
    if (typeof entry[flat] === 'boolean') return entry[flat]
    return typeof entry.caps?.[nested] === 'boolean' ? entry.caps[nested] : undefined
  }
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
 * The vendor's own label for a model's current deal, or `undefined`.
 *
 * The plan page states a `deal` object for the models that are on one — a
 * structured fact, not a guess from the price: `{ label: "Free", free: true,
 * discountPercent: 100, term: "while the stealth preview lasts", href, note }`.
 * Four to five entries carry a free deal at any time, and a few more carry a
 * partial one (`50% off`, `99% off`). Zero-cost-with-no-deal does not occur, so
 * this field is the whole signal.
 *
 * The label is passed through verbatim for two reasons: it is already written
 * for a reader, and it is the only wording that covers the partial discounts
 * without this module inventing a phrase ("99% off" is not "free", and calling
 * it that would be a claim the vendor did not make). `free` is kept separately
 * for the count, which only claims what the boolean states.
 */
export function dealLabel(entry) {
  const deal = entry?.deal
  if (deal === null || typeof deal !== 'object') return undefined
  const label = typeof deal.label === 'string' ? deal.label.trim() : ''
  if (label !== '') return label
  return deal.free === true ? 'Free' : undefined
}

/** Whether the vendor states this model is currently billed at $0. */
export function isFreeModel(entry) {
  return entry?.deal?.free === true
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
    // A model on a deal says so in the name, because the name is the only thing
    // a model picker shows: the harness lists one line per model and the reader
    // chooses from that line. Free models cost no quota, which is exactly the
    // fact a reader cannot see at the moment they are choosing.
    const deal = dealLabel(entry)
    const base = entry?.name ?? model.name
    const name = typeof base === 'string' && base !== '' && deal !== undefined ? `${base} · ${deal}` : base
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
 * How many models each tier admits, from the capability catalog alone.
 *
 * The tiers are cumulative, so the answer is one running sum rather than four
 * independent counts: a model whose `minPlanName` is `Pro` is in Pro and Max
 * and not in Go or GOAT.
 *
 * @param catalog - the parsed plan-page catalog.
 * @returns `{ go, goat, pro, max }`, or `undefined` for a catalog that carries
 *   no tier information at all — the counts would be fabricated, and a card
 *   showing `0` beside Go reads as "Go grants nothing" rather than "unknown".
 */
export function tierCounts(catalog) {
  const entries = Array.isArray(catalog) ? catalog : []
  if (entries.length === 0) return undefined
  let go = 0
  let goat = 0
  let pro = 0
  let max = 0
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const min = typeof entry.minPlanName === 'string' ? entry.minPlanName : ''
    if (!KNOWN_MIN_PLANS.has(min)) {
      // A tier this build has never heard of is above everything it knows, the
      // same way `max` treats it — so it counts towards the top tier only.
      max += 1
    } else if (min === 'Go') go += 1
    else if (min === 'GOAT') goat += 1
    else if (min === 'Pro') pro += 1
    else max += 1
  }
  return { go, goat: go + goat, pro: go + goat + pro, max: go + goat + pro + max }
}

/**
 * Count what the catalog offers per tier, without needing the live list — what
 * the settings card shows when explaining what a tier would select.
 */
export function planCatalogSummary(catalog, plan) {
  return tierCounts(catalog)?.[plan] ?? 0
}

/**
 * How many models each tier grants right now, from both sources.
 *
 * Two different questions, which is why there are two numbers. `models` is what
 * the vendor's catalog entitles the tier to; `live` is how many of those the
 * models endpoint is actually serving today, because a model can be announced
 * on the plan page before it appears on the endpoint (and vice versa). A tier
 * whose live number is lower than its catalog number is not broken — it is a
 * tier whose newest models have not shipped yet.
 *
 * Both are `null` when the source that answers them has not been read. A zero
 * there would be a claim, and "0 models" beside a tier is a claim that is
 * usually false.
 *
 * @param request - `{ apiList, catalog }`, either possibly empty.
 * @returns one `{ plan, models, live, free }` row per tier, cheapest first.
 *   `free` counts the models the endpoint is serving that the vendor states are
 *   billed at $0 — the same "right now" basis as `live`, so the two numbers are
 *   read against each other rather than against the plan page.
 */
export function tierAvailability({ apiList, catalog } = {}) {
  const entries = Array.isArray(catalog) ? catalog : []
  const models = Array.isArray(apiList) ? apiList : []
  const counts = tierCounts(entries)
  const index = indexCatalog(entries)
  const live = { go: 0, goat: 0, pro: 0, max: 0 }
  const free = { go: 0, goat: 0, pro: 0, max: 0 }

  for (const model of models) {
    if (model === null || typeof model !== 'object' || typeof model.id !== 'string') continue
    const entry = matchCatalogEntry(index, model)
    const isFree = isFreeModel(entry)
    for (const plan of PLANS) {
      if (!withinPlan(entry, plan).included) continue
      live[plan] += 1
      if (isFree) free[plan] += 1
    }
  }

  return PLANS.map((plan) => ({
    plan,
    models: counts === undefined ? null : counts[plan],
    live: models.length === 0 ? null : live[plan],
    free: models.length === 0 ? null : free[plan],
  }))
}
