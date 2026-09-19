// Type-only, so it is erased at compile time and the contract <-> ir cycle never exists at
// runtime: ir.ts imports ValidationIssue from here, and validateResponse needs the program
// it is checking the response against (kinds, option names, level counts).
import type { Program } from './ir.js'

// Mirrors the SDK's JsonValue/EntryType shape (see test/contract.sdk-compat.test-d.ts):
// `unknown` isn't assignable to the SDK's JSON-only value type, so the wire
// contract has to be expressed in JSON-safe values too.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type EntryType = string | Record<string, JsonValue> | JsonValue[] | null

export type JevQuestion =
  | { type: 'noul'; instructions: EntryType; criteria?: { true?: EntryType; false?: EntryType } | null }
  | { type: 'choice'; instructions: EntryType; criteria: Record<string, EntryType> }
  | { type: 'score'; instructions: EntryType; criteria: readonly EntryType[] }

export type JevModel = 'jev-latest' | 'jev-preview' | 'jev-1.13.0'
export const MODELS: readonly JevModel[] = ['jev-latest', 'jev-preview', 'jev-1.13.0']

// The API silently ignores unknown fields (spec §3.1: a typo like `criterion`
// never errors), so jevc has to whitelist what it emits instead.
const REQUEST_FIELDS = ['model', 'state', 'questions'] as const
const QUESTION_FIELDS = ['type', 'instructions', 'criteria'] as const
// A noul's criteria is the only criteria shape with fixed key names — a choice's keys are
// the author's option names and a score's are array indices — so it is the only one a
// whitelist can cover. `criteria: {treu: ...}` is accepted by the API, ignored by it, and
// the description the author wrote for that outcome never reaches the model.
const NOUL_CRITERIA_KEYS = ['true', 'false'] as const

export type JevRequest = {
  model: JevModel
  state: string | Record<string, JsonValue> | JsonValue[]
  questions: Record<string, JevQuestion>
}

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, EntryType>; probabilities: Record<string, number>; confidence: number }

export type JevResponse = {
  model: string
  answers: Record<string, JevAnswer>
  usage: { input_tokens: number; output_tokens: number }
}

export type ValidationIssue = {
  code: string
  path: string
  message: string
  severity: 'error' | 'warn'
}

// Measured: 29,464 tokens for 150,232 chars.
const CHARS_PER_TOKEN = 5.1
// The documentation says 64k total. The measurement says otherwise: "~45k tokens returns
// `400 max_tokens_exceeded`" (docs/superpowers/specs/2026-09-18-jevc-design.md §3.3). The
// documented number is the one the API rejects requests under, so a pre-flight check set to
// it passes requests the API refuses — the one outcome this check exists to prevent. Do NOT
// round this back up to the documented figure without a new measurement to cite; the largest
// request in fixtures/ is ~1,037 tokens, so nothing real is near either number.
export const TOKEN_BUDGET_TOTAL = 45_000
export const TOKEN_BUDGET_SINGLE = 32_000

export function estimateTokens(v: unknown): number {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '')
  return Math.ceil(s.length / CHARS_PER_TOKEN)
}

/** Resolve `a.b[0].c` against the state object. Returns undefined when absent. */
function resolvePath(state: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  let cur: unknown = state
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
    if (cur === undefined) return undefined
  }
  return cur
}

function backtickPaths(q: JevQuestion): string[] {
  const text = JSON.stringify(q)
  // A backticked token is treated as a state path only when it looks like one.
  return [...text.matchAll(/`([A-Za-z_$][\w$]*(?:\.[\w$]+|\[\d+\])+)`/g)].map(m => m[1])
}

export function validateRequest(req: JevRequest): ValidationIssue[] {
  const out: ValidationIssue[] = []
  const err = (code: string, path: string, message: string) =>
    out.push({ code, path, message, severity: 'error' })

  if (!MODELS.includes(req.model)) {
    err('model_unknown', 'model',
      `Unknown model "${req.model}". Expected one of: ${MODELS.join(', ')}.`)
  }

  const stateEmpty = req.state === '' ||
    (typeof req.state === 'object' && req.state !== null && Object.keys(req.state).length === 0)
  if (stateEmpty) {
    err('state_empty', 'state',
      'State is empty. The API accepts this with 200 and answers from no evidence.')
  }

  for (const key of Object.keys(req)) {
    if (!(REQUEST_FIELDS as readonly string[]).includes(key)) {
      err('unknown_field', key,
        `Unknown field "${key}" on the request. The API silently ignores it. Legal fields: ${REQUEST_FIELDS.join(', ')}.`)
    }
  }

  const ids = Object.keys(req.questions)
  if (ids.length === 0) {
    err('questions_empty', 'questions', 'At least one question is required.')
  }

  for (const id of ids) {
    const q = req.questions[id]
    const at = `questions.${id}`
    if (id === '') {
      err('id_empty', at, 'Question id cannot be empty.')
    }

    for (const key of Object.keys(q)) {
      if (!(QUESTION_FIELDS as readonly string[]).includes(key)) {
        err('unknown_field', `${at}.${key}`,
          `Unknown field "${key}" on question "${id}". The API silently ignores it. Legal fields: ${QUESTION_FIELDS.join(', ')}.`)
      }
    }

    if (q.type === 'score') {
      const n = q.criteria.length
      if (n < 2) {
        err('score_too_few_levels', `${at}.criteria`,
          `Score has ${n} level(s); at least 2 are required. The API accepts a single level with 200 and returns a constant 0.0 at confidence 1.0.`)
      }
      if (n > 10) {
        err('score_too_many_levels', `${at}.criteria`,
          `Score has ${n} levels; the API rejects more than 10.`)
      }
      if (q.criteria.some(c => c === null || c === '')) {
        out.push({ code: 'score_level_undescribed', path: `${at}.criteria`, severity: 'error',
          message: 'Every score level needs a concrete description; an undescribed level destroys the distribution.' })
      }
    }

    if (q.type === 'choice') {
      const n = Object.keys(q.criteria).length
      if (n < 2) {
        err('choice_too_few_options', `${at}.criteria`,
          `Choice has ${n} option(s); at least 2 are required. The API accepts one option with 200 and returns it at confidence 1.0.`)
      }
      if (n > 255) {
        err('choice_too_many_options', `${at}.criteria`, `Choice has ${n} options; the maximum is 255.`)
      }
      if (n > 240) {
        out.push({ code: 'choice_near_limit', path: `${at}.criteria`, severity: 'warn',
          message: `Choice has ${n} options; reliability degrades above roughly 240.` })
      }
    }

    if (q.type === 'noul') {
      const noInstructions = q.instructions === '' || q.instructions == null
      const noCriteria = q.criteria == null || Object.keys(q.criteria).length === 0
      if (noInstructions && noCriteria) {
        err('noul_empty', at, 'A noul needs instructions or criteria.')
      }
      // An empty criteria object stays legal (emit/policy builds one, and "described
      // neither outcome" is the noul_empty case above, reported once). A key that is
      // neither `true` nor `false` is the typo case: silently ignored on the wire, so the
      // model answers one of its two outcomes with no guidance and nothing says so.
      for (const key of Object.keys(q.criteria ?? {})) {
        if (!(NOUL_CRITERIA_KEYS as readonly string[]).includes(key)) {
          err('unknown_field', `${at}.criteria.${key}`,
            `Unknown criteria key "${key}" on noul "${id}". A noul describes two outcomes: ${NOUL_CRITERIA_KEYS.join(', ')}. The API silently ignores anything else, so this description never reaches the model.`)
        }
      }
    }

    for (const path of backtickPaths(q)) {
      if (resolvePath(req.state, path) === undefined) {
        // Backticks here are ordinary prose markup — they also quote criteria option names,
        // literal values, class names and fields of the question's own structured
        // `instructions` object — so a dotted backticked token is only *sometimes* a state
        // path. Against a string state it can never resolve at all (resolvePath bails on a
        // non-object root), which made this an outright rejection of the corpus's core use
        // case: state = a source file, question = "Does it use `sys.exit`?". The message
        // itself concedes the API answers the request anyway, so for a string state this is
        // a lint signal, not a contract violation. Only a structured state makes the path
        // *provably* absent, and that stays an error. Measured: all 10 backtick paths in
        // fixtures/ sit on object states and all 10 resolve, so neither branch fires there.
        const structured = typeof req.state === 'object' && req.state !== null
        out.push({ code: 'path_unresolved', path: at, severity: structured ? 'error' : 'warn',
          message: `Backtick path \`${path}\` does not resolve in state. The API never reports this — it silently answers from the whole state instead.` })
      }
    }

    const qTokens = estimateTokens(q) + estimateTokens(req.state)
    if (qTokens > TOKEN_BUDGET_SINGLE) {
      err('token_budget_exceeded', at,
        `State plus this question is ~${qTokens} tokens; the per-question limit is ${TOKEN_BUDGET_SINGLE}.`)
    }
  }

  const total = estimateTokens(req.state) + estimateTokens(req.questions)
  if (total > TOKEN_BUDGET_TOTAL) {
    err('token_budget_exceeded', 'request',
      `Request is ~${total} tokens; the limit is ${TOKEN_BUDGET_TOTAL}.`)
  }

  return out
}

/** The other half of the wire contract. `res` is `unknown` on purpose: it crosses the same
 * trust boundary as the request but in the opposite direction, from a remote service on a
 * model alias that moves (`jev-latest` resolved to jev-1.13.0 today), and runtime.ts takes it
 * with a bare `as Record<string, JevAnswer>` — the type asserts a shape nobody checked.
 * Same conventions as validateRequest: every violation reported at once, `error` means the
 * verdict would be wrong or would throw, `warn` means the verdict still stands. The call
 * site is runtime.ts, not here: `askModel` runs this on every response and `evaluate`
 * throws on the `error`-severity half. It is also public, so a caller can arrive with a
 * program the validators never saw. */
export function validateResponse(p: Program, res: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = []
  const err = (code: string, path: string, message: string) =>
    out.push({ code, path, message, severity: 'error' })
  // Every branch below exists because the wire disagreed with the declared type, so naming
  // what actually arrived ("null", "an array", "string") is most of the diagnosis.
  const shape = (v: unknown): string =>
    v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v
  // Present-but-not-a-number is the quiet failure: `"0.95"` as a string, or a null, reaches
  // the reducer's >=/<= comparisons and coerces (or goes NaN) into a verdict nobody flags.
  const num = (v: unknown, path: string, what: string): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    err('answer_not_a_number', path, `${what} is ${JSON.stringify(v) ?? shape(v)}, not a number.`)
    return undefined
  }

  if (res === null || typeof res !== 'object' || Array.isArray(res)) {
    err('response_malformed', 'response',
      `Response is ${shape(res)}, not an object. Nothing in it can be read.`)
    return out
  }
  const body = res as Record<string, unknown>

  // A null or absent `answers` currently dies as a bare node TypeError ("Cannot read
  // properties of null") thrown from jevc's own internals, pointing the user at jevc rather
  // than at the response. Nothing further is checkable without it, so this is the one early
  // return — reporting 20 answer_missing issues for a response that simply has no answers
  // buries the actual fault.
  const answers = body.answers
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    err('answers_missing', 'answers',
      `Response carries no answers object (got ${shape(answers)}); no decision was answered.`)
    return out
  }
  const byId = answers as Record<string, unknown>

  // Deduplicated by id, the same way emitJson's `Object.fromEntries` collapses the question
  // map (last definition wins), so a program with duplicate ids reports one issue per id
  // rather than one per copy. Unreachable through askModel/evaluate — validateProgram's
  // `duplicate_id` throws first — but this function is public.
  for (const d of new Map(p.decisions.map(d => [d.id, d])).values()) {
    const at = `answers.${d.id}`
    const a = byId[d.id]
    if (a === undefined) {
      err('answer_missing', at,
        `No answer for decision "${d.id}". The reducer needs every asked decision; a batch is scored independently, so a dropped id is silent until the verdict is computed.`)
      continue
    }
    if (a === null || typeof a !== 'object' || Array.isArray(a)) {
      err('answer_type_mismatch', at, `Answer for "${d.id}" is ${shape(a)}, not a ${d.kind} answer.`)
      continue
    }
    const ans = a as Record<string, unknown>
    if (ans.type !== d.kind) {
      // The sharp one. Today a choice-shaped answer to a noul question surfaces out of
      // isUncertain as `Decision "x" needs belowConfidence`, which reads as a defect in the
      // program's own uncertainty declaration and sends the user to edit the wrong file.
      // The program is fine; the response answered a different question than the one asked.
      err('answer_type_mismatch', at,
        `"${d.id}" was asked as a ${d.kind} but answered as ${JSON.stringify(ans.type) ?? shape(ans.type)}. The response does not match the request — the program's uncertainty declaration is not at fault.`)
      continue
    }

    if (d.kind === 'noul') {
      const n = num(ans.noul, `${at}.noul`, `"${d.id}".noul`)
      if (n !== undefined && (n < 0 || n > 1)) {
        err('noul_out_of_range', `${at}.noul`,
          `Noul ${n} is outside 0..1. A noul is a probability and the band that decides uncertainty lives in that space, so an out-of-range value reads as certain at both ends.`)
      }
      // Deliberately no check that a noul carries no `confidence`: the field is meaningless
      // for a noul (the probability is the answer) but nothing reads it, so it cannot move
      // a verdict — see `answer_unasked` below for the same reasoning.
    } else {
      const c = num(ans.confidence, `${at}.confidence`, `"${d.id}".confidence`)
      if (c !== undefined && (c < 0 || c > 1)) {
        err('confidence_out_of_range', `${at}.confidence`,
          `Confidence ${c} is outside 0..1; belowConfidence thresholds compare against that range.`)
      }
    }

    if (d.kind === 'score') {
      // A score answer is the probability-weighted expectation over the level indices, not
      // the index itself: 23 of the 26 measured score answers in fixtures/ are fractional
      // (1.99, 2.98, 0.57, 3.09 over five levels), which is exactly why reducer thresholds
      // read 2.5. So range is checkable and integrality is NOT — requiring an integer here
      // would reject almost every real response.
      const s = num(ans.score, `${at}.score`, `"${d.id}".score`)
      // Levels unknown means the program declared no criteria for a score, which is
      // validateProgram's `criteria_missing` — don't blame the response for it twice.
      const levels = Array.isArray(d.criteria) ? d.criteria.length : 0
      if (s !== undefined && levels > 0 && (s < 0 || s > levels - 1)) {
        err('score_out_of_range', `${at}.score`,
          `Score ${s} is outside level-index space for "${d.id}" (${levels} levels => 0..${levels - 1}). Score is not a 0..1 value.`)
      }
    }

    if (d.kind === 'choice') {
      // The reducer matches `is` conditions by exact option name, so an option the program
      // never declared silently matches nothing and falls through to `otherwise` — a wrong
      // verdict with no complaint. Mirrors validateProgram's `reduce_unknown_option` from
      // the other direction.
      const opts = d.criteria && !Array.isArray(d.criteria) ? Object.keys(d.criteria) : []
      const picked = ans.choice
      if (typeof picked !== 'string' || (opts.length > 0 && !opts.includes(picked))) {
        err('choice_unknown_option', `${at}.choice`,
          `"${d.id}" was answered ${JSON.stringify(picked) ?? shape(picked)}, which is not one of its declared options (${opts.join(', ') || 'none declared'}).`)
      }
    }
  }

  // An answer nobody asked for cannot change a verdict — the reducer only ever reads ids the
  // program declares — so rejecting an otherwise-correct response over it would be the same
  // false-rejection mistake as erroring on an unresolved backtick path. It is still worth
  // printing: on a moving alias it is the first visible sign the response has stopped
  // corresponding to the request, and a renamed id shows up here paired with an
  // `answer_missing` for the id we actually asked.
  const asked = new Set(p.decisions.map(d => d.id))
  for (const id of Object.keys(byId)) {
    if (!asked.has(id)) {
      out.push({ code: 'answer_unasked', path: `answers.${id}`, severity: 'warn',
        message: `Response answered "${id}", which this program never asked. The reducer ignores it.` })
    }
  }

  // Usage is billing telemetry, not evidence: the verdict is fully computed without it, so a
  // model that omits it must not have its answers thrown away. Not silent either — Verdict
  // declares `usage` non-optional, so an absent one is handed back as `undefined` behind a
  // type that promises numbers, and the crash lands in whatever sums the tokens.
  const usage = body.usage
  const counts = usage !== null && typeof usage === 'object' && !Array.isArray(usage)
    ? (usage as Record<string, unknown>)
    : undefined
  if (typeof counts?.input_tokens !== 'number' || typeof counts.output_tokens !== 'number') {
    out.push({ code: 'usage_missing', path: 'usage', severity: 'warn',
      message: `Response carries no usable token counts (got ${shape(usage)}); Verdict.usage will not hold the numbers its type promises.` })
  }

  return out
}

/** The keys an error body may keep. Everything else is replaced, subtree and all.
 *
 * This was a denylist of one key, `input`, and it lost the bet a denylist always makes: the
 * request's own field is `state`, not `input`, so the two echo shapes measured off a 422
 * (`{state: ...}` at the top level and `{request: {state: ...}}`) passed straight through
 * into `err.body`. The shape is chosen by a remote party, so the set that can be enumerated
 * is the set we want to keep, not the set we want to drop.
 *
 * The cost is real and deliberate: FastAPI's `loc` and `msg` are not here. `loc` is a path
 * INTO the request whose tail segments are keys of the caller's own state, and `msg` is
 * generic enough ("Field required") not to be worth the same bet. The rebuilt error message
 * (`"400 request failed (body redacted)"`, runtime.ts) already carries the status. */
const ERROR_BODY_KEYS: ReadonlySet<string> = new Set(['error', 'message', 'detail', 'code', 'type'])

/** The 422 body echoes the whole request, state included. Never log it raw. */
export function redactErrorBody(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body
  // Still cloned through JSON first, and still allowed to throw on a circular body: the
  // caller (runtime.ts) turns that into `[unredactable]`, which is the right answer, and a
  // recursive walk over a cycle would not return at all.
  const clone = JSON.parse(JSON.stringify(body))
  const keep = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(keep)
    if (n === null || typeof n !== 'object') return n
    return Object.fromEntries(Object.entries(n as Record<string, unknown>)
      .map(([k, v]) => [k, ERROR_BODY_KEYS.has(k) ? keep(v) : '[redacted]']))
  }
  return keep(clone)
}
