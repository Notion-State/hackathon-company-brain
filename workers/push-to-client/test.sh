#!/usr/bin/env bash
# End-to-end smoke for the pushToClient tool. Requires a staging client to be
# configured in `.env` (or via `ntn workers env set` for non-local runs).
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

echo "=== 1) Healthy create ==="
exec_tool "{
	\"clientId\": \"${CLIENT_ID}\",
	\"payload\": {
		\"brainId\": \"smoke-1\",
		\"title\": \"[Smoke] push-to-client healthy create\",
		\"source\": \"Fireflies\",
		\"category\": \"summary\",
		\"originalDate\": \"2026-05-16T18:00:00.000Z\",
		\"originUrl\": \"https://example.com/origin\",
		\"bodyMarkdown\": \"# Smoke\\n\\nParagraph.\\n\\n- bullet 1\\n- bullet 2\\n\\n\`\`\`ts\\nconsole.log(1);\\n\`\`\`\"
	}
}"

echo "=== 2) Idempotency (same brainId returns already_pushed) ==="
exec_tool "{
	\"clientId\": \"${CLIENT_ID}\",
	\"payload\": {
		\"brainId\": \"smoke-1\",
		\"title\": \"[Smoke] push-to-client healthy create\",
		\"source\": \"Fireflies\",
		\"category\": \"summary\",
		\"originalDate\": \"2026-05-16T18:00:00.000Z\",
		\"originUrl\": \"https://example.com/origin\",
		\"bodyMarkdown\": \"# Smoke\\n\\nParagraph.\"
	}
}"

echo "=== 3) Markdown warnings (image + table dropped) ==="
exec_tool "{
	\"clientId\": \"${CLIENT_ID}\",
	\"payload\": {
		\"brainId\": \"smoke-warnings-1\",
		\"title\": \"[Smoke] markdown warnings\",
		\"source\": \"Slack\",
		\"category\": \"summary\",
		\"originalDate\": null,
		\"originUrl\": null,
		\"bodyMarkdown\": \"![cat](https://example.com/cat.png)\\n\\n| a | b |\\n| - | - |\\n| 1 | 2 |\"
	}
}"

echo "=== 4) Unknown category (should throw DestinationSchemaMismatch) ==="
set +e
exec_tool "{
	\"clientId\": \"${CLIENT_ID}\",
	\"payload\": {
		\"brainId\": \"smoke-bad-category-1\",
		\"title\": \"[Smoke] unknown category\",
		\"source\": \"Fireflies\",
		\"category\": \"definitely-not-a-real-category\",
		\"originalDate\": null,
		\"originUrl\": null,
		\"bodyMarkdown\": null
	}
}"
set -e

echo "Done. Inspect runs: ntn workers runs list --plain | head"
