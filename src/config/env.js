import fs from 'node:fs';
import path from 'node:path';

/**
 * Đọc và parse file .env mà không cần cài thêm dependency bên ngoài
 * @param {string} envPath - Đường dẫn file .env
 */
export function loadEnv(envPath = '.env') {
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

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// Tự động load .env
loadEnv();
