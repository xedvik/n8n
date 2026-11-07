import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const { configHash } = await import('../wizard/lib/config.mjs');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function fakeN8n() {
  const workflow = {
    id: 'w1', name: 'Lead Intake', active: true,
    nodes: [{ name: 'Lead Webhook', type: 'n8n-nodes-base.webhook', parameters: {}, credentials: {} }],
    connections: {}, settings: {},
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/healthz/readiness') return send(200, { status: 'ok' });
      if (req.method === 'GET' && req.url === '/api/v1/workflows/w1') return send(200, workflow);
      if (req.method === 'GET' && req.url.startsWith('/api/v1/credentials')) return send(200, { data: [] });
      if (req.method === 'PUT' && req.url === '/api/v1/workflows/w1?publishIfActive=true') {
        const body = JSON.parse(raw || '{}');
        Object.assign(workflow, body, { id: 'w1', active: true });
        return send(200, workflow);
      }
      return send(404, { message: 'not found' });
    });
  });
  await listen(server);
  return {
    port: server.address().port,
    workflow,
    close: () => close(server),
  };
}

async function startWizard({ configFile, dataDir, n8nPort, port }) {
  const child = spawn(process.execPath, ['wizard/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      WIZARD_SERVER_MODE: '0',
      WIZARD_CONFIG_FILE: configFile,
      WIZARD_DATA_DIR: dataDir,
      WIZARD_HOST: '127.0.0.1',
      WIZARD_PORT: String(port),
      N8N_API_URL: `http://127.0.0.1:${n8nPort}`,
      N8N_API_KEY: 'test-api-key',
      WORKFLOW_ID: 'w1',
      N8N_PUBLIC_URL: 'https://crm.example.test/',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) {
          return {
            child,
            output: () => output,
            stop: async () => {
              child.kill('SIGTERM');
              await new Promise((resolve) => child.once('exit', resolve));
            },
          };
        }
      } catch {
        // start
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`wizard did not start:\n${output}`);
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}

async function pageToken(baseUrl) {
  const html = await (await fetch(`${baseUrl}/`)).text();
  const token = html.match(/name="wizard-token" content="([a-f0-9]{64})"/)?.[1];
  assert.ok(token);
  return token;
}

async function post(baseUrl, token, pathname, body) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'X-Wizard-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

test('workflow backup/restore and verification snapshot survive server round trips', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-wizard-fixes-'));
  const configFile = path.join(dir, 'client.json');
  const dataDir = path.join(dir, 'data');
  const base = JSON.parse(await fs.readFile(path.join(ROOT, 'config/example-client.json'), 'utf8'));
  await fs.writeFile(configFile, `${JSON.stringify(base, null, 2)}\n`, { mode: 0o600 });
  const n8n = await fakeN8n();
  const port = await freePort();
  const wizard = await startWizard({ configFile, dataDir, n8nPort: n8n.port, port });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const token = await pageToken(baseUrl);
    const backupResponse = await post(baseUrl, token, '/api/workflow/backups', {});
    assert.equal(backupResponse.status, 200);
    const backup = (await backupResponse.json()).backup;
    assert.match(backup.name, /^workflow-.+\.json$/);

    n8n.workflow.nodes[0].credentials = { httpHeaderAuth: { id: 'wrong', name: 'Wrong' } };
    const restoreResponse = await post(baseUrl, token, '/api/workflow/restore', {
      backup: backup.name,
      confirm: true,
    });
    assert.equal(restoreResponse.status, 200);
    const restored = await restoreResponse.json();
    assert.equal(restored.ok, true);
    assert.deepEqual(n8n.workflow.nodes[0].credentials, {});

    const hash = configHash(base);
    const verificationResponse = await post(baseUrl, token, '/api/verifications', {
      configHash: hash,
      results: {
        hubspot: { ok: true, status: 'connected', token: 'must-not-be-saved' },
      },
    });
    assert.equal(verificationResponse.status, 200);
    assert.deepEqual((await verificationResponse.json()).saved, ['hubspot']);

    await post(baseUrl, token, '/api/verifications', {
      configHash: 'c'.repeat(64),
      results: { hubspot: { ok: false, status: 'error' } },
    });
    const boot = await (await fetch(`${baseUrl}/api/bootstrap`)).json();
    assert.equal(boot.configHash, hash);
    assert.equal(boot.verifications.hubspot.ok, true);
    assert.equal(boot.verifications.hubspot.status, 'connected');
    assert.equal(boot.verifications.hubspot.checkedAt !== undefined, true);
    const stored = await fs.readFile(path.join(dataDir, 'integration-verifications.json'), 'utf8');
    assert.equal(stored.includes('must-not-be-saved'), false);
  } finally {
    await wizard.stop();
    await n8n.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
