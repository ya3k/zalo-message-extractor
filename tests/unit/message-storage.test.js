import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MessageStorage } from '../../src/storage/message-storage.js';

test('Unit Tests: MessageStorage', async (t) => {
  const testStorageDir = path.resolve(process.cwd(), './storage/test_msg_store');
  const storage = new MessageStorage({ baseDir: testStorageDir });

  t.after(() => {
    if (fs.existsSync(testStorageDir)) {
      fs.rmSync(testStorageDir, { recursive: true, force: true });
    }
  });

  await t.test('saveRawResponse: Lưu raw response thành công bằng ghi nguyên tử', () => {
    const rawData = { test: true, items: [1, 2, 3] };
    const savedPath = storage.saveRawResponse('acc_test', 'grp_100', rawData, 'batch1');

    assert.ok(fs.existsSync(savedPath));
    const content = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
    assert.equal(content.accountId, 'acc_test');
    assert.equal(content.groupId, 'grp_100');
    assert.deepEqual(content.data, rawData);
  });

  await t.test('saveNormalizedMessages: Khử trùng lặp và merge tin nhắn an toàn', () => {
    const batch1 = [
      { messageId: 'm1', content: 'Tin nhắn 1', sentAt: '2026-03-01T10:00:00.000Z' },
      { messageId: 'm2', content: 'Tin nhắn 2', sentAt: '2026-03-01T10:05:00.000Z' }
    ];

    const res1 = storage.saveNormalizedMessages('acc_test', 'grp_100', batch1);
    assert.equal(res1.added, 2);
    assert.equal(res1.total, 2);

    // Đợt 2 có tin nhắn mới (m3) và tin nhắn trùng (m1)
    const batch2 = [
      { messageId: 'm1', content: 'Tin nhắn 1 Update', sentAt: '2026-03-01T10:00:00.000Z' },
      { messageId: 'm3', content: 'Tin nhắn 3', sentAt: '2026-03-01T10:10:00.000Z' }
    ];

    const res2 = storage.saveNormalizedMessages('acc_test', 'grp_100', batch2);
    assert.equal(res2.added, 1); // Chỉ thêm mới 1 tin (m3)
    assert.equal(res2.total, 3); // Tổng kho là 3 tin

    const stored = storage.getNormalizedMessages('acc_test', 'grp_100');
    assert.equal(stored.length, 3);
    assert.equal(stored[0].messageId, 'm1');
    assert.equal(stored[1].messageId, 'm2');
    assert.equal(stored[2].messageId, 'm3');
  });

  await t.test('getNormalizedMessages: Trả về mảng rỗng nếu chưa có dữ liệu', () => {
    const emptyList = storage.getNormalizedMessages('acc_unknown', 'grp_unknown');
    assert.deepEqual(emptyList, []);
  });
});
