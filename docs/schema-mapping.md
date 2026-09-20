# What compiles from a schema, and what does not

The full mapping behind `jevc compile <schema.json>`. The [README](../README.md#compiling-a-schema)
carries the four rows that cover almost every real schema; this file is the rest.

`fromJsonSchema` is pure and property-tested — no model, no network. Zod, Anthropic tool
`input_schema`, OpenAI strict `json_schema` and MCP `inputSchema` all normalize to JSON
Schema first, so there is one mapper.

| Schema construct | Maps to | Note |
| --- | --- | --- |
| `boolean` | `noul` | `description` becomes the instructions |
| `string` + `enum` | `choice` | enum members become criteria keys, with no per-member description (`null`). A non-string member is rendered with `JSON.stringify`, so `{a: 1}` becomes the option name `{"a":1}`; two members that render to the same name are **dropped**, not merged |
| `oneOf`/`anyOf` of `const` | `choice` | a const union is an enum, and each member's own `description` becomes that option's criteria value — the one spelling that carries per-option prose |
| `allOf` | merged, then mapped | members compose into one effective schema, which is what a `$ref` plus local overrides becomes once resolved |
| `anyOf`/`oneOf` of `[X, null]`, or `type: ["X", "null"]` | mapped as `X` | the Pydantic v2 and OpenAI strict spelling of an optional field; a union of two *decidable* branches names no single decision and stays **dropped** |
| `integer` + `minimum: 0`/`maximum`, span 2..10 | `score` | one level per value, labelled `<dotted id> = i` (`a.risk = 0`) — `i` is both the schema's value and the answer's level index. Those labels carry no meaning, and `lintProgram` says so on every one of them: `score_levels_undescribed`, a warning, with the two schema shapes that carry per-level prose instead. The draft-6+ numeric `exclusiveMinimum`/`exclusiveMaximum` are honoured, so `{minimum: 0, maximum: 5, exclusiveMaximum: 5}` is a 5-level score, not 6 |
| `integer` + `minimum` other than `0`, span 2..10 | **dropped** | a score answer is a level index `0..n-1`, so a threshold written in the schema's numbers fires `minimum` levels early and nothing in the `Program` records the offset; re-base the range, or bucket it into described levels |
| `integer` with gapped or unreadable bounds — `multipleOf` other than 1, or the draft-04 *boolean* `exclusiveMinimum`/`exclusiveMaximum` | **dropped** | a score's levels are the contiguous indices `0..n-1`, so a gap or a bound this mapper cannot read would offer the model a level the schema forbids |
| `array` of `enum` | **one `noul` per member** (`field.member`) | several labels may apply at once, and each noul answers its own label exactly once — which is why `uniqueItems` is ignored |
| `array` of `enum` with `minItems > 0` or `maxItems <` member count | **dropped** | one independent noul per label records no cardinality, so a declared single-select would ship as an unarbitrated multi-select. Spell a single-select as a plain `enum` |
| nested `object` | recurse; ids flattened dotted (`a.b`) | the questions map is flat, and the dotted id is load-bearing rather than cosmetic: it is what scopes the generated question text, and therefore what makes two sibling `risk` fields distinguishable to the model |
| a root with no `properties` — a `$ref` root, a bare-enum root, an array root, `{}` | **dropped, exit 1** | `$ref` is not resolved, and the drop names what it found rather than returning a silently empty `Program` |
| `string` (free) | **residual** | text generation |
| `array` of `object` | **residual** | unbounded extraction |
| `number` (any) | **dropped** | a continuous range has no discrete-level equivalent; bucket it, or model a 0..1 probability as a noul |
| `integer` spanning > 10 values | **dropped** | a score takes at most 10 levels |
| `null` | **dropped** | no decision to make |
| `const` | ignored | no decision to make, whatever it is attached to — `{type: 'boolean', const: true}` and `{enum: […], const: 'a'}` compile to nothing, not to a question with one answer |
| two things claiming one id — a property named `"a.b"` beside a nested `a: {b}`, or enum members `1` and `"1"` | **both dropped, exit 1** | the intent is unrepresentable as written rather than unsupported; renaming one of them fixes it |

## Notes

`required` and `default` are ignored: Jev answers every question in the map, always.

A **dropped** cell means one of two exit codes. An *unsupported* drop — no Jev equivalent —
prints as `dropped:` on stderr and the compile still succeeds at exit 0; the artifact is
everything Jev can represent of what you wrote. A *collision* drop prints as `error:` and
exits 1 without writing anything, however many other decisions survived, because there is
no artifact that asks what the schema asked. So does a schema that compiles to no decisions
at all. `fromJsonSchema` returns a `SchemaProgram`, whose `dropped` entries carry
`kind: 'collision' | 'unsupported'`; branch on `kind`, never on the reason prose.

A two-member enum whose values are yes/no-shaped *could* collapse to a `noul`. That
heuristic is **off by default** (`collapseBooleanEnums`) — silently changing a declared
output's shape is exactly the class of surprise this project exists to remove.
