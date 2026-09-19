import { describe, it, expect } from 'vitest'
import { fromJsonSchema } from '../src/from-schema.js'
import { validateProgram, type Program } from '../src/ir.js'
import { runReducer } from '../src/runtime.js'
import type { JevAnswer } from '../src/contract.js'

/** A score answer at a given level index; only `score` matters to the reducer. */
const atLevel = (id: string, score: number): Record<string, JevAnswer> =>
  ({ [id]: { type: 'score', score, legend: {}, probabilities: {}, confidence: 0.9 } })

describe('fromJsonSchema — advanced', () => {
  it('lowers a bounded integer to a score with one level per value', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      severity: { type: 'integer', minimum: 0, maximum: 2, description: 'How severe?' } } })
    expect(p.decisions[0].kind).toBe('score')
    expect(p.decisions[0].criteria).toEqual(['severity = 0', 'severity = 1', 'severity = 2'])
  })

  // The schema's numbers and the answer's numbers are two different spaces, and a 1-based
  // range is where they silently disagree. Measured on the old lowering: `severity gte 4`
  // against levels labelled "severity = 1".."severity = 5" validated clean, then ALLOWED
  // level-index 3 — the level labelled "severity = 4". End to end on the verdict, because
  // a test that pinned the label strings is what let this through the first time.
  it('refuses a 1-based integer range rather than emitting a gate that fires a level late', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      severity: { type: 'integer', minimum: 1, maximum: 5, description: 'How severe?' } } })

    expect(p.decisions).toHaveLength(0)
    expect(p.dropped[0].reason).toMatch(/level index 0\.\.4/)

    // ...and the rule an author would have written against it is now a loud validation
    // error rather than a verdict that is wrong by a whole level at exit 0.
    const intended: Program = { ...p, reduce: { kind: 'rules', otherwise: 'allow',
      rules: [{ when: [{ id: 'severity', op: 'gte', value: 4 }], then: 'block' }] } }
    expect(validateProgram(intended).map(i => i.code)).toContain('reduce_unknown_id')
  })

  it('gates at exactly the level the author wrote once the range is re-based to 0', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      severity: { type: 'integer', minimum: 0, maximum: 4, description: 'How severe?' } } })
    const program: Program = { ...p, reduce: { kind: 'rules', otherwise: 'allow',
      rules: [{ when: [{ id: 'severity', op: 'gte', value: 4 }], then: 'block' }] } }

    expect(validateProgram(program)).toEqual([])
    expect(runReducer(program, atLevel('severity', 4))).toBe('block')
    expect(runReducer(program, atLevel('severity', 3))).toBe('allow')
  })

  it('does NOT treat a continuous number range as a score', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Model confidence in the extraction' } } })
    expect(p.decisions).toHaveLength(0)
    expect(p.dropped[0].reason).toMatch(/no discrete-level equivalent/)
  })

  // `dropped` is read as "what did not compile" — by `jevc compile`'s stderr and by
  // anything downstream of it — so a question that is right there in `decisions` must
  // never appear in it, whatever else is true about that question.
  it('never lists a decision it kept in dropped', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      severity: { type: 'integer', minimum: 0, maximum: 2 } } })
    const kept = new Set(p.decisions.map(d => d.id))
    expect([...kept]).toEqual(['severity'])
    expect(p.dropped.filter(d => kept.has(d.quote))).toEqual([])
  })

  it('drops an integer range wider than 10 levels', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      score: { type: 'integer', minimum: 0, maximum: 100 } } })
    expect(p.decisions).toHaveLength(0)
    expect(p.dropped[0].reason).toMatch(/at most 10/)
  })

  it('lowers a multi-label enum array to one noul per label', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      tags: { type: 'array', items: { type: 'string', enum: ['spam', 'abuse', 'billing'] },
        description: 'Which labels apply?' } } })
    expect(p.decisions.map(d => d.id)).toEqual(['tags.spam', 'tags.abuse', 'tags.billing'])
    expect(p.decisions.every(d => d.kind === 'noul')).toBe(true)
  })

  it('flattens nested objects with dotted ids', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      ticket: { type: 'object', properties: {
        urgent: { type: 'boolean', description: 'Is it urgent?' } } } } })
    expect(p.decisions[0].id).toBe('ticket.urgent')
  })

  it('routes a free string to the residual, not to an error', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      summary: { type: 'string', description: 'Write a one-line summary.' } } })
    expect(p.decisions).toHaveLength(0)
    expect(p.residual).toMatch(/summary/)
    expect(p.residual).toMatch(/Write a one-line summary/)
  })

  it('routes an array of objects to the residual', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      items: { type: 'array', items: { type: 'object', properties: { n: { type: 'string' } } } } } })
    expect(p.residual).toMatch(/items/)
  })

  it('silently drops a const, which encodes no decision', () => {
    const p = fromJsonSchema({ type: 'object', properties: { version: { const: 1 } } })
    expect(p.decisions).toHaveLength(0)
    expect(p.residual).toBe('')
    expect(p.dropped).toHaveLength(0)
  })

  // Composition keywords are not decisions, but they are where the properties live: an
  // untraversed one loses every question under it with no decision, no residual and no
  // `dropped` entry — the only failure mode here that leaves no trace at all.
  it('merges allOf members at the root', () => {
    const p = fromJsonSchema({ allOf: [
      { type: 'object', properties: { urgent: { type: 'boolean', description: 'Is it urgent?' } } },
      { type: 'object', properties: { dept: { type: 'string', enum: ['billing', 'sales'] } } },
    ] })
    expect(p.decisions.map(d => `${d.id}:${d.kind}`)).toEqual(['urgent:noul', 'dept:choice'])
  })

  it('merges allOf inside a property, keeping the dotted id', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      ticket: { allOf: [{ type: 'object', properties: { urgent: { type: 'boolean' } } }] } } })
    expect(p.decisions.map(d => d.id)).toEqual(['ticket.urgent'])
  })

  it('lowers the Pydantic Optional spelling, anyOf [X, null], as X', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      urgent: { anyOf: [{ type: 'boolean' }, { type: 'null' }], description: 'Is it urgent?' } } })
    expect(p.decisions).toEqual([{ id: 'urgent', kind: 'noul', instructions: 'Is it urgent?' }])
  })

  it('does NOT collapse a genuine two-branch union, which names no single decision', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      payload: { anyOf: [{ type: 'boolean' }, { type: 'string' }] } } })
    expect(p.decisions).toHaveLength(0)
    expect(p.dropped[0].reason).toMatch(/no System One equivalent/)
  })
})
