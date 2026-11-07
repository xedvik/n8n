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
  stepId: 'start',
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
  telegram: { token: '', chatId: '', test: null, chats: [] },
  mapping: { name: 'name', email: 'email', phone: 'phone', source: 'source', message: 'message', externalId: 'external_id' },
  idempotency: { enabled: true, retentionDays: 30, withoutKeyPolicy: 'process_new' },
  retry: { maxAttempts: 5, baseDelaySeconds: 30, maxDelaySeconds: 3600, processingTimeoutSeconds: 300 },
  refs: { headerAuth: null, postgres: null, google: null, hubspot: null, telegram: null },
  doctor: null,
  workflow: null,
  management: { services: null, summary: null, operations: [], backups: [], loading: false, loaded: false, error: null },
  googleProvision: null,
  integrationTab: 'hubspot',
  testLead: null,
  dirty: false,
  fieldErrors: {},
  applyStage: null,
  lastBackup: null,
  lastWorkflowBackup: null,
  previousRefs: null,
  previousConfigHash: null,
  applyStatus: null,
  configHash: null,
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function draftConfigHash() {
  try {
    const config = buildConfig();
    if (!globalThis.crypto?.subtle) return null;
    const bytes = new TextEncoder().encode(canonicalJson(config));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function markDirty() {
  state.dirty = true;
  state.testLead = null;
  state.doctor = null;
  state.applyStatus = null;
  state.hubspot.test = null;
  state.google.test = null;
  state.telegram.test = null;
  updateTopStatus();
}

function historicalTest(record) {
  if (!record?.ok) return null;
  const checkedAt = record.checkedAt ? new Date(record.checkedAt) : null;
  const label = checkedAt && !Number.isNaN(checkedAt.getTime())
    ? checkedAt.toLocaleString('ru-RU')
    : 'время неизвестно';
  return {
    ok: true,
    status: record.status || 'connected',
    historical: true,
    checkedAt: record.checkedAt || null,
    message: `Последняя проверка прошла: ${label}. Текущая доступность не проверена — запустите проверку снова.`,
  };
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

const MAIN_STAGES = [
  { id: 'start', title: 'Начало работы', hint: 'Подключение и адрес' },
  { id: 'company', title: 'Настройка компании', hint: 'Название и часовой пояс' },
  { id: 'integrations', title: 'Подключение интеграций', hint: 'CRM, таблица, уведомления' },
  { id: 'verify', title: 'Проверка и запуск', hint: 'Тесты и активация' },
  { id: 'done', title: 'Готово', hint: 'Система в работе' },
];

function steps() {
  return MAIN_STAGES;
}

function isExtraStep(step) {
  return step === 'advanced' || step === 'maintenance';
}

function isKnownStep(step) {
  return MAIN_STAGES.some((item) => item.id === step) || isExtraStep(step);
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

function applyBootstrap(data, { preserveLiveVerifications = false } = {}) {
  const liveTests = preserveLiveVerifications
    ? { hubspot: state.hubspot.test, google: state.google.test, telegram: state.telegram.test }
    : {};
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
  state.configHash = data.configHash || null;
  const verifications = data.verifications || {};
  const liveFor = (kind) => {
    const test = liveTests[kind];
    if (!test || test.historical || !test.configHash || test.configHash !== state.configHash) return null;
    return test;
  };
  state.hubspot.test = liveFor('hubspot') || historicalTest(verifications.hubspot);
  state.google.test = liveFor('google') || historicalTest(verifications.google);
  state.telegram.test = liveFor('telegram') || historicalTest(verifications.telegram);
  if (!isKnownStep(state.stepId)) state.stepId = 'start';
}

function topStatusText() {
  const data = state.boot || {};
  const baseStatus = data.n8n?.reachable
    ? data.n8n.apiKeyConfigured
      ? `n8n: ${data.n8n.workflowActive ? 'автоматизация активна' : 'автоматизация не активна'}`
      : 'n8n: требуется подключение'
    : 'n8n недоступен';
  return state.dirty ? `${baseStatus} · есть несохранённые изменения` : baseStatus;
}

function updateTopStatus() {
  const node = $('#top-status');
  if (node) node.textContent = topStatusText();
}

function render() {
  const list = steps();
  if (!isKnownStep(state.stepId)) state.stepId = 'start';
  const currentIndex = Math.max(0, list.findIndex((step) => step.id === state.stepId));
  const extra = isExtraStep(state.stepId);
  $('#progress-bar').style.width = `${extra ? 100 : ((currentIndex + 1) / list.length) * 100}%`;
  $('#progress-label').textContent = extra ? 'Сервисный раздел' : `Этап ${currentIndex + 1} из ${list.length}`;
  updateTopStatus();

  const logoutButton = $('#logout-btn');
  if (logoutButton) logoutButton.classList.toggle('hidden', !state.boot?.auth?.serverMode);

  const stepper = $('#stepper');
  stepper.replaceChildren();
  list.forEach((step, i) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    const stageState = stageStatus(step.id);
    button.type = 'button';
    button.className = `step-link ${step.id === state.stepId ? 'active' : ''} status-${stageState}`;
    button.dataset.step = step.id;
    const mark = stageState === 'verified' ? '✓' : stageState === 'error' ? '!' : stageState === 'configured' ? '•' : i + 1;
    button.innerHTML = `<span class="step-num">${mark}</span><span class="step-copy"><strong>${escapeHtml(step.title)}</strong><small>${escapeHtml(stageStateLabel(stageState))}</small></span>`;
    li.append(button);
    stepper.append(li);
  });
  const extraNav = $('#extra-nav');
  if (extraNav) {
    extraNav.classList.toggle('hidden', !state.boot?.hasConfig || !state.boot?.n8n?.apiKeyConfigured);
    for (const button of $$('[data-extra-step]', extraNav)) {
      button.classList.toggle('active', button.dataset.extraStep === state.stepId);
    }
  }

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

function renderApplyStatus() {
  const status = state.applyStatus;
  if (!status) return '';
  const type = status.state === 'applied' ? 'success' : status.state === 'partial' ? 'error' : 'warn';
  return `<div class="notice notice-${type}" role="status"><strong>${escapeHtml(status.title || '')}</strong>${escapeHtml(status.message || '')}</div>`;
}

function fieldError(name) {
  return state.fieldErrors?.[name] ? `<span class="field-error">${escapeHtml(state.fieldErrors[name])}</span>` : '';
}

function renderStepContent(step) {
  if (step === 'start') return renderStart();
  if (step === 'company') return renderClient();
  if (step === 'integrations') return renderIntegrationsStage();
  if (step === 'verify') return renderVerify();
  if (step === 'done') return renderDone();
  if (step === 'advanced') return renderAdvanced();
  if (step === 'maintenance') return renderManage();
  return renderStart();
}

function stageStateLabel(value) {
  return ({
    not_started: 'Не начато',
    action_required: 'Требует действий',
    configured: 'Настроено, не проверено',
    verified: 'Проверено',
    error: 'Ошибка',
  }[value] || 'Не начато');
}

function integrationStageState(kind) {
  if (kind === 'hubspot' && state.crmProvider !== 'hubspot') return 'skipped';
  if (kind === 'google' && !needsGoogle()) return 'skipped';
  if (kind === 'telegram' && !state.notificationsEnabled) return 'skipped';
  const test = kind === 'hubspot' ? state.hubspot.test : kind === 'google' ? state.google.test : state.telegram.test;
  const telegramChatVerified = kind !== 'telegram' || test?.details?.chatVerified === true;
  if (test?.ok === true && !test.historical && telegramChatVerified) return 'verified';
  if (test?.ok === false && !test.historical) return 'error';
  if (test?.historical || state.refs[kind]) return 'configured';
  return 'action_required';
}

function integrationStatusNote(kind, fallback) {
  const test = kind === 'hubspot' ? state.hubspot.test : kind === 'google' ? state.google.test : state.telegram.test;
  if (test?.historical) return 'Последняя проверка прошла; требуется повторная проверка.';
  if (test?.ok === true) return 'Проверено сейчас.';
  if (test?.ok === false) return 'Проверка не прошла.';
  if (state.refs[kind === 'hubspot' ? 'hubspot' : kind === 'google' ? 'google' : 'telegram']) {
    return 'Доступ сохранён; требуется повторная проверка.';
  }
  return fallback;
}

function allRequiredIntegrationsVerified() {
  const required = [];
  if (state.crmProvider === 'hubspot') required.push('hubspot');
  if (needsGoogle()) required.push('google');
  if (state.notificationsEnabled) required.push('telegram');
  return required.every((kind) => integrationStageState(kind) === 'verified' || integrationStageState(kind) === 'skipped');
}

function stageStatus(id) {
  const boot = state.boot || {};
  if (id === 'start') {
    if (!boot.n8n?.reachable) return 'error';
    if (!boot.n8n?.apiKeyConfigured) return 'action_required';
    return 'configured';
  }
  if (id === 'company') {
    if (!state.company.trim() || !timezoneValid(state.timezone)) return 'not_started';
    if (state.dirty) return 'action_required';
    return boot.hasConfig ? 'configured' : 'action_required';
  }
  if (id === 'integrations') {
    const required = [];
    if (state.crmProvider === 'hubspot') required.push('hubspot');
    if (needsGoogle()) required.push('google');
    if (state.notificationsEnabled) required.push('telegram');
    if (!required.length) return boot.hasConfig ? 'configured' : 'action_required';
    const statuses = required.map(integrationStageState);
    if (statuses.includes('error')) return 'error';
    if (statuses.includes('action_required')) return 'action_required';
    if (statuses.includes('configured')) return 'configured';
    return 'verified';
  }
  if (id === 'verify') {
    if (state.doctor?.result === 'FAIL') return 'error';
    if (state.testLead?.result === 'PASS' && state.doctor?.result === 'PASS' && allRequiredIntegrationsVerified()) return 'verified';
    if (state.doctor?.result === 'PASS') return 'configured';
    return 'action_required';
  }
  if (id === 'done') {
    if (state.testLead?.result === 'PASS' && state.doctor?.result === 'PASS' && allRequiredIntegrationsVerified()) return 'verified';
    return 'action_required';
  }
  return 'not_started';
}

function renderStart() {
  const data = state.boot;
  const n8nOk = data?.n8n?.reachable;
  const keyOk = data?.n8n?.apiKeyConfigured;
  return `
    <h2>${data?.hasConfig ? 'Настройка уже существует' : 'Добро пожаловать в CRM Automation Kit'}</h2>
    <p class="lead">${data?.hasConfig ? `Найден конфиг клиента «${escapeHtml(data.config?.clientName || 'без названия')}». Можно изменить настройки, не теряя текущие доступы и автоматизацию.` : 'Проведём настройку по шагам: компания, интеграции, доступы и проверка. Все данные остаются в вашем контуре.'}</p>
    ${renderError()}
    ${(data?.warnings || []).map((warning) => `<div class="notice notice-warn">${escapeHtml(warning)}</div>`).join('')}
    <div class="status-grid">
      ${statusCard('n8n', n8nOk ? (keyOk ? 'configured' : 'requires_auth') : 'error', n8nOk ? (keyOk ? `Автоматизация: ${data.n8n.workflowActive ? 'активна' : data.n8n.workflowExists === false ? 'не установлена' : 'не проверена'}` : 'Доступ к n8n не подключён') : 'Проверьте docker compose')}
      ${statusCard('Доступ к n8n', keyOk ? 'configured' : 'requires_auth', keyOk ? 'Автоматизация доступна' : (data?.auth?.serverMode ? 'Требуется подключение' : 'Можно настроить вручную'))}
      ${statusCard('CRM', data?.credentials?.hubspot?.status === 'configured' || data?.credentials?.google?.status === 'configured' ? 'configured' : 'not_configured', 'По текущему конфигу')}
      ${statusCard('Хранилище заявок', data?.credentials?.postgres?.status || 'unknown', 'База данных состояния')}
    </div>
    ${keyOk ? '' : data?.auth?.serverMode ? `<div class="secure-connect" role="group" aria-labelledby="connect-title">
      <h3 id="connect-title">Подключите n8n</h3>
      <ol class="setup-steps">
        <li>Откройте <a href="${escapeHtml(n8nPublicUrl())}/" target="_blank" rel="noopener">n8n</a> и создайте владельца, если открываете его впервые.</li>
        <li>Перейдите в <a href="${escapeHtml(n8nPublicUrl())}/settings/api" target="_blank" rel="noopener">Settings → API</a>.</li>
        <li>Создайте ключ с правами на чтение и изменение автоматизаций и доступов к сервисам.</li>
        <li>Скопируйте ключ и вставьте его ниже. Мастер проверит подключение.</li>
      </ol>
      <div class="connect-row">
        <div class="field grow">
          <label for="n8n-api-key">Ключ доступа n8n</label>
          <input id="n8n-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="n8n_api_…">
        </div>
        <button type="button" class="btn btn-primary" data-action="connect-n8n">Подключить n8n</button>
      </div>
      <span class="hint">Без подключения продолжить настройку нельзя.</span>
    </div>` : `<div class="notice notice-info" style="margin-top:16px"><strong>Автоматическое подключение доступов выключено</strong>Создайте API key в n8n: <a href="${escapeHtml(n8nPublicUrl())}/settings/api" target="_blank" rel="noopener">Settings → API</a>. Без ключа доступы нельзя создать автоматически.</div>`}
    ${data?.n8n?.apiKeyConfigured && data.n8n.workflowExists === false ? `<div class="notice notice-warn" style="margin-top:16px"><strong>Автоматизация ещё не установлена</strong>Установите её, затем назначьте доступы на этапе проверки.<br><button type="button" class="btn btn-secondary btn-small" data-action="install-workflow" style="margin-top:10px">Установить автоматизацию</button></div>` : ''}
    <div class="divider"></div>
    <h3>Адрес приёма заявок</h3>
    <div class="field">
      <div class="code"><code>${escapeHtml(data?.setup?.webhookUrl || `${data?.setup?.publicUrl || ''}/webhook/lead-intake`)}</code><button type="button" class="copy-btn" data-copy="${escapeHtml(data?.setup?.webhookUrl || `${data?.setup?.publicUrl || ''}/webhook/lead-intake`)}">Копировать</button></div>
      <span class="hint">Этот адрес понадобится для формы или интеграции источника. Для OAuth callback: ${escapeHtml(data?.setup?.oauthCallbackUrl || '')}</span>
    </div>
  `;
}

function renderClient() {
  return `
    <h2>Настройка компании</h2>
    <p class="lead">Название компании и часовой пояс нужны для писем, таблиц и уведомлений. Время заявок хранится в UTC, а отображается в выбранном поясе.</p>
    ${renderError()}
    <div class="grid two">
      <div class="field">
        <label for="company">Название компании</label>
        <input id="company" data-model="company" maxlength="120" placeholder="Например, ООО Ромашка" autocomplete="organization" aria-invalid="${Boolean(state.fieldErrors.company)}">
        ${fieldError('company')}
        <span class="hint">Как обращаться к клиенту в интерфейсе.</span>
      </div>
      <div class="field">
        <label for="tz-search">Часовой пояс</label>
        <div class="tz-search">
          <input id="tz-search" autocomplete="off" placeholder="Начните вводить: Tbilisi, Moscow…" aria-invalid="${Boolean(state.fieldErrors.timezone)}">
        ${fieldError('timezone')}
          <div id="tz-results" class="tz-results hidden"></div>
        </div>
        <span class="hint" id="tz-now">Текущее время: —</span>
      </div>
    </div>
  `;
}

function renderIntegrations() {
  const cards = [
    ['hubspot', 'HubSpot', 'Контакты в HubSpot'],
    ['google_sheets', 'Google Sheets', 'Таблица как CRM'],
    ['none', 'Без CRM', 'Только журнал'],
  ].map(([id, title, text]) => `
    <button type="button" class="choice ${state.crmProvider === id ? 'selected' : ''}" data-crm="${id}">
      ${state.crmProvider === id ? '<span class="badge badge-info">Выбрано</span>' : ''}
      <strong>${title}</strong><span>${text}</span>
    </button>`).join('');

  return `
    <h2>Что подключить</h2>
    <p class="lead">Выберите CRM и отметьте необязательные сервисы. Их можно пропустить — настройка продолжится без них.</p>
    ${renderError()}
    <div class="cards">${cards}</div>
    <div class="divider"></div>
    <div class="switch-row">
      <div class="switch-copy"><strong>История заявок в Google Sheets</strong><span>Независимая запись всех принятых заявок.</span></div>
      <label class="switch"><input type="checkbox" data-model="journalEnabled" data-rerender="1"><span></span></label>
    </div>
    <div class="switch-row">
      <div class="switch-copy"><strong>Уведомления Telegram</strong><span>Сообщение в чат после успешного сохранения.</span></div>
      <label class="switch"><input type="checkbox" data-model="notificationsEnabled" data-rerender="1"><span></span></label>
    </div>
    <div class="switch-row">
      <div class="switch-copy"><strong>Журнал ошибок в Google Sheets</strong><span>Отдельная вкладка для сбоев интеграций.</span></div>
      <label class="switch"><input type="checkbox" data-model="errorsEnabled" data-rerender="1"><span></span></label>
    </div>
    <h3>Источники заявок</h3>
    <div class="grid two">
      <div class="field">
        <label for="default-source">Откуда приходят заявки по умолчанию</label>
        <input id="default-source" data-model="defaultSource" placeholder="website">
        ${fieldError('defaultSource')}
      </div>
      <div class="field">
        <span class="field-label">Разрешённые источники</span>
        <div class="inline"><input class="grow" id="source-input" placeholder="Например, landing"><button type="button" class="btn btn-secondary btn-small" data-action="add-source">Добавить</button></div>
        <div class="chips" id="source-chips"></div>
        <span class="hint">Пустой список означает: принимать любой источник. Если источник не входит в список, заявка будет отклонена.</span>
      </div>
    </div>
  `;
}

function renderIntegrationsStage() {
  const available = [];
  if (state.crmProvider === 'hubspot') available.push({ id: 'hubspot', label: 'HubSpot' });
  if (needsGoogle()) available.push({ id: 'google', label: 'Google Sheets' });
  if (state.notificationsEnabled) available.push({ id: 'telegram', label: 'Telegram' });
  if (!available.some((item) => item.id === state.integrationTab)) {
    state.integrationTab = available[0]?.id || 'hubspot';
  }
  const tabs = available.map((item) => `
    <button type="button" class="integration-tab ${state.integrationTab === item.id ? 'active' : ''}" data-integration-tab="${item.id}" role="tab" aria-selected="${state.integrationTab === item.id}">
      ${item.label}${integrationStageState(item.id) === 'verified' ? ' <span class="tab-check">✓</span>' : ''}
    </button>`).join('');
  const forms = {
    hubspot: renderHubspot,
    google: renderGoogle,
    telegram: renderTelegram,
  };
  const active = available.find((item) => item.id === state.integrationTab);
  return `
    ${renderIntegrations()}
    <div class="divider"></div>
    <h3>Доступы к сервисам</h3>
    <p class="hint">Подключите выбранные сервисы. Для каждого шага есть ссылка на нужную страницу и проверка.</p>
    ${available.length ? `<div class="integration-tabs" role="tablist">${tabs}</div><div class="integration-panel">${active ? (forms[active.id] || (() => ''))() : ''}</div>` : '<div class="notice notice-info">Все интеграции отключены. Для приёма заявок включите CRM или журнал.</div>'}
  `;
}

function renderVerify() {
  return renderReview();
}

function renderDone() {
  const doctorOk = state.doctor?.result === 'PASS';
  const leadOk = state.testLead?.result === 'PASS';
  const crmOk = state.crmProvider === 'none' ? true : integrationStageState(state.crmProvider === 'hubspot' ? 'hubspot' : 'google') === 'verified';
  const sheetsOk = !needsGoogle() || integrationStageState('google') === 'verified';
  const telegramOk = !state.notificationsEnabled || integrationStageState('telegram') === 'verified';
  const ready = doctorOk && leadOk && crmOk && sheetsOk && telegramOk;
  const webhook = state.boot?.setup?.webhookUrl || `${state.boot?.setup?.publicUrl || ''}/webhook/lead-intake`;
  return `
    <div class="completion-hero ${ready ? 'success' : 'warn'}">
      <div class="completion-icon" aria-hidden="true">${ready ? '✓' : '!'}</div>
      <div>
        <p class="eyebrow">CRM Automation Kit</p>
        <h2>${ready ? 'Система готова' : 'Нужно завершить проверку'}</h2>
        <p class="lead">${ready ? 'Все обязательные проверки и тестовая заявка пройдены. Можно переходить к работе.' : 'Настройки сохранены, но успех не подтверждён реальным тестом.'}</p>
      </div>
    </div>
    ${renderError()}
    <div class="status-grid">
      ${statusCard('CRM', crmOk ? 'configured' : 'requires_auth', crmOk ? 'Проверено' : 'Требует проверки')}
      ${statusCard('Таблица', sheetsOk ? 'configured' : 'requires_auth', sheetsOk ? 'Проверено' : 'Требует проверки')}
      ${statusCard('Telegram', telegramOk ? 'configured' : 'requires_auth', telegramOk ? 'Проверено' : 'Требует проверки')}
      ${statusCard('Тестовая заявка', leadOk ? 'configured' : state.testLead?.result === 'FAIL' ? 'error' : 'requires_auth', leadOk ? 'Обработана' : state.testLead?.result === 'FAIL' ? 'Не прошла' : 'Ещё не отправлена')}
    </div>
    <div class="field" style="margin-top:18px">
      <span class="field-label">Адрес приёма заявок</span>
      <div class="code"><code>${escapeHtml(webhook)}</code><button type="button" class="copy-btn" data-copy="${escapeHtml(webhook)}">Копировать</button></div>
      <span class="hint">Передайте этот адрес в форму или интеграцию источника заявок.</span>
    </div>
    <div class="inline" style="margin-top:18px">
      <button type="button" class="btn btn-primary" data-extra-step="maintenance">Открыть управление</button>
      <button type="button" class="btn btn-secondary" data-step="company">Изменить настройки</button>
    </div>
  `;
}

function renderHubspot() {
  const mode = state.hubspot.mode;
  const status = state.hubspot.test || (state.refs.hubspot ? { status: 'configured', message: 'Доступ сохранён. Требуется повторная проверка.' } : null);
  return `
    <h3>HubSpot</h3>
    <p class="lead">Создайте private app с доступом к контактам. Ключ доступа остаётся на сервере мастера и сохраняется в защищённом хранилище.</p>
    ${renderError()}
    ${status ? `<div class="notice notice-${status.ok === false || status.historical || !status.ok ? 'warn' : 'success'}">${escapeHtml(status.message || statusLabel(status.status))}</div>` : ''}
    <div class="grid two">
      <div class="field">
        <label for="hubspot-mode">Способ подключения</label>
        <select id="hubspot-mode" data-model="hubspot.mode" data-rerender="1">
          <option value="service_key">Ключ private app (Service Key)</option>
          <option value="oauth2">OAuth2 (для публичных приложений)</option>
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
        <label for="hubspot-token">Ключ private app</label>
        <input id="hubspot-token" type="password" data-model="hubspot.appToken" autocomplete="off" placeholder="pat-…">
        ${fieldError('hubspotToken')}
      </div>` : `
      <div class="grid two" style="margin-top:16px">
        <div class="field"><label for="hubspot-client-id">Client ID</label><input id="hubspot-client-id" data-model="hubspot.clientId" autocomplete="off"></div>
        <div class="field"><label for="hubspot-client-secret">Client Secret</label><input id="hubspot-client-secret" type="password" data-model="hubspot.clientSecret" autocomplete="off"></div>
      </div>
      <div class="notice notice-warn" style="margin-top:12px">После создания доступа откройте n8n → Доступы → HubSpot OAuth2 и нажмите «Подключить». Мастер не сможет завершить OAuth за вас.</div>`}
    <div class="notice notice-info" style="margin-top:16px">
      <strong>Права private app</strong>
      <div class="chips"><span class="chip">crm.objects.contacts.read</span><span class="chip">crm.objects.contacts.write</span></div>
      <p class="small" style="margin:8px 0 0">Если используете дополнительные свойства контакта, добавьте <code>crm.schemas.contacts.read</code>.</p>
    </div>
    <div class="inline" style="margin-top:16px">
      <button type="button" class="btn btn-secondary" data-action="test-hubspot">Проверить подключение</button>
      ${state.refs.hubspot ? `<button type="button" class="btn btn-ghost btn-small" data-action="test-existing" data-kind="hubspot">Проверить сохранённый доступ</button>` : ''}
    </div>
  `;
}

function renderGoogle() {
  const mode = state.google.mode;
  const status = state.google.test || (state.refs.google ? { status: 'configured', message: 'Доступ сохранён. Требуется повторная проверка.' } : null);
  let email = '';
  if (state.google.serviceAccountText.trim()) {
    try { email = JSON.parse(state.google.serviceAccountText).client_email || ''; } catch { email = ''; }
  }
  return `
    <h3>Google Sheets</h3>
    <p class="lead">Вставьте полный URL таблицы — мастер извлечёт spreadsheet ID. Для полной автоматизации рекомендуется Service Account: он не требует OAuth-редиректа.</p>
    ${renderError()}
    ${status ? `<div class="notice notice-${status.ok === false || status.historical || !status.ok ? 'warn' : 'success'}">${escapeHtml(status.message)}</div>` : ''}
    <div class="field">
      <label for="google-url">Ссылка на основную таблицу</label>
      <input id="google-url" data-model="google.mainUrl" placeholder="https://docs.google.com/spreadsheets/d/…/edit">
      ${fieldError('googleUrl')}
      <span class="hint">Для CRM, Journal и Errors по умолчанию используется эта таблица.</span>
    </div>
    <div class="grid three" style="margin-top:16px">
      <div class="field"><label for="leads-sheet">Вкладка заявок</label><input id="leads-sheet" data-model="google.leadsSheet"></div>
      <div class="field"><label for="journal-sheet">Вкладка истории</label><input id="journal-sheet" data-model="google.journalSheet"></div>
      <div class="field"><label for="errors-sheet">Вкладка ошибок</label><input id="errors-sheet" data-model="google.errorsSheet"></div>
    </div>
    <details style="margin-top:16px">
      <summary>Отдельные таблицы для Journal / Errors</summary>
      <div>
        <div class="grid two">
          <div class="field"><label for="journal-url">Ссылка истории</label><input id="journal-url" data-model="google.journalUrl" placeholder="Пусто = основная"></div>
          <div class="field"><label for="errors-url">Ссылка ошибок</label><input id="errors-url" data-model="google.errorsUrl" placeholder="Пусто = основная"></div>
        </div>
      </div>
    </details>
    <div class="divider"></div>
    <div class="field">
      <label for="google-mode">Способ доступа</label>
      <select id="google-mode" data-model="google.mode" data-rerender="1">
        <option value="service_account">Сервисный аккаунт (рекомендуется)</option>
        <option value="oauth2">OAuth2 (вход через n8n)</option>
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
      <div class="notice notice-warn" style="margin-top:12px">Создайте доступ в n8n и нажмите «Подключить». Redirect URI: <span class="code"><code>${escapeHtml(n8nPublicUrl())}/rest/oauth2-credential/callback</code></span></div>`}
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
  const status = state.telegram.test || (state.refs.telegram ? { status: 'configured', message: 'Доступ сохранён. Требуется повторная проверка.' } : null);
  return `
    <h3>Telegram</h3>
    <p class="lead">Создайте бота через BotFather, добавьте его в чат и укажите Чат. Для групп ID отрицательный.</p>
    ${renderError()}
    ${status ? `<div class="notice notice-${status.ok === false || status.historical || !status.ok ? 'warn' : 'success'}">${escapeHtml(status.message || statusLabel(status.status))}</div>` : ''}
    <div class="grid two">
      <div class="field">
        <label for="telegram-token">Токен бота</label>
        <input id="telegram-token" type="password" data-model="telegram.token" autocomplete="off" placeholder="123456:AA…">
        ${fieldError('telegramToken')}
        <a class="btn btn-secondary btn-small" href="https://t.me/BotFather" target="_blank" rel="noopener">Создать бота в BotFather</a>
        <span class="hint">Создайте бота, добавьте его в нужный чат и отправьте любое сообщение.</span>
      </div>
      <div class="field">
        <label for="telegram-chat">Чат для уведомлений</label>
        ${state.telegram.chats.length ? `<select id="telegram-chat" data-model="telegram.chatId" class="select"><option value="">Выберите чат</option>${state.telegram.chats.map((chat) => `<option value="${escapeHtml(chat.id)}">${escapeHtml(chat.title)} · ${escapeHtml(chat.type)}</option>`).join('')}</select>` : `<input id="telegram-chat" data-model="telegram.chatId" placeholder="Сначала проверьте бота">`}
        <span class="hint">Нажмите «Проверить подключение» — мастер сам получит доступные чаты через Telegram Bot API. Если список пуст, напишите боту и повторите.</span>
        ${fieldError('telegramChat')}
      </div>
    </div>
    <div class="inline" style="margin-top:16px">
      <button type="button" class="btn btn-secondary" data-action="test-telegram">Проверить подключение</button>
      ${state.refs.telegram ? `<button type="button" class="btn btn-ghost btn-small" data-action="test-existing" data-kind="telegram">Проверить сохранённый доступ</button>` : ''}
    </div>
    <div class="notice notice-info" style="margin-top:16px"><strong>Важно</strong>Если бот не получал сообщений, <code>getUpdates</code> может быть пустым. Сначала добавьте бота в чат и отправьте сообщение.</div>
  `;
}

function summaryRow(label, value) {
  return `<div class="summary-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value || '—')}</span></div>`;
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
    <h2>Дополнительные настройки</h2>
    <p class="lead">Эти параметры нужны только для нестандартных интеграций. Значения по умолчанию безопасны. Сохранение выполняет тот же цикл проверки, что и запуск.</p>
    ${renderError()}
    ${renderApplyStatus()}
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
    <h3>Повторная обработка</h3>
    <div class="grid four">
      <div class="field"><label for="retry-max">Максимум попыток</label><input id="retry-max" type="number" min="1" max="20" data-model="retry.maxAttempts"></div>
      <div class="field"><label for="retry-base">Базовая задержка, сек</label><input id="retry-base" type="number" min="1" max="3600" data-model="retry.baseDelaySeconds"></div>
      <div class="field"><label for="retry-maxdelay">Максимальная задержка, сек</label><input id="retry-maxdelay" type="number" min="1" max="86400" data-model="retry.maxDelaySeconds"></div>
      <div class="field"><label for="retry-timeout">Timeout processing, сек</label><input id="retry-timeout" type="number" min="30" max="86400" data-model="retry.processingTimeoutSeconds"></div>
    </div>
    <div class="notice notice-info" style="margin-top:16px"><strong>Как это работает</strong>Повторный запрос с тем же ключом не создаёт дубль. Временные ошибки повторяются по расписанию; уже подтверждённые действия не выполняются заново.</div>
  `;
}

function operationStatusLabel(value) {
  return ({
    pending: 'Ожидает',
    processing: 'В обработке',
    retry_scheduled: 'Запланирован повтор',
    completed: 'Завершена',
    failed: 'Ошибка',
    needs_reconciliation: 'Требуется проверка',
  }[value] || value || 'Неизвестно');
}

function operationRow(operation) {
  const id = escapeHtml(operation.id || '');
  const status = escapeHtml(operationStatusLabel(operation.status));
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
    <h2>Обслуживание</h2>
    <p class="lead">Состояние системы, повторная обработка операций, резервные копии и проверка сервисов.</p>
    ${renderError()}
    ${data.error ? `<div class="notice notice-warn">${escapeHtml(data.error)}</div>` : ''}
    <div class="status-grid">
      ${statusCard('Веб-сервер', status(services.caddy), services.caddy ? 'HTTPS работает' : 'Не удалось проверить')}
      ${statusCard('n8n', status(services.n8n), services.n8n ? 'Контейнер запущен' : 'Не удалось проверить')}
      ${statusCard('База данных', status(services.postgres), services.postgres ? 'Контейнер запущен' : 'Не удалось проверить')}
      ${statusCard('Мастер', status(services.wizard), services.wizard ? 'Контейнер запущен' : 'Не удалось проверить')}
    </div>
    <div class="divider"></div>
    <div class="grid three">
      <div class="status-card"><h4>Всего операций</h4><p>${escapeHtml(String(summary.total ?? '—'))}</p></div>
      <div class="status-card"><h4>Требует проверки</h4><p>${escapeHtml(String(summary.needsReconciliation ?? '—'))}</p></div>
      <div class="status-card"><h4>Ждут восстановления</h4><p>${escapeHtml(String(summary.dueForRecovery ?? '—'))}</p></div>
    </div>
    <div class="row" style="margin-top:18px">
      <h3 style="margin:0">Последние операции</h3>
      <button type="button" class="btn btn-secondary btn-small" data-action="refresh-manage">Обновить</button>
    </div>
    <div class="table-wrap" style="margin-top:10px">
      <table class="data-table">
        <thead><tr><th>Номер</th><th>Статус</th><th>Источник</th><th>Обновлено</th><th>Ошибка</th><th></th></tr></thead>
        <tbody>${(data.operations || []).map(operationRow).join('') || '<tr><td colspan="6">Операций пока нет.</td></tr>'}</tbody>
      </table>
    </div>
    <div class="divider"></div>
    <h3>Резервные копии настроек</h3>
    <div class="inline">
      <select id="backup-select" class="select grow"><option value="">Выберите копию</option>${(data.backups || []).map((backup) => `<option value="${escapeHtml(backup.name)}">${escapeHtml(backup.name)}</option>`).join('')}</select>
      <button type="button" class="btn btn-secondary" data-action="create-backup">Создать копию</button>
      <button type="button" class="btn btn-danger" data-action="restore-backup">Восстановить</button>
      <button type="button" class="btn btn-secondary" data-action="doctor">Проверить систему</button>
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
  const testLead = state.testLead;
  const crmState = state.crmProvider === 'none'
    ? 'unknown'
    : integrationStageState(state.crmProvider === 'hubspot' ? 'hubspot' : 'google');
  const sheetState = !needsGoogle() ? 'unknown' : integrationStageState('google');
  const telegramState = !state.notificationsEnabled ? 'unknown' : integrationStageState('telegram');
  const ready = doctor?.result === 'PASS' && testLead?.result === 'PASS' && allRequiredIntegrationsVerified();
  return `
    <h2>Проверка и запуск</h2>
    <p class="lead">Проверьте сводку и подключения. Настройки будут сохранены, доступы — подготовлены, автоматизация — обновлена. При сбое мастер восстановит предыдущую конфигурацию.</p>
    ${renderError()}
    ${renderApplyStatus()}
    ${state.applyStage ? `<div class="notice notice-info"><strong>${escapeHtml(state.applyStage)}</strong>Не закрывайте страницу до завершения операции.</div>` : ''}
    ${!state.boot?.n8n?.apiKeyConfigured ? '<div class="notice notice-warn"><strong>n8n не подключён</strong>Вернитесь к началу работы и подключите n8n, чтобы мастер мог настроить доступы.</div>' : ''}
    <div class="summary">
      ${summaryRow('Компания', state.company)}
      ${summaryRow('Часовой пояс', state.timezone)}
      ${summaryRow('CRM', state.crmProvider === 'hubspot' ? 'HubSpot' : state.crmProvider === 'google_sheets' ? 'Google Sheets' : 'Без CRM')}
      ${summaryRow('История заявок', state.journalEnabled ? 'Google Sheets' : 'выключена')}
      ${summaryRow('Telegram', state.notificationsEnabled ? (state.telegram.chatId ? 'выбран чат' : 'нужен чат') : 'выключен')}
      ${summaryRow('Адрес приёма заявок', state.boot?.setup?.webhookUrl || '')}
    </div>
    <div class="divider"></div>
    <div class="status-grid">
      ${statusCard('CRM', crmState === 'verified' ? 'configured' : crmState === 'error' ? 'error' : crmState === 'unknown' ? 'unknown' : 'requires_auth', integrationStatusNote(state.crmProvider === 'hubspot' ? 'hubspot' : 'google', crmState === 'unknown' ? 'Не используется' : 'Требует настройки'))}
      ${statusCard('Таблица', sheetState === 'verified' ? 'configured' : sheetState === 'error' ? 'error' : 'requires_auth', integrationStatusNote('google', sheetState === 'unknown' ? 'Не используется' : 'Требует настройки'))}
      ${statusCard('Telegram', telegramState === 'verified' ? 'configured' : telegramState === 'error' ? 'error' : 'requires_auth', integrationStatusNote('telegram', telegramState === 'unknown' ? 'Не используется' : 'Требует настройки'))}
      ${statusCard('Тестовая заявка', testLead?.result === 'PASS' ? 'configured' : testLead?.result === 'FAIL' ? 'error' : 'requires_auth', testLead?.result === 'PASS' ? 'Обработана' : testLead?.result === 'FAIL' ? 'Не прошла' : 'Ещё не отправлена')}
    </div>
    <div class="inline" style="margin-top:18px">
      <button type="button" class="btn btn-secondary" data-action="doctor">Проверить систему</button>
      <button type="button" class="btn btn-secondary" data-action="test-lead">Отправить тестовую заявку</button>
      ${ready ? '<button type="button" class="btn btn-primary" data-action="go-done">Перейти к работе</button>' : ''}
    </div>
    ${doctor ? renderDoctor(doctor) : ''}
    ${!ready ? '<div class="notice notice-info" style="margin-top:14px"><strong>Успех не подтверждён</strong>Зелёный статус появится только после успешной проверки системы и реальной тестовой заявки.</div>' : ''}
    ${state.workflow ? `<div class="notice notice-${state.doctor?.result === 'PASS' ? 'success' : 'warn'}" style="margin-top:14px">Автоматизация обновлена${state.doctor?.result === 'PASS' ? ' и активна' : ', но проверка не пройдена'}.</div>` : ''}
  `;
}


function renderDoctor(result) {
  return `<div class="notice notice-${result.result === 'PASS' ? 'success' : 'warn'}" style="margin-top:16px">
    <strong>Проверка системы: ${escapeHtml(result.result)}</strong>
    <div class="summary">${(result.checks || []).map((check) => `<div class="summary-row"><span>${escapeHtml(check.level)}</span><span>${escapeHtml(check.message)}</span></div>`).join('')}</div>
  </div>`;
}

function renderActions() {
  const list = steps();
  const index = list.findIndex((step) => step.id === state.stepId);
  const actions = $('#actions');
  actions.replaceChildren();
  if (state.stepId !== 'start') {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn btn-ghost';
    back.dataset.action = 'back';
    back.textContent = 'Назад';
    actions.append(back);
  }
  const right = document.createElement('div');
  right.className = 'actions-right';
  if (state.stepId === 'verify') {
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'btn btn-primary';
    apply.dataset.action = 'save-apply';
    apply.textContent = state.busy ? 'Применяю…' : 'Сохранить и применить';
    right.append(apply);
  } else if (state.stepId === 'advanced') {
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary';
    save.dataset.action = 'save-apply';
    save.textContent = state.busy ? 'Применяю…' : 'Сохранить и применить';
    right.append(save);
  } else if (state.stepId !== 'done' && state.stepId !== 'maintenance') {
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn btn-primary';
    next.dataset.action = 'next';
    next.textContent = state.stepId === 'start' ? (state.boot?.hasConfig ? 'Продолжить настройку' : 'Начать настройку') : 'Далее';
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
  if (step === 'company') {
    $('#company').value = state.company;
    const search = $('#tz-search');
    search.value = state.timezone;
    search.addEventListener('input', () => {
      if (state.timezone !== search.value) {
        state.timezone = search.value;
        markDirty();
      }
      if (timezoneValid(search.value)) delete state.fieldErrors.timezone;
      else state.fieldErrors.timezone = 'Выберите корректный часовой пояс.';
      renderTimezoneResults(search.value);
    });
    search.addEventListener('change', () => {
      if (state.timezone !== search.value) {
        state.timezone = search.value;
        markDirty();
      }
      if (timezoneValid(search.value)) delete state.fieldErrors.timezone;
      else state.fieldErrors.timezone = 'Выберите корректный часовой пояс.';
      $('#tz-now').textContent = `Текущее время: ${timezoneNow(state.timezone)}`;
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
  if (step === 'maintenance' && !state.management.loading && !state.management.loaded) {
    refreshManagement();
  }
  if (step === 'integrations' && state.integrationTab === 'google') {
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
      if (state.timezone !== zone) {
        state.timezone = zone;
        delete state.fieldErrors.timezone;
        markDirty();
      }
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
  state.fieldErrors = {};
  if (step === 'start' && state.boot?.auth?.serverMode && !state.boot?.n8n?.apiKeyConfigured) {
    return 'Подключите n8n, чтобы продолжить настройку.';
  }
  if (step === 'company') {
    if (!state.company.trim()) {
      state.fieldErrors.company = 'Укажите название компании.';
      return state.fieldErrors.company;
    }
    if (!timezoneValid(state.timezone)) {
      state.fieldErrors.timezone = 'Выберите корректный часовой пояс.';
      return state.fieldErrors.timezone;
    }
  }
  if (step === 'integrations') {
    if (state.crmProvider === 'none' && !state.journalEnabled) {
      return 'Без CRM нужно включить журнал: иначе заявки некуда сохранять.';
    }
    if (state.crmProvider === 'google_sheets' && state.journalEnabled) {
      const main = spreadsheetId(state.google.mainUrl);
      const journal = spreadsheetId(state.google.journalUrl) || main;
      if (main && journal === main && state.google.leadsSheet.trim() === state.google.journalSheet.trim()) {
        return 'Журнал должен указывать на другую вкладку, нежели CRM.';
      }
    }
    if (!state.defaultSource.trim()) {
      state.fieldErrors.defaultSource = 'Укажите источник заявки по умолчанию.';
      return state.fieldErrors.defaultSource;
    }
    if (state.boot?.n8n?.apiKeyConfigured) {
      if (state.crmProvider === 'hubspot' && !state.refs.hubspot && !state.hubspot.appToken.trim() && !(state.hubspot.clientId.trim() && state.hubspot.clientSecret.trim())) {
        state.fieldErrors.hubspotToken = 'Укажите ключ private app или данные OAuth2.';
        return state.fieldErrors.hubspotToken;
      }
      if (needsGoogle()) {
        if (!spreadsheetId(state.google.mainUrl)) {
          state.fieldErrors.googleUrl = 'Вставьте ссылку на Google-таблицу или создайте её в мастере.';
          return state.fieldErrors.googleUrl;
        }
        if (!state.google.leadsSheet.trim()) return 'Укажите название вкладки Leads.';
        if (state.journalEnabled && !state.google.journalSheet.trim()) return 'Укажите название вкладки Journal.';
        if (state.errorsEnabled && !state.google.errorsSheet.trim()) return 'Укажите название вкладки Errors.';
        if (!state.refs.google && state.google.mode === 'service_account' && !state.google.serviceAccountText.trim()) {
          return 'Вставьте JSON сервисного аккаунта.';
        }
        if (!state.refs.google && state.google.mode === 'oauth2' && !(state.google.clientId.trim() && state.google.clientSecret.trim())) {
          return 'Укажите Client ID и Client Secret или используйте существующий доступ.';
        }
      }
      if (state.notificationsEnabled) {
        if (!state.telegram.chatId.trim()) {
          state.fieldErrors.telegramChat = 'Выберите чат Telegram.';
          return state.fieldErrors.telegramChat;
        }
        if (!state.refs.telegram && !state.telegram.token.trim()) {
          state.fieldErrors.telegramToken = 'Укажите токен Telegram-бота.';
          return state.fieldErrors.telegramToken;
        }
      }
    }
  }
  if (step === 'advanced') {
    for (const [key, value] of Object.entries(state.mapping)) {
      if (!String(value || '').trim()) return `Заполните маппинг поля «${key}».`;
    }
    const retention = Number(state.idempotency.retentionDays);
    if (!Number.isInteger(retention) || retention < 1 || retention > 3650) return 'Срок хранения должен быть целым числом от 1 до 3650 дней.';
    const maxAttempts = Number(state.retry.maxAttempts);
    const baseDelay = Number(state.retry.baseDelaySeconds);
    const maxDelay = Number(state.retry.maxDelaySeconds);
    const timeout = Number(state.retry.processingTimeoutSeconds);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) return 'Максимум попыток: 1–20.';
    if (!Number.isInteger(baseDelay) || baseDelay < 1 || baseDelay > 3600) return 'Базовая задержка: 1–3600 секунд.';
    if (!Number.isInteger(maxDelay) || maxDelay < baseDelay || maxDelay > 86400) return 'Максимальная задержка должна быть не меньше базовой и не больше 86400 секунд.';
    if (!Number.isInteger(timeout) || timeout < 30 || timeout > 86400) return 'Таймаут обработки: 30–86400 секунд.';
  }
  return null;
}
function goNext() {
  if (isExtraStep(state.stepId) || state.stepId === 'verify' || state.stepId === 'done') return;
  const error = validateStep(state.stepId);
  if (error) { state.error = error; render(); return; }
  state.error = null;
  const list = steps();
  const index = list.findIndex((step) => step.id === state.stepId);
  if (index < list.length - 1) state.stepId = list[index + 1].id;
  render();
}

function goBack() {
  if (state.dirty && !window.confirm('Есть несохранённые изменения. Перейти без сохранения?')) return;
  state.error = null;
  if (isExtraStep(state.stepId)) {
    state.stepId = state.stepId === 'advanced' ? 'company' : 'done';
    render();
    return;
  }
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

async function saveAndApply() {
  state.error = null;
  state.busy = true;
  state.applyStage = 'Проверка настроек';
  state.testLead = null;
  state.doctor = null;
  state.applyStatus = null;
  state.previousRefs = refsForApi();
  state.previousConfigHash = state.boot?.configHash || null;
  state.lastBackup = null;
  state.lastWorkflowBackup = null;
  const originStep = state.stepId;
  const previousConfig = state.boot?.hasConfig && state.boot?.config
    ? structuredClone(state.boot.config)
    : null;
  let configSaved = false;
  let workflowAttempted = false;
  render();
  try {
    const config = buildConfig();
    const validated = await api('api/config/validate', { method: 'POST', body: { config } });

    if (state.boot.n8n.apiKeyConfigured) {
      state.applyStage = 'Подготовка доступов';
      render();
      await createCredentials();

      state.applyStage = 'Сохранение точки восстановления автоматизации';
      render();
      const workflowBackup = await api('api/workflow/backups', { method: 'POST', body: {} });
      state.lastWorkflowBackup = workflowBackup.backup?.name || null;

      state.applyStage = 'Сохранение точки восстановления настроек';
      render();
      try {
        const backup = await api('api/config/backups', { method: 'POST', body: {} });
        state.lastBackup = backup.backup?.name || null;
      } catch (backupError) {
        if (backupError.data?.error !== 'config_not_found') throw backupError;
        state.lastBackup = null;
      }

      state.applyStage = 'Сохранение конфигурации';
      render();
      const saved = await api('api/config', { method: 'POST', body: { config: validated.config } });
      state.baseConfig = saved.config;
      state.boot.config = saved.config;
      state.boot.hasConfig = true;
      configSaved = true;

      state.applyStage = 'Применение автоматизации';
      render();
      workflowAttempted = true;
      const applied = await api('api/workflow/apply', { method: 'POST', body: { credentials: refsForApi() } });
      state.workflow = applied.workflow;

      state.applyStage = 'Проверка результата';
      render();
      const doctor = await api('api/doctor', { method: 'POST', body: { integrationTest: false }, allowNotOk: true });
      state.doctor = doctor;
      if (doctor.result !== 'PASS') {
        const error = new Error(
          doctor.result === 'FAIL'
            ? 'Проверка системы не пройдена: doctor вернул FAIL.'
            : 'Проверка системы не подтверждена: doctor вернул UNVERIFIED.',
        );
        error.code = 'doctor_failed';
        error.doctor = doctor;
        throw error;
      }

      const currentBoot = await api('api/bootstrap');
      await persistLiveVerifications(currentBoot.configHash).catch(() => {});
      const boot = await api('api/bootstrap');
      applyBootstrap(boot, { preserveLiveVerifications: true });
      state.dirty = false;
      state.applyStatus = {
        state: 'applied',
        title: 'Настройки применены, doctor пройден',
        message: 'Для подтверждения обработки отправьте тестовую заявку.',
      };
      toast('Настройки применены. Теперь отправьте тестовую заявку.');
    } else {
      state.applyStage = 'Сохранение конфигурации';
      render();
      const saved = await api('api/config', { method: 'POST', body: { config: validated.config } });
      state.baseConfig = saved.config;
      state.boot.config = saved.config;
      state.boot.hasConfig = true;
      configSaved = true;
      state.dirty = false;
      state.manual = true;
      state.applyStatus = {
        state: 'not_applied',
        title: 'Конфигурация сохранена, но не применена',
        message: 'n8n не подключён, поэтому доступы и автоматизация не применялись. Подключите n8n и повторите применение.',
      };
      toast('Конфигурация сохранена. Подключите n8n, чтобы назначить доступы автоматически.');
    }
  } catch (error) {
    const failure = errorMessage(error);
    const notes = [];
    let configRestored = false;
    let workflowRestored = false;

    const verifyConfigRestore = async () => {
      const restoredBoot = await api('api/bootstrap');
      return state.previousConfigHash
        ? restoredBoot.configHash === state.previousConfigHash
        : JSON.stringify(restoredBoot.config) === JSON.stringify(previousConfig);
    };

    if (state.lastBackup) {
      try {
        await api('api/config/restore', {
          method: 'POST',
          body: { name: state.lastBackup, confirm: true },
        });
        configRestored = Boolean(await verifyConfigRestore());
        if (!configRestored) notes.push('Backup восстановлен, но hash конфигурации не совпал с ожидаемым.');
      } catch (restoreError) {
        notes.push(`Backup конфигурации не восстановлен: ${errorMessage(restoreError)}.`);
      }
    }
    if (!configRestored && configSaved && previousConfig) {
      try {
        await api('api/config', { method: 'POST', body: { config: previousConfig } });
        configRestored = Boolean(await verifyConfigRestore());
        notes.push(configRestored
          ? 'Предыдущая конфигурация восстановлена и проверена.'
          : 'Предыдущая конфигурация записана, но её hash не совпал с ожидаемым.');
      } catch (restoreError) {
        notes.push(`Не удалось автоматически восстановить конфигурацию: ${errorMessage(restoreError)}.`);
      }
    } else if (configRestored) {
      notes.push('Предыдущая конфигурация восстановлена и проверена.');
    } else if (configSaved) {
      notes.push('Предыдущей конфигурации не было: автоматический откат файла невозможен. Проверьте настройки вручную.');
    }

    if (workflowAttempted && state.lastWorkflowBackup) {
      try {
        const restored = await api('api/workflow/restore', {
          method: 'POST',
          body: { backup: state.lastWorkflowBackup, confirm: true },
        });
        workflowRestored = restored.ok === true;
        notes.push(workflowRestored
          ? 'Workflow восстановлен и проверен по резервной копии.'
          : 'Workflow отправлен в n8n, но фактическое состояние не совпало с резервной копией.');
      } catch (restoreError) {
        notes.push(`Не удалось восстановить workflow: ${errorMessage(restoreError)}.`);
      }
    }
    if (!workflowRestored && workflowAttempted && state.previousRefs) {
      try {
        await api('api/workflow/apply', { method: 'POST', body: { credentials: state.previousRefs } });
        notes.push('Workflow возвращён к предыдущим доступам, но точное состояние не подтверждено.');
      } catch (restoreError) {
        notes.push(`Workflow мог остаться в промежуточном состоянии: ${errorMessage(restoreError)}.`);
      }
    }



    state.workflow = null;
    state.error = `${failure} ${notes.join(' ')}`.trim();
    const partial = (configSaved && !configRestored) || (workflowAttempted && !workflowRestored);
    state.applyStatus = {
      state: partial ? 'partial' : 'rolled_back',
      title: partial ? 'Применение частично выполнено' : 'Применение отменено',
      message: partial
        ? 'Не все изменения удалось откатить. Проверьте конфигурацию и workflow перед повторной попыткой.'
        : 'Предыдущее состояние восстановлено. Исправьте ошибку и повторите применение.',
    };
    const restoredBoot = await api('api/bootstrap').catch(() => null);
    if (restoredBoot) {
      applyBootstrap(restoredBoot);
      state.stepId = originStep === 'advanced' ? 'advanced' : 'verify';
      state.dirty = false;
    }
    state.testLead = null;
    toast(failure, 'error');
  } finally {
    state.applyStage = null;
    state.busy = false;
    render();
  }
}

async function persistLiveVerifications(configHash) {
  if (!configHash) return;
  const tests = {
    hubspot: state.hubspot.test,
    google: state.google.test,
    telegram: state.telegram.test,
  };
  const results = {};
  for (const [kind, test] of Object.entries(tests)) {
    if (test?.ok === true && !test.historical && (kind !== 'telegram' || test.details?.chatVerified === true)) {
      results[kind] = { ok: true, status: test.status || 'connected' };
    }
  }
  if (!Object.keys(results).length) return;
  await api('api/verifications', { method: 'POST', body: { configHash, results } });
  for (const kind of Object.keys(results)) {
    if (tests[kind]) tests[kind].configHash = configHash;
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
    if (integrationTest) state.testLead = result;
    toast(result.result === 'PASS' ? 'Проверка системы пройдена.' : 'Проверка системы не пройдена.', result.result === 'PASS' ? '' : 'error');
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
  const configHash = await draftConfigHash();
  try {
    let result;
    if (kind === 'hubspot') {
      if (state.hubspot.mode === 'oauth2') {
        toast('OAuth2 проверяется через сохранённый credential после Connect.');
        return;
      }
      const values = { token: state.hubspot.appToken };
      result = await api('api/integrations/test', {
        method: 'POST',
        body: { kind, values, configHash },
      });
      state.hubspot.test = { ...result, configHash: result.configHash || configHash, historical: false };
    }
    if (kind === 'telegram') {
      const values = { token: state.telegram.token, chatId: state.telegram.chatId };
      result = await api('api/integrations/test', {
        method: 'POST',
        body: { kind, values, configHash },
      });
      state.telegram.test = { ...result, configHash: result.configHash || configHash, historical: false };
      state.telegram.chats = Array.isArray(result?.details?.chats) ? result.details.chats : [];
      if (!state.telegram.chatId && state.telegram.chats.length === 1) state.telegram.chatId = state.telegram.chats[0].id;
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
      const values = {
        serviceAccount: state.google.serviceAccountText,
        spreadsheetId: spreadsheetId(state.google.mainUrl),
        sheetNames: [
          ...(state.crmProvider === 'google_sheets' ? [state.google.leadsSheet] : []),
          ...(state.journalEnabled ? [state.google.journalSheet] : []),
          ...(state.errorsEnabled ? [state.google.errorsSheet] : []),
        ].filter(Boolean),
      };
      result = await api('api/integrations/test', {
        method: 'POST',
        body: { kind: 'google_service_account', values, configHash },
      });
      state.google.test = { ...result, configHash: result.configHash || configHash, historical: false };
    }
    toast(result?.message || 'Проверка завершена.');
  } catch (error) {
    const message = errorMessage(error);
    if (kind === 'hubspot') {
      state.hubspot.test = { ok: false, message: /значение обязательно/.test(message) ? 'Вставьте ключ private app.' : message, configHash, historical: false };
      if (/значение обязательно/.test(message)) state.fieldErrors.hubspotToken = 'Вставьте ключ private app.';
    }
    if (kind === 'telegram') {
      state.telegram.test = { ok: false, message: /значение обязательно/.test(message) ? 'Вставьте токен бота и выберите чат.' : message, configHash, historical: false };
      if (/значение обязательно/.test(message)) state.fieldErrors.telegramToken = 'Вставьте токен бота.';
    }
    if (kind === 'google') {
      state.google.test = { ok: false, message, configHash, historical: false };
      if (/spreadsheetId/.test(message)) state.fieldErrors.googleUrl = 'Вставьте ссылку на таблицу.';
    }
    toast(message, 'error');
  }
  render();
}

async function testExisting(kind) {
  const ref = state.refs[kind === 'hubspot' ? 'hubspot' : kind];
  if (!ref?.id) return;
  const configHash = await draftConfigHash();
  state.busy = true;
  render();
  try {
    const result = await api(`api/credentials/${encodeURIComponent(ref.id)}/test`, {
      method: 'POST',
      body: { kind, configHash },
      allowNotOk: true,
    });
    const tested = { ...result, configHash: result.configHash || configHash, historical: false };
    if (kind === 'hubspot') state.hubspot.test = tested;
    if (kind === 'telegram') state.telegram.test = tested;
    if (kind === 'google') state.google.test = tested;
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
    if (state.dirty && !window.confirm('Есть несохранённые изменения. Перейти без сохранения?')) return;
    state.error = null;
    state.stepId = target.dataset.step;
    render();
    return;
  }
  if (target.dataset.extraStep) {
    if (state.dirty && !window.confirm('Есть несохранённые изменения. Перейти без сохранения?')) return;
    state.error = null;
    state.stepId = target.dataset.extraStep;
    render();
    return;
  }
  if (target.dataset.integrationTab) {
    state.integrationTab = target.dataset.integrationTab;
    state.error = null;
    render();
    return;
  }
  if (target.dataset.crm) {
    state.crmProvider = target.dataset.crm;
    if (state.crmProvider === 'none') state.journalEnabled = true;
    state.dirty = true;
    state.testLead = null;
    state.doctor = null;
    state.error = null;
    render();
    return;
  }
  if (target.dataset.removeSource !== undefined) {
    state.allowedSources.splice(Number(target.dataset.removeSource), 1);
    state.dirty = true;
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
      toast('Выберите копию.', 'error');
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
  if (action === 'go-done') {
    if (state.testLead?.result === 'PASS' && state.doctor?.result === 'PASS' && allRequiredIntegrationsVerified()) {
      state.stepId = 'done';
      render();
    } else {
      toast('Сначала завершите проверки обязательных интеграций.', 'error');
    }
    return;
  }
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
      state.dirty = true;
      input.value = '';
      renderSourceChips();
    }
  }
  if (action === 'install-workflow') {
    const confirmed = await confirmAction(
      'Установить автоматизацию?',
      'Автоматизация будет установлена. Если она уже существует, установка будет отклонена. Продолжать?',
    );
    if (!confirmed) return;
    state.busy = true;
    render();
    try {
      const result = await api('api/workflow/install', { method: 'POST', body: { confirm: true } });
      const boot = await api('api/bootstrap');
      state.boot = boot;
      toast(result.message || 'Автоматизация установлена.');
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
  markDirty();
  delete state.fieldErrors[model.split('.')[0]];
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
  markDirty();
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

window.addEventListener('beforeunload', (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = '';
});
