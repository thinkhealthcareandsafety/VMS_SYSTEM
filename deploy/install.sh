#!/bin/bash
# Sets up the visitor system on a fresh Ubuntu Server 24.04 mini PC. Run from the project folder:
#   sudo bash deploy/install.sh
# Safe to run again: it only adds what is missing, then starts (or updates) the system.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo bash deploy/install.sh"; exit 1; }

say "1/6 Time zone and automatic security updates"
timedatectl set-timezone Asia/Kolkata
apt-get update -qq
apt-get install -y -qq unattended-upgrades ufw openssl ca-certificates curl >/dev/null
dpkg-reconfigure -f noninteractive unattended-upgrades

say "2/6 Docker"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null

say "3/6 Firewall: only https from the hotel network, and SSH"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

say "4/6 Settings file"
if [ ! -f .env ]; then
  cp site.env.example .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
  sed -i "s|^ID_ENCRYPTION_KEY=.*|ID_ENCRYPTION_KEY=$(openssl rand -hex 32)|" .env
  chmod 600 .env
  echo "Created deploy/.env with fresh secrets. Fill LAN_HOST (and CF_API_TOKEN, TUNNEL_TOKEN for the hotel), then run this again:"
  echo "  nano deploy/.env"
  exit 0
fi
set -a; . ./.env; set +a
for v in LAN_HOST JWT_SECRET ID_ENCRYPTION_KEY; do
  [ -n "${!v:-}" ] || { echo "deploy/.env: $v is empty. Fill it in (nano deploy/.env) and run again."; exit 1; }
done
# Without a Cloudflare token: trial mode, own certificate on the PC's IP. Without a tunnel: nothing reaches it from outside.
# Written into .env, so every later docker compose command (updates, restarts) keeps the same choice.
keep() { grep -q "^$1=" .env && sed -i "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env; }
if [ -n "${CF_API_TOKEN:-}" ]; then keep CADDYFILE Caddyfile; else keep CADDYFILE Caddyfile.trial; echo "Trial mode: no CF_API_TOKEN, this PC makes its own certificate for https://$LAN_HOST"; fi
if [ -n "${TUNNEL_TOKEN:-}" ]; then keep COMPOSE_PROFILES tunnel; else keep COMPOSE_PROFILES ""; echo "No TUNNEL_TOKEN: hosts' links open only on this network"; fi

say "5/6 Data and backup folders"
mkdir -p "$DATA_DIR"/{mongo,uploads,caddy} "$BACKUP_DIR"
chown -R 1000:1000 "$DATA_DIR/uploads"
mountpoint -q "$BACKUP_DIR" || echo "Warning: $BACKUP_DIR is not a separate drive yet. Mount the backup SSD there (docs/ONSITE.md, step 4)."

say "6/6 Building and starting (the first time takes 5 to 10 minutes)"
docker compose up -d --build
docker image prune -f >/dev/null

say "Done."
echo "Open https://$LAN_HOST on a tablet on the hotel network."
echo "First admin:  sudo docker compose -f deploy/docker-compose.yml exec app node scripts/create-user.js admin \"Site Admin\" superadmin 'a-long-password'"
