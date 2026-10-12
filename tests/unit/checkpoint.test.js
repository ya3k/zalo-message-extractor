import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SyncCheckpointStore } from '../../src/storage/sync-checkpoint.js';

test('Unit Tests: SyncCheckpointStore', async (t) => {
  const testDir = path.resolve(process.cwd(), './storage/test_checkpoints');
  const store = new SyncCheckpointStore({ baseDir: testDir });

  t.after(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  await t.test('getCheckpoint: Trả về null nếu chưa có checkpoint', () => {
    const cp = store.getCheckpoint('acc_1', 'grp_none');
    assert.equal(cp, null);
  });

  await t.test('saveCheckpoint: Ghi và cập nhật checkpoint nguyên tử', () => {
    const cp1 = store.saveCheckpoint('acc_1', 'grp_1', {
      lastMsgId: '1000',
      totalSynced: 50
    });

    assert.equal(cp1.accountId, 'acc_1');
    assert.equal(cp1.groupId, 'grp_1');
    assert.equal(cp1.lastMsgId, '1000');
    assert.ok(cp1.updatedAt);

    // Đọc lại từ đĩa
    const loaded = store.getCheckpoint('acc_1', 'grp_1');
    assert.deepEqual(loaded, cp1);

    // Cập nhật tiếp checkpoint
    const cp2 = store.saveCheckpoint('acc_1', 'grp_1', {
      lastMsgId: '1050',
      totalSynced: 100
    });
    assert.equal(cp2.lastMsgId, '1050');
    assert.equal(cp2.totalSynced, 100);
  });
});
