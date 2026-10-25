#!/bin/bash
# ZAP 2.17 scans for the comparison, same plan and network as Kushaal's zap/scan.ps1. Usage:
#   ./zap.sh plain  <port>     <baseline|full|api> [label]   the vibe-coded app on this Mac
#   ./zap.sh basalt <app-host> <baseline|full|api> [label]   the Basalt app, e.g. riverside-pt.basalt.localhost
# Scanners use their own network (basalt-scan, 172.31.250.0/24) at 172.31.250.10, so an edge ban hits the
# scanner, not this laptop's browser, and there's a fixed address to allowlist for the second pass.
set -u
KIND=$1; TARGET=$2; MODE=$3; LABEL=${4:-}
RUN=$(cd "$(dirname "$0")" && pwd)
NAME="$MODE${LABEL:+-$LABEL}"
OUT="$RUN/results/$KIND"; mkdir -p "$OUT"
docker network inspect basalt-scan >/dev/null 2>&1 || docker network create --subnet 172.31.250.0/24 basalt-scan >/dev/null
docker network connect --ip 172.31.250.2 basalt-scan basalt-edge 2>/dev/null || true
if [ "$KIND" = plain ]; then
  URL="http://host.docker.internal:$TARGET"; HOSTS=(--add-host host.docker.internal:host-gateway); APPDIR="$RUN/without-basalt"
else
  URL="http://$TARGET:8080"; HOSTS=(--add-host "$TARGET:172.31.250.2"); APPDIR="$RUN/with-basalt"
fi
ESC=$(printf '%s' "$URL" | sed 's/[.[\*^$()+?{|]/\\&/g')
PLAN="$OUT/$NAME.plan.yaml"
{
cat <<YAML
env:
  contexts:
    - name: target
      urls: ['$URL']
      includePaths: ['$ESC.*']
  parameters: { failOnError: false, failOnWarning: false, progressToStdout: true }
jobs:
  - type: passiveScan-config
    parameters: { maxAlertsPerRule: 10, scanOnlyInScope: true }
YAML
if [ "$MODE" = api ]; then
cat <<YAML
  - type: openapi
    parameters: { apiFile: /zap/out/openapi.json, targetUrl: '$URL', context: target }
YAML
else
cat <<YAML
  - type: spider
    parameters: { context: target, maxDuration: 5 }
  - type: spiderAjax
    parameters: { context: target, maxDuration: 5, browserId: firefox-headless }
YAML
fi
cat <<YAML
  - type: passiveScan-wait
    parameters: { maxDuration: 10 }
YAML
if [ "$MODE" != baseline ]; then
cat <<YAML
  - type: activeScan
    parameters: { context: target, maxScanDurationInMins: 45 }
YAML
fi
cat <<YAML
  - type: report
    parameters: { template: traditional-html, reportDir: /zap/out, reportFile: '$NAME.html' }
  - type: report
    parameters: { template: traditional-json, reportDir: /zap/out, reportFile: '$NAME.json' }
YAML
} > "$PLAN"
[ "$MODE" = api ] && cp "$APPDIR/openapi.json" "$OUT/openapi.json"
cp "$PLAN" "$OUT/plan.yaml"
CID=$(docker run -d --network basalt-scan --ip 172.31.250.10 "${HOSTS[@]}" -v "$OUT:/zap/out" ghcr.io/zaproxy/zaproxy:stable zap.sh -cmd -autorun /zap/out/plan.yaml)
until docker logs "$CID" 2>&1 | grep -qE "Automation plan (succeeded|failed)"; do
  docker inspect "$CID" >/dev/null 2>&1 || break; sleep 10
done
docker logs "$CID" > "$OUT/$NAME.log" 2>&1; docker rm -f "$CID" >/dev/null 2>&1
node -e '
const r=require(process.argv[1]); const c={High:0,Medium:0,Low:0,Informational:0};
for (const s of [].concat(r.site||[])) for (const a of s.alerts||[]) { const k=(a.riskdesc||"").split(" ")[0]; if (k in c) c[k]++; }
console.log(process.argv[2], JSON.stringify(c));' "$OUT/$NAME.json" "$KIND $NAME" | tee -a "$OUT/summary.txt"
