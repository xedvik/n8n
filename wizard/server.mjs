import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT,
  buildCandidateConfig,
  createConfigBackup,
  listConfigBackups,
  loadCurrentConfig,
  loadTemplate,
  publicConfig,
  restoreConfigBackup,
  saveConfig,
  validateConfig,
} from './lib/config.mjs';
import { N8nApi, N8nApiError, defaultN8nBaseUrl } from './lib/n8n-api.mjs';
import {
  authStatus,
  clearSessionCookie,
  initAuth,
  isServerMode,
  loadStoredN8nKey,
  loginAdmin,
  registerAdmin,
  revokeSessions,
  saveStoredN8nKey,
  sessionCookie,
  verifySession,
} from './lib/auth.mjs';
import {
  ensureCredential,
  googleSheetsProvision,
  n8nCredentialsUrl,
  testIntegration,
  testStoredCredential,
} from './lib/integrations.mjs';
import { WORKFLOW_ID, applyWorkflowCredentials, installWorkflow } from './lib/workflow.mjs';
import { runDoctor } from './lib/doctor.mjs';
import { createOps } from './lib/ops.mjs';
import {
  hostAllowed,
  isLoopback,
  makeToken,
  originAllowed,
  readJsonBody,
  sanitizeText,
  securityHeaders,
  sendError,
  sendJson,
  tokenMatches,
} from './lib/security.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const HOST = process.env.WIZARD_HOST || '127.0.0.1';
const PORT = Number(process.env.WIZARD_PORT || 8787);
const ALLOW_REMOTE = process.env.WIZARD_ALLOW_REMOTE === '1';
const SERVER_MODE = isServerMode();
const TOKEN = makeToken();
let api = new N8nApi({ baseUrl: defaultN8nBaseUrl() });
const ops = createOps({ cwd: ROOT });
const N8N_URL = api.baseUrl;
const N8N_PUBLIC_URL = String(process.env.N8N_PUBLIC_URL || N8N_URL).replace(/\/+$/, '');

if (!ALLOW_REMOTE && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  throw new Error('WIZARD_HOST должен быть loopback. Для удалённого доступа задайте WIZARD_ALLOW_REMOTE=1.');
}

try {
  await initAuth();
} catch (error) {
  console.error(`CRM Setup Wizard: ${error.message}`);
  process.exit(1);
}

if (SERVER_MODE && !process.env.N8N_API_KEY) {
  try {
    const storedKey = await loadStoredN8nKey();
    if (storedKey) api = new N8nApi({ baseUrl: defaultN8nBaseUrl(), apiKey: storedKey });
  } catch (error) {
    console.error(`CRM Setup Wizard: сохранённый n8n API key недоступен (${error.code || 'error'}).`);
    process.exit(1);
  }
}

function statusFor(rows, types) {
  const row = rows.find((item) => types.includes(item.type));
  if (!row) return { status: 'not_configured' };
  return { status: 'configured', id: row.id, name: row.name, type: row.type };
}

function credentialKind(type) {
  if (type === 'googleApi') return 'service_account';
  if (type === 'googleSheetsOAuth2Api') return 'oauth2';
  return undefined;
}

function publicUrlFor(req) {
  const configured = String(process.env.N8N_PUBLIC_URL || '').trim();
  if (configured && !configured.includes('CHANGE_ME')) return configured.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || (SERVER_MODE ? 'https' : 'http')).split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function setupUrls(publicUrl) {
  return {
    publicUrl,
    webhookUrl: `${publicUrl}/webhook/lead-intake`,
    webhookTestUrl: `${publicUrl}/webhook-test/lead-intake`,
    oauthCallbackUrl: `${publicUrl}/rest/oauth2-credential/callback`,
  };
}

async function bootstrap(req) {
  const current = await loadCurrentConfig();
  const template = await loadTemplate();
  const warnings = [];
  if (current.error) warnings.push(`Текущий конфиг невалиден: ${current.error}`);
  const reachable = await api.health();
  const publicUrl = publicUrlFor(req);
  const urls = setupUrls(publicUrl);
  const n8n = {
    baseUrl: N8N_URL,
    publicUrl,
    webhookUrl: urls.webhookUrl,
    oauthCallbackUrl: urls.oauthCallbackUrl,
    apiKeyConfigured: api.configured,
    reachable,
    workflowId: WORKFLOW_ID,
    workflowExists: null,
    workflowActive: null,
    workflowName: null,
  };
  let credentials = {
    headerAuth: { status: 'unknown' },
    postgres: { status: 'unknown' },
    google: { status: 'unknown' },
    hubspot: { status: 'unknown' },
    telegram: { status: 'unknown' },
  };

  if (api.configured && reachable) {
    try {
      const workflow = await api.getWorkflow(WORKFLOW_ID);
      n8n.workflowExists = true;
      n8n.workflowActive = Boolean(workflow.active);
      n8n.workflowName = workflow.name || null;
    } catch (error) {
      if (error instanceof N8nApiError && error.status === 404) {
        n8n.workflowExists = false;
      } else {
        warnings.push(`Не удалось прочитать workflow: ${error.message}`);
      }
    }
    try {
      const rows = await api.listCredentials();
      credentials = {
        headerAuth: statusFor(rows, ['httpHeaderAuth']),
        postgres: statusFor(rows, ['postgres']),
        google: statusFor(rows, ['googleApi', 'googleSheetsOAuth2Api']),
        hubspot: statusFor(rows, ['hubspotAppToken', 'hubspotOAuth2Api']),
        telegram: statusFor(rows, ['telegramApi']),
      };
      if (credentials.google.type) credentials.google.mode = credentialKind(credentials.google.type);
    } catch (error) {
      warnings.push(`Не удалось получить credentials: ${error.message}`);
    }
  } else if (api.configured && !reachable) {
    warnings.push('n8n недоступен. Проверьте, что контейнер запущен.');
  }

  return {
    ok: true,
    auth: { serverMode: SERVER_MODE },
    setup: {
      ...urls,
      hasConfig: current.exists,
      workflowActive: Boolean(n8n.workflowActive),
      apiKeyConfigured: api.configured,
      complete: Boolean(current.exists && api.configured && n8n.workflowExists && n8n.workflowActive),
    },
    hasConfig: current.exists,
    config: publicConfig(current.config || template),
    template: publicConfig(template),
    n8n,
    credentials,
    warnings,
  };
}

async function resolveCredentialRef(ref) {
  if (!ref || typeof ref !== 'object' || !ref.id) return null;
  const credential = await api.getCredential(String(ref.id));
  return {
    id: credential.id,
    name: credential.name,
    type: credential.type,
    mode: ref.mode || credentialKind(credential.type),
  };
}

function mapError(error) {
  if (error instanceof N8nApiError) {
    return {
      status: error.status >= 400 && error.status <= 599 ? error.status : 502,
      code: error.code || 'n8n_api_error',
      message: error.message,
    };
  }
  const known = {
    invalid_config: 400,
    validation_error: 400,
    credential_type_mismatch: 400,
    n8n_api_key_missing: 400,
    n8n_key_env_locked: 409,
    n8n_key_decrypt_failed: 500,
    invalid_api_key: 400,
    confirmation_required: 400,
    body_too_large: 413,
    invalid_json: 400,
    doctor_busy: 409,
    workflow_node_missing: 500,
    workflow_invalid: 500,
    server_mode_required: 400,
    bootstrap_token_missing: 500,
    invalid_bootstrap_token: 403,
    registration_closed: 409,
    already_configured: 409,
    invalid_username: 400,
    invalid_password: 400,
    invalid_credentials: 401,
    rate_limited: 429,
    not_registered: 409,
    auth_not_initialized: 500,
    auth_state_invalid: 500,
    session_secret_invalid: 500,
    n8n_unreachable: 502,
    n8n_unauthorized: 401,
    n8n_api_error: 502,
    invalid_backup: 400,
    backup_not_found: 404,
    config_not_found: 404,
    invalid_operation_id: 400,
    invalid_status: 400,
    operation_not_found: 404,
    operation_state_invalid: 409,
    docker_unavailable: 503,
    google_auth_error: 502,
    google_api_error: 502,
  };
  return {
    status: known[error.code] || error.status || 500,
    code: error.code || 'internal_error',
    message: error.code ? error.message : 'Внутренняя ошибка мастера.',
  };
}

function mapN8nConnectError(error, suppliedKey) {
  if (!(error instanceof N8nApiError)) return mapError(error);
  const code =
    error.code === 'n8n_unauthorized'
      ? 'n8n_unauthorized'
      : error.code === 'n8n_unreachable'
        ? 'n8n_unreachable'
        : 'n8n_api_error';
  const status =
    code === 'n8n_unauthorized'
      ? 401
      : code === 'n8n_unreachable'
        ? 502
        : error.status >= 400 && error.status <= 599
          ? error.status
          : 502;
  return { status, code, message: sanitizeText(error.message, [suppliedKey]) };
}

function localRequest(req, res) {
  if (!SERVER_MODE && !ALLOW_REMOTE && !isLoopback(req.socket.remoteAddress)) {
    sendError(res, 403, 'forbidden', 'Мастер доступен только локально.');
    return false;
  }
  if (!hostAllowed(req.headers.host, PORT)) {
    sendError(res, 403, 'invalid_host', 'Неверный Host. Откройте мастер через localhost.');
    return false;
  }
  return true;
}

function requireSession(req, res) {
  if (!SERVER_MODE) return true;
  if (verifySession(req)) return true;
  sendError(res, 401, 'auth_required', 'Требуется вход в мастер.');
  return false;
}

function clientIp(req) {
  const socketIp = String(req.socket.remoteAddress || 'unknown');
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && (isLoopback(socketIp) || process.env.WIZARD_TRUST_PROXY === '1')) {
    const entries = String(forwarded)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (entries.length) return entries[entries.length - 1];
  }
  return socketIp;
}

function requireToken(req, res) {
  if (!localRequest(req, res)) return false;
  if (!originAllowed(req.headers.origin, req.headers.host)) {
    sendError(res, 403, 'invalid_origin', 'Запрос с другого origin отклонён.');
    return false;
  }
  if (!tokenMatches(TOKEN, req.headers['x-wizard-token'])) {
    sendError(res, 403, 'invalid_token', 'Сессия мастера устарела. Перезагрузите страницу.');
    return false;
  }
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().includes('application/json')) {
    sendError(res, 415, 'unsupported_media_type', 'Ожидается application/json.');
    return false;
  }
  return true;
}

async function readBody(req, res) {
  try {
    return await readJsonBody(req);
  } catch (error) {
    if (error.code === 'body_too_large') {
      sendError(res, 413, 'body_too_large', 'Тело запроса слишком велико.');
      res.once('finish', () => req.destroy());
      return null;
    }
    sendError(res, 400, error.code || 'invalid_json', 'Некорректный JSON.');
    return null;
  }
}

async function handleAuthPost(req, res, url) {
  if (!requireToken(req, res)) return true;
  const body = await readBody(req, res);
  if (!body) return true;
  try {
    if (url.pathname === '/api/auth/register') {
      const created = await registerAdmin({
        token: body.token,
        username: body.username,
        password: body.password,
        ip: clientIp(req),
      });
      const session = await loginAdmin({
        username: created.username,
        password: body.password,
        ip: clientIp(req),
      });
      sendJson(
        res,
        200,
        { ok: true, registered: true, username: session.username },
        { 'Set-Cookie': sessionCookie(session.token) },
      );
      return true;
    }
    if (url.pathname === '/api/auth/login') {
      const session = await loginAdmin({
        username: body.username,
        password: body.password,
        ip: clientIp(req),
      });
      sendJson(
        res,
        200,
        { ok: true, username: session.username },
        { 'Set-Cookie': sessionCookie(session.token) },
      );
      return true;
    }
    if (url.pathname === '/api/auth/logout') {
      if (verifySession(req)) await revokeSessions();
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
      return true;
    }
  } catch (error) {
    const mapped = mapError(error);
    sendError(res, mapped.status, mapped.code, mapped.message);
  }
  return true;
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/status') {
    sendJson(res, 200, { ok: true, ...authStatus(req) });
    return true;
  }
  if (
    SERVER_MODE &&
    req.method === 'POST' &&
    (url.pathname === '/api/auth/register' ||
      url.pathname === '/api/auth/login' ||
      url.pathname === '/api/auth/logout')
  ) {
    return handleAuthPost(req, res, url);
  }
  if (!requireSession(req, res)) return true;
  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    sendJson(res, 200, await bootstrap(req));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/config/validate') {
    if (!requireToken(req, res)) return true;
    const body = await readBody(req, res);
    if (!body) return true;
    try {
      const candidate = await buildCandidateConfig(body.config || {});
      const result = await validateConfig(candidate);
      if (!result.ok) {
        sendJson(res, 400, { ok: false, error: 'invalid_config', message: 'Конфигурация не прошла проверку.', details: result.error });
      } else {
        sendJson(res, 200, { ok: true, config: result.config, warnings: [] });
      }
    } catch (error) {
      const mapped = mapError(error);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/config') {
    if (!requireToken(req, res)) return true;
    const body = await readBody(req, res);
    if (!body) return true;
    try {
      const result = await saveConfig(body.config || {});
      sendJson(res, 200, { ok: true, config: publicConfig(result.config), backupCreated: result.backupCreated });
    } catch (error) {
      const mapped = mapError(error);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/credentials') {
    try {
      const credentials = await api.listCredentials(url.searchParams.get('type') || undefined);
      sendJson(res, 200, { ok: true, credentials });
    } catch (error) {
      const mapped = mapError(error);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/credentials') {
    if (!requireToken(req, res)) return true;
    const body = await readBody(req, res);
    if (!body) return true;
    try {
      const result = await ensureCredential(api, {
        kind: body.kind,
        values: body.values || {},
        existingId: body.existingId,
        replaceExisting: Boolean(body.replaceExisting),
      });
      sendJson(res, 200, {
        ok: true,
        credential: result.credential,
        status: result.status,
        reused: result.reused,
        requiresAuthorization: Boolean(result.requiresAuthorization),
        n8nUrl: result.requiresAuthorization ? n8nCredentialsUrl(N8N_PUBLIC_URL) : null,
        message: result.requiresAuthorization
          ? 'Credential создан. Откройте n8n и нажмите Connect для OAuth.'
          : result.reused
            ? 'Используется существующий credential.'
            : 'Credential создан.',
      });
    } catch (error) {
      const mapped = mapError(error);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  const testMatch = url.pathname.match(/^\/api\/credentials\/([^/]+)\/test$/);
  if (req.method === 'POST' && testMatch) {
    if (!requireToken(req, res)) return true;
    try {
      const result = await testStoredCredential(api, decodeURIComponent(testMatch[1]));
      sendJson(res, 200, result);
    } catch (error) {
      const mapped = mapError(error);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/integrations/test') {
    if (!requireToken(req, res)) return true;
    const body = await readBody(req, res);
    if (!body) return true;
    try {
      const result = await testIntegration(body.kind, body.values || {});
      sendJson(res, 200, result);
    } catch (error) {
      const mapped = mapError(error);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/workflow/apply') {
    if (!requireToken(req, res)) return true;
    const body = await readBody(req, res);
    if (!body) return true;
    try {
      const current = await loadCurrentConfig();
      if (!current.exists || current.error || !current.config) {
        throw Object.assign(new Error('Сначала сохраните корректную конфигурацию.'), { code: 'invalid_config' });
      }
      const refs = body.credentials || {};
      const credentials = {
        headerAuth: await resolveCredentialRef(refs.headerAuth),
        postgres: await resolveCredentialRef(refs.postgres),
        google: await resolveCredentialRef(refs.google),
        hubspot: await resolveCredentialRef(refs.hubspot),
        telegram: await resolveCredentialRef(refs.telegram),
      };
      if (!Object.values(credentials).some(Boolean)) {
        throw Object.assign(new Error('Не переданы credentials для назначения.'), { code: 'validation_error' });
      }
      const result = await applyWorkflowCredentials(api, current.config, credentials);
      sendJson(res, 200, { ok: true, ...result, message: 'Credentials назначены workflow.' });
    } catch (error) {
      const mapped = mapError(error);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/workflow/install') {
    if (!requireToken(req, res)) return true;
    const body = await readBody(req, res);
    if (!body) return true;
    if (body.confirm !== true) {
      sendError(res, 400, 'confirmation_required', 'Установка workflow требует явного подтверждения.');
      return true;
    }
    const result = await installWorkflow();
    sendJson(res, result.ok ? 200 : 500, {
      ok: result.ok,
      message: result.message,
      details: sanitizeText(result.output),
    });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/doctor') {
    if (!requireToken(req, res)) return true;
    const body = await readBody(req, res);
    if (!body) return true;
    const integrationTest = Boolean(body.integrationTest);
    if (integrationTest && body.confirm !== true) {
      sendError(res, 400, 'confirmation_required', 'Тестовая заявка требует явного подтверждения.');
      return true;
    }
    try {
      const result = await runDoctor({ integrationTest });
      sendJson(res, 200, result);
    } catch (error) {
      const mapped = mapError(error);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/services') {
    try {
      sendJson(res, 200, await ops.health());
    } catch (error) {
      const mapped = mapError(error);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/operations/summary') {
    try {
      sendJson(res, 200, await ops.summary());
    } catch (error) {
      const mapped = mapError(error);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/operations') {
    try {
      const result = await ops.list({
        status: url.searchParams.get('status') || undefined,
        limit: url.searchParams.get('limit') || undefined,
      });
      result.operations = result.operations.map((operation) => ({
        ...operation,
        lastError: sanitizeText(operation.lastError),
      }));
      sendJson(res, 200, result);
    } catch (error) {
      const mapped = mapError(error);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  const retryMatch = url.pathname.match(/^\/api\/operations\/([^/]+)\/retry$/);
  if (req.method === 'POST' && retryMatch) {
    if (!requireToken(req, res)) return true;
    const body = await readBody(req, res);
    if (!body) return true;
    try {
      const result = await ops.retry(decodeURIComponent(retryMatch[1]), {
        resetAttempts: Boolean(body.resetAttempts),
      });
      sendJson(res, 200, result);
    } catch (error) {
      const mapped = mapError(error);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/config/backups') {
    try {
      sendJson(res, 200, { ok: true, backups: await listConfigBackups() });
    } catch (error) {
      const mapped = mapError(error);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/config/backups') {
    if (!requireToken(req, res)) return true;
    try {
      sendJson(res, 200, { ok: true, backup: await createConfigBackup() });
    } catch (error) {
      const mapped = mapError(error);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/config/restore') {
    if (!requireToken(req, res)) return true;
    const body = await readBody(req, res);
    if (!body) return true;
    if (body.confirm !== true) {
      sendError(res, 400, 'confirmation_required', 'Восстановление конфига требует подтверждения.');
      return true;
    }
    try {
      const restored = await restoreConfigBackup(body.name);
      sendJson(res, 200, {
        ok: true,
        config: publicConfig(restored.config),
        backupCreated: restored.backupCreated,
        backupName: restored.backupName,
        message: 'Конфигурация восстановлена. Проверьте doctor и при необходимости примените workflow.',
      });
    } catch (error) {
      const mapped = mapError(error);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/google/provision') {
    if (!requireToken(req, res)) return true;
    const body = await readBody(req, res);
    if (!body) return true;
    try {
      const result = await googleSheetsProvision({
        serviceAccount: body.serviceAccount,
        spreadsheetId: body.spreadsheetId,
        title: body.title,
        sheets: body.sheets,
      });
      sendJson(res, 200, result);
    } catch (error) {
      const mapped = mapError(error);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  if (SERVER_MODE && req.method === 'POST' && url.pathname === '/api/n8n/connect') {
    if (!requireToken(req, res)) return true;
    const body = await readBody(req, res);
    if (!body) return true;
    const suppliedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!suppliedKey || Buffer.byteLength(suppliedKey, 'utf8') > 4096) {
      sendError(res, 400, 'invalid_api_key', 'Укажите корректный n8n API key (не более 4096 символов).');
      return true;
    }
    if (process.env.N8N_API_KEY) {
      sendError(
        res,
        409,
        'n8n_key_env_locked',
        'N8N_API_KEY задан через окружение и имеет приоритет. Ключ не сохранён.',
      );
      return true;
    }
    try {
      const candidate = new N8nApi({ baseUrl: defaultN8nBaseUrl(), apiKey: suppliedKey });
      if (!(await candidate.health())) {
        throw new N8nApiError('n8n недоступен. Проверьте, что контейнер запущен.', {
          status: 502,
          code: 'n8n_unreachable',
        });
      }
      await candidate.listCredentials();
      await saveStoredN8nKey(suppliedKey);
      api = candidate;
      sendJson(res, 200, {
        ok: true,
        apiKeyConfigured: true,
        message: 'n8n API key подключён и сохранён в зашифрованном виде.',
      });
    } catch (error) {
      const mapped = mapN8nConnectError(error, suppliedKey);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
    return true;
  }
  return false;
}

const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
  ['/favicon.svg', 'favicon.svg'],
]);

const LOGIN_FILES = new Map([
  ['/login.html', 'login.html'],
  ['/login.js', 'login.js'],
  ['/login.css', 'login.css'],
]);
const SERVER_STATIC_FILES = new Map([...STATIC_FILES, ...LOGIN_FILES]);
const PUBLIC_STATIC = new Set(['/login.html', '/login.js', '/login.css', '/styles.css', '/favicon.svg']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function staticFiles() {
  return SERVER_MODE ? SERVER_STATIC_FILES : STATIC_FILES;
}

async function serveFile(req, res, file) {
  let body;
  try {
    body = await fs.readFile(path.join(PUBLIC_DIR, file));
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendError(res, 404, 'not_found', 'Страница не найдена.');
      return;
    }
    throw error;
  }
  if (file.endsWith('.html')) {
    const html = body.toString('utf8');
    const tokenMeta = `<meta name="wizard-token" content="${TOKEN}">`;
    const existingMeta = /<meta\b[^>]*\bname=["']wizard-token["'][^>]*>/i;
    body = Buffer.from(
      existingMeta.test(html)
        ? html.replace(existingMeta, tokenMeta)
        : html.replace('</head>', `${tokenMeta}\n</head>`),
    );
  }
  res.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function serveStatic(req, res, pathname) {
  const file = staticFiles().get(pathname);
  if (!file) {
    sendError(res, 404, 'not_found', 'Страница не найдена.');
    return;
  }
  await serveFile(req, res, file);
}

async function serveStaticRequest(req, res, pathname) {
  if (!SERVER_MODE) {
    await serveStatic(req, res, pathname);
    return;
  }
  if (verifySession(req)) {
    await serveStatic(req, res, pathname);
    return;
  }
  if (pathname === '/' || pathname === '/index.html') {
    await serveFile(req, res, 'login.html');
    return;
  }
  if (PUBLIC_STATIC.has(pathname)) {
    await serveStatic(req, res, pathname);
    return;
  }
  if (staticFiles().has(pathname)) {
    sendError(res, 401, 'auth_required', 'Требуется вход в мастер.');
    return;
  }
  sendError(res, 404, 'not_found', 'Страница не найдена.');
}

const server = http.createServer(async (req, res) => {
  try {
    if (!localRequest(req, res)) return;
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (url.pathname.startsWith('/api/')) {
        if (await handleApi(req, res, url)) return;
      } else {
        await serveStaticRequest(req, res, url.pathname);
        return;
      }
    } else if (await handleApi(req, res, url)) {
      return;
    }
    sendError(res, 404, 'not_found', 'Страница не найдена.');
  } catch (error) {
    const mapped = mapError(error);
    if (!res.headersSent) {
      sendError(
        res,
        mapped.status,
        mapped.code,
        sanitizeText(mapped.message, [process.env.N8N_API_KEY, api.apiKey]),
      );
    } else {
      res.destroy();
    }
  }
});

server.requestTimeout = 190_000;
server.listen(PORT, HOST, () => {
  console.log(`CRM Setup Wizard: http://${HOST}:${PORT}`);
  console.log(`Режим: ${SERVER_MODE ? 'server' : 'local'}`);
  console.log(`n8n API: ${api.configured ? N8N_URL : 'ключ не задан (ручной режим credentials)'}`);
  if (api.configured) console.log(`API key настроен; откройте ${n8nCredentialsUrl(N8N_PUBLIC_URL)} для OAuth Connect.`);
});
