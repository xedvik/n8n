import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  googleAccessToken,
  googleSheetsProvision,
} from '../wizard/lib/integrations.mjs';

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const SERVICE_ACCOUNT = {
  client_email: 'wizard-test@example.iam.gserviceaccount.com',
  private_key: privateKey,
};
const ACCESS_TOKEN = 'ya29.fake-access-token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body === undefined ? '' : JSON.stringify(body);
    },
  };
}

function jwtScope(options) {
  const params =
    options.body instanceof URLSearchParams
      ? options.body
      : new URLSearchParams(String(options.body || ''));
  const assertion = params.get('assertion');
  const claim = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString('utf8'));
  return claim.scope;
}

function assertNoSecrets(value, label) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(ACCESS_TOKEN), false, `${label}: access token leaked`);
  assert.equal(serialized.includes(privateKey), false, `${label}: private key leaked`);
  assert.equal(serialized.includes('BEGIN PRIVATE KEY'), false, `${label}: private key marker leaked`);
}

test('creates a spreadsheet, writes headers, and never returns secrets', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === 'https://oauth2.googleapis.com/token') {
      return jsonResponse(200, { access_token: ACCESS_TOKEN });
    }
    if (url === 'https://sheets.googleapis.com/v4/spreadsheets' && options.method === 'POST') {
      return jsonResponse(200, {
        spreadsheetId: 'created-id',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/created-id/edit',
        properties: { title: 'CRM Leads' },
      });
    }
    if (
      url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/created-id/values/')
      && options.method === 'PUT'
    ) {
      return jsonResponse(200, { updatedRows: 1 });
    }
    return jsonResponse(500, { error: { message: 'unexpected request' } });
  };

  const result = await googleSheetsProvision({
    serviceAccount: JSON.stringify(SERVICE_ACCOUNT),
    title: 'CRM Leads',
    sheets: [
      { name: 'Leads', headers: ['Created At', 'Email'] },
      { name: 'Journal', headers: ['Event'] },
    ],
    fetchImpl,
  });

  assert.deepEqual(result, {
    ok: true,
    spreadsheetId: 'created-id',
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/created-id/edit',
    title: 'CRM Leads',
    sheets: ['Leads', 'Journal'],
    created: true,
  });
  assertNoSecrets(result, 'create result');

  const tokenRequest = requests.find((request) => request.url === 'https://oauth2.googleapis.com/token');
  assert.ok(tokenRequest);
  assert.equal(tokenRequest.options.method, 'POST');
  assert.equal(jwtScope(tokenRequest.options), SHEETS_SCOPE);

  const createRequest = requests.find(
    (request) => request.url === 'https://sheets.googleapis.com/v4/spreadsheets',
  );
  assert.ok(createRequest);
  assert.equal(createRequest.options.method, 'POST');
  assert.equal(createRequest.options.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(createRequest.options.headers['Content-Type'], 'application/json');
  assert.ok(createRequest.options.signal);
  assert.deepEqual(JSON.parse(createRequest.options.body), {
    properties: { title: 'CRM Leads' },
    sheets: [
      { properties: { title: 'Leads' } },
      { properties: { title: 'Journal' } },
    ],
  });

  const puts = requests.filter((request) => request.options.method === 'PUT');
  assert.equal(puts.length, 2);
  const leadsPut = puts.find((request) => request.url.includes(encodeURIComponent('Leads!A1')));
  assert.ok(leadsPut);
  assert.equal(
    leadsPut.url,
    `https://sheets.googleapis.com/v4/spreadsheets/created-id/values/${encodeURIComponent('Leads!A1')}?valueInputOption=RAW`,
  );
  assert.equal(leadsPut.options.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.deepEqual(JSON.parse(leadsPut.options.body), {
    values: [['Created At', 'Email']],
  });

  const journalPut = puts.find((request) => request.url.includes(encodeURIComponent('Journal!A1')));
  assert.ok(journalPut);
  assert.deepEqual(JSON.parse(journalPut.options.body), { values: [['Event']] });
});

test('adds missing tabs to an existing spreadsheet and rewrites all headers', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (
      url
      === 'https://sheets.googleapis.com/v4/spreadsheets/existing-id?fields=properties.title,sheets.properties.title'
      && (options.method === undefined || options.method === 'GET')
    ) {
      return jsonResponse(200, {
        properties: { title: 'Existing CRM' },
        sheets: [{ properties: { title: 'Leads' } }],
      });
    }
    if (
      url === 'https://sheets.googleapis.com/v4/spreadsheets/existing-id:batchUpdate'
      && options.method === 'POST'
    ) {
      return jsonResponse(200, { replies: [{ addSheet: { properties: { title: 'Journal' } } }] });
    }
    if (
      url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/existing-id/values/')
      && options.method === 'PUT'
    ) {
      return jsonResponse(200, { updatedRows: 1 });
    }
    return jsonResponse(500, { error: { message: 'unexpected request' } });
  };

  const result = await googleSheetsProvision({
    serviceAccount: SERVICE_ACCOUNT,
    spreadsheetId: 'https://docs.google.com/spreadsheets/d/existing-id/edit#gid=0',
    title: 'Ignored title',
    sheets: [
      { name: 'Leads', headers: ['Created At', 'Email'] },
      { name: 'Journal', headers: ['Event', 'Payload'] },
    ],
    fetchImpl,
    accessToken: ACCESS_TOKEN,
  });

  assert.deepEqual(result, {
    ok: true,
    spreadsheetId: 'existing-id',
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/existing-id/edit',
    title: 'Existing CRM',
    sheets: ['Leads', 'Journal'],
    created: false,
  });
  assertNoSecrets(result, 'existing result');

  assert.equal(requests.some((request) => request.url === 'https://oauth2.googleapis.com/token'), false);

  const metaRequest = requests.find((request) => request.url.includes('?fields='));
  assert.ok(metaRequest);
  assert.equal(metaRequest.options.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);

  const batchRequest = requests.find((request) => request.url.endsWith(':batchUpdate'));
  assert.ok(batchRequest);
  assert.equal(batchRequest.options.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.deepEqual(JSON.parse(batchRequest.options.body), {
    requests: [{ addSheet: { properties: { title: 'Journal' } } }],
  });

  const puts = requests.filter((request) => request.options.method === 'PUT');
  assert.equal(puts.length, 2);
  const headersByRange = Object.fromEntries(
    puts.map((request) => {
      const range = decodeURIComponent(request.url.split('/values/')[1].split('?')[0]);
      return [range, JSON.parse(request.options.body).values[0]];
    }),
  );
  assert.deepEqual(headersByRange['Leads!A1'], ['Created At', 'Email']);
  assert.deepEqual(headersByRange['Journal!A1'], ['Event', 'Payload']);
});

test('skips batchUpdate when all requested tabs already exist', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes('?fields=')) {
      return jsonResponse(200, {
        properties: { title: 'Existing CRM' },
        sheets: [{ properties: { title: 'Leads' } }, { properties: { title: 'Journal' } }],
      });
    }
    if (url.includes('/values/') && options.method === 'PUT') {
      return jsonResponse(200, { updatedRows: 1 });
    }
    return jsonResponse(500, { error: { message: 'unexpected request' } });
  };

  const result = await googleSheetsProvision({
    serviceAccount: SERVICE_ACCOUNT,
    spreadsheetId: 'existing-id',
    sheets: [
      { name: 'Leads', headers: ['Email'] },
      { name: 'Journal', headers: ['Event'] },
    ],
    fetchImpl,
    accessToken: ACCESS_TOKEN,
  });

  assert.equal(result.created, false);
  assert.equal(requests.some((request) => request.url.endsWith(':batchUpdate')), false);
  assert.equal(requests.filter((request) => request.options.method === 'PUT').length, 2);
});

test('validates sheet definitions before calling Google', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return jsonResponse(500, {});
  };
  const base = {
    serviceAccount: SERVICE_ACCOUNT,
    accessToken: ACCESS_TOKEN,
    fetchImpl,
  };

  const invalidSheets = [
    undefined,
    [],
    [{ name: '', headers: ['Email'] }],
    [{ name: 'Leads', headers: [] }],
    [{ name: 'Leads', headers: [''] }],
    [{ name: 'Leads', headers: ['Email'] }, { name: 'Leads', headers: ['Event'] }],
    [{ name: 'x'.repeat(101), headers: ['Email'] }],
    [{ name: 'Leads', headers: ['x'.repeat(201)] }],
    [{ name: 'Leads', headers: [42] }],
    Array.from({ length: 201 }, (_, index) => ({
      name: `Sheet ${index}`,
      headers: ['Email'],
    })),
  ];

  for (const sheets of invalidSheets) {
    await assert.rejects(
      () => googleSheetsProvision({ ...base, sheets, spreadsheetId: 'existing-id' }),
      (error) => error.code === 'validation_error',
    );
  }
  assert.equal(called, false);
});

test('maps Google auth failures to a safe google_auth_error', async () => {
  const fetchImpl = async (url) => {
    if (url.startsWith('https://sheets.googleapis.com/')) {
      return jsonResponse(403, { error: { message: `forbidden ${ACCESS_TOKEN}` } });
    }
    return jsonResponse(500, {});
  };

  await assert.rejects(
    () =>
      googleSheetsProvision({
        serviceAccount: SERVICE_ACCOUNT,
        spreadsheetId: 'existing-id',
        sheets: [{ name: 'Leads', headers: ['Email'] }],
        fetchImpl,
        accessToken: ACCESS_TOKEN,
      }),
    (error) => {
      assert.equal(error.code, 'google_auth_error');
      assert.equal(error.status, 403);
      assert.match(error.message, /Google отклонил доступ/);
      assert.equal(error.message.includes(ACCESS_TOKEN), false);
      assert.equal(error.message.includes(privateKey), false);
      assert.equal(error.message.includes('BEGIN PRIVATE KEY'), false);
      return true;
    },
  );
});

test('maps other Google failures to a safe google_api_error with status', async () => {
  const fetchImpl = async (url) => {
    if (url.startsWith('https://sheets.googleapis.com/')) {
      return jsonResponse(500, { error: { message: `boom ${ACCESS_TOKEN}` } });
    }
    return jsonResponse(500, {});
  };

  await assert.rejects(
    () =>
      googleSheetsProvision({
        serviceAccount: SERVICE_ACCOUNT,
        spreadsheetId: 'existing-id',
        sheets: [{ name: 'Leads', headers: ['Email'] }],
        fetchImpl,
        accessToken: ACCESS_TOKEN,
      }),
    (error) => {
      assert.equal(error.code, 'google_api_error');
      assert.equal(error.status, 500);
      assert.match(error.message, /Google Sheets вернул HTTP 500/);
      assert.equal(error.message.includes(ACCESS_TOKEN), false);
      assert.equal(error.message.includes(privateKey), false);
      return true;
    },
  );
});

test('googleAccessToken keeps the readonly scope by default and accepts an override', async () => {
  const scopes = [];
  const fetchImpl = async (url, options = {}) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    scopes.push(jwtScope(options));
    return jsonResponse(200, { access_token: ACCESS_TOKEN });
  };

  const readonly = await googleAccessToken(SERVICE_ACCOUNT, undefined, fetchImpl);
  const write = await googleAccessToken(SERVICE_ACCOUNT, SHEETS_SCOPE, fetchImpl);

  assert.equal(readonly.ok, true);
  assert.equal(write.ok, true);
  assert.deepEqual(scopes, [READONLY_SCOPE, SHEETS_SCOPE]);
});
