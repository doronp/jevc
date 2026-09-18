import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { loadFixtures, assertExpectation } from '../src/check.js'

const fixtures = loadFixtures('fixtures')

describe('fixture corpus', () => {
  it('loads all five domains', () => {
    expect(readdirSync('fixtures').filter(f => f.endsWith('.json'))).toHaveLength(5)
  })

  it('loads 60 measured fixtures', () => {
    expect(fixtures).toHaveLength(60)
  })

  it('every fixture records the natural-language prompt it replaces', () => {
    for (const f of fixtures) expect(f.llm_prompt.length).toBeGreaterThan(50)
  })

  it('every fixture carries provenance', () => {
    for (const f of fixtures) expect(f.provenance.length).toBeGreaterThan(10)
  })

  it('every measured response satisfies its recorded expectation', () => {
    for (const f of fixtures) {
      expect(assertExpectation(f.expect, f.measured.answers), `${f.id}`).toEqual([])
    }
  })

  it('no expectation asserts exact equality — answers drift +/-0.01', () => {
    for (const f of fixtures) {
      for (const clause of Object.values(f.expect)) {
        expect(Object.keys(clause), `${f.id}`).not.toContain('noul_eq')
        expect(Object.keys(clause), `${f.id}`).not.toContain('score_eq')
      }
    }
  })

  it('every fixture request passes the contract validator', async () => {
    const { validateRequest } = await import('../src/contract.js')
    for (const f of fixtures) {
      const issues = validateRequest({ model: 'jev-latest', state: f.state, questions: f.questions })
        .filter(i => i.severity === 'error')
      expect(issues, `${f.id}: ${issues.map(i => i.message).join('; ')}`).toEqual([])
    }
  })
})

describe('assertExpectation', () => {
  it('reports a violated lower bound', () => {
    const fails = assertExpectation({ a: { noul_gte: 0.8 } }, { a: { type: 'noul', noul: 0.4 } })
    expect(fails[0]).toMatch(/a: noul 0.4 < 0.8/)
  })
  it('passes a satisfied bound', () => {
    expect(assertExpectation({ a: { noul_gte: 0.8 } }, { a: { type: 'noul', noul: 0.9 } })).toEqual([])
  })
  it('checks a choice by name', () => {
    const fails = assertExpectation({ a: { choice: 'deny' } },
      { a: { type: 'choice', choice: 'allow', probabilities: { allow: 1, deny: 0 }, confidence: 1 } })
    expect(fails[0]).toMatch(/expected deny/)
  })
})
