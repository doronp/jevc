# Security policy

`jevc` compiles rule files into gates that other people's agents run. A defect here is a
defect in someone's guardrail, which is the kind that stays quiet until it matters. Please
report anything you find.

## Reporting

Use GitHub's private vulnerability reporting — the **Report a vulnerability** button under
[Security](https://github.com/doronp/jevc/security) — or email doron.podoleanu@gmail.com.

Please do not open a public issue for a vulnerability first.

This is a solo project at 0.1.0, so the honest commitment is small and real rather than large
and aspirational: acknowledgement within 7 days, and a fix or a written explanation of why it
is not being fixed within 30. You will be credited unless you would rather not be.

## What is in scope

- A compiled program that does not enforce what its source rule file says — a rule that
  silently becomes a question nothing can fail, a reducer that returns `allow` on input that
  should deny, a carve-out that widens to cases it was never meant to cover.
- Anything in the emitters (`--emit sdk`, `bouncer`, `toolgate`) that produces an artifact
  weaker than the program it was compiled from.
- Parser or reducer behaviour on hostile input. `jevc` ingests rule files that may be
  attacker-influenced (a `CLAUDE.md` from a cloned repository, an `AGENTS.md` in a
  dependency). Crashes, hangs, or prompt-injection through a rule file that changes the
  resulting gate are all in scope.
- Anything that causes an API key to be logged, written to disk, or embedded in a compiled
  artifact.

## What is not in scope

- The accuracy of the underlying model. `jevc` compiles to a vendor API; a question the model
  answers badly is a corpus problem, not a vulnerability. File it as an issue.
- The recorded fixtures being out of date with respect to a newer model version. That is
  expected drift — see the corpus notes in the README.
- Findings from a scanner with no demonstrated impact.

## A note on the threat model

`jevc` is not a sandbox and does not claim to be one. It turns prose rules into deterministic
checks; it does not confine what an agent can do if those checks are bypassed or not consulted.
A gate that is never called is not a gate, and that is the integrator's responsibility. Reports
about defenses `jevc` never claimed are welcome as issues, but they are not vulnerabilities.
