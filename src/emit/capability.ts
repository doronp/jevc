import type { ValidationIssue } from '../contract.js'
import { uncertaintyOf, type Decision, type Program } from '../ir.js'

export type TargetCapability = {
  name: string
  kinds: ReadonlyArray<'noul' | 'choice' | 'score'>
  /** 'code': arbitrary reducer. 'single-condition': one question per rule. 'thresholds': per-question only. */
  reducer: 'code' | 'single-condition' | 'thresholds'
  /** Thresholds must fall in this range, or undefined for level-index space. */
  thresholdRange?: [number, number]
  /**
   * Applied to the SERIALISED threshold, because that is what the consumer parses.
   * bouncer alone needs it: its `p` is a STRING with the grammar
   * `(>=|>|<=|<)\s*(\d*\.?\d+)` — no exponent — and JS renders anything below 1e-6
   * exponentially, so 1e-7 is inside thresholdRange yet unloadable. toolgate's
   * thresholds are YAML numbers written by stringify() and read back by the same `yaml`
   * package, where 1e-7 round-trips fine, so the pattern does not apply there.
   * Range and pattern catch different failures; bouncer needs both.
   */
  thresholdPattern?: RegExp
  /**
   * The verdict words the target's own parser accepts, or undefined where any string
   * goes (the code targets return whatever the reducer returns). jevc verdicts are
   * arbitrary strings, so a target with a fixed vocabulary must be checked against it.
   */
  verdicts?: ReadonlySet<string>
  /**
   * The target's loader rejects a question with empty instructions. Only bouncer
   * documents that requirement (target-bouncer.md:43); toolgate accepts any string, and
   * jevc's own contract lets a noul carry criteria instead of instructions, so this is
   * not a universal rule and is not applied as one.
   */
  requiresInstructions?: boolean
  /**
   * Question ids the target's own engine has already taken. Using one does not fail to
   * load — it silently means something else — so it is refused here rather than emitted.
   */
  reservedIds?: Readonly<Record<string, string>>
  /**
   * The target can express `op: 'uncertain'` as a probability RANGE. bouncer's `p` takes
   * an inclusive `LOW..HIGH`; toolgate has two scalars and no range at all.
   */
  rangeCondition?: boolean
  carriesConfidence: boolean
  carriesLegend: boolean
  note?: string
}

/** Decimal only: no exponent, no sign. Matches bouncer's `p` grammar. */
const PLAIN_DECIMAL = /^\d*\.?\d+$/

export const TARGETS: Record<string, TargetCapability> = {
  sdk:       { name: 'sdk', kinds: ['noul', 'choice', 'score'], reducer: 'code',
               carriesConfidence: true, carriesLegend: true },
  json:      { name: 'json', kinds: ['noul', 'choice', 'score'], reducer: 'code',
               carriesConfidence: true, carriesLegend: true },
  langchain: { name: 'langchain', kinds: ['noul', 'choice', 'score'], reducer: 'code',
               carriesConfidence: true, carriesLegend: true },
  'ai-sdk':  { name: 'ai-sdk', kinds: ['noul', 'choice', 'score'], reducer: 'code',
               carriesConfidence: false, carriesLegend: false,
               note: 'EvaluationModelV4 drops legend and moves confidence into providerMetadata, where it may be absent.' },
  bouncer:   { name: 'bouncer', kinds: ['noul'], reducer: 'single-condition',
               thresholdRange: [0, 1], thresholdPattern: PLAIN_DECIMAL,
               verdicts: new Set(['allow', 'ask', 'deny']), requiresInstructions: true,
               reservedIds: { any: 'bouncer reads `any` in a rule as "any question", not as a question named "any".' },
               rangeCondition: true,
               carriesConfidence: false, carriesLegend: false,
               note: 'gate.questions has no type key; every question is sent as a noul. A rule names exactly one question.' },
  toolgate:  { name: 'toolgate', kinds: ['noul'], reducer: 'thresholds',
               thresholdRange: [0, 1],
               reservedIds: { off_task: 'toolgate drops off_task when there is no task context, so the question would vanish.' },
               carriesConfidence: false, carriesLegend: false,
               note: 'validatePolicy throws unless every question is type: boolean.' },
}

const issue = (code: string, path: string, message: string): ValidationIssue =>
  ({ code, path, message, severity: 'error' })

const F64 = new DataView(new ArrayBuffer(8))
/**
 * The adjacent double. jevc's uncertainty band is EXCLUSIVE at both ends (runtime.ts
 * isUncertain) and bouncer's `LOW..HIGH` is INCLUSIVE, so a faithful lowering moves each
 * endpoint inwards by exactly one representable step — otherwise the two answer
 * differently at precisely p == LOW and p == HIGH. Probabilities only, hence x >= 0.
 */
function step(x: number, up: boolean): number {
  if (!Number.isFinite(x) || x < 0) return NaN
  if (x === 0) return up ? Number.MIN_VALUE : NaN
  F64.setFloat64(0, x)
  F64.setBigUint64(0, F64.getBigUint64(0) + (up ? 1n : -1n))
  return F64.getFloat64(0)
}

/**
 * The `p` string for `op: 'uncertain'` on a range target, or why it cannot be written.
 * Exported so the emitter writes the same string canEmit promised was writable.
 */
export function rangeFor(d: Decision): { p?: string; why?: string } {
  const u = uncertaintyOf(d)
  if (!('band' in u)) {
    return { why: `"${d.id}" is uncertain below a confidence, and a bouncer answer carries a probability and no confidence.` }
  }
  const [lo, hi] = u.band
  const a = step(lo, true), b = step(hi, false)
  if (!(a <= b)) {
    return { why: `the band ${JSON.stringify(u.band)} on "${d.id}" is empty once its exclusive ends are stepped inside an inclusive range.` }
  }
  if (!PLAIN_DECIMAL.test(String(a)) || !PLAIN_DECIMAL.test(String(b))) {
    return { why: `the band ${JSON.stringify(u.band)} on "${d.id}" serialises to "${a}..${b}", and the p grammar has no exponent.` }
  }
  return { p: `${a}..${b}` }
}

/**
 * toolgate's reducer is not per-question thresholds. It takes the MAX probability over
 * every question, then `>= deny` => deny, `>= ask` => ask, else allow — two scalars, and
 * that is the entire tunable surface. Emitting a per-question threshold map produces YAML
 * toolgate accepts and ignores, leaving deny/ask at their 0.85/0.55 defaults: a policy
 * that loads cleanly and means something else. So the reducer is lowered only when it is
 * genuinely max-then-two-thresholds shaped, and refused otherwise.
 *
 * Lives here, beside canEmit, because it IS the answer to "can this be emitted" — while
 * it sat in the emitter, canEmit returned [] for a dozen programs the emitter then threw
 * on, and canEmit is the gate a library consumer branches on.
 */
export function toolgateThresholds(p: Program): { thresholds?: { deny: number; ask: number }; issues: ValidationIssue[] } {
  const out: ValidationIssue[] = []
  // Each issue stands alone — a ValidationIssue is read one at a time, and canEmit now
  // reports every one of these at once rather than throwing on the first.
  const no = (path: string, why: string) => out.push(issue('reducer_unrepresentable', path,
    `${why} toolgate reduces by max(probability) over all questions, then two scalars (deny, ask). ` +
    `Express the reducer as one shared deny threshold and one shared ask threshold over every question, or emit to a code target.`))

  if (p.reduce.otherwise !== 'allow') no('reduce.otherwise', `the fallthrough is "${p.reduce.otherwise}"; toolgate's is always allow.`)

  const byVerdict = new Map<string, Set<number>>()
  const covered = new Map<string, Set<string>>()   // verdict -> question ids
  let sawAsk = false
  for (const [i, r] of p.reduce.rules.entries()) {
    if (r.then !== 'deny' && r.then !== 'ask') { no(`reduce.rules[${i}].then`, `rule verdict "${r.then}" is not deny or ask.`); continue }
    // jevc's reducer is first-match-wins over an ORDERED list; toolgate always tests
    // `>= deny` before `>= ask`. A deny rule sitting after an ask rule therefore means
    // something the policy cannot: with ask 0.55 listed first and deny 0.85 second, the
    // Program answers `ask` at p=0.9 and the emitted policy answers `deny`. Every
    // threshold is legal and every question covered, so nothing else here catches it.
    if (r.then === 'ask') sawAsk = true
    else if (sawAsk) no(`reduce.rules[${i}]`, `a deny rule comes after an ask rule; toolgate always tests deny first, so the order cannot be preserved. List every deny rule before every ask rule.`)
    for (const c of r.when) {
      // `is` and `uncertain` are reported once, generically, by canEmit below.
      if (c.op !== 'gte') { if (c.op === 'lte') no(`reduce.rules[${i}]`, `condition op "lte" on "${c.id}"; only >= maps to a threshold.`); continue }
      byVerdict.set(r.then, (byVerdict.get(r.then) ?? new Set()).add(c.value))
      covered.set(r.then, (covered.get(r.then) ?? new Set()).add(c.id))
    }
  }

  for (const verdict of byVerdict.keys()) {
    const vals = byVerdict.get(verdict)!
    if (vals.size > 1) no('reduce.rules', `${verdict} uses ${vals.size} different thresholds (${[...vals].join(', ')}); max-over-questions can only apply one.`)
    const ids = covered.get(verdict)!
    const missing = p.decisions.filter(d => !ids.has(d.id)).map(d => d.id)
    // Max-over-questions means an uncovered question still feeds the same threshold —
    // stricter than the Program says. Silent tightening is still silent divergence.
    if (missing.length) no('reduce.rules', `questions ${missing.join(', ')} have no ${verdict} rule, but max-over-questions applies the ${verdict} threshold to them anyway.`)
  }

  if (!byVerdict.has('deny')) {
    // The largest legal deny threshold is 1, and at p == 1 that still denies where the
    // Program asks. There is no faithful lowering, so this one really is refused.
    no('reduce.rules', `no deny rule; toolgate always applies a deny threshold, and even deny: 1 denies at p = 1 where this program does not.`)
  }
  if (out.length) return { issues: out }

  const deny = [...byVerdict.get('deny')!][0]
  // Deny-only is expressible and common ("deny if X, otherwise allow"): ask == deny makes
  // the ask band empty, which is exactly what the Program says. But when the Program HAS
  // ask rules, ask == deny silently deletes that verdict — toolgate tests `>= deny`
  // first, so every probability that would have asked denies instead.
  const askVals = byVerdict.get('ask')
  const ask = askVals ? [...askVals][0] : deny
  if (askVals && !(ask < deny)) {
    no('reduce.rules', `ask (${ask}) is not below deny (${deny}); toolgate tests deny first, so the ask threshold would never be reached.`)
    return { issues: out }
  }
  return { thresholds: { deny, ask }, issues: out }
}

export function canEmit(p: Program, target: string): ValidationIssue[] {
  const cap = TARGETS[target]
  if (!cap) {
    return [{ code: 'unknown_target', path: 'target', severity: 'error',
      message: `Unknown emit target "${target}". Known: ${Object.keys(TARGETS).join(', ')}.` }]
  }

  const out: ValidationIssue[] = []

  // No decisions means no evidence: the emitted artifact asks nothing and always returns
  // `otherwise`. Every target accepts that quietly — bouncer emits `questions: {}`,
  // toolgate emits thresholds that apply to its own built-ins instead, langchain emits a
  // classifier whose `questions` field is Field(min_length=1) and blows up on first use.
  if (!p.decisions.length) {
    out.push({ code: 'no_decisions', path: 'decisions', severity: 'error',
      message: `Nothing to emit: the program has no decisions, so the generated artifact would ask nothing and always return "${p.reduce.otherwise}".` })
  }

  const declared = new Set(p.decisions.map(d => d.id))

  for (const d of p.decisions) {
    // hasOwn, not a bare lookup: `reservedIds['__proto__']` inherits Object.prototype and
    // would report every __proto__ question as reserved by a target that never named it.
    const reserved = cap.reservedIds && Object.hasOwn(cap.reservedIds, d.id) ? cap.reservedIds[d.id] : undefined
    if (reserved) {
      out.push(issue('reserved_id', `decisions.${d.id}`,
        `"${d.id}" is reserved by ${target}: ${reserved} Rename the decision.`))
    }
    const kindSupported = cap.kinds.includes(d.kind)
    if (!kindSupported) {
      out.push({ code: 'kind_unsupported', path: `decisions.${d.id}`, severity: 'error',
        message: `Target "${target}" accepts only ${cap.kinds.join('/')} questions; "${d.id}" is a ${d.kind}. ${cap.note ?? ''}`.trim() })
    }
    if (cap.requiresInstructions && !d.instructions.trim()) {
      out.push({ code: 'instructions_empty', path: `decisions.${d.id}`, severity: 'error',
        message: `Target "${target}" requires non-empty instructions on every question; "${d.id}" has none. It would refuse to load the policy, and a policy it cannot load stops policy resolution entirely.` })
    }
    // Only worth saying about a question the target will actually emit: a score on a
    // noul-only target is already refused above, and "the legend will be dropped" reads
    // as a second, separate problem.
    if (d.kind === 'score' && kindSupported && !cap.carriesLegend) {
      out.push({ code: 'legend_dropped', path: `decisions.${d.id}`, severity: 'warn',
        message: `Target "${target}" does not return a legend, so a bare score is uninterpretable. jevc keeps the level descriptions beside the emitted code.` })
    }
    if (d.uncertain && 'belowConfidence' in d.uncertain && !cap.carriesConfidence) {
      out.push({ code: 'confidence_derived', path: `decisions.${d.id}.uncertain`, severity: 'warn',
        message: `Target "${target}" does not return confidence inline; it will be recomputed from the probability distribution. Never treat an absent confidence as 0.` })
    }
  }

  // Verdict vocabulary. bouncer's parser accepts allow/ask/deny and nothing else
  // (target-bouncer.md:58), and an unparseable policy does not degrade its gate — it
  // STOPS policy resolution (line 9) and routes to on_error, whose default `passthrough`
  // emits nothing at all. An unchecked verdict therefore replaces a working gate with a
  // silent one, at exit 0. toolgate has the same vocabulary but is already checked by
  // toolgateThresholds, which refuses any rule verdict that is not deny/ask.
  if (cap.verdicts) {
    const allowed = [...cap.verdicts].join('/')
    const check = (verdict: string, path: string) => {
      if (!cap.verdicts!.has(verdict)) {
        out.push({ code: 'verdict_unsupported', path, severity: 'error',
          message: `Target "${target}" accepts only the verdicts ${allowed}; got "${verdict}". A policy it cannot parse stops policy resolution entirely, so the gate goes silent rather than degrading.` })
      }
    }
    for (const [i, rule] of p.reduce.rules.entries()) check(rule.then, `reduce.rules[${i}].then`)
    check(p.reduce.otherwise, 'reduce.otherwise')
  }

  // Referential integrity, on every target. validateProgram reports the same thing as
  // reduce_unknown_id and the CLI runs it first, but canEmit is also called directly and
  // is the only gate a library consumer has: without this, the bouncer emitter writes
  // `when: { ghost: ... }`, a rule naming an undeclared question, which is a load error,
  // which stops policy resolution and disables the gate at exit 0.
  for (const [i, rule] of p.reduce.rules.entries()) {
    for (const c of rule.when) {
      if (!declared.has(c.id)) {
        out.push(issue('rule_unknown_decision', `reduce.rules[${i}]`,
          `Rule ${i} tests "${c.id}", which is not one of the program's decisions (${[...declared].join(', ') || 'none'}).`))
      }
    }
  }

  if (cap.reducer !== 'code') {
    for (const [i, rule] of p.reduce.rules.entries()) {
      // `when: [a, b]` is a CONJUNCTION (runtime.ts:39 evaluates `rule.when.every(...)`).
      // Neither policy target has one: bouncer's `when` names exactly one question, and
      // toolgate's max(probability) >= threshold is a DISJUNCTION. Exempting 'thresholds'
      // here let an AND-shaped Program emit an OR-shaped policy — at a=0.9, b=0.1 the
      // Program said allow and the emitted policy said deny. toolgate's native shape is
      // one condition per rule REPEATED per question, which first-match-wins evaluates as
      // exactly max-over-questions, and which toolgateThresholds' coverage check accepts.
      // `when: []` is an empty conjunction, and `[].every(...)` is true: the rule fires
      // unconditionally. The code targets can write that (`true` / `True`); neither
      // policy target can. bouncer's emitter read when[0] and threw a TypeError on
      // `undefined.op`, and toolgate's simply never saw the rule while its coverage
      // check went on believing every question was accounted for.
      if (rule.when.length === 0) {
        out.push({ code: 'rule_always_matches', path: `reduce.rules[${i}]`, severity: 'error',
          message: `Target "${target}" needs one question per rule; this rule has no conditions, which always matches. Give it a condition, or emit to a code target.` })
      }
      if (rule.when.length > 1) {
        out.push({ code: 'reducer_too_complex', path: `reduce.rules[${i}]`, severity: 'error',
          message: `Target "${target}" allows one question per rule; this rule tests ${rule.when.length}, which is a conjunction. Split it into one rule per question, or emit to a code target.` })
      }
      for (const c of rule.when) {
        if (c.op === 'gte' || c.op === 'lte') {
          if (cap.thresholdRange) {
            const [lo, hi] = cap.thresholdRange
            if (c.value < lo || c.value > hi) {
              out.push({ code: 'threshold_out_of_target_range', path: `reduce.rules[${i}]`, severity: 'error',
                message: `Target "${target}" accepts thresholds in ${lo}..${hi}; got ${c.value}. Score level-index thresholds cannot be expressed here.` })
            }
          }
          if (cap.thresholdPattern && !cap.thresholdPattern.test(String(c.value))) {
            out.push({ code: 'threshold_unrepresentable', path: `reduce.rules[${i}]`, severity: 'error',
              message: `Target "${target}" parses thresholds as ${cap.thresholdPattern.source}; ${c.value} serialises to "${String(c.value)}", which it will refuse to load. Round it to a plain decimal.` })
          }
        }
        // A choice equality has no shape on a target whose every question is a
        // probability: bouncer's `p` compares a number and toolgate's threshold is one.
        if (c.op === 'is') {
          out.push(issue('is_unsupported', `reduce.rules[${i}]`,
            `Target "${target}" compares probabilities; the equality on "${c.id}" has no form here.`))
        }
        if (c.op === 'uncertain') {
          // An uncertainty band IS a probability range, so a target with a range
          // comparison expresses it exactly — but only if the endpoints survive
          // serialisation. rangeFor is what the emitter will write; ask it, do not guess.
          const d = p.decisions.find(x => x.id === c.id)
          const why = !cap.rangeCondition
            ? `it has no range comparison, only ${cap.reducer === 'thresholds' ? 'two scalar thresholds' : 'a single threshold'}.`
            : d ? rangeFor(d).why : undefined
          if (why) {
            out.push(issue('uncertain_unsupported', `reduce.rules[${i}]`,
              `Target "${target}" cannot express the uncertainty condition on "${c.id}": ${why}`))
          }
        }
      }
    }
    if (cap.reducer === 'thresholds') out.push(...toolgateThresholds(p).issues)
  }

  return out
}
