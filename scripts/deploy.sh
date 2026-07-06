#!/bin/bash
set -euo pipefail
cd /opt/ai-key-hub
git fetch origin main
git reset --hard origin/main
npm install --omit=dev
systemctl restart ai-key-hub
sleep 3
systemctl is-active ai-key-hub
curl -s http://127.0.0.1:8899/api/health
echo
