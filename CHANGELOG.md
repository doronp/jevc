# Changelog

Notable changes to jevc. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — 2026-09-20

First release, so everything is new. The entries below are the behaviour changes landed by the
hardening and fix rounds (`1003b96..07fcf9d`) — recorded because artifacts emitted by the earlier
tree decide differently at runtime, and because anyone who built against that tree will hit the
first entry as an exception.

### Changed

- **BREAKING** — the emitted `ai-sdk` and `langchain` artifacts now throw/raise on a rule that reads
  a question the model did not answer, matching `sdk` and `runReducer`; they used to read the
  missing answer as "the condition did not hold", so a deny rule silently did not fire and the
  reducer fell through to `allow`. (`is` still reads an unanswered question as false in all four
  code targets; the two policy targets cannot express the refusal, now documented as a limitation.)
- `parseLiftResponse` returns the empty Program on any error-severity issue, including an unverified
  provenance citation — a lifted rule whose quote is not at the line it cites can no longer reach an
  emitted bouncer policy at exit 0 with an audit comment that lies about its own source line.
  Warn-severity issues (right quote, wrong line) still return the Program intact.
- `canEmit` refuses three things it used to pass: `threshold_not_a_number` (`deny: null` coerced past
  toolgate's own `0 <= ask <= deny <= 1` check and then denied every gated tool call),
  `instructions_not_string` (structured instructions made `canEmit` throw a TypeError instead of
  returning issues, and `emitBouncerPolicy` inherited the throw), and `id_empty` on the targets that
  put ids on the wire (the policy emitters wrote a `""`-keyed question the API rejects at request
  time).
- A non-number threshold is refused by all six targets, not just the two policy ones: `"0.5"` drew no
  diagnostic anywhere because `value(a, "q") >= "0.5"` is a legal coercing comparison. Finiteness
  stays policy-only — NaN and ±Infinity are numbers, and the code targets render them exactly.
- An uncertainty band is checked against 0..1: an endpoint outside the domain is intersected to the
  probabilities it can actually reach and reported as the new warn `band_out_of_range`, and a band
  holding no probability at all, or with a non-number endpoint, is refused. `[0.5, 1.5]` previously
  emitted `p: 0.5..1.4999999999999998`, which bouncer refuses at load — policy resolution stops and
  `on_error: passthrough` leaves no gate at all, at exit 0.

### Fixed

- CLI writes go out synchronously, so a piped artifact is no longer truncated at the 64 KiB pipe
  buffer — `emit-policy --for bouncer big.json | ssh host 'cat > policy.yaml'` used to deliver 43 of
  701 rules as loadable YAML with no terminal default, at exit 0. `EPIPE`, and only `EPIPE`, stays
  silent.
- A repeated flag is refused instead of first-match-wins: `-o a.ts -o b.ts` used to write `a.ts` and
  leave the stale `b.ts` live while the operator believed it had been replaced.
- `compile --lift` honours `-o`; it used to write to stdout and exit before `-o` was read, so a
  pipeline that wrote and then read the request file lifted the previous run's document.
- `compile --lift --emit` is refused — `--lift` prints a lowering request, not an artifact, and the
  combination used to print the request at exit 0 and ignore `--emit` entirely.
- `compile --lift` on an empty or whitespace-only document is refused, instead of asking an agent to
  lower nothing at exit 0.
- A key named `__proto__` survives into emitted TypeScript at all three splice sites (`native`,
  `ts-lowering`, the `ai-sdk` legend); it used to be read as the prototype setter and vanish, so the
  artifact asked a different question than the author wrote.
- A band with a negative endpoint, such as `[-0.1, 0.6]`, is refused with a message about its domain
  rather than the false claim that the band is empty.

### Internal

- Conformance suites (bouncer/toolgate policies loaded and decided, code artifacts executed under
  `tsc --strict` and `python3`), a CLI end-to-end suite over real child processes, and a seeded
  property sweep over all six targets. They pinned 21 reproduced live bugs as expected failures;
  all 21 are now closed and no `it.fails` remains.
- The suite no longer leaks temp directories: 101 per run before, 0 now.
- The ULP figure in `gridFor`'s comment was measured rather than inherited — 1e-9 is 18,014,399 ULPs
  at 0.4, not the 4.5 million the brief claimed.

- Every number in the README is recomputed from the repo and asserted against the README text by
  `test/examples.test.ts`, so a claim that rots fails the build. The five that cannot be pinned —
  vendor pricing, the live-probe column, repeated-call drift, the quote-length coincidence rates,
  and the vendor's option/level limits — now say so in the sentence that makes them.

Suite at this commit: 19 files, 990 tests, 990 passing, 0 expected-fail.
