
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const JWT_SECRET = process.env.JWT_SECRET;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ── Auth middleware ──
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'Pa autorizim' });
  try {
    req.user = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Token i pavlefshëm' }); }
}

// ── LOGIN ──
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Kredenciale të gabuara' });
});

// ── GET DOCUMENTS ──
app.get('/api/documents', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('documents')
    .select('id, name, file_type, size_chars, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE DOCUMENT ──
app.delete('/api/documents/:id', auth, async (req, res) => {
  const { error } = await supabase.from('documents').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── UPLOAD + EXTRACT ──
app.post('/api/upload', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nuk u dërgua skedar' });
  const { originalname, buffer, mimetype } = req.file;
  const ext = originalname.split('.').pop().toLowerCase();

  try {
    let text = '';

    if (ext === 'pdf') {
      text = await extractPDF(buffer);
    } else if (['doc', 'docx'].includes(ext)) {
      const r = await mammoth.extractRawText({ buffer });
      text = r.value;
    } else if (['xls', 'xlsx'].includes(ext)) {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      text = wb.SheetNames.map(sn => `[Fleta: ${sn}]\n` + XLSX.utils.sheet_to_csv(wb.Sheets[sn])).join('\n\n');
    } else if (['ppt', 'pptx'].includes(ext)) {
      text = await extractPPT(buffer);
    } else if (['png', 'jpg', 'jpeg', 'bmp', 'gif', 'tiff', 'webp'].includes(ext)) {
      text = await ocrWithClaude(buffer.toString('base64'), mimetype);
    }

    // If PDF returned little text, use Claude Vision page by page
    if (ext === 'pdf' && text.replace(/\s+/g, '').length < 100) {
      text = await ocrPDFWithClaude(buffer);
    }

    const { data, error } = await supabase.from('documents').insert({
      name: originalname, content: text, file_type: ext,
      size_chars: text.replace(/\s+/g, '').length
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ id: data.id, name: data.name, size_chars: data.size_chars });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Gabim gjatë procesimit: ' + e.message });
  }
});

// ── CHAT ──
app.post('/api/chat', auth, async (req, res) => {
  const { message, history, docIds } = req.body;

  // Load selected docs (or all if none specified)
  let query = supabase.from('documents').select('name, content');
  if (docIds && docIds.length > 0) query = query.in('id', docIds);
  const { data: docs } = await query;

  let ctx = '';
  if (docs && docs.length > 0) {
    ctx = '=== DOKUMENTAT ===\n\n' +
      docs.map(d => `--- ${d.name} ---\n${(d.content || '').slice(0, 9000)}`).join('\n\n') +
      '\n\n=== FUND ===\n\n';
  }

  const messages = [
    ...(history || []),
    { role: 'user', content: ctx + 'Pyetja: ' + message }
  ];

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514', max_tokens: 1500,
      system: 'Ti je një asistent zyre inteligjent. Gjithmonë përgjigju VETËM në shqip. Përdor dokumentat si kontekst kryesor, kombino me njohuri të përgjithshme kur nevojitet.',
      messages
    })
  });
  const data = await resp.json();
  const reply = data?.content?.map(b => b.text || '').join('') || 'Gabim.';
  res.json({ reply });
});

// ── PDF extraction ──
async function extractPDF(buffer) {
  // Dynamic import for ESM pdfjs
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => require('pdfjs-dist'));
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += `\n[Faqja ${i}]\n` + content.items.map(s => s.str).join(' ');
  }
  return text.trim();
}

async function ocrPDFWithClaude(buffer) {
  // Convert PDF pages to images server-side using canvas (optional, fallback: send raw PDF)
  const b64 = buffer.toString('base64');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514', max_tokens: 4000,
      messages: [{
        role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
          { type: 'text', text: 'Ekstrakto të gjithë tekstin nga ky dokument PDF. Kthe vetëm tekstin, pa komente.' }
        ]
      }]
    })
  });
  const d = await resp.json();
  return d?.content?.map(b => b.text || '').join('') || '';
}

async function ocrWithClaude(b64, mediaType) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514', max_tokens: 2000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
        { type: 'text', text: 'Ekstrakto të gjithë tekstin nga ky imazh.' }
      ]}]
    })
  });
  const d = await resp.json();
  return d?.content?.map(b => b.text || '').join('') || '';
}

async function extractPPT(buffer) {
  // Basic XML extraction for PPTX
  const JSZip = require('jszip').catch ? require('jszip') : null;
  if (!JSZip) return '[PPT: instalo jszip]';
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files).filter(f => /ppt\/slides\/slide\d+\.xml$/.test(f)).sort();
  let text = '';
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async('string');
    text += `\n[Diapozitivi ${i + 1}]\n` + xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return text;
}

app.get('/', (req, res) => res.send('Asistent Zyre Backend — OK'));
app.listen(3000, () => console.log('Server duke punuar në port 3000'));
