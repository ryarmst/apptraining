#!/usr/bin/env bash
# One-time VPS bootstrap for labs.ryarmst.ca
# Run as root on a fresh Ubuntu VPS: bash deploy/setup-vps.sh
set -euo pipefail

APP_DIR="/root/apptraining"
DOMAIN="labs.ryarmst.ca"

echo "==> Installing Docker..."
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
fi

echo "==> Installing certbot..."
apt-get update -qq
apt-get install -y -qq certbot ufw

echo "==> Configuring firewall..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> Creating app directory..."
mkdir -p "$APP_DIR/data" "$APP_DIR/logs" "$APP_DIR/uploads/exercises"

if [ ! -f "$APP_DIR/docker-compose.prod.yml" ]; then
    echo "    Copy docker-compose.prod.yml to $APP_DIR before continuing."
    echo "    (Deploy workflow does this automatically on first push.)"
fi

if [ ! -f "$APP_DIR/.env" ]; then
    echo "==> Creating .env from template..."
    if [ -f "$APP_DIR/deploy/env.example" ]; then
        SESSION_SECRET=$(openssl rand -hex 32)
        sed "s|SESSION_SECRET=generate-with-openssl-rand-hex-32|SESSION_SECRET=$SESSION_SECRET|" \
            "$APP_DIR/deploy/env.example" > "$APP_DIR/.env"
    else
        echo "    Place deploy/env.example at $APP_DIR/deploy/env.example and re-run,"
        echo "    or create $APP_DIR/.env manually."
    fi
fi

echo ""
echo "==> TLS certificate (Let's Encrypt, manual DNS-01)"
echo "    Wildcard certs cannot use HTTP validation — you add TXT records in"
echo "    Cloudflare when certbot prompts you. Run:"
echo ""
echo "      certbot certonly --manual --preferred-challenges dns \\"
echo "        -d $DOMAIN \\"
echo "        -d '*.$DOMAIN' \\"
echo "        --agree-tos \\"
echo "        --register-unsafely-without-email"
echo ""
echo "    In Cloudflare (DNS only / grey cloud for labs records):"
echo "      Type TXT, Name and Value exactly as certbot prints"
echo "      Wait a minute, press Enter in certbot to continue"
echo "      Cert path: /etc/letsencrypt/live/$DOMAIN/"
echo ""

if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    echo "==> Certificate already present at /etc/letsencrypt/live/$DOMAIN"
else
    echo "==> No certificate yet — run the certbot command above before starting the app."
fi

echo "==> Installing certbot renewal hook (restarts app after successful renew)..."
install -m 755 "$(dirname "$0")/certbot-renew-hook.sh" \
    /etc/letsencrypt/renewal-hooks/deploy/restart-apptraining.sh

echo ""
echo "==> GHCR login (required if the image is private)"
echo "    docker login ghcr.io -u YOUR_GITHUB_USERNAME"
echo "    (use a PAT with read:packages scope)"
echo ""
echo "==> DNS (grey cloud / DNS only in Cloudflare):"
echo "    A  labs        -> VPS IP"
echo "    A  *.labs      -> VPS IP"
echo ""
echo "==> GitHub Actions secrets (repo Settings > Secrets):"
echo "    VPS_HOST     = VPS IP"
echo "    VPS_USER     = root"
echo "    VPS_SSH_KEY  = private SSH key"
echo ""
echo "Setup complete. After cert is issued, start the app:"
echo "    cd $APP_DIR && docker compose -f docker-compose.prod.yml pull"
echo "    docker compose -f docker-compose.prod.yml up -d"
