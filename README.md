# CRM Automation Kit — MVP v0.1

Переиспользуемый комплект n8n для приёма заявок: HTTP webhook → нормализация → валидация → Google Sheets → Telegram. Рассчитан на быстрый запуск у клиента и замену CRM/уведомлений без переписывания основной логики.

## Что внутри

| Файл | Назначение |
|---|---|
| `docker-compose.yml` | n8n + PostgreSQL, фиксированные версии образов, healthchecks, volumes |
| `.env.example` | шаблон окружения без секретов |
| `workflows/lead-intake.json` | готовый workflow для импорта |
| `config/example-client.json` | пример конфигурации клиента: маппинг, Sheets, Telegram |
| `examples/valid-lead.json` | корректная заявка |
| `examples/invalid-lead.json` | заявка без имени и контактов |
| `scripts/import-workflow.sh` | импорт, публикация и активация workflow через n8n CLI |
| `tests/code-nodes.test.mjs` | unit-тесты логики Code-нод |
| `tests/smoke-test.sh` | HTTP smoke-тест webhook |

Версии зафиксированы: `docker.n8n.io/n8nio/n8n:2.46.6` и `postgres:17.11-alpine`. n8n поддерживает PostgreSQL 17 и 18, а PostgreSQL 16 — только в режиме compatibility support. Выбранный 17.11 находится в поддерживаемом окне.

## Архитектура

```
POST /webhook/lead-intake
        │
        ▼
Lead Webhook
        │
        ▼
Load Client Config → Parse Client Config → Validate Client Config
        │
        ▼
Normalize Lead          (только маппинг и очистка входных данных)
        │
        ▼
Validate Lead           (бизнес-правила: name + email/phone)
        │
        ├── invalid ──► Build Validation Response ──► HTTP 400
        │
        ▼ valid
Map Lead To CRM Payload (плоский payload по колонкам из конфига)
        │
        ▼
CRM Adapter - Google Sheets ──error──► Build CRM Failure ──► HTTP 502
        │
        ▼
Build Notification Message → Notification Adapter - Telegram
        │                              │
        │                              └──error──► HTTP 201 + warning
        ▼
Build Success Response ──► HTTP 201
        │
        ▼
Error Log Adapter - Google Sheets (только error-ветки) → Stop and Error
```

Ключевые точки замены:

- **CRM-адаптер**: `Map Lead To CRM Payload` формирует плоский объект, где ключи — названия полей назначения из `googleSheets.columns`. Нода `CRM Adapter - Google Sheets` — единственное место записи в CRM. При замене CRM меняется только эта нода (и её error-ветка); нормализация, валидация и HTTP-ответы остаются прежними.
- **Адаптер уведомлений**: `Build Notification Message` + `Notification Adapter - Telegram`. Текст строится из шаблона в конфиге; транспорт можно заменить, не трогая остальной workflow.
- **Журнал ошибок**: `Error Log Adapter - Google Sheets`. Пишет в отдельную вкладку `Errors`.

Нормализация (`Normalize Lead`), валидация (`Validate Lead`) и представление ответов — отдельные Code-ноды. Основная логика не знает, какие именно внешние API используются.

## Быстрый запуск

Требования: Docker с Compose v2, свободный порт `5678`.

```bash
cp .env.example .env
```

Отредактируйте `.env`:

- `POSTGRES_PASSWORD` — сильный пароль;
- `N8N_ENCRYPTION_KEY` — сгенерируйте один раз: `openssl rand -hex 32`;
- `LEAD_CONFIG_FILE` — путь к файлу конфигурации (по умолчанию `./config/example-client.json`);
- `LEAD_WEBHOOK_SECRET` — секрет для Header Auth, сгенерируйте: `openssl rand -hex 32`;
- `EXECUTIONS_DATA_MAX_AGE` / `EXECUTIONS_DATA_PRUNE_MAX_COUNT` — retention executions (по умолчанию 7 дней / 5000 записей).

Важно: `N8N_ENCRYPTION_KEY` нельзя менять после сохранения credentials. Иначе n8n не сможет расшифровать токены, и их придётся создавать заново.

Запуск:

```bash
docker compose up -d
docker compose ps
```

UI: <http://localhost:5678>. При первом открытии n8n попросит создать owner-аккаунт. Порты PostgreSQL наружу не публикуются.

### Конфигурация клиента

Скопируйте пример и заполните реальные значения:

```bash
cp config/example-client.json config/client.json
```

В `.env` укажите:

```dotenv
LEAD_CONFIG_FILE=./config/client.json
```

После изменения `LEAD_CONFIG_FILE` пересоздайте контейнер:

```bash
docker compose up -d
```

Сам JSON-конфиг читается на каждый запрос: если менять только содержимое `client.json`, перезапуск не нужен.

`config/client.json` добавлен в `.gitignore`. Пример `config/example-client.json` остаётся в репозитории как шаблон.

### Импорт и активация workflow

Способ 1, CLI (после `docker compose up -d`):

```bash
./scripts/import-workflow.sh
```

Скрипт импортирует `workflows/lead-intake.json`, публикует фиксированный ID workflow и перезапускает n8n. Перезапуск нужен из-за особенности n8n 2.x: опубликованный webhook подхватывается процессом при старте.

Скрипт предназначен для первой установки. Если workflow уже существует, он откажется импортировать credential-free экспорт, чтобы не стереть назначенные Google/Telegram credentials. Для обновлений используйте UI или запустите с `ALLOW_REIMPORT=1`, после чего заново назначьте credentials.

Способ 2, UI:

1. `Workflows` → `Import from File` → выберите `workflows/lead-intake.json`.
2. Откройте workflow.
3. Назначьте credentials (см. ниже).
4. Опубликуйте/активируйте workflow.

Production URL: `http://localhost:5678/webhook/lead-intake`.

### Header Auth для webhook

Создайте в n8n credential **Header Auth**:

- Name: `X-Webhook-Secret`
- Value: значение `LEAD_WEBHOOK_SECRET` из `.env`

Назначьте credential ноде `Lead Webhook`. Без корректного заголовка `X-Webhook-Secret` n8n возвращает `403` до выполнения workflow, поэтому строки в Sheets и сообщения в Telegram не создаются.

Секрет хранится в `.env` (gitignored) и в зашифрованном credential n8n; в Git попадает только placeholder.

## Настройка Google Sheets

1. Создайте Google-таблицу.
2. Создайте две вкладки:
   - `Leads` — заголовки в первой строке:
     `Created At | External ID | Name | Email | Phone | Source | Message | Request ID`
   - `Errors` — заголовки:
     `Created At | Request ID | Stage | Error | Lead JSON | Execution ID`
3. Скопируйте ID таблицы из URL: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`.
4. Укажите его в `config/client.json` → `googleSheets.spreadsheetId`.
5. В n8n создайте credential **Google Sheets OAuth2 API**:
   - создайте OAuth client в Google Cloud Console;
   - включите Google Sheets API;
   - добавьте redirect URI из n8n (обычно `http://localhost:5678/rest/oauth2-credential/callback`);
   - вставьте Client ID и Client Secret в credential и выполните подключение.
6. Откройте ноды `CRM Adapter - Google Sheets` и `Error Log Adapter - Google Sheets` и выберите этот credential в обеих.
7. Убедитесь, что у подключённого Google-аккаунта есть доступ к таблице.

Альтернатива — service account: создайте Google Service Account, включите Sheets API, выдайте доступ к таблице на email сервисного аккаунта, затем в обеих нодах переключите `Authentication` на `Service Account` и выберите credential типа Google Service Account.

Важно: workflow не создаёт таблицу, вкладки и заголовки автоматически. Заголовки должны совпадать с `googleSheets.columns` и `googleSheets.errorColumns` в конфиге. В обеих Google Sheets-нодах включён `Cell Format = RAW`: телефон и другие значения сохраняются как строки, без превращения `+7...` в число.

## Настройка Telegram

1. Создайте бота через `@BotFather`, получите token.
2. В n8n создайте credential **Telegram API** и вставьте token.
3. Добавьте бота в нужный чат/группу.
4. Получите `chat_id`:
   - для личного чата: напишите боту и вызовите `https://api.telegram.org/bot<TOKEN>/getUpdates`;
   - для группы: добавьте бота в группу, отправьте сообщение и возьмите `chat.id` из `getUpdates` (у групп ID отрицательный).
5. Укажите `chatId` в `config/client.json` → `telegram.chatId`.
6. В ноде `Notification Adapter - Telegram` выберите credential **Telegram API**.
7. Проверьте, что шаблон `telegram.messageTemplate` содержит только допустимые плейсхолдеры:
   `{{name}}`, `{{email}}`, `{{phone}}`, `{{source}}`, `{{message}}`, `{{externalId}}`, `{{requestId}}`.

Telegram-текст отправляется с `parse_mode=HTML`; значения полей экранируются, поэтому символы `<`, `>`, `&` из заявки не ломают разметку. В шаблоне можно использовать простые Telegram HTML-теги. Служебная подпись n8n отключена. Текст обрезается до 4000 символов, чтобы не превысить лимит API.

## API

Webhook защищён Header Auth. Передавайте `X-Webhook-Secret: <LEAD_WEBHOOK_SECRET>`. Без заголовка или с неверным значением n8n возвращает `403` ещё до выполнения workflow (тело — plain text от n8n, не JSON).

### Запрос

`POST /webhook/lead-intake`, `Content-Type: application/json`, `X-Webhook-Secret: <secret>`.

Поля:

| Поле | Обязательность | Примечание |
|---|---|---|
| `name` | да | обрезается по краям |
| `email` | email или phone | приводится к нижнему регистру |
| `phone` | email или phone | удаляются пробелы, скобки, дефисы; ведущий `+` сохраняется |
| `source` | нет | по умолчанию `unknown`; приводится к нижнему регистру |
| `message` | нет | |
| `external_id` | нет | сохраняется как строка |

Имена входных полей задаются в `mapping`. Поддерживаются вложенные пути: `"name": "contact.full_name"`.

```bash
curl -i -X POST http://localhost:5678/webhook/lead-intake \
  -H 'Content-Type: application/json' \
  -H "X-Webhook-Secret: ${LEAD_WEBHOOK_SECRET}" \
  --data @examples/valid-lead.json
```

### Ответы

| HTTP | Когда | Тело (сокращённо) |
|---|---|---|
| `201` | заявка сохранена, уведомление отправлено | `{"ok":true,"status":"created","saved":true,"notified":true,...}` |
| `201` | заявка сохранена, Telegram не отправился | `{"ok":true,"status":"saved_with_notification_error","saved":true,"notified":false,...}` |
| `400` | не прошла валидация | `{"ok":false,"error":"validation_error","details":["name is required.",...]}` |
| `403` | отсутствует/неверный `X-Webhook-Secret` | plain text `Authorization data is wrong!` |
| `500` | ошибка конфигурации/чтения конфига | `{"ok":false,"error":"configuration_error",...}` |
| `502` | Google Sheets не сохранил заявку | `{"ok":false,"error":"crm_write_failed","saved":false,"notified":false,...}` |

`502` принципиально не выглядит как успех: `ok:false`, `saved:false`. Если заявка сохранена, но Telegram упал, возвращается `201` с `notified:false` и статусом `saved_with_notification_error`, чтобы клиент не делал повторную отправку и не создавал дубликат.

### Проверка

```bash
# некорректная заявка → 400
curl -i -X POST http://localhost:5678/webhook/lead-intake \
  -H 'Content-Type: application/json' \
  -H "X-Webhook-Secret: ${LEAD_WEBHOOK_SECRET}" \
  --data @examples/invalid-lead.json

# корректная заявка: 201 при настроенных интеграциях, 502 при их отсутствии
curl -i -X POST http://localhost:5678/webhook/lead-intake \
  -H 'Content-Type: application/json' \
  -H "X-Webhook-Secret: ${LEAD_WEBHOOK_SECRET}" \
  --data @examples/valid-lead.json
```

## Конфигурация

`config/example-client.json`:

- `mapping` — соответствие внутренних полей Lead ключам входящего JSON. Меняется без правки workflow.
- `defaults.source` — источник по умолчанию.
- `googleSheets.spreadsheetId` — ID таблицы.
- `googleSheets.leadsSheetName` — вкладка заявок.
- `googleSheets.errorsSheetName` — вкладка ошибок.
- `googleSheets.columns` — маппинг внутренних полей Lead на заголовки колонок. Можно убрать необязательную колонку; она не будет записана.
- `googleSheets.errorColumns` — маппинг полей журнала ошибок на заголовки.
- `telegram.chatId` — получатель.
- `telegram.messageTemplate` — текст уведомления с плейсхолдерами.

Валидация конфига выполняется при каждом запросе. При ошибке возвращается `500 configuration_error`, детали видны в ответе (обрезаются) и в execution n8n. Секреты в конфиге не хранятся: токены и OAuth-данные живут только в credentials n8n.

## Ошибки и диагностика

- Каждая ошибка внешней интеграции уходит в error-output соответствующей ноды, а не проглатывается.
- В error-ветке формируется HTTP-ответ и запись в `Errors` (если Google Sheets доступен). Если запись журнала тоже падает, исходная ошибка не теряется: execution завершается ошибкой, детали остаются в n8n.
- После отправки HTTP-ответа выполняется `Stop and Error`, поэтому execution получает статус `error` и остаётся видимым в `Executions`, хотя клиент уже получил 502/201.
- Полные детали ошибки (например, `Node does not have any credentials set`, ответ Google API) доступны в execution: `Executions` → открыть запуск → проблемная нода.
- Ошибки валидации не пишутся в `Errors`: это ожидаемые клиентские ошибки, а не сбои интеграций.
- Ошибки конфигурации не могут быть записаны в `Errors`, потому что конфиг ещё не прочитан; они видны в execution и в теле `500`.

## Безопасность

- В репозитории нет токенов, паролей и OAuth-секретов. `.env` и `config/client.json` исключены через `.gitignore`.
- Workflow не содержит credentials: после импорта их нужно назначить в UI. n8n хранит секреты в зашифрованном виде в PostgreSQL.
- Webhook защищён Header Auth (`X-Webhook-Secret`). Credential Header Auth должен быть назначен ноде `Lead Webhook`; без него webhook не выполнит workflow. Секрет хранится в `.env` и в зашифрованном credential n8n, не в Git.
- n8n слушает только `127.0.0.1` по умолчанию (`N8N_BIND_ADDRESS`). Для внешнего доступа меняйте осознанно.
- Конфиг монтируется в контейнер read-only. Доступ файловых нод ограничен каталогом `/home/node/config` через `N8N_RESTRICT_FILE_ACCESS_TO`.
- Не публикуйте наружу PostgreSQL: порт не проброшен.
- Журнал `Errors` и executions содержат нормализованные данные заявки (PII). Retention включён: `EXECUTIONS_DATA_PRUNE=true`, `EXECUTIONS_DATA_MAX_AGE=168` (7 дней), `EXECUTIONS_DATA_PRUNE_MAX_COUNT=5000`. Ограничьте доступ к таблице и настройте retention под политику клиента.

## Проверки, выполненные локально

Выполнено на Docker + PostgreSQL 17.11 + n8n 2.46.6:

- `docker compose up -d` — оба контейнера healthy;
- импорт `workflows/lead-intake.json` через `n8n import:workflow` — успешно;
- публикация и активация workflow, production webhook отвечает;
- запрос без заголовка `X-Webhook-Secret` → `403`, workflow не выполняется;
- запрос с неверным `X-Webhook-Secret` → `403`, workflow не выполняется;
- `POST examples/invalid-lead.json` с корректным auth → `400`, корректный JSON с ошибками; read-back Google Sheets подтвердил `matchCount=0`;
- `POST examples/valid-lead.json` без credentials → `502 crm_write_failed`, `ok:false`, execution со статусом `error`;
- успешный сценарий с реальными credentials и Header Auth → `201 created`, `saved:true`, `notified:true`; execution 23 `success`, строка найдена read-back-проверкой (row 5), Telegram вернул `message_id`;
- телефон в Google Sheets сохраняется строкой `+79005550303` благодаря `Cell Format=RAW`;
- отказ Telegram проверен на реальном API с временно неверным `chatId`: `201 saved_with_notification_error`, `saved:true`, `notified:false`, execution 21 `error`, строка в Sheets сохранена (read-back row 4), Telegram вернул `Bad Request: chat not found`; затем рабочий конфиг восстановлен побайтово;
- битый конфиг → `500 configuration_error`, execution со статусом `error`;
- ошибка Google Sheets (`Node does not have any credentials set`) сохранена в execution и в error-ветке;
- retention применён в контейнере: `EXECUTIONS_DATA_PRUNE=true`, `EXECUTIONS_DATA_MAX_AGE=168`, `EXECUTIONS_DATA_PRUNE_MAX_COUNT=5000`;
- после `docker compose down` + `up` workflow остаётся активным, счетчик executions сохраняется, webhook продолжает работать;
- `node --test tests/code-nodes.test.mjs` — 13 тестов проходят;
- `bash tests/smoke-test.sh` — проходит: `403` без auth, `403` с неверным auth, `400` на invalid, `201 created` на valid (для JSON-проверок нужен `python3`);
- в `workflows/lead-intake.json` нет credentials/токенов/паролей.

Ограничения проверки:

- сбой Google Sheets API на реальном API (5xx/квота) не воспроизводился; error-ветка проверена на отсутствии credentials;
- фактическое удаление execution через 7 дней не ожидалось; проверено, что retention-переменные применены в контейнере;
- `500 configuration_error` покрыт unit-тестом и ручной проверкой, но не включён в smoke-тест;
- регрессионные проверки создали реальные строки и Telegram-сообщения с `external_id` `regression-*`; при необходимости удалите их вручную.

Локальный `502` в окружении без credentials — это проверка обработки сбоя, а не имитация успешной интеграции. После настройки credentials успешный путь подтверждён реальным запросом.

## Ограничения MVP и следующий этап

- Нет дедупликации по `external_id` и очереди повторных попыток.
- Нет автоматического создания таблицы/вкладок/заголовков.
- Обрабатывается один webhook-запрос за execution (один item).
- Header Auth использует один общий секрет; ротация секрета и credential выполняется вручную.
- Нет rate limiting и защиты от спама (Header Auth снижает риск, но не заменяет rate limiting).
- CRM-адаптер представлен точкой замены, а не отдельным SDK/фреймворком.
- Нет UI-конструктора, мультиарендности и AI.

Следующий этап: дедупликация по `external_id`, retry-очередь, идемпотентность, расширенная валидация email/phone, метрики и алерты.

## Остановка

```bash
docker compose down          # сохранить данные
docker compose down -v       # удалить данные n8n и PostgreSQL
```
