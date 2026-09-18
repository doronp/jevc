import { describe, it, expect } from 'vitest'
import { fromJsonSchema } from '../src/from-schema.js'

describe('fromJsonSchema — advanced', () => {
  it('lowers a bounded integer to a score with one level per value', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      severity: { type: 'integer', minimum: 1, maximum: 3, description: 'How severe?' } } })
    expect(p.decisions[0].kind).toBe('score')
    expect(p.decisions[0].criteria).toHaveLength(3)
  })

  it('warns that generated score levels are undescribed', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      severity: { type: 'integer', minimum: 1, maximum: 3 } } })
    expect(p.dropped.some(d => /undescribed/.test(d.reason))).toBe(true)
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
  })
})
