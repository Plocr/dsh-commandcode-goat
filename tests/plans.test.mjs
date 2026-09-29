import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CHANNEL_LABELS,
  PLAN_DOC_URLS,
  allGeneratedKeys,
  catalogPageCandidates,
  isGeneratedDisplayName,
  parseGeneratedKey,
  planTierOf,
  planVariants,
  providerDisplayName,
  tierRouteKeys,
} from '../lib/plans.js'

describe('providerDisplayName', () => {
  it('names one tier the way the reader asked for it', () => {
    assert.equal(providerDisplayName('go', 'openai'), 'Command | go')
    assert.equal(providerDisplayName('goat', 'openai'), 'Command | goat')
    assert.equal(providerDisplayName('pro', 'openai'), 'Command | pro')
    assert.equal(providerDisplayName('max', 'openai'), 'Command | max')
  })

  it('gives the secondary channels of one tier names of their own', () => {
    // The harness prints one row per route; two routes of one tier sharing a
    // name is exactly the "duplicate provider" this rule exists to remove.
    assert.equal(providerDisplayName('goat', 'anthropic'), 'Command | goat · Claude')
    assert.equal(providerDisplayName('pro', 'responses'), 'Command | pro · Responses')
  })

  it('falls back to the raw plan for a tier this build does not know', () => {
    assert.equal(providerDisplayName('ultra', 'openai'), 'Command | ultra')
  })
})

describe('isGeneratedDisplayName', () => {
  it('recognizes every name this plugin writes, and the ones it used to write', () => {
    for (const plan of ['go', 'goat', 'pro', 'max']) {
      assert.equal(isGeneratedDisplayName(providerDisplayName(plan, 'openai')), true)
      assert.equal(isGeneratedDisplayName(providerDisplayName(plan, 'anthropic')), true)
      // 0.6.x named every route of a tier after the tier alone.
      assert.equal(isGeneratedDisplayName(`Command Code ${plan === 'goat' ? 'GOAT' : plan[0].toUpperCase() + plan.slice(1)}`), true)
    }
  })

  it('leaves anything the reader typed alone', () => {
    assert.equal(isGeneratedDisplayName('我的网关'), false)
    assert.equal(isGeneratedDisplayName('Command Code'), false)
    assert.equal(isGeneratedDisplayName('Command | ultra'), false)
    assert.equal(isGeneratedDisplayName(''), false)
    assert.equal(isGeneratedDisplayName(undefined), false)
  })
})

describe('planTierOf', () => {
  it('maps the ids the billing API states to this build’s tiers', () => {
    assert.equal(planTierOf('individual-go'), 'go')
    assert.equal(planTierOf('individual-goat'), 'goat')
    assert.equal(planTierOf('individual-pro'), 'pro')
    assert.equal(planTierOf('individual-pro-v1'), 'pro')
    assert.equal(planTierOf('individual-max'), 'max')
  })

  it('normalizes casing and underscores', () => {
    assert.equal(planTierOf('Individual_GOAT'), 'goat')
  })

  it('answers nothing for a plan whose models this build cannot name', () => {
    assert.equal(planTierOf('individual-provider'), undefined)
    assert.equal(planTierOf('teams-pro'), undefined)
    assert.equal(planTierOf('individual-ultra'), undefined)
    assert.equal(planTierOf(''), undefined)
    assert.equal(planTierOf(undefined), undefined)
  })
})

describe('planVariants', () => {
  it('states the price and the three default limits per tier', () => {
    assert.deepEqual(planVariants('go'), [{ label: 'Go', price: 1, fiveHour: 3, weekly: 6, monthly: 10 }])
    assert.deepEqual(planVariants('goat'), [{ label: 'GOAT', price: 10, fiveHour: 14, weekly: 35, monthly: 70 }])
    assert.deepEqual(planVariants('pro'), [{ label: 'Pro', price: 20, fiveHour: 16, weekly: 40, monthly: 80 }])
    assert.deepEqual(planVariants('max'), [
      { label: 'Max 10×', price: 100, fiveHour: 45, weekly: 90, monthly: 150, premiumMonthly: 100 },
      { label: 'Max 20×', price: 200, fiveHour: 90, weekly: 180, monthly: 300, premiumMonthly: 200 },
    ])
  })

  it('hands out copies, so a card cannot edit the table', () => {
    const first = planVariants('goat')[0]
    first.monthly = 0
    assert.equal(planVariants('goat')[0].monthly, 70)
  })

  it('answers nothing for a tier the vendor does not sell', () => {
    assert.deepEqual(planVariants('ultra'), [])
  })
})

describe('catalogPageCandidates', () => {
  it('follows the tier’s own page, falling back to the one that always answers', () => {
    assert.deepEqual(catalogPageCandidates('go'), [PLAN_DOC_URLS.go, PLAN_DOC_URLS.goat])
    assert.deepEqual(catalogPageCandidates('pro'), [PLAN_DOC_URLS.pro, PLAN_DOC_URLS.goat])
    // The Max page publishes no catalog array at all, so a fallback is the
    // difference between an enriched sync and a silently degraded one.
    assert.deepEqual(catalogPageCandidates('max'), [PLAN_DOC_URLS.max, PLAN_DOC_URLS.goat])
    assert.deepEqual(catalogPageCandidates('goat'), [PLAN_DOC_URLS.goat])
  })

  it('does not repeat a candidate', () => {
    for (const plan of ['go', 'goat', 'pro', 'max']) {
      const candidates = catalogPageCandidates(plan)
      assert.equal(new Set(candidates).size, candidates.length)
    }
  })
})

describe('route keys', () => {
  it('parses a key back to the tier and channel that produced it', () => {
    assert.deepEqual(parseGeneratedKey('commandcode-goat-autosync'), { plan: 'goat', slot: 'openai' })
    assert.deepEqual(parseGeneratedKey('commandcode-max-anthropic'), { plan: 'max', slot: 'anthropic' })
    assert.deepEqual(parseGeneratedKey('commandcode-go-responses'), { plan: 'go', slot: 'responses' })
  })

  it('refuses to claim a route this plugin did not generate', () => {
    // A loose match would make someone else's route this plugin's to delete.
    assert.equal(parseGeneratedKey('commandcode-goat-custom'), undefined)
    assert.equal(parseGeneratedKey('commandcode-ultra-autosync'), undefined)
    assert.equal(parseGeneratedKey('my-own-gateway'), undefined)
    assert.equal(parseGeneratedKey('commandcode'), undefined)
    assert.equal(parseGeneratedKey('commandcode-goat-autosync-2'), undefined)
    assert.equal(parseGeneratedKey(undefined), undefined)
  })

  it('lists every key of a tier, and of the build', () => {
    assert.deepEqual(tierRouteKeys('go').map((entry) => entry.key), [
      'commandcode-go-autosync',
      'commandcode-go-anthropic',
      'commandcode-go-responses',
    ])
    assert.equal(allGeneratedKeys().length, 12)
    assert.equal(new Set(allGeneratedKeys()).size, 12)
  })

  it('labels every channel', () => {
    assert.deepEqual(CHANNEL_LABELS, { openai: 'AutoSync', anthropic: 'Anthropic', responses: 'Responses' })
  })
})
