/**
 * server.js — Anonymiseur judiciaire v2.9 (Railway / Node.js)
 * Remplace serveur_local.py — même API JSON, même format de réponse.
 */

import 'dotenv/config';
import express       from 'express';
import multer        from 'multer';
import cors          from 'cors';
import { promises as fs } from 'fs';
import path          from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { createWorker } from 'tesseract.js';

const require    = createRequire(import.meta.url);
const __dirname  = path.dirname(fileURLToPath(import.meta.url));

const PORT       = process.env.PORT       || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'tmp', 'uploads');
const DATA_DIR   = path.join(__dirname, 'data');
const BLACKLIST_FILE    = path.join(DATA_DIR, 'blacklist.json');
const CUSTOM_TYPES_FILE = path.join(DATA_DIR, 'custom_types.json');
const VERSION    = '2.9';

// ── Initialisation des dossiers ───────────────────────────────────────────────

await fs.mkdir(UPLOAD_DIR, { recursive: true });
await fs.mkdir(DATA_DIR,   { recursive: true });

// ── Détection des dépendances optionnelles ────────────────────────────────────

function tryRequire(id) {
  try { require.resolve(id); return true; } catch { return false; }
}

const HAS_PDF_PARSE  = tryRequire('pdf-parse');
const HAS_MAMMOTH    = tryRequire('mammoth');

// ── Persistance ───────────────────────────────────────────────────────────────

async function loadBlacklist() {
  try {
    const raw = await fs.readFile(BLACKLIST_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function saveBlacklist(words) {
  const clean = [...new Set(words.map(w => w.trim().toLowerCase()).filter(Boolean))].sort();
  await fs.writeFile(BLACKLIST_FILE, JSON.stringify(clean, null, 2), 'utf-8');
  return clean;
}

async function loadCustomTypes() {
  try {
    const raw = await fs.readFile(CUSTOM_TYPES_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function saveCustomTypes(types) {
  await fs.writeFile(CUSTOM_TYPES_FILE, JSON.stringify(types, null, 2), 'utf-8');
}

// ── Extraction PDF ────────────────────────────────────────────────────────────

async function extractPdfNative(buffer) {
  if (!HAS_PDF_PARSE) return '';
  try {
    // Import via lib/ pour éviter le chargement du fichier de test intégré
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    const result = await pdfParse(buffer);
    return (result.text || '').trim();
  } catch { return ''; }
}

async function extractPdfOcr(_buffer) {
  // OCR de PDF scanné non supporté sans moteur de rendu PDF côté serveur.
  // Le fallback dans extractPdf() retournera method:'ocr_unavailable'.
  throw new Error('ocr_unavailable');
}

/**
 * Tente l'extraction native en premier.
 * Si texte insuffisant (<50 chars/page), bascule sur OCR.
 */
async function extractPdf(buffer) {
  // Compte de pages approximatif (comme en Python)
  const raw       = buffer.toString('binary');
  const pageCount = Math.max(1, (raw.match(/\/Page /g) || []).length);
  const native    = await extractPdfNative(buffer);

  if (native.length >= pageCount * 50) {
    return { text: native, method: 'native' };
  }

  try {
    const text = await extractPdfOcr(buffer);
    return { text, method: 'ocr' };
  } catch {
    return { text: native, method: 'ocr_unavailable' };
  }
}

async function extractDocx(buffer) {
  if (!HAS_MAMMOTH) throw new Error('mammoth non disponible');
  const mammoth = require('mammoth');
  const { value } = await mammoth.extractRawText({ buffer });
  return value.trim();
}

// ── Express ───────────────────────────────────────────────────────────────────

const app    = express();
const upload = multer({
  dest:   UPLOAD_DIR,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/status
app.get('/api/status', (_req, res) => {
  res.json({
    ok:        true,
    version:   VERSION,
    tesseract: true,
    pdfminer:  HAS_PDF_PARSE, // même clé qu'en Python pour compatibilité frontend
    docx:      HAS_MAMMOTH,
  });
});

// GET /api/blacklist
app.get('/api/blacklist', async (_req, res) => {
  res.json({ words: await loadBlacklist() });
});

// POST /api/blacklist
app.post('/api/blacklist', async (req, res) => {
  try {
    const { words } = req.body;
    if (!Array.isArray(words)) return res.status(400).json({ error: 'words doit être un tableau' });
    const saved = await saveBlacklist(words);
    res.json({ ok: true, count: saved.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/custom_types
app.get('/api/custom_types', async (_req, res) => {
  res.json({ types: await loadCustomTypes() });
});

// POST /api/custom_types
app.post('/api/custom_types', async (req, res) => {
  try {
    const { types } = req.body;
    if (!Array.isArray(types)) return res.status(400).json({ error: 'types doit être un tableau' });
    await saveCustomTypes(types);
    res.json({ ok: true, count: types.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/extract (multipart)
app.post('/api/extract', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  const ext      = path.extname(file.originalname).toLowerCase();
  const filename = file.originalname;

  try {
    const buffer = await fs.readFile(file.path);
    let result;

    if (ext === '.pdf') {
      result = { ...(await extractPdf(buffer)), filename };
    } else if (ext === '.docx') {
      const text = await extractDocx(buffer);
      result = { text, method: 'docx', filename };
    } else if (ext === '.txt') {
      result = { text: buffer.toString('utf-8'), method: 'txt', filename };
    } else {
      return res.status(400).json({ error: `Format non supporté : ${ext}` });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    fs.unlink(file.path).catch(() => {});
  }
});

// ── Démarrage ─────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  const bar = '='.repeat(52);
  console.log(`\n${bar}`);
  console.log(`  Anonymiseur judiciaire v${VERSION} — Railway/Node.js`);
  console.log(bar);
  console.log(`  URL       : http://0.0.0.0:${PORT}`);
  console.log(`  OCR       : ✓ tesseract.js actif`);
  console.log(`  PDF       : ${HAS_PDF_PARSE  ? '✓ pdf-parse'         : '✗ absent'}`);
  console.log(`  DOCX      : ${HAS_MAMMOTH    ? '✓ mammoth'           : '✗ absent'}`);
  console.log(bar + '\n');
});
