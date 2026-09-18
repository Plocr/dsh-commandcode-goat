/**
 * Command Code web search — dsh's `web_search` tool served by the same
 * subscription that serves chat.
 *
 * The stock deployment backs `web_search` with a DeepSeek Messages call, which
 * needs a second credential and a second bill. Command Code's Provider API
 * exposes `/alpha/web-search` against the account key the chat routes already
 * use, so one subscription covers both.
 *
 * Two things here are worth stating plainly, because both are load-bearing:
 *
 *   - `available()` must not touch the network, and must not depend on
 *     anything only an async check can answer. The seam resolves the selected
 *     provider synchronously on every search, so this is a local predicate
 *     over the toggle and the base URL. A missing credential is deliberately
 *     *not* part of it: the seam reports an unavailable-but-configured
 *     provider as a hard selection error, while `search()` can say exactly
 *     which credential is missing.
 *   - Selection is a private-seam concern. `WebRuntime.searchProviderId` is
 *     read per call and has no public setter, so enabling the toggle writes it
 *     directly — but only when nothing else has claimed it. A deployment that
 *     named its provider explicitly in `cordis.yml`, or via
 *     `$DSH_WEB_SEARCH_PROVIDER`, keeps its choice; the toggle then reports
 *     that the selection was held rather than silently overriding it.
 */

import { COMMAND_CODE_CLI_VERSION } from './usage.js'

/** The provider id this plugin registers and selects. */
export const SEARCH_PROVIDER_ID = 'commandcode'

/** The endpoint, on the API root rather than the chat base. */
export const SEARCH_ROUTE = '/alpha/web-search'

/** The vendor clamps to this range; asking for more is a 400. */
export const MIN_RESULTS = 1
export const MAX_RESULTS = 10
/** What the vendor sends when the caller expresses no preference. */
export const DEFAULT_RESULTS = 5

/** Clamp a requested result count into the range the endpoint accepts. */
export function clampResults(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_RESULTS
  return Math.max(MIN_RESULTS, Math.min(MAX_RESULTS, Math.round(value)))
}

/** An abort that surfaces as the seam's cancellation rather than a failure. */
function isAbort(error) {
  return (typeof DOMException === 'function' && error instanceof DOMException && error.name === 'AbortError')
    || error?.name === 'AbortError'
}

/**
 * Map one `/alpha/web-search` body onto the seam's result.
 *
 * @param payload - parsed response body.
 * @returns the sources, deduplicated by URL, in the order the service ranked
 *   them.
 */
export function mapSearchPayload(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : []
  const sources = []
  const seen = new Set()
  for (const item of results) {
    if (item === null || typeof item !== 'object') continue
    const url = typeof item.url === 'string' ? item.url.trim() : ''
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    sources.push({
      url,
      ...typeof item.title === 'string' && item.title.trim() !== '' ? { title: item.title.trim() } : {},
      ...typeof item.snippet === 'string' && item.snippet.trim() !== '' ? { snippet: item.snippet.trim() } : {},
    })
  }
  return { sources, truncated: false }
}

/**
 * Build the search provider.
 *
 * @param deps - `{ apiBase, keyEnv, resolveKey, isEnabled }`. Every one is a
 *   function so the provider reads live configuration on each call rather than
 *   a snapshot taken at registration.
 * @returns a `SearchProvider` for `ctx.web.registerSearchProvider`.
 */
export function makeSearchProvider(deps) {
  return {
    id: SEARCH_PROVIDER_ID,

    /**
     * A cheap local answer only — the seam calls this on every search, and a
     * network probe here would turn provider selection into a blocking request.
     */
    available() {
      if (deps.isEnabled() !== true) return false
      const base = deps.apiBase()
      if (typeof base !== 'string' || !URL.canParse(base)) return false
      return true
    },

    async search(request, signal) {
      const query = typeof request?.query === 'string' ? request.query : ''
      if (query.trim() === '') throw new Error('Command Code web search needs a query')
      if (signal?.aborted) throw new Error('Command Code web search aborted')

      const apiBase = deps.apiBase()
      if (typeof apiBase !== 'string' || !URL.canParse(apiBase)) {
        throw new Error(`Command Code web search is misconfigured: ${JSON.stringify(apiBase)} is not a valid URL`)
      }
      const key = await deps.resolveKey()
      if (typeof key !== 'string' || key === '') {
        throw new Error(`Command Code web search has no API key; store the "${deps.keyEnv()}" credential or export it before launch`)
      }

      const endpoint = `${apiBase.replace(/\/+$/, '')}${SEARCH_ROUTE}`
      let response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${key}`,
            'x-command-code-version': COMMAND_CODE_CLI_VERSION,
            'x-cli-environment': 'production',
          },
          body: JSON.stringify({ query, numResults: clampResults(request?.maxResults) }),
          ...signal ? { signal } : {},
        })
      } catch (error) {
        if (signal?.aborted || isAbort(error)) throw new Error('Command Code web search aborted')
        throw new Error(`Command Code web search request failed: ${error instanceof Error ? error.message : String(error)}`)
      }

      if (!response.ok) {
        let detail = ''
        try {
          const parsed = await response.json()
          if (typeof parsed?.error === 'string') detail = `: ${parsed.error}`
        } catch { /* a non-JSON error body still leaves the status */ }
        throw new Error(`Command Code web search failed (HTTP ${response.status})${detail}`)
      }

      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error('Command Code web search returned an unparseable body')
      }
      return mapSearchPayload(payload)
    },
  }
}

/**
 * Point the web seam's search selection at this provider, or give it back.
 *
 * @param web - the `ctx.web` service.
 * @returns `(enable) => 'taken' | 'held' | 'released'`, where `held` means some
 *   other id already owns the selection and this plugin left it alone.
 */
export function makeSelectionController(web) {
  let previous
  let held = false
  return (enable) => {
    if (enable === true) {
      if (web.searchProviderId === SEARCH_PROVIDER_ID) return 'taken'
      if (web.searchProviderId !== undefined) {
        // Someone named a provider explicitly. Overriding it would make a
        // deliberate deployment decision silently unreachable.
        held = true
        return 'held'
      }
      previous = web.searchProviderId
      web.searchProviderId = SEARCH_PROVIDER_ID
      held = false
      return 'taken'
    }
    if (held) {
      held = false
      return 'held'
    }
    if (web.searchProviderId !== SEARCH_PROVIDER_ID) return 'released'
    if (previous === undefined) delete web.searchProviderId
    else web.searchProviderId = previous
    previous = undefined
    return 'released'
  }
}
