import { describe, it, expect } from 'vitest'
import { emitNative } from '../src/emit/native.js'
import { emitJson } from '../src/emit/json.js'
import type { Program } from '../src/ir.js'

const p: Program = {
  decisions: [
    { id: 'is_destructive', kind: 'noul', instructions: 'Does it delete data?' },
    { id: 'blast_radius', kind: 'score', instructions: 'How wide?',
      criteria: ['one file', 'one directory', 'whole repo'] },
    { id: 'target', kind: 'choice', instructions: 'What is targeted?',
      criteria: { source: 'tracked source', build: 'regenerable output' } },
  ],
  reduce: { kind: 'rules', rules: [
    { when: [{ id: 'is_destructive', op: 'gte', value: 0.8 },
             { id: 'blast_radius', op: 'gte', value: 1.5 }], then: 'deny' }], otherwise: 'allow' },
  residual: '', dropped: [],
}

describe('emitNative', () => {
  it('emits score criteria as an as-const tuple', () => {
    const src = emitNative(p)
    expect(src).toMatch(/criteria: \["one file", "one directory", "whole repo"\] as const/)
  })

  it('emits the reducer as readable code, not as data', () => {
    const src = emitNative(p)
    expect(src).toMatch(/export function reduce/)
    expect(src).toMatch(/return "deny"/)
    expect(src).toMatch(/return "allow"/)
  })

  it('emits a provenance comment when source is present', () => {
    const withSrc: Program = { ...p, decisions: [{ ...p.decisions[0],
      source: { file: 'AGENTS.md', line: 34, quote: 'never delete tracked files' } }] }
    expect(emitNative(withSrc)).toMatch(/AGENTS\.md:34.*never delete tracked files/s)
  })

  it('emits an is condition as a choiceOf call, not a bare .choice access', () => {
    const withIs: Program = { ...p, reduce: { kind: 'rules', rules: [
      { when: [{ id: 'target', op: 'is', value: 'build' }], then: 'allow' }], otherwise: 'deny' } }
    const src = emitNative(withIs)
    expect(src).toContain('choiceOf(a, "target") === "build"')
    expect(src).not.toMatch(/\.choice\s*===/)
    expect(src).toMatch(/import \{ value, isUncertain, choiceOf \} from 'jevc'/)
  })

  it('emits a parseable literal when instructions contain a newline', () => {
    const withNewline: Program = { ...p, decisions: [
      { ...p.decisions[0], instructions: 'Line one\nLine two' },
    ] }
    const src = emitNative(withNewline)
    const match = src.match(/is_destructive: (\{[^}]*\}),/)
    expect(match).not.toBeNull()
    // A raw newline inside a single-quoted literal is a SyntaxError; JSON.stringify
    // escapes it to `\n`, which stays valid on one line.
    expect(() => new Function(`return ${match![1]}`)).not.toThrow()
  })

  it('emits structured (object) criteria descriptions as real JSON, not "[object Object]"', () => {
    const withObjectCriteria: Program = { ...p, decisions: [
      { id: 'severity', kind: 'score', instructions: 'How severe?',
        criteria: [{ tier: 'low' }, 'high'] },
      { id: 'owner', kind: 'choice', instructions: 'Who owns it?',
        criteria: { team: { detail: 'a team' }, solo: 'one person' } },
    ] }
    const src = emitNative(withObjectCriteria)
    expect(src).not.toMatch(/\[object Object\]/)
    expect(src).toContain('{"tier":"low"}')
    expect(src).toContain('{"detail":"a team"}')
  })

  it('emits noul criteria (true/false branches) inline', () => {
    const withCriteria: Program = { ...p, decisions: [
      { id: 'confirmed', kind: 'noul', instructions: 'Did the user confirm?',
        criteria: { true: 'explicit yes', false: 'no response' } },
    ] }
    const src = emitNative(withCriteria)
    expect(src).toContain(
      'confirmed: { type: \'noul\', instructions: "Did the user confirm?", criteria: {"true":"explicit yes","false":"no response"} },',
    )
  })
})

describe('emitJson', () => {
  it('produces a request that passes the contract validator', async () => {
    const { validateRequest } = await import('../src/contract.js')
    expect(validateRequest(emitJson(p, 'rm -rf dist'))).toEqual([])
  })

  it('defaults to jev-latest', () => {
    expect(emitJson(p, 'x').model).toBe('jev-latest')
  })

  it('carries noul criteria (true/false branches) verbatim', () => {
    const withCriteria: Program = { ...p, decisions: [
      { id: 'confirmed', kind: 'noul', instructions: 'Did the user confirm?',
        criteria: { true: 'explicit yes', false: 'no response' } },
    ] }
    const req = emitJson(withCriteria, 'x')
    expect(req.questions.confirmed).toEqual({
      type: 'noul',
      instructions: 'Did the user confirm?',
      criteria: { true: 'explicit yes', false: 'no response' },
    })
  })
})

// ---------------------------------------------------------------------------
// Round 3, owner A. Unit-level companions to the executed sdk checks at the end of
// emit-backends.test.ts: those compile and RUN the artifact, these pin the text that
// made it unparseable, so a red run names the construct instead of a tsc exit code.
// ---------------------------------------------------------------------------

describe('emitNative, hostile-but-legal Programs', () => {
  it('emits `if (true)` for an empty conjunction, not the unparseable `if ()`', () => {
    const always: Program = { ...p, reduce: { kind: 'rules',
      rules: [{ when: [], then: 'ignore' }], otherwise: 'handle' } }
    expect(emitNative(always)).toContain('if (true) return "ignore"')
  })

  it('defines `__proto__` with a computed key, the only form that is not the setter', () => {
    // JSON.parse, because a `{ __proto__: ... }` literal in THIS file is the setter too.
    const proto: Program = { ...p, decisions: [
      { id: '__proto__', kind: 'noul', instructions: 'Touches credentials?' },
      { id: 'dept', kind: 'choice', instructions: 'Which team?',
        criteria: JSON.parse('{"__proto__":"platform","billing":"payments"}') },
    ] }
    const src = emitNative(proto)
    expect(src).toContain('["__proto__"]: { type: \'noul\'')
    expect(src).toContain('["__proto__"]: "platform"')
    // The carried copy is spliced in as an EXPRESSION, where a "__proto__" key inside
    // JSON.stringify's output is the setter as well; JSON.parse makes it data again.
    expect(src).toContain('export const program = JSON.parse(')
  })

  it('flattens every line terminator out of a provenance comment, file and line included', () => {
    const inj: Program = { ...p, decisions: [{ ...p.decisions[0],
      source: { file: 'a.md\u2028  injected: 1,', line: 4, quote: 'one\u2029two\nthree' } }] }
    const line = emitNative(inj).split('\n').find(l => l.includes('// from'))
    expect(line).toBe('  // from a.md   injected: 1,:4 — "one two three"')
  })

  it('comments the residual line by line, so a */ in it cannot end the comment', () => {
    const r: Program = { ...p, residual: 'Escalate /assets/*/icon.png.\u2028raise = 1' }
    const tail = emitNative(r).split('\n').filter(l => l !== '').slice(-3)
    expect(tail).toEqual([
      '// Still requires a generative model:',
      '// Escalate /assets/*/icon.png.',
      '// raise = 1',
    ])
  })
})

describe('emitJson, hostile-but-legal Programs', () => {
  // Green before this round too: json.ts already used Object.fromEntries. Pinned so the
  // next person who "simplifies" it to a `questions[d.id] = ...` loop gets a red test
  // rather than a wire request quietly one question short.
  it('keeps a `__proto__` question as an own key on the wire', () => {
    const proto: Program = { ...p, decisions: [
      { id: '__proto__', kind: 'noul', instructions: 'Touches credentials?' },
    ] }
    const req = emitJson(proto, 'x')
    expect(Object.getOwnPropertyNames(req.questions)).toEqual(['__proto__'])
    expect(JSON.stringify(req)).toContain('"__proto__":{"type":"noul"')
  })
})
