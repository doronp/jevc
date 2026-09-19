import { TypeSafeClient, APIError } from '@typesafe-ai/sdk'
import type { SystemOneRequest } from '@typesafe-ai/sdk'
import type { JevAnswer, JevModel, JevRequest, ValidationIssue } from './contract.js'
import { redactErrorBody, validateRequest, validateResponse } from './contract.js'
import { uncertaintyOf, validateProgram, type Program } from './ir.js'
import { emitJson } from './emit/json.js'

/** Missing-answer policy, shared by `value`, `isUncertain` and `runReducer` (the three places
 * a reducer touches evidence). They all still THROW, and deliberately so: the only honest
 * reductions of "the model did not answer" are `undefined` — which emit/native.ts:41 inlines
 * straight into `value(a, "x") >= 0.8`, where it is silently false — and "treat the condition
 * as unmatched", which makes a deny rule fail open. Refusing to produce a verdict is the only
 * direction left.
 *
 * What changed is that nothing now has to REACH this throw to learn an answer is missing.
 * `askModel` runs `validateResponse` first and reports every missing id at once as
 * `answer_missing`, so a caller that wants to collect rather than die (checkLive, whose
 * diffFixture exists precisely to classify a vanished answer as `broken`) calls `askModel`
 * and never calls the reducer at all. The throw is now the backstop for a caller who reduced
 * against an answer set they never checked, not the only way to find out. */
const noAnswer = (id: string): Error =>
  new Error(`No answer for decision "${id}". Use askModel() to collect every missing answer as a reportable issue instead of throwing on the first one.`)

/** The number a `gte`/`lte` condition compares, by kind. A non-finite one is refused rather
 * than returned: every comparison against NaN or undefined is false, so a rule written to
 * DENY never fires and the reducer falls through to the permissive `otherwise` at exit 0 —
 * fail-open, from evidence nobody could read. `validateResponse` catches this one call
 * earlier on the `evaluate` path (`answer_not_a_number`), so this is the backstop for the
 * exported reducer's own callers; emit/native.ts inlines the same comparison. */
const numberOf = (v: unknown, id: string, what: string): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  throw new Error(`Decision "${id}" was answered with a ${what} of ${typeof v === 'number' ? String(v) : JSON.stringify(v) ?? String(v)}, which is not a finite number. Every comparison against it is false, so the reducer would fall through to \`otherwise\` — refusing beats computing a permissive verdict from evidence that cannot be read.`)
}

/** The evidence number a threshold compares.
 *
 * On a CHOICE this is the CONFIDENCE, never the chosen option: `gte`/`lte` against a choice
 * gates on how sure the model is, and `is` (via `choiceOf`) is the only condition that gates
 * on WHAT it picked. That convention is load-bearing rather than incidental — ir.ts's
 * `is_needs_choice` refuses `is` against a non-choice while deliberately allowing gte/lte
 * against a choice, and `probability_threshold_out_of_range` requires such a threshold to
 * live in 0..1 precisely because it is compared against a confidence. */
export function value(a: Record<string, JevAnswer>, id: string): number {
  const ans = a[id]
  if (!ans) throw noAnswer(id)
  if (ans.type === 'noul') return numberOf(ans.noul, id, 'noul')
  if (ans.type === 'score') return numberOf(ans.score, id, 'score')   // level-index space, 0..n-1
  return numberOf(ans.confidence, id, 'confidence')
}

/** The `choice` field when the answer is a choice, `undefined` otherwise. Never throws
 * on a missing answer — an `is` comparison against `undefined` is correctly false. */
export function choiceOf(a: Record<string, JevAnswer>, id: string): string | undefined {
  const ans = a[id]
  return ans?.type === 'choice' ? ans.choice : undefined
}

export function isUncertain(a: Record<string, JevAnswer>, id: string, p: Program): boolean {
  const ans = a[id]
  if (!ans) throw noAnswer(id)
  const d = p.decisions.find(x => x.id === id)
  if (!d) throw new Error(`No decision "${id}" in program.`)
  const u = uncertaintyOf(d)
  if (ans.type === 'noul') {
    if (!('band' in u)) throw new Error(`Decision "${id}" is a noul but has no band.`)
    // Same refusal as `value`, and for a sharper reason: `NaN > 0.35 && NaN < 0.65` is
    // false, so an unreadable answer reported CERTAIN — the escalate-to-human rule was the
    // first thing it switched off.
    return numberOf(ans.noul, id, 'noul') > u.band[0] && ans.noul < u.band[1]
  }
  if (!('belowConfidence' in u)) throw new Error(`Decision "${id}" needs belowConfidence.`)
  return numberOf(ans.confidence, id, 'confidence') < u.belowConfidence
}

export function runReducer(p: Program, a: Record<string, JevAnswer>): string {
  for (const rule of p.reduce.rules) {
    const ok = rule.when.every(c => {
      if (c.op === 'uncertain') return isUncertain(a, c.id, p)
      if (c.op === 'is') return choiceOf(a, c.id) === c.value
      // The belt to validateProgram's `condition_op_unknown` (ir.ts), which is the braces.
      // `Condition`'s union constrains literals written in TypeScript and nothing else: every
      // Program that reaches here at runtime came from a bare cast of parsed JSON, and
      // runReducer is exported — emit/native.ts inlines the same comparison into generated
      // files, and both `evaluate` and direct callers can arrive with a program the validator
      // never saw. The old tail was `c.op === 'gte' ? >= : <=`, so ANY op that was not 'gte'
      // executed as 'lte': `gt` against a 0.5 threshold turned a deny rule into a rule that
      // cannot fire, and the caller got the fallthrough verdict at exit 0. A wrong security
      // verdict must never be the quiet default, so this refuses by name instead.
      // Annotated `string` on purpose — it keeps TypeScript from narrowing `c` to `never`
      // inside the guard, so the message can read the op without a cast.
      const op: string = c.op
      if (op !== 'gte' && op !== 'lte') {
        throw new Error(`Condition op "${op}" on "${c.id}" is not one of gte, lte, is, uncertain. Refusing to compute a verdict from a rule whose comparison is unknown.`)
      }
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

/** One call's worth of wire truth, and every way it disagreed with the program that asked.
 * This is `evaluate` minus the reducer and minus the throw: the path for a caller that has to
 * SEE a bad answer set rather than die on it. `checkLive`/`diffFixture` (check.ts) is the
 * motivating one — its whole job is to classify an answer that stopped coming back, which it
 * can only do if something hands it the incomplete set. */
export type AskResult = {
  /** The model version that actually answered — `jev-latest` is an alias that moves. */
  model: string
  answers: Record<string, JevAnswer>
  usage: { input_tokens: number; output_tokens: number }
  latencyMs: number
  /** Request warnings plus everything `validateResponse` found. An `error` here means no
   * verdict can be computed from these answers; `evaluate` turns exactly these into a throw. */
  issues: ValidationIssue[]
}

const issueList = (issues: ValidationIssue[]): string =>
  issues.map(i => `  ${i.path}: ${i.message}`).join('\n')

export async function askModel(
  p: Program,
  state: JevRequest['state'],
  opts: EvaluateOptions = {},
): Promise<AskResult> {
  // The library's main entrypoint ran `validateRequest` only; `validateProgram` was called
  // from cli.ts and parseLiftResponse and nowhere else, so every defect it catches was
  // reachable by simply importing jevc. Some of them are invisible downstream by then:
  // emitJson's `Object.fromEntries` collapses duplicate decision ids into one question BEFORE
  // validateRequest can count them, so a two-decision program shipped one question, the later
  // instructions silently replaced the earlier, and the verdict was computed from an answer to
  // a question the program does not contain. Measured on ids both "dup": validateProgram says
  // `duplicate_id`, the request carried 1 question for 2 decisions, and the verdict was
  // `block` from the wrong evidence.
  //
  // Sequential gates rather than one merged list, matching cli.ts:102/207: validateProgram and
  // validateRequest deliberately overlap on the wire limits (choice_too_few_options,
  // score_too_many_levels...), because they guard different exits. Throwing on the program
  // first means the overlapping codes are reported once, by the validator that can name the
  // decision rather than the emitted question.
  const programIssues = validateProgram(p).filter(i => i.severity === 'error')
  if (programIssues.length) {
    throw new Error(`Invalid program:\n${issueList(programIssues)}`)
  }
  // lintProgram is NOT run here. It is a decomposition lint over question wording, its rules
  // are heuristics, and it fires on programs that are on the wire today (check.ts builds one
  // per fixture). Refusing a paid call over a regex on instructions text belongs at the CLI's
  // authoring gate, which is where it already is.

  const req = emitJson(p, state, opts.model ?? 'jev-latest')
  // Kept unfiltered: the warns are the request half of AskResult.issues below.
  const issues = validateRequest(req)
  const requestErrors = issues.filter(i => i.severity === 'error')
  if (requestErrors.length) {
    throw new Error(`Invalid request:\n${issueList(requestErrors)}`)
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
    // The SDK derives `.message` from `.body` inside its own `APIError` constructor, at
    // throw time — before this catch block runs — and Node derives `.stack` from that
    // message immediately after. Reassigning `.body` here cannot retroactively scrub an
    // already-computed message: a body with no recognized `error`/`message`/`detail` field
    // falls back to a raw `JSON.stringify` of the whole body, and the 422 envelope is known
    // to echo the whole request — state included (see `redactErrorBody`). So rebuild the
    // same error class with a redacted body and a fixed, safe message instead of mutating
    // the one we caught; that bypasses `describe()` entirely and keeps `instanceof` intact.
    // Non-`APIError` failures (`APIConnectionError`, `APITimeoutError`, `APIUserAbortError`)
    // carry no `status`/`body` to redact, so they propagate unchanged.
    if (e instanceof APIError) {
      // `redactErrorBody` deep-clones through `JSON.parse(JSON.stringify(body))`, which throws
      // on a circular body — and it is called from inside a catch block, so that throw would
      // REPLACE the API error with a TypeError about JSON and lose the status, the request id
      // and the class identity the caller is matching on. A redaction that cannot be performed
      // must degrade to withholding the body, never to destroying the error. (The other half
      // of this is now closed in contract.ts: `redactErrorBody` was a denylist of the single
      // key `input`, so a 422 echoing the request under `state` or `request` — which is the
      // shape it actually echoes — went through unredacted. It is an allowlist now.)
      let body: unknown
      try {
        body = redactErrorBody(e.body)
      } catch {
        body = '[unredactable]'
      }
      const rebuilt = Reflect.construct(e.constructor, [
        e.status,
        body,
        e.headers,
        `${e.status} request failed (body redacted)`,
      ]) as APIError
      throw rebuilt
    }
    throw e
  }
  const latencyMs = clock() - t0

  issues.push(...validateResponse(p, res))
  // res.answers was the third of the three bare casts this round exists to close (cli.ts:197
  // and from-prompt.ts:172 are the others). validateResponse has now had its say, so the cast
  // asserts only what was checked — except when there is no answers object at all, where
  // passing a null through a type that promises a Record just moves the `Cannot read
  // properties of null` one frame into the caller. The issue list carries that truth; `{}`
  // keeps the declared type honest for the caller who ignores it.
  const unreadable = issues.some(i => i.code === 'answers_missing' || i.code === 'response_malformed')
  return {
    model: res.model,
    answers: (unreadable ? {} : res.answers) as Record<string, JevAnswer>,
    usage: res.usage,
    latencyMs,
    issues,
  }
}

export async function evaluate(
  p: Program,
  state: JevRequest['state'],
  opts: EvaluateOptions = {},
): Promise<Verdict> {
  const r = await askModel(p, state, opts)
  // evaluate still throws, and the split is the point: a Verdict has one string field the
  // caller acts on, so there is no shape in which it can return "I could not decide" — a
  // wrong verdict and a missing one are indistinguishable downstream. Library callers who
  // need the non-fatal path call askModel and reduce themselves (or not at all).
  // Response errors only: askModel already threw on program and request errors, so anything
  // of error severity left here came off the wire.
  const errors = r.issues.filter(i => i.severity === 'error')
  if (errors.length) {
    throw new Error(`Invalid response:\n${issueList(errors)}`)
  }
  // Safe to reduce now, and only now: validateResponse guarantees every declared decision has
  // an answer of the declared kind, and validateProgram guarantees no decision carries an
  // `uncertain` that uncertaintyOf cannot resolve. Those are the two throws isUncertain has.
  const answers = r.answers
  return {
    verdict: runReducer(p, answers),
    model: r.model,
    answers,
    uncertain: p.decisions.filter(d => isUncertain(answers, d.id, p)).map(d => d.id),
    usage: r.usage,
    latencyMs: r.latencyMs,
  }
}
