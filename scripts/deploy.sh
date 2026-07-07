#!/bin/bash
set -euo pipefail
cd /opt/ai-key-hub
git fetch origin main
git reset --hard origin/main
if ! docker ps --format '{{.Names}}' | grep -q '^ai-key-hub-chroma$'; then
  docker compose up -d chroma || true
fi
npm install --omit=dev || true
systemctl restart ai-key-hub
sleep 5
systemctl is-active ai-key-hub
curl -s http://127.0.0.1:8899/api/health
echo
