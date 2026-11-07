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
  assert.match(app, /api\/workflow\/backups/);
  assert.match(app, /api\/workflow\/restore/);
  assert.match(app, /Предыдущая конфигурация восстановлена/);
  assert.match(app, /workflow\/apply/);
  assert.equal(app.includes('saveConfigOnly'), false);
  assert.equal(app.includes("data-action=\"save-only\""), false);
});

test('doctor failure is treated as a failed apply and starts rollback', async () => {
  const app = await fs.readFile(path.join(ROOT, 'wizard/public/app.js'), 'utf8');
  assert.match(app, /doctor\.result !== 'PASS'/);
  assert.match(app, /Применение отменено/);
  assert.match(app, /Применение частично выполнено/);
  assert.match(app, /workflowAttempted/);
  assert.match(app, /configRestored/);
});

test('timezone edits mark state dirty and clear stale verification', async () => {
  const app = await fs.readFile(path.join(ROOT, 'wizard/public/app.js'), 'utf8');
  assert.match(app, /function markDirty\(kind = null\)/);
  assert.match(app, /state\.timezone = search\.value/);
  assert.match(app, /state\.applyStatus = null/);
  assert.match(app, /lastWorkflowBackup/);
  assert.match(app, /function integrationScope\(kind\)/);
  assert.match(app, /function readinessState\(\)/);
  assert.match(app, /function e2eIsCurrent\(\)/);
  assert.match(app, /function integrationScope\(kind\)/);
});

test('HubSpot onboarding uses Service Keys, not legacy private apps', async () => {
  const app = await fs.readFile(path.join(ROOT, 'wizard/public/app.js'), 'utf8');
  assert.equal(app.includes('settings/private-apps'), false);
  assert.match(app, /https:\/\/app\.hubspot\.com\//);
  assert.match(app, /account-service-keys/);
  assert.match(app, /Service Key/);
});

test('doctor checks have distinct levels and reconciliation warning', async () => {
  const app = await fs.readFile(path.join(ROOT, 'wizard/public/app.js'), 'utf8');
  const styles = await fs.readFile(path.join(ROOT, 'wizard/public/styles.css'), 'utf8');
  assert.match(app, /doctor-level doctor-/);
  assert.match(app, /doctor-reconciliation/);
  assert.match(styles, /\.doctor-ok/);
  assert.match(styles, /\.doctor-warn/);
  assert.match(styles, /\.doctor-fail/);
  assert.match(styles, /\.doctor-info/);
});

test('summary rows can wrap long webhook URLs on mobile', async () => {
  const styles = await fs.readFile(path.join(ROOT, 'wizard/public/styles.css'), 'utf8');
  assert.match(styles, /\.summary \{[^}]*min-width: 0/);
  assert.match(styles, /\.summary-row \{[^}]*min-width: 0/);
  assert.match(styles, /\.summary-row span:last-child \{[^}]*overflow-wrap: anywhere/);
});

test('server persists only safe verification metadata for the applied config hash', async () => {
  const server = await fs.readFile(path.join(ROOT, 'wizard/server.mjs'), 'utf8');
  const store = await fs.readFile(path.join(ROOT, 'wizard/lib/verification-store.mjs'), 'utf8');
  assert.match(server, /configHash: appliedConfigHash/);
  assert.match(server, /verifications: await listVerificationHistory/);
  assert.match(server, /recordVerification/);
  assert.match(server, /verificationKind/);
  assert.match(store, /checkedAt/);
  assert.match(store, /scope/);
  assert.match(store, /listVerificationHistory/);
  assert.equal(store.includes('message:'), false, 'verification store must not persist messages');
  assert.equal(store.includes('token:'), false, 'verification store must not persist tokens');
});
