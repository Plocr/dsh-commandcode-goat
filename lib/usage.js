/**
 * Command Code account usage — the `/alpha/*` half of the Provider API.
 *
 * Chat rides `/provider/v1`; the account surface sits on the API root and is
 * what the official CLI reads to draw its status line:
 *
 *   GET /alpha/whoami                  account and organisation identity
 *   GET /alpha/usage/summary           request/cost/token totals for the period
 *   GET /alpha/billing/credits         credit balances and the rolling windows
 *   GET /alpha/billing/subscriptions   the subscription plan behind them
 *
 * None of these are documented endpoints — they are the ones the CLI calls,
 * verified against the live service. That is exactly why every field is read
 * defensively and the untouched bodies are kept under `raw`: a shape we do not
 * recognize must degrade into "less to show", never into a thrown parse error.
 *
 * Each endpoint also degrades *independently*. A single transient failure
 * leaves a partial report and a note; only when every call fails the same way
 * does the report name a cause, because only then is a cause actually stated.
 */

/** The version header the official CLI sends. */
export const COMMAND_CODE_CLI_VERSION = '1.44.0'

/** Account paths, in the order the report reads them. */
export const USAGE_PATHS = [
  '/alpha/whoami',
  '/alpha/usage/summary',
  '/alpha/billing/credits',
  '/alpha/billing/subscriptions',
]

/** Per-request ceiling. The account surface is a dashboard, not a chat turn. */
export const USAGE_TIMEOUT_MS = 15_000

/**
 * Subscription plan ids as the vendor spells them in `planId`, mapped to the
 * tier names the site uses. Matched by longest prefix so `individual-pro-v1`
 * does not answer as `individual-pro`.
 */
const KNOWN_PLANS = {
  'individual-go': 'Go',
  'individual-goat': 'GOAT',
  'individual-pro-v1': 'Pro',
  'individual-pro': 'Pro',
  'individual-provider': 'Provider',
  'individual-max': 'Max',
  'individual-ultra': 'Ultra',
  'teams-pro': 'Teams Pro',
}

const PLAN_PREFIXES = Object.keys(KNOWN_PLANS).sort((left, right) => right.length - left.length)

/** The display name for one raw `planId`, falling back to the id itself. */
export function planNameOf(planId) {
  const normalized = String(planId ?? '').toLowerCase().replace(/_/g, '-')
  if (normalized === '') return ''
  const prefix = PLAN_PREFIXES.find((candidate) => normalized.startsWith(candidate))
  return prefix === undefined ? planId : KNOWN_PLANS[prefix]
}

/** A finite number, or zero. The account shapes are wide, not trustworthy. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** A string, or the empty string. */
function str(value) {
  return typeof value === 'string' ? value : ''
}

/** A record, or undefined for anything that is not a plain object. */
function rec(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** Request headers shared by every account call. */
export function usageHeaders(key) {
  return {
    authorization: `Bearer ${key}`,
    accept: 'application/json',
    'x-command-code-version': COMMAND_CODE_CLI_VERSION,
    'x-cli-environment': 'production',
  }
}

/** Combine the caller's cancellation with the per-request ceiling. */
function requestSignal(signal) {
  const timeout = AbortSignal.timeout(USAGE_TIMEOUT_MS)
  if (signal === undefined) return timeout
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal
}

/** GET one account path, recording a failure instead of throwing. */
async function getJson(base, path, key, failures, statuses, signal) {
  try {
    const response = await fetch(`${base}${path}`, { headers: usageHeaders(key), signal: requestSignal(signal) })
    if (!response.ok) {
      failures.push(`${path}: HTTP ${response.status}`)
      statuses.push(response.status)
      return undefined
    }
    const payload = await response.json()
    return rec(payload)
  } catch (error) {
    failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    statuses.push(undefined)
    return undefined
  }
}

/** One rolling window, normalized; `undefined` when the account omits it. */
function readWindow(source) {
  const window = rec(source)
  if (window === undefined) return undefined
  const used = num(window.used)
  const cap = num(window.cap)
  const resetAt = num(window.resetAt)
  if (used === 0 && cap === 0 && resetAt === 0 && window.exceeded !== true) return undefined
  return {
    used,
    cap,
    exceeded: window.exceeded === true,
    ...resetAt > 0 ? { resetAt } : {},
    ...cap > 0 ? { remaining: Math.max(cap - used, 0) } : {},
  }
}

/**
 * Read the whole account surface.
 *
 * @param key - the account's API key.
 * @param base - API root (`https://api.commandcode.ai`), not the chat base.
 * @param signal - optional cancellation.
 * @returns the report; `failures` is always present, and `blocked` names a
 *   cause only when every endpoint failed the same way.
 */
export async function fetchUsageReport(key, base, signal) {
  const root = String(base ?? '').replace(/\/+$/, '')
  const failures = []
  const statuses = []
  const report = { failures }

  const whoami = await getJson(root, '/alpha/whoami', key, failures, statuses, signal)
  const user = rec(whoami?.user)
  const org = rec(whoami?.org)
  if (user !== undefined) {
    report.account = {
      id: str(user.id),
      name: str(user.name),
      userName: str(user.userName),
      ...org !== undefined && str(org.id) !== '' ? { orgId: str(org.id) } : {},
    }
  }

  const usage = await getJson(root, '/alpha/usage/summary', key, failures, statuses, signal)
  if (usage !== undefined) {
    report.usage = {
      totalCount: num(usage.totalCount),
      completedCount: num(usage.completedCount),
      failedCount: num(usage.failedCount),
      successRate: num(usage.successRate),
      totalCost: num(usage.totalCost),
      totalTokensIn: num(usage.totalTokensIn),
      totalTokensOut: num(usage.totalTokensOut),
      totalCredits: num(usage.totalCredits),
      periodBasis: str(usage.periodBasis) || 'billing-period',
    }
  }

  const credits = await getJson(root, '/alpha/billing/credits', key, failures, statuses, signal)
  const creditsData = rec(credits?.credits)
  const limits = rec(credits?.windowLimits)
  const fiveHour = readWindow(limits?.fiveHour)
  const weekly = readWindow(limits?.weekly)
  if (creditsData !== undefined || fiveHour !== undefined || weekly !== undefined) {
    report.credits = {
      monthlyCredits: num(creditsData?.monthlyCredits),
      purchasedCredits: num(creditsData?.purchasedCredits),
      freeCredits: num(creditsData?.freeCredits),
      ...fiveHour === undefined ? {} : { fiveHour },
      ...weekly === undefined ? {} : { weekly },
      ...str(creditsData?.planId) !== '' ? { planId: str(creditsData.planId) } : {},
    }
  }

  const orgId = report.account?.orgId
  const subscriptionsPath = orgId === undefined || orgId === ''
    ? '/alpha/billing/subscriptions'
    : `/alpha/billing/subscriptions?orgId=${encodeURIComponent(orgId)}`
  // Always the fourth call, so `failures.length` still means "all of them".
  const subscription = await getJson(root, subscriptionsPath, key, failures, statuses, signal)
  const subscriptionData = rec(subscription?.data)
  const planId = str(subscriptionData?.planId) || str(creditsData?.planId)
  if (subscriptionData !== undefined || planId !== '') {
    const currentPeriodEnd = num(subscriptionData?.currentPeriodEnd)
    report.plan = {
      planId,
      name: planNameOf(planId) || planId,
      status: str(subscriptionData?.status),
      ...currentPeriodEnd > 0 ? { currentPeriodEnd } : {},
    }
  }

  if (failures.length === USAGE_PATHS.length) {
    const codes = statuses.filter((status) => typeof status === 'number')
    if (codes.length === USAGE_PATHS.length && codes.every((status) => status === 401 || status === 403)) {
      report.blocked = 'invalid-key'
    } else if (codes.length === USAGE_PATHS.length && codes.every((status) => status >= 500)) {
      report.blocked = 'service-unavailable'
    } else if (codes.length === 0) {
      report.blocked = 'network'
    }
  }
  return report
}

/** Percentage of a rolling window consumed, clamped to 0–100. */
export function windowPercent(window) {
  if (window === undefined || !(window.cap > 0)) return 0
  return Math.min(Math.max(Math.round((window.used / window.cap) * 100), 0), 100)
}

/** Seconds → a short "3h 12m" / "12m" / "45s" duration. */
export function formatDuration(seconds) {
  const total = Math.max(Math.round(Number(seconds) || 0), 0)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** One `plan: value` line per credit field the account actually reports. */
export function creditLines(credits) {
  if (credits === undefined) return []
  const lines = []
  if (credits.monthlyCredits > 0 || credits.purchasedCredits > 0 || credits.freeCredits > 0) {
    lines.push(`credits: ${credits.monthlyCredits} monthly, ${credits.purchasedCredits} purchased, ${credits.freeCredits} free`)
  }
  for (const [label, window] of [['5h window', credits.fiveHour], ['weekly window', credits.weekly]]) {
    if (window === undefined) continue
    const reset = window.resetAt === undefined ? '' : `, resets ${new Date(window.resetAt * 1000).toISOString()}`
    lines.push(`${label}: ${window.used}/${window.cap} requests${window.exceeded ? ' (exceeded)' : ''}${reset}`)
  }
  return lines
}

/**
 * The plain-text summary the `commandcode_usage` tool returns and the settings
 * card mirrors. Written for a model to read: labelled, one fact per line, and
 * explicit about what could not be read.
 */
export function describeUsage(report) {
  const lines = []
  const account = report?.account
  if (account !== undefined) {
    const who = account.userName || account.name || account.id
    if (who !== '') lines.push(`account: ${who}`)
  }
  if (report?.plan !== undefined) {
    const status = report.plan.status === '' ? '' : ` (${report.plan.status})`
    lines.push(`plan: ${report.plan.name}${status}`)
  }
  const usage = report?.usage
  if (usage !== undefined) {
    lines.push(`requests: ${usage.completedCount}/${usage.totalCount} completed, ${usage.failedCount} failed, success rate ${Math.round(usage.successRate * 100)}%`)
    lines.push(`cost: $${usage.totalCost.toFixed(4)} over the ${usage.periodBasis}`)
    lines.push(`tokens: ${usage.totalTokensIn} in / ${usage.totalTokensOut} out`)
  }
  lines.push(...creditLines(report?.credits))
  if (report?.blocked !== undefined) {
    lines.push(report.blocked === 'invalid-key'
      ? 'the account endpoints rejected the API key'
      : report.blocked === 'service-unavailable'
        ? 'the account endpoints are failing with server errors'
        : 'the account endpoints could not be reached')
  } else if (Array.isArray(report?.failures) && report.failures.length > 0) {
    lines.push(`unavailable: ${report.failures.join('; ')}`)
  }
  return lines.length > 0 ? lines.join('\n') : 'the account reported nothing'
}
