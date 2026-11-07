import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CADDYFILE = path.join(ROOT, 'Caddyfile');
const COMPOSE = path.join(ROOT, 'docker-compose.yml');
const OLD_COMPOSE = path.join(ROOT, 'docker-compose.server.yml');
const INSTALLER = path.join(ROOT, 'scripts/install-server.sh');
const OLD_START = path.join(ROOT, 'scripts/start-wizard.sh');
const DOCKERFILE = path.join(ROOT, 'wizard/Dockerfile');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const SERVER_DOC = path.join(ROOT, 'docs/SERVER.md');
const WIZARD_DOC = path.join(ROOT, 'docs/WIZARD.md');
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

test('Caddy is the single ingress and routes / to n8n and /setup/ to wizard', async () => {
  const caddy = await text(CADDYFILE);

  assertContains(caddy, '{$CRM_DOMAIN}', 'Caddy site address');
  assertContains(caddy, '{$ACME_EMAIL}', 'Caddy ACME email');
  assertContains(caddy, 'redir /setup /setup/ 308', 'setup redirect');
  assertContains(caddy, 'handle_path /setup/*', 'setup route');
  assertContains(caddy, 'reverse_proxy wizard:8787', 'wizard upstream DNS');
  assertContains(caddy, 'reverse_proxy n8n:5678', 'n8n upstream DNS');
  assertContains(caddy, 'Strict-Transport-Security', 'HSTS');
  assertContains(caddy, 'X-Content-Type-Options', 'nosniff');
  assert.equal(caddy.includes('127.0.0.1'), false, 'Caddy must use Compose DNS, not loopback');
  assert.equal(caddy.includes('network_mode'), false, 'Caddy must not rely on host networking');
  assert.equal(caddy.includes('2019'), false, 'Caddy admin endpoint must not be configured');
});

test('one Compose stack contains Caddy, n8n, PostgreSQL and Wizard; only Caddy publishes ports', async () => {
  const compose = await text(COMPOSE);

  for (const service of ['postgres:', 'n8n:', 'wizard:', 'caddy:']) {
    assertContains(compose, `  ${service}`, `compose service ${service}`);
  }
  assertContains(compose, 'dockerfile: wizard/Dockerfile', 'wizard image build');
  assertContains(compose, 'restart: unless-stopped', 'restart policy');
  assertContains(compose, 'condition: service_healthy', 'health dependency');
  assertContains(compose, 'expose:\n      - "5678"', 'n8n internal expose');
  assertContains(compose, 'expose:\n      - "8787"', 'wizard internal expose');
  assertContains(compose, '    ports:\n      - "80:80"\n      - "443:443"', 'Caddy ports');
  assertContains(compose, '/var/run/docker.sock:/var/run/docker.sock', 'wizard operations socket');
  assertContains(compose, 'WIZARD_SERVER_MODE: "1"', 'server auth mode');
  assertContains(compose, 'WIZARD_ALLOWED_HOSTS:', 'proxy host allowlist');
  assertContains(compose, 'WIZARD_COOKIE_SECURE: "1"', 'secure cookie');
  assertContains(compose, 'N8N_API_URL: http://n8n:5678', 'internal n8n API');
  assertContains(compose, 'N8N_PUBLIC_URL: https://${CRM_DOMAIN', 'public URL');
  assertContains(compose, 'caddy_data:', 'Caddy data volume');
  assert.equal(compose.includes('network_mode: host'), false, 'no host networking');
  assert.equal(compose.includes('N8N_BIND_ADDRESS'), false, 'no n8n host bind');
});

test('Wizard image contains only built-in runtime and Docker/Compose helpers', async () => {
  const dockerfile = await text(DOCKERFILE);
  assertContains(dockerfile, 'FROM node:22-alpine', 'Node 22 base');
  for (const pkg of ['bash', 'coreutils', 'curl', 'docker-cli', 'docker-cli-compose', 'python3']) {
    assertContains(dockerfile, pkg, `wizard image package ${pkg}`);
  }
  assertContains(dockerfile, 'ENTRYPOINT ["/app/wizard/entrypoint.sh"]', 'wizard entrypoint');
  assertContains(dockerfile, 'chmod +x /app/wizard/entrypoint.sh', 'executable entrypoint');
  assertContains(dockerfile, 'EXPOSE 8787', 'wizard internal port');
});

test('installer deploys the same unified stack and requires no host Node/systemd', async () => {
  const installer = await text(INSTALLER);
  const stat = await fs.stat(INSTALLER);
  assert.ok((stat.mode & 0o111) !== 0, 'installer executable');
  assertContains(installer, 'set -euo pipefail', 'strict mode');
  assertContains(installer, 'openssl rand -hex 32', 'secret generation');
  for (const key of ['POSTGRES_PASSWORD', 'N8N_ENCRYPTION_KEY', 'LEAD_WEBHOOK_SECRET', 'WIZARD_SECRET_KEY']) {
    assertContains(installer, key, `installer secret ${key}`);
  }
  assertContains(installer, 'bootstrap-token', 'bootstrap token');
  assertContains(installer, 'docker compose up -d --build', 'unified stack deploy');
  assertContains(installer, 'docker compose exec -T wizard', 'wizard health/workflow path');
  assertContains(installer, './scripts/migrate.sh', 'migrations');
  assertContains(installer, 'import-workflow.sh', 'workflow import');
  assertContains(installer, 'https://${DOMAIN}/setup/?token=', 'first-run URL');
  for (const forbidden of ['systemctl', 'crm-wizard.service', 'command -v node']) {
    assert.equal(installer.includes(forbidden), false, `installer must not contain ${forbidden}`);
  }
  assert.equal(installer.includes('docker-compose.server.yml'), false, 'installer must not use overlay');
});

test('old local/server split artifacts are removed', async () => {
  await assert.rejects(fs.access(OLD_COMPOSE), (error) => error.code === 'ENOENT');
  await assert.rejects(fs.access(OLD_START), (error) => error.code === 'ENOENT');
});

test('.env.example describes the unified stack, not local/server modes', async () => {
  const env = await text(ENV_EXAMPLE);
  for (const key of [
    'CRM_DOMAIN',
    'ACME_EMAIL',
    'POSTGRES_PASSWORD',
    'N8N_ENCRYPTION_KEY',
    'LEAD_WEBHOOK_SECRET',
    'WIZARD_SECRET_KEY',
    'WIZARD_SERVER_MODE=1',
    'WIZARD_HOST=0.0.0.0',
    'WIZARD_ALLOWED_HOSTS',
    'WIZARD_COOKIE_SECURE=1',
    'WIZARD_COOKIE_PATH=/setup',
    'WIZARD_DATA_DIR=/data',
    'N8N_API_URL=http://n8n:5678',
    'N8N_PUBLIC_URL',
    'BASE_URL=http://n8n:5678',
  ]) {
    assertContains(env, key, `.env.example ${key}`);
  }
  assert.equal(env.includes('WIZARD_SERVER_MODE=0'), false, 'no local mode switch');
  assert.equal(env.includes('N8N_BIND_ADDRESS'), false, 'no host n8n binding');
});

test('documentation describes one browser-first deployment and no CLI setup step', async () => {
  const serverDoc = await text(SERVER_DOC);
  const wizardDoc = await text(WIZARD_DOC);
  const readme = await text(README);

  for (const heading of ['## Установка', '## Первый запуск', '## DNS и TLS', '## Webhook URL', '## Обновление', '## Откат']) {
    assertContains(serverDoc, heading, `SERVER.md heading ${heading}`);
  }
  assertContains(serverDoc, 'https://<domain>/setup/', 'setup URL');
  assertContains(serverDoc, 'https://<domain>/webhook/lead-intake', 'webhook URL');
  assertContains(serverDoc, 'Caddy', 'Caddy');
  assertContains(wizardDoc, 'https://<domain>/setup/', 'wizard setup URL');
  assertContains(readme, 'docs/SERVER.md', 'README server link');
  assertContains(readme, 'docker compose up -d --build', 'README unified start');
  assert.equal(serverDoc.includes('systemd'), false, 'docs must not describe systemd wizard');
});

test('installer passes bash syntax check', () => {
  const result = spawnSync('bash', ['-n', INSTALLER], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('installer passes shellcheck when available', { skip: !HAS_SHELLCHECK }, () => {
  const result = spawnSync('shellcheck', [INSTALLER], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('unified Compose config is valid and exposes only 80/443', { skip: !HAS_DOCKER_COMPOSE }, () => {
  const env = {
    ...process.env,
    CRM_DOMAIN: 'example.test',
    ACME_EMAIL: 'admin@example.test',
    POSTGRES_PASSWORD: 'test-password',
    N8N_ENCRYPTION_KEY: 'test-encryption-key',
    WIZARD_SECRET_KEY: 'test-wizard-secret',
    LEAD_WEBHOOK_SECRET: 'test-webhook-secret',
  };
  const result = spawnSync('docker', ['compose', 'config'], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /caddy:/);
  assert.match(result.stdout, /wizard:/);
  assert.match(result.stdout, /published: "80"/);
  assert.match(result.stdout, /published: "443"/);
  assert.equal(result.stdout.includes('published: "5678"'), false, 'n8n must not publish 5678');
  assert.equal(result.stdout.includes('published: "8787"'), false, 'wizard must not publish 8787');
  assert.equal(result.stdout.includes('published: "5432"'), false, 'postgres must not publish 5432');
});
