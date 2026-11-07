import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-verification-store-'));
process.env.WIZARD_DATA_DIR = tempDir;

const { configHash } = await import('../wizard/lib/config.mjs');
const { listVerifications, recordVerification, VERIFICATION_STORE_PATH } = await import(
  '../wizard/lib/verification-store.mjs'
);

test.after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('configuration hash is stable across object key order and changes with values', () => {
  const first = { timezone: 'Asia/Tbilisi', crm: { provider: 'hubspot', enabled: true } };
  const second = { crm: { enabled: true, provider: 'hubspot' }, timezone: 'Asia/Tbilisi' };
  assert.equal(configHash(first), configHash(second));
  assert.match(configHash(first), /^[a-f0-9]{64}$/);
  assert.notEqual(configHash(first), configHash({ ...first, timezone: 'UTC' }));
  assert.equal(configHash(null), null);
});

test('verification store keeps only safe latest results per configuration', async () => {
  const hash = configHash({ config: 'one' });
  const other = configHash({ config: 'two' });
  await recordVerification({
    kind: 'hubspot',
    ok: true,
    status: 'connected',
    configHash: hash,
    message: 'must not be persisted',
    token: 'must not be persisted',
  });
  await recordVerification({ kind: 'google', ok: false, status: 'error', configHash: hash });
  await recordVerification({ kind: 'hubspot', ok: true, status: 'connected', configHash: other });

  const records = await listVerifications(hash);
  assert.equal(records.hubspot.ok, true);
  assert.equal(records.google.ok, false);
  assert.equal(Object.keys(records).length, 2);
  assert.equal((await listVerifications(other)).hubspot.ok, true);
  assert.equal((await listVerifications(hash)).telegram, undefined);

  const raw = await fs.readFile(VERIFICATION_STORE_PATH, 'utf8');
  assert.equal(raw.includes('must not be persisted'), false);
  assert.equal((await fs.stat(VERIFICATION_STORE_PATH)).mode & 0o777, 0o600);
});

test('verification store ignores malformed hashes and kinds', async () => {
  await recordVerification({ kind: 'unknown', ok: true, status: 'connected', configHash: 'a'.repeat(64) });
  await recordVerification({ kind: 'hubspot', ok: true, status: 'connected', configHash: 'not-a-hash' });
  assert.deepEqual(await listVerifications('a'.repeat(64)), {});
  assert.deepEqual(await listVerifications('not-a-hash'), {});
});

test('verification scopes are independent per integration', async () => {
  const { listVerificationHistory } = await import('../wizard/lib/verification-store.mjs');
  const hubspotScope = '1'.repeat(16);
  const googleScope = '2'.repeat(16);
  await recordVerification({ kind: 'hubspot', ok: true, status: 'connected', scope: hubspotScope });
  await recordVerification({ kind: 'google', ok: true, status: 'connected', scope: googleScope });
  const hubspot = await listVerifications(hubspotScope);
  const google = await listVerifications(googleScope);
  assert.deepEqual(Object.keys(hubspot), ['hubspot']);
  assert.deepEqual(Object.keys(google), ['google']);
  const history = await listVerificationHistory();
  assert.equal(history.hubspot[0].scope, hubspotScope);
  assert.equal(history.google[0].scope, googleScope);
});
