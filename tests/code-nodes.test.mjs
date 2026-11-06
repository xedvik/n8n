import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const workflow = JSON.parse(await readFile(new URL('workflows/lead-intake.json', root), 'utf8'));
const exampleConfig = JSON.parse(await readFile(new URL('config/example-client.json', root), 'utf8'));
const legacyConfig = JSON.parse(await readFile(new URL('config/example-legacy-google-sheets.json', root), 'utf8'));
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
    return { first: () => item, all: () => [item], item };
  };
  const $input = {
    first: () => ({ json: input }),
    all: () => [{ json: input }],
  };
  const fn = new Function('$', '$input', '$execution', codeNode(name));
  return fn($, $input, execution);
}

function validateConfig(rawConfig) {
  return runCode('Validate Client Config', { input: { config: clone(rawConfig) } })[0].json.config;
}

function normalize(body, rawConfig = exampleConfig) {
  const config = validateConfig(rawConfig);
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

function prepareHubspot(validated, rawConfig = exampleConfig) {
  const config = validateConfig(rawConfig);
  return runCode('Prepare HubSpot Contact', {
    input: {},
    nodes: {
      'Validate Client Config': { config },
      'Validate Lead': validated,
    },
  })[0].json;
}

function contextFor(crm, overrides = {}) {
  const validated = validate(normalize(validLead));
  return {
    lead: validated.lead,
    meta: validated.meta,
    config: validateConfig(exampleConfig),
    crm,
    journal: { enabled: false, status: 'disabled' },
    notifications: { enabled: false, status: 'disabled', channels: [] },
    warnings: [],
    hasWarning: false,
    ...overrides,
  };
}

test('normalizes legacy v1 config to v2 Google Sheets-only mode', () => {
  const config = validateConfig(legacyConfig);
  assert.equal(config.version, 2);
  assert.equal(config.crm.provider, 'google_sheets');
  assert.equal(config.journal.enabled, false);
  assert.equal(config.notifications.enabled, true);
  assert.deepEqual(config.notifications.channels, ['telegram']);
  assert.equal(config.errors.enabled, true);
});

test('validates the v2 HubSpot example config', () => {
  const config = validateConfig(exampleConfig);
  assert.equal(config.crm.provider, 'hubspot');
  assert.equal(config.crm.hubspot.phoneOnlyPolicy, 'skip');
  assert.equal(config.journal.enabled, true);
  assert.equal(config.errors.enabled, true);
});

test('rejects invalid v2 integration combinations', () => {
  const noEmailMapping = clone(exampleConfig);
  delete noEmailMapping.crm.hubspot.propertyMapping.email;
  assert.throws(() => validateConfig(noEmailMapping), /propertyMapping\.email/);

  const noChat = clone(exampleConfig);
  noChat.notifications.telegram.chatId = '';
  assert.throws(() => validateConfig(noChat), /notifications\.telegram\.chatId/);

  const badTimezone = clone(exampleConfig);
  badTimezone.timezone = 'Not/A_Timezone';
  assert.throws(() => validateConfig(badTimezone), /timezone must be a valid IANA timezone/);

  const noTimezone = clone(exampleConfig);
  delete noTimezone.timezone;
  assert.equal(validateConfig(noTimezone).timezone, 'UTC');

  const noPersistence = clone(exampleConfig);
  noPersistence.crm.provider = 'none';
  noPersistence.journal.enabled = false;
  assert.throws(() => validateConfig(noPersistence), /at least one persistence target/);

  const duplicateJournal = clone(legacyConfig);
  duplicateJournal.version = 2;
  duplicateJournal.crm = {
    provider: 'google_sheets',
    googleSheets: {
      spreadsheetId: 'spreadsheet-1',
      leadsSheetName: 'Leads',
      columns: { name: 'Name', email: 'Email' },
    },
  };
  duplicateJournal.journal = {
    enabled: true,
    provider: 'google_sheets',
    googleSheets: {
      spreadsheetId: 'spreadsheet-1',
      sheetName: 'Leads',
      columns: { name: 'Name', email: 'Email' },
    },
  };
  duplicateJournal.notifications = { enabled: false, channels: [] };
  duplicateJournal.errors = { enabled: false };
  assert.throws(() => validateConfig(duplicateJournal), /different sheet/);
});

test('normalizes a valid payload and derives first/last names', () => {
  const normalized = normalize(validLead);
  assert.equal(normalized.lead.name, 'Ivan Petrov');
  assert.equal(normalized.lead.firstName, 'Ivan');
  assert.equal(normalized.lead.lastName, 'Petrov');
  assert.equal(normalized.lead.email, 'ivan.petrov@example.com');
  assert.equal(normalized.lead.phone, '+79991234567');
  assert.equal(normalized.lead.source, 'website');
  assert.equal(normalized.meta.requestId, 'test-execution');
});

test('keeps technical time in UTC and formats display time in client timezone', () => {
  const config = clone(exampleConfig);
  config.timezone = 'Asia/Tbilisi';
  const normalized = normalize(validLead, config);
  assert.match(normalized.meta.receivedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(normalized.meta.timezone, 'Asia/Tbilisi');
  const expected = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tbilisi',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(normalized.meta.receivedAt));
  assert.equal(normalized.meta.displayReceivedAt, expected);
  assert.notEqual(normalized.meta.displayReceivedAt, normalized.meta.receivedAt);
});

test('applies nested input mapping and source fallback', () => {
  const config = clone(exampleConfig);
  config.mapping = {
    name: 'contact.full_name',
    email: 'contact.email',
    phone: 'contact.phone',
    source: 'utm.source',
    message: 'details.text',
    externalId: 'meta.id',
  };
  config.source.allowedSources = ['landing'];
  const normalized = normalize({
    contact: { full_name: ' Anna Smith ', email: 'ANNA@EXAMPLE.COM', phone: '8 (900) 111-22-33' },
    utm: { source: 'unknown-source' },
    details: { text: 'Call me' },
    meta: { id: 77 },
  }, config);
  assert.equal(normalized.lead.name, 'Anna Smith');
  assert.equal(normalized.lead.firstName, 'Anna');
  assert.equal(normalized.lead.lastName, 'Smith');
  assert.equal(normalized.lead.email, 'anna@example.com');
  assert.equal(normalized.lead.phone, '89001112233');
  assert.equal(normalized.lead.source, 'website');
  assert.equal(normalized.meta.sourceAdjusted, true);
});

test('validates required name and contacts', () => {
  const invalid = normalize({ name: '   ', email: '', phone: '', source: 'web' });
  const validated = validate(invalid);
  assert.equal(validated.validation.valid, false);
  assert.deepEqual(validated.validation.errors, [
    'name is required.',
    'At least one of email or phone is required.',
  ]);
});

test('prepares HubSpot email lookup with configured property mapping', () => {
  const validated = validate(normalize(validLead));
  const prepared = prepareHubspot(validated);
  assert.equal(prepared.action, 'search');
  assert.equal(prepared.matchedBy, 'email');
  assert.equal(prepared.searchProperty, 'email');
  assert.equal(prepared.contactProperties.email, 'ivan.petrov@example.com');
  assert.equal(prepared.contactProperties.firstname, 'Ivan');
  assert.equal(prepared.contactProperties.lastname, 'Petrov');
  assert.equal(prepared.contactProperties.phone, '+79991234567');
  assert.equal(prepared.requestBody.limit, 10);
  assert.deepEqual(prepared.requestBody.filterGroups[0].filters[0], {
    propertyName: 'email',
    operator: 'EQ',
    value: 'ivan.petrov@example.com',
  });
});

test('phone-only lead is skipped without HubSpot API call under default policy', () => {
  const validated = validate(normalize({
    name: 'Phone Only',
    phone: '+7 (900) 555-20-20',
    source: 'web',
    message: 'call me',
  }));
  const prepared = prepareHubspot(validated);
  assert.equal(prepared.action, 'skip');
  assert.equal(prepared.reason, 'phone_only');
  assert.equal(prepared.requestBody, null);
});

test('rejects unsupported HubSpot phone-only policies', () => {
  const config = clone(exampleConfig);
  config.crm.hubspot.phoneOnlyPolicy = 'search_then_create';
  assert.throws(() => validateConfig(config), /supports only "skip"/);
});

test('resolves HubSpot search results into create/update/skip decisions', () => {
  const validated = validate(normalize(validLead));
  const prepared = prepareHubspot(validated);
  const run = (response) => runCode('Resolve HubSpot Match', {
    input: response,
    nodes: { 'Prepare HubSpot Contact': prepared },
  })[0].json;

  assert.equal(run({ total: 0, results: [] }).action, 'create');
  const updated = run({ total: 1, results: [{ id: 'contact-1', properties: { email: 'x' } }] });
  assert.equal(updated.action, 'update');
  assert.equal(updated.contactId, 'contact-1');
  assert.deepEqual(updated.requestBody, { properties: prepared.contactProperties });
  const ambiguous = run({ total: 2, results: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(ambiguous.action, 'skip');
  assert.equal(ambiguous.reason, 'ambiguous_match');
});

test('normalizes HubSpot created and updated results', () => {
  const validated = validate(normalize(validLead));
  const prepared = prepareHubspot(validated);
  const resolve = (action) => ({ ...prepared, action, contactId: action === 'update' ? 'contact-1' : null, matchCount: action === 'update' ? 1 : 0 });
  const created = runCode('Normalize HubSpot Result', {
    input: { id: 'contact-new', properties: {} },
    nodes: { 'Resolve HubSpot Match': resolve('create') },
  })[0].json.crm;
  assert.equal(created.status, 'created');
  assert.equal(created.httpStatus, 201);
  assert.equal(created.provider, 'hubspot');

  const updated = runCode('Normalize HubSpot Result', {
    input: { id: 'contact-1', properties: {} },
    nodes: { 'Resolve HubSpot Match': resolve('update') },
  })[0].json.crm;
  assert.equal(updated.status, 'updated');
  assert.equal(updated.httpStatus, 200);
});

test('builds correct HTTP/response semantics for CRM, journal and notification states', () => {
  const build = (crm, overrides = {}) => runCode('Build Response', {
    input: contextFor(crm, overrides),
  })[0].json;

  const created = build({ provider: 'hubspot', status: 'created', httpStatus: 201, contactId: 'c1', matchedBy: 'email', matchCount: 0 });
  assert.equal(created.httpStatus, 201);
  assert.equal(created.response.status, 'created');
  assert.equal(created.response.saved, true);
  assert.match(created.response.receivedAt, /Z$/);
  assert.equal(typeof created.response.displayTime, 'string');

  const updated = build({ provider: 'hubspot', status: 'updated', httpStatus: 200, contactId: 'c1', matchedBy: 'email', matchCount: 1 });
  assert.equal(updated.httpStatus, 200);
  assert.equal(updated.response.status, 'updated');

  const skipped = build(
    { provider: 'hubspot', status: 'skipped', httpStatus: 202, reason: 'phone_only' },
    { journal: { enabled: true, status: 'saved' } },
  );
  assert.equal(skipped.httpStatus, 202);
  assert.equal(skipped.response.status, 'crm_skipped');
  assert.equal(skipped.response.saved, true);

  const telegramFailed = build(
    { provider: 'hubspot', status: 'created', httpStatus: 201 },
    { notifications: { enabled: true, status: 'failed', channels: ['telegram'] }, warnings: ['notification_send_failed'], hasWarning: true },
  );
  assert.equal(telegramFailed.response.status, 'saved_with_notification_error');
  assert.equal(telegramFailed.response.notified, false);
  assert.equal(telegramFailed.hasWarning, true);

  const journalFailed = build(
    { provider: 'hubspot', status: 'created', httpStatus: 201 },
    { journal: { enabled: true, status: 'failed' }, warnings: ['journal_write_failed'], hasWarning: true },
  );
  assert.equal(journalFailed.response.warnings.includes('journal_write_failed'), true);
  assert.equal(journalFailed.hasWarning, true);
});

test('maps journal rows and escapes notification values', () => {
  const context = contextFor({ provider: 'hubspot', status: 'updated', httpStatus: 200, contactId: 'c1' });
  context.lead.name = 'Ivan <Admin> & Co';
  assert.equal(context.meta.displayReceivedAt !== undefined, true);
  const row = runCode('Map Journal Row', { input: context })[0].json;
  assert.equal(row['CRM Provider'], 'hubspot');
  assert.equal(row['CRM Status'], 'updated');
  assert.equal(row['CRM Contact ID'], 'c1');
  assert.equal(row['Name'], 'Ivan <Admin> & Co');
  assert.equal(row['Created At'], context.meta.displayReceivedAt);

  const notification = runCode('Build Notification Message', { input: context })[0].json;
  assert.match(notification.text, /Ivan &lt;Admin&gt; &amp; Co/);
  assert.match(notification.text, /CRM: updated/);
  assert.match(notification.text, /Created At: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
});

test('maps HubSpot rate limit errors to HTTP 429', () => {
  const validated = validate(normalize(validLead));
  const config = validateConfig(exampleConfig);
  const result = runCode('Build CRM Failure', {
    input: { error: "Try spacing your requests out using the batching settings under 'Options'" },
    nodes: {
      'Validate Client Config': { config },
      'Validate Lead': validated,
    },
  })[0].json;
  assert.equal(result.httpStatus, 429);
  assert.equal(result.response.error, 'crm_rate_limited');
  assert.equal(result.response.ok, false);
});

test('phone-only HubSpot skip produces 202 context', () => {
  const validated = validate(normalize({ name: 'Phone Only', phone: '+7 (900) 555-20-20' }));
  const prepared = prepareHubspot(validated);
  const skipped = runCode('Build HubSpot Skipped Result', { input: prepared })[0].json;
  assert.equal(skipped.crm.provider, 'hubspot');
  assert.equal(skipped.crm.status, 'skipped');
  assert.equal(skipped.crm.reason, 'phone_only');
  assert.equal(skipped.crm.httpStatus, 202);
});

test('workflow requires Header Auth and contains no credentials or secret-like fields', () => {
  const webhook = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.webhook');
  assert.equal(webhook.parameters.authentication, 'headerAuth');
  assert.equal(webhook.credentials, undefined);
  for (const node of workflow.nodes) {
    assert.equal(node.credentials, undefined, `Node "${node.name}" must not contain credentials`);
  }
  const sheetsNodes = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.googleSheets');
  assert.equal(sheetsNodes.length, 3);
  for (const node of sheetsNodes) assert.equal(node.parameters.options.cellFormat, 'RAW');
  const telegram = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.telegram');
  assert.equal(telegram.parameters.additionalFields.parse_mode, 'HTML');
  assert.equal(telegram.parameters.additionalFields.appendAttribution, false);
});

test('HubSpot HTTP nodes use the standard Service Key credential and expected methods/URLs', () => {
  const methods = workflow.nodes
    .filter((node) => node.name.startsWith('HubSpot ') && node.type === 'n8n-nodes-base.httpRequest')
    .map((node) => ({ name: node.name, method: node.parameters.method, url: node.parameters.url, credentialType: node.parameters.nodeCredentialType }));
  assert.deepEqual(methods.map((item) => item.method).sort(), ['PATCH', 'POST', 'POST']);
  for (const item of methods) {
    assert.equal(item.credentialType, 'hubspotAppToken');
    assert.match(item.url, /api\.hubapi\.com|crm\.hubspot\.baseUrl/);
  }
});
