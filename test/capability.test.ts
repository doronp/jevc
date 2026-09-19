import { describe, it, expect } from 'vitest'
import { canEmit, TARGETS } from '../src/emit/capability.js'
import type { Program } from '../src/ir.js'

const mixed: Program = {
  decisions: [
    { id: 'destructive', kind: 'noul', instructions: 'Deletes data?' },
    { id: 'radius', kind: 'score', instructions: 'How wide?', criteria: ['file', 'dir', 'repo'] },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'destructive', op: 'gte', value: 0.8 }], then: 'deny' }], otherwise: 'allow' },
  residual: '', dropped: [],
}

const nouls: Program = {
  decisions: [
    { id: 'destructive', kind: 'noul', instructions: 'Deletes data?' },
    { id: 'outside_repo', kind: 'noul', instructions: 'Touches paths outside the repo?' },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'destructive', op: 'gte', value: 0.8 }], then: 'deny' }], otherwise: 'allow' },
  residual: '', dropped: [],
}

describe('canEmit', () => {
  it('accepts a mixed-kind program on the native target', () => {
    expect(canEmit(mixed, 'sdk')).toEqual([])
  })

  it('rejects a score decision on bouncer, which is noul-only', () => {
    const issues = canEmit(mixed, 'bouncer')
    expect(issues[0].code).toBe('kind_unsupported')
    expect(issues[0].message).toMatch(/noul/)
  })

  it('rejects a score decision on toolgate, which is boolean-only', () => {
    expect(canEmit(mixed, 'toolgate')[0].code).toBe('kind_unsupported')
  })

  it('accepts an all-noul program on bouncer', () => {
    expect(canEmit(nouls, 'bouncer')).toEqual([])
  })

  it('rejects a multi-condition rule on bouncer, which allows one question per rule', () => {
    const multi: Program = { ...nouls, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'destructive', op: 'gte', value: 0.8 },
               { id: 'outside_repo', op: 'gte', value: 0.5 }], then: 'deny' }], otherwise: 'allow' } }
    expect(canEmit(multi, 'bouncer')[0].code).toBe('reducer_too_complex')
  })

  it('rejects a threshold outside 0..1 on bouncer, whose p grammar is bounded', () => {
    const p: Program = { ...mixed, decisions: [nouls.decisions[0], mixed.decisions[1]],
      reduce: { kind: 'rules', rules: [
        { when: [{ id: 'radius', op: 'gte', value: 1.5 }], then: 'deny' }], otherwise: 'allow' } }
    expect(canEmit(p, 'bouncer').some(i => i.code === 'threshold_out_of_target_range')).toBe(true)
  })

  // Amendment: the range check alone passes 1e-7 (it IS in 0..1) but bouncer's grammar is
  // `(>=|>|<=|<)\s*(\d*\.?\d+)` with no exponent, and JS renders 1e-7 exponentially — so the
  // emitted policy would be refused at load time with every test green. The real constraint
  // is on the serialised string, not the number.
  it('rejects an in-range threshold that serialises to exponential form', () => {
    const p: Program = { ...nouls, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'destructive', op: 'gte', value: 1e-7 }], then: 'deny' }], otherwise: 'allow' } }
    const issues = canEmit(p, 'bouncer')
    expect(issues.some(i => i.code === 'threshold_out_of_target_range')).toBe(false)
    expect(issues.some(i => i.code === 'threshold_unrepresentable')).toBe(true)
  })

  it('accepts the smallest threshold that still serialises as a plain decimal', () => {
    const p: Program = { ...nouls, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'destructive', op: 'gte', value: 0.000001 }], then: 'deny' }], otherwise: 'allow' } }
    expect(canEmit(p, 'bouncer')).toEqual([])
  })

  it('warns that ai-sdk drops the score legend', () => {
    const issues = canEmit(mixed, 'ai-sdk')
    expect(issues.every(i => i.severity === 'warn')).toBe(true)
    expect(issues.some(i => i.code === 'legend_dropped')).toBe(true)
  })

  it('warns when a confidence-based uncertainty rule targets ai-sdk', () => {
    const p: Program = { ...mixed }
    p.decisions[1] = { ...p.decisions[1], uncertain: { belowConfidence: 0.7 } }
    expect(canEmit(p, 'ai-sdk').some(i => i.code === 'confidence_derived')).toBe(true)
  })

  it('rejects an unknown target by name', () => {
    expect(canEmit(mixed, 'nope')[0].code).toBe('unknown_target')
  })

  it('declares every emit target the CLI and emitters can name', () => {
    expect(Object.keys(TARGETS).sort())
      .toEqual(['ai-sdk', 'bouncer', 'json', 'langchain', 'sdk', 'toolgate'])
  })
})
