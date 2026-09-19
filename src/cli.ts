#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fromJsonSchema } from './from-schema.js'
import { buildLiftRequest } from './from-prompt.js'
import { emitNative } from './emit/native.js'
import { emitJson } from './emit/json.js'
import { emitAiSdk } from './emit/ai-sdk.js'
import { emitLangchain } from './emit/langchain.js'
import { lintProgram, validateProgram, type Program } from './ir.js'
import { assertExpectation, checkLive, loadFixtures } from './check.js'
import { validateRequest } from './contract.js'

const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (name: string): string | undefined => {
  // Single-char flags are documented in short form (-o); accept the long form too.
  const forms = name.length === 1 ? [`--${name}`, `-${name}`] : [`--${name}`]
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (forms.includes(a)) return argv[i + 1]
    // `--name=value` is the other half of GNU flag syntax. Matching only the
    // space-separated form left `--emit=json` looking like an unknown argument, so the
    // value was ignored and the DEFAULT emitter ran: the wrong artifact at exit 0.
    const form = forms.find(f => a.startsWith(`${f}=`))
    if (form) return a.slice(form.length + 1)
  }
  return undefined
}
const has = (name: string) => argv.includes(`--${name}`)

/** Flags that consume the argument after them. Everything else is a bare switch. */
const VALUED = new Set(['emit', 'o', 'for', 'fixtures'])

/**
 * The first argument after the subcommand that is neither a flag nor a flag's value.
 * emit-policy used to find its program by scanning for the first argument ending in
 * `.json`, which is the `-o` destination whenever the output is named that way: jevc then
 * read the file it was about to write (ENOENT, or worse, a stale policy) instead of the
 * program it was handed. It also refused a program file not named *.json at all.
 */
const positional = (): string | undefined => {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('-') && a !== '-') {
      if (!a.includes('=') && VALUED.has(a.replace(/^--?/, ''))) i++
      continue
    }
    return a
  }
  return undefined
}

const die = (msg: string): never => { process.stderr.write(`${msg}\n`); process.exit(1) }

// EntryType is `string | object | array | null`, so String() on it silently renders
// "[object Object]" rather than throwing. Every render site needs this.
const renderEntry = (v: unknown): string => typeof v === 'string' ? v : JSON.stringify(v)

// Compile time has no real state — emitJson substitutes a '<state>' placeholder — so the
// two state-shape-dependent checks cannot be meaningful yet and would false-reject valid
// schemas. evaluate() runs the full validator against the real state at runtime.
// NOT filtering token_budget_exceeded: a tiny placeholder under-reports tokens, which errs
// toward accepting rather than rejecting — the right direction here.
const STATE_DEPENDENT = ['path_unresolved', 'state_empty']

// Ordinary I/O failures are user errors (wrong path, unreadable file), not jevc bugs —
// they get a message naming the path, never a node:fs stack trace.
const read = (p: string) => {
  try { return p === '-' ? readFileSync(0, 'utf8') : readFileSync(p, 'utf8') }
  catch (e) { return die(`Cannot read ${p === '-' ? 'stdin' : p}: ${(e as Error).message}`) }
}
// The write side is user error for exactly the same reasons as the read side: a
// destination directory that does not exist, a read-only path. It threw a raw ENOENT with
// a node:fs stack trace before.
const write = (p: string, text: string): void => {
  try { writeFileSync(p, text) }
  catch (e) { die(`Cannot write ${p}: ${(e as Error).message}`) }
  process.stderr.write(`wrote ${p}\n`)
}
const fixtures = (dir: string) => {
  try { return loadFixtures(dir) }
  catch (e) { return die(`Cannot load fixtures from ${dir}: ${(e as Error).message}`) }
}

if (cmd === 'compile') {
  const path = positional() ?? die('usage: jevc compile <file|-> [--lift] [--emit sdk|json|ai-sdk|langchain] [-o out]')
  const text = read(path)

  if (has('lift')) {
    process.stdout.write(buildLiftRequest(text, path === '-' ? 'stdin' : basename(path)))
    process.exit(0)
  }

  let program: Program | undefined
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

  // ai-sdk and langchain existed as emitters with no way to reach them: the only route to
  // either was to import jevc as a library.
  const emit = flag('emit') ?? 'sdk'
  if (!['sdk', 'json', 'ai-sdk', 'langchain'].includes(emit)) {
    die(`Unknown --emit value "${emit}". Expected sdk, json, ai-sdk or langchain.`)
  }

  let out: string
  if (emit === 'ai-sdk') out = emitAiSdk(program!)
  else if (emit === 'langchain') out = emitLangchain(program!)
  else if (emit === 'json') {
    // Amendment: the API is the only thing that used to enforce this (e.g. the 255-option
    // choice ceiling, question-id uniqueness) — run the wire validator locally so a request
    // that would 422 is caught here instead.
    const req = emitJson(program!, '<state>')
    const reqIssues = validateRequest(req).filter(i => !STATE_DEPENDENT.includes(i.code))
    for (const i of reqIssues) process.stderr.write(`${i.severity}: ${i.path}: ${i.message}\n`)
    if (reqIssues.some(i => i.severity === 'error')) process.exit(1)
    out = JSON.stringify(req, null, 2)
  } else {
    out = emitNative(program!)
  }

  const dest = flag('o')
  if (dest) write(dest, out)
  else process.stdout.write(out)
  process.exit(0)
}

if (cmd === 'check') {
  const corpus = fixtures(flag('fixtures') ?? 'fixtures')

  if (has('live')) {
    // Amendment: --live requires a real API key and must never run as part of `npm test`.
    // Offline `check` (the default, above) needs no key and stays that way.
    if (!process.env.TYPESAFE_API_KEY) {
      die('check --live requires TYPESAFE_API_KEY in the environment.')
    }
    // Network, auth and quota failures are the normal case here, not bugs.
    const report = await checkLive(corpus)
      .catch(e => die(`check --live failed: ${(e as Error).message}`))
    for (const row of report.rows) {
      if (row.status === 'stable') continue
      const delta = row.delta === null ? '' : ` delta=${row.delta.toFixed(3)}`
      process.stdout.write(
        `${row.status.toUpperCase()} ${row.id}  recorded=${JSON.stringify(row.recorded)} live=${JSON.stringify(row.live)}${delta}\n`,
      )
    }
    process.stdout.write(
      `${report.rows.length} rows checked live against ${report.model}: ${report.drifted} drifted, ${report.broken} broken\n`,
    )
    process.exit(report.broken > 0 ? 1 : 0)
  }

  let failed = 0
  for (const f of corpus) {
    const fails = assertExpectation(f.expect, f.measured.answers)
    if (fails.length) { failed++; process.stdout.write(`FAIL ${f.id}\n  ${fails.join('\n  ')}\n`) }
  }
  process.stdout.write(`${corpus.length} fixtures, ${corpus.length - failed} passing, ${failed} failing\n`)
  process.exit(failed ? 1 : 0)
}

if (cmd === 'explain') {
  // The provenance payoff: answer "why does this question exist?"
  const id = positional() ?? die('usage: jevc explain <decision-id>')
  const hits = fixtures(flag('fixtures') ?? 'fixtures')
    .flatMap(f => Object.keys(f.questions).includes(id) ? [f] : [])
  if (!hits.length) die(`No decision "${id}" found.`)
  for (const f of hits) {
    const q = f.questions[id]
    process.stdout.write(`${id}  (${f.domain}/${f.id})\n`)
    process.stdout.write(`  type:         ${q.type}\n`)
    process.stdout.write(`  instructions: ${renderEntry(q.instructions)}\n`)
    process.stdout.write(`  provenance:   ${f.provenance}\n`)
    process.stdout.write(`  measured:     ${JSON.stringify(f.measured.answers[id])}\n`)
    process.stdout.write(`  replaces:     ${f.llm_prompt.slice(0, 120)}...\n\n`)
  }
  process.exit(0)
}

if (cmd === 'emit-policy') {
  // jev-guard is deliberately absent: its questions are `export const` literals in
  // src/guard.js and decide() destructures four fixed ids, so there is nothing to emit into.
  const target = flag('for') ?? die('usage: jevc emit-policy --for <bouncer|toolgate> <program.json> [-o out]')
  const path = positional() ?? die('supply a compiled program JSON file')
  let program: Program
  try {
    program = JSON.parse(read(path))
  } catch (e) {
    die(`${path} is not valid JSON: ${(e as Error).message}`)
  }

  // The same gate `compile` runs. Without it a rule naming a decision that does not
  // exist emitted `when: {ghost: {p: ">=0.8"}}` at exit 0 — valid YAML, a rule that can
  // never match, and (for bouncer) a policy whose only failure mode is a silent gate.
  // canEmit checks what the TARGET can express; validateProgram checks that the Program
  // is coherent at all, and neither substitutes for the other.
  const issues = [...validateProgram(program!), ...lintProgram(program!)]
  for (const i of issues) process.stderr.write(`${i.severity}: ${i.path}: ${i.message}\n`)
  if (issues.some(i => i.severity === 'error')) process.exit(1)

  const { emitBouncerPolicy } = await import('./emit/policy/bouncer.js')
  const { emitToolgatePolicy } = await import('./emit/policy/toolgate.js')
  let out: string
  try {
    if (target === 'bouncer') out = emitBouncerPolicy(program!)
    else if (target === 'toolgate') out = emitToolgatePolicy(program!)
    else die(`Unknown policy target "${target}". Known: bouncer, toolgate. (jev-guard hardcodes its questions in source and cannot be targeted.)`)
  } catch (e) {
    // A refusal is the designed outcome for a program a target cannot express; it is a
    // message for the user, not a jevc crash.
    die((e as Error).message)
  }

  const dest = flag('o')
  if (dest) write(dest, out!)
  else process.stdout.write(out!)
  process.exit(0)
}

die('usage: jevc <compile|check|explain|emit-policy> ...')
