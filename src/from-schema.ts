import type { Decision, Program } from './ir.js'

export type JsonSchema = {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  const?: unknown
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
  allOf?: JsonSchema[]
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

/** The declared type, normalized to the single type that decides the lowering.
 *
 *  `type` is allowed to be a list, and both dialects this mapper claims to accept use one:
 *  OpenAI strict `json_schema` mandates `["string","null"]` for an optional field and
 *  draft-2020-12 permits the list form anywhere. `null` is not a decidable branch (README:
 *  `null` -> dropped, no decision to make), so a list with exactly one non-null member
 *  lowers as that member. A list with two decidable members is a genuine union with no
 *  single lowering, and returns undefined so it falls through to `dropped` — whose reason
 *  prints the original `s.type`, never this normalization, or the diagnostic would name a
 *  type the schema never wrote. */
function soleType(s: JsonSchema): string | undefined {
  if (typeof s.type === 'string') return s.type
  if (!Array.isArray(s.type)) return undefined
  const decidable = s.type.filter(t => t !== 'null')
  return decidable.length === 1 ? decidable[0] : undefined
}

/** Collapse the composition keywords into one effective schema before dispatch.
 *
 *  `allOf` is the standard composition spelling (and what a `$ref` plus local overrides
 *  becomes once resolved), and Pydantic v2 emits `anyOf: [X, {type:'null'}]` for every
 *  Optional field — the same "X or null" `soleType` handles in list form. Neither wrapper
 *  is a decision of its own, and an untraversed one is the worst outcome this mapper has:
 *  every property nested under it disappears with no decision, no residual and no
 *  `dropped` entry to notice. Only the nullable union collapses; picking a branch of a
 *  real two-way union would invent a decision the schema did not make, so that keeps
 *  falling through to `dropped`. */
function flatten(s: JsonSchema): JsonSchema {
  let out = s

  const union = s.oneOf ?? s.anyOf
  // A union of consts is an enum — constOptions lowers it to a choice, so leave it there.
  if (union && union.length > 0 && !union.every(u => 'const' in u)) {
    const decidable = union.filter(u => soleType(u) !== 'null')
    if (decidable.length === 1) {
      const { oneOf: _oneOf, anyOf: _anyOf, ...own } = s
      // The wrapper's own keys win: Pydantic puts the field's description on the wrapper
      // and leaves the branch bare, so the branch is the shape and the wrapper is the prose.
      out = { ...decidable[0], ...own }
    }
  }

  if (out.allOf) {
    const { allOf, ...own } = out
    const merged: JsonSchema = { ...own }
    const properties: Record<string, JsonSchema> = {}
    for (const member of allOf) {
      const f = flatten(member)          // members compose too
      Object.assign(properties, f.properties)
      // Members fill in only what the outer schema left unsaid (typically `type`), so an
      // override written next to the `allOf` still beats the member it overrides.
      for (const [k, v] of Object.entries(f)) if (k !== 'properties' && !(k in merged)) merged[k] = v
    }
    Object.assign(properties, own.properties)
    if (Object.keys(properties).length) merged.properties = properties
    out = merged
  }

  return out
}

function constOptions(s: JsonSchema): string[] | null {
  // A `{type:'null'}` branch is the same "and it may be absent" the list-form type spells,
  // so it is stripped before asking whether the union is a const union — otherwise a
  // nullable enum reads as a mixed union and lowers to nothing at all.
  const union = (s.oneOf ?? s.anyOf)?.filter(u => soleType(u) !== 'null')
  const members = Array.isArray(s.enum) ? s.enum
    : union && union.length > 0 && union.every(u => 'const' in u) ? union.map(u => u.const)
    : null
  if (!members) return null
  // A `null` member is the absence of a value, not something to pick (README: `null` ->
  // dropped, no decision to make), and `String(null)` would hand the model a literal
  // "null" option to choose. Dedupe for the same reason: criteria is built with
  // `Object.fromEntries`, where duplicates collapse, so the arity guard has to count the
  // options that will actually exist or a 2-member enum can still emit a 1-option choice.
  return [...new Set(members.filter(m => m !== null && m !== undefined).map(String))]
}

export function fromJsonSchema(schema: JsonSchema, opts: FromSchemaOptions = {}): Program {
  const decisions: Decision[] = []
  const dropped: Program['dropped'] = []
  const residualParts: string[] = []

  const visit = (props: Record<string, JsonSchema>, prefix: string): void => {
    for (const [key, raw] of Object.entries(props)) {
      const s = flatten(raw)
      const id = prefix ? `${prefix}.${key}` : key
      const desc = s.description
      // Dispatch on the normalized type, never on `s.type` directly: every branch below
      // is a single-string compare, so a list-form type silently missed all of them.
      const type = soleType(s)

      if (type === 'boolean') {
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
      if (type === 'number' && typeof s.minimum === 'number' && typeof s.maximum === 'number') {
        dropped.push({
          reason: `"${id}" is a continuous range with no discrete-level equivalent for a score. Bucket it into described levels, or — if it is a 0..1 probability — model it as a noul, whose answer is itself a 0..1 probability.`,
          quote: key,
        })
        continue
      }

      if (type === 'integer' &&
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
        // A score ANSWER is a level index 0..n-1; a schema value is minimum..maximum. At
        // minimum 0 the two spaces coincide and a threshold means what it reads; anywhere
        // else every rule an author writes is off by `minimum`, and nothing in the emitted
        // Program records the offset — `criteria` is prose for the model, and
        // `validateProgram`'s score_threshold_out_of_range check measures thresholds
        // against 0..n-1, so for a 1..5 field it certifies the wrong number instead of
        // catching it. Of the three available fixes (index-honest labels / record the
        // offset in the Program / refuse), refusing is the shortest and leaves nothing to
        // misread: relabelling keeps both number spaces alive and hides the one the author
        // is reading off their own schema, and recording the offset needs a Program field
        // plus a new validator rule that then has to be got right too. So lower only the
        // ranges where value space IS index space, and name the re-base in the reason.
        if (s.minimum !== 0) {
          dropped.push({
            reason: `"${id}" is ${s.minimum}..${s.maximum}, but a score answer is a level index 0..${n - 1}: every threshold written in the schema's numbers would fire ${s.minimum} level(s) early, and neither the level labels nor validateProgram record the offset. Re-base it to 0..${n - 1} — the one range where the two spaces coincide — or bucket it into described levels.`,
            quote: key,
          })
          continue
        }
        decisions.push({
          id, kind: 'score',
          instructions: desc ?? `Rate ${key}.`,
          // minimum is 0 here, so `i` is both the schema's value and the answer's index.
          criteria: Array.from({ length: n }, (_, i) => `${key} = ${i}`),
        })
        // No `dropped` entry for a question that was kept: `dropped` is read as "what did
        // not compile", and this one is right there in `decisions`. The levels are still
        // undescribed — that warning belongs in `lintProgram`, over any program, not in a
        // field whose contract it breaks.
        continue
      }

      // Multi-label: array of enum -> one noul per label.
      if (type === 'array' && s.items) {
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
      if (type === 'object' && s.properties) {
        visit(s.properties, id)
        continue
      }

      // A const encodes no decision at all.
      if ('const' in s) continue

      // Free text -> residual. This is a first-class output, not a failure.
      if (type === 'string') {
        residualParts.push(`- ${id}: ${desc ?? 'free text'} (text generation — Jev emits no strings)`)
        continue
      }

      dropped.push({ reason: `"${id}" (${String(s.type)}) has no System One equivalent.`, quote: key })
    }
  }

  visit(flatten(schema).properties ?? {}, '')

  const residual = residualParts.length
    ? `The following still require a generative model:\n${residualParts.join('\n')}`
    : ''

  return { decisions, reduce: { kind: 'rules', rules: [], otherwise: 'review' }, residual, dropped }
}
