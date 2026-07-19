# Déploiement VPS IONOS — Anonymiseur judiciaire

Ce document décrit la mise en production sur le VPS IONOS (`82.165.182.173`,
Ubuntu 24.04) et la bascule DNS depuis Railway.

> **Important** : ces étapes nécessitent un accès SSH root réel au VPS et un
> accès au dashboard Cloudflare. Aucun agent automatisé n'a ces accès — la
> procédure ci-dessous est à exécuter manuellement (ou via un pipeline CI
> disposant des secrets nécessaires) par un opérateur.

## 0. Pré-requis

- Accès SSH root à `82.165.182.173`.
- Accès au dashboard Cloudflare pour la zone `jobiizy.com`.
- Le dépôt `gtl92/anonymiseur-railway`, branche `main` (ou celle à déployer),
  accessible en clone depuis le VPS (HTTPS + PAT, ou clé de déploiement).

## 1. Provisionnement du VPS

Sur le VPS, en root :

```bash
git clone https://github.com/gtl92/anonymiseur-railway.git /tmp/anonymiseur-bootstrap
cd /tmp/anonymiseur-bootstrap
chmod +x deploy/install-vps.sh
REPO_URL="https://github.com/gtl92/anonymiseur-railway.git" \
BRANCH="main" \
DOMAIN="anonymiseur.jobiizy.com" \
./deploy/install-vps.sh
```

Le script (`deploy/install-vps.sh`) :

1. Met à jour le système.
2. Installe `poppler-utils`, `tesseract-ocr` + `tesseract-ocr-fra`, `git`, `nginx`, `certbot`.
3. Installe Node.js 20.x (NodeSource) et `pm2` (global).
4. Crée un utilisateur système **non-root** dédié (`anonymiseur`) — l'app ne
   tourne jamais en root.
5. Clone/déploie le code dans `/opt/anonymiseur-railway`, `npm ci --omit=dev`.
6. Génère `.env` avec le `TESSDATA_PATH` détecté automatiquement
   (`/usr/share/tesseract-ocr/5/tessdata` sur Ubuntu 24.04), et
   `ALLOWED_ORIGINS` vide (le front est servi en same-origin, pas de CORS
   externe nécessaire).
7. Démarre l'app via pm2 (`deploy/ecosystem.config.cjs`), `pm2 save` +
   `pm2 startup` (redémarrage automatique au reboot du VPS).
8. Active `ufw` (SSH + HTTP/HTTPS uniquement).

Est idempotent : relançable sans effet destructeur (utile pour les mises à
jour de code : `git pull` + `pm2 restart anonymiseur`).

## 2. nginx + certbot (HTTPS)

```bash
cp /opt/anonymiseur-railway/deploy/nginx.conf /etc/nginx/sites-available/anonymiseur.jobiizy.com
ln -s /etc/nginx/sites-available/anonymiseur.jobiizy.com /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

certbot --nginx -d anonymiseur.jobiizy.com --redirect --hsts
```

`certbot --nginx --redirect` garantit que le port 80 ne fait **que**
rediriger vers HTTPS (aucun contenu servi en clair). Vérifier après coup :

```bash
curl -I http://anonymiseur.jobiizy.com/   # doit renvoyer 301 → https://
```

Le renouvellement auto du certificat est géré par le timer systemd
`certbot.timer` installé avec le paquet — vérifier :

```bash
systemctl status certbot.timer
```

## 3. Bascule DNS Cloudflare

Le domaine `anonymiseur.jobiizy.com` pointe actuellement vers Railway. Sur
le dashboard Cloudflare, zone `jobiizy.com` :

1. **Avant** de couper Railway : créer/modifier l'enregistrement `A`
   `anonymiseur` → `82.165.182.173`.
   - Mode **DNS only (nuage gris)** le temps de valider que le VPS répond
     correctement en HTTPS avec le bon certificat, PUIS repasser en
     **Proxied (nuage orange)** si vous voulez le CDN/WAF Cloudflare.
   - TTL bas (ex: 300s) le temps de la bascule pour limiter la propagation.
2. Attendre la propagation (`dig anonymiseur.jobiizy.com`), tester en HTTPS
   directement sur l'IP avec `Host:` forcé si besoin avant coupure complète :
   ```bash
   curl -sI --resolve anonymiseur.jobiizy.com:443:82.165.182.173 https://anonymiseur.jobiizy.com/api/status
   ```
3. Une fois confirmé, retirer/désactiver l'app Railway pour ce domaine.
4. Ne conserver **aucun** enregistrement pointant vers Railway pour ce host.

## 4. Gestion du process (pm2)

```bash
sudo -u anonymiseur pm2 status
sudo -u anonymiseur pm2 logs anonymiseur       # stdout/stderr — ne doit jamais contenir de nom/contenu de fichier
sudo -u anonymiseur pm2 restart anonymiseur    # après un déploiement de code
```

Mise à jour de code :

```bash
cd /opt/anonymiseur-railway
sudo -u anonymiseur git pull origin main
sudo -u anonymiseur npm ci --omit=dev
sudo -u anonymiseur pm2 restart anonymiseur
```

## 5. Checklist de tests post-bascule

À exécuter contre `https://anonymiseur.jobiizy.com` :

- [ ] `GET /api/status` → `{"ok":true,"poppler":true,"tesseract":true,"docx":true}`
- [ ] Upload PDF **natif** (texte sélectionnable) → `method: "native"`, texte correct
- [ ] Upload PDF **scanné** → `method: "ocr"`, texte reconnu correctement (français)
- [ ] Upload **DOCX** → `method: "docx"`, texte extrait correctement
- [ ] Blacklist : `POST /api/blacklist` puis `GET /api/blacklist` → persiste après
      `pm2 restart` (fichier `data/blacklist.json` sur disque, hors volume éphémère)
- [ ] `http://anonymiseur.jobiizy.com/` → redirige en 301 vers `https://`
- [ ] Aucun avertissement de certificat navigateur (certbot valide)
- [ ] `pm2 logs anonymiseur` après plusieurs uploads : aucun nom de fichier ni
      contenu de document dans les logs
- [ ] `ls /opt/anonymiseur-railway/tmp/uploads /opt/anonymiseur-railway/tmp/ocr`
      vides après traitement (y compris après une requête en erreur — tuer un
      upload en cours puis vérifier qu'aucun fichier orphelin ne reste)
- [ ] Le message d'en-tête du front ("Traitement sur serveur dédié · Aucun
      tiers externe") reflète bien l'architecture réelle

## 6. Rollback

Si la bascule pose problème : repointer l'enregistrement `A` Cloudflare
vers l'IP/CNAME Railway précédent (le service Railway restera actif tant
qu'il n'a pas été explicitement supprimé — ne le supprimer qu'après
validation complète de la bascule VPS).
