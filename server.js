require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const ws = require('ws');
const { createClient } = require('@supabase/supabase-js');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.json({ limit: '10mb' }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } }
);

const JWT_SECRET = process.env.JWT_SECRET || 'secret123';
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`;
const GEMINI_VISION_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`;
// ── Auth middleware ──
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'Pa autorizim' });
  try {
    req.user = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token i pavlefshëm' });
  }
}

// ── Health check ──
app.get('/', (req, res) => res.json({ status: 'OK', message: 'Asistent Zyre Backend — Gemini' }));

// ── LOGIN ──
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Kredenciale të gabuara' });
});

// ── GET DOCUMENTS ──
app.get('/api/documents', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('id, name, file_type, size_chars, created_at')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE DOCUMENT ──
app.delete('/api/documents/:id', auth, async (req, res) => {
  try {
    const { error } = await supabase.from('documents').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── UPLOAD ──
app.post('/api/upload', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nuk u dërgua skedar' });
  const { originalname, buffer, mimetype } = req.file;
  const ext = originalname.split('.').pop().toLowerCase();

  try {
    let text = '';

    if (ext === 'pdf') {
      text = await geminiPDF(buffer);
    } else if (['doc', 'docx'].includes(ext)) {
      const r = await mammoth.extractRawText({ buffer });
      text = r.value;
    } else if (['xls', 'xlsx'].includes(ext)) {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      text = wb.SheetNames.map(sn =>
        `[Fleta: ${sn}]\n` + XLSX.utils.sheet_to_csv(wb.Sheets[sn])
      ).join('\n\n');
    } else if (['ppt', 'pptx'].includes(ext)) {
      text = await extractPPT(buffer);
    } else if (['png','jpg','jpeg','bmp','gif','tiff','webp'].includes(ext)) {
      text = await geminiImage(buffer.toString('base64'), mimetype);
    } else {
      return res.status(400).json({ error: 'Format i pambështetur' });
    }

    const { data, error } = await supabase.from('documents').insert({
      name: originalname,
      content: text,
      file_type: ext,
      size_chars: text.replace(/\s+/g, '').length
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ id: data.id, name: data.name, size_chars: data.size_chars });

  } catch (e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: 'Gabim: ' + e.message });
  }
});

// ── CHAT ──
app.post('/api/chat', auth, async (req, res) => {
  try {
    const { message, history, docIds } = req.body || {};

    let query = supabase.from('documents').select('name, content');
    if (docIds && docIds.length > 0) query = query.in('id', docIds);
    const { data: docs } = await query;

    let ctx = '';
    if (docs && docs.length > 0) {
      ctx = '=== DOKUMENTAT ===\n\n' +
        docs.map(d => `--- ${d.name} ---\n${(d.content || '').slice(0, 8000)}`).join('\n\n') +
        '\n\n=== FUND ===\n\n';
    }

    // Build conversation history for Gemini
    const contents = [];
    if (Array.isArray(history)) {
      history.slice(-10).forEach(h => {
        contents.push({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: h.content }]
        });
      });
    }
    contents.push({
      role: 'user',
      parts: [{ text: ctx + 'Pyetja: ' + message }]
    });

    const resp = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: 'Ti je një asistent zyre inteligjent dhe profesional. Gjithmonë përgjigju VETËM në shqip, pavarësisht gjuhës së pyetjes. Përdor dokumentat si kontekst kryesor dhe kombino me njohuri të përgjithshme kur nevojitet. Jep përgjigje të sakta, logjike dhe të qarta.' }]
        },
        contents,
        generationConfig: { maxOutputTokens: 1500, temperature: 0.7 }
      })
    });

    const data = await resp.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Nuk mora përgjigje.';
    res.json({ reply });

  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Gemini PDF OCR ──
async function geminiPDF(buffer) {
  const b64 = buffer.toString('base64');
  const resp = await fetch(GEMINI_VISION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'application/pdf', data: b64 } },
          { text: 'Ekstrakto të gjithë tekstin nga ky PDF. Kthe vetëm tekstin e plotë, pa komente shtesë.' }
        ]
      }],
      generationConfig: { maxOutputTokens: 4000 }
    })
  });
  const d = await resp.json();
  if (d.error) throw new Error(d.error.message);
  return d?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Gemini Image OCR ──
async function geminiImage(b64, mediaType) {
  const resp = await fetch(GEMINI_VISION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mediaType, data: b64 } },
          { text: 'Ekstrakto të gjithë tekstin nga ky imazh.' }
        ]
      }],
      generationConfig: { maxOutputTokens: 2000 }
    })
  });
  const d = await resp.json();
  if (d.error) throw new Error(d.error.message);
  return d?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── PPT extraction ──
async function extractPPT(buffer) {
  try {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buffer);
    const slideFiles = Object.keys(zip.files)
      .filter(f => /ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort();
    let text = '';
    for (let i = 0; i < slideFiles.length; i++) {
      const xml = await zip.files[slideFiles[i]].async('string');
      text += `\n[Diapozitivi ${i + 1}]\n` + xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return text;
  } catch (e) {
    return '[PPT: ' + e.message + ']';
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server duke punuar në port ${PORT}`));
