import { describe, it, expect } from 'vitest'
import { canEmit, TARGETS } from '../src/emit/capability.js'
import { runReducer } from '../src/runtime.js'
import type { JevAnswer } from '../src/contract.js'
import type { Program } from '../src/ir.js'

const mixed: Program = {
  decisions: [
    { id: 'destructive', kind: 'noul', instructions: 'Deletes data?' },
    { id: 'radius', kind: 'score', instructions: 'How wide?', criteria: ['file', 'dir', 'repo'] },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'destructive', op: 'gte', value: 0.8 }], then: 'deny' }], otherwise: 'allow' },
  residual: '', dropped: [],
}

const nouls: Program = {
  decisions: [
    { id: 'destructive', kind: 'noul', instructions: 'Deletes data?' },
    { id: 'outside_repo', kind: 'noul', instructions: 'Touches paths outside the repo?' },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'destructive', op: 'gte', value: 0.8 }], then: 'deny' }], otherwise: 'allow' },
  residual: '', dropped: [],
}

/** One rule naming two questions: `destructive >= 0.85 AND outside_repo >= 0.85`. */
const andShaped: Program = { ...nouls, reduce: { kind: 'rules', rules: [
  { when: [{ id: 'destructive', op: 'gte', value: 0.85 },
           { id: 'outside_repo', op: 'gte', value: 0.85 }], then: 'deny' }], otherwise: 'allow' } }

/** The same two thresholds as a disjunction: one condition per rule, repeated per question. */
const orShaped: Program = { ...nouls, reduce: { kind: 'rules', rules: [
  { when: [{ id: 'destructive', op: 'gte', value: 0.85 }], then: 'deny' },
  { when: [{ id: 'outside_repo', op: 'gte', value: 0.85 }], then: 'deny' },
  { when: [{ id: 'destructive', op: 'gte', value: 0.55 }], then: 'ask' },
  { when: [{ id: 'outside_repo', op: 'gte', value: 0.55 }], then: 'ask' },
], otherwise: 'allow' } }

/** Transcription of toolgate's decide() (src/engine.ts:40-56): max over every question
 *  probability, then `>= deny` => deny, `>= ask` => ask, else allow. */
const toolgateVerdict = (ps: number[], deny = 0.85, ask = 0.55): string => {
  const m = Math.max(...ps)
  return m >= deny ? 'deny' : m >= ask ? 'ask' : 'allow'
}

const answers = (a: number, b: number): Record<string, JevAnswer> => ({
  destructive: { type: 'noul', noul: a },
  outside_repo: { type: 'noul', noul: b },
})

const GRID = [0, 0.1, 0.5, 0.54, 0.55, 0.56, 0.84, 0.85, 0.86, 0.9, 1]

describe('canEmit', () => {
  it('accepts a mixed-kind program on the native target', () => {
    expect(canEmit(mixed, 'sdk')).toEqual([])
  })

  it('rejects a score decision on bouncer, which is noul-only', () => {
    const issues = canEmit(mixed, 'bouncer')
    expect(issues[0].code).toBe('kind_unsupported')
    expect(issues[0].message).toMatch(/noul/)
  })

  it('rejects a score decision on toolgate, which is boolean-only', () => {
    expect(canEmit(mixed, 'toolgate')[0].code).toBe('kind_unsupported')
  })

  it('accepts an all-noul program on bouncer', () => {
    expect(canEmit(nouls, 'bouncer')).toEqual([])
  })

  it('rejects a multi-condition rule on bouncer, which allows one question per rule', () => {
    const multi: Program = { ...nouls, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'destructive', op: 'gte', value: 0.8 },
               { id: 'outside_repo', op: 'gte', value: 0.5 }], then: 'deny' }], otherwise: 'allow' } }
    expect(canEmit(multi, 'bouncer')[0].code).toBe('reducer_too_complex')
  })

  // `when: [a, b]` is a CONJUNCTION — runReducer evaluates `rule.when.every(...)` — while
  // toolgate's max(probability) >= threshold is a DISJUNCTION. Accepting the AND shape
  // here emitted an OR policy: at a=0.9, b=0.1 the Program says allow and the emitted
  // policy says deny. One condition per rule is the constraint on EVERY non-code target.
  it('rejects a multi-condition rule on toolgate too, since when[] is an AND and max() is an OR', () => {
    expect(canEmit(andShaped, 'toolgate')[0].code).toBe('reducer_too_complex')
    expect(canEmit(andShaped, 'bouncer')[0].code).toBe('reducer_too_complex')
  })

  // toolgate's real native shape: one condition per rule, repeated per question.
  // First-match-wins over that list evaluates as exactly max-over-questions.
  it('accepts the OR form on toolgate — one condition per rule, repeated per question', () => {
    expect(canEmit(orShaped, 'toolgate')).toEqual([])
  })

  it('rejects a threshold outside 0..1 on bouncer, whose p grammar is bounded', () => {
    const p: Program = { ...mixed, decisions: [nouls.decisions[0], mixed.decisions[1]],
      reduce: { kind: 'rules', rules: [
        { when: [{ id: 'radius', op: 'gte', value: 1.5 }], then: 'deny' }], otherwise: 'allow' } }
    expect(canEmit(p, 'bouncer').some(i => i.code === 'threshold_out_of_target_range')).toBe(true)
  })

  // Amendment: the range check alone passes 1e-7 (it IS in 0..1) but bouncer's grammar is
  // `(>=|>|<=|<)\s*(\d*\.?\d+)` with no exponent, and JS renders 1e-7 exponentially — so the
  // emitted policy would be refused at load time with every test green. The real constraint
  // is on the serialised string, not the number.
  it('rejects an in-range threshold that serialises to exponential form', () => {
    const p: Program = { ...nouls, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'destructive', op: 'gte', value: 1e-7 }], then: 'deny' }], otherwise: 'allow' } }
    const issues = canEmit(p, 'bouncer')
    expect(issues.some(i => i.code === 'threshold_out_of_target_range')).toBe(false)
    expect(issues.some(i => i.code === 'threshold_unrepresentable')).toBe(true)
  })

  it('accepts the smallest threshold that still serialises as a plain decimal', () => {
    const p: Program = { ...nouls, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'destructive', op: 'gte', value: 0.000001 }], then: 'deny' }], otherwise: 'allow' } }
    expect(canEmit(p, 'bouncer')).toEqual([])
  })

  it('warns that ai-sdk drops the score legend', () => {
    const issues = canEmit(mixed, 'ai-sdk')
    expect(issues.every(i => i.severity === 'warn')).toBe(true)
    expect(issues.some(i => i.code === 'legend_dropped')).toBe(true)
  })

  it('warns when a confidence-based uncertainty rule targets ai-sdk', () => {
    const p: Program = { ...mixed }
    p.decisions[1] = { ...p.decisions[1], uncertain: { belowConfidence: 0.7 } }
    expect(canEmit(p, 'ai-sdk').some(i => i.code === 'confidence_derived')).toBe(true)
  })

  it('rejects an unknown target by name', () => {
    expect(canEmit(mixed, 'nope')[0].code).toBe('unknown_target')
  })

  it('declares every emit target the CLI and emitters can name', () => {
    expect(Object.keys(TARGETS).sort())
      .toEqual(['ai-sdk', 'bouncer', 'json', 'langchain', 'sdk', 'toolgate'])
  })
})

// Comparing config SHAPES is not comparing BEHAVIOUR: the AND program and the OR program
// emit byte-identical toolgate YAML, and only one of them means what the policy does.
// So the acceptance rule is pinned against a transcription of the consumer's own reducer.
describe('toolgate reducer semantics', () => {
  it('diverges from the AND program, which is why canEmit must refuse it', () => {
    expect(runReducer(andShaped, answers(0.9, 0.1))).toBe('allow')
    expect(toolgateVerdict([0.9, 0.1])).toBe('deny')
  })

  it('agrees with the OR program on every point of a probability grid', () => {
    for (const a of GRID) {
      for (const b of GRID) {
        // The pair is carried into the assertion so a failure names the point.
        expect([a, b, runReducer(orShaped, answers(a, b))])
          .toEqual([a, b, toolgateVerdict([a, b])])
      }
    }
  })
})
