import { describe, it, expect } from 'vitest'
import { emitAiSdk } from '../src/emit/ai-sdk.js'
import { emitLangchain } from '../src/emit/langchain.js'
import type { Program } from '../src/ir.js'

const p: Program = {
  decisions: [
    { id: 'is_urgent', kind: 'noul', instructions: 'Urgent?',
      criteria: { true: 'time pressure stated', false: 'no time pressure' } },
    { id: 'dept', kind: 'choice', instructions: 'Which team?',
      criteria: { billing: 'payments', technical: 'bugs' } },
    { id: 'frustration', kind: 'score', instructions: 'How frustrated?',
      criteria: ['calm', 'annoyed', 'furious'] },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'is_urgent', op: 'gte', value: 0.8 }], then: 'escalate' }], otherwise: 'queue' },
  residual: '', dropped: [],
}

describe('emitAiSdk', () => {
  it("renames noul to the spec's boolean type", () => {
    const src = emitAiSdk(p)
    expect(src).toMatch(/type: 'boolean'/)
    expect(src).not.toMatch(/type: 'noul'/)
  })
  it('reads the answer from .probability, not .noul', () => {
    expect(emitAiSdk(p)).toMatch(/\.probability/)
  })
  it('keeps the score legend locally, since the target drops it', () => {
    const src = emitAiSdk(p)
    expect(src).toMatch(/LEGEND/)
    expect(src).toMatch(/"0": "calm"/)
  })
  it('recomputes confidence from probabilities rather than defaulting to zero', () => {
    const src = emitAiSdk(p)
    expect(src).toMatch(/providerMetadata/)
    expect(src).toMatch(/confidenceFrom/)
    expect(src).not.toMatch(/confidence \?\? 0/)
  })
  it('uses createTypeSafeAi rather than the singleton', () => {
    expect(emitAiSdk(p)).toMatch(/createTypeSafeAi/)
    expect(emitAiSdk(p)).not.toMatch(/^import \{ typeSafeAi \}/m)
  })
  it('never asserts that probabilities sum to 1 — values are rounded to 2dp', () => {
    expect(emitAiSdk(p)).not.toMatch(/=== 1/)
  })

  // EntryType is `string | object | array | null`; String() on the object form renders
  // "[object Object]" silently. Fourth site of the same bug across this codebase.
  it('renders object-form criteria as JSON, not [object Object]', () => {
    const obj: Program = { ...p, decisions: [
      { id: 'weird', kind: 'score', instructions: 'How?',
        criteria: [{ label: 'low' }, { label: 'high' }] }] }
    const src = emitAiSdk(obj)
    expect(src).not.toContain('[object Object]')
    expect(src).toContain('{"label":"low"}')
  })

  it('escapes a newline in instructions instead of breaking the string literal', () => {
    const nl: Program = { ...p, decisions: [
      { id: 'multi', kind: 'noul', instructions: 'line one\nline two' }] }
    expect(emitAiSdk(nl)).toContain('"line one\\nline two"')
  })
})

describe('emitLangchain', () => {
  it('emits Python question constructors', () => {
    const src = emitLangchain(p)
    expect(src).toMatch(/Noul\(/)
    expect(src).toMatch(/Choice\(/)
    expect(src).toMatch(/Score\(/)
  })
  it('keeps the noul name, which this target preserves', () => {
    expect(emitLangchain(p)).not.toMatch(/boolean/)
  })
  it('emits NoulCriteria explicitly, because the library default is dead code', () => {
    expect(emitLangchain(p)).toMatch(/NoulCriteria\(/)
  })
  it('emits a TypeSafeClassifier with only documented fields', () => {
    const src = emitLangchain(p)
    expect(src).toMatch(/TypeSafeClassifier\(/)
    expect(src).not.toMatch(/api_key=/)   // comes from env; extra="forbid"
  })
  it('emits the reducer as Python reading flat answers', () => {
    const src = emitLangchain(p)
    expect(src).toMatch(/def reduce/)
    expect(src).toMatch(/return "escalate"/)
  })

  // JSON is not Python: true/false/null are syntax errors there.
  it('renders object-form criteria as Python literals, not JSON', () => {
    const obj: Program = { ...p, decisions: [
      { id: 'weird', kind: 'score', instructions: 'How?',
        criteria: [{ label: 'low', strict: true }, null] }] }
    const src = emitLangchain(obj)
    expect(src).not.toContain('[object Object]')
    expect(src).toContain('{"label": "low", "strict": True}')
    expect(src).toContain('None')
    expect(src).not.toMatch(/\btrue\b|\bnull\b/)
  })

  it('emits a missing noul criteria side as None rather than an empty string', () => {
    const half: Program = { ...p, decisions: [
      { id: 'x', kind: 'noul', instructions: 'Yes?', criteria: { true: 'it is' } }] }
    expect(emitLangchain(half)).toContain('NoulCriteria(true="it is", false=None)')
  })
})
