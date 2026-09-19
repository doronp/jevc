# jevc

**A transpiler from natural-language LLM instructions to typed Jev decisions.**

A JSON Schema, an `AGENTS.md` rule, a system prompt — `jevc` lowers it into a *Jev
program*: a set of narrow typed questions answered by TypeSafe's System One model
(`jev-1.13.0`), plus a reducer that computes the verdict in ordinary code. What used to
be an LLM judgment becomes a deterministic, typed, auditable one.

A rule written in markdown is a suggestion. The same rule expressed as a typed question
against a System One model is an invariant that answers in well under a second and
cannot produce a schema error.

---

## The before and after

This rule is in thousands of `CLAUDE.md` files, and agents still break it:

```markdown
NEVER commit unless the user explicitly asks.
```

Enforcing it today means a second LLM call carrying 1,089 characters of instructions,
four judgments held in one head, a hand-parsed JSON envelope, and no way to tell which
judgment moved when the hook misfires. (That prompt is real — it is
`fixtures/agent-harness-rules.json`, `commit-only-when-explicitly-asked`.)

Compiled, it is four typed questions and a reducer. Measured on the fixture's state — a
user who said *"yeah that reading looks right, go ahead"* and an agent that decided to
commit:

```
is_commit_operation                 0.96
user_explicitly_asked_to_commit     0.06     <- a bare approval is not consent
commit_required_by_requested_task   0.16

verdict, computed in code:          deny
latency:                            731 ms
```

The carve-out ("a commit that a requested PR requires is fine") is an allowlist, so it
lives in the reducer, in code, where it can be read and tested. Run it:
`npx tsx examples/02-agents-md-guardrail.ts`.

---

## What compiles, and the honest limit

A natural-language prompt braids three different things together:

| Part | Example | Compiles? |
| --- | --- | --- |
| **Decision** | "is this command dangerous?", "which team owns this?" | **yes** |
| **Generation** | "write a summary", "explain your reasoning" | **never** — Jev emits no text |
| **Procedure** | "read the file before editing it" | **no** — that is control flow; it belongs in code |

A transpiler that claims to turn a prompt into an equivalent Jev prompt is lying. `jevc`
**separates** them. Every compilation emits three artifacts:

1. **the decision set** — real Jev questions, with thresholds and actions
2. **the residual prompt** — what genuinely still needs a generative model, now smaller
3. **the wiring** — code that evaluates (1) and calls the LLM only for (2)

`program.residual` is a first-class output, not a failure mode. A compilation that
produces an empty decision set is a valid answer: this prompt had no System One content,
and `jevc` says so instead of inventing questions.

---

## The decomposition law

This is the most useful thing in the repo, and it constrains every code path.

**Jev answers narrow evidence questions decisively and collapsed verdict questions
near-randomly.** All five numbers below come from **one** recorded call evaluating
`rm -rf node_modules` (`fixtures/security-guardrails.json`,
`bash-rm-rf-node-modules-benign`, jev-1.13.0, 720 ms):

| Question in that call | Answer | Confidence |
| --- | --- | --- |
| `decision` — allow/ask/block, the collapsed verdict | allow 0.42 / block 0.35 / ask 0.23 | **0.13** |
| `blast_radius` — score, 4 levels | 1.02 ("only regenerable artifacts") | **0.97** |
| `only_regenerable_artifacts` — noul | 0.93 | — (a noul has none) |

The decomposed heads are right and certain. The verdict head is a coin flip that would
have blocked a routine clean reinstall about a third of the time — and a guard that
blocks `rm -rf node_modules` is not a guard, it is an outage.

The same shape shows up where it costs money rather than uptime. In
`tier-router-ambiguous-scope-error-handling`, the collapsed "which model tier?" question
answered **fast at confidence 0.24** for a file that emits the billing webhook, while the
evidence questions in the same call said `request_scope_ambiguous` 0.79 and
`touches_irreversible_surface` 0.76. Reading the argmax ships a silent downgrade; reducing
the evidence in code routes it up. (`npx tsx examples/03-model-router.ts`.)

**Be precise about the claim.** Collapse is not a property of verdict words, it is what
happens when a collapsed question meets a genuinely borderline input. Across the whole
corpus, the 19 verdict-shaped choice heads — option sets that trip the same
`VERDICT_WORDS` test the linter uses — have a median confidence of 0.93, close to the
0.97 median of the other 46 choice heads. The separation is in the tail, not the middle:
the three least confident verdict heads are 0.13, 0.31 and 0.36, each on a genuinely
borderline input — precisely the case a gate exists for.

And the tail is not exclusively theirs. Two non-verdict heads sit in it too. The router's
`tier` head measured 0.24, and it is a collapsed verdict in everything but vocabulary —
the `VERDICT_WORDS` test is a heuristic and `powerful`/`fast`/`balanced` are not in it.
The other is honest uncertainty rather than collapse: in
`agent-command-referent-disambiguation` the four-way "which of `candidate_ids` does
*that* refer to?" head measured 0.23, because the command genuinely was ambiguous. The
decomposed noul in the same call said so plainly — `referent_is_ambiguous` 0.68 — which
is the shape a program should branch on, and why `uncertain` is part of the IR.

Three rules follow, all enforced by `lintProgram`:

1. **Never emit a collapsed verdict question.** Emit evidence; compute the verdict in code.
   This one is a hard error.
2. **Never emit two questions where one's answer determines the other's.** Questions in a
   batch are scored independently with no consistency enforced — one measured response
   asserted `rule_conflict = documented_exception_wins` (p 0.52, confidence 0.37) and
   `decision = deny` (confidence 0.73) in the same call.
3. **Never emit a question spanning two scopes.** A compound authorization question
   measured 0.59 — the wrong side of 0.5 — on a command whose deletions were partly
   authorized, because it anchored on the authorized half.

Carve-outs ("except `rm -rf node_modules`") are allowlists and belong in `reduce`.
Declared glob and deny patterns matched semantics at 0.25 / 0.10 / 0.14 across three tool
families, while the semantic question on the same input answered 0.96 / 0.87 / 0.85. Keep
pattern matching in code; ask Jev only what a pattern cannot express.

---

## Quick start

```bash
npm install          # Node >= 22
npm run build
export TYPESAFE_API_KEY=...   # only needed to call the API; not for any command below
```

Compile a schema:

```console
$ npx jevc compile triage.json
// Generated by jevc. Review the questions and thresholds — they are the
// part humans must check. Regenerate with: jevc compile
import type { JevAnswer, Program } from 'jevc'
import { value, isUncertain, choiceOf } from 'jevc'

export const programQuestions = {
  is_urgent: { type: 'noul', instructions: "Does the message convey time pressure?" },
  department: { type: 'choice', instructions: "Which team should handle this?", criteria: { billing: null, technical: null, sales: null } as const },
} as const
...
/** The verdict is computed here, in code — never asked of the model. */
export function reduce(a: Record<string, JevAnswer>): string {
  return "review"
}
```

with the part that cannot compile reported on stderr rather than invented:

```console
residual:
The following still require a generative model:
- reply: Draft a reply to the customer. (text generation — Jev emits no strings)
dropped: "frustration" is 1..5, but a score answer is a level index 0..4: every threshold written in the schema's numbers would fire 1 level(s) early, and neither the level labels nor validateProgram record the offset. Re-base it to 0..4 — the one range where the two spaces coincide — or bucket it into described levels.
```

Compile prose. `jevc` ships the lift *protocol*, not a second model: `--lift` prints a
request for the agent you are already talking to (Claude Code, Codex, Cursor), which
returns candidate decisions as JSON. No second API key, no second bill.

```console
$ npx jevc compile AGENTS.md --lift
Lower the natural-language rules below into a jevc Program (JSON only, no prose).
...
1. [HARD ERROR — rejected outright] NEVER emit a question that asks for a verdict
   (allow/ask/deny/block/approve/reject). Measured: a collapsed verdict question
   returned allow 0.42 / block 0.35 / ask 0.23 at confidence 0.13, while narrow
   evidence questions on the SAME input reached 0.93-0.97. ...
```

The agent's answer is a **hypothesis until measured**: `parseLiftResponse` puts it through
the same validator the deterministic path uses, and checks all three fields of every
decision's `source`, not just the quote.

- `quote` must appear verbatim in the lifted document — whitespace is normalised, so a
  re-wrap is fine — and be at least **12 characters**. A shorter fragment proves nothing
  even when it does occur: 328 of the 676 two-letter pairs appear in this README, and
  phrases taken from an unrelated instruction file turn up in it anyway 90% of the time at
  ≤3 characters, 9% at 10-11, and 1.8% by 17-20. Real rule sentences run a median of 50
  characters; the sub-12 units in real instruction files are headings and code fences.
- `file` must be the one document that was lifted. A name that was never supplied cannot be
  checked, and the `// from <file>:<line>` comment the emitter writes would send a reviewer
  somewhere unrelated.
- `line` must be a line of that document, and one the quote actually spans. Outside the file
  it is invented, and an error; inside the file but off the quote it is a repairable
  mis-citation, so it warns and names the right line.

The document itself is fenced with a run of dashes long enough not to occur in it, because
an instruction file can contain the delimiter — by accident or on purpose — and two
terminators in one prompt is how text after the fake one gets read as instructions.

---

## The CLI

Four commands. Output below is real, from this repo.

| Command | Flags | Does |
| --- | --- | --- |
| `jevc compile <file\|->` | `--lift`, `--emit sdk\|json`, `-o <path>` | JSON Schema → TypeScript (`sdk`, default) or a wire request (`json`); `--lift` prints the lift request for prose. `-` reads stdin. |
| `jevc check` | `--live`, `--fixtures <dir>` | Replays the measured corpus offline; `--live` re-measures against the API and reports drift, one fixture at a time — a fixture that cannot be measured is one `broken` row, not a dead report. |
| `jevc explain <decision-id>` | `--fixtures <dir>` | Why does this question exist — its provenance, the prompt it replaced, and what it measured. |
| `jevc emit-policy --for <bouncer\|toolgate>` | `<program.json>`, `-o <path>` | Lowers a compiled program into an incumbent guardrail's own config format, after the same `validateProgram` + `lintProgram` gate `compile` runs. |

```console
$ npx jevc check
60 fixtures, 60 passing, 0 failing
```

```console
$ npx jevc check --live
check --live requires TYPESAFE_API_KEY in the environment.
```

`--live` is the only command that touches the network, and it refuses before reaching it
if there is no key. `jev-latest` is an alias that moves under you, so a TypeSafe model bump
should surface as a diff in a drift report rather than as a production incident.

A drift row compares **both** numbers a `choice` or `score` answer carries, and renders them
as `value@confidence`: a winner that holds while its confidence falls 0.95 → 0.15 is drift,
not stability. A `noul` keeps the single comparison, having no confidence field. Each
fixture's own `expect` bands are then re-checked against the live answers — a band that no
longer holds is `broken`, not `drifted`, because offline `jevc check` already exits 1 on the
same predicate against the recorded answers and the two commands must not disagree about the
same corpus.

```console
$ npx jevc explain user_explicitly_asked_to_commit
user_explicitly_asked_to_commit  (agent-harness-rules/commit-only-when-explicitly-asked)
  type:         noul
  instructions: Looking only at recent_user_turns, did the human explicitly ask for a commit to be created?
  provenance:   Claude Code permissions docs ship this exact split as their worked example: ...
  measured:     {"type":"noul","noul":0.06}
  replaces:     You are a policy checker running inside our Claude Code PreToolUse hook. We keep getting surprise commits from the agent...
```

`emit-policy` reads a `Program` as JSON — the shape `--lift` asks the agent to produce:

```console
$ npx jevc emit-policy --for bouncer program.json
# Generated by jevc from natural-language rules.
# Review the questions and thresholds — they are the part humans must check.
# Ships in observe mode: it logs and emits nothing. Run `bouncer calibrate`
# against your own traffic before moving to guard.
#
# State is built by bouncer, not by jevc: word instructions against its fixed
# vocabulary (tool, action.kind, inside_project, outside_location, sensitive).
#
# deletes_tracked_files: AGENTS.md:3 — Never delete tracked files.
# outside_repo: AGENTS.md:3 — Stay inside the repo root.

version: 1
backend: jev
mode: observe
timeout_ms: 800
on_error: passthrough
gate:
  tools:
    - Bash
    - Edit
    - Write
    - NotebookEdit
  questions:
    deletes_tracked_files:
      instructions: Does the command delete files tracked by git?
    outside_repo:
      instructions: Does it touch paths outside the repo root?
  rules:
    - when:
        deletes_tracked_files:
          p: ">=0.8"
      then: deny
    - when:
        outside_repo:
          p: ">=0.6"
      then: ask
    - default: allow
```

---

## What compiles from a schema, and what does not

`fromJsonSchema` is pure and property-tested — no model, no network. Zod, Anthropic tool
`input_schema`, OpenAI strict `json_schema` and MCP `inputSchema` all normalize to JSON
Schema first, so there is one mapper.

| Schema construct | Maps to | Note |
| --- | --- | --- |
| `boolean` | `noul` | `description` becomes the instructions |
| `string` + `enum` | `choice` | enum members become criteria keys |
| `oneOf`/`anyOf` of `const` | `choice` | a const union is an enum |
| `allOf` | merged, then mapped | members compose into one effective schema, which is what a `$ref` plus local overrides becomes once resolved |
| `anyOf`/`oneOf` of `[X, null]`, or `type: ["X", "null"]` | mapped as `X` | the Pydantic v2 and OpenAI strict spelling of an optional field; a union of two *decidable* branches names no single decision and stays **dropped** |
| `integer` + `minimum: 0`/`maximum`, span 2..10 | `score` | one level per value, labelled `field = i` — `i` is both the schema's value and the answer's level index. Those labels carry no meaning: describe each level concretely before shipping, because an undescribed level destroys the distribution. Nothing enforces that today |
| `integer` + `minimum` other than `0`, span 2..10 | **dropped** | a score answer is a level index `0..n-1`, so a threshold written in the schema's numbers fires `minimum` levels early and nothing in the `Program` records the offset; re-base the range, or bucket it into described levels |
| `array` of `enum` | **one `noul` per member** (`field.member`) | several labels may apply at once |
| nested `object` | recurse; ids flattened dotted (`a.b`) | the questions map is flat |
| `string` (free) | **residual** | text generation |
| `array` of `object` | **residual** | unbounded extraction |
| `number` (any) | **dropped** | a continuous range has no discrete-level equivalent; bucket it, or model a 0..1 probability as a noul |
| `integer` spanning > 10 values | **dropped** | a score takes at most 10 levels |
| `null` | **dropped** | no decision to make |
| `const` | ignored | no decision to make |

`required` and `default` are ignored: Jev answers every question in the map, always.

A two-member enum whose values are yes/no-shaped *could* collapse to a `noul`. That
heuristic is **off by default** (`collapseBooleanEnums`) — silently changing a declared
output's shape is exactly the class of surprise this project exists to remove.

---

## The validator earns its keep

The API returns **200 OK** for each of these, with an answer that is wrong or meaningless.
Measured by 25 live probe requests against `jev-1.13.0` on 2026-09-18; every row is pinned
by `test/contract.test.ts` and refused locally by `validateRequest` or `validateProgram`.

| Probe | API result | Consequence | Caught by |
| --- | --- | --- | --- |
| `score` with 1 level | 200 — `score: 0.0, confidence: 1.0` | the documented 2-level minimum is not enforced server-side; you get a meaningless constant | `score_too_few_levels` |
| `choice` with 1 option | 200 — `confidence: 1.0` | degenerate certainty; always "right" | `choice_too_few_options` |
| duplicate question id | 200 — last definition silently wins | a JSON object cannot hold duplicate keys, so one question vanishes before it is sent | `duplicate_id`, in the IR |
| unknown field (`temperature`, `weight`) | 200 — silently ignored | a typo like `criterion` never errors; emitted keys must be whitelisted | `unknown_field` |
| nonexistent `` `backtick.path` `` | 200 — answered from the whole state | a typo'd path never errors, it silently degrades | `path_unresolved` — an **error** against a structured state, where the path is provably absent; a **warning** against a string state, where backticks are ordinary prose markup (`` `sys.exit` `` in a question about a source file) and no path can resolve |
| empty `state: ""` | 200 | the model answers from no evidence | `state_empty` |

Two more the wire types pin: `score` answers come back in **level-index space** (3 levels
→ 0.0..2.0, 10 levels → 0.0..9.0), which is the most likely integration bug — a team's
habitual 0..1 threshold either never fires or always does. And a `noul` carries **no
confidence field**; its probability *is* the answer, so its uncertainty rule is a band
around the middle (default `[0.35, 0.65]`), and `validateProgram` rejects
`belowConfidence` on a noul rather than ignoring it.

`Program` is obtained from untrusted JSON by a cast in three places, so both closed
vocabularies a cast cannot enforce are checked too: a `kind` outside noul/choice/score (which
`toQuestion` would ship as a *choice*), and a condition `op` outside gte/lte/is/uncertain
(which `runReducer` and every emitter would execute as `lte` — the inverse of the rule, at
exit 0). `evaluate()` runs `validateProgram` before it spends a call, which it did not
before: a duplicate decision id used to collapse into one question inside `emitJson` before
the wire validator could count it, and the verdict came back computed from an answer to a
question the program did not contain.

The response crosses the same boundary in the other direction, and used to be a bare
`res.answers as Record<string, JevAnswer>`. `validateResponse(program, res)` checks it
against the program that asked: every declared decision answered, answered as the kind it was
asked as, numbers that are numbers and in range, and a `choice` that picked a declared
option. Score answers are *not* required to be integers — 23 of the 26 measured score answers
in `fixtures/` are fractional, because the answer is the probability-weighted expectation over
the level indices. `evaluate()` throws rather than reduce a response it cannot read;
`askModel()` returns the identical issue list instead of throwing, which is how
`check --live` reports a dropped answer rather than dying on it.

Budget: 64,000 tokens per request, 32,000 for state plus the longest single question,
estimated at the measured ratio of 5.1 characters per token. Choice takes 2..255 options
(reliability degrades above ~240); score takes 2..10 levels.

---

## Emit targets: a capability model, not a syntax adapter

Targets differ in what they can **express**. `canEmit(program, target)` refuses rather than
silently dropping what a target cannot carry — the authoritative table is
`src/emit/capability.ts`:

| Target | kinds | reducer | thresholds | verdicts | confidence | legend |
| --- | --- | --- | --- | --- | --- | --- |
| `sdk` | noul, choice, score | code | — | any | yes | yes |
| `json` | noul, choice, score | code | — | any | yes | yes |
| `langchain` | noul, choice, score | code | — | any | yes | yes |
| `ai-sdk` | noul, choice, score | code | — | any | **providerMetadata, may be absent** | **dropped** |
| `bouncer` | **noul only** | **one question per rule** | **0..1, plain decimal** | **allow/ask/deny** | no | no |
| `toolgate` | **noul only** | **max over questions, two scalars** | **0..1, plain decimal** | **deny/ask** | no | no |

Neither policy target takes a multi-condition rule. `when: [a, b]` is a **conjunction** —
`runReducer` evaluates `rule.when.every(...)` — while toolgate's `max(probability) >=
threshold` is a **disjunction**, so lowering one into the other inverts the rule: at
`a = 0.9, b = 0.1` the Program says allow and the policy would say deny.

Verdict words are checked too, because they are strings in the IR and a fixed vocabulary
in the target. A bouncer policy that fails to parse does not degrade the gate, it **stops
policy resolution** and routes to `on_error`, whose default `passthrough` emits nothing —
so an unchecked `then: quarantine` would replace a working gate with a silent one at exit
0. `canEmit` returns `verdict_unsupported` instead.

Two independent threshold checks, because they catch different failures:

- **`thresholdRange`** — a score threshold lives in level-index space (`1.5` of `0..2`),
  which cannot be expressed by a target whose thresholds are 0..1 probabilities.
- **`thresholdPattern`** — applied to the *serialised* threshold, because that is what the
  consumer parses. bouncer's grammar is `(>=|>|<=|<)\s*(\d*\.?\d+)`, with no exponent, and
  JavaScript renders anything below `1e-6` exponentially: `String(1e-7) === '1e-7'`. That
  threshold is inside `[0, 1]` and still produces a policy bouncer refuses to load.

A refusal is the designed outcome, not a crash. The plan's original toolgate emitter wrote
a per-question threshold map; toolgate has no such key — it takes `max(probability)` over
**every** question and compares it to two scalars, so that file would have loaded cleanly,
ignored the map, and run at toolgate's own 0.85 / 0.55 defaults. A policy that parses and
means something else is worse than no policy, so `jevc` says:

```console
$ npx jevc emit-policy --for toolgate program.json
Cannot emit a toolgate policy: questions outside_repo have no deny rule, but max-over-questions applies the deny threshold to them anyway.
  toolgate reduces by max(probability) over all questions, then two scalars (deny, ask). Express the reducer as one shared deny threshold and one shared ask threshold over every question, or emit to a code target.
```

---

## Calibration: the corpus is measured, not written

`fixtures/` holds **60 fixtures** — five domains (security guardrails, cost optimization,
intent understanding, agent harness rules, output verification), 12 each, 343 questions
(252 noul, 65 choice, 26 score). Every one was executed live against
`POST https://api.typesafe.ai/v1/systemone` on 2026-09-18, model `jev-1.13.0`: 60/60 HTTP
200 on the first attempt, zero dropped. Each fixture carries the real natural-language
prompt it replaces, its provenance, and its measured response.

**Only 24 of the 60 predicted thresholds survived contact with the real model. 36 of 60
were wrong** and were recalibrated to measured values. Had the corpus been written from
predictions, 60% of the suite would have encoded fiction — which is the entire argument for
measuring it.

Measured latency across those 60 calls: **min 689 ms, median 778.5 ms, max 2584 ms**. The
maximum was the first call recorded in its batch, which is consistent with connection
setup but was not isolated and measured; latency is flat in question
count, not linear — the 18 fixtures with 5 questions span 689-993 ms
and the 12 with 7 questions span 701-2584 ms.
Questions evaluate in parallel, so batch aggressively; the only reason to split a request
is the shared token budget.

Answers are near-deterministic but **not bit-identical** — repeated identical calls drift
by about ±0.01. Every assertion in the corpus is therefore a band (`noul_gte`, `score_gte`,
`confidence_gte`), never an equality. That is a measured property of the model, not
defensive padding.

Cost, from TypeSafe's published pricing: **$0.042 per million input tokens, output free.**

---

## Examples

All four run offline against the recorded corpus — no key, no network. See
[`examples/README.md`](examples/README.md).

```bash
npx tsx examples/01-schema-to-jev.ts       # schema -> Jev, with the residual left visible
npx tsx examples/02-agents-md-guardrail.ts # a CLAUDE.md rule, enforced
npx tsx examples/03-model-router.ts        # route before you spend; level-index scores
npx tsx examples/04-policy-emit.ts         # emit a bouncer policy; watch toolgate refuse
```

---

## Where this sits in the ecosystem

`jevc` depends on [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk)
(`^0.6.0`) and does not reimplement it: the client, retry with backoff, `retry-after`
handling, typed error classes, `noul()`/`choice()`/`score()` and the `ResultFor`/`ScoreOf`
type machinery are all there and good.

A prior-art sweep found **seven** shipped Claude Code Jev guardrail hooks and **eight** Jev
CLIs. Building hook #8 would be the least valuable thing this project could do — and
critically, **none of the fifteen lowers anything**: every one takes questions a human
already wrote by hand. So `jevc` emits policy *for* them:

- **bouncer** — full policy: questions, one-condition rules, thresholds, provenance
  comments, shipped in `observe` mode so a generated rule must be calibrated before it is
  given authority.
- **toolgate** — questions plus its two scalar thresholds, when the reducer is genuinely
  that shape; a refusal with a reason when it is not. Its static-rule layer runs before any
  model call, which is exactly the split the decomposition law prescribes.
- **jev-guard** — *investigated and cut.* Its questions are `export const` object literals
  in `src/guard.js` and its `decide()` destructures four fixed ids, so there is nothing to
  emit into. An emitter that could only tweak thresholds would be pretending to work.

It is complementary to schema-first authoring tools (you write the schema, `jevc` lowers
it) and to repair tools that fix LLM-emitted Jev JSON (`jevc` never asks a model for JSON
in the first place — the deterministic path has no model in it at all).

---

## Security

The API key is read from `TYPESAFE_API_KEY` only. It is never written to a file, never
committed, never logged, and never embedded in a fixture. `.env` is gitignored and
`.env.example` carries a placeholder.

Nothing in `npm test`, and nothing in `examples/`, requires a key or touches the network —
the example suite runs with `TYPESAFE_API_KEY` explicitly emptied to prove it.

The `422` error envelope **echoes the whole request body**, state included. `evaluate()`
therefore rebuilds `APIError` with a redacted body and a fixed message rather than mutating
the error it caught: the SDK derives `.message` from `.body` inside its own constructor, and
Node derives `.stack` from that message immediately after, so reassigning `.body` in a catch
block cannot retroactively scrub a message that already contains your state.

---

## Development

```bash
npm run typecheck    # tsc over src + test
npm run build        # -> dist/
npm test             # offline: no key, no network, no quota
npm run check:live   # re-measures the corpus; requires TYPESAFE_API_KEY
```

Design spec: [`docs/superpowers/specs/2026-09-18-jevc-design.md`](docs/superpowers/specs/2026-09-18-jevc-design.md).
