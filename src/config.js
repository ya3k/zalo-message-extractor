import fs from 'node:fs';
import path from 'node:path';

/**
 * Doc va parse file .env don gian ma khong can dependency ben ngoai
 * @param {string} envPath
 */
export function loadEnvFile(envPath = '.env') {
  const fullPath = path.resolve(process.cwd(), envPath);
  if (!fs.existsSync(fullPath)) {
    return;
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// Tu dong load .env khi import config neu file ton tai
loadEnvFile();

export const config = {
  sessionPath: path.resolve(process.cwd(), process.env.SESSION_PATH || './session.json'),
  groupId: process.env.GROUP_ID || '',
  messageCount: parseInt(process.env.MESSAGE_COUNT || '10', 10),
  sortOrder: process.env.SORT_ORDER || 'asc',
  outputDir: path.resolve(process.cwd(), process.env.OUTPUT_DIR || './output')
};
