'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_TOKEN = 'test-admin-token-with-at-least-32-characters';
const UPLOAD_TOKEN = 'test-upload-token-with-at-least-32-characters';

let baseUrl;
let child;
let tempRoot;
let uploadedId;

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

describe('ClawDrop API', { concurrency: false }, () => {
  before(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'clawdrop-test-'));
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
        DATABASE_PATH: path.join(tempRoot, 'data', 'clawdrop.sqlite'),
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
    assert.equal((await detail.json()).file.downloadCount, 1);
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

  test('delete removes the stored file and soft-deletes its metadata', async () => {
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

    const favicon = await fetch(`${baseUrl}/favicon.svg`);
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get('content-type'), /^image\/svg\+xml/);
  });
});
