import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- config (all overridable with environment variables) ----
const PORT = Number(process.env.PORT || 3000);
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 10);
const MAX_MB = Number(process.env.MAX_MB || 50);
const MAX_JOBS = Number(process.env.MAX_JOBS || 2);          // simultaneous conversions
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 120000);  // per conversion
const DB_PATH = process.env.DB_PATH || './usage.db';
const SALT = process.env.IP_SALT || 'change-me';              // set this in production
const TRUST_PROXY = Number(process.env.TRUST_PROXY || 0);     // 1 when behind one reverse proxy

// ---- supported formats ----
const GROUPS = [
  { kind: 'image',  in: ['png', 'jpg', 'webp', 'gif', 'avif', 'tiff'], out: ['png', 'jpg', 'webp', 'avif', 'tiff', 'gif'] },
  { kind: 'doc',    in: ['doc', 'docx', 'odt', 'rtf', 'txt'],          out: ['pdf', 'docx', 'odt', 'txt'] },
  { kind: 'sheet',  in: ['xls', 'xlsx', 'ods', 'csv'],                 out: ['pdf', 'xlsx', 'ods', 'csv'] },
  { kind: 'slides', in: ['ppt', 'pptx', 'odp'],                        out: ['pdf', 'pptx', 'odp'] },
  { kind: 'audio',  in: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'],   out: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] },
  { kind: 'video',  in: ['mp4', 'mov', 'webm', 'mkv', 'avi'],          out: ['mp4', 'webm', 'mkv', 'mp3'] },
];
const ALIAS = { jpeg: 'jpg', tif: 'tiff' };
const norm = (e) => {
  e = String(e || '').toLowerCase().replace(/^\./, '').replace(/[^a-z0-9]/g, '');
  return ALIAS[e] || e;
};
const LO_FILTER = { txt: 'txt:Text', csv: 'csv:Text - txt - csv (StarCalc)' };

// ---- usage tracking (SQLite, one row per visitor per UTC day) ----
const db = new Database(DB_PATH);
db.exec('CREATE TABLE IF NOT EXISTS usage (key TEXT, day TEXT, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key, day))');
const today = () => new Date().toISOString().slice(0, 10);
const getCount = db.prepare('SELECT n FROM usage WHERE key = ? AND day = ?');
const bump = db.prepare('INSERT INTO usage (key, day, n) VALUES (?, ?, 1) ON CONFLICT (key, day) DO UPDATE SET n = n + 1');
const drop = db.prepare('UPDATE usage SET n = MAX(n - 1, 0) WHERE key = ? AND day = ?');
const prune = db.prepare("DELETE FROM usage WHERE day < date('now', '-7 day')");
// Check and reserve in one transaction so parallel requests can't slip past the limit.
const reserve = db.transaction((key) => {
  const day = today();
  if ((getCount.get(key, day)?.n ?? 0) >= DAILY_LIMIT) return false;
  bump.run(key, day);
  return true;
});
const refund = (key) => drop.run(key, today());
const usedToday = (key) => getCount.get(key, today())?.n ?? 0;
// Visitors are keyed by a salted hash of their IP, so raw IPs are never stored.
const keyFor = (req) => crypto.createHash('sha256').update(SALT + req.ip).digest('hex').slice(0, 32);

// ---- converters ----
async function convertImage(inp, out, to) {
  const animated = to === 'gif' || to === 'webp';
  let img = sharp(inp, { animated }).rotate();
  const fmt = to === 'jpg' ? 'jpeg' : to;
  if (fmt === 'jpeg') img = img.flatten({ background: '#ffffff' });
  await img.toFormat(fmt).toFile(out);
}

const FFMPEG_ARGS = {
  mp3: ['-vn', '-q:a', '2'],
  wav: ['-vn'],
  ogg: ['-vn', '-c:a', 'libvorbis', '-q:a', '5'],
  m4a: ['-vn', '-c:a', 'aac', '-b:a', '192k'],
  flac: ['-vn'],
  mp4: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-c:a', 'aac', '-movflags', '+faststart'],
  webm: ['-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus'],
  mkv: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-c:a', 'aac'],
};

async function convert(kind, inp, outDir, to) {
  const id = path.parse(inp).name;
  const out = path.join(outDir, `${id}.${to}`);

  if (kind === 'image') {
    await convertImage(inp, out, to);
    return out;
  }
  if (kind === 'audio' || kind === 'video') {
    await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', inp, ...FFMPEG_ARGS[to], out],
      { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
    return out;
  }
  // documents, spreadsheets, slides: LibreOffice, with a throwaway profile so jobs don't collide
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-'));
  try {
    await run('soffice', [`-env:UserInstallation=file://${profile}`, '--headless', '--norestore',
      '--convert-to', LO_FILTER[to] || to, '--outdir', outDir, inp], { timeout: TIMEOUT_MS });
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
  await fs.access(out);
  return out;
}

// ---- web server ----
const UP_DIR = path.join(os.tmpdir(), 'swap-uploads');
await fs.mkdir(UP_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UP_DIR,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.${norm(path.extname(file.originalname))}`),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
});

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/formats', (req, res) => res.json(GROUPS));

app.get('/api/usage', (req, res) => {
  const used = usedToday(keyFor(req));
  res.json({ limit: DAILY_LIMIT, used, left: Math.max(DAILY_LIMIT - used, 0) });
});

let active = 0;
app.post('/api/convert', upload.single('file'), async (req, res) => {
  const f = req.file;
  const key = keyFor(req);
  const trash = f ? [f.path] : [];
  let reserved = false;
  let handedOff = false;

  try {
    if (!f) return res.status(400).json({ error: 'No file uploaded.' });

    const from = norm(path.extname(f.originalname));
    const to = norm(req.body.target);
    const group = GROUPS.find((g) => g.in.includes(from));
    if (!group) return res.status(400).json({ error: `.${from || '?'} files aren’t supported.` });
    if (!group.out.includes(to) || to === from) return res.status(400).json({ error: `Can’t convert .${from} to .${to}.` });
    if (active >= MAX_JOBS) return res.status(503).json({ error: 'The server is busy. Try again in a minute.' });
    if (!reserve(key)) return res.status(429).json({ error: `You’ve used all ${DAILY_LIMIT} free conversions for today. Come back tomorrow.` });
    reserved = true;

    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conv-'));
    trash.push(outDir);

    active++;
    let outPath;
    try {
      outPath = await convert(group.kind, f.path, outDir, to);
    } finally {
      active--;
    }

    const base = path.parse(f.originalname).name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'converted';
    res.set('X-Conversions-Left', String(Math.max(DAILY_LIMIT - usedToday(key), 0)));
    handedOff = true;
    res.download(outPath, `${base}.${to}`, () => Promise.all(trash.map((p) => fs.rm(p, { recursive: true, force: true }))));
  } catch (err) {
    if (reserved) refund(key); // failed conversions don't count against the limit
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Conversion failed. The file may be damaged or unsupported.' });
  } finally {
    if (!handedOff) await Promise.all(trash.map((p) => fs.rm(p, { recursive: true, force: true })));
  }
});

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File is too large (max ${MAX_MB} MB).` });
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

// hourly housekeeping: drop stale uploads and old usage rows
setInterval(async () => {
  prune.run();
  for (const name of await fs.readdir(UP_DIR).catch(() => [])) {
    const p = path.join(UP_DIR, name);
    const s = await fs.stat(p).catch(() => null);
    if (s && Date.now() - s.mtimeMs > 3600e3) fs.rm(p, { force: true });
  }
}, 3600e3).unref();

app.listen(PORT, () => console.log(`Swap listening on :${PORT} (limit ${DAILY_LIMIT}/day)`));
