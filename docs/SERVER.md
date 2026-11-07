# Единый стек v0.5: установка и эксплуатация

v0.5 — единственный поддерживаемый способ развёртывания. Нет отдельных Local и Server режимов, нет второго Compose-файла и второго способа запуска мастера.

Один `docker-compose.yml` запускает:

- `caddy` — единственный публичный контейнер, HTTPS `80/443`;
- `n8n` — внутренний сервис, без публикации порта;
- `postgres` — внутренний сервис, без публикации порта;
- `wizard` — внутренний сервис, доступный только через Caddy по `/setup/`.

Маршруты:

```text
https://<domain>/                         -> n8n
https://<domain>/webhook/lead-intake      -> n8n
https://<domain>/rest/oauth2-credential/callback -> n8n
https://<domain>/api/v1/*                 -> n8n public API
https://<domain>/setup/                   -> wizard
```

## Требования

- Linux-сервер с Docker Engine и Docker Compose plugin.
- A/AAAA-запись домена указывает на сервер.
- Открыты входящие TCP `80` и `443`.
- `openssl`, `curl`, `ss` (обычно уже установлены).
- Node.js и отдельный процесс мастера на хосте **не требуются** для эксплуатации.
- Docker socket нужен контейнеру Wizard для существующих doctor/import/recovery скриптов; установщик подключает его в Compose.

Проверка:

```bash
docker compose version
docker info
```

## Установка

```bash
git clone <repository> /opt/crm-automation-kit
cd /opt/crm-automation-kit
sudo ./scripts/install-server.sh crm.example.com admin@example.com
```

Установщик идемпотентен. Он:

1. Проверяет домен, email, Docker/Compose и занятость портов `80/443`.
2. Создаёт `.env` из `.env.example` и выставляет `chmod 600`.
3. Генерирует `POSTGRES_PASSWORD`, `N8N_ENCRYPTION_KEY`, `LEAD_WEBHOOK_SECRET`, `WIZARD_SECRET_KEY` только если они пусты или placeholder.
4. Прописывает единые публичные URL, `CRM_DOMAIN`, `ACME_EMAIL`, `WIZARD_*`, `N8N_API_URL=http://n8n:5678`, `N8N_PUBLIC_URL=https://<domain>/`.
5. Создаёт `wizard-data/` и одноразовый `bootstrap-token`, если ещё нет `auth.json`.
6. Собирает и запускает **единый** стек: `docker compose up -d --build`.
7. Ждёт готовности n8n и Wizard, применяет миграции и импортирует workflow, только если его ещё нет.
8. Печатает first-run URL.

При прямом `docker compose up -d --build` без установщика Wizard сам создаёт `wizard-data/bootstrap-token` при первом старте; токен берётся из файла и не пишется в логи. Повторный запуск сохраняет `.env`, базу, конфиг клиента, credentials, workflow и токен.

## Первый запуск

1. Откройте `https://<domain>/` и создайте owner-аккаунт n8n.
2. Откройте `https://<domain>/settings/api` и создайте API key со scopes:
   - `workflow:read`
   - `workflow:update`
   - `workflow:activate`
   - `credential:list`
   - `credential:read`
   - `credential:create`
3. Откройте `https://<domain>/setup/?token=<token>` из вывода установщика.
4. Зарегистрируйте единственного администратора.
5. Подключите n8n API key в мастере.
6. Пройдите мастер до тестовой заявки.

Bootstrap-токен удаляется после успешной регистрации. Повторная регистрация закрыта. При повторном запуске установщика с существующим `auth.json` печатается только `https://<domain>/setup/`.

## DNS и TLS

- A/AAAA-запись должна указывать на сервер.
- Caddy автоматически получает и продлевает сертификат Let's Encrypt.
- `ACME_EMAIL` используется для ACME.
- Порты `80` и `443` должны быть доступны из интернета.
- Сертификаты и ACME-состояние хранятся в volumes `caddy_data` и `caddy_config`; не удаляйте их без причины.
- Caddy admin API отключён (`admin off`).

Для локальной проверки можно использовать `CRM_DOMAIN=localhost`; Caddy выпустит локальный сертификат, браузер может потребовать доверия локальному CA. Это тот же стек, а не отдельный режим.

## Внутренние порты и firewall

Публикуйте только:

- `80/tcp` — ACME и redirect;
- `443/tcp` — HTTPS;
- SSH по вашей политике.

Не публикуйте `5678`, `8787`, `5432`: в Compose у n8n, PostgreSQL и Wizard нет `ports`, только внутренняя сеть.

Пример UFW:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow ssh
sudo ufw enable
```

## OAuth callback URL

```text
https://<domain>/rest/oauth2-credential/callback
```

Укажите этот URL в OAuth-приложении Google/HubSpot. n8n находится за Caddy с `N8N_PROXY_HOPS=1`, поэтому схема определяется как `https`.

## Webhook URL

Production:

```text
https://<domain>/webhook/lead-intake
```

Test:

```text
https://<domain>/webhook-test/lead-intake
```

Header Auth (`X-Webhook-Secret`) остаётся обязательным. HTTPS не заменяет секрет.

## Управление после установки

Все штатные действия выполняются в `/setup/`:

- повторная настройка клиента и интеграций;
- проверка credentials и doctor;
- просмотр операций, `needs_reconciliation` и retry;
- ручной retry операции;
- backup/list/restore конфигурации;
- проверка доступности Caddy, n8n, PostgreSQL, Wizard.

CLI-команды ниже нужны только разработчикам и для аварийной диагностики:

```bash
docker compose ps
docker compose logs -f caddy n8n wizard postgres
docker compose exec -T wizard bash -lc 'cd /app && BASE_URL=http://n8n:5678 ./scripts/doctor.sh'
```

## Резервное копирование

Сохраняйте:

- `.env` (секреты; mode `600`);
- `config/client.json` и `config/.client-config.*`;
- `wizard-data/`;
- volume `postgres_data`;
- volume `n8n_data`;
- volumes `caddy_data` и `caddy_config`.

Пример:

```bash
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-n8n}" -d "${POSTGRES_DB:-n8n}" > backup-$(date +%F).sql
sudo tar -czf crm-kit-backup-$(date +%F).tar.gz \
  .env config wizard-data docker-compose.yml Caddyfile
```

Backup конфигурации также доступен в `/setup/` → «Управление»; восстановление делает backup текущей версии перед заменой.

## Обновление

```bash
cd /opt/crm-automation-kit
git pull --ff-only
sudo ./scripts/install-server.sh crm.example.com admin@example.com
```

Установщик пересоберёт Wizard, поднимет стек, применит миграции и не будет импортировать workflow, если он уже есть. Credentials и данные сохраняются. Caddy автоматически подхватит новые образы после `docker compose pull` (если теги обновляются вручную).

## Откат

1. Остановите стек без удаления volumes:

```bash
docker compose down
```

2. Верните предыдущую версию кода:

```bash
git checkout <previous-tag-or-commit>
```

3. Восстановите `.env`, `config/`, `wizard-data/` и, при необходимости, дамп PostgreSQL.
4. Запустите установщик прежней версии.

Не используйте `docker compose down -v`, если хотите сохранить базу, credentials и сертификаты.

## Миграция с v0.4.1

v0.5 использует те же имена volumes `postgres_data` и `n8n_data` и тот же Compose project `crm-automation-kit`, поэтому данные и credentials сохраняются. Отличия:

- Caddy перенесён из overlay/host-network в общую Compose-сеть;
- Wizard больше не отдельный процесс на хосте, а контейнер;
- n8n, PostgreSQL и Wizard больше не публикуют порты на хост;
- `docker-compose.server.yml` и `scripts/start-wizard.sh` удалены.

Перед обновлением сделайте backup volumes и `.env`.

## Диагностика

- Caddy не получает сертификат: проверьте DNS, порты `80/443`, `docker compose logs caddy`.
- `502` на `/`: n8n не готов — `docker compose ps`, `docker compose logs n8n`.
- `502` на `/setup/`: Wizard не готов — `docker compose ps`, `docker compose logs wizard`.
- Мастер отвечает `403 invalid_host`: проверьте `WIZARD_ALLOWED_HOSTS` и `CRM_DOMAIN`; перезапустите `docker compose up -d wizard`.
- Docker-операции мастера падают: проверьте mount `/var/run/docker.sock` и права контейнера.
- Порт занят: остановите конфликтующий сервис или освободите `80/443`.
- Нет first-run URL: проверьте `wizard-data/bootstrap-token` и отсутствие `wizard-data/auth.json`.
