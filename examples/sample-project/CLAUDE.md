# Checkout service

Node service behind the payments gateway. Postgres, Redis, Stripe.

## Rules for agents working in this repo

- NEVER commit unless the user explicitly asks. Produce the message; let the human run it.
- Never delete tracked files. If something looks unused, say so and stop.
- Do not push to `main`. Open a branch and a PR.
- Ask before adding a dependency. We audit the lockfile by hand every release.
- Migrations under `db/migrations/` are append-only once merged. Write a new one instead.
- Any change touching `src/billing/` needs a test in the same commit.
- Secrets live in 1Password, never in the repo, never in an example, never in a log line.

## Working style

- Run `npm test` before you hand anything back.
- Read the file before you edit it.
- Prefer `pg` over an ORM here; the query shapes are load-bearing.
- Explain your reasoning when you pick one of two plausible schemas.
- Summarize the diff for the reviewer when you open a PR.
