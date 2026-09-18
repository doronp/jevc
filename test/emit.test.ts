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
