import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
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
