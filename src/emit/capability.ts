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
   * bouncer's grammar is `(>=|>|<=|<)\s*(\d*\.?\d+)` — no exponent — and JS renders
   * anything below 1e-6 exponentially, so 1e-7 is inside thresholdRange yet unloadable.
   * Range and pattern catch different failures; both are needed.
   */
  thresholdPattern?: RegExp
  carriesConfidence: boolean
  carriesLegend: boolean
  note?: string
}

/** Decimal only: no exponent, no sign. Matches bouncer's and toolgate's parsers. */
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
               carriesConfidence: false, carriesLegend: false,
               note: 'gate.questions has no type key; every question is sent as a noul. A rule names exactly one question.' },
  toolgate:  { name: 'toolgate', kinds: ['noul'], reducer: 'thresholds',
               thresholdRange: [0, 1], thresholdPattern: PLAIN_DECIMAL,
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

  for (const d of p.decisions) {
    if (!cap.kinds.includes(d.kind)) {
      out.push({ code: 'kind_unsupported', path: `decisions.${d.id}`, severity: 'error',
        message: `Target "${target}" accepts only ${cap.kinds.join('/')} questions; "${d.id}" is a ${d.kind}. ${cap.note ?? ''}`.trim() })
    }
    if (d.kind === 'score' && !cap.carriesLegend) {
      out.push({ code: 'legend_dropped', path: `decisions.${d.id}`, severity: 'warn',
        message: `Target "${target}" does not return a legend, so a bare score is uninterpretable. jevc keeps the level descriptions beside the emitted code.` })
    }
    if (d.uncertain && 'belowConfidence' in d.uncertain && !cap.carriesConfidence) {
      out.push({ code: 'confidence_derived', path: `decisions.${d.id}.uncertain`, severity: 'warn',
        message: `Target "${target}" does not return confidence inline; it will be recomputed from the probability distribution. Never treat an absent confidence as 0.` })
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
      // exactly max-over-questions, and which thresholdsFor's coverage check accepts.
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
