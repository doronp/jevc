/** Policy emit: a compiled rule lowered into an incumbent guardrail's own config format —
 *  and a refusal when the target cannot express it.
 *
 *  Fifteen shipped Jev guardrail hooks and CLIs were surveyed and none of them lowers
 *  anything: every one takes questions a human wrote by hand. So jevc emits policy FOR
 *  them. Two targets are real (bouncer, toolgate); jev-guard was investigated and cut,
 *  because its questions are `export const` literals in src/guard.js and its decide()
 *  destructures four fixed ids — there is nothing to emit into. */
import { canEmit } from '../src/emit/capability.js'
import { emitBouncerPolicy } from '../src/emit/policy/bouncer.js'
import { emitToolgatePolicy } from '../src/emit/policy/toolgate.js'
import type { Program } from '../src/index.js'

// A CLAUDE.md-style rule, all noul, one question per rule — the shape bouncer accepts.
const program: Program = {
  decisions: [
    {
      id: 'deletes_tracked_files', kind: 'noul',
      instructions: 'Does the command delete files tracked by git?',
      criteria: { true: 'deletes tracked source', false: 'touches only regenerable output' },
      source: { file: 'CLAUDE.md', line: 7, quote: 'Never delete tracked files.' },
    },
    {
      id: 'outside_repo', kind: 'noul',
      instructions: 'Does it touch paths outside the repo root?',
      source: { file: 'CLAUDE.md', line: 8, quote: 'Stay inside the repo.' },
    },
  ],
  reduce: {
    kind: 'rules',
    rules: [
      { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.8 }], then: 'deny' },
      { when: [{ id: 'outside_repo', op: 'gte', value: 0.6 }], then: 'ask' },
    ],
    otherwise: 'allow',
  },
  residual: '', dropped: [],
}

console.log('canEmit(program, "bouncer"):',
  canEmit(program, 'bouncer').length === 0 ? 'clean' : 'issues')

console.log('\n=== jevc emit-policy --for bouncer\n')
console.log(emitBouncerPolicy(program))

// The same program, offered to toolgate. toolgate does not read per-question thresholds:
// it takes max(probability) over EVERY question and compares it against two scalars
// (deny, ask). Emitting a threshold map here would produce YAML that loads cleanly,
// ignores the map, and runs at toolgate's own 0.85/0.55 defaults — a policy that means
// something other than the rule it came from. Refusing is the feature.
console.log('=== jevc emit-policy --for toolgate\n')
try {
  console.log(emitToolgatePolicy(program))
} catch (e) {
  console.log((e as Error).message)
  console.log('\njevc declines rather than emitting a policy that loads cleanly and means')
  console.log('something else. To target toolgate, express the reducer as one shared deny')
  console.log('threshold and one shared ask threshold over every question.')
}

// Capability is about what a target can EXPRESS, not about syntax. bouncer sends every
// question as a noul, so a score has nowhere to go and canEmit says so by code.
const withScore: Program = {
  ...program,
  decisions: [
    ...program.decisions,
    { id: 'blast_radius', kind: 'score', instructions: 'How wide is the blast radius?',
      criteria: ['this file', 'this directory', 'the whole repo'] },
  ],
}

console.log('\n=== canEmit, same rule plus one score decision\n')
for (const i of canEmit(withScore, 'bouncer')) {
  console.log(`${i.severity} ${i.code} at ${i.path}`)
  console.log(`  ${i.message}`)
}
