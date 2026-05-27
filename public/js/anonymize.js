/**
 * anonymize.js — Moteur d'anonymisation 100% JS
 * - table dédupliquée proprement
 * - tri robuste sans pondération arbitraire
 * - conservation du titre présent dans le texte
 * - injection de civilité forcée si aucun titre dans le texte (forcedCivility)
 * - initiale de prénom : entité avec isInitiale=true → remplacée directement par initialeValue
 * - concordance avec formes réellement remplacées
 */

const Anonymizer = (() => {
  const TITRES_RE = String.raw`(?:Madame|Monsieur|M\.|Mme\.?|Me\.?|Maître|Maitre|Dr\.?|Pr\.?|Docteur|Professeur)`;

  const TITRES_SET = new Set([
    'madame', 'monsieur', 'mme', 'mme.', 'm.', 'me', 'me.',
    'maître', 'maitre', 'dr', 'dr.', 'pr', 'pr.', 'docteur', 'professeur',
  ]);

  const PREFIX = {
    NOM: 'NOM', ENTITE: 'ENTITE', ADRESSE: 'ADRESSE',
    REF: 'REF', AUTRE: 'AUTRE', COUPLE: 'COUPLE',
  };

  function nextPH(counters, type) {
    // PRENOM ne génère jamais de placeholder (toujours traité comme initiale)
    if ((type || '').toUpperCase() === 'PRENOM') return null;
    let p = PREFIX[type];
    if (!p && type) {
      p = type.trim().toUpperCase()
        .replace(/[^A-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    }
    if (!p) p = 'VAL';
    counters[p] = (counters[p] || 0) + 1;
    return `[${p}_${counters[p]}]`;
  }

  function isTitre(val) {
    return TITRES_SET.has((val || '').toLowerCase().trim());
  }

  // Retire le titre en tête : "Madame Isabelle Mervoyer" → "Isabelle Mervoyer"
  const TITRES_PREFIX_RE = /^(?:Madame|Monsieur|M\.?|Mme\.?|Mlle\.?|Me\.?|Maître|Maitre|Dr\.?|Pr\.?|Docteur|Professeur)\s+/i;
  function stripTitre(val) {
    return (val || '').replace(TITRES_PREFIX_RE, '').trim();
  }

  // Mots communs à exclure des composants de noms pour éviter les faux remplacements.
  // Si l'entité est "Jean Paris" (type NOM), on ne veut pas remplacer "Paris" seul partout.
  const COMMON_WORDS = new Set([
    'paris','lyon','marseille','france','french','nord','sud','est','ouest',
    'centre','cedex','europe','saint','sainte','ville',
    'mairie','tribunal','cour','code','article','loi','décret','numéro',
    'nom','prénom','personne','groupe','service','direction','bureau',
    'rue','avenue','boulevard','place','chemin','route','hôpital','hopital',
  ]);

  // Extrait le prénom (premier mot) si valeur = "Prénom Nom" (multi-mots, premier mot = capitalisé court)
  // Retourne null si pas de prénom détectable
  const ARTICLES = new Set(['la','le','les','du','de','des','un','une','au','aux','l','d','sur','en']);
  function extractPrenom(val) {
    const parts = val.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const first = parts[0];
    // Exclure les articles et prépositions courants
    if (ARTICLES.has(first.toLowerCase())) return null;
    // Prénom = commence par majuscule, 2-12 chars, pas tout en majuscules (sinon c'est un nom)
    // Doit contenir au moins une minuscule (ex: "Isabelle" oui, "MERVOYER" non, "La" non car filtré)
    if (/^[A-ZÀ-Ö]/.test(first) && first.length >= 2 && first.length <= 12 &&
        first !== first.toUpperCase() && /[a-zà-öø-ÿ]/.test(first)) {
      return first;
    }
    return null;
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeSpaces(s) {
    return (s || '').trim().replace(/\s+/g, ' ');
  }

  function flexPattern(val) {
    let p = escapeRegex(normalizeSpaces(val));
    p = p.replace(/\\-/g, '[\\-\\s]');
    p = p.replace(/\s+/g, '[\\s,\\-]+');
    p = p.replace(/([0-9]),/g, '$1,?');
    return p;
  }

  /**
   * Génère les variantes graphiques d'une valeur :
   * - version tout-majuscules (ex: "Dupont" → "DUPONT")
   * - version casse mixte depuis tout-caps (ex: "DUPONT" → "Dupont")
   */
  function graphicVariants(val) {
    const variants = new Set();
    const v = val.trim();
    if (!v || v.length < 2) return [];

    const upper = v.toUpperCase();
    if (upper !== v) variants.add(upper);

    if (v === upper) {
      const mixed = v.split(/\s+/).map(w =>
        w.length === 0 ? w : w[0] + w.slice(1).toLowerCase()
      ).join(' ');
      if (mixed !== v) variants.add(mixed);
    }

    return [...variants];
  }

  /**
   * Génère les variantes fuzzy d'un mot pour tolérer les erreurs OCR :
   * - suppression d'un caractère (ex: "BOUCHAABA" → "OUCHAABA", "BUCHAABA", …)
   * - insertion d'un caractère (ex: "Mahidine" → "Mabhidine" si on insère 'b')
   * - substitution d'un caractère (ex: "Jean" → "Jeam", "Jeon", …)
   *
   * N'est appliqué qu'aux mots ≥ 6 caractères pour éviter l'explosion combinatoire
   * et les faux positifs sur les mots courts.
   *
   * Retourne un regex-ready pattern qui match la valeur ET ses variantes fuzzy.
   */
  function fuzzyWordPattern(word) {
    const w = word.trim();
    if (w.length < 6) return escapeRegex(w);

    // Patterns :
    // - original
    // - chaque position avec un caractère manquant (suppression)
    // - chaque position avec un caractère inséré (insertion = . optionnel)
    // - chaque position avec un caractère substitué (. à la place)
    const patterns = new Set();
    patterns.add(escapeRegex(w));

    // Suppression : pour chaque position, le mot sans ce caractère
    for (let i = 0; i < w.length; i++) {
      const deleted = w.slice(0, i) + w.slice(i + 1);
      if (deleted.length >= 5) patterns.add(escapeRegex(deleted));
    }

    // Insertion : pour chaque position, un caractère quelconque inséré
    // (on utilise [A-Za-zÀ-ÿ] pour rester dans les lettres)
    for (let i = 0; i <= w.length; i++) {
      const inserted = escapeRegex(w.slice(0, i)) + '[A-Za-zÀ-ÿ]' + escapeRegex(w.slice(i));
      patterns.add(inserted);
    }

    // Substitution : pour chaque position, le caractère remplacé par n'importe quelle lettre
    for (let i = 0; i < w.length; i++) {
      const substituted = escapeRegex(w.slice(0, i)) + '[A-Za-zÀ-ÿ]' + escapeRegex(w.slice(i + 1));
      patterns.add(substituted);
    }

    return '(?:' + [...patterns].join('|') + ')';
  }

  function buildTable(active, counters) {
    const table       = [];
    const concordance = [];
    const seen        = new Set();

    for (const ent of active) {

      // ── Entité isInitiale (prénom marqué manuellement) ────────────────────
      if (ent.isInitiale) {
        const ini = ent.initialeValue || (ent.value[0].toUpperCase() + '.');
        const vals = [ent.value, ...(ent.aliases || [])]
          .map(normalizeSpaces).filter(v => v.length > 0 && !isTitre(v));
        for (const val of [...new Set(vals)]) {
          for (const wt of [true, false]) {
            const k = `INI||${wt}||${val.toLowerCase()}`;
            if (seen.has(k)) continue;
            seen.add(k);
            table.push({ val, ph: null, withTitre: wt, initialeOnly: ini, rawPattern: null });
          }
        }
        concordance.push({ placeholder: ini, value: ent.value, aliases: ent.aliases || [],
          type: ent.type, label: 'Initiale', initialPrefix: ini, replacedForms: [] });
        continue;
      }

      // ── Type PRENOM ───────────────────────────────────────────────────────
      if ((ent.type || '').toUpperCase() === 'PRENOM') {
        const ini = ent.initialeValue || (ent.value[0].toUpperCase() + '.');
        const vals = [ent.value, ...(ent.aliases || [])]
          .map(normalizeSpaces).filter(v => v.length > 0 && !isTitre(v));
        for (const val of [...new Set(vals)]) {
          for (const wt of [true, false]) {
            const k = `INI||${wt}||${val.toLowerCase()}`;
            if (seen.has(k)) continue;
            seen.add(k);
            table.push({ val, ph: null, withTitre: wt, initialeOnly: ini, rawPattern: null });
          }
        }
        concordance.push({ placeholder: ini, value: ent.value, aliases: ent.aliases || [],
          type: ent.type, label: 'Initiale', initialPrefix: ini, replacedForms: [] });
        continue;
      }

      // ── Entité NOM standard ───────────────────────────────────────────────
      const ph = nextPH(counters, ent.type);
      if (!ph) continue;

      const typeUp    = (ent.type || '').toUpperCase();
      const isPureNom = typeUp === 'NOM' ||
        typeUp.startsWith('DEMANDEUR') || typeUp.startsWith('DEFENDEUR') ||
        typeUp.startsWith('DÉFENDEUR');

      // Valeurs à matcher : seulement value + alias de CASSE (pas d'inversion prénom-nom)
      // Les alias ne contiennent plus que des variantes graphiques grâce à enrichPersonAliases v3
      const rawValues = [ent.value, ...(ent.aliases || [])]
        .map(normalizeSpaces)
        .map(stripTitre)
        .filter(v => v.length > 1 && !isTitre(v));

      const uniqueValues = [...new Set(rawValues)];

      for (const val of uniqueValues) {
        const valLow = val.toLowerCase();

        // Pattern standard avec/sans titre précédent
        for (const wt of [true, false]) {
          const k = `${ph}||${wt}||${valLow}`;
          if (seen.has(k)) continue;
          seen.add(k);
          table.push({ val, ph, withTitre: wt, initialeOnly: null, rawPattern: null });
        }

        // Pattern fuzzy complet pour les mots longs (OCR)
        if (isPureNom && val.split(/\s+/).length === 1 && val.length >= 6) {
          const kf = `${ph}||FUZZ||${valLow}`;
          if (!seen.has(kf)) {
            seen.add(kf);
            table.push({ val, ph, withTitre: false, initialeOnly: null,
              rawPattern: fuzzyWordPattern(val) });
          }
        }
      }

      // ── Patterns pour le prénom associé → initiale ────────────────────────
      // Source : ent.prenom + ent.prenomVariants
      // Pattern EXACT (pas fuzzy) pour éviter que le prénom matche le NOM
      if (isPureNom && (ent.prenom || ent.prenomVariants)) {
        const prenomForms = new Set();
        if (ent.prenom) prenomForms.add(ent.prenom);
        if (ent.prenomVariants) ent.prenomVariants.forEach(p => prenomForms.add(p));

        for (const prenomForm of prenomForms) {
          if (!prenomForm || prenomForm.length < 2) continue;
          const initiale  = prenomForm[0].toUpperCase() + '.';
          const prenomLow = prenomForm.toLowerCase();

          // Pattern prénom seul (exact) → initiale
          const kps = `INI_PRENOM||false||${prenomLow}`;
          if (!seen.has(kps)) {
            seen.add(kps);
            table.push({ val: prenomForm, ph: null, withTitre: false,
              initialeOnly: initiale, rawPattern: escapeRegex(prenomForm) });
          }
          // Pattern prénom précédé d'un titre → titre + initiale
          const kpt = `INI_PRENOM||true||${prenomLow}`;
          if (!seen.has(kpt)) {
            seen.add(kpt);
            table.push({ val: prenomForm, ph: null, withTitre: true,
              initialeOnly: initiale, rawPattern: escapeRegex(prenomForm) });
          }

          // Pattern combo "prénomExact NOMfuzzy" → "initiale [NOM_X]"
          // Ex: "Mahidine BOUCHAABA" ou "Mahidine Bouchaaba" → "M. [NOM_1]"
          const nomVal = ent.value;
          if (nomVal && nomVal.length >= 3) {
            // Prénom exact + NOM fuzzy (pour couvrir les variantes OCR du NOM)
            const combined = escapeRegex(prenomForm) + '[\\s,\\-]+' + fuzzyWordPattern(nomVal);
            const kcombo   = `INI_COMBO||${prenomLow}||${ent.value.toLowerCase()}`;
            if (!seen.has(kcombo)) {
              seen.add(kcombo);
              table.push({ val: prenomForm, ph, withTitre: true,
                initialeOnly: initiale, rawPattern: combined, isCombo: true });
              table.push({ val: prenomForm, ph, withTitre: false,
                initialeOnly: initiale, rawPattern: combined, isCombo: true });
            }
          }
        }
      }

      concordance.push({
        placeholder: ph, value: ent.value, aliases: ent.aliases || [],
        type: ent.type, label: ent.label, initialPrefix: null, replacedForms: [],
      });
    }

    // Tri :
    // 1. Combos prénom+nom en premier (patterns les plus spécifiques)
    // 2. Puis initialeOnly (prénoms seuls)
    // 3. Puis valeurs complètes par longueur décroissante
    // 4. withTitre avant sans titre à longueur égale
    table.sort((a, b) => {
      const aCombo = a.isCombo ? 2 : (a.initialeOnly ? 1 : 0);
      const bCombo = b.isCombo ? 2 : (b.initialeOnly ? 1 : 0);
      if (bCombo !== aCombo) return bCombo - aCombo;
      const len = b.val.length - a.val.length;
      if (len !== 0) return len;
      return Number(b.withTitre) - Number(a.withTitre);
    });

    return { table, concordance };
  }

  function buildRegex(table) {
    // Frontières de mot :
    // - NWB : pas de lettre juste avant
    //   ET pas un crochet '[' juste avant s'il commence un placeholder (lettre majuscule suit)
    // - NWE : pas de lettre juste après
    //   ET pas un motif '_NUM]' juste après (signature de placeholder)
    // Cela permet de matcher "BOUCHAABA" dans "[de M. BOUCHAABA]" mais pas
    // "NOM" dans "[NOM_1]" car "_1]" suit.
    const NWB = String.raw`(?<![A-Za-zÀ-ÖØ-öø-ÿ])`;
    const NWE = String.raw`(?![A-Za-zÀ-ÖØ-öø-ÿ])(?!_\d+\])`;

    const patterns = table.map(({ val, withTitre, rawPattern }) => {
      // Si un rawPattern est fourni (fuzzy OCR), l'utiliser directement ;
      // sinon, passer par flexPattern (qui gère tirets, espaces, virgules).
      const p = rawPattern || flexPattern(val);
      if (withTitre) return `(${TITRES_RE}\\s+)(${p})`;
      return `()(${p})`;
    });

    if (patterns.length === 0) return null;

    const alternance = patterns.map(p => `(?:${p})`).join('|');
    const bigRegex   = new RegExp(`${NWB}(?:${alternance})${NWE}`, 'giu');

    return { bigRegex, patternCount: patterns.length };
  }

  function run(text, entities) {
    const counters    = {};
    const sourceText  = text || '';

    const active = (entities || []).filter(
      e => e && e.active && !e.blocked && normalizeSpaces(e.value)
    );

    const { table, concordance } = buildTable(active, counters);
    const built = buildRegex(table);

    if (!built) return { anonymized: sourceText, concordance: [] };

    const { bigRegex, patternCount } = built;

    const concordanceMap = new Map();
    for (const c of concordance) concordanceMap.set(c.placeholder, c);

    // Collecte des initiales effectivement produites (pour highlight)
    const initialesSet = new Set();

    const anonymized = sourceText.replace(bigRegex, (match, ...groups) => {
      const captures = groups.slice(0, patternCount * 2);

      let matchedIdx = -1;
      for (let i = 0; i < patternCount; i++) {
        if (captures[i * 2 + 1] !== undefined) { matchedIdx = i; break; }
      }
      if (matchedIdx < 0) return match;

      const titreInText = captures[matchedIdx * 2]     || '';
      const matchedName = captures[matchedIdx * 2 + 1] || '';

      // ── Règle de substitution ─────────────────────────────────────────
      const { ph, initialeOnly, isCombo } = table[matchedIdx];

      // Concordance
      const entry   = ph ? concordanceMap.get(ph) : null;
      const replaced = (titreInText + matchedName).trim();
      if (entry && !entry.replacedForms.includes(replaced)) {
        entry.replacedForms.push(replaced);
      }

      if (isCombo) {
        // Combo prénom+nom : "Mahidine BOUCHAABA" → "M. [NOM_1]"
        // titreInText = éventuel titre, initialeOnly = initiale du prénom, ph = placeholder du nom
        if (initialeOnly) initialesSet.add(initialeOnly);
        return titreInText + initialeOnly + ' ' + ph;
      }

      if (initialeOnly) {
        // Prénom seul → initiale (le titre est conservé s'il est présent)
        initialesSet.add(initialeOnly);
        return titreInText + initialeOnly;
      }

      if (!ph) return match; // sécurité

      // Nom seul → titre conservé + placeholder
      return titreInText + ph;
    });

    const finalConcordance = concordance.filter(c => c.replacedForms.length > 0);
    return { anonymized, concordance: finalConcordance, initiales: [...initialesSet] };
  }

  function highlight(text, initiales) {
    const escaped = (text || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 1. Coloriser les initiales de prénom (ex: "M.", "I.", "A.")
    //    On les passe en paramètre pour éviter les faux positifs
    let result = escaped;
    if (initiales && initiales.length > 0) {
      // Trier par longueur décroissante (sécurité si initiales multi-char)
      const sorted = [...initiales].sort((a, b) => b.length - a.length);
      for (const ini of sorted) {
        const esc = ini.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Matcher l'initiale en contexte : précédée d'un espace/début, suivie d'un espace/placeholder/fin
        const re = new RegExp(`(?<=[\\s>]|^)(${esc})(?=[\\s<]|$)`, 'g');
        result = result.replace(re, '<mark class="ph ph-initiale">$1</mark>');
      }
    }

    // 2. Coloriser les placeholders [TYPE_N] par type
    result = result.replace(/\[([A-ZÉÈÀÙÂÊÎÔÛÄËÏÖÜ0-9_]+)\]/g, (match, inner) => {
      const type = inner.split('_')[0].toLowerCase()
        .replace(/[éê]/g, 'e').replace(/[èë]/g, 'e')
        .replace(/[àâ]/g, 'a').replace(/[ùû]/g, 'u')
        .replace(/[îï]/g, 'i').replace(/[ôö]/g, 'o')
        .replace(/[^a-z]/g, '');
      return `<mark class="ph ph-${type}">${match}</mark>`;
    });

    return result;
  }

  function csvEscape(s) {
    if (!s) return '';
    if (s.includes(';') || s.includes('"') || s.includes('\n'))
      return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(concordance) {
    const rows = [
      'Placeholder;Valeur originale;Alias;Formes remplacées;Type;Civilité forcée;Initiale',
      ...(concordance || []).map(r =>
        [
          r.placeholder,
          csvEscape(r.value),
          csvEscape((r.aliases || []).join(' | ')),
          csvEscape((r.replacedForms || []).join(' | ')),
          csvEscape(r.label || r.type || ''),
          csvEscape(r.forcedCivility || ''),
          csvEscape(r.initialPrefix || ''),
        ].join(';')
      ),
    ];
    return '\uFEFF' + rows.join('\n');
  }

  return { run, highlight, toCsv, flexPattern };
})();