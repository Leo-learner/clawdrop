'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const Database = require('better-sqlite3');
const contentDisposition = require('content-disposition');
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
const parsedMaxStorage = Number.parseFloat(process.env.MAX_STORAGE_MB || '10240');
const MAX_STORAGE_MB = Number.isFinite(parsedMaxStorage) && parsedMaxStorage > 0
  ? parsedMaxStorage
  : 10240;
const MAX_STORAGE_BYTES = Math.floor(MAX_STORAGE_MB * 1024 * 1024);
const MAX_STORED_FILES = 10000;
const MAX_UPLOAD_REQUESTS_PER_MINUTE = 30;
const UPLOAD_RATE_WINDOW_MS = 60 * 1000;
const MAX_ACTIVE_DOWNLOADS = 8;
const MAX_ACTIVE_SHARE_DOWNLOADS = 2;
const DOWNLOAD_TICKET_LIFETIME_MS = 60 * 1000;
const MAX_DOWNLOAD_TICKETS = 1000;
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL?.trim() || '';
const AUTO_CLEANUP_ENABLED = /^true$/i.test(process.env.AUTO_CLEANUP_ENABLED || 'false');
const parsedCleanupDays = Number.parseFloat(process.env.AUTO_CLEANUP_DAYS || '30');
const AUTO_CLEANUP_DAYS = Number.isFinite(parsedCleanupDays) && parsedCleanupDays > 0
  ? parsedCleanupDays
  : 30;
const parsedCleanupInterval = Number.parseFloat(process.env.AUTO_CLEANUP_INTERVAL_HOURS || '12');
const AUTO_CLEANUP_INTERVAL_HOURS = Number.isFinite(parsedCleanupInterval) && parsedCleanupInterval > 0
  ? parsedCleanupInterval
  : 12;
const parsedRateLimit = Number.parseFloat(process.env.CLAWDROP_RATE_LIMIT_KB || '100');
const DOWNLOAD_RATE_LIMIT_KB = Number.isFinite(parsedRateLimit) && parsedRateLimit > 0
  ? parsedRateLimit
  : 100;
const DOWNLOAD_RATE_LIMIT_BYTES_PER_SECOND = Math.max(1, Math.floor(DOWNLOAD_RATE_LIMIT_KB * 1024));
const DOWNLOAD_STREAM_CHUNK_BYTES = 16 * 1024;

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
  CREATE TABLE IF NOT EXISTS share_links (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    max_downloads INTEGER,
    download_count INTEGER NOT NULL DEFAULT 0,
    revoked_at TEXT,
    FOREIGN KEY (file_id) REFERENCES files(id)
  );
  CREATE INDEX IF NOT EXISTS idx_share_links_token ON share_links(token);
  CREATE INDEX IF NOT EXISTS idx_share_links_file_id ON share_links(file_id);
  CREATE INDEX IF NOT EXISTS idx_share_links_expires_at ON share_links(expires_at);
  CREATE TABLE IF NOT EXISTS health_probes (
    id INTEGER PRIMARY KEY
  );
`);

function validateToken(name, value, defaultValue) {
  if (!value) {
    console.warn(`[security] ${name} is not configured; its protected endpoints will reject all requests.`);
  } else if (value === defaultValue || value.length < 32) {
    throw new Error(`[security] ${name} must be a non-example random token of at least 32 characters.`);
  }
}

validateToken('UPLOAD_TOKEN', UPLOAD_TOKEN, DEFAULT_UPLOAD_TOKEN);
validateToken('ADMIN_TOKEN', ADMIN_TOKEN, DEFAULT_ADMIN_TOKEN);
if (UPLOAD_TOKEN && ADMIN_TOKEN && UPLOAD_TOKEN === ADMIN_TOKEN) {
  throw new Error('[security] UPLOAD_TOKEN and ADMIN_TOKEN must be different.');
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

const uploadRequestTimes = new Map();
function limitUploadRequests(role) {
  return (_req, res, next) => {
    const now = Date.now();
    const recent = (uploadRequestTimes.get(role) || [])
      .filter((timestamp) => timestamp > now - UPLOAD_RATE_WINDOW_MS);
    if (recent.length >= MAX_UPLOAD_REQUESTS_PER_MINUTE) {
      const retryAfter = Math.max(1, Math.ceil((recent[0] + UPLOAD_RATE_WINDOW_MS - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ ok: false, error: 'Upload rate limit exceeded' });
    }
    recent.push(now);
    uploadRequestTimes.set(role, recent);
    return next();
  };
}

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
  defParamCharset: 'utf8',
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
    fileSize: MAX_FILE_SIZE_BYTES,
    fields: 0,
    parts: 1,
    fieldNameSize: 100,
    fieldSize: 0,
    fieldNestingDepth: 0,
    fieldArrayIndexLimit: 0,
    headerPairs: 32
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
const listFilesOlderThan = db.prepare(`
  SELECT ${activeFileColumns}
  FROM files
  WHERE deleted_at IS NULL AND uploaded_at < ?
  ORDER BY uploaded_at ASC
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
const decrementDownloadCount = db.prepare(`
  UPDATE files
  SET download_count = MAX(download_count - 1, 0)
  WHERE id = ? AND deleted_at IS NULL
`);
const softDeleteFile = db.prepare(`
  UPDATE files
  SET deleted_at = ?
  WHERE id = ? AND deleted_at IS NULL
`);
const revokeShare = db.prepare(`
  UPDATE share_links
  SET revoked_at = ?
  WHERE id = ? AND revoked_at IS NULL
`);
const revokeSharesByFile = db.prepare(`
  UPDATE share_links
  SET revoked_at = ?
  WHERE file_id = ? AND revoked_at IS NULL
`);
const softDeleteFileAndShares = db.transaction((deletedAt, fileId) => {
  softDeleteFile.run(deletedAt, fileId);
  revokeSharesByFile.run(deletedAt, fileId);
});
const insertShare = db.prepare(`
  INSERT INTO share_links (
    id, file_id, token, created_at, expires_at, max_downloads
  ) VALUES (
    @id, @fileId, @token, @createdAt, @expiresAt, @maxDownloads
  )
`);
const listActiveSharesByFile = db.prepare(`
  SELECT
    id,
    file_id AS fileId,
    token,
    created_at AS createdAt,
    expires_at AS expiresAt,
    max_downloads AS maxDownloads,
    download_count AS downloadCount,
    revoked_at AS revokedAt
  FROM share_links
  WHERE file_id = ? AND revoked_at IS NULL
  ORDER BY created_at DESC
`);
const getShareByToken = db.prepare(`
  SELECT
    share_links.id,
    share_links.file_id AS fileId,
    share_links.token,
    share_links.created_at AS createdAt,
    share_links.expires_at AS expiresAt,
    share_links.max_downloads AS maxDownloads,
    share_links.download_count AS downloadCount,
    share_links.revoked_at AS revokedAt,
    files.stored_name AS storedName,
    files.original_name AS originalName,
    files.size,
    files.mime_type AS mimeType,
    files.deleted_at AS fileDeletedAt
  FROM share_links
  JOIN files ON files.id = share_links.file_id
  WHERE share_links.token = ?
`);
const incrementShareDownload = db.prepare(`
  UPDATE share_links
  SET download_count = download_count + 1
  WHERE id = ?
`);
const decrementShareDownload = db.prepare(`
  UPDATE share_links
  SET download_count = MAX(download_count - 1, 0)
  WHERE id = ?
`);
const claimShareDownload = db.transaction((token) => {
  const share = getShareByToken.get(token);
  const availability = shareAvailability(share);
  if (availability !== 'active') return { availability, share };
  incrementShareDownload.run(share.id);
  incrementDownloadCount.run(share.fileId);
  share.downloadCount += 1;
  return { availability: 'active', share };
});
const releaseShareDownload = db.transaction((share) => {
  decrementShareDownload.run(share.id);
  decrementDownloadCount.run(share.fileId);
});

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

function publicBaseUrl(req) {
  if (PUBLIC_BASE_URL) {
    try {
      const configured = new URL(PUBLIC_BASE_URL);
      if (configured.protocol === 'http:' || configured.protocol === 'https:') {
        return configured.href.replace(/\/$/, '');
      }
    } catch {
      // Fall back to the current request origin when configuration is invalid.
    }
  }
  return `${req.protocol}://${req.get('host')}`;
}

function publicShare(share, req) {
  const url = `/s/${share.token}`;
  const now = Date.now();
  return {
    id: share.id,
    fileId: share.fileId,
    url,
    fullUrl: `${publicBaseUrl(req)}${url}`,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    maxDownloads: share.maxDownloads,
    downloadCount: share.downloadCount || 0,
    revokedAt: share.revokedAt || null,
    isExpired: Boolean(share.expiresAt && Date.parse(share.expiresAt) <= now),
    isLimitReached: share.maxDownloads !== null
      && share.downloadCount >= share.maxDownloads
  };
}

function shareAvailability(share) {
  if (!share || share.fileDeletedAt) return 'missing';
  if (share.revokedAt) return 'revoked';
  if (share.expiresAt && Date.parse(share.expiresAt) <= Date.now()) return 'expired';
  if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads) return 'limited';
  return 'active';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unit);
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[unit]}`;
}

function formatRateLimitKb(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
}

function createDownloadThrottle(bytesPerSecond) {
  let scheduledAt = Date.now();
  return new Transform({
    transform(chunk, _encoding, callback) {
      const now = Date.now();
      const delayMs = Math.max(0, scheduledAt - now);
      scheduledAt = Math.max(now, scheduledAt) + (chunk.length / bytesPerSecond) * 1000;
      setTimeout(() => callback(null, chunk), delayMs);
    }
  });
}

let activeDownloads = 0;
const activeShareDownloads = new Map();
function reserveDownload(shareId = null) {
  const shareCount = shareId ? (activeShareDownloads.get(shareId) || 0) : 0;
  if (activeDownloads >= MAX_ACTIVE_DOWNLOADS
      || (shareId && shareCount >= MAX_ACTIVE_SHARE_DOWNLOADS)) {
    return null;
  }
  activeDownloads += 1;
  if (shareId) activeShareDownloads.set(shareId, shareCount + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeDownloads -= 1;
    if (shareId) {
      const remaining = activeShareDownloads.get(shareId) - 1;
      if (remaining) activeShareDownloads.set(shareId, remaining);
      else activeShareDownloads.delete(shareId);
    }
  };
}

const downloadTickets = new Map();
function pruneDownloadTickets() {
  const now = Date.now();
  for (const [token, ticket] of downloadTickets) {
    if (ticket.expiresAt <= now) downloadTickets.delete(token);
  }
}

function redeemDownloadTicket(req) {
  const cookies = (req.get('cookie') || '').split(';');
  for (const cookie of cookies) {
    const [name, token] = cookie.trim().split('=', 2);
    if (name !== 'clawdrop_download' || !/^[A-Za-z0-9_-]{43}$/.test(token || '')) continue;
    const ticket = downloadTickets.get(token);
    if (!ticket || ticket.fileId !== req.params.id || ticket.expiresAt <= Date.now()) continue;
    downloadTickets.delete(token);
    return true;
  }
  return false;
}

function requireDownloadAccess(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (match && tokensMatch(match[1], ADMIN_TOKEN)) return next();
  if (req.method === 'GET' && redeemDownloadTicket(req)) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

async function sendRateLimitedDownload(req, res, next, {
  filePath,
  originalName,
  onComplete,
  onFailure
}) {
  try {
    const stats = await fsp.stat(filePath);
    if (!stats.isFile()) {
      if (onFailure) onFailure();
      if (!res.headersSent) res.status(404).json({ ok: false, error: 'File not found' });
      return;
    }

    res.attachment(normalizeOriginalName(originalName));
    res.type(mime.lookup(originalName) || 'application/octet-stream');
    res.set({
      'Accept-Ranges': 'none',
      'Cache-Control': 'no-store',
      'Content-Length': String(stats.size),
      'X-ClawDrop-Rate-Limit-KB': formatRateLimitKb(DOWNLOAD_RATE_LIMIT_KB)
    });

    await pipeline(
      fs.createReadStream(filePath, { highWaterMark: DOWNLOAD_STREAM_CHUNK_BYTES }),
      createDownloadThrottle(DOWNLOAD_RATE_LIMIT_BYTES_PER_SECOND),
      res
    );
    if (onComplete) onComplete();
  } catch (error) {
    if (onFailure) onFailure(error);
    if (error && (error.code === 'ERR_STREAM_PREMATURE_CLOSE' || req.destroyed || res.destroyed)) {
      return;
    }
    if (!res.headersSent) {
      if (error?.code === 'ENOENT') res.status(404).json({ ok: false, error: 'File not found' });
      else next(error);
    }
  }
}

function sendSharePage(res, { statusCode, title, message, share = null }) {
  const active = share && statusCode === 200;
  const remaining = active && share.maxDownloads !== null
    ? Math.max(share.maxDownloads - share.downloadCount, 0)
    : null;
  const details = active
    ? `<dl class="share-details">
        <div><dt>文件大小</dt><dd>${escapeHtml(formatFileSize(share.size))}</dd></div>
        <div><dt>文件类型</dt><dd>${escapeHtml(share.mimeType)}</dd></div>
        <div><dt>过期时间</dt><dd>${escapeHtml(share.expiresAt || '不限')}</dd></div>
        <div><dt>剩余下载</dt><dd>${remaining === null ? '不限次数' : `${remaining} 次`}</dd></div>
      </dl>`
    : '';
  const action = active
    ? `<a class="share-download" href="/s/${encodeURIComponent(share.token)}/download">下载文件</a>`
    : '<a class="share-secondary" href="/">返回 ClawDrop</a>';
  res.status(statusCode).type('html').send(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#f4f7f4">
  <title>${escapeHtml(title)} · ClawDrop</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/share.css">
</head>
<body>
  <main class="share-shell">
    <section class="share-card">
      <div class="share-brand"><span class="share-mark" aria-hidden="true">◆</span>ClawDrop</div>
      <p class="share-label">临时文件分享</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="share-message">${escapeHtml(message)}</p>
      ${details}
      <div class="share-actions">${action}</div>
      <p class="share-footnote">此页面只提供当前文件，不包含文件列表或管理权限。</p>
    </section>
  </main>
</body>
</html>`);
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

async function storageUsage() {
  let bytes = 0;
  let files = 0;
  for await (const entry of await fsp.opendir(STORAGE_DIR)) {
    if (!entry.isFile()) continue;
    try {
      const stats = await fsp.stat(path.join(STORAGE_DIR, entry.name));
      bytes += stats.size;
      files += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { bytes, files };
}

async function storageWritable() {
  const probePath = path.join(STORAGE_DIR, `.health-${crypto.randomUUID()}`);
  let handle;
  try {
    handle = await fsp.open(probePath, 'wx', 0o600);
    await handle.writeFile('ok');
    await handle.close();
    handle = null;
    await fsp.unlink(probePath);
    return true;
  } catch {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(probePath).catch(() => {});
    return false;
  }
}

function databaseWritable() {
  let transactionOpen = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    db.prepare('INSERT INTO health_probes DEFAULT VALUES').run();
    db.exec('ROLLBACK');
    transactionOpen = false;
    return true;
  } catch {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch { /* Keep health unavailable. */ }
    }
    return false;
  }
}

let lastReadiness = null;
let readinessCheckedAt = 0;
let readinessInFlight = null;
function checkReadiness() {
  if (lastReadiness && Date.now() - readinessCheckedAt < 1000) {
    return Promise.resolve(lastReadiness);
  }
  if (!readinessInFlight) {
    readinessInFlight = (async () => {
      const storageReady = await storageWritable();
      const databaseReady = databaseWritable();
      lastReadiness = { storageReady, databaseReady };
      readinessCheckedAt = Date.now();
      return lastReadiness;
    })().finally(() => { readinessInFlight = null; });
  }
  return readinessInFlight;
}

async function runCleanup({ olderThanDays, dryRun }) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const files = listFilesOlderThan.all(cutoff);
  const result = {
    ok: true,
    dryRun,
    matched: files.length,
    deleted: 0,
    failed: 0
  };
  if (!dryRun) {
    for (const file of files) {
      const filePath = safeStoredPath(file.storedName);
      if (!filePath) {
        result.failed += 1;
        continue;
      }
      try {
        await fsp.unlink(filePath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        softDeleteFileAndShares(new Date().toISOString(), file.id);
        result.deleted += 1;
      } catch {
        result.failed += 1;
      }
    }
  }
  console.log(`[cleanup] dryRun=${dryRun} matched=${result.matched} deleted=${result.deleted} failed=${result.failed}`);
  return result;
}

let activeUpload = null;
async function handleUpload(req, res, next) {
  if (activeUpload) {
    return res.status(429).json({ ok: false, error: 'Another upload is in progress' });
  }
  const uploadSlot = Symbol('upload');
  activeUpload = uploadSlot;
  const releaseUpload = () => {
    if (activeUpload === uploadSlot) activeUpload = null;
  };
  res.once('close', releaseUpload);

  try {
    const used = await storageUsage();
    if (used.bytes >= MAX_STORAGE_BYTES || used.files >= MAX_STORED_FILES) {
      releaseUpload();
      return res.status(507).json({ ok: false, error: 'Storage quota exceeded' });
    }
  } catch (error) {
    releaseUpload();
    return next(error);
  }

  return upload.single('file')(req, res, async (uploadError) => {
    try {
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

      const used = await storageUsage();
      if (used.bytes > MAX_STORAGE_BYTES || used.files > MAX_STORED_FILES) {
        await fsp.unlink(filePath).catch(() => {});
        return res.status(507).json({ ok: false, error: 'Storage quota exceeded' });
      }

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
      if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
      return next(error);
    } finally {
      releaseUpload();
    }
  });
}

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; img-src 'self' blob: data:; frame-src blob:; script-src 'self'; style-src 'self'; connect-src 'self'",
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=15552000',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  next();
});
app.use(express.json({ limit: '16kb' }));

app.get('/api/health', async (_req, res) => {
  const { storageReady, databaseReady } = await checkReadiness();
  res.status(storageReady && databaseReady ? 200 : 503).json({
    ok: storageReady && databaseReady,
    name: 'clawdrop',
    time: new Date().toISOString(),
    storageReady,
    databaseReady
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    ok: true,
    maxFileSizeMb: MAX_FILE_SIZE_MB,
    downloadRateLimitKb: DOWNLOAD_RATE_LIMIT_KB
  });
});

app.post('/api/upload', requireUploadToken, limitUploadRequests('upload'), handleUpload);
app.post('/api/files', requireAdminToken, limitUploadRequests('admin'), handleUpload);

app.post('/api/admin/cleanup', requireAdminToken, async (req, res) => {
  const olderThanDays = req.body?.olderThanDays === undefined
    ? AUTO_CLEANUP_DAYS
    : req.body.olderThanDays;
  const dryRun = req.body?.dryRun === undefined ? true : req.body.dryRun;
  if (!Number.isFinite(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650) {
    return res.status(400).json({ ok: false, error: 'olderThanDays must be a number from 1 to 3650' });
  }
  if (typeof dryRun !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'dryRun must be a boolean' });
  }
  return res.json(await runCleanup({ olderThanDays, dryRun }));
});

app.get('/api/files', requireAdminToken, (_req, res) => {
  res.json({ ok: true, files: listActiveFiles.all().map(publicFile) });
});

app.get('/api/files/:id', requireAdminToken, (req, res) => {
  const file = getActiveFile.get(req.params.id);
  if (!file) return res.status(404).json({ ok: false, error: 'File not found' });
  return res.json({ ok: true, file: publicFile(file) });
});

app.post('/api/files/:id/download-ticket', requireAdminToken, async (req, res) => {
  const file = getActiveFile.get(req.params.id);
  const filePath = file && safeStoredPath(file.storedName);
  if (!file || !filePath || !(await fileExists(filePath))) {
    return res.status(404).json({ ok: false, error: 'File not found' });
  }

  pruneDownloadTickets();
  if (downloadTickets.size >= MAX_DOWNLOAD_TICKETS) {
    return res.status(429).json({ ok: false, error: 'Too many pending downloads' });
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const url = `/api/files/${file.id}/download`;
  downloadTickets.set(token, {
    fileId: file.id,
    expiresAt: Date.now() + DOWNLOAD_TICKET_LIFETIME_MS
  });
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(req.hostname);
  res.cookie('clawdrop_download', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: PUBLIC_BASE_URL.startsWith('https://') || !localHost,
    path: url,
    maxAge: DOWNLOAD_TICKET_LIFETIME_MS
  });
  return res.set('Cache-Control', 'no-store').json({ ok: true, url });
});

app.post('/api/files/:id/share', requireAdminToken, (req, res) => {
  const file = getActiveFile.get(req.params.id);
  if (!file) return res.status(404).json({ ok: false, error: 'File not found' });

  const expiresInHours = req.body?.expiresInHours === undefined
    ? 24
    : req.body.expiresInHours;
  const maxDownloads = req.body?.maxDownloads === undefined
    ? null
    : req.body.maxDownloads;
  if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 168) {
    return res.status(400).json({ ok: false, error: 'expiresInHours must be an integer from 1 to 168' });
  }
  if (maxDownloads !== null
      && (!Number.isInteger(maxDownloads) || maxDownloads < 1 || maxDownloads > 100)) {
    return res.status(400).json({ ok: false, error: 'maxDownloads must be null or an integer from 1 to 100' });
  }

  const createdAt = new Date();
  const share = {
    id: crypto.randomUUID(),
    fileId: file.id,
    token: crypto.randomBytes(32).toString('base64url'),
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + expiresInHours * 60 * 60 * 1000).toISOString(),
    maxDownloads,
    downloadCount: 0,
    revokedAt: null
  };
  insertShare.run(share);
  return res.status(201).json({ ok: true, share: publicShare(share, req) });
});

app.get('/api/files/:id/shares', requireAdminToken, (req, res) => {
  const file = getActiveFile.get(req.params.id);
  if (!file) return res.status(404).json({ ok: false, error: 'File not found' });
  const shares = listActiveSharesByFile.all(file.id).map((share) => publicShare(share, req));
  return res.json({ ok: true, shares });
});

app.delete('/api/shares/:id', requireAdminToken, (req, res) => {
  const result = revokeShare.run(new Date().toISOString(), req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ ok: false, error: 'Share not found' });
  }
  return res.json({ ok: true });
});

app.get('/s/:token', async (req, res) => {
  const share = /^[A-Za-z0-9_-]{43,}$/.test(req.params.token)
    ? getShareByToken.get(req.params.token)
    : null;
  const availability = shareAvailability(share);
  if (availability === 'missing') {
    return sendSharePage(res, {
      statusCode: 404,
      title: '分享链接不存在',
      message: '这个分享链接无效，或对应文件已不可用。'
    });
  }
  if (availability === 'revoked') {
    return sendSharePage(res, { statusCode: 410, title: '链接已失效', message: '分享者已撤销这个链接。' });
  }
  if (availability === 'expired') {
    return sendSharePage(res, { statusCode: 410, title: '链接已过期', message: '这个临时分享已超过有效期。' });
  }
  if (availability === 'limited') {
    return sendSharePage(res, { statusCode: 410, title: '下载次数已用完', message: '这个分享链接已达到下载次数上限。' });
  }
  const filePath = safeStoredPath(share.storedName);
  if (!filePath || !(await fileExists(filePath))) {
    return sendSharePage(res, {
      statusCode: 404,
      title: '分享文件不可用',
      message: '文件已被删除或暂时无法访问。'
    });
  }
  return sendSharePage(res, {
    statusCode: 200,
    title: share.originalName,
    message: '此文件由 ClawDrop 临时分享。',
    share
  });
});

app.get('/s/:token/download', async (req, res, next) => {
  const token = /^[A-Za-z0-9_-]{43,}$/.test(req.params.token)
    ? req.params.token
    : null;
  const initialShare = token ? getShareByToken.get(token) : null;
  const initialAvailability = shareAvailability(initialShare);
  if (initialAvailability === 'missing') {
    return sendSharePage(res, { statusCode: 404, title: '分享链接不存在', message: '这个分享链接无效，或对应文件已不可用。' });
  }
  if (initialAvailability === 'revoked') {
    return sendSharePage(res, { statusCode: 410, title: '链接已失效', message: '分享者已撤销这个链接。' });
  }
  if (initialAvailability === 'expired') {
    return sendSharePage(res, { statusCode: 410, title: '链接已过期', message: '这个临时分享已超过有效期。' });
  }
  if (initialAvailability === 'limited') {
    return sendSharePage(res, { statusCode: 410, title: '下载次数已用完', message: '这个分享链接已达到下载次数上限。' });
  }

  const filePath = safeStoredPath(initialShare.storedName);
  if (!filePath || !(await fileExists(filePath))) {
    return sendSharePage(res, { statusCode: 404, title: '分享文件不可用', message: '文件已被删除或暂时无法访问。' });
  }

  const releaseSlot = reserveDownload(initialShare.id);
  if (!releaseSlot) {
    return res.status(429).json({ ok: false, error: 'Too many active downloads' });
  }
  try {
    const claimed = claimShareDownload(token);
    if (claimed.availability !== 'active') {
      const messages = {
        missing: ['分享链接不存在', '这个分享链接无效，或对应文件已不可用。'],
        revoked: ['链接已失效', '分享者已撤销这个链接。'],
        expired: ['链接已过期', '这个临时分享已超过有效期。'],
        limited: ['下载次数已用完', '这个分享链接已达到下载次数上限。']
      };
      const [title, message] = messages[claimed.availability];
      return sendSharePage(res, { statusCode: claimed.availability === 'missing' ? 404 : 410, title, message });
    }

    await sendRateLimitedDownload(req, res, next, {
      filePath,
      originalName: claimed.share.originalName,
      onFailure: () => {
        if (!res.headersSent) releaseShareDownload(claimed.share);
      }
    });
  } finally {
    releaseSlot();
  }
});

app.get('/api/files/:id/download', requireDownloadAccess, async (req, res, next) => {
  const file = getActiveFile.get(req.params.id);
  const filePath = file && safeStoredPath(file.storedName);
  if (!file || !filePath || !(await fileExists(filePath))) {
    return res.status(404).json({ ok: false, error: 'File not found' });
  }

  const releaseSlot = reserveDownload();
  if (!releaseSlot) return res.status(429).json({ ok: false, error: 'Too many active downloads' });
  try {
    await sendRateLimitedDownload(req, res, next, {
      filePath,
      originalName: file.originalName,
      onComplete: () => {
        incrementDownloadCount.run(file.id);
      }
    });
  } finally {
    releaseSlot();
  }
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
  res.set('Content-Disposition', contentDisposition(normalizeOriginalName(file.originalName), { type: 'inline' }));

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
    await fsp.unlink(filePath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    softDeleteFileAndShares(new Date().toISOString(), file.id);
    return res.json({ ok: true });
  } catch (error) {
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
    const route = typeof req.route?.path === 'string' ? req.route.path : '<unmatched>';
    console.error(`[error] Request failed: ${req.method} ${route}`);
  }
  if (!res.headersSent) {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`ClawDrop listening on http://${HOST}:${PORT}`);
});

let cleanupTimer = null;
if (AUTO_CLEANUP_ENABLED) {
  cleanupTimer = setInterval(() => {
    runCleanup({ olderThanDays: AUTO_CLEANUP_DAYS, dryRun: false }).catch(() => {
      console.error('[cleanup] scheduled cleanup failed');
    });
  }, AUTO_CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000);
  cleanupTimer.unref();
  console.log(`[cleanup] enabled days=${AUTO_CLEANUP_DAYS} intervalHours=${AUTO_CLEANUP_INTERVAL_HOURS}`);
}

function shutdown() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
