#!/usr/bin/env node
/**
 * Re-record fixtures whose questions were fixed, from a staging file (see
 * `fixtures-staging/`). One live call per staged entry, pinned to PINNED_MODEL; each answered
 * fixture gets its staged questions, expect and (where staged) state and rationale, plus a
 * `measured` block marked `pending-review` for a person to accept or reject.
 *
 *   TYPESAFE_API_KEY=... npx tsx scripts/rerecord.ts <staging.json> [--dry-run] [--only <id>]
 *
 * `--dry-run` validates the staging file and prints what each entry would change and send. It
 * makes no call, needs no key, and writes nothing. `test/rerecord.test.ts` runs every mode
 * against a stub client and a scratch copy of fixtures/.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { TypeSafeClient } from '@typesafe-ai/sdk'
import { assertExpectation, buildProgram, type Expectation, type Fixture } from '../src/check.js'
import {
  PINNED_MODEL, estimateTokens, validateRequest,
  type JevAnswer, type JevQuestion, type JevRequest,
} from '../src/contract.js'
import { emitJson } from '../src/emit/json.js'
import { validateProgram } from '../src/ir.js'
import { quoted } from '../src/quote.js'
import { askModel } from '../src/runtime.js'

export type StagedEntry = {
  domain_file: string
  id: string
  questions: Record<string, JevQuestion>
  expect: Expectation
  state?: JevRequest['state']
  rationale?: string
  change_note: string
}

type Recorded = Record<string, unknown> & { id: string; questions: Record<string, JevQuestion>; expect: Expectation; state: JevRequest['state']; rationale: string }
export type Resolved = { entry: StagedEntry; recorded: Recorded }

const ENTRY_KEYS = new Set(['domain_file', 'id', 'questions', 'expect', 'state', 'rationale', 'change_note'])

// The messages assertExpectation emits when a clause cannot apply to the question it is
// attached to at all, as opposed to a band the answer merely missed. Run against a synthetic
// answer of the question's own type, only these can fire for a clause that is well-formed.
const STRUCTURAL = /: (unrecognized expectation clause|expected a (noul|score|choice|choice or score), got \w+$|a noul carries no confidence|no probability recorded for)/

/** An answer of `q`'s type with every probability key the question can produce, so that
 * assertExpectation reports only clause/question mismatches (see STRUCTURAL). */
function synthetic(q: JevQuestion): JevAnswer {
  if (q.type === 'noul') return { type: 'noul', noul: 0.5 }
  const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i))
  const probabilities = Object.fromEntries(keys.map(k => [k, 0]))
  return q.type === 'choice'
    ? { type: 'choice', choice: keys[0], confidence: 0.5, probabilities }
    : { type: 'score', score: 0, confidence: 0.5, legend: {}, probabilities } as JevAnswer
}

/** Every way `expect` cannot be a band over `questions`: keys that differ, clauses that do not
 * fit the question type, names that are not options, numbers outside the answer's range. */
function expectProblems(id: string, questions: Record<string, JevQuestion>, exp: Expectation): string[] {
  const out: string[] = []
  const missing = Object.keys(questions).filter(k => !(k in exp))
  const extra = Object.keys(exp).filter(k => !(k in questions))
  if (missing.length || extra.length) {
    const parts = [missing.length && `missing: ${missing.join(', ')}`, extra.length && `extra: ${extra.join(', ')}`]
    out.push(`${id}: expect keys differ from question keys (${parts.filter(Boolean).join('; ')})`)
  }
  for (const [qid, clause] of Object.entries(exp)) {
    const q = questions[qid]
    if (!q) continue
    if (!clause || typeof clause !== 'object' || !Object.keys(clause).length) {
      out.push(`${id}.${qid}: a clause must be a non-empty object`)
      continue
    }
    out.push(...assertExpectation({ [qid]: clause }, { [qid]: synthetic(q) })
      .filter(m => STRUCTURAL.test(m)).map(m => `${id}.${m}`))
    const top = q.type === 'score' ? q.criteria.length - 1 : 1
    const range = (key: string, v: unknown, hi: number) => {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > hi) {
        out.push(`${id}.${qid}: ${key} ${JSON.stringify(v)} is outside [0, ${hi}]`)
      }
    }
    for (const key of ['noul_gte', 'noul_lte', 'confidence_gte', 'confidence_lte'] as const) {
      if (clause[key] !== undefined) range(key, clause[key], 1)
    }
    for (const key of ['score_gte', 'score_lte'] as const) {
      if (clause[key] !== undefined) range(key, clause[key], top)
    }
    for (const [k, v] of Object.entries(clause.prob_lte ?? {})) range(`prob_lte.${k}`, v, 1)
    for (const [lo, hi] of [['noul_gte', 'noul_lte'], ['score_gte', 'score_lte'], ['confidence_gte', 'confidence_lte']] as const) {
      if ((clause[lo] ?? -Infinity) > (clause[hi] ?? Infinity)) out.push(`${id}.${qid}: ${lo} > ${hi}, an empty band`)
    }
    if (q.type === 'choice') {
      for (const name of [clause.choice, ...(clause.choice_in ?? [])]) {
        if (name !== undefined && !(name in q.criteria)) out.push(`${id}.${qid}: "${name}" is not an option`)
      }
    }
  }
  return out
}

/** Validate a staging document against the fixtures under `root`, with the validators the
 * corpus itself is held to: the wire contract, the program validator, and expectation shape.
 * Returns every problem found and, for each entry, the recorded fixture it replaces. */
export function validateStaging(doc: unknown, root: string): { problems: string[]; resolved: Resolved[] } {
  const problems: string[] = []
  const resolved: Resolved[] = []
  const d = doc as { purpose?: unknown; base?: unknown; entries?: unknown }
  if (typeof d?.purpose !== 'string' || typeof d.base !== 'string' || !Array.isArray(d.entries)) {
    return { problems: ['staging file needs a string "purpose", a string "base" and an "entries" array'], resolved }
  }
  const seen = new Set<string>()
  for (const [i, e] of (d.entries as StagedEntry[]).entries()) {
    const id = typeof e?.id === 'string' ? e.id : `entries[${i}]`
    const bad = (m: string) => problems.push(`${id}: ${m}`)
    const unknown = Object.keys(e ?? {}).filter(k => !ENTRY_KEYS.has(k))
    if (unknown.length) bad(`unknown entry keys: ${unknown.join(', ')}`)
    if (seen.has(id)) bad('staged twice')
    seen.add(id)
    if (typeof e.change_note !== 'string' || !e.change_note.trim()) bad('needs a non-empty change_note')
    if ('rationale' in e && (typeof e.rationale !== 'string' || !e.rationale.trim())) bad('a staged rationale must be a non-empty string')
    if (!e.questions || typeof e.questions !== 'object' || !e.expect || typeof e.expect !== 'object') {
      bad('needs "questions" and "expect" objects')
      continue
    }
    // The live run writes to this path, so it is held to one file directly under fixtures/.
    if (typeof e.domain_file !== 'string' || !/^fixtures\/[\w.-]+\.json$/.test(e.domain_file)) {
      bad(`domain_file must name a file directly under fixtures/, got ${JSON.stringify(e.domain_file)}`)
      continue
    }
    let fixtures: Recorded[]
    try {
      fixtures = JSON.parse(readFileSync(join(root, e.domain_file), 'utf8')).fixtures
    } catch (err) {
      bad(`cannot read ${e.domain_file}: ${(err as Error).message}`)
      continue
    }
    const recorded = fixtures.find(f => f.id === e.id)
    if (!recorded) { bad(`no fixture with this id in ${e.domain_file}`); continue }

    const state = e.state ?? recorded.state
    for (const iss of validateRequest({ model: PINNED_MODEL, state, questions: e.questions })) {
      if (iss.severity === 'error') bad(`request ${iss.path}: ${iss.message}`)
    }
    for (const iss of validateProgram(buildProgram({ questions: e.questions } as Fixture))) {
      if (iss.severity === 'error') bad(`program ${iss.path}: ${iss.message}`)
    }
    problems.push(...expectProblems(id, e.questions, e.expect))
    resolved.push({ entry: e, recorded })
  }
  return { problems, resolved }
}

const changedKeys = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  Object.keys(b).filter(k => k in a && !isDeepStrictEqual(a[k], b[k]))
const list = (ks: string[]) => ks.length ? ks.join(', ') : '-'
const num = (n: number) => n.toLocaleString('en-US')

function requestSize(questions: Record<string, JevQuestion>, state: JevRequest['state']) {
  const req = emitJson(buildProgram({ questions } as Fixture), state)
  return { bytes: Buffer.byteLength(JSON.stringify(req)), tokens: estimateTokens(req) }
}

function dryRunReport({ entry: e, recorded: r }: Resolved): string {
  const now = requestSize(e.questions, e.state ?? r.state)
  const was = requestSize(r.questions, r.state)
  const row = (k: string, v: string) => `  ${(k + ':').padEnd(20)}${v}`
  return [
    `${e.id} (${e.domain_file})`,
    row('questions added', list(Object.keys(e.questions).filter(k => !(k in r.questions)))),
    row('questions removed', list(Object.keys(r.questions).filter(k => !(k in e.questions)))),
    row('questions changed', list(changedKeys(r.questions, e.questions))),
    row('expect changed', list([...new Set([...changedKeys(r.expect, e.expect),
      ...Object.keys(e.expect).filter(k => !(k in r.expect)),
      ...Object.keys(r.expect).filter(k => !(k in e.expect))])])),
    row('state changes', 'state' in e && !isDeepStrictEqual(e.state, r.state) ? 'yes' : 'no'),
    row('rationale changes', 'rationale' in e && e.rationale !== r.rationale ? 'yes' : 'no'),
    row('request', `${num(now.bytes)} bytes, ~${num(now.tokens)} tokens (recorded: ${num(was.bytes)} bytes, ~${num(was.tokens)} tokens)`),
    '',
  ].join('\n')
}

/** Replace top-level fields of one fixture in a `JSON.stringify(doc, null, 2)` file WITHOUT
 * re-serialising anything else. A whole-file stringify is not byte-stable here: three
 * untouched fixtures carry floats written `1.0`, which JSON.parse/stringify turns into `1`,
 * and the absent trailing newline is easy to lose. At that indent a fixture opens with
 * `    {` and its fields start at exactly six spaces; every nested line is deeper and every
 * string is on one line, so a six-space `"key": ` line can only be a field of the fixture. */
function spliceFixture(text: string, fixture: Recorded, fields: Record<string, unknown>): string {
  const head = `    {\n      "id": ${JSON.stringify(fixture.id)},`
  const start = text.indexOf(head)
  if (start < 0 || text.indexOf(head, start + 1) >= 0) throw new Error(`${fixture.id}: cannot locate the fixture uniquely in the file`)
  const end = text.indexOf('\n    }', start)
  const last = Object.keys(fixture).at(-1)
  const out: string[] = []
  const done = new Set<string>()
  let skipping = false
  for (const line of text.slice(start, end).split('\n')) {
    const key = /^ {6}"([^"]+)": /.exec(line)?.[1]
    if (key !== undefined) skipping = key in fields
    if (key !== undefined && key in fields) {
      const value = JSON.stringify(fields[key], null, 2).split('\n').join('\n      ')
      out.push(`      ${JSON.stringify(key)}: ${value}${key === last ? '' : ','}`)
      done.add(key)
    } else if (!skipping) out.push(line)
  }
  const lost = Object.keys(fields).filter(k => !done.has(k))
  if (lost.length) throw new Error(`${fixture.id}: fields not found in the file: ${lost.join(', ')}`)
  return text.slice(0, start) + out.join('\n') + text.slice(end)
}

/** One row per bound: `prob_lte` splits into one per option, because each can hold or miss
 * on its own. `held` is assertExpectation's verdict on that bound alone. */
function tableRows(id: string, exp: Expectation, answers: Record<string, JevAnswer>): string[][] {
  const rows: string[][] = []
  for (const [qid, clause] of Object.entries(exp)) {
    const a = answers[qid] as JevAnswer & { noul?: number; score?: number; confidence?: number; choice?: string; probabilities?: Record<string, number> }
    const bounds: Array<[string, unknown, unknown, Expectation[string]]> = []
    for (const [key, bound] of Object.entries(clause)) {
      if (key === 'prob_lte') {
        for (const [k, max] of Object.entries(bound as Record<string, number>)) {
          bounds.push([`prob_lte.${k}`, max, a?.probabilities?.[k], { prob_lte: { [k]: max } }])
        }
        continue
      }
      const measured = key.startsWith('noul') ? a?.noul : key.startsWith('score') ? a?.score
        : key.startsWith('confidence') ? a?.confidence : a?.choice
      bounds.push([key, bound, measured, { [key]: bound }])
    }
    for (const [key, bound, measured, one] of bounds) {
      const held = assertExpectation({ [qid]: one }, answers).length === 0
      rows.push([`${id}.${qid}`, key, Array.isArray(bound) ? bound.join('|') : String(bound), String(measured), held ? 'held' : 'MISSED'])
    }
  }
  return rows
}

export type Io = {
  env: Record<string, string | undefined>
  out: (s: string) => void
  err: (s: string) => void
  /** Stub seam for tests. Absent, askModel builds the SDK client, which reads the key itself. */
  client?: TypeSafeClient
  /** Repo root holding fixtures/. Defaults to the working directory. */
  root?: string
  now?: () => number
  /** The date written into `measured.notes`. Defaults to today (UTC). */
  today?: string
}

export async function main(argv: string[], io: Io): Promise<number> {
  const fail = (m: string) => { io.err(`rerecord: ${m}`); return 1 }
  let file: string | undefined
  let only: string | undefined
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') dryRun = true
    else if (a === '--only' && argv[i + 1] && !argv[i + 1].startsWith('--')) only = argv[++i]
    else if (a.startsWith('--') || file !== undefined) return fail(`unexpected argument ${JSON.stringify(a)}. Usage: rerecord <staging.json> [--dry-run] [--only <id>]`)
    else file = a
  }
  if (file === undefined) return fail('usage: rerecord <staging.json> [--dry-run] [--only <id>]')
  // Checked before anything is read: without a key a live run can only fail, and failing
  // after reading and validating would look like progress. The key's VALUE is never read
  // into anything but the scrub below; the SDK client takes it from the environment itself.
  const key = io.env.TYPESAFE_API_KEY
  if (!dryRun && !key) {
    return fail('TYPESAFE_API_KEY is not set. A live re-record needs it; use --dry-run to validate the staging file without calling the API.')
  }
  const scrub = (m: string) => key ? m.split(key).join('[redacted]') : m

  const root = io.root ?? process.cwd()
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(resolve(file), 'utf8'))
  } catch (e) {
    return fail(`cannot read ${file}: ${(e as Error).message}`)
  }
  const { problems, resolved } = validateStaging(doc, root)
  if (problems.length) {
    for (const p of problems) io.err(`  ${p}`)
    return fail(`${problems.length} problem(s) in ${file}; nothing called, nothing written.`)
  }
  const selected = only === undefined ? resolved : resolved.filter(r => r.entry.id === only)
  if (!selected.length) return fail(`--only ${only}: no staged entry has that id.`)

  if (dryRun) {
    for (const r of selected) io.out(dryRunReport(r))
    io.out(`${selected.length} ${selected.length === 1 ? 'entry' : 'entries'} valid, 0 calls made.`)
    return 0
  }

  // All calls first, then all writes: one bad answer set leaves every file untouched, and the
  // first failure stops the run so no further paid call is made for answers that cannot land.
  const today = io.today ?? new Date().toISOString().slice(0, 10)
  const answered: Array<Resolved & { measured: Record<string, unknown>; answers: Record<string, JevAnswer> }> = []
  for (const r of selected) {
    const { entry: e } = r
    let res
    try {
      res = await askModel(buildProgram({ questions: e.questions } as Fixture), e.state ?? r.recorded.state, {
        client: io.client, model: PINNED_MODEL, now: io.now,
        // A recording is not a guardrail on a hot path: the latency is what gets measured, so a
        // slow answer is data, not a failure. The recorded maximum is 2,584 ms.
        timeoutMs: 30_000,
      })
    } catch (err) {
      return fail(`${e.id}: ${scrub((err as Error).message)}\nnothing written.`)
    }
    const why = res.issues.filter(i => i.severity === 'error').map(i => `${i.code} at ${i.path}: ${i.message}`)
    // Not left to validateResponse: another Jev build is only a WARN there, and
    // JEVC_ALLOW_MODEL can downgrade a named non-Jev model to one. Either would record an
    // answer from a model the corpus does not claim under a pin it does. The type says string;
    // the wire does not, and only a string is quoted (a missing model is already an error above).
    const model: unknown = res.model
    if (model !== PINNED_MODEL) {
      why.push(`answered by ${typeof model === 'string' ? quoted(model) : 'no named model'}, not ${PINNED_MODEL}`)
    }
    const unasked = Object.keys(res.answers).filter(k => !(k in e.questions))
    if (unasked.length) why.push(`answers to questions not asked: ${unasked.map(quoted).join(', ')}`)
    if (why.length) return fail(`${e.id}: refusing this answer set:\n${why.map(w => `  ${scrub(w)}`).join('\n')}\nnothing written.`)
    answered.push({
      ...r,
      answers: res.answers,
      measured: {
        answers: JSON.stringify(res.answers),
        latency_ms: res.latencyMs,
        model: res.model,
        verdict: 'pending-review',
        prediction_held: assertExpectation(e.expect, res.answers).length === 0,
        notes: `Re-recorded ${today} after question fixes: ${e.change_note}`,
      },
    })
  }

  const texts = new Map<string, string>()
  for (const { entry: e, recorded, measured } of answered) {
    const path = join(root, e.domain_file)
    const text = texts.get(path) ?? readFileSync(path, 'utf8')
    const fields: Record<string, unknown> = { questions: e.questions, expect: e.expect, measured }
    if ('state' in e) fields.state = e.state
    if ('rationale' in e) fields.rationale = e.rationale
    const next = spliceFixture(text, recorded, fields)
    // The splice is text surgery, so the parsed result is checked against what it was meant
    // to produce before anything touches the disk.
    const want = JSON.parse(text)
    want.fixtures = want.fixtures.map((f: Recorded) => f.id === e.id
      ? Object.fromEntries(Object.keys(f).map(k => [k, k in fields ? fields[k] : f[k]])) : f)
    if (JSON.stringify(JSON.parse(next)) !== JSON.stringify(want)) return fail(`${e.id}: splice did not produce the intended document; nothing written.`)
    texts.set(path, next)
  }
  // ponytail: one writeFileSync per domain file, not an atomic multi-file commit; a crash
  // between two writes leaves some files re-recorded. git restores them; use temp+rename if
  // this ever runs somewhere git is not.
  for (const [path, text] of texts) writeFileSync(path, text)

  const rows = [['bound', 'clause', 'expected', 'measured', 'result'],
    ...answered.flatMap(a => tableRows(a.entry.id, a.entry.expect, a.answers))]
  const widths = rows[0].map((_, c) => Math.max(...rows.map(r => r[c].length)))
  for (const r of rows) io.out(r.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd())
  const missed = rows.filter(r => r[4] === 'MISSED').length
  io.out(`\n${answered.length} fixture(s) re-recorded as pending-review; ${missed} bound(s) missed. ` +
    'Bands are not widened here: a MISSED row is a question for the reviewer, not an edit.')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env, out: s => console.log(s), err: s => console.error(s),
  })
}
