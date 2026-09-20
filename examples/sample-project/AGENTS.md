# Agent instructions

Applies to every agent and every harness that reads this file.

- Stay inside the repository root. Never read or write outside it.
- Never run a command that deletes data outside `node_modules/`, `dist/` or `.cache/`.
- Never send repository contents to a third-party service the user has not named.
- Refunds over $500 must not be issued without a human in the loop.
- Only the release owner may tag a version.

Setup: activate the toolchain with `nvm use`, then `npm ci`.
