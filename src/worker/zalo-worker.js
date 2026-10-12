import fs from 'node:fs';
import path from 'node:path';
import { createZaloClient } from '../client/zalo-client.js';
import { verifyEgressIp } from '../client/egress-verifier.js';
import { fetchGroupHistoryV2 } from '../client/custom-history.js';
import { ZaloAdapter } from '../adapter/zalo-adapter.js';
import { MessageStorage } from '../storage/message-storage.js';
import { FileSystemMediaStorage } from '../storage/media-storage.js';
import { SyncCheckpointStore } from '../storage/sync-checkpoint.js';
import { PersistentMediaQueue } from '../storage/media-queue.js';

/**
 * Worker chịu trách nhiệm quản lý vòng đời thu thập dữ liệu Zalo cho một tài khoản
 * - Không gửi tin nhắn, không sửa/xóa dữ liệu Zalo (READ-ONLY)
 * - Tách biệt logic nghiệp vụ, chuyển toàn bộ dữ liệu qua ZaloAdapter
 * - Kiểm soát quyền truy cập: Chỉ ingest các group nằm trong allowedGroupIds
 * - Quản lý retry, rate limit, kiểm tra IP egress và ghi bền vững checkpoint
 */
export class ZaloWorker {
  /**
   * @param {import('../config/account-config.js').AccountProfile} accountConfig
   * @param {Object} [dependencies={}]
   * @param {ZaloAdapter} [dependencies.adapter]
   * @param {MessageStorage} [dependencies.messageStorage]
   * @param {FileSystemMediaStorage} [dependencies.mediaStorage]
   * @param {SyncCheckpointStore} [dependencies.checkpointStore]
   * @param {PersistentMediaQueue} [dependencies.mediaQueue]
   */
  constructor(accountConfig, dependencies = {}) {
    if (!accountConfig || !accountConfig.accountId) {
      throw new Error('ZaloWorker yêu cầu cấu hình tài khoản accountConfig');
    }

    this.accountConfig = accountConfig;
    this.adapter = dependencies.adapter || new ZaloAdapter({ accountId: accountConfig.accountId });
    this.messageStorage = dependencies.messageStorage || new MessageStorage({ baseDir: accountConfig.storage.storageDir });
    this.mediaStorage = dependencies.mediaStorage || new FileSystemMediaStorage({
      baseDir: accountConfig.storage.mediaDir,
      maxSizeBytes: accountConfig.sync.maxMediaSizeBytes
    });
    this.checkpointStore = dependencies.checkpointStore || new SyncCheckpointStore({
      baseDir: `${accountConfig.storage.storageDir}/checkpoints`
    });

    // Hàng đợi tải media nền có độ bền vững (Persistent Media Queue)
    this.mediaQueue = dependencies.mediaQueue || new PersistentMediaQueue({
      queueFilePath: `${accountConfig.storage.storageDir}/queue/media-jobs.json`,
      mediaStorage: this.mediaStorage,
      concurrency: accountConfig.sync.mediaConcurrency || 3,
      maxRetries: accountConfig.sync.maxRetries || 3,
      onJobCompleted: async (job, processedAtt) => {
        this.messageStorage.updateAttachment(
          job.accountId,
          job.groupId,
          job.messageId,
          job.attachmentId,
          processedAtt
        );
      },
      onJobFailed: async (job, err) => {
        this.messageStorage.updateAttachment(
          job.accountId,
          job.groupId,
          job.messageId,
          job.attachmentId,
          {
            downloadStatus: 'failed',
            downloadError: err.message
          }
        );
      }
    });

    this.api = null;
    this.accountInfo = null;
    this.egressResult = null;
    this.listener = null;
    this.isListening = false;
    this.listenerHandlers = null;
  }

  /**
   * Kiểm tra khóa tiến trình (Process Lock) để ngăn chạy đồng thời 2 tiến trình trên cùng 1 tài khoản Zalo
   * @param {string} [mode='worker']
   * @returns {boolean}
   */
  checkProcessLock(mode = 'worker') {
    const lockDir = path.join(this.accountConfig.storage.storageDir, '.locks');
    const lockFile = path.join(lockDir, `${this.accountConfig.accountId}.lock`);

    if (fs.existsSync(lockFile)) {
      try {
        const content = fs.readFileSync(lockFile, 'utf8');
        const lockInfo = JSON.parse(content);
        if (lockInfo && lockInfo.pid) {
          let isAlive = false;
          try {
            process.kill(lockInfo.pid, 0);
            isAlive = true;
          } catch (e) {
            isAlive = e.code === 'EPERM';
          }

          if (isAlive && lockInfo.pid !== process.pid) {
            console.warn('================================================================');
            console.warn(`[CẢNH BÁO QUAN TRỌNG] PHÁT HIỆN TIẾN TRÌNH KHÁC ĐANG CHẠY!`);
            console.warn(`- Đang có tiến trình khác (PID: ${lockInfo.pid}, chế độ: ${lockInfo.mode || 'N/A'}) đang chạy cho tài khoản "${this.accountConfig.accountId}".`);
            console.warn(`- Zalo chỉ cho phép 1 phiên Web hoạt động đồng thời.`);
            console.warn(`- Chạy cả "listen" và "worker" cùng lúc sẽ làm Zalo ngắt kết nối WebSocket và gây hiện tượng phát lại/trùng lặp tin nhắn!`);
            console.warn('================================================================\n');
            return false;
          }
        }
      } catch {}
    }

    try {
      if (!fs.existsSync(lockDir)) {
        fs.mkdirSync(lockDir, { recursive: true });
      }
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, mode, startedAt: new Date().toISOString() }));
    } catch {}

    return true;
  }

  /**
   * Giải phóng khóa tiến trình khi thoát
   */
  releaseProcessLock() {
    const lockFile = path.join(this.accountConfig.storage.storageDir, '.locks', `${this.accountConfig.accountId}.lock`);
    try {
      if (fs.existsSync(lockFile)) {
        const content = fs.readFileSync(lockFile, 'utf8');
        const lockInfo = JSON.parse(content);
        if (lockInfo && lockInfo.pid === process.pid) {
          fs.unlinkSync(lockFile);
        }
      }
    } catch {}
  }

  /**
   * Khởi tạo worker: xác minh IP egress và đăng nhập tài khoản Zalo
   * @param {Object} [options={}]
   * @param {boolean} [options.forceQR=false]
   * @param {string} [options.mode='worker']
   * @returns {Promise<{ accountInfo: Object, egressResult: Object }>}
   */
  async start(options = {}) {
    this.checkProcessLock(options.mode || 'worker');

    console.log(`[Worker] Khởi động worker cho tài khoản: ${this.accountConfig.accountId}...`);

    // 1. Kiểm tra IP egress nếu được cấu hình
    if (this.accountConfig.egress.verifyEgressIp) {
      console.log('[Worker] Đang xác minh địa chỉ IP egress...');
      this.egressResult = await verifyEgressIp(this.accountConfig.egress);
      console.log(`[Worker] Kết quả xác minh IP egress: ${this.egressResult.details}`);

      if (this.accountConfig.egress.fixedIp && !this.egressResult.matchesExpected) {
        throw new Error(`Xác minh IP egress thất bại: ${this.egressResult.details}`);
      }
    }

    // 2. Khởi tạo client zca-js
    const { api, accountInfo } = await createZaloClient(this.accountConfig, options);
    this.api = api;
    this.accountInfo = accountInfo;

    return {
      accountInfo: this.accountInfo,
      egressResult: this.egressResult
    };
  }

  /**
   * Lấy danh sách các nhóm chat mà tài khoản tham gia
   * @returns {Promise<Array<{ id: string, name: string, memberCount: number, isAllowed: boolean }>>}
   */
  async getGroups() {
    if (!this.api || typeof this.api.getAllGroups !== 'function') {
      throw new Error('Worker chưa được khởi động hoặc API không khả dụng');
    }

    console.log('[Worker] Đang lấy danh sách nhóm chat từ Zalo...');
    const rawGroupsResponse = await this.api.getAllGroups();
    const gridVerMap = rawGroupsResponse?.gridVerMap || {};
    const groupIds = Object.keys(gridVerMap);

    if (groupIds.length === 0) {
      return [];
    }

    let infoResponse = null;
    try {
      infoResponse = await this.api.getGroupInfo(groupIds);
    } catch (err) {
      console.warn(`[Worker] Không thể lấy thông tin chi tiết nhóm: ${err.message}`);
    }

    const gridInfoMap = infoResponse?.gridInfoMap || {};
    const allowedSet = new Set(this.accountConfig.allowedGroupIds);

    const groups = groupIds.map((groupId) => {
      const detail = gridInfoMap[groupId];
      const name = detail?.name || `Nhóm-${groupId}`;
      const memberCount =
        detail?.totalMember ||
        (Array.isArray(detail?.memberIds) && detail.memberIds.length) ||
        0;

      return {
        id: groupId,
        name,
        memberCount,
        isAllowed: allowedSet.size === 0 ? true : allowedSet.has(groupId)
      };
    });

    return groups;
  }

  /**
   * Kiểm tra một nhóm có nằm trong danh sách được phép ingest hay không
   * @param {string} groupId
   * @returns {boolean}
   */
  isGroupAllowed(groupId) {
    if (!groupId) return false;
    const allowed = this.accountConfig.allowedGroupIds;
    if (!allowed || allowed.length === 0) {
      // Nếu không cấu hình nhóm nào, mặc định từ chối để đảm bảo nguyên tắc bảo mật tối thiểu
      return false;
    }
    return allowed.includes(String(groupId));
  }

  /**
   * Helper dừng có rate-limit delay
   * @param {number} ms
   */
  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Thực hiện đồng bộ tin nhắn cho một nhóm cụ thể
   * @param {string} groupId
   * @param {Object} [options={}]
   * @param {number} [options.count]
   * @returns {Promise<{ status: string, groupId: string, count: number, added: number, reason?: string }>}
   */
  async syncGroup(groupId, options = {}) {
    const stringGroupId = String(groupId);

    // 1. Kiểm tra quyền truy cập nhóm (Scope Access Control)
    if (!this.isGroupAllowed(stringGroupId)) {
      console.warn(`[Worker] BỎ QUA nhóm ${stringGroupId}: Nhóm không nằm trong danh sách được phép truy cập (allowedGroupIds).`);
      return {
        status: 'skipped',
        groupId: stringGroupId,
        count: 0,
        added: 0,
        reason: 'unauthorized_group'
      };
    }

    const targetCount = options.count || this.accountConfig.sync.messageCount || 20;
    const maxRetries = this.accountConfig.sync.maxRetries || 3;
    let attempt = 0;
    let lastError = null;
    let historyResult = null;

    console.log(`[Worker] Bắt đầu đồng bộ nhóm ${stringGroupId} (tối đa ${targetCount} tin)...`);

    // 2. Retry có giới hạn khi gọi API Zalo
    while (attempt < maxRetries) {
      attempt++;
      try {
        // Thử endpoint mặc định
        try {
          const raw = await this.api.getGroupChatHistory(stringGroupId, targetCount);
          historyResult = {
            raw,
            messages: raw?.groupMsgs || [],
            endpoint: 'v1-default'
          };
        } catch (v1Err) {
          const is404 = v1Err.status === 404 || v1Err.code === 404 || String(v1Err.message).includes('404');
          if (is404) {
            // Tự động fallback sang endpoint V2 Cloud Message
            const v2Res = await fetchGroupHistoryV2(this.api, stringGroupId, targetCount);
            historyResult = {
              raw: v2Res.raw,
              messages: v2Res.messages,
              endpoint: 'v2-cloud'
            };
          } else {
            throw v1Err;
          }
        }
        break; // Thành công
      } catch (err) {
        lastError = err;
        console.warn(`[Worker] Lỗi gọi API lịch sử nhóm (lần thử ${attempt}/${maxRetries}): ${err.message}`);
        if (attempt < maxRetries) {
          await this.sleep(1000 * attempt);
        }
      }
    }

    if (!historyResult) {
      throw new Error(`Đồng bộ nhóm ${stringGroupId} thất bại sau ${maxRetries} lần thử: ${lastError?.message}`);
    }

    // 3. Lưu trữ response thô phục vụ debugging (không chứa thông tin nhạy cảm của account)
    this.messageStorage.saveRawResponse(
      this.accountConfig.accountId,
      stringGroupId,
      historyResult.raw,
      historyResult.endpoint
    );

    // 4. Chuyển dữ liệu qua ZaloAdapter để chuẩn hóa
    const rawMsgs = historyResult.messages || [];
    const normalizedMsgs = this.adapter.normalizeMessages(rawMsgs, { groupId: stringGroupId });

    // 5. Ghi bền vững dữ liệu tin nhắn chuẩn hóa (Atomic Write & Deduplication) TRƯỚC
    // Đảm bảo tin nhắn được ghi nhận an toàn ngay cả khi tải media thất bại
    const saveResult = this.messageStorage.saveNormalizedMessages(
      this.accountConfig.accountId,
      stringGroupId,
      normalizedMsgs
    );

    // 6. Đưa attachments vào PersistentMediaQueue và xử lý
    if (this.accountConfig.sync.autoDownloadMedia) {
      for (const msg of normalizedMsgs) {
        if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
          for (const att of msg.attachments) {
            this.mediaQueue.enqueue({
              accountId: this.accountConfig.accountId,
              groupId: stringGroupId,
              messageId: msg.messageId,
              attachment: att
            });
          }
        }
      }
      await this.mediaQueue.drain(15000);
    }

    // 7. Cập nhật checkpoint đồng bộ
    const lastMsg = normalizedMsgs[normalizedMsgs.length - 1];
    this.checkpointStore.saveCheckpoint(this.accountConfig.accountId, stringGroupId, {
      lastMsgId: lastMsg?.messageId || null,
      lastSentAt: lastMsg?.sentAt || null,
      lastSyncAt: new Date().toISOString(),
      totalMessagesInStore: saveResult.total,
      syncedInThisBatch: normalizedMsgs.length,
      usedEndpoint: historyResult.endpoint
    });

    console.log(`[Worker] Hoàn tất đồng bộ nhóm ${stringGroupId}: Đã lấy ${normalizedMsgs.length} tin (thêm mới ${saveResult.added} tin, tổng lưu trữ: ${saveResult.total}).`);

    // 8. Tuân thủ rate limit delay
    if (this.accountConfig.sync.rateLimitDelayMs > 0) {
      await this.sleep(this.accountConfig.sync.rateLimitDelayMs);
    }

    return {
      status: 'success',
      groupId: stringGroupId,
      count: normalizedMsgs.length,
      added: saveResult.added,
      total: saveResult.total
    };
  }

  /**
   * Đồng bộ toàn bộ các nhóm được phép truy cập (allowedGroupIds)
   * @returns {Promise<Array<Object>>}
   */
  async syncAllAllowedGroups() {
    const allowed = this.accountConfig.allowedGroupIds;
    if (!allowed || allowed.length === 0) {
      console.warn('[Worker] Không có nhóm nào trong danh sách allowedGroupIds. Hãy cấu hình ALLOWED_GROUP_IDS.');
      return [];
    }

    console.log(`[Worker] Bắt đầu đồng bộ ${allowed.length} nhóm được phép...`);
    const results = [];

    for (const groupId of allowed) {
      try {
        const res = await this.syncGroup(groupId);
        results.push(res);
      } catch (err) {
        console.error(`[Worker] Lỗi khi đồng bộ nhóm ${groupId}: ${err.message}`);
        results.push({
          status: 'error',
          groupId,
          error: err.message
        });
      }
    }

    console.log(`[Worker] Hoàn tất chu kỳ đồng bộ toàn bộ nhóm được phép.`);
    return results;
  }

  /**
   * Bắt đầu lắng nghe tin nhắn thời gian thực qua WebSocket (Real-time Listener Daemon)
   * Giúp tự động nhận tin nhắn mới ngay lập tức 24/7 mà không cần chạy lệnh thủ công
   *
   * @param {Function} [onMessageCallback]
   * @returns {Promise<import('zca-js').Listener>}
   */
  async startRealtimeListener(onMessageCallback) {
    if (!this.api || !this.api.listener) {
      throw new Error('Worker chưa được khởi động hoặc API listener không khả dụng');
    }

    // Bảo vệ Lifecycle: Nếu đã đang lắng nghe, tránh đăng ký lặp lại nhiều lần
    if (this.isListening) {
      console.warn('[Realtime] Listener đang hoạt động. Bỏ qua yêu cầu đăng ký trùng lặp.');
      return this.listener;
    }

    // Dọn dẹp các handler cũ nếu có
    this.stopRealtimeListener();

    const listener = this.api.listener;
    this.listener = listener;

    console.log('[Realtime] Đang kết nối WebSocket lắng nghe tin nhắn Zalo thời gian thực...');

    const onConnectedHandler = () => {
      console.log('>>> [Realtime] KẾT NỐI THÀNH CÔNG! Đang lắng nghe tin nhắn mới 24/7...');
      console.log(`>>> [Realtime] Các nhóm được giám sát: ${this.accountConfig.allowedGroupIds.join(', ') || 'Tất cả'}`);
    };

    const onClosedHandler = (code, reason) => {
      console.warn(`[Realtime] Kết nối WebSocket bị đóng (${code}: ${reason}). Đang tự động kết nối lại...`);
    };

    const onErrorHandler = (err) => {
      console.error('[Realtime] Lỗi kết nối WebSocket:', err?.message || err);
    };

    const onMessageHandler = async (message) => {
      try {
        const rawData = message.data || message;
        const groupId = String(message.threadId || rawData.idTo || '');

        if (!groupId) return;

        // Kiểm soát quyền truy cập nhóm (Scope Access Control)
        if (!this.isGroupAllowed(groupId)) {
          return; // Bỏ qua nếu tin nhắn thuộc nhóm không được cấu hình
        }

        // Chuẩn hóa tin nhắn
        const normalized = this.adapter.normalizeMessage(message, { groupId });
        if (!normalized) return;

        // BƯỚC QUAN TRỌNG: Lưu bền vững tin nhắn vào messageStorage NGAY LẬP TỨC (Atomic write & Deduplication)
        // Tuyệt đối không chờ tải media mới lưu tin nhắn (chống mất tin nhắn text khi tải file lỗi)
        const saveResult = this.messageStorage.saveNormalizedMessages(
          this.accountConfig.accountId,
          groupId,
          [normalized]
        );

        // Đẩy attachment vào hàng đợi tải bền vững bất đồng bộ (Non-blocking)
        if (this.accountConfig.sync.autoDownloadMedia && Array.isArray(normalized.attachments) && normalized.attachments.length > 0) {
          for (const att of normalized.attachments) {
            this.mediaQueue.enqueue({
              accountId: this.accountConfig.accountId,
              groupId,
              messageId: normalized.messageId,
              attachment: att
            });
          }
        }

        // Cập nhật checkpoint
        this.checkpointStore.saveCheckpoint(this.accountConfig.accountId, groupId, {
          lastMsgId: normalized.messageId,
          lastSentAt: normalized.sentAt,
          lastSyncAt: new Date().toISOString(),
          totalMessagesInStore: saveResult.total,
          syncedInThisBatch: 1,
          usedEndpoint: 'realtime-websocket'
        });

        const senderPreview = normalized.senderName ? `${normalized.senderName.slice(0, 2)}***` : 'Ẩn danh';
        if (saveResult.added > 0) {
          console.log(`[Realtime] ĐÃ LƯU: [${senderPreview}] ID: ${normalized.messageId} (Nhóm: ${groupId}, Tổng kho: ${saveResult.total})`);
        }

        if (typeof onMessageCallback === 'function') {
          try {
            onMessageCallback(normalized);
          } catch (cbErr) {
            console.error('[Realtime] Lỗi trong onMessageCallback:', cbErr.message);
          }
        }
      } catch (err) {
        // Cô lập lỗi theo từng message: Lỗi một tin nhắn không bao giờ làm dừng listener
        console.error('[Realtime] Lỗi xử lý tin nhắn mới (cô lập an toàn):', err.message);
      }
    };

    this.listenerHandlers = {
      connected: onConnectedHandler,
      closed: onClosedHandler,
      error: onErrorHandler,
      message: onMessageHandler
    };

    listener.on('connected', onConnectedHandler);
    listener.on('closed', onClosedHandler);
    listener.on('error', onErrorHandler);
    listener.on('message', onMessageHandler);

    this.isListening = true;

    if (typeof listener.start === 'function') {
      listener.start({ retryOnClose: true });
    }

    return listener;
  }

  /**
   * Dừng an toàn listener và gỡ bỏ các event handlers
   */
  stopRealtimeListener() {
    if (this.listener && this.listenerHandlers) {
      for (const [event, handler] of Object.entries(this.listenerHandlers)) {
        if (typeof this.listener.off === 'function') {
          this.listener.off(event, handler);
        } else if (typeof this.listener.removeListener === 'function') {
          this.listener.removeListener(event, handler);
        }
      }
      this.listenerHandlers = null;
    }

    if (this.listener && typeof this.listener.stop === 'function') {
      try {
        this.listener.stop();
      } catch {}
    }

    this.isListening = false;
  }

  /**
   * Lấy số liệu thống kê hàng đợi media
   * @returns {Object|null}
   */
  getQueueStats() {
    return this.mediaQueue ? this.mediaQueue.getStats() : null;
  }

  /**
   * Dừng toàn bộ worker an toàn (Graceful Shutdown)
   * @param {number} [timeoutMs=5000]
   */
  async shutdown(timeoutMs = 5000) {
    console.log(`[Worker] Bắt đầu Graceful Shutdown cho tài khoản ${this.accountConfig.accountId}...`);
    this.stopRealtimeListener();

    if (this.mediaQueue) {
      await this.mediaQueue.drain(timeoutMs);
      this.mediaQueue.stop();
    }

    this.releaseProcessLock();
    console.log(`[Worker] Graceful Shutdown hoàn tất thành công.`);
  }
}
