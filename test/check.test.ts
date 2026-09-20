import { describe, it, expect } from 'vitest'
import { assertExpectation, checkLive, diffFixture, loadFixtures } from '../src/check.js'
import type { Expectation, Fixture } from '../src/check.js'
import type { JevAnswer, JevQuestion } from '../src/contract.js'
import type { TypeSafeClient } from '@typesafe-ai/sdk'

// `jevc check --live` is the only thing standing between a model bump and 60 silently
// invalidated fixtures, so every defect below is a way it UNDER-reports: a run that dies,
// a collapse that reads as stable, a gate that flips without a row. No test here touches the
// network — the client is stubbed the way test/runtime.test.ts stubs it.

const Q = {
  destructive: { type: 'noul', instructions: 'Does the command delete data?' },
  action: { type: 'choice', instructions: 'Which action?',
    criteria: { reread_full: null, trust_context: null } },
  radius: { type: 'score', instructions: 'How wide is the blast radius?',
    criteria: ['one file', 'one dir', 'whole repo'] },
} satisfies Record<string, JevQuestion>

const noul = (n: number): JevAnswer => ({ type: 'noul', noul: n })
const choice = (c: string, confidence: number): JevAnswer =>
  ({ type: 'choice', choice: c, probabilities: { [c]: confidence }, confidence })
const score = (s: number, confidence: number): JevAnswer =>
  ({ type: 'score', score: s, legend: { '0': 'one file', '1': 'one dir', '2': 'whole repo' },
    probabilities: { '0': 0, '1': 0, '2': 1 }, confidence })

/** A Fixture carrying only what buildProgram/diffFixture/assertExpectation read. The state is
 * a non-empty string on purpose: askModel now runs validateRequest, which errors on an empty
 * state, and a fixture that cannot even be emitted would be measuring the wrong thing. */
const fixture = (
  id: string,
  questions: Record<string, JevQuestion>,
  answers: Record<string, JevAnswer>,
  expectation: Expectation = {},
): Fixture => ({
  id, title: '', provenance: '', llm_prompt: '', rationale: '',
  state: `state for ${id}`, questions, expect: expectation, domain: 'test',
  measured: { model: 'jev-1.13.0', verdict: 'keep', answers },
})

const wire = (answers: Record<string, JevAnswer>) =>
  ({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 5 } })

/** Keyed by the fixture's state, which is what makes each request identifiable. An `Error`
 * value is thrown instead of returned — that is how a transport/auth/quota failure on exactly
 * one fixture is expressed, which is the normal case against a live API. */
const serves = (byState: Record<string, unknown>): TypeSafeClient => ({
  systemOne: async (req: { state: unknown }) => {
    const res = byState[String(req.state)]
    if (res === undefined) throw new Error(`no stubbed response for ${String(req.state)}`)
    if (res instanceof Error) throw res
    return res
  },
}) as unknown as TypeSafeClient

// F22 — the case check.ts's own comment calls "arguably the single most important thing this
// report must catch" was unreachable: diffFixture classified a vanished answer as broken, but
// checkLive only ever reached diffFixture through evaluate, whose `uncertain:` field calls
// isUncertain for EVERY decision and throws on the first missing answer. cli.ts:149 turned
// that into `check --live failed: ...` and exit 1 — no report, no rows, the rest unmeasured.
describe('checkLive — a vanished answer is reported, not fatal', () => {
  it('classifies the missing id as broken and still returns a report', async () => {
    const f = fixture('f1', { destructive: Q.destructive, action: Q.action },
      { destructive: noul(0.9), action: choice('reread_full', 0.9) })
    const report = await checkLive([f], {
      client: serves({ 'state for f1': wire({ destructive: noul(0.9) }) }),
    })

    expect(report.rows).toContainEqual(
      { id: 'f1.action', recorded: 'reread_full', live: 'missing', delta: null, status: 'broken' })
    expect(report.broken).toBe(1)
    // The surviving answer is still measured — the point is a report, not a refusal.
    expect(report.rows).toContainEqual(
      { id: 'f1.destructive', recorded: 0.9, live: 0.9, delta: 0, status: 'stable' })
    expect(report.model).toBe('jev-1.13.0')
  })

  it('costs one fixture, not the run, when a fixture cannot be measured at all', async () => {
    // Middle fixture fails in transport. Before: the whole run rejected and the CLI printed
    // one line about fixture 2 while fixtures 1 and 3 went unreported.
    const fs = ['f1', 'f2', 'f3'].map(id => fixture(id, { destructive: Q.destructive }, { destructive: noul(0.9) }))
    const report = await checkLive(fs, {
      client: serves({
        'state for f1': wire({ destructive: noul(0.9) }),
        'state for f2': new Error('503 upstream unavailable'),
        'state for f3': wire({ destructive: noul(0.4) }),
      }),
    })

    expect(report.rows.map(r => r.id)).toEqual(['f1.destructive', 'f2', 'f3.destructive'])
    expect(report.rows[1]).toEqual({ id: 'f2', recorded: 'measurable',
      live: 'unmeasured: 503 upstream unavailable', delta: null, status: 'broken' })
    // Fixture 3 was still measured, and its drift still surfaced.
    expect(report.rows[2]?.status).toBe('drifted')
    expect(report).toMatchObject({ broken: 1, drifted: 1 })
  })

  it('an unreadable response leaves every recorded id reported as missing', async () => {
    // validateResponse's `answers_missing`: askModel hands back `{}` rather than a null behind
    // a type that promises a Record, so the report says which ids stopped coming back instead
    // of dying as a TypeError one frame up.
    const f = fixture('f1', { destructive: Q.destructive, action: Q.action },
      { destructive: noul(0.9), action: choice('reread_full', 0.9) })
    const report = await checkLive([f], {
      client: serves({ 'state for f1': { model: 'jev-1.13.0', answers: null, usage: {} } }),
    })
    expect(report.rows.map(r => [r.id, r.live])).toEqual([
      ['f1.destructive', 'missing'], ['f1.action', 'missing'],
    ])
    expect(report.broken).toBe(2)
  })
})

// F23 — a choice was diffed on its argmax alone, so the loudest signal a model bump can send
// (same winner, confidence gone) reported `stable`. Score carried confidence too and ignored it.
describe('diffFixture — confidence is half the answer', () => {
  it('reports a choice whose winner held but whose confidence collapsed', () => {
    const f = fixture('f1', {}, { action: choice('reread_full', 0.95) })
    const rows = diffFixture(f, { action: choice('reread_full', 0.15) }, 0.15)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'f1.action', recorded: 'reread_full@0.95',
      live: 'reread_full@0.15', status: 'drifted' })
    expect(rows[0]?.delta).toBeCloseTo(0.8, 5)
  })

  it('does not over-reach: a choice inside the threshold on both halves is still stable', () => {
    const f = fixture('f1', {}, { action: choice('reread_full', 0.95) })
    const rows = diffFixture(f, { action: choice('reread_full', 0.92) }, 0.15)
    expect(rows[0]?.status).toBe('stable')
  })

  it('still reports a flipped winner as drifted even when confidence did not move', () => {
    const f = fixture('f1', {}, { action: choice('reread_full', 0.9) })
    const rows = diffFixture(f, { action: choice('trust_context', 0.9) }, 0.15)
    expect(rows[0]).toMatchObject({ recorded: 'reread_full@0.9', live: 'trust_context@0.9', status: 'drifted' })
  })

  it('reports a score whose level held but whose confidence collapsed', () => {
    const f = fixture('f1', {}, { radius: score(2, 0.97) })
    const rows = diffFixture(f, { radius: score(2, 0.2) }, 0.15)
    expect(rows[0]).toMatchObject({ recorded: '2@0.97', live: '2@0.2', status: 'drifted' })
    expect(rows[0]?.delta).toBeCloseTo(0.77, 5)
  })

  it('reports the larger of the two movements as the delta', () => {
    // Level moved a full index, confidence barely moved: the delta must describe the level.
    const f = fixture('f1', {}, { radius: score(2, 0.97) })
    const rows = diffFixture(f, { radius: score(1, 0.95) }, 0.15)
    expect(rows[0]).toMatchObject({ status: 'drifted' })
    expect(rows[0]?.delta).toBeCloseTo(1, 5)
  })

  it('invents no confidence for a noul — its probability is the whole answer', () => {
    const f = fixture('f1', {}, { destructive: noul(0.9) })
    const rows = diffFixture(f, { destructive: noul(0.91) }, 0.15)
    expect(rows[0]).toMatchObject({ recorded: 0.9, live: 0.91, status: 'stable' })
    expect(rows[0]?.delta).toBeCloseTo(0.01, 5)
  })

  // R4 — the sibling of the alien-type case below, one level in: the TYPE matches, the
  // payload is gone. `Math.abs(0.95 - undefined)` is NaN and `NaN > threshold` is false, so
  // the row reported `stable` — a fixture claiming health while carrying no measurement.
  // Reachable live: validateResponse flags it `answer_not_a_number`, but checkLive reads
  // askModel's answers and not its issues, so the answer still arrives here.
  it('refuses to call a right-typed answer with no numeric payload stable', () => {
    const f = fixture('f1', {}, { destructive: noul(0.95) })
    const payloadless = { type: 'noul' } as unknown as JevAnswer
    expect(diffFixture(f, { destructive: payloadless }, 0.15)[0])
      .toMatchObject({ id: 'f1.destructive', delta: null, status: 'broken' })
  })

  it('refuses to call a score or choice whose confidence went missing stable', () => {
    const f = fixture('f1', {}, { radius: score(2, 0.97), action: choice('reread_full', 0.9) })
    const noConfidence = { type: 'score', score: 2, legend: {}, probabilities: {} } as unknown as JevAnswer
    const noChoice = { type: 'choice', probabilities: {}, confidence: 0.9 } as unknown as JevAnswer
    const rows = diffFixture(f, { radius: noConfidence, action: noChoice }, 0.15)
    expect(rows.map(r => [r.id, r.status])).toEqual([['f1.radius', 'broken'], ['f1.action', 'broken']])
  })

  it('refuses to call a pair of unreadable answer types stable', () => {
    // Both sides are untrusted JSON. The old arithmetic tail reached this as NaN > threshold,
    // which is false, so an answer nothing can read reported `stable`.
    const alien = { type: 'ordinal', ordinal: 3 } as unknown as JevAnswer
    const f = fixture('f1', {}, { radius: alien })
    const rows = diffFixture(f, { radius: alien }, 0.15)
    expect(rows[0]).toEqual({ id: 'f1.radius', recorded: 'ordinal', live: 'ordinal', delta: null, status: 'broken' })
  })
})

// F24 — the flat 0.15 default is a statement about noise, not about what any fixture is for.
// The corpus records its own bands, and a drift that crosses one flips the verdict.
describe('checkLive — the thresholds the corpus recorded', () => {
  it('reports a sub-threshold drift that crosses a recorded gate', async () => {
    const f = fixture('f1', { destructive: Q.destructive }, { destructive: noul(0.96) },
      { destructive: { noul_gte: 0.9 } })
    const report = await checkLive([f], {
      client: serves({ 'state for f1': wire({ destructive: noul(0.82) }) }),
    })

    // The flat threshold saw nothing: 0.14 is inside 0.15, so the numeric row is `stable`.
    expect(report.rows[0]).toMatchObject({ id: 'f1.destructive', status: 'stable' })
    // The gate the fixture was written to hold did not: 0.82 is under noul_gte 0.90, so the
    // verdict this fixture pins has flipped. It gets its own row, and the CLI prints it.
    expect(report.rows[1]).toEqual({ id: 'f1.expect', recorded: 'held',
      live: 'destructive: noul 0.82 < 0.9', delta: null, status: 'drifted' })
    // R6: `drifted`, NOT `broken`, so it does not gate the exit. Measured over this corpus:
    // of the 331 numeric expectation bounds, 216 have less headroom than the report's own
    // 0.15 drift threshold, the median bound has 0.120, 14 have under 0.05, and
    // `agent-goal-drift-ci-secret-exfil.next_action_serves_user_request` sits exactly on its
    // bound (0.000). A bump smaller than the movement this tool DEFINES as drift would have
    // marked most of the corpus `broken` and exited 1.
    expect(report).toMatchObject({ broken: 0, drifted: 1 })
  })

  it('does not exit-gate the corpus on a bump inside its own drift threshold', async () => {
    // The whole R6 scenario in one fixture: every answer moved 0.06 — a third of the 0.15
    // drift threshold — and every recorded band it crosses is a band with under 0.06 of
    // headroom, which 14 bounds in the real corpus have. Nothing here is the model refusing
    // to answer, so nothing here may be `broken`.
    const f = fixture('f1', { destructive: Q.destructive }, { destructive: noul(0.92) },
      { destructive: { noul_gte: 0.9 } })
    const report = await checkLive([f], {
      client: serves({ 'state for f1': wire({ destructive: noul(0.86) }) }),
    })
    expect(report.rows.map(r => [r.id, r.status]))
      .toEqual([['f1.destructive', 'stable'], ['f1.expect', 'drifted']])
    expect(report.broken).toBe(0)
  })

  it('still reports a vanished answer as broken alongside the band it also breaks', async () => {
    // The distinction R6 is drawing: "the model stopped answering a question it used to" is
    // `broken` and gates the exit; "a band calibrated from one measurement moved" is not.
    const f = fixture('f1', { destructive: Q.destructive, action: Q.action },
      { destructive: noul(0.96), action: choice('reread_full', 0.9) },
      { destructive: { noul_gte: 0.9 }, action: { choice: 'reread_full' } })
    const report = await checkLive([f], {
      client: serves({ 'state for f1': wire({ destructive: noul(0.82) }) }),
    })
    expect(report.rows.map(r => [r.id, r.status, r.live])).toEqual([
      ['f1.destructive', 'stable', 0.82],
      // The vanishing is `broken` and gates the exit — reported by diffFixture, which is
      // where that finding lives. The expectation rows are the second, non-gating view of
      // the same run.
      ['f1.action', 'broken', 'missing'],
      ['f1.expect', 'drifted', 'destructive: noul 0.82 < 0.9'],
      ['f1.expect', 'drifted', 'action: no answer returned'],
    ])
    expect(report).toMatchObject({ broken: 1, drifted: 2 })
  })

  it('reports a confidence band the corpus recorded, which no numeric delta would reach', async () => {
    const f = fixture('f1', { action: Q.action }, { action: choice('reread_full', 0.5) },
      { action: { choice_in: ['reread_full'], confidence_lte: 0.7 } })
    const report = await checkLive([f], {
      client: serves({ 'state for f1': wire({ action: choice('reread_full', 0.62) }) }),
    })
    // Confidence moved 0.12 — inside the flat threshold, so the row is stable and the
    // expectation still holds. Nothing to report.
    expect(report).toMatchObject({ broken: 0, drifted: 0 })
  })

  it('says nothing when the live answers still satisfy every recorded expectation', async () => {
    const f = fixture('f1', { destructive: Q.destructive }, { destructive: noul(0.96) },
      { destructive: { noul_gte: 0.9 } })
    const report = await checkLive([f], {
      client: serves({ 'state for f1': wire({ destructive: noul(0.93) }) }),
    })
    expect(report.rows).toEqual([{ id: 'f1.destructive', recorded: 0.96, live: 0.93,
      delta: expect.closeTo(0.03, 5), status: 'stable' }])
    expect(report).toMatchObject({ broken: 0, drifted: 0 })
  })
})

// R4 — every comparison against `undefined`/NaN is false, so an answer of the right type
// carrying no measurement satisfied every clause of its expectation and the fixture reported
// health. This is the expectation half; the diffFixture half is two describes up.
describe('assertExpectation — a right-typed answer with no measurement in it', () => {
  it('fails instead of satisfying every clause at once', () => {
    const payloadless = { type: 'noul' } as unknown as JevAnswer
    const fails = assertExpectation(
      { destructive: { noul_gte: 0.9, noul_lte: 0.99 } }, { destructive: payloadless })
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('destructive')
    expect(fails[0]).toContain('noul')
  })

  it('fails a score or choice whose confidence is not a number', () => {
    const noConfidence = { type: 'score', score: 2, legend: {}, probabilities: {} } as unknown as JevAnswer
    expect(assertExpectation({ radius: { score_gte: 1, confidence_gte: 0.8 } },
      { radius: noConfidence })).toHaveLength(1)
    const nanConfidence = { type: 'choice', choice: 'reread_full', probabilities: {}, confidence: NaN } as JevAnswer
    expect(assertExpectation({ action: { choice: 'reread_full', confidence_gte: 0.8 } },
      { action: nanConfidence })).toHaveLength(1)
  })

  it('still passes every expectation the recorded corpus actually holds', () => {
    // The no-false-rejection guard for the clause above: offline `jevc check` runs exactly
    // this over all 58 fixtures and exits 1 on any failure.
    for (const f of loadFixtures('fixtures')) {
      const fails = assertExpectation(f.expect, f.measured.answers)
      expect(fails, `${f.id}: ${fails.join('; ')}`).toEqual([])
    }
  })
})

// R5 — `model` was `res.model ?? model`, so only the last non-null string survived and every
// row in the report claimed it. A mid-run alias bump is the one event `--live` exists to
// attribute, and it was the one event the report misattributed.
describe('checkLive — which model answered', () => {
  it('names every model that answered when the alias moves mid-run', async () => {
    const fs = ['f1', 'f2', 'f3'].map(id =>
      fixture(id, { destructive: Q.destructive }, { destructive: noul(0.9) }))
    const report = await checkLive(fs, {
      client: serves({
        'state for f1': { ...wire({ destructive: noul(0.9) }), model: 'jev-1.13.0' },
        'state for f2': { ...wire({ destructive: noul(0.9) }), model: 'jev-1.14.0' },
        'state for f3': { ...wire({ destructive: noul(0.9) }), model: 'jev-1.14.0' },
      }),
    })
    // Not "jev-1.14.0": fixture 1 was measured against a different model than 2 and 3, and a
    // report that names one of them attributes two thirds of its rows to the wrong build.
    expect(report.model).toBe('jev-1.13.0, jev-1.14.0')
  })

  it('names the single model unchanged when it does not move', async () => {
    const fs = ['f1', 'f2'].map(id =>
      fixture(id, { destructive: Q.destructive }, { destructive: noul(0.9) }))
    const report = await checkLive(fs, {
      client: serves({
        'state for f1': wire({ destructive: noul(0.9) }),
        'state for f2': wire({ destructive: noul(0.9) }),
      }),
    })
    expect(report.model).toBe('jev-1.13.0')
  })
})

// The no-false-positive test for all three fixes at once, on the real corpus rather than on
// hand-made fixtures: replay every recorded answer back at checkLive and the report must be
// silent. It also pins that all 60 programs clear the validateProgram/validateRequest gates
// askModel now runs before spending a call — a program those refuse becomes a `broken` row.
describe('checkLive — the 58-fixture corpus replayed against itself', () => {
  it('reports nothing broken and nothing drifted', async () => {
    const corpus = loadFixtures('fixtures')
    expect(corpus).toHaveLength(58)
    // checkLive awaits one fixture at a time, so request order is corpus order.
    let i = 0
    const client = { systemOne: async () => wire(corpus[i++]!.measured.answers) } as unknown as TypeSafeClient

    const report = await checkLive(corpus, { client })
    const noisy = report.rows.filter(r => r.status !== 'stable')
    expect(noisy, noisy.map(r => `${r.id} ${r.status} ${r.live}`).join('\n')).toEqual([])
    expect(report.rows).toHaveLength(corpus.reduce((n, f) => n + Object.keys(f.measured.answers).length, 0))
  })
})
