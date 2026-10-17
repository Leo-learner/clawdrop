'use strict';

// Clerk sign-in mode: the browser admin is the owner's dkz12345 Clerk account.
// Session tokens are signed locally with a throwaway key (no network).
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const UPLOAD_TOKEN = 'test-upload-token-with-at-least-32-characters';
const ADMIN_TOKEN = 'test-admin-token-with-at-least-32-characters';
const OWNER = 'user_owner';

let signer;
let publishableKey;
let baseUrl;
let child;
let root;
let logs = '';

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

function startServer(env) {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitForServer(url, processHandle) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`server exited: ${logs}`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      // Still binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not become healthy');
}

function session(claims = {}) {
  return signer.token({ sub: OWNER, azp: baseUrl, fva: [0, 0], ...claims });
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function uploadWith(token) {
  const form = new FormData();
  form.append('file', new Blob(['hello clerk']), 'hello.txt');
  return fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: bearer(token), body: form });
}

before(async () => {
  ({ createTestSigner: signer, TEST_PUBLISHABLE_KEY: publishableKey } = await import('../lib/clerk-gate/test-signer.js'));
  signer = signer();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'clawdrop-clerk-test-'));
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = startServer({
    PORT: String(port),
    UPLOAD_TOKEN,
    ADMIN_TOKEN,
    CLERK_PUBLISHABLE_KEY: publishableKey,
    CLERK_JWT_KEY: signer.jwtKey,
    OWNER_CLERK_USER_ID: OWNER,
    PUBLIC_BASE_URL: baseUrl,
    STORAGE_DIR: path.join(root, 'storage'),
    DATABASE_PATH: path.join(root, 'data', 'clawdrop.sqlite')
  });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  await waitForServer(baseUrl, child);
});

after(async () => {
  if (child && child.exitCode === null) {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill('SIGTERM');
    });
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe('Clerk sign-in mode', () => {
  test('config and CSP announce Clerk sign-in', async () => {
    const response = await fetch(`${baseUrl}/api/config`);
    assert.equal((await response.json()).signIn, 'clerk');
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' https:\/\/clerk\.dkz12345\.com https:\/\/\*\.protect\.clerk\.com/);
    assert.match(csp, /connect-src 'self' https:\/\/clerk\.dkz12345\.com https:\/\/\*\.protect\.clerk\.com:\*/);
    assert.match(csp, /worker-src 'self' blob:/);
    assert.match(logs, /ADMIN_TOKEN is ignored/);
  });

  test('the owner session opens the admin API', async () => {
    const response = await fetch(`${baseUrl}/api/files`, { headers: bearer(session()) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).files, []);
  });

  test('signed-out, forged, cookie-only and ADMIN_TOKEN requests get 401', async () => {
    const cases = [
      {},
      bearer(ADMIN_TOKEN),
      bearer(`${session().slice(0, -4)}AAAA`),
      bearer(session({ azp: 'https://games.dkz12345.com' })),
      bearer(session({ exp: Math.floor(Date.now() / 1000) - 120 })),
      { Cookie: `__session=${session()}` }
    ];
    for (const headers of cases) {
      const response = await fetch(`${baseUrl}/api/files`, { headers });
      assert.equal(response.status, 401, JSON.stringify(Object.keys(headers)));
    }
  });

  test('someone else gets NOT_OWNER; a stale or single-factor owner session gets REAUTH_REQUIRED', async () => {
    const stranger = await fetch(`${baseUrl}/api/files`, { headers: bearer(session({ sub: 'user_stranger' })) });
    assert.equal(stranger.status, 403);
    assert.equal((await stranger.json()).code, 'NOT_OWNER');
    for (const fva of [[0, -1], [721, 721], [0, 721]]) {
      const response = await fetch(`${baseUrl}/api/files`, { headers: bearer(session({ fva })) });
      assert.equal(response.status, 403, String(fva));
      assert.equal((await response.json()).code, 'REAUTH_REQUIRED');
    }
    const missing = await fetch(`${baseUrl}/api/files`, { headers: bearer(session({ fva: null })) });
    assert.equal((await missing.json()).code, 'REAUTH_REQUIRED');
  });

  test('UPLOAD_TOKEN still uploads; the owner downloads by Bearer and by ticket', async () => {
    const uploaded = await uploadWith(UPLOAD_TOKEN);
    assert.equal(uploaded.status, 201);
    const { file } = await uploaded.json();
    assert.equal((await uploadWith(session())).status, 401, 'Clerk tokens are not upload tokens');
    assert.equal((await fetch(`${baseUrl}/api/files`, { headers: bearer(UPLOAD_TOKEN) })).status, 401);

    const direct = await fetch(`${baseUrl}/api/files/${file.id}/download`, { headers: bearer(session()) });
    assert.equal(direct.status, 200);
    assert.equal(await direct.text(), 'hello clerk');
    const strangerDownload = await fetch(`${baseUrl}/api/files/${file.id}/download`, {
      headers: bearer(session({ sub: 'user_stranger' }))
    });
    assert.equal(strangerDownload.status, 403);

    const ticket = await fetch(`${baseUrl}/api/files/${file.id}/download-ticket`, {
      method: 'POST',
      headers: bearer(session())
    });
    assert.equal(ticket.status, 200);
    const cookie = (ticket.headers.get('set-cookie') || '').split(';')[0];
    const viaTicket = await fetch(`${baseUrl}/api/files/${file.id}/download`, { headers: { Cookie: cookie } });
    assert.equal(viaTicket.status, 200);
  });
});

test('a partial Clerk configuration refuses to start', async () => {
  const port = await getFreePort();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawdrop-clerk-partial-'));
  const partial = startServer({
    PORT: String(port),
    UPLOAD_TOKEN,
    OWNER_CLERK_USER_ID: OWNER,
    STORAGE_DIR: path.join(dir, 'storage'),
    DATABASE_PATH: path.join(dir, 'data', 'clawdrop.sqlite')
  });
  let stderr = '';
  partial.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => partial.once('exit', resolve));
  await fs.rm(dir, { recursive: true, force: true });
  assert.notEqual(code, 0);
  assert.match(stderr, /must be set together/);
});
