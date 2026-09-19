/**
 * Lowering shared by the TWO TypeScript emitters — `native.ts` and `ai-sdk.ts` — and by
 * nothing else. The `ts` in the name is the scope, not decoration: everything in here
 * encodes a rule of the **ECMAScript grammar**, and each of those rules is wrong for the
 * YAML and Python targets. `policy/bouncer.ts`, `policy/toolgate.ts` and `langchain.ts`
 * must not import this module.
 *
 * Both constants below used to be byte-identical copies in the two emitters. Nothing kept
 * them in step, and each one encodes something this project has already shipped wrong:
 * a question that vanished from an emitted object literal, and a comment a lifted quote
 * escaped from. One definition, imported twice, is the point of the file.
 */

/**
 * The key form for an id inside an emitted object literal.
 *
 * `__proto__` is the one id `JSON.stringify` cannot rescue. In an object initializer
 * `{ __proto__: v }` and `{ "__proto__": v }` are BOTH the prototype setter, not property
 * definitions, so the entry re-parents the object instead of becoming an own property: the
 * question simply vanishes from the emitted map. The artifact still compiles, `tsc --strict`
 * is clean, and the wire map is one question short — never sent, never answered, and a rule
 * naming it can never fire, at exit 0. A computed key is the only ordinary syntax that
 * defines an own property, and `{ ["__proto__"]: v } as const` still narrows.
 *
 * Reachable without malice: `from-schema.ts` uses a JSON Schema property name or enum
 * member as the id, so a prototype-pollution detector's own vocabulary produces it, and
 * `JSON.parse` does create an own `__proto__` key. Applies to choice OPTION names too, not
 * just decision ids — a choice that loses an option is a choice `is` can never match.
 *
 * Everything else goes through `JSON.stringify`, never a hand-rolled quoter: `EntryType` is
 * `string | object | array | null`, so `String(v)` renders "[object Object]" silently, and a
 * quoter that escapes only quotes and backslashes emits a raw newline inside a string
 * literal.
 */
export const tsIdKey = (id: string): string =>
  id === '__proto__' ? `[${JSON.stringify(id)}]`
  : /^[A-Za-z_$][\w$]*$/.test(id) ? id
  : JSON.stringify(id)

/**
 * Every ECMAScript line terminator, LS (U+2028) and PS (U+2029) included: a `//` comment
 * ends at any of them. Provenance quotes and residual prose are lifted VERBATIM out of a
 * human document, so they arrive with whatever separators that document had, and U+2028 is
 * what pasting from a PDF or from Word gives you. A terminator left in a comment ends it,
 * and the tail of the value lands in the surrounding literal as code.
 *
 * THREE NEAR-IDENTICAL REGEXES LIVE IN THIS REPO AND ALL THREE MUST STAY:
 *
 *   this module (native.ts, ai-sdk.ts)   \r\n | [\r \n U+2028 U+2029]
 *   policy/bouncer.ts, policy/toolgate.ts   \r\n | \r | \n
 *   langchain.ts                            \r\n | \r | \n
 *
 * They differ because the GRAMMARS differ, not because nobody got round to merging them.
 * YAML 1.2 line breaks are LF and CR only, and CPython's tokenizer does not treat U+2028 as
 * a terminator either — so in those two targets U+2028 is an ordinary character INSIDE a `#`
 * comment. Unifying this one down to `\r|\n` reinstates the comment-escape bug in the
 * TypeScript targets; unifying the other two up to this one splits a YAML or Python comment
 * at a character the consumer reads as text, silently changing the emitted document. Do not
 * merge them.
 *
 * Shared as a single `/g` object on purpose, and it is safe to share: the only two
 * operations the emitters perform on it are `String.prototype.replace` (which sets
 * `lastIndex` to 0 before it scans) and `String.prototype.split` (which clones the regex and
 * never reads `lastIndex`). A `.test()` or `.exec()` call on this object WOULD leak state
 * across the two emitters — use a local regex if you ever need one.
 */
export const TS_LINE_TERMINATORS = /\r\n|[\r\n\u2028\u2029]/g
