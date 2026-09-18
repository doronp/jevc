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

      dropped.push({ reason: `"${id}" (${String(s.type)}) has no System One equivalent.`, quote: key })
    }
  }

  visit(schema.properties ?? {}, '')

  return {
    decisions,
    reduce: { kind: 'rules', rules: [], otherwise: 'review' },
    residual: '',
    dropped,
  }
}
