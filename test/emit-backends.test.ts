import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitAiSdk } from '../src/emit/ai-sdk.js'
import { emitLangchain } from '../src/emit/langchain.js'
import { runReducer } from '../src/runtime.js'
import type { JevAnswer } from '../src/contract.js'
import type { Program } from '../src/ir.js'

// ---------------------------------------------------------------------------
// Execution harnesses. Reading generated code is how three rounds of review missed
// what it does; these compile it and RUN it against stub answers shaped exactly as
// target-ai-sdk-and-langchain.md verified the real ones to be.
// ---------------------------------------------------------------------------

const tmp = (tag: string) => mkdtempSync(join(tmpdir(), `jevc-${tag}-`))

/** @ai-sdk/typesafe-ai is the CONSUMER's dependency, not jevc's, so the provider import
 *  and the `model` export cannot resolve here. Neither is part of the reducer under test;
 *  everything else runs verbatim. */
const stripProvider = (src: string) => src.split('\n')
  .filter(l => !l.startsWith('import { createTypeSafeAi }')
            && !l.startsWith('export const model =')
            && !l.startsWith('  .evaluationModel('))
  .join('\n')

type AiCase = { answers: Record<string, unknown>; confidence?: Record<string, number> }

/** Typechecks the emitted module under --strict and returns reduce()'s verdict per case. */
function runAiSdk(src: string, cases: AiCase[]): string[] {
  const dir = tmp('aisdk')
  const mod = join(dir, 'mod.ts')
  writeFileSync(mod, stripProvider(src))
  execFileSync('node_modules/.bin/tsc', ['--noEmit', '--strict', '--target', 'es2022',
    '--module', 'es2022', '--moduleResolution', 'bundler', '--skipLibCheck', mod],
    { encoding: 'utf8' })
  const driver = join(dir, 'run.ts')
  writeFileSync(driver, [
    `import { reduce } from './mod.ts'`,
    `const cases = ${JSON.stringify(cases)}`,
    `console.log(JSON.stringify(cases.map(c => reduce(c.answers as any, c.confidence))))`,
  ].join('\n'))
  return JSON.parse(execFileSync('node_modules/.bin/tsx', [driver], { encoding: 'utf8' }))
}

/** langchain-typesafe is likewise the consumer's dependency. The stubs reproduce the
 *  answer shapes the target doc verified by execution — NoulAnswer has `.noul` and NO
 *  `.confidence`; choice and score carry a required `.confidence`. */
const PY_STUBS = `
class _Kw:
    def __init__(self, **kw): self.__dict__.update(kw)
class Noul(_Kw): pass
class Choice(_Kw): pass
class Score(_Kw): pass
class NoulCriteria(_Kw): pass
class TypeSafeClassifier(_Kw): pass

class NoulAnswer:
    __slots__ = ("type", "noul")
    def __init__(self, noul): self.type, self.noul = "noul", noul
class ChoiceAnswer:
    __slots__ = ("type", "choice", "probabilities", "confidence")
    def __init__(self, choice, confidence, probabilities=None):
        self.type, self.choice, self.confidence = "choice", choice, confidence
        self.probabilities = probabilities or {}
class ScoreAnswer:
    __slots__ = ("type", "score", "legend", "probabilities", "confidence")
    def __init__(self, score, confidence, legend=None, probabilities=None):
        self.type, self.score, self.confidence = "score", score, confidence
        self.legend, self.probabilities = legend or {}, probabilities or {}
`

const stripLangchainImport = (src: string) =>
  PY_STUBS + src.split('\n').filter(l => !l.startsWith('from langchain_typesafe import')).join('\n')

/** Parses the emitted module with `ast` and then RUNS its reduce() per case. */
function runLangchain(src: string, cases: Array<Record<string, unknown>>): string[] {
  const dir = tmp('langchain')
  const mod = join(dir, 'mod.py')
  writeFileSync(mod, stripLangchainImport(src))
  execFileSync('python3', ['-c', `import ast, sys; ast.parse(open(sys.argv[1]).read())`, mod],
    { encoding: 'utf8' })
  const driver = join(dir, 'run.py')
  writeFileSync(driver, [
    'import json',
    'from mod import reduce, NoulAnswer, ChoiceAnswer, ScoreAnswer',
    'def mk(spec):',
    '    spec = dict(spec)',
    '    kind = spec.pop("kind")',
    '    return {"noul": NoulAnswer, "choice": ChoiceAnswer, "score": ScoreAnswer}[kind](**spec)',
    `cases = json.loads(${JSON.stringify(JSON.stringify(cases))})`,
    'print(json.dumps([reduce({k: mk(v) for k, v in c.items()}) for c in cases]))',
  ].join('\n'))
  return JSON.parse(execFileSync('python3', [driver], { cwd: dir, encoding: 'utf8' }))
}

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
    expect(src).toMatch(/"0": "calm"/)
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

  // EntryType is `string | object | array | null`; String() on the object form renders
  // "[object Object]" silently. Fourth site of the same bug across this codebase.
  it('renders object-form criteria as JSON, not [object Object]', () => {
    const obj: Program = { ...p, decisions: [
      { id: 'weird', kind: 'score', instructions: 'How?',
        criteria: [{ label: 'low' }, { label: 'high' }] }] }
    const src = emitAiSdk(obj)
    expect(src).not.toContain('[object Object]')
    expect(src).toContain('{"label":"low"}')
  })

  it('escapes a newline in instructions instead of breaking the string literal', () => {
    const nl: Program = { ...p, decisions: [
      { id: 'multi', kind: 'noul', instructions: 'line one\nline two' }] }
    expect(emitAiSdk(nl)).toContain('"line one\\nline two"')
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

  // JSON is not Python: true/false/null are syntax errors there.
  it('renders object-form criteria as Python literals, not JSON', () => {
    const obj: Program = { ...p, decisions: [
      { id: 'weird', kind: 'score', instructions: 'How?',
        criteria: [{ label: 'low', strict: true }, null] }] }
    const src = emitLangchain(obj)
    expect(src).not.toContain('[object Object]')
    expect(src).toContain('{"label": "low", "strict": True}')
    expect(src).toContain('None')
    expect(src).not.toMatch(/\btrue\b|\bnull\b/)
  })

  it('emits a missing noul criteria side as None rather than an empty string', () => {
    const half: Program = { ...p, decisions: [
      { id: 'x', kind: 'noul', instructions: 'Yes?', criteria: { true: 'it is' } }] }
    expect(emitLangchain(half)).toContain('NoulCriteria(true="it is", false=None)')
  })
})

// ---------------------------------------------------------------------------
// C4 — the declared uncertainty, not a literal 0.5
// ---------------------------------------------------------------------------

/** No `uncertain` field, so uncertaintyOf() resolves the IR default band [0.35, 0.65]. */
const bandDefault: Program = {
  decisions: [{ id: 'is_urgent', kind: 'noul', instructions: 'Urgent?' }],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'is_urgent', op: 'uncertain' }], then: 'ask' }], otherwise: 'allow' },
  residual: '', dropped: [],
}

/** A declared confidence floor well away from 0.5, so a literal 0.5 cannot pass by luck. */
const tightChoice: Program = {
  decisions: [{ id: 'dept', kind: 'choice', instructions: 'Which team?',
    criteria: { billing: 'payments', technical: 'bugs' }, uncertain: { belowConfidence: 0.9 } }],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'dept', op: 'uncertain' }], then: 'ask' }], otherwise: 'allow' },
  residual: '', dropped: [],
}

const BAND_GRID = [0, 0.2, 0.3, 0.34, 0.35, 0.4, 0.5, 0.6, 0.65, 0.7, 0.9, 1]
const CONF_GRID = [0.1, 0.3, 0.5, 0.7, 0.89, 0.9, 0.95, 1]

const expectedBand = BAND_GRID.map(v =>
  runReducer(bandDefault, { is_urgent: { type: 'noul', noul: v } as JevAnswer }))
const expectedConf = CONF_GRID.map(c =>
  runReducer(tightChoice, { dept: { type: 'choice', choice: 'billing', confidence: c,
    probabilities: { billing: c, technical: 1 - c } } as JevAnswer }))

describe('emitted uncertainty', () => {
  // uncertaintyOf() resolves a per-decision band (default [0.35, 0.65]); the emitter
  // lowered every `uncertain` condition to `confidenceFrom(...) < 0.5`, which is
  // 0.25 < p < 0.75. At p=0.30 the Program says allow and the generated code said ask.
  it('ai-sdk: honours the noul band rather than a literal 0.5', () => {
    const got = runAiSdk(emitAiSdk(bandDefault),
      BAND_GRID.map(v => ({ answers: { is_urgent: { type: 'boolean', probability: v } } })))
    expect(got).toEqual(expectedBand)
  }, 60_000)

  it('ai-sdk: honours a declared belowConfidence rather than a literal 0.5', () => {
    const got = runAiSdk(emitAiSdk(tightChoice), CONF_GRID.map(c => ({
      answers: { dept: { type: 'choice', choice: 'billing',
        probabilities: { billing: c, technical: 1 - c } } },
      confidence: { dept: c },
    })))
    expect(got).toEqual(expectedConf)
  }, 60_000)

  // target-ai-sdk-and-langchain.md B.3: NoulAnswer is {type, noul} with NO confidence
  // field, so `answers[id].confidence` on a noul is an AttributeError at runtime.
  it('langchain: tests a noul band on .noul, which is the only field a NoulAnswer has', () => {
    const got = runLangchain(emitLangchain(bandDefault),
      BAND_GRID.map(v => ({ is_urgent: { kind: 'noul', noul: v } })))
    expect(got).toEqual(expectedBand)
  }, 60_000)

  it('langchain: honours a declared belowConfidence on a choice', () => {
    const got = runLangchain(emitLangchain(tightChoice),
      CONF_GRID.map(c => ({ dept: { kind: 'choice', choice: 'billing', confidence: c } })))
    expect(got).toEqual(expectedConf)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// C5 — a threshold against a choice compares its confidence, as value() does
// ---------------------------------------------------------------------------

const choiceThreshold: Program = {
  decisions: [{ id: 'dept', kind: 'choice', instructions: 'Which team?',
    criteria: { billing: 'payments', technical: 'bugs' } }],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'dept', op: 'gte', value: 0.7 }], then: 'route' }], otherwise: 'ask' },
  residual: '', dropped: [],
}

const expectedThreshold = CONF_GRID.map(c =>
  runReducer(choiceThreshold, { dept: { type: 'choice', choice: 'billing', confidence: c,
    probabilities: { billing: c, technical: 1 - c } } as JevAnswer }))

describe('threshold against a choice', () => {
  // runtime.value() reads a choice's confidence. Both emitters read probability, then
  // score, then gave up on 0 — so every gte was false and every lte true no matter what
  // the model returned. `route` was unreachable.
  it('ai-sdk: compares the confidence, not zero', () => {
    const got = runAiSdk(emitAiSdk(choiceThreshold), CONF_GRID.map(c => ({
      answers: { dept: { type: 'choice', choice: 'billing',
        probabilities: { billing: c, technical: 1 - c } } },
      confidence: { dept: c },
    })))
    expect(got).toEqual(expectedThreshold)
  }, 60_000)

  it('langchain: compares the confidence, not zero', () => {
    const got = runLangchain(emitLangchain(choiceThreshold),
      CONF_GRID.map(c => ({ dept: { kind: 'choice', choice: 'billing', confidence: c } })))
    expect(got).toEqual(expectedThreshold)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// I4 — a missing answer skips the rule
// ---------------------------------------------------------------------------

/** `lte` is the dangerous direction: a missing answer read as 0 satisfies every upper
 *  bound, so the rule fires on evidence that was never collected. */
const lower: Program = {
  decisions: [{ id: 'is_urgent', kind: 'noul', instructions: 'Urgent?' }],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'is_urgent', op: 'lte', value: 0.3 }], then: 'ignore' }], otherwise: 'handle' },
  residual: '', dropped: [],
}

describe('a missing answer', () => {
  // runReducer throws here, so there is no oracle to compare against; the target's own
  // rule decides. bouncer skips a rule whose question was not answered
  // (target-bouncer.md:65) — absence of evidence is not evidence — and the code targets
  // follow it. Reading 0 turned a missing answer into a confident "no".
  it('ai-sdk: skips the rule instead of reading zero', () => {
    expect(runAiSdk(emitAiSdk(lower), [
      { answers: {} },
      { answers: { is_urgent: { type: 'boolean', probability: 0.2 } } },
    ])).toEqual(['handle', 'ignore'])
  }, 60_000)

  it('langchain: skips the rule instead of reading zero', () => {
    expect(runLangchain(emitLangchain(lower), [
      {},
      { is_urgent: { kind: 'noul', noul: 0.2 } },
    ])).toEqual(['handle', 'ignore'])
  }, 60_000)
})
