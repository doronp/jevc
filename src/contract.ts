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
export const TOKEN_BUDGET_TOTAL = 64_000
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
    }

    for (const path of backtickPaths(q)) {
      if (resolvePath(req.state, path) === undefined) {
        err('path_unresolved', at,
          `Backtick path \`${path}\` does not resolve in state. The API never reports this — it silently answers from the whole state instead.`)
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

/** The 422 body echoes the whole request, state included. Never log it raw. */
export function redactErrorBody(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body
  const clone = JSON.parse(JSON.stringify(body))
  const strip = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return
    const o = n as Record<string, unknown>
    if ('input' in o) o.input = '[redacted]'
    for (const v of Object.values(o)) strip(v)
  }
  strip(clone)
  return clone
}
