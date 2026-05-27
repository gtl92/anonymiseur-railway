/**
 * server.js — Client de l'API locale (serveur_local.py)
 * Gère : statut serveur, extraction de fichiers, blacklist persistante.
 */

const Server = (() => {

  const BASE = window.location.origin;
  let _currentXhr = null; // XHR en cours d'extraction

  /** Annule l'extraction en cours si elle existe */
  function cancelExtract() {
    if (_currentXhr) {
      _currentXhr.abort();
      _currentXhr = null;
    }
  }

  // ── Statut ────────────────────────────────────────────────────────────────

  async function getStatus() {
    try {
      const r = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(2000) });
      return await r.json();
    } catch {
      return null;
    }
  }

  // ── Extraction de fichier ─────────────────────────────────────────────────

  /**
   * Envoie un fichier au serveur pour extraction.
   * @param {File} file
   * @param {function(number, string):void} [onProgress]  callback(pct 0-100, phase)
   * @returns {{ text, method, filename }}
   */
  function extractFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('file', file, file.name);

      const xhr = new XMLHttpRequest();
      _currentXhr = xhr;
      let simulTimer = null;

      // ── Progression simulée pendant le traitement serveur (75 → 93%) ─────
      // Le serveur ne renvoie rien pendant l'extraction — on simule
      // une progression lente avec des messages contextuels.
      function startSimulatedProgress() {
      const isLarge = file.size > 500_000; // > 500 Ko → OCR probable
        const steps = [
          { pct: 77, msg: 'Analyse du document…' },
          { pct: 80, msg: 'Lecture du texte…' },
          { pct: 83, msg: isLarge ? 'OCR en cours — analyse des pages…' : 'Extraction du texte…' },
          { pct: 85, msg: isLarge ? 'OCR en cours — peut prendre plusieurs minutes…' : 'Nettoyage du texte…' },
          { pct: 87, msg: isLarge ? 'OCR en cours — traitement page par page…' : 'Finalisation…' },
          { pct: 88, msg: 'OCR en cours — patience, presque terminé…' },
          { pct: 89, msg: 'OCR en cours — dernières pages…' },
          { pct: 90, msg: 'Vérification du résultat…' },
          { pct: 91, msg: 'Assemblage du texte extrait…' },
          { pct: 92, msg: 'Traitement en cours — le serveur travaille toujours…' },
          { pct: 93, msg: 'Traitement en cours…' },
        ];
        // Intervalles progressivement plus longs (total ~8 min de couverture)
        const delays = [1500, 2500, 4000, 6000, 8000, 12000, 15000, 20000, 30000, 45000, 60000];
        let i = 0;
        function tick() {
          if (i >= steps.length) return; // plateau à 93%
          if (onProgress) onProgress(steps[i].pct, steps[i].msg);
          simulTimer = setTimeout(tick, delays[i] || 10000);
          i++;
        }
        simulTimer = setTimeout(tick, 800);
      }

      // ── Progression de l'upload (0 → 74%) ────────────────────────────────
      let rampStarted = false;
      if (onProgress) {
        xhr.upload.onprogress = e => {
          if (e.lengthComputable && e.total > 0) {
            rampStarted = true; // onprogress natif actif → annuler la rampe simulée
            clearTimeout(rampTimer);
            const pct = Math.round((e.loaded / e.total) * 74);
            onProgress(pct, `Envoi du fichier… ${pct} %`);
          }
        };
        xhr.upload.onload = () => {
          if (rampStarted) {
            onProgress(75, 'Traitement serveur…');
            startSimulatedProgress();
          }
        };
      }

      xhr.onload = () => {
        clearTimeout(simulTimer);
        _currentXhr = null;
        if (onProgress) onProgress(97, 'Finalisation…');
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 400) {
            reject(new Error(data.error || `Erreur serveur ${xhr.status}`));
          } else {
            resolve(data);
          }
        } catch {
          reject(new Error('Réponse serveur invalide'));
        }
      };

      xhr.onabort   = () => { clearTimeout(simulTimer); _currentXhr = null; reject(new Error('__CANCELLED__')); };
      xhr.onerror   = () => { clearTimeout(simulTimer); _currentXhr = null; reject(new Error('Erreur réseau — serveur inaccessible')); };
      xhr.ontimeout = () => { clearTimeout(simulTimer); _currentXhr = null; reject(new Error('Délai dépassé — le serveur ne répond pas')); };
      xhr.timeout   = 900000;

      xhr.open('POST', `${BASE}/api/extract`);
      xhr.send(form);

      // Rampe simulée (localhost = upload instantané, onprogress ne tire pas)
      // Si onprogress natif se déclenche, rampStarted = true et on annule.
      let rampTimer = null;
      if (onProgress && !rampStarted) {
        const ramp = [
          { pct: 5,  delay: 0,    msg: 'Envoi du fichier…' },
          { pct: 20, delay: 200,  msg: 'Envoi du fichier…' },
          { pct: 40, delay: 500,  msg: 'Réception par le serveur…' },
          { pct: 60, delay: 900,  msg: 'Analyse en cours…' },
          { pct: 75, delay: 1400, msg: 'Traitement serveur…' },
        ];
        ramp.forEach(({ pct, delay, msg }) => {
          rampTimer = setTimeout(() => {
            if (!rampStarted) onProgress(pct, msg);
          }, delay);
        });
        setTimeout(() => {
          if (!rampStarted) startSimulatedProgress();
        }, 1600);
      }
    });
  }

  // ── Blacklist ─────────────────────────────────────────────────────────────

  async function loadBlacklist() {
    try {
      const r = await fetch(`${BASE}/api/blacklist`);
      const data = await r.json();
      return data.words || [];
    } catch {
      return [];
    }
  }

  async function saveBlacklist(words) {
    const r = await fetch(`${BASE}/api/blacklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words }),
    });
    return await r.json();
  }

  async function loadCustomTypes() {
    try {
      const r = await fetch(`${BASE}/api/custom_types`);
      const data = await r.json();
      return data.types || [];
    } catch { return []; }
  }

  async function saveCustomTypes(types) {
    try {
      const r = await fetch(`${BASE}/api/custom_types`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ types }),
      });
      return await r.json();
    } catch { return null; }
  }

  return { getStatus, extractFile, cancelExtract, loadBlacklist, saveBlacklist,
           loadCustomTypes, saveCustomTypes };
})();