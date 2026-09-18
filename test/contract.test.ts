import { describe, it, expect } from 'vitest'
import { validateRequest, estimateTokens, redactErrorBody } from '../src/contract.js'

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

  it('rejects only the whole-request budget when no single question is over budget', () => {
    // Three questions, each individually under TOKEN_BUDGET_SINGLE (32k) once
    // combined with state, but summed together over TOKEN_BUDGET_TOTAL (64k).
    // Isolates the whole-request branch from the per-question branch, which
    // the over-budget test above always trips alongside it.
    const big = 'x'.repeat(140_000)
    const issues = validateRequest({ model: 'jev-latest', state: 'hello', questions: {
      a: { type: 'noul', instructions: big },
      b: { type: 'noul', instructions: big },
      c: { type: 'noul', instructions: big } } })
    expect(issues).toEqual([{
      code: 'token_budget_exceeded', path: 'request', severity: 'error',
      message: expect.stringContaining('64000'),
    }])
  })

  it('rejects an unknown top-level field (API silently ignores a typo like `temperature`)', () => {
    const issues = validateRequest({ ...base, temperature: 0.5, questions: {
      a: { type: 'noul', instructions: 'x' } } } as never)
    expect(issues.map(i => i.code)).toContain('unknown_field')
  })

  it('rejects an unknown field on a question (API silently ignores a typo like `weight`)', () => {
    const issues = validateRequest({ ...base, questions: {
      a: { type: 'noul', instructions: 'x', weight: 5 } } } as never)
    expect(issues.map(i => i.code)).toContain('unknown_field')
  })

  it('flags an undescribed score level', () => {
    const issues = validateRequest({ ...base, questions: {
      s: { type: 'score', instructions: 'x', criteria: ['bad', null] } } })
    expect(issues.map(i => i.code)).toContain('score_level_undescribed')
  })

  it('warns when a choice is near the 240-option reliability limit', () => {
    const criteria: Record<string, null> = {}
    for (let i = 0; i < 241; i++) criteria[`opt${i}`] = null
    const issues = validateRequest({ ...base, questions: {
      c: { type: 'choice', instructions: 'x', criteria } } })
    expect(issues).toEqual([{
      code: 'choice_near_limit', path: 'questions.c.criteria', severity: 'warn',
      message: expect.stringContaining('241'),
    }])
  })

  it('rejects a choice over the 255-option maximum', () => {
    const criteria: Record<string, null> = {}
    for (let i = 0; i < 256; i++) criteria[`opt${i}`] = null
    const issues = validateRequest({ ...base, questions: {
      c: { type: 'choice', instructions: 'x', criteria } } })
    expect(issues.map(i => i.code)).toContain('choice_too_many_options')
  })
})

describe('estimateTokens', () => {
  it('uses the measured ~5.1 chars/token ratio', () => {
    expect(estimateTokens('x'.repeat(51_000))).toBeCloseTo(10_000, -2)
  })
})

describe('redactErrorBody', () => {
  // A real measured 422 body: it echoes the whole request, `input` included.
  const body = {
    detail: [
      { type: 'missing', loc: ['body', 'model'], msg: 'Field required',
        input: { state: 'SECRET STATE', questions: {} } },
    ],
  }

  it('redacts the input field but keeps type/loc/msg', () => {
    const redacted = redactErrorBody(body) as { detail: Array<{
      type: string; loc: string[]; msg: string; input: unknown
    }> }
    expect(redacted.detail[0].input).toBe('[redacted]')
    expect(redacted.detail[0].type).toBe('missing')
    expect(redacted.detail[0].loc).toEqual(['body', 'model'])
    expect(redacted.detail[0].msg).toBe('Field required')
  })

  it('redacts nested input fields at any depth', () => {
    const nested = { outer: { inner: { input: { secret: 'x' }, keep: 'y' } } }
    const redacted = redactErrorBody(nested) as { outer: { inner: { input: unknown; keep: string } } }
    expect(redacted.outer.inner.input).toBe('[redacted]')
    expect(redacted.outer.inner.keep).toBe('y')
  })

  it('passes a non-object body through unchanged', () => {
    expect(redactErrorBody('plain string')).toBe('plain string')
    expect(redactErrorBody(42)).toBe(42)
    expect(redactErrorBody(null)).toBe(null)
  })

  it('does not mutate the original body', () => {
    redactErrorBody(body)
    expect(body.detail[0].input).toEqual({ state: 'SECRET STATE', questions: {} })
  })
})
