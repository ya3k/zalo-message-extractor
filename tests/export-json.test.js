import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exportToJson } from '../src/export-json.js';

describe('Unit Tests: exportToJson', () => {
  const testFilePath = path.resolve('output/test-export.json');

  afterEach(() => {
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  test('xuat du lieu ra file JSON hop le voi encoding UTF-8', () => {
    const data = {
      message: 'Xin chào thế giới! 🇻🇳',
      count: 42,
      active: true
    };

    const writtenPath = exportToJson(testFilePath, data);
    assert.equal(fs.existsSync(writtenPath), true);

    const content = fs.readFileSync(writtenPath, 'utf8');
    const parsed = JSON.parse(content);

    assert.deepEqual(parsed, data);
    assert.equal(parsed.message, 'Xin chào thế giới! 🇻🇳');
  });

  test('nem loi khi filePath rong hoac khong hop le', () => {
    assert.throws(() => {
      exportToJson('', { test: true });
    }, /Duong dan file khong duoc de trong/);
  });
});
