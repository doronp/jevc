import { describe, it, expect } from 'vitest'
import { fromJsonSchema, type JsonSchema } from '../src/from-schema.js'
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

  // The ids differ; the text the model sees did not. Two sibling scopes with the same
  // leaf name compiled to byte-identical questions, so the batch asked one question twice
  // and neither the model nor a reader of the answers could tell which was which.
  it('scopes every generated question by its dotted id, not by the leaf name', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      inbound: { type: 'object', properties: {
        risk: { type: 'boolean' },
        tier: { type: 'string', enum: ['low', 'high'] },
        severity: { type: 'integer', minimum: 0, maximum: 2 } } },
      outbound: { type: 'object', properties: {
        risk: { type: 'boolean' },
        tier: { type: 'string', enum: ['low', 'high'] },
        severity: { type: 'integer', minimum: 0, maximum: 2 } } },
    } })

    expect(p.decisions).toHaveLength(6)
    // Every question the model is sent is distinguishable from every other one, and each
    // one names the scope it belongs to.
    expect(new Set(p.decisions.map(d => d.instructions)).size).toBe(6)
    for (const d of p.decisions) expect(d.instructions).toContain(d.id)
    // Score LEVELS are text the model reads too, and they carried the same erased scope.
    const levels = p.decisions.filter(d => d.kind === 'score').flatMap(d => d.criteria as string[])
    expect(new Set(levels).size).toBe(levels.length)
  })

  // `multipleOf` punches holes in the range, and a score's levels are the contiguous
  // indices 0..n-1: the old lowering offered levels 1 and 3 of a multipleOf-2 field, so a
  // rule gating on one validated clean and fired on a value the schema forbids.
  it('refuses a bounded integer whose legal values have gaps', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      weight: { type: 'integer', minimum: 0, maximum: 4, multipleOf: 2 } } })
    expect(p.decisions).toHaveLength(0)
    expect(p.dropped[0].reason).toMatch(/multipleOf 2/)

    // ...and a rule written against it can no longer be certified as in range.
    const intended: Program = { ...p, reduce: { kind: 'rules', otherwise: 'allow',
      rules: [{ when: [{ id: 'weight', op: 'gte', value: 3 }], then: 'block' }] } }
    expect(validateProgram(intended).map(i => i.code)).toContain('reduce_unknown_id')
  })

  // The draft-6+ exclusive bounds are a second spelling of the same contiguous range.
  // Ignored, `exclusiveMaximum: 5` emitted a sixth level for a value the schema excludes,
  // and `gte 5` against it validated clean and gated on that forbidden level.
  it('honours exclusiveMaximum instead of offering a level the schema excludes', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      severity: { type: 'integer', minimum: 0, maximum: 5, exclusiveMaximum: 5 } } })
    expect(p.decisions[0].criteria).toHaveLength(5)     // 0..4, not 0..5

    const overshoot: Program = { ...p, reduce: { kind: 'rules', otherwise: 'allow',
      rules: [{ when: [{ id: 'severity', op: 'gte', value: 5 }], then: 'block' }] } }
    expect(validateProgram(overshoot).map(i => i.code)).toContain('score_threshold_out_of_range')

    const gate: Program = { ...p, reduce: { kind: 'rules', otherwise: 'allow',
      rules: [{ when: [{ id: 'severity', op: 'gte', value: 4 }], then: 'block' }] } }
    expect(validateProgram(gate)).toEqual([])
    expect(runReducer(gate, atLevel('severity', 4))).toBe('block')
    expect(runReducer(gate, atLevel('severity', 3))).toBe('allow')
  })

  // The draft-04 boolean spelling means "the bound is exclusive". Read as "not a number,
  // ignore it", the excluded value was offered as a level anyway.
  it('refuses the draft-04 boolean exclusiveMinimum rather than silently ignoring it', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      severity: { type: 'integer', minimum: 0, maximum: 4, exclusiveMinimum: true } } })
    expect(p.decisions).toHaveLength(0)
    expect(p.dropped[0].reason).toMatch(/exclusiveMinimum/)
  })

  // One noul per label records no cardinality at all, so a `maxItems: 1` single-select
  // shipped as a multi-select in which every label could come back true at once — and
  // nothing in the Program, the validator or the reducer could arbitrate it back to one.
  it('refuses an array of enum whose cardinality a per-label noul cannot hold', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      tag: { type: 'array', minItems: 1, maxItems: 1, uniqueItems: true,
        items: { type: 'string', enum: ['spam', 'abuse', 'billing'] } } } })
    expect(p.decisions).toHaveLength(0)
    expect(p.dropped[0].reason).toMatch(/minItems 1 and maxItems 1/)
  })

  // ...but `uniqueItems` alone asks for exactly what one-noul-per-label already gives,
  // and an unbounded multi-select is the shape this lowering is for. Neither is refused.
  it('still lowers an unbounded array of enum, uniqueItems included', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      tags: { type: 'array', uniqueItems: true, maxItems: 3,
        items: { type: 'string', enum: ['spam', 'abuse', 'billing'] } } } })
    expect(p.decisions.map(d => d.id)).toEqual(['tags.spam', 'tags.abuse', 'tags.billing'])
    expect(p.dropped).toEqual([])
  })

  // A root with no literal `properties` used to return decisions:[], dropped:[],
  // residual:'' — a Program that is indistinguishable from the affirmative claim "this
  // schema needs no decisions", for three shapes that are entirely ordinary.
  it('never compiles a rootless schema to a silently empty Program', () => {
    const rootless: JsonSchema[] = [
      { $ref: '#/$defs/Ticket' },
      { type: 'string', enum: ['billing', 'sales'] },
      { type: 'array', items: { type: 'string', enum: ['spam', 'abuse'] } },
      {},
    ]
    for (const schema of rootless) {
      const p = fromJsonSchema(schema)
      expect(p.decisions, JSON.stringify(schema)).toHaveLength(0)
      // The one thing a caller can act on: nothing compiled, and the Program says so.
      expect(p.dropped.length, JSON.stringify(schema)).toBeGreaterThan(0)
      expect(p.residual, JSON.stringify(schema)).toBe('')
    }
    expect(fromJsonSchema({ $ref: '#/$defs/Ticket' }).dropped[0].reason).toMatch(/\$ref/)
  })

  // An `allOf` root still carries properties, so it is NOT the empty case.
  it('leaves a composed root that does carry properties untouched', () => {
    const p = fromJsonSchema({ allOf: [
      { type: 'object', properties: { urgent: { type: 'boolean' } } }] })
    expect(p.decisions.map(d => d.id)).toEqual(['urgent'])
    expect(p.dropped).toEqual([])
  })

  // Dotted ids are concatenated, so a property literally named "a.b" and a nested
  // `a: { b: … }` produce the same id. The questions map is a JSON object: one of the two
  // questions is silently deleted, and a reducer condition on "a.b" cannot say which of
  // them it meant. Neither survives.
  it('refuses a dotted id that two different properties both claim', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      'a.b': { type: 'boolean', description: 'The flat one.' },
      a: { type: 'object', properties: { b: { type: 'boolean', description: 'The nested one.' } } },
    } })

    expect(p.decisions.map(d => d.id)).toEqual([])
    expect(p.dropped[0].reason).toMatch(/"a\.b" is defined 2 times/)

    // A rule that named the ambiguous id is now an unknown reference rather than a
    // condition that quietly binds to whichever question survived the map.
    const intended: Program = { ...p, reduce: { kind: 'rules', otherwise: 'allow',
      rules: [{ when: [{ id: 'a.b', op: 'gte', value: 0.8 }], then: 'block' }] } }
    expect(validateProgram(intended).map(i => i.code)).toEqual(['reduce_unknown_id'])
  })

  it('refuses the same collision when an array label is the other claimant', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      'tags.spam': { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string', enum: ['spam', 'abuse'] } },
    } })
    expect(p.decisions.map(d => d.id)).toEqual(['tags.abuse'])
    expect(p.dropped[0].quote).toBe('tags.spam')
  })
})
