# A CLAUDE.md rule, enforced — the whole round trip in one project

This directory is a checkout service, written the way real ones are: a `CLAUDE.md`, an
`AGENTS.md`, a release skill. It is both ends of jevc at once. The rules jevc reads are the
ones in this project's own instruction files, and the gate jevc produces is installed back
into this project's `.claude/`, where Claude Code would actually run it.

Run it now, no key, no network:

```bash
cd examples/sample-project
JEVC_REPLAY=1 node .claude/gates/gate.mjs < .claude/gates/payload.sample.json
```

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"CLAUDE.md line 7: commits need an explicit request. The recent turns read as approval of a plan, not a request to commit (0.06). Write the commit message and let the human run it."}}
```

The command in that payload is `git add -A && git commit -m '…'`. The last thing the
human said was **"yeah that reading looks right, go ahead"** — approval of a plan, not a
request to commit. That is how surprise commits actually happen, and it is the case the
gate is here to catch.

## The round trip

Four commands, and the fourth puts the result back where the first one found it. Run them
from this directory: the lift request labels the document by the path you typed, step 3 checks
every citation against that label, and the shipped `commit.json` cites `CLAUDE.md`.

```bash
cd examples/sample-project
jevc scan .                                   # 1. what rules does this project already have?
jevc compile CLAUDE.md --lift                 # 2. hand the printed request to your agent
jevc compile program.json --source CLAUDE.md > /dev/null   # 3. save the agent's Program; check every citation
cp program.json .claude/gates/commit.json     # 4. install it
```

Step 1 reports `CLAUDE.md — 13 rules, 7 decidable`. Step 2 prints a lowering request; no
model runs inside jevc. Step 3 is your agent's answer, checked: a citation that does not
quote `CLAUDE.md` word for word exits 1. Step 4 is the only part that touches this
project — a file copy and a hook registration, both of which you can read.

The files that round trip produced, all of them in this directory:

| File | What it is |
| --- | --- |
| [`CLAUDE.md`](CLAUDE.md) | Where the rule started, as prose. Line 7. |
| [`.claude/gates/commit.json`](.claude/gates/commit.json) | The compiled program — three questions and a reducer, each question carrying the file and line it came from. |
| [`.claude/gates/gate.mjs`](.claude/gates/gate.mjs) | The hook. Builds the state from the transcript, runs the program, writes the decision. |
| [`.claude/settings.json`](.claude/settings.json) | The registration that makes Claude Code call it before every `Bash` tool call. |
| [`.claude/gates/payload.sample.json`](.claude/gates/payload.sample.json) | One recorded `PreToolUse` payload, so the above runs offline. |

`.claude/gates/release.json` is the same trip taken from
[`.claude/skills/release/SKILL.md`](.claude/skills/release/SKILL.md) instead. It is
compiled but deliberately not wired to a hook: releases are gated in CI, not by a tool-call
interceptor, and the repo's README shows it lowered to a bouncer policy instead.

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
  { "when": [{ "id": "user_explicitly_asked_to_commit",    "op": "uncertain" }],         "then": "ask" },
  { "when": [{ "id": "user_explicitly_asked_to_commit",    "op": "gte", "value": 0.5 }], "then": "allow" },
  { "when": [{ "id": "commit_required_by_requested_task",  "op": "gte", "value": 0.5 }], "then": "allow" }
],
"otherwise": "deny"
```

Read it in a pull request, change a threshold and see which cases move, add a case to the
corpus and run it. The judgment that used to live in a paragraph now lives in four lines
of JSON and a number you can point at.

## Where the human is

A closed loop invites the reading that the sentence in `CLAUDE.md` was automatically turned
into the gate. It was not, and the seam is worth finding before you trust one of these.

The questions are evidence; the **reducer is the interpretation**, and a human wrote it. In
this gate the interpretation is visible: the last rule —
`commit_required_by_requested_task` — is **not in the rule text**. `NEVER commit unless the
user explicitly asks.` admits exactly one exception; the last rule adds a second one, for a
commit the requested task genuinely needs. That is a judgment the author made, and it is in
the reducer rather than inside a question precisely so it can be read, argued with and
deleted. Delete it and the gate denies strictly.

The second rule is the other seam, and it points at a person rather than a paragraph. When
the model cannot tell whether the human asked — `user_explicitly_asked_to_commit` inside the
uncertainty band — the gate returns `ask` and the human confirms, instead of either side
guessing. The recorded case measured 0.06, outside the band, so it still denies.

That is the trade the loop actually makes. Before, the same interpretation existed too — in
the model's head, differently each turn, with nothing to point at. After, it is five lines
of JSON in a file under review.

## Install it in your own project

```bash
cp -r examples/sample-project/.claude/gates /path/to/your/project/.claude/
```

Then run `npm install jev-compiler` in that project — the gate imports it, and a global
install is not importable — change the imports in `gate.mjs` from the
relative `dist/` paths to `jev-compiler` (for `JEVC_REPLAY`, change
`HERE('../../../../fixtures')` to `HERE('../../node_modules/jev-compiler/fixtures')`: `HERE`
resolves against the gate file, not the working directory), set `TYPESAFE_API_KEY` in the environment Claude Code runs in, and register the hook —
[`.claude/settings.json`](.claude/settings.json) here is the whole file:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/gates/gate.mjs" }
        ]
      }
    ]
  }
}
```

`matcher` is a regex over tool names — widen it to `Bash|Write|Edit` when your program has
questions about file writes. Your own rules, not this one: start at `jevc scan .`.

## Notes

- `JEVC_REPLAY=1` answers from `fixtures/agent-harness-rules.json` —
  one real call to `jev-1.13.0` recorded on 2026-09-18 — so this directory runs offline.
  It replays that one recorded state; it is a demo of the wiring, not a simulator. Without
  the variable the hook calls the API and needs `TYPESAFE_API_KEY`.
- The gate fails **closed**: any error returns `ask`, so a network blip pauses for a human
  instead of silently waving the commit through. `JEVC_ON_ERROR=allow` inverts that. An answer
  from a Jev build other than `jev-1.13.0`, or from a model `JEVC_ALLOW_MODEL` names, keeps its
  verdict and prints `jev gate: warning: ...` on stderr.
- `JEVC_MODE=observe` lets every `Bash` call through and appends the verdict it would have
  had to `JEVC_OBSERVE_LOG` (default `observe.jsonl` beside the gate), one JSON line per call:
  time, verdict, model, tool name, uncertain ids, the model's answers and any warnings — never the command,
  the transcript or anything from the environment. A row with a non-null `error` is the
  fail-closed fallback, not the model's verdict: leave those out when tuning thresholds. A log
  that cannot be written is reported on stderr and the call still goes through. The default
  path is inside `.claude/gates/`, which you commit, so add `observe.jsonl` to `.gitignore`.
  Run it for a while before trusting the thresholds.
- Non-`Bash` tool calls exit 0 immediately. A question about a tool the rule cannot apply
  to spends a call to learn nothing.
- The hook returns `deny` rather than exiting 2. Both stop the tool call; the JSON form
  also carries a reason the agent can read, which is the difference between the agent
  writing the commit message for the human and the agent trying a different shell quoting.
- Claude Code reads `.claude/settings.json` from the project root it was opened in, so the
  one here applies to this directory and not to the jevc repository around it.
