import type { EntryType, ValidationIssue } from './contract.js'

export type Uncertain = { belowConfidence: number } | { band: [number, number] }

export type Decision = {
  id: string
  kind: 'noul' | 'choice' | 'score'
  instructions: string
  criteria?: { true?: EntryType; false?: EntryType } | Record<string, EntryType> | readonly EntryType[]
  uncertain?: Uncertain
  dependsOn?: string[]
  source?: { file: string; line: number; quote: string }
}

export type Condition =
  | { id: string; op: 'gte' | 'lte'; value: number }
  | { id: string; op: 'is'; value: string }
  | { id: string; op: 'uncertain' }

/** First match wins; `otherwise` is the fallthrough. A reviewable decision table. */
export type Reducer = {
  kind: 'rules'
  rules: Array<{ when: Condition[]; then: string }>
  otherwise: string
}

export type Program = {
  decisions: Decision[]   // evidence questions only, never verdicts (see 4b)
  reduce: Reducer         // the verdict, computed in code from the evidence
  residual: string        // what still needs a generative model; '' when fully compiled
  dropped: Array<{ reason: string; quote: string }>
}
// No stateBuilder in v0.1: every emit target builds its own state (bouncer and
// toolgate from the hook payload, native/langchain from caller code), so the field
// would be dead weight. Re-add it when an emitter actually consumes one.


/** Option sets that mean "what should the program do" rather than "what is true". */
export const VERDICT_WORDS = new Set([
  'allow', 'ask', 'deny', 'block', 'approve', 'reject', 'escalate',
  'permit', 'refuse', 'proceed', 'halt', 'warn', 'pass', 'fail',
])

const DEFAULT_NOUL_BAND: [number, number] = [0.35, 0.65]

/**
 * The closed op vocabulary. `Condition`'s union constrains literals written in TypeScript
 * and nothing else: every Program that reaches this function at runtime is a bare cast of
 * parsed JSON (cli.ts:197, and parseLiftResponse on a model's output), so an op outside the
 * vocabulary is a live input rather than a type error. It has to be refused here because
 * runtime.ts:43 and all five emitters end in the same `op === 'gte' ? >= : <=` ternary:
 * anything that is not 'gte' executes as 'lte' — the exact inverse of the rule, at exit 0.
 * toolgate's emitter already refuses an op it does not recognise (policy/toolgate.ts:44),
 * so the fallthrough everywhere else is an oversight, not a decision.
 */
const CONDITION_OPS: ReadonlySet<string> = new Set(['gte', 'lte', 'is', 'uncertain'])

export function validateProgram(p: Program): ValidationIssue[] {
  const out: ValidationIssue[] = []
  const err = (code: string, path: string, message: string) =>
    out.push({ code, path, message, severity: 'error' })

  const seen = new Set<string>()
  for (const d of p.decisions) {
    if (seen.has(d.id)) {
      err('duplicate_id', `decisions.${d.id}`,
        `Duplicate decision id "${d.id}". Question maps are JSON objects, so the API silently keeps only the last definition.`)
    }
    seen.add(d.id)

    // `kind` is the other closed vocabulary a cast cannot enforce, and it fails the same
    // silent way as an unknown op: toQuestion (emit/json.ts:4-19) tests noul, then score,
    // then treats EVERYTHING else as a choice, so `kind: "boolean"` ships as a choice
    // question. Nothing after this point means anything if the kind is not one of three.
    if (d.kind !== 'noul' && d.kind !== 'choice' && d.kind !== 'score') {
      err('decision_kind_unknown', `decisions.${d.id}`,
        `"${d.id}" has kind "${String(d.kind)}"; the primitives are noul, choice and score. An unrecognised kind is emitted as a choice question rather than refused.`)
      continue
    }

    // The shape of `criteria` IS the kind — the same three rows buildLiftRequest states to
    // the lifter as prose (its TYPE RULES paragraph), enforced. Nothing between this gate
    // and the wire re-checks it: toQuestion throws two layers downstream on a score that
    // is not an array, silently DROPS an array handed to a noul, and silently ships an
    // array handed to a choice as the options "0", "1", "2".
    if (d.kind === 'noul') {
      if (Array.isArray(d.criteria)) {
        err('criteria_shape', `decisions.${d.id}.criteria`,
          `"${d.id}" is a noul whose criteria is an array; a noul takes {true, false} descriptions. An array is not sent at all — the question reaches the model with neither side described.`)
      }
    } else if (!d.criteria) {
      err('criteria_missing', `decisions.${d.id}`,
        `"${d.id}" is a ${d.kind} decision with no criteria. A noul may omit criteria, but ${d.kind} decisions require it (options for choice, levels for score).`)
    } else if (d.kind === 'choice') {
      if (Array.isArray(d.criteria)) {
        err('criteria_shape', `decisions.${d.id}.criteria`,
          `"${d.id}" is a choice whose criteria is an array; a choice takes a map of option name to description. An array reaches the API as the options "0", "1", "2" — options no one named, which the reducer's \`is\` can never match.`)
      } else {
        // The wire limits are a property of the Program, not of one emit path.
        // validateRequest enforces them on the request it builds, but only `--emit=json`
        // ever runs that, so the default native path shipped a 1-option choice at exit 0.
        const n = Object.keys(d.criteria).length
        if (n < 2) {
          err('choice_too_few_options', `decisions.${d.id}.criteria`,
            `Choice "${d.id}" has ${n} option(s); at least 2 are required. The API accepts one option with 200 and returns it at confidence 1.0.`)
        }
        if (n > 255) {
          err('choice_too_many_options', `decisions.${d.id}.criteria`,
            `Choice "${d.id}" has ${n} options; the maximum is 255.`)
        }
      }
    } else if (!Array.isArray(d.criteria)) {
      err('criteria_shape', `decisions.${d.id}.criteria`,
        `"${d.id}" is a score whose criteria is an object; a score takes an ORDERED ARRAY of level descriptions, because its answer is an index into that array (0..n-1).`)
    } else {
      const n = d.criteria.length
      if (n < 2) {
        err('score_too_few_levels', `decisions.${d.id}.criteria`,
          `Score "${d.id}" has ${n} level(s); at least 2 are required. The API accepts a single level with 200 and returns a constant 0.0 at confidence 1.0.`)
      }
      if (n > 10) {
        err('score_too_many_levels', `decisions.${d.id}.criteria`,
          `Score "${d.id}" has ${n} levels; the API rejects more than 10.`)
      }
    }

    if (d.kind === 'noul' && d.uncertain && 'belowConfidence' in d.uncertain) {
      err('noul_has_no_confidence', `decisions.${d.id}.uncertain`,
        'A noul answer carries no confidence field; its probability is the answer. Use a band instead.')
    }
    if (d.kind !== 'noul' && d.uncertain && 'band' in d.uncertain) {
      err('band_needs_noul', `decisions.${d.id}.uncertain`,
        'A band applies to a noul. Use belowConfidence for choice and score.')
    }
    // An `uncertain` that names neither is strictly worse than no `uncertain` at all:
    // uncertaintyOf's default applies only when the field is ABSENT, so isUncertain
    // (runtime.ts:30/33) reaches a declared-but-empty rule and throws instead of
    // answering. A guardrail that throws is a guardrail that is off.
    if (d.uncertain && !('band' in d.uncertain) && !('belowConfidence' in d.uncertain)) {
      err('uncertain_empty', `decisions.${d.id}.uncertain`,
        `"${d.id}" declares \`uncertain\` with neither band nor belowConfidence. Omit the field to take the default (band ${JSON.stringify(DEFAULT_NOUL_BAND)} for a noul, belowConfidence 0.5 otherwise); an empty one throws at evaluation time.`)
    }
  }

  // The reducer is the verdict, and both of its unguarded fields fail OPEN — the one
  // direction a guardrail must not fail. With no `otherwise`, runReducer returns undefined
  // (runtime.ts:47) and every `verdict === 'deny'` test reads that as permission; emitNative
  // writes the same undefined into a function declared `: string` (emit/native.ts:62-64),
  // so the generated file does not compile. An unknown `kind` is executed as if it were
  // "rules" rather than refused, which is the unknown-op failure one level up.
  if (p.reduce.kind !== 'rules') {
    err('reduce_kind_unknown', 'reduce.kind',
      `Unknown reducer kind "${String(p.reduce.kind)}". The only reducer is "rules" (first match wins), and anything else is run as if it were that.`)
  }
  if (typeof p.reduce.otherwise !== 'string' || p.reduce.otherwise === '') {
    err('reduce_verdict_missing', 'reduce.otherwise',
      'The reducer has no `otherwise` verdict. Every rule can miss, and the fallthrough is what the caller gets when they all do — without it the verdict is undefined, which is not a verdict.')
  }

  const byId = new Map(p.decisions.map(d => [d.id, d]))
  for (const [ri, rule] of p.reduce.rules.entries()) {
    if (typeof rule.then !== 'string' || rule.then === '') {
      err('reduce_verdict_missing', `reduce.rules[${ri}].then`,
        `Rule ${ri} names no verdict. A rule that matches and returns undefined is worse than no rule: it also stops every later rule from being tried.`)
    }
    for (const c of rule.when) {
      // Before the id lookup: an op outside the vocabulary is wrong whether or not the
      // decision it names exists, and it is the one error that inverts a verdict silently.
      if (!CONDITION_OPS.has(c.op)) {
        err('condition_op_unknown', `reduce.rules[${ri}]`,
          `Condition op "${String(c.op)}" on "${c.id}" is not one of gte, lte, is, uncertain. The runtime and every emitter end in \`op === 'gte' ? >= : <=\`, so an unknown op is not refused — it runs as lte, inverting the rule.`)
      }
      const d = byId.get(c.id)
      if (!d) {
        err('reduce_unknown_id', `reduce.rules[${ri}]`,
          `Reducer references unknown decision "${c.id}".`)
        continue
      }
      // `is` compares the chosen option of a choice (runtime.ts:41, via choiceOf), which
      // is undefined for any other kind: the comparison is false for every possible
      // answer, so the rule is dead and the program only reads as though it gates. The
      // reverse pairing is NOT an error — gte/lte against a choice tests its confidence.
      if (c.op === 'is' && d.kind !== 'choice') {
        err('is_needs_choice', `reduce.rules[${ri}]`,
          `\`is\` compares a choice's chosen option, but "${c.id}" is a ${d.kind}. The condition is false for every answer the model can give, so the rule can never fire.`)
      }
      if (c.op === 'gte' || c.op === 'lte') {
        if (d.kind === 'score') {
          const levels = Array.isArray(d.criteria) ? d.criteria.length : 0
          if (levels && (c.value < 0 || c.value > levels - 1)) {
            err('score_threshold_out_of_range', `reduce.rules[${ri}]`,
              `Threshold ${c.value} is outside level-index space for "${c.id}" (${levels} levels => 0..${levels - 1}). Score is not a 0..1 value.`)
          }
        } else if (!(c.value >= 0 && c.value <= 1)) {
          // Stated as the range the threshold must be IN, not the range it must avoid: a
          // value that is not a number at all compares false against everything, so
          // `< 0 || > 1` would pass it — and a hand-written program file is where that arrives.
          err('probability_threshold_out_of_range', `reduce.rules[${ri}]`,
            `Threshold ${c.value} is outside 0..1 for "${c.id}". A noul answer IS a probability and a threshold against a choice compares its confidence, so both live in 0..1: a gte above 1 is a rule that can never fire, and its mirror lte fires on every answer. Score level indices are the only thresholds that leave this range.`)
        }
      }
      if (d.kind === 'choice' && c.op === 'is') {
        const opts = d.criteria && !Array.isArray(d.criteria) ? Object.keys(d.criteria) : []
        if (opts.length && !opts.includes(c.value)) {
          err('reduce_unknown_option', `reduce.rules[${ri}]`,
            `Option "${c.value}" is not defined on choice "${c.id}".`)
        }
      }
    }
  }
  return out
}

export function lintProgram(p: Program): ValidationIssue[] {
  const out: ValidationIssue[] = []

  for (const d of p.decisions) {
    // Rule 1 — never emit a collapsed verdict question. Two independent signals:
    // the option vocabulary (verdict-shaped words) and the instructions' framing
    // (verdict-shaped phrasing), since a domain-named verdict set like
    // {allow, deny, quarantine, sandbox} doesn't trip the vocabulary check alone.
    if (d.kind === 'choice') {
      const opts = d.criteria && !Array.isArray(d.criteria) ? Object.keys(d.criteria).map(o => o.toLowerCase()) : []
      const verdictish = opts.filter(o => VERDICT_WORDS.has(o)).length
      const vocabCollapse = opts.length > 0 && verdictish >= 2 && verdictish >= opts.length - 1
      const framingCollapse = /\bwhat should\b|\bwhich action\b|\bdecide whether to\b|\bwhat action\b/
        .test(d.instructions.toLowerCase())
      if (vocabCollapse || framingCollapse) {
        out.push({
          code: 'collapsed_verdict', path: `decisions.${d.id}`, severity: 'error',
          message: `"${d.id}" asks the model for a verdict (${opts.join('/')}). Measured: collapsed verdict questions return near-uniform distributions (allow 0.42 / block 0.35 / ask 0.23 at confidence 0.13) while narrow evidence questions on the same input reach 0.93-0.97. Ask for evidence; the verdict must be computed in code by the reducer.`,
        })
      }
    }

    // Rule 3 — never emit a question spanning two scopes. The trailing ", or ...?"
    // alternative is guarded against an earlier bare "or" in the same instructions:
    // that earlier "or" is very likely enumerating options within one scope (e.g.
    // "matching *.env or *.key") rather than introducing a second independent clause,
    // so a trailing ", or <clause>?" after it is not treated as compound.
    const text = d.instructions.toLowerCase()
    if (/\bor did it\b|\bor whether\b|^(?:(?!\bor\b)[\s\S])*, or\s+[^,?]{0,60}\?|\band also\b/.test(text)) {
      out.push({
        code: 'compound_question', path: `decisions.${d.id}`, severity: 'warn',
        message: `"${d.id}" appears to ask two things at once. Measured: a compound authorization question returned 0.59 — the wrong side of 0.5 — because it anchored on the authorized half of a command. Split it by scope.`,
      })
    }

    // Rule 4 — carve-outs and exceptions are allowlists; a question that embeds one
    // ("... except anything under test/fixtures/") is the shape that produces the
    // near-uniform verdict distribution. Heuristic on wording, so it warns rather
    // than blocks — it can both miss a phrasing and over-flag a legitimate "unless".
    if (/\b(except|unless|other than|aside from)\b/.test(text)) {
      out.push({
        code: 'embedded_carveout', path: `decisions.${d.id}`, severity: 'warn',
        message: `"${d.id}" appears to embed a carve-out or exception in the question text. Measured: declared deny-patterns matched semantics at 0.25/0.10/0.14 while the semantic question on the same input hit 0.96/0.87/0.85. Carve-outs are allowlists — put them in \`reduce\` or in code, not in the question.`,
      })
    }

    // Rule 5 — pattern and glob matching stays in code; a model asked to match a
    // literal pattern performs far worse than one asked the equivalent semantic
    // question. Heuristic on a few glob-shaped tokens, so it warns rather than blocks.
    if (/\*\.|\/\*|\*\//.test(text)) {
      out.push({
        code: 'embedded_pattern', path: `decisions.${d.id}`, severity: 'warn',
        message: `"${d.id}" appears to embed a glob or pattern in the question text. Measured: declared deny-patterns matched semantics at 0.25/0.10/0.14 while the semantic question on the same input hit 0.96/0.87/0.85. Pattern matching stays in code — ask only what a pattern cannot express.`,
      })
    }
  }

  // Rule 2 — never emit two questions where one determines the other.
  for (const d of p.decisions) {
    for (const dep of d.dependsOn ?? []) {
      out.push({
        code: 'dependent_questions', path: `decisions.${d.id}`, severity: 'warn',
        message: `"${d.id}" depends on "${dep}". Questions in a batch are scored independently with no consistency enforced — a measured response asserted rule_conflict=exception_wins (0.52) and decision=deny (0.73) simultaneously. Ask the resolving question and derive this one in code.`,
      })
    }
  }

  return out
}

export function uncertaintyOf(d: Decision): Uncertain {
  return d.uncertain ?? (d.kind === 'noul'
    ? { band: DEFAULT_NOUL_BAND }
    : { belowConfidence: 0.5 })
}
