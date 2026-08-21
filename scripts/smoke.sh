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

echo "==> POST /v1/pdf with a blocked upload destination (expecting 400)"
# The SSRF guard is the one part of the upload path that must hold even when
# nothing else is configured, so it is checked here rather than only by hand.
curl -sS -o "$OUT_DIR/smoke-blocked.json" -w '    status %{http_code}\n' \
  -X POST "$BASE/v1/pdf" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"html":"<p>x</p>","upload":{"url":"https://169.254.169.254/latest/meta-data/"}}'
grep -o '"code":"[^"]*"' "$OUT_DIR/smoke-blocked.json" | head -1

echo "==> POST /v1/pdf with a reserved upload header (expecting 400)"
curl -sS -o "$OUT_DIR/smoke-header.json" -w '    status %{http_code}\n' \
  -X POST "$BASE/v1/pdf" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"html":"<p>x</p>","upload":{"url":"https://storage.example.com/o.pdf","headers":{"Host":"evil.example"}}}'
grep -o '"code":"[^"]*"' "$OUT_DIR/smoke-header.json" | head -1

# The happy path needs a real presigned URL, so it is opt-in:
#   SMOKE_UPLOAD_URL="https://...signed..." ./scripts/smoke.sh
if [ -n "${SMOKE_UPLOAD_URL:-}" ]; then
  echo "==> POST /v1/pdf/sync with upload -> JSON, not bytes"
  UPLOAD_PAYLOAD="$OUT_DIR/payload-upload.json"
  {
    printf '{"filename":"smoke.pdf","html":'
    node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1],"utf8")))' "$HTML_FILE"
    printf ',"upload":{"url":'
    node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$SMOKE_UPLOAD_URL"
    printf '}}'
  } > "$UPLOAD_PAYLOAD"

  curl -fsS -X POST "$BASE/v1/pdf/sync" \
    -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
    --data-binary @"$UPLOAD_PAYLOAD" -o "$OUT_DIR/smoke-upload.json" \
    -D "$OUT_DIR/smoke-upload.headers"
  grep -iE '^(HTTP/|content-type)' "$OUT_DIR/smoke-upload.headers" || true
  cat "$OUT_DIR/smoke-upload.json"; echo
else
  echo "==> skipping the upload happy path (set SMOKE_UPLOAD_URL to a presigned PUT URL)"
fi

echo "==> done"
