import { execFile } from 'node:child_process';
import { ROOT } from './config.mjs';
import { sanitizeText } from './security.mjs';

let running = false;

export async function runDoctor({ integrationTest = false } = {}) {
  if (running) {
    throw Object.assign(new Error('Проверка doctor уже выполняется.'), { code: 'doctor_busy' });
  }
  running = true;
  try {
    return await new Promise((resolve) => {
      execFile(
        'bash',
        ['scripts/doctor.sh', ...(integrationTest ? ['--integration-test'] : [])],
        {
          cwd: ROOT,
          env: process.env,
          timeout: 180_000,
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const secrets = [
            process.env.LEAD_WEBHOOK_SECRET,
            process.env.POSTGRES_PASSWORD,
            process.env.N8N_API_KEY,
          ];
          const output = sanitizeText(`${stdout || ''}${stderr || ''}`, secrets);
          const checks = [];
          for (const line of output.split(/\r?\n/)) {
            const match = line.match(/^(OK|WARN|FAIL|INFO):\s*(.*)$/);
            if (match) checks.push({ level: match[1].toLowerCase(), message: match[2] });
          }
          const resultMatch = output.match(/RESULT:\s*(PASS|FAIL|UNVERIFIED)/i);
          const result = resultMatch ? resultMatch[1].toUpperCase() : 'UNVERIFIED';
          const ok = result === 'PASS' && !error;
          resolve({
            ok,
            result,
            checks,
            message:
              result === 'PASS'
                ? 'Проверка doctor пройдена.'
                : result === 'FAIL'
                  ? 'Проверка doctor не пройдена. Смотрите список ошибок.'
                  : 'Не удалось подтвердить результат doctor. Проверьте Docker и конфигурацию.',
          });
        },
      );
    });
  } finally {
    running = false;
  }
}
