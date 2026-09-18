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
    questions: Object.fromEntries(p.decisions.map(d => [d.id, toQuestion(d)])),
  }
}
