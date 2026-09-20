# A CLAUDE.md rule, enforced

One rule — `NEVER commit unless the user explicitly asks.` — as a Claude Code
`PreToolUse` hook that actually stops the commit.

Run it now, no key, no network:

```bash
JEVC_REPLAY=1 node gate.mjs < payload.sample.json
```

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"CLAUDE.md line 7: commits need an explicit request. The recent turns read as approval of a plan, not a request to commit (0.06). Write the commit message and let the human run it."}}
```

The command in that payload is `git add -A && git commit -m '…'`. The last thing the
human said was **"yeah that reading looks right, go ahead"** — approval of a plan, not a
request to commit. That is how surprise commits actually happen, and it is the case the
gate is here to catch.

## Before and after

**Before.** The rule lives in `CLAUDE.md` and the model re-reads it every turn alongside
everything else in the file. It usually holds. When it does not, there is nothing to
inspect: no record of which part of the rule was weighed, no way to write a test, and the
only fix available is to make the sentence louder — `NEVER`, then `**NEVER**`, then a
paragraph explaining why. Teams who escalate to a second LLM call ("you are a policy
checker, return JSON") trade one unreviewable judgment for another, and now pay for it.

**After.** Three narrow questions, and a verdict computed in ordinary code:

| Question | Measured |
| --- | --- |
| `is_commit_operation` | 0.96 |
| `user_explicitly_asked_to_commit` | **0.06** |
| `commit_required_by_requested_task` | 0.16 |

```json
"rules": [
  { "when": [{ "id": "is_commit_operation",                "op": "lte", "value": 0.5 }], "then": "allow" },
  { "when": [{ "id": "user_explicitly_asked_to_commit",    "op": "gte", "value": 0.5 }], "then": "allow" },
  { "when": [{ "id": "commit_required_by_requested_task",  "op": "gte", "value": 0.5 }], "then": "allow" }
],
"otherwise": "deny"
```

Read it in a pull request, change a threshold and see which cases move, add a case to the
corpus and run it. The judgment that used to live in a paragraph now lives in three lines
of JSON and a number you can point at.

## Install it

`.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node $CLAUDE_PROJECT_DIR/.claude/gates/gate.mjs" }
        ]
      }
    ]
  }
}
```

Copy `gate.mjs` and `program.json` to `.claude/gates/`, change the import from
`../../dist/index.js` to `jevc`, and set `TYPESAFE_API_KEY` in the environment Claude Code
runs in. `matcher` is a regex over tool names — widen it to `Bash|Write|Edit` when your
program has questions about file writes.

## Make your own

```bash
jevc scan .                                   # which of your rules can become questions
jevc compile CLAUDE.md --lift                 # hand the printed request to your agent
jevc compile program.json --emit sdk -o gate-program.ts   # or keep the JSON, as here
```

Then edit the `reduce` block — it decides the verdict; the questions are only evidence.

## Notes

- `JEVC_REPLAY=1` answers from `fixtures/agent-harness-rules.json` —
  one real call to `jev-1.13.0` recorded on 2026-09-18 — so this directory runs offline.
  It replays that one recorded state; it is a demo of the wiring, not a simulator. Without
  the variable the hook calls the API and needs `TYPESAFE_API_KEY`.
- The gate fails **closed**: any error returns `ask`, so a network blip pauses for a human
  instead of silently waving the commit through. `JEVC_ON_ERROR=allow` inverts that.
- Non-`Bash` tool calls exit 0 immediately. A question about a tool the rule cannot apply
  to spends a call to learn nothing.
- The hook returns `deny` rather than exiting 2. Both stop the tool call; the JSON form
  also carries a reason the agent can read, which is the difference between the agent
  writing the commit message for the human and the agent trying a different shell quoting.
- The third rule — `commit_required_by_requested_task` — is **not** in the rule text. The
  rule is `NEVER commit unless the user explicitly asks.` and it admits exactly one
  exception; the third rule adds a second one, for a commit the requested task genuinely
  needs. That is an interpretation the author made, not a lowering of the sentence, and it
  is in the reducer rather than inside a question precisely so it can be read, argued with
  and deleted. Delete it and the gate denies strictly.
