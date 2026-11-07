import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CONFIG_PATH = path.resolve(ROOT, process.env.WIZARD_CONFIG_FILE || 'config/client.json');
export const TEMPLATE_PATH = path.resolve(ROOT, process.env.WIZARD_TEMPLATE_FILE || 'config/example-client.json');
export const CONFIG_CHECK = path.join(ROOT, 'scripts/config-check.mjs');

let writeQueue = Promise.resolve();
const CONFIG_UID = Number(process.env.WIZARD_CONFIG_UID || 0);
const CONFIG_GID = Number(process.env.WIZARD_CONFIG_GID || 0);

async function preserveOwner(file) {
  if (!file || (!CONFIG_UID && !CONFIG_GID)) return;
  await fs.chown(file, CONFIG_UID, CONFIG_GID).catch(() => {});
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (!isPlainObject(patch)) return patch;
  const result = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    result[key] = isPlainObject(value) ? safeMerge(result[key], value) : safeMerge(undefined, value);
  }
  return result;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function runConfigCheck(file) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CONFIG_CHECK, file],
      { cwd: ROOT, timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            error: String(stderr || error.message || 'config-check failed').trim().slice(0, 4000),
          });
          return;
        }
        try {
          resolve({ ok: true, config: JSON.parse(String(stdout)) });
        } catch (parseError) {
          resolve({ ok: false, error: `config-check returned invalid JSON: ${parseError.message}` });
        }
      },
    );
  });
}

export async function validateConfig(config) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-wizard-'));
  const file = path.join(dir, 'client.json');
  try {
    await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return await runConfigCheck(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function loadTemplate() {
  return readJson(TEMPLATE_PATH);
}

export async function loadCurrentConfig() {
  try {
    const raw = await readJson(CONFIG_PATH);
    const result = await validateConfig(raw);
    if (!result.ok) return { exists: true, config: null, error: result.error };
    return { exists: true, config: result.config, error: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, config: null, error: null };
    return { exists: true, config: null, error: String(error.message || error) };
  }
}

export async function buildCandidateConfig(patch) {
  if (!isPlainObject(patch)) {
    throw Object.assign(new Error('Конфигурация должна быть JSON-объектом.'), { code: 'validation_error' });
  }
  const current = await loadCurrentConfig();
  if (current.exists && current.error) {
    throw Object.assign(new Error(`Существующий конфиг невалиден: ${current.error}`), {
      code: 'invalid_config',
    });
  }
  const base = current.config || (await loadTemplate());
  return safeMerge(base, patch);
}

async function writeValidatedConfig(config) {
  const validated = await validateConfig(config);
  if (!validated.ok) {
    const error = new Error(validated.error);
    error.code = 'invalid_config';
    throw error;
  }

  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  let backupCreated = false;
  let backupName = null;
  try {
    await fs.access(CONFIG_PATH);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupName = `.client-config.${stamp}.json`;
    const backup = path.join(path.dirname(CONFIG_PATH), backupName);
    await fs.copyFile(CONFIG_PATH, backup);
    await fs.chmod(backup, 0o600).catch(() => {});
    await preserveOwner(backup);
    backupCreated = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const tmp = path.join(
    path.dirname(CONFIG_PATH),
    `.client-config.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(tmp, `${JSON.stringify(validated.config, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, CONFIG_PATH);
    await fs.chmod(CONFIG_PATH, 0o600).catch(() => {});
    await preserveOwner(CONFIG_PATH);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
  return { config: validated.config, backupCreated, backupName };
}

export async function saveConfig(patch) {
  const operation = writeQueue.then(async () => {
    const candidate = await buildCandidateConfig(patch);
    return writeValidatedConfig(candidate);
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export async function replaceConfig(config) {
  if (!isPlainObject(config)) {
    throw Object.assign(new Error('Конфигурация должна быть JSON-объектом.'), { code: 'validation_error' });
  }
  const operation = writeQueue.then(() => writeValidatedConfig(config));
  writeQueue = operation.catch(() => {});
  return operation;
}

export async function listConfigBackups() {
  const dir = path.dirname(CONFIG_PATH);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^\.client-config\..+\.json$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const stat = await fs.stat(file);
    backups.push({ name: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString() });
  }
  return backups.sort((a, b) => b.name.localeCompare(a.name));
}

export async function createConfigBackup() {
  try {
    await fs.access(CONFIG_PATH);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw Object.assign(new Error('Конфиг ещё не создан.'), { code: 'config_not_found' });
    }
    throw error;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `.client-config.${stamp}.json`;
  const target = path.join(path.dirname(CONFIG_PATH), name);
  await fs.copyFile(CONFIG_PATH, target);
  await fs.chmod(target, 0o600).catch(() => {});
  await preserveOwner(target);
  return { name, size: (await fs.stat(target)).size, modifiedAt: (await fs.stat(target)).mtime.toISOString() };
}

export async function restoreConfigBackup(name) {
  if (typeof name !== 'string' || !/^\.client-config\.[A-Za-z0-9._-]+\.json$/.test(name) || name.includes('..')) {
    throw Object.assign(new Error('Некорректное имя backup-файла.'), { code: 'invalid_backup' });
  }
  const file = path.join(path.dirname(CONFIG_PATH), name);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw Object.assign(new Error('Backup-файл не найден.'), { code: 'backup_not_found' });
    }
    throw Object.assign(new Error('Backup-файл повреждён.'), { code: 'invalid_backup' });
  }
  return replaceConfig(parsed);
}

export function extractSpreadsheetId(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const urlMatch = text.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(text)) return text;
  return null;
}

export function isValidTimezone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function publicConfig(config) {
  // client.json is non-secret by design. Keep this boundary explicit.
  return config ? structuredClone(config) : null;
}
