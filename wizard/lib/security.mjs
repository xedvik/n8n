import crypto from 'node:crypto';

export function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function isLoopback(address) {
  if (!address) return false;
  const value = String(address);
  return value === '::1' || value === '127.0.0.1' || value.startsWith('127.') || value === '::ffff:127.0.0.1';
}

export function hostAllowed(hostHeader, port) {
  if (!hostHeader) return false;
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  if (port === 80) {
    allowed.add('127.0.0.1');
    allowed.add('localhost');
    allowed.add('[::1]');
  }
  const extra = String(process.env.WIZARD_ALLOWED_HOSTS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of extra) allowed.add(item);
  return allowed.has(String(hostHeader).toLowerCase());
}

export function originAllowed(origin, hostHeader) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === hostHeader;
  } catch {
    return false;
  }
}

export function tokenMatches(expected, supplied) {
  if (typeof expected !== 'string' || typeof supplied !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { code: 'body_too_large' }));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { code: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

export function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ...extra,
  };
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res, status, code, message, details) {
  const payload = { ok: false, error: code, message };
  if (details !== undefined) payload.details = details;
  sendJson(res, status, payload);
}

export function sanitizeText(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) {
      text = text.split(secret).join('[redacted]');
    }
  }
  text = text
    .replace(/n8n_api_[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, '[private-key-redacted]');
  return text.slice(0, 4000);
}
