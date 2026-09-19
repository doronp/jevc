import type { EntryType, JsonValue } from '../contract.js'
import { uncertaintyOf } from '../ir.js'
import type { Decision, Program } from '../ir.js'

/**
 * A Python literal for an EntryType. JSON.stringify is not enough here: JSON's
 * true/false/null are not Python, and String(v) on an object renders
 * "[object Object]". JSON string escapes ARE a subset of Python's, so strings
 * pass through JSON.stringify unchanged.
 */
function py(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return 'None'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'None'
  if (Array.isArray(v)) return `[${v.map(py).join(', ')}]`
  return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${py(x)}`).join(', ')}}`
}

/**
 * A Python literal for a THRESHOLD, which py() alone cannot render. py() maps every
 * non-finite number to `None` because a JSON null really is None wherever an EntryType
 * appears — but in `_compare(answers, "q", ">=", None)` that is a TypeError the moment
 * the rule is evaluated, where runReducer's `2 >= NaN` is simply false. Python has the
 * literals: `float("inf") / float("-inf") / float("nan")` reproduce JS comparison
 * results exactly. validateProgram refuses most of these now (a noul or choice threshold
 * must be in 0..1, a score threshold inside level-index space), but NOT NaN against a
 * score — `NaN < 0` and `NaN > levels-1` are both false — so the emitter is the last
 * line for that one. Anything that is not a number at all still goes through py(), which
 * renders it faithfully rather than guessing.
 */
function pyThreshold(v: unknown): string {
  if (typeof v === 'number' && !Number.isFinite(v)) {
    return Number.isNaN(v) ? 'float("nan")' : v > 0 ? 'float("inf")' : 'float("-inf")'
  }
  return py(v as JsonValue)
}

function question(d: Decision): string {
  if (d.kind === 'noul') {
    const c = d.criteria && !Array.isArray(d.criteria)
      ? (d.criteria as { true?: EntryType; false?: EntryType }) : undefined
    // criteria is passed explicitly: the library's own default is unreachable dead code.
    const crit = c ? `, criteria=NoulCriteria(true=${py(c.true ?? null)}, false=${py(c.false ?? null)})` : ''
    return `    ${py(d.id)}: Noul(instructions=${py(d.instructions)}${crit}),`
  }
  if (d.kind === 'score') {
    const lv = (d.criteria as readonly EntryType[]).map(py).join(', ')
    return `    ${py(d.id)}: Score(instructions=${py(d.instructions)}, criteria=[${lv}]),`
  }
  const opts = Object.entries(d.criteria as Record<string, EntryType>)
    .map(([k, v]) => `${py(k)}: ${py(v)}`).join(', ')
  return `    ${py(d.id)}: Choice(instructions=${py(d.instructions)}, criteria={${opts}}),`
}

export function emitLangchain(p: Program, name = 'program'): string {
  // Each decision's uncertainty rule, RESOLVED from the Program (uncertaintyOf supplies
  // jevc's defaults where a decision declares none) rather than assumed to be 0.5.
  const uncertainties = p.decisions.map(d => {
    const u = uncertaintyOf(d)
    const body = 'band' in u
      ? `{"band": [${py(u.band[0])}, ${py(u.band[1])}]}`
      : `{"below_confidence": ${py(u.belowConfidence)}}`
    return `    ${py(d.id)}: ${body},`
  }).join('\n')

  const rules = p.reduce.rules.map((r, i) => {
    // Which rule could not be evaluated, carried into the call. _compare and _uncertain
    // RAISE on an unanswered question now, and a traceback out of a generated module is
    // worthless without it: the frame names _compare, the Program names rule 3, and nothing
    // in the artifact connects the two. First-match-wins makes the index meaningful on its
    // own, and the verdict makes it readable without counting lines.
    const where = py(`rule ${i} -> ${r.then}`)
    const conds = r.when.map(c => {
      // _choice(), not a subscript: `answers["q"].choice` raises KeyError on an
      // unanswered question and AttributeError on an answer that is not a choice, where
      // runtime.choiceOf (runtime.ts:32-37) returns undefined and the rule simply does
      // not fire. `is` is the one operator that is SUPPOSED to be silent about a missing
      // answer, in every target — see _compare's docstring for why the other two are not.
      if (c.op === 'is') return `_choice(answers, ${py(c.id)}) == ${py(c.value)}`
      if (c.op === 'uncertain') return `_uncertain(answers, ${py(c.id)}, ${where})`
      // pyThreshold(), not interpolation: Infinity and NaN are JS globals and Python
      // NameErrors, and py()'s None would turn the comparison into a TypeError.
      return `_compare(answers, ${py(c.id)}, ${py(c.op === 'gte' ? '>=' : '<=')}, ${pyThreshold(c.value)}, ${where})`
    }).join(' and ')
    // `when: []` is an empty conjunction and `[].every(...)` is true, so the rule fires
    // unconditionally — `True` is what that means here, and joining nothing produced the
    // unparseable `if :`.
    return `    if ${conds || 'True'}:\n        return ${py(r.then)}`
  }).join('\n')

  return `# Generated by jevc for langchain-typesafe.
# api_key and base_url come from the environment: TypeSafeClassifier sets
# extra="forbid", so a stray kwarg is a hard error.
from langchain_typesafe import Choice, Noul, NoulCriteria, Score, TypeSafeClassifier

${name}_questions = {
${p.decisions.map(question).join('\n')}
}

classifier = TypeSafeClassifier(questions=${name}_questions, model="jev-latest")

# Each decision's uncertainty rule as the Program declares it. A noul answer is
# {type, noul} with no .confidence field at all, so its band is tested on .noul; a choice
# or score answer carries a required .confidence, which its floor is tested against.
_UNCERTAINTY = {
${uncertainties}
}


def _value(answers, qid):
    """The number a threshold compares against, as jevc's own runtime picks it: a noul's
    value, a score's level index, otherwise a choice's confidence. A choice answer has
    neither .noul nor .score, and falling back to 0 there made every >= fail and every
    <= pass whatever the model said. Nested getattr with a None sentinel, not "or": a
    legitimate noul of 0.0 is falsy and would fall through."""
    ans = answers.get(qid)
    if ans is None:
        return None
    noul = getattr(ans, "noul", None)
    if noul is not None:
        return noul
    score = getattr(ans, "score", None)
    if score is not None:
        return score
    return getattr(ans, "confidence", None)


def _choice(answers, qid):
    """A choice answer's chosen label, or None — mirrors runtime.choiceOf. getattr with a
    default, not attribute access: an unanswered question and an answer of the wrong kind
    (a NoulAnswer has no .choice at all) both collapse to None, and None matches no
    option, so the rule does not fire. Neither is an error a generated module could
    report anywhere."""
    return getattr(answers.get(qid), "choice", None)


def _no_answer(qid, rule):
    return (
        f'No answer for decision "{qid}", read by {rule}. Refusing to compute a verdict: '
        'an unanswered question treated as "the condition did not hold" makes a deny rule '
        'silently not fire and the reducer fall through to "otherwise". '
        "jevc's own runReducer raises here too."
    )


def _compare(answers, qid, op, threshold, rule) -> bool:
    """A rule whose question was not answered REFUSES TO PRODUCE A VERDICT — the same
    answer jevc's own reducer gives (value/isUncertain in src/runtime.ts both throw), and
    therefore the same answer the sdk target gives, since that one calls straight into it.

    This used to return False -- "the rule does not fire" -- citing bouncer, which skips a
    question it has no answer for. That reasoning is sound FOR BOUNCER and unsound here.
    Bouncer is a YAML policy document: it has no exceptions, so skipping is the only thing
    left to it, and target-bouncer.md says so. Python has exceptions. The citation was to a
    constraint that does not bind this target, and what it bought was a fail-open: False on
    a DENY rule is the deny quietly not firing, so an incomplete answer map falls through to
    "otherwise", which in every gate anyone writes is the permissive verdict. Measured, on
    one Program with the gte question unanswered: runReducer THROW, sdk THROW, ai-sdk allow,
    langchain allow. Two of the four evaluators of one Program returned the most permissive
    verdict in the list and two refused; that disagreement is the bug, and this is the
    direction that keeps the implementation that was already right.

    The "is" operator is the exception, in every target: runtime.choiceOf returns undefined
    for an unanswered question and never raises, so _choice() stays silent. "Nobody
    answered" and "the answer was not that option" are the same fact for "is" and different
    facts for a threshold.

    KNOWN TARGET LIMITATION: --emit bouncer and --emit toolgate still skip, and cannot do
    otherwise. A consumer who needs this refusal out of a policy target has to check the
    answer set is complete before the gate runs; the policy document itself cannot."""
    if answers.get(qid) is None:
        raise ValueError(_no_answer(qid, rule))
    v = _value(answers, qid)
    if v is None:
        # Present but unreadable, which runtime.numberOf refuses for the same reason: every
        # comparison against a missing number is False, so the rule cannot fire and the
        # verdict is the fallthrough, computed from evidence nobody could read.
        raise ValueError(
            f'Decision "{qid}", read by {rule}, was answered with no noul, score or '
            'confidence to compare. Refusing to compute a verdict from it.'
        )
    return v >= threshold if op == ">=" else v <= threshold


def _uncertain(answers, qid, rule) -> bool:
    ans = answers.get(qid)
    # No measurement is not "certain" -- it is no verdict at all. See _compare's docstring.
    if ans is None:
        raise ValueError(_no_answer(qid, rule))
    u = _UNCERTAINTY.get(qid)
    if u is None:
        raise ValueError(
            f'No decision "{qid}" in this program, but {rule} asks whether it is uncertain. '
            'Refusing to compute a verdict from a rule whose question does not exist.'
        )
    band = u.get("band")
    if band is not None:
        noul = getattr(ans, "noul", None)
        return noul is not None and band[0] < noul < band[1]
    confidence = getattr(ans, "confidence", None)
    return confidence is not None and confidence < u["below_confidence"]


def reduce(answers) -> str:
    """The verdict is computed here, in code — never asked of the model."""
${rules}
    return ${py(p.reduce.otherwise)}
${p.residual ? `\n# Still requires a generative model:\n${
  // Python's tokenizer ends a line at a lone \r as readily as at \n, so splitting on '\n'
  // alone leaves everything after a CR uncommented — and executed at import. Residual is
  // prose lifted from a human document and arrives with that document's line endings.
  // NUL is the other character the tokenizer will not accept: CPython refuses a NUL
  // anywhere in source text, comments included ("source code string cannot contain null
  // bytes"), so one of them makes the whole module unimportable. It is the one hole left
  // in this emitter — every other user string goes through py() -> JSON.stringify, which
  // escapes it. Fuzzed the rest of C0 through ast.parse: \0, \n and \r are the only three
  // that escape or break a `#` comment, and the split already covers the other two.
  p.residual.split(/\r\n|\r|\n/g).map(l => `# ${l.replace(/\0/g, '\\x00')}`).join('\n')}\n` : ''}`
}
