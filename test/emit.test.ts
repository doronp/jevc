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
    expect(src).toMatch(/criteria: \['one file', 'one directory', 'whole repo'\] as const/)
  })

  it('never emits a widened string[] annotation', () => {
    expect(emitNative(p)).not.toMatch(/string\[\]/)
  })

  it('emits the reducer as readable code, not as data', () => {
    const src = emitNative(p)
    expect(src).toMatch(/export function reduce/)
    expect(src).toMatch(/return 'deny'/)
    expect(src).toMatch(/return 'allow'/)
  })

  it('emits a provenance comment when source is present', () => {
    const withSrc: Program = { ...p, decisions: [{ ...p.decisions[0],
      source: { file: 'AGENTS.md', line: 34, quote: 'never delete tracked files' } }] }
    expect(emitNative(withSrc)).toMatch(/AGENTS\.md:34.*never delete tracked files/s)
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
})
