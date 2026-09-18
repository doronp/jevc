# jevc — a transpiler from LLM prompts to Jev decisions

**Status:** approved design, 2026-09-18
**Repo:** `jevc` (private)

---

## 1. Problem

Every AI system today contains judgments encoded as English sentences aimed at a
generative model. They live in system prompts, in `AGENTS.md`, in `CLAUDE.md`, in
`.cursorrules`, in the `description` field of a tool definition. Each one costs
seconds and cents, returns a string that must be parsed, and can be ignored by the
model that reads it.

A rule written in markdown is a suggestion. The same rule expressed as a typed
question against a System One model is an enforced invariant that answers in
~700ms and cannot produce a schema error.

`jevc` mechanically performs that conversion.

## 2. The central thesis, and its honest limit

A natural-language prompt braids three different things together:

| Part | Example | Compiles? |
| --- | --- | --- |
| **Decision** | "is this command dangerous?", "which team owns this?" | yes |
| **Generation** | "write a summary", "explain your reasoning" | never — Jev emits no text |
| **Procedure** | "read the file before editing it" | no — that is control flow, it belongs in code |

A transpiler that claims to turn a prompt into an equivalent Jev prompt is lying.
What `jevc` does is **separate** them. Every compilation emits three artifacts:

1. **the decision set** — real Jev questions, with thresholds and actions
2. **the residual prompt** — what genuinely still needs an LLM, now much smaller
3. **the wiring** — code that evaluates (1) and calls the LLM only for (2)

The residual is a first-class output, not a failure mode. A compilation that
produces an empty decision set is a valid and useful answer: it means this prompt
has no System One content, and `jevc` says so instead of inventing questions.

## 3. Verified API contract

Confirmed by 25 live probe requests against `jev-1.13.0` on 2026-09-18. Several
widely-circulated descriptions of this API (including LLM-generated ones) are wrong.
This section is normative and is pinned by `test/contract.test.ts`.

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <key>
```

**Request:** `{ model, state, questions }`. `state` is `string | object | array`,
**text only** — no images/audio/video. `questions` is a flat `map<string, Question>`
whose keys are caller-chosen and **not sent to the model**.

| Type | `criteria` | Bounds | Answer |
| --- | --- | --- | --- |
| `noul` | optional `{true?, false?}` | — | `{type, noul: 0..1}` — **no confidence** |
| `choice` | `map<string, EntryType\|null>` | **2..255** (~240 reliable) | `{type, choice, probabilities, confidence}` |
| `score` | **ordered array** | **2..10** | `{type, score, legend, probabilities, confidence}` |

`EntryType = string | object | array | null`, nested arbitrarily. `instructions` and
every criteria *value* may be structured, not just a string.

**`score` is returned in level-index space.** Three levels yields `0.0..2.0`; ten
yields `0.0..9.0`. Treating it as a unit interval is the most likely integration bug.

**Response:** `{ model, answers, usage }`. Input $0.042/Mtok; **output tokens are free**.

### 3.1 Where the API will not save you

These are the reason client-side validation is load-bearing rather than redundant:

| Probe | Result | Consequence |
| --- | --- | --- |
| `score` with **1 level** | **200 OK** — `score:0.0, confidence:1.0` | server does *not* enforce the documented minimum; emits a meaningless constant |
| `choice` with **1 option** | **200 OK** — `confidence:1.0` | degenerate certainty, always "right" |
| **duplicate** question id | **200** — last definition silently wins | JSON objects cannot hold duplicate keys; must dedupe before serializing |
| unknown fields (`temperature`, `weight`) | **200** — silently ignored | a typo like `criterion` never errors; must whitelist emitted keys |
| nonexistent `` `backtick.path` `` | **200** — answered anyway from whole state | a typo'd path never errors, it silently degrades |
| empty `state: ""` | **200** | must refuse locally |

### 3.2 Error envelopes — three distinct shapes

| Status | Body | Note |
| --- | --- | --- |
| `422` | `{detail: [...]}` **array** | all violations at once; **echoes the whole request body** — redact before logging |
| `400` | `{detail: "string"}` | app-level, **first error only** — re-validate after each fix |
| `400` | `{detail: {error_type, message?}}` | capacity; `message` may be **absent** |

One bad field can yield N errors (one per union arm), so error-count ≠ problem-count.

### 3.3 Measured performance

**Latency is flat in question count** — 1q: 0.85s · 10q: 0.78s · **200q: 1.03s**.
Questions evaluate in parallel; the only reason to split a request is the shared token
budget. Batch aggressively.

Budget: **64k tokens total**, **32k for state + longest single question**, ≈5.1
chars/token. ~45k tokens returns `400 max_tokens_exceeded`.

Answers are **near-deterministic, not bit-identical** (±0.01 across identical calls).
Golden tests must assert bands, never equality.

An undocumented fourth question type, `bounding_box`, appears in the server's
discriminator enum but in none of the 19k lines of documentation. Out of scope.

## 4. Intermediate representation

All inputs converge on one IR; all outputs are generated from it. This is what keeps
input formats and output surfaces independent.

```ts
type Decision = {
  id: string
  kind: 'noul' | 'choice' | 'score'
  instructions: string
  criteria: { true: string; false: string } | Record<string, string | null> | string[]
  fires?: { gte?: number; lte?: number; is?: string }
  then?: string
  uncertain?: { belowConfidence?: number } | { band: [number, number] }
  source?: { file: string; line: number; quote: string }
}

type Program = {
  decisions: Decision[]          // evidence questions only, never verdicts (see 4b)
  reduce: Reducer                // verdict computed in code from the evidence
  stateBuilder?: StateBuilder    // how to assemble `state` at call time
  residual: string               // what still needs an LLM; '' when fully compiled
  dropped: Array<{ reason: string; quote: string }>
}
```

Two fields carry the weight:

`fires` / `then` encode what a prompt never states explicitly — the threshold at which
a judgment changes program behaviour. This is the difference between a classifier and
a decision.

`uncertain` is type-dependent, and deliberately so. `choice` and `score` return a
`confidence`, so uncertainty is `belowConfidence`. **`noul` returns no confidence at
all** — its probability *is* its answer — so uncertainty for a noul is a `band` around
the middle (default `[0.35, 0.65]`): decisive at either end, escalate in between. The
validator rejects `belowConfidence` on a noul rather than silently ignoring it.

`reduce` is the direct consequence of the decomposition law. Because the verdict may
not be asked of the model, every `Program` carries the code that derives it from the
evidence answers. It is generated, checked in, and reviewed like any other code — which
is the point: the arbitration logic becomes visible and testable instead of hiding
inside a model's near-uniform distribution.

`stateBuilder` exists because in the harness domain **state is a runtime payload, not a
document**. A PreToolUse rule is evaluated against `tool_name` + `tool_input` + `cwd`
plus context a hook assembles cheaply (recent user turns, session tool history, git
context, the nearest `AGENTS.md`). So compiling a rule emits two artifacts: the pure
state-builder and the questions map. A rule whose evidence the builder cannot supply is
not compilable, and `jevc` says so rather than emitting a question that will be answered
from thin air.

`source` carries provenance back to the originating line of natural language, so
`jevc explain <id>` can always answer "why does this question exist". Per TypeSafe's
own guidance that generated questions need human review, an unreviewable question set
is a liability; provenance is what makes review tractable.

## 4b. The decomposition law

This is the most important empirical finding, and it constrains every code path.

**Jev answers narrow evidence questions decisively and collapsed verdict questions
near-randomly.** Measured on one request evaluating `rm -rf node_modules`:

| Question | Answer | Confidence |
| --- | --- | --- |
| `decision` — allow/ask/block, the collapsed verdict | allow 0.42 / block 0.35 / ask 0.23 | **0.13** |
| `blast_radius` — score | 1.02 | **0.97** |
| `only_regenerable_artifacts` — noul | 0.93 | — |

The decomposed heads are right and certain. The verdict head is a coin flip that would
have blocked a routine clean reinstall a third of the time.

**Questions in a batch are scored independently, with no consistency enforced between
them.** One measured response asserted `rule_conflict = documented_exception_wins`
(p=0.52) and `decision = deny` (confidence 0.73) simultaneously — a self-contradiction
inside a single answer set.

Three rules follow, all enforced by the linter:

1. **Never emit a collapsed verdict question.** Emit evidence questions; compute the
   verdict in code. A prompt saying "decide whether to block this" compiles to *several*
   evidence decisions plus a generated code-level reducer — never to one `choice`.
2. **Never emit two questions where one's answer logically determines the other's.**
   Ask the resolving question; derive the rest in code.
3. **Never emit a question spanning two scopes.** A compound question measured 0.59 —
   the wrong side of 0.5 — on a command whose deletions were partly authorized and
   partly not, because it anchored on the authorized segment. Split by scope.

A corollary for the security domain: real guardrail prompts spend most of their length
on **carve-outs** ("except `rm -rf node_modules`", "except security-testing discussions").
Carve-outs are *allowlists* and belong in code. Compiling them into the question text
is what produces the near-uniform verdict head above.

Division of labour, measured: declared **glob/deny patterns match semantics poorly**
(0.25, 0.10, 0.14 across three tool families) while the **semantic question answers
crisply** on the same input (0.96, 0.87, 0.85). Keep pattern matching in code; ask Jev
only what patterns cannot express.

## 5. Deterministic path: schema to IR

Pure functions, no model, property-tested. Accepts JSON Schema, Zod (via
`zod-to-json-schema`), Anthropic tool `input_schema`, OpenAI strict `json_schema`,
and MCP `inputSchema` — all normalize to JSON Schema first, so there is one mapper.

| Schema construct | Maps to | Note |
| --- | --- | --- |
| `boolean` | `noul` | `description` becomes instructions |
| `string` + `enum` | `choice` | enum members become criteria keys |
| `oneOf`/`anyOf` of `const` | `choice` | const union is an enum |
| `integer` + `minimum`/`maximum`, span <= 10 | `score` | levels from range; **warns** without per-level descriptions |
| `array` of `enum` (multi-label) | **N `noul`s, one per member** | per docs: several labels may apply simultaneously |
| nested `object` | recurse, ids flattened dotted (`a.b`) | the questions map is flat |
| `string` (free) | **residual** | text generation |
| `number` (unbounded) | **residual** | no levels can be derived |
| `array` of `object` | **residual** | unbounded extraction |
| `const`, `null` | **dropped** | no decision to make |

`required` and `default` are ignored: Jev answers every question in the map, always.

A two-member enum whose values are yes/no-shaped could collapse to a `noul`. That
heuristic is **off by default** — `choice` preserves the caller's declared type, and
silently changing an output's shape is exactly the class of surprise this project
exists to remove.

## 6. Lifted path: natural language to IR

Per the approved design the lifter is the **calling agent** — no second API key, no
second bill, works in Claude Code, Codex, or Cursor. `jevc` ships the protocol, not
the model:

1. `jevc compile AGENTS.md --lift` emits a **lift request**: the source text plus the
   IR schema plus the rules from section 3.
2. The agent returns candidate `Decision[]` as JSON.
3. `jevc` **validates** it against the same validator the deterministic path uses.
   Invalid criteria, an out-of-range threshold, a one-level score — all rejected here,
   before anything reaches the network.
4. The result is written as a reviewable file with `source` provenance on every entry.

A lifted decision is a **hypothesis until measured**. It is not trusted because a model
produced it; it is trusted because `jevc eval` ran it against the corpus and reported
its calibration. This is the only defensible answer to "why would I trust a question an
LLM wrote", and it is why the fixture corpus is built from live measurements rather
than predicted values.

## 7. Outputs

| Output | Command | Use |
| --- | --- | --- |
| `JevRequest` | library | direct runtime call |
| `decisions.ts` | `jevc compile -o` | checked in, reviewed in PRs, imported by app code |
| residual prompt | `jevc compile --residual` | the shrunken LLM prompt |
| hook config | `jevc guard --install` | Claude Code PreToolUse |
| calibration report | `jevc eval` | measured behaviour per decision |

### 7.1 Codegen constraint: preserve literal types

`@typesafe-ai/sdk` infers answer types from the question objects, but `ScoreOf`
degrades to a bare `number` unless the criteria array is a fixed-length **tuple**:

```ts
type ScoreOf<T extends ScoreCriteria> =
  number extends T['length'] ? number : Extract<keyof T, `${number}`>
```

Emitted code must therefore use `as const` or inline literals. If codegen widens
criteria to `string[]`, `legend` and `probabilities` keys silently widen too and the
type safety this project is named for evaporates. Covered by a `tsd` type-level test,
because this failure is invisible at runtime.

## 8. Runtime

A thin layer over `@typesafe-ai/sdk@0.6.0` — which already provides the client,
retry with backoff, `retry-after` handling, and typed error classes. Those are not
reimplemented.

`evaluate(program, state)` returns typed verdicts: the raw answer, whether `fires`
matched, the resolved `then`, and an `escalate` flag when confidence falls below
`escalateBelowConfidence`. Escalation is the documented confidence-routing pattern —
hand the uncertain case to a reasoning model or a human, which is the correct use of
a calibrated model and the reason calibration matters at all.

## 9. Claude Code guardrail hook

`hooks/pretooluse.ts` reads the PreToolUse payload on stdin (`tool_name`, `tool_input`,
`cwd`, `transcript_path`), evaluates a decision set compiled from the project's own
`AGENTS.md`/`CLAUDE.md`, and returns a `permissionDecision` of `allow` / `ask` / `deny`
with a reason.

**Default posture: `ask` on uncertainty, configurable to log-only** via
`jevc.config.json`. Log-only records what it *would* have done without blocking
anything, so the decision set can be calibrated against real traffic before it is
given authority. Fail-open is mandatory: any API error, timeout, or missing key exits
0 with no decision. A guardrail that bricks the agent when TypeSafe has an incident is
worse than no guardrail.

Verified contract. stdin carries `session_id`, `transcript_path`, `cwd`,
`permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`
(plus `prompt_id`, `scratchpad_dir`, `effort` when available). stdout is:

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "..." } }
```

Exit 0 with valid JSON decides the outcome; exit 2 blocks unconditionally, overriding
`permissionDecision`; exit 0 with no JSON means "no decision, normal flow". The legacy
top-level `decision`/`reason` keys are **not** part of the current contract and are not
emitted.

The SDK's `timeout` (default 10s) is **per attempt with no total budget**, so worst case
is `timeout × (maxRetries+1)` plus backoff. The hook sets `retry: {maxRetries: 0}` and a
short timeout — a guardrail must answer in under a second or get out of the way.

## 10. Testing

Two tiers, because tests that require a paid API key do not get run.

Answers are near-deterministic but **not bit-identical** — repeated identical calls
drift by ~±0.01. Every assertion is therefore a band (`noul_gte`, `score_gte`,
`confidence_gte`), never an equality. This is not defensive padding: it is a measured
property of the model.

**Offline (default, `npm test`).** Fixtures carry their *measured* Jev responses,
recorded at build time. The suite replays them: deterministic mapping, validation,
codegen, hook decisions, threshold logic. No key, no network, no quota, always green.

**Live (`npm run eval:live`).** Re-executes the corpus against the real API and
reports drift. This is how a TypeSafe model bump gets caught: `jev-latest` is an alias
that moves under you, so a changed answer distribution should surface as a diff in a
calibration report rather than as a production incident.

The corpus is already built and measured: **60 fixtures across five domains, 60/60
executed successfully against the live API, 0 dropped**. Notably only **24 of 60**
predicted thresholds survived contact with the real model — the other 36 were
recalibrated to measured values. Had the corpus been written from predictions instead of
measurements, 60% of the suite would have encoded fiction.

The corpus spans five domains — security guardrails, cost optimization, intent
understanding, agent harness rules, output verification — with every fixture carrying
the real natural-language prompt it replaces, its provenance, and its measured
response. Adversarial negatives are mandatory in the security domain: a guard that
blocks `rm -rf node_modules` is not a guard, it is an outage.

## 11. Non-goals

- **Generating text.** Jev cannot. Anything requiring it stays in the residual.
- **Replacing the LLM.** `jevc` moves judgment out of the LLM; reasoning stays.
- **Guessing thresholds.** A threshold is a product decision. `jevc` supplies a
  documented default and makes it easy to change; it does not tune it silently.
- **A monorepo.** One package, three entry points.
- **Competing on guardrail hooks or CLIs as such.** A prior-art sweep found ~7 existing
  Claude Code guardrail hooks and ~6 Jev CLIs, plus `@mateonunez/jod` (schema-first
  question authoring) and `pi-typesafe` (repairing LLM-emitted Jev JSON). None of them
  *lower* prose or JSON Schema into questions — that gap is the whole product. `jevc`'s
  hook is a thin demonstration that a compiled `AGENTS.md` is enforceable; it is not an
  attempt to win the guardrail category.

## 12. Layout

```
src/contract.ts      verified wire types + validator
src/ir.ts            Decision / Program + schema
src/from-schema.ts   JSON Schema | Zod | tool-def -> IR   (deterministic)
src/from-prompt.ts   natural language -> IR               (agent lift + validate)
src/compile.ts       IR -> request | decisions.ts | residual
src/runtime.ts       evaluate()
src/eval.ts          fixture runner + calibration report
src/cli.ts           jevc
hooks/pretooluse.ts  Claude Code guardrail
fixtures/*.json      measured corpus
examples/            runnable, realistic
```

## 13. Security

The API key is read from `TYPESAFE_API_KEY` only. It is never written to a file,
never committed, never logged, and never embedded in a fixture. `.env` is gitignored
and `.env.example` carries a placeholder.
