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

# Who answered. classify() applies evaluate()'s guard: a non-Jev model raises unless
# JEVC_ALLOW_MODEL names it; a response with no model never reaches it, because a3's
# ClassifierResponse requires the field.
import os
import warnings

answered_by = fixture["measured"]["model"]


def handler(request):
    body = json.loads(request.content)
    reply = {"answers": {k: recorded[k] for k in body["questions"]}}
    if answered_by is not None:
        reply["model"] = answered_by
    return httpx2.Response(200, json=reply)


commit_jev.classifier.client = httpx2.Client(transport=httpx2.MockTransport(handler))
answered_by = "laya-rl-agent"
try:
    commit_jev.classify(fixture["state"])
    raise AssertionError("a non-Jev model was accepted")
except ValueError as e:
    assert '"laya-rl-agent"' in str(e) and "JEVC_ALLOW_MODEL" in str(e), e
os.environ["JEVC_ALLOW_MODEL"] = "laya-rl-agent"
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    assert commit_jev.reduce(commit_jev.classify(fixture["state"]).answers) == "deny"
assert [str(x.message) for x in w if '"laya-rl-agent"' in str(x.message)], [str(x.message) for x in w]
del os.environ["JEVC_ALLOW_MODEL"]
answered_by = None
try:
    commit_jev.classify(fixture["state"])
    refused = None
except Exception as e:  # raised by a3 before _check_model runs; its class is a3's to choose
    refused = type(e).__name__
assert refused, "a response with no model was accepted"

# The key a local server ignores still has to be non-empty: a3 validates it when the module
# constructs its classifier, which is at import. The README's local-server recipe says so.
import importlib
os.environ["TYPESAFE_API_KEY"] = ""
try:
    importlib.reload(commit_jev)
    no_key = None
except Exception as e:
    no_key = type(e).__name__
assert no_key, "the module imported with an empty key"
print(f"langchain-typesafe {version('langchain-typesafe')}: 1 request to {url} (mock), "
      f"{len(body['questions'])} questions = --emit json, model {body['model']}, verdict {verdict}; "
      f"non-Jev refused, allow-listed warned, no model refused by a3 ({refused}), "
      f"empty key refused at import ({no_key})")
PY
