import { describe, it, expect } from 'vitest'
import { fromJsonSchema } from '../src/from-schema.js'
import { validateProgram, type Program } from '../src/ir.js'
import { runReducer } from '../src/runtime.js'
import type { JevAnswer } from '../src/contract.js'

/** A choice answer that picked `option`; only `choice` matters to the reducer's `is`. */
const picked = (id: string, option: string): Record<string, JevAnswer> =>
  ({ [id]: { type: 'choice', choice: option, probabilities: {}, confidence: 0.9 } })

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

  // The option NAMES are the option set: they are the criteria keys the API sends, and
  // they are what `is` compares. `String()` rendered every object "[object Object]", so a
  // 3-option choice reached the model as 2 options and one branch of the reducer became
  // unreachable. End to end on the verdict, because a test on the criteria keys alone is
  // the shape of test that let the earlier `String()` collapses ship.
  it('keeps structurally distinct enum members reachable as distinct verdicts', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      route: { enum: ['direct', { via: 'cache' }, { via: 'queue' }],
        description: 'How should this be routed?' } } })

    const options = Object.keys(p.decisions[0].criteria as object)
    expect(options).toHaveLength(3)
    const program: Program = { ...p, reduce: { kind: 'rules', otherwise: 'review', rules: [
      { when: [{ id: 'route', op: 'is', value: options[0] }], then: 'allow' },
      { when: [{ id: 'route', op: 'is', value: options[1] }], then: 'warm' },
      { when: [{ id: 'route', op: 'is', value: options[2] }], then: 'defer' },
    ] } }

    expect(validateProgram(program)).toEqual([])
    expect(options.map(o => runReducer(program, picked('route', o)))).toEqual(['allow', 'warm', 'defer'])
  })

  // Two DIFFERENT values that render to one name are the same deletion by another route,
  // and no rendering avoids every case (1 vs "1", true vs "true"). Refuse the schema
  // rather than ship a choice with an option missing from it.
  it('refuses an enum whose members do not survive as distinct option names', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      code: { enum: [1, '1', 'other'] } } })
    expect(p.decisions).toHaveLength(0)
    expect(p.dropped[0].reason).toMatch(/both name the option "1"/)
  })

  // The collision guard above is a JSON.stringify comparison, and JSON.stringify renders
  // EVERY non-finite number as the same four characters, `null`. So the one collision the
  // guard's own comment promised it caught was the one it could not see: two distinct
  // members merged into a single option named "null", `dropped` empty, exit 0. Measured
  // before the fix: `enum: [NaN, Infinity, 'z']` -> criteria {null, z}, dropped [].
  // Unreachable from a JSON file (JSON has no NaN literal), so this is library callers —
  // a Program built from a Zod/Pydantic-derived schema object in the same process.
  it('refuses non-finite enum members instead of merging them into one "null" option', () => {
    for (const members of [[NaN, Infinity, 'z'], [Infinity, -Infinity, 'z'], [NaN, -Infinity, 'z']]) {
      const p = fromJsonSchema({ type: 'object', properties: { k: { enum: members } } })
      expect(p.decisions, JSON.stringify(members.map(String))).toHaveLength(0)
      expect(p.dropped[0].kind).toBe('collision')
      expect(p.dropped[0].reason).toMatch(/both name the option "null"/)
    }

    // Nested one level down, where `{"x":null}` is what both members stringify to. The
    // top-level fix has to be in the identity of the whole value, not a special case on
    // the member itself, or this still merges.
    const nested = fromJsonSchema({ type: 'object', properties: {
      k: { enum: [{ x: NaN }, { x: Infinity }, 'z'] } } })
    expect(nested.decisions).toHaveLength(0)
    expect(nested.dropped[0].kind).toBe('collision')

    // And a finite enum is untouched: this is a refusal of members that collapse, not a
    // new tax on numbers.
    const ok = fromJsonSchema({ type: 'object', properties: { k: { enum: [1, 2.5, 'z'] } } })
    expect(Object.keys(ok.decisions[0].criteria as object)).toEqual(['1', '2.5', 'z'])
  })

  // A const union member's `description` is the only text saying what the option MEANS;
  // dropping it left the model choosing between bare labels it was never told apart.
  it('carries each const union member description into its criteria', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      tier: { oneOf: [
        { const: 'fast', description: 'Cheap and small; acceptable when latency dominates.' },
        { const: 'frontier', description: 'Expensive; use when the answer must be right.' },
      ] } } })
    expect(p.decisions[0].criteria).toEqual({
      fast: 'Cheap and small; acceptable when latency dominates.',
      frontier: 'Expensive; use when the answer must be right.',
    })
  })

  // A `const` pins the value, so there is no decision left to make. Asked anyway, the
  // model may answer the opposite of what the schema already fixed, and the reducer will
  // act on that answer.
  it('asks no question about a property a const has already pinned', () => {
    const boolean = fromJsonSchema({ type: 'object', properties: {
      enabled: { type: 'boolean', const: true } } })
    expect(boolean.decisions).toEqual([])

    const enumerated = fromJsonSchema({ type: 'object', properties: {
      tier: { type: 'string', enum: ['fast', 'frontier'], const: 'fast' } } })
    expect(enumerated.decisions).toEqual([])

    const scored = fromJsonSchema({ type: 'object', properties: {
      severity: { type: 'integer', minimum: 0, maximum: 3, const: 2 } } })
    expect(scored.decisions).toEqual([])
  })
})
