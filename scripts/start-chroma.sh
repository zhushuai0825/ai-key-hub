#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose up -d chroma
sleep 2
curl -sf http://127.0.0.1:8000/api/v2/heartbeat >/dev/null || curl -sf http://127.0.0.1:8000/api/v1/heartbeat >/dev/null && echo "Chroma is running on http://127.0.0.1:8000"
