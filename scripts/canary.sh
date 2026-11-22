#!/usr/bin/env bash
set -euo pipefail
namespace="${1:?namespace}"
max_iterations="${CANARY_MAX_ITERATIONS:-90}"
for ((iteration = 1; iteration <= max_iterations; iteration += 1)); do
  phase="$(kubectl -n "$namespace" get rollout fileexpress -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  case "$phase" in
    Healthy)
      kubectl -n "$namespace" get rollout fileexpress
      exit 0
      ;;
    Degraded|Error|Aborted)
      kubectl -n "$namespace" describe rollout fileexpress || true
      echo "Canary failed with phase ${phase}" >&2
      exit 1
      ;;
  esac
  if ((iteration == max_iterations)); then
    break
  fi
  sleep "${CANARY_POLL_SECONDS:-10}"
done
kubectl -n "$namespace" describe rollout fileexpress || true
echo "Canary did not become healthy within the bounded wait" >&2
exit 1
