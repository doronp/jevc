/**
 * Conformance of the two POLICY targets against what their consumers actually do.
 *
 * The object under test is not the emitted YAML's shape — it is the VERDICT a real bouncer
 * or toolgate installation computes from that YAML. Three properties, in order of how much
 * they matter:
 *
 *   1. Agreement. For every answer set, the consumer's verdict equals `runReducer`'s.
 *      Six of this project's historical bugs were files that parsed cleanly and meant
 *      something else; every one of them is a point where these two disagree.
 *   2. Validity. Every policy this suite emits must LOAD. For bouncer that is a correctness
 *      property and not a formatting one: a policy file that exists but fails to parse
 *      STOPS policy resolution (target-bouncer.md:9) and routes to `on_error`, whose default
 *      `passthrough` emits nothing — so an invalid emitted policy does not fail loudly, it
 *      silently replaces a working gate with no gate, at exit 0.
 *   3. Refusal conformance. `canEmit(p, target)` is the documented "can this target honestly
 *      express this Program?" gate. A consumer branches on `canEmit(p, t).length === 0` and
 *      must not then get a throw — from the emitter, or from `canEmit` itself.
 *
 * The consumer transcriptions live in `test/helpers/consumers.ts` and are taken from
 * `docs/targets/target-*.md`, never from `src/emit/policy/*.ts`. A transcription read off the
 * emitter only asserts that the emitter agrees with itself.
 *
 * Tests whose name begins with `LIVE BUG` fail against the current tree on purpose. They are
 * the point of the exercise; do not weaken them, fix src/.
 */
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { canEmit } from '../src/emit/capability.js'
import { emitBouncerPolicy } from '../src/emit/policy/bouncer.js'
import { emitToolgatePolicy } from '../src/emit/policy/toolgate.js'
import { runReducer } from '../src/runtime.js'
import { buildProgram, loadFixtures } from '../src/check.js'
import type { Decision, Program } from '../src/ir.js'
import type { JevAnswer } from '../src/contract.js'
import {
  BOUNCER_NO_MATCH,
  TOOLGATE_BUILTINS,
  bouncerEmits,
  bouncerVerdict,
  straddle,
  toolgateVerdict,
  validateBouncerPolicy,
  validateToolgatePolicy,
} from './helpers/consumers.js'

/* ------------------------------------------------------------------ builders */

type Rule = Program['reduce']['rules'][number]
type Condition = Rule['when'][number]

const noul = (id: string, extra: Partial<Decision> = {}): Decision =>
  ({ id, kind: 'noul', instructions: `Does the tool call ${id}?`, ...extra })

const prog = (decisions: Decision[], rules: Rule[], otherwise = 'allow'): Program =>
  ({ decisions, reduce: { kind: 'rules', rules, otherwise }, residual: '', dropped: [] })

const gte = (id: string, value: number): Condition => ({ id, op: 'gte', value })
const lte = (id: string, value: number): Condition => ({ id, op: 'lte', value })
const uncertainOn = (id: string): Condition => ({ id, op: 'uncertain' })

/** Every policy this file emits, so the validity property can be asserted over all of them
 *  at once rather than once per call site (deliverable 3: "every policy the suite emits"). */
const EMITTED: Array<{ what: string; target: 'bouncer' | 'toolgate'; doc: unknown }> = []

const emitB = (what: string, p: Program, opts?: Parameters<typeof emitBouncerPolicy>[1]): unknown => {
  const doc: unknown = parse(emitBouncerPolicy(p, opts))
  EMITTED.push({ what, target: 'bouncer', doc })
  return doc
}
const emitT = (what: string, p: Program): unknown => {
  const doc: unknown = parse(emitToolgatePolicy(p))
  EMITTED.push({ what, target: 'toolgate', doc })
  return doc
}

/* ---------------------------------------------------------------- grid tools */

/** Every threshold and every band end in the program — the only values a verdict can turn
 *  on. `straddle` adds one ULP either side of each plus 0 / 0.5 / 1, so an off-by-one-tick
 *  boundary (inclusive vs exclusive) shows up as a disagreement rather than as luck. */
function seedsOf(p: Program): number[] {
  const s: number[] = []
  for (const r of p.reduce.rules) {
    for (const c of r.when) if ('value' in c && typeof c.value === 'number') s.push(c.value)
  }
  for (const d of p.decisions) {
    const u = d.uncertain
    if (u && 'band' in u) s.push(u.band[0], u.band[1])
  }
  return s
}

const answersOf = (row: Record<string, number>): Record<string, JevAnswer> =>
  Object.fromEntries(Object.entries(row).map(([id, v]) => [id, { type: 'noul', noul: v } as JevAnswer]))

/**
 * The full cross product of the grid over every question, `runReducer` against the consumer
 * transcription on each row. Returns the disagreements, so a failure names the answer set.
 *
 * The cross product is not optional. Bug 3 in this project's history — an AND reducer emitted
 * onto toolgate's OR — is invisible on the diagonal and only shows at asymmetric points like
 * `a = 0.9, b = 0.1`.
 */
function gridDiff(
  p: Program,
  doc: unknown,
  consumer: (doc: unknown, answers: Record<string, number>) => string,
): string[] {
  const ids = p.decisions.map(d => d.id)
  const grid = straddle(seedsOf(p))
  const out: string[] = []
  const walk = (i: number, row: Record<string, number>): void => {
    if (i === ids.length) {
      const want = runReducer(p, answersOf(row))
      const got = consumer(doc, row)
      if (want !== got) out.push(`${JSON.stringify(row)}: runReducer=${want} consumer=${got}`)
      return
    }
    // Computed keys and spread both CreateDataProperty, so an id of `__proto__` lands as an
    // own property here rather than walking into Object.prototype's setter.
    for (const v of grid) walk(i + 1, { ...row, [ids[i]]: v })
  }
  walk(0, {})
  return out
}

/* ============================================================================
 * 1. The transcriptions, checked against the docs' own verbatim examples.
 *
 * A transcription nobody pinned is a second implementation with no tests. These cases are
 * the behaviours the target docs state in prose; if one of them breaks, every grid diff
 * below is measuring the wrong thing.
 * ========================================================================== */

/** `policy/default.yaml` @ 9f3cc16, quoted at target-bouncer.md:171-338. Comment lines are
 *  removed and nothing else: a comment cannot change what the parser sees. */
const BOUNCER_DEFAULT = `
version: 1
backend: jev
mode: observe
timeout_ms: 800
on_error: passthrough
skip_permission_modes: [plan]
gate:
  tools: [Bash, Edit, Write, NotebookEdit]
  fast_path: ["git status", "git branch", "pwd", "ls", "ls ", "npm test"]
  questions:
    destructive:
      instructions: "The command permanently destroys work that would be hard to get back."
      criteria:
        "true": "rm of tracked files, git reset --hard, git push --force"
        "false": "creating or editing files, running tests, installing packages"
    secrets:
      instructions: "The command exposes the value of a credential."
      criteria:
        "true": "printing an API key, displaying the contents of a .env file"
        "false": "mentioning an environment variable by name without printing it"
    outside_repo:
      instructions: "The command acts on files outside the project directory."
    egress:
      instructions: "The command uploads data to a network host."
    prod:
      instructions: "The command acts on a production system or live customer data."
    sensitive_target:
      instructions: "The action changes configuration that controls what runs, or that holds credentials."
  rules:
    - when: { destructive: { p: ">=0.70" } }
      then: ask
    - when: { secrets: { p: ">=0.60" } }
      then: ask
    - when: { prod: { p: ">=0.60" } }
      then: ask
    - when: { outside_repo: { p: ">=0.65" } }
      then: ask
    - when: { egress: { p: ">=0.65" } }
      then: ask
    - when: { sensitive_target: { p: ">=0.60" } }
      then: ask
    - when: { any: { p: "0.40..0.60" } }
      then: ask
    - default: allow
`

/** `examples/toolgate.yaml` @ 2627de9, quoted at target-toolgate.md:110-150, with the
 *  commented-out `rules` / `questions` bodies uncommented so the non-empty branches of the
 *  transcription are exercised by the doc's own text rather than by something invented. */
const TOOLGATE_EXAMPLE = `
backend:
  provider: gateway
  model: typesafe-ai/jev
  timeout_ms: 2500
fail_mode: passthrough
thresholds:
  deny: 0.85
  ask: 0.55
gated_tools: "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|mcp__.*"
include_task_context: true
audit:
  enabled: true
  path: ~/.toolgate/audit.jsonl
  log_input: true
rules:
  - match: { tool: Bash, input_regex: 'terraform\\s+destroy' }
    action: ask
    reason: Infra teardown needs a human
questions:
  spends_money:
    type: boolean
    instructions: This tool call makes a purchase or changes billing.
    criteria:
      "true": buys, subscribes, or raises a spend limit
      "false": no billing effect
`

describe('transcription self-check: bouncer, against policy/default.yaml (target-bouncer.md:171-338)', () => {
  const doc: unknown = parse(BOUNCER_DEFAULT)

  it('the shipped default policy passes the validator built from the schema tables', () => {
    expect(validateBouncerPolicy(doc)).toEqual([])
  })

  // target-bouncer.md:64, step 3 — "Rules top-to-bottom, first match wins."
  it('takes the first matching rule, not the strictest and not the last', () => {
    // `destructive` is rule 0 and `secrets` rule 1; both match, and the doc's own note says
    // the specific rules sit above the uncertainty rule precisely so order decides.
    expect(bouncerVerdict(doc, { destructive: 0.95, secrets: 0.95 })).toBe('ask')
    expect(bouncerVerdict(doc, { destructive: 0.1, secrets: 0.1 })).toBe('allow')
  })

  // target-bouncer.md:65, step 4 — `any` is the only cross-question primitive.
  it('applies `any` to every ANSWERED question, and its range is inclusive at both ends', () => {
    expect(bouncerVerdict(doc, { destructive: 0.5, secrets: 0.1 })).toBe('ask')
    expect(bouncerVerdict(doc, { destructive: 0.4, secrets: 0.1 })).toBe('ask')
    expect(bouncerVerdict(doc, { destructive: 0.6, secrets: 0.1 })).toBe('ask')
    // 0.39 is below the band and below every specific threshold.
    expect(bouncerVerdict(doc, { destructive: 0.39, secrets: 0.1 })).toBe('allow')
  })

  // target-bouncer.md:64 — "A question with no answer is *skipped* (absence of evidence),
  // not treated as 0." A rule on an unanswered question must neither match nor terminate.
  it('skips a rule whose question was not answered instead of scoring it 0', () => {
    expect(bouncerVerdict(doc, { secrets: 0.95 })).toBe('ask')
    expect(bouncerVerdict(doc, {})).toBe('allow')
  })

  // target-bouncer.md:63, step 2 — "non-noul or out-of-range answers are dropped."
  it('drops an out-of-range answer rather than clamping it', () => {
    expect(bouncerVerdict(doc, { destructive: 1.5 })).toBe('allow')
    expect(bouncerVerdict(doc, { destructive: -0.1 })).toBe('allow')
    expect(bouncerVerdict(doc, { destructive: Number.NaN })).toBe('allow')
  })

  // target-bouncer.md:66, step 5 — the mode gate, applied AFTER the verdict.
  it('gates emission on mode: observe never emits, guard swallows allow, full emits all', () => {
    const observe: unknown = parse(BOUNCER_DEFAULT)
    expect(bouncerEmits(observe, 'deny')).toBeNull()
    const guard = { ...(observe as Record<string, unknown>), mode: 'guard' }
    expect(bouncerEmits(guard, 'allow')).toBeNull()
    expect(bouncerEmits(guard, 'ask')).toBe('ask')
    const full = { ...(observe as Record<string, unknown>), mode: 'full' }
    expect(bouncerEmits(full, 'allow')).toBe('allow')
  })

  // target-bouncer.md:59 — a policy with no `default` simply emits nothing on a non-match.
  it('reports no-match distinctly from a verdict when the rule list has no default', () => {
    const noDefault = {
      version: 1,
      gate: { questions: { q: { instructions: 'x' } }, rules: [{ when: { q: { p: '>=0.9' } }, then: 'deny' }] },
    }
    expect(validateBouncerPolicy(noDefault)).toEqual([])
    expect(bouncerVerdict(noDefault, { q: 0.1 })).toBe(BOUNCER_NO_MATCH)
    expect(bouncerEmits(noDefault, BOUNCER_NO_MATCH)).toBeNull()
  })

  // target-bouncer.md:55-57 — the p grammar has no exponent branch. This is bug 1's shape.
  it('refuses a `p` outside the comparison grammar, because bouncer would refuse to load it', () => {
    const exp = {
      version: 1,
      gate: { questions: { q: { instructions: 'x' } }, rules: [{ when: { q: { p: '>=1e-7' } }, then: 'deny' }] },
    }
    expect(validateBouncerPolicy(exp)).toHaveLength(1)
    expect(validateBouncerPolicy(exp)[0]).toMatch(/no exponent/)
    expect(() => bouncerVerdict(exp, { q: 0.5 })).toThrow(/would not load/)
  })
})

describe('transcription self-check: toolgate, against examples/toolgate.yaml (target-toolgate.md:110-150)', () => {
  const doc: unknown = parse(TOOLGATE_EXAMPLE)

  it('the committed reference policy passes the validator built from the schema table', () => {
    expect(validateToolgatePolicy(doc)).toEqual([])
  })

  // target-toolgate.md:66 — max over ALL questions, deny tested first.
  it('reduces by max over every question and tests deny before ask', () => {
    expect(toolgateVerdict(doc, { spends_money: 0.9 })).toBe('deny')
    expect(toolgateVerdict(doc, { spends_money: 0.6 })).toBe('ask')
    expect(toolgateVerdict(doc, { spends_money: 0.1 })).toBe('allow')
    // Exactly on both thresholds: `>=`, so 0.85 denies and 0.55 asks.
    expect(toolgateVerdict(doc, { spends_money: 0.85 })).toBe('deny')
    expect(toolgateVerdict(doc, { spends_money: 0.55 })).toBe('ask')
  })

  // target-toolgate.md:54-58 — the four built-ins are the merge base and always answer.
  it.each(TOOLGATE_BUILTINS)('lets the built-in question %s reach the same max()', id => {
    expect(toolgateVerdict(doc, { [id]: 0.9 })).toBe('deny')
  })

  // target-toolgate.md:78 — `off_task` is silently dropped with no task context, and it is
  // the ONLY one of the four that can be dropped.
  it('drops off_task, and only off_task, when there is no task context', () => {
    expect(toolgateVerdict(doc, { off_task: 0.99 }, { taskContext: false })).toBe('allow')
    expect(toolgateVerdict(doc, { privilege: 0.99 }, { taskContext: false })).toBe('deny')
  })

  // target-toolgate.md:27-28 — every key is optional; a policy without `thresholds` runs at
  // 0.85 / 0.55, which is what an emitted policy that omits them inherits.
  it('falls back to the documented 0.85 / 0.55 defaults when thresholds are absent', () => {
    expect(toolgateVerdict({ questions: { q: { type: 'boolean', instructions: 'x' } } }, { q: 0.86 })).toBe('deny')
    expect(toolgateVerdict({ questions: { q: { type: 'boolean', instructions: 'x' } } }, { q: 0.56 })).toBe('ask')
    expect(toolgateVerdict({ questions: { q: { type: 'boolean', instructions: 'x' } } }, { q: 0.54 })).toBe('allow')
  })
})

/* ============================================================================
 * 2. Grid diff — bouncer.
 * ========================================================================== */

const BOUNCER_SHAPES: Array<[string, Program]> = [
  ['single threshold',
    prog([noul('a')], [{ when: [gte('a', 0.8)], then: 'deny' }])],
  ['two questions, two different thresholds',
    prog([noul('a'), noul('b')], [
      { when: [gte('a', 0.8)], then: 'deny' },
      { when: [gte('b', 0.6)], then: 'ask' },
    ])],
  ['deny and ask on the same question',
    prog([noul('a')], [
      { when: [gte('a', 0.9)], then: 'deny' },
      { when: [gte('a', 0.5)], then: 'ask' },
    ])],
  // The OR form: one condition per rule, the same condition repeated per question. This is
  // the only disjunction bouncer can express, and it is what an AND reducer gets mistaken
  // for (bug 3). Asymmetric grid points are the ones that separate them.
  ['the OR form — one condition per rule, repeated per question',
    prog([noul('a'), noul('b')], [
      { when: [gte('a', 0.85)], then: 'deny' },
      { when: [gte('b', 0.85)], then: 'deny' },
    ])],
  ['lte, which inverts the comparison',
    prog([noul('a')], [{ when: [lte('a', 0.2)], then: 'deny' }])],
  // runReducer's band is EXCLUSIVE (`> lo && < hi`); bouncer's `LOW..HIGH` is INCLUSIVE.
  // `rangeFor` steps each end inward by one ULP to bridge that, so the ULP grid is the whole
  // test: an epsilon grid would round back onto the endpoint and prove nothing.
  ['an uncertainty band, whose ends are exclusive in the IR and inclusive in the policy',
    prog([noul('a', { uncertain: { band: [0.4, 0.6] } })], [
      { when: [uncertainOn('a')], then: 'ask' },
    ])],
  ['an uncertainty band on one of two questions',
    prog([noul('a', { uncertain: { band: [0.35, 0.65] } }), noul('b')], [
      { when: [gte('b', 0.9)], then: 'deny' },
      { when: [uncertainOn('a')], then: 'ask' },
    ])],
  // A question the reducer never reads still becomes a policy question, and bouncer asks it.
  // It must not acquire a threshold on the way out.
  ['a decision the reducer never references',
    prog([noul('a'), noul('unused')], [{ when: [gte('a', 0.8)], then: 'deny' }])],
  ['an ask rule listed before a deny rule (order the policy must preserve)',
    prog([noul('a')], [
      { when: [gte('a', 0.5)], then: 'ask' },
      { when: [gte('a', 0.9)], then: 'deny' },
    ])],
  ['a non-allow fallthrough',
    prog([noul('a')], [{ when: [lte('a', 0.2)], then: 'allow' }], 'deny')],
  // `__proto__`, `constructor` and `toString` are the ids that turn an object into a lookup
  // hazard: bug 6 was a decision id of `__proto__` hitting Object.prototype's setter and the
  // question vanishing from the emitted map.
  ['ids that collide with Object.prototype',
    prog([noul('__proto__'), noul('constructor')], [
      { when: [gte('__proto__', 0.8)], then: 'deny' },
      { when: [gte('constructor', 0.6)], then: 'ask' },
    ])],
  ['an id that YAML would round-trip as a boolean',
    prog([noul('yes'), noul('off')], [
      { when: [gte('yes', 0.8)], then: 'deny' },
      { when: [gte('off', 0.6)], then: 'ask' },
    ])],
  ['thresholds at the degenerate ends of the wire range',
    prog([noul('a'), noul('b')], [
      { when: [gte('a', 1)], then: 'deny' },
      { when: [gte('b', 0)], then: 'ask' },
    ])],
]

describe('grid diff: an emitted bouncer policy computes the same verdict as runReducer', () => {
  it.each(BOUNCER_SHAPES)('%s', (what, p) => {
    expect(canEmit(p, 'bouncer').filter(i => i.severity === 'error')).toEqual([])
    const doc = emitB(what, p)
    expect(gridDiff(p, doc, bouncerVerdict)).toEqual([])
  })

  // The emitted questions must survive the round-trip under their own names. A grid diff
  // cannot see a question that vanished if no rule reads it.
  it('emits every decision as a question, including ids that collide with Object.prototype', () => {
    const p = prog([noul('__proto__'), noul('toString'), noul('constructor'), noul('a')], [
      { when: [gte('a', 0.8)], then: 'deny' },
    ])
    const doc = emitB('prototype ids, unreferenced', p) as { gate: { questions: object } }
    expect(Object.keys(doc.gate.questions).sort()).toEqual(['__proto__', 'a', 'constructor', 'toString'])
  })
})

/* ============================================================================
 * 3. Grid diff — toolgate.
 * ========================================================================== */

const TOOLGATE_SHAPES: Array<[string, Program]> = [
  ['deny-only, one question',
    prog([noul('a')], [{ when: [gte('a', 0.85)], then: 'deny' }])],
  ['deny and ask, one question',
    prog([noul('a')], [
      { when: [gte('a', 0.85)], then: 'deny' },
      { when: [gte('a', 0.55)], then: 'ask' },
    ])],
  // Every question must carry both rules: max-over-questions applies the threshold to an
  // uncovered question anyway, so `toolgateThresholds` refuses the partial form. This is the
  // shape that actually maps.
  ['the OR form over two questions, deny rules before ask rules',
    prog([noul('a'), noul('b')], [
      { when: [gte('a', 0.85)], then: 'deny' },
      { when: [gte('b', 0.85)], then: 'deny' },
      { when: [gte('a', 0.55)], then: 'ask' },
      { when: [gte('b', 0.55)], then: 'ask' },
    ])],
  ['thresholds at the degenerate ends of the wire range',
    prog([noul('a')], [
      { when: [gte('a', 1)], then: 'deny' },
      { when: [gte('a', 0)], then: 'ask' },
    ])],
  // target-toolgate.md:77 — a user question reusing a built-in id REPLACES it wholesale.
  // Only `off_task` is reserved by canEmit, so the other three are emittable and must still
  // agree: the Program's question is the one that answers.
  ['an id that collides with a toolgate built-in and therefore shadows it',
    prog([noul('destructive')], [{ when: [gte('destructive', 0.85)], then: 'deny' }])],
  ['an id that collides with Object.prototype',
    prog([noul('__proto__')], [{ when: [gte('__proto__', 0.85)], then: 'deny' }])],
]

describe('grid diff: an emitted toolgate policy computes the same verdict as runReducer', () => {
  it.each(TOOLGATE_SHAPES)('%s', (what, p) => {
    expect(canEmit(p, 'toolgate').filter(i => i.severity === 'error')).toEqual([])
    const doc = emitT(what, p)
    expect(gridDiff(p, doc, (d, answers) => toolgateVerdict(d, answers))).toEqual([])
  })

  /**
   * The documented ceiling, asserted rather than assumed. toolgate's four built-in questions
   * always feed the same `max()` (target-toolgate.md:66, and the emitter's own header says
   * "adding one can only make the gate stricter"), so an emitted policy is strictly stricter
   * than the Program it came from: a built-in firing overrides the Program's verdict.
   *
   * This is a divergence between `runReducer` and the consumer that is NOT a bug — it is the
   * target's model. It is pinned here so that if the emitter ever gains a way to suppress the
   * built-ins, the claim in its header comment has to be revisited deliberately.
   */
  it('is strictly stricter than the Program: an unrelated built-in overrides the verdict', () => {
    const p = prog([noul('a')], [
      { when: [gte('a', 0.85)], then: 'deny' },
      { when: [gte('a', 0.55)], then: 'ask' },
    ])
    const doc = emitT('builtin-ceiling', p)
    expect(runReducer(p, answersOf({ a: 0 }))).toBe('allow')
    expect(toolgateVerdict(doc, { a: 0, exfiltration: 0.99 })).toBe('deny')
    expect(toolgateVerdict(doc, { a: 0, privilege: 0.6 })).toBe('ask')
  })
})

/* ============================================================================
 * 4. The property that matters most: an emitted policy is always a VALID policy.
 * ========================================================================== */

describe('emitted policies load: hazards', () => {
  // Bug 1's exact shape. bouncer's `p` grammar is `(>=|>|<=|<)\s*(\d*\.?\d+)` with no
  // exponent branch, so 1e-7 is inside the documented 0..1 range and still unreadable.
  it('refuses a bouncer threshold that serialises in exponent notation, and says why', () => {
    const p = prog([noul('a')], [{ when: [gte('a', 1e-7)], then: 'deny' }])
    expect(canEmit(p, 'bouncer').map(i => i.code)).toContain('threshold_unrepresentable')
    expect(() => emitBouncerPolicy(p)).toThrow(/plain decimal/i)
  })

  it('refuses a threshold outside 0..1 on both policy targets', () => {
    const p = prog([noul('a')], [{ when: [gte('a', 1e21)], then: 'deny' }])
    for (const t of ['bouncer', 'toolgate'] as const) {
      expect(canEmit(p, t).map(i => i.code)).toContain('threshold_out_of_target_range')
    }
    expect(() => emitBouncerPolicy(p)).toThrow()
    expect(() => emitToolgatePolicy(p)).toThrow()
  })

  // 1e-7 IS representable on toolgate — its thresholds are YAML numbers, not a string
  // grammar — so the correct behaviour there is to emit it, not to refuse.
  it('accepts an exponent threshold on toolgate, where thresholds are YAML numbers', () => {
    const p = prog([noul('a')], [{ when: [gte('a', 1e-7)], then: 'deny' }])
    const doc = emitT('exponent threshold', p) as { thresholds: { deny: unknown } }
    expect(doc.thresholds.deny).toBe(1e-7)
  })

  it('refuses a verdict outside the allow/ask/deny vocabulary', () => {
    const p = prog([noul('a')], [{ when: [gte('a', 0.8)], then: 'escalate' }])
    expect(canEmit(p, 'bouncer').map(i => i.code)).toContain('verdict_unsupported')
    expect(() => emitBouncerPolicy(p)).toThrow()
    expect(canEmit(p, 'toolgate').some(i => i.severity === 'error')).toBe(true)
    expect(() => emitToolgatePolicy(p)).toThrow()
  })

  it('refuses a decision id that collides with each target’s reserved name', () => {
    const anyId = prog([noul('any')], [{ when: [gte('any', 0.8)], then: 'deny' }])
    expect(canEmit(anyId, 'bouncer').map(i => i.code)).toContain('reserved_id')
    expect(() => emitBouncerPolicy(anyId)).toThrow(/reserved/)

    const offTask = prog([noul('off_task')], [{ when: [gte('off_task', 0.85)], then: 'deny' }])
    expect(canEmit(offTask, 'toolgate').map(i => i.code)).toContain('reserved_id')
    expect(() => emitToolgatePolicy(offTask)).toThrow(/reserved/)
  })

  // `rule.when.every(...)` over an empty list is `true`, so `when: []` is a rule that always
  // fires. Neither target can express "always", and a policy that silently dropped it would
  // change the verdict.
  it('refuses a rule with no conditions, which always matches', () => {
    const p = prog([noul('a')], [{ when: [], then: 'deny' }])
    expect(runReducer(p, answersOf({ a: 0 }))).toBe('deny')
    for (const t of ['bouncer', 'toolgate'] as const) {
      expect(canEmit(p, t).map(i => i.code)).toContain('rule_always_matches')
    }
    expect(() => emitBouncerPolicy(p)).toThrow()
    expect(() => emitToolgatePolicy(p)).toThrow()
  })

  // The provenance comment is the one place free text from a source document reaches the
  // emitted file. A newline, a `#`, a `"` or a U+2028 that survived into it would either
  // break the parse or — worse — open a new top-level key.
  const INJECTIONS: Array<[string, string]> = [
    ['a newline', 'a\nmode: full\n#'],
    ['a CRLF', 'a\r\nversion: 2\r\n#'],
    ['a lone CR', 'a\rversion: 2\r#'],
    ['a comment marker', 'a # mode: full'],
    ['a double quote', 'he said "mode: full"'],
    ['U+2028 LINE SEPARATOR', 'a mode: full #'],
    ['U+2029 PARAGRAPH SEPARATOR', 'a mode: full #'],
    ['U+0085 NEL', 'amode: full#'],
  ]
  it.each(INJECTIONS)('keeps %s in source.quote and source.file inert in the bouncer banner', (what, hostile) => {
    const p = prog([noul('a', { source: { file: hostile, line: 1, quote: hostile } })], [
      { when: [gte('a', 0.8)], then: 'deny' },
    ])
    const doc = emitB(`injection: ${what}`, p) as Record<string, unknown>
    expect(doc.version).toBe(1)
    expect(doc.mode).toBe('observe')
    expect(Object.keys(doc).sort()).toEqual(['backend', 'gate', 'mode', 'on_error', 'timeout_ms', 'version'])
  })

  it.each(INJECTIONS)('keeps %s in the residual inert on both policy targets', (what, hostile) => {
    const p = prog([noul('a')], [{ when: [gte('a', 0.85)], then: 'deny' }], 'allow')
    const withResidual: Program = { ...p, residual: `Judge the tone.${hostile}` }
    const b = emitB(`residual injection: ${what}`, withResidual) as Record<string, unknown>
    expect(Object.keys(b).sort()).toEqual(['backend', 'gate', 'mode', 'on_error', 'timeout_ms', 'version'])
    const t = emitT(`residual injection: ${what}`, withResidual) as Record<string, unknown>
    expect(Object.keys(t).sort()).toEqual(['questions', 'thresholds'])
    expect(t.thresholds).toEqual({ deny: 0.85, ask: 0.85 })
  })

  /**
   * Values YAML 1.2's core schema would round-trip as something other than a string. Bug 4
   * was `String()` on a union collapsing values; this is the same failure one layer down, in
   * the serialiser. An id that comes back as the boolean `true` is a question nobody can
   * write a rule against.
   */
  const YAML_TYPED = [
    'yes', 'no', 'on', 'off', 'true', 'false', 'null', '~', 'y', 'N',
    '1.0', '0x10', '007', '0o17', '.nan', '.inf', '-0', '1_000',
    '2026-09-19', '12:30', '<<', '=', ' ', 'a b', '- x', '? x', ': x', '#x',
  ]

  it.each(YAML_TYPED)('round-trips the question id %j through the bouncer policy unchanged', id => {
    const p = prog([noul(id)], [{ when: [gte(id, 0.8)], then: 'deny' }])
    const doc = emitB(`yaml-typed id ${JSON.stringify(id)}`, p) as {
      gate: { questions: Record<string, unknown>; rules: Array<Record<string, unknown>> }
    }
    // Both the declaration and the rule reference: a rule naming a question that is not
    // declared is a bouncer LOAD error, so they have to change together or not at all.
    expect(Object.keys(doc.gate.questions)).toEqual([id])
    expect(Object.keys(doc.gate.rules[0].when as object)).toEqual([id])
  })

  it.each(YAML_TYPED)('round-trips the question id %j through the toolgate policy unchanged', id => {
    const p = prog([noul(id)], [{ when: [gte(id, 0.85)], then: 'deny' }])
    const doc = emitT(`yaml-typed id ${JSON.stringify(id)}`, p) as { questions: Record<string, unknown> }
    expect(Object.keys(doc.questions)).toEqual([id])
  })

  // `instructions` is held fixed here: bouncer requires it non-empty after a trim, so a
  // blank value is a refusal (asserted separately below) rather than a round-trip.
  it.each(YAML_TYPED)('round-trips %j as criteria text unchanged on both targets', text => {
    const p = prog([noul('a', { instructions: 'Is it a?', criteria: { true: text, false: text } })], [
      { when: [gte('a', 0.85)], then: 'deny' },
    ])
    const b = emitB(`yaml-typed criteria ${JSON.stringify(text)}`, p) as {
      gate: { questions: { a: { criteria: Record<string, unknown> } } }
    }
    expect(b.gate.questions.a.criteria.true).toBe(text)
    expect(b.gate.questions.a.criteria.false).toBe(text)
    const t = emitT(`yaml-typed criteria ${JSON.stringify(text)}`, p) as {
      questions: { a: { criteria: Record<string, unknown> } }
    }
    expect(t.questions.a.criteria.true).toBe(text)
    expect(t.questions.a.criteria.false).toBe(text)
  })

  it.each(YAML_TYPED.filter(t => t.trim() !== ''))('round-trips %j as instructions text unchanged', text => {
    const p = prog([noul('a', { instructions: text })], [{ when: [gte('a', 0.85)], then: 'deny' }])
    const b = emitB(`yaml-typed instructions ${JSON.stringify(text)}`, p) as {
      gate: { questions: { a: { instructions: unknown } } }
    }
    expect(b.gate.questions.a.instructions).toBe(text)
    const t = emitT(`yaml-typed instructions ${JSON.stringify(text)}`, p) as {
      questions: { a: { instructions: unknown } }
    }
    expect(t.questions.a.instructions).toBe(text)
  })

  // target-bouncer.md:43 — `instructions` is required and non-empty, and a policy bouncer
  // refuses to load is the silent-gate failure, so a blank one must be refused at emit time.
  it.each(['', ' ', '\t', '\n'])('refuses blank bouncer instructions (%j) rather than emitting them', blank => {
    const p = prog([{ id: 'a', kind: 'noul', instructions: blank }], [{ when: [gte('a', 0.85)], then: 'deny' }])
    expect(canEmit(p, 'bouncer').map(i => i.code)).toContain('instructions_empty')
    expect(() => emitBouncerPolicy(p)).toThrow(/non-empty instructions/)
  })

  /**
   * LIVE BUG. `Condition.value` is TYPED `number` and is not one at runtime: `emit-policy`
   * JSON.parses a file the README (:225) calls "the shape `--lift` asks the agent to
   * produce" — model output — and casts it. Every type check on that value in jevc is a
   * RELATIONAL comparison, which coerces:
   *
   *   ir.ts          `!(c.value >= 0 && c.value <= 1)`        "0.8" >= 0  -> true
   *   capability.ts  `c.value < cap.thresholdRange[0] || ...` "0.8" > 1   -> false
   *   capability.ts  `!(ask < deny)`                          string compare, not numeric
   *
   * bouncer survives this because `cmp()` renders the threshold through a string template
   * (`>=${v}`) and `thresholdPattern` rejects anything that does not serialise as a plain
   * decimal. toolgate has no `thresholdPattern` and its emitter copies `c.value` straight
   * into `stringify({ thresholds })`, so whatever type arrived lands in the policy file
   * where target-toolgate.md:27-28 declares `number`.
   *
   * Verified end-to-end, not just through the library:
   *   $ node dist/cli.js emit-policy --for toolgate prog.json   # {"value":"0.8"}
   *   thresholds:
   *     deny: "0.8"
   *     ask: "0.8"
   *   EXIT=0
   *
   * NaN is the sharpest case: it emits `.nan`, which fails toolgate's own hard validation
   * of `0 <= ask <= deny <= 1`, so the policy does not load at all.
   */
  const NON_NUMBER_THRESHOLDS: Array<[string, unknown]> = [
    ['a numeric string, the shape a lifted JSON program actually arrives in', '0.8'],
    ['an empty string, which coerces to 0 and denies everything', ''],
    ['a string in exponent notation', '1e-7'],
    ['the boolean true, which coerces to 1', true],
    ['null, which coerces to 0 and denies everything', null],
    ['NaN, which toolgate’s own 0 <= ask <= deny <= 1 check then fails', Number.NaN],
  ]
  const withThreshold = (value: unknown): Program =>
    prog([noul('a')], [{ when: [{ id: 'a', op: 'gte', value } as unknown as Condition], then: 'deny' }])

  it('LIVE BUG: toolgate copies a non-number threshold into the policy file verbatim', () => {
    const escaped: string[] = []
    for (const [what, value] of NON_NUMBER_THRESHOLDS) {
      const p = withThreshold(value)
      // canEmit is the documented gate. If it refused, a caller would at least be told.
      const refused = canEmit(p, 'toolgate').filter(i => i.severity === 'error').map(i => i.code)
      if (refused.length) continue
      const doc = parse(emitToolgatePolicy(p)) as { thresholds: { deny: unknown; ask: unknown } }
      const errors = validateToolgatePolicy(doc)
      if (errors.length) {
        escaped.push(`${what}: canEmit clean, emitted thresholds ${JSON.stringify(doc.thresholds)} — ${errors.join('; ')}`)
      }
    }
    expect(escaped).toEqual([])
  })

  // The same inputs on bouncer, for contrast: `thresholdPattern` catches every one of them
  // that does not serialise as a plain decimal. If this ever starts failing, a fix for the
  // bug above was applied to the wrong layer.
  it('bouncer already refuses every threshold that does not serialise as a plain decimal', () => {
    const slipped: string[] = []
    for (const [what, value] of NON_NUMBER_THRESHOLDS) {
      if (typeof value === 'string' && /^\d*\.?\d+$/.test(value)) continue   // normalised by `cmp()`
      const codes = canEmit(withThreshold(value), 'bouncer').map(i => i.code)
      if (!codes.includes('threshold_unrepresentable')) slipped.push(`${what}: ${JSON.stringify(codes)}`)
    }
    expect(slipped).toEqual([])
  })
})

/* ============================================================================
 * 5. Refusal conformance.
 *
 * `canEmit` is the documented "can this target honestly express this Program?" gate. Its
 * contract has two halves and both are load-bearing for a library consumer:
 *   - it RETURNS issues; it does not throw, or the `.length === 0` branch never runs.
 *   - it agrees with the emitter, or a caller past a clean gate gets a throw anyway.
 * ========================================================================== */

const CORPUS: Array<{ id: string; program: Program }> =
  loadFixtures('fixtures').map(f => ({ id: f.id, program: buildProgram(f) }))

/** The same corpus rewritten so each Program has a reducer the policy targets can consider —
 *  otherwise almost every fixture is refused for its reducer and the question-level checks
 *  never run. Deny above 0.85, ask above 0.55, one rule per decision: the OR form. */
const CORPUS_WITH_POLICY_REDUCER: Array<{ id: string; program: Program }> = CORPUS
  .filter(({ program }) => program.decisions.length > 0 && program.decisions.every(d => d.kind === 'noul'))
  .map(({ id, program }) => ({
    id,
    program: {
      ...program,
      reduce: {
        kind: 'rules',
        rules: [
          ...program.decisions.map(d => ({ when: [gte(d.id, 0.85)], then: 'deny' })),
          ...program.decisions.map(d => ({ when: [gte(d.id, 0.55)], then: 'ask' })),
        ],
        otherwise: 'allow',
      },
    },
  }))

describe('refusal conformance: canEmit is the gate the emitter enforces', () => {
  it('found a corpus to check', () => {
    expect(CORPUS.length).toBeGreaterThan(10)
    expect(CORPUS_WITH_POLICY_REDUCER.length).toBeGreaterThan(0)
  })

  /**
   * LIVE BUG. `canEmit` does `!d.instructions.trim()` behind `cap.requiresInstructions`,
   * which only bouncer sets (src/emit/capability.ts:220). `Decision.instructions` is TYPED
   * `string` and is not one at runtime — ir.ts's own `lintableText` doc-comment says so:
   * "the wire contract allows the structured `EntryType` form, `check.ts`'s `buildProgram`
   * passes it through with `as never`, and 10 decisions across 2 fixtures in this repo's own
   * corpus use it". Those two fixtures are in `fixtures/`, so this reproduces on the
   * project's own data, with no synthetic input at all.
   *
   * The consequence is exactly the §3 contract violation: a consumer that branches on
   * `canEmit(p, t).length === 0` gets `TypeError: d.instructions.trim is not a function`
   * instead of an issue it can report. `emitBouncerPolicy` inherits the throw, because it
   * calls `canEmit` first — so the actionable "this target requires non-empty instructions"
   * message is replaced by a stack trace naming jevc's internals.
   */
  it('LIVE BUG: canEmit returns issues and never throws, on every program in the corpus', () => {
    const threw: string[] = []
    for (const { id, program } of CORPUS) {
      for (const target of ['bouncer', 'toolgate'] as const) {
        try {
          canEmit(program, target)
        } catch (e) {
          threw.push(`${target} / ${id}: ${(e as Error).message}`)
        }
      }
    }
    expect(threw).toEqual([])
  })

  it('LIVE BUG: canEmit reports a non-string instructions value instead of throwing on it', () => {
    for (const instructions of [null, 42, { type: 'text', text: 'Is it destructive?' }]) {
      const p = prog([{ id: 'a', kind: 'noul', instructions: instructions as unknown as string }], [
        { when: [gte('a', 0.8)], then: 'deny' },
      ])
      expect(() => canEmit(p, 'bouncer')).not.toThrow()
      // Deliberately NOT pinned to `instructions_empty`: bouncer requires a non-empty
      // string, and a fix is free to report that as a new code (`instructions_not_string`)
      // rather than overloading the empty-string one. What the gate owes its caller is an
      // ERROR-severity issue rather than a stack trace; that is all this asserts, so the
      // first fix that lands turns this test's `it.fails` red instead of leaving it green
      // on a different thrown assertion.
      expect(canEmit(p, 'bouncer').filter(i => i.severity === 'error')).not.toEqual([])
    }
  })

  // The two halves of the gate, over every corpus program that gets far enough to be judged.
  it.each(['bouncer', 'toolgate'] as const)(
    'a clean canEmit means the %s emitter does not throw, and a throw means canEmit refused',
    target => {
      const emit = target === 'bouncer' ? emitBouncerPolicy : emitToolgatePolicy
      const disagreements: string[] = []
      for (const { id, program } of CORPUS_WITH_POLICY_REDUCER) {
        let refused: string[]
        try {
          refused = canEmit(program, target).filter(i => i.severity === 'error').map(i => i.code)
        } catch (e) {
          // Covered by the LIVE BUG test above; not double-counted here.
          void e
          continue
        }
        let threw: string | undefined
        try {
          const doc: unknown = parse(emit(program))
          EMITTED.push({ what: `corpus ${target} ${id}`, target, doc })
        } catch (e) {
          threw = (e as Error).message
        }
        if (refused.length && !threw) disagreements.push(`${id}: canEmit refused (${refused.join(',')}) but the emitter produced a file`)
        if (!refused.length && threw) disagreements.push(`${id}: canEmit was clean but the emitter threw: ${threw.split('\n')[0]}`)
      }
      expect(disagreements).toEqual([])
    },
  )

  /**
   * Every refusal must be diagnosable from its own text. `canEmit`'s issues are surfaced
   * verbatim by the CLI and by the emitter's throw, so a message that does not name the
   * target and the offending decision sends the user to read capability.ts.
   *
   * The bar asserted below is deliberately objective — names the target, names the path,
   * carries into the throw. It is NOT "suggests a fix": `kind_unsupported` currently states
   * the constraint ("Target bouncer accepts only noul questions") without the remedy the
   * target doc gives (target-bouncer.md:88, "jevc must lower every choice/score decision to
   * one or more noul decisions before emitting"), and a wording bar is not something a test
   * should adjudicate.
   */
  const REFUSABLE: Array<[string, Program, 'bouncer' | 'toolgate']> = [
    ['a conjunction, which neither target can express',
      prog([noul('a'), noul('b')], [{ when: [gte('a', 0.8), gte('b', 0.6)], then: 'deny' }]), 'bouncer'],
    ['a score decision on a noul-only target',
      prog([{ id: 'a', kind: 'score', instructions: 'How bad?', criteria: { levels: ['none', 'some', 'lots'] } } as unknown as Decision],
        [{ when: [gte('a', 1)], then: 'deny' }]), 'bouncer'],
    ['a choice equality, which has no shape on a probability-only target',
      prog([{ id: 'a', kind: 'choice', instructions: 'Which?', criteria: { options: { x: 'x', y: 'y' } } } as unknown as Decision],
        [{ when: [{ id: 'a', op: 'is', value: 'x' } as Condition], then: 'deny' }]), 'bouncer'],
    ['a program with no decisions at all',
      prog([], [], 'deny'), 'bouncer'],
    ['empty instructions on a target that requires them',
      prog([{ id: 'a', kind: 'noul', instructions: '   ' }], [{ when: [gte('a', 0.8)], then: 'deny' }]), 'bouncer'],
    ['a reserved id',
      prog([noul('any')], [{ when: [gte('any', 0.8)], then: 'deny' }]), 'bouncer'],
    ['two different deny thresholds, which max-over-questions cannot apply',
      prog([noul('a'), noul('b')], [
        { when: [gte('a', 0.9)], then: 'deny' },
        { when: [gte('b', 0.7)], then: 'deny' },
      ]), 'toolgate'],
    ['a deny rule after an ask rule, which toolgate always reorders',
      prog([noul('a')], [
        { when: [gte('a', 0.55)], then: 'ask' },
        { when: [gte('a', 0.85)], then: 'deny' },
      ]), 'toolgate'],
    ['a question with no deny rule, which the deny threshold still applies to',
      prog([noul('a'), noul('b')], [{ when: [gte('a', 0.85)], then: 'deny' }]), 'toolgate'],
    ['no deny rule at all, where even deny: 1 denies at p = 1',
      prog([noul('a')], [{ when: [gte('a', 0.55)], then: 'ask' }]), 'toolgate'],
    ['a non-allow fallthrough, where toolgate’s is always allow',
      prog([noul('a')], [{ when: [gte('a', 0.85)], then: 'deny' }], 'ask'), 'toolgate'],
  ]

  it.each(REFUSABLE)('refuses %s, from canEmit and from the emitter alike', (_what, p, target) => {
    const issues = canEmit(p, target).filter(i => i.severity === 'error')
    expect(issues.length).toBeGreaterThan(0)
    for (const i of issues) {
      expect(i.code).toMatch(/^[a-z_]+$/)
      expect(i.path).not.toBe('')
      expect(i.message.length).toBeGreaterThan(40)
    }
    const anonymous = issues
      .filter(i => !i.message.includes(target) && !i.message.includes(i.path))
      .map(i => `${i.code} names neither the target nor its path: ${i.message}`)
    expect(anonymous).toEqual([])
    const emit = target === 'bouncer' ? emitBouncerPolicy : emitToolgatePolicy
    expect(() => emit(p)).toThrow()
    // The throw has to carry the issues, or the library caller who skipped canEmit is told
    // only that it failed.
    try {
      emit(p)
    } catch (e) {
      expect((e as Error).message).toContain(issues[0].message)
    }
  })

  it('reports an unknown target as an issue rather than throwing', () => {
    const p = prog([noul('a')], [{ when: [gte('a', 0.8)], then: 'deny' }])
    const issues = canEmit(p, 'bouncer-v2')
    expect(issues.map(i => i.code)).toEqual(['unknown_target'])
    expect(issues[0].message).toMatch(/Known: /)
  })
})

describe('the property: every policy this suite emitted is a policy its consumer will load', () => {
  // Runs last on purpose — `EMITTED` is filled by the describes above. Each entry is named,
  // so a failure points at the case that produced the bad file rather than at a count.
  it('every emitted bouncer policy passes the schema validator', () => {
    const bad = EMITTED.filter(e => e.target === 'bouncer')
      .map(e => ({ what: e.what, errors: validateBouncerPolicy(e.doc) }))
      .filter(e => e.errors.length)
    expect(bad).toEqual([])
  })

  it('every emitted toolgate policy passes the schema validator', () => {
    const bad = EMITTED.filter(e => e.target === 'toolgate')
      .map(e => ({ what: e.what, errors: validateToolgatePolicy(e.doc) }))
      .filter(e => e.errors.length)
    expect(bad).toEqual([])
  })

  it('emitted enough policies for the two assertions above to mean something', () => {
    expect(EMITTED.filter(e => e.target === 'bouncer').length).toBeGreaterThan(40)
    expect(EMITTED.filter(e => e.target === 'toolgate').length).toBeGreaterThan(30)
  })

  /**
   * A seeded sweep over the same shape space, so the property holds over programs nobody
   * hand-picked. Deterministic (fixed LCG seed, no clock, no network) and bounded, so it is
   * a regression test rather than a flake: emit, parse, validate, and diff the verdict grid
   * against `runReducer` on every program either target accepts.
   */
  it('holds over a seeded sweep of generated programs, verdicts included', () => {
    let state = 20260919
    const rnd = (): number => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
    const THRESHOLDS = [0, 0.2, 0.35, 0.5, 0.55, 0.7, 0.85, 1, 1 / 3] as const
    const IDS = ['a', 'b', '__proto__', 'constructor', 'yes', 'null', '007', 'destructive'] as const
    const VERDICTS = ['allow', 'ask', 'deny'] as const

    const invalid: string[] = []
    const diverged: string[] = []
    let emitted = 0

    for (let i = 0; i < 400; i++) {
      const ids = [...new Set([pick(IDS), pick(IDS)])]
      const rules: Rule[] = []
      for (let r = 0; r < 1 + Math.floor(rnd() * 3); r++) {
        const id = pick(ids)
        const op = rnd() < 0.15 ? 'uncertain' : rnd() < 0.5 ? 'lte' : 'gte'
        rules.push(op === 'uncertain'
          ? { when: [uncertainOn(id)], then: pick(VERDICTS) }
          : { when: [op === 'gte' ? gte(id, pick(THRESHOLDS)) : lte(id, pick(THRESHOLDS))], then: pick(VERDICTS) })
      }
      const band: [number, number] | undefined = rnd() < 0.35
        ? [pick([0.1, 0.3, 0.35, 0.4]), pick([0.6, 0.65, 0.7, 0.9])]
        : undefined
      const p = prog(
        ids.map(id => noul(id, band ? { uncertain: { band } } : {})),
        rules,
        pick(VERDICTS),
      )
      const label = JSON.stringify({ ids, rules: p.reduce.rules, band, otherwise: p.reduce.otherwise })

      for (const [target, emit, validate, consumer] of [
        ['bouncer', emitBouncerPolicy, validateBouncerPolicy, bouncerVerdict],
        ['toolgate', emitToolgatePolicy, validateToolgatePolicy, toolgateVerdict],
      ] as const) {
        if (canEmit(p, target).some(x => x.severity === 'error')) continue
        emitted++
        let doc: unknown
        try {
          doc = parse(emit(p))
        } catch (e) {
          invalid.push(`${target} threw after a clean canEmit: ${label} — ${(e as Error).message.split('\n')[0]}`)
          continue
        }
        const errors = validate(doc)
        if (errors.length) invalid.push(`${target} ${label}: ${errors.join('; ')}`)
        const d = gridDiff(p, doc, (policy, answers) => consumer(policy, answers))
        if (d.length) diverged.push(`${target} ${label}: ${d[0]}`)
      }
    }

    expect(emitted).toBeGreaterThan(100)
    expect(invalid.slice(0, 5)).toEqual([])
    expect(diverged.slice(0, 5)).toEqual([])
  })
})
