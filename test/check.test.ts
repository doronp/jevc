import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { assertExpectation, checkLive, diffFixture, liveOptions, liveSummary, loadFixtures, MAX_REPEAT } from '../src/check.js'
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
  // askModel reads JEVC_ALLOW_MODEL per call, so one set in the shell running the suite would
  // turn the broken row below into a drifted one.
  const saved = process.env.JEVC_ALLOW_MODEL
  beforeEach(() => { delete process.env.JEVC_ALLOW_MODEL })
  afterEach(() => {
    if (saved === undefined) delete process.env.JEVC_ALLOW_MODEL
    else process.env.JEVC_ALLOW_MODEL = saved
  })

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

  // askModel now reports a response from outside the pin as `model_unexpected`;
  // checkLive read none of res.issues, so a whole run answered by something that is not Jev
  // would have diffed as ordinary drift. One row per fixture, on the fixture that saw it.
  it('reports a fixture answered by a model that is not Jev as broken, and keeps diffing', async () => {
    const fs = ['f1', 'f2'].map(id =>
      fixture(id, { destructive: Q.destructive }, { destructive: noul(0.9) }))
    const report = await checkLive(fs, {
      client: serves({
        'state for f1': wire({ destructive: noul(0.9) }),
        'state for f2': { ...wire({ destructive: noul(0.9) }), model: 'laya-rl-agent' },
      }),
    })
    expect(report.rows.filter(r => r.status !== 'stable')).toEqual([
      { id: 'f2.model', recorded: 'jev-1.13.0', live: 'laya-rl-agent', delta: null, status: 'broken' },
    ])
    // Its answers are still classified: the model row says who, the diff rows say what moved.
    expect(report.rows.map(r => r.id)).toEqual(['f1.destructive', 'f2.model', 'f2.destructive'])
    expect(report.model).toBe('jev-1.13.0, laya-rl-agent')
  })

  it('reports another Jev build as drifted, not broken', async () => {
    const f = fixture('f1', { destructive: Q.destructive }, { destructive: noul(0.9) })
    const report = await checkLive([f], {
      client: serves({ 'state for f1': { ...wire({ destructive: noul(0.9) }), model: 'jev-1.14.0' } }),
    })
    expect(report.rows.filter(r => r.status !== 'stable')).toEqual([
      { id: 'f1.model', recorded: 'jev-1.13.0', live: 'jev-1.14.0', delta: null, status: 'drifted' },
    ])
  })

  // O-R11: the documented re-measure path — name the local model, run check --live — had no
  // test; a row keyed on "starts with jev-" instead of the guard's severity passed every other.
  it('reports a model JEVC_ALLOW_MODEL names as drifted, the re-measure path', async () => {
    process.env.JEVC_ALLOW_MODEL = 'laya-rl-agent'
    const f = fixture('f1', { destructive: Q.destructive }, { destructive: noul(0.9) })
    const report = await checkLive([f], {
      client: serves({ 'state for f1': { ...wire({ destructive: noul(0.9) }), model: 'laya-rl-agent' } }),
    })
    expect(report.rows.filter(r => r.status !== 'stable')).toEqual([
      { id: 'f1.model', recorded: 'jev-1.13.0', live: 'laya-rl-agent', delta: null, status: 'drifted' },
    ])
    expect(report.broken).toBe(0)
  })

  it('never prints a model field that is not a model ID', async () => {
    const f = fixture('f1', { destructive: Q.destructive }, { destructive: noul(0.9) })
    const report = await checkLive([f], {
      client: serves({ 'state for f1': { ...wire({ destructive: noul(0.9) }), model: { state: 'SECRET' } } }),
    })
    expect(report.rows.filter(r => r.status !== 'stable')).toEqual([
      { id: 'f1.model', recorded: 'jev-1.13.0', live: 'none', delta: null, status: 'broken' },
    ])
    expect(report.model).toBe('')
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

// KA-R8, KA-R4: the line `check --live` ends on. A run where no response named a model printed
// "against : ...", and the model list is wire text printed unquoted after rows that quote it.
describe('liveSummary', () => {
  const report = (model: string) => ({ model, rows: [], drifted: 1, broken: 2 })
  it('names the model, quoted', () => {
    expect(liveSummary(report('jev-1.13.0'))).toBe('0 rows checked live against "jev-1.13.0": 1 drifted, 2 broken\n')
  })
  it('says so when no response named a model', () => {
    expect(liveSummary(report(''))).toBe('0 rows checked live against no named model: 1 drifted, 2 broken\n')
  })
  it('prints a control character escaped', () => {
    expect(liveSummary(report('x\u001b[2J'))).not.toMatch(/\u001b/)
  })
})

// cli.ts runs on import, so `liveOptions` is the seam: the CLI builds checkLive's
// options with it, and these tests hand its result to checkLive exactly as the CLI does, with
// a stub client in place of the network.
describe('liveOptions — `check --live --model <id> --threshold <n>`', () => {
  const f = fixture('f1', { destructive: Q.destructive }, { destructive: noul(0.9) })
  const asking = (answer: number) => {
    const seen: string[] = []
    const client = { systemOne: async (req: { model: string }) => {
      seen.push(req.model)
      return wire({ destructive: noul(answer) })
    } } as unknown as TypeSafeClient
    return { seen, client }
  }

  it('asks the model --model names', async () => {
    const { seen, client } = asking(0.9)
    await checkLive([f], { client, ...liveOptions('jev-latest', undefined) })
    expect(seen).toEqual(['jev-latest'])
  })

  it('asks the pinned model when --model is absent', async () => {
    const { seen, client } = asking(0.9)
    await checkLive([f], { client, ...liveOptions(undefined, undefined) })
    expect(seen).toEqual(['jev-1.13.0'])
  })

  it('classifies drift against --threshold instead of the default 0.15', async () => {
    // A 0.2 move: drift at the default, stable at 0.25, drift again at 0.1.
    const status = async (t: string | undefined) =>
      (await checkLive([f], { client: asking(0.7).client, ...liveOptions(undefined, t) })).rows[0]!.status
    expect(await status(undefined)).toBe('drifted')
    expect(await status('0.25')).toBe('stable')
    expect(await status('0.1')).toBe('drifted')
  })

  it('refuses a model outside MODELS and a threshold outside [0, 1)', () => {
    expect(() => liveOptions('laya-rl-agent', undefined)).toThrow(/"laya-rl-agent"/)
    for (const t of ['abc', 'NaN', 'Infinity', '-0.1', '1', '2', ' ', '0.3abc']) {
      expect(() => liveOptions(undefined, t), t).toThrow(/--threshold/)
    }
    expect(liveOptions(undefined, '0')).toEqual({ driftThreshold: 0 })
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

// `check --live --repeat N`. Identical calls are not guaranteed to return identical answers,
// so one call can raise a drift row that the next call would not. With N > 1 each fixture is asked N times and the per-value MEDIAN is what
// diffFixture and the recorded bands see; the min..max across the N rides along on the row.
describe('checkLive --repeat — the median of N calls is what gets diffed', () => {
  // askModel reads JEVC_ALLOW_MODEL per call; the model-guard cases below assume it is unset.
  const saved = process.env.JEVC_ALLOW_MODEL
  beforeEach(() => { delete process.env.JEVC_ALLOW_MODEL })
  afterEach(() => {
    if (saved === undefined) delete process.env.JEVC_ALLOW_MODEL
    else process.env.JEVC_ALLOW_MODEL = saved
  })

  /** The i-th reply answers the i-th request, and every request's state is kept, so a test
   * can count the calls and see which fixture each one was for. */
  const sequence = (replies: unknown[]) => {
    const states: string[] = []
    const client = { systemOne: async (req: { state: unknown }) => {
      states.push(String(req.state))
      const r = replies[states.length - 1]
      if (r === undefined) throw new Error('more requests than stubbed replies')
      if (r instanceof Error) throw r
      return r
    } } as unknown as TypeSafeClient
    return { client, states }
  }
  const nouls = (...ns: number[]) => ns.map(n => wire({ destructive: noul(n) }))
  /** A choice with BOTH options in its probability map, the way the API returns one. */
  const two = (reread: number, trust: number, confidence: number): JevAnswer => ({ type: 'choice',
    choice: reread >= trust ? 'reread_full' : 'trust_context',
    probabilities: { reread_full: reread, trust_context: trust }, confidence })

  it('asks every fixture N times, one fixture after another', async () => {
    const fs = ['f1', 'f2'].map(id => fixture(id, { destructive: Q.destructive }, { destructive: noul(0.9) }))
    const { client, states } = sequence(nouls(0.9, 0.9, 0.9, 0.9, 0.9, 0.9))
    const report = await checkLive(fs, { client, repeat: 3 })
    expect(states).toEqual(['state for f1', 'state for f1', 'state for f1',
      'state for f2', 'state for f2', 'state for f2'])
    expect(report.rows.map(r => [r.id, r.status])).toEqual([['f1.destructive', 'stable'], ['f2.destructive', 'stable']])
    expect(report.repeat).toBe(3)
  })

  it('does not flag a single outlier among five, which one call on its own would', async () => {
    const f = fixture('f1', { destructive: Q.destructive }, { destructive: noul(0.9) },
      { destructive: { noul_gte: 0.8 } })
    const five = await checkLive([f], { client: sequence(nouls(0.9, 0.91, 0.3, 0.89, 0.9)).client, repeat: 5 })
    expect(five.rows).toEqual([{ id: 'f1.destructive', recorded: 0.9, live: 0.9, delta: 0,
      status: 'stable', range: '0.3..0.91' }])
    expect(five).toMatchObject({ drifted: 0, broken: 0 })
    // The same outlier as the only sample: a drift row and a crossed band, both false alarms.
    const one = await checkLive([f], { client: sequence(nouls(0.3)).client })
    expect(one).toMatchObject({ drifted: 2, broken: 0 })
  })

  it('flags a consistent shift, and shows the spread on the drift row and the band row', async () => {
    const f = fixture('f1', { destructive: Q.destructive }, { destructive: noul(0.9) },
      { destructive: { noul_gte: 0.8 } })
    const report = await checkLive([f], { client: sequence(nouls(0.6, 0.62, 0.58, 0.61, 0.95)).client, repeat: 5 })
    expect(report.rows).toEqual([
      { id: 'f1.destructive', recorded: 0.9, live: 0.61, delta: expect.closeTo(0.29, 5), status: 'drifted', range: '0.58..0.95' },
      { id: 'f1.expect', recorded: 'held', live: 'destructive: noul 0.61 < 0.8', delta: null, status: 'drifted', range: '0.58..0.95' },
    ])
  })

  it('takes a choice\'s median per option, its winner from the argmax of those medians, and its median confidence', async () => {
    const f = fixture('f1', { action: Q.action }, { action: two(0.9, 0.1, 0.9) })
    const replies = (answers: JevAnswer[]) => answers.map(a => wire({ action: a }))
    // One call of five flipped to the other option: the medians still favour reread_full.
    const outlier = await checkLive([f], { repeat: 5, client: sequence(replies([
      two(0.9, 0.1, 0.9), two(0.88, 0.12, 0.92), two(0.2, 0.8, 0.6), two(0.91, 0.09, 0.91), two(0.89, 0.11, 0.89),
    ])).client })
    expect(outlier.rows).toEqual([{ id: 'f1.action', recorded: 'reread_full@0.9', live: 'reread_full@0.9',
      delta: 0, status: 'stable', range: 'reread_full|trust_context@0.6..0.92' }])
    // Three of five flipped: the argmax of the medians is trust_context, so the winner moved.
    const flipped = await checkLive([f], { repeat: 5, client: sequence(replies([
      two(0.3, 0.7, 0.9), two(0.88, 0.12, 0.92), two(0.2, 0.8, 0.9), two(0.25, 0.75, 0.91), two(0.89, 0.11, 0.89),
    ])).client })
    expect(flipped.rows).toEqual([{ id: 'f1.action', recorded: 'reread_full@0.9', live: 'trust_context@0.9',
      delta: 0, status: 'drifted', range: 'trust_context|reread_full@0.89..0.92' }])
  })

  // Two calls that each name a different winner at mirrored odds tie exactly on the medians.
  // Neither call's JSON key order may pick the winner: the order reverses nothing in the data.
  it('breaks an exact median tie the same way whatever order the calls came back in', async () => {
    const readFirst = two(0.55, 0.45, 0.9)
    const trustFirst: JevAnswer = { type: 'choice', choice: 'trust_context',
      probabilities: { trust_context: 0.55, reread_full: 0.45 }, confidence: 0.9 }
    for (const recorded of [two(0.9, 0.1, 0.9), two(0.1, 0.9, 0.9)]) {
      const f = fixture('f1', { action: Q.action }, { action: recorded })
      const lives = await Promise.all([[readFirst, trustFirst], [trustFirst, readFirst]].map(async order =>
        (await checkLive([f], { repeat: 2, client: sequence(order.map(a => wire({ action: a }))).client })).rows[0]!.live))
      // Each option was named by one call of two, so the tie goes to the recorded choice.
      expect(lives, JSON.stringify(recorded)).toEqual([0, 1].map(() => `${(recorded as { choice: string }).choice}@0.9`))
    }
  })

  /** Three options, the shape of the corpus's allow/ask/deny heads. */
  const gate: JevQuestion = { type: 'choice', instructions: 'Which verdict?', criteria: { allow: null, ask: null, deny: null } }
  const three = (named: string, allow: number, ask: number, deny: number): JevAnswer =>
    ({ type: 'choice', choice: named, probabilities: { allow, ask, deny }, confidence: 0.6 })

  // With three options the per-option medians can peak on an option no call chose: the calls
  // split between allow and ask, while deny keeps steady middling mass in every one of them.
  it('lets only an option some call named win, however high the median of another', async () => {
    const f = fixture('f1', { verdict: gate }, { verdict: three('allow', 0.5, 0.05, 0.45) },
      { verdict: { choice_in: ['allow', 'ask'] } })
    const report = await checkLive([f], { repeat: 3, client: sequence([
      three('allow', 0.5, 0.05, 0.45), three('ask', 0.05, 0.5, 0.45), three('allow', 0.34, 0.33, 0.33),
    ].map(a => wire({ verdict: a }))).client })
    // Medians: allow 0.34, ask 0.33, deny 0.45. Every call held the band; deny was never named.
    expect(report.rows).toEqual([{ id: 'f1.verdict', recorded: 'allow@0.6', live: 'allow@0.6',
      delta: 0, status: 'stable', range: 'allow|ask@0.6..0.6' }])
    expect(report).toMatchObject({ drifted: 0, broken: 0 })
  })

  // An even N takes the mean of the middle two, so a tie exact on paper can differ in the last
  // bit: (0.28 + 0.33) / 2 is 0.30500000000000005, while (0.15 + 0.46) / 2 is 0.305.
  it('treats medians a rounding error apart as a tie, and gives it to the option more calls named', async () => {
    const calls = [three('ask', 0.28, 0.6, 0.12), three('allow', 0.51, 0.34, 0.15),
      three('deny', 0.13, 0.19, 0.68), three('deny', 0.33, 0.21, 0.46)]
    // deny was named twice and allow once, so deny wins whichever of the two was recorded.
    for (const recorded of ['allow', 'deny']) {
      const f = fixture('f1', { verdict: gate }, { verdict: three(recorded, 0.4, 0.2, 0.4) })
      const report = await checkLive([f], { repeat: 4, client: sequence(calls.map(a => wire({ verdict: a }))).client })
      expect(report.rows[0]!.live, recorded).toBe('deny@0.6')
    }
  })

  // One call alone is read by its named choice, so the same payload at N > 1 must not turn a
  // missing probability map into a choice of `undefined`, a broken row one call never gives.
  it('falls back to the named choices when no probability key survives the median', async () => {
    const f = fixture('f1', { action: Q.action }, { action: two(0.2, 0.8, 0.8) })
    const bare = { type: 'choice', choice: 'trust_context', confidence: 0.8 } as unknown as JevAnswer
    const report = await checkLive([f], { repeat: 3, client: sequence(
      [two(0.2, 0.8, 0.8), bare, two(0.3, 0.7, 0.8)].map(a => wire({ action: a }))).client })
    expect(report.rows.map(r => [r.id, r.status, r.live])).toEqual([['f1.action', 'stable', 'trust_context@0.8']])
  })

  it('takes a score\'s median level and median confidence', async () => {
    const f = fixture('f1', { radius: Q.radius }, { radius: score(2, 0.97) })
    const report = await checkLive([f], { repeat: 5, client: sequence(
      [score(2, 0.97), score(2, 0.95), score(0, 0.3), score(2, 0.96), score(1.9, 0.97)].map(a => wire({ radius: a })),
    ).client })
    expect(report.rows).toEqual([{ id: 'f1.radius', recorded: '2@0.97', live: '2@0.96',
      delta: expect.closeTo(0.01, 5), status: 'stable', range: '0..2@0.3..0.97' }])
  })

  it('runs the model guard on every one of the N responses, one row per answerer', async () => {
    const f = fixture('f1', { destructive: Q.destructive }, { destructive: noul(0.9) })
    const answeredBy = (...models: string[]) => models.map(model => ({ ...wire({ destructive: noul(0.9) }), model }))
    // A stranger on the second call of three is still caught, and fails the run.
    const middle = await checkLive([f], { repeat: 3, client: sequence(answeredBy('jev-1.13.0', 'laya-rl-agent', 'jev-1.13.0')).client })
    expect(middle.rows.filter(r => r.status !== 'stable')).toEqual([
      { id: 'f1.model', recorded: 'jev-1.13.0', live: 'laya-rl-agent', delta: null, status: 'broken' },
    ])
    expect(middle.model).toBe('jev-1.13.0, laya-rl-agent')
    // The same build three times is one finding, not three.
    const bumped = await checkLive([f], { repeat: 3, client: sequence(answeredBy('jev-1.14.0', 'jev-1.14.0', 'jev-1.14.0')).client })
    expect(bumped.rows.filter(r => r.status !== 'stable')).toEqual([
      { id: 'f1.model', recorded: 'jev-1.13.0', live: 'jev-1.14.0', delta: null, status: 'drifted' },
    ])
  })

  it('does not let a median average away a structural fault in one of the N calls', async () => {
    const f = fixture('f1', { destructive: Q.destructive, action: Q.action, radius: Q.radius },
      { destructive: noul(0.9), action: two(0.9, 0.1, 0.9), radius: score(2, 0.97) })
    const ok = { destructive: noul(0.9), action: two(0.9, 0.1, 0.9), radius: score(2, 0.97) }
    const report = await checkLive([f], { repeat: 3, client: sequence([
      wire(ok),
      // Second call: destructive vanished, action came back as a noul, radius has no score,
      // and an id nobody asked for appeared.
      wire({ action: noul(0.9), radius: { type: 'score', legend: {}, probabilities: {}, confidence: 0.9 } as unknown as JevAnswer,
        extra: noul(0.5) }),
      wire(ok),
    ]).client })
    expect(report.rows.map(r => [r.id, r.status, r.live])).toEqual([
      ['f1.action', 'broken', 'noul'],
      ['f1.radius', 'broken', 'undefined@0.9'],
      ['f1.extra', 'broken', 'new'],
      ['f1.destructive', 'broken', 'missing'],
    ])
    expect(report.broken).toBe(4)
  })

  it('costs the fixture, not the run, when one of its N calls fails', async () => {
    const fs = ['f1', 'f2'].map(id => fixture(id, { destructive: Q.destructive }, { destructive: noul(0.9) }))
    const { client, states } = sequence([...nouls(0.9), new Error('503 upstream unavailable'), ...nouls(0.9, 0.9, 0.9)])
    const report = await checkLive(fs, { client, repeat: 3 })
    expect(states).toEqual(['state for f1', 'state for f1', 'state for f2', 'state for f2', 'state for f2'])
    expect(report.rows).toEqual([
      { id: 'f1', recorded: 'measurable', live: 'unmeasured: 503 upstream unavailable', delta: null, status: 'broken' },
      { id: 'f2.destructive', recorded: 0.9, live: 0.9, delta: 0, status: 'stable', range: '0.9..0.9' },
    ])
  })

  // checkLive is public, so a caller can reach it without liveOptions. A count of 0 or NaN
  // used to run no call at all and report every answer `missing`, and 2.5 ran three calls.
  it('refuses a repeat that is not a whole number from 1 to MAX_REPEAT, before any call', async () => {
    const f = fixture('f1', { destructive: Q.destructive }, { destructive: noul(0.9) })
    for (const repeat of [0, -1, 2.5, NaN, Infinity, MAX_REPEAT + 1, '3' as unknown as number]) {
      const { client, states } = sequence(nouls(0.9, 0.9, 0.9))
      await expect(checkLive([f], { client, repeat }), String(repeat))
        .rejects.toThrow(`repeat must be a whole number from 1 to ${MAX_REPEAT}`)
      expect(states, String(repeat)).toHaveLength(0)
    }
  })

  it('leaves the default path — one call, its answers diffed as they came — exactly as it was', async () => {
    // A reply whose `choice` is not the argmax of its own probabilities: a median would
    // recompute the winner, one call must report what the API said. No `range` either.
    const f = fixture('f1', { action: Q.action }, { action: two(0.9, 0.1, 0.9) })
    const odd: JevAnswer = { type: 'choice', choice: 'trust_context', probabilities: { reread_full: 0.9, trust_context: 0.1 }, confidence: 0.9 }
    for (const opts of [{}, { repeat: 1 }]) {
      const report = await checkLive([f], { ...opts, client: sequence([wire({ action: odd })]).client })
      expect(report.rows).toEqual([{ id: 'f1.action', recorded: 'reread_full@0.9', live: 'trust_context@0.9',
        delta: 0, status: 'drifted' }])
      expect(report.rows[0]).not.toHaveProperty('range')
    }
  })
})

describe('liveOptions — `check --live --repeat <n>`', () => {
  it('accepts a whole number of calls from 1 to MAX_REPEAT', () => {
    expect(MAX_REPEAT).toBe(10)
    expect(liveOptions(undefined, undefined, '1')).toEqual({ repeat: 1 })
    expect(liveOptions(undefined, undefined, '5')).toEqual({ repeat: 5 })
    expect(liveOptions(undefined, undefined, '10')).toEqual({ repeat: 10 })
    expect(liveOptions(undefined, undefined, undefined)).toEqual({})
  })

  it('refuses zero, negatives, fractions, anything above the cap and anything not a number', () => {
    for (const n of ['0', '-1', '1.5', '11', '100', 'abc', '', ' ', '1e1', '0x5', '+3', '3 ']) {
      expect(() => liveOptions(undefined, undefined, n), JSON.stringify(n)).toThrow(/--repeat/)
    }
  })
})

describe('liveSummary — with --repeat', () => {
  const report = { model: 'jev-1.13.0', rows: [], drifted: 1, broken: 2 }
  it('says the rows are medians when there was more than one call per fixture', () => {
    expect(liveSummary({ ...report, repeat: 5 }))
      .toBe('0 rows checked live against "jev-1.13.0", median of 5 calls per fixture: 1 drifted, 2 broken\n')
  })
  it('reads as it always did for one call', () => {
    expect(liveSummary({ ...report, repeat: 1 })).toBe('0 rows checked live against "jev-1.13.0": 1 drifted, 2 broken\n')
  })
})
