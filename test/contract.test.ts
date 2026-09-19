import { describe, it, expect } from 'vitest'
import { validateRequest, validateResponse, estimateTokens, redactErrorBody, TOKEN_BUDGET_TOTAL } from '../src/contract.js'
import { loadFixtures, buildProgram } from '../src/check.js'
import type { Program } from '../src/ir.js'

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

  // Fix round 2.5, R1. A noul's criteria has exactly two sub-keys, `true` and `false`.
  // Misspell one and the API silently ignores it (spec §3.1, the same rule the top-level and
  // per-question whitelists above exist for), so the model answers with guidance for only one
  // of its two outcomes and the author is never told their description was dropped.
  it('rejects a misspelled noul criteria sub-key', () => {
    const issues = validateRequest({ ...base, questions: {
      a: { type: 'noul', instructions: 'Is it urgent?',
        criteria: { treu: 'the ticket is urgent', false: 'the ticket is routine' } } } } as never)
    expect(issues.map(i => [i.code, i.path]))
      .toEqual([['unknown_field', 'questions.a.criteria.treu']])
    expect(issues[0].severity).toBe('error')
    expect(issues[0].message).toContain('true, false')
  })

  // Cleanup round, C4. The whitelist landed here and nowhere else, so the path that RETURNS
  // an answer was gated and the path that WRITES A DEPLOYABLE FILE was not. It is one rule
  // about one shape; it is now read from one exported constant by both validators, so the
  // next person to add an outcome key cannot move only half the gate.
  it('exports the key set validateProgram enforces, so the two cannot drift apart', async () => {
    const { NOUL_CRITERIA_KEYS } = await import('../src/contract.js')
    expect([...NOUL_CRITERIA_KEYS]).toEqual(['true', 'false'])
    const { validateProgram } = await import('../src/ir.js')
    const program: Program = {
      decisions: [{ id: 'a', kind: 'noul', instructions: 'Is it urgent?',
        criteria: { treu: 'the ticket is urgent', false: 'the ticket is routine' } as never }],
      reduce: { kind: 'rules', rules: [{ when: [{ id: 'a', op: 'gte', value: 0.8 }], then: 'deny' }],
        otherwise: 'allow' },
      residual: '', dropped: [],
    }
    const onWire = validateRequest({ ...base, questions: {
      a: { type: 'noul', instructions: 'Is it urgent?',
        criteria: { treu: 'the ticket is urgent', false: 'the ticket is routine' } } } } as never)
    const inProgram = validateProgram(program)
    expect(inProgram.map(i => i.code)).toEqual(['unknown_field'])
    expect(inProgram[0].path).toBe('decisions.a.criteria.treu')
    expect(inProgram[0].message).toBe(onWire[0].message)
  })

  it('accepts both real noul criteria sub-keys, and an empty criteria object', () => {
    // `criteria: {}` stays legal: emit-policy builds one, and an omitted description is a
    // different (already-reported) thing from a misspelled one.
    expect(validateRequest({ ...base, questions: {
      a: { type: 'noul', instructions: 'x', criteria: { true: 'yes', false: 'no' } } } })).toEqual([])
    expect(validateRequest({ ...base, questions: {
      a: { type: 'noul', instructions: 'x', criteria: {} } } })).toEqual([])
    expect(validateRequest({ ...base, questions: {
      a: { type: 'noul', instructions: 'x', criteria: null } } })).toEqual([])
  })

  it('reports every violation at once, not just the first', () => {
    const issues = validateRequest({ ...base, questions: {
      s: { type: 'score', instructions: 'x', criteria: ['one'] },
      c: { type: 'choice', instructions: 'y', criteria: { only: null } } } })
    expect(issues.map(i => i.code).sort())
      .toEqual(['choice_too_few_options', 'score_too_few_levels'])
  })

  it('flags a backtick path that does not resolve in a structured state', () => {
    const issues = validateRequest({
      model: 'jev-latest',
      state: { ticket: { messages: [{ text: 'hi' }] } },
      questions: { a: { type: 'noul', instructions: 'Is `ticket.nope.field` angry?' } },
    })
    expect(issues[0].code).toBe('path_unresolved')
    // Still an error: against an object state the path is provably absent.
    expect(issues[0].severity).toBe('error')
  })

  // Fix round 2, F8: backticks are prose markup that also quote option names, literal values
  // and class names, and against a *string* state a dotted token can never resolve at all —
  // so erroring rejected the corpus's core use case (state = source code, question = "does it
  // use `sys.exit`?") for a condition the message itself says the API answers anyway.
  it('does not reject a backticked dotted token against a string state', () => {
    const issues = validateRequest({
      model: 'jev-latest',
      state: 'import sys; sys.exit(0)',
      questions: { q1: { type: 'noul', instructions: 'Does it use `sys.exit`?' } },
    })
    expect(issues.filter(i => i.severity === 'error')).toEqual([])
    // Demoted, not deleted: the CLI still prints it, and evaluate() filters on severity.
    expect(issues).toEqual([{
      code: 'path_unresolved', path: 'questions.q1', severity: 'warn',
      message: expect.stringContaining('sys.exit'),
    }])
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
    // combined with state, but summed together over TOKEN_BUDGET_TOTAL.
    // Isolates the whole-request branch from the per-question branch, which
    // the over-budget test above always trips alongside it.
    const big = 'x'.repeat(140_000)
    const issues = validateRequest({ model: 'jev-latest', state: 'hello', questions: {
      a: { type: 'noul', instructions: big },
      b: { type: 'noul', instructions: big },
      c: { type: 'noul', instructions: big } } })
    expect(issues).toEqual([{
      code: 'token_budget_exceeded', path: 'request', severity: 'error',
      message: expect.stringContaining('45000'),
    }])
  })

  // Fix round 2.5, R3. The budget was 64,000 while the repo's own measurement
  // (docs/superpowers/specs/2026-09-18-jevc-design.md §3.3) records `400 max_tokens_exceeded`
  // at ~45k. A pre-flight budget check that passes requests the API rejects is the one thing
  // it exists to prevent, so the constant is the measurement, not the documented number.
  it('rejects a request in the gap between the measured 45k limit and the documented 64k', () => {
    // Two 120k-char questions: ~23.5k tokens each (under the 32k per-question limit),
    // ~47k together — refused by the API, accepted by the old 64,000 constant.
    const big = 'x'.repeat(120_000)
    const issues = validateRequest({ model: 'jev-latest', state: 'hello', questions: {
      a: { type: 'noul', instructions: big },
      b: { type: 'noul', instructions: big } } })
    expect(issues.map(i => [i.code, i.path])).toEqual([['token_budget_exceeded', 'request']])
    expect(TOKEN_BUDGET_TOTAL).toBe(45_000)
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

// Fix round 2, F9: the response was a bare cast (`res.answers as Record<string, JevAnswer>`)
// on the far side of a paid call, so a malformed one was either silently believed or blamed
// on the program. Every case below was measured against the old code and is noted with what
// it did then. It IS wired into evaluate() — runtime.ts's askModel runs it on every response
// and evaluate throws on the `error`-severity half (see test/runtime.test.ts, "evaluate —
// validateResponse on the response").
describe('validateResponse', () => {
  const p: Program = {
    decisions: [
      { id: 'destructive', kind: 'noul', instructions: 'Deletes data?' },
      { id: 'radius', kind: 'score', instructions: 'How wide?',
        criteria: ['one file', 'one dir', 'whole repo'] },
      { id: 'target', kind: 'choice', instructions: 'Target?',
        criteria: { source: null, build: null } },
    ],
    reduce: { kind: 'rules', rules: [], otherwise: 'ask' },
    residual: '', dropped: [],
  }

  const res = (over: Record<string, unknown> = {}): unknown => ({
    model: 'jev-1.13.0',
    answers: {
      destructive: { type: 'noul', noul: 0.95 },
      radius: { type: 'score', score: 1.99, legend: { '0': 'one file', '1': 'one dir', '2': 'whole repo' },
        probabilities: { '0': 0, '1': 0.99, '2': 0.01 }, confidence: 0.99 },
      target: { type: 'choice', choice: 'build', probabilities: { source: 0.1, build: 0.9 }, confidence: 0.8 },
    },
    usage: { input_tokens: 10, output_tokens: 5 },
    ...over,
  })

  const answers = (over: Record<string, unknown>): unknown =>
    res({ answers: { ...(res() as { answers: Record<string, unknown> }).answers, ...over } })

  it('accepts a well-formed response', () => {
    expect(validateResponse(p, res())).toEqual([])
  })

  // Old behaviour: raw `TypeError: Cannot read properties of null (reading 'destructive')`
  // thrown out of runReducer — a node stack trace pointing at jevc, not at the response.
  it('reports a null answers map instead of dying on a TypeError', () => {
    const issues = validateResponse(p, res({ answers: null }))
    expect(issues.map(i => i.code)).toEqual(['answers_missing'])
    expect(issues[0].severity).toBe('error')
    expect(issues[0].message).toContain('null')
  })

  // Old behaviour: the same raw TypeError, one property earlier.
  it('reports an absent answers map', () => {
    const issues = validateResponse(p, { model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 1 } })
    expect(issues.map(i => i.code)).toEqual(['answers_missing'])
  })

  it('reports a response that is not an object at all', () => {
    expect(validateResponse(p, null).map(i => i.code)).toEqual(['response_malformed'])
    expect(validateResponse(p, 'nope').map(i => i.code)).toEqual(['response_malformed'])
    expect(validateResponse(p, []).map(i => i.code)).toEqual(['response_malformed'])
  })

  // The sharp one. Old behaviour: isUncertain threw `Decision "destructive" needs
  // belowConfidence` — a complaint about the *program's* uncertainty declaration for a
  // defect that is entirely in the response, sending the user to edit the wrong file.
  it('blames the response, not the program, for an answer of the wrong kind', () => {
    const issues = validateResponse(p, answers({
      destructive: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 0.9 },
    }))
    expect(issues).toHaveLength(1)
    expect(issues[0].code).toBe('answer_type_mismatch')
    expect(issues[0].path).toBe('answers.destructive')
    expect(issues[0].message).toMatch(/asked as a noul but answered as "choice"/)
    expect(issues[0].message).not.toMatch(/belowConfidence/)
  })

  // Round 2's report, carried into 2.5: the loop is over `p.decisions`, so a program with
  // duplicate ids reported the same missing answer once per copy. Unreachable through
  // askModel/evaluate (validateProgram's `duplicate_id` throws first) and reachable only by
  // calling validateResponse directly, which is now public.
  it('reports a missing answer once for a program with a duplicate id', () => {
    const dup: Program = { ...p, decisions: [p.decisions[0]!, p.decisions[0]!] }
    const issues = validateResponse(dup, { model: 'x', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } })
    expect(issues.map(i => [i.code, i.path])).toEqual([['answer_missing', 'answers.destructive']])
  })

  it('reports a decision the response did not answer', () => {
    const { radius: _dropped, ...rest } = (res() as { answers: Record<string, unknown> }).answers
    const issues = validateResponse(p, res({ answers: rest }))
    expect(issues.map(i => [i.code, i.path])).toEqual([['answer_missing', 'answers.radius']])
  })

  it('reports a null answer for an asked decision', () => {
    const issues = validateResponse(p, answers({ destructive: null }))
    expect(issues.map(i => [i.code, i.path])).toEqual([['answer_type_mismatch', 'answers.destructive']])
  })

  // Old behaviour: verdict computed with no complaint — a noul above 1 is outside the band
  // space entirely, so it reads as certain.
  it('reports a noul outside 0..1', () => {
    const issues = validateResponse(p, answers({ destructive: { type: 'noul', noul: 1.7 } }))
    expect(issues.map(i => [i.code, i.path])).toEqual([['noul_out_of_range', 'answers.destructive.noul']])
  })

  // Old behaviour: verdict computed with no complaint — "0.95" coerces in a >= comparison.
  it('reports a numeric field that arrived as a string', () => {
    const issues = validateResponse(p, answers({ destructive: { type: 'noul', noul: '0.95' } }))
    expect(issues.map(i => [i.code, i.path])).toEqual([['answer_not_a_number', 'answers.destructive.noul']])
    expect(issues[0].message).toContain('"0.95"')
  })

  it('reports a required numeric field the response omitted entirely', () => {
    const issues = validateResponse(p, answers({
      radius: { type: 'score', score: 1.99, legend: {}, probabilities: {} },
    }))
    expect(issues.map(i => [i.code, i.path])).toEqual([['answer_not_a_number', 'answers.radius.confidence']])
    expect(issues[0].message).toContain('undefined')
  })

  it('reports a confidence outside 0..1', () => {
    const issues = validateResponse(p, answers({
      target: { type: 'choice', choice: 'build', probabilities: { build: 1 }, confidence: 1.4 },
    }))
    expect(issues.map(i => [i.code, i.path])).toEqual([['confidence_out_of_range', 'answers.target.confidence']])
  })

  it('reports a score outside level-index space', () => {
    const issues = validateResponse(p, answers({
      radius: { type: 'score', score: 3, legend: {}, probabilities: {}, confidence: 0.9 },
    }))
    expect(issues.map(i => [i.code, i.path])).toEqual([['score_out_of_range', 'answers.radius.score']])
    expect(issues[0].message).toContain('0..2')
  })

  // Guard, not a defect test: a score answer is the probability-weighted expectation over
  // level indices, not the index itself — 23 of the 26 measured score answers in fixtures/
  // are fractional. An integrality check here would reject almost every real response.
  it('accepts a fractional score, which is the normal case', () => {
    expect(validateResponse(p, answers({
      radius: { type: 'score', score: 0.57, legend: {}, probabilities: {}, confidence: 0.43 },
    }))).toEqual([])
  })

  // Old behaviour: silently falls through every `is` rule to `otherwise` — a wrong verdict
  // with nothing to read afterwards that says why.
  it('reports a choice the program never declared', () => {
    const issues = validateResponse(p, answers({
      target: { type: 'choice', choice: 'quarantine', probabilities: {}, confidence: 0.8 },
    }))
    expect(issues.map(i => [i.code, i.path])).toEqual([['choice_unknown_option', 'answers.target.choice']])
    expect(issues[0].message).toContain('source, build')
  })

  // Decided: warn. An id the program never asked cannot move the verdict (the reducer only
  // reads declared ids), so rejecting the response over it would repeat the F8 mistake —
  // but it is the first visible sign that a moving alias stopped answering what we asked.
  it('warns about an unasked extra answer without rejecting the response', () => {
    const issues = validateResponse(p, answers({ surprise: { type: 'noul', noul: 0.2 } }))
    expect(issues).toEqual([{
      code: 'answer_unasked', path: 'answers.surprise', severity: 'warn',
      message: expect.stringContaining('surprise'),
    }])
    expect(issues.filter(i => i.severity === 'error')).toEqual([])
  })

  // Decided: warn. The verdict is fully computed without usage, so a model that omits it
  // must not have its answers thrown away — but Verdict types `usage` non-optional and
  // hands back `undefined` behind that type, so the omission cannot go unreported either.
  it('warns about missing or malformed usage without rejecting the response', () => {
    const absent = validateResponse(p, res({ usage: undefined }))
    expect(absent.map(i => [i.code, i.severity])).toEqual([['usage_missing', 'warn']])
    const partial = validateResponse(p, res({ usage: { input_tokens: 10 } }))
    expect(partial.map(i => [i.code, i.severity])).toEqual([['usage_missing', 'warn']])
  })

  // The no-false-rejection guard, the response-side twin of "every fixture request passes
  // the contract validator": 60 responses the live API actually returned must all pass.
  it('accepts every measured response in the fixture corpus', () => {
    const fixtures = loadFixtures('fixtures')
    expect(fixtures.length).toBeGreaterThan(0)
    for (const f of fixtures) {
      const issues = validateResponse(buildProgram(f), {
        model: f.measured.model,
        answers: f.measured.answers,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      expect(issues, `${f.id}: ${issues.map(i => `${i.path}: ${i.message}`).join('; ')}`).toEqual([])
    }
  })
})

describe('estimateTokens', () => {
  it('uses the measured ~5.1 chars/token ratio', () => {
    expect(estimateTokens('x'.repeat(51_000))).toBeCloseTo(10_000, -2)
  })
})

// Fix round 2.5, R2. This was a denylist of one key, `input`, on a body shape the remote
// party controls — and the request's own field is `state`, not `input`, so the two echo
// shapes measured off a 422 (`{state: ...}` and `{request: {state: ...}}`) went through
// untouched into `err.body`. Inverted to an allowlist of the diagnostic keys.
describe('redactErrorBody', () => {
  // A real measured 422 body: it echoes the whole request, `input` included.
  const body = {
    detail: [
      { type: 'missing', loc: ['body', 'model'], msg: 'Field required',
        input: { state: 'SECRET STATE', questions: {} } },
    ],
  }

  it('redacts everything that is not a known diagnostic key, input included', () => {
    const redacted = redactErrorBody(body) as { detail: Array<{
      type: string; loc: unknown; msg: unknown; input: unknown
    }> }
    expect(redacted.detail[0].input).toBe('[redacted]')
    expect(redacted.detail[0].type).toBe('missing')
    // The cost of the inversion, pinned so it is a decision rather than a surprise: `loc` and
    // `msg` are not on the allowlist, and `loc` in particular is a path into the request whose
    // tail segments are keys of the caller's own state.
    expect(redacted.detail[0].loc).toBe('[redacted]')
    expect(redacted.detail[0].msg).toBe('[redacted]')
  })

  // The two shapes the old denylist missed. Neither key is named `input`; both carry state.
  it('redacts a 422 that echoes the request under `request`', () => {
    const echo = { detail: 'validation failed',
      request: { model: 'jev-latest', state: 'SECRET STATE', questions: {} } }
    const redacted = redactErrorBody(echo)
    expect(JSON.stringify(redacted)).not.toContain('SECRET STATE')
    expect(redacted).toEqual({ detail: 'validation failed', request: '[redacted]' })
  })

  it('redacts a top-level `state` echo', () => {
    const redacted = redactErrorBody({ error: 'bad request', state: 'SECRET STATE' })
    expect(JSON.stringify(redacted)).not.toContain('SECRET STATE')
    expect(redacted).toEqual({ error: 'bad request', state: '[redacted]' })
  })

  it('redacts at any depth inside an allowed container', () => {
    const nested = { detail: { message: 'keep me', state: { secret: 'x' } } }
    expect(redactErrorBody(nested)).toEqual({ detail: { message: 'keep me', state: '[redacted]' } })
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
