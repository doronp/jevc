import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { JevAnswer, JevQuestion, JevRequest } from './contract.js'
import { evaluate } from './runtime.js'
import type { Program } from './ir.js'

export type Expectation = Record<string, {
  noul_gte?: number; noul_lte?: number
  score_gte?: number; score_lte?: number
  confidence_gte?: number
  choice?: string
}>

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
    const doc = JSON.parse(readFileSync(join(dir, file), 'utf8'))
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
 * one human-readable message per violated clause; an empty array means the expectation held. */
export function assertExpectation(
  exp: Expectation,
  answers: Record<string, JevAnswer>,
): string[] {
  const fails: string[] = []
  for (const [id, clause] of Object.entries(exp)) {
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

/** Re-measure the corpus against the live API and diff against what was recorded.
 * `jev-latest` is an alias that moves under you; this is how a model bump surfaces as a
 * diff in a report rather than as a production incident. Requires TYPESAFE_API_KEY (read
 * by the SDK client `evaluate` constructs internally). Never run as part of `npm test`. */
export async function checkLive(fixtures: Fixture[], opts: { driftThreshold?: number } = {}): Promise<Report> {
  const threshold = opts.driftThreshold ?? 0.15   // well outside the +/-0.01 noise floor
  const rows: DriftRow[] = []
  let model = ''

  for (const f of fixtures) {
    const program: Program = {
      decisions: Object.entries(f.questions).map(([id, q]) => ({
        id, kind: q.type, instructions: String(q.instructions),
        criteria: 'criteria' in q ? (q.criteria as never) : undefined,
      })),
      reduce: { kind: 'rules', rules: [], otherwise: 'n/a' },
      residual: '', dropped: [],
    }
    const res = await evaluate(program, f.state)
    model = res.model ?? model

    for (const [id, live] of Object.entries(res.answers)) {
      const was = f.measured.answers[id]
      if (!was) { rows.push({ id: `${f.id}.${id}`, recorded: '-', live: 'new', delta: null, status: 'broken' }); continue }
      if (was.type !== live.type) {
        rows.push({ id: `${f.id}.${id}`, recorded: was.type, live: live.type, delta: null, status: 'broken' })
        continue
      }
      if (was.type === 'choice' && live.type === 'choice') {
        const same = was.choice === live.choice
        rows.push({ id: `${f.id}.${id}`, recorded: was.choice, live: live.choice, delta: null,
          status: same ? 'stable' : 'drifted' })
        continue
      }
      const a = was.type === 'noul' ? was.noul : (was as { score: number }).score
      const b = live.type === 'noul' ? live.noul : (live as { score: number }).score
      const delta = Math.abs(a - b)
      rows.push({ id: `${f.id}.${id}`, recorded: a, live: b, delta,
        status: delta > threshold ? 'drifted' : 'stable' })
    }
  }

  return {
    model, rows,
    broken: rows.filter(r => r.status === 'broken').length,
    drifted: rows.filter(r => r.status === 'drifted').length,
  }
}
