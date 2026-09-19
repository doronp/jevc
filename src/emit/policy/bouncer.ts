import { stringify } from 'yaml'
import type { EntryType } from '../../contract.js'
import type { Program } from '../../ir.js'
import { canEmit, rangeFor } from '../capability.js'

export type BouncerOptions = {
  mode?: 'observe' | 'guard' | 'full'
  tools?: string[]
  timeoutMs?: number
}

const MODES = ['observe', 'guard', 'full']

const cmp = (op: 'gte' | 'lte', v: number) => `${op === 'gte' ? '>=' : '<='}${v}`

/**
 * Every line ending, not just \n: YAML ends a comment at a lone CR too. Applied to the
 * whole assembled comment because the id, the file path and the line number are all live
 * input — a rules file named `RULES.md\nskip_permission_modes: ["default"]\n#` ended the
 * comment and wrote a REAL top-level key, and the policy still loaded: bouncer then
 * skipped the classifier in the default permission mode and allowed everything, at exit 0.
 */
const oneLine = (s: string) => s.replace(/\r\n|\r|\n/g, ' ')

// bouncer reads criteria.true/false as STRINGS. EntryType may be an object, and
// String({}) renders "[object Object]" silently — JSON.stringify keeps the content.
const asString = (v: EntryType | undefined): string =>
  v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)

export function emitBouncerPolicy(p: Program, opts: BouncerOptions = {}): string {
  const issues = canEmit(p, 'bouncer').filter(i => i.severity === 'error')
  if (issues.length) {
    throw new Error(`Cannot emit a bouncer policy:\n${issues.map(i => `  ${i.path}: ${i.message}`).join('\n')}`)
  }
  // target-bouncer.md:27-28. These are emitter options rather than Program fields, so
  // canEmit cannot pre-flight them — and a mode or timeout outside the schema is a LOAD
  // error, which stops policy resolution and routes to on_error: passthrough. Refusing
  // here is the difference between a loud failure and a gate that quietly emits nothing.
  const mode = opts.mode ?? 'observe'
  if (!MODES.includes(mode)) {
    throw new Error(`bouncer accepts mode ${MODES.join(', ')}; got "${mode}". It would refuse to load the policy.`)
  }
  const timeoutMs = opts.timeoutMs ?? 800
  if (!Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000) {
    throw new Error(`bouncer accepts timeout_ms between 50 and 30000; got ${timeoutMs}. It would refuse to load the policy.`)
  }

  // Null-prototype: `questions['__proto__'] = ...` on a plain object literal hits
  // Object.prototype's setter and re-parents the map instead of adding a key, so the
  // question disappears from the policy while the rule that names it stays. The id is
  // live input — from-schema.ts uses the JSON Schema property name verbatim.
  const questions: Record<string, unknown> = Object.create(null)
  for (const d of p.decisions) {
    const c = d.criteria && !Array.isArray(d.criteria)
      ? (d.criteria as { true?: EntryType; false?: EntryType }) : undefined
    // Only the keys `true` and `false` are read, and a side the Program does not
    // describe is OMITTED rather than sent as "". bouncer forwards criteria verbatim to
    // the model, so an empty string does not mean "unspecified", it means "this side is
    // described by nothing" — a worse prompt than leaving the side unnamed. Matches
    // bouncer's own rule that criteria is dropped from the request when it is empty.
    const criteria: Record<string, string> = {}
    if (c?.true != null) criteria.true = asString(c.true)
    if (c?.false != null) criteria.false = asString(c.false)
    // No `type` key: bouncer hardcodes type "noul" for every question.
    questions[d.id] = Object.keys(criteria).length
      ? { instructions: asString(d.instructions), criteria }
      : { instructions: asString(d.instructions) }
  }

  // The belt to the null-prototype brace: any future map that loses a question leaves a
  // rule naming a question that is not declared, and bouncer cannot load that file.
  const lost = p.decisions.filter(d => !Object.hasOwn(questions, d.id)).map(d => d.id)
  if (lost.length) {
    throw new Error(`Refusing to emit a bouncer policy missing question(s) ${lost.join(', ')}: a rule would name a question the gate does not declare, and a policy bouncer cannot load disables the gate.`)
  }

  const rules: unknown[] = p.reduce.rules.map(r => {
    const c = r.when[0]   // canEmit guarantees exactly one, and that it names a decision
    // An uncertainty band is a probability range, and `p` takes one. canEmit already
    // asked rangeFor whether this band survives the grammar, so `p` is present here.
    if (c.op === 'uncertain') {
      const d = p.decisions.find(x => x.id === c.id)!
      return { when: { [c.id]: { p: rangeFor(d).p! } }, then: r.then }
    }
    if (c.op === 'is') throw new Error(`bouncer rules compare a noul probability; "is" cannot be expressed.`)
    return { when: { [c.id]: { p: cmp(c.op, c.value) } }, then: r.then }
  })
  rules.push({ default: p.reduce.otherwise })   // exactly one terminal default, last

  const doc = stringify({
    version: 1,
    backend: 'jev',
    mode,
    timeout_ms: timeoutMs,
    on_error: 'passthrough',
    gate: { tools: opts.tools ?? ['Bash', 'Edit', 'Write', 'NotebookEdit'], questions, rules },
  })

  const provenance = p.decisions
    .filter(d => d.source)
    .map(d => oneLine(`# ${d.id}: ${d.source!.file}:${d.source!.line} — ${d.source!.quote}`))
    .join('\n')

  // residual has no field in the schema and unknown keys are ignored silently, so a
  // comment is the only honest place for it.
  // Split on every line ending, not just \n: YAML ends a comment at a lone CR too, so a
  // residual carrying CRLF or CR (it is prose lifted from a human document) would put its
  // remaining text into the document body, where it parses as policy.
  const residual = p.residual
    ? `#\n# STILL REQUIRES A GENERATIVE MODEL — not enforced by this policy:\n${
        p.residual.split(/\r\n|\r|\n/g).map(l => `# ${l}`).join('\n')}\n` : ''

  // The banner has to track the mode it was given: telling a reader the file "logs and
  // emits nothing" while it is set to deny is the same class of lie as a wrong verdict.
  const banner = mode === 'observe'
    ? `# Ships in observe mode: it logs and emits nothing. Run \`bouncer calibrate\`\n# against your own traffic before moving to guard.`
    : `# Mode ${mode}: this policy BLOCKS — it emits ${mode === 'guard' ? 'ask and deny' : 'every verdict'}.\n# Run \`bouncer calibrate\` against your own traffic before trusting it.`

  return `# Generated by jevc from natural-language rules.
# Review the questions and thresholds — they are the part humans must check.
${banner}
#
# State is built by bouncer, not by jevc: word instructions against its fixed
# vocabulary (tool, action.kind, inside_project, outside_location, sensitive).
${provenance ? `#\n${provenance}\n` : ''}${residual}
${doc}`
}
