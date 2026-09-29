#!/usr/bin/env bash
# Opt-in, not part of `npm test`: the emitted ai-sdk module typechecked with tsc --strict
# against, and run on, the REAL @ai-sdk/typesafe-ai 3.0.10, where the suite has a stub of it.
# Nothing reaches TypeSafe: the key is a dummy and TYPESAFE_BASE_URL points at a server this
# script starts on 127.0.0.1, answering with the answers jev-1.13.0 gave for the commit
# fixture. Needs npm (to fetch the package) and a built dist/ (npm run build).
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
program="$repo/examples/sample-project/.claude/gates/commit.json"
node "$repo/dist/cli.js" compile "$program" --emit ai-sdk -o "$tmp/commit_jev.ts"
node "$repo/dist/cli.js" compile "$program" --emit json -o "$tmp/request.json"

cd "$tmp"
echo '{"name":"check-ai-sdk","private":true,"type":"module"}' > package.json
npm install --silent --no-audit --no-fund @ai-sdk/typesafe-ai@3.0.10 zod@4 > /dev/null
cat > tsconfig.json <<JSON
{ "compilerOptions": { "strict": true, "target": "es2022", "module": "nodenext",
  "moduleResolution": "nodenext", "skipLibCheck": true, "outDir": "out",
  "typeRoots": ["$repo/node_modules/@types"], "types": ["node"] },
  "files": ["commit_jev.ts"] }
JSON
node "$repo/node_modules/typescript/bin/tsc" -p .

cat > drive.mjs <<'JS'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8')).fixtures
  .find(f => f.id === 'commit-only-when-explicitly-asked')
const recorded = JSON.parse(fixture.measured.answers)
const expected = JSON.parse(readFileSync('request.json', 'utf8'))
const sent = []
let reply
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    const body = JSON.parse(raw)
    sent.push({ url: req.url, body })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(reply(body)))
  })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
// Padded and slash-terminated on purpose: the module must read it as @typesafe-ai/sdk does.
process.env.TYPESAFE_BASE_URL = ` http://127.0.0.1:${server.address().port}/ `
const m = await import('./out/commit_jev.js')
// The recorded answers for exactly the questions asked: the fixture recorded two more.
const answers = body => Object.fromEntries(Object.keys(body.questions).map(k => [k, recorded[k]]))
const ask = () => m.model.doEvaluate({ state: fixture.state, questions: m.programQuestions })
try {
  reply = body => ({ model: fixture.measured.model, answers: answers(body) })
  const r = await ask()
  const verdict = m.reduce(r.answers, m.confidenceOf(r))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, '/v1/systemone')
  assert.equal(sent[0].body.model, 'jev-1.13.0')
  assert.deepEqual(Object.keys(sent[0].body.questions), Object.keys(expected.questions))
  assert.equal(verdict, 'deny')

  // Who answered, as this provider reports it. A reply naming another model is passed
  // through; a reply naming none is backfilled with the model the request asked for, so
  // response.modelId cannot tell a caller that Jev answered.
  reply = body => ({ model: 'laya-rl-agent', answers: answers(body) })
  assert.equal((await ask()).response.modelId, 'laya-rl-agent')
  reply = body => ({ answers: answers(body) })
  assert.equal((await ask()).response.modelId, 'jev-1.13.0')
} finally {
  server.close()
}
const v = JSON.parse(readFileSync('node_modules/@ai-sdk/typesafe-ai/package.json', 'utf8')).version
console.log(`@ai-sdk/typesafe-ai ${v}: tsc --strict clean; ${sent.length} requests to ${sent[0].url} (local), `
  + `model jev-1.13.0, verdict deny; a reply with no model reads back as modelId jev-1.13.0`)
JS
env -u TYPESAFE_API_KEY -u TYPESAFE_AI_API_KEY TYPESAFE_API_KEY=dummy \
  node drive.mjs "$repo/fixtures/agent-harness-rules.json"
