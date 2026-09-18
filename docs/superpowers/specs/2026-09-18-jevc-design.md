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

Confirmed by live call on 2026-09-18 against `jev-1.13.0`. Several widely-circulated
descriptions of this API (including LLM-generated ones) are wrong; this section is
the normative reference for the implementation and is pinned by
`test/contract.test.ts`.

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <key>
Content-Type: application/json
```

**Request:** `{ model, state, questions }` where `state` is `string | object | array`
and `questions` is a flat `map<string, Question>` whose keys are chosen by the caller
and are **not sent to the model**.

| Type | `criteria` shape | Answer shape |
| --- | --- | --- |
| `noul` | optional `{ true: string, false: string }` | `{ type, noul: 0..1 }` — **no confidence field** |
| `choice` | `map<string, string \| null>` | `{ type, choice, probabilities, confidence }` |
| `score` | **ordered array**, >= 2 level descriptions | `{ type, score, legend, probabilities, confidence }` |

**`score` is returned in level-index space, not 0..1.** Three levels yields a
probability-weighted float in `0.0..2.0`. Treating it as a unit interval is the most
likely integration bug and the validator rejects thresholds outside `0..n-1`.

**Response:** `{ model, answers: map<string, Answer>, usage: { input_tokens, output_tokens } }`.
Answers are nested under `answers`, keyed by the caller's ids. Output tokens are free;
input is $0.042/Mtok. Errors: 401, 422 (validation, body names the field), 429, 529.

Measured: 0.70s for a 3-question request at 433 input tokens.

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
  decisions: Decision[]
  residual: string       // what still needs an LLM; '' when fully compiled
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

`source` carries provenance back to the originating line of natural language, so
`jevc explain <id>` can always answer "why does this question exist". Per TypeSafe's
own guidance that generated questions need human review, an unreviewable question set
is a liability; provenance is what makes review tractable.

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

The exact stdin/stdout contract is pinned against the current Claude Code hook
documentation and covered by a test that feeds a recorded payload through the hook.

## 10. Testing

Two tiers, because tests that require a paid API key do not get run.

**Offline (default, `npm test`).** Fixtures carry their *measured* Jev responses,
recorded at build time. The suite replays them: deterministic mapping, validation,
codegen, hook decisions, threshold logic. No key, no network, no quota, always green.

**Live (`npm run eval:live`).** Re-executes the corpus against the real API and
reports drift. This is how a TypeSafe model bump gets caught: `jev-latest` is an alias
that moves under you, so a changed answer distribution should surface as a diff in a
calibration report rather than as a production incident.

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
