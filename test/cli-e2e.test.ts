/**
 * jevc, as a process.
 *
 * `test/cli.test.ts` spawns the binary too, but it asserts on return values: "did this
 * invocation print something matching /X/". This file asserts on the things that only
 * exist once there is a real process — the exit code, which of the two streams a byte
 * landed on, whether the file the user named exists afterwards, and whether the artifact
 * that came out of the pipe is the artifact jevc produced.
 *
 * Four invariants are asserted on EVERY invocation this file makes (see `jevc()`):
 *   1. the process exited, rather than dying on a signal;
 *   2. no raw Node stack frame reached either stream;
 *   3. no `node:internal` frame and no bare `TypeError:` reached stderr;
 *   4. stderr never carries the Node crash banner.
 * Exit code and stream contents are asserted per case, because "what counts as success"
 * is the thing under test.
 *
 * Everything here is offline: TYPESAFE_API_KEY is deleted from the child environment of
 * every spawn, including the `check --live` case, which must fail before it can open a
 * socket. Scratch files live under one OS temp dir created in beforeAll and removed in
 * afterAll; nothing is written inside the repo.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { validateRequest } from '../src/contract.js'
import { loadFixtures } from '../src/check.js'
import { pythonAvailable } from './helpers/artifacts.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'dist', 'cli.js')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc')

/** The child environment for every spawn: the developer's key is removed rather than
 *  merely unset-if-absent, so a machine that has one cannot make `--live` reach the
 *  network, and the examples cannot quietly start calling the API. */
const OFFLINE_ENV = (() => {
  const { TYPESAFE_API_KEY: _drop, ...rest } = process.env
  return { ...rest, NO_COLOR: '1' }
})()

type Result = { args: string[]; status: number | null; signal: string | null; stdout: string; stderr: string }

/** The brief's literal shape for a stack frame, plus the parenthesised form V8 uses for a
 *  named function — `    at foo (/path/file.js:1:2)` does not end in `:\d+:\d+`. */
const BARE_FRAME = /^\s+at .+:\d+:\d+$/m
const NAMED_FRAME = /^\s+at .+\(.*:\d+:\d+\)$/m

function assertNoCrashLeak(r: Result) {
  const where = `jevc ${r.args.join(' ')}`
  expect(r.signal, `${where} died on a signal`).toBe(null)
  expect(typeof r.status, `${where} produced no exit code`).toBe('number')
  for (const [stream, text] of [['stderr', r.stderr], ['stdout', r.stdout]] as const) {
    expect(BARE_FRAME.test(text), `${where}: raw stack frame on ${stream}:\n${text}`).toBe(false)
    expect(NAMED_FRAME.test(text), `${where}: raw stack frame on ${stream}:\n${text}`).toBe(false)
  }
  expect(r.stderr, where).not.toContain('node:internal')
  // The crash banner Node prints under a stack trace. Its presence means the failure was
  // an unhandled throw, not a message someone wrote for a user.
  expect(r.stderr, where).not.toMatch(/^Node\.js v\d+/m)
  expect(r.stderr, where).not.toMatch(/^(TypeError|ReferenceError|RangeError|SyntaxError):/m)
}

/** Spawns the real binary. `input` defaults to '' so a command that reads `-` can never
 *  block on an inherited tty. cwd is pinned to the repo root rather than inherited, so the
 *  suite does not depend on where vitest was started. */
function jevc(args: string[], input = ''): Result {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT, input, encoding: 'utf8', env: OFFLINE_ENV, timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
  })
  const out: Result = { args, status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  assertNoCrashLeak(out)
  return out
}

/** Runs a shell line so stdout and stderr can be redirected to separate files — the only
 *  way to prove the split, since a combined capture cannot tell them apart. */
function sh(script: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('/bin/sh', ['-c', script], {
    cwd: ROOT, input: '', encoding: 'utf8', env: OFFLINE_ENV, timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// ---------------------------------------------------------------------------
// Scratch space. One root, removed whole; nothing is written inside the repo.
// ---------------------------------------------------------------------------
let DIR: string
const p = (...parts: string[]) => join(DIR, ...parts)
const put = (name: string, body: string) => { const f = p(name); writeFileSync(f, body); return f }
const putJson = (name: string, v: unknown) => put(name, JSON.stringify(v))

/** A schema that compiles to exactly one noul question. */
const SCHEMA = { type: 'object', properties: { is_urgent: { type: 'boolean', description: 'Urgent?' } } }

/** The same schema plus a free-text field, so compiling it emits BOTH an artifact and a
 *  residual diagnostic — the case where the stdout/stderr split can actually be wrong. */
const SCHEMA_WITH_RESIDUAL = {
  type: 'object',
  properties: {
    is_urgent: { type: 'boolean', description: 'Urgent?' },
    summary: { type: 'string', description: 'Summarise it.' },
  },
}

/** A minimal, internally valid Program, in the shape emit-policy documents. */
const PROGRAM = {
  decisions: [{ id: 'outside_repo', kind: 'noul', instructions: 'Outside the repo root?' }],
  reduce: {
    kind: 'rules',
    rules: [{ when: [{ id: 'outside_repo', op: 'gte', value: 0.8 }], then: 'deny' }],
    otherwise: 'allow',
  },
  residual: '', dropped: [],
}

let SCHEMA_FILE: string
let RESIDUAL_FILE: string
let PROGRAM_FILE: string
let PROSE_FILE: string
let EMPTY_FILE: string
let NOT_JSON_FILE: string
let MISSING: string

beforeAll(() => {
  // Build once, here — every assertion below is about the compiled binary, not about src.
  // Only when dist is actually stale, though: vitest runs test files in parallel and
  // test/cli.test.ts is spawning this same dist/cli.js, so an unconditional rewrite would
  // race with it. A no-op staleness check costs a few stat()s and cannot.
  const newest = (dir: string): number => Math.max(...readdirSync(dir, { withFileTypes: true })
    .map(e => e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs))
  if (!existsSync(CLI) || statSync(CLI).mtimeMs < newest(join(ROOT, 'src'))) {
    const built = spawnSync(TSC, [], { cwd: ROOT, encoding: 'utf8' })
    expect(built.status, `tsc failed:\n${built.stdout}${built.stderr}`).toBe(0)
  }
  expect(existsSync(CLI), 'dist/cli.js is missing; run npm run build').toBe(true)

  DIR = mkdtempSync(join(tmpdir(), 'jevc-e2e-'))
  SCHEMA_FILE = putJson('schema.json', SCHEMA)
  RESIDUAL_FILE = putJson('residual-schema.json', SCHEMA_WITH_RESIDUAL)
  PROGRAM_FILE = putJson('program.json', PROGRAM)
  PROSE_FILE = put('AGENTS.md', '# Rules\nNever push to main.\n')
  EMPTY_FILE = put('empty.json', '')
  NOT_JSON_FILE = put('not-json.json', '{not json')
  MISSING = p('does-not-exist.json')
  mkdirSync(p('adir'))
}, 60_000)

afterAll(() => {
  if (!DIR) return
  // The read-only fixtures below would otherwise survive the rm.
  for (const f of ['readonly.ts']) { try { chmodSync(p(f), 0o644) } catch { /* never created */ } }
  rmSync(DIR, { recursive: true, force: true })
})

// ===========================================================================
// 1. Exit codes, over the whole matrix.
//
// One spawn per row, one named test per row. The point is not any single message: it is
// that EVERY way of getting it wrong exits non-zero with a sentence on stderr and no
// artifact on stdout, and every way of getting it right exits 0.
// ===========================================================================

/** Substrings that only ever appear inside an emitted artifact. If one of these is on the
 *  stdout of a failing run, jevc printed a deployable thing and then said it failed. */
const ARTIFACT_MARKERS = [
  'programQuestions', 'createTypeSafeAi', 'TypeSafeClassifier',
  '"questions"', 'backend: jev', 'version: 1',
]

type Case = { label: string; args: () => string[]; input?: string }

const FAILING: Case[] = [
  { label: 'no command at all', args: () => [] },
  { label: 'an unknown command', args: () => ['nonsense'] },
  { label: 'compile with no input path', args: () => ['compile'] },
  { label: 'explain with no id', args: () => ['explain'] },
  { label: 'emit-policy with no --for', args: () => ['emit-policy', PROGRAM_FILE] },
  { label: 'emit-policy with no program', args: () => ['emit-policy', '--for', 'bouncer'] },

  // Inputs.
  { label: 'compile a file that does not exist', args: () => ['compile', MISSING] },
  { label: 'compile a directory', args: () => ['compile', p('adir')] },
  { label: 'compile a file that is not JSON', args: () => ['compile', NOT_JSON_FILE] },
  { label: 'compile an empty file', args: () => ['compile', EMPTY_FILE] },
  { label: 'compile valid JSON that is not a schema (package.json)', args: () => ['compile', 'package.json'] },
  { label: 'compile a Program where a schema belongs', args: () => ['compile', PROGRAM_FILE] },
  { label: 'compile empty stdin', args: () => ['compile', '-'] },
  { label: 'emit-policy a file that does not exist', args: () => ['emit-policy', '--for', 'bouncer', MISSING] },
  { label: 'emit-policy a directory', args: () => ['emit-policy', '--for', 'bouncer', p('adir')] },
  { label: 'emit-policy a file that is not JSON', args: () => ['emit-policy', '--for', 'bouncer', NOT_JSON_FILE] },
  { label: 'emit-policy an empty file', args: () => ['emit-policy', '--for', 'bouncer', EMPTY_FILE] },
  { label: 'emit-policy valid JSON that is not a Program (package.json)', args: () => ['emit-policy', '--for', 'bouncer', 'package.json'] },
  { label: 'emit-policy a schema where a Program belongs', args: () => ['emit-policy', '--for', 'bouncer', SCHEMA_FILE] },
  { label: 'emit-policy empty stdin', args: () => ['emit-policy', '--for', 'bouncer', '-'] },
  { label: 'check --fixtures a directory that does not exist', args: () => ['check', '--fixtures', p('nope')] },
  { label: 'check --fixtures a file, not a directory', args: () => ['check', '--fixtures', SCHEMA_FILE] },
  { label: 'explain --fixtures a file, not a directory', args: () => ['explain', '--fixtures', SCHEMA_FILE, 'is_commit_operation'] },
  { label: 'explain an id no fixture has', args: () => ['explain', 'no_such_decision'] },

  // Flag forms.
  { label: '--emit as the last argument, with no value', args: () => ['compile', SCHEMA_FILE, '--emit'] },
  { label: '--emit= with an empty value', args: () => ['compile', SCHEMA_FILE, '--emit='] },
  { label: '--emit whose value is another flag', args: () => ['compile', SCHEMA_FILE, '--emit', '--for'] },
  { label: '-o as the last argument, with no value', args: () => ['compile', SCHEMA_FILE, '-o'] },
  { label: '--for as the last argument, with no value', args: () => ['emit-policy', PROGRAM_FILE, '--for'] },
  { label: 'an unknown flag on compile', args: () => ['compile', SCHEMA_FILE, '--emmit', 'json'] },
  { label: 'an unknown flag on check', args: () => ['check', '--emit', 'json'] },
  { label: 'an unknown flag on explain', args: () => ['explain', 'is_commit_operation', '--live'] },
  { label: 'an unknown flag on emit-policy', args: () => ['emit-policy', '--for', 'bouncer', PROGRAM_FILE, '--output', p('o.yaml')] },
  { label: 'a single-dash long flag', args: () => ['compile', SCHEMA_FILE, '-emit', 'json'] },
  { label: 'an unknown --emit value', args: () => ['compile', SCHEMA_FILE, '--emit', 'yaml'] },
  { label: 'an unknown --for value', args: () => ['emit-policy', '--for', 'jev-guard', PROGRAM_FILE] },
]

describe('every failing invocation: non-zero, a sentence on stderr, nothing on stdout', () => {
  for (const c of FAILING) {
    it(c.label, () => {
      const r = jevc(c.args(), c.input)
      expect(r.status, `expected non-zero for: jevc ${c.args().join(' ')}`).not.toBe(0)
      expect(r.stderr.trim().length, 'a failure with no message is not actionable').toBeGreaterThan(0)
      for (const m of ARTIFACT_MARKERS) {
        expect(r.stdout, `a failing run printed artifact text (${m})`).not.toContain(m)
      }
    })
  }
})

const SUCCEEDING: Case[] = [
  { label: 'compile a schema to the default target', args: () => ['compile', SCHEMA_FILE] },
  { label: 'compile --emit sdk', args: () => ['compile', SCHEMA_FILE, '--emit', 'sdk'] },
  { label: 'compile --emit json', args: () => ['compile', SCHEMA_FILE, '--emit', 'json'] },
  { label: 'compile --emit ai-sdk', args: () => ['compile', SCHEMA_FILE, '--emit', 'ai-sdk'] },
  { label: 'compile --emit langchain', args: () => ['compile', SCHEMA_FILE, '--emit', 'langchain'] },
  { label: 'compile --emit=json (the = form)', args: () => ['compile', SCHEMA_FILE, '--emit=json'] },
  { label: 'compile a schema from stdin', args: () => ['compile', '-'], input: JSON.stringify(SCHEMA) },
  { label: 'compile a prose file with --lift', args: () => ['compile', PROSE_FILE, '--lift'] },
  { label: 'emit-policy --for bouncer', args: () => ['emit-policy', '--for', 'bouncer', PROGRAM_FILE] },
  { label: 'emit-policy --for toolgate', args: () => ['emit-policy', '--for', 'toolgate', PROGRAM_FILE] },
  { label: 'emit-policy from stdin', args: () => ['emit-policy', '--for', 'bouncer', '-'], input: JSON.stringify(PROGRAM) },
  { label: 'check, offline', args: () => ['check'] },
  { label: 'explain a real decision id', args: () => ['explain', 'is_commit_operation'] },
]

describe('every succeeding invocation: exit 0 with the artifact on stdout', () => {
  for (const c of SUCCEEDING) {
    it(c.label, () => {
      const r = jevc(c.args(), c.input)
      expect(r.status, `expected 0 for: jevc ${c.args().join(' ')}\n${r.stderr}`).toBe(0)
      expect(r.stdout.length, 'exit 0 with an empty stdout is a silent success').toBeGreaterThan(0)
    })
  }
})

// ===========================================================================
// 2. Which stream. `jevc compile s.json > out.ts` has to produce a clean file, so the
//    split is checked by redirecting to two files and parsing the one the shell captured
//    — not by reading a combined stream, which cannot tell a diagnostic from an artifact.
//
//    The schema carries a free-text property on purpose: that is what makes jevc print a
//    `residual:` block, so there is something that COULD land in the artifact.
// ===========================================================================
describe('stdout carries the artifact, stderr carries the diagnostics', () => {
  /** Lines that are jevc talking to the operator. None may appear in a redirected artifact. */
  const DIAGNOSTIC_LINE = /^(error|warn|info): |^dropped: |^residual:$|^wrote /m

  const redirect = (args: string[], tag: string) => {
    const out = p(`${tag}.out`)
    const err = p(`${tag}.err`)
    const r = sh(`${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${args.map(a => JSON.stringify(a)).join(' ')} > ${JSON.stringify(out)} 2> ${JSON.stringify(err)} < /dev/null`)
    return { status: r.status, out: readFileSync(out, 'utf8'), err: readFileSync(err, 'utf8') }
  }

  for (const target of ['sdk', 'json', 'ai-sdk', 'langchain'] as const) {
    it(`compile --emit ${target} puts the residual on stderr and only the artifact on stdout`, () => {
      const r = redirect(['compile', RESIDUAL_FILE, '--emit', target], `emit-${target}`)
      expect(r.status).toBe(0)
      expect(r.err, 'the residual is a diagnostic').toContain('residual:')
      expect(r.err).toContain('summary: Summarise it.')
      expect(r.out, `a diagnostic line reached the ${target} artifact`).not.toMatch(DIAGNOSTIC_LINE)
      expect(r.out).not.toContain('still require a generative model:\n-')
    })
  }

  // Out-of-band: the redirected file is handed to the check the real consumer performs.
  it('the redirected --emit json file is a request the wire validator accepts', () => {
    const r = redirect(['compile', RESIDUAL_FILE, '--emit', 'json'], 'wire')
    const req = JSON.parse(r.out)
    expect(validateRequest(req).filter(i => i.severity === 'error' && !['path_unresolved', 'state_empty'].includes(i.code)))
      .toEqual([])
    expect(Object.keys(req.questions)).toEqual(['is_urgent'])
  })

  // python3 is not guaranteed on a CI image; every other langchain check in this round is
  // already behind `pythonAvailable` (test/helpers/artifacts.ts:185). This one was not, and
  // would have failed with `py.status === null` on a machine without it.
  it.runIf(pythonAvailable)('the redirected --emit langchain file is Python that parses', () => {
    const r = redirect(['compile', RESIDUAL_FILE, '--emit', 'langchain'], 'py')
    const mod = p('redirected.py')
    writeFileSync(mod, r.out)
    const py = spawnSync('python3', ['-c', 'import ast, sys; ast.parse(open(sys.argv[1]).read())', mod],
      { encoding: 'utf8' })
    expect(py.status, py.stderr).toBe(0)
  })

  it('the redirected --emit sdk file is TypeScript that compiles under --strict', () => {
    const r = redirect(['compile', RESIDUAL_FILE, '--emit', 'sdk'], 'ts')
    // The artifact imports the published package name; in-repo that is the source entry.
    const entry = join(ROOT, 'src', 'index.js')
    const mod = p('redirected.ts')
    writeFileSync(mod, r.out.replaceAll(`from 'jevc'`, `from ${JSON.stringify(entry)}`))
    const tsc = spawnSync(TSC, ['--noEmit', '--strict', '--target', 'es2022', '--module', 'nodenext',
      '--moduleResolution', 'nodenext', '--skipLibCheck', '--allowImportingTsExtensions', mod],
      { cwd: ROOT, encoding: 'utf8' })
    expect(tsc.status, `${tsc.stdout}${tsc.stderr}`).toBe(0)
  }, 60_000)

  // The out-of-band check from each target doc: yaml.parse, then the top-level keys the
  // engine reads. bouncer's policy is `version`/`gate`; toolgate's is `questions`/
  // `thresholds` and has no version key at all.
  const POLICY_SHAPE = {
    bouncer: (d: Record<string, unknown>) => {
      expect(d.version).toBe(1)
      expect(d.gate).toHaveProperty('questions')
      expect(d.gate).toHaveProperty('rules')
    },
    toolgate: (d: Record<string, unknown>) => {
      expect(Object.keys(d.questions as object)).toEqual(['outside_repo'])
      const t = d.thresholds as { deny: unknown; ask: unknown }
      expect(typeof t.deny).toBe('number')
      expect(typeof t.ask).toBe('number')
    },
  }
  for (const target of ['bouncer', 'toolgate'] as const) {
    it(`the redirected ${target} policy is YAML that parses into the shape the engine reads`, () => {
      const r = redirect(['emit-policy', '--for', target, PROGRAM_FILE], `policy-${target}`)
      expect(r.status).toBe(0)
      const doc = parseYaml(r.out) as Record<string, unknown>
      POLICY_SHAPE[target](doc)
      expect(r.out).not.toMatch(DIAGNOSTIC_LINE)
    })
  }

  it('the "wrote <path>" confirmation for -o is a diagnostic, not part of the artifact', () => {
    const dest = p('confirm.ts')
    const r = redirect(['compile', SCHEMA_FILE, '-o', dest], 'confirm')
    expect(r.status).toBe(0)
    expect(r.err).toContain(`wrote ${dest}`)
    expect(r.out, '-o means the artifact goes to the file, not to both').toBe('')
    expect(readFileSync(dest, 'utf8')).toContain('programQuestions')
  })
})

// ===========================================================================
// 3. LIVE BUG — a piped artifact is silently truncated at the pipe buffer.
//
//    Every stdout path in src/cli.ts is `process.stdout.write(out)` immediately followed
//    by `process.exit(0)` (cli.ts:224-225 for --lift, 282-283 for compile, 384-385 for
//    emit-policy). When stdout is a FILE the write is synchronous and this is fine; when
//    stdout is a PIPE it is asynchronous, and process.exit() discards whatever has not
//    been flushed. Measured: 65,536 bytes survive and the rest is dropped, at exit 0,
//    with nothing on stderr.
//
//    This is the repo's own headline failure, mechanised: an artifact that parses cleanly
//    and means something else. For bouncer the truncated policy below still parses as
//    YAML — it just has 43 of 701 rules and no terminal `default`, and
//    docs/targets/target-bouncer.md:59 says "No `default` at all = warning; at runtime a
//    non-match then emits nothing". A gate reduced to 6% of its rules, at exit 0.
//
//    The tests assert the invariant, not the measured number: what comes out of a pipe
//    must be what comes out of a redirect. Leave failing.
// ===========================================================================
describe('LIVE BUG: stdout is truncated at 64 KiB when it is a pipe', () => {
  const quoted = (args: string[]) =>
    `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${args.map(a => JSON.stringify(a)).join(' ')}`

  /** Same command twice: once redirected to a file, once through `| cat` into a file.
   *  A user does the second every time they write `jevc ... | tee`, `| ssh host 'cat >'`,
   *  `| pbcopy`, or pipe the lift request straight into an agent. */
  const bothWays = (args: string[], tag: string) => {
    const viaFile = p(`${tag}.file`)
    const viaPipe = p(`${tag}.pipe`)
    const a = sh(`${quoted(args)} > ${JSON.stringify(viaFile)} 2>/dev/null < /dev/null`)
    const b = sh(`${quoted(args)} 2>/dev/null < /dev/null | cat > ${JSON.stringify(viaPipe)}`)
    return { fileStatus: a.status, pipeStatus: b.status,
      file: readFileSync(viaFile, 'utf8'), pipe: readFileSync(viaPipe, 'utf8') }
  }

  let bigSchema: string
  let bigProgram: string
  let bigProse: string

  beforeAll(() => {
    // ~237 KB of emitted TypeScript / ~110 KB of emitted YAML / ~188 KB of lift prompt:
    // all comfortably over the 64 KiB pipe buffer, so a partial flush still fails the
    // equality assertion rather than passing by luck.
    const props: Record<string, unknown> = {}
    for (let i = 0; i < 800; i++) {
      props[`q_${i}`] = { type: 'boolean', description: `Is condition ${i} true in the state? `.repeat(4) }
    }
    bigSchema = putJson('big-schema.json', { type: 'object', properties: props })

    const decisions = [] as unknown[]
    const rules = [] as unknown[]
    for (let i = 0; i < 700; i++) {
      decisions.push({ id: `risk_${i}`, kind: 'noul', instructions: `Does the command do dangerous thing number ${i}? `.repeat(3) })
      rules.push({ when: [{ id: `risk_${i}`, op: 'gte', value: 0.8 }], then: 'deny' })
    }
    bigProgram = putJson('big-program.json', {
      decisions, reduce: { kind: 'rules', rules, otherwise: 'allow' }, residual: '', dropped: [],
    })

    bigProse = put('big-AGENTS.md', Array.from({ length: 3000 },
      (_, i) => `- Rule ${i}: never do the thing numbered ${i} without asking.`).join('\n'))
  })

  it.fails('compile --emit sdk through a pipe delivers the whole module', () => {
    const r = bothWays(['compile', bigSchema, '--emit', 'sdk'], 'big-sdk')
    expect(r.fileStatus).toBe(0)
    expect(r.pipeStatus).toBe(0)
    expect(r.file.length).toBeGreaterThan(200_000)
    expect(r.pipe.length, 'the piped module is shorter than the redirected one').toBe(r.file.length)
    expect(r.pipe).toBe(r.file)
  })

  it.fails('compile --emit json through a pipe delivers a parseable request', () => {
    const r = bothWays(['compile', bigSchema, '--emit', 'json'], 'big-json')
    expect(r.pipeStatus).toBe(0)
    expect(() => JSON.parse(r.pipe)).not.toThrow()
    expect(Object.keys(JSON.parse(r.file).questions)).toHaveLength(800)
    expect(Object.keys(JSON.parse(r.pipe).questions)).toHaveLength(800)
  })

  it.fails('emit-policy --for bouncer through a pipe delivers every rule, not the first 43', () => {
    const r = bothWays(['emit-policy', '--for', 'bouncer', bigProgram], 'big-bouncer')
    expect(r.pipeStatus, 'a truncated gate must not be delivered at exit 0').toBe(0)
    expect(r.pipe.length, `the piped policy is ${r.file.length - r.pipe.length} bytes short`)
      .toBe(r.file.length)

    // The truncated file is not a crash and not necessarily a parse error — depending on
    // where the cut lands it is a policy that LOADS, with most of the gate missing, which
    // is the only failure mode bouncer cannot see. target-bouncer.md:59: "No `default` at
    // all = warning; at runtime a non-match then emits nothing."
    const rulesOf = (text: string) => {
      const doc = parseYaml(text) as { gate?: { rules?: unknown[] } } | null
      return doc?.gate?.rules
    }
    expect(rulesOf(r.file)).toHaveLength(701)
    expect(rulesOf(r.pipe), 'rules silently dropped between jevc and the pipe').toHaveLength(701)
    expect(rulesOf(r.pipe)!.at(-1)).toEqual({ default: 'allow' })
  })

  it.fails('compile --lift through a pipe delivers a prompt that still has its fence and its instruction', () => {
    const r = bothWays(['compile', bigProse, '--lift'], 'big-lift')
    expect(r.pipeStatus).toBe(0)
    // buildLiftRequest widens the fence until the run of dashes does not occur in the
    // source, precisely so text after a fake terminator cannot be read as instructions.
    // Truncation deletes the real terminator, which defeats the whole mechanism.
    expect(r.file).toContain('--- end ---')
    expect(r.pipe, 'the piped lift request lost its terminating fence').toContain('--- end ---')
    expect(r.pipe, 'the piped lift request lost its final instruction').toContain('Return only the JSON object.')
    expect(r.pipe).toBe(r.file)
  })
})

// ===========================================================================
// 4. Nothing is written when the command fails.
// ===========================================================================
describe('a failed command leaves the filesystem alone', () => {
  const cases: Array<{ label: string; args: (dest: string) => string[] }> = [
    { label: 'an unknown --emit value', args: d => ['compile', SCHEMA_FILE, '--emit', 'yaml', '-o', d] },
    { label: 'an unknown flag name', args: d => ['compile', SCHEMA_FILE, '--emmit', 'json', '-o', d] },
    { label: 'an input file that does not exist', args: d => ['compile', MISSING, '-o', d] },
    { label: 'a schema that compiles to no decisions', args: d => ['compile', 'package.json', '-o', d] },
    { label: 'a target that cannot express the program', args: d => ['emit-policy', '--for', 'bouncer', p('score-program.json'), '-o', d] },
    { label: 'a rule naming a decision that does not exist', args: d => ['emit-policy', '--for', 'bouncer', p('ghost-program.json'), '-o', d] },
    { label: 'an unknown policy target', args: d => ['emit-policy', '--for', 'nope', PROGRAM_FILE, '-o', d] },
    { label: 'a file that is valid JSON but not a Program', args: d => ['emit-policy', '--for', 'bouncer', 'package.json', '-o', d] },
  ]

  beforeAll(() => {
    putJson('score-program.json', {
      decisions: [{ id: 'radius', kind: 'score', instructions: 'How wide?', criteria: ['file', 'repo'] }],
      reduce: { kind: 'rules', rules: [{ when: [{ id: 'radius', op: 'gte', value: 0.8 }], then: 'deny' }], otherwise: 'allow' },
      residual: '', dropped: [],
    })
    putJson('ghost-program.json', {
      ...PROGRAM,
      reduce: { kind: 'rules', rules: [{ when: [{ id: 'ghost', op: 'gte', value: 0.8 }], then: 'deny' }], otherwise: 'allow' },
    })
  })

  cases.forEach((c, i) => {
    it(`${c.label}: creates no file at -o`, () => {
      const dest = p(`never-${i}.out`)
      const r = jevc(c.args(dest))
      expect(r.status).not.toBe(0)
      expect(existsSync(dest), `${dest} was created by a failing run`).toBe(false)
    })

    it(`${c.label}: leaves an existing -o file byte-identical`, () => {
      const dest = p(`keep-${i}.out`)
      const before = `# the policy that is currently deployed, case ${i}\n`
      writeFileSync(dest, before)
      const r = jevc(c.args(dest))
      expect(r.status).not.toBe(0)
      expect(readFileSync(dest, 'utf8'), 'a failing run overwrote a good artifact').toBe(before)
    })
  })

  it('-o into a directory that does not exist reports it and creates nothing', () => {
    const dest = p('no-such-dir', 'out.ts')
    const r = jevc(['compile', SCHEMA_FILE, '-o', dest])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(dest)
    expect(existsSync(p('no-such-dir'))).toBe(false)
  })

  it('-o onto a file that is not writable reports it and leaves the file intact', () => {
    // Root ignores the mode bits, so the case cannot be set up there.
    if (process.getuid?.() === 0) return
    const dest = p('readonly.ts')
    writeFileSync(dest, 'KEEP ME\n')
    chmodSync(dest, 0o444)
    const r = jevc(['compile', SCHEMA_FILE, '-o', dest])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(dest)
    expect(readFileSync(dest, 'utf8')).toBe('KEEP ME\n')
    chmodSync(dest, 0o644)
  })

  it('-o onto an existing file is overwritten only when the command succeeds', () => {
    const dest = p('overwrite.ts')
    writeFileSync(dest, 'STALE\n')
    const r = jevc(['compile', SCHEMA_FILE, '-o', dest])
    expect(r.status).toBe(0)
    expect(readFileSync(dest, 'utf8')).toContain('programQuestions')
  })
})

// ===========================================================================
// 5. Cases with a known history.
// ===========================================================================
describe('cases with a known history', () => {
  // Used to print `TypeError: p.decisions is not iterable` with a full stack, because
  // valid JSON was cast to Program and handed to validateProgram.
  it('emit-policy --for bouncer package.json is a sentence, not a TypeError', () => {
    const r = jevc(['emit-policy', '--for', 'bouncer', 'package.json'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('is not a jevc program')
    expect(r.stderr).toContain('package.json')
    expect(r.stderr).not.toContain('is not iterable')
    expect(r.stdout).toBe('')
  })

  // `--emit` with nothing after it returned undefined, and `?? 'sdk'` could not tell that
  // apart from "the flag was never given": the DEFAULT emitter ran, at exit 0.
  it('a valued flag with no value is an error, not a silent fall-through to the default', () => {
    const r = jevc(['compile', SCHEMA_FILE, '--emit'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('requires a value')
    expect(r.stdout).toBe('')
  })

  // An unrecognised argument was never rejected, so a typo produced the default artifact.
  it('an unrecognised argument is an error, not the default artifact at exit 0', () => {
    const r = jevc(['compile', SCHEMA_FILE, '--emmit', 'json'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('--emmit')
    expect(r.stdout).toBe('')
  })

  // --live must refuse before it can open a socket. The key is deleted from the child
  // environment, so this test proves the refusal path and nothing else; no test in this
  // file may set a key or make a call.
  it('check --live without TYPESAFE_API_KEY names the variable and never reaches the network', () => {
    const r = jevc(['check', '--live'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('TYPESAFE_API_KEY')
    // checkLive prints the "N rows checked live against <model>" summary; its absence is
    // the evidence that the refusal happened before any request was built.
    expect(r.stdout).toBe('')
    expect(r.stderr).not.toMatch(/checked live|fetch failed|ENOTFOUND|ECONNREFUSED|401|429/)
  })

  it('check --live is refused even when a fixtures directory is also given', () => {
    const r = jevc(['check', '--live', '--fixtures', 'fixtures'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('TYPESAFE_API_KEY')
    expect(r.stdout).toBe('')
  })

  // "I compiled nothing" must not read as success. Fixed in round 3 for the empty case;
  // asserted here at the process level, across every target including the default.
  for (const args of [[], ['--emit', 'sdk'], ['--emit', 'json'], ['--emit', 'ai-sdk'], ['--emit', 'langchain']]) {
    it(`compile ${args.join(' ') || '(default target)'} on a schema with zero decisions exits non-zero`, () => {
      const onlyText = putJson('only-text.json', { type: 'object', properties: {
        summary: { type: 'string', description: 'One-paragraph summary.' } } })
      const r = jevc(['compile', onlyText, ...args])
      expect(r.status, 'exit 0 on "I compiled nothing" is success for a refusal').not.toBe(0)
      expect(r.stdout).toBe('')
    })
  }

  /**
   * REGRESSION GUARD — a dotted-id collision used to drop questions and still exit 0.
   *
   * `{"a.b": …, "a": {"b": …}, "c": …}` builds the id "a.b" twice. from-schema.ts refuses
   * to keep EITHER — a reducer condition on "a.b" could not say which question it means —
   * and the CLI once treated that as an ordinary `dropped:` note. Two of the schema's three
   * questions vanished and jevc wrote a deployable artifact containing only `c`, at exit 0.
   * Nothing downstream could tell that the gate it was running was a third of the gate that
   * was authored.
   *
   * This test was written as an `it.fails` pin against the tree at a5eadbb. The cleanup
   * round closed it independently by giving `dropped[]` a `kind` and making
   * `kind: 'collision'` an error however many decisions survived — "I dropped most of it"
   * is no more of a success than "I compiled nothing". Kept as a live assertion so the
   * contract cannot quietly revert.
   */
  it('compile exits non-zero when a dotted-id collision drops questions', () => {
    const collide = putJson('collide.json', { type: 'object', properties: {
      'a.b': { type: 'boolean', description: 'Literal dotted property?' },
      a: { type: 'object', properties: { b: { type: 'boolean', description: 'Nested dotted property?' } } },
      c: { type: 'boolean', description: 'The survivor?' },
    } })
    const r = jevc(['compile', collide])
    expect(r.stderr, 'the collision is at least reported').toContain('is defined 2 times')
    expect(r.status, 'a collision that silently deletes 2 of 3 questions must not exit 0').not.toBe(0)
    expect(r.stdout, 'no artifact may be emitted from a program with deleted questions').toBe('')
  })
})

// ===========================================================================
// 6. Flag forms the matrix requires but nothing covers.
// ===========================================================================
describe('flag forms', () => {
  it('--emit=value and --emit value produce byte-identical artifacts', () => {
    const a = jevc(['compile', SCHEMA_FILE, '--emit=json'])
    const b = jevc(['compile', SCHEMA_FILE, '--emit', 'json'])
    expect(a.status).toBe(0)
    expect(b.status).toBe(0)
    expect(a.stdout).toBe(b.stdout)
  })

  it('-o=path and -o path write byte-identical files', () => {
    const one = p('form-a.ts')
    const two = p('form-b.ts')
    expect(jevc(['compile', SCHEMA_FILE, `-o=${one}`]).status).toBe(0)
    expect(jevc(['compile', SCHEMA_FILE, '-o', two]).status).toBe(0)
    expect(readFileSync(one, 'utf8')).toBe(readFileSync(two, 'utf8'))
  })

  it('a flag-shaped -o value is refused and creates no file named after a flag', () => {
    const r = jevc(['compile', SCHEMA_FILE, '-o', '--emit'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('requires a value')
    const stray = join(ROOT, '--emit')
    const leaked = existsSync(stray)
    if (leaked) rmSync(stray)
    expect(leaked, 'a file named "--emit" was created in the repo root').toBe(false)
  })

  /**
   * LIVE BUG — `--lift` accepts `-o` and silently ignores it.
   *
   * cli.ts:85 lists `o` among compile's known flags, so `-o` passes the unknown-flag gate;
   * cli.ts:218-226 then writes the lift request to stdout and exits 0 without ever looking
   * at it. `jevc compile AGENTS.md --lift -o request.txt` therefore exits 0, prints 4 KB to
   * the terminal, and leaves whatever was at request.txt untouched — so a re-run that was
   * meant to refresh the request hands the agent the PREVIOUS document's prompt.
   *
   * This is the identical failure cli.ts:74-82 describes for `emit-policy --output
   * policy.yaml` ("printed the policy to stdout and left a stale policy on disk"), which
   * that comment calls out as the reason unknown flags are now rejected. `-o` on `--lift`
   * is the case the rejection cannot catch, because the flag is known — it is just unread.
   */
  it.fails('LIVE BUG: compile --lift honours -o instead of silently printing to stdout', () => {
    const dest = p('lift-request.txt')
    writeFileSync(dest, 'STALE REQUEST FROM THE PREVIOUS RUN\n')
    const r = jevc(['compile', PROSE_FILE, '--lift', '-o', dest])
    expect(r.status).toBe(0)
    expect(readFileSync(dest, 'utf8'), '--lift ignored -o and left the stale file in place')
      .not.toBe('STALE REQUEST FROM THE PREVIOUS RUN\n')
    expect(readFileSync(dest, 'utf8')).toContain('Never push to main.')
  })

  /**
   * LIVE BUG — a repeated valued flag is resolved silently, first occurrence wins.
   *
   * `flag()` (cli.ts:16-47) returns on its first match, so `--emit json --emit sdk` emits
   * JSON at exit 0 and never mentions that `--emit sdk` was discarded. That is the
   * "wrong artifact at exit 0" class cli.ts:74-82 refuses everywhere else in argv: a
   * Makefile that appends `$(EXTRA_FLAGS)` to a command that already carries `--emit`,
   * or an edited shell-history line, produces a file in the wrong language with no signal.
   *
   * Refusing an ambiguous argv is this CLI's stated rule, so that is what these assert.
   * Last-wins is the other defensible fix; if the integrator prefers it, these tests
   * should be changed to assert the LAST value took effect — but first-wins-in-silence
   * must not stand.
   */
  it.fails('LIVE BUG: a repeated --emit is refused rather than silently resolved to the first', () => {
    const r = jevc(['compile', SCHEMA_FILE, '--emit', 'json', '--emit', 'sdk'])
    expect(r.status,
      'a wire request was emitted at exit 0 for a command whose last --emit said sdk').not.toBe(0)
  })

  it.fails('LIVE BUG: a repeated --for is refused rather than silently resolved to the first', () => {
    // bouncer and toolgate are different engines with different schemas, so this is not a
    // near miss: the file written is one the named target cannot load at all.
    const r = jevc(['emit-policy', '--for', 'bouncer', '--for', 'toolgate', PROGRAM_FILE])
    expect(r.status,
      'a bouncer policy was emitted at exit 0 for a command whose last --for said toolgate').not.toBe(0)
  })

  it.fails('LIVE BUG: a repeated -o is refused rather than leaving the named file absent', () => {
    const first = p('repeat-a.ts')
    const second = p('repeat-b.ts')
    const r = jevc(['compile', SCHEMA_FILE, '-o', first, '-o', second])
    // Under every convention one of these two files is the one the user meant. Under the
    // current behaviour the second is simply never created, and exit 0 says it was fine.
    expect(r.status, `exit 0, wrote ${first}, and never created ${second}`).not.toBe(0)
  })

  /**
   * LIVE BUG — `--lift` on an empty document is a 4 KB prompt at exit 0.
   *
   * The non-lift path was fixed in round 3: a schema that compiles to nothing exits 1
   * ("Nothing to emit"). The lift path has no such gate, so `jevc compile empty.md --lift`
   * prints a complete lowering prompt whose document section is empty and exits 0. The
   * agent that receives it has nothing to lower and will either return an empty Program or
   * invent one — the "compiled nothing, reported success" failure the tool exists to refuse.
   */
  it.fails('LIVE BUG: compile --lift on an empty document exits non-zero', () => {
    const blank = put('blank.md', '')
    const r = jevc(['compile', blank, '--lift'])
    expect(r.status, 'a lift request over an empty document is not a success').not.toBe(0)
  })
})

// ===========================================================================
// 7. The examples, as real processes.
//
//    test/examples.test.ts already proves they typecheck, run offline and (for 04) print
//    three specific strings. What is added here is the process level — exit code, clean
//    stderr, independence from the caller's cwd — and the claim each example's OWN caption
//    makes, checked against the fixtures the caption says the numbers come from.
// ===========================================================================
describe('the examples, as real processes', () => {
  const EXAMPLES = ['01-schema-to-jev.ts', '02-agents-md-guardrail.ts', '03-model-router.ts', '04-policy-emit.ts']

  const runExample = (name: string, cwd = ROOT) => {
    const r = spawnSync(TSX, [join(ROOT, 'examples', name)], {
      cwd, input: '', encoding: 'utf8', env: OFFLINE_ENV, timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
    })
    const res: Result = { args: [name], status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    assertNoCrashLeak(res)
    return res
  }

  for (const name of EXAMPLES) {
    it(`${name} exits 0 with nothing on stderr`, () => {
      const r = runExample(name)
      expect(r.status, r.stderr).toBe(0)
      expect(r.stderr, 'an example that warns on stderr is an example that is half broken').toBe('')
      expect(r.stdout.length).toBeGreaterThan(0)
    }, 60_000)
  }

  // 02 and 03 resolve fixtures against their own file URL specifically so they run from
  // anywhere; 01 and 04 touch no files. Asserted from a foreign cwd, which is how a reader
  // who copied the repo somewhere and ran `tsx path/to/example` invokes them.
  it('every example produces identical output from a foreign cwd', () => {
    for (const name of EXAMPLES) {
      const here = runExample(name, ROOT)
      const there = runExample(name, DIR)
      expect(there.status, `${name} from ${DIR}: ${there.stderr}`).toBe(0)
      expect(there.stdout, `${name} depends on the caller's cwd`).toBe(here.stdout)
    }
  }, 120_000)

  // 01's caption: "The interesting part is what it refuses: `reply` is text, and Jev emits
  // no text, so it lands in the residual instead of being invented as a question."
  it('01 keeps `reply` out of the questions and in the residual, as its caption claims', () => {
    const out = runExample('01-schema-to-jev.ts').stdout
    expect(out).toContain("3 of the schema's 4 fields compiled to Jev questions:")

    const block = out.match(/export const programQuestions = \{([\s\S]*?)\n\} as const/)
    expect(block, 'the emitted questions map is the thing the caption is about').not.toBeNull()
    const ids = [...block![1].matchAll(/^\s{2}([A-Za-z_][\w]*):/gm)].map(m => m[1])
    expect(ids).toEqual(['is_urgent', 'department', 'frustration'])
    expect(ids, '`reply` was invented as a question').not.toContain('reply')

    const residual = out.slice(out.indexOf('--- residual (still needs an LLM) ---'))
    expect(residual).toContain('reply: Draft a reply to the customer.')
  })

  // 02's caption: "Every number printed below is replayed from fixtures/agent-harness-rules
  // .json — one real call to jev-1.13.0". Each printed number is checked against that
  // fixture, and the printed verdict against the reducer the example itself declares
  // (examples/02-agents-md-guardrail.ts:41-47, first match wins, otherwise deny).
  it('02 prints numbers that are in the fixture, and a verdict its own rules imply', () => {
    const out = runExample('02-agents-md-guardrail.ts').stdout
    const f = loadFixtures(join(ROOT, 'fixtures')).find(x => x.id === 'commit-only-when-explicitly-asked')!

    expect(out).toContain(`The LLM prompt this replaces: ${f.llm_prompt.length} chars`)
    expect(out).toContain(`Latency: ${f.measured.latency_ms} ms`)

    const noul = (id: string) => {
      const a = f.measured.answers[id]
      if (a.type !== 'noul') throw new Error(`${id} is not a noul in the fixture`)
      return a.noul
    }
    const ids = ['is_commit_operation', 'user_explicitly_asked_to_commit', 'commit_required_by_requested_task']
    const printed: Record<string, number> = {}
    for (const id of ids) {
      const m = out.match(new RegExp(`^\\s{2}${id}\\s+(\\S+)$`, 'm'))
      expect(m, `${id} is not printed`).not.toBeNull()
      printed[id] = Number(m![1])
      expect(printed[id], `${id} printed a number no fixture measured`).toBe(noul(id))
    }

    // The example's reducer, transcribed: first match wins, otherwise deny.
    const expected =
      printed.is_commit_operation <= 0.5 ? 'allow'
        : printed.user_explicitly_asked_to_commit >= 0.5 ? 'allow'
          : printed.commit_required_by_requested_task >= 0.5 ? 'allow'
            : 'deny'
    expect(out).toContain(`VERDICT, computed in code: ${expected}`)
    expect(expected, 'the fixture that makes this example a guardrail demo stopped denying').toBe('deny')

    // "Measured 0.06, not laundered into consent" — the caption's punchline is a number.
    expect(out).toContain(`Measured ${noul('user_explicitly_asked_to_commit')}, not laundered into consent.`)

    const collapsed = f.measured.answers.decision
    if (collapsed.type !== 'choice') throw new Error('fixture shape changed')
    expect(out).toContain(`${collapsed.choice} at confidence ${collapsed.confidence}`)
  })

  // 03's caption: "the collapsed 'which tier?' question picked the CHEAP tier at confidence
  // 0.24 ... while the evidence questions in the same call routed it up correctly."
  it('03 shows the collapsed head picking the cheap tier while the reducer routes up', () => {
    const out = runExample('03-model-router.ts').stdout
    const corpus = loadFixtures(join(ROOT, 'fixtures'))
    const f = corpus.find(x => x.id === 'tier-router-ambiguous-scope-error-handling')!
    const tier = f.measured.answers.tier
    if (tier.type !== 'choice') throw new Error('fixture shape changed')

    const section = out.slice(out.indexOf(`=== ${f.id}`))
    expect(section, 'the caption is about this fixture').toContain(f.id)
    expect(section).toContain(`the collapsed "which tier?" head, same call: ${tier.choice} at confidence ${tier.confidence}`)
    expect(tier.choice, 'the caption says the collapsed head picked the CHEAP tier').toBe('fast')

    const routed = section.match(/routed in code:\s+(\S+)/)
    expect(routed).not.toBeNull()
    expect(routed![1], 'the whole point is that the reducer routed UP from the collapsed head')
      .not.toBe(tier.choice)
    expect(['balanced', 'powerful']).toContain(routed![1])

    expect(section).toContain(`latency: ${f.measured.latency_ms} ms`)
    expect(out, 'the example claims the request it prints is clean').toContain('validation: clean')
  })

  // 04's caption: an incumbent's own config format, "and a refusal when the target cannot
  // express it". examples.test.ts pins the three marker strings; what it does not check is
  // that the YAML the example prints is a policy bouncer could load, with the program's own
  // thresholds in it.
  it('04 prints a bouncer policy that parses and carries the program\'s thresholds', () => {
    const out = runExample('04-policy-emit.ts').stdout
    const start = out.indexOf('version: 1')
    const end = out.indexOf('=== jevc emit-policy --for toolgate')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)

    const policy = parseYaml(out.slice(start, end)) as {
      version: number; mode: string; on_error: string
      gate: { questions: Record<string, unknown>; rules: Array<Record<string, unknown>> }
    }
    expect(policy.version).toBe(1)
    // "Ships in observe mode: it logs and emits nothing" — the emitter's own header.
    expect(policy.mode).toBe('observe')
    expect(Object.keys(policy.gate.questions)).toEqual(['deletes_tracked_files', 'outside_repo'])
    expect(policy.gate.rules).toEqual([
      { when: { deletes_tracked_files: { p: '>=0.8' } }, then: 'deny' },
      { when: { outside_repo: { p: '>=0.6' } }, then: 'ask' },
      { default: 'allow' },
    ])
  })
})
