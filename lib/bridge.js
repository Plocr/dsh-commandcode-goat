/**
 * The host bridge behind the settings card.
 *
 * The card could not do this work itself, for three separate reasons, and the
 * bridge exists for exactly those three:
 *
 *   1. **The account key must not reach the browser.** Usage and search are
 *      fetched host-side and only the results cross the wire.
 *   2. **The card writes two namespaces.** Its own section goes through the
 *      client settings scope; the generated routes live in `llm-pi-ai`, which
 *      the card has no scope for.
 *   3. **Syncing reads the public internet.** The fetch and the catalog parse
 *      run where the credential store is, not in a tab.
 *
 * Every route is POST-only and loopback-gated. The gate checks the peer
 * address, the `Host` header, and — when the browser sends one — that the
 * `Origin` matches that host, so a page on another origin cannot drive a sync
 * from the user's machine. `Sec-Fetch-Site: cross-site` is refused outright
 * because a same-origin fetch never sends it.
 */

import { PLANS, PLAN_TITLES } from './catalog.js'
import { CHANNEL_LABELS, PLAN_DOC_URLS, planVariants, providerDisplayName } from './plans.js'

/** Base path every route below hangs off. */
export const BRIDGE_PREFIX = '/api/dsh-commandcode-goat'

/** Largest request body accepted, in bytes. Every request here is a tiny JSON object. */
export const MAX_BODY_BYTES = 64 * 1024

/** Peer addresses that mean "this machine". */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Host header names that mean "this machine". */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Whether one request came from the machine itself.
 *
 * @param req - the Node request.
 * @returns true only when the peer, the `Host` header and any `Origin` all
 *   agree on loopback.
 */
export function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress
  if (typeof address !== 'string' || !LOOPBACK_ADDRESSES.has(address)) return false

  const host = req?.headers?.host
  if (typeof host !== 'string') return false
  let parsed
  try {
    parsed = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false

  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === parsed.host
  } catch {
    return false
  }
}

/** Send one JSON response. */
export function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Read a JSON request body, or `undefined` when it is absent, oversized or
 * unparseable — all three are the same answer to a caller that only accepts a
 * well-formed request.
 */
export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** The route keys `describe` reports on, in the order the card lists them. */
const REPORTED_ROUTES = ['openai', 'anthropic', 'responses']

/**
 * Build the bridge's route table.
 *
 * @param deps - the host facts and actions the handlers read:
 *   `{ settings, config, targetKeys, sync, usage, search, keyState, tiers,
 *   stale, subscription, prune }`.
 *   - `entryId` → the profile row id this plugin was composed under, which is
 *     also the settings namespace its form binds to.
 *   - `version` → the build's version, so the card can print what is loaded.
 *   - `settings()` → the settings service, read per request so a reloaded
 *     provider is picked up without re-registering routes.
 *   - `config()` → the live plugin config.
 *   - `targetKeys()` → `{ openai, anthropic, responses }` provider keys.
 *   - `sync()` → `{ plan, routes, diagnostics }` or throws a coded error.
 *   - `usage(base)` → the usage report, or throws a coded error.
 *   - `search()` → `{ registered, enabled, selected }`: whether this plugin's
 *     search provider is mounted at all, whether its switch is on, and which
 *     provider the runtime currently has selected.
 *   - `tiers()` → the four tiers with their quota and per-tier counts. It may
 *     be async, because a cold cache reads the catalog page on the way here.
 *   - `stale()` → the generated routes another tier left behind.
 *   - `subscription()` → the account's own subscription, when one was read.
 *   - `prune(plan)` → remove every generated route but that tier's.
 *   - `keyState()` → `{ configured, source, envName }` for the key flag. A
 *     source rather than a boolean, so the card can say *where* it looked
 *     instead of contradicting the usage panel beside it.
 * @returns the `{ kind, path, handler }` routes to hand to `webServer.register`.
 */
export function makeBridgeRoutes(deps) {
  /** Wrap one handler with the loopback gate and a contained failure path. */
  const route = (path, handler) => ({
    kind: 'exact',
    path: `${BRIDGE_PREFIX}${path}`,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { ok: false, code: 'loopback-only', message: 'this endpoint answers loopback requests only' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'use POST' })
        return
      }
      try {
        const body = await readJsonBody(req)
        if (body === undefined) {
          sendJson(res, 400, { ok: false, code: 'malformed-request', message: 'expected a JSON object body' })
          return
        }
        const result = await handler(body)
        sendJson(res, 200, result.ok === false ? result : { ok: true, value: result })
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          code: typeof error?.code === 'string' ? error.code : 'internal',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
  })

  return [
    route('/describe', async () => {
      const config = deps.config()
      const keys = deps.targetKeys()
      const settings = deps.settings()
      const current = settings?.describe?.({ redactSecrets: true })
      const llm = Array.isArray(current)
        ? current.find((descriptor) => String(descriptor?.ns) === 'llm-pi-ai')
        : undefined
      const providers = llm?.value?.providers ?? {}

      let keyState = { configured: false, source: 'none', envName: config.targetApiKeyEnv ?? '' }
      try {
        keyState = await deps.keyState()
      } catch { /* an unresolvable credential is simply "not configured" here */ }

      const targets = {}
      for (const route of REPORTED_ROUTES) {
        const key = keys[route]
        const existing = providers[key]
        targets[route] = {
          key,
          slot: route,
          channel: CHANNEL_LABELS[route] ?? route,
          // The protocol the route actually speaks, and nothing for a route that
          // does not exist: `llm-pi-ai` states this field when it is written, so
          // naming one here would describe a route the host has not created.
          api: typeof existing?.api === 'string' ? existing.api : '',
          created: existing !== undefined,
          models: Array.isArray(existing?.models) ? existing.models.length : 0,
          displayName: typeof existing?.displayName === 'string' && existing.displayName !== ''
            ? existing.displayName
            : providerDisplayName(config.plan, route),
        }
      }

      /**
       * The four tiers, as the card's own list rather than as four booleans.
       *
       * `subscribed` is the account's answer and `selected` is the user's; they
       * are different facts on purpose, because the interesting state is the
       * one where they disagree — an account on Pro whose plugin is set to GOAT
       * generates a route set the subscription does not cover, and the card can
       * only offer the fix if it can see both.
       */
      const subscription = deps.subscription?.() ?? undefined
      // Awaited, because a host with a cold cache reads its catalog on the way
      // here so the card's first paint carries real per-tier counts.
      const availability = (await deps.tiers?.()) ?? []
      const stale = deps.stale?.() ?? []
      const stalePlans = new Set(stale.map((entry) => entry.plan))
      const tiers = PLANS.map((plan) => {
        const row = availability.find((entry) => entry.plan === plan) ?? { plan, models: null, live: null }
        const routes = REPORTED_ROUTES.filter((route) => providers[keys[route]] !== undefined)
        return {
          plan,
          title: PLAN_TITLES[plan] ?? plan,
          provider: providerDisplayName(plan, 'openai'),
          docURL: PLAN_DOC_URLS[plan] ?? '',
          variants: planVariants(plan),
          models: row.models ?? null,
          live: row.live ?? null,
          selected: plan === config.plan,
          subscribed: subscription?.plan === plan,
          source: subscription?.plan === plan ? (subscription.source ?? null) : null,
          routes: plan === config.plan
            ? routes
            : stale.filter((entry) => entry.plan === plan).map((entry) => entry.slot),
          stale: stalePlans.has(plan),
        }
      })

      return {
        entryId: deps.entryId ?? '',
        version: deps.version ?? 'unknown',
        plan: config.plan ?? 'goat',
        plans: [...PLANS],
        apiKeyEnv: keyState.envName ?? config.targetApiKeyEnv ?? '',
        usageBaseURL: config.usageBaseURL ?? '',
        hasKey: keyState.configured === true,
        keySource: keyState.source,
        // A deployment that serves no settings service has nowhere to write,
        // so the card must not offer to sync into it.
        writable: settings !== undefined && settings.writable !== false,
        targets,
        tiers,
        ...subscription === undefined ? {} : { subscription },
        stale,
        search: deps.search(),
      }
    }),

    route('/sync', async (body) => {
      const result = await deps.sync({ dryRun: body.dryRun === true })
      return result
    }),

    /**
     * Remove the routes of every tier but one.
     *
     * The sweep already runs after a sync; this is the same operation on its
     * own, so a reader who sees a ghost provider does not have to reason about
     * what pressing Create / Update would do before getting rid of it.
     */
    route('/prune', async (body) => {
      if (typeof deps.prune !== 'function') {
        return { ok: false, code: 'unsupported', message: 'this build cannot prune routes' }
      }
      const result = await deps.prune(typeof body.plan === 'string' ? body.plan : undefined)
      return result
    }),

    route('/usage', async (body) => {
      const base = typeof body.baseURL === 'string' && body.baseURL.trim() !== '' ? body.baseURL.trim() : undefined
      return deps.usage(base)
    }),
  ]
}
