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
