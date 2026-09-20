# Emit target: @ai-sdk/typesafe-ai@3.0.3 (Target A, TS) + langchain-typesafe==0.0.1a2 (Target B, Python)

**Feasible:** True  
**Format:** ts + py (both targets are configured in code — neither tool reads a config file)  
**Pinned at:** TARGET A (installed from npm into /tmp/jevc-tgtA, read from `src/` which ships alongside `dist/`):
- `@ai-sdk/typesafe-ai@3.0.3` — Apache-2.0; `dist.shasum 5a6094d226bead93c0408acbb8abe0d112b96f24`; `dist.integrity sha512-pgoqSBqnabTfZwXF7zlEFCbksLLuI3iauZf4FrFioFIRY1YMFnoufLEG1kGQDVQCk8GvxG4gMti8kXYOE2lT1w==`; repo github.com/vercel/ai, directory `packages/typesafe-ai`; `engines.node >=22`; no `gitHead` field published for this version.
- `@ai-sdk/provider@4.0.17` — Apache-2.0; `gitHead 23c55190cdc3c52c94ea5fbf50ac2072593feab1`. Source of `Experimental_EvaluationModelV4` and all question/answer/result types.
- `@ai-sdk/provider-utils@5.0.44` (transitive, supplies `loadApiKey`, `postJsonToApi`, `WORKFLOW_SERIALIZE`).
- Files read: `src/index.ts`, `src/typesafe-ai-provider.ts`, `src/typesafe-ai-evaluation-model.ts` (183 lines), `src/typesafe-ai-evaluation-api.ts`, plus `@ai-sdk/provider/src/evaluation-model/v4/*.ts` and `src/shared/v4/*.ts`.
- In-source upstream pin (`typesafe-ai-evaluation-api.ts:4-5`): the wire schema is "Verified against the official SDK at 66880ccded6cb642dc1809620c2b108c33730214" — github.com/typesafe-ai/typesafe-sdk-js `src/types.ts`.
- Verified by execution under Node v22.18.0 with a stubbed `fetch` (no network, no API key): boolean→noul request mapping, noul→probability answer mapping, `providerMetadata.typesafe.confidence` population, empty-confidence case, `rounding`, `warnings` for `providerOptions.typesafe.*`, 256-option and 11-level `AI_InvalidArgumentError`s, unenforced score minimum, and `AI_LoadAPIKeyError`.

TARGET B (installed from PyPI into /tmp/jevc-tgtB venv, Python 3.10.10 — note `pip index versions` hides it; needs `--pre`):
- `langchain-typesafe==0.0.1a2` — MIT; "A LangChain integration for TypeSafe classifiers"; `Requires-Python >=3.10.0,<4.0.0`; only releases are `0.0.1a1`, `0.0.1a2`; `__version__ == "0.0.1a2"`.
- Per-file sha256 from the wheel RECORD: `classifier.py FbEWnDhmaVAeiNxZT-7EdpisZXTvwL6l61qxbKbJfs8` (18072 B), `types.py hBlxqnEjBY0GzXTc5pt7Xx0sKFoIWgJPs0pcGhmGeZE` (11148 B), `experimental/middleware/auto_mode.py Nn6ICTUJgaY9tYeLPwR91ffcWTMmcWFCN7EqYQrapa4` (9108 B), `experimental/middleware/model_router.py VOWjys4pGWwNbLoyxNsq_tXgBXAtGXjlXbNvS4sl8x4` (6891 B).
- Base deps `httpx2>=2.0.0,<3.0.0`, `langchain-core>=1.6.2,<2.0.0`; extra `experimental` → `langchain>=1.3.15,<2.0.0`. Resolved: `langchain-core==1.6.3`, `httpx2==2.13.0`, `pydantic==2.14.0b2`, `langchain==1.4.1`, `langgraph==1.2.11`.
- Files read: `__init__.py`, `_version.py`, `types.py`, `classifier.py`, `client.py`, `_state.py`, `experimental/middleware/{__init__,auto_mode,model_router}.py` (1710 lines total).
- Verified by execution: `inspect.signature` on both middleware `__init__`s (no `threshold` param; `_PROBABILITY_THRESHOLD == 0.5`), the dead default-`criteria` path resolving to `None`, `ScoreAnswer.legend` required, `NoulAnswer` having no `confidence`, flat `answers` vs derived `nouls`/`choices`/`scores`, `min_length` validation on Choice/Score, and the exact `_payload()`/`_endpoint` output.

Grounded against this repository at the time of writing: `docs/design.md` §9, `fixtures/security-guardrails.json` (model `jev-1.13.0`, recorded 2026-09-18), and `.env.example`.

## File locations

Neither target has a config file format. There is nothing to emit a `.yaml`/`.json` policy into; both are configured by constructor arguments in source code, so the emitter output is a code artifact (a `.ts` module for A, a `.py` module for B), not a config file.

Runtime credential/endpoint resolution, in precedence order:

TARGET A (`createTypeSafeAi(options)`, typesafe-ai-provider.ts:31-45)
1. `options.apiKey` (explicit) → 2. `TYPESAFE_AI_API_KEY` env var → 3. throws `AI_LoadAPIKeyError` ("TypeSafe API key is missing. Pass it using the 'apiKey' parameter or the TYPESAFE_AI_API_KEY environment variable.")
- `options.baseURL` (trailing slash stripped) → hardcoded `https://api.typesafe.ai/v1`. NO env var for baseURL on this target.
- Endpoint: `POST {baseURL}/systemone` (verified live: `https://api.typesafe.ai/v1/systemone`)
- Fallback quirk: if `config.headers` is `undefined` the model re-loads the key from `TYPESAFE_AI_API_KEY` inside `doEvaluate` (evaluation-model.ts:95-103). Unreachable via `createTypeSafeAi` (it always supplies headers), reachable only if you construct `EvaluationTypeSafeAiModel` directly — which is NOT exported from `index.ts`.

TARGET B (`TypeSafeClassifier(...)`, classifier.py:163-201)
1. `api_key=` ctor arg → 2. `TYPESAFE_API_KEY` env var → 3. `ValueError` ("TypeSafe API key is required. Pass `api_key` or set `TYPESAFE_API_KEY`.")
1. `base_url=` ctor arg → 2. `TYPESAFE_BASE_URL` env var → 3. `https://api.typesafe.ai`
- Endpoint: `POST {base_url.rstrip('/')}/v1/systemone` (classifier.py:437)
- LangChain serialization maps the secret via `lc_secrets = {"api_key": "TYPESAFE_API_KEY"}`; namespace `["langchain","classifiers","typesafe"]`.

ENV VAR NAME COLLISION — matters for jevc: A wants `TYPESAFE_AI_API_KEY`, B wants `TYPESAFE_API_KEY`. This repo's `.env.example` carries only `TYPESAFE_API_KEY`, the native/Target-B name, so an emitted Target A artifact would fail with `AI_LoadAPIKeyError` in an environment set up for jevc itself.

**Resolved.** `src/emit/ai-sdk.ts` emits `apiKey: process.env.TYPESAFE_AI_API_KEY ?? process.env.TYPESAFE_API_KEY`, so either name works; the reason is recorded in a comment there so it survives a refactor of this file.

## Schema

All types below are transcribed from installed source and then verified by execution (stubbed `fetch` for A, pydantic validation + `inspect.signature` for B).

# TARGET A — @ai-sdk/typesafe-ai@3.0.3

## A.1 Provider options — EXACT (`src/typesafe-ai-provider.ts`)

```ts
export interface TypeSafeAiProviderSettings {
  /** API key. Defaults to the TYPESAFE_AI_API_KEY environment variable. */
  apiKey?: string;
  /** API base URL. Defaults to https://api.typesafe.ai/v1. */
  baseURL?: string;
  headers?: Record<string, string>;
  fetch?: FetchFunction;
}
export function createTypeSafeAi(
  options: TypeSafeAiProviderSettings = {},
): TypeSafeAiProvider;
export const typeSafeAi: TypeSafeAiProvider;      // module-level default instance
export interface TypeSafeAiProvider extends ProviderV4 {
  evaluationModel(modelId: TypeSafeAiEvaluationModelId): EvaluationModelV4;
}
export type TypeSafeAiEvaluationModelId = 'jev-latest' | (string & {});
```
Exactly 4 options — no `maxRetries`, no `timeout`, no `model` default. `languageModel`/`embeddingModel`/`imageModel` all throw `NoSuchModelError`. Public exports (`src/index.ts`) are exactly: `createTypeSafeAi`, `typeSafeAi`, `VERSION`, and types `TypeSafeAiProvider`, `TypeSafeAiProviderSettings`, `Experimental_TypeSafeAiEvaluationModelId`. `EvaluationTypeSafeAiModel` is **not** exported.

## A.2 QUESTION type — EXACT, emit this (`@ai-sdk/provider@4.0.17` `evaluation-model-v4-question.ts`)

```ts
export type EvaluationModelV4Input =
  | string | Readonly<JSONObject> | readonly JSONValue[];

export type EvaluationModelV4Question =
  | { readonly type: 'choice';
      readonly instructions: EvaluationModelV4Input;
      /** Nonempty map of option names to descriptions. Null means no description. */
      readonly criteria: Readonly<Record<string, EvaluationModelV4Input | null>>; }
  | { readonly type: 'score';
      readonly instructions: EvaluationModelV4Input;
      /** At least two ordered levels, indexed from zero. */
      readonly criteria: readonly (EvaluationModelV4Input | null)[]; }
  | { readonly type: 'boolean';
      readonly instructions: EvaluationModelV4Input;
      readonly criteria?: { readonly true?:  EvaluationModelV4Input | null;
                            readonly false?: EvaluationModelV4Input | null; }; };
```
| field | type | required | notes |
|---|---|---|---|
| `type` | `'choice'\|'score'\|'boolean'` | yes | **`boolean`, not `noul`** — CONFIRMED |
| `instructions` | string \| JSONObject \| JSONValue[] | yes | structured JSON allowed |
| `criteria` (choice) | `Record<string, Input\|null>` | yes | 1–255 keys; `null` = no description |
| `criteria` (score) | `(Input\|null)[]` | yes | ≥2 documented, **max 10 enforced**; index 0-based |
| `criteria` (boolean) | `{true?, false?}` | **optional** | keys literally `true`/`false` |

Call options (`evaluation-model-v4-call-options.ts`):
```ts
export type EvaluationModelV4CallOptions = {
  state: EvaluationModelV4Input;                               // ONE shared state
  questions: Readonly<Record<string, EvaluationModelV4Question>>;
  abortSignal?: AbortSignal;
  headers?: Record<string, string>;
  providerOptions?: Record<string, JSONObject>;
};
```

Client-side validation, verified by execution (`doEvaluate` lines 71-87), thrown **before any I/O** as `AI_InvalidArgumentError`:
- choice `> 255` criteria keys → "TypeSafe Choice questions support at most 255 options."
- score `> 10` criteria levels → "TypeSafe Score questions support at most 10 levels."
- **NOT validated**: score with `< 2` levels. Verified: a 1-level score passed straight through to the wire. jevc must enforce `>= 2` itself.
- `supportedQuestionTypes === ['choice','score','boolean']` (readonly tuple).

## A.3 ANSWER type — EXACT (`evaluation-model-v4-result.ts`)

```ts
export type EvaluationModelV4Answer =
  | { type: 'choice'; choice: string;  probabilities?: Record<string, number>; }
  | { type: 'score';  score:  number;  probabilities?: Record<string, number>; }
  | { type: 'boolean'; probability: number; };   // P(true); NOT confidence

export type EvaluationModelV4Result = {
  answers: Record<string, EvaluationModelV4Answer>;
  rounding?: { probabilityDecimals?: number; scoreDecimals?: number };
  usage?: { inputTokens?: number; outputTokens?: number };
  warnings: SharedV4Warning[];                 // REQUIRED (array, may be empty)
  providerMetadata?: Record<string, JSONObject>;
  response?: { id?: string; timestamp?: Date; modelId?: string;
               headers?: Record<string,string>; body?: unknown };
};
```
- **`probability`, not `noul`** — CONFIRMED (mapping at evaluation-model.ts:145).
- **`legend` is DROPPED** — CONFIRMED: the score answer has no `legend` field. jevc must retain its own level→description map to interpret a fractional score.
- `probabilities` is `?optional` in the interface but **this provider always populates it** for choice and score (it passes through a non-optional wire field, `z.record(z.string(), z.number())`). Verified live.
- score `probabilities` keys are **strings** of 0-based level indices (`"0"`,`"1"`,…), not numbers.
- `rounding` is hardcoded: `{ probabilityDecimals: 2, scoreDecimals: 2 }`.
- `warnings`: one `{type:'unsupported', feature:'providerOptions.typesafe.<key>'}` per key under `providerOptions.typesafe` — **every** key warns; no provider options exist. Verified: two keys → two warnings.
- Errors: `APICallError` via `createJsonErrorResponseHandler`; message precedence `message ?? error(.message) ?? detail ?? error_type ?? 'TypeSafe request failed'`.
- Workflow serialization supported via `WORKFLOW_SERIALIZE`/`WORKFLOW_DESERIALIZE` statics; a custom `fetch` is not serialized.

## A.4 ⚠ THE CRITICAL ANSWER — confidence is NOT dropped, it is RELOCATED

Your premise is half wrong, and the half that's wrong is the half that saves the emitter.

`confidence` survives on the result object at an exact, typed address (evaluation-model.ts:131-137, 175):
```ts
const confidence = Object.fromEntries(
  Object.entries(response.answers).flatMap(([id, answer]) =>
    answer.type !== 'noul' && answer.confidence != null ? [[id, answer.confidence]] : [],
  ),
);
// ...
providerMetadata: { typesafe: { confidence } },
```
**Type: `result.providerMetadata.typesafe.confidence: Record<questionId, number>`** — statically `JSONObject`, so jevc must emit a narrowing cast/guard.

Verified live end-to-end with a stubbed wire response:
```
=== RESULT.answers ===        (legend absent; distributions intact)
 action_class:  { type:'choice', choice:'destructive',
                  probabilities:{destructive:0.95, read_only:0.03, other:0.02} }
 blast_radius:  { type:'score', score:2.87,
                  probabilities:{'0':0.01,'1':0.04,'2':0.02,'3':0.93} }
 ambiguous_intent:{ type:'choice', choice:'allow',
                  probabilities:{allow:0.42, block:0.35, ask:0.23} }
 mentions_credentials:{ type:'boolean', probability:0.96 }
=== rounding === {"probabilityDecimals":2,"scoreDecimals":2}
=== providerMetadata ===
 { "typesafe": { "confidence": { "action_class":0.94, "blast_radius":0.93,
                                 "ambiguous_intent":0.13 } } }
```
So, precisely:
1. **choice + score: confidence is available directly.** Your uncertainty rules carry over unchanged, no recomputation needed. (The 0.13 low-confidence case round-trips exactly — the same number as your measured collapsed-verdict distribution.)
2. **The full probability distribution is ALSO available** for every choice and score answer, so confidence is independently recomputable client-side if you prefer your own concentration metric.
3. **boolean/noul has no confidence anywhere, by design** — and this is not the Vercel adapter's doing: the wire schema itself is `z.object({ type: z.literal('noul'), noul: z.number() })`, with no `confidence` field. Same on Target B (`NoulAnswer` has no `confidence` field; verified it silently ignores an extra `confidence` key). A noul's distribution is fully determined by `p` as `{true: p, false: 1-p}`, so any margin-style confidence is `|2p-1|` and derivable. **Nothing is lost that exists natively.**
4. **Two real degradations to encode:**
   - `confidence[id]` is **absent, not null**, when the wire returns `confidence: null` — the `flatMap` drops the entry entirely. Verified: `{"typesafe":{"confidence":{}}}`. Emitted code must treat `undefined` as "recompute from `probabilities`", never as `0`.
   - probabilities/scores are **rounded to 2dp** and consequently **may not sum to exactly 1**. Entropy-style confidence recomputed from 2dp values is quantized; threshold comparisons near a boundary can flip. Prefer the provider's own `confidence` when present and only fall back to recomputation.

**Verdict: this emitter carries jevc's uncertainty semantics in full. It does not need to degrade.** The only genuine information loss on Target A is `legend`.

---

# TARGET B — langchain-typesafe==0.0.1a2

## B.1 Question constructors — EXACT (`langchain_typesafe/types.py`)

Pydantic `BaseModel`s, so all are **keyword-only in practice** and validated at construction:
```python
class NoulCriteria(BaseModel):          # model_config = ConfigDict(populate_by_name=True)
    true:  JsonValue = None
    false: JsonValue = None

class Noul(BaseModel):
    type: Literal["noul"] = "noul"
    instructions: str | dict[str, JsonValue] | list[JsonValue]   # REQUIRED
    criteria: NoulCriteria | None = None

class Choice(BaseModel):
    type: Literal["choice"] = "choice"
    criteria: dict[str, JsonValue] = Field(min_length=1)         # REQUIRED, >=1 label
    instructions: str | dict[str, JsonValue] | list[JsonValue]   # REQUIRED

class Score(BaseModel):
    type: Literal["score"] = "score"
    criteria: list[JsonValue] = Field(min_length=2)              # REQUIRED, >=2 levels
    instructions: str | dict[str, JsonValue] | list[JsonValue]   # REQUIRED

Question = Annotated[Noul | Choice | Score, Field(discriminator="type")]
```
Verified by execution: `Choice(criteria={})` → `too_short`; `Score(criteria=['only'])` → `too_short`; `Noul()` → `missing`. Note B enforces the score `>=2` minimum that A does **not**, but B does **not** enforce A's 255/10 upper bounds — they are complementary, so jevc should enforce `1..255` and `2..10` itself and rely on neither.

## B.2 `TypeSafeClassifier` — EXACT (`langchain_typesafe/classifier.py`)

`@beta()` `RunnableSerializable[State, ClassificationResponse]`, `ConfigDict(extra="forbid", arbitrary_types_allowed=True, validate_default=True)` — an unknown kwarg is a hard error, so the emitter must emit exactly these seven fields:
```python
TypeSafeClassifier(
    questions:    dict[str, Question]          = Field(min_length=1),   # REQUIRED
    model:        str                          = "jev-latest",          # stripped; non-empty
    api_key:      SecretStr | str              = env TYPESAFE_API_KEY,
    base_url:     str                          = env TYPESAFE_BASE_URL | "https://api.typesafe.ai",
    timeout:      float                        = 30.0,                  # gt=0
    client:       httpx2.Client | None         = None,                  # auto-created
    async_client: httpx2.AsyncClient | None    = None,                  # auto-created
)
```
`State: TypeAlias = str | BaseMessage | Sequence[_StateValue] | dict[str, _StateValue]` — a bare `int`/`float`/`bool`/`None` root raises `TypeError` (`_state.py:46`). `BaseMessage` is accepted at the root or at any depth and serialized to role/content JSON via `convert_to_openai_messages`.

Runnable surface: `invoke(input, config=None, **_)`, `ainvoke(...)`, plus inherited `batch`/`abatch`. Tracing metadata is injected automatically (`ls_provider="typesafe"`, `ls_model_name=self.model`, `ls_model_type="chat"`, `run_type="llm"`).

Emitted wire payload — verified by calling `_payload()` directly:
```json
{"state": {"tool_call": {"name": "rm_rf"}},
 "model": "jev-latest",
 "questions": {
  "mentions_credentials": {"type":"noul","instructions":"Does it touch credentials?",
                           "criteria":{"true":"reads or writes a secret","false":"no secret access"}},
  "action_class": {"type":"choice","criteria":{"destructive":"deletes data","read_only":"reads only","other":null},
                   "instructions":"Classify the action."},
  "blast_radius": {"type":"score","criteria":["none","single file","directory","whole system"],
                   "instructions":"How wide is the blast radius?"}}}
```
This is **byte-identical in shape to jevc's own fixtures** (`fixtures/security-guardrails.json` uses `"type":"noul"` with `criteria:{true,false}`). `exclude_none=True` strips only unset *model fields*, so an explicit `None` description inside a `criteria` dict survives as `null` — verified (`"other": null`).

## B.3 Answers — flat AND grouped (your premise needs correcting)

```python
class NoulAnswer(BaseModel):
    type: Literal["noul"]; noul: float = Field(ge=0.0, le=1.0)          # NO confidence field

class ChoiceAnswer(BaseModel):
    type: Literal["choice"]; choice: str
    probabilities: dict[str, float]                                      # REQUIRED
    confidence: float = Field(ge=0.0, le=1.0)                            # REQUIRED

class ScoreAnswer(BaseModel):
    type: Literal["score"]; score: float
    legend: dict[int, JsonValue]                                         # REQUIRED
    probabilities: dict[int, float]                                      # REQUIRED, int keys
    confidence: float = Field(ge=0.0, le=1.0)                            # REQUIRED

class ClassificationResponse(BaseModel):
    model: str
    answers: dict[str, Answer]          # <-- FLAT, and it is the real storage
    usage: Usage = Field(default_factory=Usage)   # input_tokens/output_tokens: int|None
    request_id: str | None = None                 # from response header
    @property nouls   -> dict[str, NoulAnswer]    # derived filter
    @property choices -> dict[str, ChoiceAnswer]  # derived filter
    @property scores  -> dict[str, ScoreAnswer]   # derived filter
```
**Correction: `result.answers[id]` DOES exist and is the primary field.** `nouls`/`choices`/`scores` are read-only `@property` views computed by `isinstance` filtering — not the storage layout, and not a replacement. Verified: flat keys `['c','n','s']`; grouped views `['n'] ['c'] ['s']`. jevc can emit flat `answers[id]` access and stay type-correct; the grouped views are a convenience that also narrows the static type, which is why the middleware uses them.

**Target B is strictly richer than Target A**: `confidence` is inline and *required* on choice/score, and `legend` is inline and *required* on score (verified: omitting `legend` → pydantic `missing`, proving the wire genuinely returns it and only the Vercel adapter discards it). Score `probabilities` keys are `int` here vs `str` on A.

Errors (`client.py`): `TypeSafeAPIError`, `TypeSafeAPIConnectionError`, `TypeSafeAPITimeoutError`, `TypeSafeAPIResponseValidationError`.

## B.4 `ModelRouterMiddleware` — EXACT (`experimental/middleware/model_router.py`)

```python
@dataclass(frozen=True)
class ModelChoice:
    model: str | BaseChatModel        # positional ok; str goes through init_chat_model()
    criteria: JsonValue

class ModelRouterMiddleware(AgentMiddleware[_ModelRouterState]):
    def __init__(self, *, choices: Mapping[str, ModelChoice],
                          instructions: str | dict[str, JsonValue] | list[JsonValue]) -> None
```
Signatures confirmed by `inspect.signature`. Both params are **keyword-only**; `choices` needs `min_length=1`. Internally builds exactly one question:
```python
_QUESTION_ID = "model_route"
Choice(instructions=self.config.instructions,
       criteria={route: choice.criteria for route, choice in self.config.choices.items()})
```
Hooks: `before_agent`/`abefore_agent` classify **the latest `HumanMessage` only**, once per agent run, and store the whole `ChoiceAnswer` at `state["model_route"]`; `wrap_model_call`/`awrap_model_call` then do `handler(request.override(model=self.models[answer.choice]))`. `trace_policy = TracePolicy(process_inputs=omit_payload)`.

## B.5 `AutoModeMiddleware` — EXACT (`experimental/middleware/auto_mode.py`)

```python
class AutoModeMiddleware(AgentMiddleware[AgentState[ResponseT], ContextT, ResponseT]):
    def __init__(self, *, tools: Sequence[str | BaseTool],          # min_length=1
                          instructions: str = _DEFAULT_INSTRUCTIONS,
                          criteria: NoulCriteria | None = None) -> None
```
Confirmed by `inspect.signature` — **exactly three keyword-only params. There is no `threshold`.** Internals, all hardcoded module constants:
```python
_QUESTION_ID = "is_risky"          # single question, fixed id, Noul only
_PROBABILITY_THRESHOLD = 0.5       # module constant, NOT a parameter
_DEFAULT_BLOCKED_MESSAGE = "The tool call `{tool_name}` was blocked because it was \
classified as risky (probability: {probability:.2f}). The tool was not executed."
```
`wrap_tool_call`: unlisted tool name → straight to `handler`; otherwise `probability = response.nouls["is_risky"].noul`, and `probability >= 0.5` → error `ToolMessage(status="error")`, else `handler(request)`. State is hardcoded: `{"messages": state["messages"][-30:], "tool_call": {id,name,args}}` plus `"tool_description"` when the tool has one. The classifier is built as `TypeSafeClassifier(questions={...})` with **no** `model`/`api_key`/`base_url` pass-through, so those are env-only. `trace_policy = TracePolicy(process_inputs=omit_payload)`.

Install requirement for both middlewares: `pip install "langchain-typesafe[experimental]"` → `langchain>=1.3.15,<2.0.0` (resolved `langchain==1.4.1`, `langgraph==1.2.11`). Bare `langchain-typesafe` raises `ImportError` on the middleware import — verified.

## Mapping notes

## Program → Target A: FULL FIDELITY. Ship this emitter.

| Program part | Maps to | Fidelity |
|---|---|---|
| `decisions[]` noul | `{type:'boolean', instructions, criteria?:{true,false}}` | exact (rename only) |
| `decisions[]` choice | `{type:'choice', instructions, criteria:Record<string,Input\|null>}` | exact (1..255) |
| `decisions[]` score | `{type:'score', instructions, criteria:(Input\|null)[]}` | exact (cap 10) |
| `stateBuilder` | `state:` — one shared `string\|JSONObject\|JSONValue[]` | exact |
| `reduce` | **plain TS after `await doEvaluate`** | exact — the backend has no verdict concept, which is precisely what you want |
| uncertainty on choice/score | `providerMetadata.typesafe.confidence[id]` + `answers[id].probabilities` | exact |
| uncertainty on noul | `answers[id].probability` only | no native confidence exists on either target; derive `\|2p-1\|` |
| `residual` | not representable | emit as a comment/separate LLM call; nothing on this target emits text |

Your architecture is a *better* fit here than the SDK's own framing: `EvaluationModelV4` has no verdict primitive at all, so "evidence questions + reduce in code" is the only expressible shape. The measured collapsed-verdict failure (allow 0.42 / block 0.35 / ask 0.23 @ 0.13) is not even encodable as a first-class thing to get wrong.

Three things the emitter must actively handle:
1. **`legend` is dropped.** Keep jevc's own level→description map beside the emitted code; a bare `score: 2.87` is uninterpretable without it. Target B keeps `legend`; A does not. Do not let the two emitters share an answer-decoding path.
2. **`confidence[id]` may be absent** (not null) — fall back to recomputing from `probabilities`, never to `0`.
3. **2dp rounding**; distributions may not sum to 1. Do not assert `sum === 1`. Your `read-result-test-exfiltration-py` bimodality check (mass at extremes, empty middle) works fine on 2dp data — it reads shape, not precision.

Prefer `createTypeSafeAi({apiKey})` over the `typeSafeAi` singleton in emitted code: the singleton is constructed at module load and its `loadApiKey` is deferred into the headers thunk, so an import with no key set is fine but every call throws. Also emit nothing under `providerOptions.typesafe` — every key produces an `unsupported` warning.

## Program → Target B `TypeSafeClassifier`: FULL FIDELITY, and the best target of the two.

Near-identity mapping — `noul` stays `noul`, `criteria:{true,false}` stays as-is, and the emitted payload is shape-identical to `fixtures/*.json`. Strictly more information comes back than on A: `confidence` inline and required on choice/score, `legend` inline and required on score. `reduce` is ordinary Python reading `result.answers[id]` (flat access is fine — the grouped views are just `@property` filters). `stateBuilder` maps onto `State` directly and gets `BaseMessage` serialization for free at any nesting depth. Emit `questions=` + `model=` and let `api_key`/`base_url` come from env; `extra="forbid"` means a stray kwarg is a hard error, so emit only the seven documented fields.

## Program → Target B middleware: THIS IS WHERE THE HONEST CEILING IS.

Your spec §9 pre-registered the risk ("if a tool's question set is hardcoded rather than policy-defined, the emitter can only emit thresholds… any emitter in that position gets cut"). I verified it, and for `AutoModeMiddleware` reality is **worse than that test**: you cannot even emit the threshold.

### `AutoModeMiddleware` — CUT IT. Not a viable Program target.
- **Question set is hardcoded**: exactly one question, fixed id `is_risky`, `Noul` only. A Program with 5–7 evidence questions (your corpus averages 6.4) cannot be expressed. There is no `questions=` parameter.
- **`reduce` is not emittable and the threshold is not a parameter**: `_PROBABILITY_THRESHOLD = 0.5` is a module constant; `inspect.signature` confirms no `threshold` kwarg. The docstring references "`threshold`" and the `Raises:` block says "if tool names or threshold configuration is invalid" — both are stale, describing a parameter that does not exist. So the emitter cannot emit questions **or** thresholds. It can only emit `tools=[...]`, one `instructions` string, and one `NoulCriteria`.
- **The verdict space is binary.** Allow/block only; the docstring states it "does not request human approval". jevc's `ask` arm has nowhere to go — which specifically kills the routing rule your own verification flagged as the fix for the one real miscalibration ("authorized ⇒ downgrade block to ask").
- **`stateBuilder` is hardcoded**: `messages[-30:]` + `tool_call{id,name,args}` + optional `tool_description`. Policy-in-state (your §7 argument — putting `CLAUDE.md` into state and asking `violates_written_policy`) is structurally impossible here; there is no seam to inject it.
- **Latent defect worth reporting upstream**: the documented default risk criteria are dead code. `_AutoModeConfig.criteria` defaults to `NoulCriteria(true=_DEFAULT_TRUE_CRITERIA, false=_DEFAULT_FALSE_CRITERIA)`, but `__init__` always passes the key explicitly as `criteria=None`, so the field default never applies. Verified at runtime: `AutoModeMiddleware(tools=['delete_file']).classifier.questions['is_risky'].criteria` → `None`. Any emitter here must pass `criteria` explicitly or silently lose the outcome definitions.
- Honest ceiling: this is a **prose-injection** emitter — one instruction string and two criteria strings into a fixed 1-question, fixed-0.5-threshold, allow/block guard. It collapses the exact decomposition your measurements say is load-bearing. Per your own rule, cut it.

### `ModelRouterMiddleware` — PARTIAL. Shippable only for the single-choice routing shape.
- **The question IS user-defined**, which is the real difference: `instructions` is yours in full, and `choices` supplies both the labels and their `criteria`. So one `Choice` decision maps 1:1, and `Choice`'s 255-option ceiling is the only limit. This is a genuine emit target for a *routing* Program.
- **But `reduce` is still hardcoded to argmax**: `self.models[answer.choice]`. No threshold, no confidence gate, no fallback route. There is exactly one question (`_QUESTION_ID = "model_route"`), so a multi-evidence Program that *computes* a route does not fit — only a Program whose single choice question's labels **are** the model names.
- **Confidence is preserved but ignored**: the full `ChoiceAnswer` (probabilities + confidence) is persisted at `state["model_route"]` via the `_ModelRouterState` schema, so a *second* middleware can read it and implement your uncertainty policy. That is the supported escape hatch, and it is the thing to emit alongside if you ship this.
- Caveat to emit defensively around: `_latest_human_message` is `next(m for m in reversed(state["messages"]) if isinstance(m, HumanMessage))` with **no default** — an agent run whose state holds no `HumanMessage` raises `StopIteration` out of `before_agent`. Also routing is decided **once per run** (`before_agent`), so it cannot re-route mid-run as the conversation shifts.
- Note it classifies a bare `HumanMessage` as state, so `stateBuilder` is hardcoded here too.

## Net recommendation
Ship **A (full)** and **B/`TypeSafeClassifier` (full)** as real emitters — both carry `decisions` + `reduce` + `stateBuilder` losslessly, with `residual` out of band on both. Ship **B/`ModelRouterMiddleware`** only as a narrow `--for model-router` mode gated on "Program is exactly one choice decision whose labels are models", and emit a companion middleware if you need the confidence gate. **Cut B/`AutoModeMiddleware`** — hardcoded question id, hardcoded 0.5 threshold with no parameter, binary verdict, hardcoded state. It is the case your spec said to cut.

One consistency note for the parent: the spec's §9 prior-art sweep says **seven** Claude Code guardrail hooks (`bouncer`, `toolgate`, `jev-guard`, `agent-guard`, `jev-gate`, `jev-claude`, `limpet`) and **eight** Jev CLIs — fifteen total, "none of the fifteen lowers anything". The relayed request said "~6 Jev CLIs"; the spec says eight. Neither of the two targets extracted here is one of those fifteen.

## Real example

```
Neither target has a committed config/policy file — both are configured in code — so the closest real artifacts are the verbatim committed examples shipped inside the installed packages.

## A. Verbatim from `node_modules/@ai-sdk/typesafe-ai/docs/105-typesafe-ai.mdx` (shipped in the published tarball)

```ts
import { typeSafeAi } from '@ai-sdk/typesafe-ai';
import { experimental_evaluate } from 'ai';

const result = await experimental_evaluate({
  model: typeSafeAi.evaluationModel('jev-latest'),
  state: {
    message: 'I was charged twice. Please refund the duplicate.',
  },
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: {
        billing: { includes: ['Charges', 'Invoices', 'Refunds'] },
        technical: ['Bugs', 'Outages'],
        other: null,
      },
    },
    severity: {
      type: 'score',
      instructions: 'How severe is the issue?',
      criteria: ['Cosmetic', 'Workaround exists', 'Blocking; no workaround'],
    },
    requestsRefund: {
      type: 'boolean',
      instructions: 'Is the customer requesting money back?',
    },
  },
});

console.log(result.answers.department.choice);
console.log(result.answers.severity.score);
console.log(result.answers.requestsRefund.probability);
console.log(result.usage);
```

And verbatim from the same file, the normative statement on the critical question:

> Confidence is a separate TypeSafe statistic, available under
> `result.providerMetadata.typesafe.confidence[questionId]` for Choice and Score
> answers. Boolean probability always means P(true), not confidence in either
> outcome. Choose decision thresholds in application code.

## B. Verbatim from `langchain_typesafe/experimental/middleware/model_router.py` docstring (lines 97-118)

```python
from langchain.agents import create_agent
from langchain_typesafe.experimental.middleware import (
    ModelChoice,
    ModelRouterMiddleware,
)

router = ModelRouterMiddleware(
    choices={
        "fast": ModelChoice(
            model="openai:gpt-5-mini",
            criteria="Simple, well-scoped tasks.",
        ),
        "powerful": ModelChoice(
            model=powerful_model,
            criteria="Complex tasks requiring deeper reasoning.",
        ),
    },
    instructions="Choose the least costly model suited to the task.",
)
agent = create_agent("openai:gpt-5-mini", middleware=[router])
```

## B2. Verbatim from `langchain_typesafe/experimental/middleware/auto_mode.py` (lines 114-125) — the entire configurable surface of that middleware

```python
auto_mode = AutoModeMiddleware(
    tools=[delete_file],
    criteria=NoulCriteria(
        true="The call writes, deletes, publishes, or changes access.",
        false="The call only reads public or user-provided data.",
    ),
)
agent = create_agent(
    model,
    tools=[read_file, delete_file],
    middleware=[auto_mode],
)
```
Note what is absent and cannot be added: any second question, any question id, and any threshold.
```
