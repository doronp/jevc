#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fromJsonSchema } from './from-schema.js'
import { buildLiftRequest } from './from-prompt.js'
import { emitNative } from './emit/native.js'
import { emitJson } from './emit/json.js'
import { lintProgram, validateProgram, type Program } from './ir.js'
import { assertExpectation, checkLive, loadFixtures } from './check.js'
import { validateRequest } from './contract.js'

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

  let out: string
  if (flag('emit') === 'json') {
    // Amendment: the API is the only thing that used to enforce this (e.g. the 255-option
    // choice ceiling, question-id uniqueness) — run the wire validator locally so a request
    // that would 422 is caught here instead.
    const req = emitJson(program!, '<state>')
    const reqIssues = validateRequest(req)
    for (const i of reqIssues) process.stderr.write(`${i.severity}: ${i.path}: ${i.message}\n`)
    if (reqIssues.some(i => i.severity === 'error')) process.exit(1)
    out = JSON.stringify(req, null, 2)
  } else {
    out = emitNative(program!)
  }

  const dest = flag('o')
  if (dest) { writeFileSync(dest, out); process.stderr.write(`wrote ${dest}\n`) }
  else process.stdout.write(out)
  process.exit(0)
}

if (cmd === 'check') {
  const fixtures = loadFixtures(flag('fixtures') ?? 'fixtures')

  if (has('live')) {
    // Amendment: --live requires a real API key and must never run as part of `npm test`.
    // Offline `check` (the default, above) needs no key and stays that way.
    if (!process.env.TYPESAFE_API_KEY) {
      die('check --live requires TYPESAFE_API_KEY in the environment.')
    }
    const report = await checkLive(fixtures)
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

die('usage: jevc <compile|check|explain> ...')
