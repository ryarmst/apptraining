#!/bin/bash

# This script is used by exercises to report completion status
# Usage: check-completion.sh <goal_id> <token> [data]

GOAL_ID="$1"
TOKEN="$2"
DATA="$3"

if [ -z "$GOAL_ID" ] || [ -z "$TOKEN" ]; then
    echo "Usage: check-completion.sh <goal_id> <token> [data]"
    exit 1
fi

# Get the container's subdomain from the hostname
SUBDOMAIN=$(hostname)

# Send completion request to the platform
curl -X POST -H "Content-Type: application/json" \
     -d "{\"goal_id\": \"$GOAL_ID\", \"token\": \"$TOKEN\", \"data\": $DATA}" \
     "https://apptraining.dbg.local/api/containers/$SUBDOMAIN/complete" 