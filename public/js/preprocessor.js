// preprocessor.js — Nettoyage pré-anonymisation
// À appeler : const clean = preprocessAbbyTxt(rawText)

export function preprocessAbbyTxt(text) {
  let t = text;

  // ── 0. Nettoyage UTF-8 ───────────────────────────────────────
  t = t.replace(/^\uFEFF/, '');           // BOM
  t = t.replace(/\r\n/g, '\n');           // CRLF → LF
  t = t.replace(/\r/g, '\n');             // CR seul

  // ── 1. Apostrophes & guillemets typographiques ───────────────
  t = t.replace(/[\u2018\u2019]/g, "'");  // ' ' → '
  t = t.replace(/[\u201C\u201D\u201E]/g, '"'); // " " „ → "

  // ── 2. n° dégradé (le plus fréquent : 29×) ──────────────────
  t = t.replace(/n[®°]\s*(\d)/g, 'n° $1');   // n® 1 → n° 1
  t = t.replace(/n\*\s*(\d)/g,   'n° $1');   // n* 3 → n° 3
  t = t.replace(/n%\s*(\d)/g,    'n° $1');   // n% 8 → n° 8
  t = t.replace(/n[t][t](\d)/g,  'n° $1');   // ntt4 → n° 4
  t = t.replace(/n\^(\d)/g,      'n° $1');   // n^3 → n° 3

  // ── 3. Ordinaux dégradés ─────────────────────────────────────
  t = t.replace(/8[®™][™]?\s*étage/g, '8ème étage');
  t = t.replace(/8\*1\*\s*étage/g,    '8ème étage');

  // ── 4. Symbole € dégradé ─────────────────────────────────────
  t = t.replace(/\b(\d+)\s+E,/g, '$1 €,');   // 110 E, → 110 €,
  t = t.replace(/\b(\d+)\s+£/g,  '$1 €');    // £ → € (artefact OCR)

  // ── 5. Confusion t/l (OCR très fréquent) ─────────────────────
  t = t.replace(/\bte\s+(Juge|jugement|jugé)\b/gi, 'le $1');
  t = t.replace(/\btes\s+(demandes|délais|dépens|locaux|lieux|parties)\b/gi, 'les $1');
  t = t.replace(/\bta\s+(société|somme|saisie|décision|charge)\b/gi, 'la $1');

  // ── 6. Mots courts dégradés (fréquents dans docs juridiques) ─
  t = t.replace(/\bartide\b/g,          'article');     // 5×
  t = t.replace(/\bauAence\b/g,         'audience');
  t = t.replace(/\birrépetibies\b/g,    'irrépétibles');
  t = t.replace(/\birrépétibies\b/g,    'irrépétibles');
  t = t.replace(/\bjvge\b/g,            'juge');
  t = t.replace(/\bpréjudee\b/g,        'préjudice');
  t = t.replace(/\bappEcation\b/g,      'application');

  // ── 7. Majuscules corrompues (typo bloc) ─────────────────────
  t = t.replace(/RECONVERSION\s+N\s+ELLE/g, 'RECONVENTIONNELLE');
  t = t.replace(/RECONVENTTONNELS/g,         'RECONVENTIONNELS');
  t = t.replace(/DEMANDEURS\s+RECONVENTTONNELS/g, 'DEMANDEURS RECONVENTIONNELS');

  // ── 8. Artefact d'en-tête Abby ───────────────────────────────
  t = t.replace(/^Art[»]+\*+\s*:\s*/m, '');  // Art»** : → supprimé

  // ── 9. Caractères parasites isolés ───────────────────────────
  t = t.replace(/■/g, '');              // Carré plein parasite
  t = t.replace(/\uFFFD/g, '?');        // Char de remplacement → ?

  // ── 10. Espaces multiples résidus ────────────────────────────
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/^\s+$/gm, '');        // Lignes blanches vides

  return t;
}