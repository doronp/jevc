import type { EntryType, JevModel, JevQuestion, JevRequest } from '../contract.js'
import type { Decision, Program } from '../ir.js'

export function toQuestion(d: Decision): JevQuestion {
  if (d.kind === 'noul') {
    const criteria = d.criteria && !Array.isArray(d.criteria)
      ? (d.criteria as { true?: EntryType; false?: EntryType })
      : undefined
    return criteria
      ? { type: 'noul', instructions: d.instructions, criteria }
      : { type: 'noul', instructions: d.instructions }
  }
  if (d.kind === 'score') {
    if (!Array.isArray(d.criteria)) throw new Error(`Score "${d.id}" needs an ordered criteria array.`)
    return { type: 'score', instructions: d.instructions, criteria: d.criteria as readonly EntryType[] }
  }
  if (!d.criteria || Array.isArray(d.criteria)) throw new Error(`Choice "${d.id}" needs a criteria map.`)
  return { type: 'choice', instructions: d.instructions, criteria: d.criteria as Record<string, EntryType> }
}

export function emitJson(
  p: Program,
  state: JevRequest['state'],
  model: JevModel = 'jev-latest',
): JevRequest {
  return {
    model,
    state,
    // Object.fromEntries, and it has to stay that: `questions[d.id] = toQuestion(d)` on a
    // plain object literal hits Object.prototype's `__proto__` SETTER for a decision named
    // `__proto__` and re-parents the map instead of adding a key, so that question never
    // reaches the wire. fromEntries defines an own key for every id, including that one —
    // which is why `--emit json` is the target that renders such a Program correctly.
    // Duplicate ids still collapse here (last wins) and validateRequest cannot see it
    // afterwards, because a JSON object cannot hold the same key twice; `validateProgram`'s
    // `duplicate_id` is the gate, and cli.ts and askModel both run it before this point.
    questions: Object.fromEntries(p.decisions.map(d => [d.id, toQuestion(d)])),
  }
}
