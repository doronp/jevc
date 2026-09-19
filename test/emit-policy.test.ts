import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import { emitBouncerPolicy } from '../src/emit/policy/bouncer.js'
import { emitToolgatePolicy } from '../src/emit/policy/toolgate.js'
import type { Program } from '../src/ir.js'

const p: Program = {
  decisions: [
    { id: 'deletes_tracked_files', kind: 'noul',
      instructions: 'Does the command delete files tracked by git?',
      criteria: { true: 'deletes tracked source', false: 'touches only regenerable output' },
      source: { file: 'AGENTS.md', line: 7, quote: 'Never delete tracked files.' } },
    { id: 'outside_repo', kind: 'noul', instructions: 'Does it touch paths outside the repo root?' },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.8 }], then: 'deny' },
    { when: [{ id: 'outside_repo', op: 'gte', value: 0.6 }], then: 'ask' },
  ], otherwise: 'allow' },
  residual: '', dropped: [],
}

describe('emitBouncerPolicy', () => {
  const doc = () => parse(emitBouncerPolicy(p))

  it('emits version 1, which bouncer requires exactly', () => {
    expect(doc().version).toBe(1)
  })
  it('defaults to observe mode so a generated policy cannot block on day one', () => {
    expect(doc().mode).toBe('observe')
  })
  it('emits each decision under gate.questions with true/false criteria', () => {
    const q = doc().gate.questions
    expect(Object.keys(q)).toEqual(['deletes_tracked_files', 'outside_repo'])
    expect(q.deletes_tracked_files.criteria.true).toMatch(/tracked source/)
  })
  it('never emits a type key, since bouncer hardcodes noul', () => {
    expect(emitBouncerPolicy(p)).not.toMatch(/type:/)
  })
  it("emits rules in bouncer's p-comparison string grammar", () => {
    expect(doc().gate.rules[0]).toEqual({ when: { deletes_tracked_files: { p: '>=0.8' } }, then: 'deny' })
  })
  it('emits exactly one terminal default, last', () => {
    const rules = doc().gate.rules
    expect(rules.filter((r: any) => 'default' in r)).toHaveLength(1)
    expect(rules.at(-1)).toEqual({ default: 'allow' })
  })
  it('rejects a reserved question named "any"', () => {
    const bad: Program = { ...p, decisions: [{ id: 'any', kind: 'noul', instructions: 'x' }] }
    expect(() => emitBouncerPolicy(bad)).toThrow(/reserved/)
  })
  it('carries provenance through as a YAML comment', () => {
    expect(emitBouncerPolicy(p))
      .toMatch(/# deletes_tracked_files: AGENTS\.md:7 — Never delete tracked files\./)
  })

  it('refuses a conjunction rather than folding it into one question', () => {
    const conj: Program = { ...p, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.8 },
               { id: 'outside_repo', op: 'gte', value: 0.6 }], then: 'deny' }], otherwise: 'allow' } }
    expect(() => emitBouncerPolicy(conj)).toThrow(/one question per rule/)
  })
  // A policy that exists but fails to parse STOPS bouncer's policy resolution and routes
  // to on_error (default passthrough = emit nothing), so an unparseable verdict does not
  // degrade the gate, it disables it.
  it('refuses a verdict outside allow/ask/deny rather than emitting an unloadable policy', () => {
    const odd: Program = { ...p, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'outside_repo', op: 'gte', value: 0.8 }], then: 'quarantine' }], otherwise: 'allow' } }
    expect(() => emitBouncerPolicy(odd)).toThrow(/quarantine/)
  })
  it('refuses a score decision, which bouncer would send as a mangled noul', () => {
    const score: Program = { ...p, decisions: [
      { id: 'radius', kind: 'score', instructions: 'How wide?', criteria: ['file', 'repo'] }] }
    expect(() => emitBouncerPolicy(score)).toThrow(/noul/)
  })
  it('renders object-form criteria as JSON, since bouncer reads criteria as strings', () => {
    const obj: Program = { ...p, decisions: [
      { id: 'x', kind: 'noul', instructions: 'Yes?', criteria: { true: { note: 'yes' }, false: null } }] }
    const q = parse(emitBouncerPolicy(obj)).gate.questions.x
    expect(q.criteria.true).toBe('{"note":"yes"}')
    expect(q.criteria.false).toBe('')
  })
  it('keeps residual visible as a comment, the only place the schema leaves for it', () => {
    expect(emitBouncerPolicy({ ...p, residual: 'summary: write a summary.' }))
      .toMatch(/# summary: write a summary\./)
  })

  // Residual is prose lifted from a human document, so its line endings are the
  // document's, not ours. Asserted on the emitted LINES rather than through parse():
  // the `yaml` package both targets pin does not end a comment at a lone CR, but the
  // YAML spec says a CR is a line break and PyYAML and go-yaml implement it, so a file
  // whose "comment" is only a comment to one parser is not a comment.
  it('comments out every line of a CR-separated residual', () => {
    const out = emitBouncerPolicy({ ...p, residual: 'Judge the tone.\rmode: guard' })
    expect(out.split(/\r\n|\r|\n/).filter(l => l.includes('mode: guard')))
      .toEqual(['# mode: guard'])
  })
})

describe('emitToolgatePolicy', () => {
  // toolgate reduces by max-over-questions against two scalars, so an emittable program
  // needs one shared deny threshold and one shared ask threshold covering every question.
  // Written as a DISJUNCTION — one condition per rule, repeated per question — because
  // that is what max-over-questions means. A single rule naming both questions would be a
  // conjunction, which this target cannot express and canEmit now refuses.
  const flat: Program = {
    decisions: p.decisions,
    reduce: { kind: 'rules', rules: [
      { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.85 }], then: 'deny' },
      { when: [{ id: 'outside_repo', op: 'gte', value: 0.85 }], then: 'deny' },
      { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.55 }], then: 'ask' },
      { when: [{ id: 'outside_repo', op: 'gte', value: 0.55 }], then: 'ask' },
    ], otherwise: 'allow' },
    residual: '', dropped: [],
  }

  it('emits every question as type boolean, which its validator requires', () => {
    const doc = parse(emitToolgatePolicy(flat))
    expect(Object.values(doc.questions).every((q: any) => q.type === 'boolean')).toBe(true)
  })
  it('notes that built-ins cannot be removed, only shadowed', () => {
    expect(emitToolgatePolicy(flat)).toMatch(/built-in/i)
  })
  it('emits the two scalar thresholds toolgate actually reads', () => {
    expect(parse(emitToolgatePolicy(flat)).thresholds).toEqual({ deny: 0.85, ask: 0.55 })
  })
  it('re-emits criteria, because overriding a question is a replace not a deep merge', () => {
    expect(parse(emitToolgatePolicy(flat)).questions.deletes_tracked_files.criteria.true)
      .toMatch(/tracked source/)
  })

  // The plan's original emitter wrote a per-question threshold map. toolgate has no such
  // key: it would load the file, ignore the map, and silently run at its 0.85/0.55
  // defaults — a policy that parses cleanly and means something else.
  it('refuses per-question thresholds instead of emitting a map toolgate ignores', () => {
    expect(() => emitToolgatePolicy(p)).toThrow(/different thresholds|no ask rule|no deny rule/)
  })
  it('refuses a question left out of a threshold, since max-over-questions covers it anyway', () => {
    const partial: Program = { ...flat, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.85 }], then: 'deny' },
      { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.55 }], then: 'ask' },
      { when: [{ id: 'outside_repo', op: 'gte', value: 0.55 }], then: 'ask' },
    ], otherwise: 'allow' } }
    expect(() => emitToolgatePolicy(partial)).toThrow(/outside_repo/)
  })
  it('refuses a non-allow fallthrough', () => {
    expect(() => emitToolgatePolicy({ ...flat, reduce: { ...flat.reduce, otherwise: 'deny' } }))
      .toThrow(/fallthrough/)
  })

  // Same CR hazard as bouncer's, asserted the same way and for the same reason.
  it('comments out every line of a CR-separated residual', () => {
    const out = emitToolgatePolicy({ ...flat, residual: 'Judge the tone.\rthresholds: {deny: 0.99}' })
    expect(out.split(/\r\n|\r|\n/).filter(l => l.includes('thresholds: {deny')))
      .toEqual(['# thresholds: {deny: 0.99}'])
  })
  it('refuses the reserved off_task id, which toolgate drops without task context', () => {
    const bad: Program = { ...flat, decisions: [{ id: 'off_task', kind: 'noul', instructions: 'x' }] }
    expect(() => emitToolgatePolicy(bad)).toThrow(/off_task/)
  })
  it('points at TOOLGATE_POLICY rather than the global file, since there is no project discovery', () => {
    expect(emitToolgatePolicy(flat)).toMatch(/TOOLGATE_POLICY/)
  })
})
