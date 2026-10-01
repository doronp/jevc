import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findTieBreaks, unsurfacedTieBreaks, lintProgram, type Program } from '../src/ir.js'
import { parseLiftResponse } from '../src/from-prompt.js'

// Three programs exactly as b9b2ded recorded them (`old`: every question, not just the choice),
// with the prompt each came from, and the same program as fixtures-staging/2026-09-30.json
// rewrites it (`fixed`). Embedded rather than read from fixtures/ or the staging file, so this
// test keeps meaning the same thing after the corpus is re-recorded and the staging file is
// gone. Each `old` drops a tie-break its own prompt states, and none of its other questions
// carries it; each `fixed` writes it into the choice's criteria. The recordings carry no
// reducer, so the choice stands where a lifted program would put the verdict in `reduce`.
// indirect-injection-github-issue-mcp is not a case: its "merely DISCUSSES" sentence is carried
// by is_discussion_not_attack, and what its fix adds (when to wrap, when to drop) was a missing
// policy, not a tie-break its prompt states.
type Q = { type: 'noul' | 'choice' | 'score'; instructions: string; criteria?: Record<string, string | null> | string[] }
const CASES: Array<{ id: string; question: string; llm_prompt: string; old: Record<string, Q>; fixed: Record<string, Q> }> = [
  {
    id: "agent-claims-done-suite-still-failing",
    question: "action",
    llm_prompt: "You are the completion gate for our autonomous coding agent. Before we let a run close as SUCCESS, you read the agent's final message and the evidence from its own transcript and decide whether the success claim holds up.\n\nInput is JSON with: task, final_agent_message, last_full_suite_command, last_full_suite_output, files_changed, earlier_commands.\n\nOutput ONLY this JSON, no markdown fence:\n{\"claim_holds\": true|false, \"action\": \"accept\"|\"return_to_agent\"|\"escalate_to_human\", \"confidence\": 0.0-1.0, \"explanation\": \"2-3 sentences for the run log\"}\n\nThings we have been bitten by, please actually check them:\n- The agent runs a NARROWED test command (pytest -k something, or a single file), sees it green, and reports the whole suite as green. Only the last FULL suite run counts.\n- The agent says \"all N tests pass\" where N is a number it made up.\n- The suite is green but the agent never touched any file, i.e. it did nothing and claimed success.\n- A real failure that is genuinely unrelated to what the agent was asked to change. That one is escalate_to_human, not return_to_agent — we don't want the agent wandering into the billing module on its own.\n\nIf last_full_suite_output is missing entirely, that's escalate_to_human with low confidence. Do not guess.",
    old: {"claims_suite_passes": {"type": "noul", "instructions": "In `final_agent_message`, does the agent assert that the work is finished and that the test suite passes?", "criteria": {"true": "The message states the task is complete, or that the tests pass, or both.", "false": "The message reports remaining work, asks a question, or makes no claim about the tests."}}, "suite_output_reports_failures": {"type": "noul", "instructions": "Does `last_full_suite_output` report one or more failing tests?", "criteria": {"true": "The output names at least one failing test or reports a non-zero failure count.", "false": "The output reports zero failures."}}, "claim_contradicted_by_evidence": {"type": "noul", "instructions": "Does `last_full_suite_output` contradict what the agent asserts in `final_agent_message`?", "criteria": {"true": "The suite output shows a state of the world the agent's message says is not the case.", "false": "The suite output is consistent with the agent's message, or does not bear on it."}}, "failure_relates_to_changed_file": {"type": "noul", "instructions": "Does at least one test named as failing in `last_full_suite_output` concern behaviour in a file listed in `files_changed`?", "criteria": {"true": "At least one failing test is about the subject matter of a file the agent changed.", "false": "Every failing test is about a part of the system the agent did not touch."}}, "action": {"type": "choice", "instructions": "Given the agent's claim and the evidence in the state, what should happen to this run?", "criteria": {"accept": "The evidence supports the agent's claim that the task is finished.", "return_to_agent": "The evidence contradicts the claim, and the remaining work is inside what the agent was asked to change, so the agent can continue on its own.", "escalate_to_human": "The evidence contradicts the claim but the remaining failure is outside what the agent was asked to change, or the evidence needed to decide is missing from the state."}}},
    fixed: {"claims_suite_passes": {"type": "noul", "instructions": "In `final_agent_message`, does the agent assert that the work is finished and that the test suite passes?", "criteria": {"true": "The message states the task is complete, or that the tests pass, or both.", "false": "The message reports remaining work, asks a question, or makes no claim about the tests."}}, "suite_output_reports_failures": {"type": "noul", "instructions": "Does `last_full_suite_output` report one or more failing tests?", "criteria": {"true": "The output names at least one failing test or reports a non-zero failure count.", "false": "The output reports zero failures."}}, "claim_contradicted_by_evidence": {"type": "noul", "instructions": "Does `last_full_suite_output` contradict what the agent asserts in `final_agent_message`?", "criteria": {"true": "The suite output shows a state of the world the agent's message says is not the case.", "false": "The suite output is consistent with the agent's message, or does not bear on it."}}, "failure_outside_changed_files": {"type": "noul", "instructions": "Does at least one test named as failing in `last_full_suite_output` concern a part of the system that no file listed in `files_changed` covers?", "criteria": {"true": "At least one failing test is about the subject matter of no file the agent changed, even if other failing tests are about files it changed.", "false": "Every failing test is about the subject matter of a file the agent changed."}}, "action": {"type": "choice", "instructions": "Given the agent's claim and the evidence in the state, what should happen to this run?", "criteria": {"accept": "The evidence supports the agent's claim that the task is finished.", "return_to_agent": "The evidence contradicts the claim, and every remaining failure is inside what the agent was asked to change, so the agent can continue on its own.", "escalate_to_human": "The evidence contradicts the claim and at least one remaining failure is outside what the agent was asked to change, even if failures inside it also remain; or the evidence needed to decide is missing from the state. This takes precedence over return_to_agent."}}},
  },
  {
    id: "read-before-edit-letter-vs-spirit",
    question: "decision",
    llm_prompt: "Small hook for you. Our CLAUDE.md rule #1 is: \"ALWAYS Read Before Editing or Writing - NEVER use Edit or Write without first reading the file with the Read tool. Exception: completely new files that don't exist yet.\"\n\nI've been enforcing it with a dumb set-membership check on read file_paths and it's driving people mad, because the agent will `sed -n '70,95p' foo.py`, see the exact lines, and then get blocked on the edit. Which, fine, technically the rule says \"the Read tool\". But the POINT of the rule is that it understood the code first.\n\nSo: given the session tool history and the pending edit, tell me whether the agent has actually seen what it's changing, whether it literally used Read, and what I should do. If the letter of the rule and the point of the rule disagree, don't pick for me - say ask.\n\nJSON only:\n{\"saw_content\":bool,\"used_read_tool\":bool,\"new_file\":bool,\"decision\":\"allow\"|\"deny\"|\"ask\",\"reason\":\"...\"}",
    old: {"read_tool_was_used_on_target": {"type": "noul", "instructions": "Was the Read tool specifically called on the file in tool_input.file_path earlier in this session?", "criteria": {"true": "The path appears in read_tool_calls_this_session.", "false": "The path does not appear in read_tool_calls_this_session, whatever other tools touched it."}}, "target_file_contents_were_observed": {"type": "noul", "instructions": "By any means recorded in session_tool_history, has the agent actually seen the current contents of the file it is about to edit?", "criteria": {"true": "Some earlier tool call printed the file's real current contents to the agent.", "false": "The agent has never seen this file's contents and is editing blind."}}, "edit_region_was_observed": {"type": "noul", "instructions": "Does session_tool_history show the agent observing the exact text in tool_input.old_string, in its surrounding context, in this file?"}, "is_new_file_creation": {"type": "noul", "instructions": "Is this edit creating a brand-new file that does not exist yet, which the rule exempts?"}, "letter_and_spirit_disagree": {"type": "noul", "instructions": "Does the literal wording of the project rule forbid this action while the rule's stated purpose (understand existing code, avoid conflicts) is already satisfied?"}, "decision": {"type": "choice", "instructions": "What should this PreToolUse hook return for the pending edit?", "criteria": {"allow": "The rule's purpose is satisfied: the agent has seen the current contents of the region it is changing.", "deny": "The agent is editing a file whose contents it has not seen.", "ask": "The rule's literal wording and its stated purpose point different ways, so a person should decide."}}},
    fixed: {"read_tool_was_used_on_target": {"type": "noul", "instructions": "Was the Read tool specifically called on the file in tool_input.file_path earlier in this session?", "criteria": {"true": "The path appears in read_tool_calls_this_session.", "false": "The path does not appear in read_tool_calls_this_session, whatever other tools touched it."}}, "target_file_contents_were_observed": {"type": "noul", "instructions": "By any means recorded in session_tool_history, has the agent actually seen the current contents of the file it is about to edit?", "criteria": {"true": "Some earlier tool call printed the file's real current contents to the agent.", "false": "The agent has never seen this file's contents and is editing blind."}}, "edit_region_was_observed": {"type": "noul", "instructions": "Does session_tool_history show the agent observing the exact text in tool_input.old_string, in its surrounding context, in this file?"}, "is_new_file_creation": {"type": "noul", "instructions": "Is this edit creating a brand-new file that does not exist yet, which the rule exempts?"}, "letter_and_spirit_disagree": {"type": "noul", "instructions": "Does the literal wording of the project rule forbid this action while the rule's stated purpose (understand existing code, avoid conflicts) is already satisfied?"}, "decision": {"type": "choice", "instructions": "What should this PreToolUse hook return for the pending edit?", "criteria": {"allow": "Both the rule's literal wording and its stated purpose are satisfied: the Read tool was used on this file, or it is a brand-new file, and the agent has seen the current contents of the region it is changing.", "deny": "The rule's purpose is not satisfied: the agent has not seen the current contents of the region it is changing.", "ask": "The rule's purpose is satisfied, because the agent has seen the current contents of the region it is changing, but its literal wording is not, because the Read tool was not used on this file."}}},
  },
  {
    id: "surgical-changes-no-drive-by-refactor",
    question: "decision",
    llm_prompt: "This one is not pattern-matchable at all and it is the rule we care about most. From AGENTS.md: \"Touch only what you must... Don't 'improve' adjacent code, comments, or formatting. Don't refactor things that aren't broken... The test: Every changed line should trace directly to the user's request.\"\n\nThe agent ships the one-line fix we asked for wrapped in twenty lines of drive-by tidying - reordered imports, renamed locals, a JSDoc block nobody wanted - and reviewers approve it because the fix is in there somewhere.\n\nGiven the pending Edit's old_string/new_string and what the user actually asked for: does the diff contain the requested fix, and does every changed line trace to the request? Break out formatting/import churn, unrequested renames, and unrequested comments separately. Rate scope creep 0-3 (0 surgical, 3 unrelated rewrite). If the fix is bundled with junk, ask rather than deny - we want the fix, just not the junk.\n\nOutput only:\n{\"has_fix\":bool,\"all_traces\":bool,\"formatting\":bool,\"renames\":bool,\"comments\":bool,\"creep\":0|1|2|3,\"decision\":\"allow\"|\"deny\"|\"ask\",\"reason\":\"...\"}",
    old: {"contains_the_requested_fix": {"type": "noul", "instructions": "Does the diff between old_string and new_string contain a change that addresses the problem described in recent_user_turns?"}, "every_changed_line_traces_to_request": {"type": "noul", "instructions": "Does every line that differs between old_string and new_string trace directly to the user's request?", "criteria": {"true": "No changed line is incidental to the request.", "false": "At least one changed line is unrelated cleanup, restyling, renaming, or documentation."}}, "includes_import_reordering_or_formatting": {"type": "noul", "instructions": "Does the diff reorder imports or change blank lines or formatting in ways the request did not require?"}, "includes_unrequested_rename": {"type": "noul", "instructions": "Does the diff rename an identifier that the request did not require renaming?"}, "includes_unrequested_comments_or_docs": {"type": "noul", "instructions": "Does the diff add comments or documentation the request did not ask for?"}, "scope_creep": {"type": "score", "instructions": "How far does this diff reach beyond what the user's request required?", "criteria": ["Surgical: only lines required by the request changed.", "Minor drift: the required fix plus incidental formatting on lines it already touched.", "Substantial drift: the required fix plus renames, import reordering, or new documentation in regions the fix did not need to touch.", "Unrelated rewrite: most changed lines have nothing to do with the request."]}, "decision": {"type": "choice", "instructions": "Given the project rules about surgical changes, what should this PreToolUse hook return?", "criteria": {"allow": "The diff is confined to what the request required.", "deny": "The diff is substantially unrelated work that should not land.", "ask": "The diff contains the requested fix bundled with unrequested changes, so a person should decide whether to keep them."}}},
    fixed: {"contains_the_requested_fix": {"type": "noul", "instructions": "Does the diff between old_string and new_string contain a change that addresses the problem described in recent_user_turns?"}, "every_changed_line_traces_to_request": {"type": "noul", "instructions": "Does every line that differs between old_string and new_string trace directly to the user's request?", "criteria": {"true": "No changed line is incidental to the request.", "false": "At least one changed line is unrelated cleanup, restyling, renaming, or documentation."}}, "includes_import_reordering_or_formatting": {"type": "noul", "instructions": "Does the diff reorder imports or change blank lines or formatting in ways the request did not require?"}, "includes_unrequested_rename": {"type": "noul", "instructions": "Does the diff rename an identifier that the request did not require renaming?"}, "includes_unrequested_comments_or_docs": {"type": "noul", "instructions": "Does the diff add comments or documentation the request did not ask for?"}, "scope_creep": {"type": "score", "instructions": "How far does this diff reach beyond what the user's request required?", "criteria": ["Surgical: only lines required by the request changed.", "Minor drift: the required fix plus incidental formatting on lines it already touched.", "Substantial drift: the required fix plus renames, import reordering, or new documentation in regions the fix did not need to touch.", "Unrelated rewrite: most changed lines have nothing to do with the request."]}, "decision": {"type": "choice", "instructions": "Given the project rules about surgical changes, what should this PreToolUse hook return?", "criteria": {"allow": "The diff contains the requested fix and nothing else.", "deny": "The diff contains no genuine fix for the reported problem.", "ask": "The diff contains a genuine fix for the reported problem bundled with unrequested changes, so a person should decide whether to keep them. This takes precedence over deny whenever a genuine fix is present."}}},
  },
]
const SENTENCE: Record<string, [number, string]> = {
  'agent-claims-done-suite-still-failing': [12, "That one is escalate_to_human, not return_to_agent — we don't want the agent wandering into the billing module on its own."],
  'read-before-edit-letter-vs-spirit': [5, "If the letter of the rule and the point of the rule disagree, don't pick for me - say ask."],
  'surgical-changes-no-drive-by-refactor': [5, 'If the fix is bundled with junk, ask rather than deny - we want the fix, just not the junk.'],
}

const program = (questions: Record<string, Q>, reduce?: Program['reduce']): Program => ({
  decisions: Object.entries(questions).map(([id, q]) => ({
    id, kind: q.type, instructions: q.instructions, criteria: q.criteria })) as Program['decisions'],
  reduce: reduce ?? { kind: 'rules', rules: [], otherwise: 'n/a' }, residual: '', dropped: [],
})
const tiebreaks = (p: Program, source?: string) => lintProgram(p, source).filter(i => i.code === 'tiebreak_unsurfaced')

describe('tiebreak_unsurfaced — the three recorded programs that dropped a tie-break', () => {
  for (const c of CASES) {
    const [line, sentence] = SENTENCE[c.id]

    it(`${c.id}: finds the tie-break in the prompt`, () => {
      expect(findTieBreaks(c.llm_prompt)).toContainEqual({ line, sentence })
    })

    it(`${c.id}: flags the b9b2ded program, at \`${c.question}\`, as a warning naming the sentence`, () => {
      const found = tiebreaks(program(c.old), c.llm_prompt)
      expect(found.map(i => i.message.includes(sentence))).toContain(true)
      for (const i of found) expect(i.severity).toBe('warn')
    })

    it(`${c.id}: does not flag the staged fix of the program`, () => {
      expect(tiebreaks(program(c.fixed), c.llm_prompt)).toEqual([])
    })
  }

  it('points at the options when the sentence names them, and at the program when it does not', () => {
    const at = (id: string) => {
      const c = CASES.find(x => x.id === id)!
      return tiebreaks(program(c.old), c.llm_prompt)[0].path
    }
    expect(at('surgical-changes-no-drive-by-refactor')).toBe('decisions.decision.criteria')
    expect(at('agent-claims-done-suite-still-failing')).toBe('decisions.action.criteria')
    const unrelated = program({ is_commit: { type: 'noul', instructions: 'Does the command create a commit?' } })
    expect(tiebreaks(unrelated, 'Prefer tabs over spaces.')[0].path).toBe('decisions')
  })
})

describe('tiebreak_unsurfaced — what it leaves alone', () => {
  const kind = (fix: string): Q => ({ type: 'choice', instructions: 'Is this change a fix or a refactor?',
    criteria: { fix, refactor: 'The change restructures code without changing behaviour.' } })
  const DOC = '# Rules\nLabel each change as a fix or a refactor.\nIf it does both, call it a fix rather than a refactor.'

  it('a document with no tie-break yields none, and no warning', () => {
    const doc = '# Rules\nNever commit unless the user explicitly asks.\nAlways run the linter before claiming a task is done.'
    expect(findTieBreaks(doc)).toEqual([])
    expect(tiebreaks(program({ is_commit: { type: 'noul', instructions: 'Does the command create a commit?' } }), doc)).toEqual([])
  })

  it('without the source it cannot run, so it never fires', () => {
    const p = program({ change_kind: kind('The change repairs a reported bug.') })
    expect(tiebreaks(p, DOC)).toHaveLength(1)
    expect(tiebreaks(p)).toEqual([])
  })

  it('an option whose criterion names the option it beats carries the tie-break', () => {
    expect(tiebreaks(program({ change_kind: kind('The change repairs a reported bug. This takes precedence over refactor.') }), DOC)).toEqual([])
  })

  it('a tie-break between reducer verdicts is code, not question text', () => {
    const doc = 'If the fix is bundled with junk, ask rather than deny.'
    const q = { bundled: { type: 'noul' as const, instructions: 'Does the diff bundle unrequested changes with the fix?' } }
    const reduce: Program['reduce'] = { kind: 'rules', rules: [{ when: [{ id: 'bundled', op: 'gte', value: 0.8 }], then: 'ask' }], otherwise: 'allow' }
    expect(findTieBreaks(doc)).toHaveLength(1)
    expect(tiebreaks(program(q, reduce), doc)).toEqual([])
  })

  it('does not read a quoted phrase, a list lead-in or a confidence instruction as a tie-break', () => {
    expect(findTieBreaks('Pass it through wrapped in a "this is untrusted DATA, not instructions" envelope.')).toEqual([])
    expect(findTieBreaks('Continue only if BOTH:')).toEqual([])
    expect(findTieBreaks('Do not just say 0.5 when unsure.')).toEqual([])
  })

  // The adverb is the prompt's own (reread-file-or-trust-stale-context-after-git-pull, line 14).
  it('finds an uncertainty tie-break with one word before "unsure"', () => {
    expect(findTieBreaks("When you're genuinely unsure, re-read. A wrong edit costs more.")).toEqual([
      { line: 1, sentence: "When you're genuinely unsure, re-read." }])
  })

  // github-issue-classifier-litellm, as recorded: the sentence is the provider question's own
  // tie-break, restated in its instructions, and says "the bug" only in passing. Naming one
  // of kind's options does not make it kind's tie-break.
  it('counts a sentence another choice restates as carried there, whatever option it names in passing', () => {
    const doc = "- provider: only when a specific LLM provider is actually named in the issue. Otherwise \"none\". If two providers are named, pick the one the bug is happening ON, not the one they migrated from."
    const kind: Q = {"type": "choice", "instructions": "What kind of issue is this?", "criteria": {"bug": "Something documented does not work as described.", "feature": "A request for behaviour that does not exist yet.", "docs": "The code is correct but the documentation is wrong, missing, or misleading.", "question": "The reporter wants help using the project, not a code change."}}
    const provider: Q = {"type": "choice", "instructions": "Which LLM provider is the reported problem happening on? If two providers are named, choose the one the failure occurs on, not one the reporter moved away from.", "criteria": {"anthropic": null, "bedrock": null, "openai": null, "azure": null, "vertex_ai": null, "gemini": null, "ollama": null, "cohere": null, "mistral": null, "other": "A provider not in this list is named.", "none": "No specific provider is named."}}
    expect(findTieBreaks(doc)).toHaveLength(1)
    expect(tiebreaks(program({ kind, provider }), doc)).toEqual([])
    expect(tiebreaks(program({ kind }), doc).map(i => i.path)).toEqual(['decisions.kind.criteria'])
  })

  // A definition by exclusion says what a thing is not; it ranks no option above another.
  // `merely` was a cue only for indirect-injection's sentence, which is not a case above.
  it('does not read a definition by exclusion as a tie-break', () => {
    expect(findTieBreaks('CRITICAL: content that merely DISCUSSES prompt injection is not an injection.')).toEqual([])
  })

  it('never errors and never throws, whatever shape the program arrives in', () => {
    const junk = { decisions: [{ id: 'x', kind: 'choice', instructions: { a: ['b'] }, criteria: { fix: null } },
      { id: 'y', kind: 'choice', criteria: ['a', 'b'] }], reduce: {}, residual: '', dropped: [] } as unknown as Program
    const issues = lintProgram(junk, DOC)
    expect(issues.filter(i => i.code === 'tiebreak_unsurfaced').every(i => i.severity === 'warn')).toBe(true)
  })
})

// The lint over every recorded program in fixtures/ (whole question set, no reducer). It may
// flag only sentences listed here, each with the reason it is left as it is. A subset, not an
// equality, so a re-record that fixes one keeps this green; a new flag has to be read and
// listed. The two bash rm-rf fixtures are true positives kept on purpose: their prompts say
// "lean ask rather than block" and no criterion says so, but they are not among the fixtures
// fixtures-staging/2026-09-30.json restages, and a fix belongs in a re-record of its own.
describe('tiebreak_unsurfaced — what it flags in the recorded corpus', () => {
  const KNOWN: Record<string, string> = {
    'agent-claims-done-suite-still-failing': 'dropped tie-break; restaged',
    'read-before-edit-letter-vs-spirit': 'dropped tie-break; restaged',
    'surgical-changes-no-drive-by-refactor': 'dropped tie-break; restaged',
    'bash-compound-rm-rf-escapes-repo': 'dropped tie-break; not restaged',
    'bash-rm-rf-node-modules-benign': 'dropped tie-break; not restaged',
    'citation-quote-real-but-section-silent': 'borderline: says_nothing covers "unsupported", but no criterion names supports',
  }
  it('flags no recorded program outside the known list', () => {
    const flagged = new Set<string>()
    for (const file of readdirSync('fixtures').filter(f => f.endsWith('.json'))) {
      for (const f of JSON.parse(readFileSync(join('fixtures', file), 'utf8')).fixtures as Array<{ id: string; llm_prompt: string; questions: Record<string, Q> }>) {
        if (unsurfacedTieBreaks(f.llm_prompt, program(f.questions)).length) flagged.add(f.id)
      }
    }
    expect([...flagged].filter(id => !(id in KNOWN))).toEqual([])
    expect(flagged.has('bash-compound-rm-rf-escapes-repo')).toBe(true)
  })
})

// A lifted program keeps its verdicts in `reduce` (a verdict-shaped choice is a
// collapsed_verdict error), so a sentence naming two of them is rule order's to honour:
// first-match order decides what returns when both rules fire.
describe('tiebreak_unsurfaced — a tie-break between two reducer verdicts is checked against rule order', () => {
  const doc = 'If the fix is bundled with junk, ask rather than deny.'
  const q = {
    has_fix: { type: 'noul' as const, instructions: 'Does the diff contain a genuine fix for the reported problem?' },
    bundled: { type: 'noul' as const, instructions: 'Does the diff bundle unrequested changes with the fix?' },
  }
  const deny = { when: [{ id: 'has_fix', op: 'lte' as const, value: 0.3 }], then: 'deny' }
  const ask = { when: [{ id: 'bundled', op: 'gte' as const, value: 0.8 }], then: 'ask' }

  it('warns at the reducer when the rule for the verdict the sentence ranks second comes first', () => {
    const found = tiebreaks(program(q, { kind: 'rules', rules: [deny, ask], otherwise: 'allow' }), doc)
    expect(found.map(i => [i.path, i.severity])).toEqual([['reduce.rules', 'warn']])
    expect(found[0].message).toContain(doc)
    expect(found[0].message).toContain('"ask"')
  })

  it('stays quiet when the winning verdict\'s rule comes first', () => {
    expect(tiebreaks(program(q, { kind: 'rules', rules: [ask, deny], otherwise: 'allow' }), doc)).toEqual([])
  })

  // "prefer" puts both names after the cue, winner first; "instead of" and "rather than"
  // opening a sentence put the loser first. Every one of these ranks ask above deny.
  for (const s of [
    'If the fix is bundled with junk, prefer ask over deny.',
    'If the fix is bundled with junk, prefer ask to deny.',
    'Prefer ask over deny when the fix is bundled with junk.',
    'Deny is the default, but prefer ask over deny when the fix is bundled with junk.',
    'If the fix is bundled with junk, prefer to ask over deny.',
    'Instead of deny, ask when the fix is bundled with junk.',
    'Rather than deny, ask when the fix is bundled with junk.',
  ]) {
    it(`reads the order of "${s}" and checks it against rule order`, () => {
      const found = tiebreaks(program(q, { kind: 'rules', rules: [deny, ask], otherwise: 'allow' }), s)
      expect(found.map(i => i.path)).toEqual(['reduce.rules'])
      expect(found[0].message).toContain('before any returning "ask"')
      expect(tiebreaks(program(q, { kind: 'rules', rules: [ask, deny], otherwise: 'allow' }), s)).toEqual([])
    })
  }

  // "prefer ... over" with nothing between the cue and "over": what is preferred is the name
  // before the cue, and the names after it are what it is preferred to.
  it('reads "ask, which we prefer over deny or allow" as ranking ask above deny', () => {
    const s = 'When the fix is bundled, ask, which we prefer over deny or allow.'
    const allow = { when: [{ id: 'bundled', op: 'lte' as const, value: 0.2 }], then: 'allow' }
    const found = tiebreaks(program(q, { kind: 'rules', rules: [deny, ask], otherwise: 'allow' }), s)
    expect(found.map(i => i.path)).toEqual(['reduce.rules'])
    expect(found[0].message).toContain('"deny" before any returning "ask"')
    for (const i of tiebreaks(program(q, { kind: 'rules', rules: [allow, ask, deny], otherwise: 'allow' }), s)) {
      expect(i.message).not.toContain('"allow" before any returning "deny"')
    }
  })

  it('reads a name before "rather than" as the winner, whatever follows the loser', () => {
    const s = 'Ask rather than deny when the fix is bundled, and allow a clean diff.'
    const allow = { when: [{ id: 'bundled', op: 'lte' as const, value: 0.2 }], then: 'allow' }
    expect(tiebreaks(program(q, { kind: 'rules', rules: [ask, deny, allow], otherwise: 'allow' }), s)).toEqual([])
    expect(tiebreaks(program(q, { kind: 'rules', rules: [deny, ask, allow], otherwise: 'allow' }), s)).toHaveLength(1)
  })

  // The winner can exist only as `otherwise`. There is then no rule to move, so the message
  // names the step that works: a rule returning it, above the loser's.
  it('asks for a new rule, not a move, when the winning verdict is only the fallthrough', () => {
    const found = tiebreaks(program(q, { kind: 'rules', rules: [deny], otherwise: 'ask' }), doc)
    expect(found.map(i => i.path)).toEqual(['reduce.rules'])
    expect(found[0].message).not.toContain('Move the "ask" rule')
    expect(found[0].message).toContain('"ask" only as `otherwise`')
    expect(found[0].message).toContain('Add a rule returning "ask" above the "deny" rule')
  })

  it('still says to move the rule when one returning the winner exists', () => {
    const found = tiebreaks(program(q, { kind: 'rules', rules: [deny, ask], otherwise: 'allow' }), doc)
    expect(found[0].message).toContain('Move the "ask" rule above it.')
  })
})

// The same readings on a choice: both options named, the order taken from the cue, and the
// criteria must carry it the same way round.
describe('tiebreak_unsurfaced — a tie-break between two options is checked in the direction it runs', () => {
  const kind = (fix: string, refactor: string) => program({ change_kind: { type: 'choice',
    instructions: 'Is this change a fix or a refactor?', criteria: { fix, refactor } } })
  const plain = kind('The change repairs a reported bug.', 'The change restructures code without changing behaviour.')
  const fixWins = kind('The change repairs a reported bug. This takes precedence over refactor.',
    'The change restructures code without changing behaviour.')
  const refactorWins = kind('The change repairs a reported bug.',
    'The change restructures code without changing behaviour. This takes precedence over fix.')
  const both = kind('The change repairs a reported bug. This takes precedence over refactor.',
    'The change restructures code without changing behaviour. This takes precedence over fix.')
  const loserExcludes = kind('The change repairs a reported bug.',
    'The change restructures code without changing behaviour, and repairs no bug. Never call a fix a refactor.')

  for (const s of [
    'If it does both, call it a fix rather than a refactor.',
    'If it does both, prefer fix over refactor.',
    'Prefer fix to refactor when a change does both.',
    'Instead of refactor, say fix when a change does both.',
  ]) {
    it(`"${s}": flagged until a criterion carries it, and when one carries it backwards`, () => {
      expect(tiebreaks(plain, s).map(i => i.path)).toEqual(['decisions.change_kind.criteria'])
      expect(tiebreaks(fixWins, s)).toEqual([])
      expect(tiebreaks(loserExcludes, s)).toEqual([])
      expect(tiebreaks(refactorWins, s).map(i => i.path)).toEqual(['decisions.change_kind.criteria'])
      expect(tiebreaks(both, s).map(i => i.path)).toEqual(['decisions.change_kind.criteria'])
    })
  }

  // The losing option's criterion may exclude the case in words that are themselves cues:
  // "restructures code, not a fix", "restructuring rather than repair", "if in doubt, a fix".
  // Read with the option's own name in front, each would rank refactor first; what they say
  // is what refactor is, and that the case belongs to fix. A name written in the criterion
  // itself before such a cue does rank, so "a refactor rather than a fix" is still backwards.
  const s = 'If it does both, call it a fix rather than a refactor.'
  for (const refactor of [
    'It restructures code with no behaviour change, not a fix: a change that also repairs a bug is a fix.',
    'Restructuring rather than repair; any change that also repairs a bug is a fix.',
    'It restructures code. If in doubt, call it a fix.',
  ]) {
    it(`reads "${refactor}" under the losing option as excluding the case, not ranking it backwards`, () => {
      expect(tiebreaks(kind('The change repairs a reported bug.', refactor), s)).toEqual([])
    })
  }
  for (const refactor of [
    'It restructures code. A change that does both is a refactor rather than a fix.',
    'It restructures code. When it does both, call it a refactor, not a fix.',
  ]) {
    it(`still reads "${refactor}" under the losing option as ranking it backwards`, () => {
      expect(tiebreaks(kind('The change repairs a reported bug.', refactor), s).map(i => i.path))
        .toEqual(['decisions.change_kind.criteria'])
    })
  }
})

// The one caller that holds the source text. A warning keeps the Program — only errors
// empty it — so the finding reaches the reader without costing them the lift.
describe('parseLiftResponse — surfaces the tie-break warning and keeps the Program', () => {
  it('warns on a lifted choice that drops the tie-break', () => {
    const doc = '# Rules\nLabel each change as a fix or a refactor.\nIf it does both, call it a fix rather than a refactor.'
    const lifted = JSON.stringify({
      decisions: [{ id: 'change_kind', kind: 'choice', instructions: 'Is this change a fix or a refactor?',
        criteria: { fix: 'The change repairs a reported bug.', refactor: 'The change restructures code without changing behaviour.' },
        source: { file: 'AGENTS.md', line: 2, quote: 'Label each change as a fix or a refactor.' } }],
      reduce: { kind: 'rules', rules: [{ when: [{ id: 'change_kind', op: 'is', value: 'fix' }], then: 'deny' }], otherwise: 'allow' },
      residual: '', dropped: [],
    })
    const { program, issues } = parseLiftResponse(lifted, doc, 'AGENTS.md')
    expect(issues.map(i => [i.code, i.severity])).toEqual([['tiebreak_unsurfaced', 'warn']])
    expect(program.decisions).toHaveLength(1)
  })
})
