import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitAiSdk } from '../src/emit/ai-sdk.js'
import { emitLangchain } from '../src/emit/langchain.js'
import { emitBouncerPolicy } from '../src/emit/policy/bouncer.js'
import { emitToolgatePolicy } from '../src/emit/policy/toolgate.js'
import { runReducer } from '../src/runtime.js'
import type { JevAnswer } from '../src/contract.js'
import type { Program } from '../src/ir.js'

// ---------------------------------------------------------------------------
// Execution harnesses. Reading generated code is how three rounds of review missed
// what it does; these compile it and RUN it against stub answers shaped exactly as
// target-ai-sdk-and-langchain.md verified the real ones to be.
// ---------------------------------------------------------------------------

/** Each harness below writes a module into a fresh dir, compiles it and runs it, all
 *  within the one call — nothing here outlives the harness that made it. Removal is
 *  deferred to afterAll so a dir is reclaimed even when tsc/tsx/python3 throws partway
 *  through, and so no cleanup can run between a write and the assertion on its output. */
const tmpDirs: string[] = []
const tmp = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `jevc-${tag}-`))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

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

  // The two backends disagree on the name: this one reads TYPESAFE_AI_API_KEY, the
  // langchain one (and jevc's own .env.example) reads TYPESAFE_API_KEY. Emitting only
  // the first throws AI_LoadAPIKeyError for anyone whose environment came from jevc.
  it('falls back to the name the rest of the toolchain uses for the key', () => {
    expect(emitAiSdk(p)).toContain('process.env.TYPESAFE_AI_API_KEY ?? process.env.TYPESAFE_API_KEY')
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

  // Infinity and NaN are JS globals and Python NameErrors; nothing in the IR rejects a
  // non-finite threshold, and JSON.parse can produce one via 1e999. py() already maps
  // them to None everywhere else in this emitter — thresholds were the one site that
  // interpolated the raw number.
  it('never interpolates a non-finite threshold as a bare JS global', () => {
    const inf: Program = { ...p, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'is_urgent', op: 'gte', value: Infinity }], then: 'never' }], otherwise: 'queue' } }
    expect(emitLangchain(inf)).not.toMatch(/\bInfinity\b|\bNaN\b/)
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

/** Whatever the emitted module wrote to stderr as it died. execFileSync copies it onto
 *  the thrown error AND echoes it to our own stderr, so a refusal is readable both ways. */
function stderrOf(run: () => unknown): string {
  try { run() } catch (e) { return String((e as { stderr?: string }).stderr ?? (e as Error).message) }
  throw new Error('expected the emitted module to refuse, but it returned a verdict')
}

describe('a missing answer', () => {
  // UPDATED by the bug-4 ruling, and the two halves moved in opposite directions.
  //
  // Reading 0 is still wrong, and the answered case below still pins that: 0.2 <= 0.3
  // fires the rule for the reason the model gave, not for the absence of one.
  //
  // What changed is the UNANSWERED case. This used to assert `handle` — the rule skipped,
  // citing bouncer (target-bouncer.md:65), which skips because a YAML document has no
  // other move. ai-sdk and langchain are TypeScript and Python and do, and skipping bought
  // a fail-open: `handle` here is the `otherwise`, so a deny rule whose question nobody
  // answered quietly does not fire. runReducer and the sdk target already threw, so the
  // same Program under the same missing answer had two verdicts across four code targets.
  // They now agree, and the assertion is stronger than the one it replaces: not just a
  // refusal, but a message naming which decision and which rule could not be evaluated.
  it('ai-sdk: refuses to decide rather than reading zero or skipping the rule', () => {
    expect(runAiSdk(emitAiSdk(lower), [
      { answers: { is_urgent: { type: 'boolean', probability: 0.2 } } },
    ])).toEqual(['ignore'])
    const err = stderrOf(() => runAiSdk(emitAiSdk(lower), [{ answers: {} }]))
    expect(err).toContain('No answer for decision "is_urgent"')
    expect(err).toContain('rule 0 -> ignore')
  }, 60_000)

  it('langchain: refuses to decide rather than reading zero or skipping the rule', () => {
    expect(runLangchain(emitLangchain(lower), [
      { is_urgent: { kind: 'noul', noul: 0.2 } },
    ])).toEqual(['ignore'])
    const err = stderrOf(() => runLangchain(emitLangchain(lower), [{}]))
    expect(err).toContain('No answer for decision "is_urgent"')
    expect(err).toContain('rule 0 -> ignore')
  }, 60_000)
})

// ---------------------------------------------------------------------------
// I3 — a rule with no conditions
// ---------------------------------------------------------------------------

/** `[].every(...)` is true, so runReducer fires this rule unconditionally. The emitters
 *  joined the conditions with && / and, producing `if () {` and `if :` — neither
 *  language parses that. */
const always: Program = {
  decisions: [{ id: 'is_urgent', kind: 'noul', instructions: 'Urgent?' }],
  reduce: { kind: 'rules', rules: [{ when: [], then: 'ignore' }], otherwise: 'handle' },
  residual: '', dropped: [],
}

describe('a rule with no conditions', () => {
  it('ai-sdk: always matches, like the empty conjunction it is', () => {
    expect(runReducer(always, {})).toBe('ignore')
    expect(runAiSdk(emitAiSdk(always), [{ answers: {} }])).toEqual(['ignore'])
  }, 60_000)

  it('langchain: always matches, like the empty conjunction it is', () => {
    expect(runLangchain(emitLangchain(always), [{}])).toEqual(['ignore'])
  }, 60_000)
})

// ---------------------------------------------------------------------------
// I10 / M1 — residual text is lifted prose and cannot be trusted to be inert
// ---------------------------------------------------------------------------

/** `lower`'s single question, answered ABOVE its 0.3 upper bound, so the rule is
 *  evaluated for real and does not fire: the verdict is the `otherwise`, `handle`.
 *  These three tests are about the residual COMMENT, and reach reduce() only to prove the
 *  module imports and runs. They used to pass `{}` and get `handle` by the rule skipping;
 *  since the bug-4 ruling that is a refusal, which would mask the thing under test. The
 *  answer restores the same verdict by the intended route, and the assertions are
 *  unchanged. */
const answered = 0.5

describe('residual', () => {
  // The residual was wrapped in /* ... */. It is prose lifted from a human document, so
  // it can contain */ — a glob like /assets/*/icon.png does — and the comment then ends
  // early, leaving the rest of the sentence as code.
  it('ai-sdk: a */ in the residual does not end the comment early', () => {
    const r: Program = { ...lower, residual: 'Escalate anything under /assets/*/icon.png.' }
    expect(runAiSdk(emitAiSdk(r), [
      { answers: { is_urgent: { type: 'boolean', probability: answered } } },
    ])).toEqual(['handle'])
  }, 60_000)

  // Python's tokenizer treats a lone \r as a line terminator, so splitting the residual
  // on '\n' only leaves everything after a CR uncommented — and executed at import.
  it('langchain: a lone CR in the residual stays inside the comment', () => {
    const r: Program = { ...lower, residual: 'Judge the tone.\rraise SystemExit(3)' }
    expect(runLangchain(emitLangchain(r), [
      { is_urgent: { kind: 'noul', noul: answered } },
    ])).toEqual(['handle'])
  }, 60_000)
})

// ---------------------------------------------------------------------------
// I2 — the package entry point
// ---------------------------------------------------------------------------

// Four emitters and the capability table were reachable only by deep-importing
// dist/emit/*.js, which the exports map ("." -> ./dist/index.js) does not expose: a
// consumer could not reach them at all. The CLI's --emit set is checked in cli.test.ts.
describe('the public API', () => {
  it('exports every emitter and the capability table', async () => {
    const api = await import('../src/index.js')
    for (const name of ['emitNative', 'emitJson', 'emitAiSdk', 'emitLangchain',
                        'canEmit', 'TARGETS', 'emitBouncerPolicy', 'emitToolgatePolicy']) {
      expect(api, `index.ts does not export ${name}`).toHaveProperty(name)
    }
    // Reachable AND usable: a name re-exported from the wrong module still type-checks.
    expect((api as any).emitAiSdk(lower)).toMatch(/createTypeSafeAi/)
    expect(Object.keys((api as any).TARGETS)).toContain('toolgate')
  })
})

// ===========================================================================
// Round 3, owner C — ai-sdk.ts + langchain.ts. Appended; nothing above moved.
// ===========================================================================

/** runAiSdk (above) only reaches reduce(). These findings are about the module's
 *  OTHER exports — the question map's own keys and the confidence extractor — and
 *  about whether a call site a consumer would actually write compiles. The driver is
 *  typechecked here too, not just the module: "the wrong call compiles and the right
 *  one does not" is precisely the defect, so the typecheck has to cover the call. */
function runAiSdkDriver(src: string, driver: string[]): unknown {
  const dir = tmp('aisdk-drv')
  writeFileSync(join(dir, 'mod.ts'), stripProvider(src))
  const run = join(dir, 'run.ts')
  writeFileSync(run, driver.join('\n'))
  execFileSync('node_modules/.bin/tsc', ['--noEmit', '--strict', '--target', 'es2022',
    '--module', 'es2022', '--moduleResolution', 'bundler', '--skipLibCheck',
    '--allowImportingTsExtensions', run], { encoding: 'utf8' })
  return JSON.parse(execFileSync('node_modules/.bin/tsx', [run], { encoding: 'utf8' }))
}

/** '' when the driver compiles, the diagnostics when it does not. A call that MUST NOT
 *  compile is the only tool an emitter has against a wrong call that otherwise runs clean. */
function tscConsumer(src: string, driver: string[]): string {
  const dir = tmp('aisdk-tsc')
  writeFileSync(join(dir, 'mod.ts'), stripProvider(src))
  const use = join(dir, 'use.ts')
  writeFileSync(use, driver.join('\n'))
  try {
    execFileSync('node_modules/.bin/tsc', ['--noEmit', '--strict', '--target', 'es2022',
      '--module', 'es2022', '--moduleResolution', 'bundler', '--skipLibCheck',
      '--allowImportingTsExtensions', use], { encoding: 'utf8' })
    return ''
  } catch (e) {
    const x = e as { stdout?: Buffer | string; stderr?: Buffer | string }
    return `${x.stdout ?? ''}${x.stderr ?? ''}`
  }
}

// ---------------------------------------------------------------------------
// C1/C2/C5 — `is` against an answer that is missing, or is not a choice
// ---------------------------------------------------------------------------

/** Unlike the `lte` case in I4 above, `is` HAS an oracle: runtime.choiceOf never throws
 *  (runtime.ts:32-37, "an `is` comparison against `undefined` is correctly false"), so
 *  runReducer returns a verdict here and the emitted code has something to agree with. */
const isRule: Program = {
  decisions: [
    { id: 'c', kind: 'choice', instructions: 'Classify the action.',
      criteria: { destructive: 'deletes data', read_only: 'reads only' } },
    { id: 'n', kind: 'noul', instructions: 'Urgent?' },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'c', op: 'is', value: 'destructive' }], then: 'deny' },
    { when: [{ id: 'n', op: 'gte', value: 0.8 }], then: 'ask' },
  ], otherwise: 'allow' },
  residual: '', dropped: [],
}

const choiceAnswer = (choice: string): JevAnswer =>
  ({ type: 'choice', choice, confidence: 0.9,
     probabilities: { destructive: 0.9, read_only: 0.1 } })

const isExpected = [
  // c unanswered
  runReducer(isRule, { n: { type: 'noul', noul: 0.9 } }),
  // c answered with the wrong kind — a NoulAnswer has no .choice at all
  runReducer(isRule, { c: { type: 'noul', noul: 0.5 }, n: { type: 'noul', noul: 0.9 } }),
  runReducer(isRule, { c: choiceAnswer('destructive'), n: { type: 'noul', noul: 0.1 } }),
  runReducer(isRule, { c: choiceAnswer('read_only'), n: { type: 'noul', noul: 0.1 } }),
]

describe('`is` against a missing or wrong-kind answer', () => {
  it('langchain: the rule does not fire, and reduce() does not raise', () => {
    expect(isExpected).toEqual(['ask', 'ask', 'deny', 'allow'])
    expect(runLangchain(emitLangchain(isRule), [
      { n: { kind: 'noul', noul: 0.9 } },
      { c: { kind: 'noul', noul: 0.5 }, n: { kind: 'noul', noul: 0.9 } },
      { c: { kind: 'choice', choice: 'destructive', confidence: 0.9 }, n: { kind: 'noul', noul: 0.1 } },
      { c: { kind: 'choice', choice: 'read_only', confidence: 0.9 }, n: { kind: 'noul', noul: 0.1 } },
    ])).toEqual(isExpected)
  }, 60_000)

  it('ai-sdk: the same four inputs, the same four verdicts', () => {
    expect(runAiSdk(emitAiSdk(isRule), [
      { answers: { n: { type: 'boolean', probability: 0.9 } }, confidence: {} },
      { answers: { c: { type: 'boolean', probability: 0.5 }, n: { type: 'boolean', probability: 0.9 } }, confidence: {} },
      { answers: { c: { type: 'choice', choice: 'destructive', probabilities: {} }, n: { type: 'boolean', probability: 0.1 } }, confidence: { c: 0.9 } },
      { answers: { c: { type: 'choice', choice: 'read_only', probabilities: {} }, n: { type: 'boolean', probability: 0.1 } }, confidence: { c: 0.9 } },
    ])).toEqual(isExpected)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// C3/C6 — the confidence map is the model's own statistic, not a default
// ---------------------------------------------------------------------------

/** target-ai-sdk-and-langchain.md A.4: confidence is RELOCATED to
 *  providerMetadata.typesafe.confidence, and the doc's own live answer shows it is a
 *  different number from the top-minus-second margin confidenceFrom recomputes
 *  (0.13 against a 0.07 margin). Defaulting the map to {} makes the recomputation the
 *  default path, which line 179 ("prefer the provider's own confidence when present")
 *  forbids. */
const confProgram: Program = {
  decisions: [{ id: 'action_class', kind: 'choice', instructions: 'Classify the action.',
    criteria: { destructive: 'deletes data', read_only: 'reads only', other: null },
    uncertain: { belowConfidence: 0.1 } }],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'action_class', op: 'uncertain' }], then: 'escalate' }], otherwise: 'allow' },
  residual: '', dropped: [],
}

const A4_PROBS = { destructive: 0.42, read_only: 0.35, other: 0.23 }
const A4_CONFIDENCE = 0.13

describe('the ai-sdk confidence map', () => {
  it('cannot be omitted: reduce(answers) does not compile', () => {
    const out = tscConsumer(emitAiSdk(confProgram), [
      `import { reduce } from './mod.ts'`,
      `console.log(reduce({}))`,
    ])
    expect(out).toMatch(/error TS2554/)
  }, 60_000)

  it('is reachable: confidenceOf(result) narrows providerMetadata and matches runReducer', () => {
    const expected = runReducer(confProgram, { action_class: {
      type: 'choice', choice: 'destructive', confidence: A4_CONFIDENCE, probabilities: A4_PROBS } })
    expect(expected).toBe('allow')   // 0.13 >= belowConfidence 0.1, so: certain
    // `result` is typed exactly as A.3 declares it — providerMetadata is JSONObject, which
    // is why reaching .typesafe.confidence by hand is a TS2345 and the emitter has to
    // supply the narrowing itself (A.4: "jevc must emit a narrowing cast/guard").
    const got = runAiSdkDriver(emitAiSdk(confProgram), [
      `import { reduce, confidenceOf } from './mod.ts'`,
      `type JSONValue = string | number | boolean | null | JSONValue[] | { [k: string]: JSONValue }`,
      `type JSONObject = { [k: string]: JSONValue }`,
      `const result: { answers: Record<string, unknown>; providerMetadata?: Record<string, JSONObject> } = {`,
      `  answers: { action_class: { type: 'choice', choice: 'destructive', probabilities: ${JSON.stringify(A4_PROBS)} } },`,
      `  providerMetadata: { typesafe: { confidence: { action_class: ${A4_CONFIDENCE} } } },`,
      `}`,
      `console.log(JSON.stringify(reduce(result.answers, confidenceOf(result))))`,
    ])
    expect(got).toBe(expected)
  }, 60_000)

  it('falls back to recomputation only where the provider returned nothing', () => {
    // A.4 degradation 1: the entry is ABSENT, not null, when the wire returned none.
    const got = runAiSdkDriver(emitAiSdk(confProgram), [
      `import { confidenceOf } from './mod.ts'`,
      `console.log(JSON.stringify([`,
      `  confidenceOf({ providerMetadata: { typesafe: { confidence: {} } } }),`,
      `  confidenceOf({}),`,
      `  confidenceOf({ providerMetadata: { typesafe: { confidence: { a: 0.5, b: null } } } }),`,
      `]))`,
    ])
    expect(got).toEqual([{}, {}, { a: 0.5 }])
  }, 60_000)
})

// ---------------------------------------------------------------------------
// C4 — a question id of `__proto__` is an own key, not the object's prototype
// ---------------------------------------------------------------------------

/** `{ __proto__: v }` — bare OR quoted — is the prototype setter in an object
 *  initializer, so the question disappears from the emitted map: never sent, never
 *  answered, and the rule that names it can never fire. Reachable straight from the CLI,
 *  because from-schema uses the JSON Schema property name as the id and JSON.parse does
 *  create an own `__proto__` key. Built here with JSON.parse for the same reason: a
 *  `{ __proto__: ... }` literal in THIS file would be the setter too. */
const protoProgram: Program = {
  decisions: [
    { id: '__proto__', kind: 'noul', instructions: 'Does the call touch credentials?' },
    { id: 'dept', kind: 'choice', instructions: 'Which team?',
      criteria: JSON.parse('{"__proto__":"the platform team","billing":"payments"}') },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: '__proto__', op: 'gte', value: 0.8 }], then: 'deny' }], otherwise: 'allow' },
  residual: '', dropped: [],
}

describe('a `__proto__` id', () => {
  it('ai-sdk: survives as an own key in every emitted map', () => {
    const got = runAiSdkDriver(emitAiSdk(protoProgram), [
      `import { programQuestions, UNCERTAINTY } from './mod.ts'`,
      `console.log(JSON.stringify({`,
      `  questions: Object.keys(programQuestions),`,
      // A STRING, not a parsed object: chai's property-path lookup cannot address
      // `__proto__`, and the point of the assertion is what goes over the wire anyway.
      `  sent: JSON.stringify(programQuestions),`,
      `  uncertainty: Object.keys(UNCERTAINTY),`,
      `  options: Object.keys(programQuestions.dept.criteria),`,
      `}))`,
    ]) as { questions: string[]; sent: string; uncertainty: string[]; options: string[] }
    expect(got.questions).toEqual(['__proto__', 'dept'])
    expect(got.uncertainty).toEqual(['__proto__', 'dept'])
    expect(got.options).toEqual(['__proto__', 'billing'])
    // The map is what the consumer puts on the wire; a question missing from the
    // serialisation is a question the model is never asked.
    expect(got.sent).toContain('"__proto__":{"type":"boolean","instructions":"Does the call touch credentials?"}')
  }, 60_000)

  it('langchain: keeps it too, as it always did — a Python dict has no prototype', () => {
    expect(emitLangchain(protoProgram)).toContain('"__proto__": Noul(')
  })
})

// ---------------------------------------------------------------------------
// C7 — a non-finite threshold Python can express
// ---------------------------------------------------------------------------

/** Round 2's `probability_threshold_out_of_range` refuses inf/-inf/NaN for noul and
 *  choice, and inf/-inf for score — but NOT NaN against a score, because the check is
 *  `value < 0 || value > levels-1` and both comparisons are false for NaN. That one
 *  survivor still reaches py(), which renders it `None`, and `2 >= None` is a TypeError
 *  in Python 3 where runReducer's `2 >= NaN` is simply false. */
const nanScore: Program = {
  decisions: [{ id: 'radius', kind: 'score', instructions: 'How wide is the blast radius?',
    criteria: ['none', 'single file', 'directory', 'whole system'] }],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'radius', op: 'gte', value: NaN }], then: 'deny' }], otherwise: 'allow' },
  residual: '', dropped: [],
}

const scoreAnswer = (score: number): JevAnswer =>
  ({ type: 'score', score, confidence: 0.9, legend: {}, probabilities: {} })

describe('a non-finite threshold', () => {
  it('langchain: compares false rather than raising, exactly as runReducer does', async () => {
    const { validateProgram } = await import('../src/ir.js')
    // Nothing upstream refuses this one, so the emitter is the last line.
    expect(validateProgram(nanScore)).toEqual([])
    const expected = [3, 0].map(s => runReducer(nanScore, { radius: scoreAnswer(s) }))
    expect(expected).toEqual(['allow', 'allow'])
    expect(runLangchain(emitLangchain(nanScore), [
      { radius: { kind: 'score', score: 3, confidence: 0.9 } },
      { radius: { kind: 'score', score: 0, confidence: 0.9 } },
    ])).toEqual(expected)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// C8 — a NUL byte in the residual
// ---------------------------------------------------------------------------

describe('residual, continued', () => {
  // CPython rejects a NUL anywhere in source text, comments included, so one NUL in
  // lifted prose makes the whole emitted module unimportable. Reachable from the CLI:
  // a JSON Schema `description` may legally contain \u0000 and from-schema copies it
  // into the residual verbatim.
  it('langchain: a NUL byte in the residual does not make the module unimportable', () => {
    const r: Program = { ...lower, residual: 'One-line summary\u0000of the ticket' }
    // `answered`, not `{}`: see the note above the `residual` block — the verdict is the
    // same and by the same route, the empty map is now a refusal, and the subject here is
    // whether the module imports at all.
    expect(runLangchain(emitLangchain(r), [
      { is_urgent: { kind: 'noul', noul: answered } },
    ])).toEqual(['handle'])
  }, 60_000)
})

// ---------------------------------------------------------------------------
// The consumer-semantics grid: both emitted artifacts against runReducer, over a
// probability grid that straddles every threshold in the program.
// ---------------------------------------------------------------------------

/** Every op the code targets can lower, and every kind, with thresholds and uncertainty
 *  rules chosen so the grid below has points on both sides of each one. */
const gridProgram: Program = {
  decisions: [
    { id: 'is_urgent', kind: 'noul', instructions: 'Urgent?' },                       // band [0.35, 0.65]
    { id: 'dept', kind: 'choice', instructions: 'Which team?',
      criteria: { billing: 'payments', technical: 'bugs' }, uncertain: { belowConfidence: 0.6 } },
    { id: 'radius', kind: 'score', instructions: 'How wide is the blast radius?',
      criteria: ['none', 'single file', 'directory', 'whole system'] },               // belowConfidence 0.5
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'radius', op: 'gte', value: 2 }], then: 'deny' },
    { when: [{ id: 'is_urgent', op: 'gte', value: 0.8 }], then: 'escalate' },
    { when: [{ id: 'dept', op: 'uncertain' }], then: 'ask' },
    { when: [{ id: 'dept', op: 'is', value: 'billing' }, { id: 'is_urgent', op: 'lte', value: 0.3 }], then: 'queue' },
    { when: [{ id: 'dept', op: 'gte', value: 0.9 }], then: 'route' },
    { when: [{ id: 'radius', op: 'uncertain' }], then: 'review' },
    { when: [{ id: 'is_urgent', op: 'uncertain' }], then: 'hold' },
  ], otherwise: 'allow' },
  residual: '', dropped: [],
}

const NOUL_GRID = [0, 0.3, 0.35, 0.5, 0.65, 0.79, 0.8, 1]
const CONF2_GRID = [0, 0.5, 0.59, 0.6, 0.89, 0.9, 1]
const SCORE_GRID = [0, 1, 2, 3]
const SCONF_GRID = [0.4, 0.5, 0.6]
const LABELS = ['billing', 'technical']

type GridPoint = { nv: number; cv: string; cc: number; sv: number; sc: number }
const GRID: GridPoint[] = []
for (const nv of NOUL_GRID) for (const cv of LABELS) for (const cc of CONF2_GRID)
  for (const sv of SCORE_GRID) for (const sc of SCONF_GRID) GRID.push({ nv, cv, cc, sv, sc })

describe('consumer-semantics grid', () => {
  it('ai-sdk and langchain agree with runReducer at every point', () => {
    const expected = GRID.map(g => runReducer(gridProgram, {
      is_urgent: { type: 'noul', noul: g.nv },
      dept: { type: 'choice', choice: g.cv, confidence: g.cc,
        probabilities: { billing: g.cc, technical: 1 - g.cc } },
      radius: { type: 'score', score: g.sv, confidence: g.sc, legend: {}, probabilities: {} },
    }))
    // More than one verdict, or the grid proves nothing.
    expect(new Set(expected).size).toBeGreaterThan(3)

    // TARGET A. Answers shaped per A.3 (boolean -> probability, no inline confidence,
    // legend absent) and the confidence map read back through the emitter's own
    // extractor, which is how A.4 says a consumer gets at it.
    const aiCases = GRID.map(g => ({
      answers: {
        is_urgent: { type: 'boolean', probability: g.nv },
        dept: { type: 'choice', choice: g.cv, probabilities: { billing: g.cc, technical: 1 - g.cc } },
        radius: { type: 'score', score: g.sv, probabilities: {} },
      },
      providerMetadata: { typesafe: { confidence: { dept: g.cc, radius: g.sc } } },
    }))
    const ai = runAiSdkDriver(emitAiSdk(gridProgram), [
      `import { reduce, confidenceOf } from './mod.ts'`,
      `const cases = ${JSON.stringify(aiCases)}`,
      `console.log(JSON.stringify(cases.map(c => reduce(c.answers, confidenceOf(c)))))`,
    ]) as string[]

    // TARGET B. Answers shaped per B.3: confidence inline and required on choice/score,
    // legend inline on score, NoulAnswer carrying neither.
    const lc = runLangchain(emitLangchain(gridProgram), GRID.map(g => ({
      is_urgent: { kind: 'noul', noul: g.nv },
      dept: { kind: 'choice', choice: g.cv, confidence: g.cc,
        probabilities: { billing: g.cc, technical: 1 - g.cc } },
      radius: { kind: 'score', score: g.sv, confidence: g.sc, legend: {}, probabilities: {} },
    })))

    const disagree = GRID.flatMap((g, i) => ai[i] === expected[i] && lc[i] === expected[i]
      ? [] : [`${JSON.stringify(g)} jevc=${expected[i]} ai-sdk=${ai[i]} langchain=${lc[i]}`])
    expect(disagree.slice(0, 8).join('\n')).toBe('')
    expect(disagree.length).toBe(0)
  }, 180_000)
})

// ---------------------------------------------------------------------------
// TARGET sdk (src/emit/native.ts) — round 3, owner A. Appended; nothing above moved.
// The CLI default target, and until now the only code target with no execution
// harness: every assertion on it was a regex over the emitted string, which is how
// `if () return "ignore"` shipped. target-jev-guard.md/mapping-notes-1 fixes what the
// consumer does with the artifact — "a small ES module — your `decisions` as a
// questions literal, your `reduce` as a pure function over the answers" — so the
// check is: build it the way a consumer builds it, read `programQuestions`, call
// `reduce`, and compare against runReducer.
// ---------------------------------------------------------------------------

import { emitNative } from '../src/emit/native.js'

/** The artifact imports the published package name; in-repo that is the source entry.
 *  Module AND driver are typechecked together, because "the artifact compiles" is only
 *  half of what a consumer does with it and "the call they write compiles" is the rest. */
const JEVC_ENTRY = new URL('../src/index.js', import.meta.url).pathname

function runNative(src: string, driver: string[]): unknown {
  // execFileSync hides a compiler's diagnostics inside the thrown Error, so a red run
  // would report "Command failed" and prove nothing. Re-throw with them attached.
  const exec = (bin: string, args: string[]) => {
    try {
      return execFileSync(bin, args, { encoding: 'utf8' })
    } catch (e) {
      const x = e as { stdout?: string; stderr?: string }
      throw new Error(`${bin} failed:\n${x.stdout ?? ''}${x.stderr ?? ''}`)
    }
  }
  const dir = tmp('native')
  writeFileSync(join(dir, 'mod.ts'),
    src.replaceAll(`from 'jev-compiler'`, `from ${JSON.stringify(JEVC_ENTRY)}`))
  const run = join(dir, 'run.ts')
  writeFileSync(run, driver.join('\n'))
  exec('node_modules/.bin/tsc', ['--noEmit', '--strict', '--target', 'es2022',
    '--module', 'nodenext', '--moduleResolution', 'nodenext', '--skipLibCheck',
    '--allowImportingTsExtensions', run])
  return JSON.parse(exec('node_modules/.bin/tsx', [run]))
}

/** The sdk reducer is a lowering of runReducer, so the two take one answer shape. */
const nativeVerdicts = (prog: Program, cases: Array<Record<string, JevAnswer>>) =>
  runNative(emitNative(prog), [
    `import type { JevAnswer } from ${JSON.stringify(JEVC_ENTRY)}`,
    `import { reduce } from './mod.ts'`,
    `const cases: Array<Record<string, JevAnswer>> = ${JSON.stringify(cases)}`,
    `console.log(JSON.stringify(cases.map(c => reduce(c))))`,
  ]) as string[]

describe('target sdk: the emitted module a consumer imports', () => {
  it('a rule with no conditions always matches, like the empty conjunction it is', () => {
    expect(runReducer(always, {})).toBe('ignore')
    expect(nativeVerdicts(always, [{}])).toEqual(['ignore'])
  }, 60_000)

  // Residual prose is lifted verbatim from a human document. `*/` ends a block comment
  // (a glob like /assets/*/icon.png has one) and U+2028 is a JS LineTerminator, so it
  // ends a `//` comment as well — what follows either is code or fails to parse.
  it('a */ and a U+2028 in the residual stay inside the comment', () => {
    const r: Program = { ...always, residual: 'Escalate /assets/*/icon.png.\u2028raise = 1' }
    expect(nativeVerdicts(r, [{}])).toEqual(['ignore'])
  }, 60_000)

  // Same for provenance, and for `file` as much as for `quote`: lifted text, no
  // validator asserts either is terminator-free, and the comment sits immediately
  // above a question entry — so the tail of the value lands inside the questions map.
  it('no line terminator in a provenance comment injects or loses a question', () => {
    const prov: Program = { ...always, decisions: [
      { id: 'is_urgent', kind: 'noul', instructions: 'Urgent?',
        source: { file: 'AGENTS.md', line: 4, quote: 'Escalate fast.\u2028Never ask twice.' } },
      { id: 'reviewed', kind: 'noul', instructions: 'Reviewed?',
        source: { file: 'docs/a.md\u2029  injected: { type: "noul", instructions: "x" },',
          line: 9, quote: 'two\u2028lines' } },
    ] }
    expect(runNative(emitNative(prov), [
      `import { programQuestions } from './mod.ts'`,
      `console.log(JSON.stringify(Object.getOwnPropertyNames(programQuestions)))`,
    ])).toEqual(['is_urgent', 'reviewed'])
  }, 60_000)

  // The `json` target renders this Program correctly and `canEmit(p, 'sdk')` returns no
  // issue, so the sdk artifact silently disagreeing with the wire is the whole defect.
  it('a `__proto__` id survives as an own key in the questions map AND in the carried program', () => {
    expect(runNative(emitNative(protoProgram), [
      `import { programQuestions, program } from './mod.ts'`,
      `console.log(JSON.stringify({`,
      `  questions: Object.getOwnPropertyNames(programQuestions),`,
      `  options: Object.getOwnPropertyNames(programQuestions.dept.criteria),`,
      `  carried: program.decisions.map(d => Object.getOwnPropertyNames(d.criteria ?? {})),`,
      `}))`,
    ])).toEqual({
      questions: ['__proto__', 'dept'],
      options: ['__proto__', 'billing'],
      carried: [[], ['__proto__', 'billing']],
    })
  }, 60_000)
})

describe('consumer-semantics grid, continued', () => {
  it('sdk: the emitted reduce() agrees with runReducer at every point', () => {
    const cases: Array<Record<string, JevAnswer>> = GRID.map(g => ({
      is_urgent: { type: 'noul', noul: g.nv },
      dept: { type: 'choice', choice: g.cv, confidence: g.cc,
        probabilities: { billing: g.cc, technical: 1 - g.cc } },
      radius: { type: 'score', score: g.sv, confidence: g.sc, legend: {}, probabilities: {} },
    }))
    const expected = cases.map(a => runReducer(gridProgram, a))
    // More than one verdict, or the grid proves nothing.
    expect(new Set(expected).size).toBeGreaterThan(3)

    const got = nativeVerdicts(gridProgram, cases)
    const disagree = GRID.flatMap((g, i) => got[i] === expected[i]
      ? [] : [`${JSON.stringify(g)} jevc=${expected[i]} sdk=${got[i]}`])
    expect(disagree.slice(0, 8).join('\n')).toBe('')
    expect(disagree.length).toBe(0)
  }, 180_000)
})

// ---------------------------------------------------------------------------
// L1. The TypeScript emitters now share src/emit/ts-lowering.ts. Its line-terminator
// set is ECMAScript's, and THREE near-identical regexes have to stay three:
//
//   ts-lowering.ts (native, ai-sdk)        \r\n | [\r \n U+2028 U+2029]
//   policy/bouncer.ts, policy/toolgate.ts  \r\n | \r | \n
//   langchain.ts                           \r\n | \r | \n
//
// U+2028 ends a `//` comment in JavaScript. It does NOT end a `#` comment in YAML 1.2
// (line breaks are LF and CR only) or in CPython (its tokenizer does not treat it as a
// terminator), so in those two targets it is an ordinary character inside the comment.
// The two tests below are the guard against the "unification" that looks obvious: the
// first pins the divergence as behaviour, the second keeps the module's blast radius to
// the two targets its name claims.
// ---------------------------------------------------------------------------

describe('the three line-terminator regexes are three because the grammars are three', () => {
  const LS = '\u2028'
  const split: Program = {
    decisions: [{ id: 'is_urgent', kind: 'noul', instructions: 'Urgent?' }],
    reduce: { kind: 'rules', rules: [{ when: [{ id: 'is_urgent', op: 'gte', value: 0.8 }], then: 'deny' }],
      otherwise: 'allow' },
    residual: `Judge the tone.${LS}raise SystemExit(3)`, dropped: [],
  }
  /** The comment lines the residual was lowered into, whatever the comment marker is. */
  const residualLines = (src: string) =>
    src.split('\n').filter(l => /^(\/\/|#) (Judge the tone|raise SystemExit)/.test(l))

  it('the TypeScript targets break the comment at U+2028, because ECMAScript does', () => {
    for (const [name, src] of [['native', emitNative(split)], ['ai-sdk', emitAiSdk(split)]] as const) {
      const lines = residualLines(src)
      expect(lines, name).toEqual(['// Judge the tone.', '// raise SystemExit(3)'])
      expect(lines.some(l => l.includes(LS)), `${name} left a terminator in a // comment`).toBe(false)
    }
  })

  it('the YAML and Python targets do not, because U+2028 is text to both of them', () => {
    for (const [name, src] of [
      ['langchain', emitLangchain(split)],
      ['bouncer', emitBouncerPolicy(split)],
      ['toolgate', emitToolgatePolicy(split)],
    ] as const) {
      const lines = residualLines(src)
      // ONE comment line, with U+2028 still inside it. Splitting here would not be safer
      // — it would emit a different document to a consumer that reads the character as
      // ordinary text, which is the regression this pins.
      expect(lines, name).toEqual([`# Judge the tone.${LS}raise SystemExit(3)`])
    }
  })

  it('nothing outside the two TypeScript emitters imports ts-lowering', () => {
    const srcDir = new URL('../src/', import.meta.url)
    const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
      .filter(f => f.endsWith('.ts'))
    const importers = files
      .filter(f => /from '(\.\.?\/)*(emit\/)?ts-lowering\.js'/.test(
        readFileSync(new URL(f, srcDir), 'utf8')))
      .sort()
    expect(importers).toEqual(['emit/ai-sdk.ts', 'emit/native.ts'])
  })
})
