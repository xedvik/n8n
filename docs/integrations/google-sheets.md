# Google Sheets

Google Sheets в v0.3 может выполнять три независимые роли:

1. **CRM-хранилище** — `crm.provider=google_sheets` (режим обратной совместимости v0.1).
2. **Журнал** — `journal.enabled=true`; пишет все принятые заявки независимо от CRM.
3. **Журнал ошибок** — `errors.enabled=true`.

Роли включаются отдельно. HubSpot можно использовать без Google Sheets; журнал и error log тогда отключаются.

## 1. Google Cloud: API и OAuth

1. Откройте [Google Cloud Console](https://console.cloud.google.com/).
2. Создайте проект или выберите существующий.
3. Включите **Google Sheets API** (`APIs & Services → Library → Google Sheets API → Enable`).
4. Включите **Google Drive API** — credential n8n Google Sheets OAuth2 использует Drive scopes.
5. Настройте OAuth consent screen / Google Auth Platform:
   - тип приложения: Internal для Workspace или External для обычного аккаунта;
   - заполните название, support email, developer contact;
   - если приложение External и находится в Testing, добавьте свой Google-аккаунт в **Test users**;
   - добавьте scopes, которые запрашивает n8n:
     - `https://www.googleapis.com/auth/drive.file`
     - `https://www.googleapis.com/auth/spreadsheets`
     - `https://www.googleapis.com/auth/drive.metadata`
6. Создайте **OAuth client ID** типа **Web application**.
7. В **Authorized redirect URIs** добавьте URL, который показывает n8n в credential, обычно:

```text
http://localhost:5678/rest/oauth2-credential/callback
```

Если n8n открывается по `http://127.0.0.1:5678`, используйте ровно:

```text
http://127.0.0.1:5678/rest/oauth2-credential/callback
```

Для домена:

```text
https://n8n.example.com/rest/oauth2-credential/callback
```

Не смешивайте `localhost` и `127.0.0.1`: OAuth callback должен совпадать с адресом, по которому открыт n8n. За прокси задайте публичный `N8N_WEBHOOK_URL`/host настройки n8n.

## 2. Credential в n8n

1. В n8n: `Credentials → Create Credential → Google Sheets OAuth2 API`.
2. Вставьте Client ID и Client Secret.
3. Нажмите Sign in with Google, выберите аккаунт и разрешите доступ.
4. Убедитесь, что у аккаунта есть доступ к нужной таблице.

### Альтернатива: Service Account

1. Создайте Service Account в Google Cloud, включите Sheets API.
2. Создайте JSON key.
3. В n8n создайте credential **Google Service Account** и вставьте JSON/key.
4. Откройте таблицу → Share → добавьте email сервисного аккаунта (`...iam.gserviceaccount.com`) с правами Editor.
5. В каждой Google Sheets-ноде переключите `Authentication` на `Service Account` и выберите credential.

Workflow по умолчанию использует OAuth2. Для service account переключение выполняется в UI на трёх нодах; это настройка credential, не изменение кода.

## 3. Таблица и вкладки

Создайте таблицу и вкладки. Заголовки должны точно совпадать с `columns` в конфиге.

### CRM Leads (если CRM = Google Sheets)

Пример v2:

```text
Created At | External ID | Name | First Name | Last Name | Email | Phone | Source | Message | Request ID
```

Legacy v1 использует:

```text
Created At | External ID | Name | Email | Phone | Source | Message | Request ID
```

### Journal

```text
Created At | External ID | Name | Email | Phone | Source | Message | Request ID | CRM Provider | CRM Status | CRM Contact ID
```

### Errors

```text
Created At | Request ID | Stage | Error | Lead JSON | Execution ID
```

Вкладки можно назвать иначе, если изменить `sheetName`/`leadsSheetName` в конфиге. Journal не должен указывать на ту же вкладку, что CRM при `crm.provider=google_sheets`; валидатор это отклонит, чтобы не было двойной записи.

В Google Sheets-нодах включён `Cell Format = RAW`: телефон сохраняется строкой (`+7...`), а не превращается в число.

Колонка `Created At` в Leads/Journal заполняется в IANA timezone из `config/client.json` (например, `Asia/Tbilisi`). В execution n8n при этом хранится технический UTC timestamp. Journal должен иметь заголовки первой строкой; пустая вкладка Journal не будет автоматически заполнена заголовками.

Journal и Errors — это отдельные хранилища PII. В отличие от executions, они не prune-ятся автоматически; ограничьте доступ к таблице и настройте политику хранения/очистки под требования клиента.

## 4. Конфигурация

Фрагмент `config/client.json`:

```json
{
  "crm": {
    "provider": "google_sheets",
    "googleSheets": {
      "spreadsheetId": "1AbC...",
      "leadsSheetName": "Leads",
      "columns": {
        "createdAt": "Created At",
        "externalId": "External ID",
        "name": "Name",
        "email": "Email",
        "phone": "Phone",
        "source": "Source",
        "message": "Message",
        "requestId": "Request ID"
      }
    }
  },
  "journal": {
    "enabled": true,
    "provider": "google_sheets",
    "googleSheets": {
      "spreadsheetId": "1AbC...",
      "sheetName": "Journal",
      "columns": {
        "createdAt": "Created At",
        "externalId": "External ID",
        "name": "Name",
        "email": "Email",
        "phone": "Phone",
        "source": "Source",
        "message": "Message",
        "requestId": "Request ID",
        "crmProvider": "CRM Provider",
        "crmStatus": "CRM Status",
        "crmContactId": "CRM Contact ID"
      }
    }
  },
  "errors": {
    "enabled": true,
    "provider": "google_sheets",
    "googleSheets": {
      "spreadsheetId": "1AbC...",
      "sheetName": "Errors",
      "columns": {
        "createdAt": "Created At",
        "requestId": "Request ID",
        "stage": "Stage",
        "error": "Error",
        "leadJson": "Lead JSON",
        "executionId": "Execution ID"
      }
    }
  }
}
```

`spreadsheetId` берётся из URL:

```text
https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit
```

## 5. Назначение credentials нодам

| Нода | Когда нужна |
|---|---|
| `CRM Adapter - Google Sheets` | `crm.provider=google_sheets` |
| `Journal Adapter - Google Sheets` | `journal.enabled=true` |
| `Error Log Adapter - Google Sheets` | `errors.enabled=true` |

Если интеграция выключена, credential можно не назначать; нода не выполняется.

## 6. Проверка

```bash
./scripts/doctor.sh
```

Проверка с реальной записью:

```bash
./scripts/doctor.sh --integration-test
```

Ручная заявка:

```bash
curl -i -X POST http://localhost:5678/webhook/lead-intake \
  -H 'Content-Type: application/json' \
  -H "X-Webhook-Secret: ${LEAD_WEBHOOK_SECRET}" \
  --data @examples/valid-lead.json
```

Ожидайте строку в CRM/Journal и `201` (или `202` при skip-политике CRM).

## 7. Типичные ошибки

- `Unauthorized` / OAuth fail:
  - не совпал redirect URI (`localhost` vs `127.0.0.1`, http vs https);
  - Google-аккаунт не добавлен в Test users;
  - не включены Sheets API и Drive API;
  - consent screen не завершён;
  - истёк/отозван refresh token — переподключите credential.
- `502 crm_write_failed` / `journal_write_failed`:
  - credential не назначен ноде;
  - неверный spreadsheet ID;
  - таблица не расшарена service account;
  - нет вкладки с точным именем;
  - заголовки не совпадают с конфигом;
  - исчерпана квота Google API.
- `The requested webhook ... is not registered` — workflow не активен, см. troubleshooting.
- Ошибка записи журнала не отменяет успешный CRM: ответ будет с `journal.status=failed`, `warnings` и execution `error`.
- Ошибка Telegram не стирает строку: ответ `202 needs_reconciliation` с `notified:false`; автоматической переотправки нет.
