import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PersistentMediaQueue } from '../../src/storage/media-queue.js';
import { DownloadStatus } from '../../src/adapter/message-types.js';

test('Unit Tests: PersistentMediaQueue', async (t) => {
  const testDir = path.resolve(process.cwd(), './storage/test_media_queue');
  const queueFile = path.join(testDir, 'media-jobs.json');

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

  await t.test('enqueue & process: Xử lý thành công tác vụ tải media với concurrency giới hạn', async () => {
    let downloadCount = 0;
    const mockStorage = {
      downloadAndStore: async (att, ctx) => {
        downloadCount++;
        return {
          ...att,
          storageKey: `${ctx.accountId}/${ctx.groupId}/${att.attachmentId}.jpg`,
          downloadStatus: DownloadStatus.DOWNLOADED
        };
      }
    };

    let completedJob = null;
    const queue = new PersistentMediaQueue({
      queueFilePath: queueFile,
      mediaStorage: mockStorage,
      concurrency: 2,
      onJobCompleted: (job, processedAtt) => {
        completedJob = { job, processedAtt };
      }
    });

    const job = queue.enqueue({
      accountId: 'acc_01',
      groupId: 'grp_01',
      messageId: 'msg_01',
      attachment: {
        attachmentId: 'att_101',
        fileName: 'photo.jpg',
        _downloadUrl: 'https://example.com/photo.jpg'
      }
    });

    assert.equal(job.status, 'pending');
    assert.equal(job.jobId, 'acc_01_grp_01_msg_01_att_101');

    // Chờ queue xử lý xong
    const drained = await queue.drain(3000);
    assert.equal(drained, true);
    assert.equal(downloadCount, 1);
    assert.ok(completedJob);
    assert.equal(completedJob.processedAtt.downloadStatus, DownloadStatus.DOWNLOADED);

    const stats = queue.getStats();
    assert.equal(stats.queueDepth, 0);
    assert.equal(stats.completedCount, 1);
    assert.equal(stats.failedCount, 0);

    queue.stop();
  });

  await t.test('Deduplication: Không tạo job trùng lặp khi enqueue cùng một attachment', async () => {
    const mockStorage = {
      downloadAndStore: async (att) => ({ ...att, downloadStatus: DownloadStatus.DOWNLOADED })
    };

    const queue = new PersistentMediaQueue({
      queueFilePath: queueFile,
      mediaStorage: mockStorage,
      concurrency: 1
    });

    const job1 = queue.enqueue({
      accountId: 'acc_01',
      groupId: 'grp_01',
      messageId: 'msg_dup',
      attachment: { attachmentId: 'att_dup', _downloadUrl: 'https://example.com/dup.jpg' }
    });

    const job2 = queue.enqueue({
      accountId: 'acc_01',
      groupId: 'grp_01',
      messageId: 'msg_dup',
      attachment: { attachmentId: 'att_dup', _downloadUrl: 'https://example.com/dup.jpg' }
    });

    assert.equal(job1.jobId, job2.jobId);
    await queue.drain(2000);
    assert.equal(queue.getStats().completedCount, 1);
    queue.stop();
  });

  await t.test('Retry & Exponential Backoff: Tác vụ lỗi được thử lại và ghi nhận failed khi hết lượt', async () => {
    let attempts = 0;
    const mockStorage = {
      downloadAndStore: async () => {
        attempts++;
        throw new Error('Connection timeout 504');
      }
    };

    let failedJob = null;
    const queue = new PersistentMediaQueue({
      queueFilePath: queueFile,
      mediaStorage: mockStorage,
      concurrency: 1,
      maxRetries: 2,
      baseRetryDelayMs: 20, // Tăng tốc cho test
      onJobFailed: (job, err) => {
        failedJob = { job, err };
      }
    });

    queue.enqueue({
      accountId: 'acc_01',
      groupId: 'grp_01',
      messageId: 'msg_fail',
      attachment: { attachmentId: 'att_fail', _downloadUrl: 'https://example.com/fail.jpg' }
    });

    await queue.drain(3000);

    assert.equal(attempts, 2);
    assert.ok(failedJob);
    assert.equal(failedJob.job.status, 'failed');
    assert.equal(queue.getStats().failedCount, 1);
    queue.stop();
  });

  await t.test('Recovery sau restart: Khôi phục job bị gián đoạn từ đĩa và tiếp tục xử lý', async () => {
    // Giả lập trạng thái file queue trên đĩa có job đang 'processing' trước khi process crash
    const interruptedPayload = {
      version: '1.0.0',
      savedAt: new Date().toISOString(),
      jobs: [
        {
          jobId: 'acc_01_grp_01_msg_rec_att_rec',
          accountId: 'acc_01',
          groupId: 'grp_01',
          messageId: 'msg_rec',
          attachmentId: 'att_rec',
          attachment: { attachmentId: 'att_rec', _downloadUrl: 'https://example.com/rec.jpg' },
          status: 'processing', // Bị ngắt giữa chừng
          attempts: 1,
          maxRetries: 3,
          nextAttemptAt: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]
    };

    fs.mkdirSync(path.dirname(queueFile), { recursive: true });
    fs.writeFileSync(queueFile, JSON.stringify(interruptedPayload, null, 2));

    let recoveredDownload = false;
    const mockStorage = {
      downloadAndStore: async (att) => {
        recoveredDownload = true;
        return { ...att, downloadStatus: DownloadStatus.DOWNLOADED };
      }
    };

    // Khởi tạo queue mới đọc lại từ file trên
    const queue = new PersistentMediaQueue({
      queueFilePath: queueFile,
      mediaStorage: mockStorage,
      concurrency: 1
    });

    // Job 'processing' phải được tự động chuyển về 'pending' khi nạp
    const statsInitial = queue.getStats();
    assert.equal(statsInitial.queueDepth, 1);

    // Kích hoạt xử lý queue
    queue.scheduleProcess();
    await queue.drain(3000);

    assert.equal(recoveredDownload, true);
    assert.equal(queue.getStats().completedCount, 1);
    queue.stop();
  });
});
