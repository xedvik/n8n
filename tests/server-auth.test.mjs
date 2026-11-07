import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const TOKEN = 'server-auth-bootstrap-token-0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
const USERNAME = 'admin';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function fakeN8n() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/healthz/readiness') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/v1/credentials')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found' }));
  });
  await listen(server);
  return {
    port: server.address().port,
    requests,
    close: () => close(server),
  };
}

async function startWizard({ dataDir, configFile, n8nPort, proxyPort, port }) {
  const child = spawn(process.execPath, ['wizard/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      WIZARD_SERVER_MODE: '1',
      WIZARD_DATA_DIR: dataDir,
      WIZARD_BOOTSTRAP_TOKEN: TOKEN,
      WIZARD_HOST: '127.0.0.1',
      WIZARD_PORT: String(port),
      WIZARD_ALLOWED_HOSTS: `127.0.0.1:${proxyPort}`,
      WIZARD_COOKIE_PATH: '/setup',
      WIZARD_COOKIE_SECURE: '0',
      WIZARD_SECRET_KEY: 'server-auth-integration-secret',
      WIZARD_CONFIG_FILE: configFile,
      N8N_API_URL: `http://127.0.0.1:${n8nPort}`,
      N8N_PUBLIC_URL: 'https://crm.example.test/',
      N8N_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
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
      // wait for startup
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');
  throw new Error(`wizard did not start:\n${output}`);
}

function proxyToWizard({ port, proxyPort }) {
  const server = http.createServer((req, res) => {
    const incoming = new URL(req.url || '/', `http://127.0.0.1:${proxyPort}`);
    if (!incoming.pathname.startsWith('/setup/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port,
        method: req.method,
        path: `${incoming.pathname.slice('/setup'.length)}${incoming.search}`,
        headers: { ...req.headers, host: `127.0.0.1:${proxyPort}` },
        agent: false,
      },
      (response) => {
        res.writeHead(response.statusCode || 500, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('bad gateway');
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
  });
  return listen(server, proxyPort).then(() => ({
    port: proxyPort,
    close: () => close(server),
  }));
}

function cookieFrom(response) {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'response must set a session cookie');
  assert.match(header, /Path=\/setup/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  return header.split(';')[0];
}

async function request(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('server mode gates the wizard, registers one admin, persists sessions, and stores the n8n key encrypted', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-server-auth-'));
  const configFile = path.join(tempDir, 'client.json');
  const dataDir = path.join(tempDir, 'wizard-data');
  const baseConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'config/example-client.json'), 'utf8'));
  await fs.writeFile(configFile, `${JSON.stringify(baseConfig, null, 2)}\n`, { mode: 0o600 });

  const n8n = await fakeN8n();
  const wizardPort = await freePort();
  const proxyPort = await freePort();
  let wizard = await startWizard({
    dataDir,
    configFile,
    n8nPort: n8n.port,
    proxyPort,
    port: wizardPort,
  });
  const proxy = await proxyToWizard({ port: wizardPort, proxyPort });
  const base = `http://127.0.0.1:${proxyPort}/setup`;

  try {
    const loginPage = await request(base, '/');
    assert.equal(loginPage.status, 200);
    const loginHtml = await loginPage.text();
    const token = loginHtml.match(/name="wizard-token" content="([a-f0-9]{64})"/)?.[1];
    assert.ok(token, 'login page must receive the CSRF token');
    assert.match(loginHtml, /auth-root/);

    const noSession = await request(base, '/api/bootstrap');
    assert.equal(noSession.status, 401);
    assert.equal((await noSession.json()).error, 'auth_required');

    const unauthorizedApp = await request(base, '/app.js');
    assert.equal(unauthorizedApp.status, 401);

    const csrfHeaders = {
      'X-Wizard-Token': token,
      Origin: `http://127.0.0.1:${proxyPort}`,
    };

    const registered = await request(base, '/api/auth/register', {
      method: 'POST',
      headers: csrfHeaders,
      body: { token: TOKEN, username: USERNAME, password: PASSWORD },
    });
    assert.equal(registered.status, 200);
    const cookie = cookieFrom(registered);

    const index = await request(base, '/', { headers: { Cookie: cookie } });
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Настройка клиента/);

    const bootstrap = await request(base, '/api/bootstrap', { headers: { Cookie: cookie } });
    assert.equal(bootstrap.status, 200);
    const boot = await bootstrap.json();
    assert.equal(boot.auth.serverMode, true);
    assert.equal(boot.n8n.publicUrl, 'https://crm.example.test');
    assert.equal(boot.n8n.apiKeyConfigured, false);
    assert.equal(JSON.stringify(boot).includes(TOKEN), false);
    assert.equal(JSON.stringify(boot).includes(PASSWORD), false);

    const duplicate = await request(base, '/api/auth/register', {
      method: 'POST',
      headers: csrfHeaders,
      body: { token: TOKEN, username: 'second', password: PASSWORD },
    });
    assert.equal(duplicate.status, 409);

    const connected = await request(base, '/api/n8n/connect', {
      method: 'POST',
      headers: { ...csrfHeaders, Cookie: cookie },
      body: { apiKey: 'n8n_api_integration_test_key' },
    });
    assert.equal(connected.status, 200);
    assert.equal((await connected.json()).apiKeyConfigured, true);
    const encrypted = await fs.readFile(path.join(dataDir, 'n8n-api-key.enc'), 'utf8');
    assert.equal(encrypted.includes('n8n_api_integration_test_key'), false);
    const connectedBoot = await request(base, '/api/bootstrap', { headers: { Cookie: cookie } });
    const connectedBody = await connectedBoot.json();
    assert.equal(connectedBody.n8n.apiKeyConfigured, true);
    assert.equal(JSON.stringify(connectedBody).includes('n8n_api_integration_test_key'), false);

    const logout = await request(base, '/api/auth/logout', {
      method: 'POST',
      headers: { ...csrfHeaders, Cookie: cookie },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/);

    const afterLogout = await request(base, '/api/bootstrap', { headers: { Cookie: cookie } });
    assert.equal(afterLogout.status, 401);

    const wrongLogin = await request(base, '/api/auth/login', {
      method: 'POST',
      headers: csrfHeaders,
      body: { username: USERNAME, password: 'wrong password value' },
    });
    assert.equal(wrongLogin.status, 401);

    const login = await request(base, '/api/auth/login', {
      method: 'POST',
      headers: csrfHeaders,
      body: { username: USERNAME, password: PASSWORD },
    });
    assert.equal(login.status, 200);
    const secondCookie = cookieFrom(login);

    const tampered = `${secondCookie}A`;
    const tamperedResponse = await request(base, '/api/bootstrap', { headers: { Cookie: tampered } });
    assert.equal(tamperedResponse.status, 401);

    await wizard.stop();
    wizard = await startWizard({
      dataDir,
      configFile,
      n8nPort: n8n.port,
      proxyPort,
      port: wizardPort,
    });

    const restartedStatus = await request(base, '/api/auth/status', { headers: { Cookie: secondCookie } });
    assert.equal(restartedStatus.status, 200);
    assert.equal((await restartedStatus.json()).authenticated, true);

    const restartedBootstrap = await request(base, '/api/bootstrap', { headers: { Cookie: secondCookie } });
    assert.equal(restartedBootstrap.status, 200);
    assert.equal((await restartedBootstrap.json()).n8n.apiKeyConfigured, true);
  } finally {
    await wizard.stop();
    await proxy.close();
    await n8n.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
