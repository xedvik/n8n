import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

test('wizard exposes five stages and status-driven progress', async () => {
  const app = await fs.readFile(path.join(ROOT, 'wizard/public/app.js'), 'utf8');
  for (const id of ['start', 'company', 'integrations', 'verify', 'done']) {
    assert.match(app, new RegExp(`id: '${id}'`), `stage ${id}`);
  }
  assert.match(app, /stageStatus/);
  assert.match(app, /configured: 'Настроено, не проверено'/);
  assert.match(app, /verified: 'Проверено'/);
  assert.equal(app.includes('start-wizard.sh'), false);
});

test('registration never asks for a bootstrap token manually', async () => {
  const login = await fs.readFile(path.join(ROOT, 'wizard/public/login.js'), 'utf8');
  assert.equal(login.includes('id="setup-token"'), false);
  assert.match(login, /renderMissingLink/);
  assert.match(login, /readSetupToken/);
  assert.match(login, /history\.replaceState/);
});

test('Telegram onboarding discovers chats instead of requiring a numeric ID first', async () => {
  const integrations = await fs.readFile(path.join(ROOT, 'wizard/lib/integrations.mjs'), 'utf8');
  assert.match(integrations, /getUpdates/);
  assert.match(integrations, /chats/);
});

test('save-and-apply has a restore point and rollback path', async () => {
  const app = await fs.readFile(path.join(ROOT, 'wizard/public/app.js'), 'utf8');
  assert.match(app, /api\/config\/backups/);
  assert.match(app, /api\/config\/restore/);
  assert.match(app, /Предыдущая конфигурация восстановлена/);
  assert.match(app, /workflow\/apply/);
});
