import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COOKIE_NAME = 'crm_wizard_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const SESSION_VERSION = 'v1';
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 200;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{2,63}$/;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const SCRYPT_OPTIONS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});
const HASH_BYTES = 64;

let authRecord = null;
let bootstrapToken = null;
let sessionSecret = null;
let registrationInProgress = false;
const loginFailures = new Map();

function dataDir() {
  return path.resolve(process.env.WIZARD_DATA_DIR || path.join(ROOT, 'wizard-data'));
}

function authFile() {
  return path.join(dataDir(), 'auth.json');
}

function sessionSecretFile() {
  return path.join(dataDir(), 'session-secret');
}

function n8nKeyFile() {
  return path.join(dataDir(), 'n8n-api-key.enc');
}

function bootstrapTokenFile() {
  return path.join(dataDir(), 'bootstrap-token');
}

function cookiePath() {
  const fallback = isServerMode() ? '/setup' : '/';
  const value = String(process.env.WIZARD_COOKIE_PATH || fallback).trim() || fallback;
  return value.startsWith('/') ? value : `/${value}`;
}

function configurationError(message, code) {
  return Object.assign(new Error(message), { code });
}

function invalidCredentialsError() {
  return Object.assign(new Error('Неверный логин или пароль.'), {
    code: 'invalid_credentials',
    status: 401,
  });
}

function decryptError() {
  return configurationError('Не удалось расшифровать сохранённый n8n API key.', 'n8n_key_decrypt_failed');
}

function safeEqualText(left, right) {
  const a = crypto.createHash('sha256').update(String(left ?? ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(right ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function safeEqualBuffer(left, right) {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, HASH_BYTES, { ...SCRYPT_OPTIONS }, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(key);
    });
  });
}

async function ensureDataDir() {
  const dir = dataDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  return dir;
}

async function writeSecureFile(file, contents) {
  await ensureDataDir();
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, contents, { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function readJsonFile(file, invalidCode, invalidMessage) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  await fs.chmod(file, 0o600);
  try {
    return JSON.parse(raw);
  } catch {
    throw configurationError(invalidMessage, invalidCode);
  }
}

async function readAuthRecord() {
  const parsed = await readJsonFile(authFile(), 'auth_state_invalid', 'Файл auth.json повреждён.');
  if (parsed === null) return null;
  if (
    !parsed ||
    parsed.v !== 1 ||
    typeof parsed.username !== 'string' ||
    typeof parsed.salt !== 'string' ||
    typeof parsed.hash !== 'string' ||
    (parsed.sessionVersion !== undefined &&
      (!Number.isInteger(parsed.sessionVersion) || parsed.sessionVersion < 1)) ||
    !/^[a-f0-9]{32}$/i.test(parsed.salt) ||
    !/^[a-f0-9]{128}$/i.test(parsed.hash)
  ) {
    throw configurationError('Файл auth.json повреждён.', 'auth_state_invalid');
  }
  return parsed;
}

async function readSessionSecretFile() {
  let raw;
  try {
    raw = await fs.readFile(sessionSecretFile(), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  await fs.chmod(sessionSecretFile(), 0o600);
  const value = raw.trim();
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw configurationError('Файл session-secret повреждён.', 'session_secret_invalid');
  }
  return value;
}

async function ensureSessionSecret({ create }) {
  if (sessionSecret) return sessionSecret;
  const existing = await readSessionSecretFile();
  if (existing) {
    sessionSecret = existing;
    return existing;
  }
  if (!create) return null;
  const generated = crypto.randomBytes(32).toString('hex');
  await writeSecureFile(sessionSecretFile(), `${generated}\n`);
  sessionSecret = generated;
  return generated;
}

async function readBootstrapToken() {
  const envToken = String(process.env.WIZARD_BOOTSTRAP_TOKEN || '').trim();
  if (envToken) return envToken;
  let raw;
  try {
    raw = await fs.readFile(bootstrapTokenFile(), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  await fs.chmod(bootstrapTokenFile(), 0o600);
  return raw.trim() || null;
}

function normalizeUsername(value) {
  if (typeof value !== 'string') {
    throw configurationError('Имя пользователя обязательно.', 'invalid_username');
  }
  const username = value.trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw configurationError(
      'Имя пользователя: 3–64 символа, латиница, цифры и . _ @ -.',
      'invalid_username',
    );
  }
  return username;
}

function validatePassword(value) {
  if (typeof value !== 'string') {
    throw configurationError('Пароль обязателен.', 'invalid_password');
  }
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    throw configurationError(
      `Пароль должен быть от ${PASSWORD_MIN_LENGTH} до ${PASSWORD_MAX_LENGTH} символов.`,
      'invalid_password',
    );
  }
  return value;
}

function createSessionToken(username, version) {
  if (!sessionSecret) {
    throw configurationError('Auth не инициализирован.', 'auth_not_initialized');
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    sub: username,
    ver: version,
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_SECONDS,
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(encoded).digest('base64url');
  return `${SESSION_VERSION}.${encoded}.${signature}`;
}

function sessionValueFromRequest(req) {
  const header = req?.headers?.cookie;
  if (typeof header !== 'string' || !header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== COOKIE_NAME) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function pruneLoginFailures(now) {
  for (const [key, record] of loginFailures) {
    if (record.resetAt <= now) loginFailures.delete(key);
  }
}

function registerLoginFailure(ip, now) {
  const record = loginFailures.get(ip);
  if (!record || record.resetAt <= now) {
    loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  record.count += 1;
}

function deriveEncryptionKey(secret) {
  const salt = Buffer.from('crm-wizard-n8n-key-v1', 'utf8');
  const info = Buffer.from('aes-256-gcm:n8n-api-key', 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), salt, info, 32));
}

async function encryptionSecret() {
  if (process.env.WIZARD_SECRET_KEY) return String(process.env.WIZARD_SECRET_KEY);
  const secret = await ensureSessionSecret({ create: true });
  if (!secret) throw configurationError('Auth не инициализирован.', 'auth_not_initialized');
  return secret;
}

export function isServerMode() {
  const value = String(process.env.WIZARD_SERVER_MODE || process.env.WIZARD_MODE || '')
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true' || value === 'server';
}

export async function initAuth() {
  authRecord = null;
  bootstrapToken = null;
  sessionSecret = null;
  registrationInProgress = false;
  loginFailures.clear();

  const serverMode = isServerMode();
  if (!serverMode) {
    return { serverMode: false, registered: false, registrationOpen: false };
  }

  await ensureDataDir();
  authRecord = await readAuthRecord();
  sessionSecret = await ensureSessionSecret({ create: true });

  if (authRecord) {
    await fs.rm(bootstrapTokenFile(), { force: true });
    bootstrapToken = null;
  } else {
    bootstrapToken = await readBootstrapToken();
  }

  if (!authRecord && !bootstrapToken) {
    throw configurationError(
      'Серверный режим: нет auth.json и не задан bootstrap token. Запуск остановлен.',
      'bootstrap_token_missing',
    );
  }

  return {
    serverMode: true,
    registered: Boolean(authRecord),
    registrationOpen: !authRecord && Boolean(bootstrapToken),
  };
}

export function authStatus(req) {
  const serverMode = isServerMode();
  const session = serverMode ? verifySession(req) : null;
  return {
    serverMode,
    configured: Boolean(authRecord),
    authenticated: serverMode ? Boolean(session) : true,
    username: session ? session.sub : null,
    expiresAt: session ? session.exp * 1000 : null,
    registrationOpen: serverMode && !authRecord && Boolean(bootstrapToken),
  };
}

export async function registerAdmin({ token, username, password, ip = '' } = {}) {
  if (!isServerMode()) {
    throw configurationError('Регистрация доступна только в серверном режиме.', 'server_mode_required');
  }
  if (registrationInProgress) {
    throw configurationError('Регистрация уже выполняется.', 'registration_closed');
  }
  registrationInProgress = true;
  try {
    const current = authRecord || (await readAuthRecord());
    if (current) {
      throw configurationError('Администратор уже зарегистрирован.', 'already_configured');
    }
    const expectedToken = bootstrapToken || (await readBootstrapToken());
    if (!expectedToken) {
      throw configurationError('Одноразовый токен настройки недоступен.', 'registration_closed');
    }
    if (!safeEqualText(expectedToken, token)) {
      throw configurationError(
        'Одноразовый токен настройки недействителен или устарел.',
        'invalid_bootstrap_token',
      );
    }

    const normalizedUsername = normalizeUsername(username);
    const validPassword = validatePassword(password);
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await scryptAsync(validPassword, salt);
    const record = {
      v: 1,
      username: normalizedUsername,
      salt,
      hash: hash.toString('hex'),
      params: { N: SCRYPT_OPTIONS.N, r: SCRYPT_OPTIONS.r, p: SCRYPT_OPTIONS.p },
      sessionVersion: 1,
      createdAt: new Date().toISOString(),
    };

    await writeSecureFile(authFile(), `${JSON.stringify(record, null, 2)}\n`);
    authRecord = record;
    bootstrapToken = null;
    await fs.rm(bootstrapTokenFile(), { force: true });
    return { ok: true, username: normalizedUsername };
  } finally {
    registrationInProgress = false;
  }
}

export async function loginAdmin({ username, password, ip = 'unknown' } = {}) {
  if (!isServerMode()) {
    throw configurationError('Вход доступен только в серверном режиме.', 'server_mode_required');
  }
  const now = Date.now();
  pruneLoginFailures(now);
  const clientKey = String(ip || 'unknown');
  const failure = loginFailures.get(clientKey);
  if (failure && failure.count >= LOGIN_MAX_FAILURES && failure.resetAt > now) {
    throw Object.assign(new Error('Слишком много попыток входа. Повторите позже.'), {
      code: 'rate_limited',
      status: 429,
    });
  }

  const current = authRecord || (await readAuthRecord());
  if (!current) {
    throw Object.assign(new Error('Администратор ещё не зарегистрирован.'), {
      code: 'not_registered',
      status: 409,
    });
  }

  const suppliedUsername = typeof username === 'string' ? username.trim() : '';
  const usernameMatches = safeEqualText(current.username, suppliedUsername);
  const rawPassword = typeof password === 'string' ? password : '';
  const passwordValue = rawPassword.length <= PASSWORD_MAX_LENGTH ? rawPassword : '';
  const derived = await scryptAsync(passwordValue, current.salt);
  const passwordMatches = safeEqualBuffer(derived, Buffer.from(current.hash, 'hex'));

  if (!usernameMatches || !passwordMatches) {
    registerLoginFailure(clientKey, now);
    throw invalidCredentialsError();
  }

  loginFailures.delete(clientKey);
  const token = createSessionToken(current.username, current.sessionVersion || 1);
  return {
    ok: true,
    username: current.username,
    token,
    expiresAt: (Math.floor(now / 1000) + SESSION_TTL_SECONDS) * 1000,
  };
}

export function verifySession(req) {
  if (!isServerMode()) return null;
  if (!sessionSecret) return null;
  const value = sessionValueFromRequest(req);
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION) return null;
  const [, encoded, signature] = parts;
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac('sha256', sessionSecret).update(encoded).digest('base64url');
  if (!safeEqualText(expected, signature)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.sub !== 'string' ||
    !payload.sub ||
    typeof payload.ver !== 'number' ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    typeof payload.nonce !== 'string' ||
    payload.nonce.length < 16
  ) {
    return null;
  }
  if (payload.ver !== (authRecord?.sessionVersion || 1)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return null;
  if (payload.iat > now + 60) return null;
  if (payload.exp - payload.iat > SESSION_TTL_SECONDS + 60) return null;
  return payload;
}

export function sessionCookie(token) {
  const attributes = [
    `${COOKIE_NAME}=${token}`,
    `Path=${cookiePath()}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (process.env.WIZARD_COOKIE_SECURE === '1') attributes.push('Secure');
  return attributes.join('; ');
}

export async function revokeSessions() {
  if (!authRecord) return { ok: true };
  const next = {
    ...authRecord,
    sessionVersion: (authRecord.sessionVersion || 1) + 1,
  };
  await writeSecureFile(authFile(), `${JSON.stringify(next, null, 2)}\n`);
  authRecord = next;
  return { ok: true };
}

export function clearSessionCookie() {
  const attributes = [
    `${COOKIE_NAME}=`,
    `Path=${cookiePath()}`,
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (process.env.WIZARD_COOKIE_SECURE === '1') attributes.push('Secure');
  return attributes.join('; ');
}

export async function loadStoredN8nKey() {
  if (process.env.N8N_API_KEY) return process.env.N8N_API_KEY;
  const payload = await readJsonFile(
    n8nKeyFile(),
    'n8n_key_decrypt_failed',
    'Файл n8n-api-key.enc повреждён.',
  );
  if (payload === null) return null;
  if (
    !payload ||
    payload.v !== 1 ||
    typeof payload.iv !== 'string' ||
    typeof payload.tag !== 'string' ||
    typeof payload.data !== 'string'
  ) {
    throw decryptError();
  }

  const secret = process.env.WIZARD_SECRET_KEY || sessionSecret || (await readSessionSecretFile());
  if (!secret) throw decryptError();

  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      deriveEncryptionKey(String(secret)),
      Buffer.from(payload.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    throw decryptError();
  }
}

export async function saveStoredN8nKey(key) {
  if (process.env.N8N_API_KEY) {
    throw Object.assign(
      new Error('N8N_API_KEY задан через окружение и имеет приоритет; ключ не сохранён.'),
      { code: 'n8n_key_env_locked', status: 409 },
    );
  }
  const value = typeof key === 'string' ? key.trim() : '';
  if (!value) {
    throw configurationError('n8n API key не задан.', 'invalid_api_key');
  }
  if (Buffer.byteLength(value, 'utf8') > 4096) {
    throw configurationError('n8n API key слишком длинный.', 'invalid_api_key');
  }

  const secret = await encryptionSecret();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveEncryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = {
    v: 1,
    alg: 'aes-256-gcm',
    kdf: 'hkdf-sha256',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
    createdAt: new Date().toISOString(),
  };

  await writeSecureFile(n8nKeyFile(), `${JSON.stringify(payload, null, 2)}\n`);
  return { ok: true };
}

export async function deleteStoredN8nKey() {
  await fs.rm(n8nKeyFile(), { force: true });
  return { ok: true };
}
