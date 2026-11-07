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
    { notifications: { enabled: true, status: 'failed', channels: ['telegram'] }, warnings: ['notification_send_failed'], hasWarning: true, needsReconciliation: true },
  );
  assert.equal(telegramFailed.httpStatus, 202);
  assert.equal(telegramFailed.response.status, 'needs_reconciliation');
  assert.equal(telegramFailed.response.notified, false);
  assert.equal(telegramFailed.hasWarning, true);

  const journalFailed = build(
    { provider: 'hubspot', status: 'created', httpStatus: 201 },
    { journal: { enabled: true, status: 'failed' }, warnings: ['journal_write_failed'], hasWarning: true, needsReconciliation: true },
  );
  assert.equal(journalFailed.httpStatus, 202);
  assert.equal(journalFailed.response.status, 'needs_reconciliation');
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
      'Decide Operation': { operation: { id: 'op-rate-limit', attempts: 1 } },
    },
  })[0].json;
  assert.equal(result.httpStatus, 202);
  assert.equal(result.response.error, 'crm_rate_limited');
  assert.equal(result.response.status, 'retry_scheduled');
  assert.equal(result.response.ok, false);
  assert.match(result.response.retryAt, /Z$/);
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
  assert.equal(sheetsNodes.length, 5);
  const writeSheetsNodes = sheetsNodes.filter((node) => !['Read CRM Leads', 'Read Journal'].includes(node.name));
  assert.equal(writeSheetsNodes.length, 3);
  for (const node of writeSheetsNodes) assert.equal(node.parameters.options.cellFormat, 'RAW');
  for (const node of sheetsNodes) assert.equal(typeof node.parameters.options, 'object');
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

test('builds idempotent operation input from external_id, header key, and recovery headers', () => {
  const validated = validate(normalize(validLead));
  const execute = (headers, config = validateConfig(exampleConfig), body = validLead) => {
    const current = body === validLead ? validated : validate(normalize(body, config));
    return runCode('Build Operation', {
      input: {},
      nodes: {
        'Validate Lead': { ...current, config },
        'Lead Webhook': { headers, body },
      },
    })[0].json.operationInput;
  };

  const external = execute({});
  assert.equal(external.idempotencyKey, validated.lead.externalId);
  assert.equal(external.operationId, null);
  assert.equal(external.recovery, false);
  assert.equal(JSON.parse(external.fingerprint).externalId, validated.lead.externalId);

  const withoutExternalId = clone(validLead);
  delete withoutExternalId.external_id;
  const header = execute({ 'idempotency-key': ' header-key-1 ' }, validateConfig(exampleConfig), withoutExternalId);
  assert.equal(header.idempotencyKey, 'header-key-1');

  const disabled = clone(exampleConfig);
  disabled.idempotency.enabled = false;
  assert.equal(execute({}, validateConfig(disabled)).idempotencyKey, null);

  const recovery = execute({ 'x-recovery': '1', 'x-operation-id': 'op-123' });
  assert.equal(recovery.recovery, true);
  assert.equal(recovery.operationId, 'op-123');
});

test('maps reserve outcomes to operation decisions', () => {
  const decide = (outcome) => runCode('Decide Operation', {
    input: { result: { outcome, operation: outcome === 'not_found' ? null : { id: 'op-1', status: outcome } } },
    nodes: { 'Build Operation': { operationInput: {}, lead: {}, meta: {}, config: {} } },
  })[0].json;

  assert.equal(decide('new').decision, 'process');
  assert.equal(decide('claimed').decision, 'process');
  assert.equal(decide('replay').decision, 'replay');
  assert.equal(decide('conflict').decision, 'conflict');
  assert.equal(decide('in_progress').decision, 'in_progress');
  assert.equal(decide('max_attempts').decision, 'terminal');
  assert.equal(decide('current').decision, 'terminal');
  assert.equal(decide('not_found').decision, 'not_found');
});

test('schedules retryable CRM failures and preserves Retry-After', () => {
  const validated = validate(normalize(validLead));
  const config = validateConfig(exampleConfig);
  const failure = (error, attempts = 1) => runCode('Build CRM Failure', {
    input: { error },
    nodes: {
      'Validate Client Config': { config },
      'Validate Lead': validated,
      'Decide Operation': { operation: { id: 'op-crm', attempts } },
    },
  })[0].json;

  const limited = failure('HubSpot create HTTP 429 Retry-After: 2: too many requests');
  assert.equal(limited.httpStatus, 202);
  assert.equal(limited.stateUpdate.status, 'retry_scheduled');
  assert.equal(limited.response.error, 'crm_rate_limited');
  assert.match(limited.response.retryAt, /Z$/);

  const permanent = failure('HubSpot create HTTP 400: invalid property');
  assert.equal(permanent.httpStatus, 502);
  assert.equal(permanent.stateUpdate.status, 'failed');
  assert.equal(permanent.response.error, 'crm_write_failed');

  const exhausted = failure('HubSpot create HTTP 500: server error', 5);
  assert.equal(exhausted.httpStatus, 502);
  assert.equal(exhausted.stateUpdate.status, 'failed');
});

test('distinguishes retryable journal failures from ambiguous failures', () => {
  const context = contextFor({ provider: 'hubspot', status: 'created', httpStatus: 201 });
  context.operation = { id: 'op-journal', attempts: 1 };
  context.warnings = [];
  const run = (error) => runCode('Build Journal Warning', {
    input: { error },
    nodes: { 'Build Journal Context': context },
  })[0].json;

  const transient = run('Google Sheets HTTP 503: backend error');
  assert.equal(transient.retryScheduled, true);
  assert.equal(transient.needsReconciliation, false);
  assert.equal(transient.stateUpdate.status, 'retry_scheduled');

  const permanent = run('Google Sheets HTTP 404: sheet not found');
  assert.equal(permanent.retryScheduled, false);
  assert.equal(permanent.needsReconciliation, true);
  assert.equal(permanent.stateUpdate.status, 'needs_reconciliation');
});

test('builds replay, conflict, in-progress and terminal responses', () => {
  const response = (ctx) => runCode('Build Replay Response', {
    input: {},
    nodes: { 'Decide Operation': ctx },
  })[0].json;

  const replay = response({ decision: 'replay', operation: { id: 'op-1', response: { status: 'created', ok: true } } });
  assert.equal(replay.httpStatus, 200);
  assert.equal(replay.response.replayed, true);
  assert.equal(replay.response.operationId, 'op-1');

  assert.equal(response({ decision: 'conflict', operation: { id: 'op-1' } }).httpStatus, 409);
  assert.equal(response({ decision: 'in_progress', operation: { id: 'op-1', status: 'processing' } }).httpStatus, 202);
  assert.equal(response({ decision: 'not_found', operation: null }).httpStatus, 404);
  const current = response({ decision: 'terminal', operation: { id: 'op-1', status: 'failed' } });
  assert.equal(current.httpStatus, 200);
  assert.equal(current.response.ok, false);
});

test('validates HubSpot full HTTP responses and extracts Retry-After', () => {
  const ok = runCode('Validate HubSpot Search HTTP', {
    input: { statusCode: 200, body: { results: [{ id: '1' }] }, headers: {} },
  })[0].json;
  assert.deepEqual(ok, { results: [{ id: '1' }] });

  assert.throws(() => runCode('Validate HubSpot Create HTTP', {
    input: { statusCode: 429, body: { message: 'slow down' }, headers: { 'retry-after': '2' } },
  }), /HTTP 429 Retry-After: 2/);
});

test('marks Telegram failures as needs_reconciliation without claiming success', () => {
  const context = contextFor({ provider: 'hubspot', status: 'created', httpStatus: 201 });
  context.config.notifications.enabled = true;
  context.config.notifications.channels = ['telegram'];
  const warning = runCode('Build Notification Warning', {
    input: { error: 'Bad Request: chat not found' },
    nodes: { 'Build Notification Message': context },
  })[0].json;
  assert.equal(warning.notifications.status, 'failed');
  assert.equal(warning.needsReconciliation, true);
  assert.equal(warning.hasWarning, true);
});

test('validates idempotency and retry config defaults and bounds', () => {
  const defaults = validateConfig(exampleConfig);
  assert.equal(defaults.idempotency.enabled, true);
  assert.equal(defaults.idempotency.withoutKeyPolicy, 'process_new');
  assert.equal(defaults.retry.maxAttempts, 5);
  assert.equal(defaults.retry.processingTimeoutSeconds, 300);

  const invalid = clone(exampleConfig);
  invalid.retry.maxAttempts = 0;
  assert.throws(() => validateConfig(invalid), /retry\.maxAttempts/);
  const invalidRetention = clone(exampleConfig);
  invalidRetention.idempotency.retentionDays = 0;
  assert.throws(() => validateConfig(invalidRetention), /idempotency\.retentionDays/);
});

test('workflow contains v0.3 state, recovery, and full-response wiring', () => {
  const names = new Set(workflow.nodes.map((node) => node.name));
  for (const name of ['Build Operation', 'Reserve Operation', 'Decide Operation', 'Schedule Trigger', 'Select Due Operations', 'Recovery Request', 'Save Final State']) {
    assert.ok(names.has(name), `missing ${name}`);
  }
  const reserve = workflow.nodes.find((node) => node.name === 'Reserve Operation');
  assert.match(reserve.parameters.query, /app\.reserve_lead_operation\(/);
  assert.match(reserve.parameters.query, /\$9::uuid/);
  const recovery = workflow.nodes.find((node) => node.name === 'Recovery Request');
  const headers = recovery.parameters.headerParameters.parameters.map((item) => item.name);
  assert.deepEqual(headers.sort(), ['Idempotency-Key', 'X-Operation-Id', 'X-Recovery'].sort());
  for (const name of ['HubSpot Search Contact', 'HubSpot Create Contact', 'HubSpot Update Contact']) {
    const node = workflow.nodes.find((item) => item.name === name);
    assert.equal(node.parameters.options.response.response.fullResponse, true);
    assert.equal(node.parameters.options.response.response.neverError, true);
  }
});

test('reconciles existing Google Sheets CRM and Journal rows by external id or operation id', () => {
  const validated = validate(normalize(validLead));
  const config = validateConfig(exampleConfig);
  const operation = { id: 'op-reconcile-1' };
  const crmCtx = { lead: validated.lead, meta: validated.meta, config, operation };
  const checkCrm = (row) => runCode('Check Existing CRM Row', {
    input: row,
    nodes: { 'Decide Operation': crmCtx },
  })[0].json;
  assert.equal(checkCrm({ 'External ID': validated.lead.externalId }).existingCrm, true);
  assert.equal(checkCrm({ 'Request ID': operation.id }).existingCrm, true);
  assert.equal(checkCrm({ 'External ID': 'other', 'Request ID': 'other' }).existingCrm, false);

  const journalCtx = { ...crmCtx, journal: { enabled: true, status: 'disabled' } };
  const checkJournal = (row) => runCode('Check Existing Journal Row', {
    input: row,
    nodes: { 'Build Journal Context': journalCtx },
  })[0].json;
  assert.equal(checkJournal({ 'External ID': validated.lead.externalId }).existingJournal, true);
  assert.equal(checkJournal({ 'Request ID': operation.id }).existingJournal, true);
  assert.equal(checkJournal({ 'External ID': 'other', 'Request ID': 'other' }).existingJournal, false);

  const mapped = runCode('Map CRM Sheet Row', {
    input: {},
    nodes: {
      'Decide Operation': crmCtx,
      'Validate Lead': validated,
      'Validate Client Config': { config },
    },
  })[0].json;
  assert.equal(mapped['Request ID'], operation.id);
  assert.equal(mapped['External ID'], validated.lead.externalId);
});

test('persists sent Telegram state before final response assembly', () => {
  const context = contextFor({ provider: 'hubspot', status: 'created', httpStatus: 201 });
  context.config.notifications.enabled = true;
  context.config.notifications.channels = ['telegram'];
  context.operation = { id: 'op-notify', attempts: 1 };
  const built = runCode('Build Notifications Sent', {
    input: {},
    nodes: {
      'Build Notification Message': context,
      'Notification Adapter - Telegram': { result: { message_id: 777 } },
    },
  })[0].json;
  assert.equal(built.notifications.status, 'sent');
  assert.equal(built.stateUpdate.status, 'processing');
  assert.equal(built.stateUpdate.telegram_status, 'sent');
  assert.equal(built.stateUpdate.telegram_message_id, '777');
  assert.equal(built.operation.id, 'op-notify');
});
