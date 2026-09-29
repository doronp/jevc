---
name: jevc
description: Turn a rule from CLAUDE.md, AGENTS.md or a skill that the agent keeps ignoring into a gate you can test — narrow typed questions for TypeSafe's Jev model, the verdict computed in code, optionally installed as a Claude Code PreToolUse hook. Use when the user wants to enforce, gate or block on a written rule, turn prose rules into typed questions or a PreToolUse gate, asks why the agent ignores a CLAUDE.md or AGENTS.md rule, or mentions jevc or Jev.
---

# jevc

`jevc` compiles a written rule into a Jev program: a few narrow typed questions answered by
TypeSafe's System One model, plus a reducer that computes the verdict in ordinary code. No
model runs inside jevc: it prints a lowering request, you answer it, and jevc checks and
emits what you wrote. Work from the root of the user's project.

## 1. Find the command

Use `jevc` if it is on `PATH` (`jevc --version`). Otherwise run each command below as
`npx -y -p jev-compiler@latest jevc …`. The package is `jev-compiler` and the command is
`jevc`: plain `npx jevc` fails because no npm package is named `jevc`, and without `@latest`
npx resolves `jev-compiler` to a jevc checkout itself when run inside one and finds no `jevc`.

## 2. Scan

Run `jevc scan .` and show the user the table: one row per instruction file found, with
counts of rules, decidable, procedure and generation. It then names the file with the most
decidable rules and lists them by line number. Lift that file, or the one holding the rule
the user named. The counts are a text heuristic; read the listed lines.

## 3. Lift

Run `jevc compile <file> --lift`. It prints a lowering request: the Program shape, five
rules, the provenance rules, and the document between fence lines. Answer it yourself, JSON
only, following all of it. What decides whether the result is any good:

- Ask for evidence, never the verdict. A question answered allow/ask/deny/block is the one
  hard error; the verdict goes in `reduce`.
- A carve-out ("unless the user explicitly asks") is its own question and its own rule in
  `reduce`, never words inside another question.
- Every decision carries `source: {file, line, quote}`: `file` exactly as the fence names
  it, `line` 1-based where the quote begins, `quote` verbatim and at least 12 characters.
  Never paraphrase.
- Text the rule wants written goes in `residual`. A rule you cannot cite goes in `dropped`
  or is left out. An empty `decisions` array is a valid answer: the rule stays in the
  prompt. Do not compile it (`jevc compile` refuses it with `Nothing to emit`, and that is
  not an error to fix); go to Finish. Never add a decision to get past it.

If the user named one rule, return decisions for that rule only. Save it as `program.json`.

## 4. Check every citation yourself

`jevc compile program.json` checks shape, validation and lint, not citations: a
paraphrased quote or a wrong line compiles at exit 0, and the artifact prints the false
citation as its audit comment. (The library's `parseLiftResponse` checks them; the CLI calls
it only for `jevc compile --source`, which `jev-compiler` 0.1.0 does not have.) For each
decision, this must print the line the decision cites:

```bash
grep -nF -f /dev/stdin <file> <<'EOF'
<quote>
EOF
```

The quoted `'EOF'` passes the quote byte for byte, apostrophes and `$` included. If it
prints nothing, the quote is not verbatim; fix it. A quote that crosses a line break will
not match, so cite a phrase from one line.

## 5. Compile

```bash
jevc compile program.json            # sdk, the default: a TypeScript module on stdout
jevc compile program.json -o gate.ts # the same, written to a file
```

Other targets, if the user needs one: `--emit ai-sdk` (Vercel AI SDK), `--emit langchain`
(Python), `--emit json` (a wire request), or `jevc emit-policy --for bouncer program.json`
and `--for toolgate`. toolgate refuses a reducer it cannot express, and says why.

Problems print on stderr as `error: <path>: <message>` or `warn: <path>: <message>`. An
`error` exits 1 and writes nothing: fix `program.json` and rerun. A `warn` still writes the
artifact; pass it on to the user. `residual` is printed under `residual:`.

## 6. Optional: install it as a PreToolUse gate

Only if the user wants the rule enforced inside Claude Code. Ask once, before you change
anything in their project, and say what a yes does: `npm install jev-compiler@0.1.0` (a new
dependency, and a new `package.json` if the project has none), two files in
`.claude/gates/`, and a `PreToolUse` hook in `.claude/settings.json`. A gate that denies
tool calls changes how their agent works. Then follow the sample project's `.claude/`
exactly (`https://github.com/doronp/jevc/tree/534cb018a1d85046eb42894f8726c4f80efa1dc3/examples/sample-project/.claude`):

1. `npm install jev-compiler@0.1.0` in the user's project. `gate.mjs` imports it, and a global
   install is not importable. Without it the hook dies at import with exit 1, which Claude
   Code treats as a non-blocking error: the tool call goes ahead and the gate is off.
2. Fetch the sample gate and copy the program beside it:

   ```bash
   mkdir -p .claude/gates
   curl -fsSL https://raw.githubusercontent.com/doronp/jevc/534cb018a1d85046eb42894f8726c4f80efa1dc3/examples/sample-project/.claude/gates/gate.mjs -o .claude/gates/gate.mjs
   cp program.json .claude/gates/<name>.json
   ```

   The URL is pinned to the commit `jev-compiler` 0.1.0 was published from, so the gate
   matches the package you installed. In `gate.mjs`, change the dist import line to
   `import { evaluate, runReducer } from 'jev-compiler'` and point `HERE('./commit.json')`
   at `./<name>.json`. The tool filter, the `state` object and the denial `reason` are
   written for the sample's commit rule; rewrite them so the state carries the evidence
   this program's questions read.
3. Register it in `.claude/settings.json`, merged into any existing file rather than
   replacing it, and show the user what you wrote:

   ```json
   { "hooks": { "PreToolUse": [
     { "matcher": "Bash",
       "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/gates/gate.mjs" }] }
   ] } }
   ```

   Keep the quotes around `$CLAUDE_PROJECT_DIR`: unquoted, a project path with a space
   splits and the gate is off. `matcher` names the tools (`Bash`, or `Bash|Write|Edit`);
   widen it only if the program asks about those tools.
4. Run it once by hand, with a payload for a tool the gate handles:

   ```bash
   echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git status"}}' | node .claude/gates/gate.mjs
   ```

   It must print one `{"hookSpecificOutput":…}` line, or nothing for allow; a stack trace
   means the gate is not running. With no key it prints `"permissionDecision":"ask"`, and
   `jev gate error, failing ask: …` on stderr. It fails closed.

## The key, and replay

Live evaluation needs `TYPESAFE_API_KEY` in the environment Claude Code runs in. Never
write it to a file (not `settings.json`, not `.env`, not the gate) and never print it. If it
is missing, tell the user to export it in their shell.

`JEVC_REPLAY=1` answers only from recorded fixtures. The sample gate uses it to replay the
one recorded call `commit.json` was built from, and only inside a jevc checkout; in a copy
it fails closed to `ask`. It cannot answer a new program's questions.

## Finish

Tell the user three things:

1. Which rules became questions: each decision id and the `file:line` it cites.
2. Which stayed in the prompt, and why: procedure (an order of steps; it belongs in code)
   or generation (text to write; it went to `residual`).
3. Which reducer thresholds you guessed. Unless something measured them, that is all of
   them: a lift is a hypothesis until it is measured against real inputs.
