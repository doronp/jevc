# Emit target: jev-guard (npm `jev-guard`, github.com/leepokai/jev-guard)

**Feasible:** False  
**Format:** json  
**Pinned at:** npm jev-guard@0.3.1 (shasum 49dca58ed064bd0dfbe8848950250cca169943b1, published 2026-09-17) == git tag v0.3.1 == commit 94996ea80b6b308327ac2077706a29ce6abd3ba0 (2026-09-18 02:44:09 +0800, "README: auto-mode framing and price/speed table first"). Verified md5-identical between the npm tarball and repo HEAD for all 7 read files: src/{guard,cli,context,session,skills,hook,jev}.js. The package ships `src/` directly — there is no dist/. Zero deps, "engines": {"node": ">=20.3"}. `node --test test/*.test.js` → 13/13 pass.

## File locations

THREE separate surfaces; only the first is a "config file", and it holds credentials only.

(1) Credentials — `~/.jev-guard/config.json`
Precedence in `backend()` (src/jev.js:14-22), first match wins:
  1. env `JEV_API_KEY`            → TypeSafe backend (https://api.typesafe.ai/v1/systemone)
  2. env `AI_GATEWAY_API_KEY`     → Vercel AI Gateway, auth="api-key"
  3. env `VERCEL_OIDC_TOKEN`      → Vercel AI Gateway, auth="oidc" (~12h TTL)
  4. file `.jevApiKey`            → TypeSafe
  5. file `.aiGatewayApiKey`      → Gateway, auth="api-key"
  6. else null → throws "no credentials"; hooks then fail OPEN (allow) unless JEV_GUARD_FAIL_CLOSED.
File path = `env.JEV_GUARD_CONFIG ?? join(homedir(), ".jev-guard", "config.json")` (src/jev.js:10,25). Read via try/JSON.parse, any error → `{}`. Written by `jev-guard key <k>` at mode 0600, dir 0700. `--gateway` or a `vck_` prefix selects the gateway field.

(2) Policy/tuning — ENVIRONMENT VARIABLES ONLY. No file. `thresholds(env)` (src/guard.js:111-115) re-reads process.env on every call. There is no policy file, no rules file, no schema.

(3) Host wiring — per-host hook manifests written by `jev-guard install <agent>` (src/cli.js:88-154). These contain zero policy, only the command string:
  claude   → ~/.claude/settings.json            .hooks[PreToolUse|PostToolUse|UserPromptSubmit|SessionStart|InstructionsLoaded]
  codex    → ~/.codex/hooks.json                same minus InstructionsLoaded, cmd gets ` --agent codex`
  copilot  → ~/.copilot/hooks/jev-guard.json    {version:1, hooks:{...}}, `bash`+`timeoutSec` keys, ` --agent copilot`
  gemini   → ~/.gemini/settings.json            .hooks[BeforeTool|AfterTool|BeforeAgent|SessionStart], timeout 30000 (ms)
  cursor   → ~/.cursor/hooks.json               .hooks[beforeShellExecution|beforeMCPExecution|preToolUse(matcher "Write|Delete")|postToolUse|beforeSubmitPrompt|sessionStart]
  pi       → ~/.pi/agent/settings.json          .extensions[] += <ROOT>/extensions/jev-guard.ts
  opencode → ~/.config/opencode/plugins/jev-guard.js  one-line re-export shim (not JSON)
  acp      → no file; `jev-guard acp -- <agent cmd>` stdio proxy, configured in the editor
Idempotence: `notOurs()` strips any existing group whose JSON stringifies to include "jev-guard" before re-appending. Install refuses to run from an npx cache path.
Committed reference manifests live at hooks/hooks.json, hooks/codex.json, hooks/cursor.json, gemini-extension.json, plugin.json, .claude-plugin/plugin.json.

State/memory paths: `~/.jev-guard/sessions/` (env JEV_GUARD_SESSIONS), `~/.jev-guard/scan-cache.json` (env JEV_GUARD_SCAN_CACHE).

## Schema

## 1. `~/.jev-guard/config.json` — COMPLETE schema (src/jev.js:14-26, src/cli.js:72-81)

| field | type | required | default | allowed values |
|---|---|---|---|---|
| `jevApiKey` | string | no | — | TypeSafe API key (console.typesafe.ai) |
| `aiGatewayApiKey` | string | no | — | Vercel AI Gateway key, conventionally `vck_…` |

That is the entire schema. Two optional string fields, both credentials. Unknown keys are ignored (plain `JSON.parse`, no validation). No questions, no thresholds, no policy, no host list. Mode 0600, dir 0700.

## 2. Env-var policy surface — the ONLY tunable behavior (src/guard.js:111-116, README:152-169)

Parsed by `n(k,d) = Number.isFinite(+env[k]) ? +env[k] : d`, so a non-numeric value silently falls back to the default.

| var | default | effect |
|---|---|---|
| `JEV_GUARD_DENY_SCORE` | `2.5` | `risk.score` ≥ this → deny |
| `JEV_GUARD_ASK_SCORE` | `1.5` | `risk.score` ≥ this → ask |
| `JEV_GUARD_ASK_P` | `0.75` | `approval.p` ≥ this → ask |
| `JEV_GUARD_USER_P` | `0.85` | `user_requested.p` ≥ this turns ask→allow (never lifts deny) |
| `JEV_GUARD_UNTRUSTED_P` | `0.7` | `from_untrusted.p` ≥ this → deny outright |
| `JEV_GUARD_INJECT_P` | `0.6` | `directed.p` ≥ this flags a tool result |
| `JEV_GUARD_SKILL_P` | `0.8` | instruction-file p that flags `unrelated_side_effects` |
| `JEV_GUARD_SKILL_SERIOUS_P` | `0.45` | instruction-file p that flags the 4 serious kinds |
| `JEV_GUARD_TIMEOUT_MS` | `20000` | whole-call budget incl. retries (hosts kill hooks ~30s) |
| `JEV_GUARD_SKIP_TOOLS` | unset | comma-sep, lowercased tool names never assessed |
| `JEV_GUARD_SKIP_SCAN` | unset | comma-sep, lowercased tool names whose results are never scanned |
| `JEV_GUARD_FAIL_CLOSED` | unset | truthy → unreachable Jev denies instead of allows |
| `JEV_MODEL` | `jev-latest` / `typesafe-ai/jev` | model id (direct API / gateway) |
| `JEV_GUARD_CONFIG` | `~/.jev-guard/config.json` | config path (READ only — see bug below) |
| `JEV_GUARD_SESSIONS` | `~/.jev-guard/sessions` | session-memory dir |
| `JEV_GUARD_SCAN_CACHE` | `~/.jev-guard/scan-cache.json` | instruction-scan cache |
| `JEV_API_KEY` / `AI_GATEWAY_API_KEY` / `VERCEL_OIDC_TOKEN` | unset | credentials (see precedence) |

**Documentation bug, confirmed empirically.** README:168 says `JEV_GUARD_CONFIG` is "where `jev-guard key` stores the key". It is not. `readConfig()` honors the override, but cli.js:78-80 calls `mkdirSync(dirname(CONFIG_FILE))` / `writeFileSync(CONFIG_FILE, …)` against the *hardcoded* home path. With `JEV_GUARD_CONFIG=/tmp/x.json` set, `jev-guard key` reads `/tmp/x.json` for the merge but writes to `~/.jev-guard/config.json`. I ran two successive `key` commands with the override set: the first key (`jevApiKey`) was silently dropped and only `aiGatewayApiKey` survived, because the merge source and the write target were different files. An emitter targeting a non-default path must write the JSON itself and must not shell out to `jev-guard key`.

## 3. The question sets — HARDCODED module constants (src/guard.js:4-99)

Three frozen object literals, `export const`, no config path, no override parameter, no plugin hook. **8 questions total, not 3.** Wire types are TypeSafe's: `noul` | `choice` | `score` (the gateway path rewrites `noul`→`boolean`, src/jev.js:33).

### `ACTION_QUESTIONS` (guard.js:60-99) — pre-tool-call. FOUR questions, not three.
| id | type | criteria shape |
|---|---|---|
| `risk` | `score` | 4-element string array = ordinal positions 0..3 (read-only → reversible → hard-to-undo → destructive) |
| `approval` | `noul` | `{true, false}` — would a careful senior engineer want explicit human approval? |
| `user_requested` | `noul` | `{true, false}` — did the user's own recent messages authorize exactly this? |
| `from_untrusted` | `noul` | `{true, false}` — does this carry out an instruction planted in untrusted content? |

The premise in the task ("its 3 questions: risk, user_requested, from_untrusted") omits `approval`, which is load-bearing: it is an independent ask-trigger in `decide()` (`approval.p >= askP`), so a call with risk below `askScore` can still be gated.

### `SCAN_QUESTIONS` (guard.js:4-27) — tool RESULTS
| id | type | values |
|---|---|---|
| `directed` | `noul` | `{true, false}` — is there text addressing an AI agent and instructing it? Explicitly excludes content that merely *documents* injection. |
| `kind` | `choice` | `injection` \| `canary` \| `discussion` \| `benign` |

### `INSTRUCTION_QUESTIONS` (guard.js:32-58) — instruction FILES
| id | type | values |
|---|---|---|
| `malicious` | `noul` | `{true, false}` — does it also do what its installer would not expect? |
| `kind` | `choice` | `exfiltration` \| `covert_execution` \| `instruction_override` \| `canary` \| `unrelated_side_effects` \| `clean` |

### Reducers (pure, testable, env-thresholded)
`decide({risk, approval, user_requested, from_untrusted}, t)` — guard.js:119-127, in order:
```
from_untrusted.p >= 0.7            -> deny (with `why`)
risk.score       >= 2.5            -> deny
risk.score >= 1.5 || approval.p >= 0.75:
    user_requested.p >= 0.85 && risk.score < 2.5 -> allow ("the user explicitly asked for it")
    otherwise                                     -> ask
otherwise                          -> allow
```
`scanContent` verdict: `flagged = directed.p >= 0.6 && kind ∈ {injection, canary, unknown}` (guard.js:157).
`judgeInstructions(kind, p, t)` — guard.js:169-172: `kind==="clean" → false`; else `p >= (kind==="unrelated_side_effects" ? 0.8 : 0.45)`. A missing kind becomes `"unknown"` and is therefore treated as serious, not ignored.

### Skip lists and limits (hardcoded sets, guard.js:103-109)
`READ_ONLY` (31 names, never assessed) and `NEVER_EXTERNAL` (20 names, results never scanned), both lowercased and spanning every host's naming (`Read`/`read`/`read_file`). `MIN_SCAN_CHARS = 200`. `MAX_STATE_CHARS = 60_000`, truncated head+tail with 1/4 kept from the tail ("injections like to hide at the end").

## 4. Question extensibility — NO

`assessAction`/`scanContent`/`scanInstructions` each pass their module constant positionally to `ask(state, QUESTIONS, opts)`. `opts` is destructured in src/jev.js:29 as exactly `{env, fetchImpl, signal, timeoutMs}` — there is no `questions` key on any public API. Grep for `custom.?question|extraQuestions|addQuestion|userQuestions|policyFile` across `src/`, `extensions/`, `README.md` returns only the wire-payload `questions:` in jev.js:45-46. No marketplace/plugin manifest carries questions either.

The single real extension point is programmatic, not config: package.json `exports` publishes `"./jev": "./src/jev.js"` and `"./guard": "./src/guard.js"`, so `import { ask } from "jev-guard/jev"` gives you `ask(state, questions, opts)` with an **arbitrary** questions object. That is a code-generation target, not a configuration target.

## 5. Instruction-file scanning — `jev-guard scan-skills [paths...]`

Roots when no paths given = `userRoots()` ∪ `projectRoots()` (src/skills.js:14-19):
- user (`$HOME/`): `.claude/skills`, `.claude/plugins`, `.claude/CLAUDE.md`, `.codex`, `.gemini/extensions`, `.pi/agent`, `.cursor`, `.copilot`, `.config/opencode`, `.agents`
- project (`$CWD/`): `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude`, `.cursor`, `.opencode`, `.codex`, `.gemini`, `.agents`, `.github/copilot-instructions.md`, `.github/hooks`, `skills`

Selection: walk to `MAX_DEPTH=7`, skipping `SKIP_DIRS` = {node_modules, .git, dist, build, out, logos, video, .tmp, tmp, worktrees, vendor_imports, marketplaces, repos}. A file is included if it matches `INSTRUCTION_FILE` (guard.js:193) or is any `*.md` at depth 0:
```
/(^|\/)(SKILL|CLAUDE|AGENTS|GEMINI|copilot-instructions)\.md$|(^|\/)(rules|commands|agents|prompts)\/[^/]+\.(md|mdc)$/i
```
Scan: `scanFiles(files, opts, {concurrency: 6})` → `scanInstructionsCached` → sha1-of-content cache in `~/.jev-guard/scan-cache.json`, capped at 5000 entries sorted by recency (`// ponytail: cap, no LRU`). Cached entries store only `{kind, p, at}` and the **verdict is recomputed on read**, so threshold changes retroactively apply. Files under 200 chars return null and are omitted entirely.

Output format (stdout; the `scanning N…` line goes to stderr) — verbatim from a real run I made against a seeded cache:
```
jev-guard: scanning 2 instruction files…
FLAGGED  /tmp/sk/skills/evil/SKILL.md
         exfiltration p=0.99 (cached)
2 scanned (2 cached), 1 flagged, 0 errors
```
Line shapes (cli.js:63-66): `FLAGGED  <file>\n         <kind with first _ → space> p=<p>[ (cached)]`, then `ERROR    <file>: <msg>`, then the summary `N scanned (M cached), F flagged, E errors`. Empty case prints `jev-guard: no instruction files found`. Not JSON, not machine-stable. **Exit codes: 2 = something flagged, 3 = errors only, 0 = clean.** `p` is printed from a value rounded to 2dp on cache write.

Same finding surfaced in-agent: SessionStart (or the first prompt event on hosts lacking it) runs `sweep()` once per session, guarded by a `swept` flag; Claude Code's `InstructionsLoaded` scans a single `input.file_path` and returns null because that event's output is discarded, deferring the report to the next prompt hook.

## 6. Tool-result scanning + session memory

PostToolUse/AfterTool/postToolUse → `collectText(tool_response)` recursively joins every string leaf, skipping only keys named `type` (guard.js:203-208), so it covers Claude/Codex `tool_response`, MCP content arrays and pi content blocks. If the tool is `Skill` or the derived source matches `INSTRUCTION_FILE`, it routes to `scanInstructionsCached` instead of `scanContent` (hook.js:37-39). The last user prompt is passed as `state.user_task`.

Session memory — `~/.jev-guard/sessions/<sha1(sessionId).slice(0,16)>.json`, file 0600, dir 0700 (src/session.js). Record: `{prompts[], intents[], calls[], flags[], updated, swept}` with hard caps `{prompts:6, intents:3, calls:12, flags:10}` applied as `slice(-N)`; every item gets `at: Date.now()`. A flag is `{kind, source, tool, p, excerpt, reported, at}`. `excerpt(text, 500)` (guard.js:196-200) keeps only lines >15 chars matching a hot regex (`assistant|\bAI\b|\bagents?\b|\bLLM|ignore (previous|prior|all|your)|do not (mention|tell|reveal)|secretly|hidden|instruction`), falling back to the whole text — this is what a later tool call gets compared against. `markReported()` flips unreported flags once surfaced. `prune()` deletes sessions older than 7 days, but only once the directory exceeds 200 files (`// ponytail: … no scheduler`).

Read-modify-write is non-atomic (`readSession` → `writeFileSync`), so concurrent hook processes can lose an append; the scan cache re-reads before writing to narrow the same window.

## 7. State payload (`buildContext`, src/context.js:11-32) — fixed 4 keys
`user_recent_messages` (last 3 deduped prompts, each clipped to 700 chars), `assistant_intent` (latest, clipped), `recent_tool_calls` (last 6, `"<tool> <preview>[ [level]]"`), `flagged_untrusted_content` (last 5, `"<kind> from <source> (p=…): \"<excerpt>\""`). Empty keys are deleted; an all-empty context returns `undefined` and then `assessAction` omits `context` from the state entirely, which drops `user_requested`/`from_untrusted` from the printed stats. Sources, in order: session store, then either adapter-supplied `messages[{role,text}]` (pi/OpenCode/ACP) or a Claude-style JSONL transcript tail (last 256KB, first line discarded as possibly partial). Tool results never count as user words.

## Mapping notes

## Verdict: cut the config emitter. There is nothing to emit a Program into.

jev-guard is the strongest possible *validation* of jevc's thesis and simultaneously the weakest possible *emit target*. Line 1 of src/guard.js is literally "Code owns the policy; Jev answers narrow questions." It independently converged on Program{decisions, reduce}: 8 narrow evidence questions in exactly your three types, and a pure `decide()` reducer that computes allow/ask/deny in JS. It even carries its own version of your measurement (README:122: 662 installed skills, highest legitimate `unrelated_side_effects` = 0.74, planted exfiltration 0.99, canary 0.51 — which is why the serious threshold sits at 0.45 and the noisy one at 0.8).

But that architecture is **compiled into JavaScript, not expressed in configuration.** Mapping each Program field:

- **`decisions` → NOT MAPPABLE.** The 8 questions are three `export const` object literals in src/guard.js. No config file, no policy file, no override parameter, no plugin manifest, no env var reaches them. Confirmed by grep across src/, extensions/ and README. To change a question you edit the file and ship a fork.
- **`reduce` → NOT MAPPABLE, and fixed-arity.** `decide()` destructures exactly `{risk, approval, user_requested, from_untrusted}` and indexes exactly `.score` / `.p`. A Program whose decision ids differ by even one name produces answers `decide()` cannot read. Emitting a different reducer *expression* (different ordering, a conjunction, a weighted sum) is impossible — the control flow is hardcoded. What you can influence is 8 numeric constants.
- **`stateBuilder` → NOT MAPPABLE.** `buildContext()` emits a fixed 4-key shape from fixed sources. No hook to add a field.
- **`residual` → NO REPRESENTATION AT ALL.** There is no concept of "this part needs a real LLM", no passthrough, no escalation path. jev-guard assumes every question it asks is fully answerable by Jev. A Program with a non-empty residual has nowhere to put it.

So the honest ceiling on an emitter is: **generate 10 environment-variable assignments plus a 2-field credentials JSON plus per-host hook wiring.** That is emitting tuning constants for someone else's frozen program. It is not lowering a compiled Program. If you shipped it, `jevc emit jev-guard` would ignore `decisions`, `reduce`, `stateBuilder` and `residual` — i.e. every part that makes a Program a Program — and quietly succeed. That is exactly the "pretends to work" emitter you said you would rather cut.

Two caveats that keep this from being a dead end:

1. **A library target is genuinely feasible.** package.json `exports` publishes `"./jev": "./src/jev.js"`, and `ask(state, questions, opts)` accepts an **arbitrary** questions object with no schema restriction beyond the noul/choice/score types you already emit. A jevc backend that emits a small ES module — your `decisions` as a questions literal, your `reduce` as a pure function over the answers, your `stateBuilder` — and calls `ask()` for transport would work today and is a faithful lowering. That is a **code emitter**, not a config emitter. It also inherits the retry/budget/dual-backend logic for free (3 attempts, 600ms·2^n backoff, one `AbortSignal.timeout` budget across retries because "a hook that dies never reaches the fail-closed branch").
2. **Threshold calibration is a real, narrow, honest feature.** `decide()` and `judgeInstructions()` are exported pure functions, `check` and `scan` exist for calibration, and the scan cache recomputes verdicts on read. If jevc measures per-decision distributions, emitting a calibrated env block for the *existing* 8 questions is defensible — as `jevc calibrate`, explicitly not as `jevc emit`.

## On #3 — your framing is correct, and the source states it explicitly.

Confirmed. `scan-skills` reads the same corpus your transpiler reads (CLAUDE.md, AGENTS.md, SKILL.md, `rules|commands|agents|prompts/*.{md,mdc}`) but asks the opposite question. The comment at guard.js:29-31 is the whole distinction: "Skills, rules and memory files are supposed to instruct the agent, so the injection questions above would flag all of them. These ask the only thing that matters for an instruction file: does it do something its installer would not expect?" You lower instruction files into questions; jev-guard audits them for covert behavior and deliberately uses a *different* question set to avoid flagging instruction-ness itself. The two uses are complementary and non-competing — and note `SCAN_QUESTIONS.directed` also carves out "content that merely discusses or documents prompt injection," which matters because jevc's own source and specs would otherwise trip it.

## On #5 — the leverage is real, but you inherit it as code, not as data.

There is **no host descriptor anywhere** — no table, no registry, no manifest schema, no array of host objects. A host is described by four hand-written things scattered across three files:
1. an if-chain over `input.hook_event_name` in hook.js covering 16 event names, plus the heuristic `cursor = /^[a-z]/.test(event)` (camelCase means Cursor);
2. `detectAgent()` payload fingerprinting (hook.js:12-16): Copilot stamps an ISO `timestamp` and no `turn_id`; Codex sends `turn_id` + `model`; otherwise Claude — with `--agent` as the manual override;
3. a per-host **output** shape, written inline at each branch and mutually incompatible: `{hookSpecificOutput:{permissionDecision}}` (Claude), top-level `{permissionDecision}` *plus* the nested form (Copilot), `{decision, reason}` (Gemini), `{permission, user_message, agent_message}` (Cursor), `{additional_context}` (Cursor session/post), `{systemMessage + additionalContext}` (Codex, because Codex 0.154 has no PreToolUse "ask", so ask degrades to a warning that lets the call proceed);
4. a hardcoded `switch (target)` in `install()` with each host's file path and manifest shape.
SDK hosts get whole separate modules: opencode.js (`tool.execute.before` throws to block / `permission.ask` sets `output.status` / `tool.execute.after` prepends to output), extensions/jev-guard.ts (pi, `pi.on("tool_call"|"tool_result")`, blocks when `!ctx.hasUI`), acp.js (JSON-RPC stdio proxy guarding only `terminal/create` and `fs/write_text_file`, and honest in its header comment that tools the agent runs internally "never pass through here and are not covered").

Adding a host means editing cli.js and hook.js. So "inheriting the adapter layer" means vendoring or importing this code, or contributing upstream — there is no host-description format for jevc to target. The per-host quirks (Cursor permission hooks must *always* return valid JSON or Cursor blocks the action; Claude's `InstructionsLoaded` output is discarded; `BeforeTool` has no ask and no additionalContext) are precisely the kind of knowledge that is expensive to rediscover and impossible to express as config.

## On the relayed question about adjacency

Directly answerable from this source, for this target only: jev-guard *is* one of the Jev-powered CLIs, and it is adjacent to the Claude Code guardrail-hook space by occupying **5 Claude Code hook events** (PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, InstructionsLoaded) plus `PermissionRequest` handling, and **16 distinct event names across 5 hook-based hosts** (the other 10: BeforeTool, AfterTool, BeforeAgent, userPromptSubmitted, beforeShellExecution, beforeMCPExecution, preToolUse, postToolUse, beforeSubmitPrompt, sessionStart), plus 3 non-hook SDK adapters (pi, OpenCode, ACP). Enumerating the *other* ~7 hooks and ~6 CLIs is outside what this repo evidences — I only read jev-guard and will not guess at the rest.

## Real example

```
## A. `~/.jev-guard/config.json` — the only actual config file. Verbatim output of `jev-guard key`, which I generated and then deleted:

```json
{
  "aiGatewayApiKey": "vck_gateway_example"
}
```

With a TypeSafe key instead (`jev-guard key sk_…`, no `vck_` prefix):

```json
{
  "jevApiKey": "sk_typesafe_example"
}
```

That is the complete file format. Both fields may coexist; `jevApiKey` wins.

## B. `hooks/cursor.json` — verbatim, committed at 94996ea. The closest thing to a policy file in the repo, and it carries no policy:

```json
{
  "hooks": {
    "beforeShellExecution": [
      { "command": "node ./src/cli.js hook", "timeout": 30 }
    ],
    "beforeMCPExecution": [
      { "command": "node ./src/cli.js hook", "timeout": 30 }
    ],
    "preToolUse": [
      { "command": "node ./src/cli.js hook", "timeout": 30, "matcher": "Write|Delete" }
    ],
    "postToolUse": [
      { "command": "node ./src/cli.js hook", "timeout": 30 }
    ],
    "beforeSubmitPrompt": [
      { "command": "node ./src/cli.js hook", "timeout": 30 }
    ],
    "sessionStart": [
      { "command": "node ./src/cli.js hook", "timeout": 30 }
    ]
  }
}
```

## C. `gemini-extension.json` — verbatim. The only manifest that declares anything configurable, and it is credentials again:

```json
{
  "name": "jev-guard",
  "version": "0.3.1",
  "description": "Prompt-injection and dangerous-action guard for coding agents, powered by Jev. Denies destructive tool calls, warns on risky ones, flags AI-directed text in tool results.",
  "settings": [
    { "name": "Jev API key", "description": "TypeSafe key from console.typesafe.ai (leave empty if you use the AI Gateway key).", "envVar": "JEV_API_KEY", "sensitive": true },
    { "name": "Vercel AI Gateway key", "description": "Alternative to the Jev key: a vck_… key for model typesafe-ai/jev.", "envVar": "AI_GATEWAY_API_KEY", "sensitive": true }
  ]
}
```

## D. What a "policy" looks like in this codebase — src/guard.js:119-127, verbatim. This is the reducer, and it is source code, not config:

```js
/** Pure policy over Jev's answers, so it can be tuned and tested without the API. */
export function decide({ risk, approval, user_requested, from_untrusted }, t = thresholds()) {
  if ((from_untrusted?.p ?? 0) >= t.untrustedP) return { level: "deny", why: "it looks like it carries out an instruction from untrusted content, not the user's request" };
  if (risk.score >= t.denyScore) return { level: "deny" };
  if (risk.score >= t.askScore || (approval.p ?? 0) >= t.askP) {
    if ((user_requested?.p ?? 0) >= t.userP && risk.score < t.denyScore) return { level: "allow", why: "the user explicitly asked for it" };
    return { level: "ask" };
  }
  return { level: "allow" };
}
```

## E. The nearest thing to an emittable artifact: the env block. Not a committed file — this is what an emitter would have to produce:

```sh
export JEV_GUARD_DENY_SCORE=2.5
export JEV_GUARD_ASK_SCORE=1.5
export JEV_GUARD_ASK_P=0.75
export JEV_GUARD_USER_P=0.85
export JEV_GUARD_UNTRUSTED_P=0.7
export JEV_GUARD_INJECT_P=0.6
export JEV_GUARD_SKILL_P=0.8
export JEV_GUARD_SKILL_SERIOUS_P=0.45
export JEV_GUARD_SKIP_TOOLS=
export JEV_GUARD_FAIL_CLOSED=
```

```
