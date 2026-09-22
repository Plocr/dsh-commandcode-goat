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

import { PLANS } from './catalog.js'

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
 *   `{ settings, config, targetKeys, sync, usage, search, resolveKey }`.
 *   - `entryId` → the profile row id this plugin was composed under, which is
 *     also the settings namespace its form binds to.
 *   - `version` → the build's version, so the card can print what is loaded.
 *   - `settings()` → the settings service, read per request so a reloaded
 *     provider is picked up without re-registering routes.
 *   - `config()` → the live plugin config.
 *   - `targetKeys()` → `{ openai, anthropic, responses }` provider keys.
 *   - `sync()` → `{ plan, routes, diagnostics }` or throws a coded error.
 *   - `usage()` → the usage report, or throws a coded error.
 *   - `search()` → `{ registered, enabled, selected, hasKey }`.
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
          created: existing !== undefined,
          models: Array.isArray(existing?.models) ? existing.models.length : 0,
          ...existing?.api === undefined ? {} : { api: existing.api },
        }
      }

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
        search: deps.search(),
      }
    }),

    route('/sync', async (body) => {
      const result = await deps.sync({ dryRun: body.dryRun === true })
      return result
    }),

    route('/usage', async (body) => {
      const base = typeof body.baseURL === 'string' && body.baseURL.trim() !== '' ? body.baseURL.trim() : undefined
      return deps.usage(base)
    }),
  ]
}
