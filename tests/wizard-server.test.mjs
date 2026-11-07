import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startWizard() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-wizard-server-'));
  const configFile = path.join(dir, 'client.json');
  const base = JSON.parse(await fs.readFile(path.join(ROOT, 'config/example-client.json'), 'utf8'));
  await fs.writeFile(configFile, `${JSON.stringify(base, null, 2)}\n`, { mode: 0o600 });
  const port = await freePort();
  const child = spawn(process.execPath, ['wizard/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      WIZARD_CONFIG_FILE: configFile,
      WIZARD_PORT: String(port),
      WIZARD_NO_PROMPT: '1',
      N8N_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 50; i += 1) {
      try {
        const health = await fetch(`${baseUrl}/api/health`);
        if (health.ok) {
          ready = true;
          break;
        }
      } catch {
        // retry while the process starts
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, `wizard server did not start:\n${output}`);
    const page = await fetch(`${baseUrl}/`);
    const html = await page.text();
    const token = html.match(/name="wizard-token" content="([a-f0-9]{64})"/)?.[1];
    assert.ok(token, 'wizard token must be injected');
    return {
      baseUrl,
      token,
      base,
      page,
      html,
      output: () => output,
      async stop() {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
        await fs.rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function rawRequest(baseUrl, { method = 'POST', path: requestPath = '/api/config', headers = {}, body } = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: requestPath,
        method,
        headers,
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          settled = true;
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
        res.on('error', (error) => {
          if (!settled) reject(error);
        });
      },
    );
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
    if (body === undefined) {
      req.end();
    } else {
      req.end(body);
    }
  });
}

test('server serves the wizard, injects a per-process token, and protects POSTs', async () => {
  const wizard = await startWizard();
  try {
    const { baseUrl, token, base, page, html } = wizard;
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    assert.equal(page.status, 200);
    assert.ok(token, 'wizard token must be injected');
    assert.match(page.headers.get('content-security-policy') || '', /script-src 'self'/);

    const bootstrap = await fetch(`${baseUrl}/api/bootstrap`);
    const boot = await bootstrap.json();
    assert.equal(boot.ok, true);
    assert.equal(boot.n8n.apiKeyConfigured, false);
    assert.equal(JSON.stringify(boot).includes('test-webhook-secret'), false);

    const rejected = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: base }),
    });
    assert.equal(rejected.status, 403);

    const accepted = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Wizard-Token': token },
      body: JSON.stringify({ config: base }),
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).ok, true);
  } finally {
    await wizard.stop();
  }
  assert.match(wizard.output(), /CRM Setup Wizard/);
  assert.ok(wizard.html.includes('wizard-token'));
});

test('rejects POST /api/config with a foreign Origin', async () => {
  const wizard = await startWizard();
  try {
    const response = await rawRequest(wizard.baseUrl, {
      headers: {
        'Content-Type': 'application/json',
        'X-Wizard-Token': wizard.token,
        Origin: 'http://evil.example',
      },
      body: JSON.stringify({ config: wizard.base }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.json?.error, 'invalid_origin');
  } finally {
    await wizard.stop();
  }
});

test('rejects POST /api/config with a foreign Host header', async () => {
  const wizard = await startWizard();
  try {
    const response = await rawRequest(wizard.baseUrl, {
      headers: {
        'Content-Type': 'application/json',
        'X-Wizard-Token': wizard.token,
        Host: 'evil.example',
      },
      body: JSON.stringify({ config: wizard.base }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.json?.error, 'invalid_host');
  } finally {
    await wizard.stop();
  }
});

test('rejects POST /api/config with a non-JSON Content-Type', async () => {
  const wizard = await startWizard();
  try {
    const response = await rawRequest(wizard.baseUrl, {
      headers: {
        'Content-Type': 'text/plain',
        'X-Wizard-Token': wizard.token,
      },
      body: JSON.stringify({ config: wizard.base }),
    });
    assert.equal(response.status, 415);
    assert.equal(response.json?.error, 'unsupported_media_type');
  } finally {
    await wizard.stop();
  }
});

test('returns 413 for a POST /api/config body larger than 2 MB', async () => {
  const wizard = await startWizard();
  try {
    const body = JSON.stringify({
      config: wizard.base,
      padding: 'x'.repeat(2 * 1024 * 1024),
    });
    assert.ok(Buffer.byteLength(body) > 2 * 1024 * 1024);
    const response = await rawRequest(wizard.baseUrl, {
      headers: {
        'Content-Type': 'application/json',
        'X-Wizard-Token': wizard.token,
      },
      body,
    });
    assert.equal(response.status, 413);
    assert.equal(response.json?.error, 'body_too_large');
  } finally {
    await wizard.stop();
  }
});
