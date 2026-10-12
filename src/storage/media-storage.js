import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DownloadStatus } from '../adapter/message-types.js';

/**
 * Interface trừu tượng cho Media Storage
 * Cho phép chuyển đổi giữa Local Filesystem và S3/GCS Object Storage
 */
export class MediaStorage {
  /**
   * Tải và lưu trữ một attachment
   * @param {Object} attachment
   * @param {Object} context
   * @returns {Promise<Object>} Attachment đã cập nhật trạng thái và storageKey
   */
  async downloadAndStore(attachment, context) {
    throw new Error('Method downloadAndStore must be implemented');
  }

  /**
   * Kiểm tra sự tồn tại của media theo storageKey
   * @param {string} storageKey
   * @returns {Promise<boolean>}
   */
  async exists(storageKey) {
    throw new Error('Method exists must be implemented');
  }
}

/**
 * Triển khai MediaStorage trên Local Filesystem với hỗ trợ:
 * - Khử trùng lặp qua SHA-256 checksum
 * - Ghi file nguyên tử (.tmp -> rename)
 * - Giới hạn kích thước và timeout tải
 * - Làm sạch URL nhạy cảm trước khi trả kết quả
 */
export class FileSystemMediaStorage extends MediaStorage {
  /**
   * @param {Object} options
   * @param {string} options.baseDir - Thư mục gốc lưu trữ media
   * @param {number} [options.maxSizeBytes=26214400] - Dung lượng tối đa (25MB)
   * @param {number} [options.timeoutMs=15000] - Timeout tải (15s)
   */
  constructor(options = {}) {
    super();
    this.baseDir = path.resolve(process.cwd(), options.baseDir || './storage/media');
    this.maxSizeBytes = options.maxSizeBytes || 25 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs || 15000;

    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Làm sạch tên file để tránh path traversal và ký tự không hợp lệ
   * @param {string|null} fileName
   * @returns {string}
   */
  sanitizeFileName(fileName) {
    if (!fileName) return 'file.bin';
    const base = path.basename(fileName);
    return base.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  /**
   * Tạo storage key an toàn và ổn định
   * @param {Object} context
   * @param {string} attachmentId
   * @param {string} checksum
   * @param {string} safeFileName
   * @returns {string}
   */
  generateStorageKey(context, attachmentId, checksum, safeFileName) {
    const accountId = context.accountId || 'default';
    const groupId = context.groupId || 'direct';
    const ext = path.extname(safeFileName) || '';
    const shortHash = checksum.slice(0, 12);
    return `${accountId}/${groupId}/${attachmentId}_${shortHash}${ext}`;
  }

  /**
   * Kiểm tra file đã tồn tại hay chưa
   * @param {string} storageKey
   * @returns {Promise<boolean>}
   */
  async exists(storageKey) {
    if (!storageKey) return false;
    const fullPath = path.join(this.baseDir, storageKey);
    return fs.existsSync(fullPath);
  }

  /**
   * Tải và lưu attachment vào filesystem
   * @param {Object} attachment
   * @param {Object} context
   * @param {string} [context.accountId]
   * @param {string} [context.groupId]
   * @param {string} [context.messageId]
   * @returns {Promise<Object>}
   */
  async downloadAndStore(attachment, context = {}) {
    const updated = { ...attachment };
    const downloadUrl = updated._downloadUrl;

    // Xóa URL thô để không lộ thông tin nhạy cảm/ký danh trong metadata
    delete updated._downloadUrl;

    // Nếu attachment không có URL hoặc không hỗ trợ tải
    if (!downloadUrl || updated.downloadStatus === DownloadStatus.UNSUPPORTED) {
      updated.downloadStatus = DownloadStatus.UNSUPPORTED;
      return updated;
    }

    const safeFileName = this.sanitizeFileName(updated.fileName);

    // Kiểm tra nếu tệp đã tồn tại trong kho lưu trữ trước đó (tránh tải lại trùng lặp)
    if (updated.storageKey && fs.existsSync(path.join(this.baseDir, updated.storageKey))) {
      updated.downloadStatus = DownloadStatus.DOWNLOADED;
      return updated;
    }

    const accountId = context.accountId || 'default';
    const groupId = context.groupId || 'direct';
    const groupDir = path.join(this.baseDir, accountId, groupId);
    if (fs.existsSync(groupDir)) {
      try {
        const existingFiles = fs.readdirSync(groupDir);
        const matchingFile = existingFiles.find((f) => f.startsWith(`${updated.attachmentId}_`));
        if (matchingFile) {
          const fullPath = path.join(groupDir, matchingFile);
          const stat = fs.statSync(fullPath);
          if (stat.size > 0) {
            updated.storageKey = `${accountId}/${groupId}/${matchingFile}`;
            updated.sizeBytes = stat.size;
            updated.downloadStatus = DownloadStatus.DOWNLOADED;
            return updated;
          }
        }
      } catch {
        // Tiếp tục tải bình thường nếu kiểm tra cache gặp lỗi
      }
    }

    try {
      // 1. Tải dữ liệu với timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await fetch(downloadUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ZaloIngestionWorker/1.0'
        }
      });
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
      }

      // Kiểm tra Content-Length nếu server cung cấp
      const contentLength = response.headers.get('content-length');
      if (contentLength && Number(contentLength) > this.maxSizeBytes) {
        throw new Error(`File size vượt quá giới hạn cho phép (${contentLength} > ${this.maxSizeBytes} bytes)`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      if (buffer.length > this.maxSizeBytes) {
        throw new Error(`Kích thước dữ liệu thực tế vượt quá giới hạn (${buffer.length} > ${this.maxSizeBytes} bytes)`);
      }

      // 2. Tính checksum SHA-256
      const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

      // 3. Tạo storageKey ổn định
      const storageKey = this.generateStorageKey(context, updated.attachmentId, checksum, safeFileName);
      const targetPath = path.join(this.baseDir, storageKey);
      const targetDir = path.dirname(targetPath);

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // 4. Ghi file nguyên tử (Atomic write: ghi file .tmp rồi rename)
      const tmpPath = `${targetPath}.${Date.now()}_${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmpPath, buffer);
      fs.renameSync(tmpPath, targetPath);

      // 5. Cập nhật metadata attachment
      updated.storageKey = storageKey;
      updated.checksum = checksum;
      updated.sizeBytes = buffer.length;
      updated.downloadStatus = DownloadStatus.DOWNLOADED;

      return updated;
    } catch (error) {
      // Khi tải thất bại, ghi nhận trạng thái 'failed', không lưu file lỗi như thành công
      updated.downloadStatus = DownloadStatus.FAILED;
      updated.downloadError = error.message;
      return updated;
    }
  }

  /**
   * Lưu trữ trực tiếp buffer vào kho (phục vụ test hoặc nguồn binary trực tiếp)
   * @param {Buffer} buffer
   * @param {string} fileName
   * @param {Object} context
   * @returns {Promise<{ storageKey: string, checksum: string, sizeBytes: number }>}
   */
  async storeBuffer(buffer, fileName, context = {}) {
    if (!Buffer.isBuffer(buffer)) {
      throw new Error('Dữ liệu lưu trữ phải là một Buffer');
    }

    if (buffer.length > this.maxSizeBytes) {
      throw new Error(`Kích thước dữ liệu vượt quá giới hạn (${buffer.length} > ${this.maxSizeBytes} bytes)`);
    }

    const safeFileName = this.sanitizeFileName(fileName);
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const attachmentId = context.attachmentId || `buf_${Date.now()}`;
    const storageKey = this.generateStorageKey(context, attachmentId, checksum, safeFileName);

    const targetPath = path.join(this.baseDir, storageKey);
    const targetDir = path.dirname(targetPath);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const tmpPath = `${targetPath}.${Date.now()}_${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, targetPath);

    return {
      storageKey,
      checksum,
      sizeBytes: buffer.length
    };
  }
}
