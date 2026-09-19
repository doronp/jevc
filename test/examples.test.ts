import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { loadFixtures } from '../src/check.js'
import { VERDICT_WORDS } from '../src/ir.js'

// The devDependency binaries directly rather than `npx`: they are already installed, so
// this resolves deterministically and can never reach the network mid-test.
const TSC = 'node_modules/.bin/tsc'
const TSX = 'node_modules/.bin/tsx'

/** execFileSync puts a compiler's diagnostics on stdout, which the thrown Error hides.
 * Re-throw with them attached, or a red typecheck reports only "Command failed". */
const run = (bin: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', env: { ...process.env, ...env } })
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string }
    throw new Error(`${bin} ${args.join(' ')} failed:\n${err.stdout ?? ''}${err.stderr ?? ''}`)
  }
}

const examples = () => readdirSync('examples').filter(f => f.endsWith('.ts')).sort()

describe('examples', () => {
  it('every example typechecks', () => {
    run(TSC, ['--noEmit', '-p', 'examples/tsconfig.json'])
  })

  // The examples replay the recorded corpus, so they must not need a key — and the test
  // proves it by removing the one this machine might have.
  it('every example runs offline without an API key', () => {
    for (const f of examples()) {
      const out = run(TSX, [`examples/${f}`], { TYPESAFE_API_KEY: '' })
      expect(out.length, f).toBeGreaterThan(0)
    }
  })

  it('the policy example prints a real policy and a real refusal', () => {
    const out = run(TSX, ['examples/04-policy-emit.ts'], { TYPESAFE_API_KEY: '' })
    expect(out).toMatch(/backend: jev/)                     // bouncer accepted it
    expect(out).toMatch(/Cannot emit a toolgate policy/)    // toolgate refused it
    expect(out).toMatch(/kind_unsupported/)                 // canEmit refused a score
  })
})

describe('README', () => {
  const readme = readFileSync('README.md', 'utf8')
  const corpus = loadFixtures('fixtures')

  it('cites the model and the corpus size the fixtures actually record', () => {
    expect(readme).toMatch(/jev-1\.13\.0/)
    expect(readme).toMatch(new RegExp(`${corpus.length} fixtures`))
    expect(new Set(corpus.map(f => f.measured.model))).toEqual(new Set(['jev-1.13.0']))
  })

  // Every latency printed in the README must be a latency something actually measured.
  // A plausible round number that no fixture produced is the exact failure this repo exists
  // to remove, so it fails the build here rather than being believed by a reader.
  it('quotes only latencies that exist in the measured corpus', () => {
    const latencies = corpus.map(f => f.measured.latency_ms!).sort((a, b) => a - b)
    const median = (latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2
    const allowed = new Set([...latencies, median].map(String))
    for (const [, n] of readme.matchAll(/(\d+(?:\.\d+)?)\s?ms\b/g)) {
      expect(allowed.has(n), `README cites ${n} ms, which no fixture measured`).toBe(true)
    }
  })

  // The decomposition law is the README's headline claim; pin it to the recorded answers so
  // a re-measured corpus cannot leave a stale number in the prose.
  it('quotes the decomposition-law confidences from the fixture that produced them', () => {
    const f = corpus.find(x => x.id === 'bash-rm-rf-node-modules-benign')!
    const verdict = f.measured.answers.decision
    const evidence = f.measured.answers.blast_radius
    if (verdict.type !== 'choice' || evidence.type !== 'score') throw new Error('fixture shape changed')
    expect(readme).toContain(f.id)
    expect(readme).toContain(String(verdict.confidence))
    expect(readme).toContain(String(evidence.confidence))
    for (const [option, p] of Object.entries(verdict.probabilities)) {
      expect(readme, `probability for ${option}`).toContain(String(p))
    }
  })

  it('cites the calibration split the corpus records', () => {
    const wrong = corpus.filter(f => f.measured.prediction_held === false).length
    expect(readme).toMatch(new RegExp(`${wrong} of (the )?${corpus.length}`))
  })

  // The remaining README statistics are derived from the corpus rather than copied from a
  // single fixture, so they are recomputed here. A number nobody can reproduce is exactly
  // what this project exists to stop shipping.
  it('cites corpus statistics that recompute from the fixtures', () => {
    const questions = corpus.flatMap(f => Object.values(f.questions))
    const count = (kind: string) => questions.filter(q => q.type === kind).length
    expect(readme).toContain(`${questions.length} questions`)

    // The README opens on the size of the prompt jevc replaces; it is a real fixture field.
    const prompt = corpus.find(f => f.id === 'commit-only-when-explicitly-asked')!.llm_prompt!
    expect(readme).toContain(`${prompt.length.toLocaleString('en-US')} characters`)
    expect(readme).toContain(`(${count('noul')} noul, ${count('choice')} choice, ${count('score')} score)`)

    // Verdict-shaped by the same VERDICT_WORDS vocabulary the linter's collapse check uses.
    const choices = corpus.flatMap(f => Object.values(f.measured.answers))
      .flatMap(a => a.type === 'choice' ? [a] : [])
    const verdictish = (a: { probabilities: Record<string, number> }) => {
      const opts = Object.keys(a.probabilities).map(o => o.toLowerCase())
      const n = opts.filter(o => VERDICT_WORDS.has(o)).length
      return n >= 2 && n >= opts.length - 1
    }
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b)
      return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
    }
    const verdicts = choices.filter(verdictish)
    const others = choices.filter(a => !verdictish(a))
    expect(readme).toContain(`${verdicts.length} verdict-shaped`)
    expect(readme).toContain(`median confidence of ${median(verdicts.map(a => a.confidence))}`)
    expect(readme).toContain(`${median(others.map(a => a.confidence))} median of the other ${others.length} choice heads`)

    // The tail claim: lowest three verdict heads, and the two non-verdict heads below them
    // that the README admits are also down there. Recomputed so neither list can go stale.
    const low = (xs: number[]) => [...xs].sort((x, y) => x - y).slice(0, 3)
    const [v1, v2, v3] = low(verdicts.map(a => a.confidence))
    expect(readme).toContain(`${v1}, ${v2} and ${v3}`)
    for (const c of low(others.map(a => a.confidence)).slice(0, 2)) {
      expect(readme, `non-verdict low tail ${c}`).toContain(`measured ${c}`)
    }

    // Latency is flat in question count, quoted as two real bands.
    const band = (n: number) => {
      const ms = corpus.filter(f => Object.keys(f.questions).length === n)
        .map(f => f.measured.latency_ms!).sort((x, y) => x - y)
      return `${ms.length}|${ms[0]}-${ms.at(-1)}`
    }
    expect(readme).toContain(`${band(5).split('|')[0]} fixtures with 5 questions span ${band(5).split('|')[1]} ms`)
    expect(readme).toContain(`${band(7).split('|')[0]} with 7 questions span ${band(7).split('|')[1]} ms`)
  })
})
