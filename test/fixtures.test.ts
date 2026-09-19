import { describe, it, expect, afterAll } from 'vitest'
import { readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadFixtures, assertExpectation, buildProgram, diffFixture } from '../src/check.js'
import type { Fixture, Expectation } from '../src/check.js'
import type { JevAnswer } from '../src/contract.js'

const fixtures = loadFixtures('fixtures')

/** Scratch dir for the one test below that needs a directory on disk. afterAll rather
 *  than try/finally so it is removed even if that test throws before its own cleanup. */
const tmpDirs: string[] = []
const mkTmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevc-fixtures-'))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

/** A minimally valid Fixture carrying only the fields buildProgram/diffFixture read. */
function fixture(id: string, answers: Record<string, JevAnswer>): Fixture {
  return {
    id, title: '', provenance: '', llm_prompt: '', rationale: '',
    state: {}, questions: {}, expect: {}, domain: '',
    measured: { model: 'jev-1.13.0', verdict: 'keep', answers },
  }
}

describe('fixture corpus', () => {
  it('loads all five domains', () => {
    expect(readdirSync('fixtures').filter(f => f.endsWith('.json'))).toHaveLength(5)
  })

  it('loads 60 measured fixtures', () => {
    expect(fixtures).toHaveLength(60)
  })

  it('every fixture records the natural-language prompt it replaces', () => {
    for (const f of fixtures) expect(f.llm_prompt.length).toBeGreaterThan(50)
  })

  it('every fixture carries provenance', () => {
    for (const f of fixtures) expect(f.provenance.length).toBeGreaterThan(10)
  })

  it('every measured response satisfies its recorded expectation', () => {
    for (const f of fixtures) {
      expect(assertExpectation(f.expect, f.measured.answers), `${f.id}`).toEqual([])
    }
  })

  it('no expectation asserts exact equality — answers drift +/-0.01', () => {
    for (const f of fixtures) {
      for (const clause of Object.values(f.expect)) {
        expect(Object.keys(clause), `${f.id}`).not.toContain('noul_eq')
        expect(Object.keys(clause), `${f.id}`).not.toContain('score_eq')
      }
    }
  })

  it('every fixture request passes the contract validator', async () => {
    const { validateRequest } = await import('../src/contract.js')
    for (const f of fixtures) {
      const issues = validateRequest({ model: 'jev-latest', state: f.state, questions: f.questions })
        .filter(i => i.severity === 'error')
      expect(issues, `${f.id}: ${issues.map(i => i.message).join('; ')}`).toEqual([])
    }
  })

  it('choice_in, prob_lte and confidence_lte actually gate — perturbing the recorded answer fails', () => {
    const f = fixtures.find(f => f.id === 'reread-file-or-trust-stale-context-after-git-pull')
    if (!f) throw new Error('fixture not found')

    // choice_in: the recorded choice is in {reread_targeted_range, reread_full}; move it out.
    const wrongChoice = JSON.parse(JSON.stringify(f.measured.answers)) as Record<string, JevAnswer>
    ;(wrongChoice.action as { choice: string }).choice = 'trust_context'
    expect(assertExpectation(f.expect, wrongChoice)).not.toEqual([])

    // prob_lte: trust_context must stay <= 0.1; recorded is 0.03 — push it over.
    const highProb = JSON.parse(JSON.stringify(f.measured.answers)) as Record<string, JevAnswer>
    ;(highProb.action as { probabilities: Record<string, number> }).probabilities.trust_context = 0.5
    expect(assertExpectation(f.expect, highProb)).not.toEqual([])

    // confidence_lte: must stay <= 0.7; recorded is 0.5 — push it over.
    const highConfidence = JSON.parse(JSON.stringify(f.measured.answers)) as Record<string, JevAnswer>
    ;(highConfidence.action as { confidence: number }).confidence = 0.9
    expect(assertExpectation(f.expect, highConfidence)).not.toEqual([])
  })

  it('loadFixtures names the offending file when a domain file has no top-level fixtures array', () => {
    const dir = mkTmp()
    writeFileSync(join(dir, 'broken.json'), JSON.stringify({ domain: 'broken' }))
    expect(() => loadFixtures(dir)).toThrow(/broken\.json/)
  })
})

describe('assertExpectation', () => {
  it('reports a violated lower bound', () => {
    const fails = assertExpectation({ a: { noul_gte: 0.8 } }, { a: { type: 'noul', noul: 0.4 } })
    expect(fails[0]).toMatch(/a: noul 0.4 < 0.8/)
  })
  it('passes a satisfied bound', () => {
    expect(assertExpectation({ a: { noul_gte: 0.8 } }, { a: { type: 'noul', noul: 0.9 } })).toEqual([])
  })
  it('checks a choice by name', () => {
    const fails = assertExpectation({ a: { choice: 'deny' } },
      { a: { type: 'choice', choice: 'allow', probabilities: { allow: 1, deny: 0 }, confidence: 1 } })
    expect(fails[0]).toMatch(/expected deny/)
  })

  it('reports a violated upper bound on confidence', () => {
    const fails = assertExpectation({ a: { confidence_lte: 0.5 } },
      { a: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 0.9 } })
    expect(fails[0]).toMatch(/a: confidence 0.9 > 0.5/)
  })
  it('passes a satisfied confidence upper bound', () => {
    expect(assertExpectation({ a: { confidence_lte: 0.5 } },
      { a: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 0.3 } })).toEqual([])
  })
  it('rejects confidence_lte against a noul, which carries no confidence', () => {
    const fails = assertExpectation({ a: { confidence_lte: 0.5 } }, { a: { type: 'noul', noul: 0.9 } })
    expect(fails[0]).toMatch(/a noul carries no confidence/)
  })

  it('checks choice_in against the option set', () => {
    expect(assertExpectation({ a: { choice_in: ['x', 'y'] } },
      { a: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 1 } })).toEqual([])
    const fails = assertExpectation({ a: { choice_in: ['x', 'y'] } },
      { a: { type: 'choice', choice: 'z', probabilities: { z: 1 }, confidence: 1 } })
    expect(fails[0]).toMatch(/expected one of x, y, got z/)
  })
  it('rejects choice_in against a non-choice answer', () => {
    const fails = assertExpectation({ a: { choice_in: ['x'] } }, { a: { type: 'noul', noul: 0.5 } })
    expect(fails[0]).toMatch(/expected a choice, got noul/)
  })

  it('checks prob_lte against a named probability', () => {
    expect(assertExpectation({ a: { prob_lte: { z: 0.1 } } },
      { a: { type: 'choice', choice: 'x', probabilities: { x: 0.9, z: 0.1 }, confidence: 1 } })).toEqual([])
    const fails = assertExpectation({ a: { prob_lte: { z: 0.1 } } },
      { a: { type: 'choice', choice: 'x', probabilities: { x: 0.5, z: 0.5 }, confidence: 1 } })
    expect(fails[0]).toMatch(/z=0.5 > 0.1/)
  })
  it('fails prob_lte loudly when the named probability key is missing rather than passing silently', () => {
    const fails = assertExpectation({ a: { prob_lte: { missing: 0.1 } } },
      { a: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 1 } })
    expect(fails[0]).toMatch(/no probability recorded for "missing"/)
  })

  it('reports an unrecognized expectation clause instead of silently ignoring it', () => {
    const exp = { a: { made_up_operator: 1 } } as unknown as Expectation
    const fails = assertExpectation(exp, { a: { type: 'noul', noul: 0.5 } })
    expect(fails[0]).toMatch(/unrecognized expectation clause "made_up_operator"/)
  })

  it('reports a missing answer rather than throwing', () => {
    const fails = assertExpectation({ a: { noul_gte: 0.5 } }, {})
    expect(fails[0]).toBe('a: no answer returned')
  })
  it('reports a type mismatch for noul_gte against a non-noul answer', () => {
    const fails = assertExpectation({ a: { noul_gte: 0.5 } },
      { a: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 1 } })
    expect(fails[0]).toMatch(/expected a noul, got choice/)
  })
  it('reports a type mismatch for noul_lte against a non-noul answer', () => {
    const fails = assertExpectation({ a: { noul_lte: 0.5 } },
      { a: { type: 'score', score: 1, legend: {}, probabilities: {}, confidence: 1 } })
    expect(fails[0]).toMatch(/expected a noul, got score/)
  })
  it('reports a type mismatch for score_gte against a non-score answer', () => {
    const fails = assertExpectation({ a: { score_gte: 1 } }, { a: { type: 'noul', noul: 0.5 } })
    expect(fails[0]).toMatch(/expected a score, got noul/)
  })
  it('reports a type mismatch for score_lte against a non-score answer', () => {
    const fails = assertExpectation({ a: { score_lte: 1 } }, { a: { type: 'noul', noul: 0.5 } })
    expect(fails[0]).toMatch(/expected a score, got noul/)
  })
  it('reports a type mismatch for choice against a non-choice answer', () => {
    const fails = assertExpectation({ a: { choice: 'x' } }, { a: { type: 'noul', noul: 0.5 } })
    expect(fails[0]).toMatch(/expected a choice, got noul/)
  })
})

describe('buildProgram', () => {
  it('preserves string-form instructions unchanged', () => {
    const f = fixture('f1', {})
    f.questions = { head: { type: 'noul', instructions: 'Is this true?' } }
    const program = buildProgram(f)
    expect(program.decisions[0]?.instructions).toBe('Is this true?')
  })
  it('preserves object-form instructions unchanged rather than stringifying them', () => {
    const f = fixture('f1', {})
    f.questions = { head: { type: 'noul', instructions: { claim: 'x', main_question: 'y' } } }
    const program = buildProgram(f)
    expect(program.decisions[0]?.instructions).toEqual({ claim: 'x', main_question: 'y' })
  })
})

describe('diffFixture', () => {
  it('reports a stable noul within threshold', () => {
    const f = fixture('f1', { a: { type: 'noul', noul: 0.9 } })
    const rows = diffFixture(f, { a: { type: 'noul', noul: 0.91 } }, 0.15)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'f1.a', recorded: 0.9, live: 0.91, status: 'stable' })
    expect(rows[0]?.delta).toBeCloseTo(0.01, 5)
  })
  it('reports a drifted noul past threshold', () => {
    const f = fixture('f1', { a: { type: 'noul', noul: 0.9 } })
    const rows = diffFixture(f, { a: { type: 'noul', noul: 0.5 } }, 0.15)
    expect(rows[0]?.status).toBe('drifted')
  })
  it('reports a stable choice', () => {
    const f = fixture('f1', { a: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 1 } })
    const rows = diffFixture(f, { a: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 1 } }, 0.15)
    expect(rows[0]?.status).toBe('stable')
  })
  it('reports a drifted choice', () => {
    const f = fixture('f1', { a: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 1 } })
    const rows = diffFixture(f, { a: { type: 'choice', choice: 'y', probabilities: { y: 1 }, confidence: 1 } }, 0.15)
    expect(rows[0]?.status).toBe('drifted')
  })
  it('reports a type change as broken', () => {
    const f = fixture('f1', { a: { type: 'noul', noul: 0.9 } })
    const rows = diffFixture(f, { a: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 1 } }, 0.15)
    expect(rows[0]).toEqual({ id: 'f1.a', recorded: 'noul', live: 'choice', delta: null, status: 'broken' })
  })
  it('reports an answer missing from the live response as broken, not silently dropped', () => {
    const f = fixture('f1', { a: { type: 'noul', noul: 0.9 } })
    const rows = diffFixture(f, {}, 0.15)
    expect(rows).toEqual([{ id: 'f1.a', recorded: 0.9, live: 'missing', delta: null, status: 'broken' }])
  })
  it('reports an answer new in the live response as broken', () => {
    const f = fixture('f1', {})
    const rows = diffFixture(f, { a: { type: 'noul', noul: 0.9 } }, 0.15)
    expect(rows).toEqual([{ id: 'f1.a', recorded: '-', live: 'new', delta: null, status: 'broken' }])
  })
})
