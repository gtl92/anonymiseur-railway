/**
 * analysis.js — Détection locale des entités (100% offline, zéro réseau)
 * Stratégie :
 * - patterns regex spécifiques
 * - extracteur "titre + nom" (Madame Suhua Laprès → entité + alias)
 * - analyse typographique (casse majuscule)
 * - enrichissement doux : multi-mots, alias, couples
 * - résolution d'identité : fusion des entités liées par alias (personne pivot)
 * - nettoyage des sous-parties redondantes
 *
 * Objectif : améliorer l'existant sans le casser.
 */

const Analysis = (() => {

  // ── Blacklist interne (termes juridiques courants) ─────────────────────────
  const BLACKLIST_INTERNAL = new Set([
    // Civilités
    'madame','monsieur','maitre','mme','me','mesdames','messieurs',
    // Juridictions
    'tribunal','cour','cassation','appel','chambre','barreau','prefecture',
    'republique','etat','france','paris','lyon','marseille','versailles',
    // Procédure civile
    'procedure','abusive','dossier','jugement','ordonnance','signification',
    'assignation','conclusions','requete','article','condamner','paiement',
    'somme','titre','frais','impayes','echeance','trimestre','ordonner',
    'interets','dommages','execution','provisoire','droit','fondement',
    'code','civile','depens','debitrice','demande','jurisprudence',
    'decompte','proces','verbaux','assemblees','generales','exigibilite',
    'comptes','instance','audience','constitution','motif','registre',
    'lettre','lettres','cessation','commerce','fax',
    // Copropriété
    'syndicat','syndic','copropriete','copropietaires','copropietaire',
    'coproprietaires','coproprietaire','ensemble','immobilier',
    'cabinet','siege','avocat','huissier','debiteur','creance','commandement',
    // Mots outils
    'pour','dans','mais','bien','etre','cette','avant','sans','objet',
    'sont','etait','outre','part','elles','soit','ainsi','tout','seul',
    'notamment','avec','comme','votre','toujours','apres','alors','selon',
    'tous','plus','fois','aura','sera','faire','fait','leurs','ceux',
    'celui','celle','entre','autres','mesure','permet','simplement',
    'semble','comporte','depuis','dette','cadre','point','fonde',
    // Mois / temps
    'janvier','fevrier','mars','avril','mai','juin','juillet','aout',
    'septembre','octobre','novembre','decembre','date','dates','annee','annees',
    'lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche',
    // Basiques
    'de','la','du','les','le','ca','sur','au','aux','il','elle','contre',
    'ces','par','en','un','une','des','et','ou','ne','pas',
    'que','qui','dont','quoi','quand','comme','car','donc','or','ni','mais',
    'ayant','etant','faisant','pouvant','devant','ayant','voulant',
    'suite','lors','apres','avant','depuis','selon','entre','outre',
    // Faux positifs fréquents
    'pole','civil','euros','piece','pieces','prise','mail','proprietaire',
    'provision','ordre','recu','preuve','constater','seront','importance',
    'contester','derniere','reconnu','tort','juger','total','agit','hauteur',
    'factures','prejudice','financier','note','contrat','sdc','cie','rue',
    'adresse','barreau',
    // Mots de bordereau / pièces juridiques (causent des faux positifs "NOM Xxx")
    'page','pages','piecen','diagnostic','certificat','attestation',
    'courrier','courriers','courriel','courriels','lettre','lettres',
    'lrar','echange','echanges','email','emails','plan','plans',
    'photo','photos','photographie','photographies','relevé','releve',
    'factures','facture','ordonnance','ordonnances','petition','petitions',
    'rapport','rapports','annonce','annonces','bordereau','bordereaux',
    'communiquees','sous','reserves','notification','decision',
    'renouvellement','regional','regionale','demande','demandes',
    'logement','logements','locatif','social','sociale',
    'audience','refere','reference','dossier','face','masse',
    // Mots tout-caps fréquents dans les documents judiciaires (non-noms propres)
    'demeurant','demeurent','demeure','occupant','occupants',
    'habitat','habitation','etablissement','association','fondation',
    'plaise','plaises','juge','juges','president','greffier','greffe',
    'statuant','ordonnant','constatant','declarant','condamnant',
    'demandeur','demandeurs','defendeur','defendeurs','appelant',
    'intime','intimes','requerant','requerants',
    'against','pour','contre','par','sur','sous','toutes','reserves',
    // Acronymes institutionnels courants
    'oph','sas','selas','sarl','sci','eurl','epic','spa',
    'dpe','lrar','drihl','dalo','caf','cpam','crous',
    // Variantes OCR de mots courants
    'habita','etabliss','associe','associes','fondati',
  ]);

  // Blacklist externe chargée depuis blacklist.json (via /api/blacklist)
  let _externalBlacklist = new Set();

  // ── Patterns regex spécifiques ────────────────────────────────────────────
  const PATTERNS = {
    REF:     /\b(?:RG|N°|N°\s?RG)[:\s]+(\d[A-Z0-9\/-]*)\b/gi,
    ADRESSE: /\d{1,4}(?:bis|ter)?\s+(?:rue|avenue|boulevard|place|allée|quai|route|chemin|impasse|square|cours)\s+[^,;.\n]+(?:\s+\d{5}\s+[A-Z\s]+)?/gi,
    SIREN:   /\b\d{3}\s?\d{3}\s?\d{3}\b/g,
    IBAN:    /\bFR\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{3}\b/gi,
    EMAIL:   /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}\b/gi,
    PHONE:   /\b(?:0|\+33)[1-9](?:[\s.-]?\d{2}){4}\b/g,
    // Date de naissance : "né le 24 février 1964" / "née le 3 mars 1980"
    // Capture la date complète y compris le lieu éventuel "à Rivesaltes (66600)"
    NAISSANCE: /\bn[ée]e?\s+le\s+\d{1,2}\s+(?:janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(?:19|20)\d{2}(?:\s+[àa]\s+[A-ZÀ-Öa-zà-ö][A-Za-zÀ-Öà-ö\s-]{2,30}(?:\s*\(\d{5}\))?)?/gi,
  };

  // Titres civils reconnus (pour extraction "titre + nom")
  const TITRES_RX = /\b(Madame|Monsieur|M\.|Mme\.?|Ma?ître?|Docteur|Dr\.?|Professeur|Pr\.?)\s+([A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ''-]{1,}(?:\s+[A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ''-]{1,}){0,2})\b/g;

  const TITRES_CIVILS = new Set([
    'monsieur','madame','maitre','maître','mme','me','dr','pr','docteur','professeur','m.'
  ]);

  // Titres d'avocats/officiers → leurs noms doivent être bloqués
  const TITRES_AVOCATS = new Set(['maître','maitre','me','me.']);

  // ── Analyse principale ────────────────────────────────────────────────────
  async function analyze(text, _apiKey, onProgress = () => {}) {
    onProgress(5, 'Extraction par titres civils…');
    const entities = [];

    // ── PASSE A : Extracteur "titre + nom" ────────────────────────────────
    // Capte "Madame Suhua Laprès", "Monsieur Laprès", "Maître Dupont"
    // Crée l'entité NOM sur la partie nom (sans le titre),
    // et stocke les formes titrées comme alias.
    extractEntitiesFromTitres(text, entities);

    onProgress(10, 'Analyse des patterns spécifiques…');

    // ── PASSE 1 : Patterns spécifiques (REF, ADRESSE, SIREN, IBAN, EMAIL, PHONE, NAISSANCE)
    // Ces patterns sont explicites et fiables → on bypass la blacklist.
    for (const [type, regex] of Object.entries(PATTERNS)) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const val = normalizeValue(match[0].trim());
        if (!val) continue;
        if (entities.some(e => e.value.toLowerCase() === val.toLowerCase())) continue;

        if (type === 'NAISSANCE') {
          const ent = createEntity(val, 'REF');
          ent.label = 'Date naissance';
          entities.push(ent);
        } else {
          entities.push(createEntity(val, type));
        }
      }
    }

    onProgress(35, 'Analyse typographique simple…');

    // ── PASSE 2 : Mots en MAJUSCULES ou Initiale Majuscule (noms propres)
    const entityPattern = /\b(?:[A-ZÀ-Ö]{2,}|[A-ZÀ-Ö][a-zà-ö]{2,})\b/g;
    const freqMap = {};
    let m;

    while ((m = entityPattern.exec(text)) !== null) {
      const word = m[0];
      const before = text.slice(Math.max(0, m.index - 3), m.index).trim();
      if (['.', '!', '?', ':', '«'].includes(before.slice(-1))) continue;
      if (/^\d+$/.test(word)) continue;
      if (!isBlacklisted(word)) {
        freqMap[word] = (freqMap[word] || 0) + 1;
      }
    }

    // ── PASSE 3 : Candidats typographiques simples
    // Construire un set des valeurs déjà bloquées (avocats détectés en passe A)
    const blockedKeys = new Set(
      entities.filter(e => e.blocked).map(e => deaccent(e.value.toLowerCase()))
    );
    for (const [word, occurrences] of Object.entries(freqMap)) {
      const normalized = normalizeValue(word);
      if (!normalized) continue;
      const normKey = deaccent(normalized.toLowerCase());
      // Si déjà dans la liste → mettre à jour les occurrences et continuer
      const existing = entities.find(e => deaccent(e.value.toLowerCase()) === normKey);
      if (existing) {
        existing.occurrences = Math.max(existing.occurrences || 1, occurrences);
        continue;
      }
      // Ignorer si c'est un composant d'une entité bloquée
      if (blockedKeys.has(normKey)) continue;
      // Filtrer les mots courts (≤ 6 chars) qui n'apparaissent qu'une seule fois
      if (normalized.length <= 6 && occurrences < 2) continue;
      const ent = createEntity(normalized, 'NOM');
      ent.occurrences = occurrences;
      entities.push(ent);
    }

    onProgress(55, 'Détection multi-mots…');

    // ── Scan complémentaire avocats (après passe typographique) ──────────────
    // Marquer comme bloquées les entités NOM dont le nom apparaît dans
    // "Nom Avocat", "Nom Notaire", "Par Maître Nom", etc.
    const avocatCtxRx = /\b([A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ''-]+(?:\s+[A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ''-]+){0,2})\s+(?:Avocat|Notaire|Huissier|Commissaire\s+de\s+[Jj]ustice)\b/g;
    const avocatCtxRx2 = /\bPar\s+(?:Ma?ître?|Me\.?)\s+([A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ''-]+(?:\s+[A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ''-]+){0,2})\b/gi;
    const avocatNames = new Set();
    for (const rx of [avocatCtxRx, avocatCtxRx2]) {
      rx.lastIndex = 0;
      let ma;
      while ((ma = rx.exec(text)) !== null) {
        const nameParts = ma[1].trim().split(/\s+/);
        nameParts.forEach(p => avocatNames.add(deaccent(p.toLowerCase())));
        avocatNames.add(deaccent(ma[1].trim().toLowerCase()));
      }
    }
    // Bloquer les entités NOM dont tous les composants sont des noms d'avocats
    for (const ent of entities) {
      if (ent.type !== 'NOM') continue;
      const norm = deaccent(ent.value.toLowerCase());
      if (avocatNames.has(norm)) { ent.blocked = true; continue; }
      const parts = norm.split(/\s+/).filter(p => p.length >= 3);
      if (parts.length > 0 && parts.every(p => avocatNames.has(p))) ent.blocked = true;
    }

    // ── PASSE 4 : Détection multi-mots
    // On passe les entités déjà connues pour éviter les combos prénom+nom
    const multiWordCandidates = extractMultiWordCandidates(text, entities);
    for (const candidate of multiWordCandidates) {
      if (!entities.some(e => e.value.toLowerCase() === candidate.toLowerCase())) {
        entities.push(createEntity(candidate, 'NOM'));
      }
    }

    onProgress(70, 'Enrichissement des alias…');

    // ── PASSE 5 : Alias automatiques pour les personnes physiques
    enrichPersonAliases(entities);

    onProgress(80, 'Détection des couples…');

    // ── PASSE 6 : Entités relationnelles (couples, épouse, veuve…)
    const coupleEntities = extractCouples(text, entities);
    for (const couple of coupleEntities) {
      if (!entities.some(e => e.value.toLowerCase() === couple.value.toLowerCase())) {
        entities.push(couple);
      }
    }

    onProgress(90, 'Résolution d\'identité…');

    // ── PASSE 7 : Consolidation + résolution d'identité (personne pivot)
    const consolidated = consolidateEntities(entities);

    onProgress(95, 'Fusion des variantes orthographiques…');

    // ── PASSE 7b : Fusion fuzzy des NOM (variantes OCR)
    // Rattache "OUCHAABA" à "Mahidine Bouchaaba" via distance de Levenshtein ≤ 1
    const fuzzyMerged = mergeFuzzyNames(consolidated);

    onProgress(97, 'Nettoyage des sous-parties…');

    // ── PASSE 8 : Suppression des NOM simples redondants (sous-parties de multi-mots)
    const cleaned = removeRedundantSimpleNames(fuzzyMerged);

    onProgress(100, `${cleaned.length} entités détectées`);
    // Retirer les entités bloquées (avocats, officiers)
    return cleaned.filter(e => !e.blocked);
  }

  // ── PASSE A : Extraction "titre + nom" ───────────────────────────────────
  //
  // Nouvelle philosophie :
  //   "Monsieur Mahidine BOUCHAABA" → entité NOM = "BOUCHAABA", ent.prenom = "Mahidine"
  //   "Monsieur BOUCHAABA"          → entité NOM = "BOUCHAABA", pas de prénom
  //   "Maître HENNEQUIN"            → avocat → entité bloquée (blocked: true)
  //
  // Pas d'alias "Monsieur X", "Madame X", ni d'inversion "Mahidine BOUCHAABA".
  // Le prénom est stocké dans ent.prenom pour que le moteur génère l'initiale.
  //
  // Heuristique prénom/nom :
  //   - Si 2+ mots après le titre :
  //     • Dernier mot tout-caps → c'est le NOM, le reste = prénom
  //     • Sinon premier mot en casse mixte + dernier en casse mixte :
  //       le dernier est le NOM (convention "Prénom Nom")
  //
  function extractEntitiesFromTitres(text, entities) {
    TITRES_RX.lastIndex = 0;
    let m;
    while ((m = TITRES_RX.exec(text)) !== null) {
      const titre  = m[1].trim();
      const nomRaw = m[2].trim();
      if (!nomRaw || isBlacklisted(nomRaw)) continue;

      const titreKey = deaccent(titre.toLowerCase().replace(/\.$/, ''));
      const isAvocat = TITRES_AVOCATS.has(titreKey);

      const parts = nomRaw.trim().split(/\s+/);
      let nomFamille, prenomStr;

      if (parts.length === 1) {
        nomFamille = parts[0];
        prenomStr  = null;
      } else {
        // Heuristique : le mot tout-caps est le NOM de famille
        // Exemples :
        //   "Mahidine BOUCHAABA" → NOM=BOUCHAABA, prénom=Mahidine
        //   "BOUCHAABA Mahidine" → NOM=BOUCHAABA, prénom=Mahidine
        //   "Catherine HENNEQUIN" → NOM=HENNEQUIN, prénom=Catherine
        //   "Jean-Pierre Dupont" → NOM=Dupont, prénom=Jean-Pierre (aucun tout-caps)
        const allCapsIdx = parts.findIndex(p => p === p.toUpperCase() && /[A-ZÀ-Ö]{2,}/.test(p));

        if (allCapsIdx >= 0) {
          // Le mot tout-caps est le NOM
          nomFamille = parts[allCapsIdx];
          prenomStr  = parts.filter((_, i) => i !== allCapsIdx).join(' ') || null;
        } else {
          // Pas de mot tout-caps → convention Prénom Nom : le dernier est le NOM
          nomFamille = parts[parts.length - 1];
          prenomStr  = parts.slice(0, -1).join(' ');
        }

        // Nettoyer : si le prenom est vide ou ne contient que des titres, ignorer
        if (prenomStr && TITRES_CIVILS.has(deaccent(prenomStr.toLowerCase()))) {
          prenomStr = null;
        }
      }

      const nomNorm = normalizeValue(nomFamille);
      if (!nomNorm || isBlacklisted(nomNorm)) continue;

      // Vérification supplémentaire : si nomFamille est déjà connu comme prénom
      // d'une entité existante → c'est probablement une inversion, on inverse
      const nomNormLow = deaccent(nomNorm.toLowerCase());
      const isKnownAsPrenom = entities.some(e =>
        e.type === 'NOM' && e.prenom &&
        deaccent(e.prenom.toLowerCase()).split(/\s+/).some(p =>
          deaccent(p.toLowerCase()) === nomNormLow
        )
      );
      if (isKnownAsPrenom && prenomStr) {
        // Inverser : prenomStr contient le vrai NOM
        const tmp = nomFamille;
        nomFamille = prenomStr;
        prenomStr  = tmp;
      }

      // Chercher ou créer l'entité
      const key = deaccent(nomNorm.toLowerCase());
      let ent = entities.find(
        e => e.type === 'NOM' && deaccent(e.value.toLowerCase()) === key
      );
      if (!ent) {
        ent = createEntity(nomNorm, 'NOM');
        entities.push(ent);
      }

      // Marquer comme avocat si nécessaire
      if (isAvocat) ent.blocked = true;

      // Stocker le prénom (jamais comme alias)
      if (prenomStr && !ent.prenom) {
        ent.prenom = prenomStr.trim();
      }
    }
  }

  // ── Gestion de la blacklist ───────────────────────────────────────────────

  function setExternalBlacklist(words) {
    _externalBlacklist = new Set(
      words.map(w => deaccent(w.trim().toLowerCase())).filter(Boolean)
    );
  }

  function addToBlacklist(wordsArray) {
    wordsArray.forEach(w => {
      if (w.trim()) _externalBlacklist.add(deaccent(w.trim().toLowerCase()));
    });
  }

  function getBlacklistWords() {
    return [..._externalBlacklist];
  }

  function isBlacklisted(val) {
    if (!val) return false;
    const parts = deaccent(val.toLowerCase()).split(/\s+/);
    return parts.some(p => BLACKLIST_INTERNAL.has(p) || _externalBlacklist.has(p));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function deaccent(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function normalizeValue(val) {
    if (!val) return '';
    const trimmed = val.trim().replace(/\s+/g, ' ');
    if (trimmed === trimmed.toUpperCase() && trimmed.length > 3) return trimmed;
    return trimmed.split(/\s+/).map(capitalizePreservePunctuation).join(' ');
  }

  function capitalize(s) {
    if (!s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }

  function capitalizePreservePunctuation(s) {
    if (!s) return '';
    return s
      .split(/([-'])/)
      .map(part => /^[A-Za-zÀ-ÖØ-öø-ÿ]/.test(part) ? capitalize(part) : part)
      .join('');
  }

  function createEntity(val, type) {
    return {
      id:          `loc_${Math.random().toString(36).slice(2, 11)}`,
      value:       val,
      type:        type,
      label:       type,
      occurrences: 1,
      aliases:     [],
      active:      true,
      blocked:     false,
    };
  }

  function addAlias(entity, alias) {
    const a = normalizeValue(alias || '');
    if (!a || a.length <= 1) return;
    if (isBlacklisted(a)) return;
    if (a.toLowerCase() === entity.value.toLowerCase()) return;
    if (!entity.aliases.some(x => x.toLowerCase() === a.toLowerCase())) {
      entity.aliases.push(a);
    }
  }

  function extractMultiWordCandidates(text, entities) {
    const results = new Set();

    // Prénoms déjà identifiés (pour exclure les combos prénom+nom)
    const prenomSet  = new Set();
    const nomSet     = new Set();
    // Noms bloqués (avocats) — leurs composants ne doivent pas former de nouvelles entités
    const blockedSet = new Set();

    for (const e of entities) {
      if (e.type !== 'NOM') continue;
      nomSet.add(deaccent(e.value.toLowerCase()));
      if (e.blocked) {
        blockedSet.add(deaccent(e.value.toLowerCase()));
        e.value.split(/\s+/).forEach(p => {
          if (p.length >= 3) blockedSet.add(deaccent(p.toLowerCase()));
        });
      }
      if (e.prenom) {
        e.prenom.split(/\s+/).forEach(p => prenomSet.add(deaccent(p.toLowerCase())));
      }
    }

    const rx1 = /\b([A-ZÀ-Ö][a-zà-öø-ÿ''-]{1,}\s+[A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ''-]{1,})\b/g;
    const rx2 = /\b([A-ZÀ-Ö][a-zà-öø-ÿ''-]{1,}\s+[A-ZÀ-Ö][a-zà-öø-ÿ''-]{1,}\s+[A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ''-]{1,})\b/g;

    for (const rx of [rx2, rx1]) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(text)) !== null) {
        const candidate = normalizeValue(m[1]);
        const parts     = candidate.split(/\s+/);
        if (parts.some(p => TITRES_CIVILS.has(deaccent(p.toLowerCase())))) continue;
        if (parts.some(p => isBlacklisted(p))) continue;
        if (parts.every(p => p.length <= 2)) continue;

        const partsNorm = parts.map(p => deaccent(p.toLowerCase()));

        // Exclure si un composant appartient à un avocat bloqué
        if (partsNorm.some(p => blockedSet.has(p))) continue;

        // Exclure si c'est un combo prénom+nom déjà géré
        const hasPrenomKnown = partsNorm.some(p => prenomSet.has(p));
        const hasNomKnown    = partsNorm.some(p => nomSet.has(p));
        if (hasPrenomKnown && hasNomKnown) continue;

        results.add(candidate);
      }
    }

    return [...results];
  }

  function enrichPersonAliases(entities) {
    for (const ent of entities) {
      if (ent.type !== 'NOM') continue;

      // Alias = uniquement variantes de casse du nom de famille
      // Pas d'inversion "Prénom Nom", pas de "Monsieur X"
      const val = ent.value;

      // Variante tout-caps si la valeur est en casse mixte
      if (val !== val.toUpperCase()) {
        addAlias(ent, val.toUpperCase());
      }
      // Variante casse mixte si la valeur est tout-caps
      if (val === val.toUpperCase() && val.length > 1) {
        const mixed = val[0] + val.slice(1).toLowerCase();
        addAlias(ent, mixed);
      }

      // Prénom en variante tout-caps (pour le moteur d'anonymisation)
      // Stocké dans ent.prenomVariants pour être accessible sans polluer les alias.
      // IMPORTANT : ne pas générer les variantes si le "prénom" est lui-même
      // une entité NOM dominante — ce serait un bug d'inversion (ex: "Mabhidine"
      // avec prenom="Bouchaaba" ne doit pas générer BOUCHAABA comme pattern initiale)
      if (ent.prenom) {
        const p = ent.prenom;
        const pNorm = deaccent(p.toLowerCase());
        // Vérifier si ce "prénom" est en réalité un NOM connu (entité avec + occurrences)
        const isActuallyNOM = entities.some(other =>
          other.id !== ent.id &&
          other.type === 'NOM' &&
          deaccent(other.value.toLowerCase()) === pNorm &&
          (other.occurrences || 1) >= (ent.occurrences || 1)
        );
        if (!isActuallyNOM) {
          if (!ent.prenomVariants) ent.prenomVariants = [];
          if (!ent.prenomVariants.includes(p)) ent.prenomVariants.push(p);
          const pUp = p.toUpperCase();
          if (!ent.prenomVariants.includes(pUp)) ent.prenomVariants.push(pUp);
          if (p === pUp) {
            const pMixed = p[0] + p.slice(1).toLowerCase();
            if (!ent.prenomVariants.includes(pMixed)) ent.prenomVariants.push(pMixed);
          }
        }
      }
    }
  }

  function extractCouples(text, entities) {
    const couples = [];
    const seen = new Set();

    // "Daniel et Suhua X"
    const rx1 = /\b([A-ZÀ-Ö][a-zà-öø-ÿ''-]{1,})\s+et\s+([A-ZÀ-Ö][a-zà-öø-ÿ''-]{1,})\s+([A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ''-]{1,})\b/g;

    // "Monsieur et Madame X"
    const rx2 = /\b(Monsieur|M\.)\s+et\s+(Madame|Mme)\s+([A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ''-]{1,})\b/gi;

    // "les époux X"
    const rx3 = /\b(?:les\s+époux|epoux)\s+([A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ''-]{1,})\b/gi;

    // ── NOUVEAU : "Madame Y épouse / veuve / née X" ───────────────────────
    // Ex : "Madame Suhua Laprès épouse Mervoyer"
    //      "Mme Dupont née Martin"
    //      "Madame Laprès veuve Durand"
    const rx4 = /\b(?:Madame|Mme\.?)\s+([A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ''-]{1,}(?:\s+[A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ''-]{1,})?)\s+(?:épouse|epouse|veuve|née|nee)\s+([A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ''-]{1,})\b/gi;

    let m;

    while ((m = rx1.exec(text)) !== null) {
      if (TITRES_CIVILS.has(m[1].toLowerCase()) || TITRES_CIVILS.has(m[2].toLowerCase())) continue;
      const v1 = normalizeValue(`${m[1]} ${m[3]}`);
      const v2 = normalizeValue(`${m[2]} ${m[3]}`);
      const coupleVal = normalizeValue(`${m[1]} et ${m[2]} ${m[3]}`);
      const key = deaccent(coupleVal.toLowerCase());
      if (seen.has(key)) continue;
      seen.add(key);

      const ent = createEntity(coupleVal, 'COUPLE');
      addAlias(ent, `Monsieur et Madame ${m[3]}`);
      addAlias(ent, `Les époux ${m[3]}`);
      addAlias(ent, v1);
      addAlias(ent, v2);
      couples.push(ent);
    }

    while ((m = rx2.exec(text)) !== null) {
      const nom = normalizeValue(m[3]);
      const coupleVal = normalizeValue(`Monsieur et Madame ${nom}`);
      const key = deaccent(coupleVal.toLowerCase());
      if (seen.has(key)) continue;
      seen.add(key);

      const ent = createEntity(coupleVal, 'COUPLE');
      addAlias(ent, `M. et Mme ${nom}`);
      addAlias(ent, `Monsieur, Madame ${nom}`);
      addAlias(ent, `Les époux ${nom}`);
      addAlias(ent, `Les conjoints ${nom}`);
      addAlias(ent, `Le couple ${nom}`);
      couples.push(ent);
    }

    while ((m = rx3.exec(text)) !== null) {
      const nom = normalizeValue(m[1]);
      const coupleVal = normalizeValue(`Les époux ${nom}`);
      const key = deaccent(coupleVal.toLowerCase());
      if (seen.has(key)) continue;
      seen.add(key);

      const ent = createEntity(coupleVal, 'COUPLE');
      addAlias(ent, `Monsieur et Madame ${nom}`);
      addAlias(ent, `M. et Mme ${nom}`);
      addAlias(ent, `Monsieur, Madame ${nom}`);
      addAlias(ent, `Le couple ${nom}`);
      couples.push(ent);
    }

    // ── Traitement rx4 : "Madame Suhua Laprès épouse Mervoyer" ───────────
    // → crée deux entités NOM distinctes (nom d'usage + nom de naissance)
    // → les relie par alias croisés
    while ((m = rx4.exec(text)) !== null) {
      const nomUsage     = normalizeValue(m[1]); // ex: "Suhua Laprès"
      const nomNaissance = normalizeValue(m[2]); // ex: "Mervoyer"

      // Entité nom d'usage (peut déjà exister via passe A)
      let entUsage = entities.find(
        e => e.type === 'NOM' && deaccent(e.value.toLowerCase()) === deaccent(nomUsage.toLowerCase())
      );
      if (!entUsage) {
        entUsage = createEntity(nomUsage, 'NOM');
        entities.push(entUsage);
      }

      // Entité nom de naissance (peut déjà exister)
      let entNaissance = entities.find(
        e => e.type === 'NOM' && deaccent(e.value.toLowerCase()) === deaccent(nomNaissance.toLowerCase())
      );
      if (!entNaissance) {
        entNaissance = createEntity(nomNaissance, 'NOM');
        entities.push(entNaissance);
      }

      // Alias croisés
      addAlias(entUsage,     nomNaissance);
      addAlias(entUsage,     `Madame ${nomUsage}`);
      addAlias(entNaissance, nomUsage);
      addAlias(entNaissance, `Madame ${nomNaissance}`);
    }

    return couples;
  }

  // ── PASSE 7b : Fusion fuzzy des variantes orthographiques (OCR) ──────────
  //
  // Après consolidation, rapproche les entités NOM dont les valeurs diffèrent
  // seulement par 1 caractère (typiquement des variantes OCR).
  // Exemple : "OUCHAABA" (1 occurrence) est absorbé dans "Mahidine Bouchaaba"
  //           parce que distance_Levenshtein("OUCHAABA","BOUCHAABA") = 1 et
  //           que "Bouchaaba" est un composant du nom.
  //
  // Stratégie : pour chaque entité NOM courte (1 mot), on cherche si un de ses
  // composants fuzzy-match un composant d'une autre entité NOM plus complète
  // (occurrence plus élevée). Si oui, on fusionne.
  //
  function mergeFuzzyNames(entities) {
    const nomEntities = entities.filter(e => e.type === 'NOM');
    const otherEntities = entities.filter(e => e.type !== 'NOM');
    const toRemove = new Set();

    // Trier par occurrences décroissantes → les entités dominantes sont des "pivots"
    const sorted = [...nomEntities].sort(
      (a, b) => (b.occurrences || 1) - (a.occurrences || 1)
    );

    for (const candidate of sorted) {
      if (toRemove.has(candidate.id)) continue;
      const candidateParts = candidate.value.split(/\s+/);
      if (candidate.value.length < 5) continue;

      // Cas 1 : entité mono-mot → on cherche un pivot multi-mots qui a un
      // composant fuzzy-égal au candidat (ex: "OUCHAABA" ≈ "Bouchaaba" dans "Mahidine Bouchaaba")
      // Cas 2 : entité multi-mots → on cherche un pivot multi-mots dont TOUS les
      // composants sont fuzzy-matchés par ceux du candidat (ex: "Bouchaaba Mabhidine"
      // ≈ "Mahidine Bouchaaba" car Mabhidine↔Mahidine et Bouchaaba↔Bouchaaba)
      for (const pivot of sorted) {
        if (pivot.id === candidate.id) continue;
        if (toRemove.has(pivot.id)) continue;
        const pivotParts = pivot.value.split(/\s+/);
        if ((pivot.occurrences || 1) <= (candidate.occurrences || 1)) continue;

        let fuzzyMatched = false;

        if (candidateParts.length === 1) {
          const candNorm = deaccent(candidate.value.toLowerCase());

          if (pivotParts.length >= 2) {
            // Cas 1 : candidat mono-mot → pivot multi-mots avec composant fuzzy-égal
            fuzzyMatched = pivotParts.some(p => {
              const pNorm = deaccent(p.toLowerCase());
              if (pNorm.length < 5 || candNorm.length < 5) return false;
              return levenshtein1(pNorm, candNorm);
            });
          } else if (pivotParts.length === 1) {
            // Cas 3 : candidat mono-mot → pivot mono-mot fuzzy-égal
            // (ex: "Mabhidine" ≈ "Mahidine", "OUCHAABA" ≈ "BOUCHAABA")
            // Seulement si le pivot est beaucoup plus fréquent (ratio ≥ 3×)
            const pivNorm = deaccent(pivot.value.toLowerCase());
            if (candNorm.length >= 5 && pivNorm.length >= 5 &&
                (pivot.occurrences || 1) >= 3 * (candidate.occurrences || 1) &&
                levenshtein1(candNorm, pivNorm)) {
              fuzzyMatched = true;
            }
          }
        } else if (candidateParts.length === pivotParts.length && pivotParts.length >= 2) {
          // Chaque composant du candidat doit matcher (strictement ou fuzzy) un
          // composant du pivot, sans ordre imposé.
          const pivotNorms = pivotParts.map(p => deaccent(p.toLowerCase()));
          const candNorms  = candidateParts.map(p => deaccent(p.toLowerCase()));
          const usedPivotIdx = new Set();
          let allMatch = true;
          for (const cn of candNorms) {
            let found = -1;
            for (let i = 0; i < pivotNorms.length; i++) {
              if (usedPivotIdx.has(i)) continue;
              if (cn === pivotNorms[i] ||
                  (cn.length >= 5 && pivotNorms[i].length >= 5 && levenshtein1(cn, pivotNorms[i]))) {
                found = i; break;
              }
            }
            if (found < 0) { allMatch = false; break; }
            usedPivotIdx.add(found);
          }
          fuzzyMatched = allMatch;
        }

        if (fuzzyMatched) {
          addAlias(pivot, candidate.value);
          for (const a of candidate.aliases || []) addAlias(pivot, a);
          pivot.occurrences = (pivot.occurrences || 1) + (candidate.occurrences || 1);
          toRemove.add(candidate.id);
          break;
        }
      }
    }

    const merged = nomEntities.filter(e => !toRemove.has(e.id));
    return [...merged, ...otherEntities];
  }

  /**
   * Test rapide : distance de Levenshtein ≤ 1 entre deux chaînes.
   * Retourne true si les chaînes sont identiques ou diffèrent d'un seul caractère
   * (substitution, insertion ou suppression).
   */
  function levenshtein1(a, b) {
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;

    // Longueurs égales : tester substitution d'un caractère
    if (la === lb) {
      let diffs = 0;
      for (let i = 0; i < la; i++) {
        if (a[i] !== b[i]) { diffs++; if (diffs > 1) return false; }
      }
      return diffs === 1;
    }

    // Longueurs diffèrent de 1 : tester insertion/suppression
    const shorter = la < lb ? a : b;
    const longer  = la < lb ? b : a;
    let i = 0, j = 0, skipped = false;
    while (i < shorter.length && j < longer.length) {
      if (shorter[i] === longer[j]) { i++; j++; }
      else if (skipped) return false;
      else { j++; skipped = true; }
    }
    return true;
  }

  // ── PASSE 7 : Consolidation + résolution d'identité (personne pivot) ─────
  //
  // Deux étapes :
  //   1. Fusion classique des doublons stricts (même type + même valeur normalisée)
  //   2. Résolution d'identité : si la VALUE d'une entité NOM est dans les ALIASES
  //      d'une autre entité NOM → fusion vers la plus longue (pivot le plus complet)
  //
  function consolidateEntities(entities) {
    // Étape 1 : fusion des doublons stricts
    const map = new Map();
    for (const ent of entities) {
      const key = `${ent.type}::${deaccent(ent.value.toLowerCase())}`;
      if (!map.has(key)) {
        map.set(key, { ...ent, aliases: [...(ent.aliases || [])] });
        continue;
      }
      const existing = map.get(key);
      existing.occurrences = Math.max(existing.occurrences || 1, ent.occurrences || 1);
      for (const alias of ent.aliases || []) {
        if (!existing.aliases.some(a => deaccent(a.toLowerCase()) === deaccent(alias.toLowerCase()))) {
          existing.aliases.push(alias);
        }
      }
    }

    let result = [...map.values()];

    // Étape 2 : résolution d'identité pour les NOM uniquement
    // On construit un index alias → entité pour repérer les recouvrements
    const nomEntities = result.filter(e => e.type === 'NOM');

    // Ensemble des entités à supprimer (absorbées par un pivot)
    const toRemove = new Set();

    for (const ent of nomEntities) {
      if (toRemove.has(ent.id)) continue;

      for (const other of nomEntities) {
        if (other.id === ent.id) continue;
        if (toRemove.has(other.id)) continue;

        const otherKeyNorm = deaccent(other.value.toLowerCase());

        // Est-ce que la valeur de `other` est un alias de `ent` ?
        const aliasMatch = ent.aliases.some(
          a => deaccent(a.toLowerCase()) === otherKeyNorm
        );

        if (aliasMatch) {
          // Le pivot est celui dont la valeur est la plus longue (nom complet)
          const pivotIsEnt = ent.value.length >= other.value.length;
          const pivot      = pivotIsEnt ? ent   : other;
          const absorbed   = pivotIsEnt ? other : ent;

          // Transfère les alias de l'absorbé vers le pivot
          addAlias(pivot, absorbed.value);
          for (const a of absorbed.aliases || []) {
            addAlias(pivot, a);
          }
          pivot.occurrences = Math.max(pivot.occurrences || 1, absorbed.occurrences || 1);

          toRemove.add(absorbed.id);
        }
      }
    }

    return result.filter(e => !toRemove.has(e.id));
  }

  // ── PASSE 8 : Suppression des NOM simples redondants ────────────────────
  //
  // Si "Laprès" (1 mot) est déjà dans les aliases de "Daniel Laprès"
  // → on supprime l'entité "Laprès" car elle est représentée par le pivot.
  //
  function removeRedundantSimpleNames(entities) {
    const nomEntities   = entities.filter(e => e.type === 'NOM');
    const otherEntities = entities.filter(e => e.type !== 'NOM');

    // Collecte tous les alias de toutes les entités NOM multi-mots
    const coveredByAlias = new Set();
    // Collecte les prénoms connus — mais seulement si ce prénom n'est PAS
    // lui-même une entité NOM dominante (pour éviter de supprimer BOUCHAABA
    // parce que Mabhidine a prenom=Bouchaaba par erreur d'inversion)
    const dominantNoms = new Set(
      nomEntities
        .filter(e => (e.occurrences || 1) >= 3)
        .map(e => deaccent(e.value.toLowerCase()))
    );
    const knownPrenoms = new Set();
    for (const ent of nomEntities) {
      for (const alias of ent.aliases) {
        coveredByAlias.add(deaccent(alias.toLowerCase()));
      }
      if (ent.prenom) {
        ent.prenom.split(/\s+/).forEach(p => {
          const pNorm = deaccent(p.toLowerCase());
          // Ne pas ajouter si c'est en réalité un NOM dominant
          if (p.length >= 2 && !dominantNoms.has(pNorm)) {
            knownPrenoms.add(pNorm);
          }
        });
      }
      if (ent.prenomVariants) {
        ent.prenomVariants.forEach(p => {
          const pNorm = deaccent(p.toLowerCase());
          if (p.length >= 2 && !dominantNoms.has(pNorm)) {
            knownPrenoms.add(pNorm);
          }
        });
      }
    }

    // Supprime les NOM simples :
    // 1. dont la valeur est couverte par un alias multi-mot
    // 2. dont la valeur est connue comme prénom d'une autre entité NOM
    const filteredNom = nomEntities.filter(ent => {
      if (ent.value.split(/\s+/).length > 1) return true; // multi-mots → toujours conservé
      const normVal = deaccent(ent.value.toLowerCase());
      if (coveredByAlias.has(normVal)) return false;
      if (knownPrenoms.has(normVal)) return false; // c'est un prénom, pas un NOM
      return true;
    });

    return [...filteredNom, ...otherEntities];
  }

  return {
    analyze,
    setExternalBlacklist,
    addToBlacklist,
    getBlacklistWords,
  };
})();