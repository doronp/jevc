/** Cost optimisation: decide the tier before spending a token on either model.
 *
 *  Both cases below are replayed from fixtures/cost-optimization.json (jev-1.13.0,
 *  recorded 2026-09-18). The second one is the argument for this whole design: the
 *  collapsed "which tier?" question picked the CHEAP tier at confidence 0.24 on a file
 *  that emits the billing webhook, while the evidence questions in the same call routed
 *  it up correctly. */
import { fileURLToPath } from 'node:url'
import { emitJson, estimateTokens, runReducer, validateRequest, type Program } from '../src/index.js'
import { loadFixtures } from '../src/check.js'

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url))
const corpus = loadFixtures(FIXTURES)

const program: Program = {
  decisions: [
    {
      id: 'scope_is_multi_file', kind: 'noul',
      instructions: 'Does `latest_user_message` require coordinated changes across more than five files or modules that must stay consistent with each other?',
    },
    {
      id: 'touches_irreversible_surface', kind: 'noul',
      instructions: 'Does the work described in `latest_user_message` touch an irreversible or production-critical surface: authentication, sessions, billing, deploys, deletion, or a data migration?',
    },
    {
      id: 'request_scope_ambiguous', kind: 'noul',
      instructions: 'Is the scope of `latest_user_message` ambiguous enough that two competent engineers could reasonably read it as either a small local change or a large one?',
    },
    {
      id: 'reasoning_depth', kind: 'score',
      instructions: 'How much design reasoning must happen before any code can be written for `latest_user_message`?',
      criteria: [
        'Mechanical. The change is fully specified; it can be applied without making a single design decision.',
        'Ordinary. A few local decisions, all of them obvious from the surrounding code.',
        'Design. Requires choosing an interface, a migration path, or a compatibility story that constrains future work.',
      ],
    },
  ],
  // "When in doubt, pay up" is an asymmetric-cost rule, which is arithmetic, not judgment.
  // 1.5 is in LEVEL-INDEX space: this score has 3 levels, so its answer runs 0..2. A team's
  // habitual 0..1 threshold here would fire on every input.
  reduce: {
    kind: 'rules',
    rules: [
      { when: [{ id: 'touches_irreversible_surface', op: 'gte', value: 0.8 }], then: 'powerful' },
      { when: [{ id: 'reasoning_depth', op: 'gte', value: 1.5 }], then: 'powerful' },
      { when: [{ id: 'scope_is_multi_file', op: 'gte', value: 0.8 }], then: 'powerful' },
      { when: [{ id: 'request_scope_ambiguous', op: 'gte', value: 0.6 }], then: 'balanced' },
    ],
    otherwise: 'fast',
  },
  residual: '', dropped: [],
}

for (const id of ['tier-router-cross-cutting-refactor-to-frontier', 'tier-router-ambiguous-scope-error-handling']) {
  const f = corpus.find(x => x.id === id)!
  const state = f.state as { latest_user_message: string }
  const tier = f.measured.answers.tier            // the collapsed head, recorded in the same call

  console.log(`\n=== ${id}`)
  console.log(`user: "${state.latest_user_message.slice(0, 96)}..."`)
  console.log('  measured evidence:')
  for (const d of program.decisions) {
    const a = f.measured.answers[d.id]
    if (a.type === 'noul') console.log(`    ${d.id.padEnd(30)} ${a.noul}`)
    if (a.type === 'score') console.log(`    ${d.id.padEnd(30)} ${a.score}   (level index, 0..2)`)
  }
  console.log(`  routed in code:            ${runReducer(program, f.measured.answers)}`)
  if (tier.type === 'choice') {
    console.log(`  the collapsed "which tier?" head, same call: ${tier.choice} at confidence ${tier.confidence}`)
  }
  console.log(`  latency: ${f.measured.latency_ms} ms`)
}

// What actually goes on the wire, for one of those states.
const unambiguous = corpus.find(x => x.id === 'tier-router-cross-cutting-refactor-to-frontier')!
const req = emitJson(program, unambiguous.state)
console.log('\n=== the request jevc would send')
console.log(JSON.stringify({ ...req, state: '<the state above>' }, null, 2).slice(0, 620) + ' ...')

const issues = validateRequest(req)
console.log('\nvalidation:', issues.length === 0 ? 'clean' : issues.map(i => i.code).join(', '))

// Routing costs one request. Input is priced at $0.042 per million tokens and output is
// free (spec §3), and estimateTokens uses the 5.1 chars/token ratio measured in
// src/contract.ts — so this is an estimate of a real request, not a benchmark.
const tokens = estimateTokens(req)
console.log(`estimated input: ~${tokens} tokens => ~$${(tokens * 0.042 / 1e6).toFixed(6)} per routing decision, output free.`)
