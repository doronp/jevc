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
})
