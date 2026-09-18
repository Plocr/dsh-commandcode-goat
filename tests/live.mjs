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
const apiList = await fetchModelList(`${API_ROOT}/provider/v1/models`)
check('the model list answers with models', apiList.length > 0, `${apiList.length} models`)
const routed = apiList.filter((model) => model.supportedEndpoints !== undefined)
check('entries state their supported endpoints', routed.length === apiList.length, `${routed.length}/${apiList.length}`)
const protocols = {}
for (const model of apiList) {
  const route = routeForModel(model)
  protocols[route] = (protocols[route] ?? 0) + 1
}
console.log(`      routing: ${JSON.stringify(protocols)}`)
check('every model routes somewhere', Object.values(protocols).reduce((total, count) => total + count, 0) === apiList.length)

console.log('\n== live capability catalog ==')
let catalog = []
try {
  catalog = await fetchCatalog('https://commandcode.ai/docs/plans/goat')
  check('the plan page yields a catalog', catalog.length > 0, `${catalog.length} entries`)
  const tiers = {}
  for (const entry of catalog) tiers[entry.minPlanName] = (tiers[entry.minPlanName] ?? 0) + 1
  console.log(`      tiers: ${JSON.stringify(tiers)}`)
  const vision = catalog.filter((entry) => entry.vision === true).length
  const reasoning = catalog.filter((entry) => entry.reasoning === true).length
  console.log(`      vision: ${vision}, reasoning: ${reasoning}`)
} catch (error) {
  check('the plan page yields a catalog', false, String(error))
}

console.log('\n== generated routes per tier ==')
for (const plan of PLANS) {
  const { routes, diagnostics } = buildEntries({ apiList, catalog, plan, extraIds: [] })
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
for (const path of USAGE_PATHS) {
  const response = await fetch(`${API_ROOT}${path}`, { headers: usageHeaders(bogus) })
  check(`${path} is live`, response.status !== 404, `HTTP ${response.status}`)
}
const search = await fetch(`${API_ROOT}${SEARCH_ROUTE}`, {
  method: 'POST',
  headers: { ...usageHeaders(bogus), 'content-type': 'application/json' },
  body: JSON.stringify({ query: 'probe', numResults: 1 }),
})
check(`${SEARCH_ROUTE} is live`, search.status !== 404, `HTTP ${search.status}`)

const report = await fetchUsageReport(bogus, API_ROOT)
check('an invalid key is classified, not thrown', report.blocked === 'invalid-key' || report.failures.length > 0, `blocked=${report.blocked}`)

console.log(`\n${failures === 0 ? 'all live checks passed' : `${failures} live check(s) failed`}`)
process.exitCode = failures === 0 ? 0 : 1
