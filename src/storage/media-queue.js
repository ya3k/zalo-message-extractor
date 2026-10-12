import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DownloadStatus } from '../adapter/message-types.js';

/**
 * @typedef {Object} MediaJob
 * @property {string} jobId - Khóa định danh duy nhất của tác vụ tải
 * @property {string} accountId
 * @property {string} groupId
 * @property {string} messageId
 * @property {string} attachmentId
 * @property {Object} attachment - Thông tin attachment kèm _downloadUrl
 * @property {'pending'|'processing'|'completed'|'failed'} status
 * @property {number} attempts - Số lần đã thử
 * @property {number} maxRetries - Số lần thử tối đa
 * @property {number} nextAttemptAt - Timestamp ms cho lần thử tiếp theo (backoff)
 * @property {string|null} lastError
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Hàng đợi tải media bền vững (Persistent Media Download Queue)
 * - Tách biệt hoàn toàn việc tải media khỏi listener tiếp nhận tin nhắn
 * - Lưu trạng thái bền vững trên filesystem để khôi phục hoàn toàn sau khi restart
 * - Giới hạn concurrency (mặc định 3, có thể cấu hình)
 * - Cơ chế retry có giới hạn với Exponential Backoff
 * - Thu thập số liệu vận hành: queueDepth, activeWorkers, failedCount, oldestJobAgeMs
 */
export class PersistentMediaQueue {
  /**
   * @param {Object} options
   * @param {string} options.queueFilePath - Đường dẫn file lưu trạng thái queue (.json)
   * @param {import('./media-storage.js').MediaStorage} options.mediaStorage - Instance lưu trữ media
   * @param {Function} [options.onJobCompleted] - Callback khi tải xong (để cập nhật lại messageStorage)
   * @param {Function} [options.onJobFailed] - Callback khi tải thất bại vĩnh viễn
   * @param {number} [options.concurrency=3] - Số luồng tải đồng thời tối đa
   * @param {number} [options.maxRetries=3] - Số lần retry tối đa cho mỗi file
   * @param {number} [options.baseRetryDelayMs=1000] - Thời gian chờ cơ sở cho backoff
   */
  constructor(options = {}) {
    if (!options.queueFilePath) {
      throw new Error('PersistentMediaQueue yêu cầu tham số queueFilePath');
    }
    if (!options.mediaStorage) {
      throw new Error('PersistentMediaQueue yêu cầu instance mediaStorage');
    }

    this.queueFilePath = path.resolve(process.cwd(), options.queueFilePath);
    this.mediaStorage = options.mediaStorage;
    this.onJobCompleted = options.onJobCompleted || null;
    this.onJobFailed = options.onJobFailed || null;

    this.concurrency = Math.max(1, options.concurrency || 3);
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : 3;
    this.baseRetryDelayMs = options.baseRetryDelayMs || 1000;

    /** @type {Map<string, MediaJob>} */
    this.jobs = new Map();

    this.activeWorkers = 0;
    this.isProcessing = false;
    this.isDraining = false;
    this.processTimer = null;

    this.ensureDir(path.dirname(this.queueFilePath));
    this.loadState();
  }

  ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Ghi file nguyên tử (Atomic write)
   */
  atomicWrite(targetPath, content) {
    const dir = path.dirname(targetPath);
    this.ensureDir(dir);
    const tmpPath = `${targetPath}.${Date.now()}_${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  }

  /**
   * Tải trạng thái queue từ đĩa khi khởi động
   * Tự động khôi phục các job đang 'processing' bị gián đoạn về 'pending'
   */
  loadState() {
    if (!fs.existsSync(this.queueFilePath)) {
      return;
    }

    try {
      const content = fs.readFileSync(this.queueFilePath, 'utf8');
      const data = JSON.parse(content);
      const jobsList = Array.isArray(data.jobs) ? data.jobs : [];

      this.jobs.clear();
      for (const job of jobsList) {
        if (!job || !job.jobId) continue;

        // Nếu tiến trình trước bị dừng đột ngột khi đang 'processing', đưa về 'pending' để tiếp tục
        if (job.status === 'processing') {
          job.status = 'pending';
          job.updatedAt = new Date().toISOString();
        }

        this.jobs.set(job.jobId, job);
      }
    } catch (err) {
      console.warn(`[MediaQueue] Cảnh báo khi đọc file queue state (${err.message}). Khởi tạo lại rỗng.`);
    }
  }

  /**
   * Lưu bền vững trạng thái queue ra file JSON trên đĩa
   */
  saveState() {
    // Chỉ lưu các job chưa hoàn tất hoặc tối đa 50 job gần nhất đã xong/lỗi để tránh phình file
    const allJobs = Array.from(this.jobs.values());
    const pendingOrProcessing = allJobs.filter((j) => j.status === 'pending' || j.status === 'processing');
    const finishedJobs = allJobs
      .filter((j) => j.status === 'completed' || j.status === 'failed')
      .slice(-50); // Giữ tối đa 50 job gần nhất

    const payload = {
      version: '1.0.0',
      savedAt: new Date().toISOString(),
      stats: this.getStats(),
      jobs: [...pendingOrProcessing, ...finishedJobs]
    };

    try {
      this.atomicWrite(this.queueFilePath, JSON.stringify(payload, null, 2));
    } catch (err) {
      console.error(`[MediaQueue] Lỗi lưu queue state: ${err.message}`);
    }
  }

  /**
   * Tạo jobId ổn định từ metadata
   */
  generateJobId(accountId, groupId, messageId, attachmentId) {
    return `${accountId}_${groupId}_${messageId}_${attachmentId}`;
  }

  /**
   * Đưa một attachment vào hàng đợi tải bền vững
   * @param {Object} params
   * @param {string} params.accountId
   * @param {string} params.groupId
   * @param {string} params.messageId
   * @param {Object} params.attachment
   * @returns {MediaJob}
   */
  enqueue(params) {
    const { accountId, groupId, messageId, attachment } = params;
    if (!attachment || !attachment.attachmentId) {
      throw new Error('Attachment không hợp lệ hoặc thiếu attachmentId');
    }

    const jobId = this.generateJobId(accountId, groupId, messageId, attachment.attachmentId);

    // Chống đưa trùng tác vụ đang tồn tại trong hàng đợi
    const existing = this.jobs.get(jobId);
    if (existing) {
      if (existing.status === 'completed') {
        return existing; // Đã tải xong trước đó, không tải lại
      }
      if (existing.status === 'processing' || existing.status === 'pending') {
        return existing; // Đang chờ hoặc đang xử lý
      }
      // Nếu đã failed trước đó, cho phép thử lại
    }

    const now = new Date().toISOString();
    /** @type {MediaJob} */
    const job = {
      jobId,
      accountId,
      groupId,
      messageId,
      attachmentId: attachment.attachmentId,
      attachment: { ...attachment },
      status: 'pending',
      attempts: 0,
      maxRetries: this.maxRetries,
      nextAttemptAt: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now
    };

    this.jobs.set(jobId, job);
    this.saveState();

    // Kích hoạt xử lý queue
    this.scheduleProcess();

    return job;
  }

  /**
   * Lên lịch chạy vòng lặp xử lý queue
   * @param {number} [delayMs=0]
   */
  scheduleProcess(delayMs = 0) {
    if (this.processTimer) return;
    this.processTimer = setTimeout(() => {
      this.processTimer = null;
      this.processQueue();
    }, delayMs);
  }

  /**
   * Vòng lặp điều phối xử lý hàng đợi theo giới hạn concurrency
   */
  async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const now = Date.now();
      while (this.activeWorkers < this.concurrency) {
        // Tìm job đang pending và đã đến hạn chạy (nextAttemptAt <= now)
        let candidate = null;
        for (const job of this.jobs.values()) {
          if (job.status === 'pending' && job.nextAttemptAt <= now) {
            candidate = job;
            break;
          }
        }

        if (!candidate) {
          break; // Không còn job nào đủ điều kiện xử lý lúc này
        }

        // Đánh dấu processing và tăng worker
        candidate.status = 'processing';
        candidate.updatedAt = new Date().toISOString();
        candidate.attempts += 1;
        this.activeWorkers += 1;
        this.saveState();

        // Chạy job không chặn vòng lặp chính
        this.executeJob(candidate).finally(() => {
          this.activeWorkers = Math.max(0, this.activeWorkers - 1);
          this.scheduleProcess();
        });
      }
    } finally {
      this.isProcessing = false;
    }

    // Nếu vẫn còn job pending nhưng chưa đến hạn backoff, lên lịch kiểm tra lại
    const now = Date.now();
    let minDelay = null;
    for (const job of this.jobs.values()) {
      if (job.status === 'pending' && job.nextAttemptAt > now) {
        const delay = job.nextAttemptAt - now;
        if (minDelay === null || delay < minDelay) {
          minDelay = delay;
        }
      }
    }

    if (minDelay !== null && minDelay > 0) {
      this.scheduleProcess(minDelay);
    }
  }

  /**
   * Thực hiện tải một file media đơn lẻ
   * @param {MediaJob} job
   */
  async executeJob(job) {
    try {
      const processedAtt = await this.mediaStorage.downloadAndStore(job.attachment, {
        accountId: job.accountId,
        groupId: job.groupId,
        messageId: job.messageId
      });

      if (processedAtt.downloadStatus === DownloadStatus.DOWNLOADED) {
        job.status = 'completed';
        job.attachment = processedAtt;
        job.updatedAt = new Date().toISOString();
        job.lastError = null;

        this.saveState();

        if (typeof this.onJobCompleted === 'function') {
          try {
            await this.onJobCompleted(job, processedAtt);
          } catch (cbErr) {
            console.error(`[MediaQueue] Lỗi callback onJobCompleted: ${cbErr.message}`);
          }
        }
      } else if (processedAtt.downloadStatus === DownloadStatus.UNSUPPORTED) {
        // Không hỗ trợ tải, đánh dấu hoàn tất (không retry)
        job.status = 'completed';
        job.attachment = processedAtt;
        job.updatedAt = new Date().toISOString();
        this.saveState();

        if (typeof this.onJobCompleted === 'function') {
          try {
            await this.onJobCompleted(job, processedAtt);
          } catch {}
        }
      } else {
        // Tải thất bại
        throw new Error(processedAtt.downloadError || 'Tải file thất bại');
      }
    } catch (err) {
      job.lastError = err.message;
      job.updatedAt = new Date().toISOString();

      if (job.attempts < job.maxRetries) {
        // Retry với exponential backoff (1s, 2s, 4s...)
        const backoffDelay = this.baseRetryDelayMs * Math.pow(2, job.attempts - 1);
        job.status = 'pending';
        job.nextAttemptAt = Date.now() + backoffDelay;
        this.saveState();
      } else {
        // Hết lượt retry -> đánh dấu thất bại vĩnh viễn
        job.status = 'failed';
        job.attachment.downloadStatus = DownloadStatus.FAILED;
        job.attachment.downloadError = err.message;
        delete job.attachment._downloadUrl;
        this.saveState();

        if (typeof this.onJobFailed === 'function') {
          try {
            await this.onJobFailed(job, err);
          } catch (failCbErr) {
            console.error(`[MediaQueue] Lỗi callback onJobFailed: ${failCbErr.message}`);
          }
        }
      }
    }
  }

  /**
   * Lấy số liệu thống kê vận hành của queue
   * @returns {{ queueDepth: number, activeWorkers: number, completedCount: number, failedCount: number, oldestJobAgeMs: number }}
   */
  getStats() {
    let pendingCount = 0;
    let completedCount = 0;
    let failedCount = 0;
    let oldestCreated = null;
    const now = Date.now();

    for (const job of this.jobs.values()) {
      if (job.status === 'pending') {
        pendingCount++;
        const createdMs = new Date(job.createdAt).getTime();
        if (oldestCreated === null || createdMs < oldestCreated) {
          oldestCreated = createdMs;
        }
      } else if (job.status === 'completed') {
        completedCount++;
      } else if (job.status === 'failed') {
        failedCount++;
      }
    }

    const oldestJobAgeMs = oldestCreated !== null ? Math.max(0, now - oldestCreated) : 0;

    return {
      queueDepth: pendingCount,
      activeWorkers: this.activeWorkers,
      completedCount,
      failedCount,
      oldestJobAgeMs
    };
  }

  /**
   * Đợi cho đến khi toàn bộ hàng đợi được xử lý xong (phục vụ test hoặc shutdown)
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<boolean>}
   */
  async drain(timeoutMs = 30000) {
    const start = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        const stats = this.getStats();
        if (stats.queueDepth === 0 && stats.activeWorkers === 0) {
          return resolve(true);
        }
        if (Date.now() - start >= timeoutMs) {
          return resolve(false); // Hết thời gian chờ
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  /**
   * Dừng queue an toàn
   */
  stop() {
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = null;
    }
    this.saveState();
  }
}
