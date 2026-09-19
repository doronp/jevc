import { describe, it, expect } from 'vitest'
import { validateProgram, lintProgram, type Program } from '../src/ir.js'

const prog = (over: Partial<Program> = {}): Program => ({
  decisions: [
    { id: 'is_destructive', kind: 'noul', instructions: 'Does the command delete data?' },
    { id: 'blast_radius', kind: 'score', instructions: 'How wide is the impact?',
      criteria: ['single file', 'one directory', 'whole repo'] },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'is_destructive', op: 'gte', value: 0.8 }], then: 'deny' }], otherwise: 'allow' },
  residual: '',
  dropped: [],
  ...over,
})

describe('validateProgram', () => {
  it('accepts a well-formed program', () => {
    expect(validateProgram(prog())).toEqual([])
  })

  it('rejects duplicate decision ids (the API silently keeps the last)', () => {
    const p = prog()
    p.decisions.push({ id: 'is_destructive', kind: 'noul', instructions: 'again' })
    expect(validateProgram(p)[0].code).toBe('duplicate_id')
  })

  it('rejects a reducer referencing an unknown decision', () => {
    const p = prog({ reduce: { kind: 'rules',
      rules: [{ when: [{ id: 'nope', op: 'gte', value: 0.5 }], then: 'deny' }], otherwise: 'allow' } })
    expect(validateProgram(p)[0].code).toBe('reduce_unknown_id')
  })

  it('rejects a score threshold outside level-index space', () => {
    const p = prog({ reduce: { kind: 'rules',
      rules: [{ when: [{ id: 'blast_radius', op: 'gte', value: 0.8 }], then: 'deny' }], otherwise: 'allow' } })
    // 3 levels => valid range is 0..2; 0.8 is legal. 5 is not.
    expect(validateProgram(p)).toEqual([])
    const bad = prog({ reduce: { kind: 'rules',
      rules: [{ when: [{ id: 'blast_radius', op: 'gte', value: 5 }], then: 'deny' }], otherwise: 'allow' } })
    expect(validateProgram(bad)[0].code).toBe('score_threshold_out_of_range')
  })

  it('rejects belowConfidence on a noul, which has no confidence field', () => {
    const p = prog()
    p.decisions[0].uncertain = { belowConfidence: 0.7 }
    expect(validateProgram(p)[0].code).toBe('noul_has_no_confidence')
  })

  it('accepts a band on a noul', () => {
    const p = prog()
    p.decisions[0].uncertain = { band: [0.35, 0.65] }
    expect(validateProgram(p)).toEqual([])
  })

  it('rejects a band on a score, which has a confidence field instead', () => {
    const p = prog()
    p.decisions[1].uncertain = { band: [0.35, 0.65] } // blast_radius is a score
    expect(validateProgram(p)[0].code).toBe('band_needs_noul')
  })

  it('rejects a reduce condition referencing an option that does not exist on a choice', () => {
    const p = prog()
    p.decisions.push({ id: 'department', kind: 'choice', instructions: 'Which team?',
      criteria: { billing: 'payments', technical: 'bugs' } })
    p.reduce = { kind: 'rules',
      rules: [{ when: [{ id: 'department', op: 'is', value: 'sales' }], then: 'deny' }], otherwise: 'allow' }
    expect(validateProgram(p)[0].code).toBe('reduce_unknown_option')
  })

  it('rejects a negative score threshold, which is also outside level-index space', () => {
    const p = prog({ reduce: { kind: 'rules',
      rules: [{ when: [{ id: 'blast_radius', op: 'gte', value: -1 }], then: 'deny' }], otherwise: 'allow' } })
    expect(validateProgram(p)[0].code).toBe('score_threshold_out_of_range')
  })

  it('rejects a choice or score decision with no criteria', () => {
    const p = prog()
    p.decisions.push({ id: 'department', kind: 'choice', instructions: 'Which team?' })
    p.decisions.push({ id: 'severity', kind: 'score', instructions: 'How severe?' })
    const issues = validateProgram(p)
    expect(issues.filter(i => i.code === 'criteria_missing').map(i => i.path)).toEqual([
      'decisions.department', 'decisions.severity',
    ])
  })
})

// Fix round 2. One defect wearing several hats: a Program only ever exists at runtime as a
// bare cast of parsed JSON (cli.ts:197, from-prompt.ts:172, runtime.ts:119), so the
// TypeScript unions below constrain nothing that actually arrives, and validateProgram used
// to re-derive by hand only the invariants someone had thought of. Each case here is a
// member of that enumeration's complement, and each one reaches the wire at exit 0.
describe('validateProgram — invariants the type system states and the cast discards', () => {
  /** The cast IS the test: it is the same one every entry point performs on parsed JSON. */
  const untyped = (p: unknown): Program => p as Program

  it('rejects a condition op outside the vocabulary, which the runtime executes as lte', () => {
    // `gt` is the plausible model variant of `gte`. Unguarded it reaches runtime.ts:43 and
    // all five emitters, where anything that is not 'gte' runs as '<=' — verified through
    // the shipped CLI: runReducer returned deny for noul 0.02 and allow for noul 0.97, and
    // `emit-policy --for bouncer` wrote `p: <=0.8` under `then: deny` at exit 0.
    const p = untyped({ ...prog(), reduce: { kind: 'rules', rules: [
      { when: [{ id: 'is_destructive', op: 'gt', value: 0.8 }], then: 'deny' }], otherwise: 'allow' } })
    const issues = validateProgram(p)
    expect(issues.map(i => i.code)).toEqual(['condition_op_unknown'])
    expect(issues[0].severity).toBe('error')
  })

  it('rejects a decision kind outside the three primitives, which is emitted as a choice', () => {
    const p = untyped({ ...prog(), decisions: [
      { id: 'is_destructive', kind: 'boolean', instructions: 'Does the command delete data?' }] })
    expect(validateProgram(p).map(i => i.code)).toEqual(['decision_kind_unknown'])
  })

  it('rejects criteria whose shape contradicts the kind', () => {
    // The score throws in toQuestion three layers downstream; the choice does not throw at
    // all, it ships the options "0" and "1".
    const p = untyped({ ...prog(),
      decisions: [
        { id: 'department', kind: 'choice', instructions: 'Which team?', criteria: ['billing', 'technical'] },
        { id: 'severity', kind: 'score', instructions: 'How severe?', criteria: { low: 'a', high: 'b' } },
        { id: 'confirmed', kind: 'noul', instructions: 'Confirmed?', criteria: ['yes', 'no'] },
      ],
      reduce: { kind: 'rules', rules: [], otherwise: 'allow' } })
    expect(validateProgram(p).map(i => `${i.code} ${i.path}`)).toEqual([
      'criteria_shape decisions.department.criteria',
      'criteria_shape decisions.severity.criteria',
      'criteria_shape decisions.confirmed.criteria',
    ])
  })

  it('rejects `is` against a noul or a score, where no answer can ever match it', () => {
    const noul = prog({ reduce: { kind: 'rules', rules: [
      { when: [{ id: 'is_destructive', op: 'is', value: 'true' }], then: 'deny' }], otherwise: 'allow' } })
    expect(validateProgram(noul).map(i => i.code)).toEqual(['is_needs_choice'])
    const score = prog({ reduce: { kind: 'rules', rules: [
      { when: [{ id: 'blast_radius', op: 'is', value: 'whole repo' }], then: 'deny' }], otherwise: 'allow' } })
    expect(validateProgram(score).map(i => i.code)).toEqual(['is_needs_choice'])
  })

  it('keeps gte against a choice legal, because it tests the answer\'s confidence', () => {
    const p = prog()
    p.decisions.push({ id: 'department', kind: 'choice', instructions: 'Which team?',
      criteria: { billing: 'payments', technical: 'bugs' } })
    p.reduce = { kind: 'rules', rules: [
      { when: [{ id: 'department', op: 'gte', value: 0.9 }], then: 'route' }], otherwise: 'ask' }
    expect(validateProgram(p)).toEqual([])
  })

  it('rejects an uncertain that declares neither band nor belowConfidence', () => {
    // Strictly worse than omitting the field: uncertaintyOf defaults only when it is
    // ABSENT, so isUncertain reaches a declared-but-empty rule and throws mid-evaluation.
    const p = untyped({ ...prog(), decisions: [
      { id: 'is_destructive', kind: 'noul', instructions: 'Does the command delete data?', uncertain: {} }] })
    expect(validateProgram(p).map(i => i.code)).toEqual(['uncertain_empty'])
  })

  it('rejects a noul threshold outside 0..1, dead in one direction and unconditional in the other', () => {
    // Level-index thresholds are range-checked against a score and were not against a
    // noul, whose answer is a probability. `gte 3` can never fire; `lte 3` always does —
    // verified: noul 0.99 fell through a `lte 3` rule to the verdict meant for low values.
    const dead = prog({ reduce: { kind: 'rules', rules: [
      { when: [{ id: 'is_destructive', op: 'gte', value: 3 }], then: 'deny' }], otherwise: 'allow' } })
    expect(validateProgram(dead).map(i => i.code)).toEqual(['probability_threshold_out_of_range'])
    const unconditional = prog({ reduce: { kind: 'rules', rules: [
      { when: [{ id: 'is_destructive', op: 'lte', value: 3 }], then: 'allow' }], otherwise: 'deny' } })
    expect(validateProgram(unconditional).map(i => i.code)).toEqual(['probability_threshold_out_of_range'])
  })

  it('rejects a confidence threshold on a choice outside 0..1', () => {
    const p = prog()
    p.decisions.push({ id: 'department', kind: 'choice', instructions: 'Which team?',
      criteria: { billing: 'payments', technical: 'bugs' } })
    p.reduce = { kind: 'rules', rules: [
      { when: [{ id: 'department', op: 'gte', value: 2 }], then: 'route' }], otherwise: 'ask' }
    expect(validateProgram(p).map(i => i.code)).toEqual(['probability_threshold_out_of_range'])
  })

  it('rejects a reducer with no otherwise, which makes the verdict literally undefined', () => {
    // runReducer returns undefined, which every `if (verdict === "deny")` caller reads as
    // permission, and emitNative writes it into a function declared `: string`.
    const { otherwise: _dropped, ...noFallthrough } = prog().reduce
    const p = untyped({ ...prog(), reduce: noFallthrough })
    expect(validateProgram(p).map(i => `${i.code} ${i.path}`)).toEqual([
      'reduce_verdict_missing reduce.otherwise',
    ])
  })

  it('rejects a rule that matches and names no verdict', () => {
    const p = untyped({ ...prog(), reduce: { kind: 'rules', rules: [
      { when: [{ id: 'is_destructive', op: 'gte', value: 0.8 }] }], otherwise: 'allow' } })
    expect(validateProgram(p).map(i => `${i.code} ${i.path}`)).toEqual([
      'reduce_verdict_missing reduce.rules[0].then',
    ])
  })

  it('rejects an unknown reducer kind rather than running it as first-match-wins', () => {
    const p = untyped({ ...prog(), reduce: { ...prog().reduce, kind: 'weights' } })
    expect(validateProgram(p).map(i => i.code)).toEqual(['reduce_kind_unknown'])
  })

  // The wire limits belong to the Program, not to one emit path: validateRequest enforces
  // them, but only `--emit=json` runs it, so `jevc compile` on `{"enum":[1,"1"]}` — two
  // enum members that collapse to one criteria key — emitted a 1-option choice at exit 0
  // on the default native path. The API answers a 1-option choice at confidence 1.0.
  it('rejects a choice outside the 2..255 option range', () => {
    const one = prog()
    one.decisions.push({ id: 'department', kind: 'choice', instructions: 'Which team?',
      criteria: { billing: 'payments' } })
    expect(validateProgram(one).map(i => i.code)).toEqual(['choice_too_few_options'])
    const many = prog()
    many.decisions.push({ id: 'department', kind: 'choice', instructions: 'Which team?',
      criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`option_${i}`, null])) })
    expect(validateProgram(many).map(i => i.code)).toEqual(['choice_too_many_options'])
  })

  it('rejects a score outside the 2..10 level range', () => {
    const one = prog({ decisions: [
      { id: 'blast_radius', kind: 'score', instructions: 'How wide?', criteria: ['single file'] }],
      reduce: { kind: 'rules', rules: [], otherwise: 'allow' } })
    expect(validateProgram(one).map(i => i.code)).toEqual(['score_too_few_levels'])
    const eleven = prog({ decisions: [
      { id: 'blast_radius', kind: 'score', instructions: 'How wide?',
        criteria: Array.from({ length: 11 }, (_, i) => `level ${i}`) }],
      reduce: { kind: 'rules', rules: [], otherwise: 'allow' } })
    expect(validateProgram(eleven).map(i => i.code)).toEqual(['score_too_many_levels'])
  })
})

describe('lintProgram — the decomposition law', () => {
  it('rejects a collapsed verdict question', () => {
    const p = prog()
    p.decisions.push({ id: 'decision', kind: 'choice',
      instructions: 'What should the harness do?',
      criteria: { allow: 'safe', ask: 'needs approval', deny: 'block it' } })
    const issues = lintProgram(p)
    expect(issues[0].code).toBe('collapsed_verdict')
    expect(issues[0].message).toMatch(/computed in code/)
  })

  it('rejects a collapsed verdict framed by instructions, even with domain-named options', () => {
    const p = prog()
    p.decisions.push({ id: 'response_action', kind: 'choice',
      instructions: 'What action should be taken on this alert?',
      criteria: { allow: 'let it proceed', deny: 'block it', quarantine: 'isolate the resource', sandbox: 'run in a sandbox' } })
    const issues = lintProgram(p)
    // Vocabulary alone would not trip this: only 2 of 4 options (allow, deny) are
    // verdict words, short of the opts.length - 1 = 3 the vocabulary check requires.
    expect(issues.some(i => i.code === 'collapsed_verdict')).toBe(true)
  })

  it('allows a choice whose options are not verdicts', () => {
    const p = prog()
    p.decisions.push({ id: 'department', kind: 'choice', instructions: 'Which team?',
      criteria: { billing: 'payments', technical: 'bugs', sales: 'pricing' } })
    expect(lintProgram(p)).toEqual([])
  })

  it('keeps a legitimate "should" choice question clean when it is not verdict-framed', () => {
    const p = prog()
    p.decisions.push({ id: 'department', kind: 'choice', instructions: 'Which team should handle this?',
      criteria: { billing: 'payments', technical: 'bugs', sales: 'pricing' } })
    expect(lintProgram(p)).toEqual([])
  })

  it('warns when one decision logically determines another', () => {
    const p = prog()
    p.decisions.push({ id: 'rule_conflict', kind: 'choice', instructions: 'Which rule wins?',
      criteria: { exception_wins: 'the documented exception governs', rule_wins: 'the base rule governs' } })
    p.decisions.push({ id: 'should_deny', kind: 'noul',
      instructions: 'Should this be denied given the rule conflict?', dependsOn: ['rule_conflict'] })
    const issues = lintProgram(p)
    expect(issues.some(i => i.code === 'dependent_questions')).toBe(true)
  })

  it('warns on a question spanning two scopes', () => {
    const p = prog()
    p.decisions.push({ id: 'authorized', kind: 'noul',
      instructions: 'Did the user authorize this action, or did it go materially further than asked?' })
    expect(lintProgram(p).some(i => i.code === 'compound_question')).toBe(true)
  })

  it('does not flag a single-scope question containing an unrelated enumeration "or"', () => {
    const p = prog()
    p.decisions.push({ id: 'is_config_junk', kind: 'noul',
      instructions: 'Is this a config file, matching *.env or *.key, or should it be ignored?' })
    expect(lintProgram(p).some(i => i.code === 'compound_question')).toBe(false)
  })

  it('warns when a carve-out or exception is embedded in the question text', () => {
    const p = prog()
    p.decisions.push({ id: 'is_protected_delete', kind: 'noul',
      instructions: 'Does this delete a file, except anything under test/fixtures/?' })
    expect(lintProgram(p).some(i => i.code === 'embedded_carveout')).toBe(true)
  })

  it('warns when a glob or pattern is embedded in the question text', () => {
    const p = prog()
    p.decisions.push({ id: 'matches_deny_glob', kind: 'noul',
      instructions: 'Does the changed path match *.env or *.key?' })
    expect(lintProgram(p).some(i => i.code === 'embedded_pattern')).toBe(true)
  })

  it('does not warn about a carve-out or pattern when the question contains neither', () => {
    const p = prog()
    const codes = lintProgram(p).map(i => i.code)
    expect(codes).not.toContain('embedded_carveout')
    expect(codes).not.toContain('embedded_pattern')
  })
})
