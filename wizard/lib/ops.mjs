import { execFile } from 'node:child_process';
import { sanitizeText } from './security.mjs';

export const OPERATION_STATUSES = Object.freeze([
  'pending',
  'processing',
  'retry_scheduled',
  'completed',
  'failed',
  'needs_reconciliation',
]);

const STATUS_SET = new Set(OPERATION_STATUSES);
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const SUMMARY_SQL = `
SELECT json_build_object(
  'counts', COALESCE((
    SELECT json_object_agg(grouped.status, grouped.occurrences)
    FROM (
      SELECT status, count(*)::int AS occurrences
      FROM app.lead_operations
      GROUP BY status
    ) grouped
  ), '{}'::json),
  'total', (SELECT count(*)::int FROM app.lead_operations),
  'needsReconciliation', (
    SELECT count(*)::int
    FROM app.lead_operations
    WHERE status = 'needs_reconciliation'
  ),
  'dueForRecovery', (
    SELECT count(*)::int
    FROM app.lead_operations
    WHERE (status = 'retry_scheduled' AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
       OR (status = 'processing' AND updated_at < now() - interval '5 minutes')
  )
)::text;
`;

function defaultRun(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { maxBuffer: 16 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        let code = 0;
        if (error) code = typeof error.code === 'number' ? error.code : 1;
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function secretsFrom(env) {
  return [
    env.POSTGRES_PASSWORD,
    env.LEAD_WEBHOOK_SECRET,
    env.N8N_API_KEY,
    env.N8N_ENCRYPTION_KEY,
    env.WIZARD_SECRET_KEY,
  ].filter((value) => typeof value === 'string' && value.length >= 6);
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(parsed)));
}

function normalizeStatus(status) {
  if (status === undefined || status === null) return null;
  if (typeof status !== 'string' || !STATUS_SET.has(status)) {
    throw failure('invalid_status', 'Недопустимый статус операции.');
  }
  return status;
}

function listSql(status, limit) {
  const where = status ? `WHERE status = '${status}'` : '';
  return `
SELECT json_build_object(
  'operations', COALESCE((
    SELECT json_agg(limited.operation ORDER BY limited.updated_at DESC)
    FROM (
      SELECT
        json_build_object(
          'id', id,
          'status', status,
          'attempts', attempts,
          'nextAttemptAt', next_attempt_at,
          'updatedAt', updated_at,
          'lastError', last_error,
          'requestId', request_id,
          'source', source,
          'crmStatus', crm_status,
          'journalStatus', journal_status,
          'telegramStatus', telegram_status
        ) AS operation,
        updated_at
      FROM app.lead_operations
      ${where}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    ) limited
  ), '[]'::json),
  'total', (
    SELECT count(*)::int
    FROM app.lead_operations
    ${where}
  )
)::text;
`;
}

function parseJsonLine(stdout) {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.find((item) => item.startsWith('{'));
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function psqlArgs(env, sql) {
  return [
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    String(env.POSTGRES_USER || 'n8n'),
    '-d',
    String(env.POSTGRES_DB || 'n8n'),
    '-Atc',
    sql,
  ];
}

function retryFailure(output) {
  const text = String(output || '').toLowerCase();
  if (/operation not found/.test(text)) {
    return failure('operation_not_found', 'Операция не найдена.');
  }
  if (
    /postgresql container is not running/.test(text) ||
    /cannot connect to the docker daemon/.test(text) ||
    /docker compose/.test(text) ||
    /docker daemon/.test(text)
  ) {
    return failure('docker_unavailable', 'Docker Compose недоступен. Проверьте, что стек запущен.');
  }
  return failure(
    'operation_state_invalid',
    'Операцию нельзя повторить в текущем состоянии. Допустимы только failed, retry_scheduled, needs_reconciliation и pending.',
  );
}

export function createOps({
  run = defaultRun,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const secrets = secretsFrom(env);

  async function query(sql) {
    let result;
    try {
      result = await run('docker', psqlArgs(env, sql), { cwd, env });
    } catch (cause) {
      const error = failure(
        'docker_unavailable',
        'Не удалось подключиться к PostgreSQL. Проверьте, что Docker Compose запущен.',
      );
      error.cause = cause;
      throw error;
    }
    if (!result || result.code !== 0) {
      const error = failure(
        'docker_unavailable',
        'Не удалось получить данные из PostgreSQL. Проверьте, что Docker Compose запущен.',
      );
      const detail = sanitizeText(result?.stderr || '', secrets).trim();
      if (detail) error.output = detail;
      throw error;
    }
    const parsed = parseJsonLine(result.stdout);
    if (!parsed) {
      throw failure('docker_unavailable', 'PostgreSQL вернул некорректный ответ.');
    }
    return parsed;
  }

  async function summary() {
    const data = await query(SUMMARY_SQL);
    return {
      ok: true,
      counts: data.counts && typeof data.counts === 'object' ? data.counts : {},
      total: Number(data.total) || 0,
      needsReconciliation: Number(data.needsReconciliation) || 0,
      dueForRecovery: Number(data.dueForRecovery) || 0,
    };
  }

  async function list({ status, limit = DEFAULT_LIMIT } = {}) {
    const safeStatus = normalizeStatus(status);
    const safeLimit = normalizeLimit(limit);
    const data = await query(listSql(safeStatus, safeLimit));
    return {
      ok: true,
      operations: Array.isArray(data.operations) ? data.operations : [],
      total: Number(data.total) || 0,
    };
  }

  async function retry(id, { resetAttempts = false } = {}) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw failure('invalid_operation_id', 'Идентификатор операции должен быть UUID.');
    }

    const args = ['scripts/retry-operation.sh', id];
    if (resetAttempts) args.push('--reset-attempts');

    let result;
    try {
      result = await run('bash', args, { cwd, env });
    } catch (cause) {
      const error = failure(
        'docker_unavailable',
        'Не удалось запустить повторную обработку. Проверьте, что Docker Compose запущен.',
      );
      error.cause = cause;
      throw error;
    }

    const output = sanitizeText(
      [result?.stdout || '', result?.stderr || ''].filter(Boolean).join('\n'),
      secrets,
    ).trim();

    if (!result || result.code !== 0) {
      const error = retryFailure(output);
      if (output) error.output = output;
      throw error;
    }

    if (/already completed/i.test(output)) {
      const error = failure('operation_state_invalid', 'Операция уже завершена; повтор не требуется.');
      if (output) error.output = output;
      throw error;
    }

    return {
      ok: true,
      message: 'Операция поставлена в очередь на повторную обработку.',
      output,
    };
  }

  async function health() {
    const unavailable = {
      ok: true,
      postgres: false,
      n8n: false,
      wizard: false,
      caddy: false,
      warning: 'Docker Compose недоступен; состояние сервисов неизвестно.',
    };

    let result;
    try {
      result = await run('docker', ['compose', 'ps', '--status', 'running', '--services'], {
        cwd,
        env,
      });
    } catch {
      return unavailable;
    }
    if (!result || result.code !== 0) return unavailable;

    const services = new Set(
      String(result.stdout || '')
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(Boolean),
    );

    return {
      ok: true,
      postgres: services.has('postgres'),
      n8n: services.has('n8n'),
      wizard: services.has('wizard'),
      caddy: services.has('caddy'),
    };
  }

  return { summary, list, retry, health };
}
