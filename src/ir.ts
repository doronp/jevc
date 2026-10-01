import { noulCriteriaIssues } from './contract.js'
import type { EntryType, ValidationIssue } from './contract.js'
// A value import, where every other edge to contract.ts is type-only. Safe because the
// dependency is one-way at runtime: contract.ts's only import from ir.ts is `import type
// { Program }`, which is erased (see the note at the top of that file), so there is no cycle.

export type Uncertain = { belowConfidence: number } | { band: [number, number] }

export type Decision = {
  id: string
  kind: 'noul' | 'choice' | 'score'
  instructions: string
  criteria?: { true?: EntryType; false?: EntryType } | Record<string, EntryType> | readonly EntryType[]
  uncertain?: Uncertain
  /** Ids this decision's answer follows from. Nothing reads it: kept so a program that declares
   * one still type-checks and validates. */
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

/**
 * The closed op vocabulary. `Condition`'s union constrains literals written in TypeScript
 * and nothing else: every Program that reaches this function at runtime is a bare cast of
 * parsed JSON (cli.ts:197, and parseLiftResponse on a model's output), so an op outside the
 * vocabulary is a live input rather than a type error. It has to be refused here because
 * runtime.ts:43 and all five emitters end in the same `op === 'gte' ? >= : <=` ternary:
 * anything that is not 'gte' executes as 'lte' — the exact inverse of the rule, at exit 0.
 * toolgate's emitter already refuses an op it does not recognise (policy/toolgate.ts:44),
 * so the fallthrough everywhere else is an oversight, not a decision.
 */
const CONDITION_OPS: ReadonlySet<string> = new Set(['gte', 'lte', 'is', 'uncertain'])

/**
 * Names a decision id and a choice option key may not take, because every consumer
 * downstream keys a PLAIN object by them and a plain object already has these.
 *
 * `__proto__` is the loud one: `questions[d.id] = {...}` hits Object.prototype's setter and
 * re-parents the map instead of creating an own key, so the question VANISHES. Verified on
 * this tree: `emitBouncerPolicy` on a program whose ids are `__proto__` and `other` writes a
 * `gate.questions` block containing only `other` while `gate.rules` still names `__proto__` —
 * valid YAML, loaded clean, and the rule can never match. `emitToolgatePolicy` drops it the
 * same way. The code emitters are worse: they write the id into a TypeScript object LITERAL,
 * where `{ __proto__: {...} }` is the prototype-setter syntax, so the generated file compiles
 * and the question is absent at runtime.
 *
 * The rest are the inherited-lookup half of the same bug. `UNCERTAINTY[id]` (emit/ai-sdk.ts:133)
 * against a plain object returns `Object` itself for `constructor` — truthy, so the `if (!rule)`
 * guard passes and `rule.belowConfidence` is undefined — and a function for `toString`,
 * `hasOwnProperty` and the others. Derived from Object.prototype rather than hand-listed so the
 * set cannot drift from the thing it is protecting; `prototype` is added because the code
 * emitters write these ids into generated source.
 *
 * Round 3 is making the emitters structurally safe (null-prototype maps, quoted keys). This is
 * the gate half of the same fix: it catches the next emitter someone writes. Reachable without
 * malice — `fromJsonSchema` uses the JSON Schema property name as the id, and `__proto__` is a
 * legal JSON object key (verified: `{"properties":{"__proto__":{"type":"boolean"}}}` compiles
 * to a decision with that id today).
 */
const RESERVED_KEYS: ReadonlySet<string> =
  new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'])

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

    if (RESERVED_KEYS.has(d.id)) {
      err('reserved_id', `decisions.${d.id}`,
        `Decision id "${d.id}" is a property every plain JavaScript object already has. Every question map downstream is a plain object keyed by this id, so the question is not refused — it is silently lost (\`__proto__\` re-parents the map on assignment; the others resolve through the prototype chain on lookup) and the rules that name it can never fire. Rename it.`)
    }

    // `kind` is the other closed vocabulary a cast cannot enforce, and it fails the same
    // silent way as an unknown op: toQuestion (emit/json.ts:4-19) tests noul, then score,
    // then treats EVERYTHING else as a choice, so `kind: "boolean"` ships as a choice
    // question. Nothing after this point means anything if the kind is not one of three.
    if (d.kind !== 'noul' && d.kind !== 'choice' && d.kind !== 'score') {
      err('decision_kind_unknown', `decisions.${d.id}`,
        `"${d.id}" has kind "${String(d.kind)}"; the primitives are noul, choice and score. An unrecognised kind is emitted as a choice question rather than refused.`)
      continue
    }

    // The shape of `criteria` IS the kind — the same three rows buildLiftRequest states to
    // the lifter as prose (its TYPE RULES paragraph), enforced. Nothing between this gate
    // and the wire re-checks it: toQuestion throws two layers downstream on a score that
    // is not an array, silently DROPS an array handed to a noul, and silently ships an
    // array handed to a choice as the options "0", "1", "2".
    if (d.kind === 'noul') {
      if (Array.isArray(d.criteria)) {
        err('criteria_shape', `decisions.${d.id}.criteria`,
          `"${d.id}" is a noul whose criteria is an array; a noul takes {true, false} descriptions. An array is not sent at all — the question reaches the model with neither side described.`)
      } else {
        // The same whitelist validateRequest enforces, from the same constant. It lived only
        // there, which gated the path that gets an answer back and left the path that WRITES
        // A DEPLOYABLE FILE open: measured on this tree, `emit-policy --for bouncer` on a
        // noul with `criteria: {treu: "...", false: "..."}` exited 0 and wrote a policy whose
        // question carries only the `false` description — the author's other outcome is gone
        // from the artifact and from the request it makes. Costs the corpus nothing: its 252
        // nouls use `true` and `false` and no other key.
        out.push(...noulCriteriaIssues(d.criteria, d.id, `decisions.${d.id}`))
      }
    } else if (!d.criteria) {
      err('criteria_missing', `decisions.${d.id}`,
        `"${d.id}" is a ${d.kind} decision with no criteria. A noul may omit criteria, but ${d.kind} decisions require it (options for choice, levels for score).`)
    } else if (d.kind === 'choice') {
      if (Array.isArray(d.criteria)) {
        err('criteria_shape', `decisions.${d.id}.criteria`,
          `"${d.id}" is a choice whose criteria is an array; a choice takes a map of option name to description. An array reaches the API as the options "0", "1", "2" — options no one named, which the reducer's \`is\` can never match.`)
      } else {
        // The wire limits are a property of the Program, not of one emit path.
        // validateRequest enforces them on the request it builds, but only `--emit=json`
        // ever runs that, so the default native path shipped a 1-option choice at exit 0.
        const n = Object.keys(d.criteria).length
        for (const opt of Object.keys(d.criteria)) {
          if (RESERVED_KEYS.has(opt)) {
            // The DIAGNOSIS, not the rule, is what changed in the cleanup round. This message
            // used to say the option was lost on the wire and that `is` could never match it.
            // Measured on this tree over all 13 names in RESERVED_KEYS, both are false:
            // emitJson's Object.fromEntries gives the option an own key, it survives the
            // JSON round trip, native/ai-sdk quote or compute the key (emit/native.ts:17),
            // and runReducer's `is` is a string comparison against `ans.choice`, which
            // matches. A message naming a mechanism the reader can check and find absent is
            // how a correct rule gets deleted by the next person.
            // What IS real is the mirror-image failure — an absent option reading as PRESENT.
            // `check.ts:151` is the one plain-object read by option name left in src/, and
            // 12 of the 13 names turn it into a silent pass.
            err('reserved_option', `decisions.${d.id}.criteria`,
              `Choice "${d.id}" has an option named "${opt}", a name every plain JavaScript object already resolves through its prototype. The option itself is not lost — measured on this tree, it reaches the wire as an own key and the reducer's \`is\` matches it. What breaks is reading a probability map by a name the map does not carry: the lookup returns Object.prototype's member instead of undefined, so an absent option reads as present. That read exists today in \`prob_lte\` (check.ts): against an answer carrying no "constructor" probability, \`assertExpectation({${JSON.stringify(d.id)}: {prob_lte: {constructor: 0.01}}}, …)\` returns no failures — a bound reported as held having compared nothing — while the same clause on an ordinary option name correctly fails. Rename it.`)
          }
        }
        if (n < 2) {
          err('choice_too_few_options', `decisions.${d.id}.criteria`,
            `Choice "${d.id}" has ${n} option(s); at least 2 are required. The API accepts one option with 200 and returns it at confidence 1.0.`)
        }
        if (n > 255) {
          err('choice_too_many_options', `decisions.${d.id}.criteria`,
            `Choice "${d.id}" has ${n} options; the maximum is 255.`)
        }
      }
    } else if (!Array.isArray(d.criteria)) {
      err('criteria_shape', `decisions.${d.id}.criteria`,
        `"${d.id}" is a score whose criteria is an object; a score takes an ORDERED ARRAY of level descriptions, because its answer is an index into that array (0..n-1).`)
    } else {
      const n = d.criteria.length
      if (n < 2) {
        err('score_too_few_levels', `decisions.${d.id}.criteria`,
          `Score "${d.id}" has ${n} level(s); at least 2 are required. The API accepts a single level with 200 and returns a constant 0.0 at confidence 1.0.`)
      }
      if (n > 10) {
        err('score_too_many_levels', `decisions.${d.id}.criteria`,
          `Score "${d.id}" has ${n} levels; the API rejects more than 10.`)
      }
    }

    if (d.kind === 'noul' && d.uncertain && 'belowConfidence' in d.uncertain) {
      err('noul_has_no_confidence', `decisions.${d.id}.uncertain`,
        'A noul answer carries no confidence field; its probability is the answer. Use a band instead.')
    }
    if (d.kind !== 'noul' && d.uncertain && 'band' in d.uncertain) {
      err('band_needs_noul', `decisions.${d.id}.uncertain`,
        'A band applies to a noul. Use belowConfidence for choice and score.')
    }
    // An `uncertain` that names neither is strictly worse than no `uncertain` at all:
    // uncertaintyOf's default applies only when the field is ABSENT, so isUncertain
    // (runtime.ts:30/33) reaches a declared-but-empty rule and throws instead of
    // answering. A guardrail that throws is a guardrail that is off.
    if (d.uncertain && !('band' in d.uncertain) && !('belowConfidence' in d.uncertain)) {
      err('uncertain_empty', `decisions.${d.id}.uncertain`,
        `"${d.id}" declares \`uncertain\` with neither band nor belowConfidence. Omit the field to take the default (band ${JSON.stringify(DEFAULT_NOUL_BAND)} for a noul, belowConfidence 0.5 otherwise); an empty one throws at evaluation time.`)
    }
  }

  // The reducer is the verdict, and both of its unguarded fields fail OPEN — the one
  // direction a guardrail must not fail. With no `otherwise`, runReducer returns undefined
  // (runtime.ts:47) and every `verdict === 'deny'` test reads that as permission; emitNative
  // writes the same undefined into a function declared `: string` (emit/native.ts:62-64),
  // so the generated file does not compile. An unknown `kind` is executed as if it were
  // "rules" rather than refused, which is the unknown-op failure one level up.
  if (p.reduce.kind !== 'rules') {
    err('reduce_kind_unknown', 'reduce.kind',
      `Unknown reducer kind "${String(p.reduce.kind)}". The only reducer is "rules" (first match wins), and anything else is run as if it were that.`)
  }
  if (typeof p.reduce.otherwise !== 'string' || p.reduce.otherwise === '') {
    err('reduce_verdict_missing', 'reduce.otherwise',
      'The reducer has no `otherwise` verdict. Every rule can miss, and the fallthrough is what the caller gets when they all do — without it the verdict is undefined, which is not a verdict.')
  }

  const byId = new Map(p.decisions.map(d => [d.id, d]))
  for (const [ri, rule] of p.reduce.rules.entries()) {
    if (typeof rule.then !== 'string' || rule.then === '') {
      err('reduce_verdict_missing', `reduce.rules[${ri}].then`,
        `Rule ${ri} names no verdict. A rule that matches and returns undefined is worse than no rule: it also stops every later rule from being tried.`)
    }
    // A rule that states no condition. REFUSED rather than read as a deliberate "always":
    // `[].every(...)` is true, so runReducer (runtime.ts) returns this rule's verdict for
    // every input — verified on this tree, a program whose first rule is `{when: [], then:
    // "allow"}` answers "allow" for is_destructive 0.99 — and every later rule plus
    // `otherwise` is dead code that still reads as though it gates. The three reasons to
    // refuse rather than accept: "always" is already spelled `otherwise`, so accepting adds
    // a second spelling of an existing concept and no expressive power; the targets already
    // disagree about how to render it (emit/native.ts writes `if ()`, which does not parse,
    // while ai-sdk and langchain write `true`), and emit/capability.ts:137 already refuses
    // it outright for both policy targets with this same code, so refusing here makes the
    // whole toolchain agree instead of leaving the gate softer than the emitters; and an
    // empty `when` is indistinguishable in the JSON from a `when` a lossy producer dropped —
    // a lifted model response is exactly where that arrives. A missing `when` is the same
    // authored defect and worse at runtime (`rule.when.every` throws), so it lands here too.
    if (!Array.isArray(rule.when) || rule.when.length === 0) {
      err('rule_always_matches', `reduce.rules[${ri}]`,
        `Rule ${ri} states no condition, so it matches every input and returns "${String(rule.then)}" — masking \`otherwise\` and every rule after it. A rule that should always fire is \`otherwise\`; a rule that lost its conditions on the way here is a bug. Give it a condition or delete it.`)
    }

    for (const c of Array.isArray(rule.when) ? rule.when : []) {
      // Before the id lookup: an op outside the vocabulary is wrong whether or not the
      // decision it names exists, and it is the one error that inverts a verdict silently.
      if (!CONDITION_OPS.has(c.op)) {
        err('condition_op_unknown', `reduce.rules[${ri}]`,
          `Condition op "${String(c.op)}" on "${c.id}" is not one of gte, lte, is, uncertain. The runtime and every emitter end in \`op === 'gte' ? >= : <=\`, so an unknown op is not refused — it runs as lte, inverting the rule.`)
      }
      const d = byId.get(c.id)
      if (!d) {
        err('reduce_unknown_id', `reduce.rules[${ri}]`,
          `Reducer references unknown decision "${c.id}".`)
        continue
      }
      // `is` compares the chosen option of a choice (runtime.ts:41, via choiceOf), which
      // is undefined for any other kind: the comparison is false for every possible
      // answer, so the rule is dead and the program only reads as though it gates. The
      // reverse pairing is NOT an error — gte/lte against a choice tests its confidence.
      if (c.op === 'is' && d.kind !== 'choice') {
        err('is_needs_choice', `reduce.rules[${ri}]`,
          `\`is\` compares a choice's chosen option, but "${c.id}" is a ${d.kind}. The condition is false for every answer the model can give, so the rule can never fire.`)
      }
      if (c.op === 'gte' || c.op === 'lte') {
        if (d.kind === 'score') {
          const levels = Array.isArray(d.criteria) ? d.criteria.length : 0
          if (levels && (c.value < 0 || c.value > levels - 1)) {
            err('score_threshold_out_of_range', `reduce.rules[${ri}]`,
              `Threshold ${c.value} is outside level-index space for "${c.id}" (${levels} levels => 0..${levels - 1}). Score is not a 0..1 value.`)
          }
        } else if (!(c.value >= 0 && c.value <= 1)) {
          // Stated as the range the threshold must be IN, not the range it must avoid: a
          // value that is not a number at all compares false against everything, so
          // `< 0 || > 1` would pass it — and a hand-written program file is where that arrives.
          err('probability_threshold_out_of_range', `reduce.rules[${ri}]`,
            `Threshold ${c.value} is outside 0..1 for "${c.id}". A noul answer IS a probability and a threshold against a choice compares its confidence, so both live in 0..1: a gte above 1 is a rule that can never fire, and its mirror lte fires on every answer. Score level indices are the only thresholds that leave this range.`)
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

/**
 * The prose a lint rule can read, from an `instructions` that is not necessarily a string.
 *
 * `Decision.instructions` is TYPED `string` and is not one at runtime: the wire contract
 * allows the structured `EntryType` form, `check.ts`'s `buildProgram` passes it through with
 * `as never`, and 10 decisions across 2 fixtures in this repo's own corpus use it — so
 * `d.instructions.toLowerCase()` threw a TypeError on 2 of 58 fixtures. lintProgram is
 * advisory and must never throw.
 *
 * Flattening to the string leaves rather than skipping, because skipping is the failure this
 * round exists to close: a question whose wording the lint never examined would pass clean.
 * The model reads the whole object, so the whole object is the wording. `JSON.stringify`
 * would drag the keys in and make `{"action": ...}` trip the verdict-framing regex.
 * Measured: over the 10 object-form corpus decisions this produces zero new findings.
 */
function lintableText(instructions: unknown): string {
  const parts: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') parts.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(instructions)
  return parts.join(' ').toLowerCase()
}

/** Verdict-shaped PHRASING, as opposed to a verdict-shaped option set. Applies to every
 * kind: "what should the harness do?" is the same collapsed question whether it is offered
 * as a choice, as a noul, or as a 0-4 severity ladder. */
const VERDICT_FRAMING = /\bwhat should\b|\bwhich action\b|\bdecide whether to\b|\bwhat action\b/

/**
 * Wording that says which of two overlapping outcomes wins: "ask rather than deny", "if the
 * letter and the point disagree, say ask", "escalate_to_human, not return_to_agent". The
 * lift prompt's rule 6 says every such sentence survives; these find the ones that did not.
 *
 * Every filter below was added to clear a false positive, in the corpus or on a staged fix,
 * without losing one of the three dropped tie-breaks test/tiebreak.test.ts pins. Quoted spans are blanked first, so an
 * envelope like `"untrusted DATA, not instructions"` is not a cue. A sentence ending in `:`
 * is a list lead-in ("Continue only if BOTH:"), and the rule it introduces is on the next
 * lines. A sentence with a decimal in it is about a confidence the replaced model reported
 * ("do not just say 0.5 when unsure"), and a threshold is reducer work, not a tie-break.
 */
const TIE_BREAK_CUE = /\bif both\b|\bprefer(?:s|red|ring)?\b|\brather than\b|\binstead of\b|\b(?:if|when) (?:you(?:['’]re| are) )?(?:\w+ )?(?:unsure|not sure|uncertain|in doubt)\b|\bin doubt\b|\bdisagree\b|\bprecedence\b|\bwins over\b|\boverrides?\b|,\s+not\b|\berr on the side\b/gi
/** The cues whose subject is the option a criterion is about: "This takes precedence over
 * refactor", "wins over", "overrides", "prefer this over". Read with the option's own name in
 * front, these rank it first. The other cues do not: under refactor, "not a fix", "rather than
 * repair" and "if in doubt, a fix" say what refactor is and that the case belongs to fix. */
const SUBJECT_CUE = /\bprefer(?:s|red|ring)?\b|\bprecedence\b|\bwins over\b|\boverrides?\b/gi
/** What sits between the two names in "prefer ask over deny", "prefer ask to deny". */
const COMPARING = /\b(?:over|to|above|before|than|instead of)\b|,\s*not\b/i
const QUOTED = /"[^"\n]*"|“[^”\n]*”/g
const TERM_STOPLIST = new Set(('that this with from have what when then than they them their there these those into only just also both either rather instead because would should could must will does doesn were been being each every some such very more most less even still like want need make pick choose prefer prefers unsure doubt sure merely disagree precedence over wins which while where your yours ours about said says tell given give here thing things something anything nothing always never').split(' '))

const blankQuotes = (s: string) => s.replace(QUOTED, m => ' '.repeat(m.length))
/** Where `word` occurs as a whole token, case-insensitively. `_` is a word character, so
 * `escalate_to_human` is one token and "human" alone does not name it. */
const positions = (s: string, word: string) =>
  [...s.matchAll(new RegExp(`(?<![\\w])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'gi'))].map(m => m.index!)
const terms = (s: string) => new Set((s.toLowerCase().match(/[a-z]+/g) ?? [])
  .filter(w => w.length >= 4 && !TERM_STOPLIST.has(w))
  .map(w => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)))
const shares = (a: Set<string>, b: Set<string>) => [...a].some(w => b.has(w))

/** The pair of `names` a tie-break sentence ranks, read off where they sit around a cue.
 * A name before the cue and one after it rank the nearest before above the first after
 * ("ask rather than deny"). Two after "prefer" with a comparing word between them rank the
 * first ("prefer ask over deny"), even with a name before it ("deny is the default, but
 * prefer ask over deny"); without one, what is preferred is the name before the cue ("ask,
 * which we prefer over deny or allow"). With none before, two after "instead of" or "rather
 * than" rank the second ("instead of deny, ask"). Only the first name after the cue loses, so
 * "ask, which we prefer over deny or allow" checks ask against deny alone. */
const rankedBy = (s: string, names: string[], cues: RegExp = TIE_BREAK_CUE): { winner: string; loser: string } | undefined => {
  const at = names.flatMap(n => positions(s, n).map(i => ({ i, n }))).sort((a, b) => a.i - b.i)
  for (const m of blankQuotes(s).matchAll(cues)) {
    const cue = m[0].toLowerCase()
    const from = m.index!
    const before = at.filter(a => a.i < from).at(-1)?.n
    const afterAt = at.filter(a => a.i >= from + cue.length)
    const after = [...new Set(afterAt.map(a => a.n))]
    if (/^prefer(?:s|ring)?$/.test(cue) && after.length >= 2) {
      const [first] = afterAt
      const second = afterAt.find(a => a.n !== first.n)!
      if (COMPARING.test(s.slice(first.i + first.n.length, second.i))) return { winner: first.n, loser: second.n }
    }
    const loser = after.find(n => n !== before)
    if (before && loser) return { winner: before, loser }
    if (!before && (cue === 'instead of' || cue === 'rather than') && after.length >= 2) return { winner: after[1], loser: after[0] }
  }
}

/** Tie-break sentences in a source document, with their 1-based line. */
export function findTieBreaks(text: string): Array<{ line: number; sentence: string }> {
  const out: Array<{ line: number; sentence: string }> = []
  text.split('\n').forEach((l, i) => {
    for (const raw of l.split(/(?<=[.!?;:])\s+/)) {
      const sentence = raw.trim()
      if (!sentence || sentence.endsWith(':') || /\d?\.\d/.test(sentence)) continue
      if (blankQuotes(sentence).search(TIE_BREAK_CUE) >= 0) out.push({ line: i + 1, sentence })
    }
  })
  return out
}

/**
 * The tie-breaks in `text` that no question or reducer verdict carries. `decision` is the
 * choice whose options the sentence names, when it names any; `order` is the pair of reducer
 * verdicts whose rules are in the wrong order. Four cases, by what the sentence names:
 *
 * A pair ranks its winner by where the names sit around a cue (`rankedBy`): one before and
 * one after ("ask rather than deny") ranks the first; two after "prefer" with "over" or
 * "to" between them ("prefer ask over deny") ranks the first of those; two after an opening
 * "instead of" or "rather than" ("instead of deny, ask") ranks the second.
 *
 * - A reducer verdict: rule order is rule 6's other allowed home. A ranked pair of verdicts
 *   is carried only if the first rule returning the loser does not come before the first
 *   returning the winner (`otherwise` counts as after every rule). One verdict alone is
 *   skipped.
 * - A ranked pair of options of one choice: carried only if one of those options' criteria
 *   names another of them ("takes precedence over deny"), and none ranks them the other way
 *   round ("refactor ... takes precedence over fix" against "a fix rather than a refactor").
 *   A losing option's criterion that excludes the case ("restructures code, not a fix") is
 *   not ranking it backwards: only a subject cue reads the option's own name as the winner.
 *   Mentioning both in the instructions ("Is it a fix or a refactor?") does not count: that
 *   is how every choice is asked, and it says nothing about which wins.
 * - Exactly one option ("... say ask"): carried only if every option's criterion shares a
 *   word with the sentence, so no option is silent about the case it settles, or if another
 *   choice's text restates the sentence (at least half its words, and two): then it is that
 *   choice's tie-break, and names this option only in passing ("the one the bug is on").
 * - Anything else: carried if any question shares a word with it.
 *
 * ponytail: a cue list and shared words, no parse. One named verdict counts as carried
 * unchecked, a criterion naming the other option counts as carrying the tie-break unless a
 * cue in it ranks the pair backwards, a paraphrase outside the cue list is missed, and one
 * shared word counts as carried. Upgrade: label every tie-break in the corpus once, and
 * measure recall and precision before widening the cue list.
 */
export function unsurfacedTieBreaks(text: string, p: Program):
  Array<{ line: number; sentence: string; decision?: string; order?: { winner: string; loser: string } }> {
  const decisions = Array.isArray(p.decisions) ? p.decisions : []
  const optionsOf = (d: Decision) => (d?.kind === 'choice' && d.criteria && typeof d.criteria === 'object' && !Array.isArray(d.criteria)
    ? d.criteria as Record<string, unknown> : undefined)
  const rules = Array.isArray(p.reduce?.rules) ? p.reduce.rules : []
  const verdicts = [...rules.map(r => r?.then), p.reduce?.otherwise].filter((v): v is string => typeof v === 'string' && v !== '')
  const textOf = (d: Decision) => [d?.id, lintableText(d?.instructions), ...Object.keys(optionsOf(d) ?? {}),
    lintableText(d?.criteria)].join(' ')
  const allTerms = terms(decisions.map(textOf).join(' '))

  const firstRule = (v: string) => {
    const i = rules.findIndex(r => r?.then === v)
    return i >= 0 ? i : v === p.reduce?.otherwise ? rules.length : Infinity
  }
  const out: Array<{ line: number; sentence: string; decision?: string; order?: { winner: string; loser: string } }> = []
  for (const tb of findTieBreaks(text)) {
    const s = tb.sentence
    const said = [...new Set(verdicts)].filter(v => positions(s, v).length)
    if (said.length) {
      const order = rankedBy(s, said)
      if (order && firstRule(order.loser) < firstRule(order.winner)) out.push({ ...tb, order })
      continue
    }
    let carried: boolean | undefined
    let decision: string | undefined
    for (const d of decisions) {
      const c = optionsOf(d)
      if (!c) continue
      const named = Object.keys(c).filter(k => positions(s, k).length)
      const pair = rankedBy(s, named)
      let ok: boolean
      if (pair) {
        // Each criterion is read with its own option in front, so "This takes precedence over
        // refactor" under fix ranks fix first, the way the sentence would. Only a subject cue
        // reads it that way (SUBJECT_CUE); any other cue ranks only names written before it in
        // the criterion itself ("a refactor rather than a fix").
        const own = named.map(k => `${k} ${lintableText(c[k])}`)
        const reversed = (r?: { winner: string; loser: string }) => r?.winner === pair.loser && r.loser === pair.winner
        const backwards = (k: string) => reversed(rankedBy(lintableText(c[k]), named))
          || reversed(rankedBy(`${k} ${lintableText(c[k])}`, named, SUBJECT_CUE))
        ok = own.some(t => named.filter(o => positions(t, o).length).length >= 2) && !named.some(backwards)
      } else if (named.length === 1) {
        const own = terms(Object.keys(c).join(' '))
        const said = new Set([...terms(s)].filter(w => !own.has(w)))
        const whole = terms(s)
        ok = said.size > 0 && Object.values(c).every(v => shares(terms(lintableText(v)), said))
          || decisions.some(o => o !== d && optionsOf(o) && [...terms(textOf(o))].filter(w => whole.has(w)).length
            >= Math.max(2, Math.ceil(whole.size / 2)))
      } else continue
      decision ??= d.id
      carried = carried || ok
    }
    if (carried === undefined) {
      const said = terms(s)
      if (said.size && !shares(said, allTerms)) out.push(tb)
    } else if (!carried) out.push({ ...tb, decision })
  }
  return out
}

export function lintProgram(p: Program, source?: string): ValidationIssue[] {
  const out: ValidationIssue[] = []

  for (const d of p.decisions) {
    const text = lintableText(d.instructions)

    // Rule 1 — never emit a collapsed verdict question. Two independent signals:
    // the option vocabulary (verdict-shaped words) and the instructions' framing
    // (verdict-shaped phrasing), since a domain-named verdict set like
    // {allow, deny, quarantine, sandbox} doesn't trip the vocabulary check alone.
    //
    // The vocabulary half is choice-only by nature — it reads option keys. The FRAMING half
    // is not, and scoping the whole rule to `kind === 'choice'` meant the check did not
    // cover the thing it exists to prevent: the identical collapsed verdict asked as a noul
    // ("Decide whether to block this.") or as a score ("What action should the harness take,
    // 0 = allow ... 4 = block?") shipped clean. Measured before widening: over all 60
    // fixtures / 343 decisions the framing regex matches 22 choice heads and ZERO noul or
    // score heads, so extending it newly refuses nothing in the corpus.
    const opts = d.kind === 'choice' && d.criteria && !Array.isArray(d.criteria)
      ? Object.keys(d.criteria).map(o => o.toLowerCase()) : []
    const verdictish = opts.filter(o => VERDICT_WORDS.has(o)).length
    const vocabCollapse = opts.length > 0 && verdictish >= 2 && verdictish >= opts.length - 1
    if (vocabCollapse || VERDICT_FRAMING.test(text)) {
      // The citation is one call, named, so a reader can check it. The POPULATION claim this
      // message used to make — "collapsed verdict questions return near-uniform
      // distributions" — is refuted by this repo's own corpus: the 26 heads this rule fires
      // on have a median confidence of 0.93. What the
      // corpus does show is that the verdict head is the one you cannot gate on.
      out.push({
        code: 'collapsed_verdict', path: `decisions.${d.id}`, severity: 'error',
        message: `"${d.id}" asks the model for the verdict itself${opts.length ? ` (${opts.join('/')})` : ''}. Measured (fixtures/security-guardrails.json, bash-rm-rf-node-modules-benign): the verdict head returned allow 0.42 / block 0.35 / ask 0.23 at confidence 0.13 — a third of the mass on blocking a routine \`rm -rf node_modules\` — while the narrow heads in the SAME call were decisive: only_regenerable_artifacts 0.93, and blast_radius put 0.98 on level 1. And the failure is not detectable from the answer: across the 26 verdict-shaped heads in fixtures/, correct answers came back at confidences from 0.13 to 1.00, so no confidence floor separates a verdict from a coin flip. Ask for evidence; the reducer computes the verdict, and its thresholds can be re-tuned without a new call.`,
      })
    }

    // Rule 3 — never emit a question spanning two scopes. The trailing ", or ...?"
    // alternative is guarded against an earlier bare "or" in the same instructions:
    // that earlier "or" is very likely enumerating options within one scope (e.g.
    // "matching *.env or *.key") rather than introducing a second independent clause,
    // so a trailing ", or <clause>?" after it is not treated as compound.
    if (/\bor did it\b|\bor whether\b|^(?:(?!\bor\b)[\s\S])*, or\s+[^,?]{0,60}\?|\band also\b/.test(text)) {
      out.push({
        code: 'compound_question', path: `decisions.${d.id}`, severity: 'warn',
        message: `"${d.id}" appears to ask two things at once. Measured (fixtures/security-guardrails.json, bash-compound-rm-rf-escapes-repo): user_authorized_this_action returned 0.59 — the wrong side of 0.5 — on \`echo ... && rm -rf $HOME/Documents/* ./dist\` after the user asked only to clear \`dist/\`, because it anchored on the authorized segment. The same question scoped to ONE action is fine: user_authorized_history_rewrite answered 0.22 in git-reset-clean-force-push-protected-main. Split it by scope.`,
      })
    }

    // Rule 4 — carve-outs and exceptions are allowlists; a question that embeds one
    // ("... except anything under test/fixtures/") makes the model arbitrate the exception
    // instead of answering a fact. Heuristic on wording, so it warns rather than blocks —
    // it can both miss a phrasing and over-flag a legitimate "unless" or "other than".
    //
    // The citation used to be the glob-evasion numbers (0.25/0.10/0.14 vs 0.96/0.87/0.85).
    // Those are real and measured, but they are about deny-PATTERNS missing evasive
    // spellings and say nothing about carve-outs; they belong to Rule 5 below and only
    // there. The corpus question that genuinely embeds a carve-out is cited instead.
    //
    // It used to be two. The second, vendored-edit-authorization-ambiguous, was removed
    // from the corpus for licensing reasons, and a message may only cite what the shipped
    // fixtures still record — test/ir.test.ts enforces exactly that.
    if (/\b(except|unless|other than|aside from)\b/.test(text)) {
      out.push({
        code: 'embedded_carveout', path: `decisions.${d.id}`, severity: 'warn',
        message: `"${d.id}" appears to embed a carve-out or exception in the question text. Measured (fixtures/agent-harness-rules.json): commit-only-when-explicitly-asked folds "NEVER commit unless the user explicitly asks" into one head, and the head goes mushy — 0.18 on allow at confidence 0.64. The same carve-out asked as its own noul is sharp in the same call: user_explicitly_asked_to_commit 0.06. Carve-outs are allowlists — ask them separately and combine them in \`reduce\`.`,
      })
    }

    // Rule 5 — pattern and glob matching stays in code; a model asked to match a
    // literal pattern performs far worse than one asked the equivalent semantic
    // question. Heuristic on a few glob-shaped tokens, so it warns rather than blocks.
    // These six numbers are the ones this rule is actually entitled to: all six are
    // recorded answers in fixtures/agent-harness-rules.json, named below so a reader can
    // check them, and all six are bounded by an `expect` clause the corpus asserts.
    if (/\*\.|\/\*|\*\//.test(text)) {
      out.push({
        code: 'embedded_pattern', path: `decisions.${d.id}`, severity: 'warn',
        message: `"${d.id}" appears to embed a glob or pattern in the question text. Measured (fixtures/agent-harness-rules.json): asked to apply the DECLARED pattern, matched_by_declared_deny_pattern returned 0.25 (no-push-to-main-any-spelling) and 0.10 (never-create-a-pr-even-when-asked) and path_matches_declared_generated_globs 0.14 (never-hand-edit-generated-file) — all three wrong-side — while the semantic question in the same three calls answered 0.96, 0.87 and 0.85. Pattern matching stays in code — ask only what a pattern cannot express.`,
      })
    }

    // Rule 6 — a score whose levels are placeholders. contract.ts's
    // `score_level_undescribed` fires only on `null` and `''`, and from-schema.ts lowers a
    // bounded integer to labels like "severity = 0" / "severity = 1" — non-empty strings
    // that sail through it, leaving a score that ships with nothing telling the model what
    // any level MEANS. A score answer is a probability-weighted index over these labels, so
    // undescribed levels do not merely lose precision, they decide the number.
    //
    // The predicate is the defect, not the one producer: levels are placeholders when they
    // are blank, or when stripping the digits collapses them all to the same text ("severity
    // = ", "level ", ""). Measured: fires on 0 of the 26 scores in fixtures/ and on
    // from-schema's generated labels. `warn`, not `error` — the program is answerable, just
    // badly, and this rule guesses at prose.
    if (d.kind === 'score' && Array.isArray(d.criteria) && d.criteria.length >= 2) {
      const levels = d.criteria.map(c => (typeof c === 'string' ? c : c == null ? '' : JSON.stringify(c)))
      const indistinct = new Set(levels.map(l => l.replace(/\d+/g, '').trim())).size === 1
      if (levels.some(l => l.trim() === '') || indistinct) {
        // The remedy, not the predicate, is what changed in the cleanup round. Measured: this
        // fires on 100% of the scores `fromJsonSchema` produces, because its only score branch
        // is the bounded integer and that branch always writes `${id} = ${i}`. The old remedy
        // told the reader to "describe each level", which is unreachable from a JSON Schema —
        // no keyword on that branch carries per-level prose, and the field's own `description`
        // becomes `instructions`. A warning that is true, permanent and unactionable is one
        // users learn to scroll past, which costs the times it matters. The rule keeps firing
        // (an undescribed level really does decide the number) and now names steps that work:
        // both routes below are measured in test/ir.test.ts to clear the warning end to end.
        out.push({
          code: 'score_levels_undescribed', path: `decisions.${d.id}.criteria`, severity: 'warn',
          message: `Score "${d.id}" has level descriptions that do not describe the levels (${levels.map(l => JSON.stringify(l)).join(', ')}) — they differ only by a number, so the model is told the index and not what it means. A score answer is a probability-weighted index over exactly these labels. Writing the Program by hand, put real prose in \`criteria\`. Coming from \`jevc compile\` on a JSON Schema there is no per-level text to write — the bounded-integer branch always labels levels this way — so change the schema instead: \`oneOf: [{const: 0, description: "…"}, …]\` lowers to a choice whose options carry that prose (the reducer then matches it with \`is\` rather than a gte/lte threshold), and \`{type: "array", items: {enum: […]}}\` lowers to one noul per level.`,
        })
      }
    }
  }

  // Lift rule 6 — a tie-break in the source survives, in the criteria or as reducer order.
  // Only the caller holding the source text can run it: a Program keeps a quote per
  // decision, not the document, so `jevc compile program.json` without `--source` never
  // reaches this. It cites fixtures by id and prompt sentence only: rerecord.ts rewrites
  // questions, never llm_prompt, so what a recorded question says is not a claim that lasts.
  // No number is recorded for the cost of a dropped tie-break, and this message may not invent one.
  if (typeof source === 'string') {
    const rules = Array.isArray(p.reduce?.rules) ? p.reduce.rules : []
    // The winner can be only `otherwise`, which sits after every rule: there is no rule
    // returning it to move, so the step is a new one.
    const fix = ({ winner, loser }: { winner: string; loser: string }) => rules.some(r => r?.then === winner)
      ? `\`reduce\` has a rule returning "${loser}" before any returning "${winner}", so where both fire first-match order returns the one the sentence ranks second. Move the "${winner}" rule above it.`
      : `\`reduce\` has a rule returning "${loser}" and returns "${winner}" only as \`otherwise\`, so wherever that rule fires first-match order returns the one the sentence ranks second. Add a rule returning "${winner}" above the "${loser}" rule, for the case the sentence describes.`
    for (const t of unsurfacedTieBreaks(source, p)) {
      out.push({
        code: 'tiebreak_unsurfaced', path: t.order ? 'reduce.rules' : t.decision ? `decisions.${t.decision}.criteria` : 'decisions', severity: 'warn',
        message: `Line ${t.line} of the source is a tie-break, "${t.sentence}", and ${t.order
          ? fix(t.order)
          : `${t.decision
          ? `the criteria of "${t.decision}" do not say which option wins, or say it the other way round, so the options it separates can both fit`
          : 'no question and no reducer verdict mentions it'}. Write it into the criteria so those options are mutually exclusive, or make it rule order in \`reduce\`.`} Tie-breaks of this shape are recorded in fixtures/agent-harness-rules.json: surgical-changes-no-drive-by-refactor's prompt says "ask rather than deny" and read-before-edit-letter-vs-spirit's says "say ask". Heuristic on wording, so it warns rather than blocks: it can miss a paraphrase and over-flag.`,
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
