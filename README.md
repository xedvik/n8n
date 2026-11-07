# CRM Automation Kit v0.5

Переиспользуемый lead-intake kit для n8n: HTTP webhook → нормализация → валидация → идемпотентная операция в PostgreSQL → CRM → журнал → уведомления → HTTP-ответ.

## Один продукт, один стек

v0.5 убирает разделение Local/Server. Всегда используется один Docker Compose-стек:

```text
                 HTTPS :443
                     │
                  ┌──▼──┐
                  │Caddy│
                  └──┬──┘
          /setup/*   │   /, /webhook/*, /rest/*, /api/v1/*
          ┌──────────┴──────────┐
          ▼                     ▼
      ┌────────┐           ┌────────┐
      │ Wizard │           │  n8n   │
      └───┬────┘           └───┬────┘
          │  internal network  │
          └──────────┬─────────┘
                     ▼
                ┌─────────┐
                │Postgres │
                └─────────┘
```

- `/` — n8n UI, public API, OAuth callbacks.
- `/setup/` — полный мастер настройки и управления.
- `/webhook/` — webhook n8n.
- Caddy — единственный публичный контейнер; n8n, PostgreSQL и Wizard не публикуют порты на хост.
- Контейнеры запускаются автоматически после перезагрузки Docker (`restart: unless-stopped`).

## Установка

Требования на сервере: Linux, Docker Engine, Docker Compose plugin, `openssl`, `curl`, открытые TCP `80/443`, DNS-запись домена.

```bash
git clone <repository> /opt/crm-automation-kit
cd /opt/crm-automation-kit
sudo ./scripts/install-server.sh crm.example.com admin@example.com
```

Альтернативная проверка без установщика (тот же стек):

```bash
cp .env.example .env
# заменить CRM_DOMAIN, ACME_EMAIL и CHANGE_ME-секреты
docker compose up -d --build
```

При первом старте без installer-скрипта Wizard сам создаст `wizard-data/bootstrap-token`. Возьмите токен из этого файла и откройте `https://<domain>/setup/?token=<token>`; значение токена в логи не пишется.

Установщик — единственная точка развёртывания. Он:

1. создаёт `.env` и генерирует `POSTGRES_PASSWORD`, `N8N_ENCRYPTION_KEY`, `LEAD_WEBHOOK_SECRET`, `WIZARD_SECRET_KEY`;
2. создаёт `wizard-data/` и одноразовый bootstrap-токен;
3. собирает и запускает **один** Compose-стек: Caddy + n8n + PostgreSQL + Wizard;
4. применяет миграции и импортирует workflow, если его ещё нет;
5. печатает first-run URL вида `https://<domain>/setup/?token=...`.

Node.js и отдельный процесс мастера на хосте не требуются. Все действия после развёртывания выполняются в браузере.

### Первый вход

1. Откройте `https://<domain>/` и создайте owner-аккаунт n8n.
2. Откройте `https://<domain>/settings/api` и создайте API key со scopes:
   - `workflow:read`
   - `workflow:update`
   - `workflow:activate`
   - `credential:list`
   - `credential:read`
   - `credential:create`
3. Откройте first-run URL из вывода установщика.
4. Зарегистрируйте единственного администратора `/setup/`.
5. Подключите n8n API key в мастере.
6. Пройдите шаги настройки и завершите тестовой заявкой.

Повторная регистрация закрыта. Пароль хранится как scrypt-hash, сессия — в HttpOnly/SameSite=Strict/Secure cookie с HMAC-подписью. Bootstrap-токен удаляется после регистрации.

## Полный onboarding

`/setup/` построен как пять последовательных этапов:

1. **Начало работы** — подключение n8n, адрес приёма заявок и OAuth callback.
2. **Настройка компании** — название и часовой пояс.
3. **Подключение интеграций** — HubSpot, Google Sheets, Telegram, источники заявок.
4. **Проверка и запуск** — безопасное применение, проверка системы и тестовая заявка.
5. **Готово** — панель состояния и переход к работе.

Технические параметры находятся в **«Дополнительных настройках»**, а операции, резервные копии и проверка сервисов — в **«Обслуживании»**.

Внешние сервисы открываются по ссылкам. Где API не позволяет автоматизацию (OAuth Connect, шаринг Google-таблицы), мастер объясняет точное действие в браузере.

## Что сохраняется

- `config/client.json` — конфигурация клиента, mode `0600`, атомарная запись, backup `config/.client-config.*.json`.
- `wizard-data/` — администратор, сессии, зашифрованный n8n API key, bootstrap-токен.
- `n8n_data` — credentials, workflow state.
- `postgres_data` — state machine и данные.
- `caddy_data` / `caddy_config` — TLS-сертификаты.

n8n API key шифруется AES-256-GCM с ключом, производным от `WIZARD_SECRET_KEY`; в браузер, DOM, storage и логи он не попадает.

## Основные команды

```bash
# статус
docker compose ps

# логи
docker compose logs -f caddy n8n wizard postgres

# обновление кода
git pull --ff-only
sudo ./scripts/install-server.sh crm.example.com admin@example.com

# остановка без удаления данных
docker compose down
```

CLI-скрипты (`doctor.sh`, `retry-operation.sh`, `import-workflow.sh`, `migrate.sh`) сохранены для разработки и аварийной диагностики. Для штатной настройки и управления они не нужны: всё доступно в `/setup/`.

## HTTP-контракт заявок

| Ситуация | HTTP | Статус |
|---|---|---|
| Новая заявка, CRM создала запись | `201` | `created` |
| HubSpot обновил контакт | `200` | `updated` |
| Повтор завершённой операции | `200` | сохранённый статус + `replayed:true` |
| Тот же ключ, другой payload | `409` | `idempotency_conflict` |
| Операция уже выполняется | `202` | `in_progress` |
| CRM retry запланирован | `202` | `retry_scheduled` |
| Нужна ручная сверка | `202` | `needs_reconciliation` |
| CRM окончательно не сохранила | `502` | `crm_write_failed` |
| Ошибка конфигурации | `500` | `configuration_error` |

Webhook: `https://<domain>/webhook/lead-intake`, Header Auth обязателен.

## Документация

- [Установка и эксплуатация единого стека](docs/SERVER.md)
- [Мастер `/setup/`](docs/WIZARD.md)
- [Пошаговая настройка и внутренние детали](docs/SETUP.md)
- [Google Sheets](docs/integrations/google-sheets.md)
- [Telegram](docs/integrations/telegram.md)
- [HubSpot](docs/integrations/hubspot.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

## Структура

```text
docker-compose.yml       # единый стек: Caddy, n8n, PostgreSQL, Wizard
Caddyfile                # единственный HTTPS ingress
wizard/                  # backend + static UI; Dockerfile
scripts/install-server.sh# one-command deployment
scripts/doctor.sh        # диагностика/read-back (используется мастером)
scripts/import-workflow.sh
scripts/migrate.sh
scripts/retry-operation.sh
scripts/cleanup-operations.sh
workflows/lead-intake.json
config/example-client.json
db/migrations/
tests/
docs/
```

## Безопасность и ограничения

- Публично доступны только Caddy `80/443`; n8n, PostgreSQL и Wizard — только внутри Compose-сети.
- Административный интерфейс защищён логином; setup API требует CSRF-токен и сессию.
- Секреты не возвращаются в API и не пишутся в браузерное storage.
- Docker socket смонтирован в Wizard только для существующих doctor/import/recovery скриптов; это требует доверия к контейнеру и root-доступу на хосте.
- Компрометация root на хосте раскрывает `.env`, Docker volumes и ключи. Нужны full-disk encryption, ограниченный SSH и firewall.
- Kit не гарантирует exactly-once для внешних API; неоднозначные стадии помечаются `needs_reconciliation`.
- Google Sheets не создаёт произвольную структуру вне заданных вкладок/заголовков.
- OAuth2 HubSpot/Google требует ручного Connect в n8n.
