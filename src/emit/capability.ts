import type { ValidationIssue } from '../contract.js'
import { uncertaintyOf, type Condition, type Decision, type Program } from '../ir.js'

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
   * What this target DOES with a `gte`/`lte` threshold, in the consumer's own terms, and
   * therefore what goes wrong when the value is not a number. Read only by
   * `threshold_not_a_number`, whose check is target-independent while its damage is not:
   * the policy targets write the value into a YAML file, the two TypeScript ones splice it
   * into source the consumer then compiles, langchain renders it as a Python literal, and
   * json does not carry the reducer at all. One sentence each, measured, because a refusal
   * that states the policy consequence on a code target is telling the author to look in a
   * file that does not exist.
   */
  thresholdSink: string
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
  /**
   * The emitted artifact builds a Jev API request keyed by `Decision.id`, so the wire
   * contract's id rules (contract.ts `validateRequest`) are part of "can this target
   * express it". True for the four code targets; bouncer and toolgate key their own YAML
   * by the id instead and their loaders accept names the wire will not.
   */
  idsOnTheWire?: boolean
  carriesConfidence: boolean
  carriesLegend: boolean
  note?: string
}

/** Decimal only: no exponent, no sign. Matches bouncer's `p` grammar. */
const PLAIN_DECIMAL = /^\d*\.?\d+$/

/**
 * The `thresholdSink` sentences, kept out of the table so each one can be read as prose and
 * so the table stays a table. Every claim in them was measured on this tree — the TS error
 * codes come from `tsc --noEmit --strict` over the emitted modules with `jevc` resolved to
 * `dist/`, the Python one from importing the emitted module and calling its `reduce`, and
 * the runReducer verdicts from `runReducer` itself on a noul grid of 0, 0.5 and 1.
 */
const SPLICED_INTO_TYPESCRIPT =
  'splices this threshold into the emitted module unquoted, where the consumer\'s own `tsc --strict` refuses it: ' +
  '`null` is TS18050 ("The value \'null\' cannot be used here") on sdk and TS2345 on ai-sdk, and `true` is TS2365 ' +
  '("Operator \'>=\' cannot be applied to types \'number\' and \'boolean\'") on sdk and TS2345 on ai-sdk. ' +
  '`jevc compile` has written, at exit 0, a file the consumer\'s build will not accept. A numeric string is the ' +
  'quiet half: `"0.5"` spliced unquoted IS the numeric literal 0.5, so it compiles clean and the threshold ' +
  'changes type with nothing to show for it.'

export const TARGETS: Record<string, TargetCapability> = {
  sdk:       { name: 'sdk', kinds: ['noul', 'choice', 'score'], reducer: 'code',
               idsOnTheWire: true, carriesConfidence: true, carriesLegend: true,
               thresholdSink: SPLICED_INTO_TYPESCRIPT },
  json:      { name: 'json', kinds: ['noul', 'choice', 'score'], reducer: 'code',
               idsOnTheWire: true, carriesConfidence: true, carriesLegend: true,
               // The request carries the QUESTIONS; the reducer stays in jevc, so this is the
               // one target where the value never reaches the artifact. It is refused all the
               // same, and for the plainest reason of the six: nothing downstream will ever
               // object, so the coercion is the whole of the damage.
               thresholdSink: 'carries the questions to the wire and leaves the verdict to jevc\'s own `runReducer`, ' +
                 'so this threshold reaches no artifact at all — it is simply coerced, silently, forever. Measured: ' +
                 'with `null` as a `gte` threshold runReducer answers deny at a probability of 0, 0.5 and 1 alike, ' +
                 'because `null` reads as 0 and a deny rule at 0 fires on everything.' },
  langchain: { name: 'langchain', kinds: ['noul', 'choice', 'score'], reducer: 'code',
               idsOnTheWire: true, carriesConfidence: true, carriesLegend: true,
               thresholdSink: 'renders this threshold through `py()`, which QUOTES a string and maps null to `None`, ' +
                 'so the emitted `_compare` raises at reduce time where `runReducer` coerces and returns a verdict. ' +
                 'Measured over a noul grid of 0, 0.5 and 1: `"0.5"` raises ' +
                 '`TypeError: \'>=\' not supported between instances of \'float\' and \'str\'` at every point, and ' +
                 '`null` the same against \'NoneType\' — a gate that answers nothing at all instead of answering wrongly.' },
  'ai-sdk':  { name: 'ai-sdk', kinds: ['noul', 'choice', 'score'], reducer: 'code',
               idsOnTheWire: true, carriesConfidence: false, carriesLegend: false,
               thresholdSink: SPLICED_INTO_TYPESCRIPT,
               note: 'EvaluationModelV4 drops legend and moves confidence into providerMetadata, where it may be absent.' },
  bouncer:   { name: 'bouncer', kinds: ['noul'], reducer: 'single-condition',
               thresholdRange: [0, 1], thresholdPattern: PLAIN_DECIMAL,
               verdicts: new Set(['allow', 'ask', 'deny']), requiresInstructions: true,
               reservedIds: { any: 'bouncer reads `any` in a rule as "any question", not as a question named "any".' },
               rangeCondition: true,
               carriesConfidence: false, carriesLegend: false,
               thresholdSink: 'writes this threshold into the `p` string of the policy file, where the grammar is ' +
                 '`(>=|>|<=|<)\\s*(\\d*\\.?\\d+)` and anything else is a LOAD error — which stops policy resolution ' +
                 'and routes to `on_error: passthrough`, so the gate emits nothing at all (target-bouncer.md:9).',
               note: 'gate.questions has no type key; every question is sent as a noul. A rule names exactly one question.' },
  toolgate:  { name: 'toolgate', kinds: ['noul'], reducer: 'thresholds',
               thresholdRange: [0, 1],
               reservedIds: { off_task: 'toolgate drops off_task when there is no task context, so the question would vanish.' },
               carriesConfidence: false, carriesLegend: false,
               thresholdSink: 'writes this threshold into the policy file as a YAML number, where ' +
                 'target-toolgate.md:27-28 declares one. Measured at exit 0 on this tree: `deny: "0.8"`, `deny: true`, ' +
                 '`deny: ""` and `deny: null` all emitted. `null` is the severe one — it satisfies toolgate\'s own ' +
                 '`0 <= ask <= deny <= 1` by the same coercion and then denies EVERY gated tool call.',
               note: 'validatePolicy throws unless every question is type: boolean.' },
}

const issue = (code: string, path: string, message: string): ValidationIssue =>
  ({ code, path, message, severity: 'error' })

/**
 * `when` as the array its type claims it already is. Every Program that reaches canEmit is
 * a bare cast of parsed JSON — cli.ts parses a file, parseLiftResponse parses a model
 * response — so a rule that arrived without its `when` is live input, not a type error, and
 * a lifted response is exactly where it arrives. This file read `rule.when` directly and
 * threw `rule.when is not iterable` out of the one gate a library consumer branches on:
 * no issue list, no path, no remedy, and on the bouncer emitter the TypeError surfaced one
 * layer further away still, as `Cannot read properties of undefined (reading 'op')`.
 *
 * Absent and empty are treated alike, matching ir.ts's predicate exactly (see the note on
 * `rule_always_matches` below): both mean the rule states no condition, and neither policy
 * target can express a rule that always matches.
 */
const conditionsOf = (rule: { when?: unknown }): readonly Condition[] =>
  Array.isArray(rule.when) ? rule.when as Condition[] : []

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
 * A band endpoint as the author wrote it. `JSON.stringify` renders every non-finite number
 * as `null`, so the old message told an author who wrote `[NaN, 0.6]` that their band was
 * `[null,0.6]` — a value they cannot find in their file.
 */
const showBand = (band: readonly unknown[]): string =>
  `[${band.map(x => typeof x === 'number' ? String(x) : JSON.stringify(x)).join(',')}]`

/**
 * The `p` string for `op: 'uncertain'` on a range target, or why it cannot be written.
 * Exported so the emitter writes the same string canEmit promised was writable.
 *
 * THE DOMAIN IS PART OF THE LOWERING. A noul answer is a probability, so the answers a band
 * can ever select are the doubles in [0,1] with `lo < p < hi` (runtime.ts isUncertain). The
 * one-ULP step below converts jevc's EXCLUSIVE end to bouncer's INCLUSIVE one, and that
 * conversion only applies where the excluded end is itself a reachable probability: below 0
 * and above 1 the nearest reachable answer is 0 and 1 themselves, unstepped.
 *
 * Reading the band as unbounded was a silent-gate bug, not a rounding nicety. `step()`
 * returns NaN for x < 0, so `[-0.1, 0.6]` fell into the empty-band branch and was refused
 * with a message saying it was empty — it is not; it holds every probability under 0.6. And
 * `[0.5, 1.5]` stepped to `1.4999999999999998`, which is outside the `p` grammar's 0..1:
 * bouncer refuses the whole POLICY FILE, which is a LOAD error, which stops policy
 * resolution and routes to `on_error: passthrough` (target-bouncer.md:9). The gate was gone
 * and canEmit had returned no issues, at exit 0.
 *
 * Intersecting with [0,1] is not a clamp in the sense that loses information: `[0.5, 1.5]`
 * and `[0.5, 1]` select exactly the same set of probabilities, so the emitted range agrees
 * with `runReducer` on every answer that can arrive. What is genuinely unwritable — a band
 * holding no probability at all, or an endpoint that is not a number — is refused here, and
 * `canEmit` reports it. `band_out_of_range` (a WARN, beside this call) is what tells the
 * author their endpoint left the domain.
 */
export function rangeFor(d: Decision): { p?: string; why?: string; outOfDomain?: boolean } {
  const u = uncertaintyOf(d)
  if (!('band' in u)) {
    return { why: `"${d.id}" is uncertain below a confidence, and a bouncer answer carries a probability and no confidence.` }
  }
  const [lo, hi] = u.band
  const shown = showBand(u.band)
  // The band is a cast of parsed JSON like everything else here, so an endpoint that is not
  // a number is live input. NaN cannot be intersected with anything, and Infinity can:
  // `[0.5, Infinity]` selects exactly the probabilities above 0.5.
  if (!(typeof lo === 'number' && typeof hi === 'number') || Number.isNaN(lo) || Number.isNaN(hi)) {
    return { why: `the band ${shown} on "${d.id}" has an endpoint that is not a number, so there is no probability range to write. A band is [low, high], both numbers in 0..1.` }
  }
  // No probability satisfies `lo < p < hi`, whatever the stepping does — distinct from the
  // inverted/adjacent band below, where the ends are probabilities and the interval between
  // them is empty. Reported apart because the remedy is different: this one says the
  // endpoints are not probabilities at all.
  if (!(lo < 1 && hi > 0)) {
    return { why: `the band ${shown} on "${d.id}" contains no probability: a noul answer lies in 0..1 and this band excludes all of it, so the question could never be uncertain. Put both ends inside 0..1.` }
  }
  const outOfDomain = lo < 0 || hi > 1
  const a = lo < 0 ? 0 : step(lo, true)
  const b = hi > 1 ? 1 : step(hi, false)
  if (!(a <= b)) {
    return { why: `the band ${shown} on "${d.id}" is empty once its exclusive ends are stepped inside an inclusive range.` }
  }
  if (!PLAIN_DECIMAL.test(String(a)) || !PLAIN_DECIMAL.test(String(b))) {
    return { why: `the band ${shown} on "${d.id}" serialises to "${a}..${b}", and the p grammar has no exponent.` }
  }
  return { p: `${a}..${b}`, outOfDomain }
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
    for (const c of conditionsOf(r)) {
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
    // The id the artifact will send to the Jev API as a question key. `validateRequest`
    // (contract.ts) refuses an empty one with `id_empty` — "Question id cannot be empty" —
    // so every code target clears canEmit and is then rejected by the server. The CLI
    // backstops itself by running validateRequest beside canEmit (cli.ts), but canEmit is
    // the ONLY gate a library consumer has, and the documented pattern is
    // `if (canEmit(p, t).length) refuse()` followed by a POST.
    //
    // Scoped to the targets that actually key the WIRE by this id. bouncer and toolgate key
    // their own YAML by it and their loaders accept `""` (target-*.md; the policy targets
    // carry the empty key through rather than dropping it, which is pinned separately), so
    // refusing it there would refuse a policy that loads and works. Same reason this is not
    // in `validateProgram`: the empty id is legal in the IR and the code targets carry it
    // intact — what it is not is legal on the wire.
    if (cap.idsOnTheWire && (typeof d.id !== 'string' || d.id === '')) {
      out.push(issue('id_empty', `decisions.${String(d.id)}`,
        `Target "${target}" sends every question to the Jev API keyed by its decision id, and the wire contract refuses ${typeof d.id !== 'string' ? `an id that is not a string (got ${typeof d.id})` : 'an empty id'} (validateRequest: id_empty, "Question id cannot be empty"). The artifact would be written at exit 0 and rejected by the API at request time. Give the decision a name.`))
    }
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
    if (cap.requiresInstructions) {
      // `Decision.instructions` is TYPED `string` and is not one at runtime: the wire
      // contract allows the structured `EntryType` form, `check.ts`'s buildProgram passes it
      // through with `as never`, and 10 decisions across 2 fixtures in this repo's own
      // corpus use it (see ir.ts's `lintableText`). `!d.instructions.trim()` therefore threw
      // `TypeError: d.instructions.trim is not a function` out of THE GATE — canEmit's whole
      // contract is that it returns issues, because `canEmit(p, t).length === 0` is the
      // branch the README tells a library consumer to write, and a throw has no branch. It
      // reached `emitBouncerPolicy` too, which calls canEmit first, so the actionable
      // refusal was replaced by a stack trace naming jevc internals.
      //
      // A DISTINCT CODE, not a reuse of instructions_empty: the object form is not empty and
      // an author told "this question has no instructions" about a question that visibly has
      // some will go looking in the wrong place. The remedy differs too — one is "write the
      // text", the other is "flatten it to a string for this target".
      if (typeof d.instructions !== 'string') {
        out.push({ code: 'instructions_not_string', path: `decisions.${d.id}`, severity: 'error',
          message: `Target "${target}" requires string instructions on every question; "${d.id}" carries ${d.instructions === null ? 'null' : Array.isArray(d.instructions) ? 'an array' : typeof d.instructions}. The wire contract allows the structured entry form, but this target's loader reads instructions as text and would refuse the policy — and a policy it cannot load stops policy resolution entirely. Flatten it to a single string for this target.` })
      } else if (!d.instructions.trim()) {
        out.push({ code: 'instructions_empty', path: `decisions.${d.id}`, severity: 'error',
          message: `Target "${target}" requires non-empty instructions on every question; "${d.id}" has none. It would refuse to load the policy, and a policy it cannot load stops policy resolution entirely.` })
      }
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
    for (const c of conditionsOf(rule)) {
      if (!declared.has(c.id)) {
        out.push(issue('rule_unknown_decision', `reduce.rules[${i}]`,
          `Rule ${i} tests "${c.id}", which is not one of the program's decisions (${[...declared].join(', ') || 'none'}).`))
      }
    }
  }

  // EVERY TARGET, which is why this loop is out here and not in the policy branch below.
  //
  // `Condition.value` is TYPED `number` and is not one at runtime: `emit-policy` JSON.parses
  // a file README:225 calls "the shape `--lift` asks the agent to produce" — model output —
  // and casts it. Every other check on this value in jevc is a RELATIONAL comparison, and
  // those COERCE: `"0.8" >= 0 && "0.8" <= 1` is true, `null >= 0 && null <= 1` is true, and
  // `!(ask < deny)` compares two STRINGS lexically. So the check has to be the type itself,
  // before any comparison.
  //
  // toolgate is where this lands in a deployed file: it has no thresholdPattern, and its
  // emitter copies `c.value` straight into `stringify({ thresholds })`, where
  // target-toolgate.md:27-28 declares a number. Measured on this tree at exit 0: `deny: "0.8"`,
  // `deny: true`, `deny: ""` and `deny: null` all emitted. `null` is the severe one — it
  // satisfies toolgate's own `0 <= ask <= deny <= 1` by the same coercion and then denies
  // EVERY gated tool call. README:381 already documents these thresholds as "0..1, plain
  // decimal"; this makes the code true.
  //
  // NOT a `continue`, and hoisting does not change that: bouncer's thresholdPattern catches
  // five of the six by their serialisation and reports `threshold_unrepresentable`, which is
  // a different sentence about the same value, and a caller reading one issue at a time is
  // owed both. The two checks simply run in two loops now, and bouncer still collects both.
  // The one the pattern does not catch is `"0.8"`, which `cmp()` renders byte-identically to
  // the number — harmless on bouncer, which is why the type check is what closes it.
  //
  // WHY IT MOVED. It sat inside `if (cap.reducer !== 'code')`, so the four code targets ran
  // none of it, and each mistranslated the value its own way instead — see `thresholdSink`
  // above for the measured consequence per target, and note that no two of them agree. The
  // CHECK is target-independent (a value that violates its own declared type is malformed
  // input anywhere); only the DAMAGE is per-target, so only the sentence varies.
  //
  // WHAT DID NOT MOVE, and this is the half that measurement corrected: the old check was
  // `typeof c.value !== 'number' || !Number.isFinite(c.value)`, and only the first clause is
  // target-independent. NaN and +-Infinity ARE numbers — they do not violate the declared
  // type — and the four code targets lower them EXACTLY: `pyThreshold` (emit/langchain.ts:32)
  // exists for precisely that and renders `float("nan")`, while the TypeScript targets splice
  // the JS globals, so the artifact agrees with runReducer on every answer. Two tests pin that
  // agreement (emit-backends.test.ts "never interpolates a non-finite threshold as a bare JS
  // global" and "langchain: compares false rather than raising, exactly as runReducer does"),
  // and hoisting the finiteness clause with the rest broke both — refusing a Program the
  // target expresses faithfully is the property's branch (1) claiming a program that belongs
  // in branch (2). It stays in the policy branch below, where it is a real limit: neither
  // `.nan` in a YAML number nor an exponent-free `p` string can spell a non-finite threshold.
  //
  // COERCION WAS CONSIDERED AND REJECTED, twice over. Lowering through `Number(v)` —
  // `"0.5"`->0.5, `null`->0, `true`->1 — reproduces runReducer's own coercion exactly and
  // would make every target agree. But `null`->0 is a `gte` deny rule with threshold 0, a
  // rule that fires on EVERYTHING, which is the `deny: null` failure mode this file cures by
  // type-checking rather than by coercing; and coercing here while refusing on the policy
  // targets would leave one Program meaning different things on different targets, which is
  // the disagreement the six targets were brought into line to end. A value that violates
  // its own declared type is malformed input, and naming it is the honest answer.
  for (const [i, rule] of p.reduce.rules.entries()) {
    for (const c of conditionsOf(rule)) {
      if (c.op !== 'gte' && c.op !== 'lte') continue
      if (typeof c.value !== 'number') {
        out.push({ code: 'threshold_not_a_number', path: `reduce.rules[${i}]`, severity: 'error',
          message: `Target "${target}" ${cap.thresholdSink} This threshold is not a number at all: "${c.id}" has ${JSON.stringify(c.value) ?? String(c.value)} (${typeof c.value}). Every range check in jevc is a relational comparison and those coerce, so a value that is not a number passes all of them and reaches the target unchanged. Write a plain number${cap.thresholdRange ? ` in ${cap.thresholdRange[0]}..${cap.thresholdRange[1]}` : ''}.` })
      }
    }
  }

  if (cap.reducer !== 'code') {
    for (const [i, rule] of p.reduce.rules.entries()) {
      const when = conditionsOf(rule)
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
      //
      // ir.ts's validateProgram emits this same code at this same path, and the overlap is
      // DELIBERATE and load-bearing in both directions — do not "deduplicate" it away.
      //   - Deleting it here was measured on this tree: emitBouncerPolicy falls straight to
      //     `r.when[0].op` and dies with `Cannot read properties of undefined`, and
      //     emitToolgatePolicy is worse — the conditionless rule contributes nothing to its
      //     threshold accounting, so `[{when:[x>=0.9] -> deny}, {when:[] -> ask}]` EMITS,
      //     at exit 0, a policy with `deny: 0.9, ask: 0.9` for a program that asks on every
      //     input below 0.9. Valid YAML, loads clean, different verdict.
      //   - Deleting it in ir.ts is worse still: runReducer answers "allow" at p = 0.99 for
      //     `[{when:[] -> allow}, {when:[is_destructive>=0.8] -> deny}]`, which is target
      //     independent, and the code emitters carry that program through verbatim.
      // canEmit is the gate a library consumer branches on; validateProgram is the gate the
      // CLI and the runtime branch on. Same sentence, two layers, neither one reachable
      // from the other. What must NOT drift is the predicate, and it had: this tested
      // `.length === 0` while ir.ts tested `!Array.isArray(when) || length === 0`, so a
      // rule that lost its `when` crashed here instead of being refused. conditionsOf now
      // holds the two in agreement.
      if (when.length === 0) {
        out.push({ code: 'rule_always_matches', path: `reduce.rules[${i}]`, severity: 'error',
          message: `Target "${target}" needs one question per rule; this rule has no conditions, which always matches. Give it a condition, or emit to a code target.` })
      }
      if (when.length > 1) {
        out.push({ code: 'reducer_too_complex', path: `reduce.rules[${i}]`, severity: 'error',
          message: `Target "${target}" allows one question per rule; this rule tests ${when.length}, which is a conjunction. Split it into one rule per question, or emit to a code target.` })
      }
      for (const c of when) {
        if (c.op === 'gte' || c.op === 'lte') {
          // The finiteness half of the old `threshold_not_a_number`, left behind when the
          // type half was hoisted to every target. It belongs to the POLICY targets alone:
          // a serialised policy has no spelling for a non-finite threshold — toolgate's YAML
          // number would be `.nan`/`.inf`, which target-toolgate.md:27-28 does not declare,
          // and bouncer's `p` grammar has no exponent, let alone a word — while the four code
          // targets write `NaN` / `float("nan")` and agree with runReducer exactly. Same code
          // as the hoisted check because it is the same class of defect to a caller reading
          // one issue at a time; a different sentence because the remedy is different.
          if (typeof c.value === 'number' && !Number.isFinite(c.value)) {
            out.push({ code: 'threshold_not_a_number', path: `reduce.rules[${i}]`, severity: 'error',
              message: `Target "${target}" ${cap.thresholdSink} ${c.value} is a number, but not a finite one, and the policy file has no spelling for it — a code target writes it exactly, this one cannot write it at all. Write a plain number${cap.thresholdRange ? ` in ${cap.thresholdRange[0]}..${cap.thresholdRange[1]}` : ''}.` })
          }
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
          const range = cap.rangeCondition && d ? rangeFor(d) : undefined
          const why = !cap.rangeCondition
            ? `it has no range comparison, only ${cap.reducer === 'thresholds' ? 'two scalar thresholds' : 'a single threshold'}.`
            : range?.why
          if (why) {
            out.push(issue('uncertain_unsupported', `reduce.rules[${i}]`,
              `Target "${target}" cannot express the uncertainty condition on "${c.id}": ${why}`))
          } else if (range?.outOfDomain) {
            // The lowering is exact — see rangeFor — so this is not a refusal. It is still
            // worth saying: an endpoint outside 0..1 is almost always a typo or a lifted
            // model's invention, and the author cannot see from the emitted `p` that the
            // number they wrote was not the number the gate uses.
            out.push({ code: 'band_out_of_range', path: `decisions.${c.id}.uncertain`, severity: 'warn',
              message: `The band ${showBand((uncertaintyOf(d!) as { band: [number, number] }).band)} on "${c.id}" has an endpoint outside 0..1. A noul answer IS a probability, so the emitted range is the part of the band a probability can reach (${range.p}) — the same answers, but not the numbers you wrote. Put both ends inside 0..1 to say it directly.` })
          }
        }
      }
    }
    if (cap.reducer === 'thresholds') out.push(...toolgateThresholds(p).issues)
  }

  return out
}

/**
 * The issues a CODE emitter refuses on its own, as distinct from everything `canEmit` knows.
 *
 * The house pattern is `emitBouncerPolicy` (emit/policy/bouncer.ts:31): call canEmit first,
 * throw with the issues. The two policy emitters can take the WHOLE error list because they
 * structurally depend on it — `emitBouncerPolicy` reads `r.when[0]` and `rangeFor(d).p!`, both
 * of which are only safe because canEmit refused the rules where they are not.
 *
 * The code emitters depend on none of it, and MEASURING the whole list on them is what settled
 * this. `canEmit(p, 'sdk').length` inside `emitNative` (and the same in ai-sdk/langchain) broke
 * 16 tests across three files, and not one of them was a mistranslation:
 *   - 10 x `rule_unknown_decision`, from emitter UNIT tests whose Program pairs a canned
 *     reducer with whatever decisions the test is really about. The lowering is faithful and
 *     `validateProgram` (reduce_unknown_id) is the gate that refuses the Program itself.
 *   -  3 x `id_empty`, from "every awkward name is still asked and still decides". The code
 *     targets carry `""` INTACT — that is the tested behaviour and the property's branch (2);
 *     `id_empty` is a fact about the WIRE, which is why it is scoped to `idsOnTheWire` and why
 *     cli.ts backstops it with `validateRequest` instead of the emitter doing it.
 *   -  2 x `threshold_not_a_number` on NaN/Infinity, which the code targets render exactly.
 *   -  1 x the same, reached through a second path.
 * A refusal that fires on an artifact the target expresses faithfully is branch (1) claiming a
 * Program that belongs in branch (2) — the same class of lie as an unrefused mistranslation,
 * pointed the other way. So the code emitters refuse exactly what they cannot LOWER, which
 * today is one code, and the rest stays advice a consumer reads from `canEmit` and the CLI
 * enforces at cli.ts:398.
 *
 * Adding a code here is a real decision: it means "this emitter cannot write a faithful
 * artifact for this Program", not "this Program is questionable".
 */
const UNLOWERABLE = new Set(['threshold_not_a_number'])

/** The errors a code emitter must refuse, ready for the house-pattern throw. Empty is the
 *  ordinary case: a code target takes an arbitrary reducer and lowers almost anything. */
export const cannotLower = (p: Program, target: string): ValidationIssue[] =>
  canEmit(p, target).filter(i => i.severity === 'error' && UNLOWERABLE.has(i.code))

/** The house-pattern message, one definition for the three code emitters. */
export const refusal = (what: string, issues: readonly ValidationIssue[]): Error =>
  new Error(`Cannot emit ${what}:\n${issues.map(i => `  ${i.path}: ${i.message}`).join('\n')}`)
