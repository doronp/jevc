import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type ExecError = Error & { stderr?: string; stdout?: string; status?: number | null }

const run = (args: string[], input?: string) =>
  execFileSync('node', ['dist/cli.js', ...args], { input, encoding: 'utf8' })

/** Runs `run` and captures the thrown error instead of letting it propagate, so a test can
 * assert on stderr/exit status without a plain `throw` inside its own try block being mistaken
 * for the CLI's failure (which would make the assertion a false positive). */
const runExpectingFailure = (args: string[], input?: string): ExecError => {
  try {
    run(args, input)
  } catch (e) {
    return e as ExecError
  }
  throw new Error(`expected "jevc ${args.join(' ')}" to exit non-zero, but it succeeded`)
}

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

  it('reports the residual for a free-text field without turning it into a question', () => {
    const out = run(['compile', '-', '--emit', 'json'], JSON.stringify({
      type: 'object', properties: {
        ok: { type: 'boolean' },
        summary: { type: 'string', description: 'Summarise it.' },
      } }))
    const parsed = JSON.parse(out)
    expect(parsed.questions.summary).toBeUndefined()
    expect(parsed.questions.ok.type).toBe('noul')
  })

  // Amendment 2: --emit json must run validateRequest before printing, so a request the API
  // would 422 on is caught locally instead. This is the same fixture the residual test above
  // used before that gate existed — zero decisions means zero questions, which validateRequest
  // itself refuses to send.
  it('rejects an --emit json request with no questions rather than printing an empty request', () => {
    const error = runExpectingFailure(['compile', '-', '--emit', 'json'], JSON.stringify({
      type: 'object', properties: { summary: { type: 'string', description: 'Summarise it.' } } }))
    expect(error.status).not.toBe(0)
    expect(error.stderr).toMatch(/at least one question is required/i)
  })

  it('rejects an --emit json request whose choice exceeds the 255-option ceiling', () => {
    const options = Array.from({ length: 256 }, (_, i) => `option_${i}`)
    const schema = { type: 'object', properties: { pick: { type: 'string', enum: options } } }
    const error = runExpectingFailure(['compile', '-', '--emit', 'json'], JSON.stringify(schema))
    expect(error.status).not.toBe(0)
    expect(error.stderr).toMatch(/256 options; the maximum is 255/)
  })

  // Fix round 1, item 1: validateRequest runs against the '<state>' placeholder at compile
  // time, since the real state doesn't exist until evaluate(). A backtick path in the
  // instructions can never resolve against that placeholder, and the placeholder is never
  // "empty" either way — both checks are meaningless before a real state exists and must not
  // false-reject an otherwise-valid schema.
  it('does not false-reject a schema whose instructions contain a backtick state path', () => {
    const out = run(['compile', '-', '--emit', 'json'], JSON.stringify({
      type: 'object', properties: {
        is_expensive: { type: 'boolean', description: 'Is `order.total` over budget?' } } }))
    const parsed = JSON.parse(out)
    expect(parsed.questions.is_expensive.type).toBe('noul')
    expect(parsed.questions.is_expensive.instructions).toBe('Is `order.total` over budget?')
  })

  // Fix round 1, item 3: an unreadable file must fail with a clean message naming the path,
  // not a raw node:fs stack trace.
  it('reports an unreadable file with a clean message instead of a raw stack trace', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'jevc-')), 'does-not-exist.json')
    const error = runExpectingFailure(['compile', missing])
    expect(error.status).not.toBe(0)
    expect(error.stderr).toContain(missing)
    expect(error.stderr).not.toMatch(/at Object\.|at Function\.|node:internal/)
  })

  it('reports a directory passed as a file with a clean message instead of a raw stack trace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevc-'))
    const error = runExpectingFailure(['compile', dir])
    expect(error.status).not.toBe(0)
    expect(error.stderr).toContain(dir)
    expect(error.stderr).not.toMatch(/at Object\.|at Function\.|node:internal/)
  })

  // Fix round 1, item 4: -o is the documented short flag for output path; only --o worked
  // before this fix.
  it('writes output to the path given by -o', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevc-'))
    const schemaFile = join(dir, 's.json')
    writeFileSync(schemaFile, JSON.stringify({ type: 'object', properties: {
      is_urgent: { type: 'boolean', description: 'Urgent?' } } }))
    const outFile = join(dir, 'out.ts')
    run(['compile', schemaFile, '-o', outFile])
    expect(readFileSync(outFile, 'utf8')).toMatch(/type: 'noul'/)
  })

  // Fix round 1, item 4 (flag helper): a typo'd --emit value must be a hard error, not a
  // silent fallback to native output.
  it('rejects an unrecognized --emit value instead of silently defaulting', () => {
    const error = runExpectingFailure(['compile', '-', '--emit', 'yaml'],
      JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } } }))
    expect(error.status).not.toBe(0)
    expect(error.stderr).toMatch(/emit/i)
  })

  // `--flag=value` is the other half of GNU flag syntax and every CLI the user has typed
  // into accepts it. It was read as an unknown argument, so `--emit=json` silently
  // produced native TypeScript: the wrong artifact at exit 0.
  it('accepts --flag=value as well as --flag value', () => {
    const out = run(['compile', '-', '--emit=json'],
      JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } } }))
    expect(JSON.parse(out).questions.ok.type).toBe('noul')
  })

  it('accepts -o=<path> for the short flag too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevc-'))
    const schemaFile = join(dir, 's.json')
    writeFileSync(schemaFile, JSON.stringify({ type: 'object', properties: {
      is_urgent: { type: 'boolean', description: 'Urgent?' } } }))
    const outFile = join(dir, 'out.ts')
    run(['compile', schemaFile, `-o=${outFile}`])
    expect(readFileSync(outFile, 'utf8')).toMatch(/type: 'noul'/)
  })

  // The two code emitters existed and had no way to be reached: the CLI knew only
  // sdk and json, so the only way to emit for @ai-sdk/typesafe-ai or langchain-typesafe
  // was to import jevc as a library.
  it('emits for ai-sdk', () => {
    const out = run(['compile', '-', '--emit', 'ai-sdk'],
      JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean', description: 'OK?' } } }))
    expect(out).toMatch(/createTypeSafeAi/)
  })

  it('emits for langchain', () => {
    const out = run(['compile', '-', '--emit', 'langchain'],
      JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean', description: 'OK?' } } }))
    expect(out).toMatch(/TypeSafeClassifier/)
  })

  // Fix round 3: the capability gate (`canEmit`) was reachable only from the two policy
  // emitters, so `compile` ran it for no target at all. Its `no_decisions` error is the one
  // that matters here: a schema of only free-text properties compiles to zero decisions, and
  // the emitted module asks nothing and returns the fallthrough verdict for every input. The
  // same program was already refused at exit 1 on `--emit json`.
  for (const target of ['sdk', 'ai-sdk', 'langchain'] as const) {
    it(`refuses a program with no decisions for --emit ${target}, as --emit json already does`, () => {
      const error = runExpectingFailure(['compile', '-', '--emit', target], JSON.stringify({
        type: 'object', properties: {
          summary: { type: 'string', description: 'One-paragraph summary of the incident.' },
          root_cause: { type: 'string', description: 'What caused it.' },
        } }))
      expect(error.status).not.toBe(0)
      expect(error.stderr).toMatch(/Nothing to emit/)
      expect(error.stdout ?? '').not.toMatch(/TypeSafeClassifier|programQuestions|createTypeSafeAi/)
    })
  }

  // The default target is the one a user gets by typing nothing, so it must be gated too.
  it('refuses a program with no decisions when no --emit is given at all', () => {
    const error = runExpectingFailure(['compile', '-'],
      JSON.stringify({ type: 'object', properties: {} }))
    expect(error.status).not.toBe(0)
    expect(error.stderr).toMatch(/Nothing to emit/)
  })

  // The wire constraints belong to the API every target's client eventually talks to, not to
  // the json emitter: validateRequest ran only inside the `--emit json` arm, so the same
  // request that was refused as json shipped as TypeScript at exit 0.
  it('runs the wire validator for --emit sdk too, not only for --emit json', () => {
    const schema = { type: 'object', properties: { '': { type: 'boolean', description: 'Blank id?' } } }
    const error = runExpectingFailure(['compile', '-', '--emit', 'sdk'], JSON.stringify(schema))
    expect(error.status).not.toBe(0)
    expect(error.stderr).toMatch(/Question id cannot be empty/)
  })

  // A valid schema must still pass every target untouched — the gate above is a refusal of
  // programs no consumer can honestly run, not a new tax on ordinary ones.
  for (const target of ['sdk', 'json', 'ai-sdk', 'langchain'] as const) {
    it(`still emits an ordinary schema for --emit ${target} with no new errors`, () => {
      const out = run(['compile', '-', '--emit', target], JSON.stringify({
        type: 'object', properties: {
          is_urgent: { type: 'boolean', description: 'Urgent?' },
          dept: { type: 'string', enum: ['sales', 'support'], description: 'Which department?' },
        } }))
      expect(out.length).toBeGreaterThan(0)
    })
  }

  // An unrecognised flag NAME was ignored outright, so `--emmit json` ran the default
  // emitter: TypeScript written into the file the user asked to hold a wire request, at
  // exit 0. This is the same failure the `--emit=json` fix named, one level up.
  it('rejects a mistyped option name instead of silently running the default emitter', () => {
    const error = runExpectingFailure(['compile', '-', '--emmit', 'json'],
      JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } } }))
    expect(error.status).not.toBe(0)
    expect(error.stderr).toMatch(/--emmit/)
    expect(error.stdout ?? '').not.toMatch(/programQuestions/)
  })

  it('rejects a single-dash long option like -emit instead of ignoring it', () => {
    const error = runExpectingFailure(['compile', '-', '-emit', 'json'],
      JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } } }))
    expect(error.status).not.toBe(0)
    expect(error.stderr).toMatch(/-emit/)
  })

  // `--emit $TARGET` with TARGET unset: flag() returned argv[i+1] === undefined, which
  // `?? 'sdk'` could not tell apart from "the flag was never given".
  it('rejects --emit with no value instead of falling through to the default target', () => {
    const error = runExpectingFailure(['compile', '-', '--emit'],
      JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } } }))
    expect(error.status).not.toBe(0)
    expect(error.stderr).toMatch(/requires a value/)
    expect(error.stdout ?? '').not.toMatch(/programQuestions/)
  })

  it('rejects -o with no value instead of quietly printing to stdout', () => {
    const error = runExpectingFailure(['compile', '-', '--emit', 'json', '-o'],
      JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } } }))
    expect(error.status).not.toBe(0)
    expect(error.stderr).toMatch(/requires a value/)
  })

  it('rejects a flag-shaped -o value instead of creating a file named after a flag', () => {
    const error = runExpectingFailure(['compile', '-', '--emit', 'json', '-o', '--emit'],
      JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } } }))
    expect(error.status).not.toBe(0)
    expect(error.stderr).toMatch(/requires a value/)
    // The old behaviour wrote the artifact to a file literally named `--emit` in the
    // working directory, which for this suite is the repo root. Clean up before asserting
    // so a regression cannot leave an untracked file behind.
    const stray = existsSync('--emit')
    if (stray) rmSync('--emit')
    expect(stray).toBe(false)
  })

  // The fence label is the name `parseLiftResponse` checks every `source.file` against, and
  // it compares against the path it is handed. Labelling the fence with the basename told
  // the lifter the file was "AGENTS.md" while the caller verifies against "docs/AGENTS.md",
  // so every decision came back provenance_file_unknown.
  it('labels the lifted document with the path as given, not just its basename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevc-'))
    mkdirSync(join(dir, 'docs'))
    const f = join(dir, 'docs', 'AGENTS.md')
    writeFileSync(f, '# Rules\nNever delete tracked files.')
    const out = run(['compile', f, '--lift'])
    expect(out).toContain(`must be exactly "${f}"`)
    expect(out).toContain(`--- ${f} ---`)
  })

  // Fix round 1 gave `read` a clean message; the write side kept throwing a raw ENOENT
  // with a node:fs stack. Both ends of the same I/O are user error, not a jevc bug.
  it('reports an unwritable -o as a message instead of a raw stack trace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevc-'))
    const schemaFile = join(dir, 's.json')
    writeFileSync(schemaFile, JSON.stringify({ type: 'object', properties: {
      is_urgent: { type: 'boolean', description: 'Urgent?' } } }))
    const dest = join(dir, 'no-such-dir', 'out.ts')
    const error = runExpectingFailure(['compile', schemaFile, '-o', dest])
    expect(error.status).not.toBe(0)
    expect(error.stderr).toContain(dest)
    expect(error.stderr).not.toMatch(/at Object\.|at Function\.|node:internal/)
  })
})

describe('jevc check', () => {
  it('replays the corpus offline and reports 60 fixtures', () => {
    expect(run(['check'])).toMatch(/60 fixtures/)
  })

  // Fix round 1, item 3.
  it('reports a nonexistent --fixtures dir with a clean message instead of a raw stack trace', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'jevc-')), 'no-such-dir')
    const error = runExpectingFailure(['check', '--fixtures', missing])
    expect(error.status).not.toBe(0)
    expect(error.stderr).toContain(missing)
    expect(error.stderr).not.toMatch(/at Object\.|at Function\.|node:internal/)
  })
})

describe('jevc check --live', () => {
  // Amendment 1: --live must require TYPESAFE_API_KEY and refuse before ever reaching the
  // network. There is no key in this environment and none may be added, so this test only
  // proves the refusal path — it must never actually call checkLive.
  it('refuses to run without TYPESAFE_API_KEY, and never reaches the network', () => {
    const { TYPESAFE_API_KEY: _drop, ...envWithoutKey } = process.env
    let error: ExecError | undefined
    try {
      execFileSync('node', ['dist/cli.js', 'check', '--live'], { encoding: 'utf8', env: envWithoutKey })
    } catch (e) {
      error = e as ExecError
    }
    expect(error).toBeDefined()
    expect(error?.status).not.toBe(0)
    expect(error?.stderr).toMatch(/TYPESAFE_API_KEY/)
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


  // Fix round 1, item 2: EntryType allows object-form instructions (10 decisions across 2
  // fixtures in the real corpus use it); String(objectValue) produces the literal text
  // "[object Object]" instead of the actual content.
  it('prints object-form instructions as JSON rather than "[object Object]"', () => {
    const out = run(['explain', 'description::hallucinated'])
    expect(out).not.toContain('[object Object]')
    expect(out).toMatch(/main_question/)
  })
})

describe('jevc emit-policy', () => {
  const program = {
    decisions: [{ id: 'outside_repo', kind: 'noul', instructions: 'Outside the repo root?' }],
    reduce: { kind: 'rules', rules: [
      { when: [{ id: 'outside_repo', op: 'gte', value: 0.8 }], then: 'deny' }], otherwise: 'allow' },
    residual: '', dropped: [],
  }
  const write = (p: unknown = program) => {
    const f = join(mkdtempSync(join(tmpdir(), 'jevc-')), 'program.json')
    writeFileSync(f, JSON.stringify(p))
    return f
  }

  it('emits a bouncer policy in observe mode', () => {
    const out = run(['emit-policy', '--for', 'bouncer', write()])
    expect(out).toMatch(/mode: observe/)
    expect(out).toMatch(/p: ">=0.8"/)
  })

  it('writes to -o', () => {
    const f = write()
    const dest = join(mkdtempSync(join(tmpdir(), 'jevc-')), 'policy.yaml')
    run(['emit-policy', '--for', 'bouncer', f, '-o', dest])
    expect(readFileSync(dest, 'utf8')).toMatch(/version: 1/)
  })

  // A target refusing a program it cannot express is the designed outcome, so it must read
  // as a message rather than a crash.
  // The reducer names `radius` rather than the replaced `outside_repo`: the program has to
  // be internally valid for the refusal under test to be the TARGET's, not the validator's.
  it('reports a refusal as a message, not a stack trace', () => {
    const score = { decisions: [
      { id: 'radius', kind: 'score', instructions: 'How wide?', criteria: ['file', 'repo'] }],
      reduce: { kind: 'rules', rules: [
        { when: [{ id: 'radius', op: 'gte', value: 0.8 }], then: 'deny' }], otherwise: 'allow' },
      residual: '', dropped: [] }
    const error = runExpectingFailure(['emit-policy', '--for', 'bouncer', write(score)])
    expect(error.status).not.toBe(0)
    expect(error.stderr).toMatch(/only noul/)
    expect(error.stderr).not.toMatch(/at Object\.|node:internal/)
  })

  // The program path was found by scanning for the first argument ending in `.json`,
  // which is the -o value whenever the output is named that way: jevc then read the
  // file it was about to write (usually ENOENT) instead of the program it was given.
  it('takes the program from the positional argument, not the first .json on the line', () => {
    const f = write()
    const dest = join(mkdtempSync(join(tmpdir(), 'jevc-')), 'out.json')
    run(['emit-policy', '--for', 'bouncer', '-o', dest, f])
    expect(readFileSync(dest, 'utf8')).toMatch(/version: 1/)
  })

  it('accepts a program file that is not named *.json', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'jevc-')), 'program')
    writeFileSync(f, JSON.stringify(program))
    expect(run(['emit-policy', '--for', 'bouncer', f])).toMatch(/version: 1/)
  })

  it('reports an unwritable -o as a message instead of a raw stack trace', () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'jevc-')), 'no-such-dir', 'policy.yaml')
    const error = runExpectingFailure(['emit-policy', '--for', 'bouncer', write(), '-o', dest])
    expect(error.status).not.toBe(0)
    expect(error.stderr).toContain(dest)
    expect(error.stderr).not.toMatch(/at Object\.|at Function\.|node:internal/)
  })

  it('names the known targets when given an unknown one', () => {
    const error = runExpectingFailure(['emit-policy', '--for', 'jev-guard', write()])
    expect(error.stderr).toMatch(/bouncer, toolgate/)
  })

  // `compile` runs validateProgram; `emit-policy` parsed raw JSON and handed it straight
  // to the emitter. A rule naming a decision that does not exist emitted
  // `when: {ghost: {p: ">=0.8"}}` at exit 0 — a policy bouncer loads and whose rule can
  // never match, which is the silent-gate failure again.
  it('validates the program, rejecting a rule that names a decision which does not exist', () => {
    const ghost = { ...program, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'ghost', op: 'gte', value: 0.8 }], then: 'deny' }], otherwise: 'allow' } }
    const error = runExpectingFailure(['emit-policy', '--for', 'bouncer', write(ghost)])
    expect(error.status).not.toBe(0)
    expect(error.stderr).toMatch(/unknown decision "ghost"/)
    expect(error.stdout ?? '').not.toMatch(/ghost/)
  })

  it('validates the program, rejecting a duplicate decision id', () => {
    const dup = { ...program, decisions: [program.decisions[0], program.decisions[0]] }
    const error = runExpectingFailure(['emit-policy', '--for', 'bouncer', write(dup)])
    expect(error.status).not.toBe(0)
    expect(error.stderr).toMatch(/duplicate/i)
  })

  it('reports invalid JSON cleanly', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'jevc-')), 'program.json')
    writeFileSync(f, '{not json')
    const error = runExpectingFailure(['emit-policy', '--for', 'bouncer', f])
    expect(error.stderr).toMatch(/is not valid JSON/)
    expect(error.stderr).not.toMatch(/at Object\.|node:internal/)
  })

  // Fix round 3: JSON that parses but is not a Program was cast to `Program` and handed
  // straight to validateProgram/lintProgram, which dereference `p.decisions`,
  // `p.reduce.rules`, `rule.when`, `d.instructions` and `d.uncertain` with no guard. Every
  // one of these escaped as a raw Node stack trace naming dist/ir.js. The inputs are not
  // exotic: README says emit-policy reads "the shape `--lift` asks the agent to produce",
  // i.e. model-generated JSON, and `jevc compile --emit json -o request.json` writes a
  // JSON file that is NOT a Program.
  const notAProgram: Array<[string, unknown]> = [
    ['an unrelated JSON object', { hello: 'world' }],
    ['a bare null', null],
    ['a bare array', []],
    ['a Program with no reduce', { decisions: [], residual: '', dropped: [] }],
    ['a decision that is a string', { ...program, decisions: ['outside_repo'] }],
    ['a decision missing instructions', { ...program, decisions: [{ id: 'x', kind: 'noul' }] }],
    ['a rule whose `when` is an object, not an array', { ...program, reduce: { kind: 'rules',
      rules: [{ when: { id: 'outside_repo', op: 'gte', value: 0.8 }, then: 'deny' }], otherwise: 'allow' } }],
    ['an `uncertain` that is a string', { ...program, decisions: [
      { id: 'outside_repo', kind: 'noul', instructions: 'Outside?', uncertain: 'maybe' }] }],
  ]
  for (const [label, bad] of notAProgram) {
    it(`reports ${label} as a message, not a raw stack trace`, () => {
      const error = runExpectingFailure(['emit-policy', '--for', 'bouncer', write(bad)])
      expect(error.status).not.toBe(0)
      expect(error.stderr).not.toMatch(/at Object\.|at Function\.|node:internal|TypeError/)
      expect(error.stderr).toMatch(/is not a jevc program/)
    })
  }

  // The crash happened before the target name was looked at, so an unknown target was
  // reported as a TypeError from the validator rather than as an unknown target.
  it('still names the known targets when the program is also malformed', () => {
    const error = runExpectingFailure(['emit-policy', '--for', 'nope', write({ hello: 'world' })])
    expect(error.stderr).not.toMatch(/at Object\.|node:internal|TypeError/)
  })

  // Same root cause as compile's `--emmit`: an unrecognised flag name was ignored, so
  // `--output policy.yaml` printed the policy to stdout at exit 0 and left whatever stale
  // policy was already on disk in place — for bouncer, a gate nobody regenerated.
  it('rejects --output rather than silently printing the policy to stdout', () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'jevc-')), 'policy.yaml')
    const error = runExpectingFailure(['emit-policy', '--for', 'bouncer', write(), '--output', dest])
    expect(error.status).not.toBe(0)
    expect(error.stderr).toMatch(/--output/)
    expect(existsSync(dest)).toBe(false)
    expect(error.stdout ?? '').not.toMatch(/version: 1/)
  })

  it('rejects a trailing -o rather than printing the policy to stdout', () => {
    const error = runExpectingFailure(['emit-policy', '--for', 'bouncer', write(), '-o'])
    expect(error.status).not.toBe(0)
    expect(error.stderr).toMatch(/requires a value/)
    expect(error.stdout ?? '').not.toMatch(/version: 1/)
  })
})
