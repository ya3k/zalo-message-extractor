import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ZaloWorker } from '../../src/worker/zalo-worker.js';
import { MessageStorage } from '../../src/storage/message-storage.js';
import { FileSystemMediaStorage } from '../../src/storage/media-storage.js';
import { SyncCheckpointStore } from '../../src/storage/sync-checkpoint.js';
import { ZaloAdapter } from '../../src/adapter/zalo-adapter.js';

test('Unit Tests: ZaloWorker', async (t) => {
  const testDir = path.resolve(process.cwd(), './storage/test_worker');

  t.after(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  const mockConfig = {
    accountId: 'acc_worker_test',
    allowedGroupIds: ['grp_allowed_1', 'grp_allowed_2'],
    sessionPath: path.join(testDir, 'session.json'),
    qrPath: path.join(testDir, 'qr.png'),
    egress: {
      proxyUrl: null,
      fixedIp: null,
      verifyEgressIp: false
    },
    storage: {
      storageDir: testDir,
      mediaDir: path.join(testDir, 'media'),
      outputDir: path.join(testDir, 'output')
    },
    sync: {
      messageCount: 10,
      rateLimitDelayMs: 0,
      maxRetries: 2,
      autoDownloadMedia: false,
      maxMediaSizeBytes: 1024 * 1024
    }
  };

  const adapter = new ZaloAdapter({ accountId: mockConfig.accountId });
  const messageStorage = new MessageStorage({ baseDir: testDir });
  const mediaStorage = new FileSystemMediaStorage({ baseDir: path.join(testDir, 'media') });
  const checkpointStore = new SyncCheckpointStore({ baseDir: path.join(testDir, 'checkpoints') });

  const worker = new ZaloWorker(mockConfig, {
    adapter,
    messageStorage,
    mediaStorage,
    checkpointStore
  });

  await t.test('isGroupAllowed: Kiểm soát chặt chẽ quyền truy cập nhóm', () => {
    assert.equal(worker.isGroupAllowed('grp_allowed_1'), true);
    assert.equal(worker.isGroupAllowed('grp_allowed_2'), true);
    assert.equal(worker.isGroupAllowed('grp_hacker_3'), false);
    assert.equal(worker.isGroupAllowed(null), false);
    assert.equal(worker.isGroupAllowed(''), false);
  });

  await t.test('syncGroup: Bỏ qua các nhóm không được ủy quyền (unauthorized_group)', async () => {
    const res = await worker.syncGroup('grp_forbidden');
    assert.equal(res.status, 'skipped');
    assert.equal(res.reason, 'unauthorized_group');
    assert.equal(res.count, 0);
  });

  await t.test('syncGroup: Thực hiện đồng bộ thành công với mock API', async () => {
    // Giả lập instance API của zca-js
    let callCount = 0;
    worker.api = {
      getGroupChatHistory: async (groupId, count) => {
        callCount++;
        return {
          groupMsgs: [
            {
              msgId: 'msg_w1',
              idTo: groupId,
              uidFrom: 'user_a',
              dName: 'User A',
              content: 'Tin nhan tu mock API',
              ts: 1710000000000,
              msgType: 'webchat'
            }
          ]
        };
      }
    };

    const res = await worker.syncGroup('grp_allowed_1');
    assert.equal(res.status, 'success');
    assert.equal(res.groupId, 'grp_allowed_1');
    assert.equal(res.count, 1);
    assert.equal(res.added, 1);
    assert.equal(callCount, 1);

    // Kiểm tra checkpoint được lưu
    const cp = checkpointStore.getCheckpoint(mockConfig.accountId, 'grp_allowed_1');
    assert.ok(cp);
    assert.equal(cp.lastMsgId, 'msg_w1');

    // Kiểm tra tin nhắn trong messageStorage
    const stored = messageStorage.getNormalizedMessages(mockConfig.accountId, 'grp_allowed_1');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].messageId, 'msg_w1');
  });

  await t.test('syncGroup: Cơ chế retry khi gặp lỗi tạm thời và phục hồi thành công', async () => {
    let attempts = 0;
    worker.api = {
      getGroupChatHistory: async (groupId, count) => {
        attempts++;
        if (attempts === 1) {
          throw new Error('Mạng bị gián đoạn tạm thời');
        }
        return {
          groupMsgs: [
            {
              msgId: 'msg_w2',
              idTo: groupId,
              uidFrom: 'user_b',
              content: 'Tin nhắn sau khi retry',
              ts: 1710000010000,
              msgType: 'webchat'
            }
          ]
        };
      }
    };

    const res = await worker.syncGroup('grp_allowed_2');
    assert.equal(res.status, 'success');
    assert.equal(attempts, 2); // Thành công ở lần thử thứ 2
    assert.equal(res.count, 1);
  });

  await t.test('startRealtimeListener: Tự động nhận, chuẩn hóa và lưu tin nhắn mới qua sự kiện', async () => {
    let capturedCallbackMsg = null;
    const listeners = {};

    worker.api = {
      listener: {
        on: (event, handler) => {
          listeners[event] = handler;
        },
        start: () => {}
      }
    };

    await worker.startRealtimeListener((normalized) => {
      capturedCallbackMsg = normalized;
    });

    assert.ok(listeners['message'], 'Phải đăng ký handler cho event message');

    // 1. Giả lập tin nhắn thuộc nhóm không được phép -> Bỏ qua
    await listeners['message']({
      threadId: 'grp_forbidden',
      data: { msgId: 'm_forbidden', content: 'Tin bị chặn', ts: 1710000020000 }
    });
    assert.equal(capturedCallbackMsg, null);

    // 2. Giả lập tin nhắn thuộc nhóm được phép -> Tự động xử lý và lưu kho
    await listeners['message']({
      threadId: 'grp_allowed_1',
      data: {
        msgId: 'm_realtime_1',
        uidFrom: 'user_rt',
        dName: 'Khách Hàng',
        content: 'Tin nhắn thời gian thực',
        ts: 1710000030000,
        msgType: 'webchat'
      }
    });

    assert.ok(capturedCallbackMsg);
    assert.equal(capturedCallbackMsg.messageId, 'm_realtime_1');
    assert.equal(capturedCallbackMsg.content, 'Tin nhắn thời gian thực');

    // Kiểm tra tin nhắn đã vào storage
    const inStore = messageStorage.getNormalizedMessages(mockConfig.accountId, 'grp_allowed_1');
    const found = inStore.find((m) => m.messageId === 'm_realtime_1');
    assert.ok(found);
    assert.equal(found.content, 'Tin nhắn thời gian thực');
  });
});
