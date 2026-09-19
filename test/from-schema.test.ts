import { describe, it, expect } from 'vitest'
import { fromJsonSchema } from '../src/from-schema.js'

describe('fromJsonSchema — primitives', () => {
  it('lowers a boolean to a noul, carrying description into instructions', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      is_urgent: { type: 'boolean', description: 'Does the message convey urgency?' } } })
    expect(p.decisions).toEqual([
      { id: 'is_urgent', kind: 'noul', instructions: 'Does the message convey urgency?' },
    ])
    expect(p.residual).toBe('')
  })

  it('synthesises instructions when description is absent', () => {
    const p = fromJsonSchema({ type: 'object', properties: { is_spam: { type: 'boolean' } } })
    expect(p.decisions[0].instructions).toBe('Is is_spam true?')
  })

  it('lowers a string enum to a choice with null rubrics', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      department: { type: 'string', enum: ['billing', 'technical', 'sales'],
        description: 'Which team should handle this?' } } })
    expect(p.decisions[0]).toEqual({
      id: 'department', kind: 'choice', instructions: 'Which team should handle this?',
      criteria: { billing: null, technical: null, sales: null },
    })
  })

  it('lowers a oneOf of consts to a choice', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      tier: { oneOf: [{ const: 'fast' }, { const: 'frontier' }] } } })
    expect(p.decisions[0].kind).toBe('choice')
    expect(Object.keys(p.decisions[0].criteria as object)).toEqual(['fast', 'frontier'])
  })

  it('lowers a nullable oneOf of consts, the null branch being no option', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      tier: { oneOf: [{ const: 'fast' }, { const: 'frontier' }, { type: 'null' }] } } })
    expect(p.decisions[0].criteria).toEqual({ fast: null, frontier: null })
  })

  it('does NOT collapse a two-member enum to a noul by default', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      answer: { type: 'string', enum: ['yes', 'no'] } } })
    expect(p.decisions[0].kind).toBe('choice')
  })

  it('collapses a two-member yes/no enum when explicitly opted in', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      answer: { type: 'string', enum: ['yes', 'no'] } } }, { collapseBooleanEnums: true })
    expect(p.decisions[0].kind).toBe('noul')
  })

  it('rejects a single-member enum rather than emitting a degenerate choice', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      only: { type: 'string', enum: ['x'] } } })
    expect(p.decisions).toHaveLength(0)
    expect(p.dropped[0].reason).toMatch(/at least 2/)
  })

  // `["boolean","null"]` is how OpenAI strict `json_schema` mandates an optional field and
  // a plain draft-2020-12 idiom, and every dispatch in the mapper was a `===` compare
  // against a string — so the whole family missed its branch, not just booleans.
  it('lowers a list-form nullable type as its non-null member', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      is_urgent: { type: ['boolean', 'null'], description: 'Does the message convey urgency?' },
      severity: { type: ['integer', 'null'], minimum: 0, maximum: 2 },
      summary: { type: ['string', 'null'], description: 'Write a one-line summary.' },
      tags: { type: ['array', 'null'], items: { type: 'string', enum: ['spam', 'abuse'] } },
    } })
    expect(p.decisions.map(d => `${d.id}:${d.kind}`)).toEqual(
      ['is_urgent:noul', 'severity:score', 'tags.spam:noul', 'tags.abuse:noul'])
    expect(p.residual).toMatch(/summary/)
    expect(p.dropped).toEqual([])
  })

  it('reports the type the schema actually wrote when a list form has no single lowering', () => {
    const p = fromJsonSchema({ type: 'object', properties: { odd: { type: ['string', 'integer'] } } })
    expect(p.decisions).toHaveLength(0)
    expect(p.dropped[0].reason).toContain('string,integer')   // never a normalized rewrite
  })

  it('drops a null enum member instead of offering "null" as a choosable option', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      department: { type: ['string', 'null'], enum: ['billing', 'technical', null] } } })
    expect(p.decisions[0].criteria).toEqual({ billing: null, technical: null })
  })

  // The arity guard and the `Object.fromEntries` that builds criteria have to see the same
  // set, or the degenerate 1-option choice the guard exists to refuse gets emitted anyway.
  it('counts the options the choice will really have, after nulls and duplicates', () => {
    const nullable = fromJsonSchema({ type: 'object', properties: {
      flag: { type: ['string', 'null'], enum: ['on', null] } } })
    expect(nullable.decisions).toHaveLength(0)
    expect(nullable.dropped[0].reason).toMatch(/1 option\(s\)/)

    const dupes = fromJsonSchema({ type: 'object', properties: {
      flag: { type: 'string', enum: ['on', 'on'] } } })
    expect(dupes.decisions).toHaveLength(0)
    expect(dupes.dropped[0].reason).toMatch(/1 option\(s\)/)
  })
})
