import type { ValidationIssue } from './contract.js'
import { lintProgram, validateProgram, type Program } from './ir.js'

// A quote shorter than this is not meaningful provenance: '' is a substring of
// every string (so a naive `haystack.includes(quote)` would trivially "find" a
// fabricated empty quote), and a single character is present almost everywhere
// in real prose. Both must be rejected even though they technically match.
const MIN_QUOTE_LENGTH = 2

export function buildLiftRequest(source: string, path: string): string {
  return `Lower the natural-language rules below into a jevc Program (JSON only, no prose).

A Program is:
  { decisions: Decision[], reduce: Reducer, residual: string, dropped: {reason,quote}[] }
  Decision = { id, kind: 'noul'|'choice'|'score', instructions, criteria?, uncertain?, source }
  Reducer  = { kind:'rules', rules: [{ when: Condition[], then: string }], otherwise: string }
  Condition = {id,op:'gte'|'lte',value:number} | {id,op:'is',value:string} | {id,op:'uncertain'}

HARD RULES — a violation is rejected, not repaired:

1. NEVER emit a question that asks for a verdict (allow/ask/deny/block/approve/reject).
   Measured: a collapsed verdict question returned allow 0.42 / block 0.35 / ask 0.23 at
   confidence 0.13, while narrow evidence questions on the SAME input reached 0.93-0.97.
   Emit evidence questions and put the verdict in \`reduce\`, which is code.
2. NEVER emit two questions where one's answer determines the other's. Questions are
   scored independently with no consistency enforced: one measured response asserted
   rule_conflict=exception_wins (0.52) and decision=deny (0.73) at the same time.
3. NEVER emit a question spanning two scopes. A compound authorization question measured
   0.59 — the wrong side of 0.5 — by anchoring on the authorized half of a command.
4. Carve-outs and exceptions ("except rm -rf node_modules") are ALLOWLISTS. Put them in
   \`reduce\`, never in question text — that is what produces the near-uniform verdict.
5. Pattern and glob matching stays in code. Measured: declared deny-patterns matched
   semantics at 0.25/0.10/0.14 while the semantic question on the same input hit
   0.96/0.87/0.85. Ask only what a pattern cannot express.

TYPE RULES: score criteria is an ORDERED ARRAY of 2-10 concrete level descriptions, and
its answer is a level INDEX (0..n-1), not 0..1. choice criteria is a map of 2-255 options.
noul has no confidence — use \`uncertain: {band:[lo,hi]}\`; choice/score use
\`uncertain: {belowConfidence: x}\`.

PROVENANCE: every decision needs \`source: {file, line, quote}\` where \`quote\` appears
VERBATIM in the text below. A decision you cannot trace to a line does not belong.

Anything requiring generated text goes in \`residual\`. An empty \`decisions\` array is a
valid answer: it means this file contains no System One decisions.

--- ${path} ---
${source}
--- end ---

Return only the JSON object.`
}

export function parseLiftResponse(
  json: string,
  source: string,
  path: string,
): { program: Program; issues: ValidationIssue[] } {
  const empty: Program = {
    decisions: [], reduce: { kind: 'rules', rules: [], otherwise: 'review' },
    residual: '', dropped: [],
  }

  let parsed: Program
  try {
    const stripped = json.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    parsed = JSON.parse(stripped)
  } catch (e) {
    return { program: empty, issues: [{
      code: 'lift_unparseable', path, severity: 'error',
      message: `The lifter did not return valid JSON: ${(e as Error).message}`,
    }] }
  }

  if (!Array.isArray(parsed.decisions) || !parsed.reduce) {
    return { program: empty, issues: [{
      code: 'lift_malformed', path, severity: 'error',
      message: 'Lifted output is missing `decisions` or `reduce`.',
    }] }
  }

  const issues: ValidationIssue[] = []
  const haystack = source.replace(/\s+/g, ' ')
  for (const d of parsed.decisions) {
    if (!d.source) {
      issues.push({ code: 'provenance_missing', path: `decisions.${d.id}`, severity: 'error',
        message: `"${d.id}" has no source. Every lifted decision must trace to a line.` })
      continue
    }
    const quote = d.source.quote.replace(/\s+/g, ' ').trim()
    if (quote.length < MIN_QUOTE_LENGTH) {
      issues.push({ code: 'provenance_too_short', path: `decisions.${d.id}`, severity: 'error',
        message: `"${d.id}" cites a quote too short to verify ("${d.source.quote}"). A quote under ${MIN_QUOTE_LENGTH} characters cannot rule out a coincidental match and does not count as provenance.` })
      continue
    }
    if (!haystack.includes(quote)) {
      issues.push({ code: 'provenance_not_found', path: `decisions.${d.id}`, severity: 'error',
        message: `"${d.id}" cites "${d.source.quote}", which does not appear in ${path}.` })
    }
  }

  issues.push(...validateProgram(parsed), ...lintProgram(parsed))
  return { program: parsed, issues }
}
