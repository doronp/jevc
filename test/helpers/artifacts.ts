/**
 * Out-of-band validation of an emitted artifact: spawn the real tool the consumer
 * would use, and return the tool's OWN diagnostics.
 *
 * Why this file exists. Every emit test in this repo before round 3 asserted on the
 * emitted TEXT. Five of the six bugs listed in the hardening brief passed that kind of
 * test: the string was right and the meaning was wrong. `tsc` and CPython are the only
 * two parties whose opinion about a TypeScript or Python artifact is authoritative, so
 * this module asks them and nothing else.
 *
 * Design decisions, stated because the brief asks which was chosen and why:
 *
 * 1. THE ARTIFACT IS WRITTEN VERBATIM. `test/emit-backends.test.ts` strips the
 *    `createTypeSafeAi` import and the `from langchain_typesafe import` line before
 *    checking, because neither package is installed. Stripping lines out of the thing
 *    under test is exactly the accommodation that hides an injection bug — a payload
 *    that breaks the emitted module three lines above the strip point is invisible if
 *    the strip is a `split('\n').filter(...)`. So instead the environment is made to
 *    satisfy the artifact: a scratch `node_modules` with a `jevc` SYMLINK to the repo
 *    and a stub `@ai-sdk/typesafe-ai` package, and a `langchain_typesafe.py` next to the
 *    emitted Python. Byte-for-byte what `jevc compile` writes to disk is what gets
 *    compiled and run.
 *
 * 2. `jevc` RESOLVES TO `dist/`, NOT `src/`. `dist/index.d.ts` is what a consumer's
 *    `tsc` actually reads, and the repo's own suite already requires a build (cli.test.ts
 *    spawns `node dist/cli.js`). Pointing at `src/` would typecheck against declarations
 *    no published consumer ever sees.
 *
 * 3. TSC IS BATCHED. One `tsc` invocation is ~1s and the injection table below is 135
 *    artifacts. `typecheckBatch` writes them all into one scratch project and attributes
 *    each diagnostic back by the filename tsc prints. `typecheckTs` is the one-shot form
 *    the brief names; it is `typecheckBatch` of a single file.
 *
 * 4. EVERYTHING LIVES IN AN OS TEMP DIR and is removed by `cleanupArtifacts()`. Nothing
 *    is written inside the repo — untracked files there get swept into commits.
 *
 * `node_modules/.bin/tsc`, never `npx tsc`: `npx tsc` resolves to an unrelated package
 * that prints "This is not the tsc command you are looking for".
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TSC = join(REPO, 'node_modules', '.bin', 'tsc')
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')

const created: string[] = []

/** A scratch directory outside the repo. Removed by `cleanupArtifacts()`. */
export function scratch(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `jevc-${tag}-`))
  created.push(d)
  return d
}

export function cleanupArtifacts(): void {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
}

/** Stub for the consumer's own dependency, so the emitted ai-sdk module needs no edits.
 *  Only the two members the artifact touches: `createTypeSafeAi(...).evaluationModel(id)`. */
const AI_SDK_STUB_DTS = `
export declare function createTypeSafeAi(options: { apiKey?: string }): {
  evaluationModel(id: string): { readonly modelId: string }
}
`
const AI_SDK_STUB_JS = `
export function createTypeSafeAi(options) {
  return { evaluationModel: (id) => ({ modelId: id }) }
}
`

/**
 * A scratch TypeScript project whose module resolution satisfies an emitted artifact
 * verbatim: `jev-compiler` -> this repo (so `dist/index.d.ts` at typecheck time and
 * `dist/index.js` at run time), `@ai-sdk/typesafe-ai` -> the stub above.
 */
function tsProject(tag: string): string {
  const dir = scratch(tag)
  const nm = join(dir, 'node_modules')
  mkdirSync(join(nm, '@ai-sdk', 'typesafe-ai'), { recursive: true })
  // A symlink rather than a copy: Node resolves the realpath, so `@typesafe-ai/sdk`
  // (which dist/index.js imports) is found through the repo's own node_modules.
  symlinkSync(REPO, join(nm, 'jev-compiler'), 'dir')
  const stub = join(nm, '@ai-sdk', 'typesafe-ai')
  writeFileSync(join(stub, 'package.json'), JSON.stringify(
    { name: '@ai-sdk/typesafe-ai', version: '0.0.0', type: 'module', main: 'index.js', types: 'index.d.ts' }))
  writeFileSync(join(stub, 'index.d.ts'), AI_SDK_STUB_DTS)
  writeFileSync(join(stub, 'index.js'), AI_SDK_STUB_JS)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scratch', type: 'module' }))
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      noEmit: true, strict: true, target: 'es2022',
      module: 'nodenext', moduleResolution: 'nodenext',
      skipLibCheck: true, allowImportingTsExtensions: true,
      // The scratch dir is outside the repo, so @types/node is not on the default
      // lookup path; the emitted ai-sdk module reads `process.env`.
      typeRoots: [join(REPO, 'node_modules', '@types')], types: ['node'],
    },
    include: ['*.ts'],
  }))
  return dir
}

/** `file.ts(12,5): error TS2322: ...` -> which file it belongs to. */
const DIAG_FILE = /^(?:.*[\\/])?([^\\/(]+\.tsx?)\(\d+,\d+\): (?:error|warning)/

/**
 * Typecheck N artifacts in ONE `tsc --noEmit --strict` run and return each one's own
 * diagnostics, keyed by the same name it was passed under. A key with no diagnostics
 * maps to `[]`. Diagnostics tsc emits without a file (`error TS5023: ...`) are attached
 * to every entry rather than dropped, because a project-level failure means no artifact
 * was actually checked and reporting `[]` would be a false pass.
 */
export function typecheckBatch(sources: Record<string, string>): Record<string, string[]> {
  const dir = tsProject('tsc')
  const names = Object.keys(sources)
  const out: Record<string, string[]> = {}
  for (const name of names) {
    out[name] = []
    writeFileSync(join(dir, `${name}.ts`), sources[name])
  }
  const r = spawnSync(TSC, ['-p', 'tsconfig.json', '--pretty', 'false'],
    { cwd: dir, encoding: 'utf8' })
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.status === 0) return out

  const unattributed: string[] = []
  let current: string | undefined
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const m = DIAG_FILE.exec(line)
    if (m) {
      current = m[1].replace(/\.tsx?$/, '')
      if (!(current in out)) { unattributed.push(line); current = undefined; continue }
      out[current].push(line.trim())
    } else if (current) {
      // A continuation line of the previous diagnostic ("  Target requires 2 ...").
      out[current].push(line.trim())
    } else {
      unattributed.push(line.trim())
    }
  }
  if (unattributed.length) for (const name of names) out[name].push(...unattributed)
  return out
}

/** `tsc --noEmit --strict` over one artifact. Returns the compiler's own diagnostics. */
export function typecheckTs(source: string): string[] {
  return typecheckBatch({ artifact: source }).artifact
}

/**
 * Typecheck an artifact together with a driver that imports it, then RUN the driver and
 * parse what it prints. "The artifact compiles" is only half of what a consumer does
 * with it; "the call they write compiles, and returns what the reducer says" is the rest.
 */
export function runTs(source: string, driver: string[]): unknown {
  const dir = tsProject('tsx')
  writeFileSync(join(dir, 'mod.ts'), source)
  writeFileSync(join(dir, 'run.ts'), driver.join('\n'))
  const t = spawnSync(TSC, ['-p', 'tsconfig.json', '--pretty', 'false'], { cwd: dir, encoding: 'utf8' })
  if (t.status !== 0) throw new Error(`tsc rejected the artifact:\n${t.stdout}${t.stderr}`)
  const r = spawnSync(TSX, [join(dir, 'run.ts')], { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`the emitted module threw:\n${r.stdout}${r.stderr}`)
  return JSON.parse(r.stdout)
}

/** Like `runTs`, but hands back the failure instead of throwing, so a test can compare
 *  "threw" against "returned a verdict" on equal footing across targets. */
export function tryRunTs(source: string, driver: string[]): { value?: unknown; error?: string } {
  try { return { value: runTs(source, driver) } } catch (e) { return { error: (e as Error).message } }
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

export const PYTHON = 'python3'

/** Checked once. A missing interpreter must produce a VISIBLE `it.skip`, never a pass. */
export const pythonAvailable = ((): boolean => {
  try {
    execFileSync(PYTHON, ['-c', 'pass'], { stdio: 'ignore' })
    return true
  } catch { return false }
})()

/**
 * `langchain_typesafe` is the consumer's dependency, not jevc's. Written as a real
 * module beside the artifact so the emitted `from langchain_typesafe import ...` line
 * stays in the file. Answer classes reproduce the shapes target-ai-sdk-and-langchain.md
 * §B.3 verified against the real package: NoulAnswer has `.noul` and NO `.confidence`;
 * ChoiceAnswer and ScoreAnswer carry a REQUIRED `.confidence`, and ScoreAnswer a
 * required `.legend`.
 */
export const LANGCHAIN_STUB = `
class _Kw:
    def __init__(self, **kw): self.__dict__.update(kw)

class Choice(_Kw): pass
class Noul(_Kw): pass
class NoulCriteria(_Kw): pass
class Score(_Kw): pass
class TypeSafeClassifier(_Kw): pass

class NoulAnswer:
    __slots__ = ("type", "noul")
    def __init__(self, noul):
        self.type, self.noul = "noul", noul

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

function pyProject(tag: string): string {
  const dir = scratch(tag)
  writeFileSync(join(dir, 'langchain_typesafe.py'), LANGCHAIN_STUB)
  return dir
}

/**
 * `python3 -c "import ast; ast.parse(...)"` over one artifact. Returns CPython's own
 * diagnostics — a SyntaxError here means the emitted module cannot be imported at all.
 *
 * Read with `errors="surrogatepass"` so a lone surrogate that survived into the file is
 * a parse result rather than a decode crash in the checker.
 */
export function parsePy(source: string): string[] {
  const dir = pyProject('pyparse')
  const f = join(dir, 'mod.py')
  writeFileSync(f, source)
  const r = spawnSync(PYTHON, ['-c',
    'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf8", errors="surrogatepass").read())', f],
    { encoding: 'utf8' })
  if (r.status === 0) return []
  return `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().split('\n').map(l => l.trim()).filter(Boolean)
}

/** N artifacts, one interpreter start. Same contract as `typecheckBatch`. */
export function parsePyBatch(sources: Record<string, string>): Record<string, string[]> {
  const dir = pyProject('pyparse')
  const out: Record<string, string[]> = {}
  for (const [name, src] of Object.entries(sources)) {
    out[name] = []
    writeFileSync(join(dir, `${name}.py`), src)
  }
  const script = [
    'import ast, json, sys',
    'res = {}',
    'for name in json.loads(sys.argv[1]):',
    '    try:',
    '        ast.parse(open(name + ".py", encoding="utf8", errors="surrogatepass").read())',
    '        res[name] = []',
    '    except Exception as e:',
    '        res[name] = [type(e).__name__ + ": " + str(e)]',
    'print(json.dumps(res))',
  ].join('\n')
  const r = spawnSync(PYTHON, ['-c', script, JSON.stringify(Object.keys(sources))],
    { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`python3 batch parse failed:\n${r.stdout}${r.stderr}`)
  return JSON.parse(r.stdout)
}

/**
 * Write the artifact, IMPORT it (which is strictly stronger than `ast.parse` — a NUL
 * byte fails at parse, but a decode error fails only at import), evaluate `call`, and
 * read the result back as JSON.
 *
 * `call` is a Python expression evaluated with the artifact's module namespace plus the
 * stub answer classes in scope, e.g. `reduce({"q": NoulAnswer(0.9)})`.
 */
export function runPy(source: string, call: string): unknown {
  return runPyScript(source, [
    'import json',
    'from langchain_typesafe import NoulAnswer, ChoiceAnswer, ScoreAnswer',
    'from mod import *',
    `print(json.dumps(${call}))`,
  ])
}

/**
 * The general form: the artifact verbatim as `mod.py`, an arbitrary driver as `run.py`,
 * its stdout parsed as JSON. `runPy`'s single-expression form cannot express `try`, and
 * "did the emitted reducer raise or return" is exactly the question §2 asks, so that has
 * to be writable on the consumer's side of the boundary rather than by editing `mod.py`.
 * Mirrors `runTs(source, driver)`.
 */
export function runPyScript(source: string, driver: string[]): unknown {
  const dir = pyProject('pyrun')
  writeFileSync(join(dir, 'mod.py'), source)
  writeFileSync(join(dir, 'run.py'), driver.join('\n'))
  const r = spawnSync(PYTHON, [join(dir, 'run.py')], { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`the emitted module failed:\n${r.stdout}${r.stderr}`)
  return JSON.parse(r.stdout)
}

/** `runPy` that hands back the failure instead of throwing. */
export function tryRunPy(source: string, call: string): { value?: unknown; error?: string } {
  try { return { value: runPy(source, call) } } catch (e) { return { error: (e as Error).message } }
}

/** Many `call`s against one artifact, one interpreter start. */
export function runPyBatch(source: string, calls: string[]): unknown[] {
  return runPyScript(source, [
    'import json',
    'from langchain_typesafe import NoulAnswer, ChoiceAnswer, ScoreAnswer',
    'from mod import *',
    `print(json.dumps([${calls.join(', ')}]))`,
  ]) as unknown[]
}
