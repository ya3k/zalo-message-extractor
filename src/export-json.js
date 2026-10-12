import fs from 'node:fs';
import path from 'node:path';

/**
 * Ghi du lieu ra file JSON dinh dang UTF-8
 * @param {string} filePath - Duong dan file dich
 * @param {any} data - Du lieu can serialize thanh JSON
 * @returns {string} - Duong dan tuyet doi cua file da ghi
 */
export function exportToJson(filePath, data) {
  if (!filePath) {
    throw new Error('Duong dan file khong duoc de trong');
  }

  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  const dir = path.dirname(absolutePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const jsonContent = JSON.stringify(data, null, 2);
  fs.writeFileSync(absolutePath, jsonContent, 'utf8');

  return absolutePath;
}
