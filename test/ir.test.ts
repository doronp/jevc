import { describe, it, expect } from 'vitest'
import { validateProgram, lintProgram, type Program } from '../src/ir.js'
import { loadFixtures } from '../src/check.js'

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
    // Pin the instruction the message must give, not the sentence it gives it in: the
    // prose moved in round 2.5 (it was citing a population property the corpus refutes)
    // and a substring match on one phrasing is what makes honest rewrites look like
    // regressions. The severity is the part a consumer acts on.
    expect(issues[0].severity).toBe('error')
    expect(issues[0].path).toBe('decisions.decision')
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

// ---------------------------------------------------------------------------
// Fix round 2.5. Everything below is the consumer's semantics, not the object's
// shape: what a reducer returns, what survives into a question map, what a lint
// message is entitled to claim.
// ---------------------------------------------------------------------------

/** Every recorded fixture, loaded once. The corpus is the only evidence in this repo, so a
 * lint message that quotes a number has to quote one of these. */
const corpus = loadFixtures('fixtures')
const answer = (fixtureId: string, questionId: string) => {
  const f = corpus.find(x => x.id === fixtureId)
  if (!f) throw new Error(`no fixture ${fixtureId}`)
  const a = f.measured.answers[questionId]
  if (!a) throw new Error(`no answer ${fixtureId}.${questionId}`)
  return a
}
/** The message a rule produces, for a program built to trip exactly that rule. */
const messageFor = (code: string, p: Program) => {
  const hit = lintProgram(p).find(i => i.code === code)
  if (!hit) throw new Error(`lintProgram produced no ${code} for this program`)
  return hit.message
}

describe('validateProgram — a rule that states no condition', () => {
  const alwaysFirst = (when: unknown): Program => ({
    decisions: [{ id: 'is_destructive', kind: 'noul', instructions: 'Does the command delete data?' }],
    reduce: { kind: 'rules', rules: [
      { when, then: 'allow' },
      { when: [{ id: 'is_destructive', op: 'gte', value: 0.8 }], then: 'deny' },
    ], otherwise: 'review' } as unknown as Program['reduce'],
    residual: '', dropped: [],
  })

  it('refuses `when: []`, which matches every input and masks every rule after it', () => {
    // The consumer's semantics, stated: `[].every(...)` is true, so runReducer answers
    // "allow" for is_destructive 0.99 — the input the SECOND rule exists to deny — and
    // `otherwise` is unreachable. Verified against the shipped runtime before this gate
    // existed. Refusing is the only outcome that does not ship that program.
    const issues = validateProgram(alwaysFirst([]))
    expect(issues.map(i => `${i.code} ${i.path}`)).toEqual(['rule_always_matches reduce.rules[0]'])
    expect(issues[0].severity).toBe('error')
    expect(issues[0].message).toContain('otherwise')
  })

  it('refuses a rule with no `when` at all, which is the same defect and throws at runtime', () => {
    const issues = validateProgram(alwaysFirst(undefined))
    expect(issues.map(i => i.code)).toEqual(['rule_always_matches'])
  })

  it('uses the code emit/capability.ts already uses, so the gate and the targets agree', () => {
    // capability.ts:137 refuses `when: []` for both policy targets with `rule_always_matches`.
    // Two codes for one defect is how `jevc compile` came to accept a program that
    // `jevc emit-policy` then refused.
    expect(validateProgram(alwaysFirst([]))[0].code).toBe('rule_always_matches')
  })

  it('leaves a rule that states a condition alone', () => {
    expect(validateProgram(prog())).toEqual([])
  })
})

describe('validateProgram — ids that a plain object already has', () => {
  /** The mechanism, with no emitter in the loop: this is what every question map does. */
  it('demonstrates why: assigning __proto__ on a plain map creates no key', () => {
    const questions: Record<string, unknown> = {}
    questions['__proto__'] = { type: 'noul' }
    questions['ok'] = { type: 'noul' }
    expect(Object.keys(questions)).toEqual(['ok'])      // the question is gone, not refused
    // and the inherited-lookup half, which is how `constructor` silently answers:
    expect(typeof ({} as Record<string, unknown>)['constructor']).toBe('function')
  })

  const withId = (id: string): Program => ({
    decisions: [{ id, kind: 'noul', instructions: 'Is it bad?' },
      { id: 'ok', kind: 'noul', instructions: 'Fine?' }],
    reduce: { kind: 'rules', rules: [{ when: [{ id, op: 'gte', value: 0.8 }], then: 'deny' }],
      otherwise: 'allow' },
    residual: '', dropped: [],
  })

  it('refuses __proto__ as a decision id', () => {
    const issues = validateProgram(withId('__proto__'))
    expect(issues.map(i => `${i.code} ${i.path}`)).toEqual(['reserved_id decisions.__proto__'])
    expect(issues[0].severity).toBe('error')
  })

  it('refuses constructor, prototype and the rest of Object.prototype', () => {
    for (const id of ['constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(validateProgram(withId(id)).map(i => i.code), id).toEqual(['reserved_id'])
    }
  })

  it('refuses __proto__ as a choice option key, where the same map swallows the option', () => {
    const p = prog()
    // Built with JSON.parse, not an object literal: `{ __proto__: 'payments' }` written in
    // source is the prototype-setter SYNTAX and produces no own key at all, which is the
    // same defect one layer up and the reason this criteria object has to arrive as data.
    // fromJsonSchema builds it with Object.fromEntries off a JSON enum, so it does.
    p.decisions.push({ id: 'department', kind: 'choice', instructions: 'Which team?',
      criteria: JSON.parse('{"__proto__":"payments","technical":"bugs","sales":"pricing"}') })
    const issues = validateProgram(p)
    expect(issues.map(i => `${i.code} ${i.path}`)).toEqual(['reserved_option decisions.department.criteria'])
  })

  it('is reachable from a JSON Schema, which is why the gate needs it', async () => {
    // `__proto__` is a legal JSON object key and from-schema uses the property name as the id.
    const { fromJsonSchema } = await import('../src/from-schema.js')
    const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"boolean","description":"Is it bad?"},"ok":{"type":"boolean","description":"Fine?"}}}')
    const program = fromJsonSchema(schema)
    expect(program.decisions.map(d => d.id)).toContain('__proto__')
    expect(validateProgram(program).map(i => i.code)).toContain('reserved_id')
  })

  it('leaves ordinary ids and option names alone', () => {
    expect(validateProgram(withId('is_destructive_2'))).toEqual([])
    expect(validateProgram(prog())).toEqual([])
  })
})

// The rule is right and stays. Its DIAGNOSIS was a mechanism that does not occur: round 3
// made every emitter define an own key (emit/json.ts's Object.fromEntries, native/ai-sdk's
// computed `idKey`), so the option is not lost and `is` matches it. A message that names a
// mechanism a reader can check and find absent is how a correct rule gets deleted by the next
// person. The tests below measure both halves and hold the message to the measurement.
const RESERVED = [...Object.getOwnPropertyNames(Object.prototype), 'prototype']

describe('validateProgram — reserved_option diagnoses the read that actually breaks', () => {
  const choiceOn = (opt: string): Program => {
    const p = prog()
    // As data, never an object literal: `{__proto__: v}` in source is the prototype setter.
    p.decisions.push({ id: 'department', kind: 'choice', instructions: 'Which team owns this?',
      criteria: JSON.parse(`{${JSON.stringify(opt)}:"payments","technical":"bugs"}`) })
    p.reduce.rules.push({ when: [{ id: 'department', op: 'is', value: opt }], then: 'deny' })
    return p
  }
  const messageOn = (opt: string) => {
    const hit = validateProgram(choiceOn(opt)).find(i => i.code === 'reserved_option')
    if (!hit) throw new Error(`validateProgram produced no reserved_option for "${opt}"`)
    return hit.message
  }

  it('still refuses every one of them — only the diagnosis changes', () => {
    for (const opt of RESERVED) {
      expect(validateProgram(choiceOn(opt)).map(i => i.code), opt).toContain('reserved_option')
    }
  })

  it('measures the refuted half: the option survives the wire and `is` matches it', async () => {
    const { emitJson } = await import('../src/emit/json.js')
    const { runReducer } = await import('../src/runtime.js')
    for (const opt of RESERVED) {
      const p = choiceOn(opt)
      // Through JSON.stringify/parse, which is what the wire actually does to this map.
      const wire = JSON.parse(JSON.stringify(emitJson(p, { tool: 'Bash' })))
      expect(Object.getOwnPropertyNames(wire.questions.department.criteria), opt).toContain(opt)
      expect(wire.questions.department.criteria[opt], opt).toBe('payments')
      const answers = JSON.parse(JSON.stringify({
        is_destructive: { type: 'noul', noul: 0.1 },
        department: { type: 'choice', choice: opt, probabilities: { [opt]: 0.9 }, confidence: 0.9 },
      }))
      expect(runReducer(p, answers), opt).toBe('deny')
    }
  })

  it('measures the real half: prob_lte on a reserved name asserts nothing and reports health', async () => {
    const { assertExpectation } = await import('../src/check.js')
    const answers = JSON.parse(JSON.stringify({
      department: { type: 'choice', choice: 'technical', probabilities: { technical: 1 }, confidence: 0.9 },
    }))
    // "constructor" is absent from this probability map. The lookup returns Object.prototype's
    // own member instead of undefined, the `p > max` comparison against a function is false,
    // and a bound that compared nothing is reported as held.
    expect(assertExpectation({ department: { prob_lte: { constructor: 0.01 } } }, answers)).toEqual([])
    // The identical clause on an ordinary absent name is correctly a failure.
    expect(assertExpectation({ department: { prob_lte: { engineering: 0.01 } } }, answers))
      .toEqual(['department: no probability recorded for "engineering"'])
    // 12 of the 13 names in the set do this; `prototype` is not an Object.prototype member and
    // is in the set for the code emitters, which write option names into generated source.
    const silent = RESERVED.filter(opt =>
      assertExpectation({ department: { prob_lte: { [opt]: 0.01 } } }, answers).length === 0)
    expect(silent).toHaveLength(12)
    expect(RESERVED.filter(o => !silent.includes(o))).toEqual(['prototype'])
  })

  it('does not claim the option is lost, or that `is` cannot match it', () => {
    for (const opt of RESERVED) {
      const m = messageOn(opt)
      expect(m, opt).not.toMatch(/silently lost/)
      expect(m, opt).not.toMatch(/can never match/)
    }
  })

  it('names the read that does break, concretely enough to check', () => {
    const m = messageOn('constructor')
    expect(m).toContain('prob_lte')
    expect(m).toContain('check.ts')
    expect(m).toContain('Rename it.')
  })
})

// R1 put this whitelist on `validateRequest` only. The wire path runs that; the two paths
// that WRITE A FILE somebody deploys — `jevc emit-policy`, and any library caller that emits
// without asking — run `validateProgram` and nothing else. A typo'd outcome key is accepted
// by the API, ignored by it, and dropped by every emitter, so the description the author
// wrote never reaches the model and nothing says so.
describe('validateProgram — a noul criteria key that is neither true nor false', () => {
  const withCriteria = (criteria: unknown): Program => {
    const p = prog()
    p.decisions.push({ id: 'is_protected', kind: 'noul',
      instructions: 'Does this touch a protected path?', criteria: criteria as never })
    return p
  }
  const typo = { treu: 'the command deletes data the user cannot regenerate', false: 'it is reversible' }

  it('refuses it on the program path, where the artifact is produced', () => {
    const issues = validateProgram(withCriteria(typo))
    expect(issues.map(i => `${i.code} ${i.path}`))
      .toEqual(['unknown_field decisions.is_protected.criteria.treu'])
    expect(issues[0].severity).toBe('error')
  })

  it('is what emit-policy silently discards: the author\'s `true` side never reaches the model', async () => {
    const { emitBouncerPolicy } = await import('../src/emit/policy/bouncer.js')
    // bouncer takes nouls only, so this is the whole program rather than prog() plus one.
    const yaml = emitBouncerPolicy({
      decisions: [{ id: 'is_protected', kind: 'noul',
        instructions: 'Does this touch a protected path?', criteria: typo as never }],
      reduce: { kind: 'rules', rules: [{ when: [{ id: 'is_protected', op: 'gte', value: 0.8 }], then: 'deny' }],
        otherwise: 'allow' },
      residual: '', dropped: [],
    })
    expect(yaml).toContain('it is reversible')                                // the `false` side ships
    expect(yaml).not.toContain('the command deletes data the user cannot regenerate')
  })

  it('agrees with validateRequest, which already refused the same key on the wire', async () => {
    const { validateRequest } = await import('../src/contract.js')
    const { emitJson } = await import('../src/emit/json.js')
    const onWire = validateRequest(emitJson(withCriteria(typo), { tool: 'Bash' }))
      .filter(i => i.code === 'unknown_field')
    expect(onWire.map(i => i.path)).toEqual(['questions.is_protected.criteria.treu'])
    // Same code, same severity, same prose — one whitelist, read from two places.
    const inProgram = validateProgram(withCriteria(typo)).filter(i => i.code === 'unknown_field')
    expect(inProgram[0].severity).toBe(onWire[0].severity)
    expect(inProgram[0].message).toBe(onWire[0].message)
  })

  it('accepts true, false, both, and an omitted or empty criteria', () => {
    for (const c of [{ true: 'yes' }, { false: 'no' }, { true: 'yes', false: 'no' }, {}, undefined]) {
      expect(validateProgram(withCriteria(c)).map(i => i.code), JSON.stringify(c) ?? 'undefined').toEqual([])
    }
  })

  it('does not double-report on an array, which criteria_shape already owns', () => {
    expect(validateProgram(withCriteria(['yes', 'no'])).map(i => i.code)).toEqual(['criteria_shape'])
  })

  it('costs the corpus nothing: 244 nouls, and every key is true or false', () => {
    const keys = new Set<string>()
    let nouls = 0
    for (const f of corpus) {
      for (const q of Object.values(f.questions)) {
        if (q.type !== 'noul') continue
        nouls++
        for (const k of Object.keys(q.criteria ?? {})) keys.add(k)
      }
    }
    expect(nouls).toBe(244)
    expect([...keys].sort()).toEqual(['false', 'true'])
  })
})

describe('lintProgram — the collapsed verdict is not a choice-only defect', () => {
  it('refuses a collapsed verdict asked as a noul', () => {
    const p = prog()
    p.decisions.push({ id: 'gate', kind: 'noul',
      instructions: 'Decide whether to block this tool call.' })
    const issues = lintProgram(p).filter(i => i.code === 'collapsed_verdict')
    expect(issues.map(i => i.path)).toEqual(['decisions.gate'])
    expect(issues[0].severity).toBe('error')
  })

  it('refuses a collapsed verdict asked as a score', () => {
    const p = prog()
    p.decisions.push({ id: 'severity', kind: 'score',
      instructions: 'What action should the harness take on this call?',
      criteria: ['allow it', 'log it', 'ask the user', 'block it'] })
    const issues = lintProgram(p).filter(i => i.code === 'collapsed_verdict')
    expect(issues.map(i => i.path)).toEqual(['decisions.severity'])
  })

  it('still names the options when there are options to name', () => {
    const p = prog()
    p.decisions.push({ id: 'decision', kind: 'choice', instructions: 'What should the harness do?',
      criteria: { allow: 'safe', deny: 'block it' } })
    expect(messageFor('collapsed_verdict', p)).toContain('(allow/deny)')
  })

  // The measurement the widening was gated on. If this number moves, the corpus changed
  // and the rule has to be re-argued rather than quietly kept.
  it('newly refuses nothing in the 58-fixture corpus: every firing is still a choice', () => {
    const fired: string[] = []
    for (const f of corpus) {
      // The same pass-through buildProgram performs, inlined so this measurement does not
      // depend on check.ts: object-form instructions reach lintProgram unconverted.
      const program: Program = {
        decisions: Object.entries(f.questions).map(([id, q]) => ({
          id, kind: q.type, instructions: q.instructions as never,
          criteria: 'criteria' in q ? (q.criteria as never) : undefined,
        })),
        reduce: { kind: 'rules', rules: [], otherwise: 'n/a' }, residual: '', dropped: [],
      }
      const kindOf = new Map(program.decisions.map(d => [d.id, d.kind]))
      for (const i of lintProgram(program)) {
        if (i.code !== 'collapsed_verdict') continue
        fired.push(`${f.id}.${i.path}:${kindOf.get(i.path.replace('decisions.', ''))}`)
      }
    }
    expect(fired).toHaveLength(27)
    expect(fired.filter(x => !x.endsWith(':choice'))).toEqual([])
  })
})

describe('lintProgram — advisory code must never throw', () => {
  // `Decision.instructions` is typed `string` and is not one at runtime: the wire contract
  // allows the structured form, check.ts's buildProgram passes it through with `as never`,
  // and 10 decisions across 2 of this repo's own 58 fixtures use it.
  const objectForm = (instructions: unknown): Program => {
    const p = prog()
    p.decisions.push({ id: 'claim_1', kind: 'noul', instructions: instructions as never })
    return p
  }

  it('reads an object-form instruction instead of throwing a TypeError on it', () => {
    expect(() => lintProgram(objectForm({ claim: 'Revenue rose', main_question: 'Is it entailed?' })))
      .not.toThrow()
  })

  it('survives every fixture in the corpus, which used to throw on 2 of 60', () => {
    let threw = 0
    for (const f of corpus) {
      const program: Program = {
        decisions: Object.entries(f.questions).map(([id, q]) => ({
          id, kind: q.type, instructions: q.instructions as never,
          criteria: 'criteria' in q ? (q.criteria as never) : undefined,
        })),
        reduce: { kind: 'rules', rules: [], otherwise: 'n/a' }, residual: '', dropped: [],
      }
      try { lintProgram(program) } catch { threw++ }
    }
    expect(threw).toBe(0)
  })

  it('still applies the wording rules to the prose inside an object-form instruction', () => {
    // Guarding by skipping would be the same silent pass this round exists to close: the
    // model reads the whole object, so the whole object is the wording.
    const carveout = objectForm({ context: 'a commit', main_question: 'Does this commit, unless the user asked?' })
    expect(lintProgram(carveout).map(i => i.code)).toContain('embedded_carveout')
    const verdict = objectForm({ main_question: 'What should the harness do with this tool result?' })
    expect(lintProgram(verdict).map(i => i.code)).toContain('collapsed_verdict')
  })

  it('reads the values, not the keys — an "action" key is not a verdict framing', () => {
    expect(lintProgram(objectForm({ action: 'git push --force', main_question: 'Is this a force push?' }))).toEqual([])
  })

  it('does not throw on instructions that are null or a number', () => {
    expect(() => lintProgram(objectForm(null))).not.toThrow()
    expect(() => lintProgram(objectForm(42))).not.toThrow()
  })
})

describe('lintProgram — a score whose levels describe nothing', () => {
  const score = (criteria: unknown[]): Program => {
    const p = prog()
    p.decisions.push({ id: 'severity', kind: 'score', instructions: 'How severe is it?',
      criteria: criteria as never })
    return p
  }
  const codes = (criteria: unknown[]) => lintProgram(score(criteria)).map(i => i.code)

  it('warns on the placeholder labels from-schema generates for a bounded integer', () => {
    // fromJsonSchema lowers `{"type":"integer","minimum":0,"maximum":2}` to these. They are
    // non-empty strings, so contract.ts's `score_level_undescribed` never sees them, and
    // from-schema dropped its own note in round 2 — nothing in the toolchain said a word.
    expect(codes(['severity = 0', 'severity = 1', 'severity = 2'])).toContain('score_levels_undescribed')
  })

  it('warns on a blank or null level', () => {
    expect(codes(['nothing lost', '', 'everything lost'])).toContain('score_levels_undescribed')
    expect(codes(['nothing lost', null, 'everything lost'])).toContain('score_levels_undescribed')
  })

  it('does not warn on levels that actually describe the levels', () => {
    expect(codes(['single file', 'one directory', 'whole repo'])).not.toContain('score_levels_undescribed')
    // Numbers inside real prose are fine — it is sameness-after-stripping that signals a placeholder.
    expect(codes(['fewer than 10 rows', 'fewer than 100 rows', 'the whole table']))
      .not.toContain('score_levels_undescribed')
  })

  it('is a warn, so a program with one still compiles', () => {
    const issue = lintProgram(score(['severity = 0', 'severity = 1'])).find(i => i.code === 'score_levels_undescribed')
    expect(issue?.severity).toBe('warn')
    expect(issue?.path).toBe('decisions.severity.criteria')
  })

  it('fires on the whole path from a JSON Schema, which is where it actually happens', async () => {
    const { fromJsonSchema } = await import('../src/from-schema.js')
    const program = fromJsonSchema({ type: 'object', properties: {
      frustration: { type: 'integer', minimum: 0, maximum: 2, description: 'How frustrated is the customer?' } } })
    expect(lintProgram(program).map(i => i.code)).toContain('score_levels_undescribed')
  })

  it('leaves the corpus clean: 0 of its 25 recorded scores are placeholders', () => {
    // The measurement the predicate was chosen on. A rule that fires on real level prose is
    // a rule nobody will read, and this is what says it does not.
    const scores = corpus.flatMap(f => Object.entries(f.questions)
      .flatMap(([id, q]) => q.type === 'score' ? [[f.id, id, q.criteria] as const] : []))
    expect(scores).toHaveLength(25)
    const fired = scores.filter(([, , criteria]) =>
      codes(criteria as unknown[]).includes('score_levels_undescribed'))
    expect(fired.map(([fid, id]) => `${fid}.${id}`)).toEqual([])
  })

  // It fires on 100% of the scores this tool's own primary path produces, and half its remedy
  // ("describe each level") is a field a schema author cannot set. A warning that is true,
  // permanent and unactionable is one users learn to scroll past, which costs the times it
  // matters. The rule stays and the firing stays — what changes is that the remedy names a
  // step the reader can actually take, and these tests execute those steps.
  describe('its remedy is reachable from where it fires', () => {
    const fromSchema = async (properties: Record<string, unknown>) => {
      const { fromJsonSchema } = await import('../src/from-schema.js')
      return fromJsonSchema({ type: 'object', properties } as never)
    }
    const m = () => messageFor('score_levels_undescribed', score(['severity = 0', 'severity = 1']))

    it('fires on every score fromJsonSchema can produce — the bounded integer is its only score branch', async () => {
      const program = await fromSchema({
        blast: { type: 'integer', minimum: 0, maximum: 2, description: 'How wide is the impact?' },
        severity: { type: 'integer', minimum: 0, maximum: 4 },
      })
      const scores = program.decisions.filter(d => d.kind === 'score')
      expect(scores.flatMap(d => d.criteria as string[])).toEqual([
        'blast = 0', 'blast = 1', 'blast = 2',
        'severity = 0', 'severity = 1', 'severity = 2', 'severity = 3', 'severity = 4',
      ])
      expect(lintProgram(program).filter(i => i.code === 'score_levels_undescribed').map(i => i.path))
        .toEqual(['decisions.blast.criteria', 'decisions.severity.criteria'])
      expect(program.dropped).toEqual([])      // nothing else in the toolchain mentions it either
    })

    it('does not send a schema author to a keyword that does not exist', () => {
      // `description` on the integer is the FIELD's prose and becomes `instructions`; there is
      // no per-level text anywhere on that branch, so "describe each level" is unreachable here.
      expect(m()).not.toMatch(/Describe each level/)
    })

    it('names the oneOf-of-described-consts route, and that route clears the warning', async () => {
      expect(m()).toContain('oneOf')
      expect(m()).toContain('const')
      const described = await fromSchema({ blast: { oneOf: [
        { const: 0, description: 'one file' },
        { const: 1, description: 'one directory' },
        { const: 2, description: 'the whole repo' },
      ] } })
      expect(lintProgram(described).map(i => i.code)).toEqual([])
      expect(described.decisions[0].criteria)
        .toEqual({ 0: 'one file', 1: 'one directory', 2: 'the whole repo' })
      // And it is honest about the cost: the levels come back as a choice, which the reducer
      // matches with `is`, not with the gte/lte thresholds a score takes.
      expect(described.decisions[0].kind).toBe('choice')
      expect(m()).toContain('`is`')
    })

    it('names the noul-per-level route, and that route clears the warning too', async () => {
      expect(m()).toContain('noul')
      const perLevel = await fromSchema({
        blast: { type: 'array', items: { enum: ['one_file', 'one_directory', 'whole_repo'] } },
      })
      expect(perLevel.decisions.map(d => `${d.id}:${d.kind}`))
        .toEqual(['blast.one_file:noul', 'blast.one_directory:noul', 'blast.whole_repo:noul'])
      expect(lintProgram(perLevel).map(i => i.code)).toEqual([])
    })
  })
})

// This is the assertion the 58-fixture corpus leaves out. `jevc check` replays the fixtures
// and reports "stable", but the numbers lint's messages quote are, for the two most-cited of
// them, in no `expect` clause at all — so "58 fixtures stable" never covered them. A lint
// message is the most-read prose in this codebase; a number in it that no recording backs is
// the exact failure this project exists to stop shipping.
describe('lint prose — every measurement a message cites is recorded in fixtures/', () => {
  const noul = (fixtureId: string, questionId: string) => {
    const a = answer(fixtureId, questionId)
    if (a.type !== 'noul') throw new Error(`${questionId} is a ${a.type}`)
    return a.noul
  }
  const choice = (fixtureId: string, questionId: string) => {
    const a = answer(fixtureId, questionId)
    if (a.type !== 'choice') throw new Error(`${questionId} is a ${a.type}`)
    return a
  }

  it('collapsed_verdict — the one call it names', () => {
    const p = prog()
    p.decisions.push({ id: 'decision', kind: 'choice', instructions: 'What should the harness do?',
      criteria: { allow: 'safe', deny: 'block it' } })
    const m = messageFor('collapsed_verdict', p)
    expect(m).toContain('bash-rm-rf-node-modules-benign')

    const verdict = choice('bash-rm-rf-node-modules-benign', 'decision')
    expect(verdict.probabilities).toMatchObject({ allow: 0.42, block: 0.35, ask: 0.23 })
    expect(verdict.confidence).toBe(0.13)
    for (const n of ['0.42', '0.35', '0.23', '0.13']) expect(m, n).toContain(n)

    // The narrow heads in the SAME call — a noul probability and a score's probability mass,
    // named as the different quantities they are rather than quoted as one "0.93-0.97" range.
    expect(noul('bash-rm-rf-node-modules-benign', 'only_regenerable_artifacts')).toBe(0.93)
    const blast = answer('bash-rm-rf-node-modules-benign', 'blast_radius')
    if (blast.type !== 'score') throw new Error('blast_radius is not a score')
    expect(blast.probabilities['1']).toBe(0.98)
    expect(m).toContain('only_regenerable_artifacts 0.93')
    expect(m).toContain('0.98 on level 1')
  })

  it('collapsed_verdict — the corpus refutes the population claim the message used to make', () => {
    // "collapsed verdict questions return near-uniform distributions" is a claim about the
    // population, and this corpus is the population. It is false here: the heads this rule
    // fires on have a median confidence of 0.86 and 28 of 29 answered correctly. The rule
    // survives on a different measurement — that the head's confidence carries no signal —
    // and the message now says that instead.
    const fired: number[] = []
    for (const f of corpus) {
      const program: Program = {
        decisions: Object.entries(f.questions).map(([id, q]) => ({
          id, kind: q.type, instructions: q.instructions as never,
          criteria: 'criteria' in q ? (q.criteria as never) : undefined,
        })),
        reduce: { kind: 'rules', rules: [], otherwise: 'n/a' }, residual: '', dropped: [],
      }
      for (const i of lintProgram(program)) {
        if (i.code !== 'collapsed_verdict') continue
        const a = f.measured.answers[i.path.replace('decisions.', '')]
        if (a && a.type !== 'noul') fired.push(a.confidence)
      }
    }
    fired.sort((a, b) => a - b)
    const median = fired.length % 2
      ? fired[(fired.length - 1) / 2]
      : (fired[fired.length / 2 - 1] + fired[fired.length / 2]) / 2

    expect(fired).toHaveLength(27)
    expect(median).toBe(0.86)                 // not near-uniform, and not close to it
    expect(fired.filter(c => c < 0.3)).toHaveLength(1)

    // What IS true, and what the message is now allowed to say.
    expect(fired[0]).toBe(0.13)
    expect(fired[fired.length - 1]).toBe(1)
    const p = prog()
    p.decisions.push({ id: 'decision', kind: 'choice', instructions: 'What should the harness do?',
      criteria: { allow: 'safe', deny: 'block it' } })
    const m = messageFor('collapsed_verdict', p)
    expect(m).toContain(`${fired.length} verdict-shaped heads`)
    expect(m).toContain('0.13 to 1.00')
    expect(m).not.toMatch(/near-uniform/)
  })

  it('compound_question — the 0.59 and the single-scope control', () => {
    const p = prog()
    p.decisions.push({ id: 'authorized', kind: 'noul',
      instructions: 'Did the user authorize this action, or did it go materially further than asked?' })
    const m = messageFor('compound_question', p)
    expect(noul('bash-compound-rm-rf-escapes-repo', 'user_authorized_this_action')).toBe(0.59)
    expect(noul('git-reset-clean-force-push-protected-main', 'user_authorized_history_rewrite')).toBe(0.22)
    expect(m).toContain('bash-compound-rm-rf-escapes-repo')
    expect(m).toContain('0.59')
    expect(m).toContain('user_authorized_history_rewrite answered 0.22')
  })

  it('embedded_carveout — cites carve-out heads, not the glob-evasion numbers', () => {
    const p = prog()
    p.decisions.push({ id: 'is_protected_delete', kind: 'noul',
      instructions: 'Does this delete a file, except anything under test/fixtures/?' })
    const m = messageFor('embedded_carveout', p)

    // The numbers this message used to carry belong to a different rule entirely: they
    // measure deny-PATTERNS missing evasive spellings and say nothing about carve-outs.
    for (const wrong of ['0.25/0.10/0.14', '0.96/0.87/0.85']) expect(m).not.toContain(wrong)

    const commit = choice('commit-only-when-explicitly-asked', 'decision')
    expect(commit.confidence).toBe(0.64)
    expect(commit.probabilities.allow).toBe(0.18)
    expect(noul('commit-only-when-explicitly-asked', 'user_explicitly_asked_to_commit')).toBe(0.06)

    // This message cited a second fixture until that fixture was removed from the corpus
    // for licensing reasons. A message may only quote what the shipped fixtures record, so
    // the citation shrank with the evidence rather than outliving it.
    expect(m).not.toContain('vendored-edit-authorization-ambiguous')
    expect(corpus.some(f => f.id === 'vendored-edit-authorization-ambiguous')).toBe(false)

    for (const n of ['0.18', '0.64', '0.06']) expect(m, n).toContain(n)
    expect(m).toContain('commit-only-when-explicitly-asked')
  })

  it('embedded_pattern — the six numbers it is entitled to, each from a named head', () => {
    const p = prog()
    p.decisions.push({ id: 'matches_deny_glob', kind: 'noul',
      instructions: 'Does the changed path match *.env or *.key?' })
    const m = messageFor('embedded_pattern', p)
    const cited: Array<[string, string, number]> = [
      ['no-push-to-main-any-spelling', 'matched_by_declared_deny_pattern', 0.25],
      ['never-create-a-pr-even-when-asked', 'matched_by_declared_deny_pattern', 0.1],
      ['never-hand-edit-generated-file', 'path_matches_declared_generated_globs', 0.14],
      ['no-push-to-main-any-spelling', 'pushes_commits_to_a_remote', 0.96],
      ['never-create-a-pr-even-when-asked', 'creates_pull_request', 0.87],
      ['never-hand-edit-generated-file', 'file_is_machine_generated', 0.85],
    ]
    for (const [fixtureId, questionId, value] of cited) {
      expect(noul(fixtureId, questionId), `${fixtureId}.${questionId}`).toBe(value)
      expect(m, fixtureId).toContain(fixtureId)
    }
    // The pattern heads are named; the semantic counterparts are identified by the call
    // they came from, which is enough for a reader to find all six.
    for (const id of ['matched_by_declared_deny_pattern', 'path_matches_declared_generated_globs']) {
      expect(m, id).toContain(id)
    }
    for (const n of ['0.25', '0.10', '0.14', '0.96', '0.87', '0.85']) expect(m, n).toContain(n)
  })

  it('dependent_questions — a probability and a confidence are different numbers', () => {
    const p = prog()
    p.decisions.push({ id: 'should_deny', kind: 'noul',
      instructions: 'Should this be denied?', dependsOn: ['rule_conflict'] })
    const m = messageFor('dependent_questions', p)
    const conflict = choice('self-contradicting-rule-file-host-vs-container', 'rule_conflict')
    const decision = choice('self-contradicting-rule-file-host-vs-container', 'decision')
    expect(conflict.choice).toBe('documented_exception_wins')
    expect(conflict.probabilities.documented_exception_wins).toBe(0.52)
    expect(decision.probabilities.deny).toBe(0.82)
    expect(m).toContain('documented_exception_wins at probability 0.52')
    expect(m).toContain('deny at probability 0.82')
  })
})
