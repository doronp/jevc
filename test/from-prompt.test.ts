import { describe, it, expect } from 'vitest'
import { buildLiftRequest, parseLiftResponse } from '../src/from-prompt.js'

const AGENTS = `# Rules
Never commit unless the user explicitly asks.
Always run the linter before claiming a task is done.`

describe('buildLiftRequest', () => {
  it('includes the source text verbatim', () => {
    expect(buildLiftRequest(AGENTS, 'AGENTS.md')).toContain('Never commit unless')
  })
  it('states the decomposition law so the lifter cannot emit a verdict question', () => {
    const req = buildLiftRequest(AGENTS, 'AGENTS.md')
    expect(req).toMatch(/never.*verdict/i)
    expect(req).toMatch(/0\.13/)   // cites the measurement
  })
  it('demands provenance on every decision', () => {
    expect(buildLiftRequest(AGENTS, 'AGENTS.md')).toMatch(/source.*line/i)
  })
  it('tells the agent about `dependsOn`, since it is the only way rule 2 can fire', () => {
    expect(buildLiftRequest(AGENTS, 'AGENTS.md')).toContain('dependsOn')
  })
  it('does not overclaim enforcement: only the verdict rule is a hard error, the rest warn', () => {
    const req = buildLiftRequest(AGENTS, 'AGENTS.md')
    expect(req).toMatch(/hard error/i)
    expect(req).toMatch(/warning/i)
  })
})

describe('parseLiftResponse', () => {
  const good = JSON.stringify({
    decisions: [{ id: 'is_commit', kind: 'noul', instructions: 'Does the command create a commit?',
      source: { file: 'AGENTS.md', line: 2, quote: 'Never commit unless the user explicitly asks.' } }],
    reduce: { kind: 'rules', rules: [{ when: [{ id: 'is_commit', op: 'gte', value: 0.8 }], then: 'ask' }],
      otherwise: 'allow' },
    residual: '', dropped: [],
  })

  it('accepts a well-formed lifted program', () => {
    const { program, issues } = parseLiftResponse(good, AGENTS, 'AGENTS.md')
    expect(issues).toEqual([])
    expect(program.decisions[0].id).toBe('is_commit')
  })

  it('rejects malformed JSON with a useful message', () => {
    const { issues } = parseLiftResponse('{not json', AGENTS, 'AGENTS.md')
    expect(issues[0].code).toBe('lift_unparseable')
  })

  it('rejects a shape missing decisions/reduce with a useful message', () => {
    const { issues } = parseLiftResponse(JSON.stringify({ foo: 'bar' }), AGENTS, 'AGENTS.md')
    expect(issues[0].code).toBe('lift_malformed')
  })

  it('rejects a lifted collapsed verdict question', () => {
    const bad = JSON.stringify({
      decisions: [{ id: 'decision', kind: 'choice', instructions: 'What should we do?',
        criteria: { allow: 'ok', deny: 'no' } }],
      reduce: { kind: 'rules', rules: [], otherwise: 'ask' }, residual: '', dropped: [],
    })
    expect(parseLiftResponse(bad, AGENTS, 'AGENTS.md').issues.some(i => i.code === 'collapsed_verdict')).toBe(true)
  })

  it('rejects provenance that does not appear in the source', () => {
    const bad = JSON.stringify({
      decisions: [{ id: 'x', kind: 'noul', instructions: 'q',
        source: { file: 'AGENTS.md', line: 2, quote: 'a rule that was never written' } }],
      reduce: { kind: 'rules', rules: [], otherwise: 'ask' }, residual: '', dropped: [],
    })
    expect(parseLiftResponse(bad, AGENTS, 'AGENTS.md').issues[0].code).toBe('provenance_not_found')
  })

  it('accepts a quote re-wrapped across lines (whitespace-normalised match)', () => {
    const wrapped = JSON.stringify({
      decisions: [{ id: 'x', kind: 'noul', instructions: 'q',
        source: { file: 'AGENTS.md', line: 2, quote: 'Never commit\nunless   the user\nexplicitly asks.' } }],
      reduce: { kind: 'rules', rules: [], otherwise: 'ask' }, residual: '', dropped: [],
    })
    const { issues } = parseLiftResponse(wrapped, AGENTS, 'AGENTS.md')
    expect(issues.some(i => i.code === 'provenance_not_found' || i.code === 'provenance_too_short')).toBe(false)
  })

  // A fabricated decision can trivially satisfy a naive substring check by citing
  // an empty or single-character "quote" — `''` is a substring of every string,
  // and a single letter is present almost everywhere. Both must be rejected even
  // though they technically satisfy `haystack.includes(quote)`.
  it('rejects an empty quote rather than treating it as trivially found', () => {
    const bad = JSON.stringify({
      decisions: [{ id: 'x', kind: 'noul', instructions: 'q',
        source: { file: 'AGENTS.md', line: 2, quote: '' } }],
      reduce: { kind: 'rules', rules: [], otherwise: 'ask' }, residual: '', dropped: [],
    })
    expect(parseLiftResponse(bad, AGENTS, 'AGENTS.md').issues[0].code).toBe('provenance_too_short')
  })

  it('rejects a single-character quote rather than treating it as trivially found', () => {
    const bad = JSON.stringify({
      decisions: [{ id: 'x', kind: 'noul', instructions: 'q',
        source: { file: 'AGENTS.md', line: 2, quote: 'N' } }],
      reduce: { kind: 'rules', rules: [], otherwise: 'ask' }, residual: '', dropped: [],
    })
    expect(parseLiftResponse(bad, AGENTS, 'AGENTS.md').issues[0].code).toBe('provenance_too_short')
  })

  it('strips a fenced code block regardless of language tag or case', () => {
    const fenced = '```JavaScript\n' + good + '\n```'
    const { issues } = parseLiftResponse(fenced, AGENTS, 'AGENTS.md')
    expect(issues).toEqual([])
  })
})

// A model can plausibly return any of these shapes for "no decisions" or a
// half-formed answer. `validateProgram`/`lintProgram` assume well-typed input
// (true on the deterministic path, where `fromJsonSchema` builds it), so on this
// path `parseLiftResponse` must catch what would otherwise be an uncaught throw
// and turn it into a reportable issue instead.
describe('parseLiftResponse never throws on plausible malformed model output', () => {
  const throwingInputs: Array<[string, string]> = [
    ['a bare top-level null', 'null'],
    ['a null entry in decisions', JSON.stringify({
      decisions: [null],
      reduce: { kind: 'rules', rules: [], otherwise: 'ask' }, residual: '', dropped: [],
    })],
    ['a bare string entry in decisions', JSON.stringify({
      decisions: ['x'],
      reduce: { kind: 'rules', rules: [], otherwise: 'ask' }, residual: '', dropped: [],
    })],
    ['source as a string instead of an object', JSON.stringify({
      decisions: [{ id: 'x', kind: 'noul', instructions: 'q', source: 'AGENTS.md line 2' }],
      reduce: { kind: 'rules', rules: [], otherwise: 'ask' }, residual: '', dropped: [],
    })],
    ['reduce.rules missing entirely', JSON.stringify({
      decisions: [], reduce: { kind: 'rules', otherwise: 'ask' }, residual: '', dropped: [],
    })],
    ['a rule.when that is a bare condition object, not an array', JSON.stringify({
      decisions: [],
      reduce: { kind: 'rules', rules: [{ when: { id: 'x', op: 'gte', value: 1 }, then: 'ask' }], otherwise: 'ask' },
      residual: '', dropped: [],
    })],
  ]

  for (const [label, json] of throwingInputs) {
    it(`returns issues instead of throwing for: ${label}`, () => {
      let result: ReturnType<typeof parseLiftResponse> | undefined
      expect(() => { result = parseLiftResponse(json, AGENTS, 'AGENTS.md') }).not.toThrow()
      expect(result!.issues.length).toBeGreaterThan(0)
      expect(result!.issues.every(i => i.severity === 'error')).toBe(true)
    })
  }
})
