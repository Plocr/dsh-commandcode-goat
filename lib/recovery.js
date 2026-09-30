/**
 * Recover one upstream rejection the harness cannot name.
 *
 * Command Code's gateway refuses a request it cannot expand with a 400 whose
 * text — `a single path expansion cannot exceed 512 candidates` — matches none
 * of the wordings `@deepseek-ai/dsh-llm` treats as a context overflow, so the
 * pi-ai adapter classifies it `INVALID_REQUEST`:
 *
 *   - `INVALID_REQUEST` is not in the retry policy's code set, so the request
 *     is not retried;
 *   - it is not `CONTEXT_WINDOW_EXCEEDED`, so `dsh-compaction-basic`'s
 *     `agent/request-error` recovery — prune, compact one region, retry — never
 *     runs for it.
 *
 * The turn then dies on its first request, every time, and nothing has changed
 * by the next turn: the same oversized request goes out again.
 *
 * This module supplies the missing classification *inside the plugin*, so the
 * route keeps publishing the window the vendor declares. Nothing is capped: the
 * session is only reduced when the gateway has actually refused it, and only
 * through the harness' own services (the tool-result pruner and the compaction
 * engine), then the request is retried once — the same "compact on the spot,
 * retry once" behaviour Command Code's own CLI documents.
 *
 * The hook is a no-op unless all of these hold: the failing provider is a route
 * this plugin generated, the failure is not already a classified overflow, the
 * failure text is the gateway's, and the switch is on.
 *
 * @module dsh-commandcode-goat/recovery
 */

/**
 * The harness' own overflow code (`CONTEXT_WINDOW_EXCEEDED_CODE` in
 * `@deepseek-ai/dsh-llm`), spelled here rather than imported: a plugin has no
 * dependency on the host's internals, and this string is the contract it is
 * matching. A failure already classified this way is handled by the harness'
 * own recovery, so this hook leaves it alone.
 */
export const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED'

/**
 * Wording Command Code's gateway uses when it refuses a request it cannot
 * expand. Matched against the classified failure's code and message.
 *
 * Kept narrow on purpose: a broad `400` match would swallow every other
 * invalid request on these routes and turn it into a paid summarization call.
 */
export const GATEWAY_OVERFLOW_SIGNATURES = [
  /a single path expansion cannot exceed \d+ candidates/i,
  /path expansion cannot exceed \d+ candidates/i,
]

/** How many times one session may be reduced and retried before the error stands. */
export const DEFAULT_RECOVERY_ATTEMPTS = 2

/**
 * Whether a failure is the gateway refusing a request it could not expand.
 *
 * @param failure - the `LlmError`-shaped failure the agent loop classified.
 * @returns true only for the gateway's own wording.
 */
export function isGatewayOverflow(failure) {
  if (failure === null || typeof failure !== 'object') return false
  if (failure.code === CONTEXT_WINDOW_EXCEEDED) return false
  const message = typeof failure.message === 'string' ? failure.message : ''
  if (message === '') return false
  return GATEWAY_OVERFLOW_SIGNATURES.some((pattern) => pattern.test(message))
}

/**
 * The `llm-pi-ai` provider keys one tier's routes were written to.
 *
 * @param keys - `{ openai, anthropic, responses }` as the bridge reports them.
 * @returns the set of provider keys this plugin owns.
 */
export function routeKeySet(keys) {
  const out = new Set()
  for (const key of Object.values(keys ?? {})) {
    if (typeof key === 'string' && key !== '') out.add(key)
  }
  return out
}

/**
 * Install the gateway-overflow recovery hook.
 *
 * Two attempts per session, cheapest first: a deterministic tool-result prune
 * on the first refusal (no upstream call at all), and the same prune plus one
 * compaction region on the second. After that the original failure stands.
 *
 * @param ctx - cordis context carrying `on`, `get` and `logger`.
 * @param options - `{ isEnabled, routeKeys, maxAttempts, commandId }`.
 *   `isEnabled` and `routeKeys` are read at event time so a live config edit
 *   (the switch, or a tier switch) applies without remounting the plugin.
 * @returns nothing; the listener lives as long as the plugin's fiber.
 */
export function installOverflowRecovery(ctx, options) {
  const isEnabled = options?.isEnabled ?? (() => true)
  const routeKeys = options?.routeKeys ?? (() => new Set())
  const maxAttempts = Number.isInteger(options?.maxAttempts) && options.maxAttempts > 0
    ? options.maxAttempts
    : DEFAULT_RECOVERY_ATTEMPTS
  const commandId = options?.commandId ?? 'dsh-commandcode-goat:overflow-recovery'
  const log = (level, message) => {
    const logger = ctx.logger
    if (typeof logger?.[level] === 'function') logger[level](message)
  }

  /**
   * One reduction ladder per session. Keyed by the session rather than the
   * agent so a reused agent does not inherit another conversation's budget.
   */
  const attempts = new WeakMap()

  /**
   * Prune oversized tool results through the harness' own pruner.
   *
   * @param session - session whose surface is rewritten.
   * @returns how many replacements landed.
   */
  const prune = (session) => {
    const pruner = ctx.get?.('toolResultPruner')
    if (typeof pruner?.pruneSession !== 'function') return 0
    try {
      const landed = pruner.pruneSession(session)
      return Number.isInteger(landed?.pruned) && landed.pruned > 0 ? landed.pruned : 0
    } catch (error) {
      log('warn', `[dsh-commandcode-goat] tool-result prune failed: ${error instanceof Error ? error.message : String(error)}`)
      return 0
    }
  }

  /**
   * Force one balanced compaction through whichever compaction backend this
   * profile composed.
   *
   * `compactIfNeeded(agent, 'context-overflow', …)` is the backend's own
   * overflow recovery and is the exact path the harness would have taken had it
   * classified this failure correctly, so it is preferred. It is not part of the
   * published `CompactionEngine` surface, hence the shape probe; the manual
   * `compactNow` is the documented fallback, and a backend offering neither
   * leaves the prune as the whole ladder.
   *
   * @param agent - agent whose session is reduced.
   * @param signal - live turn cancellation.
   * @returns whether a compaction region was committed.
   */
  const compact = async (agent, signal) => {
    const compaction = ctx.get?.('compaction')
    if (compaction === null || compaction === undefined) return false
    try {
      if (typeof compaction.compactIfNeeded === 'function') {
        const result = await compaction.compactIfNeeded(agent, 'context-overflow', signal)
        return result !== null && result !== undefined
      }
      if (typeof compaction.compactNow === 'function') {
        const result = await compaction.compactNow(agent, signal, commandId)
        return result !== null && result !== undefined
      }
      log('warn', '[dsh-commandcode-goat] no usable compaction entry point on ctx.compaction; prune only')
      return false
    } catch (error) {
      log('warn', `[dsh-commandcode-goat] overflow compaction failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  ctx.on('agent/request-error', async (payload, next) => {
    const agent = payload?.agent
    const failure = payload?.failure
    const provider = payload?.provider
    const signal = payload?.signal
    if (agent === undefined || failure === undefined) return next()
    if (!isEnabled() || isGatewayOverflow(failure) === false) return next()
    if (routeKeys().has(provider) === false) return next()
    if (signal?.aborted === true) return next()

    const session = agent.session
    const used = attempts.get(session) ?? 0
    if (used >= maxAttempts) {
      log('warn', `[dsh-commandcode-goat] gateway refused ${provider} again after ${used} recovery attempt(s); leaving the error as-is`)
      return next()
    }

    const generation = session?.surface?.replaceGeneration
    const pruned = prune(session)
    // Cheapest lever first, but never waste the attempt: a profile with no
    // tool-result pruner composed (or one that found nothing to rewrite) goes
    // straight to a compaction region instead of retrying an unchanged request.
    const compacted = used >= 1 || pruned === 0 ? await compact(agent, signal) : false
    const after = session?.surface?.replaceGeneration
    const progressed = generation === undefined || after === undefined
      ? pruned > 0 || compacted
      : after > generation
    if (progressed === false) {
      log('warn', `[dsh-commandcode-goat] nothing to reduce for ${provider}; leaving the error as-is`)
      return next()
    }

    attempts.set(session, used + 1)
    log('info', `[dsh-commandcode-goat] ${provider} refused an oversized request; pruned ${pruned} tool result(s)${compacted ? ' and compacted one region' : ''}, retrying (attempt ${used + 1}/${maxAttempts})`)
    return { kind: 'retry' }
  })

  // A completed assistant message is the proof the session fits again, so the
  // next refusal starts a fresh ladder instead of inheriting this one's budget.
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'assistant/message') attempts.delete(session)
  })
}
