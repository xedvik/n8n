import assert from 'node:assert/strict';
import test from 'node:test';

import { createOps } from '../wizard/lib/ops.mjs';

function recorder(handler) {
  const calls = [];
  const run = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    return handler({ command, args, options, calls });
  };
  return { run, calls };
}

function sqlOf(call) {
  return call.args[call.args.length - 1];
}

test('summary reads safe aggregate data without raw operation fields', async () => {
  const { run, calls } = recorder(() => ({
    code: 0,
    stdout:
      '{"counts":{"completed":5,"pending":2},"total":7,"needsReconciliation":1,"dueForRecovery":3}\n',
    stderr: '',
  }));
  const ops = createOps({
    run,
    env: { POSTGRES_USER: 'crm', POSTGRES_DB: 'leads' },
    cwd: '/srv/n8n',
  });

  const result = await ops.summary();

  assert.deepEqual(result, {
    ok: true,
    counts: { completed: 5, pending: 2 },
    total: 7,
    needsReconciliation: 1,
    dueForRecovery: 3,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'docker');
  assert.deepEqual(calls[0].args.slice(0, 10), [
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'crm',
    '-d',
    'leads',
    '-Atc',
  ]);
  assert.equal(calls[0].options.cwd, '/srv/n8n');

  const sql = sqlOf(calls[0]);
  assert.match(sql, /json_build_object/);
  for (const forbidden of ['raw_payload', 'response', 'fingerprint', 'idempotency_key']) {
    assert.equal(sql.includes(forbidden), false, `summary SQL must not read ${forbidden}`);
  }
});

test('list filters by whitelisted status and clamps the limit', async () => {
  const operation = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    status: 'failed',
    attempts: 3,
    nextAttemptAt: null,
    updatedAt: '2026-11-07T12:00:00.000Z',
    lastError: 'CRM timeout',
    requestId: 'req-1',
    source: 'webhook',
    crmStatus: 'failed',
    journalStatus: 'ok',
    telegramStatus: 'pending',
  };

  async function runFor(limitCall) {
    const { run, calls } = recorder(() => ({
      code: 0,
      stdout: `${JSON.stringify({ operations: [operation], total: 42 })}\n`,
      stderr: '',
    }));
    const ops = createOps({ run, env: {}, cwd: '/srv/n8n' });
    const result = await ops.list(limitCall);
    return { result, calls };
  }

  const filtered = await runFor({ status: 'failed', limit: 500 });
  assert.deepEqual(filtered.result, { ok: true, operations: [operation], total: 42 });
  const filteredSql = sqlOf(filtered.calls[0]);
  assert.match(filteredSql, /WHERE status = 'failed'/);
  assert.match(filteredSql, /LIMIT 100/);
  for (const forbidden of ['raw_payload', 'response', 'fingerprint', 'idempotency_key']) {
    assert.equal(filteredSql.includes(forbidden), false, `list SQL must not read ${forbidden}`);
  }

  const low = await runFor({ limit: 0 });
  assert.match(sqlOf(low.calls[0]), /LIMIT 1/);
  assert.equal(sqlOf(low.calls[0]).includes('WHERE status'), false);

  const truncated = await runFor({ limit: 20.9 });
  assert.match(sqlOf(truncated.calls[0]), /LIMIT 20/);
});

test('invalid UUID and status are rejected before running any command', async () => {
  let ran = false;
  const ops = createOps({
    run: async () => {
      ran = true;
      throw new Error('run must not be called');
    },
    env: {},
    cwd: '/srv/n8n',
  });

  await assert.rejects(
    () => ops.retry('not-a-uuid'),
    (error) => error.code === 'invalid_operation_id',
  );
  await assert.rejects(
    () => ops.list({ status: 'deleted' }),
    (error) => error.code === 'invalid_status',
  );
  await assert.rejects(
    () => ops.list({ status: 'FAILED' }),
    (error) => error.code === 'invalid_status',
  );

  assert.equal(ran, false);
});

test('retry invokes the retry script with the UUID and reset flag', async () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const { run, calls } = recorder(() => ({
    code: 0,
    stdout: `Operation: ${id}\nScheduled for explicit retry. secret topsecretvalue n8n_api_abc123\n`,
    stderr: '',
  }));
  const ops = createOps({
    run,
    env: { LEAD_WEBHOOK_SECRET: 'topsecretvalue' },
    cwd: '/srv/n8n',
  });

  const result = await ops.retry(id, { resetAttempts: true });

  assert.equal(result.ok, true);
  assert.match(result.message, /повторную обработку/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'bash');
  assert.deepEqual(calls[0].args, [
    'scripts/retry-operation.sh',
    id,
    '--reset-attempts',
  ]);
  assert.equal(calls[0].options.cwd, '/srv/n8n');
  assert.equal(result.output.includes('topsecretvalue'), false);
  assert.equal(result.output.includes('n8n_api_abc123'), false);
  assert.match(result.output, /\[redacted\]/);
});

test('retry maps nonzero script output to user-facing errors', async () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';

  async function retryWith(stderr, stdout = '') {
    const { run, calls } = recorder(() => ({ code: 1, stdout, stderr }));
    const ops = createOps({ run, env: {}, cwd: '/srv/n8n' });
    return { calls, promise: ops.retry(id) };
  }

  const processing = await retryWith('Operation is currently processing; refusing to start a concurrent retry.');
  assert.equal(processing.calls.length, 1);
  await assert.rejects(
    processing.promise,
    (error) => error.code === 'operation_state_invalid',
  );

  const missing = await retryWith(`Operation not found: ${id}`);
  await assert.rejects(missing.promise, (error) => error.code === 'operation_not_found');

  const docker = await retryWith('PostgreSQL container is not running.');
  await assert.rejects(docker.promise, (error) => error.code === 'docker_unavailable');
});

test('retry rejects an already completed operation even on a zero exit code', async () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const { run } = recorder(() => ({
    code: 0,
    stdout: 'Operation is already completed; nothing to retry.',
    stderr: '',
  }));
  const ops = createOps({ run, env: {}, cwd: '/srv/n8n' });

  await assert.rejects(
    () => ops.retry(id),
    (error) => error.code === 'operation_state_invalid',
  );
});

test('health parses running compose services', async () => {
  const { run, calls } = recorder(() => ({
    code: 0,
    stdout: 'postgres\nn8n\nwizard\ncaddy\n',
    stderr: '',
  }));
  const ops = createOps({ run, env: {}, cwd: '/srv/n8n' });

  const result = await ops.health();

  assert.deepEqual(result, {
    ok: true,
    postgres: true,
    n8n: true,
    wizard: true,
    caddy: true,
  });
  assert.deepEqual(calls[0].args, ['compose', 'ps', '--status', 'running', '--services']);
});

test('health reports unavailable Docker as false flags without crashing', async () => {
  const { run } = recorder(() => ({
    code: 1,
    stdout: '',
    stderr: 'Cannot connect to the Docker daemon',
  }));
  const ops = createOps({ run, env: {}, cwd: '/srv/n8n' });

  const result = await ops.health();

  assert.equal(result.ok, true);
  assert.equal(result.postgres, false);
  assert.equal(result.n8n, false);
  assert.equal(result.wizard, false);
  assert.equal(result.caddy, false);
  assert.equal(typeof result.warning, 'string');

  const throwing = createOps({
    run: async () => {
      throw new Error('spawn docker ENOENT');
    },
    env: {},
    cwd: '/srv/n8n',
  });
  const failed = await throwing.health();
  assert.equal(failed.ok, true);
  assert.equal(failed.postgres, false);
  assert.equal(typeof failed.warning, 'string');
});
