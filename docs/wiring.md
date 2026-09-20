# Wiring the output in

You have a compiled program. This page is one recipe per place you might put it, with the
code that actually runs.

Pick by where the decision happens:

| Where the decision happens | Recipe |
| --- | --- |
| Claude Code stops a tool call | [PreToolUse hook](#claude-code-pretooluse-hook) |
| Claude Code runs the compiler for you | [Skill and slash command](#claude-code-skill-and-slash-command) |
| Your own TypeScript agent loop | [sdk target](#your-own-typescript-agent-loop) |
| A Vercel AI SDK app | [ai-sdk target](#vercel-ai-sdk) |
| A Python agent — LangChain, LangGraph, your own | [langchain target](#python-agents) or [subprocess a gate](#any-python-agent-that-can-call-a-tool) |
| A gateway you do not control the source of | [bouncer](#bouncer) or [toolgate](#toolgate) |
| Anything that can POST | [json target](#anything-that-can-post) |

---

## Claude Code PreToolUse hook

The whole thing is installed in
[`examples/sample-project/`](../examples/sample-project/) — the project whose `CLAUDE.md`
the rule was lifted out of in the first place. A runnable `.claude/gates/gate.mjs`, its
`commit.json`, a sample payload, and the `.claude/settings.json` that registers it. Run it
offline:

```bash
cd examples/sample-project
JEVC_REPLAY=1 node .claude/gates/gate.mjs < .claude/gates/payload.sample.json
```

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"CLAUDE.md line 7: commits need an explicit request. …"}}
```

Register it in `.claude/settings.json`:

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

The contract, in three lines: the hook reads a JSON object on stdin carrying `tool_name`,
`tool_input`, `cwd`, `session_id` and `transcript_path`; it writes a
`hookSpecificOutput` object on stdout with `permissionDecision` set to `allow`, `deny` or
`ask`; and exit 0 with no output means "no opinion, carry on".

Two things decide whether this gate is any good, and neither is the model:

- **Build the state from the transcript, not just the tool call.** The commit rule turns
  entirely on what the human said, so `gate.mjs` reads the last few user turns out of
  `transcript_path`. A gate that sees only `tool_input` cannot answer the question it
  exists to answer.
- **Fail closed.** `gate.mjs` returns `ask` on any error. A gate that vanishes when the
  network does is not a gate.

## Claude Code skill and slash command

Let the agent you already have open do the compiling. Save as
`.claude/commands/jev.md` — Claude Code commands are markdown files, and the body is the
prompt:

```markdown
---
description: Turn this repo's written rules into typed Jev questions
---

Run `jevc scan .` and show me the table.

Then, for the file with the most decidable rules, run `jevc compile <that file> --lift`
and answer the request it prints. Every decision you return must carry a `source` with a
verbatim `quote` from the file — jevc rejects the whole response if a citation does not
check out, so do not paraphrase.

Save the result to `program.json` and run `jevc compile program.json --emit sdk -o gate.ts`.

Then tell me three things: which rules became questions, which stayed in the prompt
because they are procedure or generation, and which reducer thresholds you guessed at —
those are the ones I need to look at.
```

The lift step produces a hypothesis. Those thresholds are guesses until something measures
them.

## Your own TypeScript agent loop

```bash
jevc compile rules.json --emit sdk -o gate.ts
```

The emitted module exports `program`, `programQuestions` and `reduce`. Wire it wherever
the tool call is dispatched:

```ts
import { evaluate } from 'jevc'
import { program } from './gate.js'

async function callTool(name: string, input: unknown, context: AgentContext) {
  const { verdict, answers } = await evaluate(program, {
    tool_name: name,
    tool_input: input,
    recent_user_turns: context.userTurns.slice(-4),
  })
  if (verdict === 'deny') return { error: `Blocked by policy: ${explain(answers)}` }
  if (verdict === 'ask') return await context.askHuman(explain(answers))
  return await dispatch(name, input)
}
```

`evaluate` throws on a bad response rather than returning a verdict you cannot trust. If
you would rather handle that yourself, call `askModel` and run `runReducer` on what comes
back — it returns an issue list instead of throwing.

## Vercel AI SDK

```bash
jevc compile triage.json --emit ai-sdk -o triage-jev.ts
```

```ts
import { experimental_evaluate } from 'ai'   // verified present in ai@7.0.107
import { model, programQuestions, reduce, confidenceOf } from './triage-jev'

const result  = await experimental_evaluate({ model, state, questions: programQuestions })
const verdict = reduce(result.answers, confidenceOf(result))
```

`reduce` here takes **two** arguments and the second is not optional — see
[Notes](#notes).

## Python agents

```bash
jevc compile triage.json --emit langchain -o triage_jev.py
```

The emitted module builds the classifier and the reducer for you:

```python
from triage_jev import classifier, reduce

response = classifier.invoke(state)     # a Runnable: state goes in at the root
verdict  = reduce(response.answers)

if verdict == "deny":
    return "Blocked by policy."
```

`state` is the input itself, not wrapped — a string, a `BaseMessage`, a sequence or a
dict, at any depth. `response.answers` is the flat `{id: Answer}` mapping; the
`nouls` / `choices` / `scores` properties are filtered views of the same storage, useful
when you want the narrower static type.

`api_key` and `base_url` come from the environment — `TypeSafeClassifier` sets
`extra="forbid"`, so a stray keyword argument is a hard error rather than a silently
ignored one.

## Any Python agent that can call a tool

If your harness is not LangChain — a LangGraph node, a plain loop, an agent you run in a
container and would rather not rebuild — run the gate as a subprocess and let the exit code
speak. This is the recipe for any agent in any language that can shell out:

```python
import json, subprocess

def guarded(tool_name: str, tool_input: dict, user_turns: list[str]) -> str | None:
    """Returns None to proceed, or a refusal string to hand back to the model."""
    payload = json.dumps({
        "tool_name": tool_name, "tool_input": tool_input,
        "recent_user_turns": user_turns[-4:],
    })
    gate = subprocess.run(["node", "gates/gate.mjs"], input=payload,
                          capture_output=True, text=True, timeout=10)
    if gate.returncode != 0:
        return "Blocked: policy gate unavailable."      # fail closed
    out = json.loads(gate.stdout or "{}").get("hookSpecificOutput")
    if out and out["permissionDecision"] in ("deny", "ask"):
        return f"Blocked by policy: {out['permissionDecisionReason']}"
    return None
```

This is the same `gate.mjs` from the Claude Code recipe, unchanged. The hook payload
shape is a perfectly good internal protocol, and reusing it means one gate file per rule
rather than one per harness.

## bouncer

For a gateway whose source you do not own but whose policy file you do:

```bash
jevc emit-policy --for bouncer program.json -o bouncer.policy.yaml
```

You get questions, one-condition rules, thresholds, and provenance comments naming the
file and line each rule came from. It ships in `mode: observe` — it logs and gates
nothing until you run `bouncer calibrate` against your own traffic and move it to guard.

## toolgate

```bash
jevc emit-policy --for toolgate program.json -o toolgate.yaml
```

toolgate can express exactly one reducer shape: max over questions, two scalar
thresholds. If your program is that shape you get a policy. If it is not, you get a
refusal naming every reason, not just the first:

```console
Cannot emit a toolgate policy:
  reduce.rules: questions outside_repo have no deny rule, but max-over-questions applies
  the deny threshold to them anyway.
```

Exit code 1. The same `program.json` emits a bouncer policy without complaint — it is the
target that cannot carry the rule, not the rule that is wrong.

## Anything that can POST

```bash
jevc compile triage.json --emit json
```

```json
{
  "model": "jev-latest",
  "state": "<state>",
  "questions": {
    "is_urgent": { "type": "noul", "instructions": "Does this ticket describe an outage or data loss happening right now?" },
    "department": { "type": "choice", "instructions": "Which team owns the resolution?",
                    "criteria": { "billing": null, "security": null, "shipping": null, "other": null } }
  }
}
```

Substitute `state`, `POST` it to `https://api.typesafe.ai/v1/systemone` with your key, and
implement the reducer in whatever language you are in. The reducer is a handful of
comparisons; that is the point of computing it yourself.

---

## Notes

- **`bouncer` and `toolgate` are reached only through `emit-policy --for`, never through
  `--emit`.** They are policy documents, not modules, and the separate verb keeps a
  target that can silently drop half your rules out of the flag that normally cannot.
- **A policy target that cannot express your reducer refuses.** A bouncer policy that fails to parse does not degrade the gate — it stops
  policy resolution entirely and routes to `on_error`, whose default `passthrough` emits
  nothing. An unchecked emit would replace a working gate with a silent one, at exit 0.
- **Unanswered questions throw in all four code targets** (`No answer for decision
  "<id>"`). This changed in 0.1.0: `ai-sdk` and `langchain` used to return `allow` where
  `sdk` threw, and the disagreeing pair was the pair that failed open on a deny rule. The
  policy targets cannot throw — bouncer skips the rule and falls through to `default`,
  toolgate takes `max` over whatever did answer, with `fail_mode` covering an empty
  backend. Both are recorded in [`docs/targets/`](targets/).
- **`score` answers come back in level-index space** (3 levels → 0.0..2.0), which is the
  most common integration bug. A threshold written for 0..1 either never fires or always
  does.
- **A `noul` carries no confidence field.** Its probability is the answer, so its
  uncertainty rule is a band around the middle — `[0.35, 0.65]` by default — and
  `belowConfidence` on a noul is rejected.
- The emitted `ai-sdk` backend reads `TYPESAFE_AI_API_KEY ?? TYPESAFE_API_KEY`; the
  emitted `langchain` backend passes no key at all and lets its own package read the
  environment. Nothing jevc generates hard-codes a key.
- **The `ai-sdk` reducer's second argument is required on purpose.** That backend returns
  confidence in `providerMetadata`, where it can be absent; `confidenceOf` pulls it out and
  drops non-numbers rather than coercing them, because absence must never read as zero.
  Defaulting the parameter silently evaluated every confidence rule against the
  top-minus-runner-up margin instead, and those are different statistics — on the recorded
  verdict answer `{allow 0.42, block 0.35, ask 0.23}` the margin is 0.07 and the reported
  confidence is 0.13, opposite sides of a 0.10 threshold.
