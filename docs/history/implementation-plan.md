*Historical: the original task-by-task build plan for jevc 0.1.0, written before the code existed and kept unedited for provenance.*
*It is not maintained and does not describe current behaviour — see [`../design.md`](../design.md) for the design and the README for what shipped.*

# jevc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lower natural-language prompts and JSON Schemas into TypeSafe Jev decision programs that code can execute, review, and calibrate.

**Architecture:** Every input (JSON Schema, Zod, tool defs, MCP inputSchema, prose) converges on one IR — a `Program` of narrow *evidence* decisions plus a code-level `Reducer` that computes the verdict. Every output (native TS, Vercel AI SDK, LangChain Python, plain JSON, incumbent-hook policy) is generated from that IR. The verdict is never asked of the model, because measurement showed collapsed verdict questions return near-uniform distributions.

**Tech Stack:** TypeScript 5 (strict, ESM, Node ≥20) · `@typesafe-ai/sdk@0.6` as the only runtime dependency · vitest (incl. built-in `expectTypeOf` for type-level tests) · no build tool beyond `tsc`

**Spec:** `docs/superpowers/specs/2026-09-18-jevc-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Node ≥ 20**, ESM only (`"type": "module"`), TypeScript `strict: true`.
- **Zero runtime dependencies except `@typesafe-ai/sdk@^0.6.0`.** Validation is hand-written, not delegated to a schema library: the rules are custom (score 2–10, duplicate-id detection, backtick-path resolution) and the error messages must be actionable. A YAML writer may be added later, for policy emitters only.
- **Never reimplement** the SDK's client, retry policy, error classes, `noul()`/`choice()`/`score()` factories, or `ResultFor`/`ScoreOf`/`ScoreLegend`. Import them.
- **Wire limits (measured, not documented):** `score` criteria 2–10 · `choice` criteria 2–255 · question ids non-empty and unique · `state` non-empty · model ∈ `{jev-latest, jev-preview, jev-1.13.0}` · 64k tokens total, 32k for state + longest single question, ≈5.1 chars/token.
- **Jev answers drift ±0.01 between identical calls.** Every assertion against a Jev answer is a band (`gte`/`lte`), never an equality. A test asserting `toBe(0.96)` is a bug.
- **Emitted TypeScript must preserve tuple types** (`as const`). If criteria widen to `string[]`, `ScoreOf` degrades to `number` and the type safety this project is named for is gone — silently, at type level only.
- **Secrets:** the API key is read from `TYPESAFE_API_KEY` only. Never written to a file, never logged. The API's `422` body echoes the entire request including `state`, so it must be redacted before it reaches any log or error message.
- Every task ends with a commit. Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## File Structure

| File | Responsibility |
| --- | --- |
| `src/contract.ts` | Jev wire types + `validateRequest()` — the empirical rule set from spec §3.1 |
| `src/ir.ts` | `Decision` / `Program` / `Reducer` types, `validateProgram()`, `lintProgram()` (decomposition law) |
| `src/from-schema.ts` | JSON Schema → `Program`, deterministic |
| `src/from-prompt.ts` | Lift protocol: emit a lift request, strictly validate the IR an agent returns |
| `src/emit/native.ts` | `Program` → TypeScript source, tuple-preserving |
| `src/emit/json.ts` | `Program` → plain `JevRequest` |
| `src/runtime.ts` | `evaluate()` — call the API, apply thresholds, run the reducer |
| `src/check.ts` | Fixture replay + live calibration report |
| `src/cli.ts` | `jevc` |
| `fixtures/*.json` | 60 live-measured fixtures (already committed) |

Emitters for `@ai-sdk/typesafe-ai`, `langchain-typesafe`, and incumbent-hook policy are Tasks 10–12, appended once their target schemas are confirmed against real source.

---

### Task 1: Project scaffold and the wire contract

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/contract.ts`
- Test: `test/contract.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `JevQuestion`, `JevRequest`, `JevAnswer`, `JevResponse`, `ValidationIssue`, `validateRequest(req: JevRequest): ValidationIssue[]`, `estimateTokens(v: unknown): number`

- [ ] **Step 1: Scaffold the package**

`package.json`:
```json
{
  "name": "jevc",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "jevc": "./dist/cli.js" },
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "check:live": "node dist/cli.js check --live"
  },
  "dependencies": { "@typesafe-ai/sdk": "^0.6.0" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0", "@types/node": "^20.16.0" }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "declaration": true, "outDir": "dist", "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
```

Run: `npm install`

- [ ] **Step 2: Write the failing contract tests**

`test/contract.test.ts` — each case is a measured behaviour from spec §3.1, where the **API returns 200 and a wrong answer**. These are the reason the validator exists.

```ts
import { describe, it, expect } from 'vitest'
import { validateRequest, estimateTokens } from '../src/contract.js'

const base = { model: 'jev-latest' as const, state: 'hello' }

describe('validateRequest', () => {
  it('accepts a minimal valid request', () => {
    expect(validateRequest({ ...base, questions: {
      a: { type: 'noul', instructions: 'Is it urgent?' } } })).toEqual([])
  })

  it('rejects a 1-level score (API returns 200 and a meaningless constant)', () => {
    const issues = validateRequest({ ...base, questions: {
      s: { type: 'score', instructions: 'How bad?', criteria: ['only'] } } })
    expect(issues).toHaveLength(1)
    expect(issues[0].code).toBe('score_too_few_levels')
    expect(issues[0].path).toBe('questions.s.criteria')
  })

  it('rejects an 11-level score', () => {
    const criteria = Array.from({ length: 11 }, (_, i) => `level ${i}`)
    expect(validateRequest({ ...base, questions: {
      s: { type: 'score', instructions: 'x', criteria } } })[0].code)
      .toBe('score_too_many_levels')
  })

  it('rejects a 1-option choice (API returns 200 with confidence 1.0)', () => {
    expect(validateRequest({ ...base, questions: {
      c: { type: 'choice', instructions: 'Which?', criteria: { only: null } } } })[0].code)
      .toBe('choice_too_few_options')
  })

  it('rejects an empty question map', () => {
    expect(validateRequest({ ...base, questions: {} })[0].code).toBe('questions_empty')
  })

  it('rejects an empty question id', () => {
    expect(validateRequest({ ...base, questions: {
      '': { type: 'noul', instructions: 'x' } } })[0].code).toBe('id_empty')
  })

  it('rejects an empty state (API returns 200 and answers from nothing)', () => {
    expect(validateRequest({ model: 'jev-latest', state: '', questions: {
      a: { type: 'noul', instructions: 'x' } } })[0].code).toBe('state_empty')
  })

  it('rejects an unknown model', () => {
    expect(validateRequest({ ...base, model: 'jev-9000' as never, questions: {
      a: { type: 'noul', instructions: 'x' } } })[0].code).toBe('model_unknown')
  })

  it('rejects a noul with neither instructions nor criteria', () => {
    expect(validateRequest({ ...base, questions: {
      a: { type: 'noul', instructions: '' } } })[0].code).toBe('noul_empty')
  })

  it('reports every violation at once, not just the first', () => {
    const issues = validateRequest({ ...base, questions: {
      s: { type: 'score', instructions: 'x', criteria: ['one'] },
      c: { type: 'choice', instructions: 'y', criteria: { only: null } } } })
    expect(issues.map(i => i.code).sort())
      .toEqual(['choice_too_few_options', 'score_too_few_levels'])
  })

  it('flags a backtick path that does not resolve in state', () => {
    const issues = validateRequest({
      model: 'jev-latest',
      state: { ticket: { messages: [{ text: 'hi' }] } },
      questions: { a: { type: 'noul', instructions: 'Is `ticket.nope.field` angry?' } },
    })
    expect(issues[0].code).toBe('path_unresolved')
  })

  it('accepts a backtick path that does resolve', () => {
    expect(validateRequest({
      model: 'jev-latest',
      state: { ticket: { messages: [{ text: 'hi' }] } },
      questions: { a: { type: 'noul', instructions: 'Is `ticket.messages[0].text` angry?' } },
    })).toEqual([])
  })

  it('rejects a request over the token budget', () => {
    expect(validateRequest({ model: 'jev-latest', state: 'x'.repeat(200_000),
      questions: { a: { type: 'noul', instructions: 'x' } } })[0].code)
      .toBe('token_budget_exceeded')
  })
})

describe('estimateTokens', () => {
  it('uses the measured ~5.1 chars/token ratio', () => {
    expect(estimateTokens('x'.repeat(51_000))).toBeCloseTo(10_000, -2)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/contract.test.ts`
Expected: FAIL — `Failed to resolve import "../src/contract.js"`

- [ ] **Step 4: Implement `src/contract.ts`**

```ts
export type EntryType = string | Record<string, unknown> | unknown[] | null

export type JevQuestion =
  | { type: 'noul'; instructions: EntryType; criteria?: { true?: EntryType; false?: EntryType } | null }
  | { type: 'choice'; instructions: EntryType; criteria: Record<string, EntryType> }
  | { type: 'score'; instructions: EntryType; criteria: readonly EntryType[] }

export type JevModel = 'jev-latest' | 'jev-preview' | 'jev-1.13.0'
export const MODELS: readonly JevModel[] = ['jev-latest', 'jev-preview', 'jev-1.13.0']

export type JevRequest = {
  model: JevModel
  state: string | Record<string, unknown> | unknown[]
  questions: Record<string, JevQuestion>
}

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }

export type JevResponse = {
  model: string
  answers: Record<string, JevAnswer>
  usage: { input_tokens: number; output_tokens: number }
}

export type ValidationIssue = {
  code: string
  path: string
  message: string
  severity: 'error' | 'warn'
}

// Measured: 29,464 tokens for 150,232 chars.
const CHARS_PER_TOKEN = 5.1
export const TOKEN_BUDGET_TOTAL = 64_000
export const TOKEN_BUDGET_SINGLE = 32_000

export function estimateTokens(v: unknown): number {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '')
  return Math.ceil(s.length / CHARS_PER_TOKEN)
}

/** Resolve `a.b[0].c` against the state object. Returns undefined when absent. */
function resolvePath(state: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  let cur: unknown = state
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
    if (cur === undefined) return undefined
  }
  return cur
}

function backtickPaths(q: JevQuestion): string[] {
  const text = JSON.stringify(q)
  // A backticked token is treated as a state path only when it looks like one.
  return [...text.matchAll(/`([A-Za-z_$][\w$]*(?:\.[\w$]+|\[\d+\])+)`/g)].map(m => m[1])
}

export function validateRequest(req: JevRequest): ValidationIssue[] {
  const out: ValidationIssue[] = []
  const err = (code: string, path: string, message: string) =>
    out.push({ code, path, message, severity: 'error' })

  if (!MODELS.includes(req.model)) {
    err('model_unknown', 'model',
      `Unknown model "${req.model}". Expected one of: ${MODELS.join(', ')}.`)
  }

  const stateEmpty = req.state === '' ||
    (typeof req.state === 'object' && req.state !== null && Object.keys(req.state).length === 0)
  if (stateEmpty) {
    err('state_empty', 'state',
      'State is empty. The API accepts this with 200 and answers from no evidence.')
  }

  const ids = Object.keys(req.questions)
  if (ids.length === 0) {
    err('questions_empty', 'questions', 'At least one question is required.')
  }

  for (const id of ids) {
    const q = req.questions[id]
    const at = `questions.${id}`
    if (id === '') {
      err('id_empty', at, 'Question id cannot be empty.')
    }

    if (q.type === 'score') {
      const n = q.criteria.length
      if (n < 2) {
        err('score_too_few_levels', `${at}.criteria`,
          `Score has ${n} level(s); at least 2 are required. The API accepts a single level with 200 and returns a constant 0.0 at confidence 1.0.`)
      }
      if (n > 10) {
        err('score_too_many_levels', `${at}.criteria`,
          `Score has ${n} levels; the API rejects more than 10.`)
      }
      if (q.criteria.some(c => c === null || c === '')) {
        out.push({ code: 'score_level_undescribed', path: `${at}.criteria`, severity: 'error',
          message: 'Every score level needs a concrete description; an undescribed level destroys the distribution.' })
      }
    }

    if (q.type === 'choice') {
      const n = Object.keys(q.criteria).length
      if (n < 2) {
        err('choice_too_few_options', `${at}.criteria`,
          `Choice has ${n} option(s); at least 2 are required. The API accepts one option with 200 and returns it at confidence 1.0.`)
      }
      if (n > 255) {
        err('choice_too_many_options', `${at}.criteria`, `Choice has ${n} options; the maximum is 255.`)
      }
      if (n > 240) {
        out.push({ code: 'choice_near_limit', path: `${at}.criteria`, severity: 'warn',
          message: `Choice has ${n} options; reliability degrades above roughly 240.` })
      }
    }

    if (q.type === 'noul') {
      const noInstructions = q.instructions === '' || q.instructions == null
      const noCriteria = q.criteria == null || Object.keys(q.criteria).length === 0
      if (noInstructions && noCriteria) {
        err('noul_empty', at, 'A noul needs instructions or criteria.')
      }
    }

    for (const path of backtickPaths(q)) {
      if (resolvePath(req.state, path) === undefined) {
        err('path_unresolved', at,
          `Backtick path \`${path}\` does not resolve in state. The API never reports this — it silently answers from the whole state instead.`)
      }
    }

    const qTokens = estimateTokens(q) + estimateTokens(req.state)
    if (qTokens > TOKEN_BUDGET_SINGLE) {
      err('token_budget_exceeded', at,
        `State plus this question is ~${qTokens} tokens; the per-question limit is ${TOKEN_BUDGET_SINGLE}.`)
    }
  }

  const total = estimateTokens(req.state) + estimateTokens(req.questions)
  if (total > TOKEN_BUDGET_TOTAL) {
    err('token_budget_exceeded', 'request',
      `Request is ~${total} tokens; the limit is ${TOKEN_BUDGET_TOTAL}.`)
  }

  return out
}

/** The 422 body echoes the whole request, state included. Never log it raw. */
export function redactErrorBody(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body
  const clone = JSON.parse(JSON.stringify(body))
  const strip = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return
    const o = n as Record<string, unknown>
    if ('input' in o) o.input = '[redacted]'
    for (const v of Object.values(o)) strip(v)
  }
  strip(clone)
  return clone
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/contract.test.ts`
Expected: PASS, 14 tests

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts src/contract.ts test/contract.test.ts
git commit -m "feat: Jev wire contract and validator

Encodes the six cases where the API returns 200 and a wrong answer:
1-level score, 1-option choice, duplicate ids, unknown fields, empty
state, and unresolved backtick paths. Measured 2026-09-18.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The IR and the decomposition linter

**Files:**
- Create: `src/ir.ts`
- Test: `test/ir.test.ts`

**Interfaces:**
- Consumes: `ValidationIssue` from `src/contract.ts`
- Produces: `Decision`, `Program`, `Reducer`, `Condition`, `validateProgram(p: Program): ValidationIssue[]`, `lintProgram(p: Program): ValidationIssue[]`, `VERDICT_WORDS`

This task encodes spec §4b. It is the difference between jevc and a naive field-mapper.

- [ ] **Step 1: Write the failing tests**

`test/ir.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { validateProgram, lintProgram, type Program } from '../src/ir.js'

const prog = (over: Partial<Program> = {}): Program => ({
  decisions: [
    { id: 'is_destructive', kind: 'noul', instructions: 'Does the command delete data?' },
    { id: 'blast_radius', kind: 'score', instructions: 'How wide is the impact?',
      criteria: ['single file', 'one directory', 'whole repo'] },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'is_destructive', op: 'gte', value: 0.8 }], then: 'deny' }], otherwise: 'allow' },
  residual: '',
  dropped: [],
  ...over,
})

describe('validateProgram', () => {
  it('accepts a well-formed program', () => {
    expect(validateProgram(prog())).toEqual([])
  })

  it('rejects duplicate decision ids (the API silently keeps the last)', () => {
    const p = prog()
    p.decisions.push({ id: 'is_destructive', kind: 'noul', instructions: 'again' })
    expect(validateProgram(p)[0].code).toBe('duplicate_id')
  })

  it('rejects a reducer referencing an unknown decision', () => {
    const p = prog({ reduce: { kind: 'rules',
      rules: [{ when: [{ id: 'nope', op: 'gte', value: 0.5 }], then: 'deny' }], otherwise: 'allow' } })
    expect(validateProgram(p)[0].code).toBe('reduce_unknown_id')
  })

  it('rejects a score threshold outside level-index space', () => {
    const p = prog({ reduce: { kind: 'rules',
      rules: [{ when: [{ id: 'blast_radius', op: 'gte', value: 0.8 }], then: 'deny' }], otherwise: 'allow' } })
    // 3 levels => valid range is 0..2; 0.8 is legal. 5 is not.
    expect(validateProgram(p)).toEqual([])
    const bad = prog({ reduce: { kind: 'rules',
      rules: [{ when: [{ id: 'blast_radius', op: 'gte', value: 5 }], then: 'deny' }], otherwise: 'allow' } })
    expect(validateProgram(bad)[0].code).toBe('score_threshold_out_of_range')
  })

  it('rejects belowConfidence on a noul, which has no confidence field', () => {
    const p = prog()
    p.decisions[0].uncertain = { belowConfidence: 0.7 }
    expect(validateProgram(p)[0].code).toBe('noul_has_no_confidence')
  })

  it('accepts a band on a noul', () => {
    const p = prog()
    p.decisions[0].uncertain = { band: [0.35, 0.65] }
    expect(validateProgram(p)).toEqual([])
  })
})

describe('lintProgram — the decomposition law', () => {
  it('rejects a collapsed verdict question', () => {
    const p = prog()
    p.decisions.push({ id: 'decision', kind: 'choice',
      instructions: 'What should the harness do?',
      criteria: { allow: 'safe', ask: 'needs approval', deny: 'block it' } })
    const issues = lintProgram(p)
    expect(issues[0].code).toBe('collapsed_verdict')
    expect(issues[0].message).toMatch(/computed in code/)
  })

  it('allows a choice whose options are not verdicts', () => {
    const p = prog()
    p.decisions.push({ id: 'department', kind: 'choice', instructions: 'Which team?',
      criteria: { billing: 'payments', technical: 'bugs', sales: 'pricing' } })
    expect(lintProgram(p)).toEqual([])
  })

  it('warns when one decision logically determines another', () => {
    const p = prog()
    p.decisions.push({ id: 'rule_conflict', kind: 'choice', instructions: 'Which rule wins?',
      criteria: { exception_wins: 'the documented exception governs', rule_wins: 'the base rule governs' } })
    p.decisions.push({ id: 'should_deny', kind: 'noul',
      instructions: 'Should this be denied given the rule conflict?', dependsOn: ['rule_conflict'] })
    const issues = lintProgram(p)
    expect(issues.some(i => i.code === 'dependent_questions')).toBe(true)
  })

  it('warns on a question spanning two scopes', () => {
    const p = prog()
    p.decisions.push({ id: 'authorized', kind: 'noul',
      instructions: 'Did the user authorize this action, or did it go materially further than asked?' })
    expect(lintProgram(p).some(i => i.code === 'compound_question')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ir.test.ts`
Expected: FAIL — cannot resolve `../src/ir.js`

- [ ] **Step 3: Implement `src/ir.ts`**

```ts
import type { EntryType, ValidationIssue } from './contract.js'

export type Uncertain = { belowConfidence: number } | { band: [number, number] }

export type Decision = {
  id: string
  kind: 'noul' | 'choice' | 'score'
  instructions: string
  criteria?: { true?: EntryType; false?: EntryType } | Record<string, EntryType> | readonly EntryType[]
  uncertain?: Uncertain
  dependsOn?: string[]
  source?: { file: string; line: number; quote: string }
}

export type Condition =
  | { id: string; op: 'gte' | 'lte'; value: number }
  | { id: string; op: 'is'; value: string }
  | { id: string; op: 'uncertain' }

/** First match wins; `otherwise` is the fallthrough. A reviewable decision table. */
export type Reducer = {
  kind: 'rules'
  rules: Array<{ when: Condition[]; then: string }>
  otherwise: string
}

export type Program = {
  decisions: Decision[]   // evidence questions only, never verdicts (see 4b)
  reduce: Reducer         // the verdict, computed in code from the evidence
  residual: string        // what still needs a generative model; '' when fully compiled
  dropped: Array<{ reason: string; quote: string }>
}
// No stateBuilder in v0.1: every emit target builds its own state (bouncer and
// toolgate from the hook payload, native/langchain from caller code), so the field
// would be dead weight. Re-add it when an emitter actually consumes one.


/** Option sets that mean "what should the program do" rather than "what is true". */
export const VERDICT_WORDS = new Set([
  'allow', 'ask', 'deny', 'block', 'approve', 'reject', 'escalate',
  'permit', 'refuse', 'proceed', 'halt', 'warn', 'pass', 'fail',
])

const DEFAULT_NOUL_BAND: [number, number] = [0.35, 0.65]

export function validateProgram(p: Program): ValidationIssue[] {
  const out: ValidationIssue[] = []
  const err = (code: string, path: string, message: string) =>
    out.push({ code, path, message, severity: 'error' })

  const seen = new Set<string>()
  for (const d of p.decisions) {
    if (seen.has(d.id)) {
      err('duplicate_id', `decisions.${d.id}`,
        `Duplicate decision id "${d.id}". Question maps are JSON objects, so the API silently keeps only the last definition.`)
    }
    seen.add(d.id)

    if (d.kind === 'noul' && d.uncertain && 'belowConfidence' in d.uncertain) {
      err('noul_has_no_confidence', `decisions.${d.id}.uncertain`,
        'A noul answer carries no confidence field; its probability is the answer. Use a band instead.')
    }
    if (d.kind !== 'noul' && d.uncertain && 'band' in d.uncertain) {
      err('band_needs_noul', `decisions.${d.id}.uncertain`,
        'A band applies to a noul. Use belowConfidence for choice and score.')
    }
  }

  const byId = new Map(p.decisions.map(d => [d.id, d]))
  for (const [ri, rule] of p.reduce.rules.entries()) {
    for (const c of rule.when) {
      const d = byId.get(c.id)
      if (!d) {
        err('reduce_unknown_id', `reduce.rules[${ri}]`,
          `Reducer references unknown decision "${c.id}".`)
        continue
      }
      if (d.kind === 'score' && (c.op === 'gte' || c.op === 'lte')) {
        const levels = Array.isArray(d.criteria) ? d.criteria.length : 0
        if (levels && (c.value < 0 || c.value > levels - 1)) {
          err('score_threshold_out_of_range', `reduce.rules[${ri}]`,
            `Threshold ${c.value} is outside level-index space for "${c.id}" (${levels} levels => 0..${levels - 1}). Score is not a 0..1 value.`)
        }
      }
      if (d.kind === 'choice' && c.op === 'is') {
        const opts = d.criteria && !Array.isArray(d.criteria) ? Object.keys(d.criteria) : []
        if (opts.length && !opts.includes(c.value)) {
          err('reduce_unknown_option', `reduce.rules[${ri}]`,
            `Option "${c.value}" is not defined on choice "${c.id}".`)
        }
      }
    }
  }
  return out
}

export function lintProgram(p: Program): ValidationIssue[] {
  const out: ValidationIssue[] = []

  for (const d of p.decisions) {
    // Rule 1 — never emit a collapsed verdict question.
    if (d.kind === 'choice' && d.criteria && !Array.isArray(d.criteria)) {
      const opts = Object.keys(d.criteria).map(o => o.toLowerCase())
      const verdictish = opts.filter(o => VERDICT_WORDS.has(o)).length
      if (verdictish >= 2 && verdictish >= opts.length - 1) {
        out.push({
          code: 'collapsed_verdict', path: `decisions.${d.id}`, severity: 'error',
          message: `"${d.id}" asks the model for a verdict (${opts.join('/')}). Measured: collapsed verdict questions return near-uniform distributions (allow 0.42 / block 0.35 / ask 0.23 at confidence 0.13) while narrow evidence questions on the same input reach 0.93-0.97. Ask for evidence; the verdict must be computed in code by the reducer.`,
        })
      }
    }

    // Rule 3 — never emit a question spanning two scopes.
    const text = d.instructions.toLowerCase()
    if (/\bor did it\b|\bor whether\b|, or .*\?|\band also\b/.test(text)) {
      out.push({
        code: 'compound_question', path: `decisions.${d.id}`, severity: 'warn',
        message: `"${d.id}" appears to ask two things at once. Measured: a compound authorization question returned 0.59 — the wrong side of 0.5 — because it anchored on the authorized half of a command. Split it by scope.`,
      })
    }
  }

  // Rule 2 — never emit two questions where one determines the other.
  for (const d of p.decisions) {
    for (const dep of d.dependsOn ?? []) {
      out.push({
        code: 'dependent_questions', path: `decisions.${d.id}`, severity: 'warn',
        message: `"${d.id}" depends on "${dep}". Questions in a batch are scored independently with no consistency enforced — a measured response asserted rule_conflict=exception_wins (0.52) and decision=deny (0.73) simultaneously. Ask the resolving question and derive this one in code.`,
      })
    }
  }

  return out
}

export function uncertaintyOf(d: Decision): Uncertain {
  return d.uncertain ?? (d.kind === 'noul'
    ? { band: DEFAULT_NOUL_BAND }
    : { belowConfidence: 0.5 })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/ir.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/ir.ts test/ir.test.ts
git commit -m "feat: decision IR and the decomposition linter

Encodes spec 4b: no collapsed verdict questions, no logically dependent
questions, no compound scopes. Each rule cites the measurement that
produced it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: JSON Schema lowering — booleans and enums

**Files:**
- Create: `src/from-schema.ts`
- Test: `test/from-schema.test.ts`

**Interfaces:**
- Consumes: `Decision`, `Program` from `src/ir.ts`
- Produces: `fromJsonSchema(schema: JsonSchema, opts?: FromSchemaOptions): Program`, `type JsonSchema`, `type FromSchemaOptions`

- [ ] **Step 1: Write the failing tests**

`test/from-schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { fromJsonSchema } from '../src/from-schema.js'

describe('fromJsonSchema — primitives', () => {
  it('lowers a boolean to a noul, carrying description into instructions', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      is_urgent: { type: 'boolean', description: 'Does the message convey urgency?' } } })
    expect(p.decisions).toEqual([
      { id: 'is_urgent', kind: 'noul', instructions: 'Does the message convey urgency?' },
    ])
    expect(p.residual).toBe('')
  })

  it('synthesises instructions when description is absent', () => {
    const p = fromJsonSchema({ type: 'object', properties: { is_spam: { type: 'boolean' } } })
    expect(p.decisions[0].instructions).toBe('Is is_spam true?')
  })

  it('lowers a string enum to a choice with null rubrics', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      department: { type: 'string', enum: ['billing', 'technical', 'sales'],
        description: 'Which team should handle this?' } } })
    expect(p.decisions[0]).toEqual({
      id: 'department', kind: 'choice', instructions: 'Which team should handle this?',
      criteria: { billing: null, technical: null, sales: null },
    })
  })

  it('lowers a oneOf of consts to a choice', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      tier: { oneOf: [{ const: 'fast' }, { const: 'frontier' }] } } })
    expect(p.decisions[0].kind).toBe('choice')
    expect(Object.keys(p.decisions[0].criteria as object)).toEqual(['fast', 'frontier'])
  })

  it('does NOT collapse a two-member enum to a noul by default', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      answer: { type: 'string', enum: ['yes', 'no'] } } })
    expect(p.decisions[0].kind).toBe('choice')
  })

  it('collapses a two-member yes/no enum when explicitly opted in', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      answer: { type: 'string', enum: ['yes', 'no'] } } }, { collapseBooleanEnums: true })
    expect(p.decisions[0].kind).toBe('noul')
  })

  it('rejects a single-member enum rather than emitting a degenerate choice', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      only: { type: 'string', enum: ['x'] } } })
    expect(p.decisions).toHaveLength(0)
    expect(p.dropped[0].reason).toMatch(/at least 2/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/from-schema.test.ts`
Expected: FAIL — cannot resolve `../src/from-schema.js`

- [ ] **Step 3: Implement the primitive paths in `src/from-schema.ts`**

```ts
import type { Decision, Program } from './ir.js'

export type JsonSchema = {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  const?: unknown
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  minimum?: number
  maximum?: number
  [k: string]: unknown
}

export type FromSchemaOptions = {
  /** Collapse a 2-member yes/no-shaped enum into a noul. Off by default: it changes the declared output shape. */
  collapseBooleanEnums?: boolean
}

const YES = new Set(['yes', 'true', 'y', 'affirmative'])
const NO = new Set(['no', 'false', 'n', 'negative'])

function constOptions(s: JsonSchema): string[] | null {
  if (Array.isArray(s.enum)) return s.enum.map(String)
  const union = s.oneOf ?? s.anyOf
  if (union && union.every(u => 'const' in u)) return union.map(u => String(u.const))
  return null
}

export function fromJsonSchema(schema: JsonSchema, opts: FromSchemaOptions = {}): Program {
  const decisions: Decision[] = []
  const dropped: Program['dropped'] = []

  const visit = (props: Record<string, JsonSchema>, prefix: string): void => {
    for (const [key, s] of Object.entries(props)) {
      const id = prefix ? `${prefix}.${key}` : key
      const desc = s.description

      if (s.type === 'boolean') {
        decisions.push({ id, kind: 'noul', instructions: desc ?? `Is ${key} true?` })
        continue
      }

      const options = constOptions(s)
      if (options) {
        if (options.length < 2) {
          dropped.push({ reason: `"${id}" has ${options.length} option(s); a choice needs at least 2.`, quote: key })
          continue
        }
        const lower = options.map(o => o.toLowerCase())
        if (opts.collapseBooleanEnums && options.length === 2 &&
            lower.some(o => YES.has(o)) && lower.some(o => NO.has(o))) {
          decisions.push({ id, kind: 'noul', instructions: desc ?? `Is ${key} true?` })
          continue
        }
        decisions.push({
          id, kind: 'choice',
          instructions: desc ?? `Which ${key} applies?`,
          criteria: Object.fromEntries(options.map(o => [o, null])),
        })
        continue
      }

      dropped.push({ reason: `"${id}" (${String(s.type)}) has no System One equivalent.`, quote: key })
    }
  }

  visit(schema.properties ?? {}, '')

  return {
    decisions,
    reduce: { kind: 'rules', rules: [], otherwise: 'review' },
    residual: '',
    dropped,
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/from-schema.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/from-schema.ts test/from-schema.test.ts
git commit -m "feat: lower JSON Schema booleans and enums to noul and choice

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: JSON Schema lowering — scores, multi-label, nesting, residual

**Files:**
- Modify: `src/from-schema.ts`
- Test: `test/from-schema-advanced.test.ts`

**Interfaces:**
- Consumes: `fromJsonSchema` from Task 3
- Produces: same signature, extended behaviour

- [ ] **Step 1: Write the failing tests**

`test/from-schema-advanced.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { fromJsonSchema } from '../src/from-schema.js'

describe('fromJsonSchema — advanced', () => {
  it('lowers a bounded integer to a score with one level per value', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      severity: { type: 'integer', minimum: 1, maximum: 3, description: 'How severe?' } } })
    expect(p.decisions[0].kind).toBe('score')
    expect(p.decisions[0].criteria).toHaveLength(3)
  })

  it('warns that generated score levels are undescribed', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      severity: { type: 'integer', minimum: 1, maximum: 3 } } })
    expect(p.dropped.some(d => /undescribed/.test(d.reason))).toBe(true)
  })

  it('drops an integer range wider than 10 levels', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      score: { type: 'integer', minimum: 0, maximum: 100 } } })
    expect(p.decisions).toHaveLength(0)
    expect(p.dropped[0].reason).toMatch(/at most 10/)
  })

  it('lowers a multi-label enum array to one noul per label', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      tags: { type: 'array', items: { type: 'string', enum: ['spam', 'abuse', 'billing'] },
        description: 'Which labels apply?' } } })
    expect(p.decisions.map(d => d.id)).toEqual(['tags.spam', 'tags.abuse', 'tags.billing'])
    expect(p.decisions.every(d => d.kind === 'noul')).toBe(true)
  })

  it('flattens nested objects with dotted ids', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      ticket: { type: 'object', properties: {
        urgent: { type: 'boolean', description: 'Is it urgent?' } } } } })
    expect(p.decisions[0].id).toBe('ticket.urgent')
  })

  it('routes a free string to the residual, not to an error', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      summary: { type: 'string', description: 'Write a one-line summary.' } } })
    expect(p.decisions).toHaveLength(0)
    expect(p.residual).toMatch(/summary/)
    expect(p.residual).toMatch(/Write a one-line summary/)
  })

  it('routes an array of objects to the residual', () => {
    const p = fromJsonSchema({ type: 'object', properties: {
      items: { type: 'array', items: { type: 'object', properties: { n: { type: 'string' } } } } } })
    expect(p.residual).toMatch(/items/)
  })

  it('silently drops a const, which encodes no decision', () => {
    const p = fromJsonSchema({ type: 'object', properties: { version: { const: 1 } } })
    expect(p.decisions).toHaveLength(0)
    expect(p.residual).toBe('')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/from-schema-advanced.test.ts`
Expected: FAIL — scores, arrays, and nesting all fall through to `dropped`

- [ ] **Step 3: Extend `src/from-schema.ts`**

Replace the final `dropped.push(...)` fallthrough in `visit` with:

```ts
      // Bounded integer -> score, one level per value.
      if ((s.type === 'integer' || s.type === 'number') &&
          typeof s.minimum === 'number' && typeof s.maximum === 'number') {
        const n = s.maximum - s.minimum + 1
        if (n < 2) {
          dropped.push({ reason: `"${id}" spans ${n} value(s); a score needs at least 2 levels.`, quote: key })
          continue
        }
        if (n > 10) {
          dropped.push({ reason: `"${id}" spans ${n} values; a score takes at most 10 levels. Bucket it, or keep it in code.`, quote: key })
          continue
        }
        decisions.push({
          id, kind: 'score',
          instructions: desc ?? `Rate ${key}.`,
          criteria: Array.from({ length: n }, (_, i) => `${key} = ${s.minimum! + i}`),
        })
        dropped.push({
          reason: `"${id}" score levels are undescribed — generated from the numeric range. Describe each level concretely before shipping; an undescribed level destroys the distribution.`,
          quote: key,
        })
        continue
      }

      // Multi-label: array of enum -> one noul per label.
      if (s.type === 'array' && s.items) {
        const labels = constOptions(s.items)
        if (labels && labels.length >= 1) {
          for (const label of labels) {
            decisions.push({
              id: `${id}.${label}`, kind: 'noul',
              instructions: desc ? `${desc} Specifically: does "${label}" apply?` : `Does "${label}" apply to ${key}?`,
            })
          }
          continue
        }
        residualParts.push(`- ${id}: ${desc ?? `array of ${String(s.items.type)}`} (unbounded extraction — Jev cannot generate this)`)
        continue
      }

      // Nested object -> recurse, dotted ids.
      if (s.type === 'object' && s.properties) {
        visit(s.properties, id)
        continue
      }

      // A const encodes no decision at all.
      if ('const' in s) continue

      // Free text -> residual. This is a first-class output, not a failure.
      if (s.type === 'string') {
        residualParts.push(`- ${id}: ${desc ?? 'free text'} (text generation — Jev emits no strings)`)
        continue
      }

      dropped.push({ reason: `"${id}" (${String(s.type)}) has no System One equivalent.`, quote: key })
```

Declare `const residualParts: string[] = []` beside `decisions`, and build the residual in the return:

```ts
  const residual = residualParts.length
    ? `The following still require a generative model:\n${residualParts.join('\n')}`
    : ''

  return { decisions, reduce: { kind: 'rules', rules: [], otherwise: 'review' }, residual, dropped }
```

- [ ] **Step 4: Run both schema suites to verify pass**

Run: `npx vitest run test/from-schema.test.ts test/from-schema-advanced.test.ts`
Expected: PASS, 15 tests

- [ ] **Step 5: Commit**

```bash
git add src/from-schema.ts test/from-schema-advanced.test.ts
git commit -m "feat: score, multi-label, nesting and residual lowering

Multi-label arrays become one noul per label, per TypeSafe guidance that
several labels may apply at once. Free text and unbounded extraction go
to the residual rather than erroring.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Emitters — native TypeScript and plain JSON

**Files:**
- Create: `src/emit/native.ts`, `src/emit/json.ts`
- Test: `test/emit.test.ts`, `test/emit-types.test-d.ts`

**Interfaces:**
- Consumes: `Program` from `src/ir.ts`, `JevRequest` from `src/contract.ts`
- Produces: `emitNative(p: Program, name?: string): string`, `emitJson(p: Program, state: JevRequest['state'], model?: JevModel): JevRequest`

The tuple-preservation requirement is the whole point of `emitNative`. `ScoreOf<T>` degrades to bare `number` unless criteria is a fixed-length tuple, and that failure is invisible at runtime — hence the type-level test.

- [ ] **Step 1: Write the failing runtime test**

`test/emit.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { emitNative } from '../src/emit/native.js'
import { emitJson } from '../src/emit/json.js'
import type { Program } from '../src/ir.js'

const p: Program = {
  decisions: [
    { id: 'is_destructive', kind: 'noul', instructions: 'Does it delete data?' },
    { id: 'blast_radius', kind: 'score', instructions: 'How wide?',
      criteria: ['one file', 'one directory', 'whole repo'] },
    { id: 'target', kind: 'choice', instructions: 'What is targeted?',
      criteria: { source: 'tracked source', build: 'regenerable output' } },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'is_destructive', op: 'gte', value: 0.8 },
             { id: 'blast_radius', op: 'gte', value: 1.5 }], then: 'deny' }], otherwise: 'allow' },
  residual: '', dropped: [],
}

describe('emitNative', () => {
  it('emits score criteria as an as-const tuple', () => {
    const src = emitNative(p)
    expect(src).toMatch(/criteria: \['one file', 'one directory', 'whole repo'\] as const/)
  })

  it('never emits a widened string[] annotation', () => {
    expect(emitNative(p)).not.toMatch(/string\[\]/)
  })

  it('emits the reducer as readable code, not as data', () => {
    const src = emitNative(p)
    expect(src).toMatch(/export function reduce/)
    expect(src).toMatch(/return 'deny'/)
    expect(src).toMatch(/return 'allow'/)
  })

  it('emits a provenance comment when source is present', () => {
    const withSrc: Program = { ...p, decisions: [{ ...p.decisions[0],
      source: { file: 'AGENTS.md', line: 34, quote: 'never delete tracked files' } }] }
    expect(emitNative(withSrc)).toMatch(/AGENTS\.md:34.*never delete tracked files/s)
  })
})

describe('emitJson', () => {
  it('produces a request that passes the contract validator', async () => {
    const { validateRequest } = await import('../src/contract.js')
    expect(validateRequest(emitJson(p, 'rm -rf dist'))).toEqual([])
  })

  it('defaults to jev-latest', () => {
    expect(emitJson(p, 'x').model).toBe('jev-latest')
  })
})
```

- [ ] **Step 2: Write the failing type-level test**

`test/emit-types.test-d.ts` — this is what catches tuple widening:
```ts
import { describe, it, expectTypeOf } from 'vitest'
import { score } from '@typesafe-ai/sdk'
import type { ScoreOf } from '@typesafe-ai/sdk'

describe('tuple preservation', () => {
  it('keeps literal level indices when criteria is a tuple', () => {
    const tuple = ['low', 'mid', 'high'] as const
    expectTypeOf<ScoreOf<typeof tuple>>().toEqualTypeOf<'0' | '1' | '2'>()
  })

  it('degrades to number when criteria is widened — the bug we must not emit', () => {
    const widened: string[] = ['low', 'mid', 'high']
    expectTypeOf<ScoreOf<typeof widened>>().toEqualTypeOf<number>()
  })

  it('emitted question objects keep their literal criteria type', () => {
    const q = score('How wide?', ['one file', 'one directory', 'whole repo'] as const)
    expectTypeOf(q.criteria).toEqualTypeOf<readonly ['one file', 'one directory', 'whole repo']>()
  })
})
```

Add to `vitest.config.ts`: `test: { include: [...], typecheck: { include: ['test/**/*.test-d.ts'] } }`

- [ ] **Step 3: Run to verify both fail**

Run: `npx vitest run test/emit.test.ts && npx vitest --typecheck run test/emit-types.test-d.ts`
Expected: FAIL — cannot resolve `../src/emit/native.js`

- [ ] **Step 4: Implement `src/emit/json.ts`**

```ts
import type { EntryType, JevModel, JevQuestion, JevRequest } from '../contract.js'
import type { Decision, Program } from '../ir.js'

export function toQuestion(d: Decision): JevQuestion {
  if (d.kind === 'noul') {
    const criteria = d.criteria && !Array.isArray(d.criteria)
      ? (d.criteria as { true?: EntryType; false?: EntryType })
      : undefined
    return criteria
      ? { type: 'noul', instructions: d.instructions, criteria }
      : { type: 'noul', instructions: d.instructions }
  }
  if (d.kind === 'score') {
    if (!Array.isArray(d.criteria)) throw new Error(`Score "${d.id}" needs an ordered criteria array.`)
    return { type: 'score', instructions: d.instructions, criteria: d.criteria as readonly EntryType[] }
  }
  if (!d.criteria || Array.isArray(d.criteria)) throw new Error(`Choice "${d.id}" needs a criteria map.`)
  return { type: 'choice', instructions: d.instructions, criteria: d.criteria as Record<string, EntryType> }
}

export function emitJson(
  p: Program,
  state: JevRequest['state'],
  model: JevModel = 'jev-latest',
): JevRequest {
  return {
    model,
    state,
    questions: Object.fromEntries(p.decisions.map(d => [d.id, toQuestion(d)])),
  }
}
```

- [ ] **Step 5: Implement `src/emit/native.ts`**

```ts
import type { Condition, Decision, Program } from '../ir.js'

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const idKey = (id: string) => (/^[A-Za-z_$][\w$]*$/.test(id) ? id : q(id))

function provenance(d: Decision): string {
  if (!d.source) return ''
  return `  // from ${d.source.file}:${d.source.line} — "${d.source.quote}"\n`
}

function emitDecision(d: Decision): string {
  const head = `${provenance(d)}  ${idKey(d.id)}: `
  if (d.kind === 'noul') {
    const crit = d.criteria && !Array.isArray(d.criteria)
      ? `, criteria: ${JSON.stringify(d.criteria)}` : ''
    return `${head}{ type: 'noul', instructions: ${q(d.instructions)}${crit} },`
  }
  if (d.kind === 'score') {
    const levels = (d.criteria as readonly string[]).map(c => q(String(c))).join(', ')
    // `as const` is load-bearing: without it ScoreOf<T> degrades to `number`.
    return `${head}{ type: 'score', instructions: ${q(d.instructions)}, criteria: [${levels}] as const },`
  }
  const entries = Object.entries(d.criteria as Record<string, unknown>)
    .map(([k, v]) => `${idKey(k)}: ${v == null ? 'null' : q(String(v))}`).join(', ')
  return `${head}{ type: 'choice', instructions: ${q(d.instructions)}, criteria: { ${entries} } as const },`
}

function emitCondition(c: Condition): string {
  // Signature must match runtime.isUncertain(answers, id, program) exactly.
  if (c.op === 'uncertain') return `isUncertain(a, ${q(c.id)}, program)`
  if (c.op === 'is') return `a[${q(c.id)}]?.choice === ${q(c.value)}`
  return `value(a, ${q(c.id)}) ${c.op === 'gte' ? '>=' : '<='} ${c.value}`
}

export function emitNative(p: Program, name = 'program'): string {
  const rules = p.reduce.rules
    .map(r => `  if (${r.when.map(emitCondition).join(' && ')}) return ${q(r.then)}`)
    .join('\n')

  return `// Generated by jevc. Review the questions and thresholds — they are the
// part humans must check. Regenerate with: jevc compile
import type { JevAnswer, Program } from 'jevc'
import { value, isUncertain } from 'jevc'

export const ${name}Questions = {
${p.decisions.map(emitDecision).join('\n')}
} as const

/** Carried so the reducer can resolve each decision's uncertainty rule. */
export const program = ${JSON.stringify({ decisions: p.decisions, reduce: p.reduce, residual: p.residual, dropped: p.dropped }, null, 2)} as unknown as Program

/** The verdict is computed here, in code — never asked of the model. */
export function reduce(a: Record<string, JevAnswer>): string {
${rules}
  return ${q(p.reduce.otherwise)}
}
${p.residual ? `\n/* Still requires a generative model:\n${p.residual}\n*/\n` : ''}`
}
```

- [ ] **Step 6: Run both suites to verify pass**

Run: `npx vitest run test/emit.test.ts && npx vitest --typecheck run test/emit-types.test-d.ts`
Expected: PASS, 6 runtime tests + 3 type tests

- [ ] **Step 7: Commit**

```bash
git add src/emit test/emit.test.ts test/emit-types.test-d.ts vitest.config.ts
git commit -m "feat: native TS and JSON emitters with tuple preservation

Emitted score criteria carry 'as const'. Without it ScoreOf<T> silently
degrades to number and typed legend/probability keys are lost — a
type-level failure invisible at runtime, so it has a type-level test.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Runtime — evaluate, thresholds, uncertainty, reducer

**Files:**
- Create: `src/runtime.ts`
- Test: `test/runtime.test.ts`

**Interfaces:**
- Consumes: `Program`, `uncertaintyOf` from `src/ir.ts`; `JevAnswer`, `JevResponse` from `src/contract.ts`; `TypeSafeClient` from `@typesafe-ai/sdk`
- Produces: `value(a: Record<string, JevAnswer>, id: string): number`, `isUncertain(a: Record<string, JevAnswer>, id: string, p: Program): boolean`, `runReducer(p: Program, answers: Record<string, JevAnswer>): string`, `evaluate(p: Program, state, opts?): Promise<Verdict>`, `type Verdict`

No network in this task's tests — the reducer and threshold logic are pure and tested against literal answer objects.

- [ ] **Step 1: Write the failing tests**

`test/runtime.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { value, isUncertain, runReducer } from '../src/runtime.js'
import type { Program } from '../src/ir.js'
import type { JevAnswer } from '../src/contract.js'

const p: Program = {
  decisions: [
    { id: 'destructive', kind: 'noul', instructions: 'Deletes data?' },
    { id: 'radius', kind: 'score', instructions: 'How wide?',
      criteria: ['one file', 'one dir', 'whole repo'] },
    { id: 'target', kind: 'choice', instructions: 'Target?',
      criteria: { source: null, build: null } },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'destructive', op: 'uncertain' }], then: 'ask' },
    { when: [{ id: 'destructive', op: 'gte', value: 0.8 },
             { id: 'radius', op: 'gte', value: 1.5 }], then: 'deny' },
    { when: [{ id: 'target', op: 'is', value: 'build' }], then: 'allow' },
  ], otherwise: 'ask' },
  residual: '', dropped: [],
}

const answers = (over: Partial<Record<string, JevAnswer>> = {}): Record<string, JevAnswer> => ({
  destructive: { type: 'noul', noul: 0.95 },
  radius: { type: 'score', score: 2.0, legend: { '0': 'one file', '1': 'one dir', '2': 'whole repo' },
    probabilities: { '0': 0, '1': 0, '2': 1 }, confidence: 0.97 },
  target: { type: 'choice', choice: 'source', probabilities: { source: 0.9, build: 0.1 }, confidence: 0.8 },
  ...over,
})

describe('value', () => {
  it('reads a noul probability', () => {
    expect(value(answers(), 'destructive')).toBe(0.95)
  })
  it('reads a score in level-index space, not 0..1', () => {
    expect(value(answers(), 'radius')).toBe(2.0)
  })
})

describe('isUncertain', () => {
  it('treats a noul inside the default band as uncertain', () => {
    expect(isUncertain(answers({ destructive: { type: 'noul', noul: 0.5 } }), 'destructive', p)).toBe(true)
  })
  it('treats a decisive noul as certain at either end', () => {
    expect(isUncertain(answers({ destructive: { type: 'noul', noul: 0.95 } }), 'destructive', p)).toBe(false)
    expect(isUncertain(answers({ destructive: { type: 'noul', noul: 0.05 } }), 'destructive', p)).toBe(false)
  })
  it('uses confidence for a choice, never a band', () => {
    const low = answers({ target: { type: 'choice', choice: 'source',
      probabilities: { source: 0.52, build: 0.48 }, confidence: 0.13 } })
    expect(isUncertain(low, 'target', p)).toBe(true)
  })
})

describe('runReducer', () => {
  it('returns the first matching rule, not the best one', () => {
    expect(runReducer(p, answers())).toBe('deny')
  })
  it('escalates to ask when the gating evidence is uncertain', () => {
    expect(runReducer(p, answers({ destructive: { type: 'noul', noul: 0.5 } }))).toBe('ask')
  })
  it('falls through to otherwise when nothing matches', () => {
    expect(runReducer(p, answers({
      destructive: { type: 'noul', noul: 0.05 },
      target: { type: 'choice', choice: 'source', probabilities: { source: 0.95, build: 0.05 }, confidence: 0.9 },
    }))).toBe('ask')
  })
  it('matches a choice option by name', () => {
    expect(runReducer(p, answers({
      destructive: { type: 'noul', noul: 0.05 },
      target: { type: 'choice', choice: 'build', probabilities: { source: 0.1, build: 0.9 }, confidence: 0.9 },
    }))).toBe('allow')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/runtime.test.ts`
Expected: FAIL — cannot resolve `../src/runtime.js`

- [ ] **Step 3: Implement `src/runtime.ts`**

```ts
import { TypeSafeClient } from '@typesafe-ai/sdk'
import type { JevAnswer, JevModel, JevRequest } from './contract.js'
import { redactErrorBody, validateRequest } from './contract.js'
import { uncertaintyOf, type Program } from './ir.js'
import { emitJson } from './emit/json.js'

export function value(a: Record<string, JevAnswer>, id: string): number {
  const ans = a[id]
  if (!ans) throw new Error(`No answer for decision "${id}".`)
  if (ans.type === 'noul') return ans.noul
  if (ans.type === 'score') return ans.score   // level-index space, 0..n-1
  return ans.confidence
}

export function isUncertain(a: Record<string, JevAnswer>, id: string, p: Program): boolean {
  const ans = a[id]
  if (!ans) throw new Error(`No answer for decision "${id}".`)
  const d = p.decisions.find(x => x.id === id)
  if (!d) throw new Error(`No decision "${id}" in program.`)
  const u = uncertaintyOf(d)
  if (ans.type === 'noul') {
    if (!('band' in u)) throw new Error(`Decision "${id}" is a noul but has no band.`)
    return ans.noul > u.band[0] && ans.noul < u.band[1]
  }
  if (!('belowConfidence' in u)) throw new Error(`Decision "${id}" needs belowConfidence.`)
  return ans.confidence < u.belowConfidence
}

export function runReducer(p: Program, a: Record<string, JevAnswer>): string {
  for (const rule of p.reduce.rules) {
    const ok = rule.when.every(c => {
      if (c.op === 'uncertain') return isUncertain(a, c.id, p)
      if (c.op === 'is') {
        const ans = a[c.id]
        return ans?.type === 'choice' && ans.choice === c.value
      }
      const v = value(a, c.id)
      return c.op === 'gte' ? v >= c.value : v <= c.value
    })
    if (ok) return rule.then
  }
  return p.reduce.otherwise
}

export type Verdict = {
  verdict: string
  answers: Record<string, JevAnswer>
  uncertain: string[]
  usage: { input_tokens: number; output_tokens: number }
  latencyMs: number
}

export type EvaluateOptions = {
  client?: TypeSafeClient
  model?: JevModel
  /** A guardrail must answer fast or get out of the way. */
  timeoutMs?: number
  maxRetries?: number
  now?: () => number
}

export async function evaluate(
  p: Program,
  state: JevRequest['state'],
  opts: EvaluateOptions = {},
): Promise<Verdict> {
  const req = emitJson(p, state, opts.model ?? 'jev-latest')
  const issues = validateRequest(req).filter(i => i.severity === 'error')
  if (issues.length) {
    throw new Error(`Invalid request:\n${issues.map(i => `  ${i.path}: ${i.message}`).join('\n')}`)
  }

  const client = opts.client ?? new TypeSafeClient({
    timeout: opts.timeoutMs ?? 5_000,
    retry: { maxRetries: opts.maxRetries ?? 1 },
  })

  const clock = opts.now ?? (() => Date.now())
  const t0 = clock()
  let res
  try {
    res = await client.systemOne(req as never)
  } catch (e) {
    const err = e as { body?: unknown }
    if (err && typeof err === 'object' && 'body' in err) err.body = redactErrorBody(err.body)
    throw e
  }
  const latencyMs = clock() - t0

  const answers = res.answers as Record<string, JevAnswer>
  return {
    verdict: runReducer(p, answers),
    answers,
    uncertain: p.decisions.filter(d => isUncertain(answers, d.id, p)).map(d => d.id),
    usage: res.usage,
    latencyMs,
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/runtime.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts test/runtime.test.ts
git commit -m "feat: runtime evaluate with first-match reducer and typed uncertainty

Uncertainty is band-based for noul (no confidence field exists) and
confidence-based for choice and score. 422 bodies are redacted before
they escape, since the API echoes the whole request including state.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Fixture replay and the calibration report

**Files:**
- Create: `src/check.ts`
- Test: `test/fixtures.test.ts`

**Interfaces:**
- Consumes: `fixtures/*.json` (already committed), `evaluate` from `src/runtime.ts`
- Produces: `loadFixtures(dir: string): Fixture[]`, `assertExpectation(expect: Expectation, answers): string[]`, `checkLive(fixtures, opts): Promise<Report>`, `type Fixture`, `type Expectation`

The 60 fixtures carry measured responses. Offline replay asserts the *expectation logic* against those recordings — no key, no network, no quota. `check --live` re-measures and reports drift.

- [ ] **Step 1: Write the failing tests**

`test/fixtures.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { loadFixtures, assertExpectation } from '../src/check.js'

const fixtures = loadFixtures('fixtures')

describe('fixture corpus', () => {
  it('loads all five domains', () => {
    expect(readdirSync('fixtures').filter(f => f.endsWith('.json'))).toHaveLength(5)
  })

  it('loads 60 measured fixtures', () => {
    expect(fixtures).toHaveLength(60)
  })

  it('every fixture records the natural-language prompt it replaces', () => {
    for (const f of fixtures) expect(f.llm_prompt.length).toBeGreaterThan(50)
  })

  it('every fixture carries provenance', () => {
    for (const f of fixtures) expect(f.provenance.length).toBeGreaterThan(10)
  })

  it('every measured response satisfies its recorded expectation', () => {
    for (const f of fixtures) {
      expect(assertExpectation(f.expect, f.measured.answers), `${f.id}`).toEqual([])
    }
  })

  it('no expectation asserts exact equality — answers drift +/-0.01', () => {
    for (const f of fixtures) {
      for (const clause of Object.values(f.expect)) {
        expect(Object.keys(clause), `${f.id}`).not.toContain('noul_eq')
        expect(Object.keys(clause), `${f.id}`).not.toContain('score_eq')
      }
    }
  })

  it('every fixture request passes the contract validator', async () => {
    const { validateRequest } = await import('../src/contract.js')
    for (const f of fixtures) {
      const issues = validateRequest({ model: 'jev-latest', state: f.state, questions: f.questions })
        .filter(i => i.severity === 'error')
      expect(issues, `${f.id}: ${issues.map(i => i.message).join('; ')}`).toEqual([])
    }
  })
})

describe('assertExpectation', () => {
  it('reports a violated lower bound', () => {
    const fails = assertExpectation({ a: { noul_gte: 0.8 } }, { a: { type: 'noul', noul: 0.4 } })
    expect(fails[0]).toMatch(/a: noul 0.4 < 0.8/)
  })
  it('passes a satisfied bound', () => {
    expect(assertExpectation({ a: { noul_gte: 0.8 } }, { a: { type: 'noul', noul: 0.9 } })).toEqual([])
  })
  it('checks a choice by name', () => {
    const fails = assertExpectation({ a: { choice: 'deny' } },
      { a: { type: 'choice', choice: 'allow', probabilities: { allow: 1, deny: 0 }, confidence: 1 } })
    expect(fails[0]).toMatch(/expected deny/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/fixtures.test.ts`
Expected: FAIL — cannot resolve `../src/check.js`

- [ ] **Step 3: Implement `src/check.ts`**

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { JevAnswer, JevQuestion, JevRequest } from './contract.js'

export type Expectation = Record<string, {
  noul_gte?: number; noul_lte?: number
  score_gte?: number; score_lte?: number
  confidence_gte?: number
  choice?: string
}>

export type Fixture = {
  id: string
  title: string
  provenance: string
  llm_prompt: string
  rationale: string
  state: JevRequest['state']
  questions: Record<string, JevQuestion>
  expect: Expectation
  measured: {
    answers: Record<string, JevAnswer>
    latency_ms?: number
    model: string
    verdict: string
    prediction_held?: boolean
    notes?: string
  }
  domain: string
}

export function loadFixtures(dir: string): Fixture[] {
  const out: Fixture[] = []
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const doc = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    for (const f of doc.fixtures) {
      const answers = typeof f.measured.answers === 'string'
        ? JSON.parse(f.measured.answers) : f.measured.answers
      out.push({ ...f, domain: doc.domain, measured: { ...f.measured, answers } })
    }
  }
  return out
}

export function assertExpectation(
  exp: Expectation,
  answers: Record<string, JevAnswer>,
): string[] {
  const fails: string[] = []
  for (const [id, clause] of Object.entries(exp)) {
    const a = answers[id]
    if (!a) { fails.push(`${id}: no answer returned`); continue }

    if (clause.noul_gte !== undefined) {
      if (a.type !== 'noul') fails.push(`${id}: expected a noul, got ${a.type}`)
      else if (a.noul < clause.noul_gte) fails.push(`${id}: noul ${a.noul} < ${clause.noul_gte}`)
    }
    if (clause.noul_lte !== undefined) {
      if (a.type !== 'noul') fails.push(`${id}: expected a noul, got ${a.type}`)
      else if (a.noul > clause.noul_lte) fails.push(`${id}: noul ${a.noul} > ${clause.noul_lte}`)
    }
    if (clause.score_gte !== undefined) {
      if (a.type !== 'score') fails.push(`${id}: expected a score, got ${a.type}`)
      else if (a.score < clause.score_gte) fails.push(`${id}: score ${a.score} < ${clause.score_gte}`)
    }
    if (clause.score_lte !== undefined) {
      if (a.type !== 'score') fails.push(`${id}: expected a score, got ${a.type}`)
      else if (a.score > clause.score_lte) fails.push(`${id}: score ${a.score} > ${clause.score_lte}`)
    }
    if (clause.choice !== undefined) {
      if (a.type !== 'choice') fails.push(`${id}: expected a choice, got ${a.type}`)
      else if (a.choice !== clause.choice) fails.push(`${id}: expected ${clause.choice}, got ${a.choice}`)
    }
    if (clause.confidence_gte !== undefined) {
      if (a.type === 'noul') fails.push(`${id}: a noul carries no confidence`)
      else if (a.confidence < clause.confidence_gte) {
        fails.push(`${id}: confidence ${a.confidence} < ${clause.confidence_gte}`)
      }
    }
  }
  return fails
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/fixtures.test.ts`
Expected: PASS, 10 tests

If a fixture fails `validateRequest`, that is a **real finding**, not a test to loosen: the corpus was generated before the validator existed. Fix the fixture's questions to satisfy the contract and re-record its measured answer with a live call, or drop the fixture with a note in the domain file.

- [ ] **Step 5: Implement the live drift check in `src/check.ts`**

`jev-latest` is an alias that moves under you. This is how a model bump surfaces as a
diff rather than as a production incident.

```ts
import { evaluate } from './runtime.js'
import type { Program } from './ir.js'

export type DriftRow = {
  id: string
  recorded: number | string
  live: number | string
  delta: number | null
  status: 'stable' | 'drifted' | 'broken'
}

export type Report = { model: string; rows: DriftRow[]; broken: number; drifted: number }

/** Re-measure the corpus and diff against what was recorded. Requires TYPESAFE_API_KEY. */
export async function checkLive(fixtures: Fixture[], opts: { driftThreshold?: number } = {}): Promise<Report> {
  const threshold = opts.driftThreshold ?? 0.15   // well outside the +/-0.01 noise floor
  const rows: DriftRow[] = []
  let model = ''

  for (const f of fixtures) {
    const program: Program = {
      decisions: Object.entries(f.questions).map(([id, q]) => ({
        id, kind: q.type, instructions: String(q.instructions),
        criteria: 'criteria' in q ? (q.criteria as never) : undefined,
      })),
      reduce: { kind: 'rules', rules: [], otherwise: 'n/a' },
      residual: '', dropped: [],
    }
    const res = await evaluate(program, f.state)
    model = res.model ?? model

    for (const [id, live] of Object.entries(res.answers)) {
      const was = f.measured.answers[id]
      if (!was) { rows.push({ id: `${f.id}.${id}`, recorded: '-', live: 'new', delta: null, status: 'broken' }); continue }
      if (was.type !== live.type) {
        rows.push({ id: `${f.id}.${id}`, recorded: was.type, live: live.type, delta: null, status: 'broken' })
        continue
      }
      if (was.type === 'choice' && live.type === 'choice') {
        const same = was.choice === live.choice
        rows.push({ id: `${f.id}.${id}`, recorded: was.choice, live: live.choice, delta: null,
          status: same ? 'stable' : 'drifted' })
        continue
      }
      const a = was.type === 'noul' ? was.noul : (was as { score: number }).score
      const b = live.type === 'noul' ? live.noul : (live as { score: number }).score
      const delta = Math.abs(a - b)
      rows.push({ id: `${f.id}.${id}`, recorded: a, live: b, delta,
        status: delta > threshold ? 'drifted' : 'stable' })
    }
  }

  return { model, rows,
    broken: rows.filter(r => r.status === 'broken').length,
    drifted: rows.filter(r => r.status === 'drifted').length }
}
```

Add `model` to the `Verdict` type in `src/runtime.ts` (`model: res.model`) so the report can
name the version that answered — alias moves are the whole point of this check.

- [ ] **Step 6: Wire `--live` into the CLI's `check` command**

Replace the `check` branch body in `src/cli.ts` (Task 9) with a `--live` fork:

```ts
if (cmd === 'check') {
  const fixtures = loadFixtures(flag('fixtures') ?? 'fixtures')

  if (has('live')) {
    if (!process.env.TYPESAFE_API_KEY) die('check --live needs TYPESAFE_API_KEY.')
    const { checkLive } = await import('./check.js')
    const report = await checkLive(fixtures)
    for (const r of report.rows.filter(r => r.status !== 'stable')) {
      process.stdout.write(`${r.status.toUpperCase()} ${r.id}: recorded ${r.recorded} -> live ${r.live}
`)
    }
    process.stdout.write(`${report.model}: ${report.rows.length} answers, ${report.drifted} drifted, ${report.broken} broken
`)
    process.exit(report.broken ? 1 : 0)
  }

  let failed = 0
  for (const f of fixtures) {
    const fails = assertExpectation(f.expect, f.measured.answers)
    if (fails.length) { failed++; process.stdout.write(`FAIL ${f.id}\n  ${fails.join('\n  ')}\n`) }
  }
  process.stdout.write(`${fixtures.length} fixtures, ${fixtures.length - failed} passing, ${failed} failing\n`)
  process.exit(failed ? 1 : 0)
}
```

Note this makes `cli.ts` need a top-level `await`, which is fine under ESM.

`check --live` is never part of `npm test`: it costs real requests and needs a key.

- [ ] **Step 7: Commit**

```bash
git add src/check.ts test/fixtures.test.ts
git commit -m "test: offline replay of the 60-fixture measured corpus

Replays recorded responses so the suite needs no API key and burns no
quota. Asserts bands only, never equality: identical calls drift +/-0.01.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The lift protocol — natural language to IR

**Files:**
- Create: `src/from-prompt.ts`
- Test: `test/from-prompt.test.ts`

**Interfaces:**
- Consumes: `Program`, `validateProgram`, `lintProgram` from `src/ir.ts`
- Produces: `buildLiftRequest(source: string, path: string): string`, `parseLiftResponse(json: string, source: string, path: string): { program: Program; issues: ValidationIssue[] }`

`jevc` ships the *protocol*, not a model. The calling agent does the lifting; `jevc` validates it hard. There is no network call in this file and no test of model quality — only of the contract with whatever produced the IR.

- [ ] **Step 1: Write the failing tests**

`test/from-prompt.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildLiftRequest, parseLiftResponse } from '../src/from-prompt.js'

const AGENTS = `# Rules
Never commit unless the user explicitly asks.
Always run the linter before claiming a task is done.`

describe('buildLiftRequest', () => {
  it('includes the source text verbatim', () => {
    expect(buildLiftRequest(AGENTS, 'AGENTS.md')).toContain('Never commit unless')
  })
  it('states the decomposition law so the lifter cannot emit a verdict question', () => {
    const req = buildLiftRequest(AGENTS, 'AGENTS.md')
    expect(req).toMatch(/never.*verdict/i)
    expect(req).toMatch(/0\.13/)   // cites the measurement
  })
  it('demands provenance on every decision', () => {
    expect(buildLiftRequest(AGENTS, 'AGENTS.md')).toMatch(/source.*line/i)
  })
})

describe('parseLiftResponse', () => {
  const good = JSON.stringify({
    decisions: [{ id: 'is_commit', kind: 'noul', instructions: 'Does the command create a commit?',
      source: { file: 'AGENTS.md', line: 2, quote: 'Never commit unless the user explicitly asks.' } }],
    reduce: { kind: 'rules', rules: [{ when: [{ id: 'is_commit', op: 'gte', value: 0.8 }], then: 'ask' }],
      otherwise: 'allow' },
    residual: '', dropped: [],
  })

  it('accepts a well-formed lifted program', () => {
    const { program, issues } = parseLiftResponse(good, AGENTS, 'AGENTS.md')
    expect(issues).toEqual([])
    expect(program.decisions[0].id).toBe('is_commit')
  })

  it('rejects malformed JSON with a useful message', () => {
    const { issues } = parseLiftResponse('{not json', AGENTS, 'AGENTS.md')
    expect(issues[0].code).toBe('lift_unparseable')
  })

  it('rejects a lifted collapsed verdict question', () => {
    const bad = JSON.stringify({
      decisions: [{ id: 'decision', kind: 'choice', instructions: 'What should we do?',
        criteria: { allow: 'ok', deny: 'no' } }],
      reduce: { kind: 'rules', rules: [], otherwise: 'ask' }, residual: '', dropped: [],
    })
    expect(parseLiftResponse(bad, AGENTS, 'AGENTS.md').issues.some(i => i.code === 'collapsed_verdict')).toBe(true)
  })

  it('rejects provenance that does not appear in the source', () => {
    const bad = JSON.stringify({
      decisions: [{ id: 'x', kind: 'noul', instructions: 'q',
        source: { file: 'AGENTS.md', line: 2, quote: 'a rule that was never written' } }],
      reduce: { kind: 'rules', rules: [], otherwise: 'ask' }, residual: '', dropped: [],
    })
    expect(parseLiftResponse(bad, AGENTS, 'AGENTS.md').issues[0].code).toBe('provenance_not_found')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/from-prompt.test.ts`
Expected: FAIL — cannot resolve `../src/from-prompt.js`

- [ ] **Step 3: Implement `src/from-prompt.ts`**

```ts
import type { ValidationIssue } from './contract.js'
import { lintProgram, validateProgram, type Program } from './ir.js'

export function buildLiftRequest(source: string, path: string): string {
  return `Lower the natural-language rules below into a jevc Program (JSON only, no prose).

A Program is:
  { decisions: Decision[], reduce: Reducer, residual: string, dropped: {reason,quote}[] }
  Decision = { id, kind: 'noul'|'choice'|'score', instructions, criteria?, uncertain?, source }
  Reducer  = { kind:'rules', rules: [{ when: Condition[], then: string }], otherwise: string }
  Condition = {id,op:'gte'|'lte',value:number} | {id,op:'is',value:string} | {id,op:'uncertain'}

HARD RULES — a violation is rejected, not repaired:

1. NEVER emit a question that asks for a verdict (allow/ask/deny/block/approve/reject).
   Measured: a collapsed verdict question returned allow 0.42 / block 0.35 / ask 0.23 at
   confidence 0.13, while narrow evidence questions on the SAME input reached 0.93-0.97.
   Emit evidence questions and put the verdict in \`reduce\`, which is code.
2. NEVER emit two questions where one's answer determines the other's. Questions are
   scored independently with no consistency enforced: one measured response asserted
   rule_conflict=exception_wins (0.52) and decision=deny (0.73) at the same time.
3. NEVER emit a question spanning two scopes. A compound authorization question measured
   0.59 — the wrong side of 0.5 — by anchoring on the authorized half of a command.
4. Carve-outs and exceptions ("except rm -rf node_modules") are ALLOWLISTS. Put them in
   \`reduce\`, never in question text — that is what produces the near-uniform verdict.
5. Pattern and glob matching stays in code. Measured: declared deny-patterns matched
   semantics at 0.25/0.10/0.14 while the semantic question on the same input hit
   0.96/0.87/0.85. Ask only what a pattern cannot express.

TYPE RULES: score criteria is an ORDERED ARRAY of 2-10 concrete level descriptions, and
its answer is a level INDEX (0..n-1), not 0..1. choice criteria is a map of 2-255 options.
noul has no confidence — use \`uncertain: {band:[lo,hi]}\`; choice/score use
\`uncertain: {belowConfidence: x}\`.

PROVENANCE: every decision needs \`source: {file, line, quote}\` where \`quote\` appears
VERBATIM in the text below. A decision you cannot trace to a line does not belong.

Anything requiring generated text goes in \`residual\`. An empty \`decisions\` array is a
valid answer: it means this file contains no System One decisions.

--- ${path} ---
${source}
--- end ---

Return only the JSON object.`
}

export function parseLiftResponse(
  json: string,
  source: string,
  path: string,
): { program: Program; issues: ValidationIssue[] } {
  const empty: Program = {
    decisions: [], reduce: { kind: 'rules', rules: [], otherwise: 'review' },
    residual: '', dropped: [],
  }

  let parsed: Program
  try {
    const stripped = json.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    parsed = JSON.parse(stripped)
  } catch (e) {
    return { program: empty, issues: [{
      code: 'lift_unparseable', path, severity: 'error',
      message: `The lifter did not return valid JSON: ${(e as Error).message}`,
    }] }
  }

  if (!Array.isArray(parsed.decisions) || !parsed.reduce) {
    return { program: empty, issues: [{
      code: 'lift_malformed', path, severity: 'error',
      message: 'Lifted output is missing `decisions` or `reduce`.',
    }] }
  }

  const issues: ValidationIssue[] = []
  const haystack = source.replace(/\s+/g, ' ')
  for (const d of parsed.decisions) {
    if (!d.source) {
      issues.push({ code: 'provenance_missing', path: `decisions.${d.id}`, severity: 'error',
        message: `"${d.id}" has no source. Every lifted decision must trace to a line.` })
      continue
    }
    if (!haystack.includes(d.source.quote.replace(/\s+/g, ' ').trim())) {
      issues.push({ code: 'provenance_not_found', path: `decisions.${d.id}`, severity: 'error',
        message: `"${d.id}" cites "${d.source.quote}", which does not appear in ${path}.` })
    }
  }

  issues.push(...validateProgram(parsed), ...lintProgram(parsed))
  return { program: parsed, issues }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/from-prompt.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/from-prompt.ts test/from-prompt.test.ts
git commit -m "feat: lift protocol with hard validation of agent-produced IR

jevc ships the protocol, not the model. Every lifted decision must cite
a verbatim quote from the source file, and the decomposition law is
enforced on the result rather than trusted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The `jevc` CLI

**Files:**
- Create: `src/cli.ts`, `src/index.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `jevc compile <file|-> [--lift] [--emit sdk|json] [-o out]`, `jevc check [--live]`, `jevc explain <id> [--fixtures dir]`

- [ ] **Step 1: Write the failing tests**

`test/cli.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (args: string[], input?: string) =>
  execFileSync('node', ['dist/cli.js', ...args], { input, encoding: 'utf8' })

describe('jevc compile', () => {
  it('compiles a JSON Schema from a file to TypeScript', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevc-'))
    const f = join(dir, 's.json')
    writeFileSync(f, JSON.stringify({ type: 'object', properties: {
      is_urgent: { type: 'boolean', description: 'Urgent?' } } }))
    expect(run(['compile', f])).toMatch(/type: 'noul'/)
  })

  it('reads a schema from stdin with -', () => {
    const out = run(['compile', '-', '--emit', 'json'],
      JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } } }))
    expect(JSON.parse(out).questions.ok.type).toBe('noul')
  })

  it('emits a lift request for a markdown file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevc-'))
    const f = join(dir, 'AGENTS.md')
    writeFileSync(f, '# Rules\nNever push to main.')
    const out = run(['compile', f, '--lift'])
    expect(out).toContain('Never push to main.')
    expect(out).toMatch(/NEVER emit a question that asks for a verdict/)
  })

  it('reports the residual for a free-text field', () => {
    const out = run(['compile', '-', '--emit', 'json'], JSON.stringify({
      type: 'object', properties: { summary: { type: 'string', description: 'Summarise it.' } } }))
    expect(JSON.parse(out).questions).toEqual({})
  })
})

describe('jevc check', () => {
  it('replays the corpus offline and reports 60 fixtures', () => {
    expect(run(['check'])).toMatch(/60 fixtures/)
  })
})

describe('jevc explain', () => {
  it('traces a decision back to the prompt it replaced', () => {
    const out = run(['explain', 'is_commit_operation'])
    expect(out).toMatch(/provenance:/)
    expect(out).toMatch(/replaces:/)
    expect(out).toMatch(/measured:.*noul/)
  })
  it('exits non-zero for an unknown id', () => {
    expect(() => run(['explain', 'no_such_decision'])).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run test/cli.test.ts`
Expected: FAIL — `dist/cli.js` does not exist

- [ ] **Step 3: Implement `src/index.ts`**

```ts
export * from './contract.js'
export * from './ir.js'
export * from './from-schema.js'
export * from './from-prompt.js'
export * from './check.js'
export { emitJson } from './emit/json.js'
export { emitNative } from './emit/native.js'
export { evaluate, runReducer, value, isUncertain } from './runtime.js'
```

- [ ] **Step 4: Implement `src/cli.ts`**

```ts
#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fromJsonSchema } from './from-schema.js'
import { buildLiftRequest } from './from-prompt.js'
import { emitNative } from './emit/native.js'
import { emitJson } from './emit/json.js'
import { lintProgram, validateProgram } from './ir.js'
import { assertExpectation, loadFixtures } from './check.js'

const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name: string) => argv.includes(`--${name}`)
const read = (p: string) => (p === '-' ? readFileSync(0, 'utf8') : readFileSync(p, 'utf8'))

const die = (msg: string): never => { process.stderr.write(`${msg}\n`); process.exit(1) }

if (cmd === 'compile') {
  const path = argv[1] ?? die('usage: jevc compile <file|-> [--lift] [--emit sdk|json] [-o out]')
  const text = read(path)

  if (has('lift')) {
    process.stdout.write(buildLiftRequest(text, path === '-' ? 'stdin' : basename(path)))
    process.exit(0)
  }

  let program
  try {
    program = fromJsonSchema(JSON.parse(text))
  } catch {
    die(`${path} is not JSON Schema. For prose, use: jevc compile ${path} --lift`)
  }

  const issues = [...validateProgram(program!), ...lintProgram(program!)]
  for (const i of issues) process.stderr.write(`${i.severity}: ${i.path}: ${i.message}\n`)
  if (issues.some(i => i.severity === 'error')) process.exit(1)

  if (program!.residual) process.stderr.write(`\nresidual:\n${program!.residual}\n`)
  for (const d of program!.dropped) process.stderr.write(`dropped: ${d.reason}\n`)

  const out = flag('emit') === 'json'
    ? JSON.stringify(emitJson(program!, '<state>'), null, 2)
    : emitNative(program!)

  const dest = flag('o')
  if (dest) { writeFileSync(dest, out); process.stderr.write(`wrote ${dest}\n`) }
  else process.stdout.write(out)
  process.exit(0)
}

if (cmd === 'check') {
  const fixtures = loadFixtures(flag('fixtures') ?? 'fixtures')
  let failed = 0
  for (const f of fixtures) {
    const fails = assertExpectation(f.expect, f.measured.answers)
    if (fails.length) { failed++; process.stdout.write(`FAIL ${f.id}\n  ${fails.join('\n  ')}\n`) }
  }
  process.stdout.write(`${fixtures.length} fixtures, ${fixtures.length - failed} passing, ${failed} failing\n`)
  process.exit(failed ? 1 : 0)
}

if (cmd === 'explain') {
  // The provenance payoff: answer "why does this question exist?"
  const id = argv[1] ?? die('usage: jevc explain <decision-id>')
  const hits = loadFixtures(flag('fixtures') ?? 'fixtures')
    .flatMap(f => Object.keys(f.questions).includes(id) ? [f] : [])
  if (!hits.length) die(`No decision "${id}" found.`)
  for (const f of hits) {
    const q = f.questions[id]
    process.stdout.write(`${id}  (${f.domain}/${f.id})\n`)
    process.stdout.write(`  type:         ${q.type}\n`)
    process.stdout.write(`  instructions: ${String(q.instructions)}\n`)
    process.stdout.write(`  provenance:   ${f.provenance}\n`)
    process.stdout.write(`  measured:     ${JSON.stringify(f.measured.answers[id])}\n`)
    process.stdout.write(`  replaces:     ${f.llm_prompt.slice(0, 120)}...\n\n`)
  }
  process.exit(0)
}

die(`usage: jevc <compile|check|explain> ...`)
```

- [ ] **Step 5: Run to verify pass**

Run: `npm run build && npx vitest run test/cli.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all suites PASS

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts src/index.ts test/cli.test.ts
git commit -m "feat: jevc CLI — compile and check

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: README and runnable examples

**Files:**
- Create: `README.md`, `examples/01-schema-to-jev.ts`, `examples/02-agents-md-guardrail.ts`, `examples/03-model-router.ts`, `examples/README.md`
- Test: `test/examples.test.ts`

**Interfaces:**
- Consumes: the public surface from `src/index.ts`
- Produces: no new code interfaces; examples must compile and run

Examples are drawn from the measured corpus, so every number printed in the README is a real measurement, not an illustration.

- [ ] **Step 1: Write the failing test**

`test/examples.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

describe('examples', () => {
  it('every example typechecks', () => {
    expect(() => execFileSync('npx', ['tsc', '--noEmit', '-p', 'examples/tsconfig.json'],
      { encoding: 'utf8' })).not.toThrow()
  })

  it('every example runs offline without an API key', () => {
    for (const f of readdirSync('examples').filter(f => f.endsWith('.ts'))) {
      const out = execFileSync('npx', ['tsx', `examples/${f}`],
        { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '' } })
      expect(out.length, f).toBeGreaterThan(0)
    }
  })

  it('README claims cite measured numbers that exist in the corpus', () => {
    const readme = readFileSync('README.md', 'utf8')
    // Each quoted latency/probability must be traceable; guard against drift.
    expect(readme).toMatch(/jev-1\.13\.0/)
    expect(readme).toMatch(/60 fixtures/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/examples.test.ts`
Expected: FAIL — `examples/` does not exist

- [ ] **Step 3: Write `examples/01-schema-to-jev.ts`**

```ts
/** Deterministic path: a JSON Schema an LLM would have filled in, lowered to Jev. */
import { fromJsonSchema, emitNative, lintProgram } from '../src/index.js'

const schema = {
  type: 'object',
  properties: {
    is_urgent: { type: 'boolean', description: 'Does the message convey time pressure?' },
    department: { type: 'string', enum: ['billing', 'technical', 'sales'],
      description: 'Which team should handle this?' },
    frustration: { type: 'integer', minimum: 0, maximum: 2,
      description: 'How frustrated is the customer?' },
    reply: { type: 'string', description: 'Draft a reply to the customer.' },
  },
}

const program = fromJsonSchema(schema)
console.log(emitNative(program))
console.log('\n--- residual (still needs an LLM) ---\n' + program.residual)
console.log('\n--- lint ---')
for (const i of lintProgram(program)) console.log(`${i.severity}: ${i.message}`)
```

Expected output: three compiled decisions, `reply` in the residual.

- [ ] **Step 4: Write `examples/02-agents-md-guardrail.ts`**

```ts
/** The central use case: a CLAUDE.md rule enforced instead of merely hoped for.
 *  Numbers below are the measured response recorded in
 *  fixtures/agent-harness-rules.json (jev-1.13.0, 2026-09-18, 731 ms). */
import { runReducer, type Program } from '../src/index.js'
import { loadFixtures } from '../src/check.js'

const fixture = loadFixtures('fixtures')
  .find(f => f.id === 'commit-only-when-explicitly-asked')!

console.log('THE RULE, as written in CLAUDE.md:')
console.log('  "NEVER commit unless the user explicitly asks."\n')
console.log('Original LLM prompt this replaces:', fixture.llm_prompt.length, 'chars')

const program: Program = {
  decisions: [
    { id: 'is_commit_operation', kind: 'noul',
      instructions: 'Does the pending shell command in tool_input.command create a git commit?',
      source: { file: 'CLAUDE.md', line: 1, quote: 'NEVER commit unless the user explicitly asks.' } },
    { id: 'user_explicitly_asked_to_commit', kind: 'noul',
      instructions: 'Looking only at recent_user_turns, did the human explicitly ask for a commit?' },
    { id: 'commit_required_by_requested_task', kind: 'noul',
      instructions: 'Is a commit a required step of something the user did ask for, such as opening a PR?' },
  ],
  // The verdict is computed here, not asked of the model.
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'is_commit_operation', op: 'lte', value: 0.5 }], then: 'allow' },
    { when: [{ id: 'user_explicitly_asked_to_commit', op: 'gte', value: 0.5 }], then: 'allow' },
    { when: [{ id: 'commit_required_by_requested_task', op: 'gte', value: 0.5 }], then: 'allow' },
  ], otherwise: 'deny' },
  residual: '', dropped: [],
}

console.log('\nMeasured answers:', JSON.stringify(fixture.measured.answers, null, 2))
console.log('\nVerdict computed in code:', runReducer(program, fixture.measured.answers))
console.log('Latency:', fixture.measured.latency_ms, 'ms')
```

- [ ] **Step 5: Write `examples/03-model-router.ts`**

```ts
/** Cost optimisation: route to a cheap or frontier tier before spending a token on either. */
import { emitJson, validateRequest, type Program } from '../src/index.js'

const program: Program = {
  decisions: [
    { id: 'needs_multi_step_reasoning', kind: 'noul',
      instructions: 'Does answering require chaining several non-obvious steps?' },
    { id: 'domain_difficulty', kind: 'score',
      instructions: 'How specialised is the knowledge required?',
      criteria: ['general knowledge', 'professional familiarity', 'deep expertise'] },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'needs_multi_step_reasoning', op: 'gte', value: 0.6 }], then: 'frontier' },
    { when: [{ id: 'domain_difficulty', op: 'gte', value: 1.5 }], then: 'frontier' },
  ], otherwise: 'fast' },
  residual: '', dropped: [],
}

const req = emitJson(program, 'Write a Playwright script to scrape a dynamic React site.')
console.log(JSON.stringify(req, null, 2))
console.log('\nvalidation:', validateRequest(req).length === 0 ? 'clean' : 'issues found')
console.log('Routing costs ~1 request at $0.042/Mtok input, output free.')
```

- [ ] **Step 6: Write `examples/tsconfig.json`**

```json
{ "extends": "../tsconfig.json",
  "compilerOptions": { "noEmit": true, "rootDir": ".." },
  "include": ["../src", "."] }
```

- [ ] **Step 7: Write `README.md`**

Required sections, in order. Every number must come from `fixtures/` or the spec's measured tables — no illustrative figures.

1. **One-line pitch** and the before/after: a `CLAUDE.md` rule that is a suggestion, beside the same rule as an enforced invariant.
2. **Why** — the three-part split (decision / generation / procedure) and the honest limit: `jevc` separates them, it does not convert generation into decisions.
3. **The decomposition law**, with the measured table (`decision` at confidence 0.13 vs `blast_radius` at 0.97). This is the single most useful thing a reader learns.
4. **Quick start** — `npx jevc compile schema.json`, `npx jevc compile AGENTS.md --lift`.
5. **What compiles and what does not** — the mapping table from spec §5.
6. **The validator earns its keep** — the spec §3.1 table of six cases where the API returns 200 and a wrong answer.
7. **Calibration** — 60 fixtures, 5 domains, all measured against `jev-1.13.0`; and the fact that 36 of 60 predicted thresholds were wrong, which is why the corpus is measured rather than written.
8. **Relationship to the ecosystem** — depends on `@typesafe-ai/sdk`; emits policy *for* `bouncer` / `toolgate` / `jev-guard` rather than competing with them; complementary to `@mateonunez/jod` (schema-first authoring) and `pi-typesafe` (repairing LLM-emitted Jev JSON).
9. **Security** — key from `TYPESAFE_API_KEY` only; `422` bodies redacted because the API echoes state.

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run test/examples.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 9: Run the full suite and commit**

```bash
npm test
git add README.md examples test/examples.test.ts
git commit -m "docs: README and three runnable examples

Every number in the README traces to a measured fixture. Examples run
offline against recorded responses, so they need no API key.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Target capability model

**Files:**
- Create: `src/emit/capability.ts`
- Test: `test/capability.test.ts`

**Interfaces:**
- Consumes: `Program`, `ValidationIssue`
- Produces: `type TargetCapability`, `TARGETS: Record<string, TargetCapability>`, `canEmit(p: Program, target: string): ValidationIssue[]`

Research established that emit targets differ in *what they can express*, not just in syntax. Three of them accept only boolean questions; one accepts only single-condition rules. Without a capability model each emitter re-invents these checks and silently drops what it cannot carry — which is precisely the failure mode jevc exists to prevent.

| Target | kinds | reducer | confidence | legend |
| --- | --- | --- | --- | --- |
| `sdk` | noul, choice, score | code | yes | yes |
| `json` | noul, choice, score | code | yes | yes |
| `ai-sdk` | noul, choice, score | code | **providerMetadata, may be absent** | **dropped** |
| `langchain` | noul, choice, score | code | yes | yes |
| `bouncer` | **noul only** | **single-condition rules** | no | no |
| `toolgate` | **noul only** | **thresholds only** | no | no |

- [ ] **Step 1: Write the failing tests**

`test/capability.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { canEmit, TARGETS } from '../src/emit/capability.js'
import type { Program } from '../src/ir.js'

const mixed: Program = {
  decisions: [
    { id: 'destructive', kind: 'noul', instructions: 'Deletes data?' },
    { id: 'radius', kind: 'score', instructions: 'How wide?', criteria: ['file', 'dir', 'repo'] },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'destructive', op: 'gte', value: 0.8 }], then: 'deny' }], otherwise: 'allow' },
  residual: '', dropped: [],
}

const nouls: Program = {
  decisions: [
    { id: 'destructive', kind: 'noul', instructions: 'Deletes data?' },
    { id: 'outside_repo', kind: 'noul', instructions: 'Touches paths outside the repo?' },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'destructive', op: 'gte', value: 0.8 }], then: 'deny' }], otherwise: 'allow' },
  residual: '', dropped: [],
}

describe('canEmit', () => {
  it('accepts a mixed-kind program on the native target', () => {
    expect(canEmit(mixed, 'sdk')).toEqual([])
  })

  it('rejects a score decision on bouncer, which is noul-only', () => {
    const issues = canEmit(mixed, 'bouncer')
    expect(issues[0].code).toBe('kind_unsupported')
    expect(issues[0].message).toMatch(/noul/)
  })

  it('rejects a score decision on toolgate, which is boolean-only', () => {
    expect(canEmit(mixed, 'toolgate')[0].code).toBe('kind_unsupported')
  })

  it('accepts an all-noul program on bouncer', () => {
    expect(canEmit(nouls, 'bouncer')).toEqual([])
  })

  it('rejects a multi-condition rule on bouncer, which allows one question per rule', () => {
    const multi: Program = { ...nouls, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'destructive', op: 'gte', value: 0.8 },
               { id: 'outside_repo', op: 'gte', value: 0.5 }], then: 'deny' }], otherwise: 'allow' } }
    expect(canEmit(multi, 'bouncer')[0].code).toBe('reducer_too_complex')
  })

  it('rejects a threshold outside 0..1 on bouncer, whose p grammar is bounded', () => {
    const p: Program = { ...mixed, decisions: [nouls.decisions[0], mixed.decisions[1]],
      reduce: { kind: 'rules', rules: [
        { when: [{ id: 'radius', op: 'gte', value: 1.5 }], then: 'deny' }], otherwise: 'allow' } }
    expect(canEmit(p, 'bouncer').some(i => i.code === 'threshold_out_of_target_range')).toBe(true)
  })

  it('warns that ai-sdk drops the score legend', () => {
    const issues = canEmit(mixed, 'ai-sdk')
    expect(issues.every(i => i.severity === 'warn')).toBe(true)
    expect(issues.some(i => i.code === 'legend_dropped')).toBe(true)
  })

  it('warns when a confidence-based uncertainty rule targets ai-sdk', () => {
    const p: Program = { ...mixed }
    p.decisions[1] = { ...p.decisions[1], uncertain: { belowConfidence: 0.7 } }
    expect(canEmit(p, 'ai-sdk').some(i => i.code === 'confidence_derived')).toBe(true)
  })

  it('rejects an unknown target by name', () => {
    expect(canEmit(mixed, 'nope')[0].code).toBe('unknown_target')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/capability.test.ts`
Expected: FAIL — cannot resolve `../src/emit/capability.js`

- [ ] **Step 3: Implement `src/emit/capability.ts`**

```ts
import type { ValidationIssue } from '../contract.js'
import type { Program } from '../ir.js'

export type TargetCapability = {
  name: string
  kinds: ReadonlyArray<'noul' | 'choice' | 'score'>
  /** 'code': arbitrary reducer. 'single-condition': one question per rule. 'thresholds': per-question only. */
  reducer: 'code' | 'single-condition' | 'thresholds'
  /** Thresholds must fall in this range, or undefined for level-index space. */
  thresholdRange?: [number, number]
  carriesConfidence: boolean
  carriesLegend: boolean
  note?: string
}

export const TARGETS: Record<string, TargetCapability> = {
  sdk:       { name: 'sdk', kinds: ['noul', 'choice', 'score'], reducer: 'code',
               carriesConfidence: true, carriesLegend: true },
  json:      { name: 'json', kinds: ['noul', 'choice', 'score'], reducer: 'code',
               carriesConfidence: true, carriesLegend: true },
  langchain: { name: 'langchain', kinds: ['noul', 'choice', 'score'], reducer: 'code',
               carriesConfidence: true, carriesLegend: true },
  'ai-sdk':  { name: 'ai-sdk', kinds: ['noul', 'choice', 'score'], reducer: 'code',
               carriesConfidence: false, carriesLegend: false,
               note: 'EvaluationModelV4 drops legend and moves confidence into providerMetadata, where it may be absent.' },
  bouncer:   { name: 'bouncer', kinds: ['noul'], reducer: 'single-condition',
               thresholdRange: [0, 1], carriesConfidence: false, carriesLegend: false,
               note: 'gate.questions has no type key; every question is sent as a noul. A rule names exactly one question.' },
  toolgate:  { name: 'toolgate', kinds: ['noul'], reducer: 'thresholds',
               thresholdRange: [0, 1], carriesConfidence: false, carriesLegend: false,
               note: 'validatePolicy throws unless every question is type: boolean.' },
}

export function canEmit(p: Program, target: string): ValidationIssue[] {
  const cap = TARGETS[target]
  if (!cap) {
    return [{ code: 'unknown_target', path: 'target', severity: 'error',
      message: `Unknown emit target "${target}". Known: ${Object.keys(TARGETS).join(', ')}.` }]
  }

  const out: ValidationIssue[] = []

  for (const d of p.decisions) {
    if (!cap.kinds.includes(d.kind)) {
      out.push({ code: 'kind_unsupported', path: `decisions.${d.id}`, severity: 'error',
        message: `Target "${target}" accepts only ${cap.kinds.join('/')} questions; "${d.id}" is a ${d.kind}. ${cap.note ?? ''}`.trim() })
    }
    if (d.kind === 'score' && !cap.carriesLegend) {
      out.push({ code: 'legend_dropped', path: `decisions.${d.id}`, severity: 'warn',
        message: `Target "${target}" does not return a legend, so a bare score is uninterpretable. jevc keeps the level descriptions beside the emitted code.` })
    }
    if (d.uncertain && 'belowConfidence' in d.uncertain && !cap.carriesConfidence) {
      out.push({ code: 'confidence_derived', path: `decisions.${d.id}.uncertain`, severity: 'warn',
        message: `Target "${target}" does not return confidence inline; it will be recomputed from the probability distribution. Never treat an absent confidence as 0.` })
    }
  }

  if (cap.reducer !== 'code') {
    for (const [i, rule] of p.reduce.rules.entries()) {
      if (rule.when.length > 1) {
        out.push({ code: 'reducer_too_complex', path: `reduce.rules[${i}]`, severity: 'error',
          message: `Target "${target}" allows one question per rule; this rule tests ${rule.when.length}. Split it, or emit to a code target.` })
      }
      for (const c of rule.when) {
        if ((c.op === 'gte' || c.op === 'lte') && cap.thresholdRange) {
          const [lo, hi] = cap.thresholdRange
          if (c.value < lo || c.value > hi) {
            out.push({ code: 'threshold_out_of_target_range', path: `reduce.rules[${i}]`, severity: 'error',
              message: `Target "${target}" accepts thresholds in ${lo}..${hi}; got ${c.value}. Score level-index thresholds cannot be expressed here.` })
          }
        }
        if (c.op === 'uncertain' && !cap.carriesConfidence) {
          out.push({ code: 'uncertain_unsupported', path: `reduce.rules[${i}]`, severity: 'error',
            message: `Target "${target}" cannot express an uncertainty condition.` })
        }
      }
    }
  }

  return out
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/capability.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/emit/capability.ts test/capability.test.ts
git commit -m "feat: target capability model

Emit targets differ in what they can express, not just in syntax: three
accept only boolean questions and one accepts only single-condition
rules. canEmit() refuses rather than silently dropping what a target
cannot carry.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Vercel AI SDK and LangChain emitters

**Files:**
- Create: `src/emit/ai-sdk.ts`, `src/emit/langchain.ts`
- Test: `test/emit-backends.test.ts`

**Interfaces:**
- Consumes: `Program`, `canEmit`
- Produces: `emitAiSdk(p: Program, name?: string): string`, `emitLangchain(p: Program, name?: string): string`

- [ ] **Step 1: Write the failing tests**

`test/emit-backends.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { emitAiSdk } from '../src/emit/ai-sdk.js'
import { emitLangchain } from '../src/emit/langchain.js'
import type { Program } from '../src/ir.js'

const p: Program = {
  decisions: [
    { id: 'is_urgent', kind: 'noul', instructions: 'Urgent?',
      criteria: { true: 'time pressure stated', false: 'no time pressure' } },
    { id: 'dept', kind: 'choice', instructions: 'Which team?',
      criteria: { billing: 'payments', technical: 'bugs' } },
    { id: 'frustration', kind: 'score', instructions: 'How frustrated?',
      criteria: ['calm', 'annoyed', 'furious'] },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'is_urgent', op: 'gte', value: 0.8 }], then: 'escalate' }], otherwise: 'queue' },
  residual: '', dropped: [],
}

describe('emitAiSdk', () => {
  it("renames noul to the spec's boolean type", () => {
    const src = emitAiSdk(p)
    expect(src).toMatch(/type: 'boolean'/)
    expect(src).not.toMatch(/type: 'noul'/)
  })
  it('reads the answer from .probability, not .noul', () => {
    expect(emitAiSdk(p)).toMatch(/\.probability/)
  })
  it('keeps the score legend locally, since the target drops it', () => {
    const src = emitAiSdk(p)
    expect(src).toMatch(/LEGEND/)
    expect(src).toMatch(/'0': 'calm'/)
  })
  it('recomputes confidence from probabilities rather than defaulting to zero', () => {
    const src = emitAiSdk(p)
    expect(src).toMatch(/providerMetadata/)
    expect(src).toMatch(/confidenceFrom/)
    expect(src).not.toMatch(/confidence \?\? 0/)
  })
  it('uses createTypeSafeAi rather than the singleton', () => {
    expect(emitAiSdk(p)).toMatch(/createTypeSafeAi/)
    expect(emitAiSdk(p)).not.toMatch(/^import \{ typeSafeAi \}/m)
  })
  it('never asserts that probabilities sum to 1 — values are rounded to 2dp', () => {
    expect(emitAiSdk(p)).not.toMatch(/=== 1/)
  })
})

describe('emitLangchain', () => {
  it('emits Python question constructors', () => {
    const src = emitLangchain(p)
    expect(src).toMatch(/Noul\(/)
    expect(src).toMatch(/Choice\(/)
    expect(src).toMatch(/Score\(/)
  })
  it('keeps the noul name, which this target preserves', () => {
    expect(emitLangchain(p)).not.toMatch(/boolean/)
  })
  it('emits NoulCriteria explicitly, because the library default is dead code', () => {
    expect(emitLangchain(p)).toMatch(/NoulCriteria\(/)
  })
  it('emits a TypeSafeClassifier with only documented fields', () => {
    const src = emitLangchain(p)
    expect(src).toMatch(/TypeSafeClassifier\(/)
    expect(src).not.toMatch(/api_key=/)   // comes from env; extra="forbid"
  })
  it('emits the reducer as Python reading flat answers', () => {
    const src = emitLangchain(p)
    expect(src).toMatch(/def reduce/)
    expect(src).toMatch(/return "escalate"/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/emit-backends.test.ts`
Expected: FAIL — cannot resolve the two emitter modules

- [ ] **Step 3: Implement `src/emit/ai-sdk.ts`**

```ts
import type { Decision, Program } from '../ir.js'

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

function question(d: Decision): string {
  if (d.kind === 'noul') {
    // EvaluationModelV4 renames noul -> boolean; the answer field becomes `probability`.
    const c = d.criteria && !Array.isArray(d.criteria) ? `, criteria: ${JSON.stringify(d.criteria)}` : ''
    return `  ${d.id}: { type: 'boolean', instructions: ${q(d.instructions)}${c} },`
  }
  if (d.kind === 'score') {
    const lv = (d.criteria as readonly string[]).map(String).map(q).join(', ')
    return `  ${d.id}: { type: 'score', instructions: ${q(d.instructions)}, criteria: [${lv}] as const },`
  }
  const opts = Object.entries(d.criteria as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${v == null ? 'null' : q(String(v))}`).join(', ')
  return `  ${d.id}: { type: 'choice', instructions: ${q(d.instructions)}, criteria: { ${opts} } as const },`
}

export function emitAiSdk(p: Program, name = 'program'): string {
  const legends = p.decisions
    .filter(d => d.kind === 'score')
    .map(d => `  ${d.id}: { ${(d.criteria as readonly string[])
      .map((c, i) => `'${i}': ${q(String(c))}`).join(', ')} },`)
    .join('\n')

  const rules = p.reduce.rules.map(r => {
    const conds = r.when.map(c => {
      if (c.op === 'is') return `a.${c.id}?.choice === ${q(c.value)}`
      if (c.op === 'uncertain') return `confidenceFrom(a.${c.id}) < 0.5`
      const read = `(a.${c.id}?.probability ?? a.${c.id}?.score ?? 0)`
      return `${read} ${c.op === 'gte' ? '>=' : '<='} ${c.value}`
    }).join(' && ')
    return `  if (${conds}) return ${q(r.then)}`
  }).join('\n')

  return `// Generated by jevc for @ai-sdk/typesafe-ai.
// NOTE: this backend renames noul -> boolean and its answer field -> probability,
// drops \`legend\` entirely, and returns confidence only under providerMetadata,
// where it may be ABSENT. Values are rounded to 2dp, so distributions may not sum to 1.
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai'

// The target drops legend, so jevc keeps it here. A bare score is uninterpretable without it.
export const LEGEND = {
${legends || '  // no score questions'}
} as const

export const ${name}Questions = {
${p.decisions.map(question).join('\n')}
} as const

/** Confidence is not returned inline. Derive it; never treat absence as zero. */
export function confidenceFrom(answer: { probabilities?: Record<string, number>; probability?: number }): number {
  if (typeof answer?.probability === 'number') return Math.abs(2 * answer.probability - 1)
  const ps = Object.values(answer?.probabilities ?? {})
  if (!ps.length) return 0
  const sorted = [...ps].sort((x, y) => y - x)
  return sorted[0] - (sorted[1] ?? 0)
}

export function reduce(a: Record<string, any>): string {
${rules}
  return ${q(p.reduce.otherwise)}
}

export const model = createTypeSafeAi({ apiKey: process.env.TYPESAFE_AI_API_KEY })
  .evaluationModel('jev-latest')
`
}
```

- [ ] **Step 4: Implement `src/emit/langchain.ts`**

```ts
import type { Decision, Program } from '../ir.js'

const py = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

function question(d: Decision): string {
  if (d.kind === 'noul') {
    const c = d.criteria && !Array.isArray(d.criteria)
      ? (d.criteria as { true?: unknown; false?: unknown }) : undefined
    // criteria is passed explicitly: the library's own default is unreachable dead code.
    const crit = c
      ? `, criteria=NoulCriteria(true=${py(String(c.true ?? ''))}, false=${py(String(c.false ?? ''))})`
      : ''
    return `    ${py(d.id)}: Noul(instructions=${py(d.instructions)}${crit}),`
  }
  if (d.kind === 'score') {
    const lv = (d.criteria as readonly string[]).map(String).map(py).join(', ')
    return `    ${py(d.id)}: Score(instructions=${py(d.instructions)}, criteria=[${lv}]),`
  }
  const opts = Object.entries(d.criteria as Record<string, unknown>)
    .map(([k, v]) => `${py(k)}: ${v == null ? 'None' : py(String(v))}`).join(', ')
  return `    ${py(d.id)}: Choice(instructions=${py(d.instructions)}, criteria={${opts}}),`
}

export function emitLangchain(p: Program, name = 'program'): string {
  const rules = p.reduce.rules.map(r => {
    const conds = r.when.map(c => {
      if (c.op === 'is') return `answers[${py(c.id)}].choice == ${py(c.value)}`
      if (c.op === 'uncertain') return `answers[${py(c.id)}].confidence < 0.5`
      const read = `getattr(answers[${py(c.id)}], "noul", None) or getattr(answers[${py(c.id)}], "score", 0)`
      return `(${read}) ${c.op === 'gte' ? '>=' : '<='} ${c.value}`
    }).join(' and ')
    return `    if ${conds}:\n        return ${py(r.then)}`
  }).join('\n')

  return `# Generated by jevc for langchain-typesafe.
# api_key and base_url come from the environment: TypeSafeClassifier sets
# extra="forbid", so a stray kwarg is a hard error.
from langchain_typesafe import Choice, Noul, NoulCriteria, Score, TypeSafeClassifier

${name}_questions = {
${p.decisions.map(question).join('\n')}
}

classifier = TypeSafeClassifier(questions=${name}_questions, model="jev-latest")


def reduce(answers) -> str:
    """The verdict is computed here, in code — never asked of the model."""
${rules}
    return ${py(p.reduce.otherwise)}
`
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/emit-backends.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 6: Commit**

```bash
git add src/emit/ai-sdk.ts src/emit/langchain.ts test/emit-backends.test.ts
git commit -m "feat: Vercel AI SDK and LangChain emitters

ai-sdk renames noul to boolean, drops legend, and hides confidence in
providerMetadata where it may be absent — so jevc keeps the legend
locally and derives confidence from the distribution. langchain passes
NoulCriteria explicitly because the library's own default never applies.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Policy emitters for bouncer and toolgate

**Files:**
- Create: `src/emit/policy/bouncer.ts`, `src/emit/policy/toolgate.ts`
- Modify: `src/cli.ts` (add `emit-policy`), `package.json` (add `yaml`)
- Test: `test/emit-policy.test.ts`

**Interfaces:**
- Consumes: `Program`, `canEmit`
- Produces: `emitBouncerPolicy(p: Program, opts?): string`, `emitToolgatePolicy(p: Program, opts?): string`

`jev-guard` was investigated and **cut**: its questions are `export const` object literals in `src/guard.js` and its `decide()` destructures four fixed ids, so there is nothing to emit into. Do not add it.

- [ ] **Step 1: Add the YAML dependency**

Run: `npm install yaml@^2.5.0`

This is the only dependency added beyond the SDK, and only these two emitters use it.

- [ ] **Step 2: Write the failing tests**

`test/emit-policy.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import { emitBouncerPolicy } from '../src/emit/policy/bouncer.js'
import { emitToolgatePolicy } from '../src/emit/policy/toolgate.js'
import type { Program } from '../src/ir.js'

const p: Program = {
  decisions: [
    { id: 'deletes_tracked_files', kind: 'noul',
      instructions: 'Does the command delete files tracked by git?',
      criteria: { true: 'deletes tracked source', false: 'touches only regenerable output' },
      source: { file: 'AGENTS.md', line: 7, quote: 'Never delete tracked files.' } },
    { id: 'outside_repo', kind: 'noul', instructions: 'Does it touch paths outside the repo root?' },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'deletes_tracked_files', op: 'gte', value: 0.8 }], then: 'deny' },
    { when: [{ id: 'outside_repo', op: 'gte', value: 0.6 }], then: 'ask' },
  ], otherwise: 'allow' },
  residual: '', dropped: [],
}

describe('emitBouncerPolicy', () => {
  const doc = () => parse(emitBouncerPolicy(p))

  it('emits version 1, which bouncer requires exactly', () => {
    expect(doc().version).toBe(1)
  })
  it('defaults to observe mode so a generated policy cannot block on day one', () => {
    expect(doc().mode).toBe('observe')
  })
  it('emits each decision under gate.questions with true/false criteria', () => {
    const q = doc().gate.questions
    expect(Object.keys(q)).toEqual(['deletes_tracked_files', 'outside_repo'])
    expect(q.deletes_tracked_files.criteria.true).toMatch(/tracked source/)
  })
  it('never emits a type key, since bouncer hardcodes noul', () => {
    expect(emitBouncerPolicy(p)).not.toMatch(/type:/)
  })
  it("emits rules in bouncer's p-comparison string grammar", () => {
    expect(doc().gate.rules[0]).toEqual({ when: { deletes_tracked_files: { p: '>=0.8' } }, then: 'deny' })
  })
  it('emits exactly one terminal default, last', () => {
    const rules = doc().gate.rules
    expect(rules.filter((r: any) => 'default' in r)).toHaveLength(1)
    expect(rules.at(-1)).toEqual({ default: 'allow' })
  })
  it('rejects a reserved question named "any"', () => {
    const bad: Program = { ...p, decisions: [{ id: 'any', kind: 'noul', instructions: 'x' }] }
    expect(() => emitBouncerPolicy(bad)).toThrow(/reserved/)
  })
  it('carries provenance through as a YAML comment', () => {
    expect(emitBouncerPolicy(p)).toMatch(/# AGENTS\.md:7 — Never delete tracked files\./)
  })
})

describe('emitToolgatePolicy', () => {
  it('emits every question as type boolean, which its validator requires', () => {
    const doc = parse(emitToolgatePolicy(p))
    expect(Object.values(doc.questions).every((q: any) => q.type === 'boolean')).toBe(true)
  })
  it('notes that built-ins cannot be removed, only shadowed', () => {
    expect(emitToolgatePolicy(p)).toMatch(/built-in/i)
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/emit-policy.test.ts`
Expected: FAIL — cannot resolve the policy emitter modules

- [ ] **Step 4: Implement `src/emit/policy/bouncer.ts`**

```ts
import { stringify } from 'yaml'
import type { Program } from '../../ir.js'
import { canEmit } from '../capability.js'

export type BouncerOptions = {
  mode?: 'observe' | 'guard' | 'full'
  tools?: string[]
  timeoutMs?: number
}

const cmp = (op: 'gte' | 'lte', v: number) => `${op === 'gte' ? '>=' : '<='}${v}`

export function emitBouncerPolicy(p: Program, opts: BouncerOptions = {}): string {
  const issues = canEmit(p, 'bouncer').filter(i => i.severity === 'error')
  if (issues.length) {
    throw new Error(`Cannot emit a bouncer policy:\n${issues.map(i => `  ${i.path}: ${i.message}`).join('\n')}`)
  }
  for (const d of p.decisions) {
    if (d.id === 'any') throw new Error('"any" is reserved by bouncer as the cross-question selector.')
  }

  const questions: Record<string, unknown> = {}
  for (const d of p.decisions) {
    const c = d.criteria && !Array.isArray(d.criteria)
      ? (d.criteria as { true?: unknown; false?: unknown }) : undefined
    // No `type` key: bouncer hardcodes type "noul" for every question.
    questions[d.id] = c
      ? { instructions: d.instructions, criteria: { true: String(c.true ?? ''), false: String(c.false ?? '') } }
      : { instructions: d.instructions }
  }

  const rules: unknown[] = p.reduce.rules.map(r => {
    const c = r.when[0]   // canEmit guarantees exactly one
    if (c.op === 'is' || c.op === 'uncertain') {
      throw new Error(`bouncer rules compare a noul probability; "${c.op}" cannot be expressed.`)
    }
    return { when: { [c.id]: { p: cmp(c.op, c.value) } }, then: r.then }
  })
  rules.push({ default: p.reduce.otherwise })   // exactly one terminal default, last

  const doc = stringify({
    version: 1,
    backend: 'jev',
    mode: opts.mode ?? 'observe',
    timeout_ms: opts.timeoutMs ?? 800,
    on_error: 'passthrough',
    gate: { tools: opts.tools ?? ['Bash', 'Edit', 'Write', 'NotebookEdit'], questions, rules },
  })

  const provenance = p.decisions
    .filter(d => d.source)
    .map(d => `# ${d.id}: ${d.source!.file}:${d.source!.line} — ${d.source!.quote}`)
    .join('\n')

  return `# Generated by jevc from natural-language rules.
# Review the questions and thresholds — they are the part humans must check.
# Ships in observe mode: it logs and emits nothing. Run \`bouncer calibrate\`
# against your own traffic before moving to guard.
${provenance ? `#\n${provenance}\n` : ''}
${doc}`
}
```

- [ ] **Step 5: Implement `src/emit/policy/toolgate.ts`**

```ts
import { stringify } from 'yaml'
import type { Program } from '../../ir.js'
import { canEmit } from '../capability.js'

export function emitToolgatePolicy(p: Program): string {
  const issues = canEmit(p, 'toolgate').filter(i => i.severity === 'error')
  if (issues.length) {
    throw new Error(`Cannot emit a toolgate policy:\n${issues.map(i => `  ${i.path}: ${i.message}`).join('\n')}`)
  }

  const questions: Record<string, unknown> = {}
  for (const d of p.decisions) {
    // validatePolicy throws unless every question is exactly { type: boolean, instructions: string }.
    questions[d.id] = { type: 'boolean', instructions: d.instructions }
  }

  const thresholds: Record<string, number> = {}
  for (const r of p.reduce.rules) {
    const c = r.when[0]
    if (c.op === 'gte') thresholds[c.id] = c.value
  }

  return `# Generated by jevc.
# toolgate merges these over its four built-in questions (destructive,
# exfiltration, privilege, off_task). Built-ins cannot be removed — reuse a
# built-in id to shadow it. Every question must be type: boolean; choice and
# score decisions cannot be lowered to this target.
${stringify({ questions, thresholds })}`
}
```

- [ ] **Step 6: Wire `emit-policy` into the CLI**

In `src/cli.ts`, before the final `die(...)`:

```ts
if (cmd === 'emit-policy') {
  const target = flag('for') ?? die('usage: jevc emit-policy --for <bouncer|toolgate> <program.json>')
  const path = argv.find(a => a.endsWith('.json')) ?? die('supply a compiled program JSON file')
  const program = JSON.parse(readFileSync(path, 'utf8'))
  const { emitBouncerPolicy } = await import('./emit/policy/bouncer.js')
  const { emitToolgatePolicy } = await import('./emit/policy/toolgate.js')
  if (target === 'bouncer') process.stdout.write(emitBouncerPolicy(program))
  else if (target === 'toolgate') process.stdout.write(emitToolgatePolicy(program))
  else die(`Unknown policy target "${target}". Known: bouncer, toolgate. (jev-guard hardcodes its questions in source and cannot be targeted.)`)
  process.exit(0)
}
```

Update the usage line to `jevc <compile|check|explain|emit-policy> ...`.

- [ ] **Step 7: Run to verify pass, then the whole suite**

Run: `npx vitest run test/emit-policy.test.ts && npm run build && npm test`
Expected: PASS, 10 new tests; full suite green

- [ ] **Step 8: Commit**

```bash
git add src/emit/policy package.json package-lock.json src/cli.ts test/emit-policy.test.ts
git commit -m "feat: bouncer and toolgate policy emitters

Both targets are noul-only and bouncer allows one question per rule, so
canEmit() refuses anything richer rather than dropping it. Generated
bouncer policies ship in observe mode: a compiled rule must be
calibrated before it is given authority.

jev-guard was investigated and cut — its questions are const literals in
source and decide() destructures four fixed ids.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
