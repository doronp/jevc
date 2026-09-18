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
