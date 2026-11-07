const TOKEN = document.querySelector('meta[name="wizard-token"]')?.content || '';
const $ = (selector, root = document) => root.querySelector(selector);

const ERROR_TEXT = {
  invalid_credentials: 'Неверный логин или пароль.',
  invalid_token: 'Ссылка установки недействительна или уже использована.',
  invalid_bootstrap_token: 'Ссылка установки недействительна или уже использована.',
  already_configured: 'Первый администратор уже создан. Войдите с логином и паролем.',
  rate_limited: 'Слишком много попыток. Попробуйте позже.',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function errorMessage(error) {
  const code = error?.data?.error;
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  if (typeof error?.data?.details === 'string' && error.data.details.trim()) return error.data.details;
  return error?.data?.message || error?.message || 'Неизвестная ошибка';
}

async function api(path, { method = 'GET', body } = {}) {
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
  if (!response.ok || data.ok === false) {
    const error = new Error(data.message || `HTTP ${response.status}`);
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

function showError(message) {
  const box = $('#auth-error');
  if (!box) return;
  box.textContent = message;
  box.classList.remove('hidden');
}

function clearError() {
  const box = $('#auth-error');
  if (!box) return;
  box.textContent = '';
  box.classList.add('hidden');
}

function setBusy(form, busy) {
  const submit = $('button[type="submit"]', form);
  if (!submit) return;
  submit.disabled = busy;
  if (busy) {
    submit.dataset.label = submit.textContent;
    submit.textContent = 'Подождите…';
  } else if (submit.dataset.label) {
    submit.textContent = submit.dataset.label;
    delete submit.dataset.label;
  }
}

function readSetupToken() {
  const url = new URL(location.href);
  const token = url.searchParams.get('token') || '';
  if (url.searchParams.has('token')) {
    url.searchParams.delete('token');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }
  return token;
}

function renderMissingLink() {
  const root = $('#auth-root');
  root.innerHTML = `
    <div class="auth-head">
      <div class="brand-mark" aria-hidden="true">CK</div>
      <div>
        <p class="eyebrow">CRM Automation Kit</p>
        <h1>Нужна ссылка установки</h1>
      </div>
    </div>
    <div class="notice notice-warn">
      <strong>Ссылка установки не найдена</strong>
      Для создания первого администратора откройте одноразовую ссылку, которую выдал установщик.
      Если ссылка потеряна, попросите администратора сервера сгенерировать новую.
    </div>
    <p class="auth-footnote">После создания администратора эта страница будет доступна только для входа.</p>
  `;
}

function renderRegister(setupToken) {
  if (!setupToken) {
    renderMissingLink();
    return;
  }
  const root = $('#auth-root');
  root.innerHTML = `
    <div class="auth-head">
      <div class="brand-mark" aria-hidden="true">CK</div>
      <div>
        <p class="eyebrow">CRM Automation Kit</p>
        <h1>Создание администратора</h1>
      </div>
    </div>
    <p class="lead">Ссылка установки подтверждена. Создайте аккаунт, чтобы завершить настройку проекта.</p>
    <div id="auth-error" class="notice notice-error hidden" role="alert"></div>
    <form id="auth-form" class="auth-form" novalidate>
      <div class="field">
        <label for="username">Имя администратора</label>
        <input id="username" name="username" type="text" autocomplete="username" spellcheck="false" autocapitalize="none" required>
        <span class="hint">Латиница, цифры, точка, дефис или подчёркивание.</span>
      </div>
      <div class="field">
        <label for="password">Пароль</label>
        <input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>
        <span class="hint">Минимум 12 символов.</span>
      </div>
      <div class="field">
        <label for="confirm">Повторите пароль</label>
        <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="12" required>
      </div>
      <button type="submit" class="btn btn-primary auth-submit">Создать администратора</button>
    </form>
    <p class="auth-footnote">Ссылка одноразовая. Пароль не сохраняется в браузере.</p>
  `;

  const form = $('#auth-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    const username = form.username.value.trim();
    const password = form.password.value;
    const confirm = form.confirm.value;
    if (!username) {
      showError('Укажите имя администратора.');
      form.username.focus();
      return;
    }
    if (password.length < 12) {
      showError('Пароль должен содержать не менее 12 символов.');
      form.password.focus();
      return;
    }
    if (password !== confirm) {
      showError('Пароли не совпадают.');
      form.confirm.focus();
      return;
    }
    setBusy(form, true);
    try {
      await api('api/auth/register', { method: 'POST', body: { token: setupToken, username, password } });
      location.replace('./');
    } catch (error) {
      setBusy(form, false);
      const message = errorMessage(error);
      showError(`${message} Если ссылка потеряна, попросите администратора сервера создать новую ссылку установки.`);
    }
  });
  form.username.focus();
}

function renderLogin() {
  const root = $('#auth-root');
  root.innerHTML = `
    <div class="auth-head">
      <div class="brand-mark" aria-hidden="true">CK</div>
      <div>
        <p class="eyebrow">CRM Automation Kit</p>
        <h1>Вход в мастер</h1>
      </div>
    </div>
    <p class="lead">Мастер настройки доступен только администратору.</p>
    <div id="auth-error" class="notice notice-error hidden" role="alert"></div>
    <form id="auth-form" class="auth-form" novalidate>
      <div class="field">
        <label for="username">Имя пользователя</label>
        <input id="username" name="username" type="text" autocomplete="username" spellcheck="false" autocapitalize="none" required>
      </div>
      <div class="field">
        <label for="password">Пароль</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
      </div>
      <button type="submit" class="btn btn-primary auth-submit">Войти</button>
    </form>
    <p class="auth-footnote">Пароль не сохраняется в браузере.</p>
    <details class="auth-help">
      <summary>Не удаётся войти?</summary>
      <p>Восстановление пароля через мастер не предусмотрено. Попросите администратора сервера проверить доступ или создать новую установочную ссылку.</p>
    </details>
  `;

  const form = $('#auth-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    const username = form.username.value.trim();
    const password = form.password.value;
    if (!username || !password) {
      showError('Укажите имя пользователя и пароль.');
      return;
    }
    setBusy(form, true);
    try {
      await api('api/auth/login', { method: 'POST', body: { username, password } });
      location.replace('./');
    } catch (error) {
      setBusy(form, false);
      showError(errorMessage(error));
    }
  });
  form.username.focus();
}

(async function init() {
  const root = $('#auth-root');
  try {
    const status = await api('api/auth/status');
    if (!status.serverMode || status.authenticated) {
      location.replace('./');
      return;
    }
    const setupToken = readSetupToken();
    if (status.configured) renderLogin();
    else renderRegister(setupToken);
  } catch (error) {
    root.replaceChildren();
    const box = document.createElement('div');
    box.className = 'notice notice-error';
    box.setAttribute('role', 'alert');
    box.textContent = `Не удалось проверить состояние входа: ${errorMessage(error)}`;
    root.append(box);
  }
})();
