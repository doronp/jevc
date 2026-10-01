import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MODELS, type JevAnswer, type JevModel, type JevQuestion, type JevRequest } from './contract.js'
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

/** Names the field when it is not a real number, `undefined` when it is. Shared by
 * `assertExpectation` and `diffFixture`: an answer whose payload is absent or non-numeric
 * makes every comparison in both of them false, which reads as health in both. */
const notFinite = (v: unknown, what: string): string | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? undefined
    : `${what} is ${typeof v === 'number' ? String(v) : JSON.stringify(v) ?? String(v)}, not a number`

/** Why an answer's payload cannot be read, `undefined` when it can. Shared by
 * `assertExpectation` (see the note where it is called) and `medianAnswers`, which must not
 * fold an unreadable call into a median that reads as health. An answer type that is none of
 * the three primitives is not judged here; both callers deal with it on their own. */
const unreadable = (a: JevAnswer): string | undefined =>
  a.type === 'noul' ? notFinite(a.noul, 'noul')
    : a.type === 'score' ? notFinite(a.score, 'score') ?? notFinite(a.confidence, 'confidence')
    : a.type === 'choice'
      ? (typeof a.choice === 'string' ? undefined : `choice is ${JSON.stringify(a.choice)}`)
        ?? notFinite(a.confidence, 'confidence')
      : undefined

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
 * band (`_gte`/`_lte`), never equality — identical calls to the API do not return identical
 * answers. Returns one human-readable message per violated clause; an empty array means the
 * expectation held.
 * An unrecognized clause key (a typo, or an operator this function doesn't yet implement) is
 * itself reported as a failure rather than silently skipped — a clause that runs zero
 * assertions passes unconditionally, which is worse than not having the clause at all.
 * `prob_lte` against a probability key absent from the answer is likewise a failure, not a
 * silent pass — a renamed or removed option should not go unnoticed. So is an answer of the
 * right type whose payload is not there: see `unmeasured` below. */
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

    // Checked BEFORE any clause runs, because it would otherwise satisfy all of them at
    // once. Every clause below is a comparison, every comparison against `undefined` or NaN
    // is false, and a clause that fires no failure passes — so `{type: 'noul'}` with no
    // `noul` field held every band in the corpus and the fixture reported health while
    // carrying no measurement. Both sides here are untrusted JSON (a hand-edited fixture, a
    // response off a moving alias), and on the live path validateResponse's
    // `answer_not_a_number` is a report rather than a refusal, so this is reachable.
    const unmeasured = unreadable(a)
    if (unmeasured) { fails.push(`${id}: ${unmeasured}, so no clause can be checked`); continue }

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
  /** `--repeat` above 1 only: the lowest and highest value each compared number took across
   * the calls, `lo..hi`, in the `value@confidence` shape of `live` (a choice lists every winner
   * the calls named). `live` is their median; this says whether one call or all of them moved. */
  range?: string
}

export type Report = {
  /** Every model version that answered during the run, comma-joined. More than one means
   * the `jev-latest` alias moved mid-run and the rows are not all comparable. */
  model: string
  rows: DriftRow[]
  /** Rows the run should fail on: an id that stopped coming back, an answer whose type or
   * payload cannot be read, a fixture that could not be measured at all. */
  broken: number
  /** Rows that moved: a value past the flat threshold, and a recorded `expect` band that no
   * longer holds. Reported, never exit-gated — see the note in `checkLive`. */
  drifted: number
  /** Calls per fixture (`--repeat`). Above 1, every live number in `rows` is a median. */
  repeat?: number
}

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

  // One row, classified. A delta that is not a real number means the pair carries nothing to
  // compare — `{type: 'noul'}` with no `noul` makes `Math.abs(0.95 - undefined)` NaN, and
  // `NaN > threshold` is false, so the row used to read `stable`: the same silence as the
  // alien-type branch at the bottom, one level further in. `broken`, because the answer that
  // came back is unreadable, not because a number moved.
  const push = (at: string, recorded: number | string, liveCol: number | string,
                delta: number, drifted: boolean, readable = true): void => {
    rows.push(readable && Number.isFinite(delta)
      ? { id: at, recorded, live: liveCol, delta, status: drifted || delta > threshold ? 'drifted' : 'stable' }
      : { id: at, recorded, live: liveCol, delta: null, status: 'broken' })
  }

  for (const [id, liveAnswer] of Object.entries(live)) {
    const at = `${f.id}.${id}`
    const was = f.measured.answers[id]
    if (!was) { rows.push({ id: at, recorded: '-', live: 'new', delta: null, status: 'broken' }); continue }
    if (was.type !== liveAnswer.type) {
      rows.push({ id: at, recorded: was.type, live: liveAnswer.type, delta: null, status: 'broken' })
      continue
    }
    if (was.type === 'noul' && liveAnswer.type === 'noul') {
      push(at, was.noul, liveAnswer.noul, Math.abs(was.noul - liveAnswer.noul), false)
      continue
    }
    if (was.type === 'choice' && liveAnswer.type === 'choice') {
      push(at, `${was.choice}@${was.confidence}`, `${liveAnswer.choice}@${liveAnswer.confidence}`,
        Math.abs(was.confidence - liveAnswer.confidence),
        was.choice !== liveAnswer.choice,
        typeof was.choice === 'string' && typeof liveAnswer.choice === 'string')
      continue
    }
    if (was.type === 'score' && liveAnswer.type === 'score') {
      // Two independent movements, one row: `delta` reports whichever moved further, and the
      // rendered columns say which it was. Level-index space and confidence share the one
      // threshold deliberately — a 0.15 move is the same size of surprise in either.
      const dScore = Math.abs(was.score - liveAnswer.score)
      const dConfidence = Math.abs(was.confidence - liveAnswer.confidence)
      // `Math.max` propagates a NaN from either half, so an unreadable score OR an
      // unreadable confidence lands in `push`'s broken branch without a separate flag.
      push(at, `${was.score}@${was.confidence}`, `${liveAnswer.score}@${liveAnswer.confidence}`,
        Math.max(dScore, dConfidence), dScore > threshold || dConfidence > threshold)
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

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const span = (xs: number[]): string => `${Math.min(...xs)}..${Math.max(...xs)}`

/** Each key's median, over the keys EVERY call scored with a real number. A key one call left
 * out is left out here too, so `prob_lte` reports it absent exactly as it would for that call
 * alone, and an option some call never scored cannot win by default. */
const medianProbabilities = (ps: unknown[]): Record<string, number> => {
  const maps = ps.map(p => (typeof p === 'object' && p !== null ? p as Record<string, unknown> : {}))
  const out: Record<string, number> = {}
  for (const key of Object.keys(maps[0])) {
    const vs = maps.map(m => m[key])
    if (vs.every(v => typeof v === 'number' && Number.isFinite(v))) out[key] = median(vs as number[])
  }
  return out
}

type Of<T extends JevAnswer['type']> = Extract<JevAnswer, { type: T }>

/** One answer set standing for `--repeat` calls to the same fixture, so that `diffFixture` and
 * `assertExpectation` run unchanged on it. Identical calls are not guaranteed to return
 * identical answers, and the corpus records one call per fixture, so it does not say how far
 * they move: diffed one call at a time, a call can raise a drift row the next would not. The
 * median of each value does not turn on any one call —
 * noul → median; score → median level and median confidence; choice → each option's median
 * probability, the winner re-derived as the highest of those medians among the options some
 * call named (ties and an empty map explained where it is derived), median confidence.
 * `ranges` carries the min..max beside it, keyed by answer id, for the rows to print.
 *
 * One call comes back exactly as it arrived: the median of one sample is that sample, and
 * rebuilding it would re-derive a choice's winner from its probabilities instead of reporting
 * the one the API named — a different report for the default run, which must not change.
 *
 * A structural fault in ANY of the calls is a finding, not noise, and a median must not average
 * it away. An id some call dropped is left out, so diffFixture reports it `missing` — unless the
 * recording never had it, which is `new` whatever it carries, so the first copy stands in. An
 * answer of the wrong type, or one whose payload cannot be read, is passed on as it came, so it
 * is classified exactly as a single call's would be. None of those gets a range. */
function medianAnswers(f: Fixture, sets: Record<string, JevAnswer>[]):
  { answers: Record<string, JevAnswer>; ranges: Record<string, string> } {
  if (sets.length === 1) return { answers: sets[0], ranges: {} }
  const answers: Record<string, JevAnswer> = {}
  const ranges: Record<string, string> = {}
  for (const id of new Set(sets.flatMap(s => Object.keys(s)))) {
    const got = sets.map(s => s[id])
    const recorded = Object.hasOwn(f.measured.answers, id)
    if (got.some(a => a === undefined)) {
      if (!recorded) answers[id] = got.find(a => a !== undefined)!
      continue
    }
    const all = got as JevAnswer[]
    const type = recorded ? f.measured.answers[id].type : all[0].type
    const odd = all.find(a => a.type !== type || unreadable(a) !== undefined)
    if (odd) { answers[id] = odd; continue }

    if (type === 'noul') {
      const nouls = (all as Of<'noul'>[]).map(a => a.noul)
      answers[id] = { type, noul: median(nouls) }
      ranges[id] = span(nouls)
    } else if (type === 'score') {
      const ss = all as Of<'score'>[]
      const scores = ss.map(a => a.score), confidences = ss.map(a => a.confidence)
      answers[id] = { type, score: median(scores), legend: ss[0].legend,
        probabilities: medianProbabilities(ss.map(a => a.probabilities)), confidence: median(confidences) }
      ranges[id] = `${span(scores)}@${span(confidences)}`
    } else if (type === 'choice') {
      const cs = all as Of<'choice'>[]
      const probabilities = medianProbabilities(cs.map(a => a.probabilities))
      const confidences = cs.map(a => a.confidence)
      // The winner is the option with the highest median among those at least one call named.
      // Over three or more options the medians can peak on an option no call chose (the calls
      // split between two, a third holds steady middling mass in each), and a median standing
      // for N calls must not report an answer none of them gave. A named option some call left
      // unscored has no median and loses to one that has; when no named option has one, the
      // named options all tie, so a payload one call reads cleanly is not `broken` at N > 1.
      // Medians within TIE of the top are a tie, which an even N makes easy: (x + y) / 2 can
      // land one bit off a tie that is exact on paper. A tie goes to the option more calls
      // named, then to the recorded choice, then to the first in sorted order — never to the
      // key order one call's JSON happened to use.
      const TIE = 1e-9
      const names = [...new Set(cs.map(a => a.choice))]
      const p = (k: string) => Object.hasOwn(probabilities, k) ? probabilities[k] : -Infinity
      const top = Math.max(...names.map(p))
      // With no named option scored, top is -Infinity and every name passes.
      const tied = names.filter(k => p(k) >= top - TIE)
      const named = (k: string) => cs.filter(a => a.choice === k).length
      const was = recorded ? (f.measured.answers[id] as Of<'choice'>).choice : undefined
      const [choice] = tied.sort()
        .sort((a, b) => named(b) - named(a) || Number(b === was) - Number(a === was))
      answers[id] = { type, choice, probabilities, confidence: median(confidences) }
      ranges[id] = `${names.join('|')}@${span(confidences)}`
    } else {
      answers[id] = all[0]   // none of the three primitives: diffFixture's alien-type row
    }
  }
  return { answers, ranges }
}

/** The line `jevc check --live` ends on, here for the same reason liveOptions is. The model
 * list is whatever the responses named, so it is quoted the way the rows above it are, and a
 * run in which no response named one says so rather than printing "against :". A run of more
 * than one call per fixture says its numbers are medians; a one-call run reads as it always did. */
export function liveSummary(r: Pick<Report, 'model' | 'rows' | 'drifted' | 'broken' | 'repeat'>): string {
  const against = r.model === '' ? 'no named model' : JSON.stringify(r.model)
  const each = (r.repeat ?? 1) > 1 ? `, median of ${r.repeat} calls per fixture` : ''
  return `${r.rows.length} rows checked live against ${against}${each}: ${r.drifted} drifted, ${r.broken} broken\n`
}

/** The most calls `--repeat` may ask of each fixture. The cost is linear and all of it is
 * spent: a run makes N x fixtures calls, one after another — 580 for `--repeat 10` on the
 * packaged 58 — so every step of N is one more full pass over the corpus. And ten is already
 * enough to answer the question the flag exists for: a median of ten ignores up to four calls
 * that moved on their own, and the range printed beside it shows one outlier from a shift. */
export const MAX_REPEAT = 10

/** `jevc check --live --model <id> --threshold <n> --repeat <n>`, validated into checkLive's options.
 * Here rather than in cli.ts because cli.ts runs on import: this is the seam a test reaches
 * with no key and no network. Throws a sentence the CLI prints as-is.
 *
 * `--model` is one of MODELS, the same list validateRequest enforces on the wire. The
 * threshold range comes from diffFixture's `delta > threshold`: noul and confidence deltas
 * live in 0..1, so at 1 or above neither can ever drift and the run goes silent on exactly
 * the movement it exists to report; below 0 an identical answer (delta 0) is drift. 0 itself
 * is legal and means "any movement at all", noise floor included. */
export function liveOptions(model: string | undefined, threshold: string | undefined, repeat?: string):
  { model?: JevModel; driftThreshold?: number; repeat?: number } {
  const out: { model?: JevModel; driftThreshold?: number; repeat?: number } = {}
  if (model !== undefined) {
    if (!MODELS.includes(model as JevModel)) {
      throw new Error(`--model "${model}" is not a model jevc can ask. Expected one of: ${MODELS.join(', ')}.`)
    }
    out.model = model as JevModel
  }
  if (threshold !== undefined) {
    const t = Number(threshold)
    // Number(), not parseFloat: parseFloat reads "0.3abc" as 0.3 and a typo runs silently.
    // Number(" ") is 0, hence the blank check.
    if (threshold.trim() === '' || !Number.isFinite(t) || t < 0 || t >= 1) {
      throw new Error(`--threshold "${threshold}" must be a number in [0, 1): noul and confidence deltas never exceed 1, so 1 or more reports no drift on them at all.`)
    }
    out.driftThreshold = t
  }
  if (repeat !== undefined) {
    // Digits only. Number() alone takes "1e1", "0x5" and " 3" as whole numbers, and a count of
    // paid calls is no place for a spelling the reader has to evaluate.
    if (!/^[0-9]+$/.test(repeat) || Number(repeat) < 1 || Number(repeat) > MAX_REPEAT) {
      throw new Error(`--repeat "${repeat}" must be a whole number from 1 to ${MAX_REPEAT}: it is how many calls each fixture gets, and a run makes that many times as many calls as there are fixtures.`)
    }
    out.repeat = Number(repeat)
  }
  return out
}

/** Re-measure the corpus against the live API and diff against what was recorded.
 * The model asked is PINNED_MODEL unless `--model` names another; a response from any model
 * but the pin gets a `<fixture>.model` row, so a model bump surfaces as a diff in a report
 * rather than as a production incident. Requires TYPESAFE_API_KEY (read
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
 * and exits 0 is the failure this function is supposed to detect, one level up.
 *
 * `repeat` (`--repeat`, default 1) asks each fixture that many times and diffs the median of
 * the answers (see `medianAnswers`), so that no drift row turns on one call, and the min..max
 * beside it shows how far the n answers moved. Everything below still runs once
 * per fixture, on the median — except the model guard, which reads every response.
 *
 * ponytail: one failed call of the N costs the whole fixture (one `unmeasured` row), and the
 * N calls run one after another. Ceiling: a flaky endpoint loses more fixtures at a high N,
 * and a run takes N times as long. Upgrade: a median over the calls that did answer, printed
 * with its own count, and a fixture's N calls issued together once the rate limit is known. */
export async function checkLive(
  fixtures: Fixture[],
  opts: EvaluateOptions & { driftThreshold?: number; repeat?: number } = {},
): Promise<Report> {
  // The corpus records one call per fixture, so it does not say how far answers move between
  // identical calls; `repeat`'s median and min..max measure that.
  const threshold = opts.driftThreshold ?? 0.15
  const repeat = opts.repeat ?? 1
  // The bound liveOptions puts on `--repeat`, here too: this function is public, and a caller
  // that never went through the CLI could otherwise ask for 0 calls (every answer then reads
  // `missing`), 2.5 (three calls), or a count of paid calls with no ceiling. Thrown before the
  // first call, so the per-fixture catch below never turns it into a report.
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) {
    throw new Error(`checkLive: repeat must be a whole number from 1 to ${MAX_REPEAT}, got ${typeof repeat === 'number' ? String(repeat) : JSON.stringify(repeat)}.`)
  }
  const rows: DriftRow[] = []
  // Every model that answered, in the order they first answered — not just the last one.
  // This used to be `model = res.model ?? model`, so an alias bump PART WAY THROUGH the run
  // left every row in the report attributed to whichever build happened to answer last,
  // including the rows measured before the bump. Attributing a behaviour change to a model
  // change is the entire point of `--live`, and a mid-run bump was the one case it got wrong.
  const models = new Set<string>()

  for (const f of fixtures) {
    try {
      const program = buildProgram(f)
      const sets: Record<string, JevAnswer>[] = []
      const answerers = new Set<string>()
      for (let call = 0; call < repeat; call++) {
        const res = await askModel(program, f.state, opts)
        const named = typeof res.model === 'string' && res.model !== '' ? res.model : undefined
        if (named) models.add(named)
        // Who answered gets its own row, ahead of what moved, on the fixture that saw it. A
        // non-Jev answerer is `broken` (exit 1): every number below would be a diff against a
        // model this corpus never described. Another Jev build, or an ID JEVC_ALLOW_MODEL
        // accepts, is `drifted`: worth a line, not a failed run. A non-string is never printed.
        // Checked on EVERY response, not the first: a stranger answering call 3 of 5 is still a
        // stranger, and the median below would blend its answers in without a word. One row
        // per answerer, though — the same build five times is one finding, not five.
        for (const i of res.issues.filter(i => i.code === 'model_unexpected')) {
          const row: DriftRow = { id: `${f.id}.model`, recorded: f.measured.model, live: named ?? 'none',
            delta: null, status: i.severity === 'error' ? 'broken' : 'drifted' }
          const key = JSON.stringify([row.live, row.status])
          if (!answerers.has(key)) { answerers.add(key); rows.push(row) }
        }
        sets.push(res.answers)
      }
      const { answers, ranges } = medianAnswers(f, sets)
      const spread = (row: DriftRow, id: string): DriftRow =>
        Object.hasOwn(ranges, id) ? { ...row, range: ranges[id] } : row
      // Every diffFixture row id is `<fixture>.<answer id>`.
      rows.push(...diffFixture(f, answers, threshold).map(r => spread(r, r.id.slice(f.id.length + 1))))
      // The threshold that matters is the one the corpus recorded, not the flat 0.15: a noul
      // moving 0.96 -> 0.82 is inside no band in particular, but `noul_gte: 0.90` is the gate
      // the fixture was written to hold and crossing it flips the verdict. So it gets a row.
      //
      // `drifted`, NOT `broken`, so it does not gate the exit (cli.ts exits on `broken`).
      // These rows were `broken`, and the argument was symmetry with offline `jevc check`,
      // which exits 1 on the same predicate over the RECORDED answers. The two are not
      // symmetric: offline compares a recording against itself and cannot fail spuriously,
      // while this compares it against a live model (`--model jev-latest` is a moving alias,
      // and even the pin is a server someone else runs). Measured over this corpus: of the 324
      // numeric expectation bounds, 208 have LESS headroom than the 0.15 this very function
      // defines as drift, the median bound has 0.120 of headroom, 12 have under 0.05, and
      // `agent-goal-drift-ci-secret-exfil.next_action_serves_user_request` sits exactly on
      // its bound (0.000). So a benign recalibration smaller than one drift threshold would
      // have marked most of the corpus `broken` and exited 1 — and `broken`, whose job is
      // "the model stopped answering a question it used to", would have been drowned in it.
      // Everything structural still exits 1 on its own row: a vanished id, a changed answer
      // type and an unreadable payload are all `broken` out of diffFixture above.
      //
      // Overlap with a `live:'missing'` row for the same id is intended — "this id stopped
      // coming back" and "the recorded gate no longer holds" are different findings and a
      // report should carry both.
      //
      // Asked one answer id at a time only so each failure knows whose range to carry; the
      // messages and their order are what one call over the whole expectation returns.
      for (const [id, clause] of Object.entries(f.expect)) {
        for (const fail of assertExpectation({ [id]: clause }, answers)) {
          rows.push(spread({ id: `${f.id}.expect`, recorded: 'held', live: fail, delta: null, status: 'drifted' }, id))
        }
      }
    } catch (e) {
      rows.push({ id: f.id, recorded: 'measurable', live: `unmeasured: ${(e as Error).message}`,
        delta: null, status: 'broken' })
    }
  }

  return {
    // Joined rather than reduced to one: a run that spans two builds must say so, because
    // half its rows were measured against a model the other half never saw.
    model: [...models].join(', '),
    rows,
    repeat,
    broken: rows.filter(r => r.status === 'broken').length,
    drifted: rows.filter(r => r.status === 'drifted').length,
  }
}
