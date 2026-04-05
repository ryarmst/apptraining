#!/bin/bash
#
# Reports task completion to the training platform.
# Containers receive CALLBACK_URL, CALLBACK_TOKEN, and TASK_IDS as env vars.
#
# Usage: check-completion.sh <task_id> [evidence_json]
#
# Examples:
#   check-completion.sh goal_1
#   check-completion.sh goal_1 '{"notes":"found the issue"}'

TASK_ID="$1"
EVIDENCE="$2"

if [ -z "$TASK_ID" ]; then
    echo "Usage: check-completion.sh <task_id> [evidence_json]"
    echo ""
    echo "Available task IDs: ${TASK_IDS:-none defined}"
    exit 1
fi

CALLBACK_URL="${CALLBACK_URL:?CALLBACK_URL environment variable is not set}"
CALLBACK_TOKEN="${CALLBACK_TOKEN:?CALLBACK_TOKEN environment variable is not set}"

PAYLOAD="{\"task_id\":\"${TASK_ID}\""
if [ -n "$EVIDENCE" ]; then
    PAYLOAD="${PAYLOAD},\"evidence\":${EVIDENCE}"
fi
PAYLOAD="${PAYLOAD}}"

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$CALLBACK_URL" \
    -H "Content-Type: application/json" \
    -H "X-Callback-Token: $CALLBACK_TOKEN" \
    -d "$PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
    echo "Task '$TASK_ID' reported successfully"
    echo "$BODY"
else
    echo "Error reporting task '$TASK_ID' (HTTP $HTTP_CODE)"
    echo "$BODY"
    exit 1
fi
