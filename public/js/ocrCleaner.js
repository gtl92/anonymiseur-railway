/**
 * ocrCleaner.js — Nettoyeur de bruit OCR pour documents judiciaires français
 * Adapté aux patterns réels observés sur des PDF de conclusions/ordonnances.
 *
 * Pipeline :
 *   1. Normalisation Unicode (guillemets, apostrophes, tirets)
 *   2. Corrections OCR fréquentes (chiffres/lettres, dates, mots cassés)
 *   3. Nettoyage structurel (espaces, ponctuation, lignes)
 *   4. Score de bruit résiduel
 *
 * Utilisation :
 *   const { cleanOCR } = require('./ocrCleaner');
 *   const { cleaned, ocrScore, ocrLevel, issues } = cleanOCR(rawText);
 */

'use strict';

// ── 1. Normalisation Unicode ──────────────────────────────────────────────────

function normalizeUnicode(text) {
  return text
    .normalize('NFC')
    // Guillemets typographiques → guillemets droits (préservés dans le texte)
    .replace(/[""„«»]/g, (m) => ['«','»'].includes(m) ? m : '"')
    // Apostrophes typographiques → apostrophe droite
    .replace(/[''‛]/g, "'")
    // Tirets cadratin / demi-cadratin → tiret simple
    .replace(/[–—]/g, '-')
    // Caractère de remplacement Unicode (OCR raté)
    .replace(/\uFFFD/g, '')
    // Puces et symboles non-texte fréquents en OCR
    .replace(/[•·▪▸►◆]/g, '-')
    // Symbole degré parasite collé (ex: "15° arrondissement" → ok, mais "15°\"" → artefact)
    .replace(/°["'`]/g, 'er ')
    // Symbole £ parasite (OCR de 'e' ou 't')
    .replace(/£/g, 'e')
    // Symbole © parasite
    .replace(/©/g, 'c')
    // ── Corrections Abby avant suppression ® ─────────────────────────────
    // n® → n° (29× dans les docs Abby — doit précéder la suppression de ®)
    .replace(/n®\s*(\d)/g, 'n° $1')
    .replace(/n®\s*([A-Z])/g, 'n° $1')
    // Ordinaux dégradés Abby : 8®™ étage / 8*1* étage → 8ème étage
    .replace(/\b(\d{1,2})[®™*]+[™*]*\s*([eéè]tage)/gi, '$1ème $2')
    .replace(/\b(\d{1,2})\*\d\*\s*([eéè]tage)/gi,      '$1ème $2')
    // Symbole ® parasite résiduel
    .replace(/®/g, '')
    // ™ résiduel
    .replace(/™/g, '')
    // BOM UTF-8 (Abby exporte en UTF-8-SIG)
    .replace(/^\uFEFF/, '')
    // Symbole € isolé (pas suivi d'un chiffre = parasite OCR, sinon montant réel)
    .replace(/€(?!\s*\d)/g, 'e')
    // Ligatures typographiques
    .replace(/\u0153/g, 'oe')   // œ
    .replace(/\u00e6/g, 'ae')   // æ
    .replace(/\u00c6/g, 'AE')
    .replace(/\u0152/g, 'OE');
}

// ── 2. Corrections OCR fréquentes ────────────────────────────────────────────

function fixCommonOCRErrors(text) {
  return text
    // ── Dates ordinales ────────────────────────────────────────────────────
    // "ler" → "1er" (OCR: l minuscule lu comme 1)
    .replace(/\bler\b/gi, '1er')
    // "1°" seul → "1er" (degré pris pour ordinal)
    .replace(/\b1°\s*(?=[a-zA-ZÀ-ÿ])/g, '1er ')
    // "1°"" ou "1°'" → "1er"
    .replace(/1°["'`]/g, '1er ')
    // "1°\"" → "1er"
    .replace(/1°\\/g, '1er ')
    // "Cass. Civ. 1°\"" → "Cass. Civ. 1er"
    .replace(/(\bCiv\.?\s+)1°["'\\]/gi, '$11er ')
    // "Cass. 2° civ." → "Cass. 2e civ."
    .replace(/(\bCass\.?\s+)(\d)°(\s+civ)/gi, '$1$2e$3')

    // ── Arrondissements / ordres ────────────────────────────────────────────
    // "14ème" "15ème" déjà corrects, mais "14°" → "14e" (sans espace avant)
    .replace(/\b(\d{1,2})°(\s+arrondissement)/gi, '$1e$2')
    // "15\"®" → "15e" (artefact guillemet + registre)
    .replace(/(\d{1,2})"®/g, '$1e')
    // "15°\"" → "15e"
    .replace(/(\d{1,2})°["'\\]/g, '$1e')

    // ── Chiffres/lettres confondus ──────────────────────────────────────────
    // "O" → "0" dans les contextes numériques (code postal, numéros)
    // Entre deux chiffres
    .replace(/(\d)O(\d)/g, '$10$2')
    // O suivi de 4+ chiffres (code postal, etc.)
    .replace(/\bO(\d{4,})\b/g, '0$1')
    // 4+ chiffres suivi de O (ex: "75253 PARIS Cedex O5" → O5 → 05)
    .replace(/(\d{4,})O\b/g, '$10')
    // "Cedex O" suivi de chiffre → "Cedex 0"
    .replace(/\bCedex\s+O(\d)/gi, 'Cedex 0$1')
    // "O" entre espace et chiffre (ex: " O5" → " 05")
    .replace(/\sO(\d)/g, ' 0$1')

    // ── Mots coupés / collés OCR ───────────────────────────────────────────
    // Apostrophes collées sans espace (ex: "d'effectuer" → ok, "d"effectuer" → corriger)
    .replace(/([a-zA-ZÀ-ÿ])"([a-zA-ZÀ-ÿ])/g, "$1'$2")
    // Tiret en fin de ligne suivi d'une suite de mot (mots coupés)
    .replace(/-\n([a-zà-ÿ])/g, '$1')

    // ── Patterns juridiques spécifiques ────────────────────────────────────
    // "de-référé" → "de référé" (tiret parasite)
    .replace(/de-référ[ée]/g, 'de référé')
    // "n°a" → "n'a" (OCR degré pour apostrophe)
    .replace(/n°a\b/g, "n'a")
    // "d°!" → "d'" ou "d'un" (degré pour apostrophe)
    .replace(/d°(!|[a-zA-ZÀ-ÿ])/g, "d'$1")
    // "°!" → espace avant lettre minuscule → apostrophe
    .replace(/°([a-zA-ZÀ-ÿ]{2,})/g, "'$1")
    // "°°" → suppression double degré
    .replace(/°°/g, '')
    // Caractères parasites fréquents entre mots : "lo gem£t" → "logement"
    .replace(/gem£"?t/g, 'gement')

    // ── Mots juridiques fréquemment mal reconnus ───────────────────────────
    .replace(/\bapparait\b/gi, 'apparaît')
    .replace(/\bagre[ée]\b/gi, 'agréé')
    .replace(/\bceeans\b/gi, 'céans')
    .replace(/\bdeceans\b/gi, 'de céans')
    .replace(/\brefere\b/gi, 'référé')
    .replace(/\brhuamtologiques?\b/gi, 'rhumatologiques')
    .replace(/\bNéañoins\b/g, 'Néanmoins')
    .replace(/\bfavorablemet\b/gi, 'favorablement')

    // ── Patterns spécifiques Abby FineReader ──────────────────────────────
    // n° variantes résiduelles (après normalizeUnicode)
    .replace(/\bpièce\s+n\*\s*(\d)/gi, 'pièce n° $1')   // pièce n* 3 → n° 3
    .replace(/\bpièce\s+n%\s*(\d)/gi,  'pièce n° $1')   // pièce n% 8 → n° 8
    .replace(/\bpièce\s+n\^\s*(\d)/gi, 'pièce n° $1')   // pièce n^3 → n° 3
    .replace(/\bPièce\s+ntt(\d)/g,     'Pièce n° $1')   // Pièce ntt4 → n° 4
    // Symbole euro Abby : "110 E," (E seul entre nombre et virgule)
    .replace(/\b(\d+)\s+E,/g, '$1 €,')
    .replace(/\b(\d+)\s+E\b(?!\w)/g, '$1 €')
    // Confusion t/l très fréquente en OCR (Abby confond t minuscule et l)
    .replace(/\bte\s+(Juge|jugement|juge)\b/gi, 'le $1')
    .replace(/\btes\s+(demandes|délais|dépens|locaux|lieux|parties|termes|conclusions|frais)\b/gi, 'les $1')
    .replace(/(?<![a-zA-ZÀ-ÿ])ta\s+(société|somme|saisie|décision|charge|saisies)\b/gi, 'la $1')
    // Mots juridiques dégradés par Abby
    .replace(/\bartide\b/g,       'article')
    .replace(/\bArtide\b/g,       'Article')
    .replace(/\bauAence\b/g,      'audience')
    .replace(/\bjvge\b/g,         'juge')
    .replace(/\bJvge\b/g,         'Juge')
    .replace(/\bpréjudee\b/g,     'préjudice')
    .replace(/\birrépetibies\b/g, 'irrépétibles')
    .replace(/\birrépétibies\b/g, 'irrépétibles')
    .replace(/\bappEcation\b/g,   'application')
    // Blocs majuscules fusionnés par Abby
    .replace(/RECONVERSION\s+N\s+ELLE\b/g,       'RECONVENTIONNELLE')
    .replace(/RECONVENTTONNELS?\b/g,              'RECONVENTIONNELS')
    // Artefact d'en-tête Abby (numéro de page OCR → "Art»**")
    .replace(/^Art[»*]+\s*:\s*/m, '')
    // Pièces bordereau : variantes ntt / i»p / np
    .replace(/\bPièce\s+i[»?]p(\d)/g, 'Pièce n° $1')
    .replace(/\bPièce\s+np(\d)/g,      'Pièce n° $1')

    // ── Espaces ────────────────────────────────────────────────────────────
    // Espaces multiples → espace simple (hors sauts de ligne)
    .replace(/[^\S\n]{2,}/g, ' ')
    // Espace avant une apostrophe collée
    .replace(/\s'/g, "'")
    // Tabulations → espace
    .replace(/\t/g, ' ');
}

// ── 3. Nettoyage structurel ───────────────────────────────────────────────────

function cleanStructure(text) {
  return text
    // Espaces avant ponctuation (sauf « et avant »)
    .replace(/[^\S\n]+([,.;:!?])/g, '$1')
    // Espace manquant après ponctuation (ex: "décision.Le" → "décision. Le")
    .replace(/([.!?])([A-ZÀ-Ö])/g, '$1 $2')
    // Sauts de ligne triples ou plus → double saut
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── 4. Score de bruit résiduel ────────────────────────────────────────────────

const NOISE_RULES = [
  { pattern: /\b(ler|1°["'\\])/g,           weight: 2, label: 'date_ordinale'      },
  { pattern: /[a-zA-ZÀ-ÿ]"[a-zA-ZÀ-ÿ]/g,  weight: 2, label: 'apostrophe_collee'  },
  { pattern: /\uFFFD|[£©®]/g,               weight: 3, label: 'char_invalide'       },
  { pattern: /de-référ/g,                   weight: 2, label: 'mot_casse'           },
  { pattern: /\b[A-Z]{2,}[a-z]{1,2}\b/g,   weight: 1, label: 'casse_incoherente'   },
  { pattern: /°["'`\\]/g,                   weight: 2, label: 'degre_parasite'      },
  { pattern: /[^\S\n]{3,}/g,                weight: 1, label: 'espaces_multiples'   },
  { pattern: /gem£/g,                       weight: 3, label: 'char_parasite'       },
  { pattern: /\b\w{1,2}\s+\w{1,2}\s+\w{1,2}\s+\w{1,2}\b/g, weight: 1, label: 'mots_tres_courts' },
];

function computeOCRScore(text) {
  let score = 0;
  const issues = [];

  for (const rule of NOISE_RULES) {
    const matches = text.match(rule.pattern);
    if (matches && matches.length > 0) {
      const contribution = Math.min(rule.weight * matches.length, rule.weight * 3); // plafonné
      score += contribution;
      issues.push({ label: rule.label, count: matches.length, contribution });
    }
  }

  return { score, issues };
}

function ocrLevel(score) {
  if (score <= 1) return { level: 'clean',  emoji: '🟢', label: 'Propre'  };
  if (score <= 3) return { level: 'moyen',  emoji: '🟡', label: 'Moyen'   };
  return           { level: 'bruite', emoji: '🔴', label: 'Bruité'  };
}

// ── 5. Score de bruit par ligne (gibberish detection) ────────────────────────

/**
 * Évalue le niveau de bruit d'une seule ligne.
 * Détecte les lignes gibberish non récupérables (scan dégradé, italique dense).
 *
 * @param {string} line
 * @returns {{ lineScore, lineEmoji, lineLevel, isGibberish, lineFlags }}
 */
function scoreLineBruit(line) {
  const t = line.trim();
  if (!t || t.length < 8 || /^[\d\s.,;:\-*•]+$/.test(t)) {
    return { lineScore: 0, lineEmoji: '🟢', lineLevel: 'clean', isGibberish: false, lineFlags: [] };
  }

  let score = 0;
  const flags = [];

  // 1. Ratio caractères exotiques (hors latin étendu, ponctuation standard, €)
  const exotic = (t.match(/[^a-zA-ZÀ-ÿœæÆŒ0-9\s.,;:!?()\[\]'"«»\-\/€°•\u2019\u2014\u2013]/g) || []);
  const ratio  = exotic.length / Math.max(t.length, 1);
  if (ratio > 0.12)      { score += 4; flags.push(`exotic=${(ratio * 100).toFixed(0)}%`); }
  else if (ratio > 0.06) { score += 2; flags.push(`exotic=${(ratio * 100).toFixed(0)}%`); }

  // 2. Séquences de consonnes impossibles (≥ 6 d'affilée)
  //    Seuil 6 pour ne pas flaguer des mots valides comme "manifestement" (nfstm = 5)
  const hardSeq = (t.match(/[bcdfghjklmnpqrstvwxzBCDFGHJKLMNPQRSTVWXZ]{6,}/g) || []);
  if (hardSeq.length > 0) { score += 3 * hardSeq.length; flags.push(`consonnes=${JSON.stringify(hardSeq)}`); }

  // 3. Mots ≥ 4 chars sans aucune voyelle
  const noVowel = (t.match(/\b[a-zA-ZÀ-ÿ]{4,}\b/g) || [])
    .filter(w => !/[aeiouyAEIOUYàâäéèêëîïôùûüÀÂÉÈÊËÎÏÔÙÛÜ]/.test(w));
  if (noVowel.length >= 2) { score += 2 * noVowel.length; flags.push(`sans_voyelle=${JSON.stringify(noVowel.slice(0, 3))}`); }

  // 4. Underscores comme remplissage (artefact Abby sur traits de séparation)
  if (/\w{2,}_{4,}/.test(t) || /_{6,}/.test(t)) { score += 4; flags.push('underscores_remplissage'); }

  // 5. Casse aléatoire intra-mot (ex: rgtdwter, btitlkttf, MgÿjMg)
  const crazyCase = (t.match(/\b[a-z]{2,}[A-Z]{2,}[a-z]{2,}\b|\b[A-Z]{2,}[a-z]{2,}[A-Z]{2,}\b/g) || []);
  if (crazyCase.length >= 2) { score += 2; flags.push(`casse_aléatoire=${JSON.stringify(crazyCase.slice(0, 2))}`); }

  const lineLevel   = score >= 6 ? 'gibberish' : (score >= 3 ? 'moyen' : 'clean');
  const lineEmoji   = score >= 6 ? '🔴' : (score >= 3 ? '🟡' : '🟢');
  const isGibberish = score >= 6;

  return { lineScore: score, lineEmoji, lineLevel, isGibberish, lineFlags: flags };
}

/**
 * Nettoie un texte ligne par ligne et retourne chaque ligne avec son score.
 * Utilisation : Step OCR Corrections — navigation ligne à ligne avec indicateurs.
 *
 * @param {string} text       Texte brut Abby (TXT/UTF-8-SIG)
 * @param {object} options    Mêmes options que cleanOCR
 * @returns {{
 *   lines: Array<{index, raw, text, lineScore, lineEmoji, lineLevel, isGibberish, lineFlags}>,
 *   globalScore, globalEmoji, globalLevel,
 *   stats: { total, clean, moyen, gibberish }
 * }}
 */
function cleanOCRByLine(text, options = {}) {
  if (!text) return {
    lines: [], globalScore: 0, globalEmoji: '🟢', globalLevel: 'clean',
    stats: { total: 0, clean: 0, moyen: 0, gibberish: 0 }
  };

  // Nettoyage global d'abord (unicode + corrections communes)
  let cleaned = normalizeUnicode(text);
  cleaned = fixCommonOCRErrors(cleaned);
  if (!options.skipStructure) cleaned = cleanStructure(cleaned);
  cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const rawLines     = text.split('\n');
  const cleanedLines = cleaned.split('\n');
  const stats        = { total: 0, clean: 0, moyen: 0, gibberish: 0 };
  const lines        = [];

  const len = Math.max(rawLines.length, cleanedLines.length);
  for (let i = 0; i < len; i++) {
    const raw  = rawLines[i]     ?? '';
    const line = cleanedLines[i] ?? '';
    const meta = scoreLineBruit(line);

    if (line.trim()) {
      stats.total++;
      stats[meta.lineLevel === 'gibberish' ? 'gibberish'
           : meta.lineLevel === 'moyen'    ? 'moyen'
           : 'clean']++;
    }
    lines.push({ index: i, raw, text: line, ...meta });
  }

  const globalScore = stats.total > 0
    ? Math.round((stats.moyen * 2 + stats.gibberish * 5) / stats.total)
    : 0;
  const { level: globalLevel, emoji: globalEmoji } = ocrLevel(globalScore);

  return { lines, globalScore, globalEmoji, globalLevel, stats };
}

// ── 6. Détection patterns suspects (debug) ───────────────────────────────────

function detectSuspiciousPatterns(text) {
  return {
    weirdDates:       (text.match(/\b(ler|1°[^C\d\s])/g)           || []),
    brokenWords:      (text.match(/[a-zA-ZÀ-ÿ]-\n[a-zA-ZÀ-ÿ]/g)   || []),
    gluedApostrophes: (text.match(/[a-zA-ZÀ-ÿ]"[a-zA-ZÀ-ÿ]/g)     || []),
    parasiteChars:    (text.match(/[£©®\uFFFD°]["'`\\][a-zA-ZÀ-ÿ]/g) || []),
    allCapsBlocks:    (text.match(/\b[A-Z]{5,}\b/g)                 || []),
  };
}

// ── 7. Fonction principale ────────────────────────────────────────────────────

/**
 * Nettoie un texte OCR et retourne le texte nettoyé + métriques.
 *
 * @param {string} text       Texte brut extrait par OCR
 * @param {object} options
 *   @param {boolean} [options.skipStructure=false]  Ne pas nettoyer la structure
 *   @param {boolean} [options.debug=false]          Inclure les patterns suspects
 * @returns {{
 *   cleaned:  string,    // Texte nettoyé
 *   ocrScore: number,    // Score de bruit (0 = propre)
 *   ocrLevel: string,    // 'clean' | 'moyen' | 'bruite'
 *   emoji:    string,    // 🟢 🟡 🔴
 *   levelLabel:string,   // 'Propre' | 'Moyen' | 'Bruité'
 *   issues:   Array,     // Détail des problèmes trouvés
 *   debug:    object|null
 * }}
 */
function cleanOCR(text, options = {}) {
  if (!text) return {
    cleaned: '', ocrScore: 0, ocrLevel: 'clean',
    emoji: '🟢', levelLabel: 'Propre', issues: [], debug: null,
  };

  // Score AVANT nettoyage (pour mesurer l'amélioration)
  const { score: scoreBefore, issues: issuesBefore } = computeOCRScore(text);

  let result = text;
  result = normalizeUnicode(result);
  result = fixCommonOCRErrors(result);
  if (!options.skipStructure) result = cleanStructure(result);

  // Score APRÈS nettoyage (bruit résiduel)
  const { score, issues } = computeOCRScore(result);
  const lvl = ocrLevel(score);

  const debug = options.debug ? detectSuspiciousPatterns(result) : null;

  if (score > 3) {
    console.warn(`⚠️ OCR bruité (score=${score})`, {
      issues: issues.map(i => `${i.label}(×${i.count})`).join(', '),
      ...(debug ? { debug } : {}),
    });
  }

  return {
    cleaned:    result,
    ocrScore:   score,
    ocrScoreBefore: scoreBefore,
    ocrLevel:   lvl.level,
    emoji:      lvl.emoji,
    levelLabel: lvl.label,
    issues,
    debug,
  };
}

// ── Export ────────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    cleanOCR,
    cleanOCRByLine,
    scoreLineBruit,
    normalizeUnicode,
    fixCommonOCRErrors,
    cleanStructure,
    computeOCRScore,
    ocrLevel,
  };
}