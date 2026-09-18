import { TypeSafeClient } from '@typesafe-ai/sdk'
import type { SystemOneRequest } from '@typesafe-ai/sdk'
import type { JevAnswer, JevModel, JevRequest } from './contract.js'
import { redactErrorBody, validateRequest } from './contract.js'
import { uncertaintyOf, type Program } from './ir.js'
import { emitJson } from './emit/json.js'

export function value(a: Record<string, JevAnswer>, id: string): number {
  const ans = a[id]
  if (!ans) throw new Error(`No answer for decision "${id}".`)
  if (ans.type === 'noul') return ans.noul
  if (ans.type === 'score') return ans.score   // level-index space, 0..n-1
  return ans.confidence
}

/** The `choice` field when the answer is a choice, `undefined` otherwise. Never throws
 * on a missing answer — an `is` comparison against `undefined` is correctly false. */
export function choiceOf(a: Record<string, JevAnswer>, id: string): string | undefined {
  const ans = a[id]
  return ans?.type === 'choice' ? ans.choice : undefined
}

export function isUncertain(a: Record<string, JevAnswer>, id: string, p: Program): boolean {
  const ans = a[id]
  if (!ans) throw new Error(`No answer for decision "${id}".`)
  const d = p.decisions.find(x => x.id === id)
  if (!d) throw new Error(`No decision "${id}" in program.`)
  const u = uncertaintyOf(d)
  if (ans.type === 'noul') {
    if (!('band' in u)) throw new Error(`Decision "${id}" is a noul but has no band.`)
    return ans.noul > u.band[0] && ans.noul < u.band[1]
  }
  if (!('belowConfidence' in u)) throw new Error(`Decision "${id}" needs belowConfidence.`)
  return ans.confidence < u.belowConfidence
}

export function runReducer(p: Program, a: Record<string, JevAnswer>): string {
  for (const rule of p.reduce.rules) {
    const ok = rule.when.every(c => {
      if (c.op === 'uncertain') return isUncertain(a, c.id, p)
      if (c.op === 'is') return choiceOf(a, c.id) === c.value
      const v = value(a, c.id)
      return c.op === 'gte' ? v >= c.value : v <= c.value
    })
    if (ok) return rule.then
  }
  return p.reduce.otherwise
}

export type Verdict = {
  verdict: string
  /** The model version that actually answered — `jev-latest` is an alias that moves. */
  model: string
  answers: Record<string, JevAnswer>
  uncertain: string[]
  usage: { input_tokens: number; output_tokens: number }
  latencyMs: number
}

export type EvaluateOptions = {
  client?: TypeSafeClient
  model?: JevModel
  /** A guardrail must answer fast or get out of the way. */
  timeoutMs?: number
  maxRetries?: number
  now?: () => number
}

export async function evaluate(
  p: Program,
  state: JevRequest['state'],
  opts: EvaluateOptions = {},
): Promise<Verdict> {
  const req = emitJson(p, state, opts.model ?? 'jev-latest')
  const issues = validateRequest(req).filter(i => i.severity === 'error')
  if (issues.length) {
    throw new Error(`Invalid request:\n${issues.map(i => `  ${i.path}: ${i.message}`).join('\n')}`)
  }

  const client = opts.client ?? new TypeSafeClient({
    timeout: opts.timeoutMs ?? 5_000,
    retry: { maxRetries: opts.maxRetries ?? 1 },
  })

  const clock = opts.now ?? (() => Date.now())
  const t0 = clock()
  let res
  try {
    // jevc's score criteria is `readonly EntryType[]` — questions are loaded from JSON/schemas
    // at runtime with no statically known length, so it can't be the SDK's `ScoreCriteria`
    // tuple (a 2-element minimum only TypeScript can enforce on a literal array). That is the
    // one place JevRequest and SystemOneRequest diverge (see test/contract.sdk-compat.test-d.ts),
    // and it is the narrowest cast that compiles at this boundary.
    res = await client.systemOne(req as SystemOneRequest)
  } catch (e) {
    const err = e as { body?: unknown }
    if (err && typeof err === 'object' && 'body' in err) err.body = redactErrorBody(err.body)
    throw e
  }
  const latencyMs = clock() - t0

  const answers = res.answers as Record<string, JevAnswer>
  return {
    verdict: runReducer(p, answers),
    model: res.model,
    answers,
    uncertain: p.decisions.filter(d => isUncertain(answers, d.id, p)).map(d => d.id),
    usage: res.usage,
    latencyMs,
  }
}
