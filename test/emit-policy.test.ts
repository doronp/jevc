import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import { emitBouncerPolicy } from '../src/emit/policy/bouncer.js'
import { emitToolgatePolicy } from '../src/emit/policy/toolgate.js'
import { rangeFor } from '../src/emit/capability.js'
import { runReducer } from '../src/runtime.js'
import { uncertaintyOf } from '../src/ir.js'
import type { Program } from '../src/ir.js'

const p: Program = {
  decisions: [
    { id: 'deletes_tracked_files', kind: 'noul',
      instructions: 'Does the command delete files tracked by git?',
      criteria: { true: 'deletes tracked source', false: 'touches only regenerable output' },
      source: { file: 'AGENTS.md', line: 7, quote: 'Never delete tracked files.' } },
    { id: 'outside_repo', kind: 'noul', instructions: 'Does it touch paths outside the repo root?' },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.8 }], then: 'deny' },
    { when: [{ id: 'outside_repo', op: 'gte', value: 0.6 }], then: 'ask' },
  ], otherwise: 'allow' },
  residual: '', dropped: [],
}

describe('emitBouncerPolicy', () => {
  const doc = () => parse(emitBouncerPolicy(p))

  it('emits version 1, which bouncer requires exactly', () => {
    expect(doc().version).toBe(1)
  })
  it('defaults to observe mode so a generated policy cannot block on day one', () => {
    expect(doc().mode).toBe('observe')
  })
  // The banner is the only thing a human skims before installing the file. Under
  // mode: guard the old text still read "it logs and emits nothing", which is false in
  // exactly the direction that gets someone hurt.
  it.each(['guard', 'full'] as const)('does not claim to emit nothing in mode %s', mode => {
    const y = emitBouncerPolicy(p, { mode })
    expect(y).not.toMatch(/emits nothing/)
    expect(y).toMatch(new RegExp(`# Mode ${mode}: this policy BLOCKS`))
  })
  it('emits each decision under gate.questions with true/false criteria', () => {
    const q = doc().gate.questions
    expect(Object.keys(q)).toEqual(['deletes_tracked_files', 'outside_repo'])
    expect(q.deletes_tracked_files.criteria.true).toMatch(/tracked source/)
  })
  it('never emits a type key, since bouncer hardcodes noul', () => {
    expect(emitBouncerPolicy(p)).not.toMatch(/type:/)
  })
  it("emits rules in bouncer's p-comparison string grammar", () => {
    expect(doc().gate.rules[0]).toEqual({ when: { deletes_tracked_files: { p: '>=0.8' } }, then: 'deny' })
  })
  it('emits exactly one terminal default, last', () => {
    const rules = doc().gate.rules
    expect(rules.filter((r: any) => 'default' in r)).toHaveLength(1)
    expect(rules.at(-1)).toEqual({ default: 'allow' })
  })
  it('rejects a reserved question named "any"', () => {
    const bad: Program = { ...p, decisions: [{ id: 'any', kind: 'noul', instructions: 'x' }] }
    expect(() => emitBouncerPolicy(bad)).toThrow(/reserved/)
  })
  it('carries provenance through as a YAML comment', () => {
    expect(emitBouncerPolicy(p))
      .toMatch(/# deletes_tracked_files: AGENTS\.md:7 — Never delete tracked files\./)
  })

  it('refuses a conjunction rather than folding it into one question', () => {
    const conj: Program = { ...p, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.8 },
               { id: 'outside_repo', op: 'gte', value: 0.6 }], then: 'deny' }], otherwise: 'allow' } }
    expect(() => emitBouncerPolicy(conj)).toThrow(/one question per rule/)
  })
  // A policy that exists but fails to parse STOPS bouncer's policy resolution and routes
  // to on_error (default passthrough = emit nothing), so an unparseable verdict does not
  // degrade the gate, it disables it.
  it('refuses a verdict outside allow/ask/deny rather than emitting an unloadable policy', () => {
    const odd: Program = { ...p, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'outside_repo', op: 'gte', value: 0.8 }], then: 'quarantine' }], otherwise: 'allow' } }
    expect(() => emitBouncerPolicy(odd)).toThrow(/quarantine/)
  })
  it('refuses a score decision, which bouncer would send as a mangled noul', () => {
    const score: Program = { ...p, decisions: [
      { id: 'radius', kind: 'score', instructions: 'How wide?', criteria: ['file', 'repo'] }] }
    expect(() => emitBouncerPolicy(score)).toThrow(/noul/)
  })
  // The reducer is respelled against `x` as well: a rule naming a decision the program
  // does not declare is now a canEmit error (it emitted a rule referencing a question
  // that was not in gate.questions, which bouncer refuses to load).
  const onlyX = { kind: 'rules' as const, rules: [
    { when: [{ id: 'x', op: 'gte' as const, value: 0.8 }], then: 'deny' }], otherwise: 'allow' }

  it('renders object-form criteria as JSON, since bouncer reads criteria as strings', () => {
    const obj: Program = { ...p, reduce: onlyX, decisions: [
      { id: 'x', kind: 'noul', instructions: 'Yes?', criteria: { true: { note: 'yes' }, false: null } }] }
    const q = parse(emitBouncerPolicy(obj)).gate.questions.x
    expect(q.criteria.true).toBe('{"note":"yes"}')
    // Absent, not empty: bouncer forwards criteria verbatim to the model, and `false: ""`
    // tells it the negative case is described by nothing at all, which is a worse prompt
    // than not naming the side. The Program said nothing about it; so does the policy.
    expect('false' in q.criteria).toBe(false)
  })

  it('omits criteria entirely when the decision describes neither side', () => {
    const none: Program = { ...p, reduce: onlyX, decisions: [
      { id: 'x', kind: 'noul', instructions: 'Yes?', criteria: {} }] }
    expect('criteria' in parse(emitBouncerPolicy(none)).gate.questions.x).toBe(false)
  })
  it('keeps residual visible as a comment, the only place the schema leaves for it', () => {
    expect(emitBouncerPolicy({ ...p, residual: 'summary: write a summary.' }))
      .toMatch(/# summary: write a summary\./)
  })

  // Residual is prose lifted from a human document, so its line endings are the
  // document's, not ours. Asserted on the emitted LINES rather than through parse():
  // the `yaml` package both targets pin does not end a comment at a lone CR, but the
  // YAML spec says a CR is a line break and PyYAML and go-yaml implement it, so a file
  // whose "comment" is only a comment to one parser is not a comment.
  it('comments out every line of a CR-separated residual', () => {
    const out = emitBouncerPolicy({ ...p, residual: 'Judge the tone.\rmode: guard' })
    expect(out.split(/\r\n|\r|\n/).filter(l => l.includes('mode: guard')))
      .toEqual(['# mode: guard'])
  })
})

describe('emitToolgatePolicy', () => {
  // toolgate reduces by max-over-questions against two scalars, so an emittable program
  // needs one shared deny threshold and one shared ask threshold covering every question.
  // Written as a DISJUNCTION — one condition per rule, repeated per question — because
  // that is what max-over-questions means. A single rule naming both questions would be a
  // conjunction, which this target cannot express and canEmit now refuses.
  const flat: Program = {
    decisions: p.decisions,
    reduce: { kind: 'rules', rules: [
      { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.85 }], then: 'deny' },
      { when: [{ id: 'outside_repo', op: 'gte', value: 0.85 }], then: 'deny' },
      { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.55 }], then: 'ask' },
      { when: [{ id: 'outside_repo', op: 'gte', value: 0.55 }], then: 'ask' },
    ], otherwise: 'allow' },
    residual: '', dropped: [],
  }

  it('emits every question as type boolean, which its validator requires', () => {
    const doc = parse(emitToolgatePolicy(flat))
    expect(Object.values(doc.questions).every((q: any) => q.type === 'boolean')).toBe(true)
  })
  it('notes that built-ins cannot be removed, only shadowed', () => {
    expect(emitToolgatePolicy(flat)).toMatch(/built-in/i)
  })
  it('emits the two scalar thresholds toolgate actually reads', () => {
    expect(parse(emitToolgatePolicy(flat)).thresholds).toEqual({ deny: 0.85, ask: 0.55 })
  })
  it('re-emits criteria, because overriding a question is a replace not a deep merge', () => {
    expect(parse(emitToolgatePolicy(flat)).questions.deletes_tracked_files.criteria.true)
      .toMatch(/tracked source/)
  })

  // The plan's original emitter wrote a per-question threshold map. toolgate has no such
  // key: it would load the file, ignore the map, and silently run at its 0.85/0.55
  // defaults — a policy that parses cleanly and means something else.
  it('refuses per-question thresholds instead of emitting a map toolgate ignores', () => {
    expect(() => emitToolgatePolicy(p)).toThrow(/different thresholds|no ask rule|no deny rule/)
  })
  it('refuses a question left out of a threshold, since max-over-questions covers it anyway', () => {
    const partial: Program = { ...flat, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.85 }], then: 'deny' },
      { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.55 }], then: 'ask' },
      { when: [{ id: 'outside_repo', op: 'gte', value: 0.55 }], then: 'ask' },
    ], otherwise: 'allow' } }
    expect(() => emitToolgatePolicy(partial)).toThrow(/outside_repo/)
  })
  // validatePolicy allows ask == deny, but the ask branch is then unreachable: toolgate
  // tests `>= deny` first, so every probability that would have asked denies instead.
  // The Program's two rules say something its policy cannot.
  it('refuses equal ask and deny thresholds, which make the ask rule unreachable', () => {
    const same: Program = { ...flat, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.7 }], then: 'deny' },
      { when: [{ id: 'outside_repo', op: 'gte', value: 0.7 }], then: 'deny' },
      { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.7 }], then: 'ask' },
      { when: [{ id: 'outside_repo', op: 'gte', value: 0.7 }], then: 'ask' },
    ], otherwise: 'allow' } }
    expect(() => emitToolgatePolicy(same)).toThrow(/ask \(0\.7\).*deny \(0\.7\)/)
  })

  // NOT in the review's list — found while testing I13. jevc's reducer is first-match-
  // wins over an ORDERED list; toolgate always tests deny before ask. So a Program that
  // lists its ask rules first means something different from the policy it emits, even
  // though every threshold is legal and every question is covered.
  it('refuses a program whose ask rules precede its deny rules', () => {
    const askFirst: Program = { ...flat, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.55 }], then: 'ask' },
      { when: [{ id: 'outside_repo', op: 'gte', value: 0.55 }], then: 'ask' },
      { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.85 }], then: 'deny' },
      { when: [{ id: 'outside_repo', op: 'gte', value: 0.85 }], then: 'deny' },
    ], otherwise: 'allow' } }
    // The divergence itself, before the refusal that prevents it.
    expect(runReducer(askFirst, { deletes_tracked_files: { type: 'noul', noul: 0.9 },
      outside_repo: { type: 'noul', noul: 0.1 } })).toBe('ask')
    expect(() => emitToolgatePolicy(askFirst)).toThrow(/before|order/)
  })

  it('refuses a non-allow fallthrough', () => {
    expect(() => emitToolgatePolicy({ ...flat, reduce: { ...flat.reduce, otherwise: 'deny' } }))
      .toThrow(/fallthrough/)
  })

  // Same reasoning as bouncer's: criteria.true/false are forwarded into the prompt, so a
  // side the Program does not describe is left out rather than sent as "".
  it('omits a criteria side the decision does not describe', () => {
    const half: Program = { ...flat, decisions: [
      { ...p.decisions[0], criteria: { true: 'deletes tracked source' } }, p.decisions[1]],
      reduce: { kind: 'rules', rules: flat.reduce.rules, otherwise: 'allow' } }
    const q = parse(emitToolgatePolicy(half)).questions.deletes_tracked_files
    expect(q.criteria).toEqual({ true: 'deletes tracked source' })
  })

  // Same CR hazard as bouncer's, asserted the same way and for the same reason.
  it('comments out every line of a CR-separated residual', () => {
    const out = emitToolgatePolicy({ ...flat, residual: 'Judge the tone.\rthresholds: {deny: 0.99}' })
    expect(out.split(/\r\n|\r|\n/).filter(l => l.includes('thresholds: {deny')))
      .toEqual(['# thresholds: {deny: 0.99}'])
  })
  it('refuses the reserved off_task id, which toolgate drops without task context', () => {
    const bad: Program = { ...flat, decisions: [{ id: 'off_task', kind: 'noul', instructions: 'x' }] }
    expect(() => emitToolgatePolicy(bad)).toThrow(/off_task/)
  })
  it('points at TOOLGATE_POLICY rather than the global file, since there is no project discovery', () => {
    expect(emitToolgatePolicy(flat)).toMatch(/TOOLGATE_POLICY/)
  })
})

// ---------------------------------------------------------------------------
// Transcriptions of the two consumers, from target-bouncer.md:62-69 and
// target-toolgate.md:66. Comparing emitted SHAPES is not comparing BEHAVIOUR:
// every historical bug here produced a file that parsed and meant something else.

/** bouncer's `p` grammar (target-bouncer.md:55-57). `LOW..HIGH` is inclusive BOTH ends. */
const pMatches = (p: string, x: number): boolean => {
  const cmp = /^(>=|>|<=|<)\s*(\d*\.?\d+)$/.exec(p.trim())
  if (cmp) {
    const n = Number(cmp[2])
    return cmp[1] === '>=' ? x >= n : cmp[1] === '>' ? x > n : cmp[1] === '<=' ? x <= n : x < n
  }
  const range = /^(\d*\.?\d+)\.\.(\d*\.?\d+)$/.exec(p.trim())
  if (!range) throw new Error(`p "${p}" does not match bouncer's grammar`)
  return x >= Number(range[1]) && x <= Number(range[2])
}

/** First match wins; a question with no answer is skipped; `any` matches on any answer. */
const bouncerVerdict = (doc: any, answers: Record<string, number>): string => {
  for (const r of doc.gate.rules) {
    if ('default' in r) return r.default
    const [name] = Object.keys(r.when)
    const cond = r.when[name].p
    if (name === 'any') {
      if (Object.values(answers).some(v => pMatches(cond, v))) return r.then
      continue
    }
    // A rule naming a question that is not in gate.questions is a hard load error;
    // asserted separately. Here it would simply never fire.
    if (!Object.hasOwn(answers, name)) continue
    if (pMatches(cond, answers[name])) return r.then
  }
  throw new Error('no rule matched and there was no default')
}

/** max over EVERY merged question, built-ins included, then deny before ask. */
const toolgateVerdict = (doc: any, answers: Record<string, number>): string => {
  const ids = ['destructive', 'exfiltration', 'privilege', ...Object.keys(doc.questions)]
  const m = Math.max(...ids.map(id => answers[id] ?? 0))
  return m >= doc.thresholds.deny ? 'deny' : m >= doc.thresholds.ask ? 'ask' : 'allow'
}

const noul = (id: string, extra: object = {}) =>
  ({ id, kind: 'noul' as const, instructions: `Is ${id}?`, ...extra })

const F64 = new DataView(new ArrayBuffer(8))
/**
 * The adjacent double. Deliberately a SECOND implementation of capability.ts's `step`:
 * the grid is the independent check on `rangeFor`, so it must not be built out of the
 * function it is checking. `nextDown(0)` wraps to NaN rather than throwing, and every
 * caller here filters on `>= 0 && <= 1`, which NaN fails.
 */
const ulpStep = (x: number, up: boolean): number => {
  F64.setFloat64(0, x)
  F64.setBigUint64(0, F64.getBigUint64(0) + (up ? 1n : -1n))
  return F64.getFloat64(0)
}
const nextUp = (x: number) => ulpStep(x, true)
const nextDown = (x: number) => ulpStep(x, false)

/** Every threshold and band edge in the program, a tick and a ULP either side, plus 0 and 1. */
const gridFor = (prog: Program): number[] => {
  const s = new Set([0, 1])
  // ±1e-9 is about 4.5 million ULPs at 0.4. It catches a coarse endpoint mismatch — the
  // exact endpoint is in the grid, so emitting the band verbatim goes red at p = 0.4 —
  // but it is blind to the ONE-DOUBLE step rangeFor takes to turn jevc's exclusive band
  // into bouncer's inclusive range. Measured on this tree: a two-ULP inward step emits
  // "0.40000000000000013..0.5999999999999998" and the ±1e-9 grid stays green, because the
  // only probabilities that can tell a correct inward step from a two-ULP one are the
  // adjacent doubles themselves. They are the grid points below.
  const add = (v: number) => {
    for (const x of [v - 1e-9, nextDown(v), v, nextUp(v), v + 1e-9]) if (x >= 0 && x <= 1) s.add(x)
  }
  for (const r of prog.reduce.rules) for (const c of r.when) if ('value' in c && typeof c.value === 'number') add(c.value)
  // uncertaintyOf, not `d.uncertain`: a noul that OMITS the field still has a band — the
  // default [0.35, 0.65] — and rangeFor lowers that one exactly like a declared one.
  // Reading the field directly put no grid point anywhere near 0.35 or 0.65, so on a
  // default-band program the grid could not see the emitted range at all, at any
  // resolution: measured, even emitting the band verbatim stayed green.
  for (const d of prog.decisions) {
    const u = uncertaintyOf(d)
    if ('band' in u) { add(u.band[0]); add(u.band[1]) }
  }
  return [...s].sort((a, b) => a - b)
}

const gridAgrees = (prog: Program, emit: (p: Program) => string, verdict: (doc: any, a: Record<string, number>) => string) => {
  const doc = parse(emit(prog))
  const ids = prog.decisions.map(d => d.id)
  let points = 0
  const walk = (i: number, row: Record<string, number>) => {
    if (i === ids.length) {
      points++
      const answers = Object.fromEntries(ids.map(id => [id, { type: 'noul' as const, noul: row[id] }]))
      // The row travels into the assertion so a failure names the probabilities.
      expect([row, runReducer(prog, answers)]).toEqual([row, verdict(doc, row)])
      return
    }
    for (const v of gridFor(prog)) walk(i + 1, { ...row, [ids[i]]: v })
  }
  walk(0, {})
  expect(points).toBeGreaterThan(3)   // a grid that silently collapsed proves nothing
}

describe('policy targets agree with their consumer over a probability grid', () => {
  const ladder = (ids: string[]): Program => ({
    decisions: ids.map(id => noul(id)),
    reduce: { kind: 'rules', rules: [
      ...ids.map(id => ({ when: [{ id, op: 'gte' as const, value: 0.85 }], then: 'deny' })),
      ...ids.map(id => ({ when: [{ id, op: 'gte' as const, value: 0.55 }], then: 'ask' })),
    ], otherwise: 'allow' },
    residual: '', dropped: [],
  })

  it('bouncer: two questions, deny 0.85 / ask 0.55', () => {
    gridAgrees(ladder(['secrets', 'outside']), emitBouncerPolicy, bouncerVerdict)
  })
  it('toolgate: two questions, deny 0.85 / ask 0.55', () => {
    gridAgrees(ladder(['secrets', 'outside']), emitToolgatePolicy, toolgateVerdict)
  })
  it('bouncer: an lte rule, which inverts the comparison', () => {
    gridAgrees({ decisions: [noul('safe')], residual: '', dropped: [],
      reduce: { kind: 'rules', rules: [
        { when: [{ id: 'safe', op: 'lte', value: 0.2 }], then: 'allow' }], otherwise: 'deny' } },
      emitBouncerPolicy, bouncerVerdict)
  })

  // The id is a live input: from-schema.ts uses the JSON Schema property name verbatim.
  // `questions[d.id] = ...` on a plain object literal hits Object.prototype's __proto__
  // SETTER, which re-parents the map instead of adding a key, and the question vanishes.
  // On toolgate the result still loads — max() just runs over one fewer question — so the
  // gate silently weakens. On bouncer the surviving rule references a question that is no
  // longer declared, which is a load error, and a policy bouncer cannot load stops policy
  // resolution and routes to on_error: passthrough. Either way, exit 0.
  describe('a question named __proto__', () => {
    const poisoned = ladder(['__proto__', 'secrets'])

    it('survives into bouncer gate.questions as an own key', () => {
      const q = parse(emitBouncerPolicy(poisoned)).gate.questions
      expect(Object.keys(q).sort()).toEqual(['__proto__', 'secrets'])
      expect(q.__proto__.instructions).toBe('Is __proto__?')
    })
    it('survives into toolgate questions as an own key', () => {
      const q = parse(emitToolgatePolicy(poisoned)).questions
      expect(Object.keys(q).sort()).toEqual(['__proto__', 'secrets'])
      expect(q.__proto__.type).toBe('boolean')
    })
    it('leaves every bouncer rule naming a declared question', () => {
      const gate = parse(emitBouncerPolicy(poisoned)).gate
      for (const r of gate.rules) {
        if ('default' in r) continue
        expect(Object.hasOwn(gate.questions, Object.keys(r.when)[0])).toBe(true)
      }
    })
    it('agrees with both consumers on the grid, which losing it does not', () => {
      gridAgrees(poisoned, emitBouncerPolicy, bouncerVerdict)
      gridAgrees(poisoned, emitToolgatePolicy, toolgateVerdict)
    })
  })
})

describe('emitBouncerPolicy provenance is inert', () => {
  // The quote was scrubbed of line endings; `file`, `line` and `id` were not. A rule file
  // named "RULES.md\nskip_permission_modes: [\"default\"]\n#" ends the comment and writes a
  // REAL top-level key: the policy still loads, and bouncer then skips the classifier
  // entirely in the default permission mode. Valid YAML, wrong policy, exit 0.
  const withSource = (source: object): Program => ({
    decisions: [{ ...noul('secrets'), source } as any], residual: '', dropped: [],
    reduce: { kind: 'rules', rules: [
      { when: [{ id: 'secrets', op: 'gte', value: 0.5 }], then: 'deny' }], otherwise: 'allow' },
  })

  it('does not let a newline in source.file inject a top-level key', () => {
    const doc = parse(emitBouncerPolicy(withSource(
      { file: 'RULES.md\nskip_permission_modes: ["default"]\n#', line: 3, quote: 'q' })))
    expect(doc.skip_permission_modes).toBeUndefined()
    expect(Object.keys(doc).sort()).toEqual(['backend', 'gate', 'mode', 'on_error', 'timeout_ms', 'version'])
  })

  it('does not let a non-numeric source.line break the document', () => {
    const doc = parse(emitBouncerPolicy(withSource({ file: 'f', line: '1\nmode: bogus', quote: 'q' })))
    expect(doc.mode).toBe('observe')
  })

  it('does not let a newline in the decision id break the document', () => {
    const p2: Program = { decisions: [{ ...noul('k\nversion: 2'), source: { file: 'f', line: 1, quote: 'q' } }],
      residual: '', dropped: [],
      reduce: { kind: 'rules', rules: [
        { when: [{ id: 'k\nversion: 2', op: 'gte', value: 0.5 }], then: 'deny' }], otherwise: 'allow' } }
    const doc = parse(emitBouncerPolicy(p2))
    expect(doc.version).toBe(1)
    expect(Object.keys(doc.gate.questions)).toEqual(['k\nversion: 2'])
  })
})

describe('emitBouncerPolicy options are checked against the schema', () => {
  const simple: Program = { decisions: [noul('secrets')], residual: '', dropped: [],
    reduce: { kind: 'rules', rules: [
      { when: [{ id: 'secrets', op: 'gte', value: 0.5 }], then: 'deny' }], otherwise: 'allow' } }

  // target-bouncer.md:27-28. mode outside observe/guard/full and timeout_ms outside
  // 50..30000 are LOAD errors, and a policy bouncer cannot load disables the gate.
  it('refuses a mode bouncer does not know', () => {
    expect(() => emitBouncerPolicy(simple, { mode: 'enforce' as any })).toThrow(/enforce.*observe|observe.*enforce/s)
  })
  it.each([0, 30, 49, 30001, 60000, NaN, Infinity])('refuses timeout_ms %s', ms => {
    expect(() => emitBouncerPolicy(simple, { timeoutMs: ms })).toThrow(/timeout/i)
  })
  it.each([50, 800, 30000])('accepts timeout_ms %s', ms => {
    expect(parse(emitBouncerPolicy(simple, { timeoutMs: ms })).timeout_ms).toBe(ms)
  })
})

describe('emitBouncerPolicy lowers an uncertainty band', () => {
  // "Uncertainty band → `p: \"0.40..0.60\"`" is listed under what maps cleanly
  // (target-bouncer.md). jevc's band is EXCLUSIVE (runtime.ts isUncertain) and bouncer's
  // range is INCLUSIVE, so the endpoints have to be stepped inwards by one double or the
  // two disagree at exactly p = 0.4 and p = 0.6.
  const banded: Program = {
    decisions: [noul('risky', { uncertain: { band: [0.4, 0.6] } })], residual: '', dropped: [],
    reduce: { kind: 'rules', rules: [
      { when: [{ id: 'risky', op: 'gte', value: 0.9 }], then: 'deny' },
      { when: [{ id: 'risky', op: 'uncertain' }], then: 'ask' },
    ], otherwise: 'allow' },
  }

  // Was a three-alternative regex over the decimal TEXT. Measured on this tree, it
  // accepted "0.4..0.6" — the band emitted verbatim, no inward step at all, which is the
  // single defect this block exists to prevent — and "0.45..0.55", and the two-ULP step.
  // The only wrong answer it rejected was the outward step, which the grid already
  // catches. So: parse it the way bouncer parses it and compare the NUMBERS.
  it('emits a range rule rather than refusing', () => {
    const rule = parse(emitBouncerPolicy(banded)).gate.rules[1]
    expect(rule.then).toBe('ask')
    expect(rule.when.risky.p).toMatch(/^\d*\.?\d+\.\.\d*\.?\d+$/)
  })
  it('places each endpoint exactly one double inside the exclusive band', () => {
    const p = parse(emitBouncerPolicy(banded)).gate.rules[1].when.risky.p
    const m = /^(\d*\.?\d+)\.\.(\d*\.?\d+)$/.exec(p)!
    // Both halves matter. The numbers pin the arithmetic: one double INWARD, so
    // nextUp(0.4) is above 0.4 and nextDown(0.6) below 0.6, and a step of two or a step
    // the wrong way is a different double. The round trip pins the SERIALISATION: the
    // endpoint bouncer recovers from the text has to be the endpoint rangeFor computed,
    // and a threshold written in a notation the consumer reads differently is how this
    // project shipped a wrong policy before.
    expect([p, Number(m[1]), Number(m[2])]).toEqual([p, nextUp(0.4), nextDown(0.6)])
    expect([Number(m[1]) > 0.4, Number(m[2]) < 0.6]).toEqual([true, true])
    // And the emitter writes the very string canEmit promised was writable — those are
    // two functions and nothing else holds them together.
    expect(p).toBe(rangeFor(banded.decisions[0]).p)
  })
  it('agrees with bouncer on the band edges, where inclusive and exclusive differ', () => {
    gridAgrees(banded, emitBouncerPolicy, bouncerVerdict)
  })

  // The same lowering on a decision that DECLARES no band. uncertaintyOf hands it
  // [0.35, 0.65], rangeFor steps that one inward exactly as it does a declared band, and
  // the emitted range is just as load-bearing — but it is the case a reader is least
  // likely to think of, and the grid was blind to it until gridFor started asking
  // uncertaintyOf instead of reading `d.uncertain`.
  const defaulted: Program = {
    decisions: [noul('vague')], residual: '', dropped: [],
    reduce: { kind: 'rules', rules: [
      { when: [{ id: 'vague', op: 'uncertain' }], then: 'ask' },
    ], otherwise: 'allow' },
  }

  it('lowers the DEFAULT band too, one double inside each end', () => {
    const p = parse(emitBouncerPolicy(defaulted)).gate.rules[0].when.vague.p
    const m = /^(\d*\.?\d+)\.\.(\d*\.?\d+)$/.exec(p)!
    expect([p, Number(m[1]), Number(m[2])]).toEqual([p, nextUp(0.35), nextDown(0.65)])
  })
  it('agrees with bouncer on the default band edges as well', () => {
    gridAgrees(defaulted, emitBouncerPolicy, bouncerVerdict)
  })
  it('still refuses an uncertainty rule on toolgate, which has no range', () => {
    expect(() => emitToolgatePolicy(banded)).toThrow(/uncertain/)
  })
})

describe('emitToolgatePolicy with only deny rules', () => {
  // toolgate applies both thresholds always, but ask == deny makes the ask band empty,
  // which is exactly what "deny at 0.85, otherwise allow" means. Refusing it was wrong:
  // "deny if X" is the commonest rule shape there is.
  const denyOnly: Program = { decisions: [noul('secrets')], residual: '', dropped: [],
    reduce: { kind: 'rules', rules: [
      { when: [{ id: 'secrets', op: 'gte', value: 0.85 }], then: 'deny' }], otherwise: 'allow' } }

  it('collapses ask onto deny instead of refusing', () => {
    expect(parse(emitToolgatePolicy(denyOnly)).thresholds).toEqual({ deny: 0.85, ask: 0.85 })
  })
  it('agrees with toolgate on the grid', () => {
    gridAgrees(denyOnly, emitToolgatePolicy, toolgateVerdict)
  })
  // The mirror image is NOT expressible: the largest legal deny threshold is 1, and
  // p = 1 then denies where the Program asks. Refused, with that as the reason.
  it('still refuses ask-only, where no deny threshold is faithful', () => {
    const askOnly: Program = { ...denyOnly, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'secrets', op: 'gte', value: 0.55 }], then: 'ask' }], otherwise: 'allow' } }
    expect(() => emitToolgatePolicy(askOnly)).toThrow(/deny/)
  })
})
