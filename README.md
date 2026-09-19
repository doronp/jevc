# jevc

**A transpiler from natural-language LLM instructions to typed Jev decisions.**

A JSON Schema, an `AGENTS.md` rule, a system prompt — `jevc` lowers it into a *Jev
program*: a set of narrow typed questions answered by TypeSafe's System One model
(`jev-1.13.0`), plus a reducer that computes the verdict in ordinary code. What used to
be an LLM judgment becomes a deterministic, typed, auditable one.

A rule written in markdown is a suggestion. The same rule expressed as a typed question
against a System One model is an invariant that cannot produce a schema error, and that
answered in a median of 778.5 ms across the 60 calls recorded in `fixtures/` (min 689 ms,
max 2584 ms).

It is for anyone shipping a gate an LLM currently judges — a Claude Code `PreToolUse`
hook, a tool-call guard, a model router, an output verifier — who needs that gate's
decision to be reproducible and reviewable.

```bash
git clone https://github.com/doronp/jevc && cd jevc
npm install && npm run build                  # Node >= 22
npx jevc check                                # 60 fixtures, 60 passing, 0 failing
npx tsx examples/02-agents-md-guardrail.ts    # the rule below, enforced
```

Nothing above needs an API key, and neither does anything else in this README except
`jevc check --live`.

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
commit — the three that decide this state came back:

```
is_commit_operation                 0.96
user_explicitly_asked_to_commit     0.06     <- a bare approval is not consent
commit_required_by_requested_task   0.16

verdict, computed in code:          deny
latency:                            731 ms
```

(The fourth question, `command_does_more_than_commit`, measured 0.04. The reducer in
`examples/02-agents-md-guardrail.ts` does not read it, so the example prints the three
above.)

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

The decomposed heads are right and certain. The verdict head put `allow` 0.07 ahead of
`block` at confidence 0.13 — the smallest margin between a winner and a runner-up
anywhere in the corpus, and seven times the ±0.01 that repeated identical calls drift
by. The evidence heads in the very same call sit at 0.93 and 0.97. A guard that flips to
`block` on `rm -rf node_modules` is not a guard, it is an outage, and 0.07 is all that
stands between this one and that.

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

Three rules follow, all enforced by `lintProgram` — three of the six checks it runs; the
other three are the two pattern/carve-out warnings below and `score_levels_undescribed`:

1. **Never emit a collapsed verdict question.** Emit evidence; compute the verdict in code.
   This one is a hard error.
2. **Never emit two questions where one's answer determines the other's.** Questions in a
   batch are scored independently with no consistency enforced — one measured response
   asserted `rule_conflict = documented_exception_wins` (p 0.52, confidence 0.37) and
   `decision = deny` (confidence 0.73) in the same call.
3. **Never emit a question spanning two scopes.** A compound authorization question
   measured 0.59 — the wrong side of 0.5 — on a command whose deletions were partly
   authorized, because it anchored on the authorized half.

Carve-outs ("except `rm -rf node_modules`") are allowlists and belong in `reduce`
(`embedded_carveout`). A separate warning, `embedded_pattern`, covers the other half:
asking Jev whether a declared glob or deny pattern matched. Those questions measured
0.25 / 0.10 / 0.14 across three tool families — push, PR, edit — while the semantic
question on the same input answered 0.96 / 0.87 / 0.85. Keep pattern matching in code;
ask Jev only what a pattern cannot express.

---

## Compiling

Every console block below is real output, and every input it names is shown with it, so
each one can be reproduced in a clean clone. Compile a schema — `triage.json`:

```json
{
  "type": "object",
  "properties": {
    "is_urgent":   { "type": "boolean", "description": "Does the message convey time pressure?" },
    "department":  { "type": "string", "enum": ["billing", "technical", "sales"],
                     "description": "Which team should handle this?" },
    "frustration": { "type": "integer", "minimum": 1, "maximum": 5,
                     "description": "How frustrated is the customer?" },
    "reply":       { "type": "string", "description": "Draft a reply to the customer." }
  }
}
```

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

The `...` elides one declaration and its doc comment: `export const program =
JSON.parse("…") as unknown as Program`, the serialised `Program` the emitted `isUncertain`
resolves each decision's band against. The blank line inside `reduce` is real — this schema
declares no rules, so the body is the `otherwise` alone. Real stdout also repeats the
residual as a trailing comment block, so the generated file carries it too.

The part that cannot compile is reported on stderr rather than invented:

```console
residual:
The following still require a generative model:
- reply: Draft a reply to the customer. (text generation — Jev emits no strings)
dropped: "frustration" is 1..5, but a score answer is a level index 0..4: every threshold written in the schema's numbers would fire 1 level(s) early, and neither the level labels nor validateProgram record the offset. Re-base it to 0..4 — the one range where the two spaces coincide — or bucket it into described levels.
```

Compile prose. `jevc` ships the lift *protocol*, not a second model: `--lift` prints a
request for the agent you are already talking to (Claude Code, Codex, Cursor), which
returns candidate decisions as JSON. No second API key, no second bill. Given an
`AGENTS.md` whose third line is `Never delete tracked files. Stay inside the repo root.`:

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
decision's `source`, not just the quote. Any issue at `severity: "error"` — an unverifiable
citation included — comes back with the **empty** `Program`, not with a usable one that has
a warning attached. A fabricated citation used to survive all the way into an emitted
bouncer policy at exit 0, carrying the invented `file:line — quote` as a provenance
comment: an audit trail that lies about its own source, which is worse than no audit trail,
because it turns "I should check this" into "someone already did." A warn-severity issue —
the right quote at the wrong line — still returns the `Program` intact.

- `quote` must appear verbatim in the lifted document — whitespace is normalised, so a
  re-wrap is fine — and be at least **12 characters**. A shorter fragment proves nothing
  even when it does occur: taking phrases from an instruction file and asking how often
  they turn up anyway in a document that never contained them, the coincidence rate is 90%
  at ≤3 characters, 30% at 6-7, 9% at 10-11, and 1.8% by 17-20 (the measurement is recorded
  at `src/from-prompt.ts:4-13`). Real rule sentences run a median of 50 characters; the
  sub-12 units in real instruction files are headings and code fences, not rules.
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
| `jevc compile <file\|->` | `--lift`, `--emit sdk\|json\|ai-sdk\|langchain`, `-o <path>` | JSON Schema → a TypeScript module (`sdk`, default), a Vercel AI SDK backend (`ai-sdk`, TypeScript), a `langchain-typesafe` classifier (`langchain`, **Python**) or a wire request (`json`); `--lift` prints the lift request for prose. `-` reads stdin. |
| `jevc check` | `--live`, `--fixtures <dir>` | Replays the measured corpus offline; `--live` re-measures against the API and reports drift, one fixture at a time — a fixture that cannot be measured is one `broken` row, not a dead report. |
| `jevc explain <decision-id>` | `--fixtures <dir>` | Why does this question exist — its provenance, the prompt it replaced, and what it measured. |
| `jevc emit-policy --for <bouncer\|toolgate>` | `<program.json>`, `-o <path>` | Lowers a compiled program into an incumbent guardrail's own config format, after the same `validateProgram` + `lintProgram` gate `compile` runs. |

`bouncer` and `toolgate` are reached only through `emit-policy`, never through `--emit`:
they are policy documents, not modules. Every flag is strict. An unknown option
(`--output` is **not** an alias for `-o`), a repeated one (`--emit sdk --emit json`), a
valued one with no value, and `--lift --emit` together are each exit 1 with a named reason
rather than a silent default — `-o a.ts -o b.ts` used to write `a.ts` and leave a stale
`b.ts` live while the operator believed it had been replaced, and `--output out.ts` used to
be dropped entirely, sending the artifact to stdout while the named file kept its old
contents.

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
longer holds is `drifted`, not `broken`, and is reported without gating the exit. The two
commands are not running the same predicate: offline `jevc check` compares a recording
against itself and cannot fail spuriously, while `--live` compares it against a moving
alias, and 216 of the 331 numeric bounds in this corpus have less headroom than the 0.15
the drift threshold itself allows. A benign recalibration smaller than one drift threshold
would otherwise turn most of the corpus red. Everything structural still exits 1 on its own
row: a vanished id, a changed answer type, an unreadable payload and a fixture that cannot
be measured at all are each `broken`.

```console
$ npx jevc explain user_explicitly_asked_to_commit
user_explicitly_asked_to_commit  (agent-harness-rules/commit-only-when-explicitly-asked)
  type:         noul
  instructions: Looking only at recent_user_turns, did the human explicitly ask for a commit to be created?
  provenance:   Claude Code permissions docs ship this exact split as their worked example: ...
  measured:     {"type":"noul","noul":0.06}
  replaces:     You are a policy checker running inside our Claude Code PreToolUse hook. We keep getting surprise commits from the agent...
```

The `...` on `replaces:` is the CLI's own truncation; the one on `provenance:` is this
README's — `explain` prints the whole citation.

`emit-policy` reads a `Program` as JSON — the shape `--lift` asks the agent to produce.
There is a route from a lift response to a policy, but it runs through the library and
only for a caller who checks `issues` first: JSON that is not a `Program` is rejected by
name (`<path> is not a jevc program. Expected { decisions, reduce, residual, dropped }`)
rather than reaching `ir.ts` as a `TypeError`.

Here is the agent's answer to the lift request above, saved as `program.json` — two
evidence questions, each citing the line it came from, and the verdict in `reduce`:

```json
{
  "decisions": [
    { "id": "deletes_tracked_files", "kind": "noul",
      "instructions": "Does the command delete files tracked by git?",
      "source": { "file": "AGENTS.md", "line": 3, "quote": "Never delete tracked files." } },
    { "id": "outside_repo", "kind": "noul",
      "instructions": "Does it touch paths outside the repo root?",
      "source": { "file": "AGENTS.md", "line": 3, "quote": "Stay inside the repo root." } }
  ],
  "reduce": {
    "kind": "rules",
    "rules": [
      { "when": [{ "id": "deletes_tracked_files", "op": "gte", "value": 0.8 }], "then": "deny" },
      { "when": [{ "id": "outside_repo", "op": "gte", "value": 0.6 }], "then": "ask" }
    ],
    "otherwise": "allow"
  },
  "residual": "", "dropped": []
}
```

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
| `string` + `enum` | `choice` | enum members become criteria keys, with no per-member description (`null`). A non-string member is rendered with `JSON.stringify`, so `{a: 1}` becomes the option name `{"a":1}`; two members that render to the same name are **dropped**, not merged |
| `oneOf`/`anyOf` of `const` | `choice` | a const union is an enum, and each member's own `description` becomes that option's criteria value — the one spelling that carries per-option prose |
| `allOf` | merged, then mapped | members compose into one effective schema, which is what a `$ref` plus local overrides becomes once resolved |
| `anyOf`/`oneOf` of `[X, null]`, or `type: ["X", "null"]` | mapped as `X` | the Pydantic v2 and OpenAI strict spelling of an optional field; a union of two *decidable* branches names no single decision and stays **dropped** |
| `integer` + `minimum: 0`/`maximum`, span 2..10 | `score` | one level per value, labelled `<dotted id> = i` (`a.risk = 0`) — `i` is both the schema's value and the answer's level index. Those labels carry no meaning, and `lintProgram` says so on every one of them: `score_levels_undescribed`, a warning, with the two schema shapes that carry per-level prose instead. The draft-6+ numeric `exclusiveMinimum`/`exclusiveMaximum` are honoured, so `{minimum: 0, maximum: 5, exclusiveMaximum: 5}` is a 5-level score, not 6 |
| `integer` + `minimum` other than `0`, span 2..10 | **dropped** | a score answer is a level index `0..n-1`, so a threshold written in the schema's numbers fires `minimum` levels early and nothing in the `Program` records the offset; re-base the range, or bucket it into described levels |
| `integer` with gapped or unreadable bounds — `multipleOf` other than 1, or the draft-04 *boolean* `exclusiveMinimum`/`exclusiveMaximum` | **dropped** | a score's levels are the contiguous indices `0..n-1`, so a gap or a bound this mapper cannot read would offer the model a level the schema forbids |
| `array` of `enum` | **one `noul` per member** (`field.member`) | several labels may apply at once, and each noul answers its own label exactly once — which is why `uniqueItems` is ignored |
| `array` of `enum` with `minItems > 0` or `maxItems <` member count | **dropped** | one independent noul per label records no cardinality, so a declared single-select would ship as an unarbitrated multi-select. Spell a single-select as a plain `enum` |
| nested `object` | recurse; ids flattened dotted (`a.b`) | the questions map is flat, and the dotted id is load-bearing rather than cosmetic: it is what scopes the generated question text, and therefore what makes two sibling `risk` fields distinguishable to the model |
| a root with no `properties` — a `$ref` root, a bare-enum root, an array root, `{}` | **dropped, exit 1** | `$ref` is not resolved, and the drop names what it found rather than returning a silently empty `Program` |
| `string` (free) | **residual** | text generation |
| `array` of `object` | **residual** | unbounded extraction |
| `number` (any) | **dropped** | a continuous range has no discrete-level equivalent; bucket it, or model a 0..1 probability as a noul |
| `integer` spanning > 10 values | **dropped** | a score takes at most 10 levels |
| `null` | **dropped** | no decision to make |
| `const` | ignored | no decision to make, whatever it is attached to — `{type: 'boolean', const: true}` and `{enum: […], const: 'a'}` compile to nothing, not to a question with one answer |
| two things claiming one id — a property named `"a.b"` beside a nested `a: {b}`, or enum members `1` and `"1"` | **both dropped, exit 1** | the intent is unrepresentable as written rather than unsupported; renaming one of them fixes it |

`required` and `default` are ignored: Jev answers every question in the map, always.

A **dropped** cell means one of two exit codes. An *unsupported* drop — no Jev equivalent —
prints as `dropped:` on stderr and the compile still succeeds at exit 0; the artifact is
everything Jev can represent of what you wrote, and the `dropped:` block above is one. A
*collision* drop prints as `error:` and exits 1 without writing anything, however many
other decisions survived, because there is no artifact that asks what the schema asked. So
does a schema that compiles to no decisions at all. `fromJsonSchema` returns a
`SchemaProgram`, whose `dropped` entries carry `kind: 'collision' | 'unsupported'`; branch
on `kind`, never on the reason prose.

A two-member enum whose values are yes/no-shaped *could* collapse to a `noul`. That
heuristic is **off by default** (`collapseBooleanEnums`) — silently changing a declared
output's shape is exactly the class of surprise this project exists to remove.

---

## The validator earns its keep

The API returns **200 OK** for each of these, with an answer that is wrong or meaningless.
The `API result` column is quoted from 25 live probe requests against `jev-1.13.0` on
2026-09-18, transcribed in [`docs/design.md`](docs/design.md) §3 and not reproducible
offline. The `Caught by` column is: every row is pinned by `test/contract.test.ts` and
refused locally by `validateRequest` or `validateProgram`.

| Probe | API result | Consequence | Caught by |
| --- | --- | --- | --- |
| `score` with 1 level | 200 — `score: 0.0, confidence: 1.0` | the documented 2-level minimum is not enforced server-side; you get a meaningless constant | `score_too_few_levels` |
| `choice` with 1 option | 200 — `confidence: 1.0` | degenerate certainty; always "right" | `choice_too_few_options` |
| duplicate question id | 200 — last definition silently wins | a JSON object cannot hold duplicate keys, so one question vanishes before it is sent | `duplicate_id`, in the IR |
| unknown field (`temperature`, `weight`) | 200 — silently ignored | a typo like `criterion` never errors; emitted keys must be whitelisted | `unknown_field` |
| nonexistent `` `backtick.path` `` | 200 — answered from the whole state | a typo'd path never errors, it silently degrades | `path_unresolved` — an **error** against a structured state, where the path is provably absent; a **warning** against a string state, where backticks are ordinary prose markup (`` `sys.exit` `` in a question about a source file) and no path can resolve |
| empty `state: ""` | 200 | the model answers from no evidence | `state_empty` |

The whitelist reaches one level further down than the probe did. A noul `criteria` key that
is neither `true` nor `false` — `criteria: { treu: … }` — raises `unknown_field` on both the
wire path (`validateRequest`) and the program path (`validateProgram`); it was not probed
live, but the description the author wrote for that outcome demonstrably never reaches the
model, and `emit-policy` used to write it away at exit 0.

Two more the wire types pin: `score` answers come back in **level-index space** (3 levels
→ 0.0..2.0, 10 levels → 0.0..9.0), which is the most likely integration bug — a team's
habitual 0..1 threshold either never fires or always does. And a `noul` carries **no
confidence field**; its probability *is* the answer, so its uncertainty rule is a band
around the middle (default `[0.35, 0.65]`), and `validateProgram` rejects
`belowConfidence` on a noul rather than ignoring it.

`Program` is obtained from untrusted JSON by a cast in three places, so both closed
vocabularies a cast cannot enforce are checked too: a `kind` outside noul/choice/score (which
`toQuestion` would ship as a *choice*), and a condition `op` outside gte/lte/is/uncertain.
`runReducer` used to execute that one as `lte` — the inverse of the rule, at exit 0 — and now
refuses it by name, but the code emitters still inline the same two-way comparison
(`value(a, id) ${op === 'gte' ? '>=' : '<='} …`) into the files they generate, so the IR check
is the only thing standing between an unknown op and an inverted generated gate.
`evaluate()` runs `validateProgram` before it spends a call, which it did not
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

Budget: `validateRequest` refuses at **45,000 tokens** for the whole request and **32,000**
for state plus the longest single question, estimated at the measured ratio of 5.1
characters per token. The vendor documentation says 64k; ~45k returns
`400 max_tokens_exceeded` ([`docs/design.md`](docs/design.md) §3.3 records both, one line
apart), so a pre-flight check set to the documented number passes requests the API rejects —
the one outcome the check exists to prevent. Choice takes 2..255 options (reliability
degrades above ~240); score takes 2..10 levels.

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
| `bouncer` | **noul only** | **one question per rule** | **0..1, plain decimal; a band lowers to `LOW..HIGH`** | **allow/ask/deny** | no | no |
| `toolgate` | **noul only** | **max over questions, two scalars** | **0..1 (YAML number)** | **deny/ask** | no | no |

The `ai-sdk` row costs the caller one extra argument. Its emitted reducer is
`reduce(answers, confidence)`, not `reduce(answers)`, because the AI SDK carries confidence
in `providerMetadata` rather than on the answer — `confidenceOf(result)` extracts it, and
the call is `reduce(result.answers, confidenceOf(result))`. The second parameter is
required on purpose: defaulting it to `{}` silently evaluated every confidence rule against
the top-minus-runner-up margin instead, and on the verdict answer above the margin is 0.07
while the reported confidence is 0.13 — opposite sides of a 0.10 threshold.

`canEmit` never throws. It returns a `ValidationIssue[]` for every `Program` it is handed,
including one whose rules arrived without their `when` — a lifted model response is exactly
where that happens, and a gate that throws a `TypeError` tells the caller nothing about
their program. `no_decisions` is one of its errors, and the schema collision above is the
other end of the same contract: the emitted artifact asks everything the input asked, or
`jevc` refuses to emit.

Neither policy target takes a multi-condition rule. `when: [a, b]` is a **conjunction** —
`runReducer` evaluates `rule.when.every(...)` — while toolgate's `max(probability) >=
threshold` is a **disjunction**, so lowering one into the other inverts the rule: at
`a = 0.9, b = 0.1` the Program says allow and the policy would say deny. A rule with no
conditions at all is refused twice over, by `validateProgram` for every consumer
(`runReducer` fires it unconditionally and masks `otherwise` and every rule after it) and
again by `canEmit` for the two policy targets, which cannot express "always" in rule
position.

Verdict words are checked too, because they are strings in the IR and a fixed vocabulary
in the target. A bouncer policy that fails to parse does not degrade the gate, it **stops
policy resolution** and routes to `on_error`, whose default `passthrough` emits nothing —
so an unchecked `then: quarantine` would replace a working gate with a silent one at exit
0. `canEmit` returns `verdict_unsupported` instead. toolgate reaches the same refusal by a
different route: it declares no verdict vocabulary, because its verdict is not a word in a
rule but the choice of which of two scalars to write, so `then: quarantine` comes back as
`reducer_unrepresentable`. A deny-only program is fine there — it emits with `ask` set
equal to `deny`.

Two independent threshold checks, because they catch different failures:

- **`thresholdRange`** — a score threshold lives in level-index space (`1.5` of `0..2`),
  which cannot be expressed by a target whose thresholds are 0..1 probabilities.
- **`thresholdPattern`** — applied to the *serialised* threshold, because that is what the
  consumer parses. This one is bouncer's alone: it writes `p` as a **string** whose grammar
  is `(>=|>|<=|<)\s*(\d*\.?\d+)`, with no exponent, and JavaScript renders anything below
  `1e-6` exponentially: `String(1e-7) === '1e-7'`. That threshold is inside `[0, 1]` and
  still produces a policy bouncer refuses to load. toolgate writes a YAML number and has no
  such grammar, so it accepts `1e-7`.

The same principle shapes the emitters themselves. `sdk` and `ai-sdk` share
`src/emit/ts-lowering.ts` — one definition of the `__proto__` computed-key form and of the
ECMAScript line-terminator set — and it is TypeScript-only on purpose. `bouncer`, `toolgate`
and `langchain` keep their own, narrower terminator regex, because U+2028 ends a `//`
comment in JavaScript but is an ordinary character inside a `#` comment in both YAML 1.2
and CPython. Three grammars, three regexes, and a lifted quote that escaped its comment
once already is why they are not one.

Four more refusals, each named for the thing it would otherwise have shipped:
`threshold_not_a_number` (all six targets — `value(a, "q") >= "0.5"` is a legal coercing
comparison, and `deny: null` satisfied toolgate's own `0 <= ask <= deny <= 1` and then
denied every gated tool call), `instructions_not_string`, `id_empty` on the targets that
put ids on the wire, and `band_out_of_range`.

That last one is a warning, not a refusal, and the difference is worth being precise about.
jevc's uncertainty band is **exclusive** at both ends (`runtime.isUncertain` is
`lo < p < hi`) and bouncer's `p: LOW..HIGH` is **inclusive** at both, so each endpoint is
stepped one representable double inward: the default `[0.35, 0.65]` emits
`p: 0.35000000000000003..0.6499999999999999`. A reader eyeballing those digits should read
them as the step, not as a bug. A band with an endpoint outside 0..1 is then intersected
with the probabilities a noul can actually reach and emitted with a `band_out_of_range`
warning — `[0.9, 1.2]` emits `p: 0.9000000000000001..1`. A band that holds no probability
at all (`[1.2, 1.5]`), one that is empty once stepped inward (`[0.5, 0.5]`), and one whose
stepped endpoint serialises with an exponent (`[0, 1]` → `5e-324`) are each refused outright
as `uncertain_unsupported`, rather than emitted as a range bouncer cannot parse.

A refusal is the designed outcome, not a crash. The plan's original toolgate emitter wrote
a per-question threshold map; toolgate has no such key — it takes `max(probability)` over
**every** question and compares it to two scalars, so that file would have loaded cleanly,
ignored the map, and run at toolgate's own 0.85 / 0.55 defaults. A policy that parses and
means something else is worse than no policy, so `jevc` says:

```console
$ npx jevc emit-policy --for toolgate program.json
Cannot emit a toolgate policy:
  reduce.rules: questions outside_repo have no deny rule, but max-over-questions applies the deny threshold to them anyway. toolgate reduces by max(probability) over all questions, then two scalars (deny, ask). Express the reducer as one shared deny threshold and one shared ask threshold over every question, or emit to a code target.
  reduce.rules: questions deletes_tracked_files have no ask rule, but max-over-questions applies the ask threshold to them anyway. toolgate reduces by max(probability) over all questions, then two scalars (deny, ask). Express the reducer as one shared deny threshold and one shared ask threshold over every question, or emit to a code target.
```

Both directions are reported, not just the first, and the exit code is 1. The same
`program.json` emits a bouncer policy without complaint, which is the point of a
capability model: the refusal names the target that cannot carry the reducer, not a
defect in the program.

### One limitation the capability table cannot express

An **unanswered question** is handled differently by the two kinds of target, and the
difference is not a choice jevc gets to make.

All four code targets now **throw**. `runReducer`, the `sdk` module, the `ai-sdk` reducer
and the `langchain` classifier agree: `No answer for decision "<id>"`, and nothing is
returned. This is a **breaking change** — `ai-sdk` and `langchain` used to return `allow`
where `sdk` and `runReducer` threw, so the same Program with the same missing answer gave
two different verdicts, and the pair that disagreed was the pair that **failed open on a
deny rule**. An unanswered question read as "the condition did not hold" makes a deny rule
silently not fire and the reducer fall through to `otherwise`. Callers relying on the old
`allow` will now see an exception; that is the intended upgrade path, not a regression.

The two policy targets cannot do this, because a policy language has no exceptions. bouncer
**skips** a rule whose question went unanswered — absence of evidence, not evidence of
absence — and falls through to `default`; toolgate's `max(probability)` is taken over the
questions that did answer, and its `fail_mode` (default `passthrough`) covers the case
where the backend returned nothing at all. Neither is wrong for its host, and neither is
what the code targets do, so a Program lowered to both will disagree with itself on a
dropped answer. Both behaviours are recorded in
[`docs/targets/`](docs/targets/) — `target-bouncer.md` §"missing answer skips the rule" and
`target-toolgate.md` on `fail_mode`.

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
by about ±0.01. Every *numeric* assertion in the corpus is therefore a band, never an
equality: of the **329** `expect` entries across the 60 fixtures, 269 are bands, and the
remaining **60** assert an equality — but on the *argmax* of a choice, not on a number, and
52 of those 60 carry a confidence band alongside. Between them those entries pin **331**
numeric bounds (`noul_gte` 153, `noul_lte` 89, `confidence_gte` 51, `score_gte` 22,
`score_lte` 9, `confidence_lte` 7) — more bounds than entries, because a single entry can
pin both ends. The smallest gap between winner and runner-up anywhere in those 60 is
**0.07** and the median is **0.96**, so the drift does not reach the quantity being
pinned. Note that 0.07 is the collapsed verdict question from the top of this README:
wide enough that the recording is a stable assertion, far too narrow to be a verdict you
would ship. Those are different questions, and the corpus only answers the first.
Stability is a measured property of the model, not defensive padding.

Cost, from TypeSafe's published pricing as of 2026-09-18: **$0.042 per million input
tokens, output free.** Re-check it before you plan a budget around it — it is the one
number here that no test can pin, because it is not in the repo.

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

A prior-art sweep found **seven** shipped Claude Code Jev guardrail hooks (`bouncer`,
`toolgate`, `jev-guard`, `agent-guard`, `jev-gate`, `jev-claude`, `limpet`) and **eight**
Jev CLIs — the sweep is dated 2026-09-18 and listed in
[`docs/design.md`](docs/design.md) §9, so treat it as a snapshot, not a standing fact.
Building hook #8 would be the least valuable thing this project could do — and critically,
**none of the fifteen lowers anything**: every one takes questions a human already wrote by
hand. So `jevc` emits policy *for* them:

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

`jevc` itself reads one variable, `TYPESAFE_API_KEY`. It is never written to a file, never
committed, never logged, and never embedded in a fixture. `.env` is gitignored and
`.env.example` carries a placeholder (`TYPESAFE_API_KEY=apikey_...`, no body).

The **emitted** `ai-sdk` backend is the one exception, and it is the emitted file's
variable, not jevc's: `@typesafe-ai/ai-sdk-provider` reads `TYPESAFE_AI_API_KEY`, so the
generated module reads `process.env.TYPESAFE_AI_API_KEY ?? process.env.TYPESAFE_API_KEY`
and works in either environment. The emitted `langchain` backend passes no key at all —
`langchain-typesafe` reads `TYPESAFE_API_KEY` itself. Nothing jevc generates hard-codes a
key.

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

- [`docs/design.md`](docs/design.md) — the approved design spec, and the fullest argument
  for why the decomposition law is the product rather than a detail of it.
- [`docs/targets/`](docs/targets/) — one file per emit target
  ([bouncer](docs/targets/target-bouncer.md),
  [toolgate](docs/targets/target-toolgate.md),
  [ai-sdk and langchain](docs/targets/target-ai-sdk-and-langchain.md),
  [jev-guard](docs/targets/target-jev-guard.md), the one that was cut). These are the
  normative contract each emitter is written against: the consumer's real grammar, what it
  does with a field it cannot parse, and therefore why `canEmit` refuses what it refuses.
- [`CHANGELOG.md`](CHANGELOG.md) — including the breaking change in 0.1.0.
- [`docs/history/implementation-plan.md`](docs/history/implementation-plan.md) — the
  original build plan, kept unedited for provenance and not maintained.
