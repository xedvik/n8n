import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const workflow = JSON.parse(await readFile(new URL('workflows/lead-intake.json', root), 'utf8'));
const exampleConfig = JSON.parse(await readFile(new URL('config/example-client.json', root), 'utf8'));
const validLead = JSON.parse(await readFile(new URL('examples/valid-lead.json', root), 'utf8'));

const clone = (value) => JSON.parse(JSON.stringify(value));

function codeNode(name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name && candidate.type === 'n8n-nodes-base.code');
  assert.ok(node, `Code node "${name}" not found in workflow`);
  return node.parameters.jsCode;
}

function runCode(name, { input, nodes = {}, execution = { id: 'test-execution' } }) {
  const $ = (nodeName) => {
    assert.ok(Object.hasOwn(nodes, nodeName), `Missing mock for node "${nodeName}"`);
    const item = { json: nodes[nodeName] };
    return {
      first: () => item,
      all: () => [item],
      item,
    };
  };
  const $input = {
    first: () => ({ json: input }),
    all: () => [{ json: input }],
  };
  const fn = new Function('$', '$input', '$execution', codeNode(name));
  return fn($, $input, execution);
}

function normalize(body, config = clone(exampleConfig)) {
  return runCode('Normalize Lead', {
    input: {},
    nodes: {
      'Validate Client Config': { config },
      'Lead Webhook': { body },
    },
  })[0].json;
}

function validate(normalized) {
  return runCode('Validate Lead', { input: normalized })[0].json;
}

test('normalizes a valid payload into the internal Lead shape', () => {
  const normalized = normalize(validLead);
  assert.deepEqual(normalized.lead, {
    name: 'Ivan Petrov',
    email: 'ivan.petrov@example.com',
    phone: '+79991234567',
    source: 'website',
    message: 'Please contact me about delivery to Kazan.',
    externalId: 'site-1001',
  });
  assert.equal(normalized.meta.bodyIsObject, true);
  assert.equal(normalized.meta.requestId, 'test-execution');
  assert.match(normalized.meta.receivedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('applies nested field mapping from config without changing code', () => {
  const config = clone(exampleConfig);
  config.mapping = {
    name: 'contact.full_name',
    email: 'contact.email',
    phone: 'contact.phone',
    source: 'utm.source',
    message: 'details.text',
    externalId: 'meta.id',
  };
  const normalized = normalize({
    contact: {
      full_name: '  Anna  ',
      email: 'ANNA@EXAMPLE.COM',
      phone: '8 (900) 111-22-33',
    },
    utm: { source: 'Landing' },
    details: { text: 'Call me' },
    meta: { id: 77 },
  }, config);
  assert.equal(normalized.lead.name, 'Anna');
  assert.equal(normalized.lead.email, 'anna@example.com');
  assert.equal(normalized.lead.phone, '89001112233');
  assert.equal(normalized.lead.source, 'landing');
  assert.equal(normalized.lead.externalId, '77');
});

test('validates required name and at least one contact', () => {
  const invalid = normalize({ name: '   ', email: '', phone: '', source: 'web' });
  const validated = validate(invalid);
  assert.equal(validated.validation.valid, false);
  assert.deepEqual(validated.validation.errors, [
    'name is required.',
    'At least one of email or phone is required.',
  ]);
});

test('rejects a non-object request body with a clear validation error', () => {
  const normalized = normalize('not-an-object');
  const validated = validate(normalized);
  assert.equal(validated.validation.valid, false);
  assert.equal(validated.validation.errors[0], 'Request body must be a JSON object.');
});

test('validates the client config and reports every missing section', () => {
  const broken = clone(exampleConfig);
  broken.telegram.chatId = '';
  broken.googleSheets.columns = {};
  assert.throws(
    () => runCode('Validate Client Config', { input: { config: broken } }),
    /Invalid client config: .*googleSheets\.columns\.name.*telegram\.chatId/,
  );
});

test('maps the Lead to Google Sheets headers from config', () => {
  const config = clone(exampleConfig);
  const validated = validate(normalize(validLead, config));
  const row = runCode('Map Lead To CRM Payload', {
    input: {},
    nodes: {
      'Validate Client Config': { config },
      'Validate Lead': validated,
    },
  })[0].json;
  assert.deepEqual(row, {
    'Created At': validated.meta.receivedAt,
    'External ID': 'site-1001',
    Name: 'Ivan Petrov',
    Email: 'ivan.petrov@example.com',
    Phone: '+79991234567',
    Source: 'website',
    Message: 'Please contact me about delivery to Kazan.',
    'Request ID': 'test-execution',
  });
});

test('builds a Telegram message from the configured template without regex replacement bugs', () => {
  const config = clone(exampleConfig);
  config.telegram.messageTemplate = 'Lead {{name}} / {{email}}\n{{message}}';
  const validated = validate(normalize({ ...validLead, name: 'Ivan <Admin> & Co', message: 'Price is $& and $1' }, config));
  const message = runCode('Build Notification Message', {
    input: {},
    nodes: {
      'Validate Client Config': { config },
      'Validate Lead': validated,
    },
  })[0].json.text;
  assert.match(message, /Lead Ivan &lt;Admin&gt; &amp; Co \/ ivan\.petrov@example\.com\nPrice is \$&amp; and \$1/);
});

test('rejects unknown Telegram template placeholders in config', () => {
  const broken = clone(exampleConfig);
  broken.telegram.messageTemplate = 'Lead {{name}} {{typo}}';
  assert.throws(
    () => runCode('Validate Client Config', { input: { config: broken } }),
    /unknown placeholder \{\{typo\}\}/,
  );
});

test('Telegram node uses HTML parse mode, disables attribution, and no node stores credentials', () => {
  const telegram = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.telegram');
  assert.equal(telegram.parameters.additionalFields.parse_mode, 'HTML');
  assert.equal(telegram.parameters.additionalFields.appendAttribution, false);
  for (const node of workflow.nodes) {
    assert.equal(node.credentials, undefined, `Node "${node.name}" must not contain credentials`);
  }
});

test('workflow requires Header Auth, stores no credentials, and writes Sheets as RAW', () => {
  const webhook = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.webhook');
  assert.equal(webhook.parameters.authentication, 'headerAuth');
  assert.equal(webhook.credentials, undefined);
  for (const node of workflow.nodes) {
    assert.equal(node.credentials, undefined, `Node "${node.name}" must not contain credentials`);
  }
  const sheetsNodes = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.googleSheets');
  assert.equal(sheetsNodes.length, 2);
  for (const node of sheetsNodes) {
    assert.equal(node.parameters.options.cellFormat, 'RAW');
  }
});

test('success response reports both integrations', () => {
  const validated = validate(normalize(validLead));
  const response = runCode('Build Success Response', {
    input: {},
    nodes: { 'Validate Lead': validated },
  })[0].json.response;
  assert.deepEqual(response, {
    ok: true,
    status: 'created',
    saved: true,
    notified: true,
    requestId: 'test-execution',
    externalId: 'site-1001',
  });
});

test('CRM failure response never looks like success and carries a diagnostic log', () => {
  const validated = validate(normalize(validLead));
  const result = runCode('Build CRM Failure Response', {
    input: { error: 'Google API is unavailable' },
    nodes: { 'Validate Lead': validated },
  })[0].json;
  assert.equal(result.response.ok, false);
  assert.equal(result.response.saved, false);
  assert.equal(result.response.notified, false);
  assert.equal(result.log.stage, 'google_sheets_append');
  assert.match(result.log.error, /Google API is unavailable/);
  assert.equal(result.log.requestId, 'test-execution');
});

test('Telegram failure is reported as saved with a warning, not full success', () => {
  const validated = validate(normalize(validLead));
  const result = runCode('Build Notification Warning', {
    input: { error: 'Telegram API is unavailable' },
    nodes: { 'Validate Lead': validated },
  })[0].json;
  assert.equal(result.response.ok, true);
  assert.equal(result.response.saved, true);
  assert.equal(result.response.notified, false);
  assert.equal(result.response.status, 'saved_with_notification_error');
  assert.equal(result.log.stage, 'telegram_send');
});
