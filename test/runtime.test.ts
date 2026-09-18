import { describe, it, expect } from 'vitest'
import { value, isUncertain, runReducer, choiceOf, evaluate } from '../src/runtime.js'
import type { Program } from '../src/ir.js'
import type { JevAnswer } from '../src/contract.js'
import type { TypeSafeClient } from '@typesafe-ai/sdk'
import { BadRequestError, APITimeoutError } from '@typesafe-ai/sdk'

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
  it('uses confidence for a score, same as choice', () => {
    const low = answers({ radius: { type: 'score', score: 2.0,
      legend: { '0': 'one file', '1': 'one dir', '2': 'whole repo' },
      probabilities: { '0': 0, '1': 0, '2': 1 }, confidence: 0.4 } })
    expect(isUncertain(low, 'radius', p)).toBe(true)
    expect(isUncertain(answers(), 'radius', p)).toBe(false) // default confidence 0.97
  })
  it('fails loudly on a noul answer paired with a decision that has no band', () => {
    // "target" is a choice decision, so uncertaintyOf gives it belowConfidence, not a band —
    // pairing it with a noul-shaped answer is malformed data the function must not silently accept.
    const mismatched: Record<string, JevAnswer> = { ...answers(), target: { type: 'noul', noul: 0.5 } }
    expect(() => isUncertain(mismatched, 'target', p)).toThrow(/is a noul but has no band/)
  })
  it('fails loudly on a non-noul answer paired with a noul decision', () => {
    // "destructive" is a noul decision, so uncertaintyOf always gives it a band, never
    // belowConfidence — pairing it with a choice-shaped answer must not be silently accepted.
    const mismatched: Record<string, JevAnswer> = { ...answers(),
      destructive: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 0.9 } }
    expect(() => isUncertain(mismatched, 'destructive', p)).toThrow(/needs belowConfidence/)
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
  it('prefers the earlier matching rule even when a later rule also matches', () => {
    // Defaults (destructive 0.95, radius 2.0) already satisfy rule 2's deny condition;
    // overriding only `target` to "build" makes rule 3's allow condition true too. First
    // match must win — this is the whole reason the reducer replaces the model's verdict.
    const bothMatch = answers({
      target: { type: 'choice', choice: 'build', probabilities: { source: 0.1, build: 0.9 }, confidence: 0.9 },
    })
    expect(runReducer(p, bothMatch)).toBe('deny')
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

  // Fix round 1, item 1: the SDK derives `APIError.message` (and Node then derives `.stack`
  // from it) from the *body* at throw time, inside the SDK's own constructor — before
  // evaluate()'s catch block ever runs. Mutating `.body` afterwards cannot retroactively
  // scrub an already-computed message. This body has no `error`/`message`/`detail` field the
  // SDK recognizes, so it falls back to JSON-stringifying the whole body into the message —
  // exactly the "body echoes state at top level" case that leaks today.
  it('never leaks state into the caught error message or stack', async () => {
    const secretState = 'super-secret-token-should-never-be-logged'
    const leakyBody = { context: { input: secretState } }
    const thrown = new BadRequestError(400, leakyBody, new Headers({ 'x-typesafe-request-id': 'req-1' }))
    // Prove the vulnerability is real and in the SDK, independent of jevc's fix.
    expect(thrown.message).toContain(secretState)

    const fakeClient = { systemOne: async () => { throw thrown } }
    let caught: unknown
    try {
      await evaluate(p, secretState, { client: fakeClient as unknown as TypeSafeClient })
      throw new Error('expected evaluate to reject')
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(BadRequestError)
    const err = caught as BadRequestError
    expect(err.message).not.toContain(secretState)
    expect(String(err.stack)).not.toContain(secretState)
    // The existing body redaction mechanism (strips `input` fields) still applies.
    expect(err.body).toEqual({ context: { input: '[redacted]' } })
    // Class identity and request id survive the rebuild.
    expect(err.status).toBe(400)
    expect(err.requestId).toBe('req-1')
  })

  it('propagates a connection/timeout error unmodified (no body to redact)', async () => {
    const thrown = new APITimeoutError(5_000)
    const fakeClient = { systemOne: async () => { throw thrown } }
    let caught: unknown
    try {
      await evaluate(p, 'some state', { client: fakeClient as unknown as TypeSafeClient })
      throw new Error('expected evaluate to reject')
    } catch (e) {
      caught = e
    }
    expect(caught).toBe(thrown)
  })
})
