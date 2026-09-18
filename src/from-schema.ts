import type { Decision, Program } from './ir.js'

export type JsonSchema = {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  const?: unknown
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  minimum?: number
  maximum?: number
  [k: string]: unknown
}

export type FromSchemaOptions = {
  /** Collapse a 2-member yes/no-shaped enum into a noul. Off by default: it changes the declared output shape. */
  collapseBooleanEnums?: boolean
}

const YES = new Set(['yes', 'true', 'y', 'affirmative'])
const NO = new Set(['no', 'false', 'n', 'negative'])

function constOptions(s: JsonSchema): string[] | null {
  if (Array.isArray(s.enum)) return s.enum.map(String)
  const union = s.oneOf ?? s.anyOf
  if (union && union.every(u => 'const' in u)) return union.map(u => String(u.const))
  return null
}

export function fromJsonSchema(schema: JsonSchema, opts: FromSchemaOptions = {}): Program {
  const decisions: Decision[] = []
  const dropped: Program['dropped'] = []
  const residualParts: string[] = []

  const visit = (props: Record<string, JsonSchema>, prefix: string): void => {
    for (const [key, s] of Object.entries(props)) {
      const id = prefix ? `${prefix}.${key}` : key
      const desc = s.description

      if (s.type === 'boolean') {
        decisions.push({ id, kind: 'noul', instructions: desc ?? `Is ${key} true?` })
        continue
      }

      const options = constOptions(s)
      if (options) {
        if (options.length < 2) {
          dropped.push({ reason: `"${id}" has ${options.length} option(s); a choice needs at least 2.`, quote: key })
          continue
        }
        const lower = options.map(o => o.toLowerCase())
        if (opts.collapseBooleanEnums && options.length === 2 &&
            lower.some(o => YES.has(o)) && lower.some(o => NO.has(o))) {
          decisions.push({ id, kind: 'noul', instructions: desc ?? `Is ${key} true?` })
          continue
        }
        decisions.push({
          id, kind: 'choice',
          instructions: desc ?? `Which ${key} applies?`,
          criteria: Object.fromEntries(options.map(o => [o, null])),
        })
        continue
      }

      // Bounded integer -> score, one level per value. A continuous `number` range has
      // no discrete-level equivalent — collapsing it would blur the level-index space
      // a score lives in with the 0..1 probability space a noul answer lives in.
      if (s.type === 'number' && typeof s.minimum === 'number' && typeof s.maximum === 'number') {
        dropped.push({
          reason: `"${id}" is a continuous range with no discrete-level equivalent for a score. Bucket it into described levels, or — if it is a 0..1 probability — model it as a noul, whose answer is itself a 0..1 probability.`,
          quote: key,
        })
        continue
      }

      if (s.type === 'integer' &&
          typeof s.minimum === 'number' && Number.isInteger(s.minimum) &&
          typeof s.maximum === 'number' && Number.isInteger(s.maximum)) {
        const n = s.maximum - s.minimum + 1
        if (n < 2) {
          dropped.push({ reason: `"${id}" spans ${n} value(s); a score needs at least 2 levels.`, quote: key })
          continue
        }
        if (n > 10) {
          dropped.push({ reason: `"${id}" spans ${n} values; a score takes at most 10 levels. Bucket it, or keep it in code.`, quote: key })
          continue
        }
        decisions.push({
          id, kind: 'score',
          instructions: desc ?? `Rate ${key}.`,
          criteria: Array.from({ length: n }, (_, i) => `${key} = ${s.minimum! + i}`),
        })
        dropped.push({
          reason: `"${id}" score levels are undescribed — generated from the numeric range. Describe each level concretely before shipping; an undescribed level destroys the distribution.`,
          quote: key,
        })
        continue
      }

      // Multi-label: array of enum -> one noul per label.
      if (s.type === 'array' && s.items) {
        const labels = constOptions(s.items)
        if (labels && labels.length >= 1) {
          for (const label of labels) {
            decisions.push({
              id: `${id}.${label}`, kind: 'noul',
              instructions: desc ? `${desc} Specifically: does "${label}" apply?` : `Does "${label}" apply to ${key}?`,
            })
          }
          continue
        }
        residualParts.push(`- ${id}: ${desc ?? `array of ${String(s.items.type)}`} (unbounded extraction — Jev cannot generate this)`)
        continue
      }

      // Nested object -> recurse, dotted ids.
      if (s.type === 'object' && s.properties) {
        visit(s.properties, id)
        continue
      }

      // A const encodes no decision at all.
      if ('const' in s) continue

      // Free text -> residual. This is a first-class output, not a failure.
      if (s.type === 'string') {
        residualParts.push(`- ${id}: ${desc ?? 'free text'} (text generation — Jev emits no strings)`)
        continue
      }

      dropped.push({ reason: `"${id}" (${String(s.type)}) has no System One equivalent.`, quote: key })
    }
  }

  visit(schema.properties ?? {}, '')

  const residual = residualParts.length
    ? `The following still require a generative model:\n${residualParts.join('\n')}`
    : ''

  return { decisions, reduce: { kind: 'rules', rules: [], otherwise: 'review' }, residual, dropped }
}
