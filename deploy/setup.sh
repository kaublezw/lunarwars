#!/bin/bash
set -euo pipefail

echo "=== Updating system ==="
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl

echo "=== Installing Caddy ==="
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

echo "=== Installing Node.js 20 LTS ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "=== Installing PM2 ==="
sudo npm install -g pm2

echo "=== Creating app directories ==="
sudo mkdir -p /var/www/lunarwars
sudo mkdir -p /opt/lunarwars/server
sudo chown -R ubuntu:ubuntu /var/www/lunarwars /opt/lunarwars

echo "=== Configuring PM2 systemd startup ==="
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu

echo "=== Setup complete ==="
