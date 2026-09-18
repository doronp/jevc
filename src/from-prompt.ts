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
  Decision = { id, kind: 'noul'|'choice'|'score', instructions, criteria?, uncertain?, dependsOn?, source }
  Reducer  = { kind:'rules', rules: [{ when: Condition[], then: string }], otherwise: string }
  Condition = {id,op:'gte'|'lte',value:number} | {id,op:'is',value:string} | {id,op:'uncertain'}

RULES — follow all five, but they are not enforced equally. Only rule 1 fails
validation outright; passing the others is not the bar, a human reading the
generated decisions and reducer is:

1. [HARD ERROR — rejected outright] NEVER emit a question that asks for a verdict
   (allow/ask/deny/block/approve/reject). Measured: a collapsed verdict question
   returned allow 0.42 / block 0.35 / ask 0.23 at confidence 0.13, while narrow
   evidence questions on the SAME input reached 0.93-0.97. Emit evidence questions
   and put the verdict in \`reduce\`, which is code.
2. [WARNING only — and only if you declare it] NEVER emit two questions where one's
   answer determines the other's. Questions are scored independently with no
   consistency enforced: one measured response asserted rule_conflict=exception_wins
   (0.52) and decision=deny (0.73) at the same time. This can only be flagged if you
   name the dependency yourself on the dependent Decision's \`dependsOn\` field — the
   validator cannot detect an undeclared dependency from text alone, so declare it
   even though the rule is "never do this."
3. [WARNING only, heuristic] NEVER emit a question spanning two scopes. A compound
   authorization question measured 0.59 — the wrong side of 0.5 — by anchoring on the
   authorized half of a command. Caught by a text heuristic, so it can miss cases or
   over-flag; it does not block the program.
4. [WARNING only, heuristic] Carve-outs and exceptions ("except rm -rf node_modules")
   are ALLOWLISTS. Put them in \`reduce\`, never in question text — that is what
   produces the near-uniform verdict. A textual heuristic flags obvious cases
   (except/unless/other than/aside from) but cannot catch every phrasing.
5. [WARNING only, heuristic] Pattern and glob matching stays in code. Measured:
   declared deny-patterns matched semantics at 0.25/0.10/0.14 while the semantic
   question on the same input hit 0.96/0.87/0.85. Ask only what a pattern cannot
   express. A textual heuristic flags obvious glob tokens but cannot catch every
   phrasing.

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

/**
 * Structural validation of the parsed JSON before it is trusted with `Program`'s
 * type and handed to `validateProgram`/`lintProgram`. Those two functions assume
 * well-typed input — on the deterministic path that's guaranteed by construction
 * (`fromJsonSchema` only ever produces a well-typed `Program`), but a lifted
 * response comes from a model and plausible-looking output can take many
 * malformed shapes (a bare `null`, a decision that is a string, a `source` that
 * is a string instead of an object, a missing `reduce.rules`, ...). Each of
 * those would otherwise throw partway through validation instead of producing
 * a reportable issue. This function is a defensive boundary, not a full schema
 * validator: it checks only what `validateProgram`/`lintProgram`/the provenance
 * loop below actually dereference.
 */
function checkLiftedShape(parsed: unknown, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const err = (at: string, message: string) =>
    issues.push({ code: 'lift_malformed', path: at, severity: 'error', message })

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    err(path, `Lifted output must be a JSON object, got ${
      parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed}.`)
    return issues
  }
  const p = parsed as Record<string, unknown>

  if (!Array.isArray(p.decisions)) {
    err(path, 'Lifted output is missing a `decisions` array.')
  } else {
    p.decisions.forEach((raw, i) => {
      const at = `decisions.${i}`
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        err(at, `Decision at index ${i} must be an object, got ${
          raw === null ? 'null' : Array.isArray(raw) ? 'an array' : typeof raw}.`)
        return
      }
      const d = raw as Record<string, unknown>
      const label = typeof d.id === 'string' && d.id !== '' ? d.id : `index ${i}`
      if (typeof d.id !== 'string' || d.id === '') {
        err(`${at}.id`, `Decision at index ${i} is missing a non-empty string \`id\`.`)
      }
      if (d.kind !== 'noul' && d.kind !== 'choice' && d.kind !== 'score') {
        err(`${at}.kind`, `Decision "${label}" has kind "${String(d.kind)}"; expected noul, choice, or score.`)
      }
      if (typeof d.instructions !== 'string') {
        err(`${at}.instructions`, `Decision "${label}" is missing string \`instructions\`.`)
      }
      if (d.source !== undefined) {
        if (d.source === null || typeof d.source !== 'object' || Array.isArray(d.source)) {
          err(`${at}.source`, `Decision "${label}" has a \`source\` that is not an object.`)
        } else if (typeof (d.source as Record<string, unknown>).quote !== 'string') {
          err(`${at}.source`, `Decision "${label}" has a \`source\` with no string \`quote\`.`)
        }
      }
    })
  }

  if (p.reduce === null || typeof p.reduce !== 'object' || Array.isArray(p.reduce)) {
    err(path, 'Lifted output is missing a `reduce` object.')
  } else {
    const r = p.reduce as Record<string, unknown>
    if (!Array.isArray(r.rules)) {
      err('reduce.rules', '`reduce.rules` must be an array.')
    } else {
      r.rules.forEach((raw, i) => {
        const at = `reduce.rules.${i}`
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          err(at, `Rule at index ${i} must be an object.`)
          return
        }
        const rule = raw as Record<string, unknown>
        if (!Array.isArray(rule.when)) {
          err(`${at}.when`, `Rule at index ${i} is missing a \`when\` array.`)
        }
      })
    }
  }

  return issues
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

  let parsed: unknown
  try {
    const stripped = json.trim().replace(/^```[a-zA-Z0-9]*\n?/, '').replace(/\n?```$/, '')
    parsed = JSON.parse(stripped)
  } catch (e) {
    return { program: empty, issues: [{
      code: 'lift_unparseable', path, severity: 'error',
      message: `The lifter did not return valid JSON: ${(e as Error).message}`,
    }] }
  }

  const shapeIssues = checkLiftedShape(parsed, path)
  if (shapeIssues.length > 0) {
    return { program: empty, issues: shapeIssues }
  }
  const program = parsed as Program

  const issues: ValidationIssue[] = []
  const haystack = source.replace(/\s+/g, ' ')
  for (const d of program.decisions) {
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

  // Belt-and-braces: `checkLiftedShape` guards the shapes these two functions are
  // known to dereference, but it is not a full schema validator (e.g. it does not
  // check `criteria` or `dependsOn`). Anything that slips past it becomes a
  // reportable issue instead of an uncaught throw.
  try {
    issues.push(...validateProgram(program), ...lintProgram(program))
  } catch (e) {
    issues.push({ code: 'lift_malformed', path, severity: 'error',
      message: `Lifted output passed shape checks but crashed validation: ${(e as Error).message}` })
  }

  return { program, issues }
}
