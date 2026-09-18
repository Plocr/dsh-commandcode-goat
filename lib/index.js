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
 * not this plugin's. That is why syncing is an explicit, idempotent action
 * (a button, a tool, or `autoSync`) rather than something that happens on
 * every launch: it writes a user-visible section, and the user can see and
 * edit what it wrote in Settings → Models.
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
 * Settings namespace. This is the pairing key: the host half serves it and the
 * browser half registers its card under it, so the two halves meet without
 * either naming the other.
 */
export const SETTINGS_NS = 'dsh-commandcode-goat'

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

export const Config = Schema.object({
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
    .default(false)
    .description('Refresh the generated routes on a timer, so a newly published model appears without a click.'),
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
 * Resolve a config snapshot into the plain shape the rest of the module reads.
 *
 * Schemastery has already applied defaults and rejected wrong types by the time
 * this runs; what is left is the empty-string convention, which cannot be
 * expressed in the schema because each empty field means "use this other
 * default" rather than "unset".
 */
export function normalizeConfig(config) {
  const raw = config ?? {}
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
    autoSync: raw.autoSync === true,
    autoSyncIntervalMs: number(raw.autoSyncIntervalMs, DEFAULT_AUTO_SYNC_INTERVAL_MS, MIN_AUTO_SYNC_INTERVAL_MS),
    webSearch: raw.webSearch === true,
    usageBaseURL: text(raw.usageBaseURL, DEFAULT_ALPHA_BASE_URL),
    enableUsageTool: raw.enableUsageTool !== false,
    enableBridge: raw.enableBridge !== false,
  }
}

/**
 * Attach the settings section across both settings API generations.
 *
 * dsh ≥ rc.1 moved the standalone `installSettingsSection` onto
 * `SettingsProvider.installSection`; the releases before it expose only
 * `register()`. Feature-detecting keeps one build loadable on either, and the
 * fallback reproduces the same lifecycle by hand — the registrant's composition
 * entry is the base layer while the provider is present, and the entry alone is
 * the value once it detaches.
 */
export function installSettingsSection(ctx, ns, schema, entry, hooks) {
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    if (typeof settings.installSection === 'function') {
      settings.installSection(ctx, ns, schema, entry, hooks)
      return
    }
    const scope = settings.register(ns, schema, {
      base: entry,
      ...hooks.validate === undefined ? {} : { validate: hooks.validate },
    })
    hooks.setSource(() => scope.get())
    settingsCtx.effect(() => () => {
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => hooks.onChange())
  })
}

/**
 * Mount the plugin.
 *
 * @param ctx - the plugin's cordis context.
 * @param config - the resolved composition entry.
 */
export function apply(ctx, config) {
  let source = () => config ?? {}
  const resolved = () => normalizeConfig(source())
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
    let held = false
    const sync = () => {
      const enabled = resolved().webSearch === true
      try {
        held = select(enabled) === 'held'
      } catch {
        held = false
      }
    }
    applySearchSelection = sync
    searchReport = () => ({
      registered: true,
      enabled: resolved().webSearch === true,
      selected: web.searchProviderId,
      held,
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

  // ── settings section ───────────────────────────────────────────────────────
  installSettingsSection(ctx, SETTINGS_NS, Config, config ?? {}, {
    setSource: (next) => {
      source = next
      applySearchSelection()
    },
    onChange: () => {
      applySearchSelection()
    },
  })

  // ── auto-sync ──────────────────────────────────────────────────────────────
  ctx.effect(() => {
    const cfg = resolved()
    if (!cfg.autoSync) return
    let timer
    let stopped = false
    const tick = async () => {
      if (stopped) return
      try {
        await syncOnce()
      } catch (error) {
        ctx.logger?.warn?.(`[${name}] auto-sync failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // The first tick waits for the rest of the tree: auto-sync writes into
    // another plugin's section, and doing that during startup would race the
    // provider plugin's own registration.
    const first = setTimeout(() => {
      void tick()
      if (!stopped) timer = setInterval(() => void tick(), cfg.autoSyncIntervalMs)
    }, 15_000)
    return () => {
      stopped = true
      clearTimeout(first)
      if (timer !== undefined) clearInterval(timer)
    }
  }, 'dsh-commandcode-goat: auto-sync')

  // ── usage tool ─────────────────────────────────────────────────────────────
  if (config?.enableUsageTool !== false) {
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
  if (config?.enableBridge !== false) {
    ctx.inject(['webServer'], (webCtx) => {
      const routes = makeBridgeRoutes({
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
