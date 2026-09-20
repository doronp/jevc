# Attribution for the recorded corpus

The 60 fixtures in this directory are built from real material: rule files agent harnesses
actually ship, published benchmark datasets, vendor cookbooks, and papers. That is the point
of them — a corpus of invented rules would prove nothing about rules people write.

This file names every source whose **text** appears in a fixture, and its license. Sources
that were only *consulted* — a paper whose method shaped a question, a blog post that
described a failure mode — are cited in each fixture's own `provenance` field and are not
repeated here.

Licenses were read from the GitHub and Hugging Face APIs on 2026-09-20. Nothing here is legal
advice; it is a record of where the text came from so that anyone evaluating this repository
can check for themselves.

## Rule text quoted in `agent-harness-rules.json`

Each of these is a short, functional rule statement — the kind of sentence a project writes to
tell an agent what not to do. They are quoted so the corpus measures real rules rather than
rules written to be easy.

| Source | License | What appears here |
| --- | --- | --- |
| [supabase/supabase](https://github.com/supabase/supabase) `AGENTS.md` | Apache-2.0 | The generated-files rule and its path list (`never-hand-edit-generated-file`) |
| [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk) `AGENTS.md` | Apache-2.0 | Three package-manager rules (`ask-before-new-dependency-wrong-package-manager`) |
| [openai/codex](https://github.com/openai/codex) `AGENTS.md` | Apache-2.0 | The `just fmt` / `just test` rules (`no-done-without-running-checks`) |
| [apache/airflow](https://github.com/apache/airflow) `AGENTS.md` | Apache-2.0 | Two rules that contradict each other on `breeze` vs. direct `pytest` (`self-contradicting-rule-file-host-vs-container`) |
| [ghostty-org/ghostty](https://github.com/ghostty-org/ghostty) `AGENTS.md` | MIT | The "Issue and PR Guidelines" rules (`never-create-a-pr-even-when-asked`) |
| [withastro/astro](https://github.com/withastro/astro) `AGENTS.md` | MIT (`LICENSE`: *MIT, Copyright (c) 2021 Fred K. Schott*; GitHub's detector reports `NOASSERTION`) | The four "Surgical Changes" rules (`surgical-changes-no-drive-by-refactor`) |
| [nickbreaton/printable.photos](https://github.com/nickbreaton/printable.photos) `repos/AGENTS.md` | **No license file — see the note below** | Five `repos/` rules, in the `state` of `vendor-glob-false-positive` and `vendored-edit-authorization-ambiguous` |
| [netzstrategen/michi-test-template-clone](https://github.com/netzstrategen/michi-test-template-clone) `.claude/hooks/safety-write.sh` | No license file | Nothing verbatim. Its write-blocker's *behaviour* is described in the provenance of `vendor-glob-false-positive` and `never-commit-secrets-placeholder-discrimination`; the shell it was originally quoted from has been paraphrased out |
| [code.claude.com/docs/en/permissions](https://code.claude.com/docs/en/permissions) | Anthropic documentation, all rights reserved | One permission-rule split and one table row showing which `git push` spellings a `Bash(git push *)` rule does not match (`commit-only-when-explicitly-asked`, `no-push-to-main-any-spelling`) |

### Note on nickbreaton/printable.photos

That repository is public and carries **no LICENSE file**. Publishing source on GitHub is not
a grant of a license: GitHub's Terms of Service give every user the right to view a public
repository and to fork it within GitHub, and nothing more. So the five sentences reproduced
here — about 370 characters of functional rule text, fully attributed, used as a test input —
rest on fair use and their own triviality, not on permission. This is the only place in the
repository where that is true, and it is stated plainly rather than left for a reader to work
out.

It is quoted rather than paraphrased for one reason: those sentences are the **input** to a
recorded model response. Rewriting them would leave the corpus asserting measured answers for
a prompt that is not the prompt they were measured against, which is exactly the kind of
quiet dishonesty this project exists to make impossible. The choice is to keep the recording
truthful and be explicit about the source.

**If the author of that repository would prefer it not appear here, open an issue and it will
be removed and the two fixtures re-recorded against a substitute.** The same offer applies to
every source on this page.

## Dataset label names

| Dataset | License | What appears here |
| --- | --- | --- |
| [PolyAI/banking77](https://huggingface.co/datasets/PolyAI/banking77) (Casanueva et al., NLP4ConvAI 2020) | CC-BY-4.0 | Intent label names from the dataset card (`banking77-hierarchy-level1-group`, `banking77-hierarchy-level2-leaf`) |
| [CLINC150](https://huggingface.co/datasets/clinc/clinc_oos) (Larson et al., EMNLP 2019) | CC-BY-3.0 | The out-of-scope task shape and its published counts (`clinc150-out-of-scope-gate`) |

## Vendor cookbooks

Six fixtures reproduce question wording, criteria or reported results from TypeSafe's own
published cookbooks at `docs.typesafe.ai` — `sde_cascade`, `citation_check`,
`classifying_rag_passages`, `pre_parsed_value_extraction`, `date_extraction`, and
`hierarchical_classification`. These are the vendor's documentation for the API this project
compiles to; each fixture's `provenance` names the exact cookbook.

## Everything else

The remaining sources shaped a fixture's design without contributing text: RouteLLM
(Apache-2.0), AutoMix (Apache-2.0), deepagents and LangChain (MIT), tau-bench, IFEval,
SummEdits, CLAMBER, BFCL, Anthropic and LangChain engineering posts, Redis semantic-cache
guidance, Zendesk and Intercom product documentation, Invariant Labs and OpenRouter security
advisories, AWS Bedrock documentation, the AI Incident Database, and OWASP. Each is cited in
full in the `provenance` field of the fixture that used it.

The AWS credentials appearing in `never-commit-secrets-placeholder-discrimination`
(`AKIAIOSFODNN7EXAMPLE`, `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`) are the example values
published in AWS's own documentation. They are not credentials.
