import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(scriptDir, '../workflows/lead-intake.json');
const configPath = process.argv[2];

if (!configPath) {
  console.error('Usage: node scripts/config-check.mjs <client-config.json>');
  process.exit(2);
}

const workflow = JSON.parse(readFileSync(workflowPath, 'utf8'));
const validator = workflow.nodes.find((node) => node.name === 'Validate Client Config');
if (!validator || !validator.parameters?.jsCode) {
  console.error('Validate Client Config node not found in workflow');
  process.exit(2);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const $input = {
  first: () => ({ json: { config } }),
  all: () => [{ json: { config } }],
};
const $ = () => {
  throw new Error('Unexpected cross-node reference while validating config');
};

try {
  const execute = new Function('$', '$input', '$execution', validator.parameters.jsCode);
  const output = execute($, $input, { id: 'config-check' });
  process.stdout.write(`${JSON.stringify(output[0].json.config)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
