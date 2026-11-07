# Web Setup Wizard v0.4

Требования: Node.js 22 на хосте и запущенный Docker Compose.

Локальный мастер для настройки клиента без ручного редактирования `config/client.json` и без назначения credentials через n8n UI. Работает только на `127.0.0.1`, не является публичным сервисом.

## Запуск

```bash
./scripts/start-wizard.sh
```

Мастер откроется на `http://127.0.0.1:8787`. Если `N8N_API_KEY` не задан, скрипт предложит ввести его скрыто; ключ живёт только в памяти процесса и не записывается на диск. Для неинтерактивного запуска:

```bash
N8N_API_KEY='...' ./scripts/start-wizard.sh
```

Порт можно изменить:

```bash
WIZARD_PORT=8788 ./scripts/start-wizard.sh
```

Остановка — `Ctrl+C`.

## API key n8n

Автоматическое создание credentials и назначение их workflow требуют public API key n8n.

1. Откройте `http://127.0.0.1:5678/settings/api`.
2. Создайте ключ со scopes:
   - `workflow:read`
   - `workflow:update`
   - `workflow:activate`
   - `credential:list`
   - `credential:read`
   - `credential:create`
3. Запустите мастер с `N8N_API_KEY` или введите ключ в приглашении.

Ключ передаётся только server-side в заголовке `X-N8N-API-KEY`. В браузер, DOM, localStorage, sessionStorage и логи он не попадает. Без ключа мастер работает в ручном режиме: конфиг сохраняется, а credentials назначаются в n8n по инструкции на шаге «Проверка».

## Что делает мастер

1. **Обзор** — проверяет n8n, наличие конфига, API key и текущие credentials; если workflow отсутствует, предлагает установить его.
2. **Клиент** — название компании, IANA timezone с поиском и текущим временем.
3. **Интеграции** — HubSpot / Google Sheets / без CRM, Journal, Telegram, Errors, источники заявок.
4. **HubSpot** — private app, scopes, Service Key или OAuth2.
5. **Google Sheets** — URL таблицы, вкладки Leads/Journal/Errors, Service Account (рекомендуется) или OAuth2, проверка доступа и заголовков.
6. **Telegram** — BotFather, bot token, Chat ID, проверка `getMe`/`getChat`.
7. **Проверка** — сохранение конфига, создание/переиспользование credentials, назначение их 19 нодам workflow, `doctor.sh`, тестовая заявка по подтверждению.

Настройки в памяти сохраняются при переходах назад. Секреты не пишутся в storage; после перезагрузки страницы их нужно ввести снова.

## Безопасность

- Сервер слушает `127.0.0.1`. Удалённый доступ требует одновременно `WIZARD_ALLOW_REMOTE=1` и явного `WIZARD_ALLOWED_HOSTS`; это не рекомендуется.
- POST-запросы защищены случайным `X-Wizard-Token`, который вставляется в HTML meta и меняется при каждом запуске.
- Проверяются loopback-адрес, `Host`, `Origin`, `Content-Type`; тело ограничено 2 МБ.
- Конфиг сохраняется атомарно, mode `0600`, с backup `config/.client-config.<timestamp>.json`; невалидный конфиг не записывается.
- API key и credential data никогда не возвращаются в API-ответах и не логируются.
- OAuth2 credentials создаются, но требуют ручного Connect в n8n: `${N8N_URL}/home/credentials`.

## API

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/health` | healthcheck |
| GET | `/api/bootstrap` | состояние конфига, n8n, credentials |
| POST | `/api/config/validate` | проверка конфига |
| POST | `/api/config` | атомарное сохранение с backup |
| GET | `/api/credentials?type=` | metadata credentials; без API key возвращает 400 |
| POST | `/api/credentials` | создать/переиспользовать credential |
| POST | `/api/credentials/:id/test` | тест credential через n8n |
| POST | `/api/integrations/test` | прямой тест HubSpot/Telegram/Google |
| POST | `/api/workflow/apply` | назначить credentials 19 нодам |
| POST | `/api/workflow/install` | импорт workflow с `confirm:true` |
| POST | `/api/doctor` | `doctor.sh`; тестовая заявка с `confirm:true` |

Все POST требуют `X-Wizard-Token`. Ошибки имеют вид `{ok:false,error,message}`.

## Ограничения

- Мастер не создаёт Google-таблицы, вкладки и заголовки; он проверяет доступ и подсказывает структуру.
- OAuth2 HubSpot/Google требует ручного Connect в n8n.
- Google Service Account требует, чтобы таблица была расшарена на `client_email` с правами Editor.
- `doctor.sh --integration-test` использует фиксированный email `doctor@example.com` и может обновить существующий контакт HubSpot; тест запускается только после отдельного подтверждения.
- Kit по-прежнему не гарантирует exactly-once для Telegram; см. ограничения v0.3.
- Мастер не является заменой резервному копированию: перед применением сохраняются backup конфига, но workflow меняется через public API без отдельного backup-файла. Для отката используйте экспорт workflow из n8n.

## Troubleshooting

- **`n8n недоступен`** — `docker compose ps`, `docker compose logs -f n8n`.
- **`У API key нет доступа`** — добавьте scopes из раздела выше; особенно `credential:list`.
- **`Credential создан, но OAuth требует авторизации`** — откройте `/home/credentials` в n8n, нажмите Connect, вернитесь в мастер и проверьте снова.
- **`request/body/meta is read-only`** — это ошибка старой версии мастера; backend v0.4 не отправляет `meta` в PUT.
- **`Таблица не найдена`** — проверьте URL и доступ сервисного аккаунта.
- **Порт занят** — `WIZARD_PORT=8788 ./scripts/start-wizard.sh`.
