# Troubleshooting

Сначала всегда:

```bash
./scripts/doctor.sh
```

При `--integration-test` doctor проверяет не только HTTP-ответ, но и реальную запись через независимый n8n HTTP Request: HubSpot contact по ID/email, Journal и Leads/CRM-вкладку.

`doctor.sh` проверяет контейнеры, readiness, конфиг, активность workflow, Header Auth, назначение credentials и параметры. Он не подменяет реальный API-тест: для реальной заявки нужен `--integration-test`.

## HTTP-ответы

| Ответ | Что означает | Что проверить |
|---|---|---|
| `403` | Header Auth отсутствует/неверный | `LEAD_WEBHOOK_SECRET`, Header Auth credential, имя заголовка `X-Webhook-Secret`, restart n8n |
| `404` | webhook не зарегистрирован | workflow не опубликован/не активен, n8n не перезапущен после CLI publish |
| `400 validation_error` | заявка не прошла бизнес-валидацию | `details`: name и email/phone |
| `500 configuration_error` | конфиг не прочитан/невалиден | `detail`, `./scripts/config-check.mjs`, `setup-client.sh` |
| `502 crm_write_failed` | CRM окончательно не сохранил | credentials, scopes, spreadsheet/HubSpot ID, доступы, лимиты |
| `503 state_store_failed` | не удалось записать состояние операции | PostgreSQL credential, `./scripts/migrate.sh`, доступ к `app.lead_operations`; успех не подтверждён |
| `409 idempotency_conflict` | тот же ключ, другие данные | используйте новый `external_id`/`Idempotency-Key` или проверьте payload |
| `202 retry_scheduled` | retry запланирован | смотрите `retryAt`, `app.lead_operations`, Schedule Trigger |
| `202 in_progress` | такая же операция уже выполняется | не отправляйте повторно; дождитесь завершения |
| `202 needs_reconciliation` | часть стадий подтверждена, есть неоднозначная | проверьте `crm`/`journal`/`notifications` и выполните ручную сверку |
| `201 created` | CRM создал запись/контакт | нормально |
| `200 updated` | HubSpot обновил существующий контакт | нормально |
| `200 replayed:true` | повтор завершённой операции | нормально; внешние действия не повторялись |
| `202 crm_skipped` | CRM пропущен по политике | phone-only skip или ambiguous match; journal/notifications могли выполниться |

## Операции и recovery

- Посмотреть состояние: `select id,status,crm_status,journal_status,telegram_status,attempts,next_attempt_at,last_error from app.lead_operations order by created_at desc limit 20;`
- `retry_scheduled` с прошедшим `next_attempt_at`: проверьте Schedule Trigger executions и `Select Due Operations`.
- `processing` дольше `processingTimeoutSeconds`: recovery заберёт операцию; pre-filter расписания проверяет `processing` старше 5 минут, поэтому при значении меньше 300 секунд восстановление может занять до 5 минут. Авторитетный гейт — `reserve_lead_operation`; не запускайте второй webhook вручную.
- `needs_reconciliation`: автоматического retry нет. Проверьте внешний результат и решите, нужен ли ручной retry.
- Ручной retry: `./scripts/retry-operation.sh <operation-id>`; `--reset-attempts` только после понимания причины.
- Очистка: `./scripts/cleanup-operations.sh --dry-run`, затем без флага.
- Не удаляйте операции со статусами `retry_scheduled`/`processing`/`needs_reconciliation` без разбора.

## Header Auth

Симптом: `403 Authorization data is wrong!`.

1. В `.env` есть `LEAD_WEBHOOK_SECRET`.
2. В n8n credential **Header Auth**:
   - Name: `X-Webhook-Secret`;
   - Value: точно значение из `.env`.
3. Credential назначен ноде `Lead Webhook`.
4. После изменения credential/workflow n8n перезапущен/опубликован.
5. `doctor.sh` показывает 403 без заголовка и 400 с корректным заголовком.

## Workflow не отвечает

- `n8n list:workflow --active=true` должен содержать workflow ID.
- После `n8n publish:workflow` через CLI сделайте `docker compose restart n8n` — webhook подхватывается процессом при старте.
- Проверьте `docker compose logs --tail=100 n8n`.
- Если импортировали credential-free workflow поверх настроенного, credentials могли очиститься. Назначьте их заново.

## Конфиг

- Контейнер монтирует весь `./config` и всегда читает `config/client.json`; `LEAD_CONFIG_FILE` должен указывать на этот файл для host-скриптов.
- После изменения `config/client.json` конфиг читается на следующем запросе; если менялся compose/volume — `docker compose up -d`.
- Если Doctor сообщает, что контейнер использует другой конфиг, пересоздайте n8n: `docker compose up -d`.
- Пустая вкладка Journal: создайте заголовки первой строкой (см. Google Sheets integration).
- Время в Sheets/Telegram не совпадает: проверьте `timezone` в конфиге (IANA), например `Asia/Tbilisi`; технические timestamps в executions остаются UTC.

- `doctor.sh` сравнивает hash файла на хосте и в контейнере; если они разные — конфиг не перемонтирован.
- `node scripts/config-check.mjs config/client.json` покажет ошибку валидатора.
- Legacy v1-конфиг без `version` поддерживается и нормализуется в Google Sheets-only.
- Ошибки конфигурации не пишутся в `Errors`: конфиг ещё не прочитан; смотрите execution и тело `500`.

## Google OAuth: Unauthorized / redirect_uri_mismatch

- Откройте n8n по тому же host, который указан в redirect URI: `localhost` ≠ `127.0.0.1`.
- Redirect URI должен точно совпадать, включая `http/https`, порт и path:

```text
http://localhost:5678/rest/oauth2-credential/callback
```

- В Google Cloud включены **Google Sheets API** и **Google Drive API**.
- OAuth consent screen завершён; для External/Testing аккаунт добавлен в Test users.
- Client ID/Secret от того же OAuth client.
- Если токен отозван/истёк — переподключите credential.
- За reverse proxy задайте публичный URL n8n и используйте https redirect.

## Google Sheets: 502 / Unauthorized / нет строки

- Credential назначен всем включённым Google Sheets-нодам: CRM, Journal, Error Log.
- Spreadsheet ID взят из URL таблицы.
- Для service account таблица расшарена на email `...iam.gserviceaccount.com`.
- Вкладка существует и называется точно как в конфиге.
- Заголовки в первой строке точно совпадают с `columns` (регистр и пробелы важны).
- Для Google Sheets как CRM Journal не должен указывать на ту же вкладку; валидатор это отклоняет.
- `Cell Format=RAW` уже включён в workflow; телефон сохраняется строкой.
- Квоты Google API и размер таблицы не исчерпаны.
- Ошибка journal не отменяет CRM: смотрите `journal.status`, `warnings`, execution `error`; ошибка error log не отменяет HTTP-ответ.

## Telegram

- `400 chat not found`: неверный `chatId`, бот не добавлен в чат, для группы ID без минуса.
- `401 Unauthorized`: неверный token в credential.
- `403 bot was blocked`: разблокируйте бота.
- `403 bot is not a member`: добавьте бота в группу и дайте право писать.
- `chatId` группы отрицательный (`-100...`).
- Проверьте `parse_mode=HTML`: шаблон не должен содержать незакрытые теги.
- При ошибке Telegram заявка уже сохранена: ответ `202 needs_reconciliation`, `notified:false`, `warnings`; автоматической переотправки нет. Решение о повторной отправке принимает оператор.
- Если уведомления не нужны, `notifications.enabled=false`; credential не требуется.

## HubSpot: `crm=created`, но контакта нет

- `doctor.sh --integration-test` теперь делает независимый read-back через n8n HTTP Request: GET contact по ID и search по email. Если read-back PASS, контакт существует именно в том Portal ID, к которому привязан credential.
- Проверьте execution `Validate Client Config`: если там `crm.provider=google_sheets`, HubSpot-ветка не выполнялась; `crm=created` относится к Google Sheets.
- Проверьте, что контейнер читает актуальный `config/client.json`: `doctor.sh` сравнивает hash host/container.
- Если используется другой Portal ID, контакт будет в другом аккаунте; сверьте `portalId` через `GET /account-info/v3/details` с ожидаемым.

## Leads вместо Journal

- Проверьте в execution `Validate Client Config`: `crm.provider` и `journal.enabled`.
- Проверьте `Journal Enabled?` и `Journal Adapter - Google Sheets`: должен выполняться Journal adapter, а не CRM adapter.
- Journal должен иметь заголовки в первой строке; пустая вкладка не заполняется автоматически.
- `doctor.sh --integration-test` проверяет Journal row и отсутствие ошибочной записи в Leads для HubSpot-режима.

## HubSpot

- `401/403`: неверный Service Key или нет scopes `crm.objects.contacts.read/write`.
- Если используете OAuth2, переключите **Credential Type** на всех трёх HubSpot-нодах и назначьте OAuth2 credential; по умолчанию используется Service Key.
- `400 Property ... does not exist`: создайте custom property или уберите его из `propertyMapping`.
- `429`: rate limit; операция получает `202 retry_scheduled` с `Retry-After`, если он был в HTTP-ответе, иначе exponential backoff. После `maxAttempts` — окончательная ошибка.
- `502`: credential не назначен `HubSpot Search Contact` / `Create` / `Update`, неверный base URL или окончательная API error.
- Phone-only `202 crm_skipped` — это нормальная политика `skip`, не ошибка. Поиск/создание по телефону в v0.3 не поддерживается: нужна отдельная проверенная стратегия нормализации телефона.
- Несколько совпадений по email/phone → `ambiguous_match`, контакт не меняется.

## Частичные ошибки

- CRM успешна, Journal transient-ошибка → `202 retry_scheduled`; recovery повторяет только Journal, CRM не дублируется.
- CRM успешна, Journal permanent-ошибка → `202 needs_reconciliation`, `journal.status=failed`; автоматического retry нет.
- CRM успешна, Telegram упал → `202 needs_reconciliation`, `notified=false`; автоматической переотправки нет.
- CRM упала окончательно → `502`; транзиентная ошибка → `202 retry_scheduled`. Journal и notifications не выполняются до успешного CRM-этапа; ошибка видна в execution и (если включён) в Errors.
- `Stop and Error` после отправки ответа нужен, чтобы execution получил статус `error`; клиент уже получил корректный HTTP-ответ.

## PII и executions

- Успешные и ошибочные executions содержат нормализованные данные заявки.
- Retention: `EXECUTIONS_DATA_PRUNE=true`, `EXECUTIONS_DATA_MAX_AGE=168` (7 дней), `EXECUTIONS_DATA_PRUNE_MAX_COUNT=5000`.
- Настройте значения под политику клиента и ограничьте доступ к БД/таблицам.
- Не коммитьте `.env`, `config/client.json`, credentials export и error logs.
