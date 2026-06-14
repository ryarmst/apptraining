#!/usr/bin/env bash
# Installed by setup-vps.sh — restarts apptraining after cert renewal
set -euo pipefail
cd ~/apptraining
docker compose -f docker-compose.prod.yml up -d --force-recreate
