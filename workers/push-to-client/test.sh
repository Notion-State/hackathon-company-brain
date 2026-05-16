#!/usr/bin/env bash
# End-to-end smoke for the pushToClient tool, one case per docType + the
# idempotency rerun + a negative for unknown-status. Requires a staging
# client to be configured in `.env` (or via `ntn workers env set` for non-local
# runs).
#
# Usage:
#   CLIENT_ID=<id> ./test.sh            # local; uses .env automatically
#   CLIENT_ID=<id> REMOTE=1 ./test.sh   # against the deployed worker
set -euo pipefail

CLIENT_ID="${CLIENT_ID:?Set CLIENT_ID to the lowercase id of your configured staging client.}"
LOCAL_FLAG="--local"
if [[ "${REMOTE:-0}" == "1" ]]; then
	LOCAL_FLAG=""
fi

exec_tool() {
	ntn workers exec pushToClient ${LOCAL_FLAG} -d "$1"
}

echo "=== 1) Healthy create — Docs ==="
exec_tool "{
	\"clientId\": \"${CLIENT_ID}\",
	\"docType\": \"Docs\",
	\"brainId\": \"smoke-doc-1\",
	\"title\": \"[Smoke] push-to-client Doc\",
	\"type\": \"Guide\",
	\"status\": \"Drafting\",
	\"bodyMarkdown\": \"# Smoke Doc\\n\\nParagraph one.\\n\\n- bullet 1\\n- bullet 2\"
}"

echo "=== 2) Healthy create — Status Update ==="
exec_tool "{
	\"clientId\": \"${CLIENT_ID}\",
	\"docType\": \"StatusUpdate\",
	\"brainId\": \"smoke-su-1\",
	\"title\": \"[Smoke] Status Update @Next Monday\",
	\"date\": \"2026-05-18\",
	\"summary\": \"Hello world from the smoke test.\",
	\"presenterEmail\": null,
	\"addressed\": false
}"

echo "=== 3) Healthy create — Deliverable (date range) ==="
exec_tool "{
	\"clientId\": \"${CLIENT_ID}\",
	\"docType\": \"Deliverable\",
	\"brainId\": \"smoke-deliv-1\",
	\"title\": \"[Smoke] Aduro Home\",
	\"status\": \"Planning\",
	\"timelineStart\": \"2026-05-15\",
	\"timelineEnd\": \"2026-06-30\"
}"

echo "=== 4) Idempotency — re-push the Doc, expect already_pushed ==="
exec_tool "{
	\"clientId\": \"${CLIENT_ID}\",
	\"docType\": \"Docs\",
	\"brainId\": \"smoke-doc-1\",
	\"title\": \"[Smoke] push-to-client Doc (rerun)\",
	\"type\": \"Guide\",
	\"status\": \"Drafting\"
}"

echo "=== 5) Unknown status (should throw DestinationSchemaMismatch) ==="
set +e
exec_tool "{
	\"clientId\": \"${CLIENT_ID}\",
	\"docType\": \"Docs\",
	\"brainId\": \"smoke-bad-status-1\",
	\"title\": \"[Smoke] unknown status\",
	\"type\": \"Guide\",
	\"status\": \"DefinitelyNotAStatus\"
}"
set -e

echo "Done. Inspect runs: ntn workers runs list --plain | head"
