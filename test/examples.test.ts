import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { loadFixtures } from '../src/check.js'
import { VERDICT_WORDS } from '../src/ir.js'
import { runReducer } from '../src/runtime.js'

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

// ---------------------------------------------------------------------------------------
// Everything below pins a number or a console block the documentation pass touched. The
// rule is the one the README states about itself: a claim nobody can reproduce is the exact
// failure this repo exists to remove, so each of these recomputes the claim from the repo
// and fails the build rather than letting the prose rot quietly.
// ---------------------------------------------------------------------------------------
describe('README claims recompute from the repo', () => {
  const readme = readFileSync('README.md', 'utf8')
  // The README hard-wraps its prose, so a claim spanning a line break does not match a
  // literal. Collapse runs of whitespace once and assert against that for anything in prose;
  // keep the raw text for anything inside a fenced block, where the line breaks are content.
  const flat = readme.replace(/\s+/g, ' ')
  // Two reference sections live in `docs/` so the README stays readable in one sitting.
  // The claims in them are still recomputed here — moving prose out of the README must not
  // move it out of the checks, or the split becomes a place for numbers to rot.
  const flatDocs = [readme, readFileSync('docs/schema-mapping.md', 'utf8'),
    readFileSync('docs/validation.md', 'utf8')].join('\n').replace(/\s+/g, ' ')
  const corpus = loadFixtures('fixtures')

  const blocks = [...readme.matchAll(/\n```(\w*)\n([\s\S]*?)\n```/g)]
    .map(m => ({ lang: m[1], body: m[2] }))
  /** The one fenced block of `lang` that contains `needle`. Located by content, not by line
   * number, so reordering a section does not silently repoint an assertion. */
  const blockWith = (lang: string, needle: string): string => {
    const hits = blocks.filter(b => b.lang === lang && b.body.includes(needle))
    expect(hits.length, `README should have exactly one ${lang} block containing "${needle}"`).toBe(1)
    return hits[0].body
  }

  const median = (xs: readonly number[]) => {
    const s = [...xs].sort((a, b) => a - b)
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  }

  describe('the corpus statistics in the calibration section', () => {
    // Every `expect` clause in the corpus, flattened, so the band/equality split the README
    // makes can be counted rather than asserted from memory.
    const clauses = corpus.flatMap(f =>
      Object.entries(f.expect).flatMap(([id, exp]) =>
        Object.entries(exp).map(([key, value]) => ({ id, key, value, fixture: f }))))
    const entries = corpus.flatMap(f => Object.values(f.expect))

    it('splits 329 expect entries into bands and argmax equalities, by count and by kind', () => {
      const choiceEntries = entries.filter(e => 'choice' in e)
      expect(flat).toContain(`**${entries.length}** \`expect\` entries across the ${corpus.length} fixtures`)
      expect(flat).toContain(`${entries.length - choiceEntries.length} are bands`)
      expect(flat).toContain(`the remaining **${choiceEntries.length}** assert an equality`)
      expect(flat).toContain(
        `${choiceEntries.filter(e => 'confidence_gte' in e || 'confidence_lte' in e).length} of those ${choiceEntries.length} carry a confidence band`)

      // The per-kind breakdown, each recomputed. A kind that gains or loses a clause fails
      // here rather than leaving one stale integer inside a parenthesis nobody re-reads.
      const named = ['noul_gte', 'noul_lte', 'confidence_gte', 'score_gte', 'score_lte', 'confidence_lte']
      const of = (key: string) => clauses.filter(c => c.key === key).length
      for (const key of named) expect(flat, `breakdown for ${key}`).toContain(`\`${key}\` ${of(key)}`)

      // The unit of that parenthesis is BOUNDS, not entries — an entry pinning both ends
      // contributes two — which is why it sums past 269 and why the README now says so. The
      // same total carries the drift argument below, so pin them to one another here.
      const bounds = clauses.filter(c => typeof c.value === 'number').length
      expect(named.reduce((n, k) => n + of(k), 0)).toBe(bounds)
      expect(flat).toContain(`those entries pin **${bounds}** numeric bounds`)
      expect(bounds).toBeGreaterThan(entries.length - choiceEntries.length)
    })

    it('quotes the real minimum and median argmax margin behind those equalities', () => {
      const margins = corpus.flatMap(f =>
        Object.keys(f.expect).flatMap(id => {
          if (!('choice' in f.expect[id])) return []
          const a = f.measured.answers[id]
          if (a?.type !== 'choice') return []
          const sorted = Object.values(a.probabilities).sort((x, y) => y - x)
          return [Number((sorted[0] - (sorted[1] ?? 0)).toFixed(10))]
        }))
      expect(margins.length).toBe(entries.filter(e => 'choice' in e).length)
      expect(flat).toContain(`anywhere in those ${margins.length} is **${Math.min(...margins)}**`)
      expect(flat).toContain(`the median is **${median(margins)}**`)
      // The same 0.07 carries the decomposition-law claim at the top of the file, and the
      // calibration section says so. If they ever stop being the same number, say so there.
      expect(flat).toContain(`Note that ${Math.min(...margins)} is the collapsed verdict question`)
    })

    it('counts the corpus the way the provenance paragraph describes it', () => {
      const questions = corpus.flatMap(f => Object.values(f.questions))
      const of = (t: string) => questions.filter(q => q.type === t).length
      const domains = [...new Set(corpus.map(f => f.domain))]
      expect(flat).toContain(`**${corpus.length} fixtures**`)
      expect(flat).toContain(`${questions.length} questions (${of('noul')} noul, ${of('choice')} choice, ${of('score')} score)`)
      // The domains stopped being evenly sized when two fixtures were removed for licensing
      // reasons, so the README names both sizes and both are recomputed here.
      const size = (d: string) => corpus.filter(f => f.domain === d).length
      const per = [...new Set(domains.map(size))].sort((a, b) => b - a)
      expect(domains).toHaveLength(5)
      expect(per, 'a third domain size appeared — the README sentence needs rewriting').toHaveLength(2)
      expect(flat).toContain(`at ${per[0]} each, agent harness rules at ${size('agent-harness-rules')}`)
    })

    it('quotes the prediction-vs-measurement split that motivates the corpus', () => {
      const held = corpus.filter(f => f.measured.prediction_held === true).length
      const wrong = corpus.filter(f => f.measured.prediction_held === false).length
      expect(held + wrong, 'some fixture no longer records prediction_held').toBe(corpus.length)
      expect(flat).toContain(`Only ${held} of the ${corpus.length} predicted thresholds survived`)
      expect(flat).toContain(`${wrong} of ${corpus.length}`)
      expect(flat).toContain(`${Math.round((wrong / corpus.length) * 100)}% of the predicted thresholds`)
    })

    it('quotes the verdict-head tail, using the linter\'s own predicate', () => {
      // Not `some(VERDICT_WORDS.has)`: lintProgram fires only when at least two options are
      // verdict words AND at most one is not, and the looser predicate gives 26/39, not
      // 19/46. The README says "the same VERDICT_WORDS test the linter uses", so use it.
      const heads = corpus.flatMap(f => Object.entries(f.questions)
        .filter(([, q]) => q.type === 'choice')
        .map(([id, q]) => ({ q, a: f.measured.answers[id] })))
      const collapsed = ({ criteria }: { criteria?: unknown }) => {
        const opts = Object.keys((criteria ?? {}) as object).map(o => o.toLowerCase())
        const n = opts.filter(o => VERDICT_WORDS.has(o)).length
        return opts.length > 0 && n >= 2 && n >= opts.length - 1
      }
      const conf = (hs: typeof heads) => median(hs.map(h => (h.a as { confidence: number }).confidence))
      const verdict = heads.filter(h => collapsed(h.q))
      const rest = heads.filter(h => !collapsed(h.q))
      expect(flat).toContain(`the ${verdict.length} verdict-shaped choice heads`)
      expect(flat).toContain(`median confidence of ${conf(verdict)}`)
      expect(flat).toContain(`${conf(rest)} median of the other ${rest.length} choice heads`)
      const tail = verdict.map(h => (h.a as { confidence: number }).confidence).sort((a, b) => a - b)
      expect(flat).toContain(`the three least confident verdict heads are ${tail[0]}, ${tail[1]} and ${tail[2]}`)
    })

    it('quotes how many score answers are fractional, which is the integration bug', () => {
      const scores = corpus.flatMap(f => Object.values(f.measured.answers))
        .filter(a => a.type === 'score') as { score: number }[]
      const fractional = scores.filter(a => !Number.isInteger(a.score)).length
      expect(flatDocs).toContain(`${fractional} of the ${scores.length} measured score answers`)
    })

    it('quotes the drift headroom that justifies `drifted` rather than `broken`', () => {
      const gaps = corpus.flatMap(f =>
        Object.entries(f.expect).flatMap(([id, exp]) =>
          Object.entries(exp).flatMap(([key, bound]) => {
            if (typeof bound !== 'number') return []
            const a = f.measured.answers[id]
            const actual = key.startsWith('noul_') ? (a?.type === 'noul' ? a.noul : undefined)
              : key.startsWith('score_') ? (a?.type === 'score' ? a.score : undefined)
                : (a?.type === 'choice' || a?.type === 'score' ? a.confidence : undefined)
            return typeof actual === 'number' ? [Math.abs(actual - bound)] : []
          })))
      const under = gaps.filter(g => g < 0.15).length
      expect(flat).toContain(`${under} of the ${gaps.length} numeric bounds in this corpus have less headroom than the 0.15`)
    })
  })

  describe('the numbers on the first screen', () => {
    const f = () => corpus.find(x => x.id === 'commit-only-when-explicitly-asked')!

    it('quotes every measured answer the headline block shows', () => {
      const answers = f().measured.answers
      const noul = (id: string) => {
        const a = answers[id]
        if (a.type !== 'noul') throw new Error(`${id} is no longer a noul`)
        return a.noul
      }
      // The three the example prints, in the aligned block. The decimal point is escaped:
      // unescaped, `0.96` also matches `0996` and the assertion stops meaning anything.
      const lit = (n: number) => String(n).replace('.', '\\.')
      const shown = blockWith('', 'verdict, computed in code')
      for (const id of ['is_commit_operation', 'user_explicitly_asked_to_commit', 'commit_required_by_requested_task']) {
        // `(?!\d)` so 0.06 cannot be satisfied by a printed 0.065; the trailing lookahead
        // rather than `$` because one of these lines carries an inline aside after the value.
        expect(shown, id).toMatch(new RegExp(`^${id}\\s+${lit(noul(id))}(?!\\d)`, 'm'))
      }
    })

    // A latency is an observation from one batch on one day, not a benchmark, so the README
    // is allowed to record it exactly once and only where a reader has already been told
    // what it is worth. Anything above that footnote reads as a spec, so nothing above it
    // may quote a millisecond at all.
    it('keeps latency out of the body, in one footnote, quoted unrounded', () => {
      const ms = corpus.map(x => x.measured.latency_ms!).sort((a, b) => a - b)
      const cut = readme.lastIndexOf('\\* *Latency')
      expect(cut, 'the latency footnote moved or was deleted').toBeGreaterThan(-1)
      const footnote = readme.slice(cut).replace(/\s+/g, ' ')
      expect(footnote).toContain(`min ${ms[0]} ms, median ${median(ms)} ms, max ${ms.at(-1)} ms`)
      expect(readme.slice(0, cut), 'a latency escaped into the body').not.toMatch(/\d\s?ms\b/)
    })
  })

  describe('the wire-contract numbers', () => {
    it('quotes the token budgets the code enforces, not the ones the vendor documents', async () => {
      const { TOKEN_BUDGET_TOTAL, TOKEN_BUDGET_SINGLE, estimateTokens } = await import('../src/index.js')
      expect(flatDocs).toContain(`**${TOKEN_BUDGET_TOTAL.toLocaleString('en-US')} tokens**`)
      expect(flatDocs).toContain(`**${TOKEN_BUDGET_SINGLE.toLocaleString('en-US')}**`)
      // CHARS_PER_TOKEN is module-private, so derive it the way a caller would observe it.
      const ratio = 510 / estimateTokens('x'.repeat(510))
      expect(flatDocs).toContain(`the measured ratio of ${ratio} characters per token`)
    })

    it('counts the lint rules `lintProgram` actually runs', () => {
      const ir = readFileSync('src/ir.ts', 'utf8')
      const from = ir.indexOf('export function lintProgram')
      const to = ir.indexOf('export function uncertaintyOf')
      expect(from, 'lintProgram moved').toBeGreaterThan(-1)
      expect(to, 'uncertaintyOf moved — the slice below is no longer lintProgram alone').toBeGreaterThan(from)
      const codes = new Set([...ir.slice(from, to).matchAll(/code: '([a-z_]+)'/g)].map(m => m[1]))
      const word = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][codes.size]
      expect(word, `lintProgram runs ${codes.size} checks — past the end of the number words here`).toBeTruthy()
      expect(flat).toContain(`three of the ${word} checks it runs`)
    })
  })

  describe('the emit-target capability claims', () => {
    // The Program the README prints as `program.json`, parsed out of the README itself, so
    // the console blocks below are checked against the input the reader is shown.
    const program = () => JSON.parse(blockWith('json', '"deletes_tracked_files"'))

    it('prints a bouncer policy byte-for-byte identical to the emitter output', async () => {
      const { emitBouncerPolicy } = await import('../src/index.js')
      const shown = blockWith('console', '$ npx jevc emit-policy --for bouncer program.json')
      const body = shown.split('\n').slice(1).join('\n')
      expect(body.trimEnd()).toBe(emitBouncerPolicy(program()).trimEnd())
    })

    it('prints both toolgate coverage refusals, with their paths, exactly as canEmit reports them', async () => {
      const { canEmit } = await import('../src/index.js')
      const issues = canEmit(program(), 'toolgate')
      const shown = blockWith('console', '$ npx jevc emit-policy --for toolgate program.json')
      expect(issues.length, 'the README block shows two refusals').toBe(2)
      for (const i of issues) expect(shown).toContain(`${i.path}: ${i.message}`)
      // The same program is fine for bouncer; that contrast is the point of the section.
      expect(canEmit(program(), 'bouncer')).toEqual([])
    })

    // The skill worked example answers "I have a bunch of skills — what is my before and
    // after?", so its console block has to be the real before and after. Every line the
    // README shows must come from the emitter, and the two provenance comments must name
    // lines that actually say what the README claims they say.
    it('shows a real policy emitted from the release skill, citing real skill lines', async () => {
      const { emitBouncerPolicy } = await import('../src/index.js')
      const gate = JSON.parse(readFileSync('examples/sample-project/.claude/gates/release.json', 'utf8'))
      const emitted = emitBouncerPolicy(gate)
      const shown = blockWith('console', 'emit-policy --for bouncer examples/sample-project')
        .split('\n').slice(1)

      for (const line of shown) {
        if (line === '...') continue
        expect(emitted, `the README shows a line the emitter does not: ${line}`).toContain(line)
      }
      expect(shown.filter(l => l === '...').length, 'exactly one elision, and it is marked').toBe(1)

      // The citations are the whole point of the section: each must quote its own file.
      const skill = readFileSync('examples/sample-project/.claude/skills/release/SKILL.md', 'utf8').split('\n')
      for (const d of gate.decisions) {
        expect(skill[d.source.line - 1], `${d.id} cites the wrong line`).toContain(d.source.quote)
        expect(shown.join('\n')).toContain(`${d.source.file}:${d.source.line} — ${d.source.quote}`)
      }
    })

    it('lists exactly the targets that exist, in a table with one row each', async () => {
      const { TARGETS } = await import('../src/index.js')
      for (const name of Object.keys(TARGETS)) {
        expect(readme, `capability table row for ${name}`).toMatch(new RegExp(`^\\| \`${name}\` \\|`, 'm'))
      }
      // ...and no seventh. The bouncer/toolgate cells are bolded, hence the optional `**`.
      const rows = [...readme.matchAll(/^\| `([a-z-]+)` \| \*{0,2}noul/gm)].map(m => m[1])
      expect(new Set(rows)).toEqual(new Set(Object.keys(TARGETS)))
    })

    it('names only refusal and lint codes the source actually raises', () => {
      // Both spellings: capability.ts raises some through `issue('code', ...)` and some
      // through an object literal, and a list built from one spelling silently misses half.
      const raised = (file: string) => new Set(
        [...readFileSync(file, 'utf8').matchAll(/(?:code: |issue\(|err\()'([a-z_]+)'/g)].map(m => m[1]))
      const capability = raised('src/emit/capability.ts')
      const contract = raised('src/contract.ts')
      const ir = raised('src/ir.ts')
      const anywhere = new Set([...capability, ...contract, ...ir])

      // Spelled out rather than scraped: scraping the README and then checking the hits
      // exist proves nothing, because a code deleted from the prose leaves no hit to check.
      // This list fails on a rename in either direction.
      const named = [
        'verdict_unsupported', 'reducer_unrepresentable', 'no_decisions', 'threshold_not_a_number',
        'instructions_not_string', 'id_empty', 'band_out_of_range', 'uncertain_unsupported',
        'embedded_carveout', 'embedded_pattern', 'score_levels_undescribed',
        'duplicate_id', 'unknown_field', 'path_unresolved', 'state_empty',
        'score_too_few_levels', 'choice_too_few_options',
      ]
      for (const code of named) {
        expect(readme, `README no longer names ${code}`).toContain(`\`${code}\``)
        expect(anywhere.has(code), `${code} is named in the README but raised nowhere in src/`).toBe(true)
      }
    })

    it('quotes the real lowered uncertainty band, ULP step and all', async () => {
      const { canEmit, emitBouncerPolicy } = await import('../src/index.js')
      const withBand = (band?: [number, number]) => ({
        version: 1,
        decisions: [{ id: 'q', kind: 'noul', instructions: 'Is it bad?', ...(band ? { uncertain: { band } } : {}) }],
        reduce: { kind: 'rules', rules: [{ when: [{ id: 'q', op: 'uncertain' }], then: 'ask' }], otherwise: 'allow' },
        residual: '', dropped: [],
      }) as unknown as Parameters<typeof canEmit>[0]

      const pOf = (band?: [number, number]) =>
        emitBouncerPolicy(withBand(band)).split('\n').find(l => l.includes('p:'))!.trim()

      // The default band, stepped one representable double inward at both ends.
      expect(canEmit(withBand(), 'bouncer')).toEqual([])
      expect(flat).toContain(`the default \`[0.35, 0.65]\` emits \`${pOf()}\``)

      // Out of range is a WARNING and still emits, intersected with 0..1 — not a refusal.
      const over: [number, number] = [0.9, 1.2]
      const warns = canEmit(withBand(over), 'bouncer')
      expect(warns.map(i => [i.code, i.severity])).toEqual([['band_out_of_range', 'warn']])
      expect(flat).toContain(`\`[${over[0]}, ${over[1]}]\` emits \`${pOf(over)}\``)

      // These three are refusals, and the README says so by name.
      for (const bad of [[1.2, 1.5], [0.5, 0.5], [0, 1]] as [number, number][]) {
        const issues = canEmit(withBand(bad), 'bouncer')
        expect(issues.map(i => i.code), `band [${bad}]`).toEqual(['uncertain_unsupported'])
        expect(flat, `band [${bad}] named as refused`).toContain(`\`[${bad[0]}, ${bad[1]}]\``)
      }
    })

    it('is right about which target has a threshold grammar and which does not', async () => {
      const { canEmit } = await import('../src/index.js')
      // 1e-7 is inside [0,1] and serialises with an exponent, so only the target with a
      // serialised-threshold grammar can object to it.
      const tiny = {
        version: 1,
        decisions: [{ id: 'q', kind: 'noul', instructions: 'Is it bad?' }],
        reduce: { kind: 'rules', rules: [{ when: [{ id: 'q', op: 'gte', value: 1e-7 }], then: 'deny' }], otherwise: 'allow' },
        residual: '', dropped: [],
      } as unknown as Parameters<typeof canEmit>[0]
      expect(canEmit(tiny, 'bouncer').map(i => i.code)).toEqual(['threshold_unrepresentable'])
      expect(canEmit(tiny, 'toolgate')).toEqual([])
      expect(flat).toContain('toolgate writes a YAML number and has no such grammar, so it accepts `1e-7`')
    })

    it('is right that canEmit never throws, even on a rule with no `when`', async () => {
      const { canEmit, TARGETS } = await import('../src/index.js')
      const noWhen = {
        version: 1,
        decisions: [{ id: 'q', kind: 'noul', instructions: 'Is it bad?' }],
        reduce: { kind: 'rules', rules: [{ then: 'deny' }], otherwise: 'allow' },
        residual: '', dropped: [],
      } as unknown as Parameters<typeof canEmit>[0]
      for (const target of Object.keys(TARGETS)) {
        expect(() => canEmit(noWhen, target), target).not.toThrow()
      }
      expect(flat).toContain('`canEmit` never throws')
    })

    it('is right that the langchain target emits Python', async () => {
      const { emitLangchain } = await import('../src/index.js')
      const p = {
        version: 1,
        decisions: [{ id: 'q', kind: 'noul', instructions: 'Is it bad?' }],
        reduce: { kind: 'rules', rules: [{ when: [{ id: 'q', op: 'gte', value: 0.5 }], then: 'deny' }], otherwise: 'allow' },
        residual: '', dropped: [],
      } as unknown as Parameters<typeof emitLangchain>[0]
      expect(emitLangchain(p)).toContain('from langchain_typesafe import')
      expect(flat).toContain('(`langchain`, **Python**)')
    })
  })

  describe('the console blocks in the compiling section', () => {
    it('compiles the schema it prints into the output it prints', async () => {
      const { fromJsonSchema, emitNative } = await import('../src/index.js')
      const schema = JSON.parse(blockWith('json', '"frustration"'))
      const compiled = fromJsonSchema(schema)
      const emitted = emitNative(compiled as Parameters<typeof emitNative>[0]).split('\n')

      const shown = blockWith('console', '$ npx jevc compile triage.json').split('\n')
      expect(shown[0]).toBe('$ npx jevc compile triage.json')
      let checked = 0
      for (const line of shown.slice(1)) {
        // `...` is the README's own elision mark, and a blank line matches any output.
        if (line === '...' || line.trim() === '') continue
        expect(emitted, `README prints a line jevc does not emit: ${line}`).toContain(line)
        checked++
      }
      // Guard the guard: if the block is ever reduced to elisions, the loop above passes
      // vacuously and the section stops being checked at all.
      expect(checked, 'the compile block has become all elision').toBeGreaterThan(10)

      // The stderr block: the residual and the drop, both verbatim from the compile.
      // `frustration` is DROPPED, not elided, so the README owes the reason here — if the
      // 1..5 / 0..4 rebase argument ever changes wording, this is where it shows.
      const stderr = blockWith('console', 'residual:')
      expect(compiled.residual).not.toBe('')
      expect(stderr).toContain(compiled.residual)
      expect(compiled.dropped).toHaveLength(1)
      expect(compiled.dropped[0].quote).toBe('frustration')
      expect(stderr).toContain(`dropped: ${compiled.dropped[0].reason}`)
    })

    it('quotes the lift request the CLI actually prints', async () => {
      const { buildLiftRequest } = await import('../src/index.js')
      const shown = blockWith('console', '$ npx jevc compile AGENTS.md --lift').split('\n')
      // The README states the source document by its third line; build exactly that, so the
      // block is checked against the request a reader reproducing it would get.
      const request = buildLiftRequest(
        '# AGENTS.md\n\nNever delete tracked files. Stay inside the repo root.\n', 'AGENTS.md')
      let checked = 0
      for (const line of shown.slice(1)) {
        if (line === '...' || line.trim() === '') continue
        // The README truncates the tail of rule 1 with a trailing ` ...`.
        const body = line.replace(/ \.\.\.$/, '')
        expect(request, `README prints a lift line jevc does not: ${body}`).toContain(body)
        checked++
      }
      expect(checked, 'the lift block has become all elision').toBeGreaterThan(3)
    })

    it('quotes `explain` output, and is right about whose ellipsis is whose', () => {
      const shown = blockWith('console', '$ npx jevc explain').split('\n')
      const real = run(TSX, ['src/cli.ts', 'explain', 'user_explicitly_asked_to_commit'])
      for (const line of shown.slice(1)) {
        if (line.trim() === '') continue
        // The README elides the tail of `provenance:` itself; `replaces:` arrives already
        // truncated by the CLI, so that `...` is real output and must NOT be stripped.
        const body = line.startsWith('  provenance:') ? line.replace(/\.\.\.$/, '') : line
        expect(real, `README prints an explain line the CLI does not: ${body}`).toContain(body)
      }
      // ...which is only worth saying because the two ellipses differ: the CLI truncates
      // `replaces:` and does not truncate `provenance:`.
      expect(real).toMatch(/^ {2}replaces:.*\.\.\.$/m)
      expect(real).not.toMatch(/^ {2}provenance:.*\.\.\.$/m)
    })
  })

  describe('the ecosystem section', () => {
    it('quotes the prior-art sweep the design doc records, and dates it', () => {
      const design = readFileSync('docs/design.md', 'utf8').replace(/\s+/g, ' ')
      const hooks = design.match(/found \*\*(\w+)\*\* shipped Claude Code Jev guardrail hooks/)![1]
      const clis = design.match(/and \*\*(\w+)\*\* Jev CLIs/)![1]
      expect(flat).toContain(`found **${hooks}** shipped Claude Code Jev guardrail hooks`)
      expect(flat).toContain(`and **${clis}** Jev CLIs`)
      // A sweep with no date is a standing claim about a moving field; it must carry one.
      expect(flat).toMatch(/the sweep is dated \d{4}-\d{2}-\d{2}/)

      // "none of the fifteen" and "hook #8" are both derived from those two counts, and a
      // reader adds them up. Keep the arithmetic honest rather than hand-written.
      const word = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
        'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen']
      const n = (w: string) => word.indexOf(w)
      expect(n(hooks), `"${hooks}" is not a number word`).toBeGreaterThan(0)
      expect(flat).toContain(`none of the ${word[n(hooks) + n(clis)]} lowers anything`)
      expect(flat).toContain(`Building hook #${n(hooks) + 1}`)
    })

    it('quotes the dependency and the scripts a reader is told to run', async () => {
      const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
      expect(flat).toContain(`(\`${pkg.dependencies['@typesafe-ai/sdk']}\`)`)
      for (const script of ['typecheck', 'build', 'test', 'check:live']) {
        const invocation = script === 'test' ? 'npm test' : `npm run ${script}`
        expect(pkg.scripts[script], `README tells the reader to run ${invocation}`).toBeTruthy()
        expect(readme).toMatch(new RegExp(`^${invocation}\\b`, 'm'))
      }
    })

    it('is right that .env.example carries a placeholder and no key body', () => {
      const example = readFileSync('.env.example', 'utf8')
      expect(flat).toContain('`.env.example` carries a placeholder (`TYPESAFE_API_KEY=apikey_...`, no body)')
      expect(example.trim()).toBe('TYPESAFE_API_KEY=apikey_...')
      // The claim is about absence, so assert absence: no hex body anywhere in the file.
      expect(example).not.toMatch(/apikey_[0-9a-fA-F]/)
      // ...and the negation that keeps the placeholder itself out of the .env ignore rule,
      // without which the file the README points at would not be in a clean clone.
      expect(readFileSync('.gitignore', 'utf8')).toContain('!.env.example')
    })

    it('links only to docs that exist', () => {
      for (const [, target] of readme.matchAll(/\]\((docs\/[^)#]+|CHANGELOG\.md|examples\/[^)#]+)\)/g)) {
        expect(existsSync(target), `README links to ${target}, which is not in the repo`).toBe(true)
      }
    })

    // The README moves a reader's caveats to the end and then links back to them, so a
    // same-page link that resolves to nothing is not a cosmetic miss — it is the reader
    // being told "the limits are over there" and landing nowhere.
    it('resolves every same-page link to a heading it actually has', () => {
      const slug = (h: string) => h.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-')
      const headings = new Set([...readme.matchAll(/^#+\s+(.+)$/gm)].map(m => slug(m[1])))
      const targets = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map(m => m[1])
      expect(targets.length, 'the README stopped cross-linking its own notes').toBeGreaterThan(0)
      for (const t of targets) expect(headings, `README links to #${t}, which is not a heading`).toContain(t)
    })

    // The CLI table is the reference a reader works from, so it is derived from the binary's
    // own usage text rather than maintained by hand beside it.
    it('documents exactly the commands `jevc` offers, and counts them right', () => {
      const usage = readFileSync('src/cli.ts', 'utf8').match(/usage: jevc <command>\n([\s\S]*?)\n\nStart with/)
      expect(usage, 'the CLI usage block moved').not.toBeNull()
      const commands = new Set([...usage![1].matchAll(/^ {2}(\S+)/gm)].map(m => m[1]))
      const rows = new Set([...readme.matchAll(/^\| `jevc ([\w-]+)[^|]*\|/gm)].map(m => m[1]))
      expect(rows).toEqual(commands)
      expect(readme).toContain(`${['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'][commands.size]} commands.`)
    })

    // The first thing anyone sees is the hardest thing to keep honest, because nothing
    // downstream reads it. Every number and identifier drawn in the hero is recomputed from
    // the fixture and the example's own reducer, so a diagram that quietly goes stale fails
    // here rather than being believed by every reader of the repo's front page.
    it('draws a hero whose numbers come from the corpus', () => {
      const svg = readFileSync('docs/hero.svg', 'utf8')
      expect(readme.indexOf('](docs/hero.svg)'), 'the hero is not on the first screen').toBeLessThan(200)

      const f = corpus.find(x => x.id === 'commit-only-when-explicitly-asked')!
      for (const [id, a] of Object.entries(f.measured.answers)) {
        if (a.type !== 'noul' || !svg.includes(id)) continue
        // `>` so the id is a whole text node: `is_commit_operation` must not be satisfied by
        // the longer id that contains it, which is how a three-row table becomes a two-row one.
        expect(svg, `hero row ${id}`).toContain(`>${id}<`)
        expect(svg, `hero value for ${id}`).toContain(`>${a.noul}<`)
      }
      expect(svg).toContain(f.measured.model)
      expect(svg, 'the hero shows a verdict the reducer does not produce')
        .toContain(`>${runReducer(JSON.parse(readFileSync('examples/claude-code-hook/program.json', 'utf8')), f.measured.answers)}<`)

      // The first cut of this file arrived with the spaces stripped out of every text node —
      // "WHATYOUALREADYHAVE" — which is the AI-pseudo-text failure a hand-authored diagram
      // exists to avoid, and which is invisible in the markup unless something counts. Any
      // text node that is nothing but letters is a single word, so a long one is jammed
      // prose; the longest real one here is `decompose`.
      const nodes = [...svg.matchAll(/>([^<>]+)</g)].map(m => m[1].trim()).filter(Boolean)
      for (const w of nodes.filter(t => /^[A-Za-z]+$/.test(t))) {
        expect(w.length, `run-together text in the hero: "${w}"`).toBeLessThanOrEqual(12)
      }
      // ...and the short headings, which are under that cap even when jammed, by value.
      for (const phrase of ['WHAT YOU ALREADY HAVE', 'WHAT YOU GET', 'no model on this path',
        'computed in code, never asked of the model']) {
        expect(nodes, `the hero lost "${phrase}"`).toContain(phrase)
      }
    })
  })
})
