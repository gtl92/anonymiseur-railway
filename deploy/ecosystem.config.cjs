// ecosystem.config.cjs — configuration pm2 pour l'Anonymiseur judiciaire.
// Extension .cjs volontaire : le package.json de l'app est "type": "module",
// mais pm2 charge ce fichier de config en CommonJS.
//
// Les valeurs sensibles (PORT, TESSDATA_PATH, ALLOWED_ORIGINS...) vivent dans
// .env à la racine du projet (chargé par dotenv dans server.js) et ne sont
// pas dupliquées ici.

module.exports = {
  apps: [
    {
      name: 'anonymiseur',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '600M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/var/log/anonymiseur/pm2-error.log',
      out_file: '/var/log/anonymiseur/pm2-out.log',
      merge_logs: true,
      time: true,
      // Les logs pm2 ne doivent JAMAIS contenir de contenu ou de nom de
      // fichier uploadé : server.js ne logue volontairement rien de tel.
      // Ne pas ajouter de middleware de logging (morgan, etc.) qui journalise
      // l'URL complète ou le corps des requêtes multipart.
    },
  ],
};
