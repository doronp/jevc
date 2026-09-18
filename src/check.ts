import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { JevAnswer, JevQuestion, JevRequest } from './contract.js'
import { evaluate } from './runtime.js'
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
 * response, or a new one appearing — can be exercised in a test with no network call. */
export function diffFixture(f: Fixture, live: Record<string, JevAnswer>, threshold: number): DriftRow[] {
  const rows: DriftRow[] = []

  for (const [id, liveAnswer] of Object.entries(live)) {
    const was = f.measured.answers[id]
    if (!was) { rows.push({ id: `${f.id}.${id}`, recorded: '-', live: 'new', delta: null, status: 'broken' }); continue }
    if (was.type !== liveAnswer.type) {
      rows.push({ id: `${f.id}.${id}`, recorded: was.type, live: liveAnswer.type, delta: null, status: 'broken' })
      continue
    }
    if (was.type === 'choice' && liveAnswer.type === 'choice') {
      const same = was.choice === liveAnswer.choice
      rows.push({ id: `${f.id}.${id}`, recorded: was.choice, live: liveAnswer.choice, delta: null,
        status: same ? 'stable' : 'drifted' })
      continue
    }
    const a = was.type === 'noul' ? was.noul : (was as { score: number }).score
    const b = liveAnswer.type === 'noul' ? liveAnswer.noul : (liveAnswer as { score: number }).score
    const delta = Math.abs(a - b)
    rows.push({ id: `${f.id}.${id}`, recorded: a, live: b, delta,
      status: delta > threshold ? 'drifted' : 'stable' })
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
 * by the SDK client `evaluate` constructs internally). Never run as part of `npm test`. */
export async function checkLive(fixtures: Fixture[], opts: { driftThreshold?: number } = {}): Promise<Report> {
  const threshold = opts.driftThreshold ?? 0.15   // well outside the +/-0.01 noise floor
  const rows: DriftRow[] = []
  let model = ''

  for (const f of fixtures) {
    const res = await evaluate(buildProgram(f), f.state)
    model = res.model ?? model
    rows.push(...diffFixture(f, res.answers, threshold))
  }

  return {
    model, rows,
    broken: rows.filter(r => r.status === 'broken').length,
    drifted: rows.filter(r => r.status === 'drifted').length,
  }
}
