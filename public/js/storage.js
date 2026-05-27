/**
 * storage.js — Persistence des données
 * Stratégie : localStorage en priorité, PHP en option si disponible
 */

const Storage = (() => {
  const KEYS = {
    API_KEY:   'anon_api_key',
    OCR_RULES: 'anon_ocr_rules_v2',
    BLOCKED:   'anon_blocked_terms_v2',
  };

  // ── API Key ────────────────────────────────────────────────────────────────
  function getApiKey()       { return localStorage.getItem(KEYS.API_KEY) || ''; }
  function setApiKey(key)    { localStorage.setItem(KEYS.API_KEY, key); }

  // ── OCR Rules ──────────────────────────────────────────────────────────────
  // Format : [{id, from, to, caseSensitive, createdAt}]
  function getOcrRules() {
    try { return JSON.parse(localStorage.getItem(KEYS.OCR_RULES) || '[]'); }
    catch { return []; }
  }
  function setOcrRules(rules) {
    localStorage.setItem(KEYS.OCR_RULES, JSON.stringify(rules));
    // Sync vers PHP si disponible
    phpSync('ocr_rules', rules);
  }
  function addOcrRule(from, to, caseSensitive) {
    const rules = getOcrRules();
    const id = Date.now().toString(36);
    rules.push({ id, from, to, caseSensitive: !!caseSensitive, createdAt: Date.now() });
    setOcrRules(rules);
    return id;
  }
  function removeOcrRule(id) {
    const rules = getOcrRules().filter(r => r.id !== id);
    setOcrRules(rules);
  }
  function clearOcrRules() { setOcrRules([]); }

  // ── Blocked terms ──────────────────────────────────────────────────────────
  // Termes à ne jamais anonymiser (persistés)
  function getBlockedTerms() {
    try { return JSON.parse(localStorage.getItem(KEYS.BLOCKED) || '[]'); }
    catch { return []; }
  }
  function setBlockedTerms(terms) {
    localStorage.setItem(KEYS.BLOCKED, JSON.stringify(terms));
  }
  function addBlockedTerm(term) {
    const terms = getBlockedTerms();
    if (!terms.includes(term)) { terms.push(term); setBlockedTerms(terms); }
  }
  function removeBlockedTerm(term) {
    setBlockedTerms(getBlockedTerms().filter(t => t !== term));
  }

  // ── PHP sync (optionnel, pour Hostinger) ───────────────────────────────────
  async function phpSync(key, data) {
    if (!window.PHP_ENDPOINT) return; // Pas configuré
    try {
      await fetch(window.PHP_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', key, data }),
      });
    } catch { /* silencieux */ }
  }

  async function phpLoad(key) {
    if (!window.PHP_ENDPOINT) return null;
    try {
      const r = await fetch(`${window.PHP_ENDPOINT}?action=load&key=${key}`);
      const d = await r.json();
      return d.data || null;
    } catch { return null; }
  }

  // ── Init : charge depuis PHP si disponible, sinon localStorage ────────────
  async function init() {
    if (!window.PHP_ENDPOINT) return;
    const remoteOcr = await phpLoad('ocr_rules');
    if (remoteOcr && Array.isArray(remoteOcr)) {
      localStorage.setItem(KEYS.OCR_RULES, JSON.stringify(remoteOcr));
    }
  }

  return {
    getApiKey, setApiKey,
    getOcrRules, addOcrRule, removeOcrRule, clearOcrRules,
    getBlockedTerms, addBlockedTerm, removeBlockedTerm,
    init,
  };
})();
