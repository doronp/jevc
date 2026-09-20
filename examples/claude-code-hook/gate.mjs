#!/usr/bin/env node
/**
 * A working Claude Code PreToolUse hook. Not a snippet — this is the file you install.
 *
 *   echo "$(cat payload.sample.json)" | JEVC_REPLAY=1 node gate.mjs
 *
 * It enforces one rule from CLAUDE.md — "NEVER commit unless the user explicitly asks" —
 * by asking three narrow questions and computing the verdict in `program.json`'s reducer.
 * The rule itself never reaches a generative model.
 *
 * Set JEVC_REPLAY=1 to answer from the recorded fixture instead of calling the API, which
 * is how the test suite and a curious reader run it with no key and no network.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { evaluate, runReducer } from '../../dist/index.js'   // installed: from 'jevc'

const HERE = (p) => fileURLToPath(new URL(p, import.meta.url))
const program = JSON.parse(readFileSync(HERE('./program.json'), 'utf8'))

/** Fail closed. A gate that disappears when the network does is not a gate. Override with
 *  JEVC_ON_ERROR=allow if you would rather the agent keep working than be stopped. */
const ON_ERROR = process.env.JEVC_ON_ERROR === 'allow' ? 'allow' : 'ask'

/**
 * The last few human turns, read from the transcript Claude Code points the hook at.
 * This is the evidence the whole rule turns on: the difference between "commit this" and
 * "go ahead" is the difference between consent and a surprise commit.
 */
function recentUserTurns(transcriptPath, n = 4) {
  if (!transcriptPath) return []
  let lines
  try { lines = readFileSync(transcriptPath, 'utf8').split('\n') } catch { return [] }
  const turns = []
  for (const line of lines) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row?.type !== 'user') continue
    const c = row.message?.content
    const text = typeof c === 'string'
      ? c
      : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : ''
    if (text.trim()) turns.push(text.trim())
  }
  return turns.slice(-n)
}

const stdin = readFileSync(0, 'utf8')
const hook = stdin.trim() ? JSON.parse(stdin) : {}

// Only Bash can create a commit here, so everything else is out of scope. Answering a
// question about a tool the rule cannot apply to spends a call to learn nothing.
if (hook.tool_name && hook.tool_name !== 'Bash') process.exit(0)

const state = {
  hook_event_name: hook.hook_event_name ?? 'PreToolUse',
  tool_name: hook.tool_name,
  tool_input: hook.tool_input,
  cwd: hook.cwd,
  recent_user_turns: hook.recent_user_turns ?? recentUserTurns(hook.transcript_path),
  project_rules: ['NEVER commit unless the user explicitly asks.'],
}

const decide = async () => {
  if (process.env.JEVC_REPLAY) {
    // The recorded answers for exactly this state, from the corpus `npm test` asserts on.
    const { loadFixtures } = await import('../../dist/check.js')
    const f = loadFixtures(HERE('../../fixtures'))
      .find(x => x.id === 'commit-only-when-explicitly-asked')
    return { verdict: runReducer(program, f.measured.answers), answers: f.measured.answers }
  }
  return evaluate(program, state)   // needs TYPESAFE_API_KEY
}

let verdict, answers
try {
  ({ verdict, answers } = await decide())
} catch (err) {
  verdict = ON_ERROR
  answers = {}
  process.stderr.write(`jev gate error, failing ${ON_ERROR}: ${err.message}\n`)
}

if (verdict === 'allow') process.exit(0)   // silence is consent; the tool call proceeds

// The reason is built from the evidence, so the agent is told which question stopped it
// rather than being handed an opaque refusal it will try to argue with.
const asked = answers.user_explicitly_asked_to_commit?.noul
const reason = asked === undefined
  ? 'The commit gate could not be evaluated.'
  : `CLAUDE.md line 7: commits need an explicit request. The recent turns read as`
    + ` approval of a plan, not a request to commit (${asked.toFixed(2)}).`
    + ` Write the commit message and let the human run it.`

process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: verdict === 'deny' ? 'deny' : 'ask',
    permissionDecisionReason: reason,
  },
})}\n`)
