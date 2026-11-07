import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-wizard-test-'));
const tempConfig = path.join(tempDir, 'client.json');
process.env.WIZARD_CONFIG_FILE = tempConfig;
process.env.LEAD_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.LEAD_WEBHOOK_HEADER_NAME = 'X-Webhook-Secret';
process.env.POSTGRES_DB = 'n8n';
process.env.POSTGRES_USER = 'n8n';
process.env.POSTGRES_PASSWORD = 'test-password';

const configModule = await import('../wizard/lib/config.mjs');
const security = await import('../wizard/lib/security.mjs');
const { N8nApi } = await import('../wizard/lib/n8n-api.mjs');
const { ensureCredential, parseServiceAccount } = await import('../wizard/lib/integrations.mjs');
const { applyWorkflowCredentials } = await import('../wizard/lib/workflow.mjs');

test.after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function jsonResponse(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
  res.end(payload);
}

test('extracts Google spreadsheet IDs from URLs and bare IDs', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  assert.equal(configModule.extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`), id);
  assert.equal(configModule.extractSpreadsheetId(id), id);
  assert.equal(configModule.extractSpreadsheetId('not a spreadsheet'), null);
});

test('validates IANA timezones', () => {
  assert.equal(configModule.isValidTimezone('Asia/Tbilisi'), true);
  assert.equal(configModule.isValidTimezone('Europe/Moscow'), true);
  assert.equal(configModule.isValidTimezone('Mars/Olympus'), false);
  assert.equal(configModule.isValidTimezone(''), false);
});

test('security helpers reject non-loopback hosts and redact secrets', () => {
  assert.equal(security.isLoopback('127.0.0.1'), true);
  assert.equal(security.isLoopback('::1'), true);
  assert.equal(security.isLoopback('10.0.0.5'), false);
  assert.equal(security.hostAllowed('127.0.0.1:8787', 8787), true);
  assert.equal(security.hostAllowed('evil.example:8787', 8787), false);
  assert.equal(security.originAllowed('http://127.0.0.1:8787', '127.0.0.1:8787'), true);
  assert.equal(security.originAllowed('https://evil.example', '127.0.0.1:8787'), false);
  assert.equal(security.sanitizeText('token n8n_api_secret and bot123:abcdef', ['n8n_api_secret']), 'token [redacted] and bot[redacted]');
});

test('normalizes config through the workflow validator and preserves advanced fields', async () => {
  const base = JSON.parse(await fs.readFile(path.join(configModule.ROOT, 'config/example-client.json'), 'utf8'));
  base.mapping.email = 'contact_email';
  base.retry.maxAttempts = 7;
  const result = await configModule.validateConfig(base);
  assert.equal(result.ok, true);
  assert.equal(result.config.mapping.email, 'contact_email');
  assert.equal(result.config.retry.maxAttempts, 7);
});

test('invalid config is rejected without overwriting the existing file', async () => {
  const base = JSON.parse(await fs.readFile(path.join(configModule.ROOT, 'config/example-client.json'), 'utf8'));
  await fs.writeFile(tempConfig, `${JSON.stringify(base, null, 2)}\n`, { mode: 0o600 });
  const before = await fs.readFile(tempConfig, 'utf8');
  await assert.rejects(
    () => configModule.saveConfig({ timezone: 'Mars/Olympus' }),
    (error) => error.code === 'invalid_config',
  );
  assert.equal(await fs.readFile(tempConfig, 'utf8'), before);
});

test('saves a valid config atomically and keeps a backup', async () => {
  const base = JSON.parse(await fs.readFile(path.join(configModule.ROOT, 'config/example-client.json'), 'utf8'));
  await fs.writeFile(tempConfig, `${JSON.stringify(base, null, 2)}\n`, { mode: 0o600 });
  const result = await configModule.saveConfig({ clientName: 'Wizard Test', timezone: 'Asia/Tbilisi' });
  assert.equal(result.config.clientName, 'Wizard Test');
  assert.equal(result.config.timezone, 'Asia/Tbilisi');
  assert.equal(result.backupCreated, true);
  const mode = (await fs.stat(tempConfig)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('creates, lists, and restores config backups without traversal', async () => {
  const before = JSON.parse(await fs.readFile(tempConfig, 'utf8'));
  const created = await configModule.createConfigBackup();
  assert.match(created.name, /^\.client-config\..+\.json$/);
  const listed = await configModule.listConfigBackups();
  assert.equal(listed.some((item) => item.name === created.name), true);
  await configModule.saveConfig({ clientName: 'After Backup' });
  const restored = await configModule.restoreConfigBackup(created.name);
  assert.equal(restored.config.clientName, before.clientName);
  await assert.rejects(
    () => configModule.restoreConfigBackup('../client.json'),
    (error) => error.code === 'invalid_backup',
  );
});

test('n8n client lists paginated credentials, creates, tests, and updates workflow safely', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      if (req.method === 'GET' && req.url === '/api/v1/credentials?limit=250') {
        jsonResponse(res, 200, { data: [{ id: 'a', name: 'A', type: 'httpHeaderAuth' }], nextCursor: 'next' });
      } else if (req.method === 'GET' && req.url === '/api/v1/credentials?limit=250&cursor=next') {
        jsonResponse(res, 200, { data: [{ id: 'b', name: 'B', type: 'telegramApi' }] });
      } else if (req.method === 'POST' && req.url === '/api/v1/credentials') {
        jsonResponse(res, 201, { id: 'new', name: 'New', type: 'telegramApi' });
      } else if (req.method === 'POST' && req.url === '/api/v1/credentials/new/test') {
        jsonResponse(res, 200, { status: 'OK', message: 'ok' });
      } else if (req.method === 'GET' && req.url === '/api/v1/workflows/w1') {
        jsonResponse(res, 200, { id: 'w1', name: 'W', nodes: [], connections: {}, settings: {} });
      } else if (req.method === 'PUT' && req.url === '/api/v1/workflows/w1?publishIfActive=true') {
        jsonResponse(res, 200, { id: 'w1', name: 'W', active: true, versionId: 'v2', nodes: [] });
      } else {
        jsonResponse(res, 404, { message: 'not found' });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const api = new N8nApi({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'server-only-key' });
  try {
    const credentials = await api.listCredentials();
    assert.deepEqual(credentials.map((item) => item.id), ['a', 'b']);
    const created = await api.createCredential({ name: 'New', type: 'telegramApi', data: { accessToken: 'x' } });
    assert.equal(created.id, 'new');
    const tested = await api.testCredential('new');
    assert.equal(tested.status, 'OK');
    await api.updateWorkflow('w1', {
      name: 'W', nodes: [], connections: {}, settings: {}, description: null, meta: { ignored: true },
    });
    const update = requests.find((request) => request.method === 'PUT');
    assert.deepEqual(update.body, { name: 'W', nodes: [], connections: {}, settings: {} });
    assert.equal(requests.some((request) => request.body?.data?.accessToken === 'x'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('credential provisioning reuses stable names and can create a replacement', async () => {
  const calls = [];
  const api = {
    async listCredentials(type) { return type === 'httpHeaderAuth' ? [{ id: 'old', name: 'CRM Automation Kit - Header Auth', type }] : []; },
    async createCredential(body) { calls.push(body); return { id: 'new', name: body.name, type: body.type }; },
    async getCredential(id) { return { id, name: 'Existing', type: 'httpHeaderAuth' }; },
  };
  const reused = await ensureCredential(api, { kind: 'header_auth' });
  assert.equal(reused.credential.id, 'old');
  assert.equal(calls.length, 0);
  const replaced = await ensureCredential(api, { kind: 'header_auth', replaceExisting: true });
  assert.equal(replaced.credential.id, 'new');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.value, 'test-webhook-secret');
});

test('service account parser rejects non-Google JSON', () => {
  assert.throws(() => parseServiceAccount('{"type":"service_account"}'), /client_email|private_key/);
  assert.throws(() => parseServiceAccount('not-json'), /JSON/);
  const parsed = parseServiceAccount({
    client_email: 'bot@example.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
  });
  assert.equal(parsed.client_email, 'bot@example.iam.gserviceaccount.com');
});

test('workflow credential assignment touches only required nodes and preserves other nodes', async () => {
  const node = (name) => ({ name, type: 'n8n-nodes-base.noOp', parameters: {}, credentials: {} });
  const workflow = {
    id: 'w1',
    name: 'Lead Intake',
    active: true,
    nodes: [
      node('Lead Webhook'), node('Recovery Request'), node('Reserve Operation'),
      node('Save CRM State'), node('Save CRM Failure State'), node('Save Journal State'),
      node('Save Journal Failure State'), node('Save Notification State'), node('Save Final State'),
      node('Select Due Operations'), node('CRM Adapter - Google Sheets'),
      node('Journal Adapter - Google Sheets'), node('Error Log Adapter - Google Sheets'),
      node('Read CRM Leads'), node('Read Journal'), node('HubSpot Search Contact'),
      node('HubSpot Create Contact'), node('HubSpot Update Contact'),
      node('Notification Adapter - Telegram'), node('Untouched'),
    ],
    connections: { a: { main: [[{ node: 'b', type: 'main', index: 0 }]] } },
    settings: { executionOrder: 'v1' },
    meta: { keep: true },
  };
  let putBody = null;
  const api = {
    async getWorkflow() { return structuredClone(workflow); },
    async updateWorkflow(_id, body) { putBody = structuredClone(body); return { ...body, active: true, versionId: 'v2' }; },
  };
  const config = {
    crm: { provider: 'hubspot' },
    journal: { enabled: true },
    notifications: { enabled: true },
    errors: { enabled: false },
  };
  const credentials = {
    headerAuth: { id: 'h', name: 'H' },
    postgres: { id: 'p', name: 'P' },
    google: { id: 'g', name: 'G', type: 'googleApi', mode: 'service_account' },
    hubspot: { id: 'hs', name: 'HS', type: 'hubspotAppToken' },
    telegram: { id: 't', name: 'T' },
  };
  const result = await applyWorkflowCredentials(api, config, credentials);
  assert.equal(result.workflow.active, true);
  assert.equal(result.updatedNodes.length, 19);
  assert.deepEqual(putBody.meta, { keep: true });
  assert.deepEqual(putBody.connections, workflow.connections);
  const byName = Object.fromEntries(putBody.nodes.map((item) => [item.name, item]));
  assert.equal(byName['Lead Webhook'].credentials.httpHeaderAuth.id, 'h');
  assert.equal(byName['Reserve Operation'].credentials.postgres.id, 'p');
  assert.equal(byName['CRM Adapter - Google Sheets'].parameters.authentication, 'serviceAccount');
  assert.equal(byName['CRM Adapter - Google Sheets'].credentials.googleApi.id, 'g');
  assert.equal(byName['HubSpot Create Contact'].parameters.nodeCredentialType, 'hubspotAppToken');
  assert.equal(byName['Notification Adapter - Telegram'].credentials.telegramApi.id, 't');
  assert.deepEqual(byName.Untouched.credentials, {});
});

test('workflow credential assignment rejects a headerAuth credential with the wrong type', async () => {
  let putCalled = false;
  const api = {
    async getWorkflow() { return { id: 'w1', nodes: [], connections: {}, settings: {} }; },
    async updateWorkflow() { putCalled = true; return {}; },
  };
  await assert.rejects(
    () => applyWorkflowCredentials(api, {}, {
      headerAuth: { id: 'h', name: 'H', type: 'httpBasicAuth' },
    }),
    (error) =>
      error.code === 'credential_type_mismatch'
      && error.message.includes('«Header Auth»')
      && error.message.includes('фактический «httpBasicAuth»')
      && error.message.includes('ожидаемый «httpHeaderAuth»'),
  );
  assert.equal(putCalled, false);
});

test('workflow credential assignment rejects a telegram credential with the wrong type', async () => {
  let putCalled = false;
  const api = {
    async getWorkflow() { return { id: 'w1', nodes: [], connections: {}, settings: {} }; },
    async updateWorkflow() { putCalled = true; return {}; },
  };
  await assert.rejects(
    () => applyWorkflowCredentials(api, { notifications: { enabled: true } }, {
      telegram: { id: 't', name: 'T', type: 'telegram' },
    }),
    (error) =>
      error.code === 'credential_type_mismatch'
      && error.message.includes('«Telegram»')
      && error.message.includes('фактический «telegram»')
      && error.message.includes('ожидаемый «telegramApi»'),
  );
  assert.equal(putCalled, false);
});
