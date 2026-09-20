# What the validator catches

The API returns **200 OK** for each of these, with an answer that is wrong or meaningless.
That is the whole reason this layer exists: the failure is never a crash, it is exit 0 and a
wrong verdict. The [README](../README.md#what-the-validator-catches) carries the summary;
this file is the evidence.

The `API result` column is quoted from 25 live probe requests against `jev-1.13.0` on
2026-09-18, transcribed in [`design.md`](design.md) §3 and not reproducible offline. Every
row is pinned by `test/contract.test.ts` and refused locally.

| Probe | API result | Consequence | Caught by |
| --- | --- | --- | --- |
| `score` with 1 level | 200 — `score: 0.0, confidence: 1.0` | the documented 2-level minimum is not enforced server-side; you get a meaningless constant | `score_too_few_levels` |
| `choice` with 1 option | 200 — `confidence: 1.0` | degenerate certainty; always "right" | `choice_too_few_options` |
| duplicate question id | 200 — last definition silently wins | a JSON object cannot hold duplicate keys, so one question vanishes before it is sent | `duplicate_id`, in the IR |
| unknown field (`temperature`, `weight`) | 200 — silently ignored | a typo like `criterion` never errors; emitted keys must be whitelisted | `unknown_field` |
| nonexistent `` `backtick.path` `` | 200 — answered from the whole state | a typo'd path never errors, it silently degrades | `path_unresolved` — an **error** against a structured state, where the path is provably absent; a **warning** against a string state, where backticks are ordinary prose markup |
| empty `state: ""` | 200 | the model answers from no evidence | `state_empty` |

## Notes

The whitelist reaches one level further down than the probe did. A noul `criteria` key that
is neither `true` nor `false` — `criteria: { treu: … }` — raises `unknown_field` on both the
wire path (`validateRequest`) and the program path (`validateProgram`); it was not probed
live, but the description the author wrote for that outcome demonstrably never reaches the
model, and `emit-policy` used to write it away at exit 0.

Two more the wire types pin: `score` answers come back in **level-index space** (3 levels
→ 0.0..2.0, 10 levels → 0.0..9.0), which is the most likely integration bug — a team's
habitual 0..1 threshold either never fires or always does. And a `noul` carries **no
confidence field**; its probability *is* the answer, so its uncertainty rule is a band
around the middle (default `[0.35, 0.65]`), and `validateProgram` rejects
`belowConfidence` on a noul rather than ignoring it.

`Program` is obtained from untrusted JSON by a cast in three places, so both closed
vocabularies a cast cannot enforce are checked too: a `kind` outside noul/choice/score (which
`toQuestion` would ship as a *choice*), and a condition `op` outside gte/lte/is/uncertain.
`runReducer` used to execute that one as `lte` — the inverse of the rule, at exit 0 — and now
refuses it by name, but the code emitters still inline the same two-way comparison
(`value(a, id) ${op === 'gte' ? '>=' : '<='} …`) into the files they generate, so the IR check
is the only thing standing between an unknown op and an inverted generated gate.
`evaluate()` runs `validateProgram` before it spends a call, which it did not
before: a duplicate decision id used to collapse into one question inside `emitJson` before
the wire validator could count it, and the verdict came back computed from an answer to a
question the program did not contain.

The response crosses the same boundary in the other direction, and used to be a bare
`res.answers as Record<string, JevAnswer>`. `validateResponse(program, res)` checks it
against the program that asked: every declared decision answered, answered as the kind it was
asked as, numbers that are numbers and in range, and a `choice` that picked a declared
option. Score answers are *not* required to be integers — 23 of the 26 measured score answers
in `fixtures/` are fractional, because the answer is the probability-weighted expectation over
the level indices. `evaluate()` throws rather than reduce a response it cannot read;
`askModel()` returns the identical issue list instead of throwing, which is how
`check --live` reports a dropped answer rather than dying on it.

Budget: `validateRequest` refuses at **45,000 tokens** for the whole request and **32,000**
for state plus the longest single question, estimated at the measured ratio of 5.1
characters per token. The vendor documentation says 64k; ~45k returns
`400 max_tokens_exceeded` ([`design.md`](design.md) §3.3 records both, one line
apart), so a pre-flight check set to the documented number passes requests the API rejects —
the one outcome the check exists to prevent. Choice takes 2..255 options (reliability
degrades above ~240); score takes 2..10 levels.
