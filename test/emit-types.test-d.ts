import { describe, it, expectTypeOf } from 'vitest'
import { score } from '@typesafe-ai/sdk'
import type { ScoreCriteria, ScoreOf } from '@typesafe-ai/sdk'

describe('tuple preservation', () => {
  it('keeps literal level indices when criteria is a tuple', () => {
    const tuple = ['low', 'mid', 'high'] as const
    expectTypeOf<ScoreOf<typeof tuple>>().toEqualTypeOf<'0' | '1' | '2'>()
  })

  it('degrades to number when criteria is widened — the bug we must not emit', () => {
    // `ScoreOf<T extends ScoreCriteria>` requires a minimum-2-length tuple, so a
    // bare `string[]` fails the generic constraint outright (TS2344) rather than
    // reaching the conditional type. `ScoreCriteria` itself is the SDK's own
    // non-literal tuple (fixed head, `number`-length via its rest element) — it
    // satisfies the constraint while still exercising the `number` branch, which
    // is what "widened, non-literal criteria" actually looks like to `ScoreOf`.
    const widened = ['low', 'mid', 'high'] as ScoreCriteria
    expectTypeOf<ScoreOf<typeof widened>>().toEqualTypeOf<number>()
  })

  it('emitted question objects keep their literal criteria type', () => {
    const q = score('How wide?', ['one file', 'one directory', 'whole repo'] as const)
    expectTypeOf(q.criteria).toEqualTypeOf<readonly ['one file', 'one directory', 'whole repo']>()
  })
})

describe('a computed `__proto__` key', () => {
  // native.ts emits `["__proto__"]: v`, because both `__proto__: v` and `"__proto__": v`
  // are the prototype SETTER in an object initializer and define no own property at all.
  // The computed form is the only ordinary one that does — and the claim worth pinning is
  // that it still narrows under `as const`, since a widened criteria type is exactly what
  // degrades ScoreOf to `number` two tests above.
  //
  // This one does NOT discriminate the fix: tsc --strict gives `{ __proto__: v } as const`
  // the same type, complete with a `__proto__` property the object provably does not have
  // at runtime (`Object.getOwnPropertyNames` returns `["billing"]`). The type system cannot
  // see this bug at all, which is why the check that catches it is the executed one in
  // test/emit-backends.test.ts. Kept as the lock on the form native.ts must keep emitting.
  it('is an ordinary own key under `as const`, and keeps its literal type', () => {
    const criteria = { ['__proto__']: 'the platform team', billing: 'payments' } as const
    expectTypeOf(criteria).toEqualTypeOf<{
      readonly __proto__: 'the platform team'
      readonly billing: 'payments'
    }>()
  })
})
