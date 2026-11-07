import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';
import * as auth from '../wizard/lib/auth.mjs';

const VALID_PASSWORD = 'correct horse battery staple';
const BOOTSTRAP_TOKEN = 'bootstrap-token-for-auth-tests-1234567890';
const SESSION_COOKIE = 'crm_wizard_session';
const tempDirs = [];
const originalEnv = { ...process.env };

async function freshDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-auth-test-'));
  tempDirs.push(dir);
  process.env.WIZARD_DATA_DIR = dir;
  return dir;
}

async function registerAdmin(ip = '10.0.0.1') {
  await auth.initAuth();
  return auth.registerAdmin({
    token: BOOTSTRAP_TOKEN,
    username: 'admin',
    password: VALID_PASSWORD,
    ip,
  });
}

beforeEach(async () => {
  for (const key of [
    'WIZARD_MODE',
    'WIZARD_BOOTSTRAP_TOKEN',
    'WIZARD_COOKIE_PATH',
    'WIZARD_COOKIE_SECURE',
    'WIZARD_SECRET_KEY',
    'N8N_API_KEY',
  ]) {
    delete process.env[key];
  }
  process.env.WIZARD_SERVER_MODE = '1';
  process.env.WIZARD_BOOTSTRAP_TOKEN = BOOTSTRAP_TOKEN;
  await freshDataDir();
});

after(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

test('fails closed in server mode without auth.json and without a bootstrap token', async () => {
  delete process.env.WIZARD_BOOTSTRAP_TOKEN;
  await assert.rejects(
    () => auth.initAuth(),
    (error) => error.code === 'bootstrap_token_missing',
  );
});

test('registers the first admin with a single-use bootstrap token', async () => {
  await auth.initAuth();
  const status = auth.authStatus({ headers: {} });
  assert.equal(status.serverMode, true);
  assert.equal(status.configured, false);
  assert.equal(status.authenticated, false);
  assert.equal(status.registrationOpen, true);

  await assert.rejects(
    () => auth.registerAdmin({
      token: 'wrong-bootstrap-token',
      username: 'admin',
      password: VALID_PASSWORD,
      ip: '10.0.0.1',
    }),
    (error) => error.code === 'invalid_bootstrap_token',
  );

  await assert.rejects(
    () => auth.registerAdmin({
      token: BOOTSTRAP_TOKEN,
      username: 'ad',
      password: VALID_PASSWORD,
      ip: '10.0.0.1',
    }),
    (error) => error.code === 'invalid_username',
  );

  await assert.rejects(
    () => auth.registerAdmin({
      token: BOOTSTRAP_TOKEN,
      username: 'admin',
      password: 'too-short',
      ip: '10.0.0.1',
    }),
    (error) => error.code === 'invalid_password',
  );

  const created = await auth.registerAdmin({
    token: BOOTSTRAP_TOKEN,
    username: 'admin',
    password: VALID_PASSWORD,
    ip: '10.0.0.1',
  });
  assert.equal(created.ok, true);
  assert.equal(created.username, 'admin');

  const dir = process.env.WIZARD_DATA_DIR;
  const authPath = path.join(dir, 'auth.json');
  const raw = await fs.readFile(authPath, 'utf8');
  assert.equal(raw.includes(VALID_PASSWORD), false);
  assert.equal((await fs.stat(authPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  const afterRegistration = auth.authStatus({ headers: {} });
  assert.equal(afterRegistration.configured, true);
  assert.equal(afterRegistration.registrationOpen, false);

  await assert.rejects(
    () => auth.registerAdmin({
      token: BOOTSTRAP_TOKEN,
      username: 'second',
      password: VALID_PASSWORD,
      ip: '10.0.0.1',
    }),
    (error) => error.code === 'already_configured',
  );
});

test('consumes a bootstrap-token file and deletes it after registration', async () => {
  delete process.env.WIZARD_BOOTSTRAP_TOKEN;
  const dir = process.env.WIZARD_DATA_DIR;
  const tokenFile = path.join(dir, 'bootstrap-token');
  await fs.writeFile(tokenFile, `${BOOTSTRAP_TOKEN}\n`, { mode: 0o600 });

  await auth.initAuth();
  assert.equal(auth.authStatus({ headers: {} }).registrationOpen, true);
  await auth.registerAdmin({
    token: BOOTSTRAP_TOKEN,
    username: 'admin',
    password: VALID_PASSWORD,
    ip: '10.0.0.1',
  });

  await assert.rejects(fs.access(tokenFile), (error) => error.code === 'ENOENT');
});

test('logs in with the registered password and signs a verifiable session', async () => {
  await registerAdmin('10.0.0.2');

  await assert.rejects(
    () => auth.loginAdmin({
      username: 'admin',
      password: 'wrong password value',
      ip: '10.0.0.2',
    }),
    (error) => error.code === 'invalid_credentials',
  );

  const session = await auth.loginAdmin({
    username: 'admin',
    password: VALID_PASSWORD,
    ip: '10.0.0.2',
  });
  assert.equal(session.ok, true);
  assert.equal(session.username, 'admin');
  assert.ok(session.token);

  const payload = auth.verifySession({
    headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
  });
  assert.equal(payload.sub, 'admin');
  assert.ok(payload.exp > Math.floor(Date.now() / 1000));
  assert.ok(payload.exp - payload.iat <= 12 * 60 * 60);
  assert.ok(payload.nonce.length >= 16);

  const cookie = auth.sessionCookie(session.token);
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(cookie, /Path=\/setup/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(cookie.includes('Secure'), false);

  process.env.WIZARD_COOKIE_SECURE = '1';
  assert.match(auth.sessionCookie(session.token), /Secure/);
  assert.match(auth.clearSessionCookie(), /Max-Age=0/);
});

test('rejects tampered and expired session tokens', async () => {
  await registerAdmin('10.0.0.3');
  const session = await auth.loginAdmin({
    username: 'admin',
    password: VALID_PASSWORD,
    ip: '10.0.0.3',
  });

  assert.equal(auth.verifySession({ headers: {} }), null);
  assert.equal(auth.verifySession({ headers: { cookie: `${SESSION_COOKIE}=broken` } }), null);

  const [version, encoded, signature] = session.token.split('.');
  const signatureChars = [...signature];
  const middle = Math.floor(signatureChars.length / 2);
  signatureChars[middle] = signatureChars[middle] === 'A' ? 'B' : 'A';
  const tampered = `${version}.${encoded}.${signatureChars.join('')}`;
  assert.equal(
    auth.verifySession({ headers: { cookie: `${SESSION_COOKIE}=${tampered}` } }),
    null,
  );

  const forgedPayload = Buffer.from(
    JSON.stringify({
      sub: 'intruder',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: '0123456789abcdef',
    }),
    'utf8',
  ).toString('base64url');
  const forgedToken = `${version}.${forgedPayload}.${signature}`;
  assert.equal(
    auth.verifySession({ headers: { cookie: `${SESSION_COOKIE}=${forgedToken}` } }),
    null,
  );

  const secret = (
    await fs.readFile(path.join(process.env.WIZARD_DATA_DIR, 'session-secret'), 'utf8')
  ).trim();
  const expiredPayload = Buffer.from(
    JSON.stringify({
      sub: 'admin',
      iat: Math.floor(Date.now() / 1000) - 100000,
      exp: Math.floor(Date.now() / 1000) - 10,
      nonce: '0123456789abcdef',
    }),
    'utf8',
  ).toString('base64url');
  const expiredSignature = crypto
    .createHmac('sha256', secret)
    .update(expiredPayload)
    .digest('base64url');
  assert.equal(
    auth.verifySession({
      headers: { cookie: `${SESSION_COOKIE}=${version}.${expiredPayload}.${expiredSignature}` },
    }),
    null,
  );
});

test('rate limits repeated login failures per IP', async () => {
  await registerAdmin('10.0.0.4');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () => auth.loginAdmin({
        username: 'admin',
        password: `wrong password ${attempt}`,
        ip: '10.0.0.4',
      }),
      (error) => error.code === 'invalid_credentials',
    );
  }

  await assert.rejects(
    () => auth.loginAdmin({
      username: 'admin',
      password: VALID_PASSWORD,
      ip: '10.0.0.4',
    }),
    (error) => error.code === 'rate_limited',
  );

  const otherIp = await auth.loginAdmin({
    username: 'admin',
    password: VALID_PASSWORD,
    ip: '10.0.0.5',
  });
  assert.ok(otherIp.token);
});

test('encrypts the n8n API key at rest and never stores plaintext', async () => {
  await auth.initAuth();
  const key = 'n8n_api_abcdef1234567890';
  const saved = await auth.saveStoredN8nKey(key);
  assert.equal(saved.ok, true);

  const dir = process.env.WIZARD_DATA_DIR;
  const encryptedPath = path.join(dir, 'n8n-api-key.enc');
  const raw = await fs.readFile(encryptedPath, 'utf8');
  assert.equal(raw.includes(key), false);
  const payload = JSON.parse(raw);
  assert.equal(payload.v, 1);
  assert.equal(typeof payload.iv, 'string');
  assert.equal(typeof payload.tag, 'string');
  assert.equal(typeof payload.data, 'string');
  assert.equal((await fs.stat(encryptedPath)).mode & 0o777, 0o600);

  for (const entry of await fs.readdir(dir)) {
    const contents = await fs.readFile(path.join(dir, entry), 'utf8');
    assert.equal(contents.includes(key), false);
  }

  assert.equal(await auth.loadStoredN8nKey(), key);
  await auth.deleteStoredN8nKey();
  assert.equal(await auth.loadStoredN8nKey(), null);
});

test('derives the encryption key from WIZARD_SECRET_KEY when set', async () => {
  process.env.WIZARD_SECRET_KEY = 'explicit-wizard-secret-key-value';
  await auth.initAuth();
  const key = 'n8n_api_secret_key_value';
  await auth.saveStoredN8nKey(key);
  assert.equal(await auth.loadStoredN8nKey(), key);

  delete process.env.WIZARD_SECRET_KEY;
  await assert.rejects(
    () => auth.loadStoredN8nKey(),
    (error) => error.code === 'n8n_key_decrypt_failed',
  );
});

test('environment N8N_API_KEY wins and is never written to disk', async () => {
  await auth.initAuth();
  process.env.N8N_API_KEY = 'env-only-n8n-api-key';
  assert.equal(await auth.loadStoredN8nKey(), 'env-only-n8n-api-key');

  await assert.rejects(
    () => auth.saveStoredN8nKey('new-n8n-api-key'),
    (error) => error.code === 'n8n_key_env_locked',
  );
  await assert.rejects(
    fs.access(path.join(process.env.WIZARD_DATA_DIR, 'n8n-api-key.enc')),
    (error) => error.code === 'ENOENT',
  );
});
