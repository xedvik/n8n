# CRM Automation Kit v0.3

Переиспользуемый lead-intake kit для n8n: HTTP webhook → нормализация → валидация → идемпотентная операция в PostgreSQL → CRM → опциональный журнал → опциональные уведомления → HTTP-ответ.

Основная идея v0.3: повторный или конкурентный запрос не должен повторно создавать контакт, строку журнала или отправлять уведомление. Состояние операции и стадий хранится в PostgreSQL; внешние API остаются источником истины для уже подтверждённых действий.

## Возможности

- **Идемпотентность** по `external_id` (поле заявки) или заголовку `Idempotency-Key`.
- Одинаковый ключ + другой payload → контролируемый `409 idempotency_conflict`.
- Повтор завершённой операции → сохранённый ответ с `200` и `replayed:true`.
- Конкурентные одинаковые запросы → один выполняет работу, второй получает `202 in_progress`.
- **PostgreSQL state machine**: `processing`, `retry_scheduled`, `completed`, `failed`, `needs_reconciliation`.
- **Независимые стадии** CRM / Journal / Telegram с восстановлением уже подтверждённых стадий.
- **Retry** для 429, 5xx, timeout и сетевых ошибок; exponential backoff + jitter.
- `Retry-After` учитывается, когда HTTP-ответ его предоставляет.
- **Schedule Trigger** раз в минуту возвращает в работу `retry_scheduled` и зависшие `processing`.
- **Безопасный ручной retry** конкретной операции и очистка старых завершённых операций.
- **HubSpot**: поиск по email, create/update, full-response handling, контролируемые ошибки.
- **Google Sheets CRM** — режим обратной совместимости с v0.1; **Google Sheets Journal** и **Errors** — отдельно.
- **Telegram** — опциональные уведомления.
- **Header Auth** на webhook.
- Конфигурация v2; legacy v1 нормализуется автоматически.
- Время в Sheets/Telegram — в IANA timezone клиента; технические timestamps — UTC.

Стек: `docker.n8n.io/n8nio/n8n:2.46.6`, `postgres:17.11-alpine`, Docker Compose.

## Быстрый старт

Требования: Docker Compose и `python3` для onboarding-скриптов. `node` на хосте опционален: скрипты используют Node внутри контейнера n8n.

```bash
cp .env.example .env
# заполнить POSTGRES_PASSWORD, N8N_ENCRYPTION_KEY, LEAD_WEBHOOK_SECRET
docker compose up -d
./scripts/setup-client.sh   # создаёт config/client.json
./scripts/migrate.sh        # для существующего volume; новый volume применяет db/migrations автоматически
./scripts/import-workflow.sh
```

`setup-client.sh` создаёт `config/client.json`, помогает выбрать интеграции, timezone и проверяет конфиг. Каталог `./config` смонтирован в n8n целиком, поэтому изменения `client.json` видны без пересоздания контейнера; конфиг читается на каждый запрос.

> `import-workflow.sh` импортирует workflow без credentials. Для существующего клиента используйте n8n UI, чтобы не потерять назначенные credentials.

Назначьте credentials в n8n:

| Нода | Credential |
|---|---|
| `Lead Webhook` | Header Auth (`X-Webhook-Secret`) |
| `Reserve Operation`, все `Save * State`, `Select Due Operations` | PostgreSQL `leadOperationsPg` («CRM Automation Kit DB») |
| `CRM Adapter - Google Sheets`, `Journal Adapter`, `Error Log Adapter`, `Read CRM Leads`, `Read Journal` | Google Sheets OAuth2 / Service Account |
| `HubSpot Search/Create/Update Contact` | HubSpot Service Key / OAuth2 |
| `Notification Adapter - Telegram` | Telegram API |
| `Recovery Request` | тот же Header Auth, что у `Lead Webhook` |

Опубликуйте workflow и выполните:

```bash
./scripts/doctor.sh
```

Диагностика с реальной тестовой заявкой (создаст данные и может отправить уведомление):

```bash
./scripts/doctor.sh --integration-test
```

## HTTP-контракт

| Ситуация | HTTP | Основной статус |
|---|---|---|
| Новая заявка, CRM создала запись | `201` | `created` |
| Новая заявка, HubSpot обновил контакт | `200` | `updated` |
| Повтор завершённой операции | `200` | сохранённый статус + `replayed:true` |
| Тот же ключ, другие данные | `409` | `idempotency_conflict` |
| Одинаковая операция уже выполняется | `202` | `in_progress` |
| CRM retry запланирован | `202` | `retry_scheduled` / `crm_retry_scheduled` |
| Нужна ручная сверка (например, Telegram) | `202` | `needs_reconciliation` |
| CRM окончательно не сохранила | `502` | `crm_write_failed` |
| Ошибка конфигурации | `500` | `configuration_error` |
| Ошибка записи state store | `503` | `state_store_failed` |

`201` не возвращается, пока CRM не подтвердила создание. Для phone-only HubSpot заявки используется `202 crm_skipped` по политике `skip`.

## State store

Таблица `app.lead_operations` создаётся миграцией `db/migrations/001_lead_operations.sql`.

Основные функции:

- `app.reserve_lead_operation(...)` — атомарно создать/найти операцию и захватить её для recovery;
- `app.save_operation_state(uuid,jsonb)` — обновить стадии и ответ;
- `app.cleanup_lead_operations(retention_days)` — удалить только `completed`/`failed`.

Полезные команды:

```bash
./scripts/retry-operation.sh <operation-id>
./scripts/retry-operation.sh <operation-id> --reset-attempts
./scripts/cleanup-operations.sh --dry-run
./scripts/cleanup-operations.sh
```

`retry-operation.sh` отказывается работать с `completed` и активной `processing` операцией. Подтверждённые CRM/Journal-стадии сохраняются.

## Конфигурация

Основные блоки `config/client.json`:

- `source` — тип источника, default source, allowed sources.
- `timezone` — IANA timezone клиента.
- `mapping` — входные поля → внутренний Lead.
- `crm.provider` — `hubspot`, `google_sheets` или `none`.
- `crm.hubspot` / `crm.googleSheets` — настройки CRM.
- `journal` — независимый журнал Google Sheets.
- `notifications` — Telegram.
- `errors` — error log Google Sheets.
- `idempotency` — `enabled`, `retentionDays`, `withoutKeyPolicy` (`process_new`).
- `retry` — `maxAttempts`, `baseDelaySeconds`, `maxDelaySeconds`, `processingTimeoutSeconds`.

Пример: [`config/example-client.json`](config/example-client.json). Legacy v1 нормализуется в Google Sheets-only режим.

## Документация

- [Пошаговая настройка с нуля](docs/SETUP.md)
- [Google Sheets](docs/integrations/google-sheets.md)
- [Telegram](docs/integrations/telegram.md)
- [HubSpot](docs/integrations/hubspot.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

## Структура

```text
workflows/lead-intake.json      # v0.3 workflow (94 nodes)
config/example-client.json      # v2-шаблон конфига
config/example-legacy-google-sheets.json
config/client.json              # локальный конфиг клиента, gitignored
db/migrations/                  # PostgreSQL schema/functions
scripts/setup-client.sh         # интерактивный onboarding
scripts/migrate.sh              # применение миграций
scripts/doctor.sh               # диагностика + независимый API read-back
scripts/retry-operation.sh      # точечный ручной retry
scripts/cleanup-operations.sh   # retention cleanup
scripts/import-workflow.sh      # импорт для свежей установки
scripts/config-check.mjs        # валидация конфига тем же кодом, что в workflow
docs/                           # инструкции и troubleshooting
tests/                          # unit и smoke тесты
```

## Безопасность и ограничения

- `.env`, `config/client.json` и `config/*.local.json` не попадают в Git.
- В workflow нет credentials: их нужно назначить в n8n UI после импорта.
- Header Auth обязателен для webhook; секрет хранится в n8n credential и локальном `.env` для тестов.
- PII в executions ограничена retention: 7 дней / 5000 записей. Google Sheets Journal/Errors хранят PII отдельно и требуют собственной политики доступа/очистки.
- В `app.lead_operations` сохраняется raw payload; настройте retention и доступ к PostgreSQL.
- Время в Sheets/Telegram отображается в IANA timezone клиента; executions хранят UTC timestamp.
- Kit не гарантирует exactly-once для внешних API. Он предотвращает повторное выполнение подтверждённых стадий и помечает неоднозначные результаты как `needs_reconciliation`.
- Нет rate limiting на входящем webhook; Header Auth не заменяет rate limiting.
- Google Sheets не создаёт таблицы/вкладки/заголовки автоматически.
- Один webhook-запрос за execution.
- HubSpot Service Key — вариант по умолчанию; OAuth2 поддерживается после смены Credential Type в трёх HubSpot HTTP-нодах.
- Для phone-only HubSpot заявок поддерживается только `phoneOnlyPolicy=skip`.
