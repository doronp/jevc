#!/usr/bin/env bash
# Opt-in, not part of `npm test`: proves the PUBLISHED shape works, which the suite cannot,
# because the suite runs from the repo root with dist/ and fixtures/ beside it. Builds,
# `npm pack`s, installs the tarball into an empty directory, and runs the sample gate there
# the way the install steps tell a user to: imports rewritten to "jev-compiler", fixtures
# read from node_modules. Replay only; nothing reaches TypeSafe and no key is read.
# Then a secret scan over the repo tree and the unpacked tarball. Needs npm registry access
# for the tarball's own dependencies.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== build"
(cd "$repo" && env -u TYPESAFE_API_KEY npm run --silent build)

echo "== pack"
tgz="$(cd "$repo" && env -u TYPESAFE_API_KEY npm pack --silent --pack-destination "$tmp")"
echo "$tgz"

echo "== install into an empty directory"
cd "$tmp"
echo '{"name":"pack-smoke","private":true,"type":"module"}' > package.json
env -u TYPESAFE_API_KEY npm install --silent --no-audit --no-fund "./$tgz"
gates="$repo/examples/sample-project/.claude/gates"
# Where the install steps put it, not beside node_modules: a flattened copy once passed with
# a fixtures path that is wrong in the real layout.
mkdir -p .claude/gates
cp "$gates/gate.mjs" "$gates/commit.json" "$gates/payload.sample.json" .claude/gates/
# The three repo-relative paths the install steps say to change. Every export the gate
# needs (evaluate, isUncertain, runReducer, loadFixtures) is a root export of the package.
# HERE() resolves against the gate file, not the cwd, so the fixtures path climbs out of
# .claude/gates to the project's node_modules.
sed -i.bak \
  -e "s#'../../../../dist/index.js'#'jev-compiler'#" \
  -e "s#'../../../../dist/check.js'#'jev-compiler'#" \
  -e "s#'../../../../fixtures'#'../../node_modules/jev-compiler/fixtures'#" \
  .claude/gates/gate.mjs
rm .claude/gates/gate.mjs.bak
if grep -n '\.\./\.\./\.\./\.\./' .claude/gates/gate.mjs; then fail "gate.mjs still reaches into the repo"; fi

echo "== gate, replayed, from $tmp"
out="$(env -u TYPESAFE_API_KEY JEVC_REPLAY=1 node .claude/gates/gate.mjs < .claude/gates/payload.sample.json)"
echo "$out"
node -e '
  const d = JSON.parse(process.argv[1]).hookSpecificOutput?.permissionDecision
  if (d !== "deny") { console.error("expected deny, got " + d); process.exit(1) }
' "$out" || fail "installed gate did not deny the sample payload"

echo "== jevc check, installed, from $tmp"
env -u TYPESAFE_API_KEY ./node_modules/.bin/jevc check | tail -n 1

echo "== secret scan"
mkdir unpacked && tar -xzf "$tgz" -C unpacked
# 1. The CI scan, as CI runs it, over every commit. -l prints where, never the match.
# git grep exits 1 for "no match" and >1 for "could not search"; only 1 is clean.
revs="$(cd "$repo" && git rev-list --all)" || fail "git rev-list failed; history not scanned"
rc=0; (cd "$repo" && git grep -lIEi 'apikey_[0-9a-f]{16}' $revs --) || rc=$?
case $rc in
  0) fail "a TypeSafe key shape is in history (the .github/workflows/ci.yml scan)" ;;
  1) echo "ci pattern, git history: clean" ;;
  *) fail "git grep exited $rc; history not scanned" ;;
esac
# 2. The same pattern and three heuristics over the tracked tree and the tarball. A hit
# prints file:line and 6 characters, never the value.
# ponytail: regex heuristics, not a scanner. fixtures/ records fake secrets as test
# inputs, package-lock.json holds integrity hashes and docs/targets/ pins commit and file
# hashes, so the entropy check skips those three; gitleaks with an allow-list is the upgrade.
(cd "$repo" && git ls-files -z | xargs -0 -I{} printf '%s\n' "$repo/{}") > files.txt
find unpacked -type f >> files.txt
node - files.txt <<'JS'
const { readFileSync } = require('node:fs')
const files = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean)
const PLACEHOLDER = /^(apikey_\.\.\.|dummy|\.\.\.|\$.*|<.*>)$/
const entropy = s => {
  const n = {}; for (const c of s) n[c] = (n[c] ?? 0) + 1
  return Object.values(n).reduce((h, k) => h - (k / s.length) * Math.log2(k / s.length), 0)
}
const skipEntropy = f => /\/(fixtures|docs\/targets)\/|package-lock\.json$/.test(f)
let hits = 0, unread = 0
const hit = (f, i, kind, v) => { hits++; console.log(`HIT ${kind}: ${f}:${i + 1}: ${v.slice(0, 6)}... (redacted)`) }
for (const f of files) {
  let text
  // A file that cannot be read was not scanned, which is not the same as clean.
  try { text = readFileSync(f, 'utf8') } catch (e) { unread++; console.log(`UNREAD: ${f}: ${e.code}`); continue }
  if (text.includes('\0')) continue
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/apikey_[0-9a-f]{16}/gi)) hit(f, i, 'key-shape', m[0])
    for (const m of line.matchAll(/TYPESAFE(?:_AI)?_API_KEY=([^\s"'`]+)/g)) {
      if (!PLACEHOLDER.test(m[1])) hit(f, i, 'key-assignment', m[1])
    }
    for (const m of line.matchAll(/Bearer ([A-Za-z0-9._~+/-]{20,}=*)/g)) hit(f, i, 'bearer', m[1])
    if (skipEntropy(f)) return
    // No `/` in the class, so a path is not one long token; mixed case plus a digit, so a
    // lowercase hex digest is not one either.
    for (const m of line.matchAll(/[A-Za-z0-9+_-]{32,}/g)) {
      const t = m[0]
      if (/[a-z]/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t) && entropy(t) > 4.0) hit(f, i, 'high-entropy', t)
    }
  })
}
console.log(`heuristics: ${files.length - unread} files scanned (repo tree + tarball), ${hits} hit(s), ${unread} unreadable`)
process.exit(hits || unread ? 1 : 0)
JS

echo "PASS: packed, installed, the gate denied from node_modules, no secrets found"
