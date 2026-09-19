/**
 * Transcriptions of what the two policy CONSUMERS actually do with a file jevc emits.
 *
 * Source of truth is `docs/targets/target-bouncer.md` and `docs/targets/target-toolgate.md`
 * — the verified transcriptions of the pinned upstream commits — NOT `src/emit/policy/*.ts`.
 * A transcription taken from the emitter only asserts that the emitter agrees with itself.
 * Every non-obvious line below cites the doc section it came from; if a citation stops
 * matching the doc, the transcription is fiction and the test pinning it is pinning a bug.
 *
 * Shared on purpose: H2 and the property-test owner import these. Signatures take a PARSED
 * policy object (`yaml.parse(emitted)`) and a flat `Record<id, probability>` answer set,
 * because that is the pair the consumer's evaluator is a function of.
 *
 * Not a test file — `vitest.config.ts` only collects `test/**\/*.test.ts`.
 */

/* ------------------------------------------------------------------ shared */

/** Own-property read. Never a bare `o[k]`: these functions are handed policies whose
 *  question ids are live input, and `{}['__proto__']` returns `Object.prototype` while
 *  `{}['toString']` returns a function — both truthy, neither a question. */
const own = (o: unknown, k: string): unknown =>
  o !== null && typeof o === 'object' && Object.hasOwn(o, k)
    ? (o as Record<string, unknown>)[k]
    : undefined

const isMap = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** Own enumerable keys of a parsed YAML mapping, `[]` for anything else. */
const keysOf = (v: unknown): string[] => (isMap(v) ? Object.keys(v) : [])

/* ----------------------------------------------------------------- bouncer */

/** target-bouncer.md:58 — `then` / `default` must be one of exactly these. */
export const BOUNCER_VERDICTS: ReadonlySet<string> = new Set(['allow', 'ask', 'deny'])

/** target-bouncer.md:28 — `mode` enum. */
export const BOUNCER_MODES: ReadonlySet<string> = new Set(['observe', 'guard', 'full'])

/**
 * bouncer's `p` grammar, `parseComparison` (policy.ts:274-298) as transcribed at
 * target-bouncer.md:55-57. Whole-string, trimmed.
 *
 *   ">=N" ">N" "<=N" "<N"   optional whitespace after the operator; N is `\d*\.?\d+`
 *                           (so ".7" parses; "1e-1", "-0.1", "+0.5" do NOT) and 0 <= N <= 1
 *   "LOW..HIGH"             INCLUSIVE at both ends, both in [0,1], LOW <= HIGH
 *
 * The missing exponent branch is bug 1 in this project's history: a threshold that
 * serialised as `1e-7` sat inside the documented 0..1 range and was still unreadable.
 */
const P_CMP = /^(>=|>|<=|<)\s*(\d*\.?\d+)$/
const P_RANGE = /^(\d*\.?\d+)\.\.(\d*\.?\d+)$/

/** `undefined` when `p` is not a string bouncer's grammar accepts (a LOAD error upstream). */
export function parseBouncerP(p: unknown): ((x: number) => boolean) | undefined {
  if (typeof p !== 'string') return undefined
  const s = p.trim()
  const cmp = P_CMP.exec(s)
  if (cmp) {
    const n = Number(cmp[2])
    if (!(n >= 0 && n <= 1)) return undefined
    return cmp[1] === '>=' ? x => x >= n
      : cmp[1] === '>' ? x => x > n
      : cmp[1] === '<=' ? x => x <= n
      : x => x < n
  }
  const range = P_RANGE.exec(s)
  if (!range) return undefined
  const lo = Number(range[1]), hi = Number(range[2])
  if (!(lo >= 0 && lo <= 1 && hi >= 0 && hi <= 1 && lo <= hi)) return undefined
  return x => x >= lo && x <= hi
}

/** Returned by `bouncerVerdict` when no rule matched and the policy has no `default`.
 *  target-bouncer.md:59 — "at runtime a non-match then emits nothing". */
export const BOUNCER_NO_MATCH = '(no rule matched)'

/**
 * bouncer's rule evaluation, `evaluate.ts` as transcribed at target-bouncer.md:62-69,
 * steps 2-4. The pre-classifier short circuits (steps 1: `skip_permission_modes`,
 * `gate.tools`, `gate.fast_path`) are functions of the HOOK PAYLOAD, not of the answers,
 * so they are not part of this signature; `bouncerEmits` below covers the mode gate.
 *
 * - step 2: "non-noul or out-of-range answers are dropped" — an answer outside [0,1], or
 *   one that is not a finite number, is treated as ABSENT, not as 0.
 * - step 3: rules top-to-bottom, FIRST MATCH WINS. "A question with no answer is *skipped*
 *   (absence of evidence), not treated as 0" — the rule is skipped, evaluation continues.
 * - step 4: `any` matches if ANY answered question satisfies the same comparison. It is the
 *   only cross-question primitive.
 *
 * A rule whose `p` does not parse, or that names an undeclared question, is a LOAD error —
 * the whole policy is refused and resolution stops (target-bouncer.md:9). That is a
 * different failure from "this rule did not match", so it throws here rather than being
 * silently skipped; `validateBouncerPolicy` is the check that catches it before this runs.
 */
export function bouncerVerdict(policy: unknown, answers: Record<string, number>): string {
  const gate = own(policy, 'gate')
  const rules = own(gate, 'rules')
  if (!Array.isArray(rules)) throw new Error('bouncer: gate.rules must be a list')
  const declared = new Set(keysOf(own(gate, 'questions')))

  // step 2 — drop what the classifier cannot have answered with a probability.
  const answered = new Map<string, number>()
  for (const id of Object.keys(answers)) {
    const v = own(answers, id)
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) answered.set(id, v)
  }

  for (const rule of rules) {
    if (isMap(rule) && Object.hasOwn(rule, 'default')) return String(own(rule, 'default'))
    const when = own(rule, 'when')
    const names = keysOf(when)
    if (names.length !== 1) throw new Error(`bouncer: a rule's \`when\` names exactly one question, got ${names.length}`)
    const name = names[0]
    const test = parseBouncerP(own(own(when, name), 'p'))
    if (!test) throw new Error(`bouncer: \`p\` on "${name}" is outside the comparison grammar; the policy would not load`)
    if (name === 'any') {
      // step 4 — the same comparison against every ANSWERED question.
      if ([...answered.values()].some(test)) return String(own(rule, 'then'))
      continue
    }
    if (!declared.has(name)) throw new Error(`bouncer: rule names undeclared question "${name}"; the policy would not load`)
    // step 3 — no answer means the rule is skipped, NOT that it matched against 0.
    if (!answered.has(name)) continue
    if (test(answered.get(name)!)) return String(own(rule, 'then'))
  }
  return BOUNCER_NO_MATCH
}

/**
 * target-bouncer.md:67, step 5 — the mode gate, applied AFTER the verdict.
 * `observe` emits nothing ever; `guard` emits ask/deny and swallows allow; `full` emits all
 * three. `null` here means "empty stdout, exit 0" — byte-identical to not having the plugin.
 * A generated policy in the default `observe` mode therefore never changes any behaviour,
 * which is the project's own convention (target-bouncer.md:86) and not a defect.
 */
export function bouncerEmits(policy: unknown, verdict: string): string | null {
  const mode = own(policy, 'mode') ?? 'observe'
  if (mode === 'observe') return null
  if (verdict === BOUNCER_NO_MATCH) return null
  if (mode === 'guard') return verdict === 'allow' ? null : verdict
  return verdict
}

/* ---------------------------------------------------------------- toolgate */

/**
 * target-toolgate.md:54-58 — the four built-in questions. They are the MERGE BASE, so they
 * cannot be removed (`destructive: null` throws, md:76); a user question that reuses one of
 * these ids REPLACES it wholesale (md:77). Every one of them feeds the same `max()`, which
 * is why an emitted toolgate policy is always at least as strict as the Program it came from.
 */
export const TOOLGATE_BUILTINS: readonly string[] =
  ['destructive', 'exfiltration', 'privilege', 'off_task']

/** target-toolgate.md:27-28 — the defaults a policy that omits `thresholds` runs at. */
export const TOOLGATE_DEFAULT_DENY = 0.85
export const TOOLGATE_DEFAULT_ASK = 0.55

/**
 * The merged question id set: `{...builtins, ...user}` (mergePolicy, md:46).
 * `off_task` is silently dropped when there is no task context (`decide`, md:78).
 */
export function toolgateQuestionIds(policy: unknown, taskContext = true): string[] {
  const user = keysOf(own(policy, 'questions'))
  const merged = [...TOOLGATE_BUILTINS, ...user.filter(id => !TOOLGATE_BUILTINS.includes(id))]
  return taskContext ? merged : merged.filter(id => id !== 'off_task')
}

/**
 * toolgate's `decide()`, src/engine.ts:40-56 as transcribed at target-toolgate.md:66 and :91:
 * **max over ALL question probabilities** — the four unremovable built-ins included — then
 * `>= thresholds.deny` => deny, `>= thresholds.ask` => ask, else allow. DENY IS TESTED FIRST.
 *
 * The static-rule layer (md:60-64, :80) runs before this and is a function of the tool input,
 * not of the answers, so it is out of this signature; jevc emits no `rules` key, which leaves
 * the four built-in static rules in place.
 *
 * A question with no probability in `answers` counts as 0. That is the charitable reading and
 * it is the one that makes the grid diff meaningful: toolgate's real behaviour on a missing
 * answer is "malformed answer => fail_mode" (md:26), which is not a verdict at all.
 */
export function toolgateVerdict(
  policy: unknown,
  answers: Record<string, number>,
  opts: { taskContext?: boolean } = {},
): string {
  const t = own(policy, 'thresholds')
  const deny = typeof own(t, 'deny') === 'number' ? (own(t, 'deny') as number) : TOOLGATE_DEFAULT_DENY
  const ask = typeof own(t, 'ask') === 'number' ? (own(t, 'ask') as number) : TOOLGATE_DEFAULT_ASK
  const ids = toolgateQuestionIds(policy, opts.taskContext ?? true)
  const m = Math.max(...ids.map(id => {
    const v = own(answers, id)
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }))
  return m >= deny ? 'deny' : m >= ask ? 'ask' : 'allow'
}

/**
 * `toolMatcherToRegex`, src/policy.ts:158-169 as transcribed at target-toolgate.md:48-52.
 * Used by both `gated_tools` and `rules[].match.tool`; always whole-name anchored.
 * Returns undefined when the matcher does not compile (a LOAD error).
 */
export function toolMatcherToRegex(matcher: string): RegExp | undefined {
  if (matcher === '*' || matcher === '') return /^.*$/
  try {
    if (/^[\w\s|,-]+$/.test(matcher)) {
      const names = matcher.split(/[|,]/).map(s => s.trim()).filter(Boolean)
      return new RegExp(`^(?:${names.join('|')})$`)
    }
    return new RegExp(`^(?:${matcher})$`)
  } catch {
    return undefined
  }
}

/* --------------------------------------------------------------- validators
 *
 * "Does this file parse?" is not the property that matters. For bouncer, a policy file that
 * EXISTS but fails to validate STOPS policy resolution (target-bouncer.md:9) and routes to
 * `on_error`, whose default `passthrough` emits nothing — so an invalid emitted policy does
 * not fail loudly, it silently replaces a working gate with no gate, at exit 0. That makes
 * schema validity a correctness property of the emitter, not a formatting one.
 *
 * Both validators return a list of human-readable violations; `[]` means the consumer loads
 * the file and means by it what the file says.
 */

const enumErr = (path: string, v: unknown, allowed: readonly string[]): string =>
  `${path}: expected one of ${allowed.join('|')}, got ${JSON.stringify(v)}`

/**
 * bouncer's `validate()` (src/engine/policy.ts) as transcribed in the schema tables at
 * target-bouncer.md:22-60. Errors only — the doc's two warning cases (an empty `gate.tools`,
 * a missing `default`) load fine.
 *
 * One deliberate departure, marked: the doc calls a rule listed AFTER the terminal `default`
 * a *warning*. It is reported here as an error because such a rule can never fire, which is
 * the "loads clean and means something else" class this suite exists to catch, and because
 * no correct emitter can produce one.
 */
export function validateBouncerPolicy(policy: unknown): string[] {
  const e: string[] = []
  if (!isMap(policy)) return ['root: a bouncer policy must be a YAML mapping']

  // target-bouncer.md:25 — must be exactly 1; anything else, including missing, is fatal.
  if (own(policy, 'version') !== 1) e.push(`version: expected exactly 1, got ${JSON.stringify(own(policy, 'version'))}`)

  const backend = own(policy, 'backend')
  if (backend !== undefined && typeof backend !== 'string') e.push('backend: must be a string')

  const mode = own(policy, 'mode')
  if (mode !== undefined && !BOUNCER_MODES.has(String(mode))) e.push(enumErr('mode', mode, [...BOUNCER_MODES]))

  // target-bouncer.md:28 — finite, 50 <= n <= 30000, else error.
  const timeout = own(policy, 'timeout_ms')
  if (timeout !== undefined && !(typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 50 && timeout <= 30000)) {
    e.push(`timeout_ms: must be a finite number in 50..30000, got ${JSON.stringify(timeout)}`)
  }

  const onError = own(policy, 'on_error')
  if (onError !== undefined && onError !== 'passthrough' && onError !== 'deny') e.push(enumErr('on_error', onError, ['passthrough', 'deny']))

  const skip = own(policy, 'skip_permission_modes')
  if (skip !== undefined && !(Array.isArray(skip) && skip.every(s => typeof s === 'string'))) {
    e.push('skip_permission_modes: must be a list of strings')
  }

  // target-bouncer.md:31 — missing/not-a-mapping is fatal, the parse aborts.
  const gate = own(policy, 'gate')
  if (!isMap(gate)) return [...e, 'gate: required, and must be a mapping']

  for (const k of ['tools', 'fast_path'] as const) {
    const v = own(gate, k)
    if (v !== undefined && !(Array.isArray(v) && v.every(s => typeof s === 'string'))) {
      e.push(`gate.${k}: must be a list of strings`)
    }
  }

  // target-bouncer.md:38 — required mapping, >= 1 entry.
  const questions = own(gate, 'questions')
  if (!isMap(questions)) {
    e.push('gate.questions: required, and must be a mapping')
  } else if (Object.keys(questions).length === 0) {
    e.push('gate.questions: at least one question is required')
  }
  const declared = keysOf(questions)

  for (const name of declared) {
    // target-bouncer.md:42 — `any` is reserved; it is the cross-question selector.
    if (name === 'any') e.push('gate.questions.any: `any` is reserved as the cross-question rule selector and cannot name a question')
    const q = own(questions, name)
    if (!isMap(q)) { e.push(`gate.questions.${name}: must be a mapping`); continue }
    // target-bouncer.md:43 — string, required, non-empty.
    const instructions = own(q, 'instructions')
    if (typeof instructions !== 'string' || instructions.trim() === '') {
      e.push(`gate.questions.${name}.instructions: required non-empty string, got ${JSON.stringify(instructions)}`)
    }
    // target-bouncer.md:45 — there is no `type` key; every question is sent as a noul.
    if (Object.hasOwn(q, 'type')) e.push(`gate.questions.${name}.type: bouncer has no type key — every question is a noul`)
    // target-bouncer.md:44 — only `true` and `false` are read, each must be a string.
    const criteria = own(q, 'criteria')
    if (criteria !== undefined) {
      if (!isMap(criteria)) e.push(`gate.questions.${name}.criteria: must be a mapping`)
      else for (const side of ['true', 'false'] as const) {
        if (Object.hasOwn(criteria, side) && typeof own(criteria, side) !== 'string') {
          e.push(`gate.questions.${name}.criteria.${side}: must be a string, got ${JSON.stringify(own(criteria, side))}`)
        }
      }
    }
  }

  // target-bouncer.md:39 — must be a list.
  const rules = own(gate, 'rules')
  if (!Array.isArray(rules)) return [...e, 'gate.rules: required, and must be a list']

  let defaults = 0
  for (const [i, rule] of rules.entries()) {
    if (!isMap(rule)) { e.push(`gate.rules[${i}]: must be a mapping`); continue }
    if (Object.hasOwn(rule, 'default')) {
      defaults++
      // target-bouncer.md:59 — a second `default` is an error.
      if (defaults > 1) e.push(`gate.rules[${i}]: a second \`default\` is a load error`)
      if (i !== rules.length - 1) e.push(`gate.rules[${i}]: every rule after the terminal \`default\` is unreachable`)
      const d = own(rule, 'default')
      if (!BOUNCER_VERDICTS.has(String(d))) e.push(enumErr(`gate.rules[${i}].default`, d, [...BOUNCER_VERDICTS]))
      continue
    }
    // target-bouncer.md:53 — `when` names EXACTLY one question.
    const when = own(rule, 'when')
    if (!isMap(when)) { e.push(`gate.rules[${i}].when: must be a mapping naming exactly one question`); continue }
    const names = Object.keys(when)
    if (names.length !== 1) { e.push(`gate.rules[${i}].when: names exactly one question, got ${names.length}`); continue }
    const name = names[0]
    if (name !== 'any' && !declared.includes(name)) {
      e.push(`gate.rules[${i}].when: names "${name}", which is not declared in gate.questions`)
    }
    // target-bouncer.md:54 — the condition is a mapping whose `p` is a STRING.
    const cond = own(when, name)
    if (!isMap(cond)) { e.push(`gate.rules[${i}].when.${name}: must be a mapping with a \`p\``); continue }
    const p = own(cond, 'p')
    if (typeof p !== 'string') {
      e.push(`gate.rules[${i}].when.${name}.p: must be a string, got ${JSON.stringify(p)}`)
    } else if (!parseBouncerP(p)) {
      e.push(`gate.rules[${i}].when.${name}.p: "${p}" is outside the comparison grammar ((>=|>|<=|<)N with N in 0..1, or LOW..HIGH) — note there is no exponent form`)
    }
    const then = own(rule, 'then')
    if (!BOUNCER_VERDICTS.has(String(then))) e.push(enumErr(`gate.rules[${i}].then`, then, [...BOUNCER_VERDICTS]))
  }
  return e
}

/**
 * toolgate's `validatePolicy()` (src/policy.ts:133-155) as transcribed in the schema table at
 * target-toolgate.md:21-46. Every key is optional — `defaultPolicy()` fills the rest — so the
 * violations below are the ones that THROW, plus the two "loads clean, means something else"
 * cases the doc calls out (a non-array `rules` is silently dropped, md:34; a per-key question
 * override is a wholesale replace, md:77).
 */
export function validateToolgatePolicy(policy: unknown): string[] {
  const e: string[] = []
  // target-toolgate.md:19 — top level must be a mapping, else throw.
  if (!isMap(policy)) return ['root: a toolgate policy must be a YAML mapping']

  const backend = own(policy, 'backend')
  if (backend !== undefined) {
    if (!isMap(backend)) e.push('backend: must be a mapping')
    else {
      const provider = own(backend, 'provider')
      if (provider !== undefined && provider !== 'gateway' && provider !== 'mock') e.push(enumErr('backend.provider', provider, ['gateway', 'mock']))
      const model = own(backend, 'model')
      if (model !== undefined && typeof model !== 'string') e.push('backend.model: must be a string')
      const ms = own(backend, 'timeout_ms')
      if (ms !== undefined && !(typeof ms === 'number' && Number.isFinite(ms) && ms > 0)) e.push(`backend.timeout_ms: must be finite and > 0, got ${JSON.stringify(ms)}`)
    }
  }

  const failMode = own(policy, 'fail_mode')
  if (failMode !== undefined && !['passthrough', 'ask', 'deny'].includes(String(failMode))) {
    e.push(enumErr('fail_mode', failMode, ['passthrough', 'ask', 'deny']))
  }

  // target-toolgate.md:27-28 — both are numbers, and `0 <= ask <= deny <= 1` is hard-validated.
  const t = own(policy, 'thresholds')
  if (t !== undefined && t !== null) {
    if (!isMap(t)) e.push('thresholds: must be a mapping')
    else {
      const deny = own(t, 'deny'), ask = own(t, 'ask')
      for (const [k, v] of [['deny', deny], ['ask', ask]] as const) {
        if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v))) {
          e.push(`thresholds.${k}: must be a finite number, got ${JSON.stringify(v)} (${typeof v})`)
        }
      }
      const d = typeof deny === 'number' ? deny : TOOLGATE_DEFAULT_DENY
      const a = typeof ask === 'number' ? ask : TOOLGATE_DEFAULT_ASK
      if (!(0 <= a && a <= d && d <= 1)) e.push(`thresholds: must satisfy 0 <= ask <= deny <= 1, got ask=${a} deny=${d}`)
    }
  }

  // target-toolgate.md:29 — non-empty string that compiles via toolMatcherToRegex.
  const gated = own(policy, 'gated_tools')
  if (gated !== undefined) {
    if (typeof gated !== 'string' || gated === '') e.push('gated_tools: must be a non-empty string')
    else if (!toolMatcherToRegex(gated)) e.push(`gated_tools: "${gated}" does not compile as a tool matcher`)
  }

  const rules = own(policy, 'rules')
  if (rules !== undefined) {
    // target-toolgate.md:34 — a non-array `rules` is SILENTLY DROPPED. It loads, and the
    // rules the author wrote are simply not there.
    if (!Array.isArray(rules)) e.push('rules: must be a list — a non-list value is silently dropped, so the rules would vanish')
    else for (const [i, r] of rules.entries()) {
      if (!isMap(r)) { e.push(`rules[${i}]: must be a mapping`); continue }
      const match = own(r, 'match')
      if (!isMap(match)) e.push(`rules[${i}].match: required, and must be a non-null object`)
      else {
        const tool = own(match, 'tool')
        if (tool !== undefined && (typeof tool !== 'string' || !toolMatcherToRegex(tool))) e.push(`rules[${i}].match.tool: must be a string that compiles as a tool matcher`)
        const re = own(match, 'input_regex')
        if (re !== undefined) {
          if (typeof re !== 'string') e.push(`rules[${i}].match.input_regex: must be a string`)
          else { try { new RegExp(re, 'i') } catch { e.push(`rules[${i}].match.input_regex: "${re}" does not compile`) } }
        }
      }
      const action = own(r, 'action')
      // target-toolgate.md:38 — hard-validated, and note there is NO `passthrough` here.
      if (!['allow', 'ask', 'deny'].includes(String(action))) e.push(enumErr(`rules[${i}].action`, action, ['allow', 'ask', 'deny']))
      const reason = own(r, 'reason')
      if (reason !== undefined && typeof reason !== 'string') e.push(`rules[${i}].reason: must be a string`)
    }
  }

  const questions = own(policy, 'questions')
  if (questions !== undefined) {
    if (!isMap(questions)) e.push('questions: must be a mapping')
    else for (const id of Object.keys(questions)) {
      const q = own(questions, id)
      // target-toolgate.md:76 — `destructive: null` throws; a built-in cannot be removed.
      if (q === null) { e.push(`questions.${id}: null throws — a built-in cannot be removed, only shadowed`); continue }
      if (!isMap(q)) { e.push(`questions.${id}: must be a mapping`); continue }
      // target-toolgate.md:41 — must be exactly `boolean`; score/choice throw.
      if (own(q, 'type') !== 'boolean') e.push(`questions.${id}.type: must be exactly "boolean", got ${JSON.stringify(own(q, 'type'))}`)
      if (typeof own(q, 'instructions') !== 'string') e.push(`questions.${id}.instructions: required, and must be a string`)
      const criteria = own(q, 'criteria')
      if (criteria !== undefined && !isMap(criteria)) e.push(`questions.${id}.criteria: must be a mapping`)
    }
  }
  return e
}

/* --------------------------------------------------------------- grid tools */

const F64 = new DataView(new ArrayBuffer(8))
/** The adjacent double, so a grid can straddle a threshold by exactly one representable step
 *  rather than by an epsilon that may round back onto it. */
export function ulp(x: number, up: boolean): number {
  if (!Number.isFinite(x)) return NaN
  if (x === 0) return up ? Number.MIN_VALUE : 0
  F64.setFloat64(0, x)
  F64.setBigUint64(0, F64.getBigUint64(0) + (up ? 1n : -1n))
  return F64.getFloat64(0)
}

/** Every value in `seeds`, one ULP either side of each, plus the wire's degenerate ends.
 *  Clamped to [0,1] because that is the only range a noul answer can carry. */
export function straddle(seeds: Iterable<number>): number[] {
  const s = new Set<number>([0, 0.5, 1])
  for (const v of seeds) for (const x of [ulp(v, false), v, ulp(v, true)]) if (x >= 0 && x <= 1) s.add(x)
  return [...s].sort((a, b) => a - b)
}
