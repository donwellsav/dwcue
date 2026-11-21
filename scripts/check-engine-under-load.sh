#!/bin/bash
# Runs every engine test suite three times with every CPU core kept busy.
# GitHub's release runners are much slower than a development Mac; a timing
# check that passes here at idle can fail there. Run this before asking for
# a release build. Usage: scripts/check-engine-under-load.sh [build-dir]
set -u
cd "$(dirname "$0")/.."
BUILD="${1:-build/qp-native}"
LOGS="$(mktemp -d)"
cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)
pids=()
for _ in $(seq 1 "$cores"); do yes > /dev/null & pids+=($!); done
trap 'kill "${pids[@]}" 2>/dev/null' EXIT
status=0
for run in 1 2 3; do
  if ctest --test-dir "$BUILD" --output-on-failure > "$LOGS/run$run.log" 2>&1; then
    echo "run $run: $(grep -E 'tests passed' "$LOGS/run$run.log")"
  else
    status=1
    echo "run $run FAILED: $(grep -E 'tests passed|tests failed' "$LOGS/run$run.log")"
    grep -E 'FAIL$|\*\*\*Failed' "$LOGS/run$run.log" | head -10
  fi
done
echo "logs: $LOGS"
exit $status
