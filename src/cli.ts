#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { fromJsonSchema, type JsonSchema, type SchemaProgram } from './from-schema.js'
import { buildLiftRequest } from './from-prompt.js'
import { emitNative } from './emit/native.js'
import { emitJson } from './emit/json.js'
import { emitAiSdk } from './emit/ai-sdk.js'
import { emitLangchain } from './emit/langchain.js'
import { canEmit } from './emit/capability.js'
import { lintProgram, validateProgram, type Program } from './ir.js'
import { assertExpectation, checkLive, loadFixtures } from './check.js'
import { validateRequest, type ValidationIssue } from './contract.js'

const argv = process.argv.slice(2)
const cmd = argv[0]

/**
 * Every byte jevc prints goes through `toStdout`/`toStderr`, and they write the file
 * descriptor SYNCHRONOUSLY instead of going through `process.stdout`/`process.stderr`.
 *
 * A `process.stdout` write is synchronous only when stdout is a file or a TTY. To a PIPE
 * it is asynchronous, and the `process.exit()` that followed every write in this file
 * discarded whatever had not drained. Measured on this tree:
 *
 *   jevc emit-policy --for bouncer big-program.json > file   ->  185,550 bytes
 *   jevc emit-policy --for bouncer big-program.json | cat    ->   65,536 bytes, exit 0
 *
 * 65,536 is the pipe buffer, not a property of the program. The short policy is not a
 * crash and not even a parse error — it is YAML that LOADS, with 43 of 701 rules and no
 * terminal `default`, and docs/targets/target-bouncer.md:59 says a policy with no
 * `default` emits nothing when nothing matches. A gate reduced to 6% of itself, silently,
 * at exit 0: the exact "well-formed artifact, different meaning" failure this tool exists
 * to refuse. `--emit sdk` (a 313 KB module cut mid-token), `--emit json` and `--lift` (the
 * terminating fence deleted, so the anti-injection fence no longer closes) all did it too.
 *
 * Fixing it at the write rather than at the exit covers every exit at once, and stderr
 * needs it too. The `process.exit(1)` calls below are mid-command early-outs that cannot
 * be reached by falling through, and they print one `error:` line per issue. Those small
 * writes survive `| cat`, because a reader that drains continuously keeps the pipe buffer
 * empty and every write completes in the try-write — but measured against a reader that
 * is merely busy for a moment (`2>&1 >/dev/null | (sleep 2; cat)`), a 146,180-byte error
 * list arrived as 65,508 bytes and stopped at rule 631 of 1399. Exit 1, so the user knows
 * it failed; they just fix 632 of 1400 problems and the truncation point moves with
 * machine load. A fix that only removed `process.exit(0)` from the four success paths
 * would leave that in place.
 */
const writeFd = (fd: number, text: string): void => {
  try { writeFileSync(fd, text) }
  catch (e) {
    // `jevc ... | head -1`: the reader closed the pipe and there is nobody left to tell.
    // Letting EPIPE escape would print a Node stack trace and crash banner, which is
    // strictly worse than the silence `process.stdout.write` produced here before.
    if ((e as NodeJS.ErrnoException).code !== 'EPIPE') throw e
  }
}
const toStdout = (text: string) => writeFd(1, text)
const toStderr = (text: string) => writeFd(2, text)

const flag = (name: string): string | undefined => {
  // Single-char flags are documented in short form (-o); accept the long form too.
  const forms = name.length === 1 ? [`--${name}`, `-${name}`] : [`--${name}`]
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (forms.includes(a)) {
      // A valued flag with nothing after it returned `undefined`, which `?? 'sdk'` cannot
      // tell apart from "the flag was never given": `jevc compile s.json --emit` — a shell
      // history edit, or `--emit $TARGET` with TARGET unset — ran the DEFAULT emitter at
      // exit 0, and a trailing `-o` printed the artifact to stdout while the file the user
      // named kept its stale contents. That is the same "wrong artifact at exit 0" the
      // `--flag=value` note below describes, and the `=` half of this helper already
      // rejected it (`--emit=` exits 1). `-` stays a legal value: it is the stdin/stdout
      // spelling, not a flag.
      const next = argv[i + 1]
      if (next === undefined || next === '' || (next.startsWith('-') && next !== '-')) {
        die(`${a} requires a value.`)
      }
      return next
    }
    // `--name=value` is the other half of GNU flag syntax. Matching only the
    // space-separated form left `--emit=json` looking like an unknown argument, so the
    // value was ignored and the DEFAULT emitter ran: the wrong artifact at exit 0.
    const form = forms.find(f => a.startsWith(`${f}=`))
    if (form) {
      const v = a.slice(form.length + 1)
      if (v === '') die(`${a} requires a value.`)
      return v
    }
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

const die = (msg: string): never => { toStderr(`${msg}\n`); process.exit(1) }

/**
 * The options each subcommand accepts. Nothing walked argv looking for an option it did not
 * recognise, so an unrecognised one was silently dropped and the command ran with its
 * defaults: `compile --emmit json -o request.json` wrote TypeScript into request.json at
 * exit 0, and `emit-policy --output policy.yaml` printed the policy to stdout and left a
 * stale policy on disk — for bouncer, a gate nobody regenerated. Only the option's VALUE
 * was ever checked, and that check cannot fire once the NAME has already been ignored.
 * check.ts:78 applies the same rule to expectation clauses ("unrecognized clause key ... is
 * a failure rather than silently ignored"); argv was the one surface exempt from it.
 */
const KNOWN_FLAGS: Record<string, ReadonlySet<string>> = {
  compile: new Set(['emit', 'o', 'lift']),
  check: new Set(['fixtures', 'live']),
  explain: new Set(['fixtures']),
  'emit-policy': new Set(['for', 'o']),
  scan: new Set(['json']),
  show: new Set(['fixtures']),
}
const knownFlags = KNOWN_FLAGS[cmd]
if (knownFlags) {
  const seen = new Set<string>()
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('-') || a === '-') continue
    // A single dash is the short form and only ever introduces a one-character name, so
    // `-emit json` is not `--emit json`: `flag('emit')` never matches it and the default
    // emitter ran. Accepting it here would report a token as known that nothing reads.
    const name = a.replace(/^--?/, '').split('=')[0]
    if (!knownFlags.has(name) || (!a.startsWith('--') && name.length !== 1)) {
      const spelled = [...knownFlags].map(n => (n.length === 1 ? `-${n}` : `--${n}`)).join(', ')
      die(`Unknown option "${a}" for jevc ${cmd}. Known: ${spelled}.`)
    }
    // A REPEATED option is the same defect as an unrecognised one, one step further in:
    // the name is known, so nothing above objects, and `flag()` returns on its first
    // match. Measured on this tree, all at exit 0 and all silent:
    //   compile s.json --emit json --emit sdk   -> a wire request, not the module
    //   emit-policy --for bouncer --for toolgate -> a bouncer policy for a toolgate gate
    //   compile s.json -o a.ts -o b.ts          -> a.ts written, b.ts NEVER CREATED
    // The last is the worst: b.ts keeps whatever it held, so the stale artifact stays
    // live while the operator believes they just replaced it. A `$(EXTRA_FLAGS)` appended
    // to a Makefile line that already carries `--emit`, or an edited history line, is all
    // it takes. Refusing is this file's house style for an ambiguous argv (see the
    // unknown-option note above) and the only answer that cannot ship the wrong artifact.
    //
    // The same value twice (`--emit json --emit json`) is refused too. It is not
    // ambiguous about the OUTCOME, but it is the identical typo shape, "which one wins"
    // is a question a reader of the command line should never have to ask, and a rule
    // with an exception for value-equality is a rule nobody can apply by eye. The cost is
    // one clear error on a command line that was already redundant.
    if (seen.has(name)) {
      const spelled = name.length === 1 ? `-${name}` : `--${name}`
      die(`Option "${spelled}" was given more than once for jevc ${cmd}. Pass it exactly once — jevc will not choose between them.`)
    }
    seen.add(name)
    // Skip the value so a value that looks like a flag is not reported as one. `flag()`
    // refuses a flag-shaped value separately, so nothing is let through here.
    if (!a.includes('=') && VALUED.has(name)) i++
  }
}

/**
 * `validateProgram` and `lintProgram` assume a well-typed `Program`. On the `compile` path
 * that holds by construction — `fromJsonSchema` builds one. `emit-policy` is the other
 * path: it JSON.parses a file and casts. README:225 says that file is "the shape `--lift`
 * asks the agent to produce", i.e. model output, and `jevc compile --emit json -o
 * request.json` writes a JSON file that is NOT a Program. Both validators dereference
 * `p.decisions`, `p.reduce.rules`, `rule.when`, `d.instructions`, `d.uncertain` (`in` on a
 * string throws) and `d.dependsOn` with no guard, so a package.json, a schema, a bare
 * `null` or a lifted response with one field wrong escaped as a raw TypeError naming
 * dist/ir.js plus a Node version banner. Like `checkLiftedShape` in from-prompt.ts, this
 * checks only what those functions actually dereference — it is a boundary, not a schema.
 */
const checkProgramShape = (parsed: unknown, at: string): ValidationIssue[] => {
  const out: ValidationIssue[] = []
  const err = (path: string, message: string) =>
    out.push({ code: 'program_malformed', path, severity: 'error', message })
  const nameOf = (v: unknown) =>
    v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v
  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)

  if (!isObject(parsed)) {
    err(at, `A program must be a JSON object, got ${nameOf(parsed)}.`)
    return out
  }

  if (!Array.isArray(parsed.decisions)) {
    err('decisions', `\`decisions\` must be an array, got ${nameOf(parsed.decisions)}.`)
  } else {
    parsed.decisions.forEach((raw, i) => {
      const where = `decisions[${i}]`
      if (!isObject(raw)) {
        err(where, `Decision ${i} must be an object, got ${nameOf(raw)}.`)
        return
      }
      const label = typeof raw.id === 'string' && raw.id !== '' ? `"${raw.id}"` : `at index ${i}`
      if (typeof raw.id !== 'string' || raw.id === '') {
        err(`${where}.id`, `Decision ${label} needs a non-empty string \`id\`.`)
      }
      if (typeof raw.instructions !== 'string') {
        err(`${where}.instructions`, `Decision ${label} needs string \`instructions\`; got ${nameOf(raw.instructions)}.`)
      }
      if (raw.uncertain !== undefined && !isObject(raw.uncertain)) {
        err(`${where}.uncertain`, `Decision ${label} has an \`uncertain\` that is ${nameOf(raw.uncertain)}; it must be {band} or {belowConfidence}.`)
      }
      if (raw.dependsOn !== undefined && !Array.isArray(raw.dependsOn)) {
        err(`${where}.dependsOn`, `Decision ${label} has a \`dependsOn\` that is ${nameOf(raw.dependsOn)}; it must be an array of ids.`)
      }
    })
  }

  if (!isObject(parsed.reduce)) {
    err('reduce', `\`reduce\` must be an object, got ${nameOf(parsed.reduce)}. It is the verdict.`)
  } else if (!Array.isArray(parsed.reduce.rules)) {
    err('reduce.rules', `\`reduce.rules\` must be an array, got ${nameOf(parsed.reduce.rules)}.`)
  } else {
    parsed.reduce.rules.forEach((raw, i) => {
      const where = `reduce.rules[${i}]`
      if (!isObject(raw)) {
        err(where, `Rule ${i} must be an object, got ${nameOf(raw)}.`)
        return
      }
      if (!Array.isArray(raw.when)) {
        err(`${where}.when`, `Rule ${i} needs a \`when\` array of conditions, got ${nameOf(raw.when)}. A single condition is a one-element array.`)
        return
      }
      raw.when.forEach((c, ci) => {
        if (!isObject(c)) err(`${where}.when[${ci}]`, `Condition ${ci} of rule ${i} must be an object, got ${nameOf(c)}.`)
      })
    })
  }

  return out
}

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
  toStderr(`wrote ${p}\n`)
}
const fixtures = (dir: string) => {
  try { return loadFixtures(dir) }
  catch (e) { return die(`Cannot load fixtures from ${dir}: ${(e as Error).message}`) }
}

if (cmd === 'compile') {
  const path = positional() ?? die('usage: jevc compile <file|-> [--lift] [--emit sdk|json|ai-sdk|langchain] [-o out]')
  const text = read(path)

  if (has('lift')) {
    const where = path === '-' ? 'stdin' : path

    // `--emit` is one of compile's known flags, so the unknown-option gate above waves it
    // through, and this branch then returned before anything read it: `jevc compile
    // AGENTS.md --lift --emit json` printed the lift request at exit 0 and never mentioned
    // the emitter that was asked for and did not run. That is the same unread-but-known
    // flag as `-o` below. There is no honouring it — `--lift` produces the lowering
    // REQUEST an agent answers, and the emitter runs on the Program that comes back, one
    // command later — so the answer is to refuse the combination rather than pick one.
    if (flag('emit') !== undefined) {
      die('--emit has no meaning with `jevc compile --lift`: --lift prints the lowering request an agent answers, not an emitted artifact. Lift first, then run jevc on the Program the agent returns.')
    }

    // An empty instruction file is not "a document that happens to contain no rules", it
    // is a mistake — a shell redirection that produced nothing, or the wrong path — and
    // the prompt built from it is a complete 4 KB lowering request with an empty document
    // section. Measured, not assumed: from-prompt.ts normalises every candidate quote and
    // the document alike with `/\s+/g -> ' '` and then `.trim()`, and requires the quote
    // to be at least MIN_QUOTE_LENGTH (12) characters. A document with no non-whitespace
    // content normalises to the empty string, so NO citation can ever verify against it:
    // every decision the agent returns is either rejected as unprovenanced or invented.
    // That is why whitespace-only counts as empty here.
    //
    // Comments do NOT count. jevc strips nothing from an instruction document —
    // buildLiftRequest embeds `source` verbatim between the fences — so `<!-- ... -->` and
    // `# ...` are quotable text like any other line, and a decision citing one is
    // perfectly verifiable. Treating them as empty would enforce a comment syntax the tool
    // does not have, and it would have to guess which of markdown/HTML/shell it is reading.
    //
    // Same contract as `canEmit`'s `no_decisions` ("Nothing to emit: ...") at the far end
    // of the pipeline, which round 3 put on the non-lift path for the same reason: one
    // `dropped:` line at exit 0 reads as success.
    if (text.trim() === '') {
      die(`Nothing to lift: ${where} ${text.length === 0 ? 'is empty' : 'contains only whitespace'}. A lift request over an empty document asks an agent to lower nothing, and no decision it returns could be verified — a provenance quote must appear in the document, and there is no text in this one.`)
    }

    // The label on the fence is the name `parseLiftResponse` checks every `source.file`
    // against, and it compares against the path IT is handed — the same one the user typed
    // here. Labelling the fence with `basename(path)` told the lifter the file was
    // "AGENTS.md" while the caller verifies against "docs/AGENTS.md", so every decision
    // came back `provenance_file_unknown`. The label has to be the path as given.
    const request = buildLiftRequest(text, where)

    // `-o` was accepted and never read on this path alone, so `--lift -o request.txt`
    // exited 0, printed 4 KB to the terminal and left request.txt holding the PREVIOUS
    // run's prompt — a pipeline that writes it and then reads it lifts the wrong document.
    // Every other output path in this file honours `-o`; this is the same three lines.
    const dest = flag('o')
    if (dest) write(dest, request)
    else toStdout(request)
    process.exit(0)
  }

  // Two kinds of JSON reach this branch and only one of them used to work. A JSON Schema
  // lowers through `fromJsonSchema`. A Program — the `{decisions, reduce, residual,
  // dropped}` object an agent returns from `--lift` — is ALREADY lowered, and handing it to
  // `fromJsonSchema` read it as a schema with no `properties`: "The root schema declares no
  // properties to lower (its keys are: decisions, reduce, residual, dropped)", then exit 1.
  // So the last mile of the prose route had no implementation, while three places
  // documented it: `docs/wiring.md`, `examples/claude-code-hook/README.md`, and this file's
  // own `--lift` refusal ("Lift first, then run jevc on the Program the agent returns").
  //
  // A `decisions` key is the discriminator, not shape-validity: a file that claims to be a
  // Program and is malformed must be reported AS a malformed Program, or the user gets the
  // schema lowerer's "zero decisions" message about a file that has decisions in it.
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    die(`${path} is not JSON. For prose, use: jevc compile ${path} --lift`)
  }
  let program: SchemaProgram | undefined
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'decisions' in parsed) {
    const shape = checkProgramShape(parsed, path)
    if (shape.length) {
      for (const i of shape) toStderr(`${i.severity}: ${i.path}: ${i.message}\n`)
      die(`${path} has a \`decisions\` key, so it was read as a jevc program — and it is not a well-formed one. Expected { decisions, reduce, residual, dropped }, the shape \`jevc compile <file> --lift\` asks the agent to produce.`)
    }
    program = parsed as SchemaProgram
  } else {
    try {
      program = fromJsonSchema(parsed as JsonSchema)
    } catch {
      die(`${path} is not JSON Schema. For prose, use: jevc compile ${path} --lift`)
    }
  }

  const issues = [...validateProgram(program!), ...lintProgram(program!)]
  for (const i of issues) toStderr(`${i.severity}: ${i.path}: ${i.message}\n`)
  if (issues.some(i => i.severity === 'error')) process.exit(1)

  if (program!.residual) toStderr(`\nresidual:\n${program!.residual}\n`)

  // `dropped` carries two categorically different reports and only one of them is this
  // tool working as designed. `unsupported` — "this construct has no Jev equivalent" — is
  // a note: the artifact is still everything Jev can represent of what the author wrote.
  // `collision` is the author's intent LOST: two things they wrote claim one id or one
  // option name, so BOTH were discarded and the artifact asks NEITHER. Unrepresentable
  // rather than unsupported, and renaming one of them fixes it.
  //
  // So a collision is an error however many other decisions survived. The soft version of
  // this shipped a well-formed guard at exit 0 whenever ONE decision came through:
  // {"a.b": bool, "a": {"properties": {"b": bool}}, "keeper": bool} wrote a one-question
  // request with two of the three questions silently absent and `dropped:` on stderr
  // reading as information. `canEmit`'s `no_decisions` below is the SAME contract at the
  // other extreme — nothing survived — and it is blind to the partial case because
  // `decisions.length` is 1. One rule, both ends: the artifact asks everything the schema
  // asked, or jevc refuses to write one. Branching on `kind` and not on the prose, because
  // the prose changes whenever the message improves.
  const collided = program!.dropped.filter(d => d.kind === 'collision')
  for (const d of program!.dropped) {
    toStderr(`${d.kind === 'collision' ? 'error' : 'dropped'}: ${d.reason}\n`)
  }

  // ai-sdk and langchain existed as emitters with no way to reach them: the only route to
  // either was to import jevc as a library.
  const emit = flag('emit') ?? 'sdk'
  if (!['sdk', 'json', 'ai-sdk', 'langchain'].includes(emit)) {
    die(`Unknown --emit value "${emit}". Expected sdk, json, ai-sdk or langchain.`)
  }

  // Both of these ran on the `--emit json` branch alone, and neither is a property of the
  // json emitter.
  //
  // `canEmit` is the refusal gate the README's target table documents, and it was reachable
  // only from the two policy emitters — `compile` consulted the capability model for no
  // target at all. Its `no_decisions` error is the one that bites here: a JSON Schema whose
  // properties are all free text (the ordinary prose->residual case) compiles to zero
  // decisions, and the emitted module then asks nothing and returns the fallthrough verdict
  // for every input. capability.ts:72-79 already named this exact failure — langchain's
  // `TypeSafeClassifier(questions=...)` declares `Field(min_length=1)` and raises at import
  // — and nothing on this path called it. It is also the honest exit code for "I compiled
  // nothing": one `dropped:` line at exit 0 reads as success.
  //
  // `validateRequest` owns the wire constraints the API enforces on whichever artifact ends
  // up sending the request (empty question ids, the token budget; the 255-option ceiling
  // and the 2..10 score bound now belong to validateProgram above, which every target
  // already runs). Amendment: run it locally so a request that would 422 is caught here.
  const req = emitJson(program!, '<state>')
  const gate = [
    ...canEmit(program!, emit),
    ...validateRequest(req).filter(i => !STATE_DEPENDENT.includes(i.code)),
  ]
  for (const i of gate) toStderr(`${i.severity}: ${i.path}: ${i.message}\n`)
  // The collisions were reported above rather than re-printed here, but they exit with the
  // gate so a run that has both kinds of problem reports both: a gate that reveals its
  // objections one at a time turns a single fix into a guessing game.
  if (collided.length || gate.some(i => i.severity === 'error')) process.exit(1)

  let out: string
  if (emit === 'ai-sdk') out = emitAiSdk(program!)
  else if (emit === 'langchain') out = emitLangchain(program!)
  else if (emit === 'json') out = JSON.stringify(req, null, 2)
  else out = emitNative(program!)

  const dest = flag('o')
  if (dest) write(dest, out)
  else toStdout(out)
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
      toStdout(
        `${row.status.toUpperCase()} ${row.id}  recorded=${JSON.stringify(row.recorded)} live=${JSON.stringify(row.live)}${delta}\n`,
      )
    }
    toStdout(
      `${report.rows.length} rows checked live against ${report.model}: ${report.drifted} drifted, ${report.broken} broken\n`,
    )
    process.exit(report.broken > 0 ? 1 : 0)
  }

  let failed = 0
  for (const f of corpus) {
    const fails = assertExpectation(f.expect, f.measured.answers)
    if (fails.length) { failed++; toStdout(`FAIL ${f.id}\n  ${fails.join('\n  ')}\n`) }
  }
  toStdout(`${corpus.length} fixtures, ${corpus.length - failed} passing, ${failed} failing\n`)
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
    toStdout(`${id}  (${f.domain}/${f.id})\n`)
    toStdout(`  type:         ${q.type}\n`)
    toStdout(`  instructions: ${renderEntry(q.instructions)}\n`)
    toStdout(`  provenance:   ${f.provenance}\n`)
    toStdout(`  measured:     ${JSON.stringify(f.measured.answers[id])}\n`)
    toStdout(`  replaces:     ${f.llm_prompt.slice(0, 120)}...\n\n`)
  }
  process.exit(0)
}

if (cmd === 'scan') {
  // The entry point for someone who has rules but no schema — which is everyone, the
  // first time. It reads; it never writes, never calls a model and never decides.
  const { scanProject, renderScan } = await import('./scan.js')
  const root = positional() ?? '.'
  let files
  try { files = scanProject(root) }
  catch (e) { die(`Cannot scan ${root}: ${(e as Error).message}`) }
  if (has('json')) toStdout(`${JSON.stringify(files, null, 2)}\n`)
  else toStdout(renderScan(root, files!))
  process.exit(0)
}

if (cmd === 'show') {
  // `explain` answers "why does this question exist"; `show` answers "what does the whole
  // thing look like end to end", which is the question someone evaluating jevc has.
  const { renderFixture } = await import('./show.js')
  const corpus = fixtures(flag('fixtures') ?? 'fixtures')
  const id = positional()
  if (!id) {
    toStdout(`usage: jevc show <fixture-id>\n\n${corpus.length} recorded fixtures:\n\n`)
    const pad = Math.max(...corpus.map(f => f.id.length))
    for (const f of corpus) toStdout(`  ${f.id.padEnd(pad)}  ${f.title}\n`)
    process.exit(0)
  }
  const hit = corpus.find(f => f.id === id)
  if (!hit) {
    // A near miss is the common case (a typo, or half-remembering the id), and printing
    // 60 rows in answer to one wrong word is not help.
    const near = corpus.filter(f => f.id.includes(id) || id.includes(f.id)).map(f => f.id)
    die(`No fixture "${id}".${near.length ? `\nDid you mean: ${near.join(', ')}` : '\nRun `jevc show` with no argument to list them.'}`)
  }
  toStdout(`${renderFixture(hit!)}\n`)
  process.exit(0)
}

if (cmd === 'emit-policy') {
  // jev-guard is deliberately absent: its questions are `export const` literals in
  // src/guard.js and decide() destructures four fixed ids, so there is nothing to emit into.
  const target = flag('for') ?? die('usage: jevc emit-policy --for <bouncer|toolgate> <program.json> [-o out]')
  const path = positional() ?? die('supply a compiled program JSON file')
  let parsed: unknown
  try {
    parsed = JSON.parse(read(path))
  } catch (e) {
    die(`${path} is not valid JSON: ${(e as Error).message}`)
  }

  // Valid JSON is not a Program. Shape it before the cast, or validateProgram/lintProgram
  // dereference fields that are not there and the user gets a Node stack trace naming
  // jevc's internals instead of "that file is not a jevc program".
  const shape = checkProgramShape(parsed, path)
  if (shape.length) {
    for (const i of shape) toStderr(`${i.severity}: ${i.path}: ${i.message}\n`)
    die(`${path} is not a jevc program. Expected { decisions, reduce, residual, dropped } — the shape \`jevc compile <file> --lift\` asks the agent to produce.`)
  }
  const program = parsed as Program

  // The same gate `compile` runs. Without it a rule naming a decision that does not
  // exist emitted `when: {ghost: {p: ">=0.8"}}` at exit 0 — valid YAML, a rule that can
  // never match, and (for bouncer) a policy whose only failure mode is a silent gate.
  // canEmit checks what the TARGET can express; validateProgram checks that the Program
  // is coherent at all, and neither substitutes for the other.
  const issues = [...validateProgram(program!), ...lintProgram(program!)]
  for (const i of issues) toStderr(`${i.severity}: ${i.path}: ${i.message}\n`)
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
  else toStdout(out!)
  process.exit(0)
}

die(`usage: jevc <command>

  scan [dir]                    find the instruction files this project already has
  compile <file|-> --lift       turn a rules document into a lowering request for your agent
  compile <file|->              turn a JSON Schema into a typed module
  emit-policy --for <target>    lower a compiled program into bouncer or toolgate YAML
  show [fixture-id]             one recorded fixture, end to end
  explain <decision-id>         why a question exists, and what it measured
  check                         replay the measured corpus

Start with \`jevc scan\`.`)
