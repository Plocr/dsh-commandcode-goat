/**
 * Live verification against the two real upstream sources and the account
 * surface. Run with `npm run verify:live`; it needs the public internet and no
 * credential, because the account endpoints are probed for their *existence*
 * — a 401 means the route is there and gated, which is all this asserts.
 *
 * This is deliberately outside the unit suite: `npm test` must pass with no
 * network at all.
 */

import { PLANS, buildEntries, fetchCatalog, fetchModelList, providerKey, routeForModel } from '../lib/catalog.js'
import { buildRouteProfile } from '../lib/pi-ai.js'
import { USAGE_PATHS, fetchUsageReport, usageHeaders } from '../lib/usage.js'
import { SEARCH_ROUTE } from '../lib/search.js'

const API_ROOT = 'https://api.commandcode.ai'

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

console.log('== live model list ==')
/**
 * Read one upstream source, retrying a connection that the network drops.
 *
 * Both hosts are behind the same flaky edge, and this script exists to be run
 * by hand: a transient connect timeout used to end it with an undici stack
 * trace before any check had been reported, which reads as a broken plugin
 * rather than as a bad minute. The retries are for the network, not for the
 * assertions — a source that never answers still fails the checks that need it.
 */
const read = async (label, fn, attempts = 4) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (attempt === attempts) {
        console.log(`      ${label}: gave up after ${attempts} attempts — ${message}`)
        return undefined
      }
      console.log(`      ${label}: attempt ${attempt} failed — ${message}`)
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
    }
  }
  return undefined
}

const apiList = await read('model list', () => fetchModelList(`${API_ROOT}/provider/v1/models`))
check('the model list answers with models', (apiList?.length ?? 0) > 0, `${apiList?.length ?? 0} models`)
const routed = (apiList ?? []).filter((model) => model.supportedEndpoints !== undefined)
check('entries state their supported endpoints', routed.length === (apiList?.length ?? 0), `${routed.length}/${apiList?.length ?? 0}`)
const protocols = {}
for (const model of apiList ?? []) {
  const route = routeForModel(model)
  protocols[route] = (protocols[route] ?? 0) + 1
}
console.log(`      routing: ${JSON.stringify(protocols)}`)
check('every model routes somewhere', Object.values(protocols).reduce((total, count) => total + count, 0) === (apiList?.length ?? 0))

console.log('\n== live capability catalog ==')
const catalog = (await read('plan page', () => fetchCatalog('https://commandcode.ai/docs/plans/goat'))) ?? []
check('the plan page yields a catalog', catalog.length > 0, `${catalog.length} entries`)
if (catalog.length > 0) {
  const tiers = {}
  for (const entry of catalog) tiers[entry.minPlanName] = (tiers[entry.minPlanName] ?? 0) + 1
  console.log(`      tiers: ${JSON.stringify(tiers)}`)
  const vision = catalog.filter((entry) => entry.vision === true).length
  const reasoning = catalog.filter((entry) => entry.reasoning === true).length
  console.log(`      vision: ${vision}, reasoning: ${reasoning}`)
  // The vendor's own statement that a model costs nothing right now, and the
  // name the picker will show it under.
  const deals = catalog.filter((entry) => entry.deal !== null && entry.deal !== undefined)
  const free = deals.filter((entry) => entry.deal.free === true)
  console.log(`      deals: ${deals.length} (${free.length} free) — ${deals.map((entry) => `${entry.name}: ${entry.deal.label}`).join(', ')}`)
  const marked = buildEntries({ apiList: apiList ?? [], catalog, plan: 'goat' }).routes.openai.filter((entry) => / · /.test(entry.name ?? ''))
  check('a model on a deal carries the vendor\u2019s label in its name', free.length === 0 || marked.length >= free.length, `${marked.length} marked: ${marked.slice(0, 4).map((entry) => entry.name).join(', ')}`)
}

console.log('\n== generated routes per tier ==')
for (const plan of PLANS) {
  const { routes, diagnostics } = buildEntries({ apiList: apiList ?? [], catalog, plan, extraIds: [] })
  const described = ['openai', 'anthropic', 'responses']
    .filter((route) => routes[route].length > 0)
    .map((route) => `${providerKey(plan, route)}=${routes[route].length}`)
    .join(' ')
  console.log(`  ${plan.padEnd(5)} ${described}`)
  check(`${plan} selects at least one model`, routes.openai.length + routes.anthropic.length + routes.responses.length > 0)
  for (const line of diagnostics) console.log(`        note: ${line}`)

  for (const route of ['openai', 'anthropic', 'responses']) {
    if (routes[route].length === 0) continue
    const profile = buildRouteProfile({ key: providerKey(plan, route), route, entries: routes[route], plan })
    const everyEntryRoutable = routes[route].every((entry) => typeof entry.id === 'string' && entry.id !== '' && Array.isArray(entry.input))
    check(`${plan}/${route} profile is serviceable`, everyEntryRoutable && profile.models.length > 0, `api=${profile.api}`)
  }
}

console.log('\n== account endpoints exist and are credential-gated ==')
const bogus = 'cmd_live_probe_invalid'
/**
 * One probe, with its own failure reported as a failed check.
 *
 * This probe does not tolerate the most likely thing that happens to it: the
 * account host is a different host from the model list, and a blocked or slow
 * egress path to it used to take the whole script down with an undici stack
 * trace — after every earlier check had already passed, which reads as the
 * plugin's fault rather than the network's.
 */
const probe = async (label, request) => {
  try {
    const response = await request()
    check(label, response.status !== 404, `HTTP ${response.status}`)
  } catch (error) {
    check(label, false, error instanceof Error ? error.message : String(error))
  }
}
for (const path of USAGE_PATHS) {
  await probe(`${path} is live`, () => fetch(`${API_ROOT}${path}`, { headers: usageHeaders(bogus) }))
}
await probe(`${SEARCH_ROUTE} is live`, () => fetch(`${API_ROOT}${SEARCH_ROUTE}`, {
  method: 'POST',
  headers: { ...usageHeaders(bogus), 'content-type': 'application/json' },
  body: JSON.stringify({ query: 'probe', numResults: 1 }),
}))

try {
  const report = await fetchUsageReport(bogus, API_ROOT)
  check('an invalid key is classified, not thrown', report.blocked === 'invalid-key' || report.failures.length > 0, `blocked=${report.blocked}`)
} catch (error) {
  check('an invalid key is classified, not thrown', false, error instanceof Error ? error.message : String(error))
}

console.log(`\n${failures === 0 ? 'all live checks passed' : `${failures} live check(s) failed`}`)
process.exitCode = failures === 0 ? 0 : 1
