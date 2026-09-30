import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CONTEXT_WINDOW_EXCEEDED,
  DEFAULT_RECOVERY_ATTEMPTS,
  GATEWAY_OVERFLOW_SIGNATURES,
  installOverflowRecovery,
  isGatewayOverflow,
  routeKeySet,
} from '../lib/recovery.js'

/** The 400 Command Code returns, as the harness records it (nested envelope and all). */
const GATEWAY_REFUSAL = {
  code: 'INVALID_REQUEST',
  message: '400: {"message":"{\\"message\\":\\"a single path expansion cannot exceed 512 candidates trace_id: 49d472f289d9707a8e4bc4814eca2360\\",\\"type\\":\\"invalid_request_error\\"}\\n","type":"invalid_request_error"}',
}

/** An ordinary invalid request on the same route: must never be treated as an overflow. */
const UNRELATED_400 = { code: 'INVALID_REQUEST', message: '400: {"message":"model not found","type":"invalid_request_error"}' }

const ROUTES = routeKeySet({
  openai: 'commandcode-goat-autosync',
  anthropic: 'commandcode-goat-anthropic',
  responses: 'commandcode-goat-responses',
})

/**
 * A cordis stand-in faithful about what the recovery hook uses: `on`, `get`
 * and `logger`. `waterfall()` replays the harness' middleware contract —
 * a handler that returns a value ends the chain, `next()` continues it — which
 * is exactly how `agent/request-error` decides whether to retry a request.
 */
function mockContext(services = {}) {
  const listeners = new Map()
  const logs = []
  const record = (level) => (message) => logs.push({ level, message })
  const ctx = {
    logger: { info: record('info'), warn: record('warn'), debug: record('debug') },
    get(name) {
      return this[name]
    },
    on(event, handler) {
      listeners.set(event, [...listeners.get(event) ?? [], handler])
    },
    waterfall(event, payload) {
      const chain = listeners.get(event) ?? []
      let index = -1
      const next = async () => {
        index += 1
        if (index >= chain.length) return undefined
        return await chain[index](payload, next)
      }
      return next()
    },
    /** Fire a plain (non-middleware) event with its own argument list. */
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
  }
  return { ctx: { ...ctx, ...services }, logs, listeners }
}

/** A session whose `surface.replaceGeneration` moves when a replacement lands. */
function mockSession() {
  const session = { surface: { replaceGeneration: 0 } }
  return session
}

/** An agent wrapper carrying one session. */
function mockAgent(session) {
  return { session }
}

/** A pruner that rewrites the surface, like the harness' own tool-result pruner. */
function mockPruner(session, { pruned = 1, throws = false } = {}) {
  return {
    calls: 0,
    pruneSession(target) {
      this.calls += 1
      if (throws) throw new Error('session rejected the replacement')
      if (target !== session) throw new Error('pruned the wrong session')
      if (pruned > 0) target.surface.replaceGeneration += 1
      return { pruned, charsRemoved: pruned * 1000 }
    },
  }
}

describe('isGatewayOverflow', () => {
  it('recognises the gateway wording inside the harness-wrapped 400 envelope', () => {
    assert.equal(isGatewayOverflow(GATEWAY_REFUSAL), true)
    assert.equal(isGatewayOverflow({
      code: 'INVALID_REQUEST',
      message: '400: a single path expansion cannot exceed 512 candidates trace_id: f825cf1d3f9d287d93c0e6e850f8f97d',
    }), true)
  })

  it('leaves every other invalid request alone', () => {
    assert.equal(isGatewayOverflow(UNRELATED_400), false)
    assert.equal(isGatewayOverflow({ code: 'INVALID_REQUEST', message: '400: {"message":"a single path expansion"}' }), false)
    assert.equal(isGatewayOverflow(null), false)
    assert.equal(isGatewayOverflow(undefined), false)
    assert.equal(isGatewayOverflow({}), false)
    assert.equal(isGatewayOverflow({ message: 42 }), false)
  })

  it('never claims a failure the harness already classified as an overflow', () => {
    assert.equal(isGatewayOverflow({ code: CONTEXT_WINDOW_EXCEEDED, message: GATEWAY_REFUSAL.message }), false)
    assert.equal(CONTEXT_WINDOW_EXCEEDED, 'CONTEXT_WINDOW_EXCEEDED')
  })

  it('publishes its signature list for the README to quote', () => {
    assert.ok(GATEWAY_OVERFLOW_SIGNATURES.length >= 1)
    assert.ok(GATEWAY_OVERFLOW_SIGNATURES.every((pattern) => pattern instanceof RegExp))
  })
})

describe('routeKeySet', () => {
  it('collects the named routes and drops blanks', () => {
    assert.deepEqual([...routeKeySet({ openai: 'a', anthropic: '', responses: undefined })], ['a'])
    assert.deepEqual([...routeKeySet(undefined)], [])
  })
})

describe('installOverflowRecovery', () => {
  /** Build the hook with a session that is already failing. */
  const setup = (options = {}) => {
    const session = mockSession()
    const agent = mockAgent(session)
    const pruner = options.pruner ?? mockPruner(session, { pruned: options.pruned ?? 1 })
    const compaction = options.compaction
    const { ctx, logs } = mockContext({
      ...(options.services ?? {}),
      toolResultPruner: pruner,
      ...(compaction === undefined ? {} : { compaction }),
    })
    installOverflowRecovery(ctx, {
      isEnabled: options.isEnabled,
      routeKeys: options.routeKeys ?? (() => ROUTES),
      maxAttempts: options.maxAttempts,
    })
    const refuse = (overrides = {}) => ctx.waterfall('agent/request-error', {
      agent,
      provider: 'commandcode-goat-autosync',
      failure: GATEWAY_REFUSAL,
      signal: options.signal,
      ...overrides,
    })
    return { ctx, logs, pruner, session, agent, refuse }
  }

  it('prunes and asks for a retry when the gateway refuses this plugin\'s route', async () => {
    const { pruner, session, refuse, logs } = setup()
    const action = await refuse()
    assert.deepEqual(action, { kind: 'retry' })
    assert.equal(pruner.calls, 1)
    assert.equal(session.surface.replaceGeneration, 1)
    assert.match(logs.find((entry) => entry.level === 'info').message, /pruned 1 tool result/)
  })

  it('does not touch another provider, another failure, or a disabled hook', async () => {
    const foreign = setup()
    assert.equal(await foreign.refuse({ provider: 'deepseek-account' }), undefined)
    assert.equal(foreign.pruner.calls, 0)

    const unrelated = setup()
    assert.equal(await unrelated.refuse({ failure: UNRELATED_400 }), undefined)
    assert.equal(unrelated.pruner.calls, 0)

    const classified = setup()
    assert.equal(await classified.refuse({ failure: { code: CONTEXT_WINDOW_EXCEEDED, message: GATEWAY_REFUSAL.message } }), undefined)
    assert.equal(classified.pruner.calls, 0)

    const off = setup({ isEnabled: () => false })
    assert.equal(await off.refuse(), undefined)
    assert.equal(off.pruner.calls, 0)

    const otherTier = setup({ routeKeys: () => routeKeySet({ openai: 'commandcode-max-autosync' }) })
    assert.equal(await otherTier.refuse(), undefined)
    assert.equal(otherTier.pruner.calls, 0)
  })

  it('waits for an aborted turn instead of retrying into it', async () => {
    const { refuse, pruner } = setup({ signal: { aborted: true } })
    assert.equal(await refuse(), undefined)
    assert.equal(pruner.calls, 0)
  })

  it('escalates to one compaction region only on the second refusal', async () => {
    const calls = []
    const compaction = {
      compactIfNeeded: async (agent, trigger, signal) => { calls.push([trigger, signal]); return { shadowedSeqs: [1] } },
      compactNow: async () => { throw new Error('must not be reached while compactIfNeeded exists') },
    }
    const { refuse, logs } = setup({ compaction })
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.deepEqual(calls, [])
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.deepEqual(calls, [['context-overflow', undefined]])
    assert.match(logs.at(-1).message, /compacted one region/)
  })

  it('falls back to the manual compaction entry point when the backend exposes no overflow path', async () => {
    const seen = []
    const compaction = { compactNow: async (agent, signal, commandId) => { seen.push(commandId); return { shadowedSeqs: [2] } } }
    const { refuse } = setup({ compaction })
    await refuse()
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.deepEqual(seen, ['dsh-commandcode-goat:overflow-recovery'])
  })

  it('keeps the prune-only ladder when no compaction backend offers an entry point', async () => {
    const { refuse, logs } = setup({ compaction: {} })
    await refuse()
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.match(logs.map((entry) => entry.message).join('\n'), /no usable compaction entry point/)
  })

  it('goes straight to compaction when no tool-result pruner is composed', async () => {
    const session = mockSession()
    const calls = []
    const { ctx } = mockContext({
      compaction: {
        compactIfNeeded: async () => {
          calls.push('compact')
          session.surface.replaceGeneration += 1
          return { shadowedSeqs: [4] }
        },
      },
    })
    installOverflowRecovery(ctx, { routeKeys: () => ROUTES })
    const action = await ctx.waterfall('agent/request-error', {
      agent: mockAgent(session), provider: 'commandcode-goat-autosync', failure: GATEWAY_REFUSAL,
    })
    assert.deepEqual(action, { kind: 'retry' })
    assert.deepEqual(calls, ['compact'])
  })

  it('reports a pruner that cannot rewrite the session, and leaves the error standing', async () => {
    const session = mockSession()
    const throwingPruner = {
      calls: 0,
      pruneSession() {
        this.calls += 1
        throw new Error('session rejected the replacement')
      },
    }
    const { ctx, logs } = mockContext({ toolResultPruner: throwingPruner })
    installOverflowRecovery(ctx, { routeKeys: () => ROUTES })
    const refuse = () => ctx.waterfall('agent/request-error', {
      agent: mockAgent(session), provider: 'commandcode-goat-autosync', failure: GATEWAY_REFUSAL,
    })
    assert.equal(await refuse(), undefined)
    assert.equal(throwingPruner.calls, 1)
    const text = logs.map((entry) => entry.message).join('\n')
    assert.match(text, /tool-result prune failed/)
    assert.match(text, /nothing to reduce/)
  })

  it('still retries when the compaction backend fails but the prune moved the surface', async () => {
    const session = mockSession()
    const { ctx, logs } = mockContext({
      toolResultPruner: mockPruner(session),
      compaction: { compactIfNeeded: async () => { throw new Error('backend busy') } },
    })
    installOverflowRecovery(ctx, { routeKeys: () => ROUTES })
    const refuse = () => ctx.waterfall('agent/request-error', {
      agent: mockAgent(session), provider: 'commandcode-goat-autosync', failure: GATEWAY_REFUSAL,
    })
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.match(logs.map((entry) => entry.message).join('\n'), /overflow compaction failed: backend busy/)
  })

  it('leaves the error standing when nothing could be reduced', async () => {
    const { refuse, logs } = setup({ pruned: 0 })
    assert.equal(await refuse(), undefined)
    assert.match(logs.at(-1).message, /nothing to reduce/)
  })

  it('gives up after the attempt budget and says so', async () => {
    const { refuse, logs } = setup()
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.equal(await refuse(), undefined)
    assert.match(logs.at(-1).message, new RegExp(`after ${DEFAULT_RECOVERY_ATTEMPTS} recovery attempt`))
  })

  it('honours an explicit attempt budget', async () => {
    const { refuse } = setup({ maxAttempts: 1 })
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.equal(await refuse(), undefined)
  })

  it('starts a fresh ladder once an assistant message proves the session fits again', async () => {
    const { ctx, refuse, session } = setup()
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.equal(await refuse(), undefined)
    ctx.emit('session/event', session, { type: 'assistant/message' })
    assert.deepEqual(await refuse(), { kind: 'retry' })
  })

  it('keeps each session\'s budget separate', async () => {
    const session = mockSession()
    const other = mockSession()
    const { ctx } = mockContext({
      // One pruner that accepts either session, so the two budgets are what is
      // being measured rather than which session the pruner was built for.
      toolResultPruner: {
        pruneSession(target) {
          target.surface.replaceGeneration += 1
          return { pruned: 1, charsRemoved: 1000 }
        },
      },
    })
    installOverflowRecovery(ctx, { routeKeys: () => ROUTES })
    const refuse = (target) => ctx.waterfall('agent/request-error', {
      agent: mockAgent(target), provider: 'commandcode-goat-autosync', failure: GATEWAY_REFUSAL,
    })
    assert.deepEqual(await refuse(session), { kind: 'retry' })
    assert.deepEqual(await refuse(session), { kind: 'retry' })
    assert.equal(await refuse(session), undefined)
    assert.deepEqual(await refuse(other), { kind: 'retry' })
  })
})
