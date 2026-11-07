import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

const DATA_DIR = path.resolve(process.env.WIZARD_DATA_DIR || path.join(ROOT, 'wizard-data'));
const STORE_PATH = path.join(DATA_DIR, 'integration-verifications.json');
const SCOPE_RE = /^[a-f0-9]{8,64}$/;
const KINDS = new Set(['hubspot', 'google', 'telegram']);
const MAX_SCOPES_PER_KIND = 50;

let writeQueue = Promise.resolve();

function validKind(kind) {
  return typeof kind === 'string' && KINDS.has(kind);
}

function safeStatus(status) {
  return typeof status === 'string' && /^[a-z_]{1,40}$/.test(status) ? status : 'unknown';
}

function safeScope(scope) {
  return typeof scope === 'string' && SCOPE_RE.test(scope) ? scope : null;
}

function normalizeStore(parsed) {
  if (parsed?.version === 2 && parsed.records && typeof parsed.records === 'object') {
    return parsed;
  }
  const records = {};
  if (parsed?.version === 1 && parsed.records && typeof parsed.records === 'object') {
    for (const [legacyScope, byKind] of Object.entries(parsed.records)) {
      if (!safeScope(legacyScope) || !byKind || typeof byKind !== 'object') continue;
      for (const [kind, record] of Object.entries(byKind)) {
        if (!validKind(kind) || !record || typeof record !== 'object') continue;
        records[kind] = records[kind] || {};
        records[kind][legacyScope] = {
          ok: record.ok === true,
          status: safeStatus(record.status),
          checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : new Date().toISOString(),
        };
      }
    }
  }
  return { version: 2, records };
}

async function readStore() {
  try {
    return normalizeStore(JSON.parse(await fs.readFile(STORE_PATH, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 2, records: {} };
    return { version: 2, records: {} };
  }
}

async function writeStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = path.join(DATA_DIR, `.integration-verifications.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, STORE_PATH);
    await fs.chmod(STORE_PATH, 0o600).catch(() => {});
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

function prune(store) {
  const normalized = {};
  for (const [kind, records] of Object.entries(store.records || {})) {
    if (!validKind(kind) || !records || typeof records !== 'object') continue;
    const kept = Object.entries(records)
      .filter(([scope, record]) => safeScope(scope) && record && typeof record === 'object')
      .sort((a, b) => (Date.parse(b[1].checkedAt) || 0) - (Date.parse(a[1].checkedAt) || 0))
      .slice(0, MAX_SCOPES_PER_KIND);
    if (kept.length) normalized[kind] = Object.fromEntries(kept);
  }
  store.version = 2;
  store.records = normalized;
}

export async function recordVerification({ kind, ok, status, scope, configHash }) {
  const normalizedScope = safeScope(scope || configHash);
  if (!validKind(kind) || !normalizedScope) return null;
  const record = {
    ok: Boolean(ok),
    status: safeStatus(status),
    checkedAt: new Date().toISOString(),
  };
  const operation = writeQueue.then(async () => {
    const store = await readStore();
    store.records[kind] = {
      ...(store.records[kind] || {}),
      [normalizedScope]: record,
    };
    prune(store);
    await writeStore(store);
    return { ...record, scope: normalizedScope };
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export async function listVerifications(scope) {
  const store = await readStore();
  const requestedScope = scope ? safeScope(scope) : null;
  if (scope && !requestedScope) return {};
  const result = {};
  for (const [kind, records] of Object.entries(store.records || {})) {
    if (!validKind(kind) || !records || typeof records !== 'object') continue;
    const candidates = requestedScope
      ? [[requestedScope, records[requestedScope]]]
      : Object.entries(records);
    const latest = candidates
      .filter(([candidateScope, record]) => safeScope(candidateScope) && record && typeof record === 'object')
      .sort((a, b) => (Date.parse(b[1].checkedAt) || 0) - (Date.parse(a[1].checkedAt) || 0))[0];
    if (!latest) continue;
    const [candidateScope, record] = latest;
    result[kind] = {
      ok: record.ok === true,
      status: safeStatus(record.status),
      checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : null,
      scope: candidateScope,
    };
  }
  return result;
}

export async function listVerificationHistory() {
  const store = await readStore();
  const result = {};
  for (const [kind, records] of Object.entries(store.records || {})) {
    if (!validKind(kind) || !records || typeof records !== 'object') continue;
    const entries = Object.entries(records)
      .filter(([scope, record]) => safeScope(scope) && record && typeof record === 'object')
      .sort((a, b) => (Date.parse(b[1].checkedAt) || 0) - (Date.parse(a[1].checkedAt) || 0))
      .slice(0, MAX_SCOPES_PER_KIND)
      .map(([scope, record]) => ({
        ok: record.ok === true,
        status: safeStatus(record.status),
        checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : null,
        scope,
      }));
    if (entries.length) result[kind] = entries;
  }
  return result;
}

export { STORE_PATH as VERIFICATION_STORE_PATH };
