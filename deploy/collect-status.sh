#!/bin/sh
# Writes an allow-listed summary of the panel's stations into the
# portfolio-status ConfigMap. Runs every minute as a CronJob with read-only,
# per-object RBAC. Anything not listed here never leaves the cluster.
set -eu

STATIONS="
portfolio       portfolio    deployment  portfolio-site
gymhero         gymhero      deployment  gymhero-app
gymhero-db      gymhero      deployment  mongodb
music           music        deployment  music-app
job-planner     job-planner  deployment  job-planner
job-planner-api job-planner  deployment  job-planner-api
cloudflared     cloudflared  deployment  cloudflared
traefik         kube-system  deployment  traefik
monitoring      monitoring   statefulset prometheus-kube-prometheus-stack-prometheus
"
NODE=k3s-learn
OUT=/tmp/status.json

reading() {
  jq -c '
    (.spec.replicas // 0) as $desired
    | (.status.readyReplicas // 0) as $ready
    | (.status.updatedReplicas // 0) as $updated
    | ((.status.observedGeneration // 0) < (.metadata.generation // 0)) as $stale
    | {
        desired: $desired,
        ready: $ready,
        state: (if $desired == 0 then "switched-out"
                elif $stale or $updated < $desired then "deploying"
                elif $ready < $desired then "down"
                else "running" end),
        last_rollout: (.spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]
                       // ([.status.conditions[]? | select(.type == "Progressing") | .lastUpdateTime][0])
                       // .metadata.creationTimestamp)
      }'
}

echo "$STATIONS" | while read -r id ns kind name; do
  [ -n "$id" ] || continue
  if json=$(kubectl -n "$ns" get "$kind" "$name" -o json 2>/dev/null); then
    r=$(printf '%s' "$json" | reading)
  else
    r='{"state":"nodata"}'
  fi
  printf '%s\t%s\n' "$id" "$r"
done > /tmp/readings.tsv

node_json=$(kubectl get node "$NODE" -o json 2>/dev/null || echo '{}')

jq -n \
  --rawfile readings /tmp/readings.tsv \
  --argjson node "$node_json" \
  '{
     generated_at: (now | todate),
     node: {
       ready: ([$node.status.conditions[]? | select(.type == "Ready") | .status][0] == "True"),
       version: ($node.status.nodeInfo.kubeletVersion // null)
     },
     stations: ($readings | split("\n") | map(select(length > 0) | split("\t") | {key: .[0], value: (.[1] | fromjson)}) | from_entries)
   }' > "$OUT"

kubectl -n portfolio create configmap portfolio-status --from-file=status.json="$OUT" --dry-run=client -o yaml \
  | kubectl -n portfolio replace -f -
