# Examples

Every example runs offline against the recorded corpus. No API key, no network, and no
build step — they import from `../src/` directly, so `npx tsx` is enough. `npm test` runs
all four with `TYPESAFE_API_KEY` explicitly emptied, which is how the offline claim stays
true.

```bash
npx tsx examples/01-schema-to-jev.ts
npx tsx examples/02-agents-md-guardrail.ts
npx tsx examples/03-model-router.ts
npx tsx examples/04-policy-emit.ts
```

| Example | What you get | Prints |
| --- | --- | --- |
| [`01-schema-to-jev.ts`](01-schema-to-jev.ts) | Your existing output schema becomes a testable gate, with no model call anywhere in the compile. | The 3 compiled questions, the emitted TypeScript, the `reply` field left in the residual, and the lint result. |
| [`02-agents-md-guardrail.ts`](02-agents-md-guardrail.ts) | The `CLAUDE.md` rule your agent keeps ignoring, enforced instead of hoped for. | The prompt it replaces, the measured answers for `commit-only-when-explicitly-asked` (jev-1.13.0), the verdict computed from them, and the collapsed verdict head the program deliberately omits. |
| [`03-model-router.ts`](03-model-router.ts) | You stop paying for the big model on work the small one handles — decided before either is called. | Two replayed router fixtures — including the one where the collapsed "which tier?" head picked the cheap tier at confidence 0.24 — plus the request JSON and its estimated input cost. |
| [`04-policy-emit.ts`](04-policy-emit.ts) | Your rules reach a gateway you do not own the source of — or you find out it cannot express them, before you ship. | A complete bouncer policy, toolgate's refusal of the same program with the reason, and `canEmit` rejecting a score decision. |

One more directory, not a script — [`sample-project/`](sample-project/), which is the whole
loop in one place. A checkout service's `CLAUDE.md`, `AGENTS.md` and release skill, written
the way real ones are; that is what `jevc scan examples/sample-project` reads. The rule
lifted out of its `CLAUDE.md` is then installed back into it, as the `PreToolUse` hook its
own `.claude/settings.json` registers:

```bash
cd examples/sample-project && JEVC_REPLAY=1 node .claude/gates/gate.mjs < .claude/gates/payload.sample.json
```

[`GALLERY.md`](GALLERY.md) is all 58 fixtures on one page — every prompt jevc replaces, with
the questions and the measured answers. Generated from `fixtures/` by `npm run gallery`.
