import crypto from 'node:crypto';
export const CREDENTIAL_NAMES = {
  headerAuth: 'CRM Automation Kit - Header Auth',
  postgres: 'CRM Automation Kit - Postgres',
  hubspotServiceKey: 'CRM Automation Kit - HubSpot',
  hubspotOAuth2: 'CRM Automation Kit - HubSpot OAuth2',
  telegram: 'CRM Automation Kit - Telegram',
  googleServiceAccount: 'CRM Automation Kit - Google Sheets',
  googleOAuth2: 'CRM Automation Kit - Google Sheets OAuth2',
};

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(`${label}: значение обязательно`), { code: 'validation_error' });
  }
  return value.trim();
}

function credentialSpec(kind, values = {}) {
  if (kind === 'header_auth') {
    return {
      type: 'httpHeaderAuth',
      name: CREDENTIAL_NAMES.headerAuth,
      data: () => ({
        name: process.env.LEAD_WEBHOOK_HEADER_NAME || 'X-Webhook-Secret',
        value: requireText(process.env.LEAD_WEBHOOK_SECRET, 'LEAD_WEBHOOK_SECRET'),
      }),
    };
  }
  if (kind === 'postgres') {
    return {
      type: 'postgres',
      name: CREDENTIAL_NAMES.postgres,
      data: () => ({
        host: process.env.POSTGRES_HOST || 'postgres',
        port: Number(process.env.POSTGRES_PORT || 5432),
        database: requireText(process.env.POSTGRES_DB, 'POSTGRES_DB'),
        user: requireText(process.env.POSTGRES_USER, 'POSTGRES_USER'),
        password: requireText(process.env.POSTGRES_PASSWORD, 'POSTGRES_PASSWORD'),
        ssl: 'disable',
      }),
    };
  }
  if (kind === 'hubspot') {
    const mode = values.mode === 'oauth2' ? 'oauth2' : 'service_key';
    if (mode === 'oauth2') {
      return {
        type: 'hubspotOAuth2Api',
        name: CREDENTIAL_NAMES.hubspotOAuth2,
        requiresAuthorization: true,
        data: () => ({
          clientId: requireText(values.clientId, 'HubSpot Client ID'),
          clientSecret: requireText(values.clientSecret, 'HubSpot Client Secret'),
        }),
      };
    }
    return {
      type: 'hubspotAppToken',
      name: CREDENTIAL_NAMES.hubspotServiceKey,
      data: () => ({ appToken: requireText(values.appToken, 'HubSpot Service Key') }),
    };
  }
  if (kind === 'telegram') {
    return {
      type: 'telegramApi',
      name: CREDENTIAL_NAMES.telegram,
      data: () => ({ accessToken: requireText(values.botToken, 'Telegram bot token') }),
    };
  }
  if (kind === 'google_service_account') {
    const account = parseServiceAccount(values.serviceAccount);
    return {
      type: 'googleApi',
      name: CREDENTIAL_NAMES.googleServiceAccount,
      data: () => ({ email: account.client_email, privateKey: account.private_key }),
    };
  }
  if (kind === 'google_oauth2') {
    return {
      type: 'googleSheetsOAuth2Api',
      name: CREDENTIAL_NAMES.googleOAuth2,
      requiresAuthorization: true,
      data: () => ({
        clientId: requireText(values.clientId, 'Google Client ID'),
        clientSecret: requireText(values.clientSecret, 'Google Client Secret'),
      }),
    };
  }
  throw Object.assign(new Error(`Неизвестный тип credentials: ${kind}`), { code: 'validation_error' });
}

export function parseServiceAccount(input) {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw Object.assign(new Error('JSON сервисного аккаунта невалиден'), {
        code: 'validation_error',
      });
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('JSON сервисного аккаунта должен быть объектом'), {
      code: 'validation_error',
    });
  }
  const email = requireText(value.client_email, 'client_email');
  const privateKey = requireText(value.private_key, 'private_key');
  if (!email.includes('@') || !privateKey.includes('BEGIN PRIVATE KEY')) {
    throw Object.assign(new Error('Это не похоже на JSON-ключ сервисного аккаунта Google'), {
      code: 'validation_error',
    });
  }
  return { ...value, client_email: email, private_key: privateKey };
}

export async function ensureCredential(api, { kind, values = {}, existingId, replaceExisting = false }) {
  const spec = credentialSpec(kind, values);

  if (existingId) {
    const existing = await api.getCredential(existingId);
    if (existing.type !== spec.type) {
      throw Object.assign(new Error(`Credential ${existingId} имеет тип ${existing.type}, ожидался ${spec.type}`), {
        code: 'credential_type_mismatch',
      });
    }
    return {
      credential: { id: existing.id, name: existing.name, type: existing.type },
      status: spec.requiresAuthorization ? 'requires_auth' : 'configured',
      reused: true,
      requiresAuthorization: Boolean(spec.requiresAuthorization),
    };
  }

  const candidates = await api.listCredentials(spec.type);
  const existing = candidates.find((item) => item.name === spec.name);
  if (existing && !replaceExisting) {
    return {
      credential: { id: existing.id, name: existing.name, type: existing.type },
      status: spec.requiresAuthorization ? 'requires_auth' : 'configured',
      reused: true,
      requiresAuthorization: Boolean(spec.requiresAuthorization),
    };
  }

  let name = spec.name;
  if (existing && replaceExisting) {
    const suffix = crypto.randomBytes(3).toString('hex');
    name = `${spec.name} (new ${suffix})`;
  }
  const created = await api.createCredential({
    name,
    type: spec.type,
    data: spec.data(),
  });
  return {
    credential: { id: created.id, name: created.name, type: created.type },
    status: spec.requiresAuthorization ? 'requires_auth' : 'configured',
    reused: false,
    requiresAuthorization: Boolean(spec.requiresAuthorization),
  };
}

export async function testStoredCredential(api, credentialId) {
  const result = await api.testCredential(credentialId);
  const status = String(result?.status || '').toLowerCase();
  if (status === 'ok') return { ok: true, status: 'connected', message: 'Подключение работает.' };
  const message = result?.message || 'n8n не подтвердил подключение.';
  return {
    ok: false,
    status: /auth|unauthor|credential|token|connect/i.test(message) ? 'requires_auth' : 'error',
    message,
  };
}

async function fetchJson(url, options, timeout = 15_000) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: null,
      message: error.name === 'TimeoutError' ? 'Сервис не ответил вовремя.' : 'Нет соединения с сервисом.',
    };
  }
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  return { ok: response.ok, status: response.status, payload, message: payload?.message || text };
}

export async function testIntegration(kind, values = {}) {
  if (kind === 'hubspot') {
    const token = requireText(values.token, 'HubSpot Service Key');
    const result = await fetchJson(
      'https://api.hubapi.com/crm/v3/objects/contacts?limit=1&properties=email',
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    );
    if (result.status === 200) {
      return { ok: true, status: 'connected', message: 'HubSpot отвечает, Service Key принят.' };
    }
    if ([401, 403].includes(result.status)) {
      return {
        ok: false,
        status: 'requires_auth',
        message: 'HubSpot отклонил Service Key или у него нет scopes для контактов.',
      };
    }
    if (result.status === 429) {
      return { ok: false, status: 'error', message: 'HubSpot ограничил частоту запросов. Повторите позже.' };
    }
    return {
      ok: false,
      status: 'error',
      message: `HubSpot вернул HTTP ${result.status || '—'}. Проверьте ключ и доступ к API.`,
    };
  }

  if (kind === 'telegram') {
    const token = requireText(values.token, 'Telegram bot token');
    const me = await fetchJson(`https://api.telegram.org/bot${token}/getMe`);
    if (me.status === 401) {
      return { ok: false, status: 'requires_auth', message: 'Telegram отклонил bot token.' };
    }
    if (!me.ok) {
      return {
        ok: false,
        status: 'error',
        message: `Telegram вернул HTTP ${me.status || '—'}. Проверьте token.`,
      };
    }
    const username = me.payload?.result?.username || null;
    const chatId = String(values.chatId || '').trim();
    if (!chatId) {
      return {
        ok: true,
        status: 'connected',
        message: 'Бот найден. Укажите Chat ID, чтобы проверить доступ к чату.',
        details: { botUsername: username, needsChatId: true },
      };
    }
    const chat = await fetchJson(
      `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`,
    );
    if (chat.ok) {
      return {
        ok: true,
        status: 'connected',
        message: 'Бот найден и имеет доступ к чату.',
        details: {
          botUsername: username,
          chatTitle: chat.payload?.result?.title || chat.payload?.result?.username || null,
        },
      };
    }
    return {
      ok: false,
      status: chat.status === 403 ? 'requires_auth' : 'error',
      message:
        chat.status === 400
          ? 'Chat ID не найден. Добавьте бота в чат и проверьте ID (у групп он отрицательный).'
          : chat.status === 403
            ? 'Бот не имеет права писать в этот чат.'
            : 'Не удалось проверить чат Telegram.',
    };
  }

  if (kind === 'google_service_account') {
    const account = parseServiceAccount(values.serviceAccount);
    const spreadsheetId = requireText(values.spreadsheetId, 'spreadsheetId');
    const token = await googleAccessToken(account);
    if (!token.ok) {
      return { ok: false, status: 'requires_auth', message: token.message };
    }
    const meta = await fetchJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties.title`,
      { headers: { Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json' } },
    );
    if ([401, 403].includes(meta.status)) {
      return {
        ok: false,
        status: 'requires_auth',
        message: 'Google отклонил доступ. Проверьте, что таблица расшарена сервисному аккаунту.',
      };
    }
    if (!meta.ok) {
      return {
        ok: false,
        status: 'error',
        message:
          meta.status === 404
            ? 'Таблица не найдена. Проверьте URL или ID.'
            : `Google Sheets вернул HTTP ${meta.status || '—'}.`,
      };
    }
    const sheets = (meta.payload?.sheets || [])
      .map((item) => item.properties?.title)
      .filter(Boolean);
    const requested = (Array.isArray(values.sheetNames) ? values.sheetNames : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    const missing = requested.filter((name) => !sheets.includes(name));
    if (missing.length) {
      return {
        ok: false,
        status: 'error',
        message: `В таблице нет вкладок: ${missing.join(', ')}.`,
        details: { spreadsheetTitle: meta.payload?.properties?.title || null, sheets, missing },
      };
    }
    return {
      ok: true,
      status: 'connected',
      message: 'Таблица доступна, нужные вкладки найдены.',
      details: { spreadsheetTitle: meta.payload?.properties?.title || null, sheets },
    };
  }

  throw Object.assign(new Error(`Неизвестная интеграция: ${kind}`), { code: 'validation_error' });
}

export async function googleAccessToken(account) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(
    JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  ).toString('base64url');
  const unsigned = `${header}.${claim}`;
  let assertion;
  try {
    assertion = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url');
  } catch {
    return { ok: false, message: 'Не удалось подписать JWT. Проверьте private_key сервисного аккаунта.' };
  }
  const result = await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${assertion}`,
    }),
  });
  if (!result.ok || !result.payload?.access_token) {
    return {
      ok: false,
      message: result.status === 400 ? 'Google отклонил ключ сервисного аккаунта.' : 'Не удалось получить Google access token.',
    };
  }
  return { ok: true, accessToken: result.payload.access_token };
}

export function n8nCredentialsUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}/home/credentials`;
}

