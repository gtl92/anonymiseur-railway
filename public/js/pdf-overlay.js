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
    const scaleX    = Math.hypot(tx[0], tx[1]);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const widthPx    = item.width * scaleX;
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

/** Rectangles fusionnés (fractions de page) des occurrences d'une entité sur une page. */
function matchesForPage(pageWords, entity) {
  const pageTokens = pageWords.map(w => foldTok(w.text));
  const rects = [];
  for (const cand of candidateTokenLists(entity)) {
    for (let i = 0; i <= pageTokens.length - cand.length; i++) {
      let ok = true;
      for (let j = 0; j < cand.length; j++) {
        if (pageTokens[i + j] !== cand[j]) { ok = false; break; }
      }
      if (!ok) continue;
      const span = pageWords.slice(i, i + cand.length);
      const left   = Math.min(...span.map(w => w.left));
      const top    = Math.min(...span.map(w => w.top));
      const right  = Math.max(...span.map(w => w.left + w.width));
      const bottom = Math.max(...span.map(w => w.top + w.height));
      rects.push({ left, top, width: right - left, height: bottom - top });
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

  function clear() {
    _pages = [];
    _lastEntities = null;
    if (_container) _container.innerHTML = '';
  }

  /**
   * Charge et rend un PDF texte natif dans `container` (un <canvas> par
   * page + calque de surlignage). `blobUrl` : URL du fichier original déjà
   * en mémoire côté client (State.sourceBlobUrl) — rien n'est renvoyé au
   * serveur pour ce chemin.
   */
  async function loadNative(blobUrl, container) {
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

    for (let n = 1; n <= doc.numPages; n++) {
      const page     = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1.5 });

      const pageEl = document.createElement('div');
      pageEl.className = 'pdfov-page';

      const canvas = document.createElement('canvas');
      canvas.width  = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      pageEl.appendChild(canvas);
      container.appendChild(pageEl);

      const words = await nativePageWords(page, viewport);
      _pages.push({ el: pageEl, words });
    }
    return true;
  }

  /**
   * Affiche des pages déjà OCRisées : `pageImages` (data URL base64, une par
   * page) + `pageBoxes` (positions par mot en pixels natifs de l'image,
   * renvoyées par server.js — cf. extractPdfOcr).
   */
  function loadOcr(pageImages, pageBoxes, container) {
    clear();
    _container = container;
    if (!pageImages || !pageImages.length) return false;

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
        if (_lastEntities) highlight(_lastEntities); // rattrape le surlignage demandé avant chargement
      }, { once: true });

      _pages.push({ el: pageEl, words: [] }); // rempli au onload (dimensions naturelles requises)
    });
    return true;
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
      for (const entity of active) {
        for (const rect of matchesForPage(page.words, entity)) {
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

  return { loadNative, loadOcr, highlight, clear, isReady };
}
