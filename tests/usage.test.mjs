import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  creditLines,
  describeUsage,
  fetchUsageReport,
  formatDuration,
  planNameOf,
  usageHeaders,
  windowPercent,
} from '../lib/usage.js'

const BASE = 'https://api.commandcode.ai'

const HEALTHY = {
  '/alpha/whoami': { user: { id: 'u1', name: 'Ada', userName: 'ada' }, org: { id: 'org 1' } },
  '/alpha/usage/summary': {
    totalCount: 40,
    completedCount: 38,
    failedCount: 2,
    successRate: 0.95,
    totalCost: 1.2345,
    totalTokensIn: 1_200_000,
    totalTokensOut: 34_000,
    totalCredits: 500,
    periodBasis: 'billing-period',
  },
  '/alpha/billing/credits': {
    credits: { monthlyCredits: 1000, purchasedCredits: 250, freeCredits: 5, planId: 'individual-goat' },
    windowLimits: {
      fiveHour: { used: 12, cap: 60, exceeded: false, resetAt: 1_800_000_000 },
      weekly: { used: 61, cap: 60, exceeded: true, resetAt: 1_800_100_000 },
    },
  },
  '/alpha/billing/subscriptions?orgId=org%201': {
    data: { planId: 'individual-pro-v1', status: 'active', currentPeriodEnd: 1_900_000_000 },
  },
}

/** Answer the account surface from a fixture keyed by path. */
function stubFetch(table, { onCall } = {}) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    const path = url.slice(BASE.length)
    calls.push({ path, options })
    onCall?.(path)
    const entry = table[path]
    if (entry === undefined) return { ok: false, status: 404, json: async () => ({}) }
    if (entry instanceof Error) throw entry
    if (entry.status !== undefined && entry.status >= 400) return { ok: false, status: entry.status, json: async () => entry.body ?? {} }
    return { ok: true, status: 200, json: async () => entry }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

describe('planNameOf', () => {
  it('matches the longest known prefix', () => {
    assert.equal(planNameOf('individual-goat'), 'GOAT')
    assert.equal(planNameOf('individual-pro-v1'), 'Pro')
    assert.equal(planNameOf('individual-pro'), 'Pro')
    assert.equal(planNameOf('teams-pro'), 'Teams Pro')
  })

  it('normalizes underscores and casing', () => {
    assert.equal(planNameOf('Individual_Pro'), 'Pro')
  })

  it('passes an unknown id through and answers empty for nothing', () => {
    assert.equal(planNameOf('individual-galactic'), 'individual-galactic')
    assert.equal(planNameOf(''), '')
    assert.equal(planNameOf(undefined), '')
  })
})

describe('usageHeaders', () => {
  it('carries the bearer key and the CLI identity the endpoints expect', () => {
    const headers = usageHeaders('k')
    assert.equal(headers.authorization, 'Bearer k')
    assert.equal(headers['x-command-code-version'], '1.44.0')
    assert.equal(headers['x-cli-environment'], 'production')
  })
})

describe('fetchUsageReport', () => {
  it('normalizes the whole surface and asks for the org-scoped subscriptions', async () => {
    const stub = stubFetch(HEALTHY)
    try {
      const report = await fetchUsageReport('key', BASE)
      assert.deepEqual(report.failures, [])
      assert.equal(report.blocked, undefined)
      assert.deepEqual(report.account, { id: 'u1', name: 'Ada', userName: 'ada', orgId: 'org 1' })
      assert.equal(report.plan.name, 'Pro')
      assert.equal(report.plan.status, 'active')
      assert.equal(report.plan.currentPeriodEnd, 1_900_000_000)
      assert.equal(report.usage.completedCount, 38)
      assert.equal(report.usage.totalTokensIn, 1_200_000)
      assert.deepEqual(report.credits.fiveHour, { used: 12, cap: 60, exceeded: false, resetAt: 1_800_000_000, remaining: 48 })
      assert.equal(report.credits.weekly.exceeded, true)
      assert.equal(report.credits.monthlyCredits, 1000)
    } finally {
      stub.restore()
    }
    assert.deepEqual(stub.calls.map((call) => call.path), [
      '/alpha/whoami',
      '/alpha/usage/summary',
      '/alpha/billing/credits',
      '/alpha/billing/subscriptions?orgId=org%201',
    ])
  })

  it('degrades one failing endpoint into a note instead of blanking the report', async () => {
    const stub = stubFetch({ ...HEALTHY, '/alpha/usage/summary': { status: 500 } })
    try {
      const report = await fetchUsageReport('key', BASE)
      assert.deepEqual(report.failures, ['/alpha/usage/summary: HTTP 500'])
      assert.equal(report.usage, undefined)
      assert.equal(report.credits.monthlyCredits, 1000)
      assert.equal(report.blocked, undefined)
    } finally {
      stub.restore()
    }
  })

  it('still makes the fourth call when the third failed', async () => {
    const stub = stubFetch({ '/alpha/billing/credits': { status: 503 }, '/alpha/billing/subscriptions': { data: { planId: 'individual-max' } } })
    try {
      const report = await fetchUsageReport('key', BASE)
      assert.equal(report.failures.length, 3)
      assert.equal(report.plan.name, 'Max')
    } finally {
      stub.restore()
    }
  })

  it('names a cause only when every endpoint failed the same way', async () => {
    const unauthorized = stubFetch({})
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) })
    try {
      assert.equal((await fetchUsageReport('key', BASE)).blocked, 'invalid-key')
    } finally {
      unauthorized.restore()
    }

    const outage = stubFetch({})
    globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) })
    try {
      assert.equal((await fetchUsageReport('key', BASE)).blocked, 'service-unavailable')
    } finally {
      outage.restore()
    }

    const offline = stubFetch({})
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    try {
      const report = await fetchUsageReport('key', BASE)
      assert.equal(report.blocked, 'network')
      assert.equal(report.failures.length, 4)
    } finally {
      offline.restore()
    }
  })

  it('treats a mixed failure as no stated cause', async () => {
    const stub = stubFetch({})
    globalThis.fetch = async (url) => (url.endsWith('/whoami')
      ? { ok: false, status: 401, json: async () => ({}) }
      : { ok: false, status: 500, json: async () => ({}) })
    try {
      assert.equal((await fetchUsageReport('key', BASE)).blocked, undefined)
    } finally {
      stub.restore()
    }
  })

  it('survives a body whose fields are the wrong type', async () => {
    const stub = stubFetch({
      '/alpha/whoami': { user: 'nope' },
      '/alpha/usage/summary': { totalCount: 'lots', successRate: null },
      '/alpha/billing/credits': { credits: { monthlyCredits: 'many' }, windowLimits: { fiveHour: { used: 1, cap: 0 } } },
      '/alpha/billing/subscriptions': {},
    })
    try {
      const report = await fetchUsageReport('key', BASE)
      // `used > 0` with a zero cap still states something, so the window is
      // reported; the strings that are not numbers all collapse to zero.
      assert.equal(report.usage.totalCount, 0)
      assert.equal(report.usage.successRate, 0)
      assert.equal(report.credits.monthlyCredits, 0)
      assert.equal(report.credits.fiveHour.used, 1)
      assert.equal(report.account, undefined)
    } finally {
      stub.restore()
    }
  })

  it('omits an org filter when the account names no organisation', async () => {
    const stub = stubFetch({ '/alpha/billing/subscriptions': { data: { planId: 'individual-goat' } } })
    try {
      await fetchUsageReport('key', BASE)
    } finally {
      stub.restore()
    }
    assert.equal(stub.calls[3].path, '/alpha/billing/subscriptions')
  })

  it('tolerates a trailing slash on the base', async () => {
    const stub = stubFetch(HEALTHY)
    try {
      await fetchUsageReport('key', `${BASE}/`)
    } finally {
      stub.restore()
    }
    assert.equal(stub.calls[0].path, '/alpha/whoami')
  })
})

describe('presentation helpers', () => {
  it('clamps a window percentage', () => {
    assert.equal(windowPercent({ used: 1, cap: 4 }), 25)
    assert.equal(windowPercent({ used: 99, cap: 4 }), 100)
    assert.equal(windowPercent({ used: 1, cap: 0 }), 0)
    assert.equal(windowPercent(undefined), 0)
  })

  it('formats a duration at each scale', () => {
    assert.equal(formatDuration(45), '45s')
    assert.equal(formatDuration(600), '10m')
    assert.equal(formatDuration(3600 * 3 + 60 * 12), '3h 12m')
    assert.equal(formatDuration(3600 * 30), '1d 6h')
    assert.equal(formatDuration(-5), '0s')
  })

  it('describes only the credit windows the account reports', () => {
    assert.deepEqual(creditLines(undefined), [])
    assert.deepEqual(creditLines({ monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 }), [])
    const lines = creditLines({ monthlyCredits: 10, purchasedCredits: 0, freeCredits: 0, fiveHour: { used: 1, cap: 2, exceeded: false } })
    assert.equal(lines.length, 2)
    assert.match(lines[1], /5h window: 1\/2 requests/)
  })

  it('writes a summary a model can read', () => {
    const text = describeUsage({
      account: { userName: 'ada', id: 'u1' },
      plan: { name: 'GOAT', status: 'active' },
      usage: { completedCount: 38, totalCount: 40, failedCount: 2, successRate: 0.95, totalCost: 1.2345, totalTokensIn: 100, totalTokensOut: 20, periodBasis: 'billing-period' },
      credits: { monthlyCredits: 10, purchasedCredits: 0, freeCredits: 0, fiveHour: { used: 1, cap: 2, exceeded: false } },
      failures: [],
    })
    assert.match(text, /account: ada/)
    assert.match(text, /plan: GOAT \(active\)/)
    assert.match(text, /38\/40 completed, 2 failed, success rate 95%/)
    assert.match(text, /\$1\.2345 over the billing-period/)
    assert.match(text, /tokens: 100 in \/ 20 out/)
  })

  it('says what is missing rather than reporting nothing', () => {
    assert.equal(describeUsage({ failures: [] }), 'the account reported nothing')
    assert.match(describeUsage({ failures: ['/alpha/whoami: HTTP 500'] }), /unavailable: \/alpha\/whoami: HTTP 500/)
    assert.match(describeUsage({ failures: ['a', 'b', 'c', 'd'], blocked: 'invalid-key' }), /rejected the API key/)
    assert.match(describeUsage({ failures: [], blocked: 'service-unavailable' }), /server errors/)
    assert.match(describeUsage({ failures: [], blocked: 'network' }), /could not be reached/)
  })
})
