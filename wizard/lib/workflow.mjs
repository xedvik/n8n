import { execFile } from 'node:child_process';
import { ROOT } from './config.mjs';

export const WORKFLOW_ID = process.env.WORKFLOW_ID || '7c9f5a2e-3b4d-4f6a-9c1e-2d8b7a6f5e40';

const HEADER_NODES = ['Lead Webhook', 'Recovery Request'];
const POSTGRES_NODES = [
  'Reserve Operation',
  'Save CRM State',
  'Save CRM Failure State',
  'Save Journal State',
  'Save Journal Failure State',
  'Save Notification State',
  'Save Final State',
  'Select Due Operations',
];
const GOOGLE_NODES = [
  'CRM Adapter - Google Sheets',
  'Journal Adapter - Google Sheets',
  'Error Log Adapter - Google Sheets',
  'Read CRM Leads',
  'Read Journal',
];
const HUBSPOT_NODES = [
  'HubSpot Search Contact',
  'HubSpot Create Contact',
  'HubSpot Update Contact',
];

function nodeByName(workflow, name) {
  const node = workflow.nodes?.find((item) => item.name === name);
  if (!node) {
    throw Object.assign(new Error(`В workflow не найдена нода «${name}».`), {
      code: 'workflow_node_missing',
    });
  }
  return node;
}

function attach(node, type, credential) {
  node.credentials = node.credentials && typeof node.credentials === 'object' ? node.credentials : {};
  node.credentials[type] = { id: credential.id, name: credential.name };
}

function assertCredentialType(credential, integration, expected) {
  if (credential.type && credential.type !== expected) {
    throw Object.assign(
      new Error(
        `Тип credential для интеграции «${integration}» не соответствует: фактический «${credential.type}», ожидаемый «${expected}».`,
      ),
      { code: 'credential_type_mismatch' },
    );
  }
}

export async function applyWorkflowCredentials(api, config, credentials = {}) {
  const workflow = await api.getWorkflow(WORKFLOW_ID);
  if (!workflow || !Array.isArray(workflow.nodes)) {
    throw Object.assign(new Error('n8n вернул workflow без nodes.'), { code: 'workflow_invalid' });
  }
  const updated = new Set();

  if (credentials.headerAuth) {
    assertCredentialType(credentials.headerAuth, 'Header Auth', 'httpHeaderAuth');
    for (const name of HEADER_NODES) {
      attach(nodeByName(workflow, name), 'httpHeaderAuth', credentials.headerAuth);
      updated.add(name);
    }
  }
  if (credentials.postgres) {
    assertCredentialType(credentials.postgres, 'PostgreSQL', 'postgres');
    for (const name of POSTGRES_NODES) {
      attach(nodeByName(workflow, name), 'postgres', credentials.postgres);
      updated.add(name);
    }
  }

  const googleNeeded =
    config.crm?.provider === 'google_sheets' || config.journal?.enabled || config.errors?.enabled;
  if (googleNeeded && credentials.google) {
    const mode = credentials.google.mode || (credentials.google.type === 'googleApi' ? 'service_account' : 'oauth2');
    const type = mode === 'service_account' ? 'googleApi' : 'googleSheetsOAuth2Api';
    if (credentials.google.type && credentials.google.type !== type) {
      throw Object.assign(new Error('Тип Google credential не соответствует выбранному способу доступа.'), {
        code: 'credential_type_mismatch',
      });
    }
    for (const name of GOOGLE_NODES) {
      const node = nodeByName(workflow, name);
      node.parameters = node.parameters && typeof node.parameters === 'object' ? node.parameters : {};
      node.parameters.authentication = mode === 'service_account' ? 'serviceAccount' : 'oAuth2';
      attach(node, type, credentials.google);
      updated.add(name);
    }
  }

  if (config.crm?.provider === 'hubspot' && credentials.hubspot) {
    const type = credentials.hubspot.type || 'hubspotAppToken';
    if (!['hubspotAppToken', 'hubspotOAuth2Api'].includes(type)) {
      throw Object.assign(new Error('Неподдерживаемый тип HubSpot credential.'), {
        code: 'credential_type_mismatch',
      });
    }
    for (const name of HUBSPOT_NODES) {
      const node = nodeByName(workflow, name);
      node.parameters = node.parameters && typeof node.parameters === 'object' ? node.parameters : {};
      node.parameters.nodeCredentialType = type;
      attach(node, type, credentials.hubspot);
      updated.add(name);
    }
  }

  if (config.notifications?.enabled && credentials.telegram) {
    assertCredentialType(credentials.telegram, 'Telegram', 'telegramApi');
    attach(nodeByName(workflow, 'Notification Adapter - Telegram'), 'telegramApi', credentials.telegram);
    updated.add('Notification Adapter - Telegram');
  }

  const result = await api.updateWorkflow(WORKFLOW_ID, workflow, { publishIfActive: true });
  return {
    workflow: {
      id: result.id || WORKFLOW_ID,
      active: Boolean(result.active),
      versionId: result.versionId || result.activeVersionId || null,
    },
    updatedNodes: [...updated],
  };
}

export async function installWorkflow() {
  return new Promise((resolve) => {
    execFile(
      'bash',
      ['scripts/import-workflow.sh'],
      {
        cwd: ROOT,
        env: { ...process.env, ALLOW_REIMPORT: '0' },
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const output = `${stdout || ''}${stderr || ''}`.trim();
        resolve({
          ok: !error,
          output: output.slice(-8000),
          message: error ? 'Не удалось установить workflow. Проверьте Docker и лог.' : 'Workflow установлен и опубликован.',
        });
      },
    );
  });
}
