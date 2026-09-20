# jevc — a transpiler from LLM prompts to Jev decisions

**Status:** approved design, 2026-09-18
**Repo:** [`doronp/jevc`](https://github.com/doronp/jevc)

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
| `choice` | `map<string, EntryType\|null>` | **2..255** | `{type, choice, probabilities, confidence}` |
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

One `Program`, four emitters plus policy output. The IR exists precisely so these
grow independently.

| Emitter | `--emit` | Target | Carries uncertainty? |
| --- | --- | --- | --- |
| **native** | `sdk` | `@typesafe-ai/sdk@0.6` — `as const` TS codegen | yes |
| **ai-sdk** | `ai-sdk` | `@ai-sdk/typesafe-ai@3` (`EvaluationModelV4`) | **degraded** — see below |
| **langchain** | `langchain` | `langchain-typesafe` (Python) incl. middleware config | yes |
| **json** | `json` | plain request JSON for curl/Go/Rust | n/a |

The Vercel `EvaluationModelV4` spec **renames the primitives**: `noul`→`boolean`,
answer field `noul`→`probability`, and it drops `confidence` and `legend` entirely. It
also reads a different env var (`TYPESAFE_AI_API_KEY`) and a different baseURL
(`.../v1`). Where a compiled decision's uncertainty rule depends on `confidence`, that
emitter must either recompute it from the probability distribution or refuse to emit —
the transpiler will not silently drop an uncertainty rule. Which of the two applies is
being confirmed against the real type signatures before implementation.

| Other output | Command | Use |
| --- | --- | --- |
| residual prompt | `jevc compile --residual` | the shrunken LLM prompt |
| incumbent policy | `jevc emit-policy --for bouncer\|toolgate\|jev-guard` | see §9 |
| calibration report | `jevc check` | measured behaviour per decision |

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

## 9. Policy emitters for incumbent guardrails

A prior-art sweep found **seven** shipped Claude Code Jev guardrail hooks
(`bouncer`, `toolgate`, `jev-guard`, `agent-guard`, `jev-gate`, `jev-claude`,
`limpet`) and **eight** Jev CLIs. Building hook #8 would be the least valuable thing
this project could do.

Critically: **none of the fifteen lowers anything.** Every one takes questions a human
already wrote by hand. So they are competitors for the surface and have zero overlap
with the core.

`jevc` therefore emits *policy for them* rather than replacing them:

```
jevc emit-policy --for bouncer   AGENTS.md   # -> bouncer YAML
jevc emit-policy --for toolgate  AGENTS.md   # -> toolgate YAML (static rules + model layer)
```

Both of those shipped. `jev-guard` did not, and deliberately: its questions are `export
const` literals in its own source, so there is no policy file to emit into and the CLI
refuses the target by name (`src/cli.ts:546`).

This is the transpiler applied to their file formats, and it inherits
their calibration harnesses and multi-host adapters for free. `toolgate` is the most
interesting target because it already has a **static-rule layer that runs before any
model call** — which is exactly the split §4b prescribes, so a compiled program can be
emitted across both layers: patterns to the static rules, semantics to the questions.

**Known risk, being verified before implementation:** if a tool's question set is
hardcoded rather than policy-defined, the emitter can only emit thresholds. That is a
much weaker story, and any emitter in that position gets cut rather than shipped
pretending to work.

Independent corroboration of §4b from `bouncer`'s own published calibration against
`jev-1.13.0`: five of its six questions clear its 0.85 accuracy gate. The one that
fails, at 14/18, is `destructive` — the broadest and most collapsed question in its
set. Same failure mode, measured by a different team.

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

The corpus is already built and measured: **58 fixtures across five domains, 58/58
executed successfully against the live API, 0 dropped**. Notably only **23 of 58**
predicted thresholds survived contact with the real model — the other 35 were
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
- **Shipping a guardrail hook.** Seven exist and two of them (`bouncer`, `jev-guard`)
  are ahead of anything a fresh start would produce. `jevc` emits policy *for* them.
- **A general-purpose eval CLI.** Eight Jev CLIs already do this. `jevc` stays
  `compile` / `check` / `emit` / `emit-policy`.
- **Reimplementing the SDK.** Client, retry policy, error taxonomy, `noul()`/`choice()`/
  `score()`, `ResultFor`/`ScoreOf`/`ScoreLegend`, `APIPromise`, env resolution are all
  present and good in `@typesafe-ai/sdk@0.6.0`. Depend on it.

## 12. Layout

```
src/contract.ts      verified wire types + validator
src/ir.ts            Decision / Program + schema
src/from-schema.ts   JSON Schema | Zod | tool-def -> IR   (deterministic)
src/from-prompt.ts   natural language -> IR               (agent lift + validate)
src/compile.ts       IR -> request | decisions.ts | residual
src/emit/capability.ts  what each target can express; refuses rather than drops
src/emit/policy/     bouncer + toolgate YAML
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
