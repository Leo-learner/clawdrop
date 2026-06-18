'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_TOKEN = 'test-admin-token-with-at-least-32-characters';
const UPLOAD_TOKEN = 'test-upload-token-with-at-least-32-characters';

let baseUrl;
let child;
let databasePath;
let tempRoot;
let uploadedId;
let activeShare;
let cleanupFileId;
let cleanupShare;

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before becoming healthy (code ${child.exitCode})`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The process may still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not become healthy within 10 seconds');
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function upload(name, content, token = UPLOAD_TOKEN) {
  const form = new FormData();
  form.append('file', new Blob([content]), name);
  return fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: bearer(token),
    body: form
  });
}

async function createShare(fileId, payload = {}) {
  const response = await fetch(`${baseUrl}/api/files/${fileId}/share`, {
    method: 'POST',
    headers: {
      ...bearer(ADMIN_TOKEN),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  assert.equal(response.status, 201);
  return (await response.json()).share;
}

function updateDatabase(sql, ...params) {
  const database = new Database(databasePath);
  try {
    return database.prepare(sql).run(...params);
  } finally {
    database.close();
  }
}

describe('ClawDrop API', { concurrency: false }, () => {
  before(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'clawdrop-test-'));
    databasePath = path.join(tempRoot, 'data', 'clawdrop.sqlite');
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const v1Database = new Database(databasePath);
    v1Database.exec(`
      CREATE TABLE files (
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
    `);
    v1Database.close();
    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        ADMIN_TOKEN,
        UPLOAD_TOKEN,
        MAX_FILE_SIZE_MB: '1',
        STORAGE_DIR: path.join(tempRoot, 'storage'),
        DATABASE_PATH: databasePath,
        PUBLIC_BASE_URL: baseUrl
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await waitForServer();
  });

  after(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('health endpoint is public and reports ready dependencies', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.name, 'clawdrop');
    assert.equal(body.storageReady, true);
    assert.equal(body.databaseReady, true);
    assert.ok(Date.parse(body.time));

    const migratedDatabase = new Database(databasePath, { readonly: true });
    const shareTable = migratedDatabase.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'share_links'"
    ).get();
    const indexes = migratedDatabase.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_share_links_%'"
    ).all();
    migratedDatabase.close();
    assert.equal(shareTable.name, 'share_links');
    assert.equal(indexes.length, 3);
  });

  test('admin endpoints reject missing, wrong, and upload-only tokens', async () => {
    for (const headers of [{}, bearer('wrong-token'), bearer(UPLOAD_TOKEN)]) {
      const response = await fetch(`${baseUrl}/api/files`, { headers });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { ok: false, error: 'Unauthorized' });
    }
  });

  test('upload endpoint accepts only the upload token', async () => {
    for (const token of ['wrong-token', ADMIN_TOKEN]) {
      const response = await upload('denied.txt', 'denied', token);
      assert.equal(response.status, 401);
    }

    const response = await upload('unsafe.html', '<script>alert(1)</script>\nhello');
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.match(body.file.id, /^[0-9a-f-]{36}$/i);
    assert.equal(body.file.originalName, 'unsafe.html');
    assert.equal(body.file.mimeType, 'text/html');
    assert.match(body.file.sha256, /^[0-9a-f]{64}$/);
    assert.equal(body.file.downloadUrl, `/api/files/${body.file.id}/download`);
    assert.equal(body.file.previewUrl, `/api/files/${body.file.id}/preview`);
    uploadedId = body.file.id;
  });

  test('admin can list and inspect uploaded metadata', async () => {
    const list = await fetch(`${baseUrl}/api/files`, { headers: bearer(ADMIN_TOKEN) });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.files.length, 1);
    assert.equal(listBody.files[0].id, uploadedId);
    assert.equal(listBody.files[0].downloadCount, 0);

    const detail = await fetch(`${baseUrl}/api/files/${uploadedId}`, {
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).file.originalName, 'unsafe.html');
  });

  test('admin can create a high-entropy temporary share link', async () => {
    const response = await fetch(`${baseUrl}/api/files/${uploadedId}/share`, {
      method: 'POST',
      headers: {
        ...bearer(ADMIN_TOKEN),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expiresInHours: 24, maxDownloads: 5 })
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.share.fileId, uploadedId);
    assert.equal(body.share.maxDownloads, 5);
    assert.equal(body.share.downloadCount, 0);
    assert.match(body.share.url, /^\/s\/[A-Za-z0-9_-]{43,}$/);
    assert.equal(body.share.fullUrl, `${baseUrl}${body.share.url}`);
    assert.notEqual(body.share.url.includes(uploadedId), true);
    assert.ok(Date.parse(body.share.expiresAt));
    activeShare = body.share;
  });

  test('admin can list active shares with computed status flags', async () => {
    const response = await fetch(`${baseUrl}/api/files/${uploadedId}/shares`, {
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.shares.length, 1);
    assert.equal(body.shares[0].id, activeShare.id);
    assert.equal(body.shares[0].isExpired, false);
    assert.equal(body.shares[0].isLimitReached, false);
  });

  test('public share page exposes only the selected file without admin authentication', async () => {
    const response = await fetch(`${baseUrl}${activeShare.url}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.match(response.headers.get('content-security-policy'), /style-src 'self'/);
    const html = await response.text();
    assert.match(html, /unsafe\.html/);
    assert.match(html, /下载文件/);
    assert.doesNotMatch(html, /ADMIN_TOKEN|UPLOAD_TOKEN|\/api\/files|id="file-list"/);

    const missing = await fetch(`${baseUrl}/s/not-a-real-share-token`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /分享链接不存在/);
  });

  test('public share download returns the selected attachment and increments both counters', async () => {
    const response = await fetch(`${baseUrl}${activeShare.url}/download`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.equal(await response.text(), '<script>alert(1)</script>\nhello');

    const sharesResponse = await fetch(`${baseUrl}/api/files/${uploadedId}/shares`, {
      headers: bearer(ADMIN_TOKEN)
    });
    const shares = (await sharesResponse.json()).shares;
    assert.equal(shares.find((share) => share.id === activeShare.id).downloadCount, 1);

    const fileResponse = await fetch(`${baseUrl}/api/files/${uploadedId}`, {
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal((await fileResponse.json()).file.downloadCount, 1);
  });

  test('HTML preview is forced to plain text and cannot be sniffed', async () => {
    const response = await fetch(`${baseUrl}/api/files/${uploadedId}/preview`, {
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await response.text(), '<script>alert(1)</script>\nhello');
  });

  test('download is authenticated, uses an attachment, and increments its count', async () => {
    const denied = await fetch(`${baseUrl}/api/files/${uploadedId}/download`);
    assert.equal(denied.status, 401);

    const response = await fetch(`${baseUrl}/api/files/${uploadedId}/download`, {
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.equal(await response.text(), '<script>alert(1)</script>\nhello');

    const detail = await fetch(`${baseUrl}/api/files/${uploadedId}`, {
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal((await detail.json()).file.downloadCount, 2);
  });

  test('share download stops exactly at maxDownloads', async () => {
    const share = await createShare(uploadedId, { expiresInHours: 24, maxDownloads: 1 });
    const first = await fetch(`${baseUrl}${share.url}/download`);
    assert.equal(first.status, 200);
    await first.arrayBuffer();

    const second = await fetch(`${baseUrl}${share.url}/download`);
    assert.equal(second.status, 410);
    assert.match(await second.text(), /下载次数已用完/);

    const page = await fetch(`${baseUrl}${share.url}`);
    assert.equal(page.status, 410);
    assert.match(await page.text(), /下载次数已用完/);
  });

  test('expired share cannot open or download', async () => {
    const share = await createShare(uploadedId, { expiresInHours: 1, maxDownloads: null });
    updateDatabase(
      'UPDATE share_links SET expires_at = ? WHERE id = ?',
      new Date(Date.now() - 60_000).toISOString(),
      share.id
    );

    const page = await fetch(`${baseUrl}${share.url}`);
    assert.equal(page.status, 410);
    assert.match(await page.text(), /链接已过期/);
    const download = await fetch(`${baseUrl}${share.url}/download`);
    assert.equal(download.status, 410);
    assert.match(await download.text(), /链接已过期/);
  });

  test('admin can revoke a share without deleting its file', async () => {
    const share = await createShare(uploadedId, { expiresInHours: 24, maxDownloads: null });
    const response = await fetch(`${baseUrl}/api/shares/${share.id}`, {
      method: 'DELETE',
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const page = await fetch(`${baseUrl}${share.url}`);
    assert.equal(page.status, 410);
    assert.match(await page.text(), /链接已失效/);
    const detail = await fetch(`${baseUrl}/api/files/${uploadedId}`, {
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal(detail.status, 200);
  });

  test('share creation validates authorization and bounded options', async () => {
    const denied = await fetch(`${baseUrl}/api/files/${uploadedId}/share`, {
      method: 'POST',
      headers: {
        ...bearer(UPLOAD_TOKEN),
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(denied.status, 401);

    for (const payload of [
      { expiresInHours: 0 },
      { expiresInHours: 169 },
      { maxDownloads: 0 },
      { maxDownloads: 101 },
      { maxDownloads: '5' }
    ]) {
      const response = await fetch(`${baseUrl}/api/files/${uploadedId}/share`, {
        method: 'POST',
        headers: {
          ...bearer(ADMIN_TOKEN),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      assert.equal(response.status, 400);
    }
  });

  test('unsupported files return 415 for preview', async () => {
    const uploadResponse = await upload('archive.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const { file } = await uploadResponse.json();
    const preview = await fetch(`${baseUrl}/api/files/${file.id}/preview`, {
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal(preview.status, 415);

    const deleted = await fetch(`${baseUrl}/api/files/${file.id}`, {
      method: 'DELETE',
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal(deleted.status, 200);
  });

  test('oversized uploads return 413', async () => {
    const response = await upload('too-large.bin', new Uint8Array(1024 * 1024 + 1));
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'File exceeds the 1 MB limit'
    });
  });

  test('invalid IDs return a path-safe 404', async () => {
    const response = await fetch(`${baseUrl}/api/files/not-a-valid-id`, {
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.deepEqual(body, { ok: false, error: 'File not found' });
    assert.equal(JSON.stringify(body).includes(tempRoot), false);
  });

  test('cleanup dry run reports old files without deleting or revoking them', async () => {
    const uploadResponse = await upload('cleanup-old.txt', 'old but still present');
    assert.equal(uploadResponse.status, 201);
    cleanupFileId = (await uploadResponse.json()).file.id;
    cleanupShare = await createShare(cleanupFileId, { expiresInHours: 24, maxDownloads: null });
    updateDatabase(
      'UPDATE files SET uploaded_at = ? WHERE id = ?',
      new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      cleanupFileId
    );

    const denied = await fetch(`${baseUrl}/api/admin/cleanup`, {
      method: 'POST',
      headers: {
        ...bearer(UPLOAD_TOKEN),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ olderThanDays: 30, dryRun: true })
    });
    assert.equal(denied.status, 401);

    const response = await fetch(`${baseUrl}/api/admin/cleanup`, {
      method: 'POST',
      headers: {
        ...bearer(ADMIN_TOKEN),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ olderThanDays: 30, dryRun: true })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      dryRun: true,
      matched: 1,
      deleted: 0,
      failed: 0
    });
    assert.equal((await fetch(`${baseUrl}/api/files/${cleanupFileId}`, {
      headers: bearer(ADMIN_TOKEN)
    })).status, 200);
    assert.equal((await fetch(`${baseUrl}${cleanupShare.url}`)).status, 200);
  });

  test('cleanup deletes old files and revokes their shares', async () => {
    const response = await fetch(`${baseUrl}/api/admin/cleanup`, {
      method: 'POST',
      headers: {
        ...bearer(ADMIN_TOKEN),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ olderThanDays: 30, dryRun: false })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      dryRun: false,
      matched: 1,
      deleted: 1,
      failed: 0
    });
    assert.equal((await fetch(`${baseUrl}/api/files/${cleanupFileId}`, {
      headers: bearer(ADMIN_TOKEN)
    })).status, 404);
    const sharePage = await fetch(`${baseUrl}${cleanupShare.url}`);
    assert.equal(sharePage.status, 404);
    const database = new Database(databasePath, { readonly: true });
    const share = database.prepare('SELECT revoked_at AS revokedAt FROM share_links WHERE id = ?').get(cleanupShare.id);
    database.close();
    assert.ok(Date.parse(share.revokedAt));
  });

  test('delete removes the stored file and soft-deletes its metadata', async () => {
    const share = await createShare(uploadedId, { expiresInHours: 24, maxDownloads: null });
    const response = await fetch(`${baseUrl}/api/files/${uploadedId}`, {
      method: 'DELETE',
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const detail = await fetch(`${baseUrl}/api/files/${uploadedId}`, {
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal(detail.status, 404);
    const shareDownload = await fetch(`${baseUrl}${share.url}/download`);
    assert.equal(shareDownload.status, 404);
    const database = new Database(databasePath, { readonly: true });
    const revoked = database.prepare('SELECT revoked_at AS revokedAt FROM share_links WHERE id = ?').get(share.id);
    database.close();
    assert.ok(Date.parse(revoked.revokedAt));
    const storedFiles = await fs.readdir(path.join(tempRoot, 'storage'));
    assert.deepEqual(storedFiles, []);
  });

  test('static app is served with a restrictive content security policy', async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    const html = await response.text();
    assert.match(html, /ClawDrop/);
    assert.match(html, /autocomplete="username"/);
    assert.match(html, /id="file-search"/);
    assert.match(html, /data-filter="image"/);
    assert.match(html, /data-filter="archive"/);
    assert.match(html, /id="share-dialog"/);
    assert.doesNotMatch(html, /复制受保护下载链接/);

    const favicon = await fetch(`${baseUrl}/favicon.svg`);
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get('content-type'), /^image\/svg\+xml/);

    const shareStyles = await fetch(`${baseUrl}/share.css`);
    assert.equal(shareStyles.status, 200);
  });

  test('Windows deployment helper validates configuration without changing firewall or installing PM2', async () => {
    const script = await fs.readFile(path.join(ROOT, 'scripts', 'deploy-windows.ps1'), 'utf8');
    assert.match(script, /Node\.js 20 or newer/);
    assert.match(script, /npm\.cmd install/);
    assert.match(script, /npm\.cmd run check/);
    assert.match(script, /npm\.cmd test/);
    assert.match(script, /pm2 start server\.js --name clawdrop/);
    assert.doesNotMatch(script, /New-NetFirewallRule|Install-Module|npm\.cmd install --global pm2/);
  });
});
