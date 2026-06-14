#!/usr/bin/env bash
set -euo pipefail

DOMAIN="127.0.0.1.nip.io"
CERT_DIR="/etc/ssl/certs/apptraining"
KEY_DIR="/etc/ssl/private/apptraining"
CERT_PATH="$CERT_DIR/apptraining.pem"
KEY_PATH="$KEY_DIR/apptraining.key"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Creating SSL directories..."
sudo mkdir -p "$CERT_DIR" "$KEY_DIR"

echo "==> Generating self-signed wildcard certificate for $DOMAIN..."
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout "$KEY_PATH" \
  -out "$CERT_PATH" \
  -subj "/CN=$DOMAIN" \
  -addext "subjectAltName=DNS:$DOMAIN,DNS:*.$DOMAIN,DNS:*.apptraining.$DOMAIN"

echo "==> Using nip.io for wildcard DNS (no local DNS config required)..."
echo "    Domain: $DOMAIN"
echo "    Subdomains like <uuid>.$DOMAIN will resolve to 127.0.0.1 via nip.io"

echo "==> Creating .env from .env.example..."
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  SESSION_SECRET=$(openssl rand -hex 32)
  sed \
    -e "s|PLATFORM_DOMAIN=yourdomain.local|PLATFORM_DOMAIN=$DOMAIN|" \
    -e "s|SESSION_SECRET=change-me-to-a-random-string|SESSION_SECRET=$SESSION_SECRET|" \
    "$SCRIPT_DIR/.env.example" > "$SCRIPT_DIR/.env"
  echo "    .env created."
else
  echo "    .env already exists, skipping."
fi

echo "==> Installing npm dependencies..."
cd "$SCRIPT_DIR"
npm install

echo "==> Starting server..."
sudo node src/server.js
