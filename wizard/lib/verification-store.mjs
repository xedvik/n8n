import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

const DATA_DIR = path.resolve(process.env.WIZARD_DATA_DIR || path.join(ROOT, 'wizard-data'));
const STORE_PATH = path.join(DATA_DIR, 'integration-verifications.json');
const CONFIG_HASH_RE = /^[a-f0-9]{64}$/;
const KINDS = new Set(['hubspot', 'google', 'telegram']);
const MAX_CONFIGS = 50;
const MAX_RECORDS_PER_CONFIG = 10;

let writeQueue = Promise.resolve();

function validKind(kind) {
  return typeof kind === 'string' && KINDS.has(kind);
}

function safeStatus(status) {
  return typeof status === 'string' && /^[a-z_]{1,40}$/.test(status) ? status : 'unknown';
}

async function readStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_PATH, 'utf8'));
    if (!parsed || parsed.version !== 1 || !parsed.records || typeof parsed.records !== 'object') {
      return { version: 1, records: {} };
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, records: {} };
    return { version: 1, records: {} };
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
  const entries = Object.entries(store.records)
    .filter(([hash, records]) => CONFIG_HASH_RE.test(hash) && records && typeof records === 'object')
    .map(([hash, records]) => ({
      hash,
      records: Object.fromEntries(
        Object.entries(records)
          .filter(([kind, record]) => validKind(kind) && record && typeof record === 'object')
          .slice(-MAX_RECORDS_PER_CONFIG),
      ),
      latest: Math.max(
        0,
        ...Object.values(records).map((record) => Date.parse(record?.checkedAt) || 0),
      ),
    }))
    .sort((a, b) => b.latest - a.latest)
    .slice(0, MAX_CONFIGS);
  store.records = Object.fromEntries(entries.map(({ hash, records }) => [hash, records]));
}

export async function recordVerification({ kind, ok, status, configHash }) {
  if (!validKind(kind) || typeof configHash !== 'string' || !CONFIG_HASH_RE.test(configHash)) {
    return null;
  }
  const record = {
    ok: Boolean(ok),
    status: safeStatus(status),
    checkedAt: new Date().toISOString(),
  };
  const operation = writeQueue.then(async () => {
    const store = await readStore();
    store.records[configHash] = {
      ...(store.records[configHash] || {}),
      [kind]: record,
    };
    prune(store);
    await writeStore(store);
    return record;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export async function listVerifications(configHash) {
  if (typeof configHash !== 'string' || !CONFIG_HASH_RE.test(configHash)) return {};
  const store = await readStore();
  const records = store.records[configHash];
  if (!records || typeof records !== 'object') return {};
  return Object.fromEntries(
    Object.entries(records)
      .filter(([kind, record]) => validKind(kind) && record && typeof record === 'object')
      .map(([kind, record]) => [kind, {
        ok: record.ok === true,
        status: safeStatus(record.status),
        checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : null,
      }]),
  );
}

export { STORE_PATH as VERIFICATION_STORE_PATH };
