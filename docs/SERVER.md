# Server-развёртывание на одном домене

Этот режим публикует n8n и веб-мастер на одном HTTPS-домене через Caddy:

- `https://<domain>/` — n8n UI, public API, OAuth callbacks и webhooks.
- `https://<domain>/setup/` — веб-мастер настройки (Caddy снимает префикс `/setup`).
- n8n слушает только `127.0.0.1:5678`; PostgreSQL портов наружу не публикует.
- Caddy работает в `network_mode: host`, завершает TLS и проксирует loopback-порты.

Локальный режим (`docker compose up -d` + `./scripts/start-wizard.sh`) не меняется.

## Требования

- Linux VPS или выделенный сервер с systemd и Docker Compose.
- Docker с поддержкой `network_mode: host` (обычный rootful Docker на Linux;
  Docker Desktop/rootless может не подойти).
- Домен, A/AAAA-запись которого указывает на этот сервер.
- Открытые входящие TCP-порты `80` и `443`.
- Node.js 22+ на хосте для веб-мастера (установщик проверяет версию).
- `openssl`, `curl`, `ss` (пакет iproute2) — обычно уже установлены.

Проверка:

```bash
docker compose version
node --version
```

## Установка

```bash
git clone <repository> /opt/crm-automation-kit
cd /opt/crm-automation-kit
sudo ./scripts/install-server.sh crm.example.com admin@example.com
```

Установщик идемпотентен. Он:

1. Проверяет домен, email, Docker/Compose, Node.js 22+ и свободность портов
   80/443, а также loopback-портов 5678/8787 (предупреждение).
2. Создаёт `.env` из `.env.example`, если файла нет, и выставляет `chmod 600`.
3. Генерирует `POSTGRES_PASSWORD`, `N8N_ENCRYPTION_KEY`, `LEAD_WEBHOOK_SECRET` и
   `WIZARD_SECRET_KEY`, только если они отсутствуют, пусты или содержат `CHANGE_ME`.
4. Прописывает серверные значения `N8N_*`, `CRM_DOMAIN`, `ACME_EMAIL`, `WIZARD_*`,
   `N8N_API_URL`, `N8N_PUBLIC_URL`, `LEAD_CONFIG_FILE`.
5. Создаёт `wizard-data/` с режимом `700` и одноразовый `bootstrap-token` (`600`),
   если ещё нет `auth.json`; существующие данные и токен не перезаписываются.
6. Устанавливает и запускает systemd-юнит `crm-wizard.service`.
7. Поднимает `docker compose -f docker-compose.yml -f docker-compose.server.yml up -d`,
   ждёт готовности n8n, применяет миграции и импортирует workflow, только если его ещё нет.
8. Печатает первые шаги и точный first-run URL, пока `auth.json` ещё не создан.

Повторный запуск сохраняет секреты, базу, конфиг клиента и не перегенерирует токен.

## Первый запуск

1. Откройте `https://<domain>/` и создайте owner-аккаунт n8n.
2. Откройте `https://<domain>/settings/api` и создайте API key со scopes:
   - `workflow:read`
   - `workflow:update`
   - `workflow:activate`
   - `credential:list`
   - `credential:read`
   - `credential:create`
3. Откройте first-run URL из вывода установщика:
   `https://<domain>/setup/?token=<одноразовый-токен>`.
   Зарегистрируйте администратора мастера и подключите n8n API key.
   После успешной регистрации токен автоматически удаляется и повторная регистрация
   блокируется; вручную удалять файл не нужно.
4. При повторном запуске установщик, если `auth.json` уже существует, печатает
   только `https://<domain>/setup/`.

Для OAuth2 credentials (Google, HubSpot) нажмите Connect в n8n:
`https://<domain>/home/credentials`.

## DNS и TLS

- A-запись (и AAAA, если используется IPv6) домена должна указывать на сервер.
- Caddy сам получает и продлевает сертификат Let's Encrypt по HTTP-01/TLS-ALPN-01.
- `ACME_EMAIL` из `.env` используется для регистрации в ACME.
- Порты 80 и 443 должны быть доступны из интернета. Если 80 закрыт или занят,
  выпуск сертификата не завершится.
- После изменения DNS подождите распространения записей; проверьте:
  `dig +short <domain>`.
- Сертификаты и ACME-состояние хранятся в volume `caddy_data`; не удаляйте его без причины.
- Admin API Caddy не публикуется наружу (по умолчанию только loopback).

## Локальный режим и сервер

| | Локально | Сервер |
|---|---|---|
| n8n UI | `http://127.0.0.1:5678` | `https://<domain>/` |
| Мастер | `http://127.0.0.1:8787` | `https://<domain>/setup/` |
| TLS | нет | Caddy + автоматический ACME |
| Compose | `docker-compose.yml` | `docker-compose.yml` + `docker-compose.server.yml` |
| Мастер | `./scripts/start-wizard.sh` | systemd `crm-wizard.service` |
| n8n bind | `127.0.0.1` | `127.0.0.1` |

Серверные переменные в `.env`: `CRM_DOMAIN`, `ACME_EMAIL`, `N8N_HOST=<domain>`,
`N8N_PROTOCOL=https`, `N8N_WEBHOOK_URL=https://<domain>/`,
`N8N_EDITOR_BASE_URL=https://<domain>/`, `N8N_BIND_ADDRESS=127.0.0.1`,
`WIZARD_SERVER_MODE=1`, `WIZARD_ALLOWED_HOSTS=<domain>`,
`WIZARD_COOKIE_SECURE=1`.

## OAuth callback URL

n8n формирует callback из `N8N_EDITOR_BASE_URL` и `N8N_PROTOCOL`. Для этого развёртывания:

```text
https://<domain>/rest/oauth2-credential/callback
```

Укажите этот URL в настройках OAuth-приложения Google/HubSpot, если требуется
ручная регистрация. `N8N_PROXY_HOPS=1` обеспечивает корректное определение схемы
`https` за Caddy.

## Webhook URL

Production webhook:

```text
https://<domain>/webhook/lead-intake
```

Test webhook:

```text
https://<domain>/webhook-test/lead-intake
```

`N8N_WEBHOOK_URL=https://<domain>/` используется n8n для построения публичных ссылок.
Header Auth (`X-Webhook-Secret`) остаётся обязательным; HTTPS не заменяет секрет.

## Firewall

Открывайте только:

- `80/tcp` — ACME HTTP-01 и редирект на HTTPS.
- `443/tcp` — HTTPS.
- SSH-порт по вашей политике.

Не публикуйте наружу `5678` (n8n), `8787` (мастер) и `5432` (PostgreSQL).
Docker Compose публикует n8n только на `127.0.0.1`; PostgreSQL не имеет `ports`.

Пример UFW:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow ssh
sudo ufw enable
```

## Резервное копирование

Сохраняйте:

- `.env` (содержит секреты; режим `600`).
- `config/client.json` и backup-файлы `config/.client-config.*`.
- `wizard-data/` (auth и токен мастера).
- PostgreSQL volume `postgres_data`.
- n8n volume `n8n_data` (credentials, workflow state).
- Caddy volume `caddy_data` (сертификаты).

Логический backup PostgreSQL:

```bash
docker compose -f docker-compose.yml -f docker-compose.server.yml exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-n8n}" -d "${POSTGRES_DB:-n8n}" > backup-$(date +%F).sql
```

Файловый backup каталогов и volumes:

```bash
sudo tar -czf crm-kit-backup-$(date +%F).tar.gz \
  .env config wizard-data docker-compose.yml docker-compose.server.yml Caddyfile
```

Для volumes используйте snapshot провайдера или
`docker run --rm -v crm-automation-kit_postgres_data:/data ...` по вашей политике.
Перед обновлениями делайте backup всегда.

## Обновление

```bash
cd /opt/crm-automation-kit
git pull --ff-only
sudo ./scripts/install-server.sh crm.example.com admin@example.com
```

Установщик заново проверит конфиг, пересоздаст unit при необходимости, выполнит
`docker compose ... up -d`, миграции и не будет импортировать workflow, если он уже есть.
Существующие credentials и данные сохраняются. Caddy автоматически подхватит
актуальные образы после `docker compose pull` (если вы обновляете теги вручную).

## Откат

1. Остановите сервисы, сохранив volumes:

```bash
sudo systemctl disable --now crm-wizard.service
docker compose -f docker-compose.yml -f docker-compose.server.yml down
```

2. Верните предыдущую версию кода:

```bash
git checkout <previous-tag-or-commit>
```

3. Восстановите `.env`, `config/`, `wizard-data/` и, при необходимости, дамп PostgreSQL
   из backup.
4. Поднимите прежнюю версию:

```bash
sudo ./scripts/install-server.sh crm.example.com admin@example.com
```

`docker compose ... down` не удаляет named volumes; не используйте `-v`, если хотите
сохранить базу, credentials и сертификаты.

## Диагностика

- Caddy не получает сертификат: проверьте DNS, порты 80/443 и
  `docker logs crm-automation-kit-caddy-1` (имя контейнера может отличаться).
- `502` на `/`: n8n не готов — `docker compose ... ps` и `logs n8n`.
- Мастер отвечает `403 invalid_host`: проверьте `WIZARD_ALLOWED_HOSTS=<domain>` в `.env`
  и перезапустите `crm-wizard.service`.
- Мастер не стартует: `journalctl -u crm-wizard.service -n 100 --no-pager`.
  Проверьте Node.js 22+ и `command -v node`; установщик добавляет каталог Node в PATH unit.
- `doctor`/workflow из мастера падают с доступом к Docker: пользователь из
  `SUDO_USER` не входит в группу `docker`; добавьте его или запускайте установщик от root.
- Порт занят: остановите конфликтующий сервис или освободите 80/443.
- Нет first-run URL, хотя `wizard-data/auth.json` отсутствует: установщик печатает
  токен из `wizard-data/bootstrap-token` при каждом запуске. Не удаляйте `auth.json`
  без необходимости; для сброса администратора остановите сервис, удалите
  `wizard-data/auth.json`, создайте новый `bootstrap-token` и перезапустите установщик.
