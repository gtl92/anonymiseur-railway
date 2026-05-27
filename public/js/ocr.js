/**
 * ocr.js — Application des règles OCR et aperçu diff
 */

const OCR = (() => {

  /**
   * Applique les règles OCR sur un texte.
   * Retourne { text, changes } où changes = nombre de substitutions effectuées.
   */
  function applyRules(text, rules) {
    let result = text;
    let totalChanges = 0;
    for (const rule of rules) {
      const flags = rule.caseSensitive ? 'g' : 'gi';
      const escaped = escapeRegex(rule.from);
      const re = new RegExp(escaped, flags);
      const before = result;
      result = result.replace(re, rule.to);
      if (result !== before) {
        // Compte les remplacements
        const matches = before.match(new RegExp(escaped, flags));
        totalChanges += matches ? matches.length : 0;
      }
    }
    return { text: result, changes: totalChanges };
  }

  /**
   * Génère un aperçu HTML avec les changements mis en évidence.
   * Ins = texte ajouté (vert), Del = texte supprimé (rouge).
   * Optimisé pour les textes longs : on ne diff que les 2000 premiers chars.
   */
  function buildDiffPreview(original, modified, maxChars = 2000) {
    const orig = original.slice(0, maxChars);
    const mod  = modified.slice(0, maxChars);

    if (orig === mod) return escHtml(orig);

    // Diff mot par mot simple
    const origWords = tokenize(orig);
    const modWords  = tokenize(mod);
    const lcs = computeLCS(origWords, modWords);

    let html = '';
    let oi = 0, mi = 0, li = 0;
    while (oi < origWords.length || mi < modWords.length) {
      if (li < lcs.length && oi < origWords.length && mi < modWords.length
          && origWords[oi] === lcs[li] && modWords[mi] === lcs[li]) {
        html += escHtml(origWords[oi]);
        oi++; mi++; li++;
      } else if (mi < modWords.length && (li >= lcs.length || modWords[mi] !== lcs[li])) {
        html += `<ins>${escHtml(modWords[mi])}</ins>`;
        mi++;
      } else if (oi < origWords.length) {
        html += `<del>${escHtml(origWords[oi])}</del>`;
        oi++;
      } else break;
    }
    if (original.length > maxChars) html += `\n<span style="color:var(--ink4)">[… ${original.length - maxChars} caractères supplémentaires]</span>`;
    return html;
  }

  function tokenize(text) {
    // Découpe en tokens préservant les espaces/sauts de ligne
    return text.split(/(\s+)/).filter(t => t.length > 0);
  }

  function computeLCS(a, b) {
    // LCS simplifié — pas de DP complet pour les très longues séquences
    const limit = 300; // Au-delà, on tronque pour la perf
    const A = a.slice(0, limit);
    const B = b.slice(0, limit);
    const m = A.length, n = B.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = A[i-1] === B[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
    const result = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (A[i-1] === B[j-1]) { result.unshift(A[i-1]); i--; j--; }
      else if (dp[i-1][j] > dp[i][j-1]) i--;
      else j--;
    }
    return result;
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  return { applyRules, buildDiffPreview, escapeRegex };
})();
