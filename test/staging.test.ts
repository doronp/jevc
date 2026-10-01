import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { validateStaging, type StagedEntry } from '../scripts/rerecord.js'
import { unsurfacedTieBreaks, type Program } from '../src/ir.js'

// The staged question fixes are re-recorded live by scripts/rerecord.ts, one paid call per
// entry. Everything that can be wrong with them offline is caught here first, with the same
// validators the script runs before it calls anything: the wire contract, the program
// validator, and an expect that bounds every question with a band its type can carry.

const PATH = 'fixtures-staging/2026-09-30.json'
const text = readFileSync(PATH, 'utf8')
const doc = JSON.parse(text) as { base: string; entries: StagedEntry[] }

describe(PATH, () => {
  it('passes every validator the re-record runs, against the fixtures it replaces', () => {
    expect(validateStaging(doc, '.').problems).toEqual([])
  })

  it('stages nine fixtures, each once, on base b9b2ded', () => {
    expect(doc.base).toBe('b9b2ded')
    expect(doc.entries).toHaveLength(9)
    expect(new Set(doc.entries.map(e => e.id)).size).toBe(9)
  })

  // state and rationale are staged only where the fix itself requires it: a staged field
  // overwrites the recorded one, so an unneeded one is an unreviewed edit riding along.
  it('stages state only for the repaired diff, and rationale only where the fix changes it', () => {
    expect(doc.entries.filter(e => 'state' in e).map(e => e.id)).toEqual(['surgical-changes-no-drive-by-refactor'])
    expect(doc.entries.filter(e => 'rationale' in e).map(e => e.id).sort()).toEqual([
      'agent-claims-done-suite-still-failing',
      'reread-file-or-trust-stale-context-after-git-pull',
      'self-contradicting-rule-file-host-vs-container',
      'surgical-changes-no-drive-by-refactor',
      'underspecified-request-clarification-gate',
    ])
  })

  // Lift rule 6 on the fixes themselves: each staged question set carries every tie-break its
  // own llm_prompt states, by the same lint a lifted program gets (no reducer is staged, so
  // only the criteria can carry one).
  it('leaves no tie-break of its own llm_prompt unsurfaced', () => {
    for (const e of doc.entries) {
      const f = (JSON.parse(readFileSync(e.domain_file, 'utf8')).fixtures as Array<{ id: string; llm_prompt: string }>)
        .find(x => x.id === e.id)!
      const p = { decisions: Object.entries(e.questions).map(([id, q]) => ({ id, kind: q.type, instructions: q.instructions,
        criteria: (q as { criteria?: unknown }).criteria })), reduce: { kind: 'rules', rules: [], otherwise: 'n/a' },
        residual: '', dropped: [] } as unknown as Program
      expect(unsurfacedTieBreaks(f.llm_prompt, p), e.id).toEqual([])
    }
  })

  // Two nouls over one fact are scored independently and can disagree, with nothing to say
  // which wins: the underspecified request's time gap is asked once, as missing_time_window.
  // And a noul the action is derived from asks what the action turns on: "any failure outside
  // the task" escalates, so "at least one failure inside it" is the wrong question.
  it('asks the time gap once, and the out-of-scope failure the way the action decides it', () => {
    const u = doc.entries.find(e => e.id === 'underspecified-request-clarification-gate')!
    expect(Object.keys(u.questions)).toContain('missing_time_window')
    expect(Object.keys(u.questions)).not.toContain('ambiguity_temporal')
    const o = doc.entries.find(e => e.id === 'agent-claims-done-suite-still-failing')!
    expect(Object.keys(o.questions)).not.toContain('failure_relates_to_changed_file')
  })

  // The file holds what a re-record writes and nothing else: a key outside this shape would
  // ride into a public repo unread by the script, so the shape is checked, not the words.
  it('holds only the fields a re-record reads, and nothing shaped like a credential', () => {
    const top = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(top).sort()).toEqual(['base', 'entries', 'purpose'])
    expect(typeof top.purpose).toBe('string')
    const allowed = ['change_note', 'domain_file', 'expect', 'id', 'questions', 'rationale', 'state']
    for (const e of top.entries as Array<Record<string, unknown>>) {
      expect(Object.keys(e).filter(k => !allowed.includes(k)), String(e.id)).toEqual([])
      for (const k of ['change_note', 'domain_file', 'id', 'rationale'] as const) {
        if (k in e) expect(typeof e[k], `${String(e.id)}.${k}`).toBe('string')
      }
      expect(e.domain_file as string).toMatch(/^fixtures\/[a-z-]+\.json$/)
      for (const k of ['questions', 'expect'] as const) {
        expect(e[k] !== null && typeof e[k] === 'object' && !Array.isArray(e[k]), `${String(e.id)}.${k}`).toBe(true)
      }
    }
    expect(text).not.toMatch(/\bBearer\s+\S|\bsk-[\w-]{8,}|TYPESAFE_API_KEY\s*=/i)
    // A long run of letters AND digits is what an API key looks like; no prose word is one.
    expect(text).not.toMatch(/\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{32,}\b/)
  })
})
