import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { JevAnswer, JevQuestion, JevRequest } from './contract.js'
import { askModel, type EvaluateOptions } from './runtime.js'
import type { Program } from './ir.js'

export type Expectation = Record<string, {
  noul_gte?: number; noul_lte?: number
  score_gte?: number; score_lte?: number
  confidence_gte?: number; confidence_lte?: number
  choice?: string; choice_in?: string[]
  prob_lte?: Record<string, number>
}>

/** Every clause key `assertExpectation` understands. Anything else on a clause is reported
 * as a failure rather than silently ignored — see the "unrecognized expectation clause"
 * branch below. Keep in sync with `Expectation`'s keys. */
const KNOWN_CLAUSE_KEYS = new Set([
  'noul_gte', 'noul_lte', 'score_gte', 'score_lte',
  'confidence_gte', 'confidence_lte', 'choice', 'choice_in', 'prob_lte',
])

export type Fixture = {
  id: string
  title: string
  provenance: string
  llm_prompt: string
  rationale: string
  state: JevRequest['state']
  questions: Record<string, JevQuestion>
  expect: Expectation
  measured: {
    answers: Record<string, JevAnswer>
    latency_ms?: number
    model: string
    verdict: string
    prediction_held?: boolean
    notes?: string
  }
  domain: string
}

/** Load the measured fixture corpus from a directory of domain files (see fixtures/*.json).
 * `measured.answers` is stored as a JSON string in some domain files and as an object in
 * others — normalize both to an object. */
export function loadFixtures(dir: string): Fixture[] {
  const out: Fixture[] = []
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const path = join(dir, file)
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(doc.fixtures)) {
      throw new Error(`${path}: expected a top-level "fixtures" array, got ${typeof doc.fixtures}.`)
    }
    for (const f of doc.fixtures) {
      const answers = typeof f.measured.answers === 'string'
        ? JSON.parse(f.measured.answers) : f.measured.answers
      out.push({ ...f, domain: doc.domain, measured: { ...f.measured, answers } })
    }
  }
  return out
}

/** Check a set of answers against a fixture's recorded expectation. Every bound is a
 * band (`_gte`/`_lte`), never equality — identical calls to the API drift +/-0.01. Returns
 * one human-readable message per violated clause; an empty array means the expectation held.
 * An unrecognized clause key (a typo, or an operator this function doesn't yet implement) is
 * itself reported as a failure rather than silently skipped — a clause that runs zero
 * assertions passes unconditionally, which is worse than not having the clause at all.
 * `prob_lte` against a probability key absent from the answer is likewise a failure, not a
 * silent pass — a renamed or removed option should not go unnoticed. */
export function assertExpectation(
  exp: Expectation,
  answers: Record<string, JevAnswer>,
): string[] {
  const fails: string[] = []
  for (const [id, clause] of Object.entries(exp)) {
    for (const key of Object.keys(clause)) {
      if (!KNOWN_CLAUSE_KEYS.has(key)) fails.push(`${id}: unrecognized expectation clause "${key}"`)
    }

    const a = answers[id]
    if (!a) { fails.push(`${id}: no answer returned`); continue }

    if (clause.noul_gte !== undefined) {
      if (a.type !== 'noul') fails.push(`${id}: expected a noul, got ${a.type}`)
      else if (a.noul < clause.noul_gte) fails.push(`${id}: noul ${a.noul} < ${clause.noul_gte}`)
    }
    if (clause.noul_lte !== undefined) {
      if (a.type !== 'noul') fails.push(`${id}: expected a noul, got ${a.type}`)
      else if (a.noul > clause.noul_lte) fails.push(`${id}: noul ${a.noul} > ${clause.noul_lte}`)
    }
    if (clause.score_gte !== undefined) {
      if (a.type !== 'score') fails.push(`${id}: expected a score, got ${a.type}`)
      else if (a.score < clause.score_gte) fails.push(`${id}: score ${a.score} < ${clause.score_gte}`)
    }
    if (clause.score_lte !== undefined) {
      if (a.type !== 'score') fails.push(`${id}: expected a score, got ${a.type}`)
      else if (a.score > clause.score_lte) fails.push(`${id}: score ${a.score} > ${clause.score_lte}`)
    }
    if (clause.choice !== undefined) {
      if (a.type !== 'choice') fails.push(`${id}: expected a choice, got ${a.type}`)
      else if (a.choice !== clause.choice) fails.push(`${id}: expected ${clause.choice}, got ${a.choice}`)
    }
    if (clause.confidence_gte !== undefined) {
      if (a.type === 'noul') fails.push(`${id}: a noul carries no confidence`)
      else if (a.confidence < clause.confidence_gte) {
        fails.push(`${id}: confidence ${a.confidence} < ${clause.confidence_gte}`)
      }
    }
    if (clause.confidence_lte !== undefined) {
      if (a.type === 'noul') fails.push(`${id}: a noul carries no confidence`)
      else if (a.confidence > clause.confidence_lte) {
        fails.push(`${id}: confidence ${a.confidence} > ${clause.confidence_lte}`)
      }
    }
    if (clause.choice_in !== undefined) {
      if (a.type !== 'choice') fails.push(`${id}: expected a choice, got ${a.type}`)
      else if (!clause.choice_in.includes(a.choice)) {
        fails.push(`${id}: expected one of ${clause.choice_in.join(', ')}, got ${a.choice}`)
      }
    }
    if (clause.prob_lte !== undefined) {
      if (a.type !== 'choice' && a.type !== 'score') {
        fails.push(`${id}: expected a choice or score, got ${a.type}`)
      } else {
        for (const [key, max] of Object.entries(clause.prob_lte)) {
          const p = a.probabilities[key]
          if (p === undefined) fails.push(`${id}: no probability recorded for "${key}"`)
          else if (p > max) fails.push(`${id}: probability ${key}=${p} > ${max}`)
        }
      }
    }
  }
  return fails
}

export type DriftRow = {
  id: string
  recorded: number | string
  live: number | string
  delta: number | null
  status: 'stable' | 'drifted' | 'broken'
}

export type Report = { model: string; rows: DriftRow[]; broken: number; drifted: number }

/** Build the Program `checkLive` replays a fixture's questions through.
 *
 * `Decision.instructions` (src/ir.ts) is typed `string` — it was designed for prose lowered
 * fresh from a prompt. A `JevQuestion` loaded straight from a fixture may legally carry
 * object-form `instructions` (`EntryType`; the wire contract allows it, and 10 decisions
 * across 2 fixtures in this corpus use it). `q.instructions as never` passes that value
 * through unchanged at runtime — only the static type is asserted, exactly as `criteria`
 * already is below — never coerced with `String()`, which would turn an object into the
 * literal text "[object Object]" and manufacture drift the live API never produced. */
export function buildProgram(f: Fixture): Program {
  return {
    decisions: Object.entries(f.questions).map(([id, q]) => ({
      id, kind: q.type, instructions: q.instructions as never,
      criteria: 'criteria' in q ? (q.criteria as never) : undefined,
    })),
    reduce: { kind: 'rules', rules: [], otherwise: 'n/a' },
    residual: '', dropped: [],
  }
}

/** Diff one fixture's recorded answers against a live answer set. Pure, and exported so the
 * classification (stable / drifted / broken) — including an answer vanishing from the live
 * response, or a new one appearing — can be exercised in a test with no network call.
 *
 * Confidence is part of the comparison for the two kinds that carry it. A choice used to be
 * diffed on its argmax alone, so a fixture whose winner held while confidence fell 0.95 ->
 * 0.15 reported `stable` — the loudest possible signal that a model bump broke the fixture,
 * and the report said nothing. Both numbers are compared against the same `threshold`: the
 * recorded answer is one measurement, and either half of it moving is drift. A noul has no
 * confidence field at all (its probability IS the answer), so it keeps the single comparison.
 * `recorded`/`live` render as `value@confidence` for those two kinds because the status can
 * now be driven by either number — printing only the winner would show a `drifted` row whose
 * recorded and live columns are identical. */
export function diffFixture(f: Fixture, live: Record<string, JevAnswer>, threshold: number): DriftRow[] {
  const rows: DriftRow[] = []

  for (const [id, liveAnswer] of Object.entries(live)) {
    const at = `${f.id}.${id}`
    const was = f.measured.answers[id]
    if (!was) { rows.push({ id: at, recorded: '-', live: 'new', delta: null, status: 'broken' }); continue }
    if (was.type !== liveAnswer.type) {
      rows.push({ id: at, recorded: was.type, live: liveAnswer.type, delta: null, status: 'broken' })
      continue
    }
    if (was.type === 'noul' && liveAnswer.type === 'noul') {
      const delta = Math.abs(was.noul - liveAnswer.noul)
      rows.push({ id: at, recorded: was.noul, live: liveAnswer.noul, delta,
        status: delta > threshold ? 'drifted' : 'stable' })
      continue
    }
    if (was.type === 'choice' && liveAnswer.type === 'choice') {
      const delta = Math.abs(was.confidence - liveAnswer.confidence)
      rows.push({ id: at, recorded: `${was.choice}@${was.confidence}`,
        live: `${liveAnswer.choice}@${liveAnswer.confidence}`, delta,
        status: was.choice !== liveAnswer.choice || delta > threshold ? 'drifted' : 'stable' })
      continue
    }
    if (was.type === 'score' && liveAnswer.type === 'score') {
      // Two independent movements, one row: `delta` reports whichever moved further, and the
      // rendered columns say which it was. Level-index space and confidence share the one
      // threshold deliberately — a 0.15 move is the same size of surprise in either.
      const dScore = Math.abs(was.score - liveAnswer.score)
      const dConfidence = Math.abs(was.confidence - liveAnswer.confidence)
      rows.push({ id: at, recorded: `${was.score}@${was.confidence}`,
        live: `${liveAnswer.score}@${liveAnswer.confidence}`, delta: Math.max(dScore, dConfidence),
        status: dScore > threshold || dConfidence > threshold ? 'drifted' : 'stable' })
      continue
    }
    // Matching types that are none of the three primitives. Both sides are untrusted JSON (a
    // hand-edited fixture, a response off a moving alias), so this is reachable without a type
    // error, and the alternative to a row here is the answer vanishing from the report — the
    // same silence F22 exists to remove. The old arithmetic tail reached it as NaN > threshold,
    // which is false, so an unreadable pair reported `stable`.
    rows.push({ id: at, recorded: was.type, live: liveAnswer.type, delta: null, status: 'broken' })
  }

  // An id the recording has but the live response doesn't is the model no longer answering a
  // question it used to — arguably the single most important thing this report must catch.
  for (const [id, was] of Object.entries(f.measured.answers)) {
    if (id in live) continue
    const recorded = was.type === 'choice' ? was.choice : was.type === 'noul' ? was.noul : was.score
    rows.push({ id: `${f.id}.${id}`, recorded, live: 'missing', delta: null, status: 'broken' })
  }

  return rows
}

/** Re-measure the corpus against the live API and diff against what was recorded.
 * `jev-latest` is an alias that moves under you; this is how a model bump surfaces as a
 * diff in a report rather than as a production incident. Requires TYPESAFE_API_KEY (read
 * by the SDK client `askModel` constructs internally). Never run as part of `npm test`.
 *
 * `askModel`, not `evaluate`: this function's whole output is a classification of what moved,
 * so it must SEE a bad answer set rather than die on it. `evaluate` computes a verdict, and
 * every path to one throws on the first missing answer — `runReducer` via `value`, and
 * `uncertain:` via `isUncertain` for EVERY decision, which fires even when no rule reads the
 * one that vanished. Measured on this corpus: drop one answer from fixture 3 of 60 and the
 * old loop died there with 12 rows collected, cli.ts:149's `.catch` turned it into
 * `check --live failed: ...` and exit 1, and 57 fixtures went unmeasured — a model bump
 * dropping one id destroyed the entire report the tool exists to produce. askModel hands back
 * the incomplete set with the missing ids as issues, so diffFixture classifies them `broken`.
 *
 * The per-fixture try/catch is the other half. askModel still throws — on a program or
 * request the validators refuse, and on transport/auth/quota failures, which are the normal
 * case against a live API — and one of those must cost one fixture, not the run. An
 * unmeasured fixture is `broken` rather than skipped: a report that quietly covers 59 of 60
 * and exits 0 is the failure this function is supposed to detect, one level up. */
export async function checkLive(
  fixtures: Fixture[],
  opts: EvaluateOptions & { driftThreshold?: number } = {},
): Promise<Report> {
  const threshold = opts.driftThreshold ?? 0.15   // well outside the +/-0.01 noise floor
  const rows: DriftRow[] = []
  let model = ''

  for (const f of fixtures) {
    try {
      const res = await askModel(buildProgram(f), f.state, opts)
      model = res.model ?? model
      rows.push(...diffFixture(f, res.answers, threshold))
      // The threshold that matters is the one the corpus recorded, not the flat 0.15: a noul
      // moving 0.96 -> 0.82 is inside no band in particular, but `noul_gte: 0.90` is the gate
      // the fixture was written to hold and crossing it flips the verdict. `broken`, not
      // `drifted`, and that respects the exit policy rather than overriding it — offline
      // `jevc check` already exits 1 when assertExpectation fails against the RECORDED
      // answers (cli.ts:165-171), so the same predicate failing against live answers cannot
      // be exit 0 without the two commands disagreeing about the same corpus. The reason
      // drift is not gated (36 of 60 thresholds moved on the last bump, benign recalibration)
      // does not reach here: an expectation is a band a human chose per fixture, so failing
      // one is a contract break, not a value moving. Overlap with a `live:'missing'` row for
      // the same id is intended — "this id stopped coming back" and "the recorded gate no
      // longer holds" are different findings and a report should carry both.
      for (const fail of assertExpectation(f.expect, res.answers)) {
        rows.push({ id: `${f.id}.expect`, recorded: 'held', live: fail, delta: null, status: 'broken' })
      }
    } catch (e) {
      rows.push({ id: f.id, recorded: 'measurable', live: `unmeasured: ${(e as Error).message}`,
        delta: null, status: 'broken' })
    }
  }

  return {
    model, rows,
    broken: rows.filter(r => r.status === 'broken').length,
    drifted: rows.filter(r => r.status === 'drifted').length,
  }
}
