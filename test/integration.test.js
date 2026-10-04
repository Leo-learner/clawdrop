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

async function waitForServer(url = baseUrl, serverProcess = child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
      throw new Error(`server exited before becoming healthy (code ${serverProcess.exitCode})`);
    }
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // The process may still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not become healthy within 10 seconds');
}

async function stopServer(serverProcess) {
  if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => serverProcess.kill('SIGKILL'), 3000);
    serverProcess.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    serverProcess.kill('SIGTERM');
  });
}

async function isolatedServer(overrides = {}, prepare = async () => ({})) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clawdrop-isolated-test-'));
  const preparedOverrides = await prepare(root);
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const storageDir = path.join(root, 'storage');
  const databaseFile = path.join(root, 'data', 'clawdrop.sqlite');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    ADMIN_TOKEN,
    UPLOAD_TOKEN,
    MAX_FILE_SIZE_MB: '1',
    MAX_STORAGE_MB: '10240',
    STORAGE_DIR: storageDir,
    DATABASE_PATH: databaseFile,
    PUBLIC_BASE_URL: url
  };
  for (const [key, value] of Object.entries({ ...overrides, ...preparedOverrides })) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const processHandle = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  processHandle.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  processHandle.stdout.resume();
  try {
    await waitForServer(url, processHandle);
  } catch (error) {
    await stopServer(processHandle);
    await fs.rm(root, { recursive: true, force: true });
    throw new Error(`${error.message}\n${stderr}`);
  }
  return {
    url,
    root,
    storageDir,
    databaseFile,
    get logs() { return stderr; },
    async close() {
      await stopServer(processHandle);
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

async function assertStartupRejected(overrides) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clawdrop-rejected-test-'));
  const port = await getFreePort();
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    ADMIN_TOKEN,
    UPLOAD_TOKEN,
    STORAGE_DIR: path.join(root, 'storage'),
    DATABASE_PATH: path.join(root, 'data', 'clawdrop.sqlite'),
    ...overrides
  };
  const processHandle = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  processHandle.stdout.on('data', (chunk) => { output += chunk.toString(); });
  processHandle.stderr.on('data', (chunk) => { output += chunk.toString(); });
  try {
    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 3000);
      processHandle.once('exit', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    assert.ok(result, `server unexpectedly stayed up with rejected tokens: ${output}`);
    assert.notEqual(result.code, 0, `server accepted rejected tokens: ${output}`);
    assert.match(output, /token/i);
  } finally {
    await stopServer(processHandle);
    await fs.rm(root, { recursive: true, force: true });
  }
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function uploadAt(url, name, content, token = UPLOAD_TOKEN) {
  const form = new FormData();
  form.append('file', new Blob([content]), name);
  return fetch(`${url}/api/upload`, {
    method: 'POST',
    headers: bearer(token),
    body: form
  });
}

async function upload(name, content, token = UPLOAD_TOKEN) {
  return uploadAt(baseUrl, name, content, token);
}

async function createShareAt(url, fileId, payload = {}) {
  const response = await fetch(`${url}/api/files/${fileId}/share`, {
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

async function createShare(fileId, payload = {}) {
  return createShareAt(baseUrl, fileId, payload);
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
        MAX_STORAGE_MB: '10240',
        STORAGE_DIR: path.join(tempRoot, 'storage'),
        DATABASE_PATH: databasePath,
        PUBLIC_BASE_URL: baseUrl
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await waitForServer();
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('health and config endpoints are public and report ready dependencies', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('strict-transport-security') || '', /^max-age=\d+/i);
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

    const config = await fetch(`${baseUrl}/api/config`);
    assert.equal(config.status, 200);
    assert.deepEqual(await config.json(), {
      ok: true,
      maxFileSizeMb: 1,
      downloadRateLimitKb: 100
    });
  });

  test('configured example, short, and shared tokens fail startup; missing tokens stay locked down', async () => {
    for (const configuration of [
      { ADMIN_TOKEN: 'change-me-admin-token' },
      { UPLOAD_TOKEN: 'change-me-upload-token' },
      { ADMIN_TOKEN: 'too-short' },
      { UPLOAD_TOKEN: 'too-short' },
      { ADMIN_TOKEN: UPLOAD_TOKEN }
    ]) {
      await assertStartupRejected(configuration);
    }

    const fixture = await isolatedServer({ ADMIN_TOKEN: undefined, UPLOAD_TOKEN: undefined });
    try {
      const health = await fetch(`${fixture.url}/api/health`);
      assert.equal(health.status, 200);
      const files = await fetch(`${fixture.url}/api/files`, { headers: bearer(ADMIN_TOKEN) });
      assert.equal(files.status, 401);
      const rejectedUpload = await uploadAt(fixture.url, 'locked.txt', 'contents');
      assert.equal(rejectedUpload.status, 401);
    } finally {
      await fixture.close();
    }
  });

  test('health fails when storage stops being writable', async () => {
    const fixture = await isolatedServer();
    try {
      await fs.rmdir(fixture.storageDir);
      await fs.writeFile(fixture.storageDir, 'not a directory');
      await new Promise((resolve) => setTimeout(resolve, 1050));
      const health = await fetch(`${fixture.url}/api/health`);
      assert.equal(health.status, 503);
      const body = await health.json();
      assert.equal(body.ok, false);
      assert.equal(body.storageReady, false);
      assert.equal(body.databaseReady, true);
    } finally {
      await fixture.close();
    }
  });

  test('server error logs omit query secrets and use only the matched route', async () => {
    const fixture = await isolatedServer({ NODE_ENV: 'production' });
    const querySecret = 'never-log-this-query-secret';
    try {
      await fs.rmdir(fixture.storageDir);
      await fs.writeFile(fixture.storageDir, 'not a directory');
      const form = new FormData();
      form.append('file', new Blob(['content']), 'error-log.txt');
      const response = await fetch(`${fixture.url}/api/upload?secret=${querySecret}`, {
        method: 'POST',
        headers: bearer(UPLOAD_TOKEN),
        body: form
      });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { ok: false, error: 'Internal server error' });
      const deadline = Date.now() + 2000;
      while (!fixture.logs.includes('Request failed') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.match(fixture.logs, /Request failed: POST \/api\/upload/);
      assert.doesNotMatch(fixture.logs, /never-log-this-query-secret/);
      assert.doesNotMatch(fixture.logs, new RegExp(UPLOAD_TOKEN));
    } finally {
      await fixture.close();
    }
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

  test('multipart upload accepts exactly one file and no extra fields', async () => {
    const withField = new FormData();
    withField.append('file', new Blob(['data']), 'extra-field.txt');
    withField.append('note', 'unwanted');
    const withSecondFile = new FormData();
    withSecondFile.append('file', new Blob(['first']), 'first.txt');
    withSecondFile.append('file', new Blob(['second']), 'second.txt');
    const indexedFile = new FormData();
    indexedFile.append('file[0]', new Blob(['data']), 'indexed.txt');

    for (const form of [withField, withSecondFile, indexedFile]) {
      const response = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: bearer(UPLOAD_TOKEN),
        body: form
      });
      assert.equal(response.status, 400);
    }
    const files = await fetch(`${baseUrl}/api/files`, { headers: bearer(ADMIN_TOKEN) });
    assert.equal((await files.json()).files.length, 1);
    assert.equal((await fs.readdir(path.join(tempRoot, 'storage'))).length, 1);
  });

  test('upload token is limited to 30 requests per minute without blocking admin uploads', async () => {
    const fixture = await isolatedServer();
    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await uploadAt(fixture.url, `rate-${attempt}.txt`, 'x');
        assert.equal(response.status, 201);
      }
      const limited = await uploadAt(fixture.url, 'rate-limited.txt', 'x');
      assert.equal(limited.status, 429);
      assert.equal((await limited.json()).error, 'Upload rate limit exceeded');
      assert.ok(Number(limited.headers.get('retry-after')) >= 1);

      const adminForm = new FormData();
      adminForm.append('file', new Blob(['admin upload']), 'admin-after-rate-limit.txt');
      const adminUpload = await fetch(`${fixture.url}/api/files`, {
        method: 'POST',
        headers: bearer(ADMIN_TOKEN),
        body: adminForm
      });
      assert.equal(adminUpload.status, 201);
    } finally {
      await fixture.close();
    }
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

  test('browser upload endpoint accepts only the admin token', async () => {
    const deniedForm = new FormData();
    deniedForm.append('file', new Blob(['denied']), 'browser-denied.txt');
    const denied = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: bearer(UPLOAD_TOKEN),
      body: deniedForm
    });
    assert.equal(denied.status, 401);

    const acceptedForm = new FormData();
    acceptedForm.append('file', new Blob(['browser upload']), '../browser-upload.txt');
    const accepted = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
      body: acceptedForm
    });
    assert.equal(accepted.status, 201);
    const body = await accepted.json();
    assert.equal(body.ok, true);
    assert.equal(body.file.originalName, 'browser-upload.txt');

    const deleted = await fetch(`${baseUrl}/api/files/${body.file.id}`, {
      method: 'DELETE',
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal(deleted.status, 200);
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
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(Number(response.headers.get('content-length')) > 0, true);
    assert.equal(response.headers.get('x-clawdrop-rate-limit-kb'), '100');
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

  test('share downloads enforce two streams per share and eight streams total', async () => {
    const fixture = await isolatedServer({ CLAWDROP_RATE_LIMIT_KB: '1' });
    const activeResponses = [];
    try {
      const created = await uploadAt(fixture.url, 'stream-cap.bin', new Uint8Array(32 * 1024));
      assert.equal(created.status, 201);
      const fileId = (await created.json()).file.id;
      const shares = [];
      for (let index = 0; index < 5; index += 1) {
        shares.push(await createShareAt(fixture.url, fileId));
      }

      for (let index = 0; index < 2; index += 1) {
        const response = await fetch(`${fixture.url}${shares[0].url}/download`);
        assert.equal(response.status, 200);
        activeResponses.push(response);
      }
      const thirdSameShare = await fetch(`${fixture.url}${shares[0].url}/download`);
      assert.equal(thirdSameShare.status, 429);
      await thirdSameShare.arrayBuffer();

      for (let shareIndex = 1; shareIndex < 4; shareIndex += 1) {
        for (let streamIndex = 0; streamIndex < 2; streamIndex += 1) {
          const response = await fetch(`${fixture.url}${shares[shareIndex].url}/download`);
          assert.equal(response.status, 200);
          activeResponses.push(response);
        }
      }
      assert.equal(activeResponses.length, 8);
      const ninth = await fetch(`${fixture.url}${shares[4].url}/download`);
      assert.equal(ninth.status, 429);
      await ninth.arrayBuffer();

      const listed = await fetch(`${fixture.url}/api/files/${fileId}/shares`, {
        headers: bearer(ADMIN_TOKEN)
      });
      const shareRows = (await listed.json()).shares;
      assert.equal(shareRows.find((share) => share.id === shares[4].id).downloadCount, 0);
    } finally {
      await Promise.allSettled(activeResponses.map((response) => response.body.cancel()));
      await fixture.close();
    }
  });

  test('a share keeps its download count once the client receives bytes and disconnects', async () => {
    const fixture = await isolatedServer({ CLAWDROP_RATE_LIMIT_KB: '1' });
    try {
      const created = await uploadAt(fixture.url, 'partial.bin', new Uint8Array(32 * 1024));
      assert.equal(created.status, 201);
      const fileId = (await created.json()).file.id;
      const share = await createShareAt(fixture.url, fileId, { maxDownloads: 1 });

      const response = await fetch(`${fixture.url}${share.url}/download`);
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const firstChunk = await reader.read();
      assert.equal(firstChunk.done, false);
      assert.ok(firstChunk.value.byteLength > 0);
      await reader.cancel();

      const retry = await fetch(`${fixture.url}${share.url}/download`);
      assert.equal(retry.status, 410);
      assert.match(await retry.text(), /下载次数已用完/);

      const shareList = await fetch(`${fixture.url}/api/files/${fileId}/shares`, {
        headers: bearer(ADMIN_TOKEN)
      });
      assert.equal((await shareList.json()).shares[0].downloadCount, 1);
      const detail = await fetch(`${fixture.url}/api/files/${fileId}`, {
        headers: bearer(ADMIN_TOKEN)
      });
      assert.equal((await detail.json()).file.downloadCount, 1);
    } finally {
      await fixture.close();
    }
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

  test('preview encodes a Unicode filename with RFC 5987', async () => {
    const name = '中文 报告.txt';
    const created = await upload(name, '报告正文');
    assert.equal(created.status, 201);
    const fileId = (await created.json()).file.id;
    try {
      const preview = await fetch(`${baseUrl}/api/files/${fileId}/preview`, {
        headers: bearer(ADMIN_TOKEN)
      });
      assert.equal(preview.status, 200);
      const disposition = preview.headers.get('content-disposition') || '';
      assert.match(disposition, /^inline;/);
      assert.match(disposition, /filename\*=UTF-8''/i);
      assert.ok(disposition.includes(encodeURIComponent(name)));
      assert.equal(await preview.text(), '报告正文');
    } finally {
      const deleted = await fetch(`${baseUrl}/api/files/${fileId}`, {
        method: 'DELETE',
        headers: bearer(ADMIN_TOKEN)
      });
      assert.equal(deleted.status, 200);
    }
  });

  test('download is authenticated, uses an attachment, and increments its count', async () => {
    const denied = await fetch(`${baseUrl}/api/files/${uploadedId}/download`);
    assert.equal(denied.status, 401);

    const response = await fetch(`${baseUrl}/api/files/${uploadedId}/download`, {
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(Number(response.headers.get('content-length')) > 0, true);
    assert.equal(response.headers.get('accept-ranges'), 'none');
    assert.equal(response.headers.get('x-clawdrop-rate-limit-kb'), '100');
    assert.equal(await response.text(), '<script>alert(1)</script>\nhello');

    let count = -1;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const detail = await fetch(`${baseUrl}/api/files/${uploadedId}`, {
        headers: bearer(ADMIN_TOKEN)
      });
      count = (await detail.json()).file.downloadCount;
      if (count === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(count, 2);
  });

  test('download ticket uses a short-lived one-use cookie bound to one file', async () => {
    for (const headers of [{}, bearer(UPLOAD_TOKEN)]) {
      const denied = await fetch(`${baseUrl}/api/files/${uploadedId}/download-ticket`, {
        method: 'POST',
        headers
      });
      assert.equal(denied.status, 401);
    }

    const created = await fetch(`${baseUrl}/api/files/${uploadedId}/download-ticket`, {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal(created.status, 200);
    const ticket = await created.json();
    assert.equal(ticket.ok, true);
    const ticketUrl = new URL(ticket.url, baseUrl);
    assert.equal(ticketUrl.origin, baseUrl);
    assert.equal(ticketUrl.pathname, `/api/files/${uploadedId}/download`);
    assert.equal(ticketUrl.search, '');
    const setCookie = created.headers.get('set-cookie') || '';
    assert.match(setCookie, /;\s*HttpOnly\b/i);
    assert.match(setCookie, /;\s*SameSite=Strict\b/i);
    assert.match(setCookie, /;\s*(?:Max-Age=\d+|Expires=)/i);
    const cookie = setCookie.split(';', 1)[0];
    assert.match(cookie, /^[^=]+=.+$/);

    const otherUpload = await upload('other-ticket-file.txt', 'other file');
    assert.equal(otherUpload.status, 201);
    const otherId = (await otherUpload.json()).file.id;
    try {
      const wrongFile = await fetch(`${baseUrl}/api/files/${otherId}/download`, {
        headers: { Cookie: cookie }
      });
      assert.equal(wrongFile.status, 401);

      const first = await fetch(ticketUrl, { headers: { Cookie: cookie } });
      assert.equal(first.status, 200);
      assert.equal(await first.text(), '<script>alert(1)</script>\nhello');

      const reused = await fetch(ticketUrl, { headers: { Cookie: cookie } });
      assert.equal(reused.status, 401);

      const bearerDownload = await fetch(ticketUrl, { headers: bearer(ADMIN_TOKEN) });
      assert.equal(bearerDownload.status, 200);
      await bearerDownload.arrayBuffer();
    } finally {
      const removed = await fetch(`${baseUrl}/api/files/${otherId}`, {
        method: 'DELETE',
        headers: bearer(ADMIN_TOKEN)
      });
      assert.equal(removed.status, 200);
    }
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

  test('storage quota rejects an upload with 507 and frees capacity after deletion', async () => {
    const fixture = await isolatedServer({ MAX_STORAGE_MB: '0.001' });
    try {
      const first = await uploadAt(fixture.url, 'first.bin', new Uint8Array(600));
      assert.equal(first.status, 201);
      const firstId = (await first.json()).file.id;

      const overQuota = await uploadAt(fixture.url, 'over-quota.bin', new Uint8Array(600));
      assert.equal(overQuota.status, 507);
      const list = await fetch(`${fixture.url}/api/files`, { headers: bearer(ADMIN_TOKEN) });
      assert.equal((await list.json()).files.length, 1);
      assert.equal((await fs.readdir(fixture.storageDir)).length, 1);

      const removed = await fetch(`${fixture.url}/api/files/${firstId}`, {
        method: 'DELETE',
        headers: bearer(ADMIN_TOKEN)
      });
      assert.equal(removed.status, 200);
      const retry = await uploadAt(fixture.url, 'retry.bin', new Uint8Array(600));
      assert.equal(retry.status, 201);
    } finally {
      await fixture.close();
    }
  });

  test('a held multipart upload makes a simultaneous upload return 429', async () => {
    const fixture = await isolatedServer();
    const boundary = 'clawdrop-held-upload-boundary';
    const encoder = new TextEncoder();
    let finishRequest;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="held.txt"\r\nContent-Type: text/plain\r\n\r\nheld`
        ));
        finishRequest = () => {
          controller.enqueue(encoder.encode(`\r\n--${boundary}--\r\n`));
          controller.close();
        };
      }
    });
    let firstRequest;
    try {
      firstRequest = fetch(`${fixture.url}/api/upload`, {
        method: 'POST',
        headers: {
          ...bearer(UPLOAD_TOKEN),
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body,
        duplex: 'half'
      });
      firstRequest.catch(() => {});

      const deadline = Date.now() + 5000;
      while ((await fs.readdir(fixture.storageDir)).length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal((await fs.readdir(fixture.storageDir)).length, 1, 'first upload never reached storage');
      const simultaneous = await uploadAt(fixture.url, 'simultaneous.txt', 'second');
      assert.equal(simultaneous.status, 429);
    } finally {
      finishRequest();
      if (firstRequest) {
        const completed = await firstRequest;
        assert.equal(completed.status, 201);
        await completed.arrayBuffer();
      }
      await fixture.close();
    }
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

  test('delete revokes metadata and shares when the disk file is already missing', async () => {
    const created = await upload('missing-on-disk.txt', 'metadata survives');
    assert.equal(created.status, 201);
    const fileId = (await created.json()).file.id;
    const share = await createShare(fileId);
    const database = new Database(databasePath, { readonly: true });
    const storedName = database.prepare('SELECT stored_name FROM files WHERE id = ?').get(fileId).stored_name;
    database.close();
    await fs.unlink(path.join(tempRoot, 'storage', storedName));

    const deleted = await fetch(`${baseUrl}/api/files/${fileId}`, {
      method: 'DELETE',
      headers: bearer(ADMIN_TOKEN)
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { ok: true });
    assert.equal((await fetch(`${baseUrl}/api/files/${fileId}`, {
      headers: bearer(ADMIN_TOKEN)
    })).status, 404);
    assert.equal((await fetch(`${baseUrl}${share.url}`)).status, 404);
  });

  test('static app is served with a restrictive content security policy', async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    const html = await response.text();
    assert.match(html, /ClawDrop/);
    assert.match(html, /autocomplete="username"/);
    assert.match(html, /id="file-search"/);
    assert.match(html, /id="upload-form"/);
    assert.match(html, /id="download-progress-wrap"/);
    assert.match(html, /id="download-progress"/);
    assert.match(html, /id="download-progress-status"/);
    assert.match(html, /当前下载限速：100 KB\/s/);
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
