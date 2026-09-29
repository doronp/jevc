# Changelog

Notable changes to jevc. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Breaking

Recompile every emitted artifact after upgrading: the model it asks for and the `langchain`
module's API are both baked in at compile time.

- Every default model is now the pinned `jev-1.13.0` (`PINNED_MODEL`, exported), not the
  `jev-latest` alias: `emitJson`, `askModel`/`evaluate` (and so the sample gate), and the model the
  emitted `ai-sdk` and `langchain` artifacts construct. All 58 fixtures were recorded against
  `jev-1.13.0`, so the alias asked a model nobody measured, and a vendor bump would have changed
  every compiled gate without a jevc release. `jev-latest` is still accepted when you name it.
  Recompile emitted artifacts to pick the pin up.
- `validateResponse` now checks who answered (`model_unexpected`). A response whose `model` is
  missing or not a Jev build is an error, so `evaluate()` throws and a gate fails closed; another
  Jev build is a warning and the verdict stands. The corpus and every threshold it records were
  measured on `jev-1.13.0` and must be re-measured for any other model. `JEVC_ALLOW_MODEL` (comma-separated
  exact IDs, read on every call) is the one opt-in: a named non-Jev model becomes a warning.
  `check --live` reports the answering model as a `<fixture>.model` row — `broken` for a non-Jev
  model, `drifted` for another Jev build or an allowed ID. `validateResponse` takes the allow-list
  as an optional third argument. `evaluate()` returns the warnings as `Verdict.warnings`, and
  the sample gate prints each on stderr and logs them in observe mode.
- The emitted `langchain` module targets `langchain-typesafe>=0.0.1a3` and names it in its
  header. a3 moved `questions` from the `TypeSafeClassifier` constructor into invoke's input and
  forbids extra fields, so the module jevc emitted before raised a `ValidationError` at import.
  It now constructs `TypeSafeClassifier(model=...)` and exports `classify(state)`, which invokes
  it with `{"state": state, "questions": ...}`: call `reduce(classify(state).answers)` where you
  called `reduce(classifier.invoke(state).answers)`. `scripts/check-langchain-a3.sh` (opt-in,
  needs uv, not part of `npm test`) runs an emitted module against the real 0.0.1a3 with a
  dummy key and a mock transport; it sends nothing to TypeSafe.

### Changed

- The emitted `ai-sdk` module honours `TYPESAFE_BASE_URL`, the API root jevc's own SDK and
  `langchain-typesafe` already read. `@ai-sdk/typesafe-ai` reads no env var for its base URL, so
  the module could only reach `api.typesafe.ai`; it now passes `baseURL: <root>/v1` when the
  variable is set and the provider default when it is not. Recompile to pick it up.
- A model ID a response names is JSON-quoted wherever jevc prints it — `model_unexpected`
  messages (cut at 64 characters) and the `check --live` summary line — so a control character
  arrives escaped. The summary reads `against no named model` when no response named one.
- The sample gate's `commit.json` routes an uncertain `user_explicitly_asked_to_commit` to
  `ask`: when the model cannot tell whether the human asked for the commit, the human confirms.
  The recorded case (0.06) is outside the band, so the replay still denies.
- Docs: the README says where answers come from and what happens when they stop —
  `TYPESAFE_BASE_URL` for an account or a local Jev-compatible server, thresholds measured on
  `jev-1.13.0` only, the vendor outage path per surface, pin retirement, `JEVC_MODE=observe`, and
  that `bouncer`/`toolgate` inherit the host's model. `docs/design.md`'s `escalate` flag is marked
  superseded.

### Added

- `jevc check --live --model <id> --threshold <n>`. `--model` is one of the models jevc can ask
  (default `jev-1.13.0`); `--model jev-latest` is how to see what a vendor bump would change.
  `--threshold` is the drift threshold (default 0.15), a number in [0, 1): noul and confidence
  deltas never exceed 1, so a larger value would report no drift on them. Both are validated
  before the key check and refused without `--live`.
- `JEVC_MODE=observe` in the sample gate: every call is let through, and the verdict it would
  have had is appended as one JSON line to `JEVC_OBSERVE_LOG` (default `observe.jsonl` beside the
  gate) — time, verdict, model, tool name, uncertain ids, answers and warnings; no state, no env values. A
  row whose verdict is the fail-closed fallback carries the error in `error` (null otherwise). A
  log that cannot be written does not block the call.
- `jevc compile <program.json> --source <doc>` runs `parseLiftResponse` on a lifted Program
  before compiling it: a citation that does not quote `<doc>` word for word, or names it
  differently from the lift request, prints the issue and exits 1 with nothing emitted. Without
  `--source` nothing changes. It is refused on a JSON Schema and with `--lift`.
- `scripts/pack-smoke.sh` (opt-in, not part of `npm test`): builds, `npm pack`s, installs the
  tarball into an empty directory, runs the sample gate there with its imports pointed at
  `jev-compiler` and its fixtures at `node_modules/`, asserts it denies the sample payload, runs
  the installed `jevc check`, then scans git history (the CI pattern) and the tracked tree plus
  the unpacked tarball for secret-shaped strings, printing locations only.

### Fixed

- The install steps told you to import the gate's runtime from `jevc`; the package is
  `jev-compiler`, and the import needs a project-local install.
- The README said 210 of the 321 numeric bounds have less than 0.15 of headroom; it is 207. Fifteen
  sit exactly on 0.15, and float subtraction put three of them under it. Two source comments
  quoted an older corpus (331 bounds, 23 of 26 fractional score answers) and now match
  `scripts/corpus-stats.ts`, which recomputes all of them offline.

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
