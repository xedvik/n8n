# HubSpot

HubSpot-адаптер в v0.2 использует стандартный n8n credential **HubSpot Service Key** (`hubspotAppToken`) и три HTTP Request-ноды:

- `HubSpot Search Contact` — поиск по email;
- `HubSpot Create Contact` — создание нового контакта;
- `HubSpot Update Contact` — обновление существующего по contact ID.

## 1. Создание Service Key

1. В HubSpot откройте **Development → Private apps** (или Settings → Integrations → Private Apps).
2. Создайте private app.
3. Добавьте scopes:
   - `crm.objects.contacts.read`
   - `crm.objects.contacts.write`
4. Если планируете читать/проверять свойства контактов, при необходимости добавьте `crm.schemas.contacts.read`.
5. Создайте/скопируйте access token (Service Key). Не публикуйте его.

## 2. Credential в n8n

1. `Credentials → Create Credential → HubSpot Service Key`.
2. Вставьте access token.
3. Сохраните.

Альтернатива — `HubSpot OAuth2 API`: она поддерживается n8n, но требует OAuth app и набора scopes. В v0.2 HTTP-ноды по умолчанию настроены на `hubspotAppToken`. Если вы сознательно используете OAuth2, переключите **Credential Type** на `HubSpot OAuth2 API` во всех трёх HubSpot HTTP-нодах и назначьте OAuth2 credential. Иначе HubSpot-ветка будет падать с ошибкой credential.

## 3. Назначение credential

Откройте workflow и назначьте HubSpot credential:

- `HubSpot Search Contact`
- `HubSpot Create Contact`
- `HubSpot Update Contact`

Если `crm.provider != hubspot`, эти ноды не выполняются; credential не нужен.

## 4. Конфигурация

```json
{
  "crm": {
    "provider": "hubspot",
    "hubspot": {
      "baseUrl": "https://api.hubapi.com",
      "phoneOnlyPolicy": "skip",
      "searchEmailProperty": "email",
      "searchLimit": 10,
      "propertiesToReturn": ["email", "phone", "firstname", "lastname"],
      "propertyMapping": {
        "email": "email",
        "phone": "phone",
        "firstname": "firstName",
        "lastname": "lastName",
        "message": "message"
      }
    }
  }
}
```

`propertyMapping`:

- ключи — имена HubSpot contact properties;
- значения — поля внутреннего Lead:
  `name`, `firstName`, `lastName`, `email`, `phone`, `source`, `message`, `externalId`.

Стандартные свойства `email`, `phone`, `firstname`, `lastname`, `message` существуют в HubSpot. Если добавляете `source` или `external_id`, сначала создайте соответствующие custom properties в HubSpot. Иначе API вернёт ошибку о неизвестном property.

`firstName` и `lastName` выводятся из поля `name` (первое слово / остаток). `propertyMapping.email` обязателен: по нему выполняется поиск существующего контакта.

## 5. Поведение адаптера

### Email-заявка

1. `POST /crm/v3/objects/contacts/search` с фильтром по `propertyMapping.email`.
2. Нет совпадений → `POST /crm/v3/objects/contacts`, ответ `201 created`.
3. Одно совпадение → `PATCH /crm/v3/objects/contacts/{id}`, ответ `200 updated`.
4. Несколько совпадений → контролируемый `202 crm_skipped` с `reason=ambiguous_match`; контакт не изменяется.

### Заявка только с телефоном

- `phoneOnlyPolicy=skip` — единственная поддерживаемая политика v0.2. Заявка без email не создаёт контакт и не ищет телефонные совпадения вслепую; журнал/уведомления могут продолжить работу. Поиск/создание по телефону требует отдельной проверенной стратегии нормализации и появится в следующей версии.

### Ошибки и лимиты

- HTTP-ноды имеют `retryOnFail`: 3 попытки с паузой 5 секунд.
- При 429/rate limit после retries ответ клиенту — `429 crm_rate_limited`, execution `error`.
- Прочие ошибки API → `502 crm_write_failed`; детали сохраняются в execution и error log.
- Ошибка HubSpot не запускает journal/notifications: CRM считается основным хранилищем.

## 6. Проверка

```bash
./scripts/doctor.sh
```

Доктор проверит назначение credential и конфиг. Реальный HubSpot API без credentials не проверяется.

С credentials:

```bash
./scripts/doctor.sh --integration-test
```

Ожидайте:

- `201 created` для нового email;
- `200 updated` при повторной заявке с тем же email;
- `202 crm_skipped` для phone-only при `skip`;
- `502` при отсутствии credential/scope;
- `429` при исчерпании лимита.

Тестовая заявка создаёт реальный контакт. Для проверки phone-only используйте HTTP-запрос без email.

## 7. Типичные ошибки

- `401/403` — неверный Service Key или отсутствуют scopes контактов.
- `400 Property ... does not exist` — в `propertyMapping` указано несуществующее custom property.
- `400` при phone-only create — в v0.2 такой сценарий не выполняется: phone-only заявки пропускаются с `202 crm_skipped`.
- `429` — rate limit; уменьшите частоту запросов, проверьте execution и повторите позже.
- `502` — credential не назначен одной из трёх HubSpot-нод, неверный base URL или network/API error.
- Контакт обновился не тот — проверьте `searchEmailProperty`/`propertyMapping.email` и дубликаты email в HubSpot.
