# Настройка CRM Automation Kit v0.3

Руководство от чистого окружения до первой обработанной заявки. Обязательные шаги отмечены, необязательные интеграции можно пропускать. v0.3 требует PostgreSQL state store; для существующего Docker volume примените миграции.

## 1. Требования

- Docker с Compose v2.
- Свободный локальный порт `5678`.
- `python3` на хосте для `setup-client.sh` и `doctor.sh`.
- `node` на хосте не обязателен: скрипты используют Node внутри контейнера n8n, если его нет на хосте.
- Для HubSpot — аккаунт HubSpot и private app access token (Service Key).
- Для Google Sheets — Google-аккаунт и Google Cloud project.
- Для Telegram — аккаунт Telegram.

## 2. Запуск Docker и n8n

```bash
cp .env.example .env
```

Заполните `.env`:

```dotenv
POSTGRES_PASSWORD=<сильный пароль>
N8N_ENCRYPTION_KEY=<openssl rand -hex 32>
LEAD_WEBHOOK_SECRET=<openssl rand -hex 32>
LEAD_CONFIG_FILE=./config/client.json
```

`N8N_ENCRYPTION_KEY` нельзя менять после сохранения credentials: n8n не расшифрует их. Сохраните ключ в менеджере секретов.

```bash
docker compose up -d
docker compose ps
```

Для **нового** PostgreSQL volume миграции из `db/migrations` применяются автоматически при инициализации. Для существующего volume выполните:

```bash
./scripts/migrate.sh
```

Дождитесь статуса `healthy` у обоих контейнеров. UI: <http://localhost:5678>. При первом открытии создайте owner-аккаунт.

Если n8n открывается по `127.0.0.1`, используйте этот же host в OAuth redirect URI. Не смешивайте `localhost` и `127.0.0.1` — иначе Google OAuth вернёт `Unauthorized` или ошибку redirect.

## 3. Создание конфигурации клиента

```bash
./scripts/setup-client.sh
```

Скрипт:

- создаёт `config/client.json` из `config/example-client.json`;
- спрашивает CRM-провайдера (`hubspot`, `google_sheets`, `none`);
- спрашивает IANA timezone клиента (например, `Asia/Tbilisi`);
- включает/выключает журнал, Telegram и error log;
- запрашивает только несекретные параметры;
- проверяет конфиг тем же валидатором, что workflow;
- при повторном запуске сохраняет существующие настройки;
- не записывает токены и секреты.

Контейнер монтирует весь каталог `./config` в `/home/node/config` и всегда читает `client.json`. Изменения содержимого `client.json` подхватываются на следующем запросе без пересоздания контейнера.

`LEAD_CONFIG_FILE` в `.env` используется `doctor.sh` и должен указывать на `./config/client.json`. `setup-client.sh` пишет в `CONFIG_FILE` (по умолчанию `config/client.json`). Если вы меняли compose-файл/volume — выполните `docker compose up -d`.

Секреты и OAuth-токены в `client.json` не хранятся. Их место — credentials n8n.

## 4. Google Sheets

Google Sheets может быть:

- CRM-хранилищем (`crm.provider=google_sheets`) — режим обратной совместимости v0.1;
- независимым журналом (`journal.enabled=true`);
- хранилищем ошибок (`errors.enabled=true`).

Подробно: [Google Sheets](integrations/google-sheets.md).

Кратко:

1. Создайте таблицу и вкладки с заголовками (см. инструкцию).
2. Создайте credential **Google Sheets OAuth2 API** или **Google Service Account**.
3. Укажите spreadsheet ID и имена вкладок в `config/client.json`.
4. Назначьте credential нодам:
   - `CRM Adapter - Google Sheets` — если CRM = Google Sheets;
   - `Journal Adapter - Google Sheets` — если журнал включён;
   - `Error Log Adapter - Google Sheets` — если error log включён.

Если Google Sheets не используется, пропустите шаг; ноды не будут выполняться.

## 5. Telegram

Подробно: [Telegram](integrations/telegram.md).

Кратко:

1. Создайте бота через `@BotFather`.
2. Создайте credential **Telegram API**.
3. Добавьте бота в чат/группу и получите `chatId`.
4. Включите `notifications.enabled` и укажите `notifications.telegram.chatId`.
5. Назначьте credential ноде `Notification Adapter - Telegram`.

Если уведомления не нужны, установите `notifications.enabled=false`; credential не требуется.

## 6. HubSpot

Подробно: [HubSpot](integrations/hubspot.md).

Кратко:

1. Создайте HubSpot private app с scopes `crm.objects.contacts.read` и `crm.objects.contacts.write`.
2. Скопируйте access token (Service Key) и создайте credential **HubSpot Service Key**.
3. В `config/client.json` выберите `crm.provider=hubspot`.
4. Назначьте credential трём нодам:
   - `HubSpot Search Contact`;
   - `HubSpot Create Contact`;
   - `HubSpot Update Contact`.
5. Проверьте `propertyMapping`: ключи — HubSpot properties, значения — поля Lead.

Если вы сознательно используете **HubSpot OAuth2 API**, переключите Credential Type на всех трёх HTTP-нодах и назначьте OAuth2 credential. По умолчанию используется Service Key.

По умолчанию и единственная поддерживаемая политика — `phoneOnlyPolicy=skip`: заявка только с телефоном не создаёт контакт и не ищет дубликаты вслепую. Ответ — `202 crm_skipped`, журнал/уведомления при этом могут продолжить работу. Поиск/создание по телефону требует отдельной проверенной стратегии нормализации и появится в следующей версии.

## 7. Назначение credentials нодам

Откройте workflow в n8n и назначьте:

| Нода | Credential |
|---|---|
| `Lead Webhook` | Header Auth (`X-Webhook-Secret` = `LEAD_WEBHOOK_SECRET`) |
| `Reserve Operation` | PostgreSQL credential `leadOperationsPg` («CRM Automation Kit DB») |
| `Save CRM State`, `Save CRM Failure State` | тот же PostgreSQL credential |
| `Save Journal State`, `Save Journal Failure State`, `Save Notification State`, `Save Final State` | тот же PostgreSQL credential |
| `Select Due Operations` | тот же PostgreSQL credential |
| `Recovery Request` | тот же Header Auth, что у `Lead Webhook` |
| `CRM Adapter - Google Sheets` | Google Sheets OAuth2 или Service Account |
| `Journal Adapter - Google Sheets` | Google Sheets OAuth2 или Service Account |
| `Error Log Adapter - Google Sheets` | Google Sheets OAuth2 или Service Account |
| `Notification Adapter - Telegram` | Telegram API |
| `HubSpot Search Contact` | HubSpot Service Key |
| `HubSpot Create Contact` | HubSpot Service Key |
| `HubSpot Update Contact` | HubSpot Service Key |

PostgreSQL credential создаётся в n8n как **Postgres** с теми же host/database/user/password, что в `.env` (host `postgres`, database/user из `POSTGRES_*`). Он нужен всем state/recovery-нодам, а не только CRM. `doctor.sh` проверяет его назначение отдельно.

Не назначайте credential неиспользуемым интеграциям без необходимости. `doctor.sh` проверяет только включённые в конфиге интеграции, плюс обязательный PostgreSQL state store.

### Header Auth

Создайте в n8n credential **Header Auth**:

- Name: `X-Webhook-Secret`;
- Value: значение `LEAD_WEBHOOK_SECRET` из `.env`.

Назначьте его `Lead Webhook`. Без credential или с другим значением webhook вернёт `403` до выполнения workflow.

## 8. Импорт и активация workflow

Для свежей установки:

```bash
./scripts/import-workflow.sh
```

Скрипт применяет миграции, импортирует `workflows/lead-intake.json`, публикует workflow и перезапускает n8n. После перезапуска назначьте credentials: импорт не содержит секретов.

Для уже настроенного клиента используйте n8n UI. Скрипт импорта откажется перезаписывать существующий workflow без `ALLOW_REIMPORT=1`, потому что credential-free импорт может стереть назначенные credentials.

В n8n 2.x после публикации через CLI может потребоваться перезапуск процесса; скрипт делает это автоматически. После изменений в UI опубликуйте workflow и убедитесь, что он активен.

## 9. Тестирование

Без записи в CRM/журнал и без уведомлений:

```bash
./scripts/doctor.sh
```

С реальной тестовой заявкой (создаст данные, может отправить Telegram):

```bash
./scripts/doctor.sh --integration-test
```

Ручная проверка:

```bash
curl -i -X POST http://localhost:5678/webhook/lead-intake \
  -H 'Content-Type: application/json' \
  -H "X-Webhook-Secret: ${LEAD_WEBHOOK_SECRET}" \
  --data @examples/valid-lead.json
```

Ожидаемые статусы:

- `201` — создан контакт/строка CRM;
- `200` — обновлён существующий HubSpot contact или повтор завершённой операции (`replayed:true`);
- `202 crm_skipped` — CRM пропущен по политике (например, phone-only при `skip`);
- `202 in_progress` — такая же операция уже выполняется;
- `202 retry_scheduled` — CRM/Journal retry запланирован; смотрите `retryAt`;
- `202 needs_reconciliation` — часть действий подтверждена, но есть неоднозначная стадия;
- `409 idempotency_conflict` — тот же ключ использован с другими данными;
- `400` — validation error;
- `403` — неверный/отсутствующий Header Auth;
- `500` — ошибка конфигурации;
- `502` — CRM окончательно не сохранил заявку;
- `503 state_store_failed` — не удалось записать состояние; успех не подтверждён.

Проверьте, что:

- строка появилась в CRM/журнале;
- Telegram-сообщение пришло (если включён);
- в случае ошибки в n8n `Executions` есть запись со статусом `error`;
- error log содержит ошибку, если он включён;
- в `app.lead_operations` операция имеет ожидаемый `status` и стадии CRM/Journal/Telegram.

## 10. Диагностика

Начните с:

```bash
./scripts/doctor.sh
```

Он проверяет контейнеры, readiness, конфиг, timezone, активность workflow, совпадение конфига в контейнере, Header Auth, назначение credentials и параметры. При `--integration-test` отправляет одну реальную заявку и делает **независимый read-back**: HubSpot contact по ID и email, строку Journal и отсутствие ошибочной записи в Leads (или строку Google Sheets CRM в режиме `google_sheets`).

Типовые проблемы: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## 11. Чеклист нового клиента

- [ ] `.env` создан, ключи сгенерированы, `.env` не в Git.
- [ ] `docker compose up -d` — оба контейнера healthy.
- [ ] `./scripts/setup-client.sh` завершён, `config/client.json` создан.
- [ ] `config/client.json` создан; `LEAD_CONFIG_FILE` указывает на него для `doctor.sh`.
- [ ] `timezone` задан как IANA timezone клиента (например, `Asia/Tbilisi`).
- [ ] Выбраны CRM/journal/notifications/errors.
- [ ] Созданы нужные credentials в n8n и назначены нодам.
- [ ] Header Auth назначен `Lead Webhook`.
- [ ] Workflow опубликован/активен.
- [ ] `./scripts/doctor.sh` — PASS.
- [ ] `./scripts/doctor.sh --integration-test` — PASS (или осознанно пропущен).
- [ ] PII retention и доступ к таблицам настроены под политику клиента.

## 12. Конфигурация v2

Основные блоки:

- `source` — тип источника (`webhook`), default source, allowed sources.
- `timezone` — IANA timezone клиента для отображения времени в Sheets/Telegram; технические timestamps остаются UTC.
- `mapping` — входные поля → внутренний Lead.
- `crm.provider` — `hubspot`, `google_sheets` или `none`.
- `crm.hubspot.propertyMapping` — HubSpot property → поле Lead.
- `crm.googleSheets` — CRM-таблица для режима Google Sheets.
- `journal` — независимый журнал (Google Sheets), включается отдельно.
- `notifications` — каналы и Telegram.
- `errors` — error log (Google Sheets), включается отдельно.
- `idempotency` — `enabled`, `retentionDays`, `withoutKeyPolicy` (`process_new`).
- `retry` — `maxAttempts`, `baseDelaySeconds`, `maxDelaySeconds`, `processingTimeoutSeconds`.

Legacy v1-конфиг без `version` автоматически нормализуется в Google Sheets-only режим: `crm.provider=google_sheets`, `journal.enabled=false`, Telegram/error log включены. Это сохраняет обратную совместимость с v0.1.

## 13. Идемпотентность и recovery

Ключ идемпотентности выбирается так:

1. `external_id` из заявки (если задан);
2. иначе заголовок `Idempotency-Key`;
3. если ключа нет — создаётся новая операция (`withoutKeyPolicy=process_new`).

Повтор с тем же ключом и теми же значимыми данными возвращает сохранённый результат. Другие данные → `409`. Конкурентный запрос → `202 in_progress`.

Состояние операции и стадий хранится в `app.lead_operations`. Подтверждённые CRM/Journal/Telegram-стадии не выполняются повторно. При 429/5xx/timeout CRM или Journal операция получает `retry_scheduled`; Schedule Trigger раз в минуту отправляет recovery-запрос. Неоднозначные результаты (например, Telegram) получают `needs_reconciliation` и не переотправляются автоматически.

Ручные команды:

```bash
./scripts/retry-operation.sh <operation-id>
./scripts/retry-operation.sh <operation-id> --reset-attempts
./scripts/cleanup-operations.sh --dry-run
./scripts/cleanup-operations.sh
```

`retry-operation.sh` отказывается работать с `completed` и активной `processing` операцией. `cleanup-operations.sh` удаляет только `completed`/`failed` старше `idempotency.retentionDays`.

## 14. PostgreSQL state credential

Кроме стандартных интеграций, workflow использует PostgreSQL:

- host: `postgres`;
- database/user/password: значения `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` из `.env`;
- credential type: **Postgres**;
- назначить нодам `Reserve Operation`, `Save * State`, `Select Due Operations`.

Без этого credential новые заявки завершатся `503 state_store_failed`; ложного `201` не будет.
