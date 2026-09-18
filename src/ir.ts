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

    if ((d.kind === 'choice' || d.kind === 'score') && !d.criteria) {
      err('criteria_missing', `decisions.${d.id}`,
        `"${d.id}" is a ${d.kind} decision with no criteria. A noul may omit criteria, but ${d.kind} decisions require it (options for choice, levels for score).`)
    }

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
