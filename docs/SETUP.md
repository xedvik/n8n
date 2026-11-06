# Настройка CRM Automation Kit v0.2

Руководство от чистого окружения до первой обработанной заявки. Обязательные шаги отмечены, необязательные интеграции можно пропускать.

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

Дождитесь статуса `healthy` у обоих контейнеров. UI: <http://localhost:5678>. При первом открытии создайте owner-аккаунт.

Если n8n открывается по `127.0.0.1`, используйте этот же host в OAuth redirect URI. Не смешивайте `localhost` и `127.0.0.1` — иначе Google OAuth вернёт `Unauthorized` или ошибку redirect.

## 3. Создание конфигурации клиента

```bash
./scripts/setup-client.sh
```

Скрипт:

- создаёт `config/client.json` из `config/example-client.json`;
- спрашивает CRM-провайдера (`hubspot`, `google_sheets`, `none`);
- включает/выключает журнал, Telegram и error log;
- запрашивает только несекретные параметры;
- проверяет конфиг тем же валидатором, что workflow;
- при повторном запуске сохраняет существующие настройки;
- не записывает токены и секреты.

После создания проверьте:

```bash
grep '^LEAD_CONFIG_FILE=' .env
docker compose up -d
```

Если `LEAD_CONFIG_FILE` указывает на другой файл, пересоздайте контейнер. Файл монтируется в контейнер как `/home/node/config/client.json`.

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
| `CRM Adapter - Google Sheets` | Google Sheets OAuth2 или Service Account |
| `Journal Adapter - Google Sheets` | Google Sheets OAuth2 или Service Account |
| `Error Log Adapter - Google Sheets` | Google Sheets OAuth2 или Service Account |
| `Notification Adapter - Telegram` | Telegram API |
| `HubSpot Search Contact` | HubSpot Service Key |
| `HubSpot Create Contact` | HubSpot Service Key |
| `HubSpot Update Contact` | HubSpot Service Key |

Не назначайте credential неиспользуемым интеграциям без необходимости. `doctor.sh` проверяет только включённые в конфиге интеграции.

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

Скрипт импортирует `workflows/lead-intake.json`, публикует workflow и перезапускает n8n. После перезапуска назначьте credentials: импорт не содержит секретов.

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
- `200` — обновлён существующий HubSpot contact;
- `202` — CRM пропущен по политике (например, phone-only при `skip`), но заявка принята;
- `400` — validation error;
- `403` — неверный/отсутствующий Header Auth;
- `500` — ошибка конфигурации;
- `502` — CRM не сохранил заявку;
- `429` — HubSpot rate limit после retries.

Проверьте, что:

- строка появилась в CRM/журнале;
- Telegram-сообщение пришло (если включён);
- в случае ошибки в n8n `Executions` есть запись со статусом `error`;
- error log содержит ошибку, если он включён.

## 10. Диагностика

Начните с:

```bash
./scripts/doctor.sh
```

Он проверяет контейнеры, readiness, конфиг, активность workflow, совпадение конфига в контейнере, Header Auth, назначение credentials и параметры. При `--integration-test` отправляет одну реальную заявку.

Типовые проблемы: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## 11. Чеклист нового клиента

- [ ] `.env` создан, ключи сгенерированы, `.env` не в Git.
- [ ] `docker compose up -d` — оба контейнера healthy.
- [ ] `./scripts/setup-client.sh` завершён, `config/client.json` создан.
- [ ] `LEAD_CONFIG_FILE` указывает на нужный файл, n8n пересоздан.
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
- `mapping` — входные поля → внутренний Lead.
- `crm.provider` — `hubspot`, `google_sheets` или `none`.
- `crm.hubspot.propertyMapping` — HubSpot property → поле Lead.
- `crm.googleSheets` — CRM-таблица для режима Google Sheets.
- `journal` — независимый журнал (Google Sheets), включается отдельно.
- `notifications` — каналы и Telegram.
- `errors` — error log (Google Sheets), включается отдельно.

Legacy v1-конфиг без `version` автоматически нормализуется в Google Sheets-only режим: `crm.provider=google_sheets`, `journal.enabled=false`, Telegram/error log включены. Это сохраняет обратную совместимость с v0.1.
