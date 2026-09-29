/**
 * The subscription tiers, described the way the settings card and the generated
 * provider names need them.
 *
 * Three separate things live here because they are the same fact read in three
 * directions:
 *
 *   1. **What a tier is called.** The vendor sells Go, GOAT, Pro and the two
 *      Max sizes. Users see those names in the card; the harness sees the
 *      provider name written onto a route.
 *   2. **Where a tier is documented.** Each tier has its own page, and it is
 *      the only place its default quota is stated — the models endpoint says
 *      nothing about plans at all.
 *   3. **What a tier grants.** Price and the three rolling limits, as the
 *      vendor's own pages state them on 2026-09-29. They are constants rather
 *      than something parsed at run time: the pages carry these figures as
 *      prose in a React payload, and a parser that guessed at prose would
 *      invent numbers the day the copy is reworded. The link beside every
 *      figure is what makes the claim checkable.
 *
 * The provider naming rule is the one this module exists to enforce. Two routes
 * of one tier serve the same account over two protocols, and before this rule
 * they carried the same display name — so the harness's own Settings → Models
 * page, which prints one row per route, showed two rows that read as a
 * duplicate rather than as two channels of one subscription.
 */

import { PLANS, PLAN_TITLES, providerKey, ROUTE_ORDER } from './catalog.js'

/** The word every generated provider name starts with. */
export const PROVIDER_PREFIX = 'Command'

/**
 * The separator between the prefix and the tier, spelled once.
 *
 * A pipe rather than a colon: the harness prints provider names beside their
 * route key in several places, and a colon there reads as part of the key.
 */
export const PROVIDER_SEPARATOR = '|'

/**
 * What each route slot is called in the card.
 *
 * `autosync` is the vendor's own word for the aggregated slot — the plugin
 * mirrors it in the route key — but a reader choosing a channel needs the
 * protocol, not the pipeline that filled it.
 */
export const CHANNEL_LABELS = {
  openai: 'AutoSync',
  anthropic: 'Anthropic',
  responses: 'Responses',
}

/**
 * The tail appended to a secondary route's name.
 *
 * The parenthesised protocol is what the reader is actually choosing between:
 * the same model served over two protocols is two routes, and only one of them
 * can be reached from a given model's `supported_endpoints`.
 */
const CHANNEL_SUFFIX = {
  openai: '',
  anthropic: ' · Claude',
  responses: ' · Responses',
}

/**
 * The provider name one tier's route carries.
 *
 * @param plan - the tier id, as the config states it (`go`, `goat`, `pro`, `max`).
 * @param slot - the route slot (`openai`, `anthropic`, `responses`).
 * @returns the display name, e.g. `Command | goat` or `Command | goat · Claude`.
 */
export function providerDisplayName(plan, slot) {
  const title = PLANS.includes(plan) ? plan : String(plan ?? '')
  return `${PROVIDER_PREFIX} ${PROVIDER_SEPARATOR} ${title}${CHANNEL_SUFFIX[slot] ?? ''}`
}

/**
 * Every name this plugin has ever generated, current and historical.
 *
 * It exists to answer exactly one question: *may a re-sync rewrite this route's
 * `displayName`?* Overwriting a name the reader chose is rude and unrecoverable,
 * but refusing to touch the ones this plugin wrote itself would leave anyone
 * upgrading from the 0.6.x naming (`Command Code GOAT`) staring at two rows
 * that read as the same provider — the bug this naming rule was introduced to
 * fix. So a stored name is rewritten only when it is on this list, and anything
 * else is left alone.
 */
export function isGeneratedDisplayName(value) {
  if (typeof value !== 'string') return false
  const name = value.trim()
  if (name === '') return false
  for (const plan of PLANS) {
    for (const slot of ROUTE_ORDER) {
      if (name === providerDisplayName(plan, slot)) return true
    }
    // 0.6.x named a route after its tier alone: `Command Code GOAT`.
    if (name === `${PROVIDER_PREFIX} Code ${PLAN_TITLES[plan]}`) return true
  }
  return false
}

/** The tier's own documentation page, which is also the quota's citation. */
export const PLAN_DOC_URLS = {
  go: 'https://commandcode.ai/docs/plans/go',
  goat: 'https://commandcode.ai/docs/plans/goat',
  pro: 'https://commandcode.ai/docs/plans/pro',
  max: 'https://commandcode.ai/docs/plans/max',
}

/**
 * Price and default quota per tier, as the vendor's plan pages state them.
 *
 * `monthly` is the size of the credit pool one billing period grants, which is
 * the same number the plan page calls the monthly limit. `premiumMonthly`
 * exists only on the Max sizes, which split the pool between standard and
 * premium models instead of pooling everything.
 *
 * A tier may have more than one size, which is why this is a list: Max is sold
 * as 10× and 20× and nothing in the models endpoint tells them apart. The first
 * entry is the one a figure without a size refers to.
 */
const PLAN_VARIANTS = {
  go: [
    { label: 'Go', price: 1, fiveHour: 3, weekly: 6, monthly: 10 },
  ],
  goat: [
    { label: 'GOAT', price: 10, fiveHour: 14, weekly: 35, monthly: 70 },
  ],
  pro: [
    { label: 'Pro', price: 20, fiveHour: 16, weekly: 40, monthly: 80 },
  ],
  max: [
    { label: 'Max 10×', price: 100, fiveHour: 45, weekly: 90, monthly: 150, premiumMonthly: 100 },
    { label: 'Max 20×', price: 200, fiveHour: 90, weekly: 180, monthly: 300, premiumMonthly: 200 },
  ],
}

/**
 * The sizes one tier is sold in, cheapest first.
 *
 * @param plan - the tier id.
 * @returns copied entries, so a caller cannot edit the table by accident.
 */
export function planVariants(plan) {
  const variants = PLAN_VARIANTS[plan] ?? []
  return variants.map((variant) => ({ ...variant }))
}

/**
 * Which catalog page to read for one tier, and what to fall back to.
 *
 * The capability catalog (the array carrying `minPlanName`, `vision` and
 * `reasoning`) is published on the Go, GOAT and Pro pages and is byte-identical
 * on all three; the Max page carries a different payload with no catalog array
 * at all. So following the tier's own page is right for three tiers and a
 * guaranteed miss for the fourth — the fallback is what keeps Max from
 * degrading into an unenriched sync for no reason.
 *
 * @param plan - the tier id.
 * @returns candidate URLs, best first, without repeats.
 */
export function catalogPageCandidates(plan) {
  const own = PLAN_DOC_URLS[plan]
  const fallback = PLAN_DOC_URLS.goat
  return own === undefined || own === fallback ? [fallback] : [own, fallback]
}

/**
 * Subscription ids the vendor's billing API uses, mapped to tier ids.
 *
 * Longest prefix wins, so `individual-pro-v1` does not answer as
 * `individual-pro`. Ids with no tier — the pay-as-you-go `provider` plan, the
 * team plans, `ultra` — are deliberately absent: they grant something this
 * plugin has no model list for, and guessing a tier for them would generate
 * routes the account cannot use.
 */
const PLAN_ID_TIERS = {
  'individual-go': 'go',
  'individual-goat': 'goat',
  'individual-pro-v1': 'pro',
  'individual-pro': 'pro',
  'individual-max': 'max',
}

/**
 * Ids that must not fall through to a shorter known prefix.
 *
 * `individual-provider` is the pay-as-you-go plan and begins with
 * `individual-pro`, so without this entry the longest-prefix match would read a
 * metered account as a Pro subscription and generate a route set the account is
 * not paying for.
 */
const PLAN_ID_BLOCKERS = ['individual-provider', 'individual-ultra', 'teams-pro', 'teams-enterprise']

const PLAN_ID_PREFIXES = [...Object.keys(PLAN_ID_TIERS), ...PLAN_ID_BLOCKERS]
  .sort((left, right) => right.length - left.length)

/**
 * The tier a `planId` grants, or `undefined` for a plan this build cannot map.
 *
 * @param planId - the raw id, e.g. `individual-goat`.
 */
export function planTierOf(planId) {
  const normalized = String(planId ?? '').toLowerCase().replace(/_/g, '-')
  if (normalized === '') return undefined
  const prefix = PLAN_ID_PREFIXES.find((candidate) => normalized.startsWith(candidate))
  return prefix === undefined ? undefined : PLAN_ID_TIERS[prefix]
}

/** Every route key this plugin generates, in creation order, for one tier. */
export function tierRouteKeys(plan) {
  return ROUTE_ORDER.map((slot) => ({ slot, key: providerKey(plan, slot) }))
}

/** Every route key this plugin generates for every tier. */
export function allGeneratedKeys() {
  return PLANS.flatMap((plan) => tierRouteKeys(plan).map((entry) => entry.key))
}

/**
 * Which tier and slot a generated route key belongs to, or `undefined`.
 *
 * The parse is deliberately strict: `commandcode-` then a known tier then a
 * known suffix. A user's own route named `commandcode-goat-something` is not
 * this plugin's to delete, and a looser match would make it so.
 */
export function parseGeneratedKey(key) {
  if (typeof key !== 'string' || !key.startsWith('commandcode-')) return undefined
  for (const plan of PLANS) {
    for (const slot of ROUTE_ORDER) {
      if (key === providerKey(plan, slot)) return { plan, slot }
    }
  }
  return undefined
}
