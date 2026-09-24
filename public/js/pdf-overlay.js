/**
 * pdf-overlay.js — Surlignage des entités directement sur le rendu du document
 * (au lieu du texte extrait seul), sur le modèle de la vue "Original" de
 * LibreJustice /redact.
 *
 * Deux sources possibles, unifiées sur un même modèle de page :
 * - PDF texte natif : rendu par pdfjs-dist (100% navigateur, aucun envoi au
 *   serveur) — page.getTextContent() donne la position de chaque fragment.
 * - PDF scanné (OCR) : image de page + positions par mot renvoyées par
 *   server.js (tesseract), aucune position n'est recalculée côté client.
 *
 * Toutes les positions sont normalisées en fractions [0..1] de la largeur/
 * hauteur de page — insensible au zoom/redimensionnement de l'affichage.
 *
 * createPdfOverlay() renvoie une instance indépendante (ses propres pages,
 * son propre conteneur DOM) : l'app en crée une par emplacement d'affichage
 * (ex. panneau gauche step 2, panneau droit step 3) pour éviter qu'une
 * instance n'efface le rendu d'une autre en se rechargeant.
 */

// pdfjs est un singleton navigateur (worker global) : sa configuration ne
// dépend d'aucune instance et ne se fait qu'une fois, quel que soit le
// nombre d'overlays créés par createPdfOverlay().
let _pdfjsReady = false;
function ensurePdfjs() {
  if (_pdfjsReady) return true;
  if (typeof pdfjsLib === 'undefined') return false;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdfjs/pdf.worker.min.js';
  _pdfjsReady = true;
  return true;
}

// ── Découpage d'un fragment de texte pdfjs en mots + position fractionnelle
// sur la largeur du fragment (approximation proportionnelle au nombre de
// caractères — suffisant pour un rectangle de surlignage, pas pour une
// sélection pixel-perfect). ─────────────────────────────────────────────────
function splitFragmentIntoWords(str) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    out.push({
      text:      m[0],
      startFrac: m.index / str.length,
      endFrac:   (m.index + m[0].length) / str.length,
    });
  }
  return out;
}

/** Mots + position (fractions de page) d'une page pdfjs déjà chargée. */
async function nativePageWords(page, viewport) {
  const content = await page.getTextContent();
  const words = [];
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    // item.width est déjà exprimé par pdfjs à l'échelle "police normale"
    // (avance du glyphe × taille de police) — le multiplier par tx[0]/tx[1]
    // (qui inclut LUI AUSSI la taille de police via la matrice de l'item)
    // comptait la taille de police deux fois et gonflait la largeur d'un
    // facteur ≈ la taille de police (un mot de 10 caractères débordait sur
    // toute la largeur de page). Seule l'échelle du viewport doit s'appliquer.
    const widthPx = item.width * viewport.scale;
    const x = tx[4];
    // tx[5] = position de la LIGNE DE BASE (bas du texte, hors jambages) en
    // pixels viewport. L'ascendant réel couvre ~80% de la hauteur de fonte
    // (le reste est la marge interne de la police) ; on descend un peu sous
    // la ligne de base pour couvrir les jambages (g, p, q, y).
    const yTop    = tx[5] - fontHeight * 0.82;
    const boxH    = fontHeight * 0.98;
    for (const w of splitFragmentIntoWords(item.str)) {
      words.push({
        text:   w.text,
        left:   (x + w.startFrac * widthPx) / viewport.width,
        top:    yTop / viewport.height,
        width:  ((w.endFrac - w.startFrac) * widthPx) / viewport.width,
        height: boxH / viewport.height,
      });
    }
  }
  return words;
}

// ── Correspondance entités ↔ mots de page (pure, partagée entre instances) ──

function foldTok(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function candidateTokenLists(entity) {
  const vals = [entity.value, ...(entity.aliases || [])].filter(Boolean);
  return vals
    .map(v => v.trim().split(/\s+/).map(foldTok).filter(Boolean))
    .filter(toks => toks.length > 0);
}

function rectFromWords(words) {
  const left   = Math.min(...words.map(w => w.left));
  const top    = Math.min(...words.map(w => w.top));
  const right  = Math.max(...words.map(w => w.left + w.width));
  const bottom = Math.max(...words.map(w => w.top + w.height));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Index d'une page — calculé UNE FOIS par page (pas par entité) : les tokens
 * repliés de chaque mot, et la liste des positions où chaque token apparaît.
 * Sans cet index, matchesForPage recalculait pageTokens et scannait tous les
 * mots pour CHAQUE entité — sur un document long avec beaucoup d'entités
 * (typiquement après reprise d'une session déjà bien avancée), le coût
 * explosait (pages × mots × entités) et gelait l'onglet le temps du calcul.
 */
function buildPageWordIndex(pageWords) {
  const tokens = pageWords.map(w => foldTok(w.text));
  const byFirstToken = new Map(); // token replié → [indices de mots qui commencent ainsi]
  tokens.forEach((tok, i) => {
    if (!tok) return;
    let arr = byFirstToken.get(tok);
    if (!arr) { arr = []; byFirstToken.set(tok, arr); }
    arr.push(i);
  });
  return { tokens, byFirstToken };
}

/**
 * Rectangles (fractions de page) des occurrences d'une entité sur une page.
 * Un match multi-mots (ex. "Monsieur SCHNEIDER") peut enjamber un saut de
 * ligne pdfjs — fusionner bêtement min/max produirait alors une boîte
 * couvrant toute la zone verticale entre les deux lignes. On découpe donc le
 * span en groupes de mots sur la même ligne (écart vertical < 60% de la
 * hauteur du mot précédent) et on émet un rectangle par groupe.
 *
 * `pageIndex` (buildPageWordIndex) permet de ne partir que des positions du
 * premier token du candidat, au lieu de scanner tous les mots de la page.
 */
function matchesForPage(pageWords, pageIndex, entity) {
  const { tokens, byFirstToken } = pageIndex;
  const rects = [];
  for (const cand of candidateTokenLists(entity)) {
    const starts = byFirstToken.get(cand[0]);
    if (!starts) continue;
    for (const i of starts) {
      if (i + cand.length > tokens.length) continue;
      let ok = true;
      for (let j = 1; j < cand.length; j++) {
        if (tokens[i + j] !== cand[j]) { ok = false; break; }
      }
      if (!ok) continue;
      const span = pageWords.slice(i, i + cand.length);
      let group = [span[0]];
      for (let k = 1; k < span.length; k++) {
        const prev = span[k - 1], cur = span[k];
        const sameLine = Math.abs(cur.top - prev.top) < prev.height * 0.6;
        if (sameLine) {
          group.push(cur);
        } else {
          rects.push(rectFromWords(group));
          group = [cur];
        }
      }
      rects.push(rectFromWords(group));
    }
  }
  return rects;
}

/** Classe CSS de surlignage par type d'entité (cohérent avec le mode texte). */
function typeClass(type) {
  const t = (type || '').toLowerCase().split('_')[0];
  return `pdfov-hl-${t || 'val'}`;
}

/**
 * Crée une instance de surlignage indépendante, liée à un emplacement
 * d'affichage donné (son propre conteneur DOM, ses propres pages).
 */
function createPdfOverlay() {
  let _pages        = [];  // [{ el, words: [{text,left,top,width,height}] (fractions 0..1) }]
  let _container    = null;
  let _lastEntities = null; // pour redessiner une fois les images OCR chargées (async)
  // Jeton de build : si un second appel à loadNative/loadOcr démarre avant
  // que le premier ait fini (ex. double clic sur l'onglet "Original" pendant
  // le rendu d'un gros PDF), l'appel périmé doit s'arrêter au lieu de
  // continuer à ajouter des pages dans le désordre au conteneur.
  let _buildId = 0;

  function clear() {
    _pages = [];
    _lastEntities = null;
    _zoom = 1;
    if (_container) _container.innerHTML = '';
  }

  /**
   * Charge et rend un PDF texte natif dans `container` (un <canvas> par
   * page + calque de surlignage). `blobUrl` : URL du fichier original déjà
   * en mémoire côté client (State.sourceBlobUrl) — rien n'est renvoyé au
   * serveur pour ce chemin.
   */
  async function loadNative(blobUrl, container) {
    const myBuild = ++_buildId;
    clear();
    _container = container;
    if (!ensurePdfjs() || !blobUrl) return false;

    let doc;
    try {
      doc = await pdfjsLib.getDocument(blobUrl).promise;
    } catch (err) {
      console.error('[PdfOverlay] échec chargement pdfjs, repli sur l\'iframe brute :', err);
      return false;
    }
    if (myBuild !== _buildId) return false; // supersédé pendant le chargement du document

    for (let n = 1; n <= doc.numPages; n++) {
      if (myBuild !== _buildId) return false; // un appel plus récent a pris le relais

      const page     = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1.5 });

      const pageEl = document.createElement('div');
      pageEl.className = 'pdfov-page';

      const canvas = document.createElement('canvas');
      canvas.width  = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (myBuild !== _buildId) return false;

      pageEl.appendChild(canvas);
      container.appendChild(pageEl);

      const words = await nativePageWords(page, viewport);
      if (myBuild !== _buildId) return false;
      _pages.push({ el: pageEl, words, naturalWidth: viewport.width });
    }
    applyZoom();
    return true;
  }

  /**
   * Affiche des pages déjà OCRisées : `pageImages` (data URL base64, une par
   * page) + `pageBoxes` (positions par mot en pixels natifs de l'image,
   * renvoyées par server.js — cf. extractPdfOcr).
   */
  function loadOcr(pageImages, pageBoxes, container) {
    const myBuild = ++_buildId;
    clear();
    _container = container;
    if (!pageImages || !pageImages.length) return Promise.resolve(false);

    // Résolu dès que la 1ère page a ses dimensions naturelles (suffisant pour
    // fitZoom() — les pages d'un même PDF scanné partagent la même taille) ;
    // les pages suivantes se complètent en arrière-plan sans bloquer l'appelant.
    let resolveFirstLoaded;
    const firstLoaded = new Promise(res => { resolveFirstLoaded = res; });

    pageImages.forEach((src, i) => {
      const pageEl = document.createElement('div');
      pageEl.className = 'pdfov-page';

      const img = document.createElement('img');
      img.src = src;
      img.alt = `Page ${i + 1}`;
      pageEl.appendChild(img);
      container.appendChild(pageEl);

      const boxes = (pageBoxes && pageBoxes[i] && pageBoxes[i].words) || [];
      const words = [];
      img.addEventListener('load', () => {
        if (myBuild !== _buildId) return; // supersédé par un appel plus récent
        const nw = img.naturalWidth  || 1;
        const nh = img.naturalHeight || 1;
        for (const b of boxes) {
          words.push({
            text:   b.text,
            left:   b.x0 / nw,
            top:    b.y0 / nh,
            width:  (b.x1 - b.x0) / nw,
            height: (b.y1 - b.y0) / nh,
          });
        }
        _pages[i].words = words;
        _pages[i].naturalWidth = nw;
        applyZoom();
        if (i === 0) resolveFirstLoaded();
        if (_lastEntities) highlight(_lastEntities); // rattrape le surlignage demandé avant chargement
      }, { once: true });

      _pages.push({ el: pageEl, words: [], naturalWidth: null }); // rempli au onload
    });
    return firstLoaded.then(() => true);
  }

  // ── Zoom ──────────────────────────────────────────────────────────────────
  // 1.0 = taille native du rendu (viewport.scale=1.5 pour le PDF, résolution
  // native de l'image pour l'OCR). Chaque page reçoit une largeur CSS
  // explicite ; le rapport largeur/hauteur suit via `height: auto` sur le
  // canvas/l'image.
  let _zoom = 1;

  function applyZoom() {
    for (const p of _pages) {
      if (p.naturalWidth) p.el.style.width = (p.naturalWidth * _zoom) + 'px';
    }
  }

  function setZoom(zoom) {
    _zoom = Math.max(0.25, Math.min(4, zoom));
    applyZoom();
    return _zoom;
  }

  function getZoom() {
    return _zoom;
  }

  /** Zoom qui fait tenir la page dans la largeur du conteneur (moins la marge). */
  function fitZoom() {
    if (!_container || !_pages.length || !_pages[0].naturalWidth) return _zoom;
    const available = _container.clientWidth - 24; // padding du conteneur
    return setZoom(available / _pages[0].naturalWidth);
  }

  function pageCount() {
    return _pages.length;
  }

  function scrollToPage(n) {
    const p = _pages[n - 1];
    if (p) p.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /**
   * (Re)dessine les surlignages pour la liste d'entités actives fournie.
   * Idempotent : retire les surlignages précédents avant de redessiner.
   */
  function highlight(entities) {
    _lastEntities = entities;
    if (!_pages.length) return;
    const active = (entities || []).filter(e => e && e.active && !e.blocked && e.value);

    for (const page of _pages) {
      page.el.querySelectorAll('.pdfov-hl').forEach(n => n.remove());
      if (!page.words.length) continue;
      // Index recalculé seulement si les mots de la page ont changé (ex.
      // page OCR dont le chargement se termine après un 1er appel) —
      // sinon réutilisé tel quel, highlight() pouvant être appelé souvent
      // (édition d'entités, zoom, changement d'onglet…).
      if (page._wordIndexFor !== page.words) {
        page._wordIndex    = buildPageWordIndex(page.words);
        page._wordIndexFor = page.words;
      }
      for (const entity of active) {
        for (const rect of matchesForPage(page.words, page._wordIndex, entity)) {
          const box = document.createElement('div');
          box.className = `pdfov-hl ${typeClass(entity.type)}`;
          box.style.left   = (rect.left   * 100) + '%';
          box.style.top    = (rect.top    * 100) + '%';
          box.style.width  = (rect.width  * 100) + '%';
          box.style.height = (rect.height * 100) + '%';
          box.title = entity.value;
          page.el.appendChild(box);
        }
      }
    }
  }

  function isReady() {
    return _pages.length > 0;
  }

  return {
    loadNative, loadOcr, highlight, clear, isReady,
    setZoom, getZoom, fitZoom, pageCount, scrollToPage,
  };
}
