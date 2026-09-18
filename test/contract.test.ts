import { describe, it, expect } from 'vitest'
import { validateRequest, estimateTokens } from '../src/contract.js'

const base = { model: 'jev-latest' as const, state: 'hello' }

describe('validateRequest', () => {
  it('accepts a minimal valid request', () => {
    expect(validateRequest({ ...base, questions: {
      a: { type: 'noul', instructions: 'Is it urgent?' } } })).toEqual([])
  })

  it('rejects a 1-level score (API returns 200 and a meaningless constant)', () => {
    const issues = validateRequest({ ...base, questions: {
      s: { type: 'score', instructions: 'How bad?', criteria: ['only'] } } })
    expect(issues).toHaveLength(1)
    expect(issues[0].code).toBe('score_too_few_levels')
    expect(issues[0].path).toBe('questions.s.criteria')
  })

  it('rejects an 11-level score', () => {
    const criteria = Array.from({ length: 11 }, (_, i) => `level ${i}`)
    expect(validateRequest({ ...base, questions: {
      s: { type: 'score', instructions: 'x', criteria } } })[0].code)
      .toBe('score_too_many_levels')
  })

  it('rejects a 1-option choice (API returns 200 with confidence 1.0)', () => {
    expect(validateRequest({ ...base, questions: {
      c: { type: 'choice', instructions: 'Which?', criteria: { only: null } } } })[0].code)
      .toBe('choice_too_few_options')
  })

  it('rejects an empty question map', () => {
    expect(validateRequest({ ...base, questions: {} })[0].code).toBe('questions_empty')
  })

  it('rejects an empty question id', () => {
    expect(validateRequest({ ...base, questions: {
      '': { type: 'noul', instructions: 'x' } } })[0].code).toBe('id_empty')
  })

  it('rejects an empty state (API returns 200 and answers from nothing)', () => {
    expect(validateRequest({ model: 'jev-latest', state: '', questions: {
      a: { type: 'noul', instructions: 'x' } } })[0].code).toBe('state_empty')
  })

  it('rejects an unknown model', () => {
    expect(validateRequest({ ...base, model: 'jev-9000' as never, questions: {
      a: { type: 'noul', instructions: 'x' } } })[0].code).toBe('model_unknown')
  })

  it('rejects a noul with neither instructions nor criteria', () => {
    expect(validateRequest({ ...base, questions: {
      a: { type: 'noul', instructions: '' } } })[0].code).toBe('noul_empty')
  })

  it('reports every violation at once, not just the first', () => {
    const issues = validateRequest({ ...base, questions: {
      s: { type: 'score', instructions: 'x', criteria: ['one'] },
      c: { type: 'choice', instructions: 'y', criteria: { only: null } } } })
    expect(issues.map(i => i.code).sort())
      .toEqual(['choice_too_few_options', 'score_too_few_levels'])
  })

  it('flags a backtick path that does not resolve in state', () => {
    const issues = validateRequest({
      model: 'jev-latest',
      state: { ticket: { messages: [{ text: 'hi' }] } },
      questions: { a: { type: 'noul', instructions: 'Is `ticket.nope.field` angry?' } },
    })
    expect(issues[0].code).toBe('path_unresolved')
  })

  it('accepts a backtick path that does resolve', () => {
    expect(validateRequest({
      model: 'jev-latest',
      state: { ticket: { messages: [{ text: 'hi' }] } },
      questions: { a: { type: 'noul', instructions: 'Is `ticket.messages[0].text` angry?' } },
    })).toEqual([])
  })

  it('rejects a request over the token budget', () => {
    expect(validateRequest({ model: 'jev-latest', state: 'x'.repeat(200_000),
      questions: { a: { type: 'noul', instructions: 'x' } } })[0].code)
      .toBe('token_budget_exceeded')
  })
})

describe('estimateTokens', () => {
  it('uses the measured ~5.1 chars/token ratio', () => {
    expect(estimateTokens('x'.repeat(51_000))).toBeCloseTo(10_000, -2)
  })
})
