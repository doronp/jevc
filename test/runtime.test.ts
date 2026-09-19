import { describe, it, expect } from 'vitest'
import { value, isUncertain, runReducer, choiceOf, evaluate, askModel } from '../src/runtime.js'
import type { Condition, Program } from '../src/ir.js'
import type { JevAnswer } from '../src/contract.js'
import { validateRequest } from '../src/contract.js'
import { emitJson } from '../src/emit/json.js'
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

// A client that never touches the network. `throws` is the shape used to prove a gate fired
// BEFORE the paid call: if the request ever goes out, the test sees "reached the network"
// instead of the refusal it asserted.
const serves = (res: unknown) => ({ systemOne: async () => res }) as unknown as TypeSafeClient
const neverCalled = () => ({
  systemOne: async () => { throw new Error('reached the network') },
}) as unknown as TypeSafeClient
const usage = { input_tokens: 10, output_tokens: 5 }
const tick = () => { let t = 1000; return () => (t += 7) }

// F18 — the CRITICAL half. ir.ts's validateProgram now refuses `condition_op_unknown`, which
// covers every path that runs the validator; this is the belt for `runReducer`'s own callers
// (emit/native.ts inlines the same comparison, and runReducer is exported).
describe('runReducer — an op outside the vocabulary', () => {
  it('refuses an unknown op by name instead of executing it as lte', () => {
    const unknownOp: Program = {
      ...p,
      reduce: {
        kind: 'rules',
        rules: [{ when: [{ id: 'destructive', op: 'gt', value: 0.5 } as unknown as Condition], then: 'deny' }],
        otherwise: 'allow',
      },
    }
    // The author wrote "deny when destructive > 0.5" and the answer is 0.95. The old tail was
    // `c.op === 'gte' ? >= : <=`, so `gt` ran as `0.95 <= 0.5` — false, the deny rule never
    // fired, and the caller got 'allow' at exit 0. Refusal is the only safe default here.
    expect(() => runReducer(unknownOp, answers()))
      .toThrow(/Condition op "gt" on "destructive" is not one of gte, lte, is, uncertain/)
  })

  it('still executes every op that IS in the vocabulary', () => {
    // Guards the fix against over-reach: gte/is/uncertain are exercised by the suite above,
    // and lte is the branch the unknown op used to be absorbed into, so it is pinned here.
    const lteRule: Program = {
      ...p,
      reduce: {
        kind: 'rules',
        rules: [{ when: [{ id: 'destructive', op: 'lte', value: 0.5 }], then: 'allow' }],
        otherwise: 'deny',
      },
    }
    expect(runReducer(lteRule, answers({ destructive: { type: 'noul', noul: 0.2 } }))).toBe('allow')
    expect(runReducer(lteRule, answers())).toBe('deny')
  })
})

// F19 — validateProgram was called from cli.ts and parseLiftResponse and nowhere else, so
// importing jevc as a library skipped it entirely.
describe('evaluate — validateProgram on the library path', () => {
  const dup: Program = {
    decisions: [
      { id: 'dup', kind: 'noul', instructions: 'Does the command delete files?' },
      { id: 'dup', kind: 'noul', instructions: 'Is the user an admin?' },
    ],
    reduce: {
      kind: 'rules',
      rules: [{ when: [{ id: 'dup', op: 'gte', value: 0.8 }], then: 'block' }],
      otherwise: 'allow',
    },
    residual: '', dropped: [],
  }

  it('duplicate ids collapse in the question map before validateRequest can see them', () => {
    // The measurement behind the fix, pinned so the reasoning cannot rot: emitJson's
    // Object.fromEntries keeps the LAST definition, so two decisions ship as one question and
    // the wire validator finds nothing wrong. "Does the command delete files?" was replaced by
    // "Is the user an admin?", and the verdict was computed from the admin answer while the
    // program reads as though it came from the delete answer.
    const req = emitJson(dup, 'rm -rf /')
    expect(Object.keys(req.questions)).toEqual(['dup'])
    expect(req.questions.dup.instructions).toBe('Is the user an admin?')
    expect(validateRequest(req).filter(i => i.severity === 'error')).toEqual([])
  })

  it('refuses the same program, before spending a call', async () => {
    await expect(evaluate(dup, 'rm -rf /', { client: neverCalled() }))
      .rejects.toThrow(/Invalid program:[\s\S]*Duplicate decision id "dup"/)
  })

  it('reaches the wire limits from the library path, reported against the decision', async () => {
    // validateRequest also catches a 1-option choice, but only `--emit=json` ever ran it, and
    // its message names the emitted question. Running validateProgram first means the
    // overlapping codes are reported once, by the validator that can name the decision.
    const oneOption: Program = {
      decisions: [{ id: 'dept', kind: 'choice', instructions: 'Which team?', criteria: { billing: null } }],
      reduce: { kind: 'rules', rules: [], otherwise: 'ask' },
      residual: '', dropped: [],
    }
    await expect(evaluate(oneOption, 'a support ticket', { client: neverCalled() }))
      .rejects.toThrow(/Invalid program:[\s\S]*Choice "dept" has 1 option\(s\)/)
  })

  it('still evaluates a valid program unchanged', async () => {
    const r = await evaluate(p, 'rm -rf /tmp/build', { client: serves({ model: 'jev-1.13.0', answers: answers(), usage }), now: tick() })
    expect(r.verdict).toBe('deny')
  })
})

// F20 — the response crossed the same trust boundary as the request and was taken with a bare
// `as Record<string, JevAnswer>`.
describe('evaluate — validateResponse on the response', () => {
  it('names a response that answered a different question than the one asked', async () => {
    // Before: isUncertain reached `Decision "destructive" needs belowConfidence`, which reads
    // as a defect in the program's own uncertainty declaration and sends the reader to edit a
    // file that is not at fault. The program is fine; the response is not.
    const wrongKind = {
      ...answers(),
      destructive: { type: 'choice', choice: 'yes', probabilities: { yes: 1 }, confidence: 0.9 },
    }
    await expect(evaluate(p, 'rm -rf /', { client: serves({ model: 'jev-1.13.0', answers: wrongKind, usage }) }))
      .rejects.toThrow(/"destructive" was asked as a noul but answered as "choice"/)
  })

  it('names a null answers object instead of dying as a bare TypeError after a paid call', async () => {
    await expect(evaluate(p, 'rm -rf /', { client: serves({ model: 'jev-1.13.0', answers: null, usage }) }))
      .rejects.toThrow(/Response carries no answers object \(got null\)/)
  })

  it('refuses a noul answered outside 0..1, which reads as certain at both ends', async () => {
    const outOfRange = { ...answers(), destructive: { type: 'noul', noul: 95 } }
    await expect(evaluate(p, 'rm -rf /', { client: serves({ model: 'jev-1.13.0', answers: outOfRange, usage }) }))
      .rejects.toThrow(/Noul 95 is outside 0\.\.1/)
  })

  it('does not reject over a warn — an unasked extra answer cannot move a verdict', async () => {
    const extra = { ...answers(), ghost: { type: 'noul', noul: 0.5 } }
    const r = await evaluate(p, 'rm -rf /', { client: serves({ model: 'jev-1.13.0', answers: extra, usage }), now: tick() })
    expect(r.verdict).toBe('deny')
  })
})

// F21 — the throw in `value`/`isUncertain` was what made checkLive die and diffFixture's
// missing-answer branch unreachable. The contract: the reducer still refuses (there is no safe
// verdict to compute from evidence that never arrived), and `askModel` is the path that
// reports instead of throwing. See the `noAnswer` comment in src/runtime.ts.
describe('askModel — a missing answer is reportable, not fatal', () => {
  const partial = { destructive: answers().destructive }   // radius and target never came back
  const dropped = () => serves({ model: 'jev-1.13.0', answers: partial, usage })

  it('hands back the incomplete answer set, with every missing id named', async () => {
    const r = await askModel(p, 'rm -rf /', { client: dropped(), now: tick() })
    expect(r.issues.filter(i => i.severity === 'error').map(i => i.path))
      .toEqual(['answers.radius', 'answers.target'])
    // The whole point: the caller still gets what came back, so check.ts's diffFixture can
    // classify the two absent ids as `broken` rather than never running.
    expect(Object.keys(r.answers)).toEqual(['destructive'])
    expect(r.model).toBe('jev-1.13.0')
    expect(r.latencyMs).toBe(7)
  })

  it('evaluate refuses the same response, naming all of them at once', async () => {
    // Not just "it throws" — it throws ONCE with the whole list. The old path died inside
    // value() on the first missing id and never mentioned the second.
    await expect(evaluate(p, 'rm -rf /', { client: dropped() }))
      .rejects.toThrow(/answers\.radius[\s\S]*answers\.target/)
  })

  it('the reducer itself still refuses, and says where to go instead', () => {
    expect(() => runReducer(p, partial as Record<string, JevAnswer>))
      .toThrow(/No answer for decision "radius"\. Use askModel\(\)/)
  })

  it('reports a clean response with no issues at all', async () => {
    const r = await askModel(p, 'rm -rf /', { client: serves({ model: 'jev-1.13.0', answers: answers(), usage }), now: tick() })
    expect(r.issues).toEqual([])
  })
})

// Reviewed alongside F18-F21: `redactErrorBody` deep-clones with
// JSON.parse(JSON.stringify(body)), and it is called from inside a catch block.
describe('evaluate — a body that cannot be redacted', () => {
  it('withholds the body rather than destroying the error', async () => {
    // A body the SDK can construct an error from (`message` short-circuits its JSON.stringify)
    // but redactErrorBody cannot clone. Before: the TypeError from JSON.stringify escaped the
    // catch block and REPLACED the APIError — status, requestId and class identity all lost,
    // so a caller matching on `instanceof BadRequestError` saw a JSON error instead.
    const circular: Record<string, unknown> = { message: 'bad request' }
    circular.self = circular
    const thrown = new BadRequestError(400, circular, new Headers({ 'x-typesafe-request-id': 'req-2' }))

    const client = { systemOne: async () => { throw thrown } } as unknown as TypeSafeClient
    let caught: unknown
    try {
      await evaluate(p, 'some state', { client })
      throw new Error('expected evaluate to reject')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(BadRequestError)
    const err = caught as BadRequestError
    expect(err.status).toBe(400)
    expect(err.requestId).toBe('req-2')
    expect(err.body).toBe('[unredactable]')
    expect(err.message).toBe('400 request failed (body redacted)')
  })
})
