#!/usr/bin/env bash
# Runs `npm run sandcastle` in a loop: as soon as it exits 0, run it again.
# Exit code 3 means "idle" (no Sandcastle-labelled work left) -- a clean stop,
# so the loop ends with status 0. Any other non-zero code is a real failure and
# is propagated as this script's exit status.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# Must match IDLE_EXIT_CODE in .sandcastle/main.mts.
IDLE_EXIT_CODE=3

run=0
while true; do
  run=$((run + 1))
  echo "=== sandcastle run #$run ==="
  npm run sandcastle
  code=$?
  if [ "$code" -eq "$IDLE_EXIT_CODE" ]; then
    echo "=== sandcastle idle (no work left); stopping cleanly after $run run(s) ==="
    exit 0
  fi
  if [ "$code" -ne 0 ]; then
    echo "=== sandcastle exited with code $code; stopping after $run run(s) ==="
    exit "$code"
  fi
done
