#!/usr/bin/env bash
# Quick end-to-end check against a running stack.
#   PDF_API_KEY=pdf_sk_xxx ./scripts/smoke.sh [html-file]
set -euo pipefail

BASE="${PDF_URL:-http://localhost:8080}"
KEY="${PDF_API_KEY:?set PDF_API_KEY to the key in your .env}"
HTML_FILE="${1:-scripts/sample-certificate.html}"
OUT_DIR="${OUT_DIR:-out}"
mkdir -p "$OUT_DIR"

json_field() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

echo "==> GET /health"
curl -fsS "$BASE/health"; echo

echo "==> GET /ready"
curl -sS "$BASE/ready"; echo

echo "==> POST /v1/pdf (unauthenticated, expecting 401)"
curl -sS -o /dev/null -w '    status %{http_code}\n' -X POST "$BASE/v1/pdf" \
  -H 'content-type: application/json' -d '{"html":"<p>nope</p>"}'

PAYLOAD="$OUT_DIR/payload.json"
# Build {"html": "<file contents>", ...} without needing jq.
{
  printf '{"filename":"smoke.pdf","html":'
  node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1],"utf8")))' "$HTML_FILE"
  printf ',"options":{"format":"A4","printBackground":true,"margin":{"top":"12mm","bottom":"14mm","left":"12mm","right":"12mm"}}}'
} > "$PAYLOAD"

echo "==> POST /v1/pdf/sync -> $OUT_DIR/smoke-sync.pdf"
curl -fsS -X POST "$BASE/v1/pdf/sync" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  --data-binary @"$PAYLOAD" -o "$OUT_DIR/smoke-sync.pdf" -D "$OUT_DIR/smoke-sync.headers"
grep -iE '^(HTTP/|content-type|content-length)' "$OUT_DIR/smoke-sync.headers" || true
ls -l "$OUT_DIR/smoke-sync.pdf"

echo "==> POST /v1/pdf (async)"
JOB_ID=$(curl -fsS -X POST "$BASE/v1/pdf" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H "Idempotency-Key: smoke-$(date +%s)" \
  --data-binary @"$PAYLOAD" | json_field id)
echo "    job $JOB_ID"

for _ in $(seq 1 120); do
  BODY=$(curl -fsS "$BASE/v1/jobs/$JOB_ID" -H "authorization: Bearer $KEY")
  STATUS=$(printf '%s' "$BODY" | json_field status)
  echo "    status $STATUS"
  case "$STATUS" in
    completed) break ;;
    failed) echo "$BODY"; exit 1 ;;
  esac
  sleep 0.5
done

echo "==> GET /v1/jobs/$JOB_ID/pdf -> $OUT_DIR/smoke-async.pdf"
curl -fsS "$BASE/v1/jobs/$JOB_ID/pdf" -H "authorization: Bearer $KEY" -o "$OUT_DIR/smoke-async.pdf"
ls -l "$OUT_DIR/smoke-async.pdf"

echo "==> done"
