/** Deterministic path: a JSON Schema an LLM would have filled in, lowered to Jev.
 *
 *  No model runs here and no key is needed — fromJsonSchema is a pure function. The
 *  interesting part is what it refuses: `reply` is text, and Jev emits no text, so it
 *  lands in the residual instead of being invented as a question. */
import { fromJsonSchema, emitNative, lintProgram } from '../src/index.js'

const schema = {
  type: 'object',
  properties: {
    is_urgent: { type: 'boolean', description: 'Does the message convey time pressure?' },
    department: {
      type: 'string', enum: ['billing', 'technical', 'sales'],
      description: 'Which team should handle this?',
    },
    frustration: {
      type: 'integer', minimum: 0, maximum: 2,
      description: 'How frustrated is the customer?',
    },
    reply: { type: 'string', description: 'Draft a reply to the customer.' },
  },
}

const program = fromJsonSchema(schema)

console.log(`${program.decisions.length} of the schema's 4 fields compiled to Jev questions:`)
for (const d of program.decisions) console.log(`  ${d.id}: ${d.kind}`)

console.log('\n--- emitted TypeScript (jevc compile schema.json) ---\n')
console.log(emitNative(program))

// The residual is a first-class output, not a failure: it is the smaller prompt that
// still needs a generative model, now separated from the parts that no longer do.
console.log('--- residual (still needs an LLM) ---')
console.log(program.residual || '(none — fully compiled)')

// `dropped` carries the things that had no System One equivalent, each with a reason.
console.log('\n--- dropped ---')
for (const d of program.dropped) console.log(`  ${d.quote}: ${d.reason}`)

// The linter enforces the decomposition law (spec §4b) on every program, whatever
// produced it. A clean schema like this one trips nothing.
const issues = lintProgram(program)
console.log('\n--- lint ---')
console.log(issues.length === 0
  ? '  clean'
  : issues.map(i => `  ${i.severity}: ${i.message}`).join('\n'))
