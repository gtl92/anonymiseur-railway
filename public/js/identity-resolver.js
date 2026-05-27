/**
 * identity-resolver.js
 * ------------------------------------------------------------
 * Module intermédiaire à brancher entre analysis.js et anonymize.js
 *
 * Objectif :
 * - fusionner les entités représentant la même personne
 * - enrichir les alias (Monsieur X, Madame X, prénom + nom, etc.)
 * - construire des entités "COUPLE" stables
 * - éviter les placeholders incohérents pour un même couple
 *
 * Principe casse :
 * - TOUTES les comparaisons internes se font en minuscules via fold()
 * - Les valeurs AFFICHÉES (value, aliases) sont normalisées en Title Case
 *   via normalizeDisplayName() au moment de la création/fusion uniquement
 *
 * Compatible avec le format d'entité existant :
 * {
 *   id, value, type, label, occurrences, aliases, active, blocked
 * }
 *
 * Usage :
 *   const detected = await Analysis.analyze(text, null, onProgress);
 *   const resolved = IdentityResolver.resolve(text, detected, { onProgress });
 *   // → resolved contient aussi resolved.suggestions (pour la modale Parties)
 */

const IdentityResolver = (() => {

  const TITRES = new Set([
    'monsieur', 'madame', 'm.', 'mme', 'mme.', 'me', 'me.',
    'maître', 'maitre', 'dr', 'dr.', 'docteur', 'pr', 'pr.', 'professeur',
    'mesdames', 'messieurs',
  ]);

  const PARTICULES = new Set([
    'de', 'du', 'des', "d'", 'le', 'la', 'les', 'van', 'von', 'da', 'del', 'della',
  ]);

  const COUPLE_WORDS = new Set([
    'epoux', 'époux', 'couple', 'mari', 'epouse', 'épouse',
  ]);

  // ── Point d'entrée principal ─────────────────────────────────────────────

  function resolve(text, entities, options = {}) {
    const onProgress  = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const couplePrefix = options.couplePrefix || 'COUPLE';

    const sourceEntities = Array.isArray(entities) ? entities : [];
    const rawText        = typeof text === 'string' ? text : '';

    onProgress(5, 'Préparation des entités…');

    // 1. Clone + nettoyage
    const cloned = sourceEntities
      .filter(Boolean)
      .map(cloneEntity)
      .filter(e => e.value.length > 0);

    onProgress(15, 'Déduplication exacte…');
    const deduped = dedupeExact(cloned);

    onProgress(30, 'Séparation personnes / autres…');
    const { persons, others } = splitEntities(deduped);

    onProgress(45, 'Fusion des variantes de personnes…');
    const mergedPersons = mergePersons(persons);

    onProgress(60, 'Enrichissement des alias…');
    enrichPersonAliases(mergedPersons);

    onProgress(72, 'Détection des couples…');

    // Séparer les COUPLE déjà détectés par analysis.js pour ne pas les recréer
    const existingCouples = others.filter(e => e.type === 'COUPLE');
    const nonCoupleOthers = others.filter(e => e.type !== 'COUPLE');

    const newCouples = buildCouples(rawText, mergedPersons, couplePrefix, existingCouples);

    onProgress(85, 'Désambiguïsation des noms ambigus…');
    disambiguateSurnameAliases(mergedPersons);

    onProgress(92, 'Calcul des suggestions de regroupement…');
    const suggestions = buildGroupingSuggestions(mergedPersons);

    onProgress(100, `${mergedPersons.length + nonCoupleOthers.length + existingCouples.length + newCouples.length} entités résolues`);

    const finalEntities = [
      ...nonCoupleOthers,
      ...mergedPersons,
      ...existingCouples,
      ...newCouples,
    ];

    // On attache les suggestions à l'objet retourné
    // (récupérables via IdentityResolver._lastSuggestions)
    IdentityResolver._lastSuggestions = suggestions;

    return finalEntities;
  }

  // ── Helpers de base ──────────────────────────────────────────────────────

  function cloneEntity(e) {
    return {
      id:          e.id || `loc_${Math.random().toString(36).slice(2, 11)}`,
      value:       normalizeDisplayName(e.value || ''),
      type:        e.type  || 'NOM',
      label:       e.label || e.type || 'NOM',
      occurrences: Number(e.occurrences || 1),
      aliases:     Array.isArray(e.aliases)
                     ? e.aliases.map(a => normalizeDisplayName(a)).filter(Boolean)
                     : [],
      active:      e.active  !== false,
      blocked:     e.blocked === true,
    };
  }

  function normalizeSpaces(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function deaccent(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  /** Clé de comparaison : minuscules + sans accents + espaces normalisés */
  function fold(s) {
    return deaccent(normalizeSpaces(s)).toLowerCase();
  }

  function titleCaseWord(s) {
    if (!s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }

  /** Normalise une valeur pour l'affichage (Title Case, tirets/apostrophes préservés) */
  function normalizeDisplayName(s) {
    return normalizeSpaces(s)
      .split(/\s+/)
      .map(part => {
        if (!part) return part;
        return part
          .split(/([-'])/)
          .map(chunk => /^[A-Za-zÀ-ÖØ-öø-ÿ]/.test(chunk) ? titleCaseWord(chunk) : chunk)
          .join('');
      })
      .join(' ');
  }

  function isTitleToken(token) {
    return TITRES.has(fold(token));
  }

  function isCoupleWord(token) {
    return COUPLE_WORDS.has(fold(token));
  }

  function isLikelyNameToken(token) {
    const t = normalizeSpaces(token);
    if (!t || isTitleToken(t) || isCoupleWord(t)) return false;
    if (/^\d+$/.test(t)) return false;
    return /^[A-ZÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ''\-]+$/.test(t) || /^[A-ZÀ-Ö]{2,}$/.test(t);
  }

  function stripLeadingTitles(value) {
    const parts = normalizeSpaces(value).split(/\s+/);
    let i = 0;
    while (i < parts.length && isTitleToken(parts[i])) i++;
    return normalizeSpaces(parts.slice(i).join(' '));
  }

  function tokenizeName(value) {
    return stripLeadingTitles(value).split(/\s+/).filter(Boolean);
  }

  function getSurname(value) {
    const parts = tokenizeName(value).filter(p => !PARTICULES.has(fold(p)));
    return parts.length > 0 ? parts[parts.length - 1] : '';
  }

  function getFirstName(value) {
    const parts = tokenizeName(value);
    return parts.length > 0 ? parts[0] : '';
  }

  function isPersonLikeEntity(e) {
    if (!e || e.blocked || !e.active) return false;
    if (e.type !== 'NOM') return false;
    const parts = tokenizeName(e.value);
    if (parts.length === 0 || parts.length > 4) return false;
    return parts.every(isLikelyNameToken);
  }

  // ── Déduplication / séparation ───────────────────────────────────────────

  function dedupeExact(entities) {
    const map = new Map();
    for (const e of entities) {
      const key = `${e.type}::${fold(e.value)}`;
      if (!map.has(key)) {
        map.set(key, e);
      } else {
        const existing = map.get(key);
        existing.occurrences = Math.max(existing.occurrences || 1, e.occurrences || 1);
        for (const alias of e.aliases || []) addAlias(existing, alias);
      }
    }
    return [...map.values()];
  }

  function splitEntities(entities) {
    const persons = [];
    const others  = [];
    for (const e of entities) {
      (isPersonLikeEntity(e) ? persons : others).push(e);
    }
    return { persons, others };
  }

  // ── Fusion des personnes ─────────────────────────────────────────────────

  function mergePersons(persons) {
    // Étape 1 : noms complets (≥ 2 tokens) — dédup par clé exacte
    const fullNames   = persons.filter(p => tokenizeName(p.value).length >= 2);
    const simpleNames = persons.filter(p => tokenizeName(p.value).length === 1);

    const byExact = new Map();
    for (const p of fullNames) {
      const key = fold(stripLeadingTitles(p.value));
      if (!byExact.has(key)) {
        byExact.set(key, p);
      } else {
        mergeEntityInto(byExact.get(key), p);
      }
    }

    const mergedFull = [...byExact.values()];

    // Index nom de famille → liste de personnes (fold pour la comparaison)
    const surnameIndex = new Map();
    for (const p of mergedFull) {
      const surname = fold(getSurname(p.value));
      if (!surname) continue;
      if (!surnameIndex.has(surname)) surnameIndex.set(surname, []);
      surnameIndex.get(surname).push(p);
    }

    // Étape 2 : rattacher les noms simples non ambigus
    for (const s of simpleNames) {
      const surnameKey = fold(stripLeadingTitles(s.value));
      const candidates = surnameIndex.get(surnameKey) || [];
      if (candidates.length === 1) {
        mergeEntityInto(candidates[0], s);
        addAlias(candidates[0], s.value);
      } else {
        mergedFull.push(s); // ambigu ou orphelin → conservé seul
      }
    }

    // Étape 3 : dédup finale par clé d'identité
    const finalMap = new Map();
    for (const p of mergedFull) {
      const key = buildPersonIdentityKey(p);
      if (!finalMap.has(key)) {
        finalMap.set(key, p);
      } else {
        mergeEntityInto(finalMap.get(key), p);
      }
    }

    return [...finalMap.values()];
  }

  function buildPersonIdentityKey(entity) {
    const v     = stripLeadingTitles(entity.value);
    const parts = tokenizeName(v);
    if (parts.length >= 2) {
      return `FULL::${fold(parts[0])}::${fold(getSurname(v))}`;
    }
    return `SIMPLE::${fold(v)}`;
  }

  function mergeEntityInto(target, source) {
    target.occurrences = Math.max(target.occurrences || 1, source.occurrences || 1);

    // Le pivot garde la forme la plus longue comme valeur principale
    if (tokenizeName(source.value).length > tokenizeName(target.value).length) {
      addAlias(target, target.value);
      target.value = normalizeDisplayName(source.value);
    } else {
      addAlias(target, source.value);
    }

    for (const alias of source.aliases || []) addAlias(target, alias);
  }

  function addAlias(entity, alias) {
    const a = normalizeDisplayName(alias || '');
    if (!a || fold(a) === fold(entity.value)) return;
    if (!entity.aliases.some(x => fold(x) === fold(a))) {
      entity.aliases.push(a);
    }
  }

  // ── Enrichissement des alias ─────────────────────────────────────────────

  function enrichPersonAliases(persons) {
    for (const p of persons) {
      const clean     = stripLeadingTitles(p.value);
      const parts     = tokenizeName(clean);
      if (parts.length === 0) continue;

      const firstName = getFirstName(clean);
      const surname   = getSurname(clean);

      if (firstName) addAlias(p, firstName);
      if (surname)   addAlias(p, surname);

      if (surname) {
        addAlias(p, `Monsieur ${surname}`);
        addAlias(p, `Madame ${surname}`);
        addAlias(p, `M. ${surname}`);
        addAlias(p, `Mme ${surname}`);
        addAlias(p, `Mme. ${surname}`);
      }

      if (parts.length >= 2) {
        addAlias(p, clean);
        addAlias(p, `${surname} ${firstName}`);    // inversion NOM Prénom
        addAlias(p, `Monsieur ${clean}`);
        addAlias(p, `Madame ${clean}`);
        addAlias(p, `M. ${clean}`);
        addAlias(p, `Mme ${clean}`);
      }

      // NE PAS générer "Madame Prénom épouse Nom" comme alias générique
      // (ce pattern est géré en amont par analysis.js — passe rx4)
    }
  }

  // ── Couples ──────────────────────────────────────────────────────────────

  function buildCouples(text, persons, couplePrefix, existingCouples) {
    const couples = [];

    // Construire un Set des clés de couples déjà existants pour éviter les doublons
    const existingKeys = new Set(
      (existingCouples || []).map(e => fold(stripLeadingTitles(e.value)))
    );

    const seen = new Set([...existingKeys]);

    const surnameToPersons = new Map();
    for (const p of persons) {
      const surname = fold(getSurname(p.value));
      if (!surname) continue;
      if (!surnameToPersons.has(surname)) surnameToPersons.set(surname, []);
      surnameToPersons.get(surname).push(p);
    }

    // Pattern 1 : "Prénom et Prénom Nom"
    const rxPP = /\b([A-ZÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ''\-]+)\s+et\s+([A-ZÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ''\-]+)\s+([A-ZÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ''\-]+)\b/g;

    // Pattern 2 : "Monsieur et Madame Nom"
    const rxMM = /\b(?:Monsieur|M\.)\s+et\s+(?:Madame|Mme)\s+([A-ZÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ''\-]+)\b/gi;

    // Pattern 3 : "les époux Nom"
    const rxEp = /\b(?:les\s+époux|epoux)\s+([A-ZÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ''\-]+)\b/gi;

    let m;

    while ((m = rxPP.exec(text)) !== null) {
      // Ignorer si un des tokens est un titre civil
      if (TITRES.has(fold(m[1])) || TITRES.has(fold(m[2]))) continue;

      const p1  = normalizeDisplayName(m[1]);
      const p2  = normalizeDisplayName(m[2]);
      const nom = normalizeDisplayName(m[3]);
      const val = `${p1} et ${p2} ${nom}`;
      const key = fold(val);
      if (seen.has(key)) continue;
      seen.add(key);

      const ent = createGroupEntity(val, couplePrefix);
      addAlias(ent, `Monsieur et Madame ${nom}`);
      addAlias(ent, `M. et Mme ${nom}`);
      addAlias(ent, `Les époux ${nom}`);
      addAlias(ent, `Le couple ${nom}`);

      const mbr1 = findBestPerson(persons, `${p1} ${nom}`);
      const mbr2 = findBestPerson(persons, `${p2} ${nom}`);
      if (mbr1) addAlias(ent, mbr1.value);
      if (mbr2) addAlias(ent, mbr2.value);
      ent.members = [mbr1?.id, mbr2?.id].filter(Boolean);

      couples.push(ent);
    }

    while ((m = rxMM.exec(text)) !== null) {
      const nom  = normalizeDisplayName(m[1]);
      const val  = `Monsieur et Madame ${nom}`;
      const key  = fold(val);
      if (seen.has(key)) continue;
      seen.add(key);

      const candidates = surnameToPersons.get(fold(nom)) || [];
      const ent = createGroupEntity(val, couplePrefix);
      addAlias(ent, `M. et Mme ${nom}`);
      addAlias(ent, `Les époux ${nom}`);
      addAlias(ent, `Le couple ${nom}`);
      addAlias(ent, `Les conjoints ${nom}`);
      for (const c of candidates) addAlias(ent, c.value);
      ent.members = candidates.slice(0, 2).map(x => x.id);

      couples.push(ent);
    }

    while ((m = rxEp.exec(text)) !== null) {
      const nom = normalizeDisplayName(m[1]);
      const val = `Les époux ${nom}`;
      const key = fold(val);
      if (seen.has(key)) continue;
      seen.add(key);

      const candidates = surnameToPersons.get(fold(nom)) || [];
      const ent = createGroupEntity(val, couplePrefix);
      addAlias(ent, `Monsieur et Madame ${nom}`);
      addAlias(ent, `M. et Mme ${nom}`);
      addAlias(ent, `Le couple ${nom}`);
      addAlias(ent, `Les conjoints ${nom}`);
      for (const c of candidates) addAlias(ent, c.value);
      ent.members = candidates.slice(0, 2).map(x => x.id);

      couples.push(ent);
    }

    return couples;
  }

  function createGroupEntity(value, type) {
    return {
      id:          `grp_${Math.random().toString(36).slice(2, 11)}`,
      value:       normalizeDisplayName(value),
      type:        type || 'COUPLE',
      label:       type || 'COUPLE',
      occurrences: 1,
      aliases:     [],
      active:      true,
      blocked:     false,
      members:     [],
    };
  }

  function findBestPerson(persons, fullName) {
    const target = fold(stripLeadingTitles(fullName));
    for (const p of persons) {
      if (fold(stripLeadingTitles(p.value)) === target) return p;
      if ((p.aliases || []).some(a => fold(stripLeadingTitles(a)) === target)) return p;
    }
    return null;
  }

  // ── Désambiguïsation : nom seul ambigu → retirer, garder formes titrées ──

  function disambiguateSurnameAliases(persons) {
    const counts = new Map();
    for (const p of persons) {
      const s = fold(getSurname(p.value));
      if (s) counts.set(s, (counts.get(s) || 0) + 1);
    }

    for (const p of persons) {
      const surname    = getSurname(p.value);
      const surnameKey = fold(surname);
      if (!surname || (counts.get(surnameKey) || 0) <= 1) continue;

      // Retirer le nom seul (ambigu)
      p.aliases = p.aliases.filter(alias => fold(stripLeadingTitles(alias)) !== surnameKey);

      // Conserver les formes titrées (déjà ajoutées par enrichPersonAliases)
      // Pas besoin de les ré-ajouter ici
    }
  }

  // ── Suggestions de regroupement pour la modale Parties ───────────────────
  //
  // Pour chaque nom de famille partagé par ≥ 2 personnes, on génère
  // une suggestion { surname, members: [entity, entity, …] }
  // qui sera affichée dans la modale pour permettre à l'utilisateur
  // de déclarer qui est Demandeur / Défendeur.

  function buildGroupingSuggestions(persons) {
    const surnameMap = new Map();

    for (const p of persons) {
      const surname = fold(getSurname(p.value));
      if (!surname || surname.length < 2) continue;
      if (!surnameMap.has(surname)) surnameMap.set(surname, []);
      surnameMap.get(surname).push(p);
    }

    const suggestions = [];
    for (const [surname, members] of surnameMap) {
      if (members.length < 2) continue;
      suggestions.push({
        surname:     normalizeDisplayName(members[0] ? getSurname(members[0].value) : surname),
        members:     members,
      });
    }

    return suggestions;
  }

  // ── API publique ─────────────────────────────────────────────────────────

  // Applique les déclarations Parties à la liste d'entités.
  // partiesConfig = {
  //   demandeurs: [ { entityId, ordre } ],   // ordre = 1-based
  //   defendeurs: [ { entityId, ordre } ],
  // }
  // Modifie directement les entités dans State.entities.
  function applyParties(entities, partiesConfig) {
    const { demandeurs = [], defendeurs = [] } = partiesConfig || {};

    const roleMap = new Map();

    demandeurs.forEach(({ entityId, ordre }) => {
      roleMap.set(entityId, `DEMANDEUR_${ordre}`);
    });
    defendeurs.forEach(({ entityId, ordre }) => {
      roleMap.set(entityId, `DEFENDEUR_${ordre}`);
    });

    for (const ent of entities) {
      if (roleMap.has(ent.id)) {
        ent.type  = roleMap.get(ent.id);
        ent.label = roleMap.get(ent.id);
      }
    }

    return entities;
  }

  return {
    resolve,
    applyParties,
    _lastSuggestions: [],
  };

})();