/** The central use case: a CLAUDE.md rule enforced instead of merely hoped for.
 *
 *  Every number printed below is replayed from fixtures/agent-harness-rules.json —
 *  one real call to jev-1.13.0, recorded 2026-09-18. Nothing here reaches the network. */
import { fileURLToPath } from 'node:url'
import { runReducer, type Program } from '../src/index.js'
import { loadFixtures } from '../src/check.js'

// Resolved against this file, not the shell's cwd, so the example runs from anywhere.
const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url))

const fixture = loadFixtures(FIXTURES)
  .find(f => f.id === 'commit-only-when-explicitly-asked')!

console.log('THE RULE, as written in CLAUDE.md:')
console.log('  "NEVER commit unless the user explicitly asks."\n')
console.log('The LLM prompt this replaces:', fixture.llm_prompt.length, 'chars of instructions,')
console.log('  hand-parsed JSON out, and four judgments held in one head.\n')

const program: Program = {
  decisions: [
    {
      id: 'is_commit_operation', kind: 'noul',
      instructions: 'Does the pending shell command in tool_input.command create a git commit in this repository?',
      source: { file: 'CLAUDE.md', line: 1, quote: 'NEVER commit unless the user explicitly asks.' },
    },
    {
      id: 'user_explicitly_asked_to_commit', kind: 'noul',
      instructions: 'Looking only at recent_user_turns, did the human explicitly ask for a commit to be created?',
    },
    {
      id: 'commit_required_by_requested_task', kind: 'noul',
      instructions: 'Is creating a commit a necessary step of the task the human actually requested in recent_user_turns?',
    },
  ],
  // The verdict is computed here, not asked of the model (spec §4b, rule 1). The
  // carve-outs — "a commit needed by a PR the user asked for is fine" — are allowlist
  // logic, so they live in these rules rather than inside a question's text.
  reduce: {
    kind: 'rules',
    rules: [
      { when: [{ id: 'is_commit_operation', op: 'lte', value: 0.5 }], then: 'allow' },
      { when: [{ id: 'user_explicitly_asked_to_commit', op: 'gte', value: 0.5 }], then: 'allow' },
      { when: [{ id: 'commit_required_by_requested_task', op: 'gte', value: 0.5 }], then: 'allow' },
    ],
    otherwise: 'deny',
  },
  residual: '', dropped: [],
}

console.log('MEASURED EVIDENCE (one call, jev-1.13.0):')
for (const d of program.decisions) {
  const a = fixture.measured.answers[d.id]
  if (a.type === 'noul') console.log(`  ${d.id.padEnd(35)} ${a.noul}`)
}

console.log('\nVERDICT, computed in code:', runReducer(program, fixture.measured.answers))
console.log('Latency:', fixture.measured.latency_ms, 'ms')

// The user's last turn was "yeah that reading looks right, go ahead" — a bare approval
// of a plan, not a request to commit. That is the real-world way surprise commits
// happen, and it is why authorization is split into two questions instead of one.
console.log('\nThe trap in this state: the last user turn is')
console.log(`  "${(fixture.state as { recent_user_turns: string[] }).recent_user_turns.at(-1)}"`)
console.log('  — an approval of the plan, not consent to commit. Measured 0.06, not laundered into consent.')

// The same recorded call also contains the collapsed verdict question, which this
// program deliberately does not emit. It happened to agree here, but see README §
// "The decomposition law" for the same head on a different input: 0.42/0.35/0.23 at
// confidence 0.13 — a coin flip where the evidence heads were decisive.
const collapsed = fixture.measured.answers.decision
if (collapsed.type === 'choice') {
  console.log(`\nFor contrast, the collapsed "what should the hook return" question, asked in the`)
  console.log(`same call: ${collapsed.choice} at confidence ${collapsed.confidence}`)
  console.log(`  (${Object.entries(collapsed.probabilities).map(([k, v]) => `${k} ${v}`).join(' / ')})`)
  console.log('  jevc never emits that question; the reducer above replaces it.')
}
