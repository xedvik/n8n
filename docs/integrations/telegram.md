# Telegram

Telegram — опциональный канал уведомлений. Если `notifications.enabled=false`, credential и chat ID не нужны.

## 1. Создание бота

1. В Telegram откройте `@BotFather`.
2. Выполните `/newbot`, задайте имя и username.
3. Скопируйте token. Не публикуйте его и не добавляйте в Git.

## 2. Credential в n8n

1. `Credentials → Create Credential → Telegram API`.
2. Вставьте token.
3. Сохраните credential.

## 3. Чат и chat ID

1. Добавьте бота в нужный личный чат или группу.
2. Для группы проверьте, что бот имеет право отправлять сообщения.
3. Напишите боту или отправьте сообщение в группу.
4. Получите `chat_id`:

```text
https://api.telegram.org/bot<TOKEN>/getUpdates
```

В ответе найдите `message.chat.id`.

Особенности:

- у групп и супергрупп ID отрицательный, например `-1001234567890`;
- для каналов бот должен быть администратором;
- если бот не получал обновлений, `getUpdates` может быть пустым — отправьте сообщение после добавления бота.

## 4. Конфигурация

```json
{
  "notifications": {
    "enabled": true,
    "channels": ["telegram"],
    "telegram": {
      "chatId": "-1001234567890",
      "messageTemplate": "New lead\n\nName: {{name}}\nEmail: {{email}}\nPhone: {{phone}}\nSource: {{source}}\nMessage: {{message}}\nExternal ID: {{externalId}}\nRequest ID: {{requestId}}\nCRM: {{crmStatus}}"
    }
  }
}
```

Допустимые плейсхолдеры:

`{{name}}`, `{{firstName}}`, `{{lastName}}`, `{{email}}`, `{{phone}}`, `{{source}}`, `{{message}}`, `{{externalId}}`, `{{requestId}}`, `{{crmStatus}}`, `{{crmProvider}}`, `{{crmContactId}}`.

Неизвестный плейсхолдер — ошибка конфигурации.

## 5. Назначение credential

Откройте ноду `Notification Adapter - Telegram` и выберите credential **Telegram API**.

Сообщение отправляется с:

- `parse_mode=HTML`;
- экранированием значений полей (`<`, `>`, `&`, `"`), чтобы пользовательский текст не ломал разметку;
- отключённой служебной подписью n8n (`appendAttribution=false`);
- ограничением длины 4000 символов.

В шаблоне можно использовать простые Telegram HTML-теги, но не вставляйте незакрытые теги.

## 6. Проверка

```bash
./scripts/doctor.sh
```

После настройки можно выполнить реальную проверку:

```bash
./scripts/doctor.sh --integration-test
```

Или отправить заявку вручную. Успешный сценарий:

- `201 created` (или `200 updated`, `202 crm_skipped`);
- `notified:true`;
- сообщение пришло в чат.

Если CRM сохранила заявку, но Telegram недоступен:

- HTTP `202 needs_reconciliation` с `notified:false`;
- `status` равен `needs_reconciliation`; автоматической переотправки нет;
- `warnings` содержит `notification_send_failed`;
- execution имеет статус `error`, чтобы сбой был виден.

## 7. Типичные ошибки

- `400 Bad Request: chat not found` — неверный chat ID, бот не добавлен в чат, ID группы указан без минуса.
- `401 Unauthorized` — неверный/отозванный token.
- `403 Forbidden: bot was blocked by the user` — пользователь заблокировал бота.
- `403 Forbidden: bot is not a member of the group chat` — добавьте бота в группу.
- Ошибка HTML parse — в шаблоне незакрытый тег или неэкранированный HTML; используйте простой текст.
- Сообщение не пришло, но заявка сохранена — проверьте execution, error log и `warnings`.
