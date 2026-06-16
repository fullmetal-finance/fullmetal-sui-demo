#!/usr/bin/env bash
# Run the fullmetal Move unit tests.
#
# Why this wrapper: deepbook_margin's OWN test code cannot compile when it is a
# dependency (it relies on a Pyth module-extension that Move only applies to the
# ROOT package), and `sui move test` compiles dependency test code. Our only
# deepbook user is the rehypo module — which is exercised on testnet (deploy +
# script), not in unit tests. So for the unit-test run we temporarily set aside
# the deepbook dependency and rehypo.move, then restore them on exit.
set -e
cd "$(dirname "$0")"

restore() {
  [ -f /tmp/.fm_rehypo.bak ] && mv /tmp/.fm_rehypo.bak sources/rehypo.move 2>/dev/null || true
  [ -f /tmp/.fm_movetoml.bak ] && cp /tmp/.fm_movetoml.bak Move.toml 2>/dev/null && rm -f /tmp/.fm_movetoml.bak || true
}
trap restore EXIT

cp Move.toml /tmp/.fm_movetoml.bak
mv sources/rehypo.move /tmp/.fm_rehypo.bak
python3 - <<'PY'
import re
s = open('Move.toml').read()
# drop the deepbook_margin dep (git or MVR form) + any dep-replacements block
s = re.sub(r'\ndeepbook_margin = .*', '', s)
s = re.sub(r'\n\[dep-replacements\.testnet\][^\[]*', '\n', s)
open('Move.toml', 'w').write(s)
PY

sui move test "$@"
