import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROOT, configHash } from './config.mjs';
import { WORKFLOW_ID } from './workflow.mjs';

const DATA_DIR = path.resolve(process.env.WIZARD_DATA_DIR || path.join(ROOT, 'wizard-data'));
const BACKUP_DIR = path.join(DATA_DIR, 'workflow-backups');
const NAME_RE = /^workflow-[A-Za-z0-9._-]+\.json$/;
const MAX_BACKUPS = 20;

let writeQueue = Promise.resolve();

function workflowView(workflow) {
  return {
    name: workflow.name,
    active: Boolean(workflow.active),
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: workflow.settings || {},
    ...(workflow.description !== undefined ? { description: workflow.description } : {}),
    ...(workflow.staticData !== undefined ? { staticData: workflow.staticData } : {}),
    ...(workflow.pinData !== undefined ? { pinData: workflow.pinData } : {}),
    ...(workflow.nodeGroups !== undefined ? { nodeGroups: workflow.nodeGroups } : {}),
  };
}

async function pruneBackups() {
  const entries = await fs.readdir(BACKUP_DIR, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile() && NAME_RE.test(entry.name));
  for (const file of files.sort((a, b) => b.name.localeCompare(a.name)).slice(MAX_BACKUPS)) {
    await fs.rm(path.join(BACKUP_DIR, file.name), { force: true }).catch(() => {});
  }
}

export async function createWorkflowBackup(api) {
  const workflow = await api.getWorkflow(WORKFLOW_ID);
  if (!workflow || !Array.isArray(workflow.nodes)) {
    throw Object.assign(new Error('n8n вернул workflow без nodes.'), { code: 'workflow_invalid' });
  }
  const operation = writeQueue.then(async () => {
    await fs.mkdir(BACKUP_DIR, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `workflow-${stamp}-${crypto.randomBytes(3).toString('hex')}.json`;
    const file = path.join(BACKUP_DIR, name);
    const snapshot = { version: 1, createdAt: new Date().toISOString(), workflow: workflowView(workflow) };
    await fs.writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(file, 0o600).catch(() => {});
    await pruneBackups();
    return { name, createdAt: snapshot.createdAt };
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export async function restoreWorkflowBackup(api, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..')) {
    throw Object.assign(new Error('Некорректное имя резервной копии workflow.'), { code: 'invalid_backup' });
  }
  const file = path.join(BACKUP_DIR, name);
  let snapshot;
  try {
    snapshot = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw Object.assign(new Error('Резервная копия workflow не найдена.'), { code: 'backup_not_found' });
    }
    throw Object.assign(new Error('Резервная копия workflow повреждена.'), { code: 'invalid_backup' });
  }
  const workflow = snapshot?.workflow;
  if (!workflow || !Array.isArray(workflow.nodes)) {
    throw Object.assign(new Error('Резервная копия workflow повреждена.'), { code: 'invalid_backup' });
  }
  await api.updateWorkflow(WORKFLOW_ID, workflow, { publishIfActive: true });
  const actual = await api.getWorkflow(WORKFLOW_ID);
  const expectedHash = configHash(workflowView(workflow));
  const actualHash = configHash(workflowView(actual));
  const activeExpected = Boolean(workflow.active);
  const activeActual = Boolean(actual.active);
  return {
    ok: expectedHash === actualHash && activeExpected === activeActual,
    backup: name,
    expectedHash,
    actualHash,
    activeExpected,
    activeActual,
    message:
      expectedHash === actualHash && activeExpected === activeActual
        ? 'Workflow восстановлен и проверен.'
        : 'Workflow отправлен в n8n, но фактическое состояние отличается от резервной копии.',
  };
}
