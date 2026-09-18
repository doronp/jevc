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

    if (d.kind === 'noul' && d.uncertain && 'belowConfidence' in d.uncertain) {
      err('noul_has_no_confidence', `decisions.${d.id}.uncertain`,
        'A noul answer carries no confidence field; its probability is the answer. Use a band instead.')
    }
    if (d.kind !== 'noul' && d.uncertain && 'band' in d.uncertain) {
      err('band_needs_noul', `decisions.${d.id}.uncertain`,
        'A band applies to a noul. Use belowConfidence for choice and score.')
    }
  }

  const byId = new Map(p.decisions.map(d => [d.id, d]))
  for (const [ri, rule] of p.reduce.rules.entries()) {
    for (const c of rule.when) {
      const d = byId.get(c.id)
      if (!d) {
        err('reduce_unknown_id', `reduce.rules[${ri}]`,
          `Reducer references unknown decision "${c.id}".`)
        continue
      }
      if (d.kind === 'score' && (c.op === 'gte' || c.op === 'lte')) {
        const levels = Array.isArray(d.criteria) ? d.criteria.length : 0
        if (levels && (c.value < 0 || c.value > levels - 1)) {
          err('score_threshold_out_of_range', `reduce.rules[${ri}]`,
            `Threshold ${c.value} is outside level-index space for "${c.id}" (${levels} levels => 0..${levels - 1}). Score is not a 0..1 value.`)
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
    // Rule 1 — never emit a collapsed verdict question.
    if (d.kind === 'choice' && d.criteria && !Array.isArray(d.criteria)) {
      const opts = Object.keys(d.criteria).map(o => o.toLowerCase())
      const verdictish = opts.filter(o => VERDICT_WORDS.has(o)).length
      if (verdictish >= 2 && verdictish >= opts.length - 1) {
        out.push({
          code: 'collapsed_verdict', path: `decisions.${d.id}`, severity: 'error',
          message: `"${d.id}" asks the model for a verdict (${opts.join('/')}). Measured: collapsed verdict questions return near-uniform distributions (allow 0.42 / block 0.35 / ask 0.23 at confidence 0.13) while narrow evidence questions on the same input reach 0.93-0.97. Ask for evidence; the verdict must be computed in code by the reducer.`,
        })
      }
    }

    // Rule 3 — never emit a question spanning two scopes.
    const text = d.instructions.toLowerCase()
    if (/\bor did it\b|\bor whether\b|, or .*\?|\band also\b/.test(text)) {
      out.push({
        code: 'compound_question', path: `decisions.${d.id}`, severity: 'warn',
        message: `"${d.id}" appears to ask two things at once. Measured: a compound authorization question returned 0.59 — the wrong side of 0.5 — because it anchored on the authorized half of a command. Split it by scope.`,
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
