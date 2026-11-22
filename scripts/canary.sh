#!/usr/bin/env bash
set -euo pipefail
release="${1:?release}"; namespace="${2:?namespace}"; shift 2
for weight in "$@"; do
  kubectl -n "$namespace" annotate deployment fileexpress fileexpress/canary-weight="$weight" --overwrite
  kubectl -n "$namespace" rollout status deployment fileexpress --timeout=5m
  sleep "${CANARY_INTERVAL:-60}"
  error_rate="$(curl -fsS "${PROMETHEUS_URL:?PROMETHEUS_URL}/api/v1/query" --get --data-urlencode 'query=sum(rate(errors_total[5m]))/sum(rate(http_req_duration_seconds_count[5m]))*100' | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s);console.log(Number(r.data.result[0]?.value[1]??0))})')"
  if node -e "process.exit(Number(process.argv[1]) > 2 ? 0 : 1)" "$error_rate"; then
    helm -n "$namespace" rollback "$release" --wait --timeout 5m
    echo "Canary aborted: error rate ${error_rate}% exceeds 2%" >&2
    exit 1
  fi
done
