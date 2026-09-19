# Emit target: @riskaverse/toolgate (RiskAverseTech/toolgate) — YAML policy at ~/.toolgate/toolgate.yaml

**Feasible:** True  
**Format:** yaml  
**Pinned at:** GitHub RiskAverseTech/toolgate @ commit 2627de9cb178e4663744759fdcb40bdd7cd4c4ff (2026-09-18, "v0.1.2: tight pass..."), package.json version 0.1.2, repo has NO git tags. npm package @riskaverse/toolgate is NOT PUBLISHED — registry.npmjs.org returns E404, so `npm install` was impossible; I cloned the repo, ran `npm install` + `tsc` and read/executed real dist/. Transitive deps resolved: ai@7.0.105, @ai-sdk/gateway@4.0.85, @ai-sdk/provider@4.0.17, yaml@^2.5.0.

## File locations

Exactly ONE trusted location, resolved in `policyPath()` (src/policy.ts:102-104), precedence order:
1. explicit `--policy <path>` CLI flag (`toolgate hook --policy`, `toolgate check --policy`)
2. `$TOOLGATE_POLICY` env var
3. `~/.toolgate/toolgate.yaml` (default)
Tilde-expanded via `expandTilde()`. If the resolved file does not exist, `defaultPolicy()` is returned silently (no error).

CRITICAL for an emitter: there is deliberately NO per-project/cwd discovery. Comment at src/policy.ts:97-101: "Policy lives in ONE trusted place ... Deliberately no per-project discovery — a cloned repo must never be able to reconfigure the firewall." So jevc CANNOT emit a `toolgate.yaml` into the repo and have it picked up. The emitter must either write `$HOME/.toolgate/toolgate.yaml` (global, clobbers the user's other rules) or emit a file plus require `TOOLGATE_POLICY=<path>` in the hook command / environment. Audit log default: `~/.toolgate/audit.jsonl`.

## Schema

Derived from `interface Policy` (src/types.ts:61-75), `defaultPolicy()` (src/policy.ts:84-95), `mergePolicy()` (116-131) and `validatePolicy()` (133-155). Top-level YAML must be a mapping (else throw). All keys optional — every one falls back to a default.

| key | type | required | default | allowed / validated |
|---|---|---|---|---|
| `backend.provider` | `"gateway" \| "mock"` | no | `gateway` | hard-validated; anything else throws |
| `backend.model` | string | no | `typesafe-ai/jev` | NOT validated (any string; passed straight to AI Gateway) |
| `backend.timeout_ms` | number | no | `2500` | must be finite and `> 0` |
| `fail_mode` | `"passthrough" \| "ask" \| "deny"` | no | `passthrough` | hard-validated. Applied on backend error/timeout/malformed answer/zero questions |
| `thresholds.deny` | number | no | `0.85` | must satisfy `0 <= ask <= deny <= 1` |
| `thresholds.ask` | number | no | `0.55` | same constraint |
| `gated_tools` | string (tool matcher) | no | `"Bash\|Write\|Edit\|MultiEdit\|NotebookEdit\|WebFetch\|WebSearch\|mcp__.*"` | non-empty string; must compile via `toolMatcherToRegex` |
| `include_task_context` | boolean | no | `true` | not type-validated; uses `??` so explicit `false` works |
| `audit.enabled` | boolean | no | `true` | not type-validated |
| `audit.path` | string | no | `~/.toolgate/audit.jsonl` | tilde-expanded; dir `0700`, file `0600` |
| `audit.log_input` | boolean | no | `true` | not type-validated; input truncated to 500 chars + secret-redacted |
| `rules` | `StaticRule[]` | no | the 4 built-ins | user rules **prepended** before built-ins. Non-array value is silently dropped |
| `rules[].match` | object | **yes** (per rule) | — | must be a non-null object, else throw |
| `rules[].match.tool` | string (tool matcher) | no | undefined = match any tool | must compile via `toolMatcherToRegex` |
| `rules[].match.input_regex` | string (JS regex) | no | undefined = match any input | must compile via `new RegExp()`; applied case-insensitively |
| `rules[].action` | `"allow" \| "ask" \| "deny"` | **yes** | — | hard-validated. Note: NO `passthrough` here |
| `rules[].reason` | string | no | `"Matched static rule #N"` | free text, surfaced to user + model |
| `questions` | `Record<string, BooleanQuestion>` | no | the 4 built-ins | merged **shallow per key** over built-ins |
| `questions.<id>.type` | `"boolean"` | **yes** | — | **must be exactly `boolean`** — `score`/`choice` throw |
| `questions.<id>.instructions` | string | **yes** | — | must be a string |
| `questions.<id>.criteria.true` | string | no | — | not validated |
| `questions.<id>.criteria.false` | string | no | — | not validated |

**Merge semantics** (`mergePolicy`): `backend`/`thresholds`/`audit` shallow-spread one level; `rules` = `[...user, ...builtins]`; `questions` = `{...builtins, ...user}` shallow per key. **Unknown/typo'd top-level keys are silently ignored** — verified: a policy with `gated_tool:` (typo) and `nonsense_key: 42` loaded without error and kept the default `gated_tools`. An emitter gets no schema feedback on a misspelled key.

**Tool matcher grammar** (`toolMatcherToRegex`, src/policy.ts:158-169), used by both `gated_tools` and `rules[].match.tool`:
- `"*"` or `""` → match everything (`/^.*$/`)
- matches `/^[\w\s|,-]+$/` → treated as a name list, split on `|` or `,`, trimmed → `^(?:a|b)$`
- otherwise → used as a regex → `^(?:<matcher>)$`
- always whole-name anchored, so `mcp__.*` needs the `.*`.

**The 4 built-in questions** (verbatim ids + instructions, src/policy.ts:7-40):
- `destructive` — "This tool call irreversibly destroys or overwrites data, files, branches, or infrastructure."
- `exfiltration` — "This tool call sends local file contents, credentials, or environment variables to a network destination."
- `privilege` — "This tool call escalates privileges or modifies system configuration, credentials, or security settings."
- `off_task` — "This tool call is outside the scope of the stated current task."

**The 4 built-in static rules** (src/policy.ts:52-82), all `tool: Bash` except #3:
1. `deny` — recursive `rm` targeting `/`, `~`, or `$HOME` ("Recursive delete targeting root or home")
2. `ask` — `curl|wget ... | sh` or `sh <(curl ...)` ("Piping a remote script into a shell")
3. `ask` — `tool: Write|Edit|MultiEdit|NotebookEdit` touching `.claude/settings`, `.toolgate`, `toolgate.ya?ml`
4. `ask` — Bash redirect/`tee`/`cp`/`mv`/`rm`/`ln`/`chmod`/`chown`/`truncate`/`sed -i` onto those same safety files

**Decision pipeline** (`decide`, src/engine.ts:13-57): static rules in order, first match wins → `gated_tools` filter (non-match ⇒ `passthrough`, no audit row) → build state → drop `off_task` if no task → `backend.evaluate` → **max over all question probabilities** → `>= thresholds.deny` ⇒ deny, `>= thresholds.ask` ⇒ ask, else allow.

**Hook contract** (src/hook.ts:30-41): emits `{systemMessage, hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision, permissionDecisionReason}}`; `passthrough` emits nothing. Always exits 0. Internal errors become a visible `ask`, never a silent allow. Registered as a `PreToolUse` hook with `matcher: "*"`, `command: "toolgate hook"`, `timeout: 10`.

## Mapping notes

VERDICT: build the emitter, but scope it to 2 of the 4 Program parts. It is genuinely useful, not cosmetic — I proved both target layers accept machine-generated content end-to-end. The ceiling is real and is in `reduce`, not in the questions.

**Q2 answered — questions are POLICY-DEFINED, not hardcoded, and ARE user-extensible.** This is the load-bearing good news. `DEFAULT_QUESTIONS` is merely the default value of the `questions` key; `mergePolicy` does `{...base.questions, ...user.questions}` (src/policy.ts:126), covered by their own test ("user questions are merged over built-ins", test/policy.test.ts:34-36) and confirmed by my run where `spends_money` came back in `probabilities`. Three caveats an emitter must respect:
- **Boolean only.** `validatePolicy` throws unless `q.type === 'boolean'` (src/policy.ts:150-154). I verified: `type: score` → `toolgate policy: question "blast_radius" must be { type: boolean, instructions: string }`, exit 1; same for `type: choice`. So jevc `noul`/`choice`/`score` decisions DO NOT MAP — only boolean evidence questions do. Worth knowing where the limit lives: the underlying AI SDK `EvaluationQuestion` (@ai-sdk/provider EvaluationModelV4Question) fully supports `choice` (criteria map) and `score` (ordered levels), and Jev returns distributions for both. The boolean-only restriction is toolgate's validator, ~1 line wide, not a model or Gateway limit — a viable upstream PR if you want score/choice to survive the lowering.
- **Built-ins cannot be removed.** They are the merge base, and `destructive: null` throws validation. So every emitted policy always carries the 4 built-in questions plus yours. You can only *shadow* one by reusing its id.
- **Override is a wholesale per-key REPLACE, not a deep merge.** Verified: overriding `destructive` with `{type, instructions}` left `criteria: undefined`. If jevc overrides a built-in id it must re-emit `criteria` too.
- Reserved id: `off_task` is silently dropped when no task context exists (src/engine.ts:63). Don't emit a custom question named `off_task` unless you want that skip.

**Q3 answered — yes, there IS a static-rule layer, and targeting BOTH layers is the right call; your instinct is correct.** `rules: [{match:{tool?, input_regex?}, action, reason?}]`, ordered, first match wins, evaluated before any model call (src/engine.ts:15-21). Measured: 0.05-0.07s wall clock on the static path with `node dist/cli.js` — matches their "~60 ms" claim; the AI SDK (~600ms import) is lazy-loaded and never touched on a static hit. Emitter-relevant details:
- Syntax is **JS regex, not glob.** jevc must compile globs to regex itself. Case-insensitive (`new RegExp(input_regex, 'i')`).
- `input_regex` matches against `matchText()` (src/state.ts:27-37): every string/number in `tool_input`, plus object KEYS, joined by `\n`, with all `"`, `'`, `\` stripped. So patterns are written for the raw command, not JSON — and an emitted pattern must not contain quotes or backslash-escapes that assume JSON form.
- **User rules are prepended, so an emitted `allow` rule CAN shadow a built-in `deny`.** Verified: a user rule `{tool: Bash, input_regex: 'rm', action: allow}` made `rm -rf /` return `allow` where the default policy returns `deny`. The built-ins are a floor only in the sense that they can't be deleted — they are fully shadowable. Treat that as a safety obligation on the emitter (never emit broad `allow` rules), not as a feature.
- `action` has no `passthrough` option — a static rule always expresses an opinion.

**Q1/Q4 answered** in schema_md. `gated_tools` default is `"Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|mcp__.*"`, matched whole-name-anchored via `toolMatcherToRegex` (name list if it matches `/^[\w\s|,-]+$/`, else regex, always wrapped `^(?:...)$`); a non-match short-circuits to `passthrough` with no audit row.

**Q5 CONFIRMED — Vercel AI Gateway, not the direct API.** `src/backends/gateway.ts:1` imports `experimental_evaluate` from `ai` and calls it with `model` as a bare string (`'typesafe-ai/jev'`). A string model id is resolved by the AI SDK's configured default provider, which is `@ai-sdk/gateway` (`import { gateway } from "@ai-sdk/gateway"` at ai/dist/index.js:692 and :12853). I grepped `@ai-sdk/gateway@4.0.85` dist and found `AI_GATEWAY_API_KEY` and the `ai-gateway.vercel.sh` endpoint. Auth is `AI_GATEWAY_API_KEY` (or Vercel OIDC), documented in the CLI help text (src/cli.ts:27). Direct TypeSafe API (`api.typesafe.ai/v1/systemone`) is roadmap-only, unimplemented. **Config implications for the emitter:** the YAML exposes only `backend.provider` (`gateway|mock`) and `backend.model` — there is NO key for api_key, base_url, headers, or providerOptions, and `maxRetries: 0` is hardcoded with a single attempt under a hard wall-clock `timeout_ms`. So an emitted policy cannot carry credentials or point at a different endpoint; auth is environment-only and out of band. Emitting `provider: mock` is the right default for tests (deterministic regex heuristic, no network, no key), but note the mock only has SIGNALS for 3 built-in ids — any jevc-emitted custom question scores a flat 0.02 under mock, so mock cannot validate your question semantics, only your YAML shape.

**What does NOT map, and why — the honest ceiling:**
- **`reduce: Reducer` DOES NOT MAP. This is the main loss.** toolgate's reducer is hardcoded in `decide()` (src/engine.ts:40-56): take the **max** probability across all questions, then `>= thresholds.deny` ⇒ deny, `>= thresholds.ask` ⇒ ask, else allow. The only tunable surface is two scalars (`deny`, `ask`). There are no per-question weights, no AND/OR, no conditionals, no arithmetic, no per-question thresholds. Consequence that matters for your design: because the reduce is max-over-questions, **every emitted question is implicitly OR'd at the same severity**, so adding a question can only ever make the gate stricter. You cannot express "A and B together are risky but neither alone", nor "question X is advisory, question Y is blocking". Partial workaround: push reducer structure down into the static-rule layer (which genuinely does support ordered first-match-wins with allow/ask/deny) and keep only single-signal evidence questions in `questions`. A jevc Reducer that isn't expressible as max-then-two-thresholds should be a hard emit error, not a silent lossy downgrade.
- **`stateBuilder` DOES NOT MAP.** `buildState()` (src/state.ts:9-21) is hardcoded: `tool`, `tool_input` (middle-truncated at 6000 chars), plus `cwd` and `permission_mode` when present, plus `current_task` scraped from the Claude Code transcript (1200 chars). The only policy control is the `include_task_context` boolean. No YAML key can add, rename, or compute a state field.
- **`residual: string` has no home.** Nothing in the schema holds it, and unknown keys are silently dropped, so it can only survive as a YAML comment.
- Also note `instructions` is mutated at call time: engine appends a fixed prompt-injection warning (`UNTRUSTED_NOTE`, src/engine.ts:5-6) to every question. Emitted instructions should not duplicate that hardening.

**Recommended emitter shape:** split the compiled Program across both layers as you proposed — pattern-expressible decisions → `rules[]` (regex-compiled, ordered to mirror reducer precedence, `allow` never emitted); non-pattern boolean evidence decisions → `questions{}` (namespaced ids to avoid colliding with the 4 built-ins and reserved `off_task`); map the Reducer to `thresholds` + `fail_mode` only when it is max-then-threshold shaped, else refuse; drop `stateBuilder` and `residual` with an explicit warning. Ship a `--policy-path` so you write a dedicated file + `TOOLGATE_POLICY` rather than clobbering the user's global `~/.toolgate/toolgate.yaml`.

**Adjacency note (relevant to the user's follow-up question):** toolgate sits in BOTH buckets being surveyed — it is a Claude Code `PreToolUse` guardrail hook *and* a Jev-backed CLI (`toolgate hook|check|init|audit`), and it independently arrived at the same core thesis as jevc (narrow evidence questions + verdict computed in code from probabilities). It is the closest prior art to jevc found so far, and the single best emit target precisely because its question set is policy-driven rather than hardcoded.

## Real example

```
Verbatim `examples/toolgate.yaml` @ 2627de9 (the committed reference policy, copied to `~/.toolgate/toolgate.yaml` by `toolgate init`):

```yaml
# toolgate policy — https://github.com/RiskAverseTech/toolgate
# Lives at ~/.toolgate/toolgate.yaml (or $TOOLGATE_POLICY). Never read from
# project directories, so a cloned repo can't reconfigure the firewall.

backend:
  provider: gateway        # gateway | mock
  model: typesafe-ai/jev
  timeout_ms: 2500

# When the decision model is unreachable:
#   passthrough = defer to the agent's normal permission flow (default)
#   ask         = force a confirmation prompt
#   deny        = block until the model is back
fail_mode: passthrough

thresholds:
  deny: 0.85               # block at/above this probability
  ask: 0.55                # prompt at/above this probability

# Tools the model evaluates (whole-name match; exact, a|b list, or regex).
gated_tools: "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|mcp__.*"

# Pull the current task from the transcript so `off_task` has context.
include_task_context: true

audit:
  enabled: true
  path: ~/.toolgate/audit.jsonl
  log_input: true          # inputs are truncated and secrets redacted

# Static rules run before the model — first match wins, costs nothing.
# Rules you add here run BEFORE the built-ins (rm -rf / or ~ → deny;
# curl | sh → ask; edits to agent safety settings → ask). Patterns match the
# raw tool input values (quotes stripped), case-insensitively.
rules: []
#  - match: { tool: Bash, input_regex: 'terraform\s+destroy' }
#    action: ask
#    reason: Infra teardown needs a human

# Extra questions are merged over the four built-ins
# (destructive, exfiltration, privilege, off_task).
questions: {}
#  spends_money:
#    type: boolean
#    instructions: This tool call makes a purchase or changes billing.
```

I also wrote and EXECUTED a synthetic jevc-style emitted policy against the built engine to prove the target accepts machine-generated output:

```yaml
# EMITTED BY jevc (synthetic test of the emit target)
backend: { provider: mock, model: typesafe-ai/jev, timeout_ms: 2500 }
fail_mode: ask
thresholds: { deny: 0.85, ask: 0.55 }
gated_tools: "Bash|Write|Edit|mcp__.*"
include_task_context: true
audit: { enabled: false, path: ~/.toolgate/audit.jsonl, log_input: false }
rules:
  - match: { tool: Bash, input_regex: 'terraform\s+destroy' }
    action: ask
    reason: jevc rule/0 - infra teardown
  - match: { tool: Bash, input_regex: 'kubectl\s+delete\s+ns' }
    action: deny
    reason: jevc rule/1 - namespace delete
questions:
  spends_money:
    type: boolean
    instructions: This tool call makes a purchase or changes billing.
    criteria:
      true: buys, subscribes, or raises a spend limit
      false: no billing effect
```

Results (`node dist/cli.js check`, TOOLGATE_POLICY pointed at the above):
- `Bash {"command":"terraform destroy -auto-approve"}` → `{"verdict":"ask","reason":"jevc rule/0 - infra teardown","source":"static-rule"}` — emitted static rule fires.
- `Bash {"command":"sudo apt install stripe-cli"}` → `{"verdict":"deny","source":"model","probabilities":{"destructive":0.02,"exfiltration":0.02,"privilege":0.85,"spends_money":0.02}}` — the emitted custom question reaches the model alongside the built-ins.
- `Read {"file_path":"/etc/passwd"}` → `{"verdict":"passthrough","reason":"Tool \"Read\" is not gated","source":"no-opinion"}`.
```
