#!/usr/bin/env bash
#
# install-vps.sh — Provisionnement VPS IONOS (Ubuntu 24.04) pour l'Anonymiseur judiciaire.
#
# Installe Node.js, poppler-utils, tesseract-ocr (+ langue fra), pm2, nginx et certbot,
# déploie l'application sous un utilisateur système dédié (non-root) et démarre le
# service via pm2.
#
# Usage (en root, sur le VPS) :
#   REPO_URL="https://github.com/gtl92/anonymiseur-railway.git" \
#   BRANCH="main" \
#   DOMAIN="anonymiseur.jobiizy.com" \
#   ./install-vps.sh
#
# Idempotent : peut être relancé sans effet de bord destructeur.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/gtl92/anonymiseur-railway.git}"
BRANCH="${BRANCH:-main}"
DOMAIN="${DOMAIN:-anonymiseur.jobiizy.com}"
APP_USER="${APP_USER:-anonymiseur}"
APP_DIR="${APP_DIR:-/opt/anonymiseur-railway}"
NODE_MAJOR="${NODE_MAJOR:-20}"

if [[ $EUID -ne 0 ]]; then
  echo "Ce script doit être exécuté en root (sudo)." >&2
  exit 1
fi

echo "== 1/8 Mise à jour du système =="
apt-get update -y
apt-get upgrade -y

echo "== 2/8 Dépendances système : poppler-utils, tesseract-ocr (fra), git, ufw, nginx, certbot =="
apt-get install -y \
  curl ca-certificates gnupg git ufw \
  poppler-utils \
  tesseract-ocr tesseract-ocr-fra \
  nginx \
  certbot python3-certbot-nginx

echo "== 3/8 Node.js ${NODE_MAJOR}.x (NodeSource) =="
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

echo "== 4/8 pm2 (process manager) =="
npm install -g pm2

echo "== 5/8 Utilisateur système dédié (non-root) =="
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

echo "== 6/8 Déploiement du code =="
if [[ -d "$APP_DIR/.git" ]]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch origin "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  mkdir -p "$APP_DIR"
  chown "$APP_USER:$APP_USER" "$APP_DIR"
  sudo -u "$APP_USER" git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --omit=dev

echo "== 7/8 Configuration (.env) =="
TESSDATA_PATH="$(find /usr/share/tesseract-ocr -maxdepth 2 -iname tessdata -type d | head -n1)"
if [[ -z "$TESSDATA_PATH" ]]; then
  echo "Impossible de localiser le dossier tessdata." >&2
  exit 1
fi

ENV_FILE="$APP_DIR/.env"
cat > "$ENV_FILE" <<EOF
PORT=3000
TESSDATA_PATH=${TESSDATA_PATH}
# Le front est servi par ce serveur (même origine) : pas de CORS externe nécessaire.
ALLOWED_ORIGINS=
UPLOAD_DIR=${APP_DIR}/tmp/uploads
EOF
chown "$APP_USER:$APP_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

mkdir -p /var/log/anonymiseur
chown "$APP_USER:$APP_USER" /var/log/anonymiseur

echo "== 8/8 pm2 : démarrage du service =="
cp "$APP_DIR/deploy/ecosystem.config.cjs" "$APP_DIR/ecosystem.config.cjs"
sudo -u "$APP_USER" env HOME="/home/$APP_USER" pm2 start "$APP_DIR/ecosystem.config.cjs"
sudo -u "$APP_USER" env HOME="/home/$APP_USER" pm2 save

# pm2 startup : génère la commande systemd à exécuter en root (une fois)
env PM2_HOME="/home/$APP_USER/.pm2" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" | tail -n1 > /tmp/pm2-startup-cmd.sh
bash /tmp/pm2-startup-cmd.sh || true
rm -f /tmp/pm2-startup-cmd.sh

echo "== Pare-feu (ufw) : SSH + HTTP/HTTPS uniquement =="
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo
echo "=================================================================="
echo " Application démarrée via pm2 sous l'utilisateur '${APP_USER}'."
echo " Prochaine étape : configurer nginx + certbot pour ${DOMAIN}"
echo "   cp ${APP_DIR}/deploy/nginx.conf /etc/nginx/sites-available/${DOMAIN}"
echo "   ln -s /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/"
echo "   nginx -t && systemctl reload nginx"
echo "   certbot --nginx -d ${DOMAIN}"
echo " Voir deploy/DEPLOY.md pour la procédure complète."
echo "=================================================================="
