# Examples

Every example runs offline against the recorded corpus. No API key, no network:

```bash
npx tsx examples/01-schema-to-jev.ts
```

| Example | Demonstrates | Prints |
| --- | --- | --- |
| [`01-schema-to-jev.ts`](01-schema-to-jev.ts) | The deterministic path: a 4-field JSON Schema lowered to Jev with no model in the loop. | The 3 compiled questions, the emitted TypeScript, the `reply` field left in the residual, and the lint result. |
| [`02-agents-md-guardrail.ts`](02-agents-md-guardrail.ts) | A `CLAUDE.md` rule enforced instead of hoped for: evidence questions plus a reducer in code. | The measured answers for `commit-only-when-explicitly-asked` (jev-1.13.0, 731 ms), the verdict computed from them, and the collapsed verdict head the program deliberately omits. |
| [`03-model-router.ts`](03-model-router.ts) | Cost routing decided before either model is called, and score answers in level-index space. | Two replayed router fixtures — including the one where the collapsed "which tier?" head picked the cheap tier at confidence 0.24 — plus the request JSON and its estimated input cost. |
| [`04-policy-emit.ts`](04-policy-emit.ts) | Emitting policy for incumbent guardrails, and refusing when a target cannot express the program. | A complete bouncer policy, toolgate's refusal of the same program with the reason, and `canEmit` rejecting a score decision. |
