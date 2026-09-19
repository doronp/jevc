import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLiftResponse } from '../src/from-prompt.js'
import { emitNative } from '../src/emit/native.js'
import { runReducer } from '../src/runtime.js'
import type { JevAnswer } from '../src/contract.js'
import type { ValidationIssue } from '../src/contract.js'

// ---------------------------------------------------------------------------
// L4. `--lift` had no end-to-end round trip. Every half was tested — cli.test.ts checks
// the fence label, from-prompt.test.ts checks `parseLiftResponse` against hand-written
// JSON — but nothing ran a response BUILT FROM A REAL REQUEST back through the parser,
// so the seam between them was unproven: the CLI labels the fence with the path exactly
// as typed, and `parseLiftResponse` compares every `source.file` against that same
// string. Those two have to agree, and the way they stop agreeing is a `basename()` on
// one side, which turns every decision into `provenance_file_unknown`.
//
// Everything here is offline. The "agent response" is hand-written against the request
// this suite just generated; no model is called.
//
// Note what this round trip is NOT. There is no CLI subcommand that CONSUMES a lift
// response — `jevc compile <file>` runs `fromJsonSchema`, so handing it a lifted Program
// is not the way back in. `parseLiftResponse` is the library entry point the README
// documents for that half, and `emit-policy` is the CLI command that takes a Program
// JSON. That is the real chain, and it is the one exercised below.
// ---------------------------------------------------------------------------

type ExecError = Error & { stderr?: string; stdout?: string; status?: number | null }

const cli = (args: string[]) =>
  execFileSync('node', ['dist/cli.js', ...args], { encoding: 'utf8' })

const cliExpectingFailure = (args: string[]): ExecError => {
  try {
    cli(args)
  } catch (e) {
    return e as ExecError
  }
  throw new Error(`expected "jevc ${args.join(' ')}" to exit non-zero, but it succeeded`)
}

const AGENTS = [
  '# Repository rules',
  '',
  'Never delete tracked source files without an explicit confirmation.',
  'Regenerable build output under dist/ may be removed freely.',
  'Summarise the change for the reviewer in prose.',
  '',
].join('\n')

/** Writes AGENTS.md under a nested directory, so the path as typed is not its basename. */
function lifted() {
  const dir = mkdtempSync(join(tmpdir(), 'jevc-lift-'))
  const path = join(dir, 'AGENTS.md')
  writeFileSync(path, AGENTS)
  const request = cli(['compile', path, '--lift'])
  return { dir, path, request }
}

/**
 * The path the REQUEST itself tells the agent to cite, read back out of the request text
 * rather than assumed. Reading it here is what makes this a round trip: if the CLI ever
 * labels the fence with something other than the string `parseLiftResponse` compares
 * against, the response built from this value stops validating.
 */
const declaredPath = (request: string): string => {
  const m = request.match(/`file` must be exactly "([^"]*)"/)
  expect(m, 'the lift request no longer states the file to cite').not.toBeNull()
  return m![1]
}

const fenceLabel = (request: string): string => {
  const m = request.match(/^(-{3,}) (.*) \1$/m)
  expect(m, 'the lift request no longer has an opening fence').not.toBeNull()
  return m![2]
}

const QUOTE_DELETES = 'Never delete tracked source files without an explicit confirmation.'
const QUOTE_BUILD = 'Regenerable build output under dist/ may be removed freely.'

/** A plausible agent answer to the request above: two evidence questions, the verdict in
 *  `reduce`, provenance on both, the prose sentence left as residual. */
const response = (file: string) => ({
  decisions: [
    { id: 'deletes_tracked_source', kind: 'noul',
      instructions: 'Does the command delete tracked source files?',
      source: { file, line: 3, quote: QUOTE_DELETES } },
    { id: 'targets_build_output', kind: 'noul',
      instructions: 'Is the target regenerable build output under dist/?',
      source: { file, line: 4, quote: QUOTE_BUILD } },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'deletes_tracked_source', op: 'gte', value: 0.7 }], then: 'deny' },
    { when: [{ id: 'targets_build_output', op: 'gte', value: 0.8 }], then: 'allow' },
  ], otherwise: 'ask' },
  residual: 'Summarise the change for the reviewer in prose.',
  dropped: [],
})

const noul = (v: number): JevAnswer => ({ type: 'noul', noul: v })
const errors = (issues: ValidationIssue[]) => issues.filter(i => i.severity === 'error')
const codes = (issues: ValidationIssue[]) => [...new Set(issues.map(i => i.code))].sort()

describe('--lift round trip', () => {
  it('labels the fence with the same string parseLiftResponse verifies against', () => {
    const { path, request } = lifted()
    // Both halves of the seam, read out of the one artifact that carries them.
    expect(declaredPath(request)).toBe(path)
    expect(fenceLabel(request)).toBe(path)
  })

  it('round-trips a document read from stdin, whose "path" is the word stdin', () => {
    // `-` has no path to label the fence with, so the CLI writes `stdin` — and a caller
    // verifying a stdin lift has to hand `parseLiftResponse` that same word. It is the
    // one label that is not a filename, so it is the one most likely to drift.
    const request = execFileSync('node', ['dist/cli.js', 'compile', '-', '--lift'],
      { input: AGENTS, encoding: 'utf8' })
    expect(declaredPath(request)).toBe('stdin')
    expect(fenceLabel(request)).toBe('stdin')
    expect(parseLiftResponse(JSON.stringify(response('stdin')), AGENTS, 'stdin').issues).toEqual([])
  })

  it('accepts a response built against the request, with no issues at all', () => {
    const { request } = lifted()
    const file = declaredPath(request)
    const { program, issues } = parseLiftResponse(JSON.stringify(response(file)), AGENTS, file)

    expect(issues).toEqual([])
    // The Program is the one the response described, not a partial or an empty stand-in.
    expect(program.decisions.map(d => d.id)).toEqual(['deletes_tracked_source', 'targets_build_output'])
    expect(program.decisions.map(d => d.kind)).toEqual(['noul', 'noul'])
    expect(program.decisions.map(d => d.source?.file)).toEqual([file, file])
    expect(program.decisions.map(d => d.source?.line)).toEqual([3, 4])
    expect(program.reduce.rules).toHaveLength(2)
    expect(program.reduce.otherwise).toBe('ask')
    expect(program.residual).toBe('Summarise the change for the reviewer in prose.')
  })

  it('the round-tripped Program decides the way the response described', () => {
    const { request } = lifted()
    const file = declaredPath(request)
    const { program } = parseLiftResponse(JSON.stringify(response(file)), AGENTS, file)
    // Verdicts, not shape: the rule order is deny-then-allow with an `ask` fallthrough.
    const verdict = (a: Record<string, JevAnswer>) => runReducer(program, a)
    expect(verdict({ deletes_tracked_source: noul(0.91), targets_build_output: noul(0.02) })).toBe('deny')
    expect(verdict({ deletes_tracked_source: noul(0.02), targets_build_output: noul(0.95) })).toBe('allow')
    expect(verdict({ deletes_tracked_source: noul(0.30), targets_build_output: noul(0.30) })).toBe('ask')
    // deny wins over allow when both fire, because it is written first.
    expect(verdict({ deletes_tracked_source: noul(0.91), targets_build_output: noul(0.95) })).toBe('deny')
  })

  it('reaches a real artifact: the lifted Program emits a policy at exit 0', () => {
    const { dir, request } = lifted()
    const file = declaredPath(request)
    const { program, issues } = parseLiftResponse(JSON.stringify(response(file)), AGENTS, file)
    expect(errors(issues)).toEqual([])

    const programJson = join(dir, 'program.json')
    writeFileSync(programJson, JSON.stringify(program, null, 2))
    const policy = cli(['emit-policy', '--for', 'bouncer', programJson])
    expect(policy).toContain('deletes_tracked_source:')
    expect(policy).toContain('p: ">=0.7"')
    expect(policy).toContain('then: deny')
    // Provenance survives the whole chain: the reviewer is sent to the path they typed
    // and the line the quote is on.
    expect(policy).toContain(`# deletes_tracked_source: ${file}:3 — ${QUOTE_DELETES}`)

    // And into the TypeScript target, whose provenance comment is the same claim.
    expect(emitNative(program)).toContain(`  // from ${file}:3 — "${QUOTE_DELETES}"`)
  })
})

// Each of these is a way a real model breaks the response. Every one must be a reported
// error, never a Program that looks usable. `parseLiftResponse` reports rather than
// exits — it is a library function — so the contract tested here is "at least one
// error-severity issue", which is the condition cli.ts turns into exit 1 at every
// boundary it owns (cli.ts:237, cli.ts:295, cli.ts:390).
describe('--lift round trip, broken the ways a model breaks it', () => {
  const broken = (mutate: (file: string) => string) => {
    const { request } = lifted()
    const file = declaredPath(request)
    return { file, ...parseLiftResponse(mutate(file), AGENTS, file) }
  }

  it('a fence labelled with a basename where the request asked for a path', () => {
    const { program, issues } = broken(file =>
      JSON.stringify(response(file)).replaceAll(JSON.stringify(file), JSON.stringify('AGENTS.md')))
    expect(codes(errors(issues))).toEqual(['provenance_file_unknown'])
    // Both decisions, not just the first: a partial trace is not a trace.
    expect(errors(issues)).toHaveLength(program.decisions.length)
    expect(issues[0].message).toContain('which was not supplied')
  })

  it('a fence label whose whitespace differs inside the path', () => {
    const { issues } = broken(file => JSON.stringify(response(file))
      .replaceAll(JSON.stringify(file), JSON.stringify(file.replace('/AGENTS.md', '/ AGENTS.md'))))
    expect(codes(errors(issues))).toEqual(['provenance_file_unknown'])
  })

  it('a truncated response', () => {
    const { program, issues } = broken(file => JSON.stringify(response(file)).slice(0, 220))
    expect(codes(errors(issues))).toEqual(['lift_unparseable'])
    expect(program.decisions).toEqual([])
  })

  it('a fence with no JSON in it', () => {
    for (const body of ['```json\n\n```', '```json\nHere is the program you asked for.\n```']) {
      const { program, issues } = broken(() => body)
      expect(codes(errors(issues)), body).toEqual(['lift_unparseable'])
      expect(program.decisions).toEqual([])
    }
  })

  it('valid JSON of the wrong shape', () => {
    for (const body of [
      JSON.stringify({ questions: {}, verdict: 'allow' }),   // the wire request's shape
      JSON.stringify([{ id: 'deletes_tracked_source' }]),    // a bare array of decisions
      JSON.stringify(null),
      '"a program"',
    ]) {
      const { program, issues } = broken(() => body)
      expect(codes(errors(issues)), body).toEqual(['lift_malformed'])
      expect(program.decisions, body).toEqual([])
    }
  })

  it('two fences, because the model explained itself twice', () => {
    const { program, issues } = broken(file => {
      const one = JSON.stringify(response(file))
      return '```json\n' + one + '\n```\n\n```json\n' + one + '\n```'
    })
    // The fence stripper takes the first opener and the last closer, so two blocks are
    // two JSON documents in one string — unparseable, which is the right answer. Picking
    // one of them would be guessing which program the model meant.
    expect(codes(errors(issues))).toEqual(['lift_unparseable'])
    expect(program.decisions).toEqual([])
  })

  it('a quote that does not appear in the source document', () => {
    const { issues } = broken(file => JSON.stringify(response(file))
      .replace(QUOTE_DELETES, 'Always force-push to the main branch immediately.'))
    expect(codes(errors(issues))).toEqual(['provenance_not_found'])
    expect(issues[0].path).toBe('decisions.deletes_tracked_source')
  })

  it('every one of them is an error, so the caller\'s gate fires', () => {
    // The gate cli.ts writes at every boundary it owns. Stated once, over every break
    // above, so a future issue downgraded from `error` to `warn` is caught here even if
    // its own test still finds the code.
    const breaks: Array<(file: string) => string> = [
      f => JSON.stringify(response(f)).replaceAll(JSON.stringify(f), JSON.stringify('AGENTS.md')),
      f => JSON.stringify(response(f)).slice(0, 220),
      () => '```json\n\n```',
      () => JSON.stringify({ questions: {} }),
      () => '```json\n' + JSON.stringify(response('x')) + '\n```\n```json\n{}\n```',
      f => JSON.stringify(response(f)).replace(QUOTE_DELETES, 'Always force-push immediately.'),
    ]
    for (const b of breaks) {
      const { issues } = broken(b)
      expect(issues.some(i => i.severity === 'error'), b.toString()).toBe(true)
    }
  })

  it('the empty Program a parse failure returns cannot become an artifact', () => {
    // `parseLiftResponse` returns a stand-in Program alongside the issues. A caller that
    // ignored the issues and pressed on still cannot ship: both CLI commands that take a
    // Program refuse it, at exit 1, naming why.
    const { dir } = lifted()
    const { program } = parseLiftResponse('not json at all', AGENTS, 'AGENTS.md')
    const emptyJson = join(dir, 'empty.json')
    writeFileSync(emptyJson, JSON.stringify(program))

    for (const args of [['emit-policy', '--for', 'bouncer', emptyJson], ['compile', emptyJson]]) {
      const error = cliExpectingFailure(args)
      expect(error.status, args.join(' ')).toBe(1)
      expect(error.stderr, args.join(' ')).toMatch(/no decisions/)
      expect(error.stderr, args.join(' ')).not.toMatch(/at Object\.|at Function\.|node:internal/)
    }
  })
})

// The two tolerances are deliberate, and pinning them stops someone "fixing" a
// non-defect into a rejection of every well-formed response.
describe('--lift round trip, what the file check deliberately forgives', () => {
  it('a leading ./ and surrounding whitespace are the same path', () => {
    const { request } = lifted()
    const file = declaredPath(request)
    for (const cited of [`./${file}`, ` ${file}`, `${file}\n`]) {
      const json = JSON.stringify(response(file)).replaceAll(
        JSON.stringify(file), JSON.stringify(cited))
      expect(parseLiftResponse(json, AGENTS, file).issues, cited).toEqual([])
    }
  })

  it('a re-wrapped quote still matches, and its line is still checked', () => {
    const { request } = lifted()
    const file = declaredPath(request)
    const rewrapped = QUOTE_DELETES.replace(' without', '\n   without')
    const cite = (line: number) => {
      const r = response(file)
      r.decisions[0].source = { file, line, quote: rewrapped }
      return JSON.stringify(r)
    }
    expect(parseLiftResponse(cite(3), AGENTS, file).issues).toEqual([])
    const off = parseLiftResponse(cite(4), AGENTS, file).issues
    expect(codes(off)).toEqual(['provenance_line_mismatch'])
    // A mis-citation of a rule that IS there is repairable and names the right line, so
    // it warns; it must not become an error and it must not be silent.
    expect(off[0].severity).toBe('warn')
    expect(off[0].message).toContain('line 3')
  })
})
