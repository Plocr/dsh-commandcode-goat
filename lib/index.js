/**
 * dsh-commandcode-goat — host half.
 *
 * Publishes a Command Code subscription (GOAT / Pro / Max) into DeepSeek
 * Harness as first-class provider routes, and adds the account surface the
 * gateway's own CLI has: usage, credit windows, and web search.
 *
 * ## Why this plugin owns no adapter
 *
 * It writes provider *profiles* into the first-party `llm-pi-ai` settings
 * section instead of implementing `LlmAdapter`. The harness then serves those
 * routes with the adapter it already ships, which is where streaming, tool
 * calling, reasoning dispatch, image handling and replay are implemented and
 * tested. An out-of-tree adapter would have to re-derive all of it from the
 * chunk protocol and stay correct across releases; a profile only has to state
 * facts — which endpoint, which protocol, which models, which capabilities.
 *
 * The trade is that the routes a profile creates are the provider plugin's,
 * not this plugin's, so what a sync writes is a user-visible section the user
 * can read and edit in Settings → Models. Syncing is therefore idempotent and
 * deliberately conservative — it refreshes `models` and never overwrites an
 * `apiKeyEnv`, `baseURL`, `compat` or `displayName` a route already carries —
 * but it is not hidden behind a button. `autoSync` is on by default, because a
 * plugin whose whole job is to make a subscription selectable otherwise looks
 * like it installed nothing at all: no provider row appears in
 * Settings → Models, so there is nowhere to put the key, and the plugin reads
 * as broken rather than as pending.
 *
 * The first tick is delayed rather than immediate: it writes into another
 * plugin's section, and doing that during startup races the provider plugin's
 * own registration. A few seconds of waiting costs nothing and removes the
 * race.
 *
 * ## What the two upstream sources are for
 *
 * `GET /provider/v1/models` is the live list and the routing truth — it states
 * which endpoints each model answers on. The GOAT plan page carries the
 * capability catalog the list omits: thinking, vision, and which subscription
 * tier each model starts at. Joining them is what lets one sync produce routes
 * that are both complete and correctly scoped to the user's tier.
 */

import Schema from '@deepseek-ai/schemastery'
import { readFileSync } from 'node:fs'

import {
  DEFAULT_ALPHA_BASE_URL,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_CATALOG_URL,
  DEFAULT_SOURCE_URL,
  PLANS,
  buildEntries,
  fetchCatalog,
  fetchModelList,
  providerKey,
} from './catalog.js'
import { SyncError, SYNC_CODES, syncPlan } from './pi-ai.js'
import { describeUsage, fetchUsageReport } from './usage.js'
import { makeSearchProvider, makeSelectionController, SEARCH_PROVIDER_ID } from './search.js'
import { makeBridgeRoutes } from './bridge.js'

/** Cordis plugin name. */
export const name = 'dsh-commandcode-goat'

/**
 * This build's version, read from the installed manifest.
 *
 * Reported through the settings bridge so the card can print it. Without it,
 * "which build is actually loaded" is unanswerable from the UI — and since a
 * `github:` install pins a commit in the lockfile, an update that was never
 * applied looks exactly like a fix that did not work.
 */
export const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

/**
 * The row id this bundle's patch declares, for a context that cannot name it.
 *
 * This is the pairing key: the host half serves the settings section and the
 * browser half registers its card under it. Since dsh 0.1.7 a settings section
 * *is* a plugin entry, so the key is that entry's **row id** — `commandcode-goat`,
 * exactly as `cordis.patch.yml` declares it — and not this package's name, which
 * is a different string used for a different purpose (the client module id, and
 * the `plugins.bundle.config` address).
 *
 * It is only a fallback because the profile owns the row: the mount reads the
 * real id off the fiber, reports it through the bridge, and the card rebinds to
 * whatever the host says. This constant is what a context with no fiber — a
 * programmatic mount, a test — binds to.
 */
export const SETTINGS_NS = 'commandcode-goat'

/**
 * Nothing is hard-injected. Every seam this plugin uses — settings, web,
 * webServer, tools, credentials — is attached through an optional `ctx.inject`
 * so the row also loads in a headless or SDK profile where most of them are
 * absent, and simply does less there.
 */
export const inject = []

/** Ceiling on one sync's network work: two fetches and one settings write. */
export const SYNC_TIMEOUT_MS = 45_000

/** Default auto-sync cadence. A catalog this size does not move hourly. */
export const DEFAULT_AUTO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Floor on the auto-sync cadence, so a mis-typed 0 cannot become a hot loop. */
export const MIN_AUTO_SYNC_INTERVAL_MS = 60_000

/**
 * How long the first automatic sync waits after the plugin mounts.
 *
 * It writes into another plugin's settings section, so it has to let the rest
 * of the tree finish composing first — including the provider plugin whose
 * routes are being written. Long enough for that, short enough that a user who
 * restarts and immediately opens Settings → Models finds the provider row
 * already there.
 */
export const FIRST_SYNC_DELAY_MS = 15_000

const configSchema = Schema.object({
  sourceURL: Schema.string()
    .default(DEFAULT_SOURCE_URL)
    .description('Live model list. Answers with { data: [...] }.'),
  catalogURL: Schema.string()
    .default(DEFAULT_CATALOG_URL)
    .description('Official plan page carrying the per-model capability catalog; a failure here degrades the sync instead of failing it.'),
  plan: Schema.union(PLANS)
    .default('goat')
    .description('Subscription tier to generate providers for. Tiers are cumulative: pro includes goat, max includes both.'),
  targetApiKeyEnv: Schema.string()
    .default('')
    .description(`Credential reference the generated routes resolve their key through. Empty means ${DEFAULT_API_KEY_ENV}.`),
  targetBaseURL: Schema.string()
    .default('')
    .description(`Chat base URL written onto a route that has none. Empty means ${DEFAULT_BASE_URL}.`),
  targetCompat: Schema.object({
    thinkingFormat: Schema.string(),
    supportsReasoningEffort: Schema.boolean(),
  })
    .description('Override for the OpenAI-shaped route\'s compat block. Empty writes the reasoning-enabling default.'),
  extraIds: Schema.array(Schema.string())
    .default([])
    .description('Private model ids to publish alongside the catalog, on the OpenAI-shaped route.'),
  includeReasoningEfforts: Schema.boolean()
    .default(false)
    .description('Declare an identity effort map on models the catalog marks as reasoning. Off by default: the catalog names no wire values.'),
  autoSync: Schema.boolean()
    .default(true)
    .description('Create the generated routes on first load and refresh them on the configured interval, so the provider row appears in Settings → Models without anyone having to find a button. On by default; set it false to make every write an explicit action.'),
  autoSyncIntervalMs: Schema.number()
    .default(DEFAULT_AUTO_SYNC_INTERVAL_MS)
    .description('Auto-sync cadence in milliseconds; at least one minute.'),
  webSearch: Schema.boolean()
    .default(false)
    .description('Back the model-facing web_search tool with this account, so no separate search credential is needed.'),
  usageBaseURL: Schema.string()
    .default(DEFAULT_ALPHA_BASE_URL)
    .description('API root for the /alpha/* usage and search endpoints, distinct from the chat base.'),
  enableUsageTool: Schema.boolean()
    .default(true)
    .description('Register the commandcode_usage tool so a model can read the account itself.'),
  enableBridge: Schema.boolean()
    .default(true)
    .description('Serve the loopback-only endpoints the settings card calls.'),
})

/**
 * Every field of this plugin is a user preference, so every field is
 * `volatile()`.
 *
 * Since dsh 0.1.7 that marker is what makes a Config field configurable at all:
 * it decides which fields `settings.describe()` projects into a form, which
 * field paths a settings write accepts, and — because a volatile value is
 * handed to the plugin as a live reference rather than a copy — how a running
 * instance learns that the user changed something without being remounted.
 * Marking is per field, and a volatile field may not sit inside another one,
 * which the flat shape here satisfies. `volatile()` returns a marked copy
 * rather than mutating, so each field is replaced by its marked form.
 *
 * The method arrived in schemastery 3.18.4. A deployment resolves this plugin's
 * own dependency range, not the harness's copy, so an older schemastery can
 * reach here — and it must not take the entry down at import time, where
 * "failed to import" names no cause and hides that everything else still works.
 */
export const fieldVolatility = (() => {
  for (const [key, field] of Object.entries(configSchema.dict ?? {})) {
    if (typeof field?.volatile !== 'function') return 'unsupported'
    configSchema.dict[key] = field.volatile()
  }
  return 'configured'
})()

export const Config = configSchema

/**
 * Resolve a config snapshot into the plain shape the rest of the module reads.
 *
 * Schemastery has already applied defaults and rejected wrong types by the time
 * this runs; what is left is the empty-string convention, which cannot be
 * expressed in the schema because each empty field means "use this other
 * default" rather than "unset".
 */
export function normalizeConfig(config) {
  /**
   * Read a config field's current value.
   *
   * A `volatile()` field does not arrive as its value: since dsh 0.1.7 the
   * loader hands the plugin a live reference and updates it in place, so the
   * value must be read through `get()` at the moment it is wanted. Duck-typing
   * the reference keeps a build working on a host that hands the plain value
   * instead.
   */
  const live = (value) => (
    value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  )
  const raw = Object.fromEntries(Object.entries(config ?? {}).map(([key, value]) => [key, live(value)]))
  const number = (value, fallback, minimum) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback
  }
  const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
  return {
    sourceURL: text(raw.sourceURL, DEFAULT_SOURCE_URL),
    catalogURL: text(raw.catalogURL, DEFAULT_CATALOG_URL),
    plan: PLANS.includes(raw.plan) ? raw.plan : 'goat',
    targetApiKeyEnv: text(raw.targetApiKeyEnv, DEFAULT_API_KEY_ENV),
    targetBaseURL: text(raw.targetBaseURL, DEFAULT_BASE_URL),
    targetCompat: raw.targetCompat,
    extraIds: Array.isArray(raw.extraIds) ? raw.extraIds.filter((id) => typeof id === 'string' && id.trim() !== '') : [],
    includeReasoningEfforts: raw.includeReasoningEfforts === true,
    autoSync: raw.autoSync !== false,
    autoSyncIntervalMs: number(raw.autoSyncIntervalMs, DEFAULT_AUTO_SYNC_INTERVAL_MS, MIN_AUTO_SYNC_INTERVAL_MS),
    webSearch: raw.webSearch === true,
    usageBaseURL: text(raw.usageBaseURL, DEFAULT_ALPHA_BASE_URL),
    enableUsageTool: raw.enableUsageTool !== false,
    enableBridge: raw.enableBridge !== false,
  }
}

/**
 * Mount the plugin.
 *
 * @param ctx - the plugin's cordis context.
 * @param config - the resolved composition entry.
 */
export function apply(ctx, config) {
  /**
   * The row id the profile composed this plugin under.
   *
   * Since dsh 0.1.7 a settings section *is* a plugin entry: `describe()` keys
   * its descriptors by that row's id, and a write addresses the entry by it. So
   * this id is also the namespace the browser half binds its form to, and the
   * host reports it rather than letting the card assume one.
   */
  const entryId = ctx.fiber?.entry?.options.id ?? SETTINGS_NS
  /**
   * Without the marker there is no form and no writable field on this entry, so
   * say so once, in the log, with the actual cause — a silently unconfigurable
   * plugin is the worst of the available outcomes.
   */
  if (fieldVolatility !== 'configured') {
    ctx.logger?.warn?.(
      `[${name}] the resolved @deepseek-ai/schemastery has no Schema.volatile() (it arrived in 3.18.4), so this plugin's settings cannot be edited; install a newer schemastery for this profile`,
    )
  }
  // Volatile fields are live references, so this reads whatever is current
  // rather than a snapshot taken when the plugin was mounted.
  const resolved = () => normalizeConfig(config)
  const settingsService = () => ctx.get('settings')

  // ── credential ─────────────────────────────────────────────────────────────
  /**
   * The account key, resolved once per operation rather than cached, so a key
   * stored through Settings → Models reaches the next call without a restart.
   * The credentials seam already layers the managed store, the environment and
   * `.env` files; the direct `process.env` read is the fallback for a
   * deployment that loads no credential provider at all.
   */
  const resolveKey = async () => {
    const envName = resolved().targetApiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const found = await credentials.resolve(envName)
        if (typeof found?.value === 'string' && found.value !== '') return found.value
      } catch { /* fall through to the launch environment */ }
    }
    const ambient = process.env?.[envName]
    return typeof ambient === 'string' && ambient !== '' ? ambient : undefined
  }

  /**
   * Where the account key resolves from, for the card to *state* rather than
   * assert. Reads the same two sources in the same order as {@link resolveKey},
   * so the two can never disagree about whether a key exists — a card that
   * says "not configured" beside a usage panel that just read the account is
   * self-contradicting, and the reader has no way to tell which half is wrong.
   *
   * Reports only the source and the reference name; never the value.
   */
  const keyState = async () => {
    const envName = resolved().targetApiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const found = await credentials.resolve(envName)
        if (typeof found?.value === 'string' && found.value !== '') {
          return { configured: true, source: found.source === 'env' ? 'environment' : 'credentials', envName }
        }
      } catch { /* fall through to the launch environment */ }
    }
    const ambient = process.env?.[envName]
    if (typeof ambient === 'string' && ambient !== '') return { configured: true, source: 'environment', envName }
    return { configured: false, source: 'none', envName }
  }

  // ── sync ───────────────────────────────────────────────────────────────────
  /**
   * Read both sources, join them, and write the selected tier's route set.
   *
   * @param options - `{ dryRun }` reports what would be written without writing.
   * @returns the sync report the card renders.
   */
  const syncOnce = async ({ dryRun = false } = {}) => {
    const settings = settingsService()
    const cfg = resolved()
    const diagnostics = []
    const signal = AbortSignal.timeout(SYNC_TIMEOUT_MS)

    let apiList
    try {
      apiList = await fetchModelList(cfg.sourceURL, signal)
    } catch (error) {
      throw new SyncError(
        SYNC_CODES.fetch,
        `could not read the model list from ${cfg.sourceURL}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (apiList.length === 0) {
      throw new SyncError(SYNC_CODES.fetch, `${cfg.sourceURL} answered with no models`)
    }

    let catalog = []
    let catalogAvailable = true
    try {
      catalog = await fetchCatalog(cfg.catalogURL, signal)
    } catch (error) {
      catalogAvailable = false
      diagnostics.push(`capability catalog could not be read (${error instanceof Error ? error.message : String(error)})`)
    }

    const { routes, diagnostics: built } = buildEntries({
      apiList,
      catalog,
      plan: cfg.plan,
      extraIds: cfg.extraIds,
      includeReasoningEfforts: cfg.includeReasoningEfforts,
    })
    diagnostics.push(...built)

    const counts = Object.fromEntries(
      Object.entries(routes).map(([route, entries]) => [providerKey(cfg.plan, route), entries.length]),
    )
    const report = {
      plan: cfg.plan,
      dryRun,
      catalog: { available: catalogAvailable, entries: catalog.length },
      live: apiList.length,
      counts,
      diagnostics,
    }
    if (dryRun) return report

    const written = await syncPlan({
      settings,
      plan: cfg.plan,
      routes,
      cfg: {
        targetApiKeyEnv: cfg.targetApiKeyEnv,
        targetBaseURL: cfg.targetBaseURL,
        targetCompat: cfg.targetCompat,
      },
    })
    ctx.logger?.info?.(
      `[${name}] synced ${cfg.plan}: ${written.routes.map((route) => `${route.key}=${route.count}`).join(', ')}`,
    )
    return { ...report, routes: written.routes, skipped: written.skipped }
  }

  // ── usage ──────────────────────────────────────────────────────────────────
  /**
   * Read the account surface with the configured key.
   *
   * @param base - optional API root override from the card.
   * @param signal - optional caller cancellation.
   */
  const readUsage = async (base, signal) => {
    const cfg = resolved()
    const root = typeof base === 'string' && base.trim() !== '' ? base.trim() : cfg.usageBaseURL
    if (!URL.canParse(root)) {
      throw new SyncError('usage-misconfigured', `usage base ${JSON.stringify(root)} is not a valid URL`)
    }
    const key = await resolveKey()
    if (key === undefined) {
      throw new SyncError(
        SYNC_CODES.noKey,
        `no "${cfg.targetApiKeyEnv}" credential is configured; store it in Settings → Models or export it before launch`,
      )
    }
    return fetchUsageReport(key, root, signal)
  }

  // ── web search ─────────────────────────────────────────────────────────────
  let applySearchSelection = () => {}
  let searchReport = () => ({ registered: false, enabled: false, selected: SEARCH_PROVIDER_ID, held: false })

  ctx.inject(['web'], (webCtx) => {
    const web = webCtx.web
    const provider = makeSearchProvider({
      isEnabled: () => resolved().webSearch,
      apiBase: () => resolved().usageBaseURL,
      keyEnv: () => resolved().targetApiKeyEnv,
      resolveKey,
    })
    const disposeProvider = web.registerSearchProvider(provider)
    const select = makeSelectionController(web)
    const sync = () => {
      try {
        select(resolved().webSearch === true)
      } catch {
        /* a runtime whose selection cannot be written keeps its own choice */
      }
    }
    applySearchSelection = sync
    searchReport = () => ({
      registered: true,
      enabled: resolved().webSearch === true,
      selected: web.searchProviderId,
    })
    sync()
    // The web service registers a provider on its own fiber, so the returned
    // disposer is the only thing that unregisters it when this fiber unloads.
    webCtx.effect(() => () => {
      try {
        select(false)
      } catch { /* the web runtime may already be gone */ }
      disposeProvider()
    }, 'dsh-commandcode-goat: web search')
  })

  // ── live configuration ─────────────────────────────────────────────────────
  /**
   * A volatile edit does not remount the plugin; it re-resolves the config and
   * fires this event. Nothing else re-reads the fields — they are live
   * references — so the one thing derived from them that must be re-applied is
   * the search selection, which is written into another service.
   */
  ctx.on('loader/volatile-update', () => {
    applySearchSelection()
  })

  // ── auto-sync ──────────────────────────────────────────────────────────────
  /**
   * The timer runs whether or not the toggle is currently on, and each tick
   * decides for itself.
   *
   * That is not incidental. Both the toggle and the interval are volatile
   * fields: the card flips them without remounting the plugin, so a value
   * captured when this effect ran would keep syncing — or keep refusing to —
   * against the user's decision until the profile restarted. Reading them at
   * the moment they are used is what makes the switch mean something the first
   * time it is touched. An off tick costs one comparison.
   */
  ctx.effect(() => {
    let handle
    let stopped = false
    const tick = async () => {
      if (stopped || resolved().autoSync !== true) return
      try {
        await syncOnce()
      } catch (error) {
        ctx.logger?.warn?.(`[${name}] auto-sync failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    /**
     * Schedule the next tick from the config as it stands *after* this one, so
     * a changed interval reaches the next wait rather than the one after it.
     */
    const schedule = (delay) => {
      handle = setTimeout(async () => {
        if (stopped) return
        await tick()
        if (stopped) return
        schedule(resolved().autoSyncIntervalMs)
      }, delay)
    }
    // The first tick waits for the rest of the tree: auto-sync writes into
    // another plugin's section, and doing that during startup would race the
    // provider plugin's own registration.
    schedule(FIRST_SYNC_DELAY_MS)
    return () => {
      stopped = true
      clearTimeout(handle)
    }
  }, 'dsh-commandcode-goat: auto-sync')

  // ── usage tool ─────────────────────────────────────────────────────────────
  if (resolved().enableUsageTool) {
    ctx.inject(['tools'], (toolsCtx) => {
      toolsCtx.tools.register({
        name: 'commandcode_usage',
        description:
          'Read the Command Code account behind the commandcode provider routes: subscription plan, request and cost totals for the current period, credit balances, and the rolling 5-hour and weekly request windows.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(_args, exec) {
          const report = await readUsage(undefined, exec?.signal)
          return `${describeUsage(report)}\n\n${JSON.stringify(report, null, 2)}`
        },
      })
    })
  }

  // ── settings card bridge ───────────────────────────────────────────────────
  if (resolved().enableBridge) {
    ctx.inject(['webServer'], (webCtx) => {
      const routes = makeBridgeRoutes({
        entryId,
        version: PLUGIN_VERSION,
        config: resolved,
        settings: settingsService,
        targetKeys: () => {
          const plan = resolved().plan
          return {
            openai: providerKey(plan, 'openai'),
            anthropic: providerKey(plan, 'anthropic'),
            responses: providerKey(plan, 'responses'),
          }
        },
        sync: syncOnce,
        usage: (base) => readUsage(base),
        search: () => searchReport(),
        keyState,
      })
      webCtx.effect(() => {
        const disposers = routes.map((route) => webCtx.webServer.register(route))
        return () => {
          for (const dispose of disposers) dispose()
        }
      }, 'dsh-commandcode-goat: settings bridge')
    })
  }
}

export default { name, inject, Config, apply }
