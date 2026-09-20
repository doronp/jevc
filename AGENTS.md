# AGENTS.md

`jevc` compiles natural-language rules into **Jev programs**: a few narrow typed questions
answered by TypeSafe's System One model, plus a reducer that computes the verdict in
ordinary code. Read [README.md](README.md) first — it is the spec, and every number in it
is recomputed from `fixtures/` by `test/examples.test.ts`.

## Setup

```bash
npm install && npm run build   # Node >= 20; >= 22 to run the tests
npm test                       # offline: no key, no network, no quota
npm run typecheck              # tsc over src + test
npm run gallery                # regenerate examples/GALLERY.md from fixtures/
```

Run these from the repository root. `npm run check:live` is the only command that talks to
the network; it needs `TYPESAFE_API_KEY` and must never be wired into `npm test`.

## Rules

**Never write an API key to a file.** `TYPESAFE_API_KEY` lives in the environment and
nowhere else. `.env.example` carries the placeholder only, and CI scans every commit in
history for a real one.

**A fixture is a recording, not a document.** `state` is the exact input a measured response
was produced against, and `measured.answers` is what came back on 2026-09-18 from
`jev-1.13.0`. Never hand-edit either to make something pass. If a recording is wrong, it is
re-recorded with `check --live`, or it is deleted. Paraphrasing a `state` leaves the corpus
asserting measured answers for a prompt nobody measured.

**Measured or it does not ship.** Any number in the README, in a lint message, or in a doc
must be a value a shipped fixture actually records. `test/ir.test.ts` enforces this for lint
messages: a rule whose evidence leaves the corpus is removed, not reworded.

**Quote rule text only from Apache-2.0 or MIT sources,** and add the row to
[`fixtures/ATTRIBUTION.md`](fixtures/ATTRIBUTION.md) in the same change.

**`docs/targets/*.md` is the normative contract for the emitters,** not the other way round.
The conformance suites transcribe each consumer's own reducer and assert ours agrees over a
grid; when an emitter and a target doc disagree, the doc wins until the doc is updated.

## Layout

| Path | What is in it |
| --- | --- |
| `src/ir.ts` | the IR, the reducer, and `lintProgram` — six checks, each grounded in a measured fixture |
| `src/emit/` | one emitter per target: `sdk`, `json`, `ai-sdk`, `langchain`, `bouncer`, `toolgate` |
| `fixtures/` | 58 recorded fixtures across five domains, plus `ATTRIBUTION.md` |
| `docs/targets/` | the consumer contract each emitter is written against |
| `docs/history/` | kept unedited for provenance; do not maintain it |
| `examples/` | runnable end-to-end examples, and `GALLERY.md` (generated) |

## About this file

It is prose, which is the problem `jevc` exists for — nothing above is enforced by anything.
`npx jevc scan .` finds it, and `npx jevc compile AGENTS.md --lift` turns it into a lowering
request: the rules that can become typed questions, and the ones that cannot.
