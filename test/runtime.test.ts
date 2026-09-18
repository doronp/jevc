import { describe, it, expect } from 'vitest'
import { value, isUncertain, runReducer, choiceOf, evaluate } from '../src/runtime.js'
import type { Program } from '../src/ir.js'
import type { JevAnswer } from '../src/contract.js'
import type { TypeSafeClient } from '@typesafe-ai/sdk'

const p: Program = {
  decisions: [
    { id: 'destructive', kind: 'noul', instructions: 'Deletes data?' },
    { id: 'radius', kind: 'score', instructions: 'How wide?',
      criteria: ['one file', 'one dir', 'whole repo'] },
    { id: 'target', kind: 'choice', instructions: 'Target?',
      criteria: { source: null, build: null } },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'destructive', op: 'uncertain' }], then: 'ask' },
    { when: [{ id: 'destructive', op: 'gte', value: 0.8 },
             { id: 'radius', op: 'gte', value: 1.5 }], then: 'deny' },
    { when: [{ id: 'target', op: 'is', value: 'build' }], then: 'allow' },
  ], otherwise: 'ask' },
  residual: '', dropped: [],
}

const answers = (over: Partial<Record<string, JevAnswer>> = {}): Record<string, JevAnswer> => ({
  destructive: { type: 'noul', noul: 0.95 },
  radius: { type: 'score', score: 2.0, legend: { '0': 'one file', '1': 'one dir', '2': 'whole repo' },
    probabilities: { '0': 0, '1': 0, '2': 1 }, confidence: 0.97 },
  target: { type: 'choice', choice: 'source', probabilities: { source: 0.9, build: 0.1 }, confidence: 0.8 },
  ...over,
})

describe('value', () => {
  it('reads a noul probability', () => {
    expect(value(answers(), 'destructive')).toBe(0.95)
  })
  it('reads a score in level-index space, not 0..1', () => {
    expect(value(answers(), 'radius')).toBe(2.0)
  })
})

describe('isUncertain', () => {
  it('treats a noul inside the default band as uncertain', () => {
    expect(isUncertain(answers({ destructive: { type: 'noul', noul: 0.5 } }), 'destructive', p)).toBe(true)
  })
  it('treats a decisive noul as certain at either end', () => {
    expect(isUncertain(answers({ destructive: { type: 'noul', noul: 0.95 } }), 'destructive', p)).toBe(false)
    expect(isUncertain(answers({ destructive: { type: 'noul', noul: 0.05 } }), 'destructive', p)).toBe(false)
  })
  it('uses confidence for a choice, never a band', () => {
    const low = answers({ target: { type: 'choice', choice: 'source',
      probabilities: { source: 0.52, build: 0.48 }, confidence: 0.13 } })
    expect(isUncertain(low, 'target', p)).toBe(true)
  })
})

describe('runReducer', () => {
  it('returns the first matching rule, not the best one', () => {
    expect(runReducer(p, answers())).toBe('deny')
  })
  it('escalates to ask when the gating evidence is uncertain', () => {
    expect(runReducer(p, answers({ destructive: { type: 'noul', noul: 0.5 } }))).toBe('ask')
  })
  it('falls through to otherwise when nothing matches', () => {
    expect(runReducer(p, answers({
      destructive: { type: 'noul', noul: 0.05 },
      target: { type: 'choice', choice: 'source', probabilities: { source: 0.95, build: 0.05 }, confidence: 0.9 },
    }))).toBe('ask')
  })
  it('matches a choice option by name', () => {
    expect(runReducer(p, answers({
      destructive: { type: 'noul', noul: 0.05 },
      target: { type: 'choice', choice: 'build', probabilities: { source: 0.1, build: 0.9 }, confidence: 0.9 },
    }))).toBe('allow')
  })
})

// Amendment 1: Task 5's emitNative emits `choiceOf(a, "target") === "build"` for `is`
// conditions, so every generated file with an `is` rule needs this to exist and compile.
describe('choiceOf', () => {
  it('returns the choice field for a choice answer', () => {
    expect(choiceOf(answers(), 'target')).toBe('source')
  })
  it('returns undefined for a non-choice answer', () => {
    expect(choiceOf(answers(), 'destructive')).toBeUndefined()
  })
  it('does not throw on a missing answer', () => {
    expect(choiceOf({}, 'nope')).toBeUndefined()
  })
})

// Amendment 2: `evaluate()` needs no test that makes a real call, so this exercises it
// against a fake client (no network) to prove the reducer, uncertainty list, and the
// resolved `model` field (Task 7's checkLive reads this) all thread through correctly.
describe('evaluate', () => {
  it('resolves a verdict using a fake client, with no network call', async () => {
    const fakeClient = {
      systemOne: async () => ({
        model: 'jev-1.13.0',
        answers: answers(),
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    }
    const result = await evaluate(p, 'rm -rf /tmp/build', {
      client: fakeClient as unknown as TypeSafeClient,
      now: (() => { let t = 1000; return () => (t += 7) })(),
    })
    expect(result.verdict).toBe('deny')
    expect(result.model).toBe('jev-1.13.0')
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
    expect(result.uncertain).toEqual([])
    expect(result.latencyMs).toBe(7)
  })
})
