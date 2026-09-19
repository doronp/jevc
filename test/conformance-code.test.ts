/**
 * Conformance of the CODE targets — `sdk`/native, `ai-sdk`, `langchain`, `json` — against
 * `runReducer`, which is the reference semantics (src/runtime.ts:75-101).
 *
 * The code targets have a property the policy targets do not: the artifact is EXECUTABLE.
 * So the question "does the emitted thing mean what the Program means" is answerable by
 * running it, rather than by grepping the text it was serialised into. Every assertion
 * here goes through `test/helpers/artifacts.ts`, which spawns the real `tsc` and the real
 * `python3` over the artifact BYTE-FOR-BYTE as `jevc compile` writes it.
 *
 * Sources transcribed here, cited at each use:
 *   - src/runtime.ts               — `runReducer`, `value`, `choiceOf`, `isUncertain`
 *   - src/ir.ts                    — `uncertaintyOf` defaults, `validateProgram`
 *   - src/contract.ts              — `validateRequest`, `validateResponse`, wire limits
 *   - docs/targets/target-ai-sdk-and-langchain.md §A.3, §A.4, §B.3 — the two consumers'
 *     verified ANSWER shapes, which is what the emitted reducers are fed here
 *
 * A test in this file that fails is a live bug. It is left failing and named `LIVE BUG`.
 */
import { describe, it, expect, afterAll } from 'vitest'
import {
  cleanupArtifacts, parsePyBatch, pythonAvailable, runPy, runPyScript, runTs, typecheckBatch,
} from './helpers/artifacts.js'
import { emitAiSdk } from '../src/emit/ai-sdk.js'
import { emitJson, toQuestion } from '../src/emit/json.js'
import { emitLangchain } from '../src/emit/langchain.js'
import { emitNative } from '../src/emit/native.js'
import { validateProgram } from '../src/ir.js'
import { validateRequest, validateResponse } from '../src/contract.js'
import { runReducer } from '../src/runtime.js'
import type { JevAnswer, JevQuestion, JevRequest } from '../src/contract.js'
import type { Program } from '../src/ir.js'

afterAll(cleanupArtifacts)

const SLOW = 180_000

// ---------------------------------------------------------------------------
// 1. Every condition op, every kind, executed — not read.
// ---------------------------------------------------------------------------

/**
 * One Program exercising the whole reducer vocabulary at once, because the bugs this
 * file exists for are interaction bugs: a rule ORDER the consumer evaluates differently,
 * a conjunction lowered onto a disjunction, a threshold compared in the wrong space.
 *
 *   rule 0  radius >= 2 AND urgent >= 0.8   -> deny      (conjunction, two kinds)
 *   rule 1  dept is billing AND urgent <= 0.2 AND radius <= 1 -> queue  (three conditions)
 *   rule 2  urgent uncertain                -> hold      (noul band, the default [0.35,0.65])
 *   rule 3  dept uncertain                  -> ask       (declared belowConfidence 0.6)
 *   rule 4  radius uncertain                -> review    (default belowConfidence 0.5)
 *   rule 5  dept is other                   -> triage    (`is` as a sole condition)
 *   rule 6  urgent >= 1                     -> certain   (threshold exactly at the top)
 *   rule 7  radius <= 0                     -> noop      (threshold exactly at the bottom)
 *   rule 8  dept >= 0.9                     -> route     (gte against a CHOICE = its confidence)
 *   otherwise                               -> allow
 *
 * Rule 0 sits before rule 2 and rule 6 before rule 8 deliberately: first-match-wins is
 * the semantics (src/runtime.ts:76-99), and a target that evaluates rules in another
 * order answers differently only when an earlier and a later rule both match.
 */
const vocabulary: Program = {
  decisions: [
    { id: 'urgent', kind: 'noul', instructions: 'Is the request urgent?' },
    { id: 'dept', kind: 'choice', instructions: 'Which team owns this?',
      criteria: { billing: 'payments', technical: 'bugs', other: 'anything else' },
      uncertain: { belowConfidence: 0.6 } },
    { id: 'radius', kind: 'score', instructions: 'How wide is the blast radius?',
      criteria: ['none', 'single file', 'directory', 'whole system'] },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'radius', op: 'gte', value: 2 }, { id: 'urgent', op: 'gte', value: 0.8 }], then: 'deny' },
    { when: [{ id: 'dept', op: 'is', value: 'billing' },
             { id: 'urgent', op: 'lte', value: 0.2 },
             { id: 'radius', op: 'lte', value: 1 }], then: 'queue' },
    { when: [{ id: 'urgent', op: 'uncertain' }], then: 'hold' },
    { when: [{ id: 'dept', op: 'uncertain' }], then: 'ask' },
    { when: [{ id: 'radius', op: 'uncertain' }], then: 'review' },
    { when: [{ id: 'dept', op: 'is', value: 'other' }], then: 'triage' },
    { when: [{ id: 'urgent', op: 'gte', value: 1 }], then: 'certain' },
    { when: [{ id: 'radius', op: 'lte', value: 0 }], then: 'noop' },
    { when: [{ id: 'dept', op: 'gte', value: 0.9 }], then: 'route' },
  ], otherwise: 'allow' },
  residual: '', dropped: [],
}

/** The adjacent double. "One ULP either side" of a threshold is the only way to show a
 *  comparison is `>=` and not `>`, and it is where a serialise-then-reparse round trip
 *  loses. Both JS `String(x)` and Python `repr(float)` are shortest-round-trip, so the
 *  literal printed into each driver below reconstructs the same double in both. */
const F64 = new DataView(new ArrayBuffer(8))
function adjacent(x: number, up: boolean): number {
  F64.setFloat64(0, x)
  F64.setBigUint64(0, F64.getBigUint64(0) + (up ? 1n : -1n))
  return F64.getFloat64(0)
}

// Straddling every boundary in `vocabulary`: on it, one ULP either side, and the
// degenerate ends the wire can carry (validateResponse bounds a noul and a confidence to
// 0..1 and a score to level-index space, so 0/1 and 0/3 are the real extremes).
const URGENT = [0, adjacent(0, true), 0.2, adjacent(0.2, true), 0.35, 0.5, 0.65,
                adjacent(0.8, false), 0.8, adjacent(1, false), 1]
const DEPT = ['billing', 'technical', 'other']
const DEPT_CONF = [0, adjacent(0.6, false), 0.6, adjacent(0.9, false), 0.9, 1]
const RADIUS = [0, adjacent(0, true), 1, adjacent(2, false), 2, 3]
const RADIUS_CONF = [adjacent(0.5, false), 0.5]

type Point = { u: number; d: string; c: number; r: number; rc: number }
const POINTS: Point[] = []
for (const u of URGENT) for (const d of DEPT) for (const c of DEPT_CONF)
  for (const r of RADIUS) for (const rc of RADIUS_CONF) POINTS.push({ u, d, c, r, rc })

/** jevc's own answer shape (src/contract.ts:36-39) — what `runReducer` and the `sdk`
 *  target both consume. */
const jevcAnswers = (g: Point): Record<string, JevAnswer> => ({
  urgent: { type: 'noul', noul: g.u },
  dept: { type: 'choice', choice: g.d, confidence: g.c,
    probabilities: { billing: g.c, technical: 1 - g.c, other: 0 } },
  radius: { type: 'score', score: g.r, confidence: g.rc, legend: {}, probabilities: {} },
})

const EXPECTED = POINTS.map(g => runReducer(vocabulary, jevcAnswers(g)))

/** Axis literals, spelled once, inlined into every driver so all four evaluators walk the
 *  product in exactly the same order. */
const AXES = JSON.stringify({ U: URGENT, D: DEPT, C: DEPT_CONF, R: RADIUS, RC: RADIUS_CONF })

describe('every condition op and kind, executed against runReducer', () => {
  it('the grid is not degenerate: it reaches most of the verdict vocabulary', () => {
    // A grid that only ever produces `allow` proves nothing about any target.
    const seen = new Set(EXPECTED)
    expect([...seen].sort()).toEqual(
      ['allow', 'ask', 'certain', 'deny', 'hold', 'noop', 'queue', 'review', 'route', 'triage'].filter(v => seen.has(v)))
    expect(seen.size).toBeGreaterThanOrEqual(8)
  })

  it('sdk: the emitted reduce() agrees with runReducer at every point', () => {
    const got = runTs(emitNative(vocabulary), [
      `import type { JevAnswer } from 'jevc'`,
      `import { reduce } from './mod.ts'`,
      `const A = ${AXES}`,
      `const out: string[] = []`,
      `for (const u of A.U) for (const d of A.D) for (const c of A.C)`,
      `for (const r of A.R) for (const rc of A.RC) {`,
      `  const a: Record<string, JevAnswer> = {`,
      `    urgent: { type: 'noul', noul: u },`,
      `    dept: { type: 'choice', choice: d, confidence: c,`,
      `      probabilities: { billing: c, technical: 1 - c, other: 0 } },`,
      `    radius: { type: 'score', score: r, confidence: rc, legend: {}, probabilities: {} },`,
      `  }`,
      `  out.push(reduce(a))`,
      `}`,
      `console.log(JSON.stringify(out))`,
    ]) as string[]
    expect(disagreements(got, 'sdk')).toEqual([])
  }, SLOW)

  it('ai-sdk: the emitted reduce() agrees with runReducer at every point', () => {
    // Answers shaped per target-ai-sdk-and-langchain.md §A.3: noul is renamed `boolean`
    // and its field `probability`; no confidence inline anywhere; score keeps a string-keyed
    // `probabilities`. Confidence is read back through the emitter's own `confidenceOf`,
    // which §A.4 says is how a consumer reaches providerMetadata.typesafe.confidence.
    const got = runTs(emitAiSdk(vocabulary), [
      `import { reduce, confidenceOf } from './mod.ts'`,
      `const A = ${AXES}`,
      `const out: string[] = []`,
      `for (const u of A.U) for (const d of A.D) for (const c of A.C)`,
      `for (const r of A.R) for (const rc of A.RC) {`,
      `  const answers = {`,
      `    urgent: { type: 'boolean', probability: u },`,
      `    dept: { type: 'choice', choice: d,`,
      `      probabilities: { billing: c, technical: 1 - c, other: 0 } },`,
      `    radius: { type: 'score', score: r, probabilities: {} },`,
      `  }`,
      `  const result = { providerMetadata: { typesafe: { confidence: { dept: c, radius: rc } } } }`,
      `  out.push(reduce(answers, confidenceOf(result)))`,
      `}`,
      `console.log(JSON.stringify(out))`,
    ]) as string[]
    expect(disagreements(got, 'ai-sdk')).toEqual([])
  }, SLOW)

  it.runIf(pythonAvailable)('langchain: the emitted reduce() agrees with runReducer at every point', () => {
    // Answers per §B.3: confidence inline and REQUIRED on choice and score, legend
    // required on score, NoulAnswer carrying neither.
    const A = JSON.parse(AXES) as { U: number[]; D: string[]; C: number[]; R: number[]; RC: number[] }
    const lit = (xs: unknown[]) => JSON.stringify(xs)
    const got = runPy(emitLangchain(vocabulary),
      `[reduce({"urgent": NoulAnswer(u), ` +
      `"dept": ChoiceAnswer(d, c, {"billing": c, "technical": 1 - c, "other": 0}), ` +
      `"radius": ScoreAnswer(r, rc, {}, {})}) ` +
      `for u in ${lit(A.U)} for d in ${lit(A.D)} for c in ${lit(A.C)} ` +
      `for r in ${lit(A.R)} for rc in ${lit(A.RC)}]`) as string[]
    expect(disagreements(got, 'langchain')).toEqual([])
  }, SLOW)
})

// ---------------------------------------------------------------------------
// 2. Absent evidence. The one case the reference refuses to answer.
// ---------------------------------------------------------------------------

/**
 * `runReducer` does not have a value for every condition it evaluates. When the answer
 * map is missing the id a `gte`/`lte`/`uncertain` condition names, `value()` throws
 * `noAnswer(id)` (src/runtime.ts:40-47) and `isUncertain()` goes through `value()` too
 * (src/runtime.ts:63-72) — the reducer refuses to produce a verdict rather than treat
 * "we never asked" as "the threshold was not met". `is` is the exception: `choiceOf()`
 * returns `undefined` for anything that is not a choice answer and never throws
 * (src/runtime.ts:49-53), so an unanswered `is` is simply false.
 *
 * This is reachable without malice. src/contract.ts:267 has an `answer_missing` code
 * precisely because a model can return an answer map with an id dropped, and a consumer
 * of an emitted artifact never runs jevc's `validateResponse` — they hand the provider's
 * `answers` straight to the emitted `reduce()`.
 */
const gate: Program = {
  decisions: [
    { id: 'destructive', kind: 'noul', instructions: 'Does it delete data?' },
    { id: 'dept', kind: 'choice', instructions: 'Who owns it?',
      criteria: { billing: 'payments', technical: 'bugs' } },
    { id: 'radius', kind: 'score', instructions: 'Blast radius?',
      criteria: ['none', 'some', 'everything'] },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'destructive', op: 'gte', value: 0.8 }], then: 'deny' },
    { when: [{ id: 'dept', op: 'is', value: 'billing' }], then: 'queue' },
    { when: [{ id: 'radius', op: 'uncertain' }], then: 'review' },
  ], otherwise: 'allow' },
  residual: '', dropped: [],
}

type Have = {
  destructive?: number; dept?: string; deptConf?: number; radius?: number; radiusConf?: number
}
/** Each case names WHICH condition meets the hole, because the three ops reach a missing
 *  answer by three different paths and only one of them is defined to be silent. */
const ABSENT: { name: string; have: Have }[] = [
  { name: 'nothing answered at all', have: {} },
  { name: 'the gte decision unanswered',
    have: { dept: 'technical', deptConf: 0.9, radius: 2, radiusConf: 0.9 } },
  { name: 'the uncertain decision unanswered',
    have: { destructive: 0.1, dept: 'technical', deptConf: 0.9 } },
  { name: 'control — only the `is` decision unanswered, which is defined to be false',
    have: { destructive: 0.1, radius: 2, radiusConf: 0.9 } },
  { name: 'control — everything answered',
    have: { destructive: 0.1, dept: 'technical', deptConf: 0.9, radius: 2, radiusConf: 0.9 } },
]
const HAVE = JSON.stringify(ABSENT.map(s => s.have))

const REF_ABSENT = ABSENT.map(({ have: h }) => {
  const a: Record<string, JevAnswer> = {}
  if (h.destructive !== undefined) a.destructive = { type: 'noul', noul: h.destructive }
  if (h.dept !== undefined) {
    a.dept = { type: 'choice', choice: h.dept, confidence: h.deptConf!, probabilities: {} }
  }
  if (h.radius !== undefined) {
    a.radius = { type: 'score', score: h.radius, confidence: h.radiusConf!, legend: {}, probabilities: {} }
  }
  try { return runReducer(gate, a) } catch { return 'THROW' }
})

describe('a missing answer', () => {
  /**
   * FIXED (was a live bug). `runReducer` and the `sdk` artifact threw; the `ai-sdk` and
   * `langchain` artifacts skipped the rule and fell through to `otherwise`. On this Program
   * `otherwise` is `allow`, so on the same Program and the same incomplete answer map two of
   * the four evaluators refused to decide and two returned the most permissive verdict in
   * the list.
   *
   * Cause, in the emitters' own code:
   *   - src/emit/ai-sdk.ts:`compare()` returned `false` when the answer was absent, and
   *     `uncertain()` returned `false` when `!rule || !ans`.
   *   - src/emit/langchain.ts:`_value()` returned `None` and `_compare()`/`_uncertain()`
   *     returned `False` rather than raising.
   *
   * Both were documented as deliberate, citing bouncer's skip-on-missing rule. The ruling
   * was that the citation does not bind: bouncer is a YAML policy document with no
   * exceptions, and three of the four CODE targets emit a language that has them. So the
   * code targets now refuse, as `runReducer` does, rather than the reference being relaxed
   * to match them — a deny rule that quietly does not fire is the defect class this suite
   * exists for. The emitted throw names the decision AND the rule (`rule 2 -> review`),
   * because a stack frame inside a generated module names neither.
   *
   * The two controls are load-bearing in the other direction: `is` against an unanswered
   * question is still silently false in all four (`choiceOf` never throws), and a complete
   * answer map still returns a verdict. A fix that made everything throw would fail them.
   *
   * Either policy is arguable on its own. Four evaluators of one Program disagreeing is
   * not: `jevc compile --emit sdk` and `jevc compile --emit ai-sdk` are documented as two
   * lowerings of the same semantics, and here they answered differently.
   */
  it('all four evaluators refuse to decide on a missing answer, and agree on which', () => {
    const sdk = runTs(emitNative(gate), [
      `import type { JevAnswer } from 'jevc'`,
      `import { reduce } from './mod.ts'`,
      `type Have = { destructive?: number; dept?: string; deptConf?: number; radius?: number; radiusConf?: number }`,
      `const HAVE: Have[] = ${HAVE}`,
      `console.log(JSON.stringify(HAVE.map(h => {`,
      `  const a: Record<string, JevAnswer> = {}`,
      `  if (h.destructive !== undefined) a.destructive = { type: 'noul', noul: h.destructive }`,
      `  if (h.dept !== undefined) a.dept = { type: 'choice', choice: h.dept, confidence: h.deptConf!, probabilities: {} }`,
      `  if (h.radius !== undefined) a.radius = { type: 'score', score: h.radius, confidence: h.radiusConf!, legend: {}, probabilities: {} }`,
      `  try { return reduce(a) } catch { return 'THROW' }`,
      `})))`,
    ]) as string[]

    // §A.3 answer shapes; confidence arrives out-of-band and is absent for an unanswered id.
    const ai = runTs(emitAiSdk(gate), [
      `import { reduce } from './mod.ts'`,
      `type Have = { destructive?: number; dept?: string; deptConf?: number; radius?: number; radiusConf?: number }`,
      `const HAVE: Have[] = ${HAVE}`,
      `console.log(JSON.stringify(HAVE.map(h => {`,
      `  const a: Record<string, unknown> = {}`,
      `  const conf: Record<string, number> = {}`,
      `  if (h.destructive !== undefined) a.destructive = { type: 'boolean', probability: h.destructive }`,
      `  if (h.dept !== undefined) { a.dept = { type: 'choice', choice: h.dept, probabilities: {} }; conf.dept = h.deptConf! }`,
      `  if (h.radius !== undefined) { a.radius = { type: 'score', score: h.radius, probabilities: {} }; conf.radius = h.radiusConf! }`,
      `  try { return reduce(a, conf) } catch { return 'THROW' }`,
      `})))`,
    ]) as string[]

    const lc = pythonAvailable ? runPyScript(emitLangchain(gate), [
      'import json',
      'from langchain_typesafe import NoulAnswer, ChoiceAnswer, ScoreAnswer',
      'from mod import *',
      `HAVE = ${HAVE}`,
      'out = []',
      'for h in HAVE:',
      '    a = {}',
      '    if "destructive" in h: a["destructive"] = NoulAnswer(h["destructive"])',
      '    if "dept" in h: a["dept"] = ChoiceAnswer(h["dept"], h["deptConf"], {})',
      '    if "radius" in h: a["radius"] = ScoreAnswer(h["radius"], h["radiusConf"], {}, {})',
      '    try:',
      '        out.append(reduce(a))',
      '    except Exception:',
      '        out.append("THROW")',
      'print(json.dumps(out))',
      // Without python3 the langchain column reads `SKIPPED` on BOTH sides of the
      // assertion, so it is visibly absent from the comparison rather than quietly passing.
    ]) as string[] : ABSENT.map(() => 'SKIPPED - python3 not on PATH')

    const row = (i: number, l: string) =>
      `${ABSENT[i].name}: runReducer=${REF_ABSENT[i]} sdk=${sdk[i]} ai-sdk=${ai[i]} langchain=${l}`
    expect(ABSENT.map((_, i) => row(i, lc[i]))).toEqual(
      ABSENT.map((_, i) => `${ABSENT[i].name}: runReducer=${REF_ABSENT[i]} sdk=${REF_ABSENT[i]}`
        + ` ai-sdk=${REF_ABSENT[i]} langchain=${pythonAvailable ? REF_ABSENT[i] : lc[i]}`))
  }, SLOW)
})

// ---------------------------------------------------------------------------
// 3. Text lifted out of the instruction and into the artifact.
// ---------------------------------------------------------------------------

/**
 * Every payload here is a character sequence that terminates something in one of the two
 * output languages. A block-comment close and a newline end a comment; U+2028/U+2029 end
 * a line for a JS parser but not for a naive `split('\n')`; a NUL, a lone surrogate and an
 * RTL override are bytes that survive JSON and change how the file is read; `"""`/`'''`
 * close a Python string; a backslash, a backtick and `${}` are the three ways to leave a
 * JS string literal.
 */
const PAYLOADS: [name: string, text: string][] = [
  ['block-comment-close', '*/'],
  ['lf', 'a\nb'],
  ['crlf', 'a\r\nb'],
  ['cr', 'a\rb'],
  ['u2028', 'a\\u2028b'],
  ['u2029', 'a\\u2029b'],
  ['nul', 'a\\u0000b'],
  ['triple-double-quote', 'a"""b'],
  ['triple-single-quote', "a'''b"],
  ['backslash', 'a\\b'],
  ['dollar-brace', 'a${1 + 1}b'],
  ['backtick', 'a`b'],
  ['script-close', 'a</script>b'],
  ['lone-surrogate', 'a\uD800b'],
  ['rtl-override', 'a\\u202Eb'],
]

type Channel = 'quote' | 'file' | 'residual' | 'instructions' | 'option' | 'verdict'
const CHANNELS: Channel[] = ['quote', 'file', 'residual', 'instructions', 'option', 'verdict']

/**
 * Which channels each target actually lifts into its artifact. Read off the emitters:
 * `source.file`/`source.line`/`source.quote` are rendered only by `provenance()` in
 * src/emit/native.ts:35-45 — neither src/emit/ai-sdk.ts nor src/emit/langchain.ts emits
 * provenance at all. The residual is a comment in all three; instructions, option
 * descriptions and verdict strings are the payload of the emitted code everywhere.
 *
 * This table is a claim, not an observation: if provenance is ever added to a second
 * target, the cell flips and this test goes red on the day the new escaping needs review.
 */
const EMITS: Record<string, Set<Channel>> = {
  sdk: new Set<Channel>(['quote', 'file', 'residual', 'instructions', 'option', 'verdict']),
  aisdk: new Set<Channel>(['residual', 'instructions', 'option', 'verdict']),
  lc: new Set<Channel>(['residual', 'instructions', 'option', 'verdict']),
}

/** Bracketing markers, pure ASCII so no escaping can rewrite them: their presence proves
 *  the channel reached the artifact and the cell is not vacuously clean. */
const open = (i: number) => `zqa${i}`
const close = (i: number) => `zqb${i}`
const wrap = (i: number) => `${open(i)}${PAYLOADS[i][1]}${close(i)}`

function injected(ch: Channel, i: number): Program {
  const text = wrap(i)
  const p: Program = {
    decisions: [{ id: 'dept', kind: 'choice', instructions: 'Which team owns this?',
      criteria: { billing: 'payments', technical: 'bugs' } }],
    reduce: { kind: 'rules', rules: [{ when: [{ id: 'dept', op: 'is', value: 'billing' }], then: 'queue' }],
      otherwise: 'allow' },
    residual: '', dropped: [],
  }
  const d = p.decisions[0]
  if (ch === 'quote') d.source = { file: 'policy.md', line: 12, quote: text }
  if (ch === 'file') d.source = { file: text, line: 12, quote: 'the quoted sentence' }
  if (ch === 'residual') p.residual = text
  if (ch === 'instructions') d.instructions = text
  if (ch === 'option') d.criteria = { billing: text, technical: 'bugs' }
  if (ch === 'verdict') p.reduce.rules[0].then = text
  return p
}

describe('hostile text in every channel that reaches a code artifact', () => {
  /**
   * One table over {sdk, ai-sdk, langchain} x 6 channels x 15 payloads = 270 artifacts,
   * checked in two batched processes. A cell passes only if the emitted file is accepted
   * by the real compiler AND — where the emitter claims to carry that channel — both
   * markers survive. Syntax alone is not enough: a channel that silently drops the text
   * would also compile.
   */
  it('every payload in every channel still compiles, and is still carried', () => {
    const ts: Record<string, string> = {}
    const py: Record<string, string> = {}
    for (const ch of CHANNELS) {
      for (let i = 0; i < PAYLOADS.length; i++) {
        ts[`sdk_${ch}_${i}`] = emitNative(injected(ch, i))
        ts[`aisdk_${ch}_${i}`] = emitAiSdk(injected(ch, i))
        py[`lc_${ch}_${i}`] = emitLangchain(injected(ch, i))
      }
    }
    const tsDiag = typecheckBatch(ts)
    const pyDiag = pythonAvailable ? parsePyBatch(py) : undefined

    const rows: string[] = []
    const want: string[] = []
    const cell = (key: string, target: string, ch: Channel, i: number,
                  src: string, diag: string[]) => {
      const marked = src.includes(open(i)) && src.includes(close(i))
      const label = `${target} ${ch} ${PAYLOADS[i][0]}`
      rows.push(`${label}: syntax=${diag.length ? diag[0] : 'ok'} carried=${marked}`)
      want.push(`${label}: syntax=ok carried=${EMITS[target].has(ch)}`)
    }
    for (const ch of CHANNELS) {
      for (let i = 0; i < PAYLOADS.length; i++) {
        cell(`sdk_${ch}_${i}`, 'sdk', ch, i, ts[`sdk_${ch}_${i}`], tsDiag[`sdk_${ch}_${i}`])
        cell(`aisdk_${ch}_${i}`, 'aisdk', ch, i, ts[`aisdk_${ch}_${i}`], tsDiag[`aisdk_${ch}_${i}`])
        if (pyDiag) cell(`lc_${ch}_${i}`, 'lc', ch, i, py[`lc_${ch}_${i}`], pyDiag[`lc_${ch}_${i}`])
      }
    }
    expect(rows).toEqual(want)
  }, SLOW)

  /**
   * Compiling is the weaker half. A payload that became CODE rather than data can still
   * compile — `${1 + 1}` inside a template literal, a comment terminator followed by a
   * statement. So: one Program carrying all 15 payloads at once, executed, and asked the
   * two questions a consumer cares about. Does the reducer still return the verdict the
   * reference returns, and is the question text the model will be sent still the text the
   * Program declared, byte for byte.
   */
  const many: Program = {
    decisions: PAYLOADS.map(([, ], i) => ({
      id: `p${i}`, kind: 'noul' as const, instructions: wrap(i),
      source: { file: wrap(i), line: i + 1, quote: wrap(i) },
    })),
    reduce: {
      kind: 'rules',
      rules: PAYLOADS.map((_, i) => ({ when: [{ id: `p${i}`, op: 'gte' as const, value: 0.5 }], then: `v${i}` })),
      otherwise: 'none',
    },
    // Verdicts stay ASCII here on purpose: a lone surrogate would have to survive the
    // child process's stdout as well as the artifact, and that is not the claim under test.
    residual: PAYLOADS.map(([, t]) => t).join('\n--\n'),
    dropped: [],
  }
  /** One answer above threshold at a time, then none, so every rule is the winner once. */
  const HOT = [...PAYLOADS.map((_, i) => i), -1]
  const refVerdicts = HOT.map(hot => runReducer(many, Object.fromEntries(
    PAYLOADS.map((_, i) => [`p${i}`, { type: 'noul', noul: i === hot ? 0.9 : 0.1 }]))))
  const refInstructions = Object.fromEntries(many.decisions.map(d => [d.id, d.instructions]))

  it('sdk: 15 payloads at once still reduce correctly and still ask the declared question', () => {
    const got = runTs(emitNative(many), [
      `import type { JevAnswer } from 'jevc'`,
      `import { reduce, programQuestions } from './mod.ts'`,
      `const HOT = ${JSON.stringify(HOT)}`,
      `const verdicts = HOT.map(hot => reduce(Object.fromEntries(`,
      `  HOT.slice(0, -1).map(i => [\`p\${i}\`, { type: 'noul', noul: i === hot ? 0.9 : 0.1 } as JevAnswer]))))`,
      `const asked = Object.fromEntries(Object.entries(programQuestions as Record<string, { instructions: unknown }>)`,
      `  .map(([k, v]) => [k, v.instructions]))`,
      `console.log(JSON.stringify({ verdicts, asked }))`,
    ]) as { verdicts: string[]; asked: Record<string, unknown> }
    expect(got.verdicts).toEqual(refVerdicts)
    expect(got.asked).toEqual(refInstructions)
  }, SLOW)

  it('ai-sdk: 15 payloads at once still reduce correctly and still ask the declared question', () => {
    const got = runTs(emitAiSdk(many), [
      `import { reduce, programQuestions } from './mod.ts'`,
      `const HOT = ${JSON.stringify(HOT)}`,
      `const verdicts = HOT.map(hot => reduce(Object.fromEntries(`,
      `  HOT.slice(0, -1).map(i => [\`p\${i}\`, { type: 'boolean', probability: i === hot ? 0.9 : 0.1 }])), {}))`,
      `const asked = Object.fromEntries(Object.entries(programQuestions as Record<string, { instructions: unknown }>)`,
      `  .map(([k, v]) => [k, v.instructions]))`,
      `console.log(JSON.stringify({ verdicts, asked }))`,
    ]) as { verdicts: string[]; asked: Record<string, unknown> }
    expect(got.verdicts).toEqual(refVerdicts)
    expect(got.asked).toEqual(refInstructions)
  }, SLOW)

  it.runIf(pythonAvailable)('langchain: 15 payloads at once still reduce correctly and still ask the declared question', () => {
    const got = runPyScript(emitLangchain(many), [
      'import json',
      'from langchain_typesafe import NoulAnswer',
      'from mod import *',
      `HOT = ${JSON.stringify(HOT)}`,
      'verdicts = [reduce({"p%d" % i: NoulAnswer(0.9 if i == hot else 0.1) for i in HOT[:-1]})',
      '            for hot in HOT]',
      'asked = {k: getattr(v, "instructions", None) for k, v in program_questions.items()}',
      'print(json.dumps({"verdicts": verdicts, "asked": asked}))',
    ]) as { verdicts: string[]; asked: Record<string, unknown> }
    expect(got.verdicts).toEqual(refVerdicts)
    expect(got.asked).toEqual(refInstructions)
  }, SLOW)
})

// ---------------------------------------------------------------------------
// 4. Identifiers and keys.
// ---------------------------------------------------------------------------

/** A one-decision Program whose single id is `id`, gated on that id. */
function withId(id: string): Program {
  return {
    decisions: [{ id, kind: 'noul', instructions: 'Does it delete data?' }],
    reduce: { kind: 'rules', rules: [{ when: [{ id, op: 'gte', value: 0.5 }], then: 'deny' }],
      otherwise: 'allow' },
    residual: '', dropped: [],
  }
}

/**
 * Every name that is also a member of `Object.prototype`, plus `prototype`. src/ir.ts
 * builds `RESERVED_KEYS` from `Object.getOwnPropertyNames(Object.prototype)` for exactly
 * this list, so transcribing it by hand here is the point: if that set ever shrinks, this
 * spells out which names stopped being refused.
 */
const PROTOTYPE_NAMES = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']

/**
 * Names that are awkward in one of the two output languages but are ordinary map keys in
 * the IR. Each is here because something downstream might be tempted to emit it as a bare
 * identifier rather than a quoted key: TS reserved words, Python keywords and soft
 * keywords, a digit-leading name, punctuation that splits an identifier, the empty string,
 * a name longer than any editor gutter, and two non-ASCII names.
 */
const AWKWARD_IDS = [
  'class', 'function', 'default', 'import', 'export', 'new', 'delete', 'typeof', 'in',
  'def', 'None', 'True', 'lambda', 'global', 'async', 'match', 'pass',
  '2fa', 'has-dash', 'has.dot', 'has space', '', 'x'.repeat(300), 'café', 'א',
]

describe('identifiers and keys', () => {
  it('a name off Object.prototype is refused loudly, as an id and as a choice option', () => {
    // src/ir.ts `validateProgram` -> `reserved_id` / `reserved_option`. Refusing is a
    // legitimate answer to a hostile name; refusing QUIETLY is not, so the severity is
    // part of the claim.
    for (const name of PROTOTYPE_NAMES) {
      const asId = validateProgram(withId(name)).filter(i => i.severity === 'error')
      expect(asId.map(i => i.code), `id ${name}`).toContain('reserved_id')

      const asOption = validateProgram({
        decisions: [{ id: 'dept', kind: 'choice', instructions: 'Who owns it?',
          criteria: Object.fromEntries([[name, 'a description'], ['technical', 'bugs']]) }],
        reduce: { kind: 'rules', rules: [{ when: [{ id: 'dept', op: 'is', value: 'technical' }], then: 'queue' }],
          otherwise: 'allow' },
        residual: '', dropped: [],
      }).filter(i => i.severity === 'error')
      expect(asOption.map(i => i.code), `option ${name}`).toContain('reserved_option')
    }
  })

  /**
   * The disjunction from the brief: a name is either refused loudly, or it survives
   * INTACT — the artifact parses, the question is still asked under that name, and the
   * verdict still matches `runReducer`. These names are not refused (`validateProgram`
   * returns no error for them, asserted first, so the rest of the test cannot pass
   * vacuously by testing names nobody would emit), so the second branch has to hold.
   *
   * One asymmetry is deliberate and is NOT asserted here: the empty id is legal in the IR
   * and carried by all three code targets, but `validateRequest` rejects it on the wire
   * with `id_empty` (src/contract.ts:121). That is checked in §5 rather than papered over.
   */
  const awkward: Program = {
    decisions: AWKWARD_IDS.map(id => ({ id, kind: 'noul' as const, instructions: `Is ${id} true?` })),
    reduce: {
      kind: 'rules',
      rules: AWKWARD_IDS.map((id, n) => ({ when: [{ id, op: 'gte' as const, value: 0.5 }], then: `hit${n}` })),
      otherwise: 'none',
    },
    residual: '', dropped: [],
  }
  const IDS = JSON.stringify(AWKWARD_IDS)
  const awkwardVerdicts = AWKWARD_IDS.map(hot => runReducer(awkward, Object.fromEntries(
    AWKWARD_IDS.map(id => [id, { type: 'noul', noul: id === hot ? 0.9 : 0.1 }]))))

  it('the awkward names are legal in the IR, so nothing below is vacuous', () => {
    expect(validateProgram(awkward).filter(i => i.severity === 'error')).toEqual([])
    expect(awkwardVerdicts).toEqual(AWKWARD_IDS.map((_, n) => `hit${n}`))
  })

  it('sdk: every awkward name is still asked and still decides', () => {
    const got = runTs(emitNative(awkward), [
      `import type { JevAnswer } from 'jevc'`,
      `import { reduce, programQuestions } from './mod.ts'`,
      `const IDS: string[] = ${IDS}`,
      `const verdicts = IDS.map(hot => reduce(Object.fromEntries(`,
      `  IDS.map(id => [id, { type: 'noul', noul: id === hot ? 0.9 : 0.1 } as JevAnswer]))))`,
      `console.log(JSON.stringify({ verdicts, asked: Object.keys(programQuestions) }))`,
    ]) as { verdicts: string[]; asked: string[] }
    expect(got.verdicts).toEqual(awkwardVerdicts)
    expect(got.asked.sort()).toEqual([...AWKWARD_IDS].sort())
  }, SLOW)

  it('ai-sdk: every awkward name is still asked and still decides', () => {
    const got = runTs(emitAiSdk(awkward), [
      `import { reduce, programQuestions } from './mod.ts'`,
      `const IDS: string[] = ${IDS}`,
      `const verdicts = IDS.map(hot => reduce(Object.fromEntries(`,
      `  IDS.map(id => [id, { type: 'boolean', probability: id === hot ? 0.9 : 0.1 }])), {}))`,
      `console.log(JSON.stringify({ verdicts, asked: Object.keys(programQuestions) }))`,
    ]) as { verdicts: string[]; asked: string[] }
    expect(got.verdicts).toEqual(awkwardVerdicts)
    expect(got.asked.sort()).toEqual([...AWKWARD_IDS].sort())
  }, SLOW)

  it.runIf(pythonAvailable)('langchain: every awkward name is still asked and still decides', () => {
    const got = runPyScript(emitLangchain(awkward), [
      'import json',
      'from langchain_typesafe import NoulAnswer',
      'from mod import *',
      `IDS = ${IDS}`,
      'verdicts = [reduce({i: NoulAnswer(0.9 if i == hot else 0.1) for i in IDS}) for hot in IDS]',
      'print(json.dumps({"verdicts": verdicts, "asked": sorted(program_questions.keys())}))',
    ]) as { verdicts: string[]; asked: string[] }
    expect(got.verdicts).toEqual(awkwardVerdicts)
    expect(got.asked).toEqual([...AWKWARD_IDS].sort())
  }, SLOW)

  /**
   * FIXED (was a live bug). `__proto__` used to be guarded in the KEY position only.
   * src/emit/native.ts:`idKey` and src/emit/ai-sdk.ts:`idKey` emit a computed key
   * `['__proto__']` so a DECISION named `__proto__` survives, but the VALUES beside it were
   * spliced in as `JSON.stringify(v)`. An `instructions` or a criteria description that is
   * an object with its own `__proto__` key therefore landed in the artifact as an object
   * LITERAL, where `"__proto__":` is the prototype setter and not a key — so the emitted
   * module re-parented the object and dropped the entry, and the question the consumer
   * sends was missing text the Program declared.
   *
   * Closed by `tsValue` in src/emit/ts-lowering.ts, which renders a JSON value as a
   * TypeScript expression with the computed-key form at every `__proto__` and JSON's own
   * quoting everywhere else, applied at all four value splices in native.ts and all five in
   * ai-sdk.ts — the fifth being the LEGEND map, a second copy of every score level that no
   * earlier round reached.
   *
   * Reachable without malice: `Decision.instructions` is typed `string` but is not one
   * (src/ir.ts:274-279 says so, and lintProgram exists because 2 of 60 fixtures carry an
   * object there); src/check.ts passes a wire `instructions` straight through with a cast,
   * and both fixtures/output-verification.json and fixtures/cost-optimization.json use the
   * object form today. The same class as the historical `__proto__` bug, one level deeper.
   *
   * The wire (`--emit json`, via `Object.fromEntries`) and `langchain` (a Python dict) both
   * carry it correctly, which is what makes this a divergence and not a policy.
   */
  const nestedProto: Program = {
    decisions: [{
      id: 'dept', kind: 'choice',
      // Built by parsing, not by an object literal: writing `{ __proto__: 'x' }` in this
      // file would hit the very setter under test and produce no own key to begin with.
      instructions: JSON.parse('{"q":"Which team owns this?","__proto__":"escalate immediately"}'),
      criteria: JSON.parse('{"billing":{"__proto__":{"hint":"refunds"},"note":"payments"},"technical":"bugs"}'),
    }],
    reduce: { kind: 'rules', rules: [{ when: [{ id: 'dept', op: 'is', value: 'billing' }], then: 'queue' }],
      otherwise: 'allow' },
    residual: '', dropped: [],
  }

  it('a nested `__proto__` key inside instructions or a criteria value survives in every target', () => {
    const wire = toQuestion(nestedProto.decisions[0])
    const want = JSON.stringify({ instructions: wire.instructions, criteria: wire.criteria })
    expect(want).toContain('__proto__')  // the wire really does carry it; otherwise vacuous

    const tsDriver = [
      `import { programQuestions } from './mod.ts'`,
      `const q = (programQuestions as Record<string, { instructions: unknown; criteria: unknown }>)['dept']`,
      `console.log(JSON.stringify(JSON.stringify({ instructions: q.instructions, criteria: q.criteria })))`,
    ]
    const sdk = runTs(emitNative(nestedProto), tsDriver) as string
    const ai = runTs(emitAiSdk(nestedProto), tsDriver) as string
    const lc = pythonAvailable ? runPyScript(emitLangchain(nestedProto), [
      'import json',
      'from mod import *',
      'q = program_questions["dept"]',
      // `separators` so the Python rendering is byte-comparable with JSON.stringify's.
      'inner = json.dumps({"instructions": q.instructions, "criteria": q.criteria}, separators=(",", ":"))',
      'print(json.dumps(inner))',
    ]) as string : want

    expect({ sdk, 'ai-sdk': ai, langchain: lc }).toEqual({ sdk: want, 'ai-sdk': want, langchain: want })
  }, SLOW)
})

// ---------------------------------------------------------------------------
// 5. The json target: the wire, in both directions.
// ---------------------------------------------------------------------------

/**
 * An answer for every question in a REQUEST, derived from the request alone — the kind,
 * the option names and the number of score levels all come from `req.questions`, never
 * from the Program. That is the point: if `emitJson` declared a different kind, a
 * different option vocabulary or a different number of levels than the Program has, the
 * answer built from the request is the wrong shape for the Program and either
 * `validateResponse` or `runReducer` will say so.
 */
function answersFromRequest(req: JevRequest, pick = 0): Record<string, JevAnswer> {
  const out: Record<string, JevAnswer> = {}
  for (const [id, q] of Object.entries(req.questions)) {
    if (q.type === 'noul') {
      out[id] = { type: 'noul', noul: pick === 0 ? 0.9 : 0.1 }
    } else if (q.type === 'choice') {
      const options = Object.keys(q.criteria)
      const choice = options[pick % options.length]
      out[id] = { type: 'choice', choice, confidence: 0.95,
        probabilities: Object.fromEntries(options.map(o => [o, o === choice ? 0.95 : 0])) }
    } else {
      const levels = q.criteria as readonly unknown[]
      out[id] = { type: 'score', score: pick % levels.length, confidence: 0.95,
        legend: Object.fromEntries(levels.map((c, i) => [String(i), c as never])),
        probabilities: {} }
    }
  }
  return out
}

describe('the json target is a valid request, and a request that answers back', () => {
  const STATE = 'The user asked to delete the production database.'

  it('a compiled Program emits a request the contract accepts', () => {
    for (const [name, p] of [['vocabulary', vocabulary], ['gate', gate]] as [string, Program][]) {
      const issues = validateRequest(emitJson(p, STATE)).filter(i => i.severity === 'error')
      expect(issues.map(i => `${i.code} ${i.path}`), name).toEqual([])
    }
  })

  it('the emitted request is JSON, and round-trips through JSON.parse unchanged', () => {
    const req = emitJson(vocabulary, STATE)
    const text = JSON.stringify(req)
    expect(JSON.parse(text)).toEqual(req)
    // Every declared decision reaches the wire under its own id, in order.
    expect(Object.keys(JSON.parse(text).questions)).toEqual(vocabulary.decisions.map(d => d.id))
  })

  /**
   * Each wire limit, violated one at a time, has to be REPORTED. Transcribed from
   * src/contract.ts: choice 2..255 options with a warn from 241 (lines 150-158), score
   * 2..10 levels (134-139), a non-empty id (121), at least one question (114), and a
   * token budget of 32,000 for one question against 45,000 for the request at
   * 5.1 chars per token (54-55, 198-209).
   */
  it('every wire limit is reported when the emitted request breaks it', () => {
    const noul = (id: string): Program['decisions'][number] =>
      ({ id, kind: 'noul', instructions: 'Is it urgent?' })
    const wrap = (ds: Program['decisions']): Program => ({
      decisions: ds,
      reduce: { kind: 'rules', rules: [], otherwise: 'allow' },
      residual: '', dropped: [],
    })
    const opts = (n: number) => Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`opt${i}`, `description ${i}`]))
    const levels = (n: number) => Array.from({ length: n }, (_, i) => `level ${i}`)
    const choice = (n: number): Program => wrap([{ id: 'dept', kind: 'choice',
      instructions: 'Who owns it?', criteria: opts(n) }])
    const score = (n: number): Program => wrap([{ id: 'radius', kind: 'score',
      instructions: 'How wide?', criteria: levels(n) }])

    const codes = (p: Program, state: JevRequest['state'] = STATE) =>
      validateRequest(emitJson(p, state)).map(i => `${i.severity}:${i.code}`)

    expect(codes(choice(1))).toContain('error:choice_too_few_options')
    expect(codes(choice(2))).not.toContain('error:choice_too_few_options')
    expect(codes(choice(255))).not.toContain('error:choice_too_many_options')
    expect(codes(choice(256))).toContain('error:choice_too_many_options')
    expect(codes(choice(241))).toContain('warn:choice_near_limit')
    expect(codes(choice(240))).not.toContain('warn:choice_near_limit')

    expect(codes(score(1))).toContain('error:score_too_few_levels')
    expect(codes(score(2))).not.toContain('error:score_too_few_levels')
    expect(codes(score(10))).not.toContain('error:score_too_many_levels')
    expect(codes(score(11))).toContain('error:score_too_many_levels')

    expect(codes(wrap([noul('')]))).toContain('error:id_empty')
    expect(codes(wrap([]))).toContain('error:questions_empty')
    expect(codes(wrap([noul('urgent')]), '')).toContain('error:state_empty')

    // 5.1 chars per token. The two budgets are separate and have to be separable: one
    // question of 200,000 chars is ~39,200 tokens, over the 32,000 per-question limit but
    // under the 45,000 request limit; two questions of 130,000 chars are ~25,500 each,
    // under the per-question limit and ~51,000 together, over the request limit.
    const overQuestion = codes(wrap([{ id: 'urgent', kind: 'noul', instructions: 'x'.repeat(200_000) }]))
    expect(overQuestion.filter(c => c.endsWith('token_budget_exceeded'))).toEqual(['error:token_budget_exceeded'])

    const overRequest = validateRequest(emitJson(wrap([
      { id: 'a', kind: 'noul', instructions: 'x'.repeat(130_000) },
      { id: 'b', kind: 'noul', instructions: 'y'.repeat(130_000) },
    ]), STATE))
    expect(overRequest.filter(i => i.code === 'token_budget_exceeded').map(i => i.path)).toEqual(['request'])
  })

  /**
   * The reverse direction. A request that cannot be answered back into the same verdict is
   * a request that describes a different Program than the one that was compiled.
   */
  it('the emitted request, answered plausibly, reduces to the verdict runReducer gives', () => {
    for (const [name, p] of [['vocabulary', vocabulary], ['gate', gate]] as [string, Program][]) {
      const req = emitJson(p, STATE)
      // `pick` walks the option and level vocabularies so this is not one lucky answer:
      // every choice option and every score level is the chosen one at least once.
      for (let pick = 0; pick < 5; pick++) {
        const answers = answersFromRequest(req, pick)
        const res = { model: 'jev-latest', answers, usage: { input_tokens: 10, output_tokens: 10 } }
        expect(validateResponse(p, res).filter(i => i.severity === 'error'),
          `${name} pick=${pick}`).toEqual([])
        // Built from the REQUEST; compared against the same construction over the PROGRAM.
        const fromProgram = answersFromRequest(
          { model: 'jev-latest', state: STATE,
            questions: Object.fromEntries(p.decisions.map(d => [d.id, toQuestion(d)])) as Record<string, JevQuestion> },
          pick)
        expect(runReducer(p, answers), `${name} pick=${pick}`).toBe(runReducer(p, fromProgram))
      }
    }
  })
})

/** The first few points where a target's verdict differs from the reference, formatted so
 *  a red run names the inputs rather than printing 1,900 strings. */
function disagreements(got: string[], target: string): string[] {
  expect(got).toHaveLength(POINTS.length)
  return POINTS.flatMap((g, i) => got[i] === EXPECTED[i] ? []
    : [`${JSON.stringify(g)} runReducer=${EXPECTED[i]} ${target}=${got[i]}`]).slice(0, 10)
}
