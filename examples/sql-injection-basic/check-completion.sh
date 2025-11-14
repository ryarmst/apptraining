#!/bin/bash

# This script checks if a specific goal has been completed and reports back to the orchestrator

GOAL_ID=$1
TOKEN=$2
DATA=$3
CALLBACK_URL=${CALLBACK_URL:-"http://localhost:3000/api/containers/${TRAINING_SUBDOMAIN}/complete"}

# Validate input
if [ -z "$GOAL_ID" ] || [ -z "$TOKEN" ]; then
    echo "Usage: $0 <goal_id> <token> [data]"
    exit 1
fi

# Create JSON payload
PAYLOAD="{\"goal_id\":\"$GOAL_ID\",\"token\":\"$TOKEN\""
if [ ! -z "$DATA" ]; then
    PAYLOAD="$PAYLOAD,\"data\":$DATA"
fi
PAYLOAD="$PAYLOAD}"

# Send completion notification to orchestrator
curl -X POST "$CALLBACK_URL" \
     -H "Content-Type: application/json" \
     -d "$PAYLOAD"

exit $? 