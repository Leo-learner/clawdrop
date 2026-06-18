'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');
const express = require('express');
const mime = require('mime-types');
const multer = require('multer');

dotenv.config({ path: path.join(__dirname, '.env') });

const PROJECT_ROOT = __dirname;
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '3010', 10);
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DEFAULT_UPLOAD_TOKEN = 'change-me-upload-token';
const DEFAULT_ADMIN_TOKEN = 'change-me-admin-token';
const parsedMaxFileSize = Number.parseFloat(process.env.MAX_FILE_SIZE_MB || '200');
const MAX_FILE_SIZE_MB = Number.isFinite(parsedMaxFileSize) && parsedMaxFileSize > 0
  ? parsedMaxFileSize
  : 200;
const MAX_FILE_SIZE_BYTES = Math.floor(MAX_FILE_SIZE_MB * 1024 * 1024);
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

function resolveProjectPath(configuredPath, fallback) {
  const value = configuredPath || fallback;
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(PROJECT_ROOT, value);
}

const STORAGE_DIR = resolveProjectPath(process.env.STORAGE_DIR, 'storage');
const DATABASE_PATH = resolveProjectPath(process.env.DATABASE_PATH, 'data/clawdrop.sqlite');

fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });

const db = new Database(DATABASE_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    stored_name TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    download_count INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_files_uploaded_at
    ON files (uploaded_at DESC);
`);

function warnAboutToken(name, value, defaultValue) {
  if (!value) {
    console.warn(`[security] ${name} is not configured; its protected endpoints will reject all requests.`);
  } else if (value === defaultValue) {
    console.warn(`[security] ${name} still uses the example value. Replace it before deployment.`);
  } else if (value.length < 32) {
    console.warn(`[security] ${name} is short. Use a random token of at least 32 characters.`);
  }
}

warnAboutToken('UPLOAD_TOKEN', UPLOAD_TOKEN, DEFAULT_UPLOAD_TOKEN);
warnAboutToken('ADMIN_TOKEN', ADMIN_TOKEN, DEFAULT_ADMIN_TOKEN);
if (UPLOAD_TOKEN && ADMIN_TOKEN && UPLOAD_TOKEN === ADMIN_TOKEN) {
  console.warn('[security] UPLOAD_TOKEN and ADMIN_TOKEN are identical. Use separate values.');
}

function tokensMatch(received, expected) {
  if (!received || !expected) return false;
  const receivedHash = crypto.createHash('sha256').update(received, 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(receivedHash, expectedHash);
}

function tokenGuard(expectedToken) {
  return (req, res, next) => {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    if (!match || !tokensMatch(match[1], expectedToken)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    return next();
  };
}

const requireUploadToken = tokenGuard(UPLOAD_TOKEN);
const requireAdminToken = tokenGuard(ADMIN_TOKEN);

function normalizeOriginalName(input) {
  const normalized = String(input || '').replace(/\\/g, '/');
  const base = path.posix.basename(normalized).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'file').slice(0, 255);
}

function safeStoredPath(storedName) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storedName)) {
    return null;
  }
  const resolved = path.resolve(STORAGE_DIR, storedName);
  if (path.dirname(resolved) !== STORAGE_DIR) return null;
  return resolved;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, STORAGE_DIR),
    filename: (_req, file, callback) => {
      const id = crypto.randomUUID();
      file.clawdropId = id;
      callback(null, id);
    }
  }),
  limits: {
    files: 1,
    fileSize: MAX_FILE_SIZE_BYTES
  }
});

const activeFileColumns = `
  id,
  stored_name AS storedName,
  original_name AS originalName,
  size,
  mime_type AS mimeType,
  sha256,
  uploaded_at AS uploadedAt,
  download_count AS downloadCount
`;
const getActiveFile = db.prepare(`
  SELECT ${activeFileColumns}
  FROM files
  WHERE id = ? AND deleted_at IS NULL
`);
const listActiveFiles = db.prepare(`
  SELECT ${activeFileColumns}
  FROM files
  WHERE deleted_at IS NULL
  ORDER BY uploaded_at DESC
`);
const insertFile = db.prepare(`
  INSERT INTO files (
    id, stored_name, original_name, size, mime_type, sha256, uploaded_at
  ) VALUES (
    @id, @storedName, @originalName, @size, @mimeType, @sha256, @uploadedAt
  )
`);
const incrementDownloadCount = db.prepare(`
  UPDATE files
  SET download_count = download_count + 1
  WHERE id = ? AND deleted_at IS NULL
`);
const softDeleteFile = db.prepare(`
  UPDATE files
  SET deleted_at = ?
  WHERE id = ? AND deleted_at IS NULL
`);

function publicFile(file) {
  return {
    id: file.id,
    originalName: file.originalName,
    size: file.size,
    mimeType: file.mimeType,
    sha256: file.sha256,
    uploadedAt: file.uploadedAt,
    downloadCount: file.downloadCount,
    downloadUrl: `/api/files/${file.id}/download`,
    previewUrl: `/api/files/${file.id}/preview`
  };
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; img-src 'self' blob: data:; frame-src blob:; script-src 'self'; style-src 'self'; connect-src 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  next();
});

app.get('/api/health', async (_req, res) => {
  const storageReady = await fileExists(STORAGE_DIR);
  let databaseReady = false;
  try {
    databaseReady = db.prepare('SELECT 1 AS ready').get().ready === 1;
  } catch {
    databaseReady = false;
  }
  res.json({
    ok: storageReady && databaseReady,
    name: 'clawdrop',
    time: new Date().toISOString(),
    storageReady,
    databaseReady
  });
});

app.post('/api/upload', requireUploadToken, (req, res, next) => {
  upload.single('file')(req, res, async (uploadError) => {
    if (uploadError) {
      if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          ok: false,
          error: `File exceeds the ${MAX_FILE_SIZE_MB} MB limit`
        });
      }
      return res.status(400).json({ ok: false, error: 'Invalid file upload' });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'A single file field named "file" is required' });
    }

    const filePath = safeStoredPath(req.file.filename);
    if (!filePath) {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ ok: false, error: 'Invalid stored file name' });
    }

    try {
      const originalName = normalizeOriginalName(req.file.originalname);
      const record = {
        id: req.file.clawdropId,
        storedName: req.file.filename,
        originalName,
        size: req.file.size,
        mimeType: mime.lookup(originalName) || 'application/octet-stream',
        sha256: await sha256File(filePath),
        uploadedAt: new Date().toISOString(),
        downloadCount: 0
      };
      insertFile.run(record);
      return res.status(201).json({ ok: true, file: publicFile(record) });
    } catch (error) {
      await fsp.unlink(filePath).catch(() => {});
      return next(error);
    }
  });
});

app.get('/api/files', requireAdminToken, (_req, res) => {
  res.json({ ok: true, files: listActiveFiles.all().map(publicFile) });
});

app.get('/api/files/:id', requireAdminToken, (req, res) => {
  const file = getActiveFile.get(req.params.id);
  if (!file) return res.status(404).json({ ok: false, error: 'File not found' });
  return res.json({ ok: true, file: publicFile(file) });
});

app.get('/api/files/:id/download', requireAdminToken, async (req, res, next) => {
  const file = getActiveFile.get(req.params.id);
  const filePath = file && safeStoredPath(file.storedName);
  if (!file || !filePath || !(await fileExists(filePath))) {
    return res.status(404).json({ ok: false, error: 'File not found' });
  }

  return res.download(filePath, normalizeOriginalName(file.originalName), (error) => {
    if (!error) {
      incrementDownloadCount.run(file.id);
    } else if (!res.headersSent) {
      next(error);
    }
  });
});

const imagePreviewTypes = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp']
]);
const textPreviewExtensions = new Set([
  '.txt', '.log', '.md', '.json', '.js', '.css', '.html', '.htm'
]);

app.get('/api/files/:id/preview', requireAdminToken, async (req, res) => {
  const file = getActiveFile.get(req.params.id);
  const filePath = file && safeStoredPath(file.storedName);
  if (!file || !filePath || !(await fileExists(filePath))) {
    return res.status(404).json({ ok: false, error: 'File not found' });
  }

  const extension = path.extname(file.originalName).toLowerCase();
  const inlineName = normalizeOriginalName(file.originalName).replace(/["\\]/g, '_');
  res.set('Content-Disposition', `inline; filename="${inlineName}"`);

  if (imagePreviewTypes.has(extension)) {
    res.type(imagePreviewTypes.get(extension));
    return res.sendFile(filePath);
  }
  if (extension === '.pdf') {
    res.type('application/pdf');
    return res.sendFile(filePath);
  }
  if (textPreviewExtensions.has(extension)) {
    if (file.size > MAX_TEXT_PREVIEW_BYTES) {
      return res.status(413).json({ ok: false, error: 'Text preview is limited to 2 MB' });
    }
    res.type('text/plain; charset=utf-8');
    return res.sendFile(filePath);
  }
  return res.status(415).json({ ok: false, error: 'Preview is not supported for this file type' });
});

app.delete('/api/files/:id', requireAdminToken, async (req, res, next) => {
  const file = getActiveFile.get(req.params.id);
  const filePath = file && safeStoredPath(file.storedName);
  if (!file || !filePath) {
    return res.status(404).json({ ok: false, error: 'File not found' });
  }
  try {
    await fsp.unlink(filePath);
    softDeleteFile.run(new Date().toISOString(), file.id);
    return res.json({ ok: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return res.status(404).json({ ok: false, error: 'File not found' });
    }
    return next(error);
  }
});

app.use(express.static(path.join(PROJECT_ROOT, 'public'), {
  dotfiles: 'deny',
  index: 'index.html',
  maxAge: 0
}));

app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.use((_error, req, res, _next) => {
  if (process.env.NODE_ENV !== 'test') {
    console.error(`[error] Request failed: ${req.method} ${req.originalUrl}`);
  }
  if (!res.headersSent) {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`ClawDrop listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
