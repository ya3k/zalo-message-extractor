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

test('Burst Simulation Tests: High Throughput, Multi-Group, Slow Media, Faults & Recovery', async (t) => {
  const testDir = path.resolve(process.cwd(), './storage/test_burst');

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

  await t.test('Burst Test: 100 tin nhắn trong thời gian ngắn từ nhiều group đồng thời', async () => {
    const config = {
      accountId: 'acc_burst_01',
      allowedGroupIds: ['grp_1', 'grp_2', 'grp_3', 'grp_4'],
      sessionPath: path.join(testDir, 'session.json'),
      qrPath: path.join(testDir, 'qr.png'),
      egress: { verifyEgressIp: false },
      storage: {
        storageDir: testDir,
        mediaDir: path.join(testDir, 'media'),
        outputDir: path.join(testDir, 'output')
      },
      sync: {
        messageCount: 50,
        rateLimitDelayMs: 0,
        maxRetries: 2,
        autoDownloadMedia: true,
        maxMediaSizeBytes: 1024 * 1024,
        mediaConcurrency: 3
      }
    };

    let downloadAttempts = 0;
    // Giả lập media download chậm hơn tốc độ nhận tin (50ms per download)
    const slowMediaStorage = {
      downloadAndStore: async (att, ctx) => {
        downloadAttempts++;
        await new Promise((r) => setTimeout(r, 40));
        return {
          ...att,
          storageKey: `${ctx.accountId}/${ctx.groupId}/${att.attachmentId}.jpg`,
          checksum: 'sha256_mock_hash',
          downloadStatus: DownloadStatus.DOWNLOADED
        };
      }
    };

    const adapter = new ZaloAdapter({ accountId: config.accountId });
    const messageStorage = new MessageStorage({ baseDir: testDir });
    const checkpointStore = new SyncCheckpointStore({ baseDir: path.join(testDir, 'checkpoints') });
    const queueFilePath = path.join(testDir, 'queue', 'media-jobs.json');
    const mediaQueue = new PersistentMediaQueue({
      queueFilePath,
      mediaStorage: slowMediaStorage,
      concurrency: 3,
      onJobCompleted: async (job, processedAtt) => {
        messageStorage.updateAttachment(job.accountId, job.groupId, job.messageId, job.attachmentId, processedAtt);
      }
    });

    const worker = new ZaloWorker(config, {
      adapter,
      messageStorage,
      mediaStorage: slowMediaStorage,
      checkpointStore,
      mediaQueue
    });

    const eventHandlers = {};
    worker.api = {
      listener: {
        on: (ev, fn) => { eventHandlers[ev] = fn; },
        start: () => {}
      }
    };

    await worker.startRealtimeListener();

    // Sinh 100 tin nhắn giả lập từ 4 nhóm khác nhau, bao gồm:
    // - 70 tin nhắn text
    // - 30 tin nhắn có ảnh/file
    // - 10 tin nhắn trùng lặp cố tình
    const TOTAL_BURST = 100;
    const messages = [];
    const groups = ['grp_1', 'grp_2', 'grp_3', 'grp_4'];

    for (let i = 0; i < TOTAL_BURST; i++) {
      const isDuplicate = i % 10 === 0 && i > 0;
      const targetGroupIdx = isDuplicate ? (i - 1) % groups.length : i % groups.length;
      const msgId = isDuplicate ? `burst_msg_${i - 1}` : `burst_msg_${i}`;
      const groupId = groups[targetGroupIdx];
      const hasMedia = i % 3 === 0;

      messages.push({
        threadId: groupId,
        data: {
          msgId,
          uidFrom: `user_${i % 10}`,
          content: hasMedia
            ? { photoId: `p_${i}`, hdUrl: `https://example.com/p_${i}.jpg` }
            : `Nội dung burst tin số ${i}`,
          ts: String(1710000000000 + i * 100),
          msgType: hasMedia ? 'chat.photo' : 'webchat'
        }
      });
    }

    // Bắt đầu đo thời gian nhận tin (Ingestion Speed)
    const startTime = Date.now();

    // Bắn 100 messages đồng thời vào listener callback
    await Promise.all(messages.map((m) => eventHandlers['message'](m)));

    const ingestionDurationMs = Date.now() - startTime;
    console.log(`[Burst Metric] Thời gian hoàn tất tiếp nhận & persist 100 tin nhắn: ${ingestionDurationMs}ms`);

    // Ingestion PHẢI hoàn tất cực nhanh (dưới 5 giây cho 100 tin), không bị chặn bởi media
    assert.ok(
      ingestionDurationMs < 5000,
      `Ingestion phải hoàn tất nhanh dưới 5s (thực tế: ${ingestionDurationMs}ms)`
    );

    // Kiểm tra số lượng tin nhắn duy nhất đã nhận trong từng nhóm
    let totalStoredMessages = 0;
    for (const grp of groups) {
      const msgs = messageStorage.getNormalizedMessages(config.accountId, grp);
      totalStoredMessages += msgs.length;
    }

    // Tổng số tin duy nhất: 100 tin trừ đi 9 tin trùng = 91 tin duy nhất
    console.log(`[Burst Metric] Tổng tin nhắn duy nhất đã lưu trong kho: ${totalStoredMessages} tin.`);
    assert.equal(totalStoredMessages, 91, 'Phải lưu chính xác 91 tin nhắn duy nhất (đã khử trùng 9 tin)');

    // Kiểm tra queue backlog tại thời điểm ngay sau khi nhận tin
    const initialStats = worker.getQueueStats();
    console.log(`[Burst Metric] Queue backlog ngay sau khi nhận tin:`, initialStats);
    assert.ok(initialStats.queueDepth > 0 || initialStats.activeWorkers > 0);

    // Chờ toàn bộ media queue hoàn tất xử lý trong nền
    const drainSuccess = await mediaQueue.drain(15000);
    assert.equal(drainSuccess, true, 'Hàng đợi media phải xả hết');

    const finalStats = worker.getQueueStats();
    console.log(`[Burst Metric] Trạng thái queue sau khi hoàn tất xử lý:`, finalStats);
    assert.equal(finalStats.queueDepth, 0);
    assert.ok(finalStats.completedCount > 0);

    await worker.shutdown(2000);
  });

  await t.test('Burst Test: Worker Restart khi Queue đang còn pending tác vụ (Crash Recovery)', async () => {
    const queueFilePath = path.join(testDir, 'queue', 'media-jobs.json');

    // 1. Tạo hàng đợi ban đầu và đẩy 5 tác vụ
    const mockStorage = {
      downloadAndStore: async (att) => {
        // Giả lập thời gian tải
        await new Promise((r) => setTimeout(r, 200));
        return { ...att, downloadStatus: DownloadStatus.DOWNLOADED };
      }
    };

    const queue1 = new PersistentMediaQueue({
      queueFilePath,
      mediaStorage: mockStorage,
      concurrency: 1
    });

    for (let i = 1; i <= 5; i++) {
      queue1.enqueue({
        accountId: 'acc_rec',
        groupId: 'grp_rec',
        messageId: `msg_${i}`,
        attachment: { attachmentId: `att_${i}`, _downloadUrl: `https://example.com/file_${i}.jpg` }
      });
    }

    // Dừng đột ngột trước khi hoàn tất (giả lập crash/shutdown)
    queue1.stop();

    // 2. Khởi tạo Worker / Queue mới (giả lập process khởi động lại sau crash)
    let processedAfterRestart = 0;
    const restartStorage = {
      downloadAndStore: async (att) => {
        processedAfterRestart++;
        return { ...att, downloadStatus: DownloadStatus.DOWNLOADED };
      }
    };

    const queue2 = new PersistentMediaQueue({
      queueFilePath,
      mediaStorage: restartStorage,
      concurrency: 2
    });

    // Queue mới phải nhận diện được các tác vụ chưa hoàn tất từ file state
    const restartStats = queue2.getStats();
    assert.ok(restartStats.queueDepth > 0, 'Phải phục hồi được các tác vụ pending từ đĩa');

    // Kích hoạt xử lý tiếp
    queue2.scheduleProcess();
    const drained = await queue2.drain(5000);
    assert.equal(drained, true);
    assert.ok(processedAfterRestart > 0, 'Phải tiếp tục tải các tác vụ còn dang dở');
    assert.equal(queue2.getStats().queueDepth, 0);

    queue2.stop();
  });
});
