import { sanitizeText } from './security.mjs';

export class N8nApiError extends Error {
  constructor(message, { status = 0, code = 'n8n_api_error' } = {}) {
    super(message);
    this.name = 'N8nApiError';
    this.status = status;
    this.code = code;
  }
}

export function defaultN8nBaseUrl() {
  if (process.env.N8N_API_URL) return process.env.N8N_API_URL.replace(/\/+$/, '');
  const protocol = process.env.N8N_PROTOCOL || 'http';
  const port = process.env.N8N_PORT || '5678';
  return `${protocol}://127.0.0.1:${port}`;
}

export class N8nApi {
  constructor({ baseUrl = defaultN8nBaseUrl(), apiKey = process.env.N8N_API_KEY || '' } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.apiKey = String(apiKey || '');
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  async health() {
    try {
      const response = await fetch(`${this.baseUrl}/healthz/readiness`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async request(method, path, { body, query, timeout = 15_000 } = {}) {
    if (!this.apiKey) {
      throw new N8nApiError('n8n API key не задан.', { code: 'n8n_api_key_missing', status: 400 });
    }
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'X-N8N-API-KEY': this.apiKey,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new N8nApiError(
        error.name === 'TimeoutError'
          ? 'n8n не ответил вовремя. Проверьте, что контейнер запущен.'
          : 'Не удалось подключиться к n8n API.',
        { code: 'n8n_unreachable' },
      );
    }

    if (response.status === 204) return null;
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      const raw = payload?.message || payload?.description || text || `HTTP ${response.status}`;
      const message = sanitizeText(raw, [this.apiKey]);
      if (response.status === 401) {
        throw new N8nApiError('n8n отклонил API key. Проверьте ключ и его scopes.', {
          status: 401,
          code: 'n8n_unauthorized',
        });
      }
      if (response.status === 403) {
        throw new N8nApiError('У API key нет доступа к этому действию в n8n.', {
          status: 403,
          code: 'n8n_forbidden',
        });
      }
      if (response.status === 404) {
        throw new N8nApiError('Объект не найден в n8n.', { status: 404, code: 'n8n_not_found' });
      }
      throw new N8nApiError(message, { status: response.status, code: 'n8n_api_error' });
    }
    return payload;
  }

  async listCredentials(type) {
    const credentials = [];
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const data = await this.request('GET', '/credentials', {
        query: { limit: 250, ...(cursor ? { cursor } : {}) },
      });
      const rows = Array.isArray(data?.data) ? data.data : [];
      for (const row of rows) {
        if (!type || row.type === type) {
          credentials.push({
            id: row.id,
            name: row.name,
            type: row.type,
            updatedAt: row.updatedAt,
          });
        }
      }
      cursor = data?.nextCursor;
      if (!cursor) break;
    }
    return credentials;
  }

  async getCredential(id) {
    return this.request('GET', `/credentials/${encodeURIComponent(id)}`);
  }

  async createCredential({ name, type, data }) {
    return this.request('POST', '/credentials', { body: { name, type, data } });
  }

  async testCredential(id) {
    return this.request('POST', `/credentials/${encodeURIComponent(id)}/test`);
  }


  async getWorkflow(id) {
    return this.request('GET', `/workflows/${encodeURIComponent(id)}`);
  }

  async updateWorkflow(id, workflow, { publishIfActive = true } = {}) {
    const body = {
      name: workflow.name,
      nodes: workflow.nodes,
      connections: workflow.connections,
      settings: workflow.settings || {},
    };
    for (const key of ['description', 'staticData', 'pinData', 'nodeGroups']) {
      if (workflow[key] !== undefined && workflow[key] !== null) body[key] = workflow[key];
    }
    return this.request('PUT', `/workflows/${encodeURIComponent(id)}`, {
      body,
      query: { publishIfActive: publishIfActive ? 'true' : 'false' },
      timeout: 30_000,
    });
  }
}
