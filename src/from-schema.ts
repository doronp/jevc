import type { EntryType } from './contract.js'
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

/** The option name a member contributes to a choice, and the prose that defines it.
 *
 *  The key is the whole identity of the option: `criteria` is built from it with
 *  `Object.fromEntries`, the API sends it to the model as the thing to pick, and the
 *  reducer's `is` compares against it. `String()` is what shipped here, and it is the
 *  same collapse this repo has now hit five times — every object renders
 *  `"[object Object]"`, `[1,2]` and `"1,2"` render alike, `1` and `"1"` render alike —
 *  so an N-option choice is emitted as an (N-1)-option choice with two distinct schema
 *  values behind one key, and everything downstream validates clean. JSON is used for
 *  anything that is not already a string: stable, round-trippable, and distinct for
 *  distinct values. The collisions JSON cannot rule out (`{a,b}` vs `{b,a}` over-split
 *  rather than merge, and `NaN`/`Infinity` both render `null`) are caught by the
 *  identity check in `constOptions` and refused there. */
type Option = { key: string; description: EntryType }

function optionKey(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
}

type OptionSet = { options: Option[]; collision?: string }

function constOptions(s: JsonSchema): OptionSet | null {
  // A `{type:'null'}` branch is the same "and it may be absent" the list-form type spells,
  // so it is stripped before asking whether the union is a const union — otherwise a
  // nullable enum reads as a mixed union and lowers to nothing at all.
  const union = (s.oneOf ?? s.anyOf)?.filter(u => soleType(u) !== 'null')
  // A const union's members each carry their own `description`, and that description is
  // the only text saying what the option MEANS — dropping it leaves the model picking
  // between bare labels. `enum` has no per-member metadata, so those stay undescribed.
  const members: Array<{ value: unknown; description: EntryType }> | null =
    Array.isArray(s.enum) ? s.enum.map(value => ({ value, description: null }))
    : union && union.length > 0 && union.every(u => 'const' in u)
      ? union.map(u => ({ value: u.const, description: typeof u.description === 'string' ? u.description : null }))
      : null
  if (!members) return null

  // A `null` member is the absence of a value, not something to pick (README: `null` ->
  // dropped, no decision to make), and `String(null)` would hand the model a literal
  // "null" option to choose. Dedupe for the same reason: criteria is built with
  // `Object.fromEntries`, where duplicates collapse, so the arity guard has to count the
  // options that will actually exist or a 2-member enum can still emit a 1-option choice.
  // Deduping is only legitimate between members that are the SAME value, though: two
  // different values landing on one key is the silent merge above, and is refused.
  const options: Option[] = []
  const claimedBy = new Map<string, string>()
  let collision: string | undefined
  for (const m of members) {
    if (m.value === null || m.value === undefined) continue
    const key = optionKey(m.value)
    const identity = JSON.stringify(m.value) ?? String(m.value)
    const claimed = claimedBy.get(key)
    if (claimed === undefined) {
      claimedBy.set(key, identity)
      options.push({ key, description: m.description })
    } else if (claimed !== identity) {
      collision ??= `${claimed} and ${identity} both name the option "${key}"`
    }
  }
  return collision ? { options, collision } : { options }
}

/** The inclusive integer bounds the schema declares, however it spells them.
 *
 *  `exclusiveMinimum`/`exclusiveMaximum` are a second spelling of the same contiguous
 *  range (draft-6 onward writes them as numbers), and ignoring one is not harmless: a
 *  `{minimum: 0, maximum: 5, exclusiveMaximum: 5}` used to emit six levels, the last of
 *  them a value the schema forbids. */
function intBounds(s: JsonSchema): { lo: number; hi: number } | null {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const lows = [num(s.minimum), num(s.exclusiveMinimum) === undefined ? undefined : Math.floor(num(s.exclusiveMinimum)!) + 1]
    .filter((v): v is number => v !== undefined)
  const highs = [num(s.maximum), num(s.exclusiveMaximum) === undefined ? undefined : Math.ceil(num(s.exclusiveMaximum)!) - 1]
    .filter((v): v is number => v !== undefined)
  if (!lows.length || !highs.length) return null
  return { lo: Math.ceil(Math.max(...lows)), hi: Math.floor(Math.min(...highs)) }
}

/** Why a bounded integer's legal values are not the contiguous run `intBounds` reports.
 *
 *  A score's levels are the contiguous indices `0..n-1`, so a constraint that punches
 *  holes in the range — or one written in a spelling this mapper does not read — makes
 *  the mapper offer the model levels the schema forbids, at exit 0. */
function forbiddenLevels(s: JsonSchema): string | null {
  if ('multipleOf' in s && s.multipleOf !== 1) {
    return `declares multipleOf ${JSON.stringify(s.multipleOf)}, so its legal values have gaps in them, while a score's levels are the contiguous indices 0..n-1: every gap would be offered to the model as a level the schema forbids. Enumerate the legal values as an enum, or bucket them into described levels`
  }
  for (const k of ['exclusiveMinimum', 'exclusiveMaximum'] as const) {
    if (k in s && !(typeof s[k] === 'number' && Number.isFinite(s[k]))) {
      return `declares ${k}: ${JSON.stringify(s[k])}, the draft-04 boolean spelling this mapper does not read; the bound would be off by one and the excluded value offered as a level. Write it as the draft-6+ number, or use plain minimum/maximum`
    }
  }
  return null
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

      // Before every branch that would build a question: a `const` pins the value, so
      // there is no decision left to make. Checked after `boolean` and `enum`, a
      // `{type:'boolean', const:true}` compiled to "Is pinned true?" — an open question
      // inviting the model to contradict the one answer the schema already wrote down.
      if ('const' in s) continue

      // Instructions are built from the dotted `id`, never the leaf `key`: two nested
      // properties sharing a leaf name ({a:{risk},b:{risk}}) produced byte-identical
      // questions with the parent scope erased, so neither the model nor the reducer
      // could tell which of the two it was answering.
      if (type === 'boolean') {
        decisions.push({ id, kind: 'noul', instructions: desc ?? `Is ${id} true?` })
        continue
      }

      const optionSet = constOptions(s)
      if (optionSet) {
        if (optionSet.collision) {
          dropped.push({
            reason: `"${id}" has enum members that do not survive as distinct option names: ${optionSet.collision}. A choice is its option names — they are the criteria keys, they are what the model picks, and they are what the reducer's \`is\` compares — so two members behind one name is an option silently deleted from the set. Give the members distinct values.`,
            quote: id,
          })
          continue
        }
        const options = optionSet.options
        if (options.length < 2) {
          dropped.push({ reason: `"${id}" has ${options.length} option(s); a choice needs at least 2.`, quote: id })
          continue
        }
        const lower = options.map(o => o.key.toLowerCase())
        if (opts.collapseBooleanEnums && options.length === 2 &&
            lower.some(o => YES.has(o)) && lower.some(o => NO.has(o))) {
          decisions.push({ id, kind: 'noul', instructions: desc ?? `Is ${id} true?` })
          continue
        }
        decisions.push({
          id, kind: 'choice',
          instructions: desc ?? `Which ${id} applies?`,
          criteria: Object.fromEntries(options.map(o => [o.key, o.description])),
        })
        continue
      }

      // Bounded integer -> score, one level per value. A continuous `number` range has
      // no discrete-level equivalent — collapsing it would blur the level-index space
      // a score lives in with the 0..1 probability space a noul answer lives in.
      if (type === 'number' && typeof s.minimum === 'number' && typeof s.maximum === 'number') {
        dropped.push({
          reason: `"${id}" is a continuous range with no discrete-level equivalent for a score. Bucket it into described levels, or — if it is a 0..1 probability — model it as a noul, whose answer is itself a 0..1 probability.`,
          quote: id,
        })
        continue
      }

      const bounds = type === 'integer' ? intBounds(s) : null
      if (bounds) {
        const holes = forbiddenLevels(s)
        if (holes) {
          dropped.push({ reason: `"${id}" ${holes}.`, quote: id })
          continue
        }
        const n = bounds.hi - bounds.lo + 1
        if (n < 2) {
          dropped.push({ reason: `"${id}" spans ${n} value(s); a score needs at least 2 levels.`, quote: id })
          continue
        }
        if (n > 10) {
          dropped.push({ reason: `"${id}" spans ${n} values; a score takes at most 10 levels. Bucket it, or keep it in code.`, quote: id })
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
        if (bounds.lo !== 0) {
          dropped.push({
            reason: `"${id}" is ${bounds.lo}..${bounds.hi}, but a score answer is a level index 0..${n - 1}: every threshold written in the schema's numbers would fire ${bounds.lo} level(s) early, and neither the level labels nor validateProgram record the offset. Re-base it to 0..${n - 1} — the one range where the two spaces coincide — or bucket it into described levels.`,
            quote: id,
          })
          continue
        }
        decisions.push({
          id, kind: 'score',
          instructions: desc ?? `Rate ${id}.`,
          // the lower bound is 0 here, so `i` is both the schema's value and the answer's index.
          criteria: Array.from({ length: n }, (_, i) => `${id} = ${i}`),
        })
        // No `dropped` entry for a question that was kept: `dropped` is read as "what did
        // not compile", and this one is right there in `decisions`. The levels are still
        // undescribed — that warning belongs in `lintProgram`, over any program, not in a
        // field whose contract it breaks.
        continue
      }

      // Multi-label: array of enum -> one noul per label.
      if (type === 'array' && s.items) {
        const labelSet = constOptions(s.items)
        if (labelSet?.collision) {
          dropped.push({
            reason: `"${id}" is an array whose member values do not survive as distinct labels: ${labelSet.collision}. Each label becomes its own noul id, so two values behind one label is a question silently deleted. Give the members distinct values.`,
            quote: id,
          })
          continue
        }
        const labels = labelSet?.options ?? []
        if (labels.length >= 1) {
          // `minItems`/`maxItems` bound the CARDINALITY of the selection, and one
          // independent noul per label records no cardinality anywhere: each noul is
          // answered on its own, so a `maxItems: 1` single-select shipped as an
          // unarbitrated multi-select where every label may come back high at once, with
          // nothing in the Program, in validateProgram or in the reducer able to hold it
          // to one. (`uniqueItems` needs no entry — one noul per label already answers
          // each label exactly once, which is what `uniqueItems: true` asks for.)
          const maxItems = typeof s.maxItems === 'number' ? s.maxItems : undefined
          const minItems = typeof s.minItems === 'number' ? s.minItems : undefined
          const bound = [
            minItems !== undefined && minItems > 0 ? `minItems ${minItems}` : undefined,
            maxItems !== undefined && maxItems < labels.length ? `maxItems ${maxItems}` : undefined,
          ].filter(b => b !== undefined)
          if (bound.length) {
            dropped.push({
              reason: `"${id}" is an array of ${labels.length} enum members with ${bound.join(' and ')}, but it lowers to one independent noul per label and nothing in a Program can hold the set of true labels to a count. Spell a single-select as a plain enum instead — a choice picks exactly one — or remove the bound and accept the multi-select.`,
              quote: id,
            })
            continue
          }
          for (const label of labels) {
            decisions.push({
              id: `${id}.${label.key}`, kind: 'noul',
              instructions: desc ? `${desc} Specifically: does "${label.key}" apply?` : `Does "${label.key}" apply to ${id}?`,
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

      // Free text -> residual. This is a first-class output, not a failure.
      if (type === 'string') {
        residualParts.push(`- ${id}: ${desc ?? 'free text'} (text generation — Jev emits no strings)`)
        continue
      }

      dropped.push({ reason: `"${id}" (${String(s.type)}) has no System One equivalent.`, quote: id })
    }
  }

  const root = flatten(schema)
  const rootProps = root.properties ?? {}
  if (Object.keys(rootProps).length === 0) {
    // A root without `properties` used to return decisions:[], dropped:[], residual:'' —
    // a Program indistinguishable from the affirmative claim "this schema needs no
    // decisions". `$ref` roots, bare-enum roots, array roots and `{}` are all ordinary
    // shapes, and every one of them compiled to that silent nothing. Lowering the root
    // itself is not on offer: a decision needs an id and only a property name supplies
    // one, so inventing an id would name a question the schema never asked.
    const ref = typeof root.$ref === 'string' ? root.$ref : undefined
    dropped.push(ref
      ? {
        quote: ref,
        reason: `The root schema is a "$ref" to "${ref}". This mapper resolves no references, so every property behind it is invisible here and nothing was lowered. Inline the referenced schema, or pass the already-resolved one.`,
      }
      : {
        quote: '(root)',
        reason: `The root schema declares no properties to lower (its keys are: ${Object.keys(root).join(', ') || 'none'}), so this Program has zero decisions. That is not the same claim as "this schema needs no decisions" — wrap the value in an object with a named property, since every decision id comes from one.`,
      })
  }

  visit(rootProps, '')

  // Dotted ids are built by concatenation, so a property literally named "a.b" and a
  // nested `a: { b: … }` — or an array label — produce the same id. Every emitter turns
  // `decisions` into a JSON object (the wire question map, emitNative's `as const`
  // literal), so the later definition silently replaces the earlier one: two different
  // questions, one survivor, no trace. Neither can be kept, because a reducer condition
  // naming that id cannot say which of the two it means.
  const uses = new Map<string, number>()
  for (const d of decisions) uses.set(d.id, (uses.get(d.id) ?? 0) + 1)
  for (const [id, n] of uses) {
    if (n < 2) continue
    dropped.push({
      quote: id,
      reason: `"${id}" is defined ${n} times: a property whose name contains a literal "." collides with the dotted id of a nested property or of an array label. The questions map is a JSON object, so only the last definition would reach the model, and a reducer condition on "${id}" cannot say which question it means. Rename one of them.`,
    })
  }

  const residual = residualParts.length
    ? `The following still require a generative model:\n${residualParts.join('\n')}`
    : ''

  return {
    decisions: decisions.filter(d => (uses.get(d.id) ?? 0) < 2),
    reduce: { kind: 'rules', rules: [], otherwise: 'review' },
    residual,
    dropped,
  }
}
