import type { EntryType } from '../contract.js'
import type { Condition, Decision, Program } from '../ir.js'

// JSON.stringify is the escaper: it handles quotes, backslashes, newlines,
// unicode, and non-string EntryType values (objects/arrays) uniformly. A
// hand-rolled escaper is easy to get wrong in ways that only show up on
// inputs the fixtures don't cover (see fix-round-1 items 2-3).
//
// `__proto__` is the one id JSON.stringify cannot rescue: in an object literal
// `__proto__: v` is the PROTOTYPE SETTER, not a property definition, and quoting it
// (`"__proto__": v`) is the setter too. The question or the choice option simply
// vanishes from the emitted literal — the artifact compiles, tsc is clean, and the
// wire map is short one entry. A computed key is the only ordinary form that defines
// an own property, and `{ ["__proto__"]: v } as const` still narrows. Reachable
// without malice: from-schema.ts uses a JSON Schema property name / enum member as
// the id, so a prototype-pollution detector's own vocabulary produces it.
const idKey = (id: string) =>
  id === '__proto__' ? `[${JSON.stringify(id)}]`
  : /^[A-Za-z_$][\w$]*$/.test(id) ? id
  : JSON.stringify(id)

// Every JS line terminator, LS and PS included: a `//` comment ends at any of them.
// Same constant and same reason as ai-sdk.ts — provenance quotes and residual prose are
// lifted verbatim out of a human document, so they arrive with whatever separators that
// document had, and U+2028 is what pasting from a PDF or Word gives you.
const LINE = /\r\n|[\r\n\u2028\u2029]/g

function provenance(d: Decision): string {
  if (!d.source) return ''
  // Every interpolated field, not just the quote: `file` is as much lifted text as
  // `quote` is (checkLiftedShape never even asserts it is a string), and a terminator in
  // it ends the comment just the same — with the tail of the value landing in the
  // questions literal as code. String() because the Program reaching here is a cast of
  // parsed JSON, so `line` need not be a number nor `file` a string.
  const flat = (v: unknown) => String(v).replace(LINE, ' ')
  return `  // from ${flat(d.source.file)}:${flat(d.source.line)} — "${flat(d.source.quote)}"\n`
}

function emitDecision(d: Decision): string {
  const head = `${provenance(d)}  ${idKey(d.id)}: `
  if (d.kind === 'noul') {
    const crit = d.criteria && !Array.isArray(d.criteria)
      ? `, criteria: ${JSON.stringify(d.criteria)}` : ''
    return `${head}{ type: 'noul', instructions: ${JSON.stringify(d.instructions)}${crit} },`
  }
  if (d.kind === 'score') {
    const levels = (d.criteria as readonly EntryType[]).map(c => JSON.stringify(c)).join(', ')
    // `as const` is load-bearing: without it ScoreOf<T> degrades to `number`.
    return `${head}{ type: 'score', instructions: ${JSON.stringify(d.instructions)}, criteria: [${levels}] as const },`
  }
  const entries = Object.entries(d.criteria as Record<string, EntryType>)
    .map(([k, v]) => `${idKey(k)}: ${JSON.stringify(v)}`).join(', ')
  return `${head}{ type: 'choice', instructions: ${JSON.stringify(d.instructions)}, criteria: { ${entries} } as const },`
}

function emitCondition(c: Condition): string {
  // Signatures must match runtime.isUncertain / runtime.choiceOf exactly (Task 6).
  if (c.op === 'uncertain') return `isUncertain(a, ${JSON.stringify(c.id)}, program)`
  // A cast (`a[id] as ChoiceAnswer`) would silence the discriminated-union
  // narrowing error exactly where the generated code is least inspectable;
  // a helper call keeps the emitted code cast-free, same shape as value()/isUncertain().
  if (c.op === 'is') return `choiceOf(a, ${JSON.stringify(c.id)}) === ${JSON.stringify(c.value)}`
  return `value(a, ${JSON.stringify(c.id)}) ${c.op === 'gte' ? '>=' : '<='} ${c.value}`
}

export function emitNative(p: Program, name = 'program'): string {
  const rules = p.reduce.rules
    .map(r => {
      // `when: []` is an empty conjunction and `[].every(...)` is true (runtime.ts), so the
      // rule fires unconditionally — `true` is what that means here, and joining nothing
      // produced the unparseable `if ()`. Same fix and same wording as ai-sdk.ts and
      // langchain.ts; capability.ts:122 exempts the code targets from `rule_always_matches`
      // precisely because they can say it, so this is the target keeping that promise.
      const conds = r.when.map(emitCondition).join(' && ')
      return `  if (${conds || 'true'}) return ${JSON.stringify(r.then)}`
    })
    .join('\n')

  // Spliced in as a TypeScript EXPRESSION, JSON.stringify's own output is not safe: a
  // `"__proto__"` key inside it is the prototype setter once it is source code, so the
  // carried copy quietly lost criteria options that `programQuestions` above still has.
  // JSON.parse at load makes it data again, where `__proto__` is an ordinary own key.
  const carried = JSON.stringify({
    decisions: p.decisions, reduce: p.reduce, residual: p.residual, dropped: p.dropped,
  })

  return `// Generated by jevc. Review the questions and thresholds — they are the
// part humans must check. Regenerate with: jevc compile
import type { JevAnswer, Program } from 'jevc'
import { value, isUncertain, choiceOf } from 'jevc'

export const ${name}Questions = {
${p.decisions.map(emitDecision).join('\n')}
} as const

/** Carried so the reducer can resolve each decision's uncertainty rule. */
export const program = JSON.parse(${JSON.stringify(carried)}) as unknown as Program

/** The verdict is computed here, in code — never asked of the model. */
export function reduce(a: Record<string, JevAnswer>): string {
${rules}
  return ${JSON.stringify(p.reduce.otherwise)}
}
${p.residual ? `\n${['Still requires a generative model:', ...p.residual.split(LINE)]
    .map(l => `// ${l}`).join('\n')}\n` : ''}`
}
