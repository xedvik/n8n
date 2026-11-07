import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CADDYFILE = path.join(ROOT, 'Caddyfile');
const SERVER_COMPOSE = path.join(ROOT, 'docker-compose.server.yml');
const BASE_COMPOSE = path.join(ROOT, 'docker-compose.yml');
const INSTALLER = path.join(ROOT, 'scripts/install-server.sh');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const GITIGNORE = path.join(ROOT, '.gitignore');
const SERVER_DOC = path.join(ROOT, 'docs/SERVER.md');
const README = path.join(ROOT, 'README.md');

const HAS_DOCKER_COMPOSE = spawnSync('docker', ['compose', 'version'], {
  encoding: 'utf8',
}).status === 0;

const HAS_SHELLCHECK = spawnSync('shellcheck', ['--version'], {
  encoding: 'utf8',
}).status === 0;

async function text(file) {
  return fs.readFile(file, 'utf8');
}

function assertContains(source, needle, label) {
  assert.ok(source.includes(needle), `${label} must contain: ${needle}`);
}

test('Caddyfile serves n8n at root and the wizard under /setup', async () => {
  const caddy = await text(CADDYFILE);

  assertContains(caddy, '{$CRM_DOMAIN}', 'Caddyfile site address');
  assertContains(caddy, '{$ACME_EMAIL}', 'Caddyfile ACME email');
  assertContains(caddy, 'encode zstd gzip', 'Caddyfile compression');
  assertContains(caddy, 'redir /setup /setup/ 308', 'Caddyfile setup redirect');
  assertContains(caddy, 'handle_path /setup/*', 'Caddyfile setup route');
  assertContains(caddy, 'reverse_proxy 127.0.0.1:{$WIZARD_PORT:8787}', 'Caddyfile wizard upstream');
  assertContains(caddy, 'reverse_proxy 127.0.0.1:{$N8N_PORT:5678}', 'Caddyfile n8n upstream');
  assertContains(caddy, 'Strict-Transport-Security', 'Caddyfile HSTS');
  assertContains(caddy, 'X-Content-Type-Options', 'Caddyfile nosniff');
  assertContains(caddy, 'Referrer-Policy', 'Caddyfile referrer policy');

  assert.match(caddy, /handle\s*\{[\s\S]*reverse_proxy 127\.0\.0\.1:\{\$N8N_PORT:5678\}[\s\S]*\}/);
  assert.equal(caddy.includes('2019'), false, 'Caddy admin endpoint must not be configured');
});

test('server compose adds host-networked Caddy without publishing PostgreSQL', async () => {
  const compose = await text(SERVER_COMPOSE);

  assertContains(compose, 'caddy:2.10-alpine', 'pinned Caddy image');
  assertContains(compose, 'network_mode: host', 'Caddy host networking');
  assertContains(compose, 'restart: unless-stopped', 'Caddy restart policy');
  assertContains(compose, 'condition: service_healthy', 'Caddy depends_on n8n healthy');
  assertContains(compose, 'CRM_DOMAIN:', 'Caddy CRM_DOMAIN env');
  assertContains(compose, 'ACME_EMAIL:', 'Caddy ACME_EMAIL env');
  assertContains(compose, './Caddyfile:/etc/caddy/Caddyfile:ro', 'Caddyfile mount');
  assertContains(compose, 'caddy_data:/data', 'Caddy data volume');
  assertContains(compose, 'caddy_config:/config', 'Caddy config volume');
  assertContains(compose, '127.0.0.1:${N8N_PORT:-5678}:5678', 'loopback n8n publish');

  assert.equal(compose.includes('postgres:'), false, 'server compose must not redefine postgres');
  assert.equal(compose.includes('5432'), false, 'server compose must not publish PostgreSQL');
});

test('base compose carries editor URL and proxy hops defaults', async () => {
  const compose = await text(BASE_COMPOSE);
  assertContains(compose, 'N8N_EDITOR_BASE_URL:', 'base compose editor URL');
  assertContains(compose, 'N8N_PROXY_HOPS:', 'base compose proxy hops');
});

test('installer generates secrets, installs systemd, and issues a one-time token', async () => {
  const installer = await text(INSTALLER);
  const stat = await fs.stat(INSTALLER);

  assert.ok((stat.mode & 0o111) !== 0, 'installer must be executable');
  assertContains(installer, 'set -euo pipefail', 'installer strict mode');
  assertContains(installer, 'openssl rand -hex 32', 'installer secret generation');
  assertContains(installer, 'POSTGRES_PASSWORD', 'installer DB secret');
  assertContains(installer, 'N8N_ENCRYPTION_KEY', 'installer n8n encryption key');
  assertContains(installer, 'LEAD_WEBHOOK_SECRET', 'installer webhook secret');
  assertContains(installer, 'WIZARD_SECRET_KEY', 'installer wizard secret');
  assertContains(installer, '/etc/systemd/system/crm-wizard.service', 'installer unit path');
  assertContains(installer, 'Restart=always', 'installer unit restart policy');
  assertContains(installer, 'systemctl enable --now', 'installer enables unit');
  assertContains(installer, 'SUDO_USER', 'installer derives run user');
  assertContains(installer, 'bootstrap-token', 'installer token path');
  assertContains(installer, 'auth.json', 'installer auth check');
  assertContains(installer, 'chmod 600', 'installer env permissions');
  assertContains(installer, 'install -d -m 700', 'installer data permissions');
  assertContains(installer, 'https://${DOMAIN}/setup/?token=', 'installer first-run URL');
  assertContains(installer, './scripts/migrate.sh', 'installer migrations');
  assertContains(installer, './scripts/import-workflow.sh', 'installer workflow import');
  assertContains(installer, 'WIZARD_ALLOWED_HOSTS', 'installer allowed hosts');
  assertContains(installer, 'https://${DOMAIN}/', 'installer public URLs');
  assertContains(installer, 'curl -fsS "http://127.0.0.1:${WIZARD_PORT_VALUE}/api/health"', 'installer wizard health check');
});

test('.env.example contains server and wizard keys; wizard-data is ignored', async () => {
  const env = await text(ENV_EXAMPLE);
  const ignore = await text(GITIGNORE);
  const keys = [
    'POSTGRES_PASSWORD',
    'N8N_ENCRYPTION_KEY',
    'LEAD_WEBHOOK_SECRET',
    'WIZARD_SECRET_KEY',
    'CRM_DOMAIN',
    'ACME_EMAIL',
    'N8N_EDITOR_BASE_URL',
    'N8N_PROXY_HOPS',
    'N8N_API_URL',
    'N8N_PUBLIC_URL',
    'WIZARD_SERVER_MODE',
    'WIZARD_HOST',
    'WIZARD_PORT',
    'WIZARD_ALLOWED_HOSTS',
    'WIZARD_COOKIE_SECURE',
    'WIZARD_COOKIE_PATH',
    'WIZARD_DATA_DIR',
  ];

  for (const key of keys) {
    assert.match(env, new RegExp(`^${key}=`, 'm'), `.env.example must define ${key}`);
  }
  assert.match(ignore, /^wizard-data\/$/m, '.gitignore must ignore wizard-data/');
});

test('server documentation exists and is linked from the README', async () => {
  const doc = await text(SERVER_DOC);
  const readme = await text(README);

  for (const heading of [
    '## Установка',
    '## Первый запуск',
    '## DNS и TLS',
    '## OAuth callback URL',
    '## Webhook URL',
    '## Firewall',
    '## Резервное копирование',
    '## Обновление',
    '## Откат',
  ]) {
    assertContains(doc, heading, `SERVER.md heading ${heading}`);
  }
  assertContains(doc, 'https://<domain>/setup/', 'SERVER.md setup URL');
  assertContains(doc, 'https://<domain>/rest/oauth2-credential/callback', 'SERVER.md OAuth callback');
  assertContains(doc, 'https://<domain>/webhook/lead-intake', 'SERVER.md webhook URL');
  assertContains(readme, 'docs/SERVER.md', 'README link to SERVER.md');
});

test('installer passes bash syntax check', () => {
  const result = spawnSync('bash', ['-n', INSTALLER], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('installer passes shellcheck when available', { skip: !HAS_SHELLCHECK }, () => {
  const result = spawnSync('shellcheck', [INSTALLER], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('merged compose config is valid', { skip: !HAS_DOCKER_COMPOSE }, () => {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      'docker-compose.yml',
      '-f',
      'docker-compose.server.yml',
      'config',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        POSTGRES_PASSWORD: 'test-password',
        N8N_ENCRYPTION_KEY: 'test-encryption-key',
        CRM_DOMAIN: 'example.test',
        ACME_EMAIL: 'admin@example.test',
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /caddy:/);
  assert.match(result.stdout, /network_mode: host/);
  assert.match(result.stdout, /host_ip: 127\.0\.0\.1/);
  assert.match(result.stdout, /target: 5678/);
  assert.match(result.stdout, /published: "5678"/);
});
