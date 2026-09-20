---
name: release
description: Cut a release of the checkout service
---

# Release

Cutting a release is irreversible once the tag is pushed, so the gates matter more
than the steps.

- A release must never go out with a failing test.
- Never release on a Friday after 16:00 local time.
- The changelog must mention every change touching `src/billing/`.
- Do not bump the major version without an approved RFC.

Steps:

1. Run `npm test` and `npm run typecheck`.
2. Write the changelog entry for this version.
3. Open the release PR and summarize the diff for the reviewer.
4. After the PR merges, the release owner tags it.
