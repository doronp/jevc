import type { ValidationIssue } from '../contract.js'
import type { Program } from '../ir.js'

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
               carriesConfidence: false, carriesLegend: false,
               note: 'gate.questions has no type key; every question is sent as a noul. A rule names exactly one question.' },
  toolgate:  { name: 'toolgate', kinds: ['noul'], reducer: 'thresholds',
               thresholdRange: [0, 1],
               carriesConfidence: false, carriesLegend: false,
               note: 'validatePolicy throws unless every question is type: boolean.' },
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

  for (const d of p.decisions) {
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
  // thresholdsFor, which refuses any rule verdict that is not deny/ask.
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

  if (cap.reducer !== 'code') {
    for (const [i, rule] of p.reduce.rules.entries()) {
      // `when: [a, b]` is a CONJUNCTION (runtime.ts:39 evaluates `rule.when.every(...)`).
      // Neither policy target has one: bouncer's `when` names exactly one question, and
      // toolgate's max(probability) >= threshold is a DISJUNCTION. Exempting 'thresholds'
      // here let an AND-shaped Program emit an OR-shaped policy — at a=0.9, b=0.1 the
      // Program said allow and the emitted policy said deny. toolgate's native shape is
      // one condition per rule REPEATED per question, which first-match-wins evaluates as
      // exactly max-over-questions, and which thresholdsFor's coverage check accepts.
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
        if (c.op === 'uncertain' && !cap.carriesConfidence) {
          out.push({ code: 'uncertain_unsupported', path: `reduce.rules[${i}]`, severity: 'error',
            message: `Target "${target}" cannot express an uncertainty condition.` })
        }
      }
    }
  }

  return out
}
