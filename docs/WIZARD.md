# Мастер настройки `/setup/` v0.5

Мастер — часть единого Docker Compose-стека. Он не запускается отдельно на хосте и не публикует собственный порт наружу. Публичный адрес:

```text
https://<domain>/setup/
```

Caddy снимает префикс `/setup` и проксирует запросы в контейнер `wizard:8787`. Относительные ссылки и API-пути браузера работают под `/setup/`.

## Первый вход

1. Установите стек:

```bash
sudo ./scripts/install-server.sh crm.example.com admin@example.com
```

2. Откройте first-run URL из вывода установщика:
   `https://<domain>/setup/?token=<одноразовый-токен>`.
3. Создайте единственного администратора. Пароль — не короче 12 символов.
4. Подключите n8n API key в браузере.
5. Пройдите шаги мастера.

После регистрации bootstrap-токен удаляется. Повторная регистрация возвращает `already_configured`; вход — по логину и паролю.

## Полный цикл

| Шаг | Что настраивается |
|---|---|
| Обзор | n8n, API key, workflow, credentials, предупреждения |
| Адрес | публичный URL, webhook, OAuth callback, проверка доступности |
| Клиент | компания, IANA timezone, текущее время |
| Интеграции | HubSpot / Google Sheets / без CRM, Journal, Telegram, Errors, источники |
| HubSpot | private app, scopes, Service Key или OAuth2 |
| Google Sheets | URL/ID, вкладки, Service Account/OAuth2, создание таблицы и заголовков |
| Telegram | BotFather, token, Chat ID, `getMe`/`getChat` |
| Маппинг и поведение | поля заявки, идемпотентность, retention, retry |
| Проверка | сохранение, credentials, workflow, doctor, тестовая заявка |
| Управление | сервисы, операции, retry, backup/restore, doctor |

## Google Sheets: автоматическое создание

Для Service Account доступна кнопка **«Создать таблицу и заголовки»**:

- если URL/ID не указан — создаётся новая таблица;
- если указан — добавляются отсутствующие вкладки;
- первая строка каждой вкладки заполняется заголовками из шаблона конфигурации;
- существующие строки данных не изменяются.

После создания откройте таблицу → **Share** → добавьте `client_email` сервисного аккаунта с правами Editor. OAuth2-режим требует ручного Connect в n8n; автоматическое создание доступно только для Service Account.

## Управление

Раздел «Управление» показывает:

- доступность Caddy, n8n, PostgreSQL, Wizard;
- количество операций и `needs_reconciliation`;
- последние операции без raw payload;
- ручной retry допустимых операций;
- список backup-файлов конфигурации, создание и восстановление;
- запуск doctor.

Retry разрешён только для `failed`, `retry_scheduled`, `needs_reconciliation`, `pending`. `completed` и активная `processing` отклоняются. Подтверждённые CRM/Journal стадии не выполняются повторно.

## API key n8n

Нужны scopes:

- `workflow:read`
- `workflow:update`
- `workflow:activate`
- `credential:list`
- `credential:read`
- `credential:create`

Ключ вводится в браузере, проверяется server-side и сохраняется в `wizard-data/n8n-api-key.enc`:

- AES-256-GCM;
- ключ шифрования — `WIZARD_SECRET_KEY` через HKDF;
- в API, DOM, localStorage/sessionStorage и логи ключ не возвращается.

Без ключа серверный мастер не пропускает дальше шага «Обзор». Ручной режим v0.4 в v0.5 не поддерживается: настройка должна завершаться в браузере.

## API

Все пути снаружи имеют префикс `/setup/`.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/health` | healthcheck без авторизации |
| GET | `/api/auth/status` | состояние входа/регистрации |
| POST | `/api/auth/register` | первый администратор |
| POST | `/api/auth/login` | вход |
| POST | `/api/auth/logout` | выход и отзыв сессий |
| GET | `/api/bootstrap` | конфиг, n8n, setup URLs, credentials |
| POST | `/api/n8n/connect` | проверить и сохранить API key |
| POST | `/api/config/validate` | валидация конфига |
| POST | `/api/config` | атомарное сохранение с backup |
| GET | `/api/config/backups` | список backup |
| POST | `/api/config/backups` | создать backup |
| POST | `/api/config/restore` | восстановить backup (confirm) |
| GET | `/api/services` | доступность контейнеров |
| GET | `/api/operations/summary` | сводка state machine |
| GET | `/api/operations` | последние операции |
| POST | `/api/operations/:id/retry` | ручной retry |
| POST | `/api/google/provision` | создать таблицу/вкладки/заголовки |
| GET | `/api/credentials` | metadata credentials |
| POST | `/api/credentials` | создать/переиспользовать credential |
| POST | `/api/credentials/:id/test` | тест credential |
| POST | `/api/integrations/test` | прямой тест интеграций |
| POST | `/api/workflow/apply` | назначить credentials 19 нодам |
| POST | `/api/workflow/install` | импорт workflow (confirm) |
| POST | `/api/doctor` | doctor; тестовая заявка (confirm) |

POST-запросы требуют `X-Wizard-Token`; все API, кроме health/auth, требуют сессию. Ошибки: `{ok:false,error,message}`.

## Безопасность

- Мастер доступен только через Caddy; контейнерный порт `8787` не публикуется.
- Cookie: HttpOnly, SameSite=Strict, Secure, Path=/setup.
- CSRF-токен вставляется в HTML meta и меняется при каждом запуске.
- Проверяются Host, Origin, Content-Type; тело ограничено 2 МБ.
- Конфиг пишется атомарно, mode `0600`, с backup.
- API key и credential data не возвращаются в API.
- Docker socket доступен контейнеру только для doctor/import/recovery. Компрометация root на хосте всё равно раскрывает секреты; нужны full-disk encryption и ограниченный доступ.

## Ограничения

- OAuth2 HubSpot/Google требует ручного Connect в n8n.
- Google Service Account требует шаринга таблицы на `client_email`.
- `doctor --integration-test` использует фиксированный email и может обновить существующий контакт HubSpot; запуск только после подтверждения.
- Kit не гарантирует exactly-once для внешних API; неоднозначные стадии требуют `needs_reconciliation`.
- Изменение DNS/домена и TLS — инфраструктурная операция Caddy; мастер показывает текущий адрес и проверяет доступность, но не перевыпускает сертификаты.
