#!/usr/bin/env bash
# Opt-in, not part of `npm test`: the emitted langchain module run against the REAL
# langchain-typesafe 0.0.1a3 in an ephemeral uv environment, where the suite only has a
# transcription of it. Nothing reaches TypeSafe: the key is a dummy, the base URL is a
# port nothing listens on, and the classifier's client is swapped for an
# httpx2.MockTransport that answers with the answers jev-1.13.0 gave for the commit
# fixture. Needs uv and a built dist/ (npm run build).
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
program="$repo/examples/sample-project/.claude/gates/commit.json"
node "$repo/dist/cli.js" compile "$program" --emit langchain -o "$tmp/commit_jev.py"
node "$repo/dist/cli.js" compile "$program" --emit json -o "$tmp/request.json"

cd "$tmp"
env -u TYPESAFE_API_KEY TYPESAFE_API_KEY=dummy TYPESAFE_BASE_URL=http://127.0.0.1:9 \
  uv run --quiet --no-project --with langchain-typesafe==0.0.1a3 \
  python - "$repo/fixtures/agent-harness-rules.json" <<'PY'
import json, sys
from importlib.metadata import version

import httpx2

fixture = next(f for f in json.load(open(sys.argv[1]))["fixtures"]
               if f["id"] == "commit-only-when-explicitly-asked")
recorded = json.loads(fixture["measured"]["answers"])
expected = json.load(open("request.json"))
sent = []


def handler(request):
    body = json.loads(request.content)
    sent.append((str(request.url), body))
    # The recorded answers for exactly the questions asked: the fixture recorded two more.
    return httpx2.Response(200, json={"model": fixture["measured"]["model"],
                                      "answers": {k: recorded[k] for k in body["questions"]}})


import commit_jev  # constructs the classifier: a2's questions= would raise here

commit_jev.classifier.client = httpx2.Client(transport=httpx2.MockTransport(handler))
response = commit_jev.classify(fixture["state"])
verdict = commit_jev.reduce(response.answers)

assert len(sent) == 1, sent
url, body = sent[0]
assert url == "http://127.0.0.1:9/v1/systemone", url
assert body["model"] == "jev-1.13.0", body["model"]
assert body["questions"] == expected["questions"], (body["questions"], expected["questions"])
assert body["state"] == fixture["state"]
assert verdict == "deny", verdict
print(f"langchain-typesafe {version('langchain-typesafe')}: 1 request to {url} (mock), "
      f"{len(body['questions'])} questions = --emit json, model {body['model']}, verdict {verdict}")
PY
