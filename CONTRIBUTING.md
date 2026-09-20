# Contributing

Issues and pull requests are welcome. This is a solo project at 0.1.0, so the useful thing
to know before you spend time is what this repository will and will not accept.

## The standard

**Measured or it does not ship.** Every number in the README, in a lint message, in a doc is
recomputed from `fixtures/` by the test suite. There is no way to add a claim without adding
the measurement behind it, and that is deliberate: a tool that turns prose into checkable
gates has no business shipping prose nobody checked.

A consequence worth stating plainly: if the fixture behind a lint rule leaves the corpus,
the rule leaves with it. That has already happened once — see the commit that cut
`polarity_disagreement`.

## Before you open a PR

```bash
npm install && npm run build
npm run typecheck
npm test              # offline: no key, no network, no quota
```

CI runs the same three on Node 22 and 24, plus a scan of every commit in history for a
leaked API key.

If you changed anything in `fixtures/`, also run `npm run gallery` and commit the
regenerated `examples/GALLERY.md`.

## What a change has to respect

- **Fixtures are recordings.** `state` is the exact input a measured response was produced
  against. Never edit a `state` or a `measured.answers` value to make an assertion pass —
  re-record with `jevc check --live`, or delete the fixture. See [AGENTS.md](AGENTS.md).
- **Rule text quoted in a fixture comes from Apache-2.0 or MIT sources only,** and the row
  goes into [`fixtures/ATTRIBUTION.md`](fixtures/ATTRIBUTION.md) in the same change.
- **`docs/targets/*.md` is the contract the emitters are written against.** An emitter
  change that contradicts a target doc needs the doc updated first, with the consumer
  behaviour that justifies it. The conformance suites transcribe each consumer's own reducer
  and execute the emitted artifact under it; that is where the interesting bugs were found,
  and none of them were crashes — all were exit 0 with a wrong verdict.
- **No API key in a file, ever.** Not in a test, not in a fixture, not in an example.

## Adding a fixture

A fixture is only worth adding if it was measured. The shape is one recorded call: the
natural-language prompt it replaces, its provenance with a named source, the questions, the
measured answers, and `expect` bands around them. Bands, not equalities — repeated identical
calls drift by about ±0.01.

Adversarial negatives are as valuable as positives. A corpus of only true positives rewards
a transpiler that denies everything.

## Commits

One change per commit, with a message that says why rather than what. The diff already says
what.

## Reporting a vulnerability

Do not open a public issue first — see [SECURITY.md](SECURITY.md).
