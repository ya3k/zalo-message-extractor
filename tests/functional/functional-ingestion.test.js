import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ZaloWorker } from '../../src/worker/zalo-worker.js';
import { MessageStorage } from '../../src/storage/message-storage.js';
import { FileSystemMediaStorage } from '../../src/storage/media-storage.js';
import { SyncCheckpointStore } from '../../src/storage/sync-checkpoint.js';
import { PersistentMediaQueue } from '../../src/storage/media-queue.js';
import { ZaloAdapter } from '../../src/adapter/zalo-adapter.js';
import { DownloadStatus } from '../../src/adapter/message-types.js';

test('Functional Tests: Message Ingestion, Deduplication, Media & Error Isolation', async (t) => {
  const testDir = path.resolve(process.cwd(), './storage/test_functional');

  t.beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  t.after(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  function setupWorker(overrides = {}) {
    const config = {
      accountId: 'acc_func_test',
      allowedGroupIds: ['grp_alpha', 'grp_beta'],
      sessionPath: path.join(testDir, 'session.json'),
      qrPath: path.join(testDir, 'qr.png'),
      egress: { verifyEgressIp: false },
      storage: {
        storageDir: testDir,
        mediaDir: path.join(testDir, 'media'),
        outputDir: path.join(testDir, 'output')
      },
      sync: {
        messageCount: 20,
        rateLimitDelayMs: 0,
        maxRetries: 2,
        autoDownloadMedia: true,
        maxMediaSizeBytes: 1024 * 1024,
        mediaConcurrency: 2,
        ...overrides.sync
      }
    };

    const adapter = new ZaloAdapter({ accountId: config.accountId });
    const messageStorage = new MessageStorage({ baseDir: testDir });
    const mediaStorage = overrides.mediaStorage || new FileSystemMediaStorage({
      baseDir: path.join(testDir, 'media')
    });
    const checkpointStore = new SyncCheckpointStore({
      baseDir: path.join(testDir, 'checkpoints')
    });
    const mediaQueue = new PersistentMediaQueue({
      queueFilePath: path.join(testDir, 'queue', 'media-jobs.json'),
      mediaStorage,
      concurrency: 2,
      maxRetries: 2,
      baseRetryDelayMs: 20,
      onJobCompleted: async (job, processedAtt) => {
        messageStorage.updateAttachment(job.accountId, job.groupId, job.messageId, job.attachmentId, processedAtt);
      },
      onJobFailed: async (job, err) => {
        messageStorage.updateAttachment(job.accountId, job.groupId, job.messageId, job.attachmentId, {
          downloadStatus: DownloadStatus.FAILED,
          downloadError: err.message
        });
      }
    });

    const worker = new ZaloWorker(config, {
      adapter,
      messageStorage,
      mediaStorage,
      checkpointStore,
      mediaQueue
    });

    return { worker, config, messageStorage, mediaStorage, checkpointStore, mediaQueue };
  }

  await t.test('1. Nhận và lưu message text, chuẩn hóa đúng group, sender, message ID và timestamp', async () => {
    const { worker, config, messageStorage } = setupWorker();
    const eventHandlers = {};

    worker.api = {
      listener: {
        on: (ev, fn) => { eventHandlers[ev] = fn; },
        start: () => {}
      }
    };

    await worker.startRealtimeListener();

    // Giả lập nhận 1 text message từ WebSocket
    await eventHandlers['message']({
      threadId: 'grp_alpha',
      data: {
        msgId: 'msg_txt_01',
        uidFrom: 'user_u1',
        dName: 'Nguyễn Khách',
        content: 'Nội dung tin nhắn text',
        ts: '1710000000000',
        msgType: 'webchat'
      }
    });

    const stored = messageStorage.getNormalizedMessages(config.accountId, 'grp_alpha');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].messageId, 'msg_txt_01');
    assert.equal(stored[0].groupId, 'grp_alpha');
    assert.equal(stored[0].senderId, 'user_u1');
    assert.equal(stored[0].senderName, 'Nguyễn Khách');
    assert.equal(stored[0].content, 'Nội dung tin nhắn text');
    assert.equal(stored[0].messageType, 'text');
    assert.equal(stored[0].sentAt, new Date(1710000000000).toISOString());

    worker.stopRealtimeListener();
  });

  await t.test('2. Nhận cùng một message nhiều lần mà không tạo bản ghi trùng ngoài ý muốn (Idempotency)', async () => {
    const { worker, config, messageStorage } = setupWorker();
    const eventHandlers = {};

    worker.api = {
      listener: {
        on: (ev, fn) => { eventHandlers[ev] = fn; },
        start: () => {}
      }
    };

    await worker.startRealtimeListener();

    const rawMsg = {
      threadId: 'grp_alpha',
      data: {
        msgId: 'msg_dup_test',
        uidFrom: 'user_u1',
        content: 'Tin nhắn gửi 3 lần',
        ts: '1710000001000',
        msgType: 'webchat'
      }
    };

    // Bắn cùng 1 tin nhắn 3 lần
    await eventHandlers['message'](rawMsg);
    await eventHandlers['message'](rawMsg);
    await eventHandlers['message'](rawMsg);

    const stored = messageStorage.getNormalizedMessages(config.accountId, 'grp_alpha');
    assert.equal(stored.length, 1, 'Chỉ được lưu duy nhất 1 bản ghi');
    assert.equal(stored[0].messageId, 'msg_dup_test');

    worker.stopRealtimeListener();
  });

  await t.test('3. Nhận message có ảnh/file: Lưu tin nhắn ngay lập tức và tải attachment qua queue', async () => {
    const mockMediaStorage = {
      downloadAndStore: async (att, ctx) => ({
        ...att,
        storageKey: `${ctx.accountId}/${ctx.groupId}/file_saved.jpg`,
        checksum: 'sha256_mock_hash',
        downloadStatus: DownloadStatus.DOWNLOADED
      })
    };

    const { worker, config, messageStorage, mediaQueue } = setupWorker({ mediaStorage: mockMediaStorage });
    const eventHandlers = {};

    worker.api = {
      listener: {
        on: (ev, fn) => { eventHandlers[ev] = fn; },
        start: () => {}
      }
    };

    await worker.startRealtimeListener();

    await eventHandlers['message']({
      threadId: 'grp_alpha',
      data: {
        msgId: 'msg_img_01',
        uidFrom: 'user_u2',
        msgType: 'chat.photo',
        ts: '1710000002000',
        content: {
          photoId: 'photo_999',
          hdUrl: 'https://example.com/img.jpg',
          fileName: 'hoa_don.jpg'
        }
      }
    });

    // 1. Kiểm tra tin nhắn được lưu NGAY LẬP TỨC vào messageStorage trước khi media tải xong
    let stored = messageStorage.getNormalizedMessages(config.accountId, 'grp_alpha');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].messageId, 'msg_img_01');
    assert.equal(stored[0].messageType, 'image');
    assert.equal(stored[0].attachments.length, 1);

    // 2. Chờ mediaQueue xử lý xong
    await mediaQueue.drain(3000);

    // 3. Sau khi media hoàn tất, attachment trong messages.json phải được cập nhật trạng thái
    stored = messageStorage.getNormalizedMessages(config.accountId, 'grp_alpha');
    const updatedAtt = stored[0].attachments[0];
    assert.equal(updatedAtt.downloadStatus, DownloadStatus.DOWNLOADED);
    assert.equal(updatedAtt.storageKey, 'acc_func_test/grp_alpha/file_saved.jpg');
    assert.equal(updatedAtt.checksum, 'sha256_mock_hash');

    worker.stopRealtimeListener();
  });

  await t.test('4. Media download thất bại: KHÔNG làm mất tin nhắn text/metadata, cập nhật status FAILED', async () => {
    const failingMediaStorage = {
      downloadAndStore: async () => {
        throw new Error('404 Not Found từ Zalo CDN');
      }
    };

    const { worker, config, messageStorage, mediaQueue } = setupWorker({ mediaStorage: failingMediaStorage });
    const eventHandlers = {};

    worker.api = {
      listener: {
        on: (ev, fn) => { eventHandlers[ev] = fn; },
        start: () => {}
      }
    };

    await worker.startRealtimeListener();

    await eventHandlers['message']({
      threadId: 'grp_alpha',
      data: {
        msgId: 'msg_failing_media',
        uidFrom: 'user_u3',
        msgType: 'share.file',
        ts: '1710000003000',
        content: {
          fileId: 'f_broken',
          fileUrl: 'https://example.com/broken.pdf',
          fileName: 'tai_lieu.pdf'
        }
      }
    });

    // Tin nhắn vẫn PHẢI tồn tại trong storage
    let stored = messageStorage.getNormalizedMessages(config.accountId, 'grp_alpha');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].messageId, 'msg_failing_media');

    // Chờ queue hoàn tất retry và đánh dấu failed
    await mediaQueue.drain(3000);

    // Tin nhắn vẫn còn, trạng thái attachment được cập nhật FAILED kèm lỗi
    stored = messageStorage.getNormalizedMessages(config.accountId, 'grp_alpha');
    assert.equal(stored.length, 1);
    const att = stored[0].attachments[0];
    assert.equal(att.downloadStatus, DownloadStatus.FAILED);
    assert.ok(att.downloadError);

    worker.stopRealtimeListener();
  });

  await t.test('5. Lỗi xử lý một tin nhắn không làm dừng hoặc ảnh hưởng các tin nhắn tiếp theo', async () => {
    const { worker, config, messageStorage } = setupWorker();
    const eventHandlers = {};

    worker.api = {
      listener: {
        on: (ev, fn) => { eventHandlers[ev] = fn; },
        start: () => {}
      }
    };

    await worker.startRealtimeListener();

    // Tin nhắn 1: Dữ liệu bị lỗi bất thường (undefined gây lỗi nếu không cô lập)
    await eventHandlers['message'](null);

    // Tin nhắn 2: Dữ liệu hợp lệ bình thường
    await eventHandlers['message']({
      threadId: 'grp_alpha',
      data: {
        msgId: 'msg_valid_after_error',
        uidFrom: 'user_u4',
        content: 'Tin nhắn sau tin lỗi',
        ts: '1710000004000',
        msgType: 'webchat'
      }
    });

    const stored = messageStorage.getNormalizedMessages(config.accountId, 'grp_alpha');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].messageId, 'msg_valid_after_error');

    worker.stopRealtimeListener();
  });

  await t.test('6. Quản lý Lifecycle: Không đăng ký lặp lại listener khi đã chạy', async () => {
    const { worker } = setupWorker();
    let registerCount = 0;

    worker.api = {
      listener: {
        on: () => { registerCount++; },
        start: () => {}
      }
    };

    await worker.startRealtimeListener();
    const count1 = registerCount;
    assert.ok(count1 > 0);

    // Gọi lần 2: Không được đăng ký thêm handler
    await worker.startRealtimeListener();
    assert.equal(registerCount, count1, 'Không được tăng thêm handler khi listener đang active');

    // Dừng listener và reset cờ
    worker.stopRealtimeListener();
    assert.equal(worker.isListening, false);
  });
});
