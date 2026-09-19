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

  // target-bouncer.md:58 — `then` / `default` must be allow, ask or deny. jevc verdicts are
  // arbitrary strings, so an unchecked one emits a policy bouncer refuses to parse; a policy
  // that fails to parse STOPS resolution (line 9) and routes to on_error, whose default
  // passthrough emits nothing. The user replaces a working gate with a silent one.
  it("rejects a rule verdict outside bouncer's allow/ask/deny vocabulary", () => {
    const q: Program = { ...nouls, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'destructive', op: 'gte', value: 0.8 }], then: 'quarantine' }], otherwise: 'allow' } }
    const issues = canEmit(q, 'bouncer')
    expect(issues.some(i => i.code === 'verdict_unsupported')).toBe(true)
    expect(issues.find(i => i.code === 'verdict_unsupported')!.message).toMatch(/quarantine/)
  })

  it('rejects a fallthrough verdict outside the same vocabulary', () => {
    const q: Program = { ...nouls, reduce: { ...nouls.reduce, otherwise: 'escalate' } }
    expect(canEmit(q, 'bouncer').some(i => i.code === 'verdict_unsupported')).toBe(true)
  })

  it('accepts all three verdicts bouncer does parse', () => {
    const q: Program = { ...nouls, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'destructive', op: 'gte', value: 0.8 }], then: 'deny' },
      { when: [{ id: 'outside_repo', op: 'gte', value: 0.6 }], then: 'ask' },
    ], otherwise: 'allow' } }
    expect(canEmit(q, 'bouncer')).toEqual([])
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

  // A target that cannot emit the question at all has no legend to drop. Reporting both
  // makes the refusal look like two problems and buries the one that matters.
  it('does not warn about a dropped legend for a kind it is already refusing', () => {
    expect(canEmit(mixed, 'bouncer').filter(i => i.path === 'decisions.radius').map(i => i.code))
      .toEqual(['kind_unsupported'])
  })

  // toolgate's thresholds are YAML NUMBERS written by stringify(), not strings matched
  // against a grammar: 1e-7 round-trips through the yaml package both ends use. The
  // serialised-form constraint belongs to bouncer, whose p is a string with the grammar
  // `(>=|>|<=|<)\s*(\d*\.?\d+)` and no exponent.
  it('accepts an exponential threshold on toolgate, which reads thresholds as numbers', () => {
    const tiny: Program = { ...orShaped, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'destructive', op: 'gte', value: 1e-7 }], then: 'deny' },
      { when: [{ id: 'outside_repo', op: 'gte', value: 1e-7 }], then: 'deny' },
      { when: [{ id: 'destructive', op: 'gte', value: 1e-8 }], then: 'ask' },
      { when: [{ id: 'outside_repo', op: 'gte', value: 1e-8 }], then: 'ask' },
    ], otherwise: 'allow' } }
    expect(canEmit(tiny, 'toolgate')).toEqual([])
    expect(canEmit(tiny, 'bouncer').every(i => i.code === 'threshold_unrepresentable')).toBe(true)
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

  // `when: []` is an empty conjunction, and `[].every(...)` is true — runReducer fires
  // such a rule unconditionally. bouncer's emitter read `when[0]` and crashed with a
  // TypeError on `undefined.op`; toolgate's saw no condition and silently dropped the
  // rule from its threshold accounting. Neither target has a way to say "always", so
  // both refuse; the code targets say it exactly and are accepted.
  it('rejects a conditionless rule on the policy targets, which cannot express one', () => {
    const always: Program = { ...nouls, reduce: { kind: 'rules', rules: [
      { when: [], then: 'deny' }], otherwise: 'allow' } }
    expect(canEmit(always, 'bouncer')[0].code).toBe('rule_always_matches')
    expect(canEmit(always, 'toolgate')[0].code).toBe('rule_always_matches')
    expect(canEmit(always, 'sdk')).toEqual([])
    expect(canEmit(always, 'ai-sdk')).toEqual([])
  })

  // A Program with no decisions compiles to a gate that asks nothing and therefore
  // always returns `otherwise`. Every target accepts it in its own way and none of them
  // complains: bouncer emits `questions: {}`, toolgate emits a thresholds block that
  // applies to its four built-ins only, and langchain's TypeSafeClassifier.questions is
  // Field(min_length=1), so that module raises a ValidationError the first time it runs.
  it('rejects a program with no decisions on every target', () => {
    const empty: Program = { decisions: [],
      reduce: { kind: 'rules', rules: [], otherwise: 'allow' }, residual: '', dropped: [] }
    for (const target of Object.keys(TARGETS)) {
      expect([target, canEmit(empty, target)[0]?.code]).toEqual([target, 'no_decisions'])
    }
  })

  // target-bouncer.md:43 — instructions is required and non-empty. An empty one makes
  // the policy unloadable, and an unloadable policy stops resolution and routes to
  // on_error: passthrough, which emits nothing. Same silent gate as a bad verdict.
  it('rejects empty instructions on bouncer, whose loader requires them', () => {
    const blank: Program = { ...nouls,
      decisions: [{ ...nouls.decisions[0], instructions: '   ' }, nouls.decisions[1]] }
    const issues = canEmit(blank, 'bouncer')
    expect(issues[0].code).toBe('instructions_empty')
    expect(issues[0].path).toBe('decisions.destructive')
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
