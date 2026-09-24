/**
 * app.js — Contrôleur principal de l'application
 * Gère la navigation entre étapes et l'état global.
 */

// ── État global ───────────────────────────────────────────────────────────────
const State = {
  rawText:          '',
  processedText:    '',
  entities:         [],
  result:           null,
  currentStep:      1,
  stepsUnlocked:    [1],
  customTypes:      [],
  sourceBlobUrl:    null,
  sourceIsText:     true,
  // Après : sourceBlobUrl: null,
  sourceFileName: '',  
  refDocUrl:        null,
  caviardages:      [], // { word, replacement, scope, position } — appliqués uniquement à la sortie
  scanIgnored:      [], // valeurs ignorées dans le scan (persistantes)
  viewerTab:        'original',
  // Parties procédurales
  parties:          { demandeurs: [], defendeurs: [] },
  partiesKeywords:  {
    demandeurs: ['demandeur','demandeurs','requérant','requérants','appelant','appelants','plaignant','plaignants'],
    defendeurs: ['défendeur','défendeurs','défenderesse','défenderesses','intimé','intimés','mis en cause'],
  },
};

// Types système (toujours présents)
const SYSTEM_TYPES = [
  { id: 'NOM',     label: 'Nom & Prénom' },
  { id: 'ENTITE',  label: 'Entreprise / Org.' },
  { id: 'ADRESSE', label: 'Adresse' },
  { id: 'REF',     label: 'Référence' },
  { id: 'SIREN',   label: 'SIREN' },
  { id: 'IBAN',    label: 'IBAN' },
  { id: 'EMAIL',   label: 'Email' },
  { id: 'PHONE',   label: 'Téléphone' },
  { id: 'AUTRE',   label: 'Autre' },
];

function getAllTypes() {
  return [...SYSTEM_TYPES, ...State.customTypes];
}

function getTypeLabel(typeId) {
  const t = getAllTypes().find(t => t.id === typeId);
  return t ? t.label : typeId;
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  await Storage.init();
  renderOcrRules();
  await initServer();
});

async function initServer() {
  const status = await Server.getStatus();
  updateServerStatus(status);

  if (!status) {
    // Serveur non disponible au démarrage → retry toutes les 3s
    _startServerRetry();
  } else {
    _finishServerInit(status);
  }
}

/** Réessaie de joindre le serveur toutes les 3s jusqu'au succès */
let _serverRetryTimer = null;
function _startServerRetry() {
  if (_serverRetryTimer) return;

  async function _retry() {
    const status = await Server.getStatus();
    if (status) {
      _serverRetryTimer = null;
      updateServerStatus(status);
      _finishServerInit(status);
    } else {
      // Attendre la fin de l'appel PUIS programmer le prochain — pas d'accumulation
      _serverRetryTimer = setTimeout(_retry, 3000);
    }
  }

  _serverRetryTimer = setTimeout(_retry, 3000);
}
/** Termine l'initialisation une fois le serveur disponible */
async function _finishServerInit(status) {
  // Le sharedLayout est masqué par défaut, affiché dès step 2
  const shared = document.getElementById('sharedLayout');
  if (shared) shared.style.display = 'none';

  // Pré-charger le dictionnaire DICT_FR dans la blacklist Analysis
  if (window.DICT_FR && window.DICT_FR.size > 0) {
    Analysis.addToBlacklist([...window.DICT_FR]);
    console.log(`DICT_FR : ${window.DICT_FR.size} mots pré-chargés dans la blacklist`);
  }

  // Charger la blacklist externe
  const words = await Server.loadBlacklist();
  if (words.length > 0) {
    Analysis.addToBlacklist(words);
    console.log(`Blacklist externe : ${words.length} mots chargés`);
  }

  // Charger les types personnalisés
  const serverTypes = await Server.loadCustomTypes();
  if (serverTypes.length > 0) {
    State.customTypes = serverTypes;
  } else {
    const saved = localStorage.getItem('customTypes');
    if (saved) {
      try { State.customTypes = JSON.parse(saved); } catch {}
      if (State.customTypes.length > 0) Server.saveCustomTypes(State.customTypes).catch(() => {});
    }
  }
  updateTypeFilter();
}

function updateServerStatus(status) {
  const bar = document.getElementById('serverStatusBar');
  if (!bar) return;
  if (!status) {
    bar.className = 'header-server-status err';
    bar.textContent = '⏳ Connexion au serveur…';
    return;
  }
  const ocrText = status.tesseract ? ' · OCR actif' : ' · OCR inactif';
  bar.className = 'header-server-status ok';
  bar.innerHTML = `✓ Serveur v${status.version}${ocrText}`;
}

function showTesseractHelp() {
  document.getElementById('tesseractHelp').style.display = 'block';
  document.getElementById('tesseractHelp').scrollIntoView({ behavior: 'smooth' });
}

// ── Navigation ────────────────────────────────────────────────────────────────
function goToStep(n) {
  if (n > 1 && !State.stepsUnlocked.includes(n)) return;

  State.currentStep = n;

  // Stepper visuel
  document.querySelectorAll('.step-btn').forEach((b, i) => {
    b.classList.remove('active', 'done');
    if (i + 1 === n) b.classList.add('active');
    else if (i + 1 < n) b.classList.add('done');
  });

  // Panels step (step4 reste un vrai panel)
  document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(`step${n}`);
  if (panel) panel.classList.add('active');

  // Shared layout : visible en step 2 et 3 seulement
  const shared = document.getElementById('sharedLayout');
  if (shared) shared.style.display = (n === 2 || n === 3) ? 'block' : 'none';

  // Barre contrôle : visible en step 2 et 3
  const ctrlbar = document.getElementById('ocrControlbar');
  if (ctrlbar) ctrlbar.style.display = (n === 2 || n === 3) ? 'flex' : 'none';
  // Outils OCR (sauts, règles, recherche) : step 2 seulement
  ['saveStep2Btn','entitiesImportBtn','lbSuspectCount'].forEach(id => {
    // handled by existing buttons visibility
  });
  const ocrTools = document.querySelectorAll('.ocr-tools-only');
  ocrTools.forEach(el => el.style.display = (n === 2) ? '' : 'none');

  // Step 1 preview : visible en step 1 seulement (si fichier chargé)
  const step1Preview = document.getElementById('step1Preview');
  const step1Import  = document.getElementById('step1Import');
  if (n === 1) {
    const hasFile = !!(State.rawText || State.sourceBlobUrl);
    if (hasFile) {
      // Fichier chargé : montrer le preview ET le bouton changer
      if (step1Preview) step1Preview.style.display = 'block';
      if (step1Import)  step1Import.style.display  = 'none';
      // Toujours afficher le bouton "Changer de fichier"
      const btnChange = document.getElementById('btnStep1Change');
      if (btnChange) btnChange.style.display = 'inline-flex';
    } else {
      // Pas de fichier : zone d'import normale
      if (step1Preview) step1Preview.style.display = 'none';
      if (step1Import)  step1Import.style.display  = 'block';
    }
    // Toujours afficher le bouton "Continuer" si étape déverrouillée
    const btnNext = document.getElementById('btnStep1Next');
    if (btnNext) btnNext.disabled = !hasFile;
  } else {
    if (step1Preview) step1Preview.style.display = 'none';
  }

  // Barre navigation sauts : masquer si pas step 2
  if (n !== 2) {
    const lbnav = document.getElementById('lbNav');
    if (lbnav) lbnav.style.display = 'none';
  }

  // step4 : forcer la visibilité explicitement
  const step4 = document.getElementById('step4');
  if (step4) step4.style.display = (n === 4) ? 'block' : '';

  // Switcher le panneau gauche
  switchLeftPanel(n);

  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (n === 2) {
    renderOcrRules();
    refreshViewer();
    ensureOriginalDisplayed();
    // Re-synchroniser le header gauche avec la colonne après affichage
    requestAnimationFrame(() => {
      const splitLeft  = document.getElementById('ocrSplitLeft');
      const headerLeft = document.getElementById('splitHeaderLeft');
      if (splitLeft && headerLeft) {
        const w = splitLeft.getBoundingClientRect().width;
        if (w > 0 && !headerLeft.style.width) {
          headerLeft.style.width     = w + 'px';
          headerLeft.style.flexShrink = '0';
        }
      }
    });
  }
  if (n === 3) {
    refreshEntityViewer();
    // Toujours reconstruire le tableau entités (notamment après restauration session)
    if (typeof renderEntityTable === 'function') renderEntityTable(State.entities);
  }
  if (n === 4) renderResults();
}

// Vue courante du panneau gauche en step 3 : 'pdf' | 'entities'
let _leftPanelView = 'pdf';

/**
 * Bascule la colonne gauche entre PDF (step 2) et vue step 3.
 * Le textViewer à droite ne bouge JAMAIS.
 */
function switchLeftPanel(step) {
  // Marquer le body pour masquer les outils OCR en step 3
  document.body.classList.toggle('step3-active', step === 3);

  const headerPdf   = document.getElementById('headerPdfPanel');
  const headerEnt   = document.getElementById('headerEntitiesPanel');
  const viewerHint  = document.getElementById('viewerHint');
  const step3Header = document.getElementById('step3RightHeader');
  const step2Actions = document.getElementById('step2Actions');
  const step3Actions = document.getElementById('step3Actions');
  const spacer      = document.getElementById('pdfToolbarSpacer');

  const isStep2 = step === 2;
  const isStep3 = step === 3;

  if (headerPdf)    headerPdf.style.display    = isStep2 ? 'flex' : 'none';
  if (headerEnt)    headerEnt.style.display    = isStep3 ? 'flex' : 'none';
  if (viewerHint)   viewerHint.style.display   = isStep2 ? 'flex' : 'none';
  if (step3Header)  step3Header.style.display  = isStep3 ? 'flex' : 'none';
  if (step2Actions) step2Actions.style.display = 'none';
  if (step3Actions) step3Actions.style.display = 'none';

  // Toggle anonymisé — visible seulement en step 3
  const anonToggle = document.getElementById('anonPreviewToggle');
  if (anonToggle) {
    anonToggle.style.display = isStep3 ? 'flex' : 'none';
    // Réinitialiser le switch à "Normal" quand on arrive en step 3
    if (isStep3) {
      const sw = document.getElementById('anonPreviewSwitch');
      if (sw) sw.checked = false;
    }
  }
  // Boutons nav dans la controlbar
  const nav2 = document.getElementById('ctrlNavStep2');
  const nav3 = document.getElementById('ctrlNavStep3');
  if (nav2) nav2.style.display = isStep2 ? 'flex' : 'none';
  if (nav3) nav3.style.display = isStep3 ? 'flex' : 'none';

  if (isStep2) {
    // Step 2 : toujours PDF à gauche
    _showPdfPanel();
    if (spacer) spacer.style.display = 'block';
  } else if (isStep3) {
    // Step 3 : restaurer la vue précédente (PDF ou entités)
    setLeftPanelView(_leftPanelView, false);
    if (spacer) spacer.style.display = _leftPanelView === 'pdf' ? 'block' : 'none';
    // Mettre à jour le label selon le type de source
    setTimeout(_updateLeftPanelLabel, 0);
  }
}

/** Affiche le panneau PDF dans la colonne gauche */
function _showPdfPanel() {
  const pdfPanel = document.getElementById('leftPdfPanel');
  const entPanel = document.getElementById('leftEntitiesPanel');
  if (pdfPanel) pdfPanel.style.display = 'flex';
  if (entPanel) entPanel.style.display = 'none';
}

/** Affiche le panneau entités dans la colonne gauche */
function _showEntitiesPanel() {
  const pdfPanel = document.getElementById('leftPdfPanel');
  const entPanel = document.getElementById('leftEntitiesPanel');
  if (pdfPanel) pdfPanel.style.display = 'none';
  if (entPanel) entPanel.style.display = 'flex';
}

/**
 * Toggle PDF ↔ Entités dans la colonne gauche (step 3 uniquement).
 * @param {string} view  'pdf' | 'entities'
 * @param {boolean} saveState  mémoriser la vue (défaut: true)
 */
function setLeftPanelView(view, saveState = true) {
  if (saveState) _leftPanelView = view;
  if (typeof OublisPanel !== 'undefined' && OublisPanel._isActive && OublisPanel._isActive()) { OublisPanel._closeOnly(); }

  const btnPdf = document.getElementById('lptBtnPdf');
  const btnEnt = document.getElementById('lptBtnEnt');
  const spacer  = document.getElementById('pdfToolbarSpacer');

  if (view === 'pdf') {
    _showPdfPanel();
    if (btnPdf) btnPdf.classList.add('active');
    if (btnEnt) btnEnt.classList.remove('active');
    if (spacer) spacer.style.display = 'block';
  } else {
    _showEntitiesPanel();
    if (btnPdf) btnPdf.classList.remove('active');
    if (btnEnt) btnEnt.classList.add('active');
    if (spacer) spacer.style.display = 'none';
  }
}


/**
 * Met à jour le label du bouton gauche et la disponibilité du panneau PDF
 * selon que la source est un PDF natif, un TXT avec PDF de référence,
 * ou un TXT sans référence.
 */
/**
 * Remplit textViewerOriginal avec le texte numéroté ligne par ligne,
 * et synchronise le gutter gauche (origViewerGutter).
 * Remplace tous les appels directs à textOrig.textContent = ...
 */
function _fillOriginalViewer(text) {
  //console.log('[DEBUG] fillViewer lignes:', (text||'').split('\n').length);
  const wrap   = document.getElementById('origViewerWrap');
  const gutter = document.getElementById('origViewerGutter');
  const viewer = document.getElementById('textViewerOriginal');
  if (!viewer) return;

  const lines = (text || '').split('\n');

  // Construire le HTML numéroté (lignes vides → \u00a0 pour conserver la hauteur)
  viewer.innerHTML = lines
    .map((l, i) => `<span class="viewer-line" data-line="${i + 1}">${
      l === '' ? '\u00a0' : escHtml(l)
    }</span>`)
    .join('');

  // Construire le gutter
  if (gutter) {
    gutter.innerHTML = lines
      .map((_, i) => `<span class="viewer-gutter-line">${i + 1}</span>`)
      .join('');
  }

  // Synchroniser le scroll gutter ↔ viewer
  viewer.onscroll = () => { if (gutter) gutter.scrollTop = viewer.scrollTop; };

  // Afficher le wrap (masqué par défaut)
  if (wrap) wrap.style.display = 'flex';
}

/**
 * Masque le viewer original (et son gutter).
 */
function _hideOriginalViewer() {
  const wrap = document.getElementById('origViewerWrap');
  if (wrap) wrap.style.display = 'none';
}

function _updateLeftPanelLabel() {
  const btnPdf  = document.getElementById('lptBtnPdf');
  const btnLoad = document.getElementById('btnLoadRefPdf');
  const hasPdf  = !State.sourceIsText && State.sourceBlobUrl;
  const hasRef  = !!State.refDocUrl;

  if (btnPdf) {
    if (hasPdf) {
      // Source PDF native
      btnPdf.textContent = '📄 PDF';
      btnPdf.title       = 'Voir le document PDF original';
      btnPdf.style.opacity = '1';
      btnPdf.disabled    = false;
    } else if (hasRef) {
      // TXT avec PDF de référence chargé
      btnPdf.textContent = '📄 PDF ref.';
      btnPdf.title       = 'Voir le PDF de référence chargé';
      btnPdf.style.opacity = '1';
      btnPdf.disabled    = false;
    } else {
      // TXT sans PDF — afficher le texte source à la place
      btnPdf.textContent = '📄 Texte source';
      btnPdf.title       = 'Voir le texte source (pas de PDF disponible)';
      btnPdf.style.opacity = '0.7';
      btnPdf.disabled    = false;
    }
  }

  // Bouton "Charger PDF de référence" : visible uniquement pour les sources TXT
  if (btnLoad) {
    btnLoad.style.display = State.sourceIsText ? 'inline-flex' : 'none';
    const srcExt = (State.sourceFileName || '').split('.').pop().toLowerCase();
    const refType = ['pdf','docx','doc','txt','odt'].includes(srcExt)
      ? srcExt.toUpperCase()
      : 'document';
    btnLoad.textContent = hasRef
      ? `🔄 Changer ${refType} réf.`
      : `📎 Charger ${refType} réf.`;
  }

  // Mettre à jour la visibilité du bouton source (visible si contenu disponible)
  const btnOpenSrcLabel = document.getElementById('btnOpenSource');
  if (btnOpenSrcLabel) {
    const hasContent = !!(State.rawText || State.sourceBlobUrl || State.refDocUrl);
    btnOpenSrcLabel.style.display = hasContent ? 'inline-flex' : 'none';
  }
}

/** Déclenche le chargement d'un PDF de référence (uniquement pour visualisation) */
function _showRefInPanel(url, isHtml) {
  const iframe   = document.getElementById('pdfPreview');
  const docxDiv  = document.getElementById('splitDocxPreview');
  const origWrap = document.getElementById('origViewerWrap');

  // Tout masquer d'abord
  if (iframe)   { iframe.style.display  = 'none'; iframe.src = ''; }
  if (docxDiv)  { docxDiv.style.display = 'none'; docxDiv.innerHTML = ''; }
  if (origWrap) { origWrap.style.display = 'none'; }

  if (isHtml) {
    // DOCX converti → div HTML
    if (docxDiv) {
      docxDiv.innerHTML = url;
      docxDiv.style.cssText = 'display:block;overflow-y:auto;padding:1rem;font-family:serif;';
    }
  } else {
    // PDF → iframe
    if (iframe) { iframe.src = url; iframe.style.display = 'block'; }
  }
}

function triggerLoadRefPdf() {
  const srcExt = (State.sourceFileName || '').split('.').pop().toLowerCase();
 //  const acceptTypes = srcExt === 'docx' ? '.pdf,.docx,.doc' : '.pdf';
const acceptTypes = '.pdf,.docx,.doc';
  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = acceptTypes;
  input.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();

    // Libérer l'ancienne ref
    if (State.refDocUrl) { URL.revokeObjectURL(State.refDocUrl); State.refDocUrl = null; }

    let isHtml = false;
    let htmlContent = '';

    if (ext === 'pdf') {
      State.refDocUrl = URL.createObjectURL(file);
    } else if (['docx','doc'].includes(ext) && typeof mammoth !== 'undefined') {
      // Conversion DOCX → HTML via Mammoth
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer });
      htmlContent = result.value;
      // Blob URL pour "nouvelle fenêtre"
      const fullHtml = `<html><body style="font-family:serif;padding:2rem;font-size:13px">${htmlContent}</body></html>`;
      State.refDocUrl = URL.createObjectURL(new Blob([fullHtml], { type: 'text/html' }));
      isHtml = true;
    } else {
      showToast('⚠ Format non supporté pour la référence');
      return;
    }

    // Proposer le choix d'affichage
    const openInNew = await showConfirm({
      title: 'Afficher le document de référence',
      body: `<strong>${file.name}</strong><br>
             <span style="color:var(--ink3);font-size:12px">
               Comment voulez-vous l'afficher ?
             </span>`,
      ok: '↗ Nouvelle fenêtre',
      cancel: '⇄ Remplacer le viewer',
      icon: '📄'
    });

    if (openInNew) {
      // Ne pas toucher au panneau gauche
      window.open(State.refDocUrl, '_blank');
    } else {
      // Remplacer : afficher dans le panneau gauche
      setLeftPanelView('pdf');
      _showRefInPanel(isHtml ? htmlContent : State.refDocUrl, isHtml);
      _updateLeftPanelLabel();
      syncPdfToolbarSpacer();
      _hideOriginalViewer();
      const noDoc = document.getElementById('splitNoDoc');
      if (noDoc) noDoc.style.display = 'none';
      const placeholder = document.getElementById('splitPlaceholder');
      if (placeholder) placeholder.style.display = 'none';
      const btnOpenSrc = document.getElementById('btnOpenSource');
      if (btnOpenSrc) btnOpenSrc.style.display = 'inline-flex';
    }

    showToast(`✓ Document de référence chargé : ${file.name}`);
  };
  input.click();
}


/**
 * Déplace physiquement le #textViewer dans le bon conteneur selon l'étape.
 * Step 2 → pane-corrected | Step 3 → entityViewerSlot
 */
function moveTextViewer(step) {
  const viewer = document.getElementById('textViewer');
  if (!viewer) return;

  if (step === 2) {
    // En step 2 : remettre dans ocr-split-right, avant le footer
    const slot2  = document.getElementById('ocrSplitRight');
    const footer = slot2?.querySelector('.viewer-footer');
    if (slot2 && viewer.parentElement !== slot2) {
      if (footer) slot2.insertBefore(viewer, footer);
      else slot2.appendChild(viewer);
    }
  } else if (step === 3) {
    // En step 3 : déplacer dans le slot dédié
    const slot3 = document.getElementById('entityViewerSlot');
    if (slot3 && viewer.parentElement !== slot3) {
      slot3.appendChild(viewer);
    }
  }
}

function unlockStep(n) {
  if (!State.stepsUnlocked.includes(n)) State.stepsUnlocked.push(n);
  document.getElementById(`stepBtn${n}`).disabled = false;
}

// ── Settings ──────────────────────────────────────────────────────────────────
function toggleSettings() {
  const panel = document.getElementById('settingsPanel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

// ── STEP 1
// ── STEP 1 : Import ───────────────────────────────────────────────────────────
function handleDragOver(e) {
  e.preventDefault();
  document.getElementById('dropZone').classList.add('drag-over');
}
function handleDragLeave(e) {
  document.getElementById('dropZone').classList.remove('drag-over');
}
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('dropZone').classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
}
function handleFileSelect(e) {
  const f = e.target.files[0];
  // Vider l'input immédiatement → permet de re-sélectionner le même fichier
  e.target.value = '';
  if (f) loadFile(f);
}

async function loadFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['txt','pdf','docx'].includes(ext)) {
    alert(`Format non supporté : .${ext}\nFormats acceptés : .txt · .pdf · .docx`);
    return;
  }

  // Modale de chargement
  // Modale de chargement — bouton Annuler activé pour PDF (peut prendre du temps)
  showLoadingModal('Analyse du document…', 'Préparation en cours…', 10, ext === 'pdf');
  document.getElementById('btnStep1Next').disabled = true;

  // Libérer l'ancien blob URL si existant
  if (State.sourceBlobUrl) { URL.revokeObjectURL(State.sourceBlobUrl); State.sourceBlobUrl = null; }
  State.pageBoxes  = null;
  State.pageImages = null;
  if (typeof PdfOverlay !== 'undefined') PdfOverlay.clear();

  let text = '', method = 'txt';

  if (ext === 'txt') {
    text = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => {
        const buf = e.target.result;
        let decoded = new TextDecoder('utf-8').decode(buf);
        if (decoded.includes('�')) {
          decoded = new TextDecoder('windows-1252').decode(buf);
          if (/[ŽŠˆ˜•–—]/.test(decoded)) {
            decoded = new TextDecoder('macintosh').decode(buf);
          }
        }
        decoded = decoded.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        //console.log('[CRLF] après normalize:', JSON.stringify(decoded.slice(0, 100)));
        res(decoded);
      };
      r.onerror = rej;
      r.readAsArrayBuffer(file);
    });
    State.sourceIsText  = true;
    State.sourceBlobUrl = null;
  } else {
    // Stocker le fichier DOCX pour rendu Mammoth (step 1)
    if (ext === 'docx' && typeof mammoth !== 'undefined') {
      State._docxFile = file;
    }
    try {
      const result = await Server.extractFile(file, (pct, msg) => {
        updateLoadingModal(
          ext === 'pdf' ? 'Extraction du PDF…' : 'Extraction du document…',
          msg,
          pct
        );
      });
      text   = result.text   || '';
      method = result.method || ext;
      // Positions par mot pour le surlignage direct sur le document (step 3) —
      // uniquement présentes pour un PDF passé par l'OCR (cf. server.js).
      State.pageBoxes  = result.pageBoxes  || null;
      State.pageImages = result.pageImages || null;
      // Stocker le blob URL pour preview PDF
      if (ext === 'pdf') {
        State.sourceBlobUrl = URL.createObjectURL(file);
        State.sourceIsText  = false;
      } else {
        State.sourceBlobUrl = null;
        State.sourceIsText  = true;
      }
      if (method === 'ocr_unavailable') {
        hideLoadingModal();
        document.getElementById('tesseractHelp').style.display = 'block';
        document.getElementById('btnStep1Next').disabled = false;
        return;
      }
    } catch (e) {
      hideLoadingModal();
      if (e.message === '__CANCELLED__') return; // annulation volontaire — pas d'alerte
      alert(`Erreur extraction : ${e.message}`);
      document.getElementById('btnStep1Next').disabled = false;
      return;
    }
  }

  // ── Nettoyage OCR Abby (TXT uniquement) ──────────────────────────────────
  // cleanOCRByLine est défini dans ocrCleaner.js (chargé avant app.js dans index.html)
  let cleanedText = text;
  if (ext === 'txt' && typeof cleanOCRByLine === 'function') {
    const ocrResult  = cleanOCRByLine(text);
    cleanedText      = ocrResult.lines.map(l => l.text).join('\n');
    State.ocrLinesMeta = ocrResult.lines;   // chaque ligne avec {lineEmoji, isGibberish, lineFlags…}
    console.log(`[OCR Abby] nettoyage : 🟢${ocrResult.stats.clean} 🟡${ocrResult.stats.moyen} 🔴${ocrResult.stats.gibberish}`);
  }

  State.rawText       = cleanedText;  // texte nettoyé → texte de travail
  State.sourceFileName = file.name;
  //console.log('[DEBUG] rawText lignes:', State.rawText.split('\n').length, '| premiers chars:', JSON.stringify(State.rawText.slice(0, 100)));
  State.originalText  = text;         // texte source original (jamais modifié)
  State.processedText = '';
  State.entities      = [];
  State.result        = null;
  State.parties       = { demandeurs: [], defendeurs: [] };
  State.stepsUnlocked = [1, 2];

  const methodLabel = { txt:'TXT', native:'PDF natif', ocr:'PDF·OCR', docx:'DOCX' };

  // Finalisation modale puis fermeture
  updateLoadingModal('Document prêt !', `${(file.size/1024).toFixed(1)} Ko · ${methodLabel[method]||method}`, 100);
  setTimeout(() => {
    hideLoadingModal();
    // Mettre à jour le pill après fermeture de la modale
    const pill = document.getElementById('dropPill');
    if (pill) {
      pill.innerHTML = `📎 ${escHtml(file.name)} · ${(file.size/1024).toFixed(1)} Ko · <em>${methodLabel[method]||method}</em>`;
      pill.style.display = 'inline-flex';
    }
  }, 500);

  const chars     = text.length;
  const words     = text.trim().split(/\s+/).filter(Boolean).length;
  const lineCount = text.split('\n').length;

  // Stats (certains éléments peuvent ne pas exister selon la vue)
  const elChars  = document.getElementById('statChars');
  const elWords  = document.getElementById('statWords');
  const elLines  = document.getElementById('statLines');
  const elStats  = document.getElementById('importStats');
  if (elChars) elChars.textContent = chars.toLocaleString('fr-FR');
  if (elWords) elWords.textContent = words.toLocaleString('fr-FR');
  if (elLines) elLines.textContent = lineCount.toLocaleString('fr-FR');
  if (elStats) elStats.style.display = 'inline-flex';

  // Preview step 1 (nouveau layout split)
  const elStep1Text = document.getElementById('step1TextPreview');
  if (elStep1Text) elStep1Text.textContent = text;

  // Ancien preview (compatibilité)
  const elPreview     = document.getElementById('textPreview');
  const elPreviewWrap = document.getElementById('textPreviewWrap');
  if (elPreview) {
    const previewLines = text.split('\n').slice(0, 8).join('\n');
    elPreview.textContent = previewLines + (lineCount > 8 ? '\n…' : '');
  }
  if (elPreviewWrap) elPreviewWrap.style.display = 'block';

  document.getElementById('btnStep1Next').disabled = false;
  unlockStep(2);
  unlockStep(3);

  // Initialiser les previews
  initOriginalPreview();

  // Le sharedLayout reste masqué en step 1 — il s'affichera à goToStep(2)
  // On ne l'affiche PAS ici pour éviter la redondance avec step1Preview

  // Pré-détection silencieuse (sur texte nettoyé)
  Analysis.analyze(cleanedText, null, () => {}).then(entities => {
    const seen = new Set(State.entities.map(e => e.value.toLowerCase()));
    const fresh = entities.filter(e => !seen.has(e.value.toLowerCase()));
    State.entities = [...State.entities, ...fresh];
    if (typeof renderEntityTable === 'function') renderEntityTable(State.entities);
  });
}

// ── STEP 2 : OCR Viewer & Rules ───────────────────────────────────────────────

// État du visualiseur
const ViewerState = {
  mode:               'original',
  searchQuery:        '',
  searchMatches:      [],
  searchCurrent:      -1,
  renderedText:       '',
  spHighlight:        '',
  oublisHighlight:    '',
  lbTargetLine:       -1,
  searchUncoveredOnly: false,  // true = naviguer uniquement dans les non-couverts
};

function addOcrRule1() {
  const fromEl = document.getElementById('ocrFrom');
  const toEl   = document.getElementById('ocrTo');
  const from = fromEl.value.trim();
  const to   = toEl.value.trim();
  const cs   = document.getElementById('ocrCaseSensitive').checked;

  fromEl.classList.toggle('error', !from);
  toEl.classList.toggle('error', !to);
  if (!from || !to) return;

  Storage.addOcrRule(from, to, cs);
  renderOcrRules();
  refreshViewer();

  fromEl.value = ''; toEl.value = '';
  fromEl.classList.remove('error'); toEl.classList.remove('error');
  fromEl.focus();
}

function addOcrRule() {
  const fromEl = document.getElementById('ocrFrom');
  const toEl   = document.getElementById('ocrTo');
  const from = fromEl.value.trim();
  const to   = toEl.value.trim();
  const cs   = document.getElementById('ocrCaseSensitive').checked;

  if (!from || !to) return;

  // 1. On ajoute la règle OCR normale
  Storage.addOcrRule(from, to, cs);
  
  // 2. NOUVEAU : On propose d'ajouter la forme corrigée aux entités
  if (confirm(`Voulez-vous aussi ajouter "${to}" à la liste des noms à anonymiser ?`)) {
    State.entities.unshift({
      id: `ocr_link_${Date.now()}`,
      value: to, // On utilise la forme corrigée
      type: 'NOM',
      label: 'NOM',
      occurrences: 1,
      aliases: [from], // On ajoute la forme erronée comme alias !
      active: true,
      blocked: false,
      manual: true
    });
    unlockStep(3);
  }

  renderOcrRules();
  refreshViewer();

  fromEl.value = ''; toEl.value = '';
  fromEl.focus();
}



function removeOcrRule(id) {
  Storage.removeOcrRule(id);
  renderOcrRules();
  refreshViewer();
}

function clearAllOcrRules() {
  if (!confirm('Effacer toutes les règles OCR ?')) return;
  Storage.clearOcrRules();
  renderOcrRules();
  refreshViewer();
}

function renderOcrRules() {
  const rules = Storage.getOcrRules();
  const list  = document.getElementById('ocrRuleList');
  const count = document.getElementById('ocrRuleCount');
  const btnClear = document.getElementById('btnClearOcr');

  count.textContent = rules.length;
  btnClear.style.display = rules.length > 0 ? 'inline' : 'none';

  if (rules.length === 0) {
    list.innerHTML = '<div class="rule-empty">Aucune règle active.</div>';
    return;
  }

  list.innerHTML = rules.map(r => `
    <div class="rule-item" data-id="${escAttr(r.id)}">
      <span class="rule-from">${escHtml(r.from)}</span>
      <span class="rule-arrow">→</span>
      <span class="rule-to">${escHtml(r.to)}</span>
      ${r.caseSensitive ? '<span class="rule-cs-badge">casse</span>' : ''}
      <button class="rule-del" onclick="removeOcrRule('${escAttr(r.id)}')" title="Supprimer">✕</button>
    </div>`).join('');
}

// ── Visualiseur plein texte ────────────────────────────────────────────────────

function toggleViewerMode() {
  ViewerState.mode = document.getElementById('toggleViewMode').checked ? 'corrected' : 'original';
  document.getElementById('viewerModeLabel').textContent =
    ViewerState.mode === 'corrected' ? 'Texte après corrections' : 'Texte original';
  refreshViewer();
}

function refreshViewer() {
  if (!State.rawText) return;


  const rules = Storage.getOcrRules();
  let text = (State.rawText || '').normalize('NFC');

  if (ViewerState.mode === 'corrected' && rules.length > 0) {
    const result = OCR.applyRules(State.rawText, rules);
    text = result.text;
    State.processedText = result.text;

    // Compteur substitutions
    const countEl = document.getElementById('ocrSubstCount');
    if (result.changes > 0) {
      countEl.textContent = `✓ ${result.changes} substitution${result.changes > 1 ? 's' : ''} appliquée${result.changes > 1 ? 's' : ''}`;
      countEl.style.display = 'block';
    } else {
      countEl.style.display = 'none';
    }
  } else {
    State.processedText = State.rawText;
    const countEl = document.getElementById('ocrSubstCount');
    if (countEl) countEl.style.display = 'none';
  }

  // Rebuild viewer content
  // Si mode sauts actif : injecter un marqueur unique à la ligne cible
  if ((LB.active || ViewerState.oublisHighlight) && ViewerState.lbTargetLine >= 0) {
    const lines = text.split('\n');
    const idx   = ViewerState.lbTargetLine;
    if (idx < lines.length) {
      // Insérer le marqueur au début de la ligne cible (char unicode rare)
      lines[idx] = '\uFFF9' + lines[idx];
      text = lines.join('\n');
    }
  }
  buildViewerHTML(text, rules);
}

function buildViewerHTML(text, rules) {
  const viewer = document.getElementById('textViewer');

  // Normalisation NFC : garantit que les accents composés (é, à, etc.)
  // ont la même forme dans le texte ET dans les termes de recherche.
  // Sans ça, un é tapé au clavier (NFC) ne matche pas un é issu de PDF (NFD).
  text = text.normalize('NFC');
  const query = ViewerState.searchQuery.normalize('NFC');

  // On travaille sur le texte brut et on construit le HTML en une passe
  // pour éviter les conflits entre surlignages

  // 1. Découpe le texte en segments : normal | match-règle | match-recherche
  let segments = [{ text, type: 'normal' }];

  // Applique le surlignage des règles (mode original uniquement)
  if (ViewerState.mode === 'original' && rules.length > 0) {
    for (const rule of rules) {
      segments = highlightSegments(segments, rule.from, 'hl-rule', rule.caseSensitive, rule);
    }
  }

  // Surlignage des entités d'abord — AVANT la recherche
  // Ainsi la recherche voit les segments hl-entity-found et peut les marquer
  // sans imbrication : hl-search-in-rule combine les deux classes sur un seul span.
  if (State.entities && State.entities.length > 0 && !SP.active && !LB.active) {
    const isPlaceholder = v => /^\[.+\]$/.test((v || '').trim());
    for (const ent of State.entities) {
      if (ent.active && !ent.blocked && !isPlaceholder(ent.value)) {
        // Entités initiale (PRENOM/isInitiale) → classe distincte bleue
        const hlClass = (ent.isInitiale || ent.type === 'PRENOM')
          ? 'hl-entity-initiale' : 'hl-entity-found';
        segments = highlightSegments(segments, ent.value, hlClass, false, null, true);
        for (const alias of (ent.aliases || [])) {
          if (alias && !isPlaceholder(alias))
            segments = highlightSegments(segments, alias, hlClass, false, null, true);
        }
      }
    }
  }

  // Surlignage rouge/barré pour les mots caviardés
  if (State.caviardages && State.caviardages.length > 0 && !SP.active && !LB.active) {
    for (const cav of State.caviardages) {
      if (cav.word) segments = highlightSegments(segments, cav.word, 'hl-caviarde', false, null, true);
    }
  }

  // Applique la recherche par-dessus (voit maintenant les segments hl-entity-found)
  if (query.trim().length >= 2) {
    segments = highlightSegments(segments, query, 'hl-search', false, null);
  }

  // Highlight mode correction espaces/sauts (jaune distinct)
  const spQ = (ViewerState.spHighlight || '').normalize('NFC');
  if (spQ.trim().length >= 1) {
    segments = highlightSegments(segments, spQ, 'hl-sp-found', false, null);
  }

  // Highlight Recherche/Remplacement (bleu distinct des entités et de la recherche viewer)
  if (RR.active && RR.query && RR.matches.length > 0) {
    if (RR.useRegex) {
      // En mode regex : surligner directement depuis les positions RR.matches
      segments = _highlightByPositions(segments, RR.matches, 'hl-rr', text.length);
    } else {
      segments = highlightSegments(segments, RR.query, 'hl-rr', !RR.ignoreCase, null);
    }
  }
  const oublisQ = (ViewerState.oublisHighlight || '').normalize('NFC');
  if (oublisQ.trim().length >= 1) {
    segments = highlightSegments(segments, oublisQ, 'hl-oubli', false, null, true);
  }
  
  // Convertit en HTML
  let html = '';
  let searchIdx = 0;
  let rrIdx = 0;
  ViewerState.searchMatches = [];

  for (const seg of segments) {
    if (seg.type === 'normal') {
      // Détection du marqueur lb-target (injecté par refreshViewer en mode sauts)
      if (seg.text.includes('\uFFF9')) {
        const parts = seg.text.split('\uFFF9');
        html += escHtml(parts[0]);
        // La partie après le marqueur = début de la ligne cible
        const lineContent = parts[1] || '';
        const eol = lineContent.indexOf('\n');
        const lineText = eol >= 0 ? lineContent.slice(0, eol) : lineContent;
        const rest      = eol >= 0 ? lineContent.slice(eol) : '';
        html += `<span id="lb-target" class="hl-sp-found">${escHtml(lineText)}</span>${escHtml(rest)}`;
        // S'il y a d'autres marqueurs (ne devrait pas arriver), traiter normalement
        for (let i = 2; i < parts.length; i++) html += escHtml(parts[i]);
      } else {
        html += escHtml(seg.text);
      }
    } else if (seg.type === 'hl-rule') {
      const title = `Cliquez pour créer une règle : "${escAttr(seg.ruleFrom)}" → ?`;
      html += `<span class="hl-rule" onclick="prefillFromRule('${escAttr(seg.text)}')" title="${title}">${escHtml(seg.text)}</span>`;
    } else if (seg.type === 'hl-search') {
      const matchId = `sm_${searchIdx}`;
      ViewerState.searchMatches.push(matchId);
      // data-covered="0" = non couvert par une entité
      html += `<span class="hl-search" id="${matchId}" data-match="${searchIdx}" data-covered="0">${escHtml(seg.text)}</span>`;
      searchIdx++;
    } else if (seg.type === 'hl-caviarde') {
      html += `<span class="hl-caviarde" title="Mot caviardé — remplacé dans la sortie anonymisée">${escHtml(seg.text)}</span>`;
    } else if (seg.type === 'hl-entity-initiale') {
      html += `<span class="hl-entity-initiale" title="Prénom : sera remplacé par son initiale">${escHtml(seg.text)}</span>`;
    } else if (seg.type === 'hl-entity-found') {
      html += `<span class="hl-entity-found" title="Entité détectée : sera anonymisée">${escHtml(seg.text)}</span>`;
    } else if (seg.type === 'hl-oubli') {
      html += `<span class="hl-oubli">${escHtml(seg.text)}</span>`;
    } else if (seg.type === 'hl-sp-found') {
      html += `<span class="hl-sp-found">${escHtml(seg.text)}</span>`;
    } else if (seg.type === 'hl-rr') {
      const isCurrent = (rrIdx === RR.current);
      html += `<span class="hl-rr${isCurrent ? ' hl-rr-current' : ''}" data-rr="${rrIdx}">${escHtml(seg.text)}</span>`;
      rrIdx++;
    } else if (seg.type === 'hl-search-in-rule') {
      // Mot trouvé par la recherche ET déjà marqué par une règle OCR ou entité
      const matchId = `sm_${searchIdx}`;
      const isCoveredByEntity = seg.origType === 'hl-entity-found';
      ViewerState.searchMatches.push(matchId);
      const spanCls = isCoveredByEntity ? 'hl-entity-found hl-search' : 'hl-rule hl-search';
      // data-covered="1" = couvert par une entité, "0" = couvert par règle OCR seulement
      html += `<span class="${spanCls}" id="${matchId}" data-match="${searchIdx}" data-covered="${isCoveredByEntity ? 1 : 0}">${escHtml(seg.text)}</span>`;
      searchIdx++;
    } else {
      // Fallback sécurité : tout type inconnu → texte brut visible
      html += escHtml(seg.text);
    }
  }

  // Construire le HTML ligne par ligne.
  // Chaque ligne = un span display:block avec numéro dans le gutter.
  // Les lignes vides reçoivent un \u00a0 (espace insécable) pour forcer
  // la hauteur à exactement 1 line-height — identique au mode édition
  // où le texte brut contient de vrais \n.
  const htmlLines = html.split('\n');
  const numberedHtml = htmlLines
    .map((line, i) => {
      const content = line === '' ? '\u00a0' : line;
      return `<span class="viewer-line" data-line="${i + 1}">${content}</span>`;
    })
    .join('');

  // Rendre le viewer toujours éditable
  viewer.contentEditable = 'true';
  viewer.spellcheck = false;
  viewer.innerHTML = numberedHtml;

  // Mettre à jour le gutter externe
  updateViewerGutter(htmlLines.length);

  // Mettre à jour le compteur de recherche
  updateSearchCount();

  // Stats
  document.getElementById('viewerStats').textContent =
    `${text.length.toLocaleString('fr-FR')} car. · ${text.split('\n').length} lignes`;
}


// ── Gutter externe — numéros de ligne permanents ──────────────────────────────

/**
 * Reconstruit les numéros de ligne dans le gutter externe.
 * Appelé à chaque refreshViewer() ET à chaque passage en mode édition.
 * @param {number} lineCount — nombre de lignes du texte courant
 */
function updateViewerGutter(lineCount) {
  const gutter = document.getElementById('viewerGutter');
  const viewer = document.getElementById('textViewer');
  if (!gutter || !viewer) return;

  // Construire les numéros en une seule chaîne
  let html = '';
  for (let i = 1; i <= lineCount; i++) {
    html += `<span class="viewer-gutter-line">${i}</span>`;
  }
  gutter.innerHTML = html;

  // Synchroniser le scroll du gutter sur celui du viewer
  _syncGutterScroll();
}

/** Synchronise le scrollTop du gutter avec le viewer (appelé aussi sur scroll) */
function _syncGutterScroll() {
  const gutter = document.getElementById('viewerGutter');
  const viewer = document.getElementById('textViewer');
  if (gutter && viewer) gutter.scrollTop = viewer.scrollTop;
}

// Accrocher la synchro scroll dès que le viewer est prêt
document.addEventListener('DOMContentLoaded', () => {
  const viewer = document.getElementById('textViewer');
  if (viewer) {
    viewer.addEventListener('scroll', _syncGutterScroll, { passive: true });
  }
});

/**
 * Retourne l'index 0-based de la première ligne visible dans le textViewer.
 * data-line est 1-based dans le DOM → on soustrait 1.
 */
function getViewerTopLine() {
  const viewer = document.getElementById('textViewer');
  if (!viewer) return 0;
  const scrollTop = viewer.scrollTop;
  if (scrollTop < 2) return 0;
  const spans = viewer.querySelectorAll('span[data-line]');
  let best = 0;
  for (const span of spans) {
    if (span.offsetTop <= scrollTop + 4) best = parseInt(span.dataset.line, 10) - 1;
    else break;
  }
  return best;
}

/**
 * Injecte des highlights de type `cls` aux positions absolues `positions` dans les segments.
 * Utilisé pour le mode regex de RR où on a déjà calculé les positions.
 * @param {Array} segments - segments texte courants
 * @param {Array} positions - [{start, end}] positions absolues dans le texte complet
 * @param {string} cls - classe CSS à appliquer
 * @param {number} totalLen - longueur totale du texte (pour validation)
 */
function _highlightByPositions(segments, positions, cls, totalLen) {
  if (!positions || positions.length === 0) return segments;
  // Convertir les positions absolues en opérations de découpe sur les segments
  let result = [];
  let offset = 0;
  let posIdx = 0;

  for (const seg of segments) {
    const segStart = offset;
    const segEnd   = offset + seg.text.length;
    let localOffset = 0;

    while (posIdx < positions.length) {
      const p = positions[posIdx];
      if (p.start >= segEnd) break; // ce match est après ce segment
      if (p.end   <= segStart) { posIdx++; continue; } // ce match est avant

      // Intersection : [max(p.start,segStart), min(p.end,segEnd)]
      const hlStart = Math.max(p.start, segStart) - segStart;
      const hlEnd   = Math.min(p.end,   segEnd)   - segStart;

      if (hlStart > localOffset) {
        result.push({ text: seg.text.slice(localOffset, hlStart), type: seg.type === 'normal' ? 'normal' : seg.type });
      }
      result.push({ text: seg.text.slice(hlStart, hlEnd), type: cls });
      localOffset = hlEnd;

      if (p.end <= segEnd) posIdx++;
      else break;
    }

    if (localOffset < seg.text.length) {
      result.push({ text: seg.text.slice(localOffset), type: seg.type });
    }
    offset = segEnd;
  }
  return result;
}

function highlightSegments(segments, term, cls, caseSensitive, rule, useFlex) {
  if (!term) return segments;
  // Normaliser NFC le terme pour matcher les deux formes d'accents
  const normTerm = term.normalize('NFC');
  const flags = caseSensitive ? 'g' : 'gi';
  let re;
  try {
    // useFlex=true : pattern flexible (entités) — tolère tiret/espace, virgule optionnelle
    // useFlex=false : pattern exact (règles OCR, recherche)
    const pattern = useFlex ? Anonymizer.flexPattern(normTerm) : OCR.escapeRegex(normTerm);
    re = new RegExp(pattern, flags);
  }
  catch { return segments; }

  const result = [];
  for (const seg of segments) {
    // Les segments déjà marqués (hl-rule, hl-entity-found) sont passés tels quels
    // SAUF si on est en train de chercher (cls === 'hl-search') :
    // dans ce cas on cherche aussi dedans pour ne pas manquer de résultats.
    if (seg.type !== 'normal' && cls !== 'hl-search' && cls !== 'hl-sp-found') {
      result.push(seg);
      continue;
    }
    // Pour hl-search sur un segment déjà marqué (hl-entity-found, hl-rule...) :
    // si la recherche est contenue (même partiellement) dans ce segment,
    // on marque le segment ENTIER comme résultat — pas de span imbriqué.
    // Cela préserve le fond vert des entités lors d'une recherche.
    if (seg.type !== 'normal' && cls === 'hl-search') {
      const normText = seg.text.normalize('NFC');
      re.lastIndex = 0;
      if (re.test(normText)) {
        re.lastIndex = 0;
        // Le segment (ou une partie) matche → marquer le span entier
        result.push({ text: seg.text, type: 'hl-search-in-rule',
                      origType: seg.type, ruleFrom: seg.ruleFrom });
      } else {
        re.lastIndex = 0;
        result.push(seg);
      }
      continue;
    }
    // Segment normal : split sur la regex
    const normText = seg.text.normalize('NFC');
    const parts   = normText.split(re);
    const matches = normText.match(re) || [];
    parts.forEach((part, i) => {
      if (part) result.push({ text: part, type: 'normal' });
      if (i < matches.length) {
        result.push({ text: matches[i], type: cls, ruleFrom: rule?.from });
      }
    });
  }
  return result;
}

// ── Recherche ─────────────────────────────────────────────────────────────────

function performSearch() {
  // Normaliser NFC dès la saisie pour cohérence avec le texte
  ViewerState.searchQuery = document.getElementById('viewerSearch').value.normalize('NFC');
  ViewerState.searchCurrent = -1;
  refreshViewer();
  if (ViewerState.searchMatches.length > 0) navigateSearch(1);
}

function navigateSearch(dir) {
  // Selon le mode, naviguer dans tous les matches ou seulement les non-couverts
  const activeMatches = _getActiveSearchMatches();
  const total = activeMatches.length;
  if (total === 0) return;

  // Trouver la position courante dans activeMatches
  const currentId = ViewerState.searchMatches[ViewerState.searchCurrent];
  let activeCurrent = activeMatches.indexOf(currentId);
  activeCurrent = ((activeCurrent + dir) % total + total) % total;

  // Retirer current de tous
  document.querySelectorAll('.hl-search').forEach(el => el.classList.remove('hl-current'));

  const targetId = activeMatches[activeCurrent];
  // Mettre à jour searchCurrent avec l'index global
  ViewerState.searchCurrent = ViewerState.searchMatches.indexOf(targetId);

  const el = document.getElementById(targetId);
  if (el) {
    el.classList.add('hl-current');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  updateSearchCount();
}

function _getActiveSearchMatches() {
  if (!ViewerState.searchUncoveredOnly) return ViewerState.searchMatches;
  // Filtrer : garder uniquement ceux avec data-covered="0"
  return ViewerState.searchMatches.filter(id => {
    const el = document.getElementById(id);
    return el && el.dataset.covered === '0';
  });
}

function toggleSearchUncovered() {
  ViewerState.searchUncoveredOnly = !ViewerState.searchUncoveredOnly;
  const btn = document.getElementById('btnSearchUncovered');
  if (btn) btn.classList.toggle('active', ViewerState.searchUncoveredOnly);
  // Relancer la navigation depuis le début
  ViewerState.searchCurrent = -1;
  const active = _getActiveSearchMatches();
  if (active.length > 0) navigateSearch(1);
  updateSearchCount();
}

function updateSearchCount() {
  const allMatches      = ViewerState.searchMatches;
  const activeMatches   = _getActiveSearchMatches();
  const total           = allMatches.length;
  const uncovered       = allMatches.filter(id => {
    const el = document.getElementById(id);
    return el && el.dataset.covered === '0';
  }).length;

  const currentId = ViewerState.searchMatches[ViewerState.searchCurrent];
  const activeCur = activeMatches.indexOf(currentId);
  const cur       = activeCur >= 0 ? activeCur + 1 : 0;
  const activeTotal = activeMatches.length;

  const el = document.getElementById('searchCount');
  if (!el) return;

  if (!ViewerState.searchQuery) {
    el.textContent = '';
    el.title = '';
    return;
  }

  if (ViewerState.searchUncoveredOnly) {
    el.textContent = activeTotal > 0 ? `${cur}/${activeTotal} non couverts` : '0 non couvert';
    el.title = `${total} occurrence(s) au total · ${uncovered} non couverte(s)`;
  } else {
    el.textContent = total > 0 ? `${cur}/${total}` : '0';
    el.title = uncovered > 0 && ViewerState.searchQuery
      ? `⚠ ${uncovered} non couvert(s) sur ${total}`
      : '';
    // Signaler visuellement s'il y a des non-couverts
    el.classList.toggle('has-uncovered', uncovered > 0 && total > 0);
  }
}

function clearSearch() {
  document.getElementById('viewerSearch').value = '';
  ViewerState.searchQuery        = '';
  ViewerState.searchCurrent      = -1;
  ViewerState.searchMatches      = [];
  ViewerState.searchUncoveredOnly = false;
  const btn = document.getElementById('btnSearchUncovered');
  if (btn) btn.classList.remove('active');
  const count = document.getElementById('searchCount');
  if (count) { count.textContent = ''; count.classList.remove('has-uncovered'); }
  refreshViewer();
}

// ── Sélection texte → pré-remplissage ─────────────────────────────────────────
// Variable globale temporaire pour stocker la sélection
let currentSelection = "";
let _selHandlerTimer = null;

function handleTextSelection() {
  // Ne pas déclencher si le ctx-menu est ouvert
  const ctx = document.getElementById('ctxMenu');
  if (ctx && ctx.style.display !== 'none') return;
  const ctxSub = document.getElementById('ctxSubmenu');
  if (ctxSub && ctxSub.style.display !== 'none') return;

  // Capture IMMÉDIATE — avant tout refresh qui détruirait la sélection DOM
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const viewer = document.getElementById('textViewer');
  if (!viewer) return;
  if (!viewer.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
  const captured = sel.toString().trim();
  if (!captured || captured.length < 2 || captured.length > 100) return;
  if (captured === currentSelection) return;

  // Debounce — annuler les appels précédents encore en attente
  if (_selHandlerTimer) clearTimeout(_selHandlerTimer);
  _selHandlerTimer = setTimeout(() => {
    _selHandlerTimer = null;
    currentSelection = captured;
    if (State.currentStep === 3) {
      showSelectionPopover(captured);
    } else {
      // Step 2 : hint dans le split-header
      const hint = document.getElementById('viewerHint');
      if (hint) {
        hint.innerHTML = `
          <span>Sélectionné : <strong>"${escHtml(captured)}"</strong></span>
          <button class="btn-sm btn-outline" onclick="sendToOcr()" style="padding:2px 8px;font-size:11px">→ Règle OCR</button>
          <button class="btn-sm btn-primary" onclick="sendToEntities()" style="padding:2px 8px;font-size:11px">🔒 Anonymiser</button>
          <button onclick="resetHint()" style="background:none;border:none;cursor:pointer;color:var(--ink3)">✕</button>`;
      }
    }
  }, 150); // 150ms au lieu de 10ms — laisse le DOM se stabiliser
}
// Fonction 1 : Envoi vers la correction OCR (Étape 2)
function sendToOcr() {
  const sel = currentSelection;
  hideSelectionPopover();
  // Si on est en step 3, basculer en step 2 d'abord
  if (State.currentStep === 3) {
    goToStep(2);
    setTimeout(() => {
      const fromEl = document.getElementById('ocrFrom');
      if (fromEl) { fromEl.value = sel; fromEl.focus(); }
      const drawer = document.getElementById('rulesDrawer');
      if (drawer && drawer.style.display === 'none') toggleRulesDrawer();
    }, 350);
    return;
  }
  const fromEl = document.getElementById('ocrFrom');
  if (!fromEl) return;
  fromEl.value = sel;
  fromEl.focus();
  fromEl.style.background = '#f0fdf4';
  setTimeout(() => fromEl.style.background = '', 500);
  resetHint();
}

// Fonction 2 : Envoi vers l'anonymisation (Étape 3)
function sendToEntities() {
  const sel = currentSelection;
  hideSelectionPopover();
  // On ajoute l'entité à la liste globale
  const newEntity = {
    id: `man_${Date.now()}`,
    value: sel,
    type: 'NOM',
    label: 'NOM',
    occurrences: 1,
    aliases: [],
    active: true,
    blocked: false,
    manual: true
  };

  State.entities.unshift(newEntity);

  // On débloque l'étape 3 si besoin
  unlockStep(3);

  // On rafraîchit le tableau (si on est déjà sur l'étape 3 ou pour plus tard)
  if (typeof renderEntityTable === 'function') {
    renderEntityTable(State.entities);
  }

  // Petit message de confirmation sur le bouton
  const hint = document.getElementById('viewerHint');
  hint.innerHTML = `✅ <strong>"${escHtml(sel)}"</strong> ajouté à la liste d'anonymisation !`;
  hint.style.background = '#dcfce7';
  hint.style.color = '#166534';
  
  setTimeout(resetHint, 2000);
}

function resetHint() {
  const hint = document.getElementById('viewerHint');
  hint.innerHTML = '💡 Sélectionnez un mot dans le texte pour le copier dans le champ "Forme OCR" ou l\'anonymiser directement.';
  hint.style.background = '';
  hint.style.borderColor = '';
  hint.style.color = '';
  currentSelection = "";
}

function resetHintStep3() {
  // Mode normal
  const hint3  = document.getElementById('viewerHintStep3');
  const evHint = document.getElementById('entityViewerHint');
  if (hint3)  hint3.style.display  = 'none';
  if (evHint) evHint.style.display = 'inline';
  // Mode agrandi (modale)
  const hint3M  = document.getElementById('viewerHintStep3Modal');
  const evHintM = document.getElementById('entityViewerHintModal');
  if (hint3M)  hint3M.style.display  = 'none';
  if (evHintM) evHintM.style.display = 'inline';
  currentSelection = '';
  hideSelectionPopover();
}

function showSelectionPopover(text) {
// Fermer le menu contextuel s'il est ouvert
const ctx = document.getElementById('ctxMenu');
if (ctx) ctx.style.display = 'none';
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const range = sel.getRangeAt(0);
  const rect  = range.getBoundingClientRect();
  const pop   = document.getElementById('selectionPopover');
  const label = document.getElementById('selectionPopoverLabel');
  if (!pop || !label) return;

  label.textContent = text.length > 40 ? `"${text.slice(0, 38)}…"` : `"${text}"`;

  pop.style.display = 'flex';

  const popW = 320;
// Ancrer EN DESSOUS par défaut (évite le conflit avec PopClip qui est toujours au-dessus)
let top  = rect.bottom + 8;  // ← était rect.top - 48
let left = rect.left + rect.width / 2 - popW / 2;

left = Math.max(8, Math.min(left, window.innerWidth - popW - 8));

// Basculer au-dessus seulement si pas assez de place en bas
if (top + 48 > window.innerHeight) top = rect.top - 48;

pop.style.left = left + 'px';
pop.style.top  = top  + 'px';

}

function hideSelectionPopover() {
  const pop = document.getElementById('selectionPopover');
  if (pop) pop.style.display = 'none';
  currentSelection = '';
}

function prefillFromRule(val) {
  const fromEl = document.getElementById('ocrFrom');
  fromEl.value = val;
  fromEl.focus();
  document.getElementById('ocrTo').focus();
}

// ── Raccourci Ctrl+F dans le visualiseur ──────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f' && State.currentStep === 2) {
    e.preventDefault();
    document.getElementById('viewerSearch').focus();
    document.getElementById('viewerSearch').select();
  }
});

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
    e.preventDefault();
    toggleRRPanel();
  }
  if (e.key === 'Escape' && RR.active) {
    closeRRPanel();
  }
  if (e.key === 'Escape') {
    hideSelectionPopover();
  }
});

// ── Attache les événements de sélection sur le visualiseur ────────────────────
// (fait ici plutôt qu'en inline pour fiabilité cross-browser)
document.addEventListener('DOMContentLoaded', () => {

  // ── Séparateur draggable entre les deux colonnes ───────────────────────────
  const divider  = document.getElementById('ocrSplitDivider');
  const splitLeft  = document.getElementById('ocrSplitLeft');
  const splitRight = document.getElementById('ocrSplitRight');

  if (divider && splitLeft && splitRight) {
    let dragging = false;
    let startX, startLeftW;

    divider.addEventListener('mousedown', e => {
      dragging  = true;
      startX    = e.clientX;
      startLeftW = splitLeft.getBoundingClientRect().width;
      document.body.style.cursor    = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const container = document.getElementById('ocrSplitCols') || splitLeft.parentElement;
      const contW     = container.getBoundingClientRect().width;
      const delta     = e.clientX - startX;
      const newLeftW  = Math.max(200, Math.min(contW - 250, startLeftW + delta));
      splitLeft.style.width  = newLeftW + 'px';
      splitLeft.style.flex   = 'none';
      splitRight.style.flex  = '1';
      // Synchroniser le header gauche
      const hl = document.querySelector('.split-header-left');
      if (hl) { hl.style.width = newLeftW + 'px'; hl.style.flexShrink = '0'; }
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor    = '';
      document.body.style.userSelect = '';
      // Persister la largeur
      localStorage.setItem('ocrSplitLeftW', splitLeft.style.width);
    });

    // Restaurer la largeur sauvegardée
    const saved = localStorage.getItem('ocrSplitLeftW');
    if (saved) {
      splitLeft.style.width = saved; splitLeft.style.flex = 'none';
      const headerLeft = document.querySelector('.split-header-left');
      if (headerLeft) { headerLeft.style.width = saved; headerLeft.style.flexShrink = '0'; }
    }
  }

  const viewer = document.getElementById('textViewer');
  if (!viewer) return;

  // mouseup uniquement (pointerup causerait un double appel sur Mac trackpad)
  viewer.addEventListener('mouseup', handleTextSelection);

  // Empêcher contenteditable de capturer le clic droit
  // en bloquant le focus natif sur contextmenu
  viewer.addEventListener('mousedown', e => {
    if (e.button === 2) {
      // Clic droit : empêcher le déplacement du curseur d'édition
      e.preventDefault();
    }
  });

  // keyup : sélection au clavier (Shift+flèches)
  viewer.addEventListener('keyup', e => {
    if (e.shiftKey || e.key === 'End' || e.key === 'Home') {
      handleTextSelection();
    }
  });

  // Fermer le popover sur clic en dehors
  document.addEventListener('mousedown', e => {
    const pop = document.getElementById('selectionPopover');
    if (!pop || pop.style.display === 'none') return;
    // Ne pas fermer si le clic est dans le popover OU dans le ctx-menu
    const ctx = document.getElementById('ctxMenu');
    const ctxSub = document.getElementById('ctxSubmenu');
    if (pop.contains(e.target)) return;
    if (ctx && ctx.contains(e.target)) return;
    if (ctxSub && ctxSub.contains(e.target)) return;
    hideSelectionPopover();
  });

  // ── Focus : passer en mode texte brut pour l'édition ──────────────────────
  viewer.addEventListener('focus', () => {
    //console.log('%c[FOCUS] _rrReplacing='+_rrReplacing+' edit='+viewer.classList.contains('text-viewer--edit'), 'color:orange;font-weight:bold');
    if (!State.rawText) return;
    // Sauvegarder le scroll AVANT de remplacer l'innerHTML
    const scrollTop = viewer.scrollTop;
    const plain = State.processedText || State.rawText;
    viewer.textContent = plain;
    // Restaurer le scroll immédiatement après
    viewer.scrollTop = scrollTop;
    viewer.classList.add('text-viewer--edit');
    const searchInput = document.getElementById('viewerSearch');
    if (searchInput) searchInput.disabled = true;

    // Mettre à jour le gutter avec le nombre de lignes du texte brut
    const lineCount = plain.split('\n').length;
    updateViewerGutter(lineCount);
    // Re-synchro scroll (le scrollTop vient d'être restauré)
    _syncGutterScroll();
  });

  // ── Blur : sauvegarder et re-surligner ────────────────────────────────────
  viewer.addEventListener('blur', () => {
    //console.log('%c[BLUR] _rrReplacing='+_rrReplacing+' edit='+viewer.classList.contains('text-viewer--edit'), 'color:purple;font-weight:bold');
    // if (_rrReplacing) { console.log('[BLUR] bloqué'); return; }
    if (!State.rawText) return;
    // Récupérer le texte modifié.
    // En mode édition, le contenu est du textContent brut (pas de spans).
    // En mode vue, les spans vides contiennent \u00a0 → les nettoyer ligne par ligne.
    let edited;
    if (viewer.classList.contains('text-viewer--edit')) {
      // Mode édition : innerText préserve les sauts de ligne
      edited = viewer.innerText;
    } else {
      // Mode vue (ne devrait pas blur sans focus, mais par sécurité)
      edited = viewer.innerText.split('\n')
        .map(l => l === '\u00a0' ? '' : l)
        .join('\n');
    }
    if (edited !== (State.processedText || State.rawText)) {
      State.processedText = edited;
      State.rawText = edited;
      showToast('Texte mis à jour ✓');
    }
    viewer.classList.remove('text-viewer--edit');
    // Réactiver recherche
    const searchInput = document.getElementById('viewerSearch');
    if (searchInput) searchInput.disabled = false;
    // Sauvegarder le scroll avant le rebuild
    const scrollTop = viewer.scrollTop;
    // Rebuilder le HTML avec surlignage
    refreshViewer();
    // Restaurer le scroll après le rebuild
    viewer.scrollTop = scrollTop;
    if (State.viewerTab === 'side') updateSidePane();
    // Auto-save après modification texte
    scheduleAutoSave();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ── UNDO — Historique des entités (Ctrl+Z) ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const UNDO_MAX = 20; // niveaux d'annulation conservés
const _undoStack = [];  // [{ entities: [...], label: '...' }, ...]
let   _undoToast = null; // référence au toast undo pour l'effacer

/**
 * Sauvegarde l'état courant des entités avant une opération destructive.
 * @param {string} label — description courte de l'opération (pour le toast)
 */
function pushUndo(label = 'Modification') {
  // Deep copy des entités (aliases inclus)
  const snapshot = State.entities.map(e => ({ ...e, aliases: [...(e.aliases || [])] }));
  _undoStack.push({ entities: snapshot, label });
  if (_undoStack.length > UNDO_MAX) _undoStack.shift();
  _updateUndoBtn();
}

/** Annule la dernière opération sur les entités */
function undoEntities() {
  if (_undoStack.length === 0) { showToast('Rien à annuler'); return; }
  const { entities, label } = _undoStack.pop();
  State.entities = entities;
  renderEntityTable(State.entities);
  if (State.currentStep === 3) setTimeout(() => refreshEntityViewer(), 0);
  _updateUndoBtn();
  showToast(`↩ Annulé : ${label}`);
  scheduleAutoSave();
}

/** Met à jour les boutons Undo (barre principale + modale) */
function _updateUndoBtn() {
  const has   = _undoStack.length > 0;
  const label = has ? `Annuler : ${_undoStack[_undoStack.length - 1].label} (Ctrl+Z)` : 'Rien à annuler';

  for (const id of ['btnUndo', 'btnUndoModal']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.disabled     = !has;
    btn.title        = label;
    btn.style.opacity = has ? '1' : '0.4';
  }
}

// Raccourci clavier Ctrl+Z global (uniquement en étape 3, hors champ texte)
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    // Ne pas intercepter si on est dans un input/textarea/contenteditable actif
    const tag = document.activeElement?.tagName;
    const ce  = document.activeElement?.isContentEditable;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || ce) return;
    if (State.currentStep !== 3) return;
    e.preventDefault();
    undoEntities();
  }
});

// ── STEP 3 : Entities ─────────────────────────────────────────────────────────
// ── STEP 3 : Analyse ─────────────────────────────────────────────────────────
async function runAnalysis() {
  const textToAnalyze = State.processedText || State.rawText;
  if (!textToAnalyze) return;

  document.getElementById('analyzeBox').style.display      = 'none';
  document.getElementById('analysisProgress').style.display = 'block';

  try {
    // 1. Détection locale (analysis.js) — 60% de la barre
    const detectedRaw = await Analysis.analyze(textToAnalyze, null, (pct, msg) => {
      document.getElementById('progressFill').style.width = (pct * 0.6) + '%';
      document.getElementById('progressMsg').textContent  = msg;
    });

    // 2. Résolution d'identité (identity-resolver.js) — 40% restants
    document.getElementById('progressMsg').textContent = 'Résolution des identités…';
    const resolved = (typeof IdentityResolver !== 'undefined')
      ? IdentityResolver.resolve(textToAnalyze, detectedRaw, {
          onProgress: (pct, msg) => {
            document.getElementById('progressFill').style.width = (60 + pct * 0.4) + '%';
            document.getElementById('progressMsg').textContent  = msg;
          },
        })
      : detectedRaw;

    // 3. Fusion avec les entités manuelles existantes
    const existingValues = new Set(State.entities.map(e => e.value.toLowerCase()));
    const newUnique = resolved.filter(de => {
      if (existingValues.has(de.value.toLowerCase())) return false;
      existingValues.add(de.value.toLowerCase());
      return true;
    });
    State.entities = [...State.entities, ...newUnique];

    // 4. Affichage
    renderEntityTable(State.entities);

    const elProgress = document.getElementById('analysisProgress');
    const elActions  = document.getElementById('step3Actions');
    const elBulk     = document.getElementById('bulkActionsBar');
    const elAnalyze  = document.getElementById('analyzeBox');

    if (elProgress) elProgress.style.display = 'none';
    if (elActions)  elActions.style.display  = 'flex';
    if (elBulk)     elBulk.style.display     = 'flex';
    if (elAnalyze)  elAnalyze.style.display  = 'none';

    setLeftPanelView('entities');
    unlockStep(4);
    initEntityViewer();

    // 5. Ouvrir la modale Parties automatiquement après l'analyse
    setTimeout(() => openPartiesModal(), 500);

  } catch (err) {
    console.error(err);
    document.getElementById('analysisProgress').style.display = 'none';
    document.getElementById('analyzeBox').style.display       = 'flex';
    alert('Erreur lors de l\'analyse : ' + err.message);
  }
}




// ── Rendu du tableau entités ──────────────────────────────────────────────────

let _currentFilter = '';

function renderEntityTable(entities, filterType) {
  if (filterType !== undefined) _currentFilter = filterType;

  // Les entités isInitiale sont gérées par anonymize.js mais n'apparaissent pas dans le tableau
  const tableEntities = entities.filter(e => !e.isInitiale);

  let filtered = _currentFilter
    ? tableEntities.filter(e => e.type === _currentFilter)
    : [...tableEntities];

  // Filtre recherche texte
  if (_entitySearchQuery) {
    filtered = filtered.filter(e =>
      e.value.toLowerCase().includes(_entitySearchQuery) ||
      (e.aliases || []).some(a => a.toLowerCase().includes(_entitySearchQuery))
    );
  }

  // Tri alphabétique
  if (_entitySortMode === 'asc') {
    filtered.sort((a, b) => a.value.localeCompare(b.value, 'fr', { sensitivity: 'base' }));
  } else if (_entitySortMode === 'desc') {
    filtered.sort((a, b) => b.value.localeCompare(a.value, 'fr', { sensitivity: 'base' }));
  }

  const active = tableEntities.filter(e => e.active && !e.blocked).length;
  document.getElementById('entityCount').textContent = tableEntities.length;
  document.getElementById('entityActive').textContent = active;

  // Afficher la barre d'actions en masse dès qu'il y a des entités
  const bulk = document.getElementById('bulkActionsBar');
  if (bulk) bulk.style.display = tableEntities.length > 0 ? 'flex' : 'none';

  // Synchronise la case "tout sélectionner"
  const chkAll = document.getElementById('chkAllEntities');
  if (chkAll) {
    const activatable = filtered.filter(e => !e.blocked);
    chkAll.checked = activatable.length > 0 && activatable.every(e => e.active);
    chkAll.indeterminate = activatable.some(e => e.active) && !activatable.every(e => e.active);
  }

  const tbody = document.getElementById('entityTbody');
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--ink4);padding:20px">Aucune entité${_currentFilter ? ' de ce type' : ''}.</td></tr>`;
    // Rafraîchir le viewer si visible
    buildEntityViewerHTML(State.processedText || State.rawText || '');
    return;
  }

  tbody.innerHTML = filtered.map(ent => {
    const inactive = !ent.active || ent.blocked;
    const aliases  = (ent.aliases || []).map(a =>
      `<span class="alias-tag">${escHtml(a)}<button class="alias-del" onclick="removeAlias('${ent.id}','${escAttr(a)}')" title="Supprimer">×</button></span>`
    ).join('');
    return `
    <tr class="${inactive ? 'inactive' : ''}" id="erow_${ent.id}">
      <td class="col-check">
        <input type="checkbox" ${ent.active && !ent.blocked ? 'checked' : ''}
          onchange="toggleEntity('${ent.id}', this.checked)"
          ${ent.blocked ? 'disabled title="Bloqué"' : ''}>
      </td>
      <td class="col-value" onclick="highlightEntityInViewer('${ent.id}')" style="cursor:pointer" title="Cliquer pour localiser dans le texte">
        <span class="entity-value ${ent.blocked ? 'blocked' : ''}">${escHtml(ent.value)}</span>
        ${ent.manual ? '<span class="tag-manual">manuel</span>' : ''}
      </td>
      <td class="col-type">
        <select class="type-select type-${ent.type}" onchange="changeEntityType('${ent.id}', this.value)"
          title="Changer le type">
          ${(() => {
            const allTypes = getAllTypes();
            const known = allTypes.find(t => t.id === ent.type);
            // Si le type n'est pas dans la liste (ex: DEMANDEUR_1, DEFENDEUR_2…)
            // ajouter une option dynamique sélectionnée en premier
            const extra = !known
              ? `<option value="${escAttr(ent.type)}" selected>${escHtml(ent.type)}</option>`
              : '';
            return extra + allTypes.map(t =>
              `<option value="${escAttr(t.id)}" ${ent.type === t.id ? 'selected' : ''}>${escHtml(t.label)}</option>`
            ).join('');
          })()}
        </select>
      </td>
      <td class="col-aliases">
        ${aliases}
        <button class="btn-alias" onclick="promptAddAlias('${ent.id}')">+alias</button>
      </td>
      <td class="col-occ">${ent.occurrences || '—'}</td>
      <td class="col-actions">
        <button class="btn-icon-sm" onclick="caviarderEntity('${ent.id}')"
          title="Caviarder toutes les occurrences">✂</button>
        <button class="btn-icon-sm" onclick="blockEntity('${ent.id}')"
          title="${ent.blocked ? 'Débloquer' : 'Ne jamais anonymiser'}">${ent.blocked ? '✓' : '⛔'}</button>
        <button class="btn-icon-sm btn-delete" onclick="deleteEntity('${ent.id}')"
          title="Supprimer de la liste">🗑</button>
      </td>
    </tr>`;
  }).join('');
  // Rafraîchir le viewer texte si en step 3
  if (State.currentStep === 3) buildEntityViewerHTML(State.processedText || State.rawText || '');
  // Sync modale si ouverte
  const _modal = document.getElementById('entitiesModal');
  if (_modal && _modal.style.display !== 'none') renderEntityTableModal();
  // Auto-save après modification entités
  scheduleAutoSave();
}

// ── Actions entité ────────────────────────────────────────────────────────────

function toggleEntity(id, active) {
  const ent = State.entities.find(e => e.id === id);
  if (!ent) return;
  ent.active = active;

  // Mettre à jour la classe inactive sur la ligne (sans reconstruire)
  [document.getElementById(`erow_${id}`), document.getElementById(`erow_modal_${id}`)].forEach(row => {
    if (row) row.classList.toggle('inactive', !active || ent.blocked);
  });

  // Mettre à jour les compteurs
  const activeCount = State.entities.filter(e => e.active && !e.blocked).length;
  ['entityActive','entityActiveModal'].forEach(elId => {
    const el = document.getElementById(elId); if (el) el.textContent = activeCount;
  });
  ['entityCount','entityCountModal'].forEach(elId => {
    const el = document.getElementById(elId); if (el) el.textContent = State.entities.length;
  });

  if (State.currentStep === 3) buildEntityViewerHTML(State.processedText || State.rawText || '');
}

function blockEntity(id) {
  const ent = State.entities.find(e => e.id === id);
  if (!ent) return;
  if (ent.blocked) {
    // Débloquer : remettre actif
    ent.blocked = false; ent.active = true;
    renderEntityTable(State.entities);
    refreshViewer();
    showToast(`"${ent.value}" réactivé`);
  } else {
    // Blacklister ET supprimer de la liste
    pushUndo(`Exclusion "${ent.value}"`);
    Analysis.addToBlacklist([ent.value, ...(ent.aliases || [])]);
    Server.saveBlacklist([...Analysis.getBlacklistWords()]).catch(() => {});
    State.entities = State.entities.filter(e => e.id !== id);
    renderEntityTable(State.entities);
    if (State.currentStep === 3) refreshEntityViewer();
    showToast(`"${ent.value}" blacklisté et retiré`);
  }
}

function deleteEntity(id) {
  const ent = State.entities.find(e => e.id === id);
  if (ent) pushUndo(`Suppression "${ent.value}"`);
  State.entities = State.entities.filter(e => e.id !== id);
  renderEntityTable(State.entities);
}

function promptAddAlias(id) {
  const val = prompt('Alias à ajouter (variante OCR ou orthographe alternative) :');
  if (!val || !val.trim()) return;
  const ent = State.entities.find(e => e.id === id);
  if (ent) {
    if (!ent.aliases) ent.aliases = [];
    ent.aliases.push(val.trim());
    renderEntityTable(State.entities);
  }
}

function removeAlias(id, alias) {
  const ent = State.entities.find(e => e.id === id);
  if (ent) {
    ent.aliases = (ent.aliases || []).filter(a => a !== alias);
    renderEntityTable(State.entities);
  }
}

function filterEntities() {
  _currentFilter = document.getElementById('typeFilter').value;
  renderEntityTable(State.entities);
}

// ── Sélectionner tout / désélectionner tout ───────────────────────────────────

function toggleAllEntities(chk) {
  const filtered = _currentFilter
    ? State.entities.filter(e => e.type === _currentFilter)
    : State.entities;
  filtered.forEach(e => { if (!e.blocked) e.active = chk.checked; });

  // Mettre à jour les checkboxes individuelles dans le DOM sans reconstruire
  filtered.forEach(e => {
    // Tableau principal
    const row = document.getElementById(`erow_${e.id}`);
    if (row) {
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb && !e.blocked) cb.checked = chk.checked;
      row.classList.toggle('inactive', !e.active || e.blocked);
    }
    // Modale
    const rowM = document.getElementById(`erow_modal_${e.id}`);
    if (rowM) {
      const cbM = rowM.querySelector('input[type="checkbox"]');
      if (cbM && !e.blocked) cbM.checked = chk.checked;
      rowM.classList.toggle('inactive', !e.active || e.blocked);
    }
  });

  // Sync checkbox jumelle
  const chkMain  = document.getElementById('chkAllEntities');
  const chkModal = document.getElementById('chkAllEntitiesModal');
  if (chkMain  && chkMain  !== chk) chkMain.checked  = chk.checked;
  if (chkModal && chkModal !== chk) chkModal.checked = chk.checked;

  // Mettre à jour les compteurs
  const activeCount = State.entities.filter(e => e.active && !e.blocked).length;
  ['entityActive','entityActiveModal'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = activeCount;
  });
  if (State.currentStep === 3) buildEntityViewerHTML(State.processedText || State.rawText || '');
}

// ── Suppression en masse → blacklist ─────────────────────────────────────────

/**
 * Supprime toutes les entités décochées (active=false) et les envoie
 * vers la blacklist persistante pour ne plus les revoir.
 */
async function deleteUncheckedToBlacklist() {
  // Respecter le filtre actif : si un type est sélectionné, n'agir que sur ce type
  const scope = _currentFilter
    ? State.entities.filter(e => e.type === _currentFilter && !e.active && !e.blocked)
    : State.entities.filter(e => !e.active && !e.blocked);
  const scopeLabel = _currentFilter ? ` (type « ${_currentFilter} »)` : '';

  if (scope.length === 0) {
    showToast(`Aucune entité décochée${scopeLabel}`);
    return;
  }
  const preview = scope.slice(0, 5).map(e => `<code>${escHtml(e.value)}</code>`).join(', ')
    + (scope.length > 5 ? ` <em>+${scope.length - 5} autres</em>` : '');
  const ok = await showConfirm({
    icon: '🚫',
    title: `Supprimer ${scope.length} entité(s) décochée(s)${scopeLabel} ?`,
    body: `Les entités suivantes seront <strong>retirées de la liste</strong> et ajoutées à la blacklist :<br><br>${preview}<br><br>
           <span style="color:var(--ink3);font-size:12px">💡 Utilisez Ctrl+Z pour annuler si nécessaire.</span>`,
    ok: `🚫 Supprimer ${scope.length} décochée(s)`,
    cancel: 'Annuler',
  });
  if (!ok) return;

  pushUndo(`Suppression ${scope.length} décochée(s)${scopeLabel} → BL`);

  const removeIds = new Set(scope.map(e => e.id));
  State.entities = State.entities.filter(e => !removeIds.has(e.id));
  Analysis.addToBlacklist(scope.map(e => e.value));

  try {
    const allWords = [...Analysis.getBlacklistWords()];
    await Server.saveBlacklist(allWords);
    showToast(`${scope.length} entité(s) supprimée(s) → blacklist (${allWords.length} mots)`);
  } catch {
    showToast(`${scope.length} entité(s) supprimée(s) (blacklist non persistée — serveur inactif)`);
  }

  renderEntityTable(State.entities);
}


async function deleteCheckedToBlacklist() {
  const scope = _currentFilter
    ? State.entities.filter(e => e.type === _currentFilter && e.active && !e.blocked)
    : State.entities.filter(e => e.active && !e.blocked);
  const scopeLabel = _currentFilter ? ` (type « ${_currentFilter} »)` : '';

  if (scope.length === 0) {
    showToast(`Aucune entité cochée${scopeLabel}`);
    return;
  }
  const preview = scope.slice(0, 5).map(e => `<code>${escHtml(e.value)}</code>`).join(', ')
    + (scope.length > 5 ? ` <em>+${scope.length - 5} autres</em>` : '');
  const ok = await showConfirm({
    icon: '⚠️',
    title: `Supprimer ${scope.length} entité(s) cochée(s)${scopeLabel} ?`,
    body: `<strong style="color:#dc2626">Attention :</strong> vous allez supprimer les entités <strong>actives</strong> (à anonymiser)${scopeLabel} :<br><br>
           ${preview}<br><br>
           Elles seront retirées de la liste ET ajoutées à la blacklist.<br>
           <span style="color:var(--ink3);font-size:12px">💡 Utilisez Ctrl+Z pour annuler immédiatement après si nécessaire.</span>`,
    ok: `⚠️ Supprimer quand même`,
    cancel: 'Annuler',
  });
  if (!ok) return;

  pushUndo(`Suppression ${scope.length} cochée(s)${scopeLabel} → BL`);

  const removeIds = new Set(scope.map(e => e.id));
  State.entities = State.entities.filter(e => !removeIds.has(e.id));
  Analysis.addToBlacklist(scope.map(e => e.value));

  try {
    const allWords = [...Analysis.getBlacklistWords()];
    await Server.saveBlacklist(allWords);
    showToast(`${scope.length} entité(s) cochée(s) supprimée(s) → blacklist`);
  } catch {
    showToast(`${scope.length} entité(s) supprimée(s) (blacklist non persistée)`);
  }

  renderEntityTable(State.entities);
}

/**
 * Supprime toutes les entités du type actuellement filtré et les blackliste.
 */
async function deleteFilteredTypeToBlacklist() {
  if (!_currentFilter) {
    showToast('Sélectionnez d\'abord un type dans le filtre');
    return;
  }
  const toRemove = State.entities.filter(e => e.type === _currentFilter);
  if (toRemove.length === 0) return;
  const ok = await showConfirm({
    icon: '🗑',
    title: `Supprimer ${toRemove.length} entité(s) de type « ${_currentFilter} » ?`,
    body: `Toutes les entités de ce type seront retirées de la liste et blacklistées.<br>
           <span style="color:var(--ink3);font-size:12px">💡 Ctrl+Z pour annuler.</span>`,
    ok: `🗑 Supprimer ${toRemove.length} entité(s)`,
    cancel: 'Annuler',
  });
  if (!ok) return;

  pushUndo(`Suppression type ${_currentFilter} → BL`);

  const removeIds = new Set(toRemove.map(e => e.id));
  State.entities = State.entities.filter(e => !removeIds.has(e.id));
  Analysis.addToBlacklist(toRemove.map(e => e.value));

  try {
    await Server.saveBlacklist([...Analysis.getBlacklistWords()]);
    showToast(`${toRemove.length} entité(s) « ${_currentFilter} » supprimée(s) → blacklist`);
  } catch {
    showToast(`${toRemove.length} entité(s) supprimée(s)`);
  }

  // Réinitialiser le filtre
  _currentFilter = '';
  document.getElementById('typeFilter').value = '';
  renderEntityTable(State.entities);
}

// ── Fusion doublons ───────────────────────────────────────────────────────────

/**
 * Fusion sur sélection : les entités COCHÉES sont fusionnées.
 * La première cochée devient l'entité canonique.
 * Les autres deviennent ses alias et sont supprimées.
 */
function mergeDuplicateEntities() {
  const selected = State.entities.filter(e => e.active && !e.blocked);

  if (selected.length < 2) {
    showToast('Cochez au moins 2 entités à fusionner, puis cliquez Fusionner');
    return;
  }

  // La première entité cochée est la canonique
  const [canonical, ...toMerge] = selected;
  const mergeIds = new Set(toMerge.map(e => e.id));

  // Ajouter les valeurs + alias des entités fusionnées comme alias de la canonique
  toMerge.forEach(e => {
    const newAliases = [e.value, ...(e.aliases || [])].filter(Boolean);
    canonical.aliases = [...new Set([...(canonical.aliases || []), ...newAliases])];
    canonical.occurrences = (canonical.occurrences || 1) + (e.occurrences || 1);
  });

  // Supprimer les entités absorbées
  State.entities = State.entities.filter(e => !mergeIds.has(e.id));

  renderEntityTable(State.entities);
  showToast(`${toMerge.length} entité(s) fusionnée(s) dans "${canonical.value}"`);
}

// ── Ajout manuel ──────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════════
// ── SCANNER LES OUBLIS ────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const ScanOublis = (() => {

  // Patterns de détection par catégorie
  const PATTERNS = [
    // ── Civilités : capture la civilité + ce qui suit (jusqu'à 4 mots)
    {
      cat: 'civilite',
      icon: '👤',
      defaultType: 'NOM',
      label: 'Civilité',
      // Civilité seule (M. Dupont) ou avec prénom (Monsieur Jean Dupont)
      regex: /\b(M\.?|Mr\.?|Mme\.?|Mlle\.?|Monsieur|Madame|Mademoiselle|Maître|Me\.?)\s+((?:[A-ZÀ-Ö][a-zà-öù\-']{1,}|[A-ZÀ-Ö]{2,})(?:\s+(?:[A-ZÀ-Ö][a-zà-öù\-']{1,}|[A-ZÀ-Ö]{2,})){0,3})/g,
      extract: m => m[0].trim(),   // valeur complète à extraire
    },
    // ── Adresses : numéro + voie
    {
      cat: 'adresse',
      icon: '🏠',
      defaultType: 'ADRESSE',
      label: 'Adresse',
      // Cas 1 : numéro + tout mot de voie / Cas 2 : sans numéro, mots non-ambigus seulement
      regex: new RegExp(
        String.raw`\b` +
        String.raw`(?:(\d{1,4}\s*(?:bis|ter|quater)?\s*,?\s*)(rue|avenue|av\.|boulevard|bd\.?|place|pl\.|allée|impasse|chemin|route|voie|passage|square|rond-?point|résidence|cité|hameau|lieu-dit)\s+(?:de\s+(?:la\s+|l['']\s*|les\s+|du\s+)?)?([A-ZÀ-Öa-zà-ö][A-Za-zÀ-Öà-ö\s\-'']{2,40}))` +
        String.raw`|(?:()(rue|avenue|av\.|boulevard|bd\.?|place|pl\.|impasse|square|rond-?point|hameau|lieu-dit)\s+(?:de\s+(?:la\s+|l['']\s*|les\s+|du\s+)?)?([A-ZÀ-Ö][A-Za-zÀ-Öà-ö\s\-'']{2,40}))`,
        'gi'
      ),
      extract: m => m[0].trim(),
    },
    // ── Codes postaux + ville : 5 chiffres + mot(s) en majuscule
    {
      cat: 'codepostal',
      icon: '📮',
      defaultType: 'ADRESSE',
      label: 'CP + Ville',
      regex: /\b(\d{5})\s+([A-ZÀÂÉÈÊËÎÏÔÙÛÜ][A-ZÀÂÉÈÊËÎÏÔÙÛÜ\s\-]{1,30})\b/g,
      extract: m => m[0].trim(),
    },
    // ── Organisations : SARL, SAS, SCI, SA, EURL, SNC + nom qui suit
    {
      cat: 'org',
      icon: '🏢',
      defaultType: 'ENTITE',
      label: 'Organisation',
      regex: /\b(SARL|SAS|SASU|SCI|SA|EURL|SNC|GIE|SCOP|SEP|SCP|SC)\s+([A-ZÀ-Öa-zà-ö][A-Za-zÀ-Öà-ö0-9\s&\-'.]{2,50}?)(?=\s*[,;.\n([]|$)/g,
      extract: m => m[0].trim(),
    },
    // ── Orgs : "la société X", "l'entreprise X", "la copropriété X"
    {
      cat: 'org',
      icon: '🏢',
      defaultType: 'ENTITE',
      label: 'Organisation nommée',
      regex: /\b(?:la\s+société|l['']entreprise|la\s+copropriété|le\s+syndicat|l['']association|la\s+compagnie|le\s+cabinet)\s+([«"']?[A-ZÀ-Ö][A-Za-zÀ-Öà-ö0-9\s&\-'.]{2,50}[«"']?)/gi,
      extract: m => m[0].trim(),
    },
    // ── Titres professionnels : Commissaire de Justice, conciliateur, Docteur, Professeur + nom
    {
      cat: 'civilite',
      icon: '👤',
      defaultType: 'NOM',
      label: 'Titre professionnel',
      regex: /\b(?:Commissaire\s+de\s+Justice|conciliateur\s+de\s+justice|Docteur|Professeur|Dr\.?|Pr\.?|Prof\.?)\s+((?:[A-ZÀ-Ö][a-zà-öù\-']{1,}|[A-ZÀ-Ö]{2,})(?:\s+(?:[A-ZÀ-Ö][a-zà-öù\-']{1,}|[A-ZÀ-Ö]{2,})){0,3})/g,
      extract: m => m[0].trim(),
    },
    // ── Civilité + initiale + nom : "Madame A. Dupont", "Monsieur B. Martin"
    {
      cat: 'civilite',
      icon: '👤',
      defaultType: 'NOM',
      label: 'Civilité + initiale',
      regex: /\b(?:M\.?|Mr\.?|Mme\.?|Mlle\.?|Monsieur|Madame|Mademoiselle|Maître|Me\.?)\s+[A-ZÀ-Ö]\.\s+((?:[A-ZÀ-Ö][a-zà-öù\-']{1,}|[A-ZÀ-Ö]{2,})(?:\s+(?:[A-ZÀ-Ö][a-zà-öù\-']{1,}|[A-ZÀ-Ö]{2,})){0,2})/g,
      extract: m => m[0].trim(),
    },
    // ── Noms tout-majuscules orphelins : "de OUCHAABA", "logement de DUPONT"
    // Capture un mot ou groupe tout-caps ≥ 4 chars, précédé d'une préposition ou verbe courant,
    // sans exiger de civilité (cas fréquent dans les titres de section et bordereaux)
    {
      cat: 'civilite',
      icon: '👤',
      defaultType: 'NOM',
      label: 'Nom tout-caps',
      regex: /\b(?:de|du|par|pour|entre|avec|chez|sur|contre|concernant|logement\s+de|dossier\s+de|affaire|locataire)\s+([A-ZÀ-ÖØ-Ý]{3,}(?:[- ][A-ZÀ-ÖØ-Ý]{2,}){0,3})\b/g,
      extract: m => m[1].trim(),
    },
    // ── Prénom orphelin après placeholder : "[NOM_8] Mabhidine" ou "[NOM_8] M."
    // Détecte un mot capitalisé (≥ 4 chars) immédiatement après un [PLACEHOLDER]
    // qui n'aurait pas été remplacé (fuite de prénom isolé)
    {
      cat: 'civilite',
      icon: '👤',
      defaultType: 'NOM',
      label: 'Prénom après placeholder',
      regex: /\[(?:NOM|SUPPRIMÉ|ADRESSE)[^\]]*\]\s+([A-ZÀ-Ö][a-zà-öù]{3,}(?:\s+[A-ZÀ-Ö][a-zà-öù]{2,}){0,2})\b/g,
      extract: m => m[1].trim(),
    },
  ];

  // Catégorie courante pour le filtre
  let _currentCat = 'all';
  // Résultats du dernier scan
  let _results = [];
  // Set des valeurs ignorées dans cette session de scan
  let _ignored = new Set();

  function open() {
    document.getElementById('scanOublisOverlay').style.display = 'flex';
    _ignored = new Set();
    _currentCat = 'all';
    // Réinitialiser les filtres visuels
    document.querySelectorAll('.scan-filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.cat === 'all');
    });
    document.getElementById('scanResults').innerHTML =
      '<div class="scan-empty">Cliquez sur <strong>Scanner</strong> pour analyser le document.</div>';
    document.getElementById('scanCount').textContent = '';
  }

  function close() {
    document.getElementById('scanOublisOverlay').style.display = 'none';
  }

  function run() {
    const text = State.processedText || State.rawText;
    if (!text) {
      showToast('Aucun texte disponible à scanner');
      return;
    }

    // Valeurs déjà dans la liste des entités (+ leurs alias)
    const alreadyCaptured = new Set();
    for (const e of State.entities) {
      alreadyCaptured.add(e.value.toLowerCase().trim());
      for (const a of (e.aliases || [])) {
        alreadyCaptured.add(a.toLowerCase().trim());
      }
    }
    // Mots caviardés : exclus exactement ET par inclusion partielle (ex: "Haqege" exclut "Prof. Haqege")
    const caviardedWords = new Set();
    for (const cav of (State.caviardages || [])) {
      if (cav.word) {
        const w = cav.word.toLowerCase().trim().replace(/\s+/g, ' ');
        alreadyCaptured.add(w); caviardedWords.add(w);
        w.split(/\s+/).filter(t => t.length >= 4).forEach(t => caviardedWords.add(t));
      }
    }
    // Ignorés persistants
    for (const v of (State.scanIgnored || [])) {
      alreadyCaptured.add(v.toLowerCase().trim());
    }

    _results = [];
    const seen = new Set(); // éviter les doublons entre patterns

    for (const pat of PATTERNS) {
      pat.regex.lastIndex = 0;
      let m;
      while ((m = pat.regex.exec(text)) !== null) {
        const raw = pat.extract(m).trim();
        if (!raw || raw.length < 3) continue;

        const key = raw.toLowerCase();
        if (seen.has(key)) continue;
        if (alreadyCaptured.has(key)) continue;
        // Vérifier si déjà couvert selon la catégorie :
        // - adresses : exacte seulement (un mot court comme "Vaugirard" ne doit pas bloquer "80 rue de Vaugirard")
        // - civilités/orgs : filtrer si composant déjà capturé, mais seulement si ≥ 8 chars
        //   (seuil relevé à 8 pour éviter que "Annaïk" (6 chars) bloque "Madame Annaïk MEROYER")
        let alreadyContained = false;
        if (pat.cat === 'adresse' || pat.cat === 'codepostal') {
          alreadyContained = alreadyCaptured.has(key);
        } else {
          const kw1 = key.split(/\s+/).filter(w => w.length >= 3);
          alreadyContained = [...alreadyCaptured].some(v => {
            if (v.length < 3) return false;
            if (v === key || (v.length >= 8 && (v.includes(key) || key.includes(v)))) return true;
            return kw1.some(w => w === v);
          });
        }
        if (alreadyContained) continue;

        // Vérifier si le résultat contient un mot caviardé (ex: "Prof. Haqege" contient "haqege")
        if (caviardedWords.size > 0 && [...caviardedWords].some(w => key.includes(w))) continue;

        seen.add(key);

        // Extraire le contexte (±70 chars)
        const start = Math.max(0, m.index - 65);
        const end   = Math.min(text.length, m.index + raw.length + 65);
        let ctx = text.slice(start, end).replace(/\s+/g, ' ').trim();
        // Marquer la valeur dans le contexte
        const escapedRaw = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        ctx = ctx.replace(new RegExp(escapedRaw, 'i'), `<mark>${raw}</mark>`);

        _results.push({
          id:   `scan_${Math.random().toString(36).substr(2,8)}`,
          cat:  pat.cat,
          icon: pat.icon,
          value: raw,
          type:  pat.defaultType,
          ctx,
          added: false,
        });
      }
    }

    _ignored = new Set();
    renderResults();
  }

  function renderResults() {
    const container = document.getElementById('scanResults');
    const visible = _results.filter(r =>
      !_ignored.has(r.id) &&
      (_currentCat === 'all' || r.cat === _currentCat)
    );

    const total   = _results.filter(r => !_ignored.has(r.id)).length;
    const pending = visible.filter(r => !r.added).length;
    document.getElementById('scanCount').textContent =
      total > 0
        ? `${total} suspect${total > 1 ? 's' : ''} · ${pending} en attente`
        : 'Aucun oubli détecté 🎉';

    if (visible.length === 0) {
      container.innerHTML = '<div class="scan-empty">Aucun résultat dans cette catégorie.</div>';
      return;
    }

    container.innerHTML = visible.map(r => `
      <div class="scan-item ${r.added ? 'scan-added' : ''}" id="scanItem_${r.id}">
        <div class="scan-item-cat">${r.icon}</div>
        <div class="scan-item-body">
          <div class="scan-item-value" title="${r.value}">${r.value}</div>
          <div class="scan-item-context">${r.ctx}</div>
        </div>
        <div class="scan-item-type">
          <select class="scan-type-select" id="scanType_${r.id}" onchange="ScanOublis._setType('${r.id}',this.value)">
            <option value="NOM"      ${r.type==='NOM'     ?'selected':''}>NOM</option>
            <option value="ADRESSE"  ${r.type==='ADRESSE' ?'selected':''}>ADRESSE</option>
            <option value="ENTITE"   ${r.type==='ENTITE'  ?'selected':''}>ENTITE</option>
            <option value="REF"      ${r.type==='REF'     ?'selected':''}>REF</option>
            <option value="AUTRE"    ${r.type==='AUTRE'   ?'selected':''}>AUTRE</option>
          </select>
        </div>
        <div class="scan-item-actions">
          <button class="scan-add-btn" onclick="ScanOublis._add('${r.id}')" ${r.added?'disabled':''}>
            ${r.added ? '✓ Ajouté' : '+ Ajouter'}
          </button>
          <button class="scan-ignore-btn" onclick="ScanOublis._ignore('${r.id}')" title="Ne pas traiter — ne sera plus reproposé">⊘ Ignorer</button>
        </div>
      </div>
    `).join('');
  }

  function _setType(id, type) {
    const r = _results.find(r => r.id === id);
    if (r) r.type = type;
  }

  function _add(id) {
    const r = _results.find(r => r.id === id);
    if (!r || r.added) return;

    // Vérif doublon
    if (State.entities.some(e => e.value.toLowerCase() === r.value.toLowerCase())) {
      showToast(`"${r.value}" est déjà dans la liste`);
      r.added = true;
    } else {
      State.entities.unshift({
        id: `scan_${Date.now()}`,
        value: r.value,
        type: r.type,
        label: r.type,
        occurrences: 0,
        aliases: [],
        active: true,
        blocked: false,
        manual: true,
      });
      renderEntityTable(State.entities);
      if (State.currentStep === 3) setTimeout(() => refreshEntityViewer(), 0);
      r.added = true;
      showToast(`"${r.value}" ajouté comme ${r.type}`);
    }

    // Mettre à jour visuellement la carte
    const item = document.getElementById(`scanItem_${id}`);
    if (item) {
      item.classList.add('scan-added');
      const btn = item.querySelector('.scan-add-btn');
      if (btn) { btn.textContent = '✓ Ajouté'; btn.disabled = true; }
    }

    // Rafraîchir le compteur
    const total   = _results.filter(r => !_ignored.has(r.id)).length;
    const pending = _results.filter(r => !_ignored.has(r.id) && !r.added).length;
    document.getElementById('scanCount').textContent =
      `${total} suspect${total > 1 ? 's' : ''} · ${pending} en attente`;
  }

  function _ignore(id) {
    _ignored.add(id);
    // Persister dans State.scanIgnored pour ne plus reproposer
    const r = _results.find(r => r.id === id);
    if (r) {
      if (!State.scanIgnored) State.scanIgnored = [];
      const val = r.value.toLowerCase().trim();
      if (!State.scanIgnored.includes(val)) {
        State.scanIgnored.push(val);
        autoSave();
      }
    }
    const item = document.getElementById(`scanItem_${id}`);
    if (item) item.remove();
    const total   = _results.filter(r => !_ignored.has(r.id)).length;
    const pending = _results.filter(r => !_ignored.has(r.id) && !r.added).length;
    document.getElementById('scanCount').textContent =
      total > 0
        ? `${total} suspect${total > 1 ? 's' : ''} · ${pending} en attente`
        : 'Aucun oubli détecté 🎉';
    if (_results.filter(r => !_ignored.has(r.id)).length === 0) {
      document.getElementById('scanResults').innerHTML =
        '<div class="scan-empty">Tous les suspects ont été traités 🎉</div>';
    }
  }

  function filterCat(btn, cat) {
    _currentCat = cat;
    document.querySelectorAll('.scan-filter-btn').forEach(b =>
      b.classList.toggle('active', b === btn)
    );
    renderResults();
  }

  function _getPatterns() { return PATTERNS; }
  return { open, close, run, renderResults, filterCat, _add, _ignore, _setType, _getPatterns };

})();

// ── Panneau Vérification Oublis (step 3) ─────────────────────────────────────

const OublisPanel = (() => {
  let _results   = [];   // { id, value, cat, type, occurrences:[{index,ctx}], current:0, added:false, ignored:false }
  let _current   = -1;   // index du résultat actif dans _results
  let _active    = false;

  // ── Scan ─────────────────────────────────────────────────────────────────
  function run() {
    const text = State.processedText || State.rawText || '';
    if (!text) { _renderEmpty('Aucun texte disponible.'); return; }

    // Construire alreadyCaptured
    const captured = new Set();
    for (const e of State.entities) {
      captured.add(e.value.toLowerCase().trim());
      for (const a of (e.aliases || [])) captured.add(a.toLowerCase().trim());
    }
    const cavWords = new Set();
    for (const cav of (State.caviardages || [])) {
      if (cav.word) {
        const w = cav.word.toLowerCase().trim().replace(/\s+/g, ' ');
        captured.add(w); cavWords.add(w);
        w.split(/\s+/).filter(t => t.length >= 4).forEach(t => cavWords.add(t));
      }
    }
    for (const v of (State.scanIgnored || [])) captured.add(v.toLowerCase().trim());

    // Récupérer les patterns depuis ScanOublis (réutiliser la logique)
    const PATTERNS = ScanOublis._getPatterns ? ScanOublis._getPatterns() : _builtinPatterns();

    _results = [];
    const seen = new Set();

    for (const pat of PATTERNS) {
      pat.regex.lastIndex = 0;
      let m;
      while ((m = pat.regex.exec(text)) !== null) {
        const raw = pat.extract(m).trim();
        if (!raw || raw.length < 3) continue;
        const key = raw.toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(key)) continue;
        if (captured.has(key)) continue;
        let dominated = false;
        if (pat.cat === 'adresse' || pat.cat === 'codepostal') {
          dominated = captured.has(key);
        } else {
          const kw2 = key.split(/\s+/).filter(w => w.length >= 3);
          dominated = [...captured].some(v => {
            if (v.length < 3) return false;
            if (v === key || (v.length >= 8 && (v.includes(key) || key.includes(v)))) return true;
            return kw2.some(w => w === v);
          });
        }
        if (dominated) continue;
        if (cavWords.size > 0 && [...cavWords].some(w => key.includes(w))) continue;
        seen.add(key);

        // Trouver TOUTES les occurrences dans le texte
        const occurrences = _findAllOccurrences(text, raw);
        if (occurrences.length === 0) continue;

        // Détecter si un mot du résultat est déjà une entité → suggérer alias
        const rawWords = raw.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
        const parentEnt = State.entities.find(e =>
          e.active && !e.blocked &&
          rawWords.some(w => w === e.value.toLowerCase())
        );
        _results.push({
          id: `op_${Math.random().toString(36).substr(2,8)}`,
          value: raw,
          cat: pat.cat,
          defaultType: pat.defaultType,
          type: pat.defaultType,
          occurrences,
          current: 0,
          added: false,
          ignored: false,
          parentEntity: parentEnt ? parentEnt.value : null,
        });
      }
    }

    _current = _results.length > 0 ? 0 : -1;
    _render();
    _updateBadge();

    // Auto-localiser le premier résultat
    if (_current >= 0) _localize(_current);
  }

  function _builtinPatterns() {
    // Patterns de base si ScanOublis._getPatterns n'est pas exposé
    return [{
      cat: 'civilite', icon: '👤', defaultType: 'NOM',
      regex: /\b(M\.?|Mr\.?|Mme\.?|Mlle\.?|Monsieur|Madame|Mademoiselle|Maître|Me\.?)\s+((?:[A-ZÀ-Ö][a-zà-öù\-']{1,}|[A-ZÀ-Ö]{2,})(?:\s+(?:[A-ZÀ-Ö][a-zà-öù\-']{1,}|[A-ZÀ-Ö]{2,})){0,3})/g,
      extract: m => m[0].trim(),
    }];
  }

  function _findAllOccurrences(text, raw) {
    const occs = [];
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = Math.max(0, m.index - 50);
      const end   = Math.min(text.length, m.index + raw.length + 50);
      let ctx = text.slice(start, end).replace(/\s+/g, ' ').trim();
      const esc2 = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      ctx = ctx.replace(new RegExp(esc2, 'i'), `<mark class="oubli-mark">${raw}</mark>`);
      occs.push({ index: m.index, ctx });
    }
    return occs;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function _render() {
    const list = document.getElementById('oublisList');
    const nav  = document.getElementById('oublisNav');
    const count = document.getElementById('oublisPanelCount');
    if (!list) return;

    const visible = _results.filter(r => !r.ignored);
    if (count) count.textContent = visible.length > 0
      ? `${visible.length} oubli${visible.length > 1 ? 's' : ''} détecté${visible.length > 1 ? 's' : ''}`
      : 'Aucun oubli 🎉';

    if (visible.length === 0) {
      list.innerHTML = '<div class="oublis-empty">Aucun oubli détecté 🎉</div>';
      if (nav) nav.style.display = 'none';
      return;
    }

    if (nav) nav.style.display = 'flex';
    _updateNav();

    list.innerHTML = visible.map((r, visIdx) => {
      const occ = r.occurrences[r.current];
      const occNav = r.occurrences.length > 1
        ? `<span class="oubli-occ-nav">
            <button onclick="OublisPanel._occNav('${r.id}',-1)">↑</button>
            <span>${r.current + 1}/${r.occurrences.length}</span>
            <button onclick="OublisPanel._occNav('${r.id}',1)">↓</button>
           </span>` : '';

      const typeOpts = getAllTypes().map(t =>
        `<option value="${t.id}" ${t.id === r.type ? 'selected' : ''}>${t.label}</option>`
      ).join('');

      const realIdx = _results.findIndex(x => x.id === r.id);
      const isActive = realIdx === _current;

      return `<div class="oubli-card ${isActive ? 'oubli-card--active' : ''} ${r.added ? 'oubli-card--done' : ''}" id="oubliCard_${r.id}" onclick="OublisPanel._select('${r.id}')">
        <div class="oubli-card-top">
          <span class="oubli-value">${escHtml(r.value)}</span>
          ${occNav}
          <button class="oubli-ignore-btn" onclick="event.stopPropagation();OublisPanel._ignore('${r.id}')" title="Ignorer définitivement">⊘</button>
        </div>
        <div class="oubli-ctx">${occ.ctx}</div>
        <div class="oubli-actions">
          <select class="oubli-type-select" id="oubliType_${r.id}" onclick="event.stopPropagation()">
            ${typeOpts}
          </select>
          <button class="oubli-add-btn ${r.parentEntity ? 'oubli-add-btn--alias' : ''}"
            onclick="event.stopPropagation();OublisPanel._add('${r.id}')" ${r.added ? 'disabled' : ''}>
            ${r.added ? '✓ Fait' : r.parentEntity ? `+ Alias de ${escHtml(r.parentEntity)}` : '+ Entité'}
          </button>
          <button class="oubli-caviar-btn" onclick="event.stopPropagation();OublisPanel._caviar('${r.id}')">✂</button>
        </div>
      </div>`;
    }).join('');
  }

  function _renderEmpty(msg) {
    const list = document.getElementById('oublisList');
    if (list) list.innerHTML = `<div class="oublis-empty">${msg}</div>`;
    const count = document.getElementById('oublisPanelCount');
    if (count) count.textContent = '—';
  }

  function _updateNav() {
    const visible = _results.filter(r => !r.ignored);
    const visIdx  = visible.findIndex(r => r.id === (_results[_current]?.id));
    const pos = document.getElementById('oublisNavPos');
    if (pos) pos.textContent = visible.length > 0
      ? `${Math.max(1, visIdx + 1)} / ${visible.length}` : '0 / 0';
  }

  function _updateBadge() {
    const badge = document.getElementById('oublisBadge');
    const n = _results.filter(r => !r.ignored && !r.added).length;
    if (!badge) return;
    badge.textContent = n;
    badge.style.display = n > 0 ? 'inline-block' : 'none';
    // Colorer le bouton Vérifier si des oublis
    const btn = document.getElementById('lptBtnVerify');
    if (btn) btn.classList.toggle('alert', n > 0);
  }

  // ── Localiser dans le viewer ──────────────────────────────────────────────
  function _localize(idx) {
    const r = _results[idx];
    if (!r) return;
    const occ = r.occurrences[r.current];
    if (!occ) return;

    // Trouver la ligne dans le texte
    const text = State.processedText || State.rawText || '';
    const linesBefore = text.slice(0, occ.index).split('\n');
    const lineIdx = linesBefore.length - 1;

    ViewerState.lbTargetLine   = lineIdx;
    ViewerState.oublisHighlight = r.value;
    if (State.currentStep === 3) refreshEntityViewer(); else refreshViewer();

    // Scroll vers la ligne
    setTimeout(() => {
      const viewer = document.getElementById('textViewer');
      const span = viewer?.querySelector(`span[data-line="${lineIdx + 1}"]`);
      if (span) span.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  function _select(id) {
    const idx = _results.findIndex(r => r.id === id);
    if (idx < 0) return;
    _current = idx;
    _localize(idx);
    _render();
  }

  function _occNav(id, dir) {
    const r = _results.find(r => r.id === id);
    if (!r) return;
    r.current = ((r.current + dir) % r.occurrences.length + r.occurrences.length) % r.occurrences.length;
    _localize(_results.findIndex(x => x.id === id));
    _render();
  }

  function navigate(dir) {
    const visible = _results.filter(r => !r.ignored);
    if (visible.length === 0) return;
    const curVis = visible.findIndex(r => r.id === (_results[_current]?.id));
    const next = ((curVis + dir) % visible.length + visible.length) % visible.length;
    const nextId = visible[next].id;
    _current = _results.findIndex(r => r.id === nextId);
    _localize(_current);
    _render();
    // Scroll la carte dans le panneau
    setTimeout(() => {
      const card = document.getElementById(`oubliCard_${nextId}`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  }

  function _add(id) {
    const r = _results.find(r => r.id === id);
    if (!r || r.added) return;
    const sel = document.getElementById(`oubliType_${id}`);
    const type = sel ? sel.value : r.type;
    const valLower = r.value.toLowerCase();

    // Vérifier si un mot du résultat correspond à une entité existante
    // Ex: "Monsieur PANARELLI" → PANARELLI est entité → ajouter "Monsieur PANARELLI" comme alias
    const words = valLower.split(/\s+/).filter(w => w.length >= 3);
    const parentEntity = State.entities.find(e =>
      !e.blocked && e.active &&
      words.some(w => w === e.value.toLowerCase())
    );

    if (parentEntity) {
      // Ajouter comme alias de l'entité parente
      if (!parentEntity.aliases) parentEntity.aliases = [];
      if (!parentEntity.aliases.some(a => a.toLowerCase() === r.value.toLowerCase())) {
        parentEntity.aliases.push(r.value);
        renderEntityTable(State.entities);
        refreshEntityViewer();
        showToast(`"${r.value}" ajouté comme alias de "${parentEntity.value}"`);
      } else {
        showToast(`"${r.value}" est déjà alias de "${parentEntity.value}"`);
      }
    } else if (State.entities.some(e => e.value.toLowerCase() === valLower)) {
      showToast(`"${r.value}" est déjà dans la liste`);
    } else {
      State.entities.unshift({
        id: `op_${Date.now()}`,
        value: r.value, type, label: type,
        occurrences: 0, aliases: [],
        active: true, blocked: false, manual: true,
      });
      renderEntityTable(State.entities);
      refreshEntityViewer();
      showToast(`"${r.value}" ajouté comme ${type}`);
    }
    r.added = true;
    _updateBadge();
    _render();
  }

  function _caviar(id) {
    const r = _results.find(r => r.id === id);
    if (!r) return;
    openCaviar(r.value, r.occurrences[r.current]?.index ?? null);
  }

  function _ignore(id) {
    const r = _results.find(r => r.id === id);
    if (!r) return;
    r.ignored = true;
    if (!State.scanIgnored) State.scanIgnored = [];
    const val = r.value.toLowerCase().trim();
    if (!State.scanIgnored.includes(val)) { State.scanIgnored.push(val); autoSave(); }
    showToast(`"${r.value}" ignoré — ne sera plus reproposé`);
    // Passer au suivant automatiquement
    const visible = _results.filter(x => !x.ignored);
    if (visible.length > 0) {
      _current = _results.findIndex(x => x.id === visible[0].id);
      _localize(_current);
    } else {
      _current = -1;
    }
    _updateBadge();
    _render();
  }

  // ── Toggle panneau ────────────────────────────────────────────────────────
  function _hideAll() {
    ['leftPdfPanel','leftEntitiesPanel','leftOublisPanel'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }

  function _restorePrev() {
    const id = _leftPanelView === 'pdf' ? 'leftPdfPanel' : 'leftEntitiesPanel';
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
  }

  function toggle() {
    const panel = document.getElementById('leftOublisPanel');
    if (!panel) return;
    _active = !_active;
    if (_active) {
      _hideAll();
      panel.style.display = 'flex';
      run();
    } else {
      _hideAll();
      _restorePrev();
      ViewerState.oublisHighlight = '';
      ViewerState.lbTargetLine = -1;
      if (State.currentStep === 3) refreshEntityViewer(); else refreshViewer();
    }
    const btn = document.getElementById('lptBtnVerify');
    if (btn) btn.classList.toggle('active', _active);
  }

  function _isActive()  { return _active; }
  function _getResults() { return _results; }
  function _closeOnly() {
    if (!_active) return;
    _active = false;
    _hideAll();
    _restorePrev();
    ViewerState.oublisHighlight = '';
    ViewerState.lbTargetLine = -1;
    if (State.currentStep === 3) refreshEntityViewer(); else refreshViewer();
    const btn = document.getElementById('lptBtnVerify');
    if (btn) btn.classList.remove('active');
  }
  return { run, navigate, toggle, _add, _caviar, _ignore, _occNav, _select, _isActive, _closeOnly, _getResults };
})();

function toggleOublisPanel()  { OublisPanel.toggle(); }
function runOublisPanel()     { OublisPanel.run(); }
function oublisNavigate(dir)  { OublisPanel.navigate(dir); }

// Fonctions globales exposées pour le HTML
function openScanOublis()        { ScanOublis.open(); }
function closeScanOublis()       { ScanOublis.close(); }
function runScanOublis()         { ScanOublis.run(); }
function scanFilterCat(btn, cat) { ScanOublis.filterCat(btn, cat); }

/** Crée et insère une entité manuelle ; retourne false si valeur vide/déjà présente. */
function createManualEntity(value, type) {
  const v = (value || '').trim();
  if (!v) return false;
  if (State.entities.some(e => e.value.toLowerCase() === v.toLowerCase())) {
    showToast('Cette valeur est déjà dans la liste'); return false;
  }
  const t = type || 'NOM';
  State.entities.unshift({
    id: `man_${Date.now()}`,
    value: v, type: t, label: t,
    occurrences: 0, aliases: [],
    active: true, blocked: false, manual: true
  });
  renderEntityTable(State.entities);
  if (State.currentStep === 3) setTimeout(() => refreshEntityViewer(), 0);
  return true;
}

function addEntityManual() {
  const val = prompt('Valeur à anonymiser :');
  createManualEntity(val, 'NOM');
}

/** Ajout rapide depuis le champ visible en haut du panneau Entités (step 3). */
function addEntityQuick() {
  const input = document.getElementById('entityQuickAddInput');
  const typeSel = document.getElementById('entityQuickAddType');
  if (!input) return;
  const ok = createManualEntity(input.value, typeSel ? typeSel.value : 'NOM');
  if (ok) {
    input.value = '';
    showToast('Entité ajoutée');
  }
  input.focus();
}

/** Amène le focus sur le champ d'ajout rapide (depuis le menu Actions). */
function focusEntityQuickAdd() {
  const input = document.getElementById('entityQuickAddInput');
  if (!input) return;
  input.focus();
  input.select();
}

// ── Import entités (JSON/CSV) ─────────────────────────────────────────────────

function triggerEntityImport() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,.csv';
  input.onchange = e => handleEntityImport(e.target.files[0]);
  input.click();
}

async function handleEntityImport(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const content = e.target.result;
    let imported = [];
    if (file.name.endsWith('.json')) {
      try { imported = JSON.parse(content); } catch { alert('JSON invalide'); return; }
    } else {
      const lines = content.split('\n');
      imported = lines.slice(1).map(line => {
        const [value, type, aliases] = line.split(';');
        return { value: value?.trim(), type: type?.trim() || 'NOM',
                 aliases: aliases ? aliases.split(',').map(a => a.trim()) : [] };
      }).filter(en => en.value);
    }
    const seen = new Set(State.entities.map(e => e.value.toLowerCase()));
    let added = 0;
    imported.forEach(en => {
      if (!en.value || seen.has(en.value.toLowerCase())) return;
      // Respecter active/blocked du JSON si présents, sinon défaut true/false
      const active  = en.active  !== undefined ? en.active  : true;
      const blocked = en.blocked !== undefined ? en.blocked : false;
      // Ne pas importer les entités bloquées (dans la BL)
      if (blocked) return;
      State.entities.push({
        id: `imp_${Math.random().toString(36).substr(2,9)}`,
        value: en.value,
        type: en.type || 'NOM',
        label: en.label || en.type || 'NOM',
        occurrences: en.occurrences || 0,
        aliases: en.aliases || [],
        active, blocked: false, manual: true
      });
      seen.add(en.value.toLowerCase());
      added++;
    });
    renderEntityTable(State.entities);
    showToast(`${added} entité(s) importée(s)`);
  };
  reader.readAsText(file);
}

// ── Blacklist externe ─────────────────────────────────────────────────────────

function triggerBlacklistImport() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,.csv,.txt';
  input.onchange = e => handleBlacklistImport(e.target.files[0]);
  input.click();
}

async function handleBlacklistImport(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    const content = e.target.result;
    let words = [];
    if (file.name.endsWith('.json')) {
      try {
        const parsed = JSON.parse(content);
        words = Array.isArray(parsed) ? parsed : Object.keys(parsed);
      } catch { alert('JSON invalide'); return; }
    } else {
      // CSV ou TXT : séparateurs virgule, point-virgule, saut de ligne
      words = content.split(/[\n,;]+/).map(w => w.trim()).filter(w => w.length > 1);
    }

    Analysis.setExternalBlacklist(words);

    // Persister sur le serveur
    try {
      await Server.saveBlacklist(words);
      showToast(`Blacklist chargée : ${words.length} mots · persistée sur disque`);
    } catch {
      showToast(`Blacklist chargée en mémoire : ${words.length} mots (serveur inactif)`);
    }

    // Relancer l'analyse pour filtrer les nouvelles entrées
    if (State.entities.length > 0) runAnalysis();
  };
  reader.readAsText(file);
}

async function exportBlacklist() {
  const words = Analysis.getBlacklistWords();
  if (words.length === 0) { showToast('Blacklist vide'); return; }
  const blob = new Blob([JSON.stringify(words, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = buildFileName('blacklist', 'json'); a.click();
  URL.revokeObjectURL(url);
}

// ── Toast notification ────────────────────────────────────────────────────────

function showToast(msg, duration = 3000) {
  let toast = document.getElementById('appToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'appToast';
    toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
      'background:var(--ink1,#1a1a2e);color:#fff;padding:10px 20px;border-radius:8px;' +
      'font-size:13px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.3);transition:opacity .3s';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.style.opacity = '0'; }, duration);
}

// ── Helpers HTML ──────────────────────────────────────────────────────────────

/** Timestamp local formaté pour les noms de fichiers : 2025-06-15_11h42 */
function localTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}h${pad(d.getMinutes())}`;
}

// ── Référence dossier ─────────────────────────────────────────────────────────
function getDossierPrefix() {
  try { return localStorage.getItem('dossierPrefix') || ''; } catch { return ''; }
}

function saveDossierPrefix(val) {
  val = val.trim();
  try { localStorage.setItem('dossierPrefix', val); } catch {}
  const badge = document.getElementById('dossierBadge');
  const label = document.getElementById('dossierBadgeLabel');
  if (badge && label) {
    label.textContent = val;
    badge.style.display = val ? 'inline-flex' : 'none';
  }
}

function buildFileName(suffix, ext) {
  const prefix = getDossierPrefix();
  const ts = localTimestamp();
  return prefix ? `${prefix}_${suffix}_${ts}.${ext}` : `${suffix}_${ts}.${ext}`;
}

function openSettingsAndFocusDossier() {
  const panel = document.getElementById('settingsPanel');
  if (panel && panel.style.display === 'none') panel.style.display = 'block';
  const input = document.getElementById('dossierPrefix');
  if (input) { input.focus(); input.select(); }
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── STEP 4 : Anonymisation & Résultats ────────────────────────────────────────

function runAnonymization() {
  const text = _applyCaviardages(State.processedText || State.rawText || '');
  if (!text) { alert('Aucun texte à anonymiser.'); return; }
  if (!State.entities.length) { alert('Aucune entité définie.'); return; }
  _checkOublisBeforeAnon(() => {
    const result = Anonymizer.run(text, State.entities);
    State.result = result;
    _exportDone = false;
    unlockStep(4);
    renderResults();
    goToStep(4);
    setTimeout(_updateExportBanner, 50);
  });
}

function _checkOublisBeforeAnon(onConfirm) {
  // Réutiliser le moteur OublisPanel pour éviter la duplication de logique
  // et garantir la cohérence avec le panneau Vérifier
  OublisPanel.run();  // scan silencieux
  const suspects = OublisPanel._getResults().filter(r => !r.ignored && !r.added);

  if (suspects.length === 0) { onConfirm(); return; }

  const overlay = document.getElementById('anonCheckOverlay');
  const list    = document.getElementById('anonCheckList');
  if (!overlay || !list) { onConfirm(); return; }

  list.innerHTML = suspects.slice(0, 8).map(r =>
    `<li><span class="anon-check-item">${escHtml(r.value)}</span></li>`
  ).join('') + (suspects.length > 8 ? `<li class="anon-check-more">…et ${suspects.length - 8} autre(s)</li>` : '');
  document.getElementById('anonCheckCount').textContent = suspects.length;
  overlay.style.display = 'flex';
  document.getElementById('anonCheckContinue').onclick = () => {
    overlay.style.display = 'none';
    onConfirm();
  };
  document.getElementById('anonCheckCorrect').onclick = () => {
    overlay.style.display = 'none';
    // Ouvrir le panneau oublis directement (déjà scanné)
    if (!OublisPanel._isActive || !OublisPanel._isActive()) OublisPanel.toggle();
    else OublisPanel._render && OublisPanel._render();
  };
}

function renderResults() {
  if (!State.result) return;
  const { anonymized, concordance } = State.result;

  // Onglet document
  document.getElementById('resultDoc').innerHTML = Anonymizer.highlight(anonymized);

  // Onglet concordance
  document.getElementById('concBadge').textContent = concordance.length;
  document.getElementById('concTbody').innerHTML = concordance.map(r => `
    <tr>
      <td><code>${escHtml(r.placeholder)}</code></td>
      <td>${escHtml(r.value)}</td>
      <td>${(r.aliases||[]).map(a => `<span class="alias-tag">${escHtml(a)}</span>`).join(' ')}</td>
      <td><span class="type-badge type-${r.type}">${escHtml(r.label||r.type)}</span></td>
    </tr>`).join('');
}

function switchResultTab(tab, btn) {
  document.querySelectorAll('.rtab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.result-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(`rp-${tab}`).classList.add('active');
}

function exportTxt() {
  if (!State.result) return;
  const blob = new Blob([State.result.anonymized], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, buildFileName('document_anonymise', 'txt'));
}

function copyResult() {
  if (!State.result) return;
  navigator.clipboard.writeText(State.result.anonymized)
    .then(() => showToast('Texte copié dans le presse-papiers'))
    .catch(() => showToast('Échec de la copie'));
}

function exportCsv() {
  if (!State.result) return;
  const blob = new Blob([Anonymizer.toCsv(State.result.concordance)],
    { type: 'text/csv;charset=utf-8' });
  triggerDownload(blob, buildFileName('concordance', 'csv'));
}

function exportJson() {
  if (!State.result) return;
  const blob = new Blob([JSON.stringify(State.result.concordance, null, 2)],
    { type: 'application/json' });
  triggerDownload(blob, buildFileName('concordance', 'json'));
}

/** Exporte tout en une fois : .txt + concordance CSV */
async function exportTout() {
  if (!State.result) { showToast('Aucun résultat à exporter'); return; }

  const now      = localTimestamp();
  const _pfx     = getDossierPrefix();
  const baseName = _pfx ? `${_pfx}_anonymise_${now}` : `anonymise_${now}`;

  // ── Construire le ZIP ────────────────────────────────────────────────────
  const zip = new JSZip();
  zip.file(`${baseName}.txt`,           State.result.anonymized);
  zip.file(`${baseName}_table.csv`,     Anonymizer.toCsv(State.result.concordance));
  // Inclure le texte original pour permettre de recharger la session sans repasser par l'import
  if (State.originalText || State.rawText) {
    zip.file(`${baseName}_original.txt`, State.originalText || State.rawText);
  }
  // Inclure la session complète pour reprise facile
  zip.file(`${baseName}_session.json`,  JSON.stringify(buildSessionData(), null, 2));

  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });

  // ── Sauvegarder via showSaveFilePicker (boîte de dialogue unique) ────────
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: `${baseName}.zip`,
        types: [{ description: 'Archive ZIP', accept: { 'application/zip': ['.zip'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(zipBlob);
      await writable.close();
      _exportDone = true;
      _updateExportBanner();
      showToast(`✓ ZIP sauvegardé : ${handle.name}`);
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // annulé par l'utilisateur
      // Erreur inattendue → fallback
    }
  }

  // ── Fallback : téléchargement automatique dans Downloads ────────────────
  _dlSilent(zipBlob, `${baseName}.zip`);
  _exportDone = true;
  _updateExportBanner();
  showToast(`✓ ${baseName}.zip téléchargé`);
}

/** Téléchargement silencieux (lien <a>) sans boîte de dialogue */
function _dlSilent(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Suivi de l'export pour le rappel visuel
let _exportDone = false;

function _updateExportBanner() {
  const banner = document.getElementById('exportRappelBanner');
  if (!banner) return;
  if (_exportDone) {
    banner.style.display = 'none';
  } else if (State.result) {
    banner.style.display = 'flex';
  }
}



function triggerDownload(blob, filename) {
  // Utiliser showSaveFilePicker si disponible (Chrome/Edge), sinon fallback
  if (window.showSaveFilePicker) {
    const ext = filename.split('.').pop().toLowerCase();
    const typeMap = {
      txt:  [{ description: 'Fichier texte', accept: { 'text/plain': ['.txt'] } }],
      csv:  [{ description: 'Fichier CSV',   accept: { 'text/csv':   ['.csv'] } }],
      json: [{ description: 'Fichier JSON',  accept: { 'application/json': ['.json'] } }],
    };
    window.showSaveFilePicker({
      suggestedName: filename,
      types: typeMap[ext] || [{ description: 'Fichier', accept: { 'application/octet-stream': ['.' + ext] } }],
    }).then(async handle => {
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      showToast(`Sauvegardé : ${handle.name}`);
    }).catch(err => {
      // Annulé par l'utilisateur ou non supporté → fallback silencieux
      if (err.name !== 'AbortError') {
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
      }
    });
  } else {
    // Fallback navigateurs sans showSaveFilePicker (Firefox, Safari)
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }
}

// ── Fonctions viewer hint (étape 2) ───────────────────────────────────────────

function prefillOcr() {
  sendToOcr();
}

function addSelectedToEntities() {
  sendToEntities();
}

// ── Modal Alias ───────────────────────────────────────────────────────────────

let _aliasTargetId = null;

function promptAddAlias(id) {
  _aliasTargetId = id;
  const ent = State.entities.find(e => e.id === id);
  if (!ent) return;
  document.getElementById('aliasEntityName').textContent = ent.value;
  renderAliasList(ent);
  document.getElementById('aliasModal').style.display = 'flex';
  document.getElementById('aliasInput').value = '';
  document.getElementById('aliasInput').focus();
}

function renderAliasList(ent) {
  const list = document.getElementById('aliasList');
  const aliases = ent.aliases || [];
  if (aliases.length === 0) {
    list.innerHTML = '<div style="color:var(--ink3);font-size:12px">Aucun alias.</div>';
    return;
  }
  list.innerHTML = aliases.map(a => `
    <div class="alias-row">
      <span class="alias-tag">${escHtml(a)}</span>
      <button class="alias-del" onclick="removeAlias('${escAttr(ent.id)}','${escAttr(a)}'); renderAliasList(State.entities.find(e=>e.id==='${escAttr(ent.id)}'))">✕</button>
    </div>`).join('');
}

function addAlias() {
  const input = document.getElementById('aliasInput');
  const val = input.value.trim();
  if (!val || !_aliasTargetId) return;
  const ent = State.entities.find(e => e.id === _aliasTargetId);
  if (!ent) return;
  if (!ent.aliases) ent.aliases = [];
  if (!ent.aliases.includes(val)) {
    ent.aliases.push(val);
    renderAliasList(ent);
    renderEntityTable(State.entities);
  }
  input.value = '';
  input.focus();
}

function closeAliasModal(e) {
  if (e && e.target !== document.getElementById('aliasModal')) return;
  document.getElementById('aliasModal').style.display = 'none';
  _aliasTargetId = null;
}

// ── Changement de type d'une entité ──────────────────────────────────────────

function changeEntityType(id, newType) {
  const ent = State.entities.find(e => e.id === id);
  if (!ent) return;
  ent.type  = newType;
  ent.label = getTypeLabel(newType);
  renderEntityTable(State.entities);
}

// ── Gestionnaire blacklist (panneau paramètres) ───────────────────────────────

function openBlacklistManager() {
  renderBlacklistManager();
  document.getElementById('blacklistManager').style.display = 'block';
  document.getElementById('settingsPanel').style.display = 'none';
}

function closeBlacklistManager() {
  document.getElementById('blacklistManager').style.display = 'none';
}

function renderBlacklistManager() {
  const words = Analysis.getBlacklistWords().sort();
  const list  = document.getElementById('blManagerList');

  if (words.length === 0) {
    list.innerHTML = '<div class="bl-empty">Blacklist vide — aucun mot exclu.</div>';
    return;
  }
  list.innerHTML = words.map(w => `
    <div class="bl-row">
      <span class="bl-word">${escHtml(w)}</span>
      <button class="bl-del" onclick="removeFromBlacklist('${escAttr(w)}')" title="Retirer">✕</button>
    </div>`).join('');

  document.getElementById('blManagerCount').textContent = `${words.length} mot${words.length > 1 ? 's' : ''}`;
}

function removeFromBlacklist(word) {
  const current = Analysis.getBlacklistWords().filter(w => w !== word);
  Analysis.setExternalBlacklist(current);
  Server.saveBlacklist(current).catch(() => {});
  renderBlacklistManager();
  showToast(`"${word}" retiré de la blacklist`);
}

function addToBlacklistFromManager() {
  const input = document.getElementById('blManagerInput');
  const raw   = input.value.trim();
  if (!raw) return;
  const words = raw.split(/[\n,;]+/).map(w => w.trim()).filter(w => w.length > 0);
  const current = Analysis.getBlacklistWords();
  Analysis.setExternalBlacklist([...current, ...words]);
  Server.saveBlacklist(Analysis.getBlacklistWords()).catch(() => {});
  input.value = '';
  renderBlacklistManager();
  showToast(`${words.length} mot(s) ajouté(s) à la blacklist`);
}

function clearBlacklist() {
  if (!confirm('Vider entièrement la blacklist ?')) return;
  Analysis.setExternalBlacklist([]);
  Server.saveBlacklist([]).catch(() => {});
  renderBlacklistManager();
  showToast('Blacklist vidée');
}

// ── Gestionnaire types personnalisés ─────────────────────────────────────────

async function openTypeManager() {
  try {
    const serverTypes = await Server.loadCustomTypes();
    if (serverTypes.length > 0) {
      State.customTypes = serverTypes;
      localStorage.setItem('customTypes', JSON.stringify(serverTypes));
    } else {
      // Fallback cache local si le serveur est vide
      const saved = localStorage.getItem('customTypes');
      if (saved) {
        try { State.customTypes = JSON.parse(saved); } catch {}
        if (State.customTypes.length > 0) Server.saveCustomTypes(State.customTypes).catch(() => {});
      }
    }
  } catch {}
  renderTypeManager();
  document.getElementById('typeManager').style.display = 'block';
  document.getElementById('settingsPanel').style.display = 'none';
}

function closeTypeManager() {
  document.getElementById('typeManager').style.display = 'none';
}

function renderTypeManager() {
  const list = document.getElementById('typeManagerList');
  if (State.customTypes.length === 0) {
    list.innerHTML = '<div class="bl-empty">Aucun type personnalisé.</div>';
  } else {
    list.innerHTML = State.customTypes.map(t => `
      <div class="bl-row">
        <span class="type-badge type-CUSTOM">${escHtml(t.label)}</span>
        <span class="bl-word-sm" style="color:var(--ink3);font-family:var(--mono);font-size:10px">${escHtml(t.id)}</span>
        <button class="bl-del" onclick="removeCustomType('${escAttr(t.id)}')" title="Supprimer">✕</button>
      </div>`).join('');
  }
  // Mettre à jour aussi les selects du filtre
  updateTypeFilter();
}

function addCustomType() {
  const labelInput = document.getElementById('typeManagerInput');
  const label = labelInput.value.trim();
  if (!label) return;
  // Générer un id : majuscules, sans accents, sans espaces
  const id = label.toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]/g, '_')
    .replace(/_+/g, '_').replace(/^_|_$/g, '');

  if (!id) { showToast('Nom de type invalide'); return; }
  if (getAllTypes().some(t => t.id === id)) {
    showToast(`Le type "${id}" existe déjà`); return;
  }

  State.customTypes.push({ id, label });
  localStorage.setItem('customTypes', JSON.stringify(State.customTypes));
  Server.saveCustomTypes(State.customTypes).catch(() => {});
  labelInput.value = '';
  renderTypeManager();
  // Rafraîchir le tableau entités pour que les dropdowns incluent le nouveau type
  if (State.entities.length > 0) renderEntityTable(State.entities);
  showToast(`Type "${label}" créé`);
}

function removeCustomType(id) {
  State.customTypes = State.customTypes.filter(t => t.id !== id);
  localStorage.setItem('customTypes', JSON.stringify(State.customTypes));
  Server.saveCustomTypes(State.customTypes).catch(() => {});
  // Remettre les entités de ce type en NOM
  State.entities.forEach(e => { if (e.type === id) { e.type = 'NOM'; e.label = 'Nom & Prénom'; } });
  renderTypeManager();
  renderEntityTable(State.entities);
  showToast(`Type supprimé`);
}

function updateTypeFilter() {
  const sel = document.getElementById('typeFilter');
  if (!sel) return;
  const current = sel.value;
  const types = getAllTypes();
  sel.innerHTML = '<option value="">Tous les types</option>' +
    types.map(t => `<option value="${escAttr(t.id)}" ${current === t.id ? 'selected' : ''}>${escHtml(t.label)}</option>`).join('');
}

// ── Mode édition du visualiseur ───────────────────────────────────────────────





// ── Resize horizontal du viewer ───────────────────────────────────────────────

(function initViewerResize() {
  document.addEventListener('DOMContentLoaded', () => {
    const viewerCol = document.querySelector('.ocr-viewer-col');
    if (!viewerCol) return;

    // Appliquer le resize CSS natif
    viewerCol.style.resize    = 'horizontal';
    viewerCol.style.overflow  = 'hidden';
    viewerCol.style.minWidth  = '320px';
    viewerCol.style.maxWidth  = '85vw';

    // Persister la largeur entre rechargements
    const saved = localStorage.getItem('viewerWidth');
    if (saved) viewerCol.style.width = saved;

    // Observer les changements de taille via ResizeObserver
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        localStorage.setItem('viewerWidth', entry.contentRect.width + 'px');
      }
    });
    ro.observe(viewerCol);
  });
})();

// ── Export entités ────────────────────────────────────────────────────────────

function toggleExportMenu() {
  const menu = document.getElementById('exportEntitiesMenu');
  if (!menu) return;
  const isOpen = menu.style.display !== 'none';
  menu.style.display = isOpen ? 'none' : 'block';
  // Fermer si clic ailleurs
  if (!isOpen) {
    setTimeout(() => {
      document.addEventListener('click', function closeMenu(e) {
        if (!document.getElementById('exportEntitiesDropdown')?.contains(e.target)) {
          menu.style.display = 'none';
          document.removeEventListener('click', closeMenu);
        }
      });
    }, 0);
  }
}

function exportEntitiesJson() {
  if (!State.entities.length) { showToast('Aucune entité à exporter'); return; }
  const data = State.entities.map(e => ({
    value:   e.value,
    type:    e.type,
    label:   e.label,
    aliases: e.aliases || [],
    active:  e.active,
    blocked: e.blocked,
  }));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  triggerDownload(blob, buildFileName('entites', 'json'));
  document.getElementById('exportEntitiesMenu').style.display = 'none';
  showToast(`${data.length} entité(s) exportée(s) en JSON`);
}

function exportEntitiesCsv() {
  if (!State.entities.length) { showToast('Aucune entité à exporter'); return; }
  const rows = [
    'Valeur;Type;Alias;Actif;Bloqué',
    ...State.entities.map(e => [
      csvEsc(e.value),
      csvEsc(e.type),
      csvEsc((e.aliases || []).join(' | ')),
      e.active  ? 'oui' : 'non',
      e.blocked ? 'oui' : 'non',
    ].join(';'))
  ];
  const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  triggerDownload(blob, buildFileName('entites', 'csv'));
  document.getElementById('exportEntitiesMenu').style.display = 'none';
  showToast(`${State.entities.length} entité(s) exportée(s) en CSV`);
}

function csvEsc(s) {
  if (!s) return '';
  s = String(s);
  if (s.includes(';') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ── Import concordance (table d'anonymisation) → fusion avec entités ──────────

function triggerConcordanceImport() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,.csv';
  input.onchange = e => handleConcordanceImport(e.target.files[0]);
  input.click();
}

async function handleConcordanceImport(file) {
  if (!file) return;
  const content = await file.text();
  let rows = [];

  try {
    if (file.name.endsWith('.json')) {
      // Format JSON : tableau de { placeholder, value, aliases, type, label }
      // ou tableau de { value, type, aliases } (format export entités)
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) { showToast('JSON invalide : tableau attendu'); return; }
      rows = parsed;
    } else {
      // Format CSV : Placeholder;Valeur originale;Alias;Type
      const lines = content.split('\n').filter(l => l.trim());
      const header = lines[0].toLowerCase();
      const hasPlaceholder = header.includes('placeholder');
      rows = lines.slice(1).map(line => {
        const parts = line.split(';').map(p => p.trim().replace(/^"|"$/g, ''));
        if (hasPlaceholder) {
          // Format concordance : Placeholder;Valeur;Alias;Type
          const [placeholder, value, aliasStr, type] = parts;
          return { placeholder, value, aliases: aliasStr ? aliasStr.split('|').map(a => a.trim()).filter(Boolean) : [], type: type || 'NOM' };
        } else {
          // Format entités : Valeur;Type;Alias;Actif;Bloqué
          const [value, type, aliasStr] = parts;
          return { value, type: type || 'NOM', aliases: aliasStr ? aliasStr.split('|').map(a => a.trim()).filter(Boolean) : [] };
        }
      }).filter(r => r.value && r.value.trim());
    }
  } catch (e) {
    showToast('Erreur de lecture du fichier : ' + e.message);
    return;
  }

  if (!rows.length) { showToast('Aucune entrée valide dans le fichier'); return; }

  // Fusion : on n'ajoute que les valeurs absentes de la liste d'entités
  const existing = new Set(State.entities.map(e => e.value.toLowerCase().trim()));
  let added = 0, merged = 0;

  for (const row of rows) {
    const val = (row.value || '').trim();
    if (!val) continue;

    if (existing.has(val.toLowerCase())) {
      // Entité déjà présente → fusionner les alias uniquement
      const ent = State.entities.find(e => e.value.toLowerCase() === val.toLowerCase());
      if (ent && row.aliases?.length) {
        const existingAliases = new Set((ent.aliases || []).map(a => a.toLowerCase()));
        for (const alias of row.aliases) {
          if (alias && !existingAliases.has(alias.toLowerCase())) {
            ent.aliases = [...(ent.aliases || []), alias];
            existingAliases.add(alias.toLowerCase());
          }
        }
        merged++;
      }
    } else {
      State.entities.push({
        id:          `conc_${Date.now()}_${Math.random().toString(36).substr(2,6)}`,
        value:       val,
        type:        row.type || 'NOM',
        label:       row.label || row.type || 'NOM',
        occurrences: 0,
        aliases:     row.aliases || [],
        active:      true,
        blocked:     false,
        manual:      true,
      });
      existing.add(val.toLowerCase());
      added++;
    }
  }

  renderEntityTable(State.entities);
  if (State.currentStep === 3) setTimeout(() => refreshEntityViewer(), 0);
  showToast(`Table importée : ${added} entité(s) ajoutée(s), ${merged} fusionnée(s)`);
  scheduleAutoSave();
}



// ── Step 2 : Sauvegarde TXT ───────────────────────────────────────────────────

function saveStep2Txt() {
  const text = State.processedText || State.rawText;
  if (!text) { showToast('Aucun texte à sauvegarder'); return; }

  const name = buildFileName('texte_ocr', 'txt');

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, name);
  showToast(`Sauvegardé : ${name}`);
}

// ── Step 2 : Import entités ────────────────────────────────────────────────────
// Même logique que handleEntityImport (étape 3) mais accessible depuis l'étape 2

function triggerStep2EntitiesImport() {
  document.getElementById('step2EntitiesInput').click();
}

function handleStep2EntitiesImport(event) {
  const file = event.target.files[0];
  if (!file) return;
  // Réinitialiser l'input pour permettre de réimporter le même fichier
  event.target.value = '';

  const reader = new FileReader();
  reader.onload = (e) => {
    const content = e.target.result;
    let imported  = [];

    if (file.name.endsWith('.json')) {
      try { imported = JSON.parse(content); }
      catch { showToast('❌ JSON invalide'); return; }
    } else {
      // CSV : Valeur;Type;Aliases (même format que l\'export)
      const lines = content.split('\n');
      const start = lines[0].toLowerCase().includes('valeur') ? 1 : 0; // sauter entête
      imported = lines.slice(start).map(line => {
        const [value, type, aliases] = line.split(';');
        return {
          value:   value?.trim().replace(/^"|"$/g, ''),
          type:    type?.trim()  || 'NOM',
          aliases: aliases ? aliases.replace(/^"|"$/g, '').split(' | ').map(a => a.trim()).filter(Boolean) : [],
        };
      }).filter(en => en.value);
    }

    const seen  = new Set(State.entities.map(e => e.value.toLowerCase()));
    let added   = 0;
    imported.forEach(en => {
      if (!seen.has(en.value.toLowerCase())) {
        State.entities.push({
          id:          `imp_${Math.random().toString(36).substr(2, 9)}`,
          value:       en.value,
          type:        en.type,
          label:       getTypeLabel(en.type),
          occurrences: 0,
          aliases:     en.aliases || [],
          active:      true,
          blocked:     false,
          manual:      true,
        });
        seen.add(en.value.toLowerCase());
        added++;
      }
    });

    showToast(`${added} entité(s) importée(s) — disponibles à l\'étape 3`);
  };
  reader.readAsText(file, 'UTF-8');
}

// ── Step 1 : reprise d'un TXT sauvegardé depuis step 2 ────────────────────────
// Pas de code supplémentaire nécessaire : loadFile() accepte déjà les .txt
// Le fichier sauvegardé contient le texte corrigé → State.rawText = texte corrigé
// L'utilisateur repart de l'étape 2 avec son texte en cours

// ── Gestion des sauts de ligne suspects ───────────────────────────────────────

const LB = {
  suspects:   [],        // indices de lignes suspectes dans le texte
  current:    -1,        // index courant dans suspects[]
  ignored:    new Set(), // indices ignorés manuellement
  active:     false,     // true = mode sauts actif
  _breakInfo: {},        // { lineIdx: skipCount } — nb lignes à fusionner
};

/**
 * Un saut de ligne est "suspect" si :
 * - La ligne ne se termine pas par . ? ! : ; ) » " … —
 * - La ligne suivante ne commence pas par une majuscule isolée (début de phrase)
 *   OU commence par une minuscule
 * - Ni l'une ni l'autre n'est vide
 */
/**
 * Retourne le type de saut suspect entre deux lignes consécutives :
 *   'direct'  — lineA coupe directement sur lineB (pas de ponctuation finale)
 *   'empty'   — lineA, ligne vide, lineB (phrase coupée par une ligne vide)
 *   false     — pas suspect
 *
 * Appelée avec (lineA, lineB) pour le cas direct,
 * ou (lineA, lineB, lineC) pour le cas avec ligne vide intercalée.
 */
// Teste si une ligne se termine par une lettre/chiffre (y compris accentuées)
const RE_ENDS_WORD = /[a-zA-Z0-9À-ÖØ-öø-ÿ]\s*$/;
// Teste si une ligne commence par une minuscule (y compris accentuées)
const RE_STARTS_LOWER = /^[a-zàâäéèêëîïôùûüçœæ]/;

// Tiret de césure : lettre suivie d'un tiret en fin de ligne (ex: "Aix-en-", "pro-")
const RE_ENDS_HYPHEN = /[a-zA-ZÀ-ÖØ-öø-ÿ]-\s*$/;

// Titres de civilité en fin de ligne → toujours suspect (le nom suit sur la ligne d'après)
const RE_ENDS_CIVILITE = /\b(?:Monsieur|Madame|Mademoiselle|Maître|Maitre|Docteur|Professeur|M\.|Mme\.?|Me\.?|Dr\.?|Pr\.?)\s*$/i;

function isSuspectBreak(lineA, lineB, lineC) {
  // Cas 3 lignes : lineA → "" → lineC (compatibilité)
  if (lineC !== undefined) {
    if (lineA.trim() === '' || lineB.trim() !== '' || lineC.trim() === '') return false;
    if (RE_ENDS_HYPHEN.test(lineA)) return true;
    if (RE_ENDS_CIVILITE.test(lineA)) return true;  // "Monsieur" → nom sur ligne suivante
    const endPunct = /[.?!:;)»"…—\]]\s*$/.test(lineA);
    if (endPunct) return false;
    const nextLower = RE_STARTS_LOWER.test(lineC.trim());
    return nextLower || RE_ENDS_WORD.test(lineA.trim());
  }

  // Cas 2 lignes : lineA → lineB direct
  if (!lineA.trim() || !lineB.trim()) return false;
  if (RE_ENDS_HYPHEN.test(lineA)) return true;
  if (RE_ENDS_CIVILITE.test(lineA)) return true;  // "Monsieur" → nom sur ligne suivante
  const endPunct = /[.?!:;)»"…—\]]\s*$/.test(lineA);
  if (endPunct) return false;
  const nextStartsLower = RE_STARTS_LOWER.test(lineB.trim());
  return nextStartsLower || RE_ENDS_WORD.test(lineA.trim());
}

/**
 * Détecte tous les sauts suspects dans un tableau de lignes.
 * Gère N lignes vides intercalées (pas seulement 1).
 * Retourne un tableau de { lineIdx, skipCount } :
 *   lineIdx  = index de lineA (la ligne à fusionner)
 *   skipCount = nombre de lignes à supprimer (lineA + vides + lineB)
 */
function findSuspectBreaks(lines) {
  const suspects = [];
  let i = 0;
  while (i < lines.length - 1) {
    const lineA = lines[i];
    if (!lineA.trim()) { i++; continue; }

    // Cas direct : lineA → lineB (pas de ligne vide)
    if (lines[i + 1].trim() !== '') {
      if (isSuspectBreak(lineA, lines[i + 1])) {
        suspects.push({ lineIdx: i, skipCount: 2 });
        // Ne pas sauter lineB (i+1) : elle peut elle-même être une lineA suspecte
        // Ex: "...VALOIS est" / "en" / "droit de réclamer" → deux sauts consécutifs
        i += 1;
        continue;
      }
      i++;
      continue;
    }

    // Lignes vides intercalées : compter combien
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;

    // j pointe sur la première ligne non vide après les vides
    if (j < lines.length) {
      const lineB = lines[j];
      // Vérifier si c'est un saut suspect (utiliser isSuspectBreak 2 lignes)
      if (isSuspectBreak(lineA, lineB)) {
        suspects.push({ lineIdx: i, skipCount: j - i + 1 }); // lineA + vides + lineB
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return suspects;
}

/**
 * Gère l'exclusivité controlbar / lbNav / spNav.
 * mode: 'ctrl' | 'lb' | 'sp'
 * Toutes les barres ont la même hauteur → zéro décalage vertical.
 */
function _setNavBar(mode) {
  const ctrl  = document.getElementById('ocrControlbar');
  const lbNav = document.getElementById('lbNav');
  const spNav = document.getElementById('spNav');
  if (ctrl)  ctrl.style.display  = mode === 'ctrl' ? 'flex'  : 'none';
  if (lbNav) lbNav.style.display = mode === 'lb'   ? 'flex'  : 'none';
  if (spNav) spNav.style.display = mode === 'sp'   ? 'flex'  : 'none';
  // RR n'a plus de nav bar propre : il utilise la search-box viewer (rrReplaceRow)
}

function detectSuspectBreaks(fromLine = 0) {
  const text = State.processedText || State.rawText;
  if (!text) { showToast('Aucun texte à analyser'); return; }

  // Si déjà des suspects mémorisés (quit puis re-clic) → reprendre sans re-scanner
  if (!LB.active && LB.suspects.length > 0) {
    const stillActive = LB.suspects.filter(i => !LB.ignored.has(i));
    if (stillActive.length > 0) {
      LB.active = true;
      _setNavBar('lb');
      refreshViewer();
      lbRenderCurrent();
      showToast(`Reprise — ${stillActive.length} saut${stillActive.length > 1 ? 's' : ''} restant${stillActive.length > 1 ? 's' : ''}`);
      return;
    }
  }

  const lines = text.split('\n');
  LB.suspects = [];
  LB.ignored  = new Set();

  // Utiliser findSuspectBreaks qui gère N lignes vides intercalées
  const allBreaks = findSuspectBreaks(lines);
  // Filtrer selon fromLine (0 = tout, >0 = depuis cette ligne)
  const breaks = fromLine > 0 ? allBreaks.filter(b => b.lineIdx >= fromLine) : allBreaks;
  LB._fromLine = fromLine; // mémorisé pour affichage
  for (const b of breaks) {
    LB.suspects.push(b.lineIdx);
    LB._breakInfo = LB._breakInfo || {};
    LB._breakInfo[b.lineIdx] = b.skipCount;
  }

  // ── Lignes 🔴 gibberish OCR Abby (détectées au chargement) ──────────
  if (State.ocrLinesMeta) {
    LB._breakInfo = LB._breakInfo || {};
    State.ocrLinesMeta
      .filter(l => l.isGibberish && !LB.suspects.includes(l.index))
      .forEach(l => {
        LB.suspects.push(l.index);
        LB._breakInfo[l.index] = 1;   // ligne seule, pas de fusion
      });
    LB.suspects.sort((a, b) => a - b);
  }

  const count = LB.suspects.length;
  document.getElementById('lbSuspectCount').textContent = `${count} suspect${count > 1 ? 's' : ''}`;

  if (count === 0) {
    showToast('Aucun saut de ligne suspect détecté');
    _setNavBar('ctrl');
    return;
  }

  LB.current = 0;
  LB.active  = true;
  // Fermer le mode espaces si actif (toggle exclusif)
  if (SP.active) { SP.active = false; SP.suspects = []; SP.current = -1; SP.ignored = new Set(); }
  ViewerState.spHighlight = '';
  refreshViewer();
  _setNavBar('lb');
  lbRenderCurrent();
  const fromMsg = (fromLine > 0) ? ` (depuis ligne ${fromLine + 1})` : '';
  showToast(`${count} saut${count > 1 ? 's' : ''} suspect${count > 1 ? 's' : ''} détecté${count > 1 ? 's' : ''}${fromMsg}`);
}

function detectSuspectBreaksFromHere() {
  const fromLine = getViewerTopLine();
  if (fromLine === 0) {
    // Viewer en haut → comportement identique à Détecter
    detectSuspectBreaks(0);
    return;
  }
  // Reset complet avant scan partiel
  LB.suspects = [];
  LB.ignored  = new Set();
  LB._breakInfo = {};
  detectSuspectBreaks(fromLine);
}

function detectSpacedLettersFromHere() {
  const fromLine = getViewerTopLine();
  SP.suspects = [];
  SP.current  = -1;
  SP.ignored  = new Set();
  SP._fromLine = 0;
  detectSpacedLetters(fromLine);
}

function lbRenderCurrent() {
  const text  = State.processedText || State.rawText;
  const lines = text.split('\n');
  const total = LB.suspects.filter(i => !LB.ignored.has(i)).length;

  // Recalculer l'index courant parmi les non-ignorés
  const active = LB.suspects.filter(i => !LB.ignored.has(i));
  if (active.length === 0) {
    _setNavBar('ctrl');
    LB.active = false;
    ViewerState.spHighlight  = '';
    ViewerState.lbTargetLine = -1;
    refreshViewer(); // restaure le highlight entites
    document.getElementById('lbSuspectCount').textContent = '0 suspect';
    showToast('Tous les sauts ont été traités ✓');
    return;
  }

  // S'assurer que LB.current pointe sur un actif
  if (LB.current >= active.length) LB.current = active.length - 1;
  if (LB.current < 0) LB.current = 0;

  const lineIdx = active[LB.current];
  const lineA   = lines[lineIdx]   || '';
  const lineB   = lines[lineIdx+1] || '';

  // Sécurité : si lineIdx hors bornes, ignorer
  if (lineIdx >= lines.length) {
    LB.ignored.add(lineIdx);
    lbRenderCurrent();
    return;
  }

  // Prévisualisation : montrer le contexte (fin de lineA + début de lineB)
  const preview = document.getElementById('lbPreview');
  const previewA = lineA.trim().slice(-40) || lineA.slice(-40) || '(vide)';
  const previewB = lineB.trim().slice(0, 40) || lineB.slice(0, 40) || '(vide)';
  preview.innerHTML =
    `<span class="lb-ctx">${escHtml(previewA)}</span>` +
    `<span class="lb-mark">↵</span>` +
    `<span class="lb-ctx">${escHtml(previewB)}</span>`;

  document.getElementById('lbCounter').textContent = `${LB.current + 1} / ${active.length}`;

  // Positionner le marqueur sur la ligne exacte via lbTargetLine
  // Le marqueur \uFFF9 est injecté par refreshViewer dans le texte,
  // puis rendu comme <span id="lb-target"> dans buildViewerHTML.
  ViewerState.spHighlight  = '';  // inutile en mode LB : on utilise lb-target
  ViewerState.lbTargetLine = lineIdx;
  refreshViewer();
  setTimeout(() => {
    const el = document.getElementById('lb-target');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      lbScrollToLine(lineIdx);
    }
  }, 80);
}

function lbScrollToLine(lineIdx) {
  // Highlighter temporairement la zone dans le viewer
  // On scroll via position approximative
  const viewer = document.getElementById('textViewer');
  if (!viewer) return;
  const text  = viewer.innerText || viewer.textContent;
  const lines = text.split('\n');
  // Estimer la position en pixels
  const lineHeight  = 22; // approx en px (line-height: 1.8 * 12px)
  const approxTop   = lineIdx * lineHeight;
  viewer.scrollTop  = Math.max(0, approxTop - viewer.clientHeight / 2);
}

function lbNavigate(dir) {
  const active = LB.suspects.filter(i => !LB.ignored.has(i));
  if (active.length === 0) return;
  LB.current = ((LB.current + dir) % active.length + active.length) % active.length;
  lbRenderCurrent();
}

function lbMergeCurrent() {
  const text   = State.processedText || State.rawText;
  const lines  = text.split('\n');
  const active = LB.suspects.filter(i => !LB.ignored.has(i));
  if (active.length === 0) return;

  const lineIdx = active[LB.current];

  // Récupérer le skipCount depuis _breakInfo (N lignes vides possibles)
  const skipCount = (LB._breakInfo && LB._breakInfo[lineIdx]) || 2;
  // La ligne à fusionner avec lineA est à lineIdx + skipCount - 1
  const lineB = lines[lineIdx + skipCount - 1] || '';
  const merged = lines[lineIdx].trimEnd() + ' ' + lineB.trimStart();
  const spliceCount = skipCount;
  lines.splice(lineIdx, spliceCount, merged);

  const newText = lines.join('\n');
  State.processedText = newText;
  State.rawText       = newText;

  // Mettre à jour les indices suspects (décaler ceux après lineIdx)
  LB.suspects = LB.suspects
    .filter(i => i !== lineIdx)
    .map(i => i > lineIdx ? i - 1 : i);
  LB.ignored  = new Set([...LB.ignored]
    .filter(i => i !== lineIdx)
    .map(i => i > lineIdx ? i - 1 : i));

  // Rester sur le même index si possible
  const newActive = LB.suspects.filter(i => !LB.ignored.has(i));
  if (LB.current >= newActive.length) LB.current = Math.max(0, newActive.length - 1);

  document.getElementById('lbSuspectCount').textContent =
    `${newActive.length} suspect${newActive.length > 1 ? 's' : ''}`;

  // Re-détecter sur le nouveau texte pour capter les chaînes de sauts
  const newLines = newText.split('\n');
  // Mettre à jour la liste des suspects à partir du texte modifié
  const freshBreaks = findSuspectBreaks(newLines);
  const freshSuspects = freshBreaks.map(b => b.lineIdx);
  LB._breakInfo = {};
  for (const b of freshBreaks) LB._breakInfo[b.lineIdx] = b.skipCount;
  LB.suspects = freshSuspects;
  LB.ignored  = new Set([...LB.ignored].filter(i => freshSuspects.includes(i)));
  const stillActive = LB.suspects.filter(i => !LB.ignored.has(i));

  // Repositionner sur le premier saut APRES lineIdx dans le nouveau texte.
  // lineIdx a diminué d'au moins 1 après la fusion (spliceCount lignes supprimées).
  // On cherche le premier stillActive[k] >= lineIdx.
  const nextPos = stillActive.findIndex(li => li >= lineIdx);
  if (nextPos >= 0) {
    LB.current = nextPos;
  } else {
    LB.current = Math.max(0, stillActive.length - 1);
  }

  document.getElementById('lbSuspectCount').textContent =
    `${stillActive.length} suspect${stillActive.length !== 1 ? 's' : ''}`;

  refreshViewer();
  lbRenderCurrent();
}

function lbSkipCurrent() {
  const active = LB.suspects.filter(i => !LB.ignored.has(i));
  if (active.length === 0) return;
  LB.ignored.add(active[LB.current]);
  // Ne pas avancer : le suivant prend la place du courant
  const newActive = LB.suspects.filter(i => !LB.ignored.has(i));
  if (LB.current >= newActive.length) LB.current = Math.max(0, newActive.length - 1);
  document.getElementById('lbSuspectCount').textContent =
    `${newActive.length} suspect${newActive.length > 1 ? 's' : ''}`;
  lbRenderCurrent();
}

function lbMergeFromHere() {
  // Fusionner automatiquement tous les sauts restants à partir du courant
  const active = LB.suspects.filter(i => !LB.ignored.has(i));
  if (active.length === 0) return;

  // Compter combien on va fusionner
  const toMerge = active.slice(LB.current);
  if (toMerge.length === 0) return;

  const confirm_ = toMerge.length > 10
    ? window.confirm(`Fusionner automatiquement les ${toMerge.length} sauts restants ?`)
    : true;
  if (!confirm_) return;

  // Appliquer toutes les fusions d'un coup sur le texte courant
  let text = State.processedText || State.rawText;

  // On travaille avec findSuspectBreaks sur le texte courant
  // et on fusionne depuis la position courante jusqu'à la fin
  let pass = 0;
  const MAX = 30;

  while (pass < MAX) {
    const lines  = text.split('\n');
    const breaks = findSuspectBreaks(lines);

    // Ne garder que les sauts à partir de lineIdx courant
    const currentLineIdx = active[LB.current] || 0;
    const toFuse = breaks.filter(b => b.lineIdx >= currentLineIdx);
    if (toFuse.length === 0) break;

    // Construire un index pour cette passe
    const passBreaks = {};
    for (const b of toFuse) passBreaks[b.lineIdx] = b.skipCount;

    // Fusionner en une passe
    const result = [];
    let i = 0;
    let fused = 0;
    while (i < lines.length) {
      if (passBreaks[i] !== undefined) {
        const sc    = passBreaks[i];
        const lineB = lines[i + sc - 1] || '';
        result.push(lines[i].trimEnd() + ' ' + lineB.trimStart());
        i += sc;
        fused++;
      } else {
        result.push(lines[i]);
        i++;
      }
    }
    text = result.join('\n');
    pass++;
    if (fused === 0) break;
  }

  State.processedText = text;
  State.rawText       = text;

  // Recalculer les suspects restants
  const newLines   = text.split('\n');
  const freshBreaks = findSuspectBreaks(newLines);
  LB.suspects   = freshBreaks.map(b => b.lineIdx);
  LB._breakInfo = {};
  for (const b of freshBreaks) LB._breakInfo[b.lineIdx] = b.skipCount;
  LB.ignored    = new Set();
  // Repositionner au début (les sauts avant le courant sont intacts)
  const currentLineIdx = active[LB.current] || 0;
  const nextPos = LB.suspects.findIndex(li => li >= currentLineIdx);
  LB.current = nextPos >= 0 ? nextPos : 0;

  const stillActive = LB.suspects.filter(i => !LB.ignored.has(i));
  document.getElementById('lbSuspectCount').textContent =
    `${stillActive.length} suspect${stillActive.length !== 1 ? 's' : ''}`;

  refreshViewer();
  if (stillActive.length > 0) {
    lbRenderCurrent();
    showToast(`${toMerge.length} saut${toMerge.length > 1 ? 's' : ''} fusionné${toMerge.length > 1 ? 's' : ''} ✓`);
  } else {
    lbRenderCurrent(); // fermera la barre
  }
}

function lbQuit() {
  // Ferme la barre mais CONSERVE la position et les ignorés
  _setNavBar('ctrl');
  LB.active     = false;
  LB._breakInfo = LB._breakInfo || {};
  ViewerState.spHighlight  = '';
  ViewerState.lbTargetLine = -1;
  refreshViewer();
  document.getElementById('lbSuspectCount').textContent = '—';
  showToast('Mode correction des sauts fermé (position mémorisée)');
}

// ── Modale de chargement ──────────────────────────────────────────────────────

function showLoadingModal(msg, sub, pct, cancellable = false) {
  const modal = document.getElementById('loadingModal');
  if (!modal) return;
  document.getElementById('loadingMsg').textContent = msg || 'Chargement…';
  document.getElementById('loadingSub').textContent = sub || '';
  const p = pct || 0;
  document.getElementById('loadingBar').style.width = p + '%';
  const pctEl = document.getElementById('loadingPct');
  if (pctEl) pctEl.textContent = p > 0 ? p + ' %' : '';
  const cancelBtn = document.getElementById('loadingCancelBtn');
  if (cancelBtn) cancelBtn.style.display = cancellable ? 'inline-block' : 'none';
  modal.style.display = 'flex';
}

function cancelLoading() {
  Server.cancelExtract();
  hideLoadingModal();
  // Réactiver le bouton suivant
  const btn = document.getElementById('btnStep1Next');
  if (btn) btn.disabled = false;
  showToast('Chargement annulé');
}

function updateLoadingModal(msg, sub, pct) {
  const modal = document.getElementById('loadingModal');
  if (!modal) return;
  if (modal.style.display === 'none') return;
  if (msg !== undefined) document.getElementById('loadingMsg').textContent = msg;
  if (sub !== undefined) document.getElementById('loadingSub').textContent = sub;
  if (pct !== undefined) {
    const bar = document.getElementById('loadingBar');
    if (bar) bar.style.width = pct + '%';
    const pctEl = document.getElementById('loadingPct');
    if (pctEl) pctEl.textContent = pct > 0 ? pct + ' %' : '';
  }
}

function hideLoadingModal() {
  const modal = document.getElementById('loadingModal');
  if (modal) modal.style.display = 'none';
}

function autoFixAllBreaks() {
  const text = State.processedText || State.rawText;
  if (!text) { showToast('Aucun texte à corriger'); return; }

  let current = text;
  let totalFixed = 0;
  let pass = 0;
  const MAX_PASSES = 20; // sécurité anti-boucle infinie

  // Boucler jusqu'à ce qu'il n'y ait plus de suspects
  while (pass < MAX_PASSES) {
    const lines  = current.split('\n');
    const result = [];
    let fixed = 0;
    let i = 0;

    // Construire un index des sauts pour cette passe
    const passBreaks = {};
    for (const b of findSuspectBreaks(lines)) passBreaks[b.lineIdx] = b.skipCount;

    while (i < lines.length) {
      if (passBreaks[i] !== undefined) {
        const sc = passBreaks[i];
        const lineB = lines[i + sc - 1] || '';
        result.push(lines[i].trimEnd() + ' ' + lineB.trimStart());
        i += sc;
        fixed++;
      } else {
        result.push(lines[i]);
        i++;
      }
    }

    totalFixed += fixed;
    current = result.join('\n');
    pass++;

    // Si plus rien à fusionner, on arrête
    if (fixed === 0) break;
  }

  State.processedText = current;
  State.rawText       = current;

  // Réinitialiser l'état LB
  LB.suspects = [];
  LB.current  = -1;
  LB.ignored  = new Set();
  document.getElementById('lbSuspectCount').textContent = '0 suspect';
  _setNavBar('ctrl');

  refreshViewer();
  showToast(`${totalFixed} saut${totalFixed > 1 ? 's' : ''} de ligne fusionné${totalFixed > 1 ? 's' : ''} en ${pass} passe${pass > 1 ? 's' : ''} ✓`);
}

// ── Recherche / Remplacement dans le texte ────────────────────────────────────

let _rrReplacing = false;

const RR = {
  active:    false,
  matches:   [],  // [{start, end, text}] positions dans processedText
  current:   -1,
  query:     '',
  replace:   '',
  useRegex:  false,
  ignoreCase: true,
};

/** Ouvre / ferme la modale Recherche-Remplacement. */
function toggleRRPanel() {
  if (RR.active) {
    closeRRPanel();
  } else {
    // Pré-remplir depuis entityViewerSearch si non vide
    const evs = document.getElementById('entityViewerSearch');
    if (evs && evs.value.trim()) {
      const q = document.getElementById('rrQuery');
      if (q && !q.value) q.value = evs.value.trim();
    }
    openRRPanel();
  }
}

function openRRPanel() {
  RR.active = true;
  const modal = document.getElementById('rrModal');
  if (modal) modal.style.display = 'block';
  const btn = document.getElementById('btnRRToggle');
  if (btn) btn.classList.add('active');
  setTimeout(() => {
    const q = document.getElementById('rrQuery');
    if (q) { q.focus(); q.select(); }
  }, 60);
  rrScan();
}

function closeRRPanel() {
  RR.active  = false;
  RR.matches = [];
  RR.current = -1;
  RR.query   = '';
  const modal = document.getElementById('rrModal');
  if (modal) modal.style.display = 'none';
  const btn = document.getElementById('btnRRToggle');
  if (btn) btn.classList.remove('active');
  refreshViewer();
}
/** Rend la modale RR draggable par son header. */
function _initRRDrag() {
  const modal  = document.getElementById('rrModal');
  const handle = document.getElementById('rrModalHeader');
  if (!modal || !handle) return;

  // Éviter d'attacher plusieurs fois si _initRRDrag est rappelé
  if (handle._rrDragBound) return;
  handle._rrDragBound = true;

  let startX, startY, origLeft, origTop;

  handle.addEventListener('mousedown', e => {
    // Ignorer le clic sur le bouton close (ou ses enfants ex: icône Lucide)
    if (e.target.closest('.modal-close')) return;
    e.preventDefault();

    const rect = modal.getBoundingClientRect();

    // Figer position : annuler right/bottom pour éviter le resize par le browser
    modal.style.position = 'fixed';
    modal.style.right    = 'auto';
    modal.style.bottom   = 'auto';
    modal.style.left     = rect.left + 'px';
    modal.style.top      = rect.top  + 'px';
    modal.style.transform = 'none';

    origLeft = rect.left;
    origTop  = rect.top;
    startX   = e.clientX;
    startY   = e.clientY;

    function onMove(e) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      modal.style.left = Math.max(0, origLeft + dx) + 'px';
      modal.style.top  = Math.max(0, origTop  + dy) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

// Initialiser le drag au chargement
window.addEventListener('load', () => { setTimeout(_initRRDrag, 500); });



function _rrSyncFromViewer() {
  const viewer = document.getElementById('textViewer');
  if (!viewer) return false;
  if (!viewer.classList.contains('text-viewer--edit')) return false;
  const edited = viewer.innerText;
  State.rawText       = edited;
  State.processedText = edited;
  viewer.classList.remove('text-viewer--edit');
  return true;
}

/** Scan pur : lit les champs DOM, construit RR.matches, met à jour le compteur.
 *  Ne touche pas à RR.current, n'appelle ni _rrSyncFromViewer() ni refreshViewer(). */
function _rrScanOnly() {
  const queryEl   = document.getElementById('rrQuery');
  const replaceEl = document.getElementById('rrReplace');
  const regexEl   = document.getElementById('rrRegex');
  const caseEl    = document.getElementById('rrCase');

  RR.query      = queryEl?.value   || '';
  RR.replace    = replaceEl?.value || '';
  RR.useRegex   = regexEl?.checked ?? false;
  RR.ignoreCase = !(caseEl?.checked ?? false);

  RR.matches = [];

  const text = (State.processedText || State.rawText || '').normalize('NFC');
  //console.log('[SCAN] text(50):', JSON.stringify(text.slice(0,50)), '| query:', JSON.stringify(RR.query));
  if (!RR.query) {
    _updateRRCount();
    return;
  }

  let re;
  try {
    const pattern = RR.useRegex ? RR.query : RR.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags   = 'g' + (RR.ignoreCase ? 'i' : '');
    re = new RegExp(pattern, flags);
  } catch (e) {
    document.getElementById('rrCount').textContent = '⚠ regex invalide';
    return;
  }

  let m;
  while ((m = re.exec(text)) !== null) {
    RR.matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    if (m[0].length === 0) re.lastIndex++; // éviter boucle infinie
  }

  _updateRRCount();
}

/**
 * Scanne le texte avec la query courante et met à jour RR.matches.
 * Appelé à chaque frappe dans le champ Rechercher.
 */
function rrScan() {
  _rrSyncFromViewer();
  RR.current = -1;
  _rrScanOnly();
  refreshViewer();
  if (RR.matches.length > 0) {
    RR.current = 0;
    rrScrollToCurrent();
  }
}

function _updateRRCount() {
  const el = document.getElementById('rrCount');
  if (!el) return;
  const n = RR.matches.length;
  if (!RR.query) { el.textContent = ''; return; }
  const cur = RR.current >= 0 ? RR.current + 1 : (n > 0 ? 1 : 0);
  el.textContent = n === 0 ? '0 résultat' : `${cur} / ${n}`;
  el.style.color = n === 0 ? 'var(--danger, #c0392b)' : '';
}

function rrNavigate(dir) {
  if (RR.matches.length === 0) return;
  RR.current = ((RR.current + dir) % RR.matches.length + RR.matches.length) % RR.matches.length;
  _updateRRCount();
  refreshViewer();    // re-render pour mettre à jour hl-rr-current
  rrScrollToCurrent();
}

function rrScrollToCurrent() {
  // Attendre que le DOM soit mis à jour après refreshViewer
  setTimeout(() => {
    const el = document.querySelector('.hl-rr-current');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 50);
}

/**
 * Remplace l'occurrence courante (ou toutes si all=true).
 * Modifie State.processedText et re-scanne.
 */
function rrReplace(all = false) {
  // Toujours relire le champ "Remplacer par" depuis le DOM — RR.replace peut être stale
  const _replEl = document.getElementById('rrReplace');
  if (_replEl) RR.replace = _replEl.value;

  // NFC : même normalisation que _rrScanOnly → offsets cohérents
  const text = (State.processedText || State.rawText || '').normalize('NFC');

  //console.log('%c[RR-REPLACE] START all='+all+' matches='+RR.matches.length+' current='+RR.current, 'color:green;font-weight:bold');
  //console.log('[RR-REPLACE] text(80):', JSON.stringify(text.slice(0,80)));
  //console.log('[RR-REPLACE] RR.query:', JSON.stringify(RR.query), '| RR.replace:', JSON.stringify(RR.replace));

  if (!RR.query || RR.matches.length === 0) {
    //console.log('[RR-REPLACE] ← abort (query vide ou 0 matches)');
    return;
  }

  let newText;
  let count = 0;

  if (all) {
    let re;
    try {
      const pattern = RR.useRegex ? RR.query : RR.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const flags   = 'g' + (RR.ignoreCase ? 'i' : '');
      re = new RegExp(pattern, flags);
    } catch (e) { return; }
    count   = RR.matches.length;
    newText = text.replace(re, RR.replace);
  } else {
    if (RR.current < 0 || RR.current >= RR.matches.length) {
      //console.log('[RR-REPLACE] ← abort (current hors bornes)');
      return;
    }
    const match = RR.matches[RR.current];
    //console.log('[RR-REPLACE] match:', JSON.stringify(match));
    //console.log('[RR-REPLACE] text[start:end]:', JSON.stringify(text.slice(match.start, match.end)));
    //console.log('[RR-REPLACE] charCodes query  :', [...RR.query].map(c => c.codePointAt(0).toString(16)).join(' '));
    //console.log('[RR-REPLACE] charCodes match  :', [...text.slice(match.start, match.end)].map(c => c.codePointAt(0).toString(16)).join(' '));

    let repl = RR.replace;
    if (RR.useRegex) {
      try {
        const re = new RegExp(RR.query, RR.ignoreCase ? 'i' : '');
        repl = match.text.replace(re, RR.replace);
      } catch (e) { repl = RR.replace; }
    }
    //console.log('[RR-REPLACE] repl:', JSON.stringify(repl));
    count   = 1;
    newText = text.slice(0, match.start) + repl + text.slice(match.end);
    //console.log('[RR-REPLACE] newText===text ?', newText === text);
    //console.log('[RR-REPLACE] newText(80):', JSON.stringify(newText.slice(0,80)));
  }

  pushUndo();
  _rrReplacing = true;
  State.rawText       = newText;
  State.processedText = newText;
  autoSave();

  if (all) showToast(`✦ ${count} remplacement${count > 1 ? 's' : ''} effectué${count > 1 ? 's' : ''}`);

  // Re-scanner sur newText normalisé — sans passer par rrScan()
  RR.matches = [];
  RR.current = -1;
  if (RR.query) {
    const newNFC = newText.normalize('NFC');
    let re;
    try {
      const pattern = RR.useRegex ? RR.query : RR.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(pattern, 'g' + (RR.ignoreCase ? 'i' : ''));
    } catch (e) { re = null; }
    if (re) {
      let m;
      while ((m = re.exec(newNFC)) !== null) {
        RR.matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  }
  _updateRRCount();

  refreshViewer();
  requestAnimationFrame(() => { _rrReplacing = false; });

  if (!all && RR.matches.length > 0) {
    RR.current = Math.min(RR.current, RR.matches.length - 1);
    rrScrollToCurrent();
  }
}

// ── Correction des espaces parasites OCR (navigation un par un) ───────────────

const SP = {
  suspects: [],
  current:  -1,
  ignored:  new Set(),
  active:   false, // true = mode espaces actif → désactive highlight entités
};

// Fusion intelligente de tokens OCR fragmentes.
// Utilise window.DICT_FR (dict_fr.js) si disponible pour segmenter les runs de lettres.
// Regles :
//   - run de lettres : segmentation par dictionnaire si possible, sinon fusion brute
//   - changement lettre->chiffre ou chiffre->lettre : espace entre les groupes
//   - token de 2+ chars : mot separe
//   - ponctuation (°.,) : colle au groupe courant
function smartMergeTokens(tokens) {
  const isDigit  = s => /^[0-9]+$/.test(s);
  const isLetter = s => /^[A-Za-zÀ-ÖØ-öø-ÿ]+$/.test(s);
  const dict     = window.DICT_FR || null;

  // Segmentation d'un run de lettres via dictionnaire (programmation dynamique)
  // Cherche la meilleure couverture gauche-droite par mots du dictionnaire.
  function dictSegment(run) {
    if (!dict || run.length <= 2) return [run.join('')];
    const s = run.join('').toLowerCase();
    const n = s.length;
    // dp[i] = meilleure segmentation de s[0..i]
    const dp   = new Array(n + 1).fill(null);
    const back = new Array(n + 1).fill(0);
    dp[0] = [];
    for (let i = 1; i <= n; i++) {
      for (let j = Math.max(0, i - 5); j < i; j++) {
        const word = s.slice(j, i);
        if (dp[j] !== null && (dict.has(word) || i - j === 1)) {
          if (dp[i] === null || i - j > back[i]) {
            dp[i] = dp[j];
            back[i] = i - j;
          }
        }
      }
    }
    if (dp[n] === null) return [run.join('')]; // fallback : fusion brute
    // Reconstruire les mots depuis back[]
    const words = [];
    let pos = n;
    while (pos > 0) {
      const len = back[pos];
      // Respecter la casse originale
      words.unshift(run.slice(pos - len, pos).join(''));
      pos -= len;
    }
    return words;
  }

  const groups = [];
  let run = [], runType = null;

  function flushRun() {
    if (run.length === 0) return;
    if (runType === 'letter' && run.length > 2) {
      // Segmenter via dictionnaire
      const words = dictSegment(run);
      words.forEach(w => groups.push(w));
    } else {
      groups.push(run.join(''));
    }
    run = []; runType = null;
  }

  for (const tok of tokens) {
    if (tok.length >= 2) {
      flushRun();
      groups.push(tok);
    } else {
      const type = isDigit(tok) ? 'digit' : isLetter(tok) ? 'letter' : 'other';
      if (runType !== null && type !== runType && type !== 'other' && runType !== 'other') {
        flushRun();
      }
      run.push(tok);
      if (type !== 'other') runType = type;
    }
  }
  flushRun();
  return groups.join(' ');
}

function detectSpacedLetters(fromLine = 0) {
  const text = State.processedText || State.rawText;
  if (!text) { showToast('Aucun texte à analyser'); return; }

  // Reprendre sans re-scanner si suspects mémorisés
  if (!SP.active && SP.suspects.length > 0) {
    const stillActive = SP.suspects.filter((_, i) => !SP.ignored.has(i));
    if (stillActive.length > 0) {
      SP.active = true;
      _setNavBar('sp');
      spRenderCurrent();
      showToast(`Reprise — ${stillActive.length} espace${stillActive.length > 1 ? 's' : ''} restant${stillActive.length > 1 ? 's' : ''}`);
      return;
    }
  }

  SP.suspects = [];
  SP.current  = -1;
  SP.ignored  = new Set();

  const L = 'A-Za-z\xC0-\xD6\xD8-\xF6\xF8-\xFF';
  // Apostrophes droite (') et typographique (’) : traitées comme caractères
  // de mot pour que "qu'il", "l'y", "n'est" soient vus comme tokens longs (> 2)
  // et n'entrent jamais dans un run de tokens courts.
  const APO = "'\u2019";
  // Parenthèses/crochets collés à un token : "4)." ou "(Pièce" = 1 token long
  // Évite "N° 4)." → "N°" + "4" + ")." = run de courts → faux positif
  const PAREN = "()\\[\\]";  // () OK dans une classe regex, [] doivent être échappés

  // ── Règle 1 : tokens courts (1-2 chars) séparés par 1 ou 2 espaces ────────
  // ex: "a u Barreau", "N ° d e", "e t sa"
  // On scanne le texte mot par mot pour trouver des runs de tokens courts
  const tokenRe = new RegExp(`([${L}0-9°.,]{1,2})(?=( {1,2}[${L}0-9°.,]{1,2})+( |\n|$))`, 'gm');

  let m;
  // Approche : scanner les lignes une par une
  const lines1 = text.split('\n');
  let offset1 = 0;
  for (const line of lines1) {
    // Un token inclut apostrophes ET parenthèses : "qu'il"=5 chars, "4)."=3 chars → pas court
    // Collecter tous les mots avec leurs positions
    const wordList = [];
    const wr = new RegExp(`[${L}${APO}${PAREN}0-9°.,]+`, 'g');
    let wordMatch;
    while ((wordMatch = wr.exec(line)) !== null) {
      wordList.push({ w: wordMatch[0], pos: wordMatch.index });
    }
    // Chercher des runs de 3+ tokens consécutifs courts (1-2 chars)
    let i = 0;
    while (i < wordList.length) {
      if (wordList[i].w.length <= 2) {
        // Début d'un run potentiel
        let j = i;
        while (j < wordList.length && wordList[j].w.length <= 2) j++;
        const runWords = wordList.slice(i, j);
        // Minimum 3 tokens normalement, mais 2 suffisent si le contexte a des doubles espaces
      const minTokens = line.includes('  ') ? 2 : 3;
      if (runWords.length >= minTokens) {
          // Construire la chaîne originale (du début du premier au fin du dernier)
          const startPos = runWords[0].pos;
          const endPos   = runWords[runWords.length-1].pos + runWords[runWords.length-1].w.length;
          const original = line.slice(startPos, endPos);
          // ── Exclure si le between entre 2 tokens quelconques contient - ou / ──
          // ex: "5 - 1" (art. de loi), "22 / 06" (date) ne sont PAS des OCR fracturés
          let hasSeparator = false;
          for (let k = 0; k < runWords.length - 1; k++) {
            const betweenSep = line.slice(runWords[k].pos + runWords[k].w.length, runWords[k+1].pos);
            if (/[-\/]/.test(betweenSep)) { hasSeparator = true; break; }
          }
          if (hasSeparator) { i = j; continue; }
          const start    = offset1 + startPos;
          const tokens   = runWords.map(r => r.w);
          const merged   = smartMergeTokens(tokens);
          const origNorm = tokens.join(' ');
          if (merged !== origNorm || original !== origNorm) {
            SP.suspects.push({ start, end: start + original.length, original, merged });
          }
        }
        i = j;
      } else {
        i++;
      }
    }
    offset1 += line.length + 1;
  }

  // ── Règle 2 : doubles espaces entre mots normaux ───────────────────────────
  // ex: "2  lits", "salle  de", "nuit  et"
  // Signal : 2+ espaces entre deux mots d'au moins 2 chars
  // Exclusion : si l'espace est entouré d'un - ou / (ex: "5 - 1", "22 / 06")
  const re2 = new RegExp(
    `([${L}0-9][${L}0-9]+|[0-9]+)( {2,})([${L}0-9][${L}0-9]+|[0-9]+)`,
    'g'
  );
  while ((m = re2.exec(text)) !== null) {
    // Vérifier le contexte autour : présence de - ou / adjacent
    const ctxStart = Math.max(0, m.index - 2);
    const ctxEnd   = Math.min(text.length, m.index + m[0].length + 2);
    const ctx      = text.slice(ctxStart, ctxEnd);
    if (/[-\/]/.test(ctx)) continue; // expression avec séparateur → ne pas signaler
    const original = m[0];
    const merged   = m[1] + ' ' + m[3]; // un seul espace
    const already  = SP.suspects.some(s => s.start <= m.index && s.end >= m.index + original.length);
    if (!already) {
      SP.suspects.push({ start: m.index, end: m.index + original.length, original, merged });
    }
  }

  // ── Règle 3 : lettre isolée + espace(s) + suite du mot (ex: "r  etraite", "l  espace") ──
  // Approche par tokens pour éviter les faux positifs des lookbehind Unicode.
  // Exige que la lettre isolée ne soit pas précédée d'une lettre (sinon fin de vrai mot).
  // Lettres très ambiguës (a, à, y…) toujours ignorées.
  // Lettres communes (l, d, n…) exigent 2+ espaces pour confirmer fragmentation OCR.
  {
    const ALWAYS_SKIP_SP  = new Set(['a','à','y','e','o','i','u']);
    const NEEDS_DOUBLE_SP = new Set(['l','d','s','n','m','c','j','t']);
    const reWordSP = new RegExp('[' + L + ']+', 'g');
    const lines3 = text.split('\n');
    let off3 = 0;
    for (const line3 of lines3) {
      const words3 = [];
      let wm3;
      reWordSP.lastIndex = 0;
      while ((wm3 = reWordSP.exec(line3)) !== null) words3.push({ w: wm3[0], pos: wm3.index });
      for (let i = 0; i < words3.length - 1; i++) {
        const wa = words3[i], wb = words3[i + 1];
        const between3 = line3.slice(wa.pos + wa.w.length, wb.pos);
        if (!/^ {1,3}$/.test(between3)) continue;
        if (!(wa.w.length === 1 && wb.w.length >= 3)) continue;
        // Pas précédé d'une lettre collée
        if (wa.pos > 0 && new RegExp('[' + L + ']').test(line3[wa.pos - 1])) continue;
        const letter3 = wa.w.toLowerCase();
        if (ALWAYS_SKIP_SP.has(letter3)) continue;
        if (NEEDS_DOUBLE_SP.has(letter3) && between3.length < 2) continue;
        const original3 = line3.slice(wa.pos, wb.pos + wb.w.length);
        const merged3   = original3.replace(/ +/, '');
        const start3    = off3 + wa.pos;
        const end3      = off3 + wb.pos + wb.w.length;
        const already3  = SP.suspects.some(s => s.start <= start3 && s.end >= end3);
        if (!already3) SP.suspects.push({ start: start3, end: end3, original: original3, merged: merged3 });
      }
      off3 += line3.length + 1;
    }
  }

  // Trier par position et supprimer chevauchements
  SP.suspects.sort((a, b) => a.start - b.start);
  SP.suspects = SP.suspects.filter((s, i, arr) => i === 0 || s.start >= arr[i-1].end);

  // Filtrer depuis la position courante si fromLine > 0
  if (fromLine > 0) {
    const text2 = State.processedText || State.rawText;
    const lines2 = text2.split('\n');
    // Calculer l'offset char de la ligne fromLine
    let fromOffset = 0;
    for (let i = 0; i < fromLine && i < lines2.length; i++) fromOffset += lines2[i].length + 1;
    SP.suspects = SP.suspects.filter(s => s.start >= fromOffset);
    SP._fromLine = fromLine;
  } else {
    SP._fromLine = 0;
  }

  const count = SP.suspects.length;
  if (count === 0) {
    showToast('Aucun espace parasite détecté');
    _setNavBar('ctrl');
    return;
  }

  SP.current = 0;
  SP.active  = true;
  // Fermer le mode sauts si actif (toggle exclusif)
  if (LB.active) { LB.active = false; LB.suspects = []; LB.current = -1; LB.ignored = new Set(); }
  ViewerState.spHighlight = '';
  _setNavBar('sp');
  spRenderCurrent();
  const spFromMsg = (fromLine > 0) ? ` (depuis ligne ${fromLine + 1})` : '';
  showToast(`${count} espace${count > 1 ? 's' : ''} parasite${count > 1 ? 's' : ''} détecté${count > 1 ? 's' : ''}${spFromMsg}`);
}

function spActive() {
  return SP.suspects.filter((_, i) => !SP.ignored.has(i));
}

function spRenderCurrent() {
  const active = spActive();
  if (active.length === 0) {
    document.getElementById('spNav').style.display = 'none';
    SP.active = false;
    ViewerState.spHighlight = '';
    refreshViewer(); // restaure le highlight entites
    showToast('Tous les espaces parasites ont ete traites ✓');
    return;
  }
  if (SP.current >= active.length) SP.current = active.length - 1;
  if (SP.current < 0) SP.current = 0;

  const s = active[SP.current];
  // Source non éditable
  const origEl = document.getElementById('spOriginal');
  if (origEl) origEl.textContent = `"${s.original}"`;
  // Cible éditable initialisée avec la valeur fusionnée
  const inputEl = document.getElementById('spMergedInput');
  if (inputEl) { inputEl.value = s.merged; setTimeout(() => { inputEl.focus(); inputEl.select(); }, 50); }

  document.getElementById('spCounter').textContent = `${SP.current + 1} / ${active.length}`;

  // Surligner la chaine dans le viewer via hl-sp-found (jaune)
  ViewerState.spHighlight = s.original;

  refreshViewer(); // rafraichit sans highlight entites, avec hl-sp-found
  setTimeout(() => {
    const el = document.querySelector('.text-viewer .hl-sp-found');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 50);
}

function spScrollToMatch(original) {
  const viewer = document.getElementById('textViewer');
  if (!viewer) return;
  const text = viewer.innerText || viewer.textContent;
  const idx  = text.indexOf(original);
  if (idx < 0) return;
  const lineIdx = text.substring(0, idx).split('\n').length;
  viewer.scrollTop = Math.max(0, lineIdx * 22 - viewer.clientHeight / 2);
}

function spNavigate(dir) {
  const active = spActive();
  if (active.length === 0) return;
  SP.current = ((SP.current + dir) % active.length + active.length) % active.length;
  spRenderCurrent();
}

function spMergeCurrent() {
  const active = spActive();
  if (active.length === 0) return;
  const s       = active[SP.current];
  const realIdx = SP.suspects.indexOf(s);

  // Lire la valeur du champ éditable (peut avoir été modifiée par l'utilisateur)
  const inputEl = document.getElementById('spMergedInput');
  const merged  = (inputEl && inputEl.value.trim()) ? inputEl.value : s.merged;

  let text = State.processedText || State.rawText;
  text = text.substring(0, s.start) + merged + text.substring(s.end);

  const delta = merged.length - s.original.length;
  SP.suspects = SP.suspects.map((sus, i) =>
    i <= realIdx ? sus : { ...sus, start: sus.start + delta, end: sus.end + delta }
  );
  SP.suspects.splice(realIdx, 1);
  SP.ignored = new Set([...SP.ignored].map(i => i > realIdx ? i - 1 : i).filter(i => i !== realIdx));

  State.processedText = text;
  State.rawText       = text;

  const stillActive = spActive();
  if (SP.current >= stillActive.length) SP.current = Math.max(0, stillActive.length - 1);
  refreshViewer();
  spRenderCurrent();
}

function spSkipCurrent() {
  const active = spActive();
  if (active.length === 0) return;
  const realIdx = SP.suspects.indexOf(active[SP.current]);
  SP.ignored.add(realIdx);
  const newActive = spActive();
  if (SP.current >= newActive.length) SP.current = Math.max(0, newActive.length - 1);
  spRenderCurrent();
}

function spMergeFromHere() {
  const active = spActive();
  if (active.length === 0) return;

  const toMerge = active.slice(SP.current);
  if (toMerge.length === 0) return;

  const doIt = toMerge.length > 10
    ? window.confirm(`Fusionner automatiquement les ${toMerge.length} espaces restants avec la correction proposée ?`)
    : true;
  if (!doIt) return;

  let text = State.processedText || State.rawText;
  let fixed = 0;

  // Appliquer toutes les fusions à partir du courant
  // On travaille sur les suspects actuels triés par position décroissante
  // pour que les offsets restent valides après chaque remplacement
  const toProcess = [...toMerge].sort((a, b) => b.start - a.start);

  for (const s of toProcess) {
    // Utiliser la valeur du champ éditable si c'est le suspect courant,
    // sinon utiliser s.merged (valeur calculée)
    let merged = s.merged;
    if (s === active[SP.current]) {
      const inputEl = document.getElementById('spMergedInput');
      if (inputEl && inputEl.value.trim()) merged = inputEl.value;
    }
    text = text.substring(0, s.start) + merged + text.substring(s.end);
    fixed++;
  }

  State.processedText = text;
  State.rawText       = text;

  // Recalculer les suspects restants (ceux avant le courant)
  SP.suspects = [];
  SP.current  = -1;
  SP.ignored  = new Set();
  SP.active   = false;
  ViewerState.spHighlight = '';

  _setNavBar('ctrl');
  refreshViewer();
  showToast(`${fixed} espace${fixed > 1 ? 's' : ''} parasite${fixed > 1 ? 's' : ''} fusionné${fixed > 1 ? 's' : ''} ✓`);
}

function spQuit() {
  // Ferme la barre mais CONSERVE la position et les ignorés
  // pour pouvoir reprendre là où on en était
  _setNavBar('ctrl');
  SP.active   = false;
  ViewerState.spHighlight = '';
  refreshViewer();
  showToast('Mode correction des espaces fermé (position mémorisée)');
}

function fixSpacedLetters() { detectSpacedLetters(); }
// ── Réduction des sauts multiples ────────────────────────────────────────────
/**
 * Réduit tous les runs de N lignes vides consécutives à 1 seule ligne vide.
 * ex: lineA + "" + "" + "" + lineB → lineA + "" + lineB
 */
function reduceMultipleBlankLines() {
  const text = State.processedText || State.rawText;
  if (!text) { showToast('Aucun texte à traiter'); return; }

  const lines  = text.split('\n');
  const result = [];
  let   blanks = 0;
  let   fixed  = 0;

  for (const line of lines) {
    if (line.trim() === '') {
      blanks++;
      //GTL if (blanks === 1) {
      //GTL  result.push(line); // garder 1 seule ligne vide
      //GTL } else {
        fixed++; // supprimer les lignes vides supplémentaires
      //GTL }
    } else {
      blanks = 0;
      result.push(line);
    }
  }

  if (fixed === 0) {
    showToast('Aucun saut multiple détecté');
    return;
  }

  const newText = result.join('\n');
  State.processedText = newText;
  State.rawText       = newText;
  refreshViewer();
  showToast(`${fixed} ligne${fixed > 1 ? 's' : ''} vide${fixed > 1 ? 's' : ''} supprimée${fixed > 1 ? 's' : ''} ✓`);
}


// ── Séparateur draggable générique ───────────────────────────────────────────
function initDraggableDivider(dividerId, leftId, containerId, storageKey, headerLeftId) {
  const divider   = document.getElementById(dividerId);
  const splitLeft = document.getElementById(leftId);
  if (!divider || !splitLeft) return;

  let dragging = false, startX, startLeftW;
  divider.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX;
    startLeftW = splitLeft.getBoundingClientRect().width;
    document.body.style.cursor = document.body.style.userSelect = 'col-resize';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const container = document.getElementById(containerId) || splitLeft.parentElement;
    const contW = container.getBoundingClientRect().width;
    const newW  = Math.max(200, Math.min(contW - 250, startLeftW + e.clientX - startX));
    splitLeft.style.width = newW + 'px'; splitLeft.style.flex = 'none';
    const hl = headerLeftId ? document.getElementById(headerLeftId) : null;
    if (hl) { hl.style.width = newW + 'px'; hl.style.flexShrink = '0'; }
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = document.body.style.userSelect = '';
    if (storageKey) localStorage.setItem(storageKey, splitLeft.style.width);
  });
  const saved = storageKey ? localStorage.getItem(storageKey) : null;
  if (saved) {
    splitLeft.style.width = saved; splitLeft.style.flex = 'none';
    const hl = headerLeftId ? document.getElementById(headerLeftId) : null;
    if (hl) { hl.style.width = saved; hl.style.flexShrink = '0'; }
  } else {
    // Pas de largeur sauvegardée : sync header sur la largeur naturelle après rendu
    requestAnimationFrame(() => {
      const hl = headerLeftId ? document.getElementById(headerLeftId) : null;
      if (hl && splitLeft) {
        const w = splitLeft.getBoundingClientRect().width;
        if (w > 0) { hl.style.width = w + 'px'; hl.style.flexShrink = '0'; }
      }
    });
  }
}

// ── Gestion des onglets viewer ────────────────────────────────────────────────

function switchViewerTab(tab) {
  State.viewerTab = tab;

  // Mettre à jour les boutons onglets
  document.querySelectorAll('.vtab').forEach(b => b.classList.remove('active'));
  const activeBtn = document.getElementById(`vtab-${tab}`);
  if (activeBtn) activeBtn.classList.add('active');

  // Masquer tous les panneaux
  document.querySelectorAll('.viewer-pane').forEach(p => p.classList.remove('active'));

  // Afficher le panneau actif
  const pane = document.getElementById(`pane-${tab}`);
  if (pane) pane.classList.add('active');

  // Recherche désactivée sur panneau original pur PDF
  const searchInput = document.getElementById('viewerSearch');
  if (searchInput) {
    searchInput.disabled = (tab === 'original' && !State.sourceIsText);
  }

  // Mettre à jour le contenu selon l'onglet
  if (tab === 'corrected') {
    refreshViewer(); // rebuild avec surlignage
  } else if (tab === 'side') {
    updateSidePane();
  }
}

// ── Surlignage des entités directement sur le rendu du PDF (step 2/3) ───────
// PdfOverlay.loadNative/loadOcr est coûteux (rend chaque page) : on ne le
// relance que si l'URL source a changé, sinon on se contente de redessiner
// les surlignages (highlight() est bon marché).
let _pdfOverlayBuiltFor = null;

async function _buildPdfOverlay(pdfUrl) {
  const wrap   = document.getElementById('pdfOverlayWrap');
  const iframe = document.getElementById('pdfPreview');
  if (!wrap || typeof PdfOverlay === 'undefined') return;

  if (_pdfOverlayBuiltFor === pdfUrl && PdfOverlay.isReady()) {
    wrap.style.display = 'block';
    if (iframe) iframe.style.display = 'none';
    PdfOverlay.highlight(State.entities);
    return;
  }

  let ok = false;
  if (State.pageImages && State.pageImages.length) {
    // PDF scanné (OCR) : images + positions par mot déjà fournies par le serveur.
    console.log('[PdfOverlay] chemin OCR —', State.pageImages.length, 'page(s) image');
    ok = PdfOverlay.loadOcr(State.pageImages, State.pageBoxes, wrap);
  } else {
    // PDF texte natif : rendu et positionnement 100% navigateur (pdfjs).
    console.log('[PdfOverlay] chemin PDF natif —', typeof pdfjsLib === 'undefined' ? 'pdfjsLib absent !' : 'pdfjsLib chargé');
    ok = await PdfOverlay.loadNative(pdfUrl, wrap);
  }

  if (ok) {
    _pdfOverlayBuiltFor = pdfUrl;
    wrap.style.display = 'block';
    if (iframe) iframe.style.display = 'none';
    PdfOverlay.highlight(State.entities);
  } else {
    // Repli sur l'iframe brute (ex : pdfjs indisponible/échec de rendu).
    console.warn('[PdfOverlay] échec construction overlay — repli sur iframe brute');
    _pdfOverlayBuiltFor = null;
    wrap.style.display = 'none';
    if (iframe) iframe.style.display = 'block';
  }
}

function _hidePdfOverlay() {
  const wrap = document.getElementById('pdfOverlayWrap');
  if (wrap) wrap.style.display = 'none';
}

async function initOriginalPreview() {
  // ── Réinitialiser tous les viewers (rechargement) ────────────────────────
  const _pdf    = document.getElementById('step1PdfPreview');
  const _txt    = document.getElementById('step1TextPreview');
  const _docx   = document.getElementById('step1DocxPreview');
  if (_pdf)  { _pdf.style.display  = 'none'; _pdf.src = ''; }
  if (_txt)  { _txt.style.display  = 'none'; _txt.textContent = ''; }
  if (_docx) { _docx.style.display = 'none'; _docx.innerHTML  = ''; }

  // ── Step 1 : basculer vers la vue split ─────────────────────────────────
  const step1Import  = document.getElementById('step1Import');
  const step1Preview = document.getElementById('step1Preview');
  const step1Pdf     = document.getElementById('step1PdfPreview');
  const step1Text    = document.getElementById('step1TextPreview');
  const step1Ph      = document.getElementById('step1Placeholder');
  const step1Spacer  = document.getElementById('step1Spacer');
  const btnChange    = document.getElementById('btnStep1Change');

  if (step1Import)  step1Import.style.display  = 'none';
  if (step1Preview) step1Preview.style.display = 'block';
  if (btnChange)    btnChange.style.display     = 'inline-flex';

  const label = document.getElementById('step1DocLabel');
  // Réinitialiser tous les viewers
  const _p = document.getElementById('step1PdfPreview');
  const _t = document.getElementById('step1TextPreview');
  const _d = document.getElementById('step1DocxPreview');
  if (_p)  { _p.style.display  = 'none'; _p.src = ''; }
  if (_t)  { _t.style.display  = 'none'; _t.textContent = ''; }
  if (_d)  { _d.style.display  = 'none'; _d.innerHTML  = ''; }

  if (!State.sourceIsText && State.sourceBlobUrl) {
    // PDF : afficher en pleine largeur
    if (step1Pdf)  { step1Pdf.src = State.sourceBlobUrl; step1Pdf.style.display = 'block'; }
    if (step1Text) step1Text.style.display = 'none';
    if (label) label.textContent = '📄 Document PDF chargé';
  } else if (State._sessionRestored && State.rawText) {
    // Session restaurée sans PDF : afficher le texte corrigé
    if (step1Pdf)  step1Pdf.style.display = 'none';
    if (step1Text) {
      step1Text.style.display = 'block';
      step1Text.textContent   = State.processedText || State.rawText;
    }
    if (label) label.textContent = '📝 Session restaurée · Texte corrigé';
    // Afficher le bouton changer de fichier pour permettre de charger un PDF
    const btnChange = document.getElementById('btnStep1Change');
    if (btnChange) btnChange.style.display = 'inline-flex';
  } else {
    if (step1Pdf) step1Pdf.style.display = 'none';

    const docxDiv = document.getElementById('step1DocxPreview');

    if (State._docxFile && typeof mammoth !== 'undefined') {
      // DOCX : rendu HTML via Mammoth
      if (step1Text) step1Text.style.display = 'none';
      if (docxDiv)   docxDiv.style.display   = 'block';
      if (label)     label.textContent        = '📄 Document DOCX';

      const arrayBuffer = await State._docxFile.arrayBuffer();
      mammoth.convertToHtml({ arrayBuffer })
        .then(result => {
          if (docxDiv) docxDiv.innerHTML = result.value;
        })
        .catch(() => {
          // Fallback texte brut si Mammoth échoue
          if (docxDiv)   docxDiv.style.display   = 'none';
          if (step1Text) { step1Text.style.display = 'block'; step1Text.textContent = State.rawText || ''; }
        });
    } else {
      // TXT : texte brut
      if (docxDiv)   { if (docxDiv) docxDiv.style.display = 'none'; }
      if (step1Text) { step1Text.style.display = 'block'; step1Text.textContent = State.rawText || ''; }
      if (label)     label.textContent = '📝 Texte extrait';
    }
  }

  // Stats
  const text  = State.rawText || '';
  const chars = document.getElementById('statChars');
  const lines = document.getElementById('statLines');
  const stats = document.getElementById('importStats');
  if (chars) chars.textContent = text.length.toLocaleString('fr');
  if (lines) lines.textContent = text.split('\n').length.toLocaleString('fr');
  if (stats) stats.style.display = text ? 'inline-flex' : 'none';

  // ── Step 2/3 : source dans la colonne gauche du layout partagé ──────────
  const placeholder   = document.getElementById('splitPlaceholder');
  const pdfIframe     = document.getElementById('pdfPreview');
  const splitDocxDiv  = document.getElementById('splitDocxPreview');
  const noDoc         = document.getElementById('splitNoDoc');
  const btnOpenSrc    = document.getElementById('btnOpenSource');

  // Masquer le viewer DOCX par défaut (réaffiché si besoin ci-dessous)
  if (splitDocxDiv) { splitDocxDiv.style.display = 'none'; splitDocxDiv.innerHTML = ''; }

  if (!State.rawText && !State.sourceBlobUrl) {
    if (placeholder) placeholder.style.display = 'flex';
    if (pdfIframe)   pdfIframe.style.display   = 'none';
    _hideOriginalViewer();
    _hidePdfOverlay();
    if (noDoc)       noDoc.style.display        = 'inline';
    if (btnOpenSrc)  btnOpenSrc.style.display   = 'none';
    return;
  }

  if (placeholder) placeholder.style.display = 'none';
  if (noDoc)       noDoc.style.display        = 'none';
  if (btnOpenSrc)  btnOpenSrc.style.display   = 'inline-flex';

  // Mettre à jour le label snapshot (heure de chargement)
  const snapshotLabel = document.getElementById('sourceSnapshotLabel');
  if (snapshotLabel) {
    const t = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    snapshotLabel.textContent = `📷 ${t}`;
    snapshotLabel.title = `Aperçu chargé à ${t} — la source ne se met pas à jour`;
  }

  // Résoudre l'URL PDF à afficher : source native ou PDF de référence
  const isSourcePdf = !State.sourceIsText && !!State.sourceBlobUrl;
  const pdfUrl = isSourcePdf ? State.sourceBlobUrl : State.refDocUrl;

  if (pdfUrl) {
    // PDF natif OU PDF de référence chargé a posteriori
    if (pdfIframe) { pdfIframe.src = pdfUrl; pdfIframe.style.display = 'block'; syncPdfToolbarSpacer(); }
    _hideOriginalViewer();
    if (placeholder) placeholder.style.display = 'none';
    // Surlignage direct sur le document : uniquement pour le VRAI document
    // analysé (pas un PDF de référence chargé a posteriori, sans rapport
    // avec les entités détectées).
    if (isSourcePdf) _buildPdfOverlay(pdfUrl); else _hidePdfOverlay();
  } else if (State._docxFile && typeof mammoth !== 'undefined') {
    // DOCX : rendu HTML via Mammoth dans le panneau gauche du split
    if (pdfIframe) { pdfIframe.style.display = 'none'; pdfIframe.src = ''; }
    _hideOriginalViewer();
    _hidePdfOverlay();
    if (splitDocxDiv) splitDocxDiv.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
    const spacer = document.getElementById('pdfToolbarSpacer');
    if (spacer) spacer.style.display = 'none';
    State._docxFile.arrayBuffer().then(ab => {
      mammoth.convertToHtml({ arrayBuffer: ab })
        .then(result => { if (splitDocxDiv) splitDocxDiv.innerHTML = result.value; })
        .catch(() => {
          if (splitDocxDiv) splitDocxDiv.style.display = 'none';
          _fillOriginalViewer(State.rawText);
        });
    });
  } else if (State.rawText) {
    // TXT sans PDF de référence : afficher le texte source numéroté
    if (pdfIframe) { pdfIframe.style.display = 'none'; pdfIframe.src = ''; }
    _hidePdfOverlay();
    _fillOriginalViewer(State.rawText);
    if (placeholder) placeholder.style.display = 'none';
    const spacer = document.getElementById('pdfToolbarSpacer');
    if (spacer) spacer.style.display = 'none';
  }

  // Toujours mettre à jour le label du bouton gauche
  _updateLeftPanelLabel();
}

// Appelé après goToStep(2) pour s'assurer que le texte original est affiché
function ensureOriginalDisplayed() {
  if (!State._pendingOriginalDisplay) return;
  State._pendingOriginalDisplay = false;
  if (State.rawText && State.sourceIsText) {
    _fillOriginalViewer(State.rawText);
    const placeholder = document.getElementById('splitPlaceholder');
    if (placeholder) placeholder.style.display = 'none';
  }
}

function resetStep1() {
  // Effacer l'état complet
  State.rawText         = '';
  State.processedText   = '';
  State.sourceBlobUrl   = null;
  State.sourceIsText    = false;
  State._docxFile       = null;
  State._sessionRestored = false;
  State.entities        = [];
  State.result          = null;
  const step1Import  = document.getElementById('step1Import');
  const step1Preview = document.getElementById('step1Preview');
  const btnChange    = document.getElementById('btnStep1Change');
  const btnNext      = document.getElementById('btnStep1Next');
  if (step1Import)  step1Import.style.display  = 'block';
  if (step1Preview) step1Preview.style.display = 'none';
  if (btnChange)    btnChange.style.display     = 'none';
  if (btnNext)      btnNext.disabled = true;
  if (State.sourceBlobUrl) { URL.revokeObjectURL(State.sourceBlobUrl); State.sourceBlobUrl = null; }
  State._docxFile = null;
  State.rawText = ''; State.processedText = ''; State.entities = []; State.result = null;
  State.parties = { demandeurs: [], defendeurs: [] };
  State.stepsUnlocked = [1];
  document.querySelectorAll('.step-btn').forEach((b, i) => {
    b.classList.toggle('active', i === 0);
    b.classList.remove('done');
    if (i > 0) b.disabled = true;
  });
}

/** Résout l'URL PDF disponible (source native ou ref) */
function _getPdfUrl() {
  return (!State.sourceIsText && State.sourceBlobUrl)
    ? State.sourceBlobUrl
    : (State.refDocUrl || null);
}

function openPdfNewTab() {
  const url = _getPdfUrl();
  if (url) setTimeout(() => window.open(url, '_blank'), 0);
}

function openPdfNewWindow() {
  const url = _getPdfUrl();
  if (url) {
    setTimeout(() => window.open(url, '_blank',
      'width=900,height=1000,menubar=no,toolbar=no,location=no,status=no'), 0);
  }
}

/** Ouvre le texte corrigé dans un nouvel onglet */
function openTxtNewTab() {
  const text = State.processedText || State.rawText;
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  setTimeout(() => { window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 5000); }, 0);
}

/** Ouvre le texte corrigé dans une nouvelle fenêtre */
function openTxtNewWindow() {
  const text = State.processedText || State.rawText;
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  setTimeout(() => {
    window.open(url, '_blank', 'width=900,height=1000,menubar=no,toolbar=no,location=no,status=no');
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 0);
}

/** Ouvre la source originale (PDF, DOCX ou TXT) dans une nouvelle fenêtre */
function openSourceNewWindow() {
  const pdfUrl = _getPdfUrl();
  if (pdfUrl) {
    setTimeout(() => window.open(pdfUrl, '_blank', 'width=900,height=800,menubar=no,toolbar=no,location=no,status=no'), 0);
  } else if (State._docxFile && typeof mammoth !== 'undefined') {
    State._docxFile.arrayBuffer().then(ab => {
      mammoth.convertToHtml({ arrayBuffer: ab }).then(result => {
        const win = window.open('', '_blank', 'width=900,height=800,menubar=no,toolbar=no,location=no,status=no');
        if (!win) return;
        win.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>Source DOCX</title>
<style>body{font-family:Georgia,serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.7;color:#1a1a1a}
h1,h2,h3{font-family:Georgia,serif;margin:1em 0 0.4em}
p{margin-bottom:0.8em}
table{border-collapse:collapse;width:100%;font-size:13px;margin:1em 0}
td,th{border:1px solid #ccc;padding:6px 10px}
</style></head><body>${result.value}</body></html>`);
        win.document.close();
      });
    });
  } else if (State.rawText) {
    const blob = new Blob([State.rawText], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    setTimeout(() => { window.open(url, '_blank', 'width=900,height=800'); setTimeout(() => URL.revokeObjectURL(url), 5000); }, 0);
  }
}

/** Ouvre le texte corrigé (ou brut) dans une nouvelle fenêtre */
function openCorrectedNewWindow() {
  const text = State.processedText || State.rawText || '';
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  setTimeout(() => {
    window.open(url, '_blank', 'width=900,height=800,menubar=no,toolbar=no,location=no,status=no');
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 0);
}

/**
 * Met à jour la visibilité des sections PDF et TXT dans les menus "Ouvrir ▾"
 * selon ce qui est disponible (PDF natif, PDF ref, texte).
 */
function _updateOpenMenuOptions() {
  const hasPdf  = !!_getPdfUrl();
  const hasTxt  = !!(State.processedText || State.rawText);
  const hasBoth = hasPdf && hasTxt;

  for (const suffix of ['', 'Step3']) {
    const grpPdf = document.getElementById(`openOptsPdf${suffix}`);
    const grpTxt = document.getElementById(`openOptsTxt${suffix}`);
    const sep    = document.getElementById(`openOptsSep${suffix}`);
    if (grpPdf) grpPdf.style.display = hasPdf  ? 'block' : 'none';
    if (grpTxt) grpTxt.style.display = hasTxt  ? 'block' : 'none';
    if (sep)    sep.style.display    = hasBoth  ? 'block' : 'none';
  }

  // Afficher/masquer le menu step 3
  const menuStep3 = document.getElementById('openPdfMenuStep3');
  if (menuStep3) menuStep3.style.display = (hasPdf || hasTxt) ? 'inline-flex' : 'none';
}

function toggleOpenPdfMenu(e) {
  e.stopPropagation();
  _updateOpenMenuOptions();
  const opts = document.getElementById('openPdfOptions');
  if (!opts) return;
  const isOpen = opts.style.display !== 'none';
  opts.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    setTimeout(() => document.addEventListener('click', closeOpenPdfMenu, { once: true }), 0);
  }
}

function closeOpenPdfMenu() {
  const opts = document.getElementById('openPdfOptions');
  if (opts) opts.style.display = 'none';
}

function toggleOpenPdfMenuStep3(e) {
  e.stopPropagation();
  _updateOpenMenuOptions();
  const opts = document.getElementById('openPdfOptionsStep3');
  if (!opts) return;
  const isOpen = opts.style.display !== 'none';
  opts.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    setTimeout(() => document.addEventListener('click', closeOpenPdfMenuStep3, { once: true }), 0);
  }
}

function closeOpenPdfMenuStep3() {
  const opts = document.getElementById('openPdfOptionsStep3');
  if (opts) opts.style.display = 'none';
}



/**
 * Synchronise la hauteur de l'espaceur avec la toolbar du viewer PDF.
 * Appelée après que l'iframe PDF est chargée.
 */
function syncPdfToolbarSpacer() {
  const spacer  = document.getElementById('pdfToolbarSpacer');
  if (!spacer) return;

  // Essayer de lire --viewer-pdf-toolbar-height depuis l'iframe
  const iframe = document.getElementById('pdfPreview');
  if (!iframe) return;

  // Observer la taille via une iframe chargée
  iframe.addEventListener('load', () => {
    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      const toolbarH  = iframeDoc?.querySelector('.toolbar')?.getBoundingClientRect().height
                     || iframeDoc?.querySelector('#toolbarViewer')?.getBoundingClientRect().height;
      if (toolbarH && toolbarH > 0) {
        spacer.style.height = toolbarH + 'px';
        return;
      }
    } catch { /* cross-origin — pas d'accès au DOM de l'iframe */ }
    // Fallback : utiliser la valeur CSS --viewer-pdf-toolbar-height si définie
    const cssVar = getComputedStyle(document.documentElement)
      .getPropertyValue('--viewer-pdf-toolbar-height').trim();
    spacer.style.height = cssVar || '56px';
  }, { once: true });

  // Fallback immédiat si déjà chargé
  const cssVar = getComputedStyle(document.documentElement)
    .getPropertyValue('--viewer-pdf-toolbar-height').trim();
  spacer.style.height = cssVar || '56px';
}

function toggleRulesDrawer() {
  const drawer = document.getElementById('rulesDrawer');
  const btn    = document.getElementById('btnRulesToggle');
  if (!drawer) return;
  const isOpen = drawer.style.display !== 'none';
  drawer.style.display = isOpen ? 'none' : 'block';
  if (btn) btn.classList.toggle('active', !isOpen);
}

// Synchronise le badge du tiroir avec celui de la barre
function syncRuleBadge() {
  const count = document.getElementById('ocrRuleCount')?.textContent || '0';
  const badge = document.getElementById('ocrRuleCountDrawer');
  if (badge) badge.textContent = count;
}

function updateSidePane() {
  // Côté gauche : original (PDF ou texte)
  if (!State.sourceIsText && State.sourceBlobUrl) {
    const iframe = document.getElementById('pdfPreviewSide');
    if (iframe) { iframe.src = State.sourceBlobUrl; iframe.style.display = 'block'; }
    const sideOrig = document.getElementById('textViewerSideOrig');
    if (sideOrig) sideOrig.style.display = 'none';
  } else {
    const iframe = document.getElementById('pdfPreviewSide');
    if (iframe) { iframe.style.display = 'none'; }
    const sideOrig = document.getElementById('textViewerSideOrig');
    if (sideOrig) {
      sideOrig.style.display = 'block';
      sideOrig.textContent = State.rawText || '';
    }
  }

  // Côté droit : texte corrigé (non éditable)
  const sideCorr = document.getElementById('textViewerSideCorr');
  if (sideCorr) {
    sideCorr.textContent = State.processedText || State.rawText || '';
  }
}

// Surcharger refreshViewer pour aussi mettre à jour le panneau side si actif
const _origRefreshViewer = refreshViewer;
// Note: refreshViewer est redéfinie pour mettre à jour le side pane si actif

// ── Overlay original (mobile) ─────────────────────────────────────────────────

function openOriginalOverlay() {
  const overlay = document.getElementById('origOverlay');
  if (!overlay) return;

  const iframe  = document.getElementById('pdfOverlay');
  const textDiv = document.getElementById('textViewerOverlay');

  if (!State.sourceIsText && State.sourceBlobUrl) {
    // PDF
    iframe.src          = State.sourceBlobUrl;
    iframe.style.display  = 'block';
    textDiv.style.display = 'none';
  } else if (State.rawText) {
    // TXT / DOCX
    iframe.style.display  = 'none';
    textDiv.style.display = 'block';
    textDiv.textContent   = State.rawText;
  } else {
    showToast('Aucun document chargé');
    return;
  }

  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden'; // bloquer scroll arrière-plan
}

function closeOriginalOverlay() {
  const overlay = document.getElementById('origOverlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
}

// ── Menu contextuel éditeur ───────────────────────────────────────────────────

const CtxMenu = {
  targetWord:   '',   // mot sur lequel on a cliqué
  targetEntId:  null, // id de l'entité correspondante (si trouvée)
  targetSpan:   null, // span DOM ciblé (pour occurrence courante)
};

// Initialiser le menu contextuel sur le viewer
(function initCtxMenu() {
  document.addEventListener('DOMContentLoaded', () => {
    const viewer = document.getElementById('textViewer');
    if (!viewer) return;

    // Bloquer le menu natif du navigateur sur le viewer en permanence
    viewer.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();

      const target = e.target;
      let word = '';

      // Priorité 1 : span surligné sous le curseur
      if (target.classList.contains('hl-entity-found') ||
          target.classList.contains('hl-rule') ||
          target.classList.contains('hl-search-in-rule')) {
        word = target.textContent.trim();
      } else {
        // Priorité 2 : sélection en cours
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
          word = sel.toString().trim();
        }
        // Priorité 3 : mot sous le curseur (caretRangeFromPoint)
        if (!word) word = getWordAtCaret(e);
      }

      if (!word) return;

      // Chercher l'entité correspondante (valeur ou alias)
      const wordLower = word.toLowerCase();
      const ent = State.entities.find(ent =>
        ent.value.toLowerCase() === wordLower ||
        (ent.aliases || []).some(a => a.toLowerCase() === wordLower)
      );

      CtxMenu.targetWord  = word;
      CtxMenu.targetEntId = ent?.id || null;
      CtxMenu.targetSpan  = (target.classList.contains('hl-entity-found') ||
                             target.classList.contains('hl-rule') ||
                             target.classList.contains('hl-search-in-rule'))
                            ? target : null;

      showCtxMenu(e.clientX, e.clientY, word, !!ent);
    });

    // Fermer si clic gauche ailleurs (inclut le sous-menu pour ne pas le fermer prématurément)
    document.addEventListener('click', e => {
      if (!e.target.closest('#ctxMenu') && !e.target.closest('#ctxSubmenu')) closeCtxMenu();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtxMenu(); });

    // Fermer le sous-menu avec délai annulable (évite la fermeture lors du passage trigger → sous-menu)
    setTimeout(() => {
      const trigger = document.getElementById('ctxAnonymiserTrigger');
      const submenu = document.getElementById('ctxSubmenu');
      if (!trigger || !submenu) return;

      let _closeTimer = null;

      function scheduleClose() {
        _closeTimer = setTimeout(() => closeCtxSubmenu(), 300);
      }
      function cancelClose() {
        if (_closeTimer) { clearTimeout(_closeTimer); _closeTimer = null; }
      }

      trigger.addEventListener('mouseleave', scheduleClose);
      trigger.addEventListener('mouseenter', cancelClose);
      submenu.addEventListener('mouseenter', cancelClose);
      submenu.addEventListener('mouseleave', scheduleClose);
    }, 500);
  });
})();

function getWordAtCaret(e) {
  // Récupère le mot sous le pointeur via caretRangeFromPoint
  let range;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(e.clientX, e.clientY);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
    if (!pos) return '';
    range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
  } else return '';

  if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return '';

  const text   = range.startContainer.textContent;
  const offset = range.startOffset;
  const before = text.slice(0, offset).match(/[\wÀ-ÿ]+$/)?.[0] || '';
  const after  = text.slice(offset).match(/^[\wÀ-ÿ]+/)?.[0] || '';
  return before + after;
}

function showCtxMenu(x, y, word, hasEntity) {
// Fermer le popover de sélection s'il est ouvert
hideSelectionPopover();
  const menu  = document.getElementById('ctxMenu');
  const label = document.getElementById('ctxMenuLabel');
  if (!menu) return;

  label.textContent = `"${word}"`;

  // Adapter les items selon contexte
  document.getElementById('ctxMenu').querySelector('[onclick="ctxBlockEntity()"]')
    .style.display = hasEntity ? 'block' : 'none';
  document.getElementById('ctxMenu').querySelector('[onclick="ctxRemoveEntity()"]')
    .style.display = hasEntity ? 'block' : 'none';

  // Afficher "Initiale de prénom" si pertinent
  _updateInitialeBtnVisibility(word);

  // Positionner sans déborder de l'écran
  menu.style.display = 'block';
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth,  vh = window.innerHeight;
  menu.style.left = Math.min(x, vw - mw - 8) + 'px';
  menu.style.top  = Math.min(y, vh - mh - 8) + 'px';
}

function closeCtxMenu() {
  const menu = document.getElementById('ctxMenu');
  if (menu) menu.style.display = 'none';
  closeCtxSubmenu();
}

// ── Actions du menu contextuel ────────────────────────────────────────────────

function ctxBlockEntity() {
  closeCtxMenu();
  const word = CtxMenu.targetWord;
  if (!word) return;

  // Ajouter à la blacklist
  Analysis.addToBlacklist([word]);
  Server.saveBlacklist([...Analysis.getBlacklistWords()]).catch(() => {});

  // Bloquer l'entité si elle existe
  if (CtxMenu.targetEntId) {
    const ent = State.entities.find(e => e.id === CtxMenu.targetEntId);
    if (ent) { ent.blocked = true; ent.active = false; }
  } else {
    // Supprimer tous les fragments qui matchent
    State.entities = State.entities.filter(e =>
      e.value.toLowerCase() !== word.toLowerCase()
    );
  }

  renderEntityTable(State.entities);
  refreshViewer();
  showToast(`"${word}" exclu de l'anonymisation + blacklisté`);
}

function ctxRemoveEntity() {
  closeCtxMenu();
  if (!CtxMenu.targetEntId) {
    // Chercher par valeur
    State.entities = State.entities.filter(e =>
      e.value.toLowerCase() !== CtxMenu.targetWord.toLowerCase()
    );
  } else {
    State.entities = State.entities.filter(e => e.id !== CtxMenu.targetEntId);
  }
  renderEntityTable(State.entities);
  refreshViewer();
  showToast(`"${CtxMenu.targetWord}" retiré de la liste`);
}

function ctxToOcrRule() {
  closeCtxMenu();
  goToStep(2);
  setTimeout(() => {
    const fromEl = document.getElementById('ocrFrom');
    if (fromEl) {
      fromEl.value = CtxMenu.targetWord;
      fromEl.focus();
      // Ouvrir le tiroir règles si fermé
      const drawer = document.getElementById('rulesDrawer');
      if (drawer && drawer.style.display === 'none') toggleRulesDrawer();
      document.getElementById('ocrTo')?.focus();
    }
  }, 300);
}

function ctxAddEntity() {
  // Compatibilité — redirige vers ctxAssignRole NOM par défaut
  ctxAssignRole('NOM', null);
}

// ── Sous-menu Anonymiser ──────────────────────────────────────────────────────

function openCtxSubmenu() {
  const sub     = document.getElementById('ctxSubmenu');
  const trigger = document.getElementById('ctxAnonymiserTrigger');
  const menu    = document.getElementById('ctxMenu');
  if (!sub || !trigger || !menu) return;

  // Rendre visible mais hors écran d'abord pour mesurer
  sub.style.visibility = 'hidden';
  sub.style.display    = 'block';

  // Positionner au frame suivant (dimensions disponibles après rendu)
  requestAnimationFrame(() => {
    const mRect = menu.getBoundingClientRect();
    const tRect = trigger.getBoundingClientRect();
    const vw    = window.innerWidth;
    const vh    = window.innerHeight;
    const subW  = sub.offsetWidth  || 220;
    const subH  = sub.offsetHeight || 300;

    let left = mRect.right + 4;
    let top  = tRect.top;

    // Débordement à droite → afficher à gauche
    if (left + subW > vw - 8) left = mRect.left - subW - 4;

    // Débordement en bas → remonter
    if (top + subH > vh - 8) top = Math.max(8, vh - subH - 8);

    sub.style.left       = left + 'px';
    sub.style.top        = top  + 'px';
    sub.style.visibility = 'visible';
  });
}

function closeCtxSubmenu() {
  const sub = document.getElementById('ctxSubmenu');
  if (sub) sub.style.display = 'none';
}

/**
 * Assigne un rôle procédural à l'entité sélectionnée dans le menu contextuel.
 *
 * @param {string}      role      'NOM' | 'DEMANDEUR' | 'DEFENDEUR' |
 *                                'COUPLE_DEMANDEUR' | 'COUPLE_DEFENDEUR' |
 *                                'FAMILLE_DEMANDEUR' | 'FAMILLE_DEFENDEUR'
 * @param {string|null} civility  'Mme' | 'Madame' | 'M.' | 'Monsieur' | 'Me' | null
 */
function ctxAssignRole(role, civility) {
  closeCtxMenu();
  const word = CtxMenu.targetWord;
  if (!word) return;

  // Calculer le numéro d'ordre pour les rôles DEMANDEUR / DEFENDEUR
  // On compte les entités déjà assignées au même rôle de base
  function nextOrdre(baseRole) {
    const prefix = baseRole.toLowerCase();
    return State.entities.filter(e =>
      e.type && e.type.toLowerCase().startsWith(prefix)
    ).length + 1;
  }

  // Construire le type final avec numéro d'ordre si applicable
  let finalType = role;
  if (['DEMANDEUR', 'DEFENDEUR', 'COUPLE_DEMANDEUR', 'COUPLE_DEFENDEUR',
       'FAMILLE_DEMANDEUR', 'FAMILLE_DEFENDEUR'].includes(role)) {
    const ordre = nextOrdre(role);
    finalType = `${role}_${ordre}`;
  }

  // Chercher une entité existante (valeur ou alias)
  let ent = State.entities.find(e =>
    e.value.toLowerCase() === word.toLowerCase() ||
    (e.aliases || []).some(a => a.toLowerCase() === word.toLowerCase())
  );

  if (ent) {
    // Mettre à jour le type et la civilité de l'entité existante
    ent.type           = finalType;
    ent.label          = finalType;
    ent.forcedCivility = civility || null;
  } else {
    // Créer une nouvelle entité
    ent = {
      id:             `ctx_${Date.now()}`,
      value:          word,
      type:           finalType,
      label:          finalType,
      occurrences:    1,
      aliases:        [],
      active:         true,
      blocked:        false,
      manual:         true,
      forcedCivility: civility || null,
    };
    State.entities.unshift(ent);
  }

  // Synchroniser State.parties si rôle procédural
  _syncPartyFromEntity(ent, role, civility);

  renderEntityTable(State.entities);
  refreshViewer();
  autoSave();

  const civilLabel = civility ? `${civility} ` : '';
  showToast(`"${word}" → ${civilLabel}[${finalType}]`);
}

/**
 * Met à jour State.parties après assignation contextuelle.
 * Évite les doublons et maintient la cohérence avec la modale Parties.
 */
function _syncPartyFromEntity(ent, baseRole, civility) {
  if (!['DEMANDEUR', 'DEFENDEUR'].some(r => baseRole.startsWith(r))) return;

  const side = baseRole.startsWith('DEMANDEUR') ? 'demandeurs' : 'defendeurs';
  if (!State.parties[side]) State.parties[side] = [];

  // Mettre à jour si déjà présent, sinon ajouter
  const existing = State.parties[side].find(p => p.entityId === ent.id);
  if (existing) {
    existing.civilite = civility || 'auto';
  } else {
    State.parties[side].push({
      entityId: ent.id,
      label:    ent.value,
      civilite: civility || 'auto',
    });
  }
}

// ── Step 3 : Viewer texte intégré ─────────────────────────────────────────────

const EntityViewer = {
  searchQuery:   '',
  searchMatches: [],
  searchCurrent: -1,
};

// Init séparateur draggable step 3
(function initEntitySplit() {
  document.addEventListener('DOMContentLoaded', () => {
    const divider   = document.getElementById('entitySplitDivider');
    const splitLeft = document.querySelector('.entity-split-left');
    const splitRight = document.getElementById('entitySplitRight');
    if (!divider || !splitLeft || !splitRight) return;

    let dragging = false, startX, startLeftW;

    divider.addEventListener('mousedown', e => {
      dragging   = true;
      startX     = e.clientX;
      startLeftW = splitLeft.getBoundingClientRect().width;
      document.body.style.cursor     = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const contW    = splitLeft.parentElement.getBoundingClientRect().width;
      const newLeftW = Math.max(280, Math.min(contW - 280, startLeftW + e.clientX - startX));
      splitLeft.style.width = newLeftW + 'px';
      splitLeft.style.flex  = 'none';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = document.body.style.userSelect = '';
      localStorage.setItem('entitySplitLeftW', splitLeft.style.width);
    });

    const saved = localStorage.getItem('entitySplitLeftW');
    if (saved) { splitLeft.style.width = saved; splitLeft.style.flex = 'none'; }
  });
})();

/**
 * refreshEntityViewer — reconstruit le surlignage du textViewer
 * en tenant compte des entités actives/bloquées/supprimées.
 * Utilisé en step 3 après toute modification de la liste.
 */
function refreshEntityViewer() {
  // Si on était en mode anonymisé, repasser en mode normal
  const sw = document.getElementById('anonPreviewSwitch');
  if (sw && sw.checked) {
    sw.checked = false;
    const label = document.getElementById('rightPanelLabel');
    if (label) label.textContent = '✏ Texte corrigé';
    const viewer = document.getElementById('textViewer');
    if (viewer) viewer.classList.remove('anon-preview-mode');
  }
  // Reconstruire via refreshViewer (step 2) en mode "entités step 3"
  const prevMode = ViewerState.mode;
  ViewerState.mode = 'corrected';
  refreshViewer();
  ViewerState.mode = prevMode;
  // Ajouter les listeners après le rebuild DOM (setTimeout garantit que innerHTML est fini)
  setTimeout(() => addEntityClickListeners(), 0);
  // Redessiner le surlignage sur le document original si l'overlay est actif
  if (typeof PdfOverlay !== 'undefined' && PdfOverlay.isReady()) {
    PdfOverlay.highlight(State.entities);
  }
}

/**
 * toggleAnonPreview — bascule le textViewer entre vue normale (entités surlignées)
 * et vue prévisualisée anonymisée (placeholders et initiales affichés).
 */
function toggleAnonPreview(active) {
  const viewer = document.getElementById('textViewer');
  if (!viewer) return;

  const label = document.getElementById('rightPanelLabel');

  if (!active) {
    // Retour mode normal
    if (label) label.textContent = '✏ Texte corrigé';
    viewer.classList.remove('anon-preview-mode');
    refreshEntityViewer();
    return;
  }

  // Mode anonymisé : lancer Anonymizer.run() à la volée
  if (label) label.textContent = '🔒 Prévisualisation anonymisée';
  viewer.classList.add('anon-preview-mode');

  const text = _applyCaviardages(State.processedText || State.rawText || '');
  const activeEntities = State.entities.filter(e => e.active && !e.blocked);
const { anonymized, initiales } = Anonymizer.run(text, activeEntities);

  // Afficher en lecture seule avec mise en évidence des placeholders
  viewer.contentEditable = 'false';
viewer.innerHTML = Anonymizer.highlight(anonymized, initiales);}

function addEntityClickListeners() {
  const viewer = document.getElementById('textViewer');
  if (!viewer) return;
  viewer.querySelectorAll('.hl-entity-found').forEach(span => {
    span.classList.add('ev-ent');
    span.style.cursor = 'pointer';
    span.title = 'Cliquer pour localiser dans le tableau';
    // Supprimer un éventuel listener précédent
    span.removeEventListener('click', span._evEntHandler);
    span._evEntHandler = function() {
      if (State.currentStep !== 3) return;
      const text = this.textContent.trim().toLowerCase();
      const ent  = State.entities.find(e =>
        e.value.toLowerCase() === text ||
        (e.aliases||[]).some(a => a.toLowerCase() === text)
      );
      if (ent) highlightEntityRow(ent.id);
    };
    span.addEventListener('click', span._evEntHandler);
  });
}

// Alias pour compatibilité avec l'ancien code
function initEntityViewer() { refreshEntityViewer(); }
function buildEntityViewerHTML() { refreshEntityViewer(); }

/** Scroll vers la première occurrence d'une entité dans le viewer step 3 */
function scrollEntityViewerTo(entValue) {
  const viewer = document.getElementById('textViewer');
  if (!viewer) return;

  // ── Si le viewer est en mode édition, en sortir d'abord ──────────────────
  // Le blur handler reconstruit les spans hl-entity-found via refreshViewer().
  // On attend la fin du rebuild avant de chercher et scroller.
  if (viewer.classList.contains('text-viewer--edit')) {
    viewer.blur();
    // Le blur est synchrone pour la sauvegarde mais refreshViewer() est aussi
    // synchrone → les spans sont disponibles immédiatement après.
    // On utilise un rAF pour laisser le DOM se stabiliser.
    requestAnimationFrame(() => _doScrollEntityViewerTo(viewer, entValue));
    return;
  }

  _doScrollEntityViewerTo(viewer, entValue);
}

function _doScrollEntityViewerTo(viewer, entValue) {
  const normValue = entValue.toLowerCase().trim();

  // Chercher dans .hl-entity-found
  const spans = viewer.querySelectorAll('.hl-entity-found');
  for (const span of spans) {
    if (span.textContent.toLowerCase().trim() === normValue) {
      span.scrollIntoView({ behavior: 'smooth', block: 'center' });
      span.classList.add('hl-entity-flash');
      setTimeout(() => span.classList.remove('hl-entity-flash'), 1200);
      return;
    }
  }

  // Fallback : match partiel
  for (const span of spans) {
    if (span.textContent.toLowerCase().includes(normValue)) {
      span.scrollIntoView({ behavior: 'smooth', block: 'center' });
      span.classList.add('hl-entity-flash');
      setTimeout(() => span.classList.remove('hl-entity-flash'), 1200);
      return;
    }
  }
}

/** Clic sur une ligne du tableau → scroll dans le viewer */
function highlightEntityInViewer(entId) {
  const ent = State.entities.find(e => e.id === entId);
  if (!ent) return;
  scrollEntityViewerTo(ent.value);
  // Mettre en évidence le hint
  const hint = document.getElementById('entityViewerHint');
  if (hint) {
    hint.textContent = `→ "${ent.value}"`;
    hint.style.color = 'var(--primary)';
    setTimeout(() => {
      hint.textContent = '← Cliquez sur une entité';
      hint.style.color = '';
    }, 2000);
  }
}

/** Clic depuis le viewer → scroll vers la ligne du tableau */
function highlightEntityRow(entId) {
  if (!entId) return;
  const row = document.getElementById(`erow_${entId}`);
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('row-flash');
    setTimeout(() => row.classList.remove('row-flash'), 1200);
  }
}

// ── Recherche dans le viewer step 3 ──────────────────────────────────────────

function entityViewerSearch() {
  const input = document.getElementById('entityViewerSearch');
  if (!input) return;
  const query = input.value.normalize('NFC');

  if (!query) { entityViewerClear(); return; }

  ViewerState.searchQuery   = query;
  ViewerState.searchCurrent = -1;
  const prevMode = ViewerState.mode;
  ViewerState.mode = 'corrected';
  refreshViewer();
  ViewerState.mode = prevMode;
  setTimeout(() => {
    addEntityClickListeners();
    EntityViewer.searchMatches  = ViewerState.searchMatches;
    EntityViewer.searchCurrent  = ViewerState.searchCurrent;
    if (EntityViewer.searchMatches.length > 0) entityViewerNavigate(1);
    updateEntitySearchCount();
  }, 0);
}

function entityViewerNavigate(dir) {
  // Respecter le filtre non-couverts si actif
  const activeMatches = ViewerState.searchUncoveredOnly
    ? _getActiveSearchMatches()
    : EntityViewer.searchMatches;

  const total = activeMatches.length;
  if (total === 0) return;

  // Trouver la position courante dans activeMatches
  const currentId = EntityViewer.searchMatches[EntityViewer.searchCurrent];
  let activeCurrent = activeMatches.indexOf(currentId);
  activeCurrent = ((activeCurrent + dir) % total + total) % total;

  document.querySelectorAll('#textViewer .hl-search').forEach(el => el.classList.remove('hl-current'));

  const targetId = activeMatches[activeCurrent];
  // Mettre à jour searchCurrent avec l'index global
  EntityViewer.searchCurrent = EntityViewer.searchMatches.indexOf(targetId);

  const el = document.getElementById(targetId);
  if (el) { el.classList.add('hl-current'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  updateEntitySearchCount();
}

function entityViewerClear() {
  const input = document.getElementById('entityViewerSearch');
  if (input) input.value = '';
  EntityViewer.searchQuery    = '';
  EntityViewer.searchCurrent  = -1;
  EntityViewer.searchMatches  = [];
  ViewerState.searchQuery     = '';
  ViewerState.searchCurrent   = -1;
  ViewerState.searchMatches   = [];
  ViewerState.searchUncoveredOnly = false;
  const btn = document.getElementById('btnEntitySearchUncovered');
  if (btn) btn.classList.remove('active');
  const count = document.getElementById('entitySearchCount');
  if (count) { count.textContent = ''; count.classList.remove('has-uncovered'); }
  refreshEntityViewer();
  updateEntitySearchCount();
}

function toggleEntitySearchUncovered() {
  ViewerState.searchUncoveredOnly = !ViewerState.searchUncoveredOnly;
  const btn = document.getElementById('btnEntitySearchUncovered');
  if (btn) btn.classList.toggle('active', ViewerState.searchUncoveredOnly);
  // Relancer depuis le début dans le nouveau filtre
  EntityViewer.searchCurrent = -1;
  entityViewerNavigate(1);
  updateEntitySearchCount();
}

function updateEntitySearchCount() {
  const el    = document.getElementById('entitySearchCount');
  if (!el) return;

  const allMatches = EntityViewer.searchMatches;
  const total      = allMatches.length;

  if (!total && !EntityViewer.searchQuery) {
    el.textContent = '';
    el.classList.remove('has-uncovered');
    return;
  }

  // Compter les non-couverts (data-covered="0")
  const uncovered = allMatches.filter(id => {
    const span = document.getElementById(id);
    return span && span.dataset.covered === '0';
  }).length;

  const activeMatches = ViewerState.searchUncoveredOnly
    ? _getActiveSearchMatches() : allMatches;
  const activeTotal   = activeMatches.length;
  const currentId     = allMatches[EntityViewer.searchCurrent];
  const activeCur     = activeMatches.indexOf(currentId);
  const cur           = activeCur >= 0 ? activeCur + 1 : 0;

  if (ViewerState.searchUncoveredOnly) {
    el.textContent = activeTotal > 0 ? `${cur}/${activeTotal} non couverts` : '0 non couvert';
    el.title = `${total} occurrence(s) · ${uncovered} non couverte(s)`;
    el.classList.toggle('has-uncovered', uncovered > 0);
  } else {
    el.textContent = total > 0 ? `${cur}/${total}` : '0';
    el.title = uncovered > 0 ? `⚠ ${uncovered} non couvert(s) sur ${total}` : '';
    el.classList.toggle('has-uncovered', uncovered > 0);
  }
}


// ── Accordéon toolbar entités ─────────────────────────────────────────────────
let _entityAccordionOpen = true;

function toggleEntityAccordion() {
  _entityAccordionOpen = !_entityAccordionOpen;
  const acc = document.getElementById('entityAccordion');
  const btn = document.getElementById('entityAccordionBtn');
  if (acc) acc.style.display = _entityAccordionOpen ? 'block' : 'none';
  if (btn) btn.textContent = _entityAccordionOpen ? '▾' : '▸';
  localStorage.setItem('entityAccordionOpen', _entityAccordionOpen ? '1' : '0');
}

// Restaurer l'état au chargement
document.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('entityAccordionOpen');
  if (saved === '0') {
    _entityAccordionOpen = false;
    const acc = document.getElementById('entityAccordion');
    const btn = document.getElementById('entityAccordionBtn');
    if (acc) acc.style.display = 'none';
    if (btn) btn.textContent = '▸';
  }
});

// ── Recherche dans la liste des entités ───────────────────────────────────────

let _entitySearchQuery = '';
let _entitySortAsc     = false; // null = pas de tri, true = A→Z, false = Z→A ... on alterne

function filterEntitiesSearch() {
  _entitySearchQuery = document.getElementById('entitySearch')?.value.toLowerCase().trim() || '';
  renderEntityTable(State.entities);
}

function clearEntitySearch() {
  const input = document.getElementById('entitySearch');
  if (input) input.value = '';
  _entitySearchQuery = '';
  renderEntityTable(State.entities);
}

let _entitySortMode = null; // null | 'asc' | 'desc'

function toggleEntitySort() {
  const btn = document.getElementById('btnSortEntities');
  if (_entitySortMode === null || _entitySortMode === 'desc') {
    _entitySortMode = 'asc';
    if (btn) btn.textContent = '⇅ A→Z';
  } else {
    _entitySortMode = 'desc';
    if (btn) btn.textContent = '⇅ Z→A';
  }
  renderEntityTable(State.entities);
}

// ── Popup de confirmation fusion ──────────────────────────────────────────────

let _mergeSelection = []; // entités à fusionner après confirmation

function mergeDuplicateEntities() {
  const checked = State.entities.filter(e => e.active && !e.blocked);
  if (checked.length < 2) {
    showToast('Cochez au moins 2 entités à fusionner');
    return;
  }

  // Dédupliquer la sélection (valeurs strictement identiques)
  const seenM = new Set();
  const unique = checked.filter(e => {
    const k = e.value.toLowerCase().trim();
    if (seenM.has(k)) return false;
    seenM.add(k); return true;
  });
  if (unique.length < 2) {
    showToast('Les entités cochées sont des doublons exacts — fusion inutile');
    renderEntityTable(State.entities); // nettoyer les doublons
    return;
  }

  _mergeSelection = unique.map(e => ({ ...e, _include: true }));
  renderMergeConfirmList();
  document.getElementById('mergeConfirmOverlay').style.display = 'flex';
}

function renderMergeConfirmList() {
  const list = document.getElementById('mergeConfirmList');
  if (!list) return;
  list.innerHTML = _mergeSelection.map((ent, i) => `
    <div class="merge-confirm-item ${i === 0 ? 'merge-canonical' : ''}">
      <input type="checkbox" ${ent._include ? 'checked' : ''}
        onchange="_mergeSelection[${i}]._include = this.checked; renderMergeConfirmList()">
      <span class="merge-item-value">${escHtml(ent.value)}</span>
      <div class="merge-item-actions">
        ${i === 0
          ? '<span class="merge-canonical-badge">canonique</span>'
          : `<button class="btn-sm btn-outline merge-swap-btn"
               onclick="swapMergeCanonical(${i})" title="Définir comme canonique">
               ↑ Rendre canonique
             </button>
             <span class="merge-alias-badge">alias</span>`
        }
      </div>
    </div>
  `).join('');
}

function swapMergeCanonical(idx) {
  if (idx === 0) return;
  // Déplacer l'entité idx en position 0 (canonique)
  const [newCanon] = _mergeSelection.splice(idx, 1);
  _mergeSelection.unshift(newCanon);
  renderMergeConfirmList();
}

function closeMergeConfirm() {
  document.getElementById('mergeConfirmOverlay').style.display = 'none';
  _mergeSelection = [];
}

function confirmMerge() {
  const toMerge = _mergeSelection.filter(e => e._include);
  if (toMerge.length < 2) {
    showToast('Gardez au moins 2 entités cochées pour fusionner');
    return;
  }

  const canonical = toMerge[0];
  const aliases   = toMerge.slice(1);
  const aliasIds  = new Set(aliases.map(e => e.id));

  // Trouver l'entité canonique dans State.entities et lui ajouter les alias
  const canonEnt = State.entities.find(e => e.id === canonical.id);
  if (!canonEnt) { closeMergeConfirm(); return; }

  aliases.forEach(a => {
    if (!canonEnt.aliases.includes(a.value)) canonEnt.aliases.push(a.value);
    // Ajouter aussi les alias des entités fusionnées
    (a.aliases || []).forEach(al => {
      if (!canonEnt.aliases.includes(al)) canonEnt.aliases.push(al);
    });
  });

  // Supprimer les entités fusionnées (sauf la canonique)
  State.entities = State.entities.filter(e => !aliasIds.has(e.id));

  closeMergeConfirm();
  renderEntityTable(State.entities);
  if (State.currentStep === 3) refreshEntityViewer();
  showToast(`Fusion : "${canonEnt.value}" + ${aliases.length} alias`);
}

// ── Caviardage ────────────────────────────────────────────────────────────────

const CaviarState = {
  word:     '',   // mot ou phrase à caviarder
  isPhrase: false, // true si sélection multi-mots
  position: null   // index dans le texte pour "occurrence courante"
};

const CAVIAR_STYLES = {
  supprime: '[SUPPRIMÉ]',
  blocks:   '████████',
  vide:     '',
};

/** Ouvre le popup de caviardage pour un mot donné */
/** Ouvre le gestionnaire de caviardages (liste + annulation) */
function openCaviarManager() {
  renderCaviarList();
  document.getElementById('caviarManagerOverlay').style.display = 'flex';
}
function closeCaviarManager() {
  document.getElementById('caviarManagerOverlay').style.display = 'none';
}

/** Met à jour le badge du bouton Caviardages */
function _updateCaviarBadge() {
  const badge = document.getElementById('caviarBadge');
  if (!badge) return;
  const n = (State.caviardages || []).length;
  badge.textContent = n;
  badge.style.display = n > 0 ? 'inline-block' : 'none';
}

/** Affiche/met à jour la liste dans le gestionnaire */
function renderCaviarList() {
  const items = document.getElementById('caviarListItems');
  const empty = document.getElementById('caviarListEmpty');
  if (!items) return;
  const cavs = State.caviardages || [];
  if (empty) empty.style.display = cavs.length === 0 ? 'block' : 'none';
  _updateCaviarBadge();
  items.innerHTML = cavs.map((cav, idx) => {
    const repl  = cav.replacement || '(vide)';
    const scope = cav.scope === 'current' ? '1 occurrence' : 'toutes';
    return `<div class="caviar-list-item">
      <span class="caviar-list-word">${escHtml(cav.word)}</span>
      <span class="caviar-list-arrow">→</span>
      <span class="caviar-list-repl">${escHtml(repl)}</span>
      <span class="caviar-list-scope">(${scope})</span>
      <button class="caviar-list-cancel" onclick="annulerCaviardage(${idx})" title="Annuler ce caviardage">✕</button>
    </div>`;
  }).join('');
}

/** Annule un caviardage par son index */
function annulerCaviardage(idx) {
  if (!State.caviardages) return;
  const word = State.caviardages[idx]?.word || '';
  State.caviardages.splice(idx, 1);
  renderCaviarList();
  autoSave();
  refreshViewer();
  const sw = document.getElementById('anonPreviewSwitch');
  if (sw && sw.checked) toggleAnonPreview(true);
  showToast(`Caviardage annulé : "${word}"`);
}

function openCaviar(word, position) {
  if (!word) return;
  CaviarState.word     = word;
  CaviarState.position = position ?? null;
  const target = document.getElementById('caviarTarget');
  if (target) target.textContent = `"${word}"`;
  const defRadio = document.querySelector('[name="caviarStyle"][value="supprime"]');
  if (defRadio) defRadio.checked = true;
  const custom = document.getElementById('caviarCustom');
  if (custom) custom.value = '';
  const allScope = document.querySelector('[name="caviarScope"][value="all"]');
  if (allScope) allScope.checked = true;
  document.getElementById('caviarOverlay').style.display = 'flex';
}

function closeCaviar() {
  document.getElementById('caviarOverlay').style.display = 'none';
  CaviarState.word = '';
}

/**
 * Applique les caviardages stockés sur un texte (copie locale).
 * Utilisé par runAnonymization() et toggleAnonPreview().
 */
function _applyCaviardages(text) {
  if (!State.caviardages || !State.caviardages.length) return text;
  for (const cav of State.caviardages) {
    const pattern = Anonymizer.flexPattern(cav.word.normalize('NFC'));
    let re;
    try { re = new RegExp(pattern, 'gi'); }
    catch { re = new RegExp(cav.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); }
    if (cav.scope === 'current' && cav.position != null) {
      re.lastIndex = cav.position;
      const m = re.exec(text);
      if (m) { text = text.slice(0, m.index) + cav.replacement + text.slice(m.index + m[0].length); continue; }
      re.lastIndex = 0;
      const m2 = re.exec(text);
      if (m2) text = text.slice(0, m2.index) + cav.replacement + text.slice(m2.index + m2[0].length);
    } else {
      re.lastIndex = 0;
      text = text.replace(re, cav.replacement);
    }
  }
  return text;
}

function applyCaviar() {
  const word = CaviarState.word;
  if (!word) return;

  const style = document.querySelector('[name="caviarStyle"]:checked')?.value || 'supprime';
  let replacement;
  if (style === 'custom') {
    replacement = document.getElementById('caviarCustom')?.value || '[SUPPRIMÉ]';
  } else {
    replacement = CAVIAR_STYLES[style] ?? '[SUPPRIMÉ]';
  }

  const scope = document.querySelector('[name="caviarScope"]:checked')?.value || 'all';

  // Stocker le caviardage — le texte source n'est PAS modifié
  if (!State.caviardages) State.caviardages = [];
  const already = State.caviardages.findIndex(c =>
    c.word.toLowerCase() === word.toLowerCase() && c.scope === scope
  );
  const entry = { word, replacement, scope, position: CaviarState.position ?? null };
  if (already >= 0) State.caviardages[already] = entry;
  else State.caviardages.push(entry);

  // Compter les occurrences pour le toast (sans modifier le texte)
  const text = State.processedText || State.rawText || '';
  let count = 0;
  try {
    const re = new RegExp(Anonymizer.flexPattern(word.normalize('NFC')), 'gi');
    count = (text.match(re) || []).length;
  } catch { count = 0; }

  closeCaviar();
  autoSave();
  refreshViewer();
  const sw = document.getElementById('anonPreviewSwitch');
  if (sw && sw.checked) toggleAnonPreview(true);
  // Rafraîchir le panneau oublis si actif — le mot caviardé ne doit plus apparaître
  if (typeof OublisPanel !== 'undefined' && OublisPanel._isActive && OublisPanel._isActive()) {
    OublisPanel.run();
  }
  showToast(`✂ ${count} occurrence(s) caviardée(s) → "${replacement || '(supprimé)'}" (visible en mode anonymisé)`);
}

/** Depuis le menu contextuel */
function ctxCaviarder() {
  closeCtxMenu();
  // Passer la position dans le texte brut pour permettre "occurrence courante"
  const text = State.processedText || State.rawText || '';
  const word = CtxMenu.targetWord || '';
  const pos  = word ? text.toLowerCase().indexOf(word.toLowerCase()) : null;
  openCaviar(word, pos >= 0 ? pos : null);
}

/** Depuis la liste des entités — caviarder toutes les occurrences d'une entité */
function caviarderEntity(entId) {
  const ent = State.entities.find(e => e.id === entId);
  if (!ent) return;
  openCaviar(ent.value);
}

/** Retire de la liste les entités DÉCOCHÉES (active=false), sans les blacklister.
 * Respecte le filtre de type actif si présent. Annulable via Ctrl+Z. */
function retireDecochees() {
  const scope = _currentFilter
    ? State.entities.filter(e => e.type === _currentFilter && !e.active && !e.blocked)
    : State.entities.filter(e => !e.active && !e.blocked);
  const scopeLabel = _currentFilter ? ` (type « ${_currentFilter} »)` : '';

  if (scope.length === 0) {
    showToast(`Aucune entité décochée${scopeLabel} à retirer`);
    return;
  }

  pushUndo(`Retrait ${scope.length} décochée(s)${scopeLabel}`);
  const removeIds = new Set(scope.map(e => e.id));
  State.entities = State.entities.filter(e => !removeIds.has(e.id));
  renderEntityTable(State.entities);
  if (typeof renderEntityTableModal === 'function') renderEntityTableModal();
  if (State.currentStep === 3) refreshEntityViewer();
  showToast(`⊘ ${scope.length} entité(s) décochée(s) retirée(s)${scopeLabel} sans blacklister`);
}

/** Retire de la liste les entités COCHÉES (active=true), sans les blacklister.
 * Respecte le filtre de type actif si présent. Annulable via Ctrl+Z. */
function retireCochees() {
  const scope = _currentFilter
    ? State.entities.filter(e => e.type === _currentFilter && e.active && !e.blocked)
    : State.entities.filter(e => e.active && !e.blocked);
  const scopeLabel = _currentFilter ? ` (type « ${_currentFilter} »)` : '';

  if (scope.length === 0) {
    showToast(`Aucune entité cochée${scopeLabel} à retirer`);
    return;
  }

  pushUndo(`Retrait ${scope.length} cochée(s)${scopeLabel}`);
  const removeIds = new Set(scope.map(e => e.id));
  State.entities = State.entities.filter(e => !removeIds.has(e.id));
  renderEntityTable(State.entities);
  if (typeof renderEntityTableModal === 'function') renderEntityTableModal();
  if (State.currentStep === 3) refreshEntityViewer();
  showToast(`⊘ ${scope.length} entité(s) cochée(s) retirée(s)${scopeLabel} sans blacklister`);
}

// ── Modale entités pleine largeur ─────────────────────────────────────────────

let _modalSortMode  = null;
let _modalSearchQ   = '';
let _modalFilter    = '';

function openEntitiesModal() {
  const modal = document.getElementById('entitiesModal');
  if (!modal) return;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Remplir le tableau modal
  renderEntityTableModal();

  // Déplacer le textViewer dans le slot de la modale
  const viewer = document.getElementById('textViewer');
  const slot   = document.getElementById('entitiesModalViewer');
  if (viewer && slot && viewer.parentElement !== slot) {
    slot.appendChild(viewer);
  }

  // Synchroniser l'état du hint sélection (si actif en mode normal → l'afficher dans modal)
  const hint3      = document.getElementById('viewerHintStep3');
  const hint3M     = document.getElementById('viewerHintStep3Modal');
  const hint3Label = document.getElementById('viewerHintStep3Label');
  const hint3LabelM = document.getElementById('viewerHintStep3LabelModal');
  const evHintM    = document.getElementById('entityViewerHintModal');
  if (hint3M) {
    const isHintVisible = hint3 && hint3.style.display !== 'none';
    hint3M.style.display = isHintVisible ? 'inline-flex' : 'none';
    if (hint3LabelM && hint3Label) hint3LabelM.textContent = hint3Label.textContent;
    if (evHintM) evHintM.style.display = isHintVisible ? 'none' : 'inline';
  }

  // Attendre que la modale soit visible avant de refresher et d'init le séparateur
  requestAnimationFrame(() => {
    refreshEntityViewer();
    // Séparateur draggable — utiliser l'ID du div gauche
    const leftEl = modal.querySelector('.entities-modal-left');
    if (leftEl && !leftEl.id) leftEl.id = 'entitiesModalLeft';
    initDraggableDivider('entitiesModalDivider', 'entitiesModalLeft', null, 'entitiesModalLeftW', null);
  });
}

function closeEntitiesModal() {
  const modal = document.getElementById('entitiesModal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
  // Remettre le textViewer dans viewerWrap (son slot d'origine)
  const viewer   = document.getElementById('textViewer');
  const wrapSlot = document.getElementById('viewerWrap');
  if (viewer && wrapSlot && viewer.parentElement !== wrapSlot) {
    wrapSlot.appendChild(viewer);
  }
  // Sync tableau principal + rebuild numérotation
  renderEntityTable(State.entities);
  requestAnimationFrame(() => {
    // Reconstruire la numérotation après réinsertion dans le DOM
    const viewer = document.getElementById('textViewer');
    if (viewer) {
      const lines = viewer.querySelectorAll('.viewer-line');
      if (lines.length) updateViewerGutter(lines.length);
      else {
        const plain = viewer.textContent || '';
        updateViewerGutter(plain.split('\n').length);
      }
      _syncGutterScroll();
    }
    if (typeof refreshEntityViewer === 'function') refreshEntityViewer();
  });
}

function renderEntityTableModal() {
  let filtered = _modalFilter
    ? State.entities.filter(e => e.type === _modalFilter)
    : [...State.entities];

  if (_modalSearchQ) {
    filtered = filtered.filter(e =>
      e.value.toLowerCase().includes(_modalSearchQ) ||
      (e.aliases || []).some(a => a.toLowerCase().includes(_modalSearchQ))
    );
  }
  if (_modalSortMode === 'asc') filtered.sort((a,b) => a.value.localeCompare(b.value, 'fr', {sensitivity:'base'}));
  if (_modalSortMode === 'desc') filtered.sort((a,b) => b.value.localeCompare(a.value, 'fr', {sensitivity:'base'}));

  const tbody = document.getElementById('entityTbodyModal');
  const countEl  = document.getElementById('entityCountModal');
  const activeEl = document.getElementById('entityActiveModal');
  const bulk     = document.getElementById('bulkActionsModal');

  if (countEl)  countEl.textContent  = State.entities.length;
  if (activeEl) activeEl.textContent = State.entities.filter(e => e.active && !e.blocked).length;
  if (bulk)     bulk.style.display   = filtered.length > 0 ? 'flex' : 'none';

  if (!tbody) return;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--ink4);padding:20px">Aucune entité.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(ent => {
    const inactive = !ent.active || ent.blocked;
    return `<tr class="${inactive ? 'inactive' : ''}" id="erow_modal_${ent.id}">
      <td class="col-check">
        <input type="checkbox" ${ent.active && !ent.blocked ? 'checked' : ''}
          ${ent.blocked ? 'disabled' : ''}
          onchange="toggleEntity('${ent.id}', this.checked)">
      </td>
      <td class="col-value" onclick="highlightEntityInViewer('${ent.id}')" style="cursor:pointer">
        <span class="entity-value ${ent.blocked ? 'blocked' : ''}">${escHtml(ent.value)}</span>
        ${ent.manual ? '<span class="tag-manual">manuel</span>' : ''}
      </td>
      <td class="col-type">
        <select class="type-select type-${ent.type}" onchange="changeEntityType('${ent.id}', this.value)">
          ${(() => {
            const allTypes = getAllTypes();
            const known = allTypes.find(t => t.id === ent.type);
            const extra = !known
              ? `<option value="${escAttr(ent.type)}" selected>${escHtml(ent.type)}</option>`
              : '';
            return extra + allTypes.map(t =>
              `<option value="${escAttr(t.id)}" ${ent.type === t.id ? 'selected' : ''}>${escHtml(t.label)}</option>`
            ).join('');
          })()}
        </select>
      </td>
      <td class="col-occ">${ent.occurrences || '—'}</td>
      <td class="col-actions">
        <button class="btn-icon-sm" onclick="caviarderEntity('${ent.id}')" title="Caviarder">✂</button>
        <button class="btn-icon-sm" onclick="blockEntity('${ent.id}')"
          title="${ent.blocked ? 'Débloquer' : 'Blacklister'}">${ent.blocked ? '✓' : '⛔'}</button>
        <button class="btn-icon-sm btn-delete" onclick="deleteEntity('${ent.id}')" title="Supprimer">🗑</button>
      </td>
    </tr>`;
  }).join('');
}

function filterEntitiesSearchModal() {
  _modalSearchQ = document.getElementById('entitySearchModal')?.value.toLowerCase().trim() || '';
  renderEntityTableModal();
}
function clearEntitySearchModal() {
  const i = document.getElementById('entitySearchModal');
  if (i) i.value = '';
  _modalSearchQ = '';
  renderEntityTableModal();
}
function filterEntitiesModal() {
  _modalFilter = document.getElementById('typeFilterModal')?.value || '';
  renderEntityTableModal();
}
function toggleEntitySortModal() {
  const btn = document.querySelector('[onclick="toggleEntitySortModal()"]');
  _modalSortMode = _modalSortMode === 'asc' ? 'desc' : 'asc';
  if (btn) btn.textContent = _modalSortMode === 'asc' ? '⇅ A→Z' : '⇅ Z→A';
  renderEntityTableModal();
}

// Rafraîchir la modale si ouverte après toute modif d'entités
const _origRenderEntityTable = renderEntityTable;
// On hook renderEntityTable pour aussi rafraîchir la modale
const _hookedRender = renderEntityTable;

// ════════════════════════════════════════════════════════════════════════════
// SESSION : Auto-save + Export/Import complet
// ════════════════════════════════════════════════════════════════════════════

const SESSION_KEY = 'anonymiseur_session';
let _autoSaveTimer = null;

// ── Auto-save ─────────────────────────────────────────────────────────────────

/** Déclenche un auto-save avec debounce 3s */
function scheduleAutoSave() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(autoSave, 3000);
}

function autoSave() {
  if (!State.rawText) return; // Rien à sauvegarder
  try {
    const session = buildSessionData();
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    const now = new Date().toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
    updateAutoSaveStatus(`✓ Sauvegarde auto ${now}`);
  } catch (e) {
    updateAutoSaveStatus('⚠ Sauvegarde auto échouée (localStorage plein ?)');
  }
}

function updateAutoSaveStatus(msg) {
  const el = document.getElementById('autoSaveStatus');
  if (el) el.textContent = msg;
}

/** Construit l'objet session complet */
function buildSessionData() {
  return {
    version:         '2.9',
    savedAt:         new Date().toISOString(),
    originalText:    State.originalText  || State.rawText || '',
    rawText:         State.rawText       || '',
    processedText:   State.processedText || '',
    entities:        State.entities,
    blacklist:       [...(Analysis.getBlacklistWords?.() || [])],
    ocrRules:        Storage.getOcrRules?.() || [],
    customTypes:     State.customTypes      || [],
    parties:         State.parties          || { demandeurs: [], defendeurs: [] },
    partiesKeywords: State.partiesKeywords  || {},
    initialesMap:    State.initialesMap     || {},
    currentStep:     State.currentStep,
    sourceFileName:  State.sourceFileName || '',
    concordance:     State.result ? State.result.concordance : [],
    anonymized:      State.result ? State.result.anonymized  : '',
    caviardages:     State.caviardages || [],
    scanIgnored:     State.scanIgnored  || [],
  };
}

// Accrocher scheduleAutoSave sur les modifications clés
const _origRefreshViewerForSession = refreshViewer;
// Hook sur refreshViewer (appelé après chaque modif texte)
const __origRefreshViewer = refreshViewer;

// ── Export session ────────────────────────────────────────────────────────────

function exportSession() {
  const session = buildSessionData();
  const json    = JSON.stringify(session, null, 2);
  const fname   = buildFileName('session_anonymiseur', 'json');
  const blob    = new Blob([json], { type: 'application/json' });
  const url     = URL.createObjectURL(blob);
  const a       = document.createElement('a');
  a.href = url; a.download = fname; a.click();
  URL.revokeObjectURL(url);
  showToast(`📦 Session exportée : ${fname}`);
}

// ── Import session ────────────────────────────────────────────────────────────

function triggerImportSession() {
  document.getElementById('sessionFileInput')?.click();
}

async function importSession(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  // Réinitialiser pour permettre de recharger le même fichier
  event.target.value = '';
  try {
    const text    = await file.text();
    const session = JSON.parse(text);

    if (!session.rawText && !session.processedText) {
      alert('Fichier de session invalide ou vide.');
      return;
    }

    const ok1 = await showConfirm({
      title: 'Reprendre cette session ?',
      body: `Session du <strong>${new Date(session.savedAt).toLocaleString('fr-FR')}</strong><br>
             <span style="color:var(--ink3);font-size:12px">Cela remplacera le document et les entités actuels.</span>`,
      ok: '✓ Reprendre',
      cancel: 'Annuler',
      icon: '📂'
    });
    if (!ok1) return;

    // Restaurer l'état
    State.rawText       = session.rawText       || '';
    State.rawText       = State.rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    State.originalText  = session.originalText  || State.rawText;
    State.processedText = session.processedText || State.rawText;
    State.processedText = State.processedText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    State.entities      = (session.entities || []).map(e => ({
      id: e.id || `imp_${Math.random().toString(36).substr(2,9)}`,
      value: e.value, type: e.type || 'NOM', label: e.label || e.type || 'NOM',
      occurrences: e.occurrences || 0, aliases: e.aliases || [],
      active: e.active !== false, blocked: e.blocked || false, manual: true
    }));
    State.customTypes      = session.customTypes      || [];
    State.parties          = session.parties          || { demandeurs: [], defendeurs: [] };
    State.partiesKeywords  = session.partiesKeywords  || State.partiesKeywords;
    State.initialesMap     = session.initialesMap      || {};
    State.currentStep   = 2;
    State.sourceFileName = session.sourceFileName || '';
    State.stepsUnlocked = [1, 2, 3, 4];

    // Restaurer la concordance si présente
    if (session.caviardages?.length) State.caviardages = session.caviardages;
    if (session.scanIgnored?.length)  State.scanIgnored  = session.scanIgnored;
    if (session.concordance?.length && session.anonymized) {
      State.result = { anonymized: session.anonymized, concordance: session.concordance };
    }

    // Restaurer les règles OCR
    if (session.ocrRules?.length) {
      session.ocrRules.forEach(r => Storage.addOcrRule(r.from, r.to, r.caseSensitive));
    }

    // Restaurer la blacklist
    if (session.blacklist?.length) {
      Analysis.addToBlacklist(session.blacklist);
    }

    // Débloquer les étapes
    [2, 3, 4].forEach(n => unlockStep(n));

    // Afficher le sharedLayout
    const sharedEl = document.getElementById('sharedLayout');
    if (sharedEl) sharedEl.style.display = 'block';

    goToStep(2);

    // PDF non disponible
    const noDocEl = document.getElementById('splitNoDoc');
    const phEl    = document.getElementById('splitPlaceholder');
    if (noDocEl) { noDocEl.textContent = '📄 PDF non disponible (rechargez si besoin)'; noDocEl.style.display = 'inline'; }
    if (phEl)    phEl.style.display = 'none';

    showToast(`✓ Session restaurée — ${State.entities.filter(e=>e.active).length} entités, ${session.blacklist?.length || 0} mots BL`);
    updateAutoSaveStatus(`Session importée le ${new Date().toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'})}`);

  } catch (e) {
    alert('Erreur lors de la lecture de la session : ' + e.message);
  }

  // Réinitialiser l'input file
  event.target.value = '';
}

// ── Restauration auto au démarrage ───────────────────────────────────────────

async function checkAutoSaveRestore() {
  try {
    const saved = localStorage.getItem(SESSION_KEY);
    if (!saved) return;
    const session = JSON.parse(saved);
    if (!session.rawText) return;
    // Ne pas proposer si un document est déjà en cours
    if (State.rawText) return;

    const savedAt = new Date(session.savedAt).toLocaleString('fr-FR');
    const confirm_ = await showConfirm({
      title: 'Session non terminée',
      body: `Trouvée le <strong>${savedAt}</strong><br>
             <span style="color:var(--ink3);font-size:12px">
               ${session.entities?.length || 0} entités · ${session.blacklist?.length || 0} mots BL
             </span>`,
      ok: '↩ Reprendre',
      cancel: 'Ignorer',
      icon: '💾'
    });
    if (confirm_) {
      // Simuler un import
      importSessionData(session);
    } else {
      // Effacer la session sauvegardée
      localStorage.removeItem(SESSION_KEY);
    }
  } catch {}
}

function importSessionData(session) {
  State.rawText       = session.rawText       || '';
  State.rawText       = State.rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  State.processedText = session.processedText || State.rawText;
  State.processedText = State.processedText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  State.sourceIsText  = true;   // PDF non disponible après rechargement
  State.sourceBlobUrl = null;
  State.sourceFileName = session.sourceFileName || '';
  State._sessionRestored = true; // Marquer la session comme restaurée
  State.entities      = (session.entities || []).map(e => ({
    id: e.id || `rst_${Math.random().toString(36).substr(2,9)}`,
    value: e.value, type: e.type || 'NOM', label: e.label || e.type || 'NOM',
    occurrences: e.occurrences || 0, aliases: e.aliases || [],
    active: e.active !== false, blocked: e.blocked || false, manual: true
  }));
  State.customTypes      = session.customTypes      || [];
  State.parties          = session.parties          || { demandeurs: [], defendeurs: [] };
  State.partiesKeywords  = session.partiesKeywords  || State.partiesKeywords;
  State.initialesMap     = session.initialesMap      || {};
  State.stepsUnlocked = [1, 2, 3, 4];

  // Restaurer la concordance si elle était dans la session
  if (session.concordance?.length && session.anonymized) {
    State.result = { anonymized: session.anonymized, concordance: session.concordance };
    unlockStep(4);
  }

  if (session.ocrRules?.length) {
    session.ocrRules.forEach(r => Storage.addOcrRule(r.from, r.to, r.caseSensitive));
  }
  if (session.blacklist?.length) Analysis.addToBlacklist(session.blacklist);
  if (session.caviardages?.length) State.caviardages = session.caviardages;
  if (session.scanIgnored?.length)  State.scanIgnored  = session.scanIgnored;

  [2, 3, 4].forEach(n => unlockStep(n));

  // Afficher le sharedLayout et aller en step 3 si entités, sinon step 2
  const shared = document.getElementById('sharedLayout');
  if (shared) shared.style.display = 'block';

  const targetStep = State.entities.length > 0 ? 3 : 2;
  goToStep(targetStep);

  // Indiquer que le PDF original n'est plus disponible
  const noDoc = document.getElementById('splitNoDoc');
  const placeholder = document.getElementById('splitPlaceholder');
  if (noDoc) { noDoc.textContent = '📄 PDF non disponible (rechargez le fichier si besoin)'; noDoc.style.display = 'inline'; }
  if (placeholder) placeholder.style.display = 'none';

  // Bouton source : masqué car le PDF n'est plus disponible après restore
  const btnOpenSrcRestore = document.getElementById('btnOpenSource');
  if (btnOpenSrcRestore) btnOpenSrcRestore.style.display = 'none';

  updateAutoSaveStatus(`✓ Session restaurée — rechargez le PDF si besoin`);

  // Forcer l'affichage du texte original numéroté dans le panneau gauche.
  // Le sharedLayout vient d'être rendu visible : on attend le prochain frame
  // pour que le DOM soit prêt avant de peupler textViewerOriginal.
  requestAnimationFrame(() => {
    if (State.rawText) {
      _fillOriginalViewer(State.rawText);
    }
    const ph = document.getElementById('splitPlaceholder');
    if (ph) ph.style.display = 'none';
  });
}

// ── Accrocher l'auto-save sur les événements clés ────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Vérifier si une session existe au démarrage
  setTimeout(checkAutoSaveRestore, 500);
  // Restaurer la référence dossier
  const savedPrefix = getDossierPrefix();
  if (savedPrefix) {
    const input = document.getElementById('dossierPrefix');
    if (input) input.value = savedPrefix;
    saveDossierPrefix(savedPrefix);
  }
});

// ── Dropdown Actions toolbar entités ─────────────────────────────────────────
function toggleEbarActions() {
  const menu = document.getElementById('ebarActionsMenu');
  if (!menu) return;
  const isOpen = menu.style.display !== 'none';
  menu.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    // Fermer au clic ailleurs
    setTimeout(() => {
      document.addEventListener('click', function handler(e) {
        if (!document.getElementById('ebarActionsDropdown')?.contains(e.target)) {
          closeEbarActions();
          document.removeEventListener('click', handler);
        }
      });
    }, 10);
  }
}

function closeEbarActions() {
  const menu = document.getElementById('ebarActionsMenu');
  if (menu) menu.style.display = 'none';
}

// ════════════════════════════════════════════════════════════════════════════
// MODALE CONFIRM CUSTOM — remplace confirm() natif du navigateur
// ════════════════════════════════════════════════════════════════════════════

let _confirmResolve = null;

/**
 * Remplace window.confirm() par une modale premium.
 * Usage : const ok = await showConfirm({ title, body, ok, cancel, icon })
 */
function showConfirm({ title = 'Confirmer', body = '', ok = 'Confirmer',
                       cancel = 'Annuler', icon = '⚠️', danger = false } = {}) {
  return new Promise(resolve => {
    _confirmResolve = resolve;

    const overlay  = document.getElementById('confirmModal');
    const titleEl  = document.getElementById('confirmModalTitle');
    const bodyEl   = document.getElementById('confirmModalBody');
    const iconEl   = document.getElementById('confirmModalIcon');
    const okBtn    = document.getElementById('confirmModalOkBtn');
    const cancelBtn= document.getElementById('confirmModalCancelBtn');

    if (!overlay) { resolve(window.confirm(body || title)); return; }

    titleEl.textContent  = title;
    bodyEl.innerHTML     = body;
    iconEl.textContent   = icon;
    okBtn.textContent    = ok;
    cancelBtn.textContent= cancel;
    okBtn.className      = danger ? 'btn-danger-solid' : 'btn-primary';

    overlay.style.display = 'flex';
    // Focus sur OK par défaut
    setTimeout(() => okBtn.focus(), 50);
  });
}

function confirmModalOk() {
  document.getElementById('confirmModal').style.display = 'none';
  if (_confirmResolve) { _confirmResolve(true); _confirmResolve = null; }
}

function confirmModalCancel() {
  document.getElementById('confirmModal').style.display = 'none';
  if (_confirmResolve) { _confirmResolve(false); _confirmResolve = null; }
}

// Intercepter Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('confirmModal')?.style.display !== 'none') {
    confirmModalCancel();
  }
});
// ══════════════════════════════════════════════════════════════════════════════
// MODALE PARTIES — Identification des demandeurs / défendeurs
// ══════════════════════════════════════════════════════════════════════════════

// Mots-clés par défaut (modifiables par l'utilisateur dans la modale)
const PARTIES_KEYWORDS_DEFAULT = {
  demandeurs: ['demandeur','demandeurs','requérant','requérants','appelant','appelants','plaignant','plaignants','demanderesse','demanderesses'],
  defendeurs: ['défendeur','défendeurs','défenderesse','défenderesses','intimé','intimés','mis en cause','assigné','assignés'],
};

function openPartiesModal() {
  const overlay = document.getElementById('partiesModal');
  if (!overlay) return;
  _renderPartiesModal();
  overlay.style.display = 'flex';
}

function closePartiesModal() {
  const overlay = document.getElementById('partiesModal');
  if (overlay) overlay.style.display = 'none';
}

function openPartiesModalFromToolbar() {
  openPartiesModal();
}

function _renderPartiesModal() {
  // Initialiser les mots-clés si vides
  if (!State.partiesKeywords.demandeurs?.length) {
    State.partiesKeywords = JSON.parse(JSON.stringify(PARTIES_KEYWORDS_DEFAULT));
  }

  // Remplir les champs mots-clés
  const kwDem = document.getElementById('partiesKwDemandeur');
  const kwDef = document.getElementById('partiesKwDefendeur');
  if (kwDem) kwDem.value = (State.partiesKeywords.demandeurs || []).join(', ');
  if (kwDef) kwDef.value = (State.partiesKeywords.defendeurs || []).join(', ');

  // Vider la zone résultats auto
  const autoResult = document.getElementById('partiesAutoResult');
  if (autoResult) autoResult.innerHTML = '';

  // Suggestions IdentityResolver (noms de famille communs)
  const suggestions = (typeof IdentityResolver !== 'undefined')
    ? (IdentityResolver._lastSuggestions || []) : [];
  _renderPartiesSuggestions(suggestions);

  // Listes demandeurs / défendeurs
  _refreshPartiesLists();
}

function _renderPartiesSuggestions(suggestions) {
  const box = document.getElementById('partiesSuggestions');
  if (!box) return;
  if (!suggestions.length) {
    box.innerHTML = '<p class="parties-no-sug">Aucun regroupement automatique détecté.</p>';
    return;
  }
  box.innerHTML = suggestions.map(s => `
    <div class="parties-suggestion">
      <span class="parties-sug-label">👥 Nom commun : <strong>${escHtml(s.surname)}</strong></span>
      <div class="parties-sug-members">
        ${s.members.map(m => `
          <span class="parties-sug-chip" onclick="addPartieFromSuggestion('${m.id}')">
            ${escHtml(m.value)}
          </span>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function _refreshPartiesLists() {
  _renderPartiesList('demandeurs', 'partiesDemandeursList');
  _renderPartiesList('defendeurs', 'partiesDefendeursList');
}

function _renderPartiesList(side, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const items = State.parties[side] || [];
  if (!items.length) {
    el.innerHTML = '<div class="parties-empty">— vide —</div>';
    return;
  }
  const prefix = side === 'demandeurs' ? 'DEMANDEUR' : 'DEFENDEUR';
  el.innerHTML = items.map((item, idx) => {
    const civ = item.civilite || 'auto';
    return `
    <div class="parties-item">
      <span class="parties-item-num">${idx + 1}</span>
      <span class="parties-item-label">${escHtml(item.label)}</span>
      <span class="parties-item-type">${prefix}_${idx + 1}</span>
      <select class="parties-item-civ" title="Civilité forcée"
        onchange="setPartieCivilite('${side}', ${idx}, this.value)">
        <option value="auto"     ${civ==='auto'    ?'selected':''}>Auto</option>
        <option value="Mme"      ${civ==='Mme'     ?'selected':''}>Mme</option>
        <option value="Madame"   ${civ==='Madame'  ?'selected':''}>Madame</option>
        <option value="M."       ${civ==='M.'      ?'selected':''}>M.</option>
        <option value="Monsieur" ${civ==='Monsieur'?'selected':''}>Monsieur</option>
        <option value="Me"       ${civ==='Me'      ?'selected':''}>Me</option>
        <option value="Dr"       ${civ==='Dr'      ?'selected':''}>Dr</option>
        <option value=""         ${civ===''        ?'selected':''}>—</option>
      </select>
      <button class="btn-icon parties-item-remove"
        onclick="removePartie('${side}', ${idx})" title="Retirer">✕</button>
    </div>`;
  }).join('');
}

function setPartieCivilite(side, idx, value) {
  if (State.parties[side]?.[idx]) State.parties[side][idx].civilite = value;
}

function addPartieFromSuggestion(entityId) {
  const ent = State.entities.find(e => e.id === entityId);
  if (!ent) return;
  _openAddPartieDialog(ent);
}

function _openAddPartieDialog(ent) {
  const dialog = document.getElementById('partiesAddDialog');
  if (!dialog) return;
  document.getElementById('partiesAddLabel').textContent = ent.value;
  dialog.dataset.entityId = ent.id;
  dialog.style.display = 'flex';
}

function closeAddPartieDialog() {
  const dialog = document.getElementById('partiesAddDialog');
  if (dialog) dialog.style.display = 'none';
}

function confirmAddPartie(side) {
  const dialog = document.getElementById('partiesAddDialog');
  if (!dialog) return;
  const entityId = dialog.dataset.entityId;
  const ent = State.entities.find(e => e.id === entityId);
  if (!ent) return;
  const already = [...(State.parties.demandeurs||[]), ...(State.parties.defendeurs||[])]
    .some(p => p.entityId === entityId);
  if (already) { showToast('Déjà déclarée.'); closeAddPartieDialog(); return; }
  State.parties[side].push({ entityId, label: ent.value, civilite: 'auto' });
  closeAddPartieDialog();
  _refreshPartiesLists();
}

function removePartie(side, idx) {
  State.parties[side].splice(idx, 1);
  _refreshPartiesLists();
  autoSave();
}

function addPartieManuelle(side) {
  const inputId = side === 'demandeurs' ? 'partiesDemandeurInput' : 'partiesDefendeurInput';
  const input   = document.getElementById(inputId);
  if (!input) return;
  const val = input.value.trim();
  if (!val) return;

  let ent = State.entities.find(e => e.value.toLowerCase() === val.toLowerCase());
  if (!ent) {
    ent = {
      id: `manuel_${Math.random().toString(36).slice(2,9)}`,
      value: val, type: 'NOM', label: 'NOM',
      occurrences: 1, aliases: [], active: true, blocked: false,
    };
    State.entities.push(ent);
    renderEntityTable(State.entities);
  }
  const already = [...(State.parties.demandeurs||[]), ...(State.parties.defendeurs||[])]
    .some(p => p.entityId === ent.id);
  if (already) { showToast('Déjà déclarée.'); return; }
  State.parties[side].push({ entityId: ent.id, label: ent.value, civilite: 'auto' });
  input.value = '';
  _refreshPartiesLists();
}

// ── Détection automatique dans le texte ──────────────────────────────────────

function runAutoDetectParties() {
  const text = State.processedText || State.rawText;
  if (!text) { showToast('Pas de texte disponible.'); return; }

  // Lire les mots-clés depuis les champs
  const kwDem = document.getElementById('partiesKwDemandeur')?.value || '';
  const kwDef = document.getElementById('partiesKwDefendeur')?.value || '';

  const demKW = kwDem.split(',').map(s => s.trim()).filter(Boolean);
  const defKW = kwDef.split(',').map(s => s.trim()).filter(Boolean);

  // Sauvegarder dans State
  State.partiesKeywords = { demandeurs: demKW, defendeurs: defKW };

  const detected = _detectPartiesInText(text, State.entities, { demandeurs: demKW, defendeurs: defKW });

  const box = document.getElementById('partiesAutoResult');
  if (!box) return;

  if (!detected.length) {
    box.innerHTML = '<p class="parties-no-sug">Aucune correspondance trouvée dans le texte.</p>';
    return;
  }

  box.innerHTML = detected.map((d, i) => `
    <div class="parties-auto-item" id="autoItem_${i}">
      <div class="parties-auto-context">${escHtml(d.context)}</div>
      <div class="parties-auto-row">
        <span class="parties-auto-name"><strong>${escHtml(d.name)}</strong></span>
        <span class="parties-auto-role ${d.side === 'demandeurs' ? 'role-dem' : 'role-def'}">
          ${d.side === 'demandeurs' ? '⚡ Demandeur' : '🛡 Défendeur'}
        </span>
        <button class="btn-sm btn-primary" onclick="acceptAutoDetect(${i})">✓ Accepter</button>
        <button class="btn-sm btn-secondary" onclick="rejectAutoDetect(${i})">✗</button>
      </div>
    </div>
  `).join('');

  // Stocker pour acceptation/rejet
  window._autoDetectedParties = detected;
}

function _detectPartiesInText(text, entities, keywords) {
  const results = [];
  const seen    = new Set();

  function escRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function foldStr(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  }

  // Construire index des entités NOM
  const nameIndex = new Map();
  for (const ent of entities) {
    if (!ent.active || ent.blocked) continue;
    const forms = [ent.value, ...(ent.aliases||[])];
    for (const f of forms) nameIndex.set(foldStr(f), ent);
  }

  function tryMatch(kwList, side) {
    if (!kwList.length) return;

    const kwPat  = kwList.map(escRx).sort((a,b) => b.length-a.length).join('|');
    const titrePat = '(?:Madame|Monsieur|M\\.|Mme\\.?|Me\\.?|Maître|Maitre|Dr\\.?|Docteur)?\\s*';
    const namePat  = '[A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ\'\\-]{1,}(?:\\s+[A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ\'\\-]{1,}){0,3}';

    // Pattern 1 : "[Titre?] Nom, mot-clé" ou "[Titre?] Nom (mot-clé)"
    const rx1 = new RegExp(
      `(${titrePat}(${namePat}))(?:\\s*[,\\(]\\s*)(${kwPat})`, 'gi'
    );
    // Pattern 2 : "mot-clé [Titre?] Nom" ou "mot-clé : [Titre?] Nom"
    const rx2 = new RegExp(
      `(${kwPat})(?:\\s*[:\\-,]?\\s+)(${titrePat}(${namePat}))`, 'gi'
    );

    for (const rx of [rx1, rx2]) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(text)) !== null) {
        // Extraire le nom brut (sans titre)
        const fullMatch = m[0];
        const nameRaw   = (rx === rx1 ? m[2] : m[m.length - 1]) || '';
        const nameFolded = foldStr(nameRaw.trim());
        if (!nameFolded || nameFolded.length < 3) continue;

        const key = `${side}::${nameFolded}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Chercher l'entité correspondante
        const ent = nameIndex.get(nameFolded)
          || [...nameIndex.entries()]
              .find(([k]) => k.includes(nameFolded) || nameFolded.includes(k))?.[1];

        // Extraire le contexte (30 chars avant/après)
        const start   = Math.max(0, m.index - 30);
        const end     = Math.min(text.length, m.index + fullMatch.length + 30);
        const context = (start > 0 ? '…' : '') +
                        text.slice(start, end).replace(/\n/g, ' ') +
                        (end < text.length ? '…' : '');

        results.push({
          name:     nameRaw.trim(),
          side,
          entityId: ent?.id || null,
          entity:   ent   || null,
          context,
        });
      }
    }
  }

  tryMatch(keywords.demandeurs || [], 'demandeurs');
  tryMatch(keywords.defendeurs || [], 'defendeurs');

  return results;
}

function acceptAutoDetect(idx) {
  const detected = window._autoDetectedParties || [];
  const d = detected[idx];
  if (!d) return;

  // Créer l'entité si elle n'existe pas
  let ent = d.entity || State.entities.find(
    e => e.value.toLowerCase() === d.name.toLowerCase()
  );
  if (!ent) {
    ent = {
      id: `auto_${Math.random().toString(36).slice(2,9)}`,
      value: d.name, type: 'NOM', label: 'NOM',
      occurrences: 1, aliases: [], active: true, blocked: false,
    };
    State.entities.push(ent);
  }

  // Éviter les doublons dans State.parties
  const already = [...(State.parties.demandeurs||[]), ...(State.parties.defendeurs||[])]
    .some(p => p.entityId === ent.id);
  if (!already) {
    State.parties[d.side].push({ entityId: ent.id, label: ent.value, civilite: 'auto' });
  }

  // Masquer cet item
  const el = document.getElementById(`autoItem_${idx}`);
  if (el) el.style.opacity = '0.4';

  _refreshPartiesLists();
  renderEntityTable(State.entities);
}

function rejectAutoDetect(idx) {
  const el = document.getElementById(`autoItem_${idx}`);
  if (el) el.remove();
}

// ── Appliquer les parties ─────────────────────────────────────────────────────

function applyParties() {
  const config = {
    demandeurs: State.parties.demandeurs.map((p, i) => ({ entityId: p.entityId, ordre: i + 1 })),
    defendeurs: State.parties.defendeurs.map((p, i) => ({ entityId: p.entityId, ordre: i + 1 })),
  };

  // Appliquer types DEMANDEUR_N / DEFENDEUR_N via IdentityResolver si dispo
  if (typeof IdentityResolver !== 'undefined') {
    IdentityResolver.applyParties(State.entities, config);
  } else {
    // Fallback manuel
    const roleMap = new Map();
    config.demandeurs.forEach(({ entityId, ordre }) => roleMap.set(entityId, `DEMANDEUR_${ordre}`));
    config.defendeurs.forEach(({ entityId, ordre }) => roleMap.set(entityId, `DEFENDEUR_${ordre}`));
    State.entities.forEach(e => {
      if (roleMap.has(e.id)) { e.type = roleMap.get(e.id); e.label = e.type; }
    });
  }

  // Propager forcedCivility
  [...State.parties.demandeurs, ...State.parties.defendeurs].forEach(partie => {
    const ent = State.entities.find(e => e.id === partie.entityId);
    if (!ent) return;
    const civ = partie.civilite || 'auto';
    ent.forcedCivility = (civ && civ !== 'auto') ? civ : null;
  });

  renderEntityTable(State.entities);
  closePartiesModal();
  autoSave();
  showToast(`✓ ${config.demandeurs.length} demandeur(s) · ${config.defendeurs.length} défendeur(s) appliqués`);
}

// ══════════════════════════════════════════════════════════════════════════════
// INITIALE DE PRÉNOM
// ══════════════════════════════════════════════════════════════════════════════

// Stockage des initiales par entité : { entityId → 'I.' }
// Stocké dans State pour être sauvegardé en session
if (!State.initialesMap) State.initialesMap = {};

// État temporaire de la modale
const _InitialeState = {
  prenom:      '',
  initialeAuto:'',
  initialeChoisie: '',
  entityId:    null,
  targetSpan:  null, // span DOM ciblé pour occurrence courante
};

/**
 * Appelé depuis le menu contextuel.
 * Calcule l'initiale du mot cliqué et ouvre la modale de confirmation.
 */
function ctxSetInitiale() {
  closeCtxMenu();
  const word = CtxMenu.targetWord;
  if (!word) return;

  _InitialeState.prenom     = word;
  _InitialeState.entityId   = null;
  _InitialeState.targetSpan = CtxMenu.targetSpan || null;

  // Calculer l'initiale sans conflit avec les initiales déjà attribuées
  const initiale = _computeInitiale(word, null);
  _InitialeState.initialeAuto    = initiale.value;
  _InitialeState.initialeChoisie = initiale.value;

  // Remplir la modale
  document.getElementById('initialePrenom').textContent      = word;
  document.getElementById('initialePrenomPortee').textContent = word;
  document.getElementById('initialeProposee').textContent    = initiale.value;
  document.getElementById('initialeCustomInput').value       = '';
  document.getElementById('initialeCustomPreview').textContent = '';

  // Conflit
  const conflitZone = document.getElementById('initialeConflitZone');
  if (initiale.conflict) {
    conflitZone.style.display = 'block';
    _renderInitialeChips(initiale.alternatives);
  } else {
    conflitZone.style.display = 'none';
  }

  // Portée : désactiver "occurrence courante" si pas de span ciblé
  const porteeCurrentLabel = document.getElementById('initialePorteeCurrentLabel');
  const radioToutes   = document.querySelector('input[name="initialePortee"][value="toutes"]');
  const radioCourante = document.querySelector('input[name="initialePortee"][value="courante"]');
  if (radioToutes) radioToutes.checked = true;
  if (porteeCurrentLabel) {
    porteeCurrentLabel.style.opacity = _InitialeState.targetSpan ? '1' : '0.4';
    porteeCurrentLabel.style.pointerEvents = _InitialeState.targetSpan ? '' : 'none';
  }
  if (radioCourante) radioCourante.disabled = !_InitialeState.targetSpan;

  document.getElementById('initialeModal').style.display = 'flex';
}

/**
 * Calcule l'initiale pour un prénom donné.
 * Détecte les conflits avec les initiales déjà attribuées.
 * Retourne { value, conflict, alternatives }
 */
function _computeInitiale(prenom, _unused) {
  // Collecter les initiales déjà utilisées (entités isInitiale existantes)
  const usedInitiales = new Set(
    State.entities
      .filter(e => e.isInitiale && e.value.toLowerCase() !== (prenom || '').toLowerCase())
      .map(e => (e.initialeValue || '').toLowerCase())
  );

  // Générer candidats : J. → Je. → Jea. → Jean.
  const up = prenom.toUpperCase();
  const candidates = [];
  for (let len = 1; len <= Math.min(prenom.length, 4); len++) {
    candidates.push(up.slice(0, len) + '.');
  }

  // Trouver le premier candidat sans conflit
  for (const c of candidates) {
    if (!usedInitiales.has(c.toLowerCase())) {
      return { value: c, conflict: false, alternatives: [] };
    }
  }

  // Tous conflictuels → retourner le premier avec la liste des alternatives
  return {
    value:        candidates[0],
    conflict:     true,
    alternatives: candidates,
  };
}

function _renderInitialeChips(alternatives) {
  const box = document.getElementById('initialeConflitChips');
  if (!box) return;
  box.innerHTML = alternatives.map(alt => `
    <button class="initiale-chip ${alt === _InitialeState.initialeChoisie ? 'active' : ''}"
      onclick="selectInitialeChip('${alt}')">${alt}</button>
  `).join('');
}

function selectInitialeChip(val) {
  _InitialeState.initialeChoisie = val;
  document.getElementById('initialeProposee').textContent = val;
  document.getElementById('initialeCustomInput').value = '';
  document.getElementById('initialeCustomPreview').textContent = '';
  document.querySelectorAll('.initiale-chip').forEach(c => {
    c.classList.toggle('active', c.textContent.trim() === val);
  });
}

function initialeCustomUpdate() {
  const raw = document.getElementById('initialeCustomInput').value.trim();
  if (!raw) {
    document.getElementById('initialeCustomPreview').textContent = '';
    // Revenir à l'auto si effacé
    _InitialeState.initialeChoisie = _InitialeState.initialeAuto;
    document.getElementById('initialeProposee').textContent = _InitialeState.initialeAuto;
    return;
  }
  const formatted = raw.toUpperCase().replace(/\.$/, '') + '.';
  _InitialeState.initialeChoisie = formatted;
  document.getElementById('initialeCustomPreview').textContent = formatted;
  document.getElementById('initialeProposee').textContent = formatted;
  document.querySelectorAll('.initiale-chip').forEach(c => c.classList.remove('active'));
}

function closeInitialeModal() {
  document.getElementById('initialeModal').style.display = 'none';
}

/**
 * Applique l'initiale choisie.
 * - "toutes" : crée/met à jour une entité isInitiale → anonymize.js remplacera toutes les occurrences
 * - "courante" : remplace directement le span ciblé dans le DOM du viewer
 */
function applyInitiale() {
  const initiale = _InitialeState.initialeChoisie || _InitialeState.initialeAuto;
  const prenom   = _InitialeState.prenom;
  if (!initiale || !prenom) { closeInitialeModal(); return; }

  const portee = document.querySelector('input[name="initialePortee"]:checked')?.value || 'toutes';

  if (portee === 'courante' && _InitialeState.targetSpan) {
    // Remplacer uniquement ce span dans le viewer
    const span = _InitialeState.targetSpan;
    span.textContent = initiale;
    span.classList.add('hl-initiale');
    // Mettre à jour aussi le texte traité si possible
    if (typeof syncViewerToProcessedText === 'function') syncViewerToProcessedText();
    closeInitialeModal();
    showToast(`✦ Occurrence remplacée par ${initiale}`);
    return;
  }

  // Portée "toutes" : créer/mettre à jour l'entité isInitiale
  if (!State.initialesMap) State.initialesMap = {};

  const existingIni = State.entities.find(
    e => e.isInitiale && e.value.toLowerCase() === prenom.toLowerCase()
  );

  if (existingIni) {
    existingIni.initialeValue = initiale;
    State.initialesMap[existingIni.id] = initiale;
  } else {
    const newEnt = {
      id:            'ini_' + Date.now(),
      value:         prenom,
      aliases:       [],
      type:          'PRENOM',
      label:         'Initiale',
      active:        true,
      blocked:       false,
      isInitiale:    true,
      initialeValue: initiale,
    };
    State.entities.push(newEnt);
    State.initialesMap[newEnt.id] = initiale;
  }

  closeInitialeModal();
  renderEntityTable(State.entities);
  autoSave();
  showToast(`✦ ${prenom} → ${initiale} (toutes occurrences)`);
}

/**
 * Afficher le bouton "Initiale de prénom" dans le menu contextuel
 * uniquement si le mot ressemble à un prénom (commence par une majuscule,
 * n'est pas un titre, et est associé à une entité multi-mots)
 */
function _updateInitialeBtnVisibility(word) {
  const btn = document.getElementById('ctxInitialeBtn');
  if (!btn) return;

  const TITRES = new Set(['madame','monsieur','m.','mme','maitre','maître','dr','docteur','me']);
  if (!word || TITRES.has(word.toLowerCase())) { btn.style.display = 'none'; return; }

  // Visible si le mot commence par une majuscule (potentiel prénom)
  const startsWithUpper = /^[A-ZÀ-Ö]/.test(word);
  btn.style.display = startsWithUpper ? 'block' : 'none';
}