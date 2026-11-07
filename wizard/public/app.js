const TOKEN = document.querySelector('meta[name="wizard-token"]')?.content || '';
const FALLBACK_TIMEZONES = [
  'UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow',
  'Asia/Tbilisi', 'Asia/Yerevan', 'Asia/Almaty', 'Asia/Dubai', 'Asia/Tokyo',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Australia/Sydney',
];
const TIMEZONES = (() => {
  try {
    const list = Intl.supportedValuesOf('timeZone');
    return Array.isArray(list) && list.length ? list : FALLBACK_TIMEZONES;
  } catch {
    return FALLBACK_TIMEZONES;
  }
})();

const state = {
  boot: null,
  baseConfig: null,
  stepId: 'overview',
  company: '',
  timezone: 'UTC',
  crmProvider: 'hubspot',
  journalEnabled: true,
  notificationsEnabled: false,
  errorsEnabled: false,
  defaultSource: 'website',
  allowedSources: [],
  hubspot: { mode: 'service_key', appToken: '', clientId: '', clientSecret: '', test: null },
  google: {
    mainUrl: '', journalUrl: '', errorsUrl: '', leadsSheet: 'Leads', journalSheet: 'Journal',
    errorsSheet: 'Errors', mode: 'service_account', serviceAccountText: '', clientId: '',
    clientSecret: '', test: null,
  },
  telegram: { token: '', chatId: '', test: null },
  mapping: { name: 'name', email: 'email', phone: 'phone', source: 'source', message: 'message', externalId: 'external_id' },
  idempotency: { enabled: true, retentionDays: 30, withoutKeyPolicy: 'process_new' },
  retry: { maxAttempts: 5, baseDelaySeconds: 30, maxDelaySeconds: 3600, processingTimeoutSeconds: 300 },
  refs: { headerAuth: null, postgres: null, google: null, hubspot: null, telegram: null },
  doctor: null,
  workflow: null,
  management: { services: null, summary: null, operations: [], backups: [], loading: false, loaded: false, error: null },
  googleProvision: null,
  error: null,
  busy: false,
  manual: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function setPath(object, path, value) {
  const parts = path.split('.');
  let cursor = object;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {};
    cursor = cursor[parts[i]];
  }
  cursor[parts.at(-1)] = value;
}

function getPath(object, path) {
  return path.split('.').reduce((value, key) => (value == null ? value : value[key]), object);
}

function toast(message, type = '') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast show ${type}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.className = 'toast'; }, 3800);
}

async function api(path, { method = 'GET', body, allowNotOk = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-Wizard-Token'] = TOKEN;
  }
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({ ok: false, message: `HTTP ${response.status}` }));
  if (response.status === 401 && data.error === 'auth_required') {
    location.replace('./');
    const error = new Error(data.message || 'Требуется авторизация.');
    error.data = data;
    error.status = response.status;
    throw error;
  }
  if (!response.ok || (!allowNotOk && data.ok === false)) {
    const error = new Error(data.message || `HTTP ${response.status}`);
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

function errorMessage(error) {
  if (typeof error?.data?.details === 'string') return error.data.details;
  return error?.data?.message || error?.message || 'Неизвестная ошибка';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function n8nPublicUrl() {
  const url = state.boot?.n8n?.publicUrl || state.boot?.n8n?.baseUrl || 'http://127.0.0.1:5678';
  return String(url).replace(/\/+$/, '');
}

function spreadsheetId(value) {
  const text = String(value || '').trim();
  const match = text.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(text)) return text;
  return null;
}

function timezoneValid(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function timezoneNow(value) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: value, dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date());
  } catch {
    return '—';
  }
}

function needsGoogle() {
  return state.crmProvider === 'google_sheets' || state.journalEnabled || state.errorsEnabled;
}

function steps() {
  const result = [
    { id: 'overview', title: 'Обзор', hint: 'Текущее состояние' },
    { id: 'address', title: 'Адрес', hint: 'Публичный URL и webhook' },
    { id: 'client', title: 'Клиент', hint: 'Название и время' },
    { id: 'integrations', title: 'Интеграции', hint: 'CRM, журнал, уведомления' },
  ];
  if (state.crmProvider === 'hubspot') result.push({ id: 'hubspot', title: 'HubSpot', hint: 'Service Key' });
  if (needsGoogle()) result.push({ id: 'google', title: 'Google Sheets', hint: 'Таблица и доступ' });
  if (state.notificationsEnabled) result.push({ id: 'telegram', title: 'Telegram', hint: 'Бот и чат' });
  result.push({ id: 'advanced', title: 'Дополнительно', hint: 'Маппинг, retry, идемпотентность' });
  result.push({ id: 'review', title: 'Проверка', hint: 'Сохранить и проверить' });
  result.push({ id: 'manage', title: 'Управление', hint: 'Операции, backup, сервисы' });
  return result;
}

function statusLabel(status) {
  return ({
    configured: 'Подключено',
    connected: 'Подключено',
    requires_auth: 'Требует авторизации',
    not_configured: 'Не настроена',
    error: 'Ошибка',
    unknown: 'Неизвестно',
  }[status] || 'Неизвестно');
}

function statusClass(status) {
  if (status === 'configured' || status === 'connected') return 'ok';
  if (status === 'requires_auth' || status === 'unknown' || status === 'not_configured') return 'warn';
  return 'err';
}

function badge(status) {
  const cls = statusClass(status);
  return `<span class="badge badge-${cls === 'ok' ? 'success' : cls === 'warn' ? 'warn' : 'danger'}">${statusLabel(status)}</span>`;
}

function statusCard(title, status, note = '') {
  const safeTitle = escapeHtml(title);
  const safeNote = escapeHtml(note);
  return `<div class="status-card">
    <div class="row"><h4>${safeTitle}</h4><span class="status-dot ${statusClass(status)}"></span></div>
    <p>${safeNote || statusLabel(status)}</p>
  </div>`;
}

function applyBootstrap(data) {
  state.boot = data;
  const config = data.config || data.template || {};
  state.baseConfig = structuredClone(config);
  const hasConfig = Boolean(data.hasConfig);
  state.company = hasConfig ? String(config.clientName || '') : '';
  state.timezone = hasConfig ? String(config.timezone || 'UTC') : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  state.crmProvider = config.crm?.provider || 'hubspot';
  state.journalEnabled = hasConfig ? Boolean(config.journal?.enabled) : false;
  state.notificationsEnabled = hasConfig ? Boolean(config.notifications?.enabled) : false;
  state.errorsEnabled = hasConfig ? Boolean(config.errors?.enabled) : false;
  state.defaultSource = hasConfig ? (config.source?.defaultSource || 'website') : 'website';
  state.allowedSources = Array.isArray(config.source?.allowedSources) ? [...config.source.allowedSources] : [];
  state.hubspot.mode = data.credentials?.hubspot?.type === 'hubspotOAuth2Api' ? 'oauth2' : 'service_key';
  state.google.mode = data.credentials?.google?.type === 'googleSheetsOAuth2Api' ? 'oauth2' : 'service_account';

  const usable = (value) => (typeof value === 'string' && !value.startsWith('REPLACE_') && value.trim() ? value.trim() : '');
  const crmId = usable(config.crm?.googleSheets?.spreadsheetId);
  const journalId = usable(config.journal?.googleSheets?.spreadsheetId);
  const errorsId = usable(config.errors?.googleSheets?.spreadsheetId);
  const primary = config.crm?.provider === 'google_sheets' ? crmId : (journalId || errorsId || crmId);
  state.google.mainUrl = primary ? `https://docs.google.com/spreadsheets/d/${primary}/edit` : '';
  state.google.journalUrl = journalId && journalId !== primary ? `https://docs.google.com/spreadsheets/d/${journalId}/edit` : '';
  state.google.errorsUrl = errorsId && errorsId !== primary ? `https://docs.google.com/spreadsheets/d/${errorsId}/edit` : '';
  state.google.leadsSheet = config.crm?.googleSheets?.leadsSheetName || 'Leads';
  state.google.journalSheet = config.journal?.googleSheets?.sheetName || 'Journal';
  state.google.errorsSheet = config.errors?.googleSheets?.sheetName || 'Errors';
  state.telegram.chatId = usable(config.notifications?.telegram?.chatId);
  state.mapping = { ...state.mapping, ...(config.mapping || {}) };
  state.idempotency = { ...state.idempotency, ...(config.idempotency || {}) };
  state.retry = { ...state.retry, ...(config.retry || {}) };

  for (const [key, value] of Object.entries(data.credentials || {})) {
    if (value?.id) {
      state.refs[key] = {
        id: value.id, name: value.name, type: value.type,
        mode: key === 'google' ? value.mode : undefined,
      };
    }
  }
  if (!steps().some((step) => step.id === state.stepId)) state.stepId = 'overview';
}

function render() {
  const list = steps();
  if (!list.some((step) => step.id === state.stepId)) state.stepId = 'integrations';
  const currentIndex = Math.max(0, list.findIndex((step) => step.id === state.stepId));
  $('#progress-bar').style.width = `${((currentIndex + 1) / list.length) * 100}%`;
  $('#progress-label').textContent = `Шаг ${currentIndex + 1} из ${list.length}`;
  $('#top-status').textContent = state.boot?.n8n?.reachable
    ? state.boot.n8n.apiKeyConfigured
      ? `n8n: ${state.boot.n8n.workflowActive ? 'workflow активен' : 'workflow не активен'}`
      : 'n8n: API key не задан'
    : 'n8n недоступен';

  const logoutButton = $('#logout-btn');
  if (logoutButton) logoutButton.classList.toggle('hidden', !state.boot?.auth?.serverMode);

  const stepper = $('#stepper');
  stepper.replaceChildren();
  list.forEach((step, i) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `step-link ${step.id === state.stepId ? 'active' : ''} ${i < currentIndex ? 'done' : ''}`;
    button.dataset.step = step.id;
    button.innerHTML = `<span class="step-num">${i < currentIndex ? '✓' : i + 1}</span><span class="step-copy"><strong>${escapeHtml(step.title)}</strong><small>${escapeHtml(step.hint)}</small></span>`;
    li.append(button);
    stepper.append(li);
  });

  const content = $('#step-content');
  content.replaceChildren();
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = renderStepContent(state.stepId);
  content.append(panel);
  hydrateStep(state.stepId);
  renderActions();
}

function renderError() {
  if (!state.error) return '';
  return `<div class="notice notice-error" role="alert"><strong>Не получилось</strong>${escapeHtml(state.error)}</div>`;
}

function renderStepContent(step) {
  if (step === 'overview') return renderOverview();
  if (step === 'address') return renderAddress();
  if (step === 'client') return renderClient();
  if (step === 'integrations') return renderIntegrations();
  if (step === 'hubspot') return renderHubspot();
  if (step === 'google') return renderGoogle();
  if (step === 'telegram') return renderTelegram();
  if (step === 'advanced') return renderAdvanced();
  if (step === 'manage') return renderManage();
  return renderReview();
}

function renderOverview() {
  const data = state.boot;
  const n8nOk = data?.n8n?.reachable;
  const keyOk = data?.n8n?.apiKeyConfigured;
  return `
    <h2>${data?.hasConfig ? 'Настройка уже существует' : 'Добро пожаловать в CRM Automation Kit'}</h2>
    <p class="lead">${data?.hasConfig ? `Найден конфиг клиента «${escapeHtml(data.config?.clientName || 'без названия')}». Можно изменить настройки, не теряя текущие credentials и workflow.` : 'Проведём настройку по шагам: клиент, интеграции, credentials и проверка. Все данные остаются в вашем контуре.'}</p>
    ${renderError()}
    ${(data?.warnings || []).map((warning) => `<div class="notice notice-warn">${escapeHtml(warning)}</div>`).join('')}
    <div class="status-grid">
      ${statusCard('n8n', n8nOk ? 'configured' : 'error', n8nOk ? (keyOk ? `Workflow: ${data.n8n.workflowName || (data.n8n.workflowExists === false ? 'не найден' : 'неизвестен')}` : 'API key не задан') : 'Проверьте docker compose')}
      ${statusCard('API key n8n', keyOk ? 'configured' : 'requires_auth', keyOk ? 'Автоматизация credentials доступна' : (data?.auth?.serverMode ? 'Требуется подключение' : 'Можно настроить вручную'))}
      ${statusCard('CRM', data?.credentials?.hubspot?.status === 'configured' || data?.credentials?.google?.status === 'configured' ? 'configured' : 'not_configured', 'По текущему конфигу')}
      ${statusCard('PostgreSQL state', data?.credentials?.postgres?.status || 'unknown', 'Нужен для state machine')}
    </div>
    ${keyOk ? '' : data?.auth?.serverMode ? `<div class="secure-connect" role="group" aria-labelledby="connect-title">
      <h3 id="connect-title">Подключите n8n по API key</h3>
      <p>Создайте API key в n8n: <a href="${escapeHtml(n8nPublicUrl())}/settings/api" target="_blank" rel="noopener">Settings → API</a>. Ключ отправляется только серверу мастера и не сохраняется в браузере.</p>
      <div class="connect-row">
        <div class="field grow">
          <label for="n8n-api-key">API key n8n</label>
          <input id="n8n-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="n8n_api_…">
        </div>
        <button type="button" class="btn btn-primary" data-action="connect-n8n">Подключить n8n</button>
      </div>
      <span class="hint">Без подключения продолжить настройку нельзя.</span>
    </div>` : `<div class="notice notice-info" style="margin-top:16px"><strong>Автоматическое создание credentials выключено</strong>Создайте API key в n8n: <a href="${escapeHtml(n8nPublicUrl())}/settings/api" target="_blank" rel="noopener">Settings → API</a>. Без ключа credentials нельзя создать автоматически.</div>`}
    ${data?.n8n?.apiKeyConfigured && data.n8n.workflowExists === false ? `<div class="notice notice-warn" style="margin-top:16px"><strong>Workflow ещё не установлен</strong>Импортируйте v0.4 workflow в n8n, затем назначьте credentials на шаге проверки.<br><button type="button" class="btn btn-secondary btn-small" data-action="install-workflow" style="margin-top:10px">Установить workflow</button></div>` : ''}
  `;
}

function renderClient() {
  return `
    <h2>Клиент</h2>
    <p class="lead">Эти данные попадают в ответы, таблицы и уведомления. Часовой пояс влияет только на отображаемое время; технические метки остаются UTC.</p>
    ${renderError()}
    <div class="grid two">
      <div class="field">
        <label for="company">Название компании</label>
        <input id="company" data-model="company" maxlength="120" placeholder="Например, ООО Ромашка" autocomplete="organization">
        <span class="hint">Как обращаться к клиенту в интерфейсе.</span>
      </div>
      <div class="field">
        <label for="tz-search">Часовой пояс IANA</label>
        <div class="tz-search">
          <input id="tz-search" autocomplete="off" placeholder="Начните вводить: Tbilisi, Moscow…">
          <div id="tz-results" class="tz-results hidden"></div>
        </div>
        <span class="hint" id="tz-now">Текущее время: —</span>
      </div>
    </div>
  `;
}

function renderIntegrations() {
  const cards = [
    ['hubspot', 'HubSpot', 'Контакты через Service Key'],
    ['google_sheets', 'Google Sheets', 'Таблица как CRM'],
    ['none', 'Без CRM', 'Только журнал'],
  ].map(([id, title, text]) => `
    <button type="button" class="choice ${state.crmProvider === id ? 'selected' : ''}" data-crm="${id}">
      ${state.crmProvider === id ? '<span class="badge badge-info">Выбрано</span>' : ''}
      <strong>${title}</strong><span>${text}</span>
    </button>`).join('');

  return `
    <h2>Интеграции</h2>
    <p class="lead">Выберите, куда сохранять заявки. Journal и Telegram можно отключить — тогда их шаги не появятся.</p>
    ${renderError()}
    <div class="cards">${cards}</div>
    <div class="divider"></div>
    <div class="switch-row">
      <div class="switch-copy"><strong>Журнал Google Sheets</strong><span>Независимая запись всех принятых заявок.</span></div>
      <label class="switch"><input type="checkbox" data-model="journalEnabled" data-rerender="1"><span></span></label>
    </div>
    <div class="switch-row">
      <div class="switch-copy"><strong>Уведомления Telegram</strong><span>Сообщение в чат после успешного сохранения.</span></div>
      <label class="switch"><input type="checkbox" data-model="notificationsEnabled" data-rerender="1"><span></span></label>
    </div>
    <div class="switch-row">
      <div class="switch-copy"><strong>Журнал ошибок Google Sheets</strong><span>Отдельная вкладка для сбоев интеграций.</span></div>
      <label class="switch"><input type="checkbox" data-model="errorsEnabled" data-rerender="1"><span></span></label>
    </div>
    <h3>Источники заявок</h3>
    <div class="grid two">
      <div class="field">
        <label for="default-source">Источник по умолчанию</label>
        <input id="default-source" data-model="defaultSource" placeholder="website">
      </div>
      <div class="field">
        <span class="field-label">Разрешённые источники</span>
        <div class="inline"><input class="grow" id="source-input" placeholder="Например, landing"><button type="button" class="btn btn-secondary btn-small" data-action="add-source">Добавить</button></div>
        <div class="chips" id="source-chips"></div>
        <span class="hint">Пустой список означает: принимать любой source. Если source не входит в список, заявка будет отклонена.</span>
      </div>
    </div>
  `;
}

function renderHubspot() {
  const mode = state.hubspot.mode;
  const status = state.hubspot.test || (state.refs.hubspot ? { status: 'configured', message: `Используется: ${state.refs.hubspot.name}` } : null);
  return `
    <h2>HubSpot</h2>
    <p class="lead">Нужен private app с доступом к контактам. Service Key остаётся на сервере мастера и сразу передаётся в n8n credential.</p>
    ${renderError()}
    ${status ? `<div class="notice notice-${status.ok === false ? 'warn' : 'success'}">${escapeHtml(status.message || statusLabel(status.status))}</div>` : ''}
    <div class="grid two">
      <div class="field">
        <label for="hubspot-mode">Способ авторизации</label>
        <select id="hubspot-mode" data-model="hubspot.mode" data-rerender="1">
          <option value="service_key">Service Key (private app)</option>
          <option value="oauth2">OAuth2 (требует Connect)</option>
        </select>
      </div>
      <div class="field">
        <span class="field-label">Где создать</span>
        <a class="btn btn-secondary" href="https://app.hubspot.com/settings/private-apps" target="_blank" rel="noopener">Открыть Private Apps</a>
        <span class="hint">Development → Private apps. Скопируйте access token.</span>
      </div>
    </div>
    ${mode === 'service_key' ? `
      <div class="field" style="margin-top:16px">
        <label for="hubspot-token">Service Key</label>
        <input id="hubspot-token" type="password" data-model="hubspot.appToken" autocomplete="off" placeholder="pat-…">
      </div>` : `
      <div class="grid two" style="margin-top:16px">
        <div class="field"><label for="hubspot-client-id">Client ID</label><input id="hubspot-client-id" data-model="hubspot.clientId" autocomplete="off"></div>
        <div class="field"><label for="hubspot-client-secret">Client Secret</label><input id="hubspot-client-secret" type="password" data-model="hubspot.clientSecret" autocomplete="off"></div>
      </div>
      <div class="notice notice-warn" style="margin-top:12px">После создания credential откройте n8n → Credentials → HubSpot OAuth2 → Connect. Мастер не сможет завершить OAuth за вас.</div>`}
    <div class="notice notice-info" style="margin-top:16px">
      <strong>Scopes private app</strong>
      <div class="chips"><span class="chip">crm.objects.contacts.read</span><span class="chip">crm.objects.contacts.write</span></div>
      <p class="small" style="margin:8px 0 0">Если используете дополнительные свойства контакта, добавьте <code>crm.schemas.contacts.read</code>.</p>
    </div>
    <div class="inline" style="margin-top:16px">
      <button type="button" class="btn btn-secondary" data-action="test-hubspot">Проверить подключение</button>
      ${state.refs.hubspot ? `<button type="button" class="btn btn-ghost btn-small" data-action="test-existing" data-kind="hubspot">Проверить сохранённый credential</button>` : ''}
    </div>
  `;
}

function renderGoogle() {
  const mode = state.google.mode;
  const status = state.google.test;
  let email = '';
  if (state.google.serviceAccountText.trim()) {
    try { email = JSON.parse(state.google.serviceAccountText).client_email || ''; } catch { email = ''; }
  }
  return `
    <h2>Google Sheets</h2>
    <p class="lead">Вставьте полный URL таблицы — мастер извлечёт spreadsheet ID. Для полной автоматизации рекомендуется Service Account: он не требует OAuth-редиректа.</p>
    ${renderError()}
    ${status ? `<div class="notice notice-${status.ok === false ? 'warn' : 'success'}">${escapeHtml(status.message)}</div>` : ''}
    <div class="field">
      <label for="google-url">Ссылка на основную таблицу</label>
      <input id="google-url" data-model="google.mainUrl" placeholder="https://docs.google.com/spreadsheets/d/…/edit">
      <span class="hint">Для CRM, Journal и Errors по умолчанию используется эта таблица.</span>
    </div>
    <div class="grid three" style="margin-top:16px">
      <div class="field"><label for="leads-sheet">Вкладка Leads</label><input id="leads-sheet" data-model="google.leadsSheet"></div>
      <div class="field"><label for="journal-sheet">Вкладка Journal</label><input id="journal-sheet" data-model="google.journalSheet"></div>
      <div class="field"><label for="errors-sheet">Вкладка Errors</label><input id="errors-sheet" data-model="google.errorsSheet"></div>
    </div>
    <details style="margin-top:16px">
      <summary>Отдельные таблицы для Journal / Errors</summary>
      <div>
        <div class="grid two">
          <div class="field"><label for="journal-url">Ссылка Journal</label><input id="journal-url" data-model="google.journalUrl" placeholder="Пусто = основная"></div>
          <div class="field"><label for="errors-url">Ссылка Errors</label><input id="errors-url" data-model="google.errorsUrl" placeholder="Пусто = основная"></div>
        </div>
      </div>
    </details>
    <div class="divider"></div>
    <div class="field">
      <label for="google-mode">Способ доступа</label>
      <select id="google-mode" data-model="google.mode" data-rerender="1">
        <option value="service_account">Service Account (рекомендуется)</option>
        <option value="oauth2">OAuth2 (Connect в n8n)</option>
      </select>
    </div>
    ${mode === 'service_account' ? `
      <div class="grid two" style="margin-top:16px">
        <div class="field">
          <label for="google-sa">JSON-ключ сервисного аккаунта</label>
          <textarea id="google-sa" data-model="google.serviceAccountText" placeholder='{"type":"service_account","client_email":"…","private_key":"…"}' spellcheck="false"></textarea>
          <input id="google-sa-file" type="file" accept=".json,application/json">
          <span class="hint">Файл читается локально и не сохраняется на диск мастером.</span>
        </div>
        <div class="field">
          <span class="field-label">Email сервисного аккаунта</span>
          <div class="code"><code id="google-sa-email">${escapeHtml(email || 'появится после вставки JSON')}</code>${email ? '<button type="button" class="copy-btn" data-copy="' + escapeHtml(email) + '">Копировать</button>' : ''}</div>
          <span class="hint">Откройте таблицу → Share → добавьте этот email с правами Editor.</span>
          <a class="btn btn-secondary btn-small" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud Credentials</a>
        </div>
      </div>` : `
      <div class="grid two" style="margin-top:16px">
        <div class="field"><label for="google-client-id">Client ID</label><input id="google-client-id" data-model="google.clientId" autocomplete="off"></div>
        <div class="field"><label for="google-client-secret">Client Secret</label><input id="google-client-secret" type="password" data-model="google.clientSecret" autocomplete="off"></div>
      </div>
      <div class="notice notice-warn" style="margin-top:12px">Создайте credential в n8n и нажмите Connect. Redirect URI: <span class="code"><code>${escapeHtml(n8nPublicUrl())}/rest/oauth2-credential/callback</code></span></div>`}
    <div class="inline" style="margin-top:16px">
      <button type="button" class="btn btn-secondary" data-action="test-google">Проверить таблицу</button>
      ${mode === 'service_account' ? '<button type="button" class="btn btn-primary" data-action="provision-google">Создать таблицу и заголовки</button>' : ''}
      <a class="btn btn-ghost btn-small" href="https://console.cloud.google.com/apis/library/sheets.googleapis.com" target="_blank" rel="noopener">Включить Sheets API</a>
    </div>
    ${state.googleProvision ? `<div class="notice notice-success" style="margin-top:12px"><strong>${state.googleProvision.created ? 'Таблица создана' : 'Таблица обновлена'}</strong>${escapeHtml(state.googleProvision.spreadsheetUrl || '')}<br>Откройте таблицу → Share → добавьте <code class="inline-code">${escapeHtml(email || 'email сервисного аккаунта')}</code> с правами Editor.</div>` : ''}
    <div class="notice notice-info" style="margin-top:16px">
      <strong>Заголовки первой строки</strong>
      <div class="code"><code id="headers-leads">Created At | External ID | Name | First Name | Last Name | Email | Phone | Source | Message | Request ID</code><button type="button" class="copy-btn" data-copy="Created At | External ID | Name | First Name | Last Name | Email | Phone | Source | Message | Request ID">Копировать</button></div>
      <div class="code" style="margin-top:6px"><code>Journal: Created At | External ID | Name | Email | Phone | Source | Message | Request ID | CRM Provider | CRM Status | CRM Contact ID</code><button type="button" class="copy-btn" data-copy="Created At | External ID | Name | Email | Phone | Source | Message | Request ID | CRM Provider | CRM Status | CRM Contact ID">Копировать</button></div>
    </div>
  `;
}

function renderTelegram() {
  const status = state.telegram.test || (state.refs.telegram ? { status: 'configured', message: `Используется: ${state.refs.telegram.name}` } : null);
  return `
    <h2>Telegram</h2>
    <p class="lead">Создайте бота через BotFather, добавьте его в чат и укажите Chat ID. Для групп ID отрицательный.</p>
    ${renderError()}
    ${status ? `<div class="notice notice-${status.ok === false ? 'warn' : 'success'}">${escapeHtml(status.message || statusLabel(status.status))}</div>` : ''}
    <div class="grid two">
      <div class="field">
        <label for="telegram-token">Bot token</label>
        <input id="telegram-token" type="password" data-model="telegram.token" autocomplete="off" placeholder="123456:AA…">
        <a class="btn btn-secondary btn-small" href="https://t.me/BotFather" target="_blank" rel="noopener">Открыть BotFather</a>
      </div>
      <div class="field">
        <label for="telegram-chat">Chat ID</label>
        <input id="telegram-chat" data-model="telegram.chatId" placeholder="-1001234567890">
        <span class="hint">Напишите боту или в группу, затем откройте <span class="code"><code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code></span> и найдите <code>message.chat.id</code>.</span>
      </div>
    </div>
    <div class="inline" style="margin-top:16px">
      <button type="button" class="btn btn-secondary" data-action="test-telegram">Проверить бота и чат</button>
      ${state.refs.telegram ? `<button type="button" class="btn btn-ghost btn-small" data-action="test-existing" data-kind="telegram">Проверить сохранённый credential</button>` : ''}
    </div>
    <div class="notice notice-info" style="margin-top:16px"><strong>Важно</strong>Если бот не получал сообщений, <code>getUpdates</code> может быть пустым. Сначала добавьте бота в чат и отправьте сообщение.</div>
  `;
}

function summaryRow(label, value) {
  return `<div class="summary-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value || '—')}</span></div>`;
}

function renderAddress() {
  const setup = state.boot?.setup || {};
  const publicUrl = setup.publicUrl || n8nPublicUrl();
  return `
    <h2>Адрес приложения</h2>
    <p class="lead">Один публичный адрес обслуживает n8n, webhook, OAuth callback и мастер. Значения ниже определены текущим HTTPS-входом Caddy; домен и TLS задаются при развёртывании стека.</p>
    ${renderError()}
    <div class="grid two">
      <div class="field">
        <span class="field-label">Публичный адрес</span>
        <div class="code"><code>${escapeHtml(publicUrl)}</code><button type="button" class="copy-btn" data-copy="${escapeHtml(publicUrl)}">Копировать</button></div>
        <span class="hint">Откройте n8n по этому адресу. Мастер доступен по <code class="inline-code">/setup/</code>.</span>
      </div>
      <div class="field">
        <span class="field-label">Webhook заявок</span>
        <div class="code"><code>${escapeHtml(setup.webhookUrl || `${publicUrl}/webhook/lead-intake`)}</code><button type="button" class="copy-btn" data-copy="${escapeHtml(setup.webhookUrl || `${publicUrl}/webhook/lead-intake`)}">Копировать</button></div>
        <span class="hint">Передавайте этот URL в форму/интеграцию источника заявок. Header Auth обязателен.</span>
      </div>
      <div class="field">
        <span class="field-label">OAuth callback</span>
        <div class="code"><code>${escapeHtml(setup.oauthCallbackUrl || `${publicUrl}/rest/oauth2-credential/callback`)}</code><button type="button" class="copy-btn" data-copy="${escapeHtml(setup.oauthCallbackUrl || `${publicUrl}/rest/oauth2-credential/callback`)}">Копировать</button></div>
        <span class="hint">Укажите этот URL в OAuth-приложении Google/HubSpot, если делаете собственную OAuth-интеграцию.</span>
      </div>
      <div class="field">
        <span class="field-label">Проверка</span>
        <div class="inline">
          <button type="button" class="btn btn-secondary" data-action="refresh-address">Проверить доступность</button>
          <a class="btn btn-secondary" href="${escapeHtml(publicUrl)}/" target="_blank" rel="noopener">Открыть n8n</a>
        </div>
        <span class="hint">Проверка обновит статус n8n и workflow без изменения настроек.</span>
      </div>
    </div>
  `;
}

function renderAdvanced() {
  const mapping = state.mapping;
  const idem = state.idempotency;
  const retry = state.retry;
  const mappingFields = [
    ['name', 'Имя', 'name'],
    ['email', 'Email', 'email'],
    ['phone', 'Телефон', 'phone'],
    ['source', 'Источник', 'source'],
    ['message', 'Сообщение', 'message'],
    ['externalId', 'External ID', 'external_id'],
  ].map(([key, label, placeholder]) => `
    <div class="field"><label for="map-${key}">${label}</label><input id="map-${key}" data-model="mapping.${key}" placeholder="${placeholder}"></div>`).join('');
  return `
    <h2>Маппинг и поведение</h2>
    <p class="lead">Эти настройки определяют, какие поля приходят из формы, как работает идемпотентность и сколько раз workflow повторяет временно неуспешные операции.</p>
    ${renderError()}
    <h3>Поля входной заявки</h3>
    <div class="grid three">${mappingFields}</div>
    <p class="hint">Значения — имена полей JSON, которые присылает источник. Для вложенных полей используйте путь через точку.</p>
    <div class="divider"></div>
    <h3>Идемпотентность</h3>
    <div class="grid three">
      <div class="field"><label for="idem-enabled">Включена</label><label class="switch"><input id="idem-enabled" type="checkbox" data-model="idempotency.enabled" data-rerender="1"><span></span></label></div>
      <div class="field"><label for="idem-retention">Хранить, дней</label><input id="idem-retention" type="number" min="1" max="3650" data-model="idempotency.retentionDays"></div>
      <div class="field"><label for="idem-policy">Без ключа</label><select id="idem-policy" data-model="idempotency.withoutKeyPolicy"><option value="process_new">Обрабатывать как новую</option></select></div>
    </div>
    <div class="divider"></div>
    <h3>Retry</h3>
    <div class="grid four">
      <div class="field"><label for="retry-max">Максимум попыток</label><input id="retry-max" type="number" min="1" max="20" data-model="retry.maxAttempts"></div>
      <div class="field"><label for="retry-base">Базовая задержка, сек</label><input id="retry-base" type="number" min="1" max="3600" data-model="retry.baseDelaySeconds"></div>
      <div class="field"><label for="retry-maxdelay">Максимальная задержка, сек</label><input id="retry-maxdelay" type="number" min="1" max="86400" data-model="retry.maxDelaySeconds"></div>
      <div class="field"><label for="retry-timeout">Timeout processing, сек</label><input id="retry-timeout" type="number" min="30" max="86400" data-model="retry.processingTimeoutSeconds"></div>
    </div>
    <div class="notice notice-info" style="margin-top:16px"><strong>Как это работает</strong>Повторный запрос с тем же external_id/Idempotency-Key не создаёт дубль. Временные ошибки CRM/Telegram/Sheets повторяются по расписанию; подтверждённые стадии не выполняются заново.</div>
  `;
}

function operationRow(operation) {
  const id = escapeHtml(operation.id || '');
  const status = escapeHtml(operation.status || 'unknown');
  const updated = escapeHtml(operation.updatedAt || '—');
  const source = escapeHtml(operation.source || '—');
  const retryable = ['failed', 'retry_scheduled', 'needs_reconciliation', 'pending'].includes(operation.status);
  return `<tr>
    <td><code>${id}</code></td>
    <td><span class="badge">${status}</span></td>
    <td>${source}</td>
    <td>${updated}</td>
    <td>${escapeHtml(operation.lastError || '—')}</td>
    <td>${retryable ? `<button type="button" class="btn btn-small btn-secondary" data-action="retry-operation" data-id="${id}">Повторить</button>` : '—'}</td>
  </tr>`;
}

function renderManage() {
  const data = state.management;
  const services = data.services || {};
  const summary = data.summary || {};
  const status = (ok) => (ok ? 'configured' : 'error');
  return `
    <h2>Управление</h2>
    <p class="lead">Проверка сервисов, состояние state machine, ручной retry и backup конфигурации. Все действия выполняются через авторизованный /setup/.</p>
    ${renderError()}
    ${data.error ? `<div class="notice notice-warn">${escapeHtml(data.error)}</div>` : ''}
    <div class="status-grid">
      ${statusCard('Caddy', status(services.caddy), services.caddy ? 'HTTPS ingress работает' : 'Не удалось проверить')}
      ${statusCard('n8n', status(services.n8n), services.n8n ? 'Контейнер запущен' : 'Не удалось проверить')}
      ${statusCard('PostgreSQL', status(services.postgres), services.postgres ? 'Контейнер запущен' : 'Не удалось проверить')}
      ${statusCard('Wizard', status(services.wizard), services.wizard ? 'Контейнер запущен' : 'Не удалось проверить')}
    </div>
    <div class="divider"></div>
    <div class="grid three">
      <div class="status-card"><h4>Всего операций</h4><p>${escapeHtml(String(summary.total ?? '—'))}</p></div>
      <div class="status-card"><h4>Нужна сверка</h4><p>${escapeHtml(String(summary.needsReconciliation ?? '—'))}</p></div>
      <div class="status-card"><h4>Ждут recovery</h4><p>${escapeHtml(String(summary.dueForRecovery ?? '—'))}</p></div>
    </div>
    <div class="row" style="margin-top:18px">
      <h3 style="margin:0">Последние операции</h3>
      <button type="button" class="btn btn-secondary btn-small" data-action="refresh-manage">Обновить</button>
    </div>
    <div class="table-wrap" style="margin-top:10px">
      <table class="data-table">
        <thead><tr><th>ID</th><th>Статус</th><th>Источник</th><th>Обновлено</th><th>Ошибка</th><th></th></tr></thead>
        <tbody>${(data.operations || []).map(operationRow).join('') || '<tr><td colspan="6">Операций пока нет.</td></tr>'}</tbody>
      </table>
    </div>
    <div class="divider"></div>
    <h3>Backup конфигурации</h3>
    <div class="inline">
      <select id="backup-select" class="select grow"><option value="">Выберите backup</option>${(data.backups || []).map((backup) => `<option value="${escapeHtml(backup.name)}">${escapeHtml(backup.name)}</option>`).join('')}</select>
      <button type="button" class="btn btn-secondary" data-action="create-backup">Создать backup</button>
      <button type="button" class="btn btn-danger" data-action="restore-backup">Восстановить</button>
      <button type="button" class="btn btn-secondary" data-action="doctor">Проверить doctor</button>
    </div>
    ${data.loading ? '<p class="hint">Загружаю состояние…</p>' : ''}
    ${state.doctor ? renderDoctor(state.doctor) : ''}
  `;
}

async function refreshManagement() {
  state.management.loading = true;
  state.management.error = null;
  render();
  const safe = async (promise) => {
    try { return await promise; } catch (error) { return { __error: errorMessage(error) }; }
  };
  const [services, summary, operations, backups] = await Promise.all([
    safe(api('api/services')),
    safe(api('api/operations/summary')),
    safe(api('api/operations?limit=50')),
    safe(api('api/config/backups')),
  ]);
  if (services.__error || summary.__error || operations.__error || backups.__error) {
    state.management.error = services.__error || summary.__error || operations.__error || backups.__error;
  }
  state.management.services = services.__error ? null : services;
  state.management.summary = summary.__error ? null : summary;
  state.management.operations = operations.__error ? [] : operations.operations || [];
  state.management.backups = backups.__error ? [] : backups.backups || [];
  state.management.loading = false;
  state.management.loaded = true;
  render();
}

function renderReview() {
  const doctor = state.doctor;
  const manual = !state.boot?.n8n?.apiKeyConfigured;
  return `
    <h2>Проверка и запуск</h2>
    <p class="lead">Сначала сохраняем конфиг, затем создаём credentials и назначаем их workflow. Реальный тест заявки запускается только по отдельному подтверждению.</p>
    ${renderError()}
    ${manual ? `<div class="notice notice-warn"><strong>Ручной режим</strong>API key n8n не задан. Сохраните конфиг, затем назначьте credentials в n8n по инструкции ниже.</div>` : ''}
    <div class="summary">
      ${summaryRow('Компания', state.company)}
      ${summaryRow('Часовой пояс', state.timezone)}
      ${summaryRow('CRM', state.crmProvider === 'hubspot' ? 'HubSpot' : state.crmProvider === 'google_sheets' ? 'Google Sheets' : 'Без CRM')}
      ${summaryRow('Журнал', state.journalEnabled ? `Google Sheets / ${state.google.journalSheet}` : 'выключен')}
      ${summaryRow('Telegram', state.notificationsEnabled ? state.telegram.chatId || 'нужен Chat ID' : 'выключен')}
      ${summaryRow('Журнал ошибок', state.errorsEnabled ? state.google.errorsSheet : 'выключен')}
      ${summaryRow('Публичный адрес', state.boot?.setup?.publicUrl || '')}
      ${summaryRow('Идемпотентность', state.idempotency.enabled ? `${state.idempotency.retentionDays} дней` : 'выключена')}
      ${summaryRow('Retry', `${state.retry.maxAttempts} попыток, ${state.retry.baseDelaySeconds}–${state.retry.maxDelaySeconds} сек`)}
    </div>
    <div class="divider"></div>
    <div class="status-grid">
      ${statusCard('n8n', state.boot?.n8n?.reachable ? 'configured' : 'error', state.boot?.n8n?.reachable ? 'API доступен' : 'Проверьте Docker')}
      ${statusCard('Header Auth', state.refs.headerAuth ? 'configured' : (manual ? 'requires_auth' : 'not_configured'), state.refs.headerAuth?.name || 'X-Webhook-Secret')}
      ${statusCard('PostgreSQL', state.refs.postgres ? 'configured' : (manual ? 'requires_auth' : 'not_configured'), state.refs.postgres?.name || 'CRM Automation Kit DB')}
      ${statusCard('Google Sheets', state.refs.google ? 'configured' : (needsGoogle() ? 'not_configured' : 'unknown'), state.refs.google?.name || '')}
      ${statusCard('HubSpot', state.refs.hubspot ? 'configured' : (state.crmProvider === 'hubspot' ? 'not_configured' : 'unknown'), state.refs.hubspot?.name || '')}
      ${statusCard('Telegram', state.refs.telegram ? 'configured' : (state.notificationsEnabled ? 'not_configured' : 'unknown'), state.refs.telegram?.name || '')}
    </div>
    <div class="inline" style="margin-top:18px">
      <button type="button" class="btn btn-secondary" data-action="doctor">Проверить doctor</button>
      <button type="button" class="btn btn-secondary" data-action="test-lead">Отправить тестовую заявку</button>
    </div>
    ${manual ? renderManualCredentials() : ''}
    ${doctor ? renderDoctor(doctor) : ''}
    ${state.workflow ? `<div class="notice notice-success" style="margin-top:14px">Workflow обновлён: ${escapeHtml(state.workflow.id || '')}, активен: ${state.workflow.active ? 'да' : 'нет'}.</div>` : ''}
  `;
}

function renderManualCredentials() {
  return `<div class="notice notice-info" style="margin-top:16px">
    <strong>Назначьте в n8n вручную</strong>
    <div class="summary">
      ${summaryRow('Header Auth', 'Lead Webhook, Recovery Request')}
      ${summaryRow('PostgreSQL', 'Reserve Operation, все Save * State, Select Due Operations')}
      ${summaryRow('Google Sheets', '5 нод Google Sheets')}
      ${summaryRow('HubSpot Service Key', 'HubSpot Search/Create/Update Contact')}
      ${summaryRow('Telegram API', 'Notification Adapter - Telegram')}
    </div>
    <a class="btn btn-secondary btn-small" href="${escapeHtml(n8nPublicUrl())}/home/credentials" target="_blank" rel="noopener">Открыть Credentials в n8n</a>
  </div>`;
}

function renderDoctor(result) {
  return `<div class="notice notice-${result.result === 'PASS' ? 'success' : 'warn'}" style="margin-top:16px">
    <strong>doctor: ${escapeHtml(result.result)}</strong>
    <div class="summary">${(result.checks || []).map((check) => `<div class="summary-row"><span>${escapeHtml(check.level)}</span><span>${escapeHtml(check.message)}</span></div>`).join('')}</div>
  </div>`;
}

function renderActions() {
  const list = steps();
  const index = list.findIndex((step) => step.id === state.stepId);
  const actions = $('#actions');
  actions.replaceChildren();
  if (index > 0) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn btn-ghost';
    back.dataset.action = 'back';
    back.textContent = 'Назад';
    actions.append(back);
  }
  const right = document.createElement('div');
  right.className = 'actions-right';
  if (state.stepId === 'review') {
    const saveOnly = document.createElement('button');
    saveOnly.type = 'button';
    saveOnly.className = 'btn btn-secondary';
    saveOnly.dataset.action = 'save-only';
    saveOnly.textContent = 'Только сохранить';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'btn btn-primary';
    apply.dataset.action = 'save-apply';
    apply.textContent = state.busy ? 'Применяю…' : 'Сохранить и применить';
    right.append(saveOnly, apply);
  } else if (state.stepId !== 'manage') {
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn btn-primary';
    next.dataset.action = 'next';
    next.textContent = state.stepId === 'overview' ? (state.boot?.hasConfig ? 'Изменить настройки' : 'Начать настройку') : 'Далее';
    right.append(next);
  }
  for (const button of $$('button', right)) button.disabled = state.busy;
  actions.append(right);
}

function hydrateModels() {
  for (const element of $$('[data-model]')) {
    const value = getPath(state, element.dataset.model);
    if (element.type === 'checkbox') {
      element.checked = Boolean(value);
    } else if (element.type !== 'file') {
      element.value = value == null ? '' : String(value);
    }
  }
}

function hydrateStep(step) {
  hydrateModels();
  if (step === 'client') {
    $('#company').value = state.company;
    const search = $('#tz-search');
    search.value = state.timezone;
    search.addEventListener('input', () => {
      if (timezoneValid(search.value)) state.timezone = search.value;
      renderTimezoneResults(search.value);
    });
    search.addEventListener('change', () => {
      if (timezoneValid(search.value)) {
        state.timezone = search.value;
        $('#tz-now').textContent = `Текущее время: ${timezoneNow(state.timezone)}`;
      }
    });
    search.addEventListener('focus', () => renderTimezoneResults(search.value));
    search.addEventListener('blur', () => setTimeout(() => $('#tz-results')?.classList.add('hidden'), 160));
    $('#tz-now').textContent = `Текущее время: ${timezoneNow(state.timezone)}`;
    $('#tz-results').replaceChildren();
    $('#tz-results').classList.add('hidden');
  }
  if (step === 'integrations') {
    renderSourceChips();
  }
  if (step === 'manage' && !state.management.loading && !state.management.loaded) {
    refreshManagement();
  }
  if (step === 'google') {
    const file = $('#google-sa-file');
    file?.addEventListener('change', async () => {
      const selected = file.files?.[0];
      if (!selected) return;
      if (selected.size > 200_000) { toast('JSON-ключ слишком большой.', 'error'); return; }
      state.google.serviceAccountText = await selected.text();
      render();
    });
  }
}

function renderTimezoneResults(query) {
  const box = $('#tz-results');
  if (!box) return;
  const needle = String(query || '').trim().toLowerCase();
  const list = TIMEZONES
    .filter((zone) => !needle || zone.toLowerCase().includes(needle))
    .slice(0, 60);
  box.replaceChildren();
  if (!list.length) {
    box.classList.add('hidden');
    return;
  }
  for (const zone of list) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tz-option';
    button.textContent = zone;
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      state.timezone = zone;
      $('#tz-search').value = zone;
      $('#tz-now').textContent = `Текущее время: ${timezoneNow(zone)}`;
      box.classList.add('hidden');
    });
    box.append(button);
  }
  box.classList.remove('hidden');
}

function renderSourceChips() {
  const box = $('#source-chips');
  if (!box) return;
  box.replaceChildren();
  state.allowedSources.forEach((source, index) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.append(document.createTextNode(source));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.removeSource = String(index);
    remove.setAttribute('aria-label', `Удалить ${source}`);
    remove.textContent = '×';
    chip.append(remove);
    box.append(chip);
  });
}

function buildConfig() {
  const base = structuredClone(state.baseConfig || state.boot?.template || {});
  base.version = 2;
  base.clientName = state.company.trim();
  base.timezone = state.timezone.trim();
  base.source = { ...(base.source || {}), type: 'webhook', defaultSource: state.defaultSource.trim() || 'unknown', allowedSources: [...state.allowedSources] };
  base.crm = { ...(base.crm || {}), provider: state.crmProvider };
  if (state.crmProvider === 'google_sheets') {
    const id = spreadsheetId(state.google.mainUrl);
    if (!id) throw new Error('Вставьте полный URL Google-таблицы для CRM.');
    base.crm.googleSheets = { ...(base.crm.googleSheets || {}), spreadsheetId: id, leadsSheetName: state.google.leadsSheet.trim() };
  }
  if (state.crmProvider === 'hubspot') {
    base.crm.hubspot = { ...(base.crm.hubspot || {}), baseUrl: base.crm.hubspot?.baseUrl || 'https://api.hubapi.com', phoneOnlyPolicy: 'skip' };
  }
  base.journal = { ...(base.journal || {}), enabled: state.journalEnabled, provider: 'google_sheets' };
  if (state.journalEnabled) {
    const main = spreadsheetId(state.google.mainUrl);
    const journal = spreadsheetId(state.google.journalUrl) || main;
    if (!journal) throw new Error('Вставьте URL Google-таблицы для Journal.');
    base.journal.googleSheets = { ...(base.journal.googleSheets || {}), spreadsheetId: journal, sheetName: state.google.journalSheet.trim() };
  }
  base.errors = { ...(base.errors || {}), enabled: state.errorsEnabled, provider: 'google_sheets' };
  if (state.errorsEnabled) {
    const main = spreadsheetId(state.google.mainUrl);
    const errors = spreadsheetId(state.google.errorsUrl) || main;
    if (!errors) throw new Error('Вставьте URL Google-таблицы для Errors.');
    base.errors.googleSheets = { ...(base.errors.googleSheets || {}), spreadsheetId: errors, sheetName: state.google.errorsSheet.trim() };
  }
  base.notifications = { ...(base.notifications || {}), enabled: state.notificationsEnabled, channels: state.notificationsEnabled ? ['telegram'] : [] };
  base.notifications.telegram = { ...(base.notifications.telegram || {}), chatId: state.telegram.chatId.trim() };
  base.mapping = { ...(base.mapping || {}), ...state.mapping };
  base.idempotency = {
    ...(base.idempotency || {}),
    ...state.idempotency,
    enabled: Boolean(state.idempotency.enabled),
    retentionDays: Number(state.idempotency.retentionDays),
    withoutKeyPolicy: 'process_new',
  };
  base.retry = {
    ...(base.retry || {}),
    ...state.retry,
    maxAttempts: Number(state.retry.maxAttempts),
    baseDelaySeconds: Number(state.retry.baseDelaySeconds),
    maxDelaySeconds: Number(state.retry.maxDelaySeconds),
    processingTimeoutSeconds: Number(state.retry.processingTimeoutSeconds),
  };
  return base;
}

function validateStep(step) {
  if (step === 'overview' && state.boot?.auth?.serverMode && !state.boot?.n8n?.apiKeyConfigured) {
    return 'Подключите n8n API key, чтобы продолжить настройку.';
  }
  if (step === 'client') {
    if (!state.company.trim()) return 'Укажите название компании.';
    if (!timezoneValid(state.timezone)) return 'Выберите корректный часовой пояс IANA.';
  }
  if (step === 'integrations') {
    if (state.crmProvider === 'none' && !state.journalEnabled) return 'Без CRM нужно включить журнал: иначе заявки некуда сохранять.';
    if (state.crmProvider === 'google_sheets' && state.journalEnabled) {
      const main = spreadsheetId(state.google.mainUrl);
      const journal = spreadsheetId(state.google.journalUrl) || main;
      if (main && journal === main && state.google.leadsSheet.trim() === state.google.journalSheet.trim()) {
        return 'Journal должен указывать на другую вкладку, нежели CRM.';
      }
    }
    if (!state.defaultSource.trim()) return 'Укажите источник заявки по умолчанию.';
  }
  if (step === 'hubspot' && state.boot?.n8n?.apiKeyConfigured) {
    if (!state.refs.hubspot && !state.hubspot.appToken.trim() && !(state.hubspot.clientId.trim() && state.hubspot.clientSecret.trim())) {
      return 'Укажите Service Key или данные OAuth2.';
    }
  }
  if (step === 'google') {
    if (!spreadsheetId(state.google.mainUrl)) return 'Вставьте корректный URL Google-таблицы.';
    if (!state.google.leadsSheet.trim()) return 'Укажите название вкладки Leads.';
    if (state.journalEnabled && !state.google.journalSheet.trim()) return 'Укажите название вкладки Journal.';
    if (state.errorsEnabled && !state.google.errorsSheet.trim()) return 'Укажите название вкладки Errors.';
    if (state.boot?.n8n?.apiKeyConfigured) {
      if (!state.refs.google && state.google.mode === 'service_account' && !state.google.serviceAccountText.trim()) {
        return 'Вставьте JSON сервисного аккаунта.';
      }
      if (!state.refs.google && state.google.mode === 'oauth2' && !(state.google.clientId.trim() && state.google.clientSecret.trim())) {
        return 'Укажите Client ID и Client Secret или используйте существующий credential.';
      }
    }
  }
  if (step === 'telegram') {
    if (!state.telegram.chatId.trim()) return 'Укажите Chat ID.';
    if (state.boot?.n8n?.apiKeyConfigured && !state.refs.telegram && !state.telegram.token.trim()) {
      return 'Укажите bot token.';
    }
  }
  if (step === 'advanced') {
    for (const [key, value] of Object.entries(state.mapping)) {
      if (!String(value || '').trim()) return `Заполните маппинг поля «${key}».`;
    }
    const retention = Number(state.idempotency.retentionDays);
    if (!Number.isInteger(retention) || retention < 1 || retention > 3650) return 'Retention должен быть целым числом от 1 до 3650 дней.';
    const maxAttempts = Number(state.retry.maxAttempts);
    const baseDelay = Number(state.retry.baseDelaySeconds);
    const maxDelay = Number(state.retry.maxDelaySeconds);
    const timeout = Number(state.retry.processingTimeoutSeconds);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) return 'Максимум попыток: 1–20.';
    if (!Number.isInteger(baseDelay) || baseDelay < 1 || baseDelay > 3600) return 'Базовая задержка: 1–3600 секунд.';
    if (!Number.isInteger(maxDelay) || maxDelay < baseDelay || maxDelay > 86400) return 'Максимальная задержка должна быть не меньше базовой и не больше 86400 секунд.';
    if (!Number.isInteger(timeout) || timeout < 30 || timeout > 86400) return 'Timeout processing: 30–86400 секунд.';
  }
  return null;
}

function goNext() {
  const error = validateStep(state.stepId);
  if (error) { state.error = error; render(); return; }
  state.error = null;
  const list = steps();
  const index = list.findIndex((step) => step.id === state.stepId);
  if (index < list.length - 1) state.stepId = list[index + 1].id;
  render();
}

function goBack() {
  state.error = null;
  const list = steps();
  const index = list.findIndex((step) => step.id === state.stepId);
  if (index > 0) state.stepId = list[index - 1].id;
  render();
}

function refsForApi() {
  return {
    headerAuth: state.refs.headerAuth ? { id: state.refs.headerAuth.id } : undefined,
    postgres: state.refs.postgres ? { id: state.refs.postgres.id } : undefined,
    google: state.refs.google ? { id: state.refs.google.id, mode: state.refs.google.mode } : undefined,
    hubspot: state.refs.hubspot ? { id: state.refs.hubspot.id } : undefined,
    telegram: state.refs.telegram ? { id: state.refs.telegram.id } : undefined,
  };
}

async function createCredentials() {
  if (!state.boot?.n8n?.apiKeyConfigured) return false;
  const ensure = async (kind, values = {}, existing = null, replace = false) => {
    const result = await api('api/credentials', {
      method: 'POST',
      body: { kind, values, ...(existing && !replace ? { existingId: existing.id } : {}), replaceExisting: replace },
    });
    return result.credential;
  };
  state.refs.headerAuth = await ensure('header_auth', {}, state.refs.headerAuth);
  state.refs.postgres = await ensure('postgres', {}, state.refs.postgres);

  if (state.crmProvider === 'hubspot') {
    const hasNew = state.hubspot.mode === 'service_key'
      ? Boolean(state.hubspot.appToken.trim())
      : Boolean(state.hubspot.clientId.trim() && state.hubspot.clientSecret.trim());
    if (hasNew) {
      state.refs.hubspot = await ensure('hubspot', {
        mode: state.hubspot.mode,
        appToken: state.hubspot.appToken,
        clientId: state.hubspot.clientId,
        clientSecret: state.hubspot.clientSecret,
      }, state.refs.hubspot, Boolean(state.refs.hubspot));
      state.refs.hubspot.mode = state.hubspot.mode;
    }
  }
  if (needsGoogle()) {
    const hasNew = state.google.mode === 'service_account'
      ? Boolean(state.google.serviceAccountText.trim())
      : Boolean(state.google.clientId.trim() && state.google.clientSecret.trim());
    if (hasNew) {
      state.refs.google = await ensure(
        state.google.mode === 'service_account' ? 'google_service_account' : 'google_oauth2',
        state.google.mode === 'service_account'
          ? { serviceAccount: state.google.serviceAccountText }
          : { clientId: state.google.clientId, clientSecret: state.google.clientSecret },
        state.refs.google,
        Boolean(state.refs.google),
      );
      state.refs.google.mode = state.google.mode;
    }
  }
  if (state.notificationsEnabled && state.telegram.token.trim()) {
    state.refs.telegram = await ensure('telegram', { botToken: state.telegram.token }, state.refs.telegram, Boolean(state.refs.telegram));
  }
  return true;
}

async function saveConfigOnly() {
  state.error = null;
  state.busy = true;
  render();
  try {
    const config = buildConfig();
    const validated = await api('api/config/validate', { method: 'POST', body: { config } });
    const saved = await api('api/config', { method: 'POST', body: { config: validated.config } });
    state.baseConfig = saved.config;
    state.boot.config = saved.config;
    state.boot.hasConfig = true;
    toast(saved.backupCreated ? 'Конфигурация сохранена, предыдущая версия в backup.' : 'Конфигурация сохранена.');
  } catch (error) {
    state.error = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function saveAndApply() {
  state.error = null;
  state.busy = true;
  render();
  try {
    const config = buildConfig();
    const validated = await api('api/config/validate', { method: 'POST', body: { config } });
    const saved = await api('api/config', { method: 'POST', body: { config: validated.config } });
    state.baseConfig = saved.config;
    state.boot.config = saved.config;
    state.boot.hasConfig = true;

    if (state.boot.n8n.apiKeyConfigured) {
      await createCredentials();
      const applied = await api('api/workflow/apply', { method: 'POST', body: { credentials: refsForApi() } });
      state.workflow = applied.workflow;
      toast('Конфигурация и credentials применены к workflow.');
      const doctor = await api('api/doctor', { method: 'POST', body: { integrationTest: false }, allowNotOk: true });
      state.doctor = doctor;
      state.boot = await api('api/bootstrap');
      toast(doctor.result === 'PASS' ? 'doctor: PASS' : 'doctor не подтвердил настройку. Смотрите отчёт.', doctor.result === 'PASS' ? '' : 'error');
    } else {
      state.manual = true;
      toast('Конфигурация сохранена. Credentials нужно назначить в n8n вручную.');
    }
  } catch (error) {
    state.error = errorMessage(error);
    toast(errorMessage(error), 'error');
  } finally {
    state.busy = false;
    render();
  }
}

async function runDoctor(integrationTest = false) {
  state.error = null;
  state.busy = true;
  render();
  try {
    const result = await api('api/doctor', {
      method: 'POST',
      body: { integrationTest, confirm: integrationTest ? true : undefined },
      allowNotOk: true,
    });
    state.doctor = result;
    toast(result.result === 'PASS' ? 'doctor: PASS' : `doctor: ${result.result}`, result.result === 'PASS' ? '' : 'error');
  } catch (error) {
    state.error = errorMessage(error);
    toast(errorMessage(error), 'error');
  } finally {
    state.busy = false;
    render();
  }
}

async function testIntegration(kind) {
  state.error = null;
  try {
    let values;
    if (kind === 'hubspot') {
      values = state.hubspot.mode === 'service_key'
        ? { token: state.hubspot.appToken }
        : { clientId: state.hubspot.clientId, clientSecret: state.hubspot.clientSecret };
      if (state.hubspot.mode === 'oauth2') {
        toast('OAuth2 проверяется через сохранённый credential после Connect.');
        return;
      }
      state.hubspot.test = await api('api/integrations/test', { method: 'POST', body: { kind, values } });
    }
    if (kind === 'telegram') {
      values = { token: state.telegram.token, chatId: state.telegram.chatId };
      state.telegram.test = await api('api/integrations/test', { method: 'POST', body: { kind, values } });
    }
    if (kind === 'google') {
      if (state.google.mode === 'oauth2') {
        if (state.refs.google) {
          await testExisting('google');
          return;
        }
        toast('OAuth2 проверяется после Connect в n8n.');
        return;
      }
      values = {
        serviceAccount: state.google.serviceAccountText,
        spreadsheetId: spreadsheetId(state.google.mainUrl),
        sheetNames: [
          ...(state.crmProvider === 'google_sheets' ? [state.google.leadsSheet] : []),
          ...(state.journalEnabled ? [state.google.journalSheet] : []),
          ...(state.errorsEnabled ? [state.google.errorsSheet] : []),
        ].filter(Boolean),
      };
      state.google.test = await api('api/integrations/test', { method: 'POST', body: { kind: 'google_service_account', values } });
    }
    toast(state.hubspot.test?.message || state.telegram.test?.message || state.google.test?.message || 'Проверка завершена.');
  } catch (error) {
    const message = errorMessage(error);
    if (kind === 'hubspot') state.hubspot.test = { ok: false, message };
    if (kind === 'telegram') state.telegram.test = { ok: false, message };
    if (kind === 'google') state.google.test = { ok: false, message };
    toast(message, 'error');
  }
  render();
}

async function testExisting(kind) {
  const ref = state.refs[kind === 'hubspot' ? 'hubspot' : kind];
  if (!ref?.id) return;
  state.busy = true;
  render();
  try {
    const result = await api(`api/credentials/${encodeURIComponent(ref.id)}/test`, { method: 'POST', body: {}, allowNotOk: true });
    if (kind === 'hubspot') state.hubspot.test = result;
    if (kind === 'telegram') state.telegram.test = result;
    if (kind === 'google') state.google.test = result;
    toast(result.message);
  } catch (error) {
    toast(errorMessage(error), 'error');
  } finally {
    state.busy = false;
    render();
  }
}

function googleProvisionPayload() {
  const base = state.baseConfig || state.boot?.template || {};
  const columns = (obj) => Object.values(obj || {}).filter(Boolean);
  const sheets = [];
  if (state.crmProvider === 'google_sheets') {
    sheets.push({ name: state.google.leadsSheet.trim(), headers: columns(base.crm?.googleSheets?.columns) });
  }
  if (state.journalEnabled) {
    sheets.push({ name: state.google.journalSheet.trim(), headers: columns(base.journal?.googleSheets?.columns) });
  }
  if (state.errorsEnabled) {
    sheets.push({ name: state.google.errorsSheet.trim(), headers: columns(base.errors?.googleSheets?.columns) });
  }
  return {
    serviceAccount: state.google.serviceAccountText,
    spreadsheetId: spreadsheetId(state.google.mainUrl) || undefined,
    title: `${state.company.trim() || 'CRM'} — CRM Automation Kit`,
    sheets,
  };
}

async function provisionGoogle() {
  if (!state.google.serviceAccountText.trim()) {
    toast('Вставьте JSON сервисного аккаунта.', 'error');
    return;
  }
  const payload = googleProvisionPayload();
  if (!payload.sheets.length) {
    toast('Нет включённых таблиц для создания.', 'error');
    return;
  }
  const confirmed = await confirmAction(
    'Создать/обновить Google-таблицу?',
    'Мастер добавит отсутствующие вкладки и перезапишет первую строку заголовков. Существующие данные строк не изменяются.',
  );
  if (!confirmed) return;
  state.busy = true;
  render();
  try {
    const result = await api('api/google/provision', { method: 'POST', body: payload });
    state.googleProvision = result;
    state.google.mainUrl = result.spreadsheetUrl;
    state.google.test = {
      ok: true,
      status: 'connected',
      message: result.created ? 'Таблица создана; проверьте доступ и заголовки.' : 'Вкладки и заголовки обновлены.',
    };
    toast(result.created ? 'Таблица создана.' : 'Таблица обновлена.');
  } catch (error) {
    state.google.test = { ok: false, message: errorMessage(error) };
    toast(errorMessage(error), 'error');
  } finally {
    state.busy = false;
    render();
  }
}

async function confirmAction(title, text) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  return new Promise((resolve) => {
    const handler = () => {
      dialog.removeEventListener('close', handler);
      resolve(dialog.returnValue === 'confirm');
    };
    dialog.addEventListener('close', handler);
    dialog.returnValue = 'cancel';
    dialog.showModal();
  });
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button, a');
  if (!target) return;
  if (target.dataset.step) {
    state.error = null;
    state.stepId = target.dataset.step;
    render();
    return;
  }
  if (target.dataset.crm) {
    state.crmProvider = target.dataset.crm;
    if (state.crmProvider === 'none') state.journalEnabled = true;
    state.error = null;
    render();
    return;
  }
  if (target.dataset.removeSource !== undefined) {
    state.allowedSources.splice(Number(target.dataset.removeSource), 1);
    renderSourceChips();
    return;
  }
  if (target.dataset.copy) {
    try {
      await navigator.clipboard.writeText(target.dataset.copy);
      toast('Скопировано.');
    } catch {
      toast('Не удалось скопировать.', 'error');
    }
    return;
  }
  const action = target.dataset.action;
  if (!action) return;
  if (action === 'next') goNext();
  if (action === 'back') goBack();
  if (action === 'connect-n8n') {
    const input = $('#n8n-api-key');
    const apiKey = (input?.value || '').trim();
    if (!apiKey) {
      toast('Введите API key n8n.', 'error');
      input?.focus();
      return;
    }
    target.disabled = true;
    const label = target.textContent;
    target.textContent = 'Подключаю…';
    try {
      await api('api/n8n/connect', { method: 'POST', body: { apiKey } });
      if (input) input.value = '';
      const boot = await api('api/bootstrap');
      applyBootstrap(boot);
      state.error = null;
      toast('n8n API key подключён.');
      render();
    } catch (error) {
      target.disabled = false;
      target.textContent = label;
      toast(errorMessage(error), 'error');
    }
    return;
  }
  if (action === 'refresh-address') {
    try {
      state.boot = await api('api/bootstrap');
      toast('Статус адреса и n8n обновлён.');
      render();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
    return;
  }
  if (action === 'refresh-manage') {
    state.management.loaded = false;
    await refreshManagement();
    return;
  }
  if (action === 'retry-operation') {
    const id = target.dataset.id;
    const confirmed = await confirmAction(
      'Повторить операцию?',
      `Операция ${id} будет поставлена в очередь. Уже подтверждённые CRM/Journal стадии не будут выполнены заново.`,
    );
    if (!confirmed) return;
    try {
      await api(`api/operations/${encodeURIComponent(id)}/retry`, { method: 'POST', body: {} });
      toast('Операция поставлена на повтор.');
      state.management.loaded = false;
      await refreshManagement();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
    return;
  }
  if (action === 'create-backup') {
    try {
      const result = await api('api/config/backups', { method: 'POST', body: {} });
      toast(`Backup создан: ${result.backup?.name || ''}`);
      state.management.loaded = false;
      await refreshManagement();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
    return;
  }
  if (action === 'restore-backup') {
    const select = $('#backup-select');
    const name = select?.value || '';
    if (!name) {
      toast('Выберите backup.', 'error');
      return;
    }
    const confirmed = await confirmAction(
      'Восстановить конфигурацию?',
      `Текущий config/client.json будет заменён backup-файлом ${name}. Текущая версия сначала сохранится как новый backup.`,
    );
    if (!confirmed) return;
    try {
      await api('api/config/restore', { method: 'POST', body: { name, confirm: true } });
      const boot = await api('api/bootstrap');
      applyBootstrap(boot);
      state.management.loaded = false;
      toast('Конфигурация восстановлена.');
      render();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
    return;
  }
  if (action === 'provision-google') {
    await provisionGoogle();
    return;
  }
  if (action === 'logout') {
    try {
      await api('api/auth/logout', { method: 'POST' });
    } catch {
      // api() уже перенаправляет на страницу входа при 401.
    }
    location.replace('./');
    return;
  }
  if (action === 'save-only') await saveConfigOnly();
  if (action === 'save-apply') await saveAndApply();
  if (action === 'doctor') await runDoctor(false);
  if (action === 'test-hubspot') await testIntegration('hubspot');
  if (action === 'test-google') await testIntegration('google');
  if (action === 'test-telegram') await testIntegration('telegram');
  if (action === 'test-existing') await testExisting(target.dataset.kind);
  if (action === 'add-source') {
    const input = $('#source-input');
    const value = input?.value.trim();
    if (value && !state.allowedSources.includes(value)) {
      state.allowedSources.push(value);
      input.value = '';
      renderSourceChips();
    }
  }
  if (action === 'install-workflow') {
    const confirmed = await confirmAction(
      'Установить workflow?',
      'Будет выполнен import-workflow.sh. Если workflow уже существует, импорт будет отклонён. Продолжать?',
    );
    if (!confirmed) return;
    state.busy = true;
    render();
    try {
      const result = await api('api/workflow/install', { method: 'POST', body: { confirm: true } });
      const boot = await api('api/bootstrap');
      state.boot = boot;
      toast(result.message || 'Workflow установлен.');
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      state.busy = false;
      render();
    }
    return;
  }
  if (action === 'test-lead') {
    const confirmed = await confirmAction(
      'Отправить реальную тестовую заявку?',
      'Будет создана настоящая запись в CRM/Journal и, если включено, отправлено сообщение в Telegram. Продолжать?',
    );
    if (confirmed) await runDoctor(true);
  }
});

document.addEventListener('input', (event) => {
  const model = event.target.dataset.model;
  if (!model) return;
  setPath(state, model, event.target.value);
  if (model === 'google.serviceAccountText') {
    const email = (() => { try { return JSON.parse(event.target.value).client_email || ''; } catch { return ''; } })();
    const node = $('#google-sa-email');
    if (node) node.textContent = email || 'появится после вставки JSON';
  }
});

document.addEventListener('change', (event) => {
  const model = event.target.dataset.model;
  if (!model) return;
  const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
  setPath(state, model, value);
  if (event.target.dataset.rerender) render();
});

(async function init() {
  try {
    const data = await api('api/bootstrap');
    applyBootstrap(data);
    render();
  } catch (error) {
    const box = $('#boot-error');
    box.classList.remove('hidden');
    box.textContent = `Не удалось загрузить мастер: ${error.message}. Проверьте, что контейнер wizard запущен и доступен через Caddy.`;
  }
})();
