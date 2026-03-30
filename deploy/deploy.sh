#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVER_HOST="${DEPLOY_HOST:?Set DEPLOY_HOST to your server Elastic IP}"
SERVER_USER="${DEPLOY_USER:-ubuntu}"
SSH_KEY="${DEPLOY_KEY:-$HOME/.ssh/lunarwars-key.pem}"

echo "=== Building client ==="
cd "$PROJECT_DIR"
VITE_WS_SERVER_URL="ws://${SERVER_HOST}/ws" npm run build

echo "=== Uploading client files ==="
rsync -avz --delete \
  --exclude='rl_model_weights.json' \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  dist/ "${SERVER_USER}@${SERVER_HOST}:/var/www/lunarwars/"

echo "=== Uploading server files ==="
rsync -avz \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  server/package.json server/server.ts \
  "${SERVER_USER}@${SERVER_HOST}:/opt/lunarwars/server/"

echo "=== Uploading Caddy + PM2 config ==="
rsync -avz \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  deploy/Caddyfile "${SERVER_USER}@${SERVER_HOST}:/tmp/Caddyfile"
rsync -avz \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  deploy/ecosystem.config.cjs "${SERVER_USER}@${SERVER_HOST}:/opt/lunarwars/"

echo "=== Installing deps + restarting services ==="
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SERVER_USER}@${SERVER_HOST}" \
  "cd /opt/lunarwars/server && npm install --production=false && cd /opt/lunarwars && pm2 startOrRestart ecosystem.config.cjs && pm2 save && sudo cp /tmp/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy"

echo "=== Deploy complete ==="
echo "Game is live at http://${SERVER_HOST}"
