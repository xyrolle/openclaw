#!/bin/zsh
# Upgrade proof: released 2026.10.6 writes config, sessions and transcripts; the PR head starts on the
# same state dir, validates it, reads the same transcripts, keeps buffering a Claude 5 route by
# default, and streams it once the route opts in. Prints a terminal transcript.
set -u
P=${0:A:h}
W=$P/work
WT=${OPENCLAW_CHECKOUT:?set OPENCLAW_CHECKOUT to a built checkout of the PR head}
NB=$(dirname "$(command -v node)")   # Node 24.22.1+
RELEASED=$P/released/node_modules/.bin/openclaw   # npm install --prefix released openclaw@2026.10.6
TOKEN=upgrade-proof-token
GW_PORT=18931
STUB_PORT=18921
STUB_LOG=$W/stub.jsonl

rm -rf $W && mkdir -p $W/home/.openclaw $W/workspace
export HOME=$W/home
export OPENCLAW_STATE_DIR=$W/home/.openclaw
export OPENCLAW_CONFIG_PATH=$W/home/.openclaw/openclaw.json
export PATH=$NB:$PATH
# The same isolation switches upstream's runtime-proof fixture uses.
export OPENCLAW_SKIP_CHANNELS=1 OPENCLAW_SKIP_GMAIL_WATCHER=1 OPENCLAW_SKIP_CRON=1
export OPENCLAW_SKIP_CANVAS_HOST=1 OPENCLAW_SKIP_BROWSER_CONTROL_SERVER=1 OPENCLAW_DISABLE_BONJOUR=1

say() { print -r -- "$*"; }
run() { say "\$ $*"; "$@" 2>&1; say ""; }
head_cli() { node $WT/openclaw.mjs "$@"; }
released_cli() { $RELEASED "$@"; }
wait_port() {
  for _ in {1..120}; do
    nc -z 127.0.0.1 $1 2>/dev/null && return 0
    sleep 1
  done
  say "port $1 never opened"; return 1
}
observe() {
  (cd $WT && node --import ./scripts/tsx.mjs $P/observe-turn.mts ws://127.0.0.1:$GW_PORT $TOKEN "$1" "$2" $STUB_LOG)
  say ""
}
released_turn() {
  # A turn through the released CLI: chat.send, then agent.wait.
  say "\$ openclaw gateway call chat.send --params '{\"sessionKey\":\"$1\",\"message\":\"$2\",...}'"
  local run_id=$(released_cli gateway call chat.send --json \
    --params "{\"sessionKey\":\"$1\",\"message\":\"$2\",\"deliver\":false,\"idempotencyKey\":\"$1-seed\"}" 2>/dev/null |
    python3 -I -c 'import json,sys; print(json.load(sys.stdin)["runId"])')
  say "\$ openclaw gateway call agent.wait --params '{\"runId\":\"<run>\"}'"
  released_cli gateway call agent.wait --json --timeout 90000 \
    --params "{\"runId\":\"$run_id\",\"timeoutMs\":80000}" 2>/dev/null |
    python3 -I -c 'import json,sys; print("status:", json.load(sys.stdin).get("status"))'
  say ""
}
history_digest() {
  # Role, content and tool identity of every message: what a reload renders and replays.
  $1 gateway call chat.history --params "{\"sessionKey\":\"$2\",\"limit\":100}" --json 2>/dev/null > $W/history-$1-${2##*:}.json
  python3 -I -c '
import hashlib, json, sys
messages = json.load(open(sys.argv[1]))["messages"]
projection = [{k: m.get(k) for k in ("role", "content", "toolCallId", "toolName", "stopReason", "customType")} for m in messages]
print(len(messages), "messages, sha256", hashlib.sha256(json.dumps(projection, sort_keys=True).encode()).hexdigest()[:16])' $W/history-$1-${2##*:}.json
}
AGENT_DB=$W/home/.openclaw/agents/main/agent/openclaw-agent.sqlite
stored_digest() {
  say "\$ python3 transcript-digest.py <state>/agents/main/agent/openclaw-agent.sqlite $1   # stored transcript rows"
  python3 -I $P/transcript-digest.py $AGENT_DB $W/transcript-baseline.json $1
  say ""
}
rendered() {
  python3 -I -c '
import json, sys
for m in json.load(open(sys.argv[1]))["messages"]:
    print("   ", m.get("role"), m.get("stopReason") or "", json.dumps(m.get("content"))[:70])' $1
}
start_gateway() {
  say "\$ $1 gateway run --port $GW_PORT --bind loopback   # background, log in $2"
  if [[ $1 == released ]]; then
    released_cli gateway run --port $GW_PORT --bind loopback > $2 2>&1 &
  else
    head_cli gateway run --port $GW_PORT --bind loopback > $2 2>&1 &
  fi
  GW_PID=$!
  wait_port $GW_PORT && sleep 2
  say "Gateway listening on 127.0.0.1:$GW_PORT"
  say ""
}
stop_gateway() {
  say "\$ kill -TERM <gateway pid>"
  # The CLI hands the Gateway to a supervisor process; stop the listener and its supervisor.
  local -a pids=()
  for pid in $(lsof -t -nP -iTCP:$GW_PORT -sTCP:LISTEN); do
    local parent=$(ps -o ppid= -p $pid | tr -d ' ')
    [[ "$(ps -o command= -p $parent)" == openclaw-gateway* ]] && pids+=($parent)
    pids+=($pid)
  done
  kill -TERM $pids 2>/dev/null
  for _ in {1..60}; do
    local alive=0
    for pid in $pids; do kill -0 $pid 2>/dev/null && alive=1; done
    (( alive )) || break
    sleep 1
  done
  wait $GW_PID 2>/dev/null
  say "Gateway stopped"
  say ""
}

cleanup() {
  nc -z 127.0.0.1 $GW_PORT 2>/dev/null && stop_gateway > /dev/null
  [[ -n "${STUB_PID:-}" ]] && kill $STUB_PID 2>/dev/null
}
trap cleanup EXIT

cat > $W/config.seed.json <<JSON
{
  "gateway": { "mode": "local", "port": $GW_PORT, "bind": "loopback", "auth": { "mode": "token", "token": "$TOKEN" } },
  "agents": {
    "defaults": {
      "workspace": "$W/workspace",
      "skipBootstrap": true,
      "model": { "primary": "claude-proxy/claude-sonnet-5-5" }
    }
  },
  "models": {
    "mode": "replace",
    "providers": {
      "claude-proxy": {
        "baseUrl": "http://127.0.0.1:$STUB_PORT",
        "apiKey": "sk-ant-api03-upgrade-proof",
        "api": "anthropic-messages",
        "models": [
          {
            "id": "claude-sonnet-5-5",
            "name": "Claude Sonnet 5.5",
            "reasoning": true,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 200000,
            "maxTokens": 4096
          }
        ]
      }
    }
  }
}
JSON
python3 -I -c "import json,sys;  open(sys.argv[2], 'w').write(json.dumps(json.load(open(sys.argv[1])), indent=2) + '\\n')" $W/config.seed.json $OPENCLAW_CONFIG_PATH

node $P/stub-server.mjs $STUB_PORT $STUB_LOG > $W/stub.out 2>&1 &
STUB_PID=$!
wait_port $STUB_PORT

say "## 1. Released 2026.10.6 writes sessions and transcripts on a custom Claude 5 route (no flag)"
say ""
run released_cli --version
run released_cli config validate
start_gateway released $W/gateway-2026.10.6.log
released_turn agent:main:saved-answer "[scenario:answer] Saved before the upgrade."
released_turn agent:main:saved-two-calls "[scenario:two-calls] Write a file, then continue."
say "\$ openclaw gateway call chat.history ... | digest   # per saved session"
say "saved-answer:    $(history_digest released_cli agent:main:saved-answer)"
say "saved-two-calls: $(history_digest released_cli agent:main:saved-two-calls)"
say ""
BEFORE_ANSWER=$(history_digest released_cli agent:main:saved-answer)
BEFORE_TWO=$(history_digest released_cli agent:main:saved-two-calls)
stop_gateway
stored_digest record

say "## 2. PR head on the same state dir, config unchanged"
say ""
run head_cli --version
run head_cli config validate
say "\$ openclaw doctor --fix --non-interactive   # the documented upgrade step"
head_cli doctor --fix --non-interactive > $W/doctor.log 2>&1
say "exit $?   (full output in doctor.log; migration lines:)"
grep -iE "schema|migrat|session" $W/doctor.log | sed -E 's/\x1b\[[0-9;]*m//g' | head -12
say ""
start_gateway head $W/gateway-head-default.log
AFTER_ANSWER=$(history_digest head_cli agent:main:saved-answer)
AFTER_TWO=$(history_digest head_cli agent:main:saved-two-calls)
say "\$ openclaw gateway call chat.history ... | digest   # same saved sessions, read by the PR head"
say "saved-answer:    $AFTER_ANSWER   $([[ $AFTER_ANSWER == $BEFORE_ANSWER ]] && print identical || print CHANGED)"
say "saved-two-calls: $AFTER_TWO   $([[ $AFTER_TWO == $BEFORE_TWO ]] && print identical || print CHANGED)"
say ""
say "chat.history of saved-two-calls as each version renders it:"
say "  2026.10.6:"; rendered $W/history-released_cli-saved-two-calls.json
say "  PR head:"; rendered $W/history-head_cli-saved-two-calls.json
say ""
observe agent:main:saved-answer "[scenario:answer] First turn after the upgrade, default route."
stop_gateway
stored_digest compare

say "## 3. Opt the same route in"
say ""
say "\$ (add compat.streamBeforeRefusal: true to models.providers.claude-proxy.models[0])"
cp $OPENCLAW_CONFIG_PATH $W/openclaw.before-opt-in.json
python3 -I - $OPENCLAW_CONFIG_PATH <<'PY'
import json, sys
path = sys.argv[1]
config = json.load(open(path))
config["models"]["providers"]["claude-proxy"]["models"][0]["compat"] = {"streamBeforeRefusal": True}
open(path, "w").write(json.dumps(config, indent=2) + "\n")
PY
diff -u $W/openclaw.before-opt-in.json $OPENCLAW_CONFIG_PATH | sed -n '3,$p' | grep -E '^[+-]'
say ""
run head_cli config validate
start_gateway head $W/gateway-head-opt-in.log
observe agent:main:saved-answer "[scenario:answer] Same session, route opted in."
observe agent:main:after-upgrade-refusal "[scenario:refusal] Opted-in refusal."
say "\$ openclaw gateway call chat.history ... | digest   # earlier transcripts after the opt-in"
OPTED_TWO=$(history_digest head_cli agent:main:saved-two-calls)
say "saved-two-calls: $OPTED_TWO   $([[ $OPTED_TWO == $BEFORE_TWO ]] && print identical || print CHANGED)"
say ""
stop_gateway
stored_digest compare
kill $STUB_PID 2>/dev/null
