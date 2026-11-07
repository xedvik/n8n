import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-workflow-backup-'));
process.env.WIZARD_DATA_DIR = tempDir;

const { createWorkflowBackup, restoreWorkflowBackup } = await import('../wizard/lib/workflow-backup.mjs');

test.after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function fakeApi() {
  let current = {
    id: 'w1',
    name: 'Lead Intake',
    active: true,
    nodes: [{ name: 'Lead Webhook', type: 'n8n-nodes-base.webhook', parameters: {}, credentials: {} }],
    connections: {},
    settings: { executionOrder: 'v1' },
  };
  return {
    get current() { return structuredClone(current); },
    setCurrent(value) { current = structuredClone(value); },
    async getWorkflow() { return structuredClone(current); },
    async updateWorkflow(_id, workflow) {
      current = { ...structuredClone(workflow), id: 'w1', active: Boolean(current.active) };
      return structuredClone(current);
    },
  };
}

test('workflow backup restores exact nodes and credentials and verifies actual state', async () => {
  const api = fakeApi();
  const backup = await createWorkflowBackup(api);
  assert.match(backup.name, /^workflow-.+\.json$/);

  api.setCurrent({
    ...api.current,
    nodes: [{ name: 'Lead Webhook', type: 'n8n-nodes-base.webhook', parameters: {}, credentials: { httpHeaderAuth: { id: 'wrong' } } }],
  });
  assert.equal(api.current.nodes[0].credentials.httpHeaderAuth.id, 'wrong');

  const restored = await restoreWorkflowBackup(api, backup.name);
  assert.equal(restored.ok, true);
  assert.equal(restored.expectedHash, restored.actualHash);
  assert.deepEqual(api.current.nodes, [{
    name: 'Lead Webhook',
    type: 'n8n-nodes-base.webhook',
    parameters: {},
    credentials: {},
  }]);
  assert.equal(api.current.active, true);
});

test('workflow restore rejects traversal and missing backups', async () => {
  const api = fakeApi();
  await assert.rejects(() => restoreWorkflowBackup(api, '../workflow.json'), /Некорректное имя/);
  await assert.rejects(() => restoreWorkflowBackup(api, 'workflow-missing.json'), /не найдена/);
});
