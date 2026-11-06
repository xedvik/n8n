# CRM Automation Kit v0.2

Переиспользуемый lead-intake kit для n8n: HTTP webhook → нормализация → валидация → CRM-адаптер → опциональный журнал → опциональные уведомления → HTTP-ответ.

Поддерживаются:
- **HubSpot**: поиск по email, создание/обновление контакта, безопасная политика для phone-only заявок, нормализованный результат, retries и обработка 429.
- **Google Sheets как CRM** — режим обратной совместимости с v0.1.
- **Google Sheets как независимый журнал** — включается отдельно от CRM.
- **Telegram** — опциональные уведомления.
- **Header Auth** на webhook.
- Конфигурация v2 и автоматическая нормализация legacy v1.

Стек: `docker.n8n.io/n8nio/n8n:2.46.6`, `postgres:17.11-alpine`, Docker Compose.

## Быстрый старт

Требования: Docker Compose, `python3` для onboarding-скриптов. `node` на хосте опционален: скрипты умеют использовать Node внутри контейнера n8n.

```bash
cp .env.example .env
# заполнить POSTGRES_PASSWORD, N8N_ENCRYPTION_KEY, LEAD_WEBHOOK_SECRET
docker compose up -d
./scripts/setup-client.sh
```

`setup-client.sh` создаст `config/client.json`, поможет выбрать интеграции и проверит конфиг. Затем:

```bash
# указать в .env:
# LEAD_CONFIG_FILE=./config/client.json
docker compose up -d
```

Импорт workflow:
- новая установка — `./scripts/import-workflow.sh`;
- обновление существующего клиента — через n8n UI, не credential-free импортом.

Назначьте credentials в n8n, опубликуйте workflow и выполните:

```bash
./scripts/doctor.sh
```

Диагностика с реальной тестовой заявкой (создаст данные и может отправить уведомление):

```bash
./scripts/doctor.sh --integration-test
```

## Документация

- [Пошаговая настройка с нуля](docs/SETUP.md)
- [Google Sheets](docs/integrations/google-sheets.md)
- [Telegram](docs/integrations/telegram.md)
- [HubSpot](docs/integrations/hubspot.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

## Структура

```text
workflows/lead-intake.json      # v0.2 workflow
config/example-client.json      # v2-шаблон конфига
config/example-legacy-google-sheets.json
config/client.json              # локальный конфиг клиента, gitignored
scripts/setup-client.sh         # интерактивный onboarding
scripts/doctor.sh               # диагностика
scripts/config-check.mjs        # валидация конфига тем же кодом, что в workflow
scripts/import-workflow.sh      # импорт для свежей установки
docs/                           # инструкции и troubleshooting
tests/                          # unit и smoke тесты
```

## Безопасность

- `.env`, `config/client.json` и `config/*.local.json` не попадают в Git.
- В workflow нет credentials: их нужно назначить в n8n UI после импорта.
- Header Auth обязателен для webhook; секрет хранится в n8n credential и локальном `.env` для тестов.
- PII в executions ограничена retention: 7 дней / 5000 записей. Google Sheets Journal/Errors хранят PII отдельно и требуют собственной политики доступа/очистки.
- `config/client.json` содержит только несекретные параметры. Токены и OAuth-ключи хранятся только в n8n credentials.

## Ограничения v0.2

- Реальный HubSpot API не проверялся без клиентских credentials; автоматические тесты покрывают mapping, маршрутизацию, skip/error-ветки и HTTP-контракт.
- Нет дедупликации по `external_id` и отдельной retry-очереди.
- Google Sheets не создаёт таблицы/вкладки/заголовки автоматически.
- Один webhook-запрос за execution.
- Нет rate limiting на входящем webhook (Header Auth не заменяет rate limiting).
- HubSpot Service Key — вариант по умолчанию; OAuth2 поддерживается после смены Credential Type в трёх HTTP Request нодах.
