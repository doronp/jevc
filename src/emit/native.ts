import type { EntryType } from '../contract.js'
import type { Condition, Decision, Program } from '../ir.js'
// One definition, shared with ai-sdk.ts: `idKey` and the line-terminator set were
// byte-identical copies here and there, and nothing forced them to stay in step. The
// module is named for the TYPESCRIPT targets — its ECMAScript terminator set is
// deliberately NOT the one bouncer.ts, toolgate.ts and langchain.ts use, and the header
// of ts-lowering.ts says why all three must stay separate.
import { tsIdKey as idKey, tsValue, TS_LINE_TERMINATORS as LINE } from './ts-lowering.js'
import { cannotLower, refusal } from './capability.js'

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

// `tsValue`, never a bare `JSON.stringify`, at every one of the four VALUE splices below.
// Each of them lands its argument in expression position, where JSON.stringify's output is
// an object literal and a nested `__proto__` key is the prototype setter — so the option or
// the instruction text silently vanished from the emitted map while `--emit json` and
// `--emit langchain` still carried it. Same defect as `idKey` guards in key position, one
// level deeper; ts-lowering.ts states it once. The output is byte-identical to the old
// `JSON.stringify` splice for any value that has no `__proto__` key in it.
function emitDecision(d: Decision): string {
  const head = `${provenance(d)}  ${idKey(d.id)}: `
  if (d.kind === 'noul') {
    const crit = d.criteria && !Array.isArray(d.criteria)
      ? `, criteria: ${tsValue(d.criteria)}` : ''
    return `${head}{ type: 'noul', instructions: ${tsValue(d.instructions)}${crit} },`
  }
  if (d.kind === 'score') {
    const levels = (d.criteria as readonly EntryType[]).map(c => tsValue(c)).join(', ')
    // `as const` is load-bearing: without it ScoreOf<T> degrades to `number`.
    return `${head}{ type: 'score', instructions: ${tsValue(d.instructions)}, criteria: [${levels}] as const },`
  }
  const entries = Object.entries(d.criteria as Record<string, EntryType>)
    .map(([k, v]) => `${idKey(k)}: ${tsValue(v)}`).join(', ')
  return `${head}{ type: 'choice', instructions: ${tsValue(d.instructions)}, criteria: { ${entries} } as const },`
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
  // The house pattern, from emitBouncerPolicy (src/emit/policy/bouncer.ts:31): the gate runs
  // INSIDE the emitter as well as in front of it. `emitNative` is exported from src/index.ts,
  // so `emitNative(p)` on its own is a supported call, and a library function that writes a
  // broken artifact when called that way is a defect however carefully cli.ts gates its own
  // path. It does gate it — cli.ts:398 runs canEmit before this call and exits 1 on an error
  // — so nothing on the CLI path changes; what changes is the consumer who skipped the
  // documented `if (canEmit(p, t).length) refuse()` and got a module their own tsc rejects.
  //
  // `cannotLower`, not the whole of `canEmit`: the difference is measured, and capability.ts
  // records the 16 tests that measured it.
  const issues = cannotLower(p, 'sdk')
  if (issues.length) throw refusal('an sdk module', issues)
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
