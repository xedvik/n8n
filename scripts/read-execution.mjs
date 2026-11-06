import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse } = require('/usr/local/lib/node_modules/n8n/node_modules/flatted');

const raw = readFileSync(0, 'utf8').trim();
if (!raw) {
  console.error('No execution data received on stdin');
  process.exit(2);
}

const data = parse(raw);
const result = data.resultData || data;
const error = result.error || data.error;
const errorMessage = error
  ? (error.message || error.description || String(error))
  : null;

console.log(JSON.stringify({
  lastNodeExecuted: result.lastNodeExecuted || null,
  error: errorMessage,
}, null, 2));
