/**
 * server.js — Anonymiseur judiciaire v2.10 (VPS IONOS / Node.js)
 * OCR PDF scanné : poppler-utils (pdftoppm) + tesseract.js
 * Ne dépend PLUS de pdfjs-dist ni de @napi-rs/canvas (source du bug DOMMatrix sur Railway).
 */

import 'dotenv/config';
import express       from 'express';
import multer        from 'multer';
import cors          from 'cors';
import { promises as fs } from 'fs';
import path          from 'path';
import os            from 'os';
import crypto        from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execFile }  from 'child_process';
import { promisify } from 'util';
import { createWorker } from 'tesseract.js';

const require       = createRequire(import.meta.url);
const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const PORT       = process.env.PORT       || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'tmp', 'uploads');
const OCR_DIR     = path.join(__dirname, 'tmp', 'ocr');
const DATA_DIR   = path.join(__dirname, 'data');
const BLACKLIST_FILE    = path.join(DATA_DIR, 'blacklist.json');
const CUSTOM_TYPES_FILE = path.join(DATA_DIR, 'custom_types.json');
const VERSION    = '2.10';

// Dossier des données linguistiques Tesseract installées via apt
// (détecté et écrit dans .env par install-vps.sh — voir TESSDATA_PATH).
const TESSDATA_PATH = process.env.TESSDATA_PATH || '/usr/share/tesseract-ocr/5/tessdata';
const OCR_DPI        = Number(process.env.OCR_DPI || 300);

// ── Initialisation des dossiers ───────────────────────────────────────────────

await fs.mkdir(UPLOAD_DIR, { recursive: true });
await fs.mkdir(OCR_DIR,    { recursive: true });
await fs.mkdir(DATA_DIR,   { recursive: true });

// ── Détection des dépendances optionnelles ────────────────────────────────────

function tryRequire(id) {
  try { require.resolve(id); return true; } catch { return false; }
}

const HAS_PDF_PARSE = tryRequire('pdf-parse');
const HAS_MAMMOTH   = tryRequire('mammoth');

async function popplerOk() {
  try {
    await execFileAsync('pdftoppm', ['-v']);
    return true;
  } catch { return false; }
}
const HAS_POPPLER = await popplerOk();

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

// ── Extraction PDF texte natif ────────────────────────────────────────────────

async function extractPdfNative(buffer) {
  if (!HAS_PDF_PARSE) return '';
  try {
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    const result = await pdfParse(buffer);
    return (result.text || '').trim();
  } catch { return ''; }
}

// ── OCR PDF scanné : pdftoppm (rasterisation) + tesseract.js (reconnaissance) ──

async function pdfToPngPages(buffer) {
  const id       = crypto.randomBytes(8).toString('hex');
  const pdfPath  = path.join(OCR_DIR, `${id}.pdf`);
  const prefix   = path.join(OCR_DIR, `${id}-page`);

  await fs.writeFile(pdfPath, buffer);
  try {
    // -r 300 : 300 dpi, bon compromis qualité OCR / temps de traitement
    await execFileAsync('pdftoppm', ['-r', String(OCR_DPI), '-png', pdfPath, prefix]);
  } catch (err) {
    // pdftoppm peut avoir écrit des pages partielles avant l'échec : les purger.
    const partial = (await fs.readdir(OCR_DIR).catch(() => []))
      .filter(f => f.startsWith(`${id}-page`))
      .map(f => path.join(OCR_DIR, f));
    await Promise.all(partial.map(p => fs.unlink(p).catch(() => {})));
    throw err;
  } finally {
    fs.unlink(pdfPath).catch(() => {});
  }

  const files = (await fs.readdir(OCR_DIR))
    .filter(f => f.startsWith(`${id}-page`) && f.endsWith('.png'))
    .sort()
    .map(f => path.join(OCR_DIR, f));

  return files;
}

/**
 * OCR + position des mots par page (pour le surlignage direct sur l'image
 * côté client — cf. anonymiseur front). Les PNG de page ne sont JAMAIS
 * conservés sur disque : lus en mémoire (base64) puis supprimés comme avant
 * (cf. DEPLOY.md — tmp/ocr doit rester vide après traitement).
 */
async function extractPdfOcr(buffer) {
  if (!HAS_POPPLER) throw new Error('ocr_unavailable');

  const pages = await pdfToPngPages(buffer);
  if (pages.length === 0) throw new Error('ocr_unavailable');

  let worker;
  try {
    worker = await createWorker('fra', 1, {
      langPath: TESSDATA_PATH,
      gzip: false, // les .traineddata installés via apt ne sont pas gzippés
    });
    const texts      = [];
    const pageBoxes  = [];
    const pageImages = [];
    for (const pagePath of pages) {
      const { data } = await worker.recognize(pagePath);
      texts.push(data.text || '');
      const words = (data.words || [])
        .filter(w => w.text && w.text.trim())
        .map(w => ({
          text: w.text,
          x0: w.bbox?.x0 ?? 0, y0: w.bbox?.y0 ?? 0,
          x1: w.bbox?.x1 ?? 0, y1: w.bbox?.y1 ?? 0,
        }));
      pageBoxes.push({ words });
      // Image lue en mémoire (pas de route statique) : cf. commentaire ci-dessus.
      const png = await fs.readFile(pagePath);
      pageImages.push(`data:image/png;base64,${png.toString('base64')}`);
    }
    return { text: texts.join('\n\n').trim(), pageBoxes, pageImages };
  } finally {
    if (worker) await worker.terminate();
    await Promise.all(pages.map(p => fs.unlink(p).catch(() => {})));
  }
}

/**
 * Tente l'extraction native en premier.
 * Si texte insuffisant (<50 chars/page), bascule sur OCR (poppler + tesseract.js).
 */
async function extractPdf(buffer) {
  const raw       = buffer.toString('binary');
  const pageCount = Math.max(1, (raw.match(/\/Page /g) || []).length);
  const native    = await extractPdfNative(buffer);

  if (native.length >= pageCount * 50) {
    return { text: native, method: 'native' };
  }

  try {
    const { text, pageBoxes, pageImages } = await extractPdfOcr(buffer);
    return { text, method: 'ocr', pageBoxes, pageImages };
  } catch (e) {
    if (e.message === 'ocr_unavailable') {
      return { text: native, method: 'ocr_unavailable' };
    }
    throw new Error(`ocr_error:${e.message}`);
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

// CORS restreint : le front est servi par ce même serveur (express.static),
// donc aucune origine externe n'est nécessaire en production. ALLOWED_ORIGINS
// permet d'ouvrir explicitement des origines de dev/tierces si besoin.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : false,
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/status
app.get('/api/status', (_req, res) => {
  res.json({
    ok:        true,
    version:   VERSION,
    tesseract: HAS_POPPLER,
    poppler:   HAS_POPPLER,
    pdfminer:  HAS_PDF_PARSE, // clé conservée pour compat frontend existant
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
  console.log(`  Anonymiseur judiciaire v${VERSION} — VPS IONOS`);
  console.log(bar);
  console.log(`  URL       : http://0.0.0.0:${PORT}`);
  console.log(`  Poppler   : ${HAS_POPPLER    ? '✓ pdftoppm détecté'  : '✗ absent (OCR indisponible)'}`);
  console.log(`  OCR       : ${HAS_POPPLER    ? '✓ tesseract.js prêt' : '✗ indisponible'}`);
  console.log(`  Tessdata  : ${TESSDATA_PATH}`);
  console.log(`  PDF       : ${HAS_PDF_PARSE  ? '✓ pdf-parse'         : '✗ absent'}`);
  console.log(`  DOCX      : ${HAS_MAMMOTH    ? '✓ mammoth'           : '✗ absent'}`);
  console.log(bar + '\n');
});
