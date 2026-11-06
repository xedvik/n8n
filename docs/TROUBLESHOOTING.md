# Troubleshooting

Сначала всегда:

```bash
./scripts/doctor.sh
```

`doctor.sh` проверяет контейнеры, readiness, конфиг, активность workflow, Header Auth, назначение credentials и параметры. Он не подменяет реальный API-тест: для реальной заявки нужен `--integration-test`.

## HTTP-ответы

| Ответ | Что означает | Что проверить |
|---|---|---|
| `403` | Header Auth отсутствует/неверный | `LEAD_WEBHOOK_SECRET`, Header Auth credential, имя заголовка `X-Webhook-Secret`, restart n8n |
| `404` | webhook не зарегистрирован | workflow не опубликован/не активен, n8n не перезапущен после CLI publish |
| `400 validation_error` | заявка не прошла бизнес-валидацию | `details`: name и email/phone |
| `500 configuration_error` | конфиг не прочитан/невалиден | `detail`, `./scripts/config-check.mjs`, `setup-client.sh` |
| `502 crm_write_failed` | CRM не сохранил | credentials, scopes, spreadsheet/HubSpot ID, доступы, rate limit |
| `429 crm_rate_limited` | HubSpot rate limit после retries | подождать, уменьшить частоту, проверить execution |
| `201 created` | CRM создал запись/контакт | нормально |
| `200 updated` | HubSpot обновил существующий контакт | нормально |
| `202 crm_skipped` | CRM пропущен по политике | phone-only skip или ambiguous match; journal/notifications могли выполниться |

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

- `config/client.json` должен быть тем файлом, на который указывает `LEAD_CONFIG_FILE`.
- После изменения `LEAD_CONFIG_FILE`:

```bash
docker compose up -d
```

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
- При ошибке Telegram заявка уже сохранена: ответ `_with_notification_error`, `notified:false`, `warnings`, execution `error`.
- Если уведомления не нужны, `notifications.enabled=false`; credential не требуется.

## HubSpot

- `401/403`: неверный Service Key или нет scopes `crm.objects.contacts.read/write`.
- Если используете OAuth2, переключите **Credential Type** на всех трёх HubSpot-нодах и назначьте OAuth2 credential; по умолчанию используется Service Key.
- `400 Property ... does not exist`: создайте custom property или уберите его из `propertyMapping`.
- `429`: rate limit; 3 retries уже настроены, затем ответ `429 crm_rate_limited`.
- `502`: credential не назначен `HubSpot Search Contact` / `Create` / `Update`, неверный base URL или API error.
- Phone-only `202 crm_skipped` — это нормальная политика `skip`, не ошибка. Поиск/создание по телефону в v0.2 не поддерживается: нужна отдельная проверенная стратегия нормализации телефона.
- Несколько совпадений по email/phone → `ambiguous_match`, контакт не меняется.

## Частичные ошибки

- CRM успешна, Journal упал → CRM-ответ сохраняется, `journal.status=failed`, warning, execution `error`.
- CRM успешна, Telegram упал → `status=..._with_notification_error`, `notified=false`, warning, execution `error`.
- CRM упала → `502/429`, journal и notifications не выполняются, ошибка видна в execution и (если включён) в Errors.
- `Stop and Error` после отправки ответа нужен, чтобы execution получил статус `error`; клиент уже получил корректный HTTP-ответ.

## PII и executions

- Успешные и ошибочные executions содержат нормализованные данные заявки.
- Retention: `EXECUTIONS_DATA_PRUNE=true`, `EXECUTIONS_DATA_MAX_AGE=168` (7 дней), `EXECUTIONS_DATA_PRUNE_MAX_COUNT=5000`.
- Настройте значения под политику клиента и ограничьте доступ к БД/таблицам.
- Не коммитьте `.env`, `config/client.json`, credentials export и error logs.
