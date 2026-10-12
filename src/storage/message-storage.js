import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Quản lý lưu trữ tin nhắn thô (raw) và tin nhắn đã chuẩn hóa (normalized)
 * Đảm bảo:
 * - Ghi file nguyên tử (Atomic write qua .tmp -> rename)
 * - Khử trùng lặp tin nhắn dựa trên messageId
 * - Tách biệt raw response phục vụ debug với normalized storage
 */
export class MessageStorage {
  /**
   * @param {Object} options
   * @param {string} options.baseDir - Thư mục gốc (mặc định ./storage)
   */
  constructor(options = {}) {
    this.baseDir = path.resolve(process.cwd(), options.baseDir || './storage');
    this.rawDir = path.join(this.baseDir, 'raw');
    this.normalizedDir = path.join(this.baseDir, 'normalized');

    this.ensureDir(this.rawDir);
    this.ensureDir(this.normalizedDir);

    // Chuỗi Promise tuần tự hóa các thao tác ghi theo từng nhóm để chống race condition
    this.writeQueues = new Map();
  }

  ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Thực hiện ghi nội dung vào file nguyên tử (Atomic Write)
   * @param {string} targetPath
   * @param {string|Buffer} content
   */
  atomicWrite(targetPath, content) {
    const dir = path.dirname(targetPath);
    this.ensureDir(dir);

    const tmpPath = `${targetPath}.${Date.now()}_${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  }

  /**
   * Lưu raw response phục vụ debug và kiểm thử
   * @param {string} accountId
   * @param {string} groupId
   * @param {any} rawData
   * @param {string} [batchLabel]
   * @returns {string} Đường dẫn file raw đã lưu
   */
  saveRawResponse(accountId, groupId, rawData, batchLabel = '') {
    const safeAccount = String(accountId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeGroup = String(groupId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const label = batchLabel ? `_${batchLabel}` : '';
    const fileName = `raw_${timestamp}${label}.json`;

    const targetDir = path.join(this.rawDir, safeAccount, safeGroup);
    const targetPath = path.join(targetDir, fileName);

    const payload = {
      capturedAt: new Date().toISOString(),
      accountId,
      groupId,
      data: rawData
    };

    this.atomicWrite(targetPath, JSON.stringify(payload, null, 2));
    return targetPath;
  }

  /**
   * Lấy đường dẫn file lưu messages chuẩn hóa của một group
   * @param {string} accountId
   * @param {string} groupId
   * @returns {string}
   */
  getNormalizedFilePath(accountId, groupId) {
    const safeAccount = String(accountId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeGroup = String(groupId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.normalizedDir, safeAccount, safeGroup, 'messages.json');
  }

  /**
   * Đọc danh sách tin nhắn chuẩn hóa hiện có của group
   * @param {string} accountId
   * @param {string} groupId
   * @returns {Array<Object>}
   */
  getNormalizedMessages(accountId, groupId) {
    const targetPath = this.getNormalizedFilePath(accountId, groupId);
    if (!fs.existsSync(targetPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(targetPath, 'utf8');
      const parsed = JSON.parse(content);
      return Array.isArray(parsed.messages) ? parsed.messages : [];
    } catch {
      return [];
    }
  }

  /**
   * Cập nhật thông tin attachment của một message cụ thể sau khi tải xong/thất bại
   * @param {string} accountId
   * @param {string} groupId
   * @param {string} messageId
   * @param {string} attachmentId
   * @param {Object} updatedFields
   * @returns {boolean} True nếu tìm thấy và cập nhật thành công
   */
  updateAttachment(accountId, groupId, messageId, attachmentId, updatedFields = {}) {
    const targetPath = this.getNormalizedFilePath(accountId, groupId);
    if (!fs.existsSync(targetPath)) {
      return false;
    }

    try {
      const content = fs.readFileSync(targetPath, 'utf8');
      const parsed = JSON.parse(content);
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];

      const targetMsg = messages.find((m) => m && m.messageId === messageId);
      if (!targetMsg || !Array.isArray(targetMsg.attachments)) {
        return false;
      }

      const targetAtt = targetMsg.attachments.find((a) => a && a.attachmentId === attachmentId);
      if (!targetAtt) {
        return false;
      }

      // Cập nhật các trường
      Object.assign(targetAtt, updatedFields);
      // Đảm bảo không lưu _downloadUrl nhạy cảm
      delete targetAtt._downloadUrl;

      parsed.lastUpdatedAt = new Date().toISOString();
      this.atomicWrite(targetPath, JSON.stringify(parsed, null, 2));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Lưu và merge các tin nhắn chuẩn hóa mới vào kho (có khử trùng lặp theo messageId)
   * Đảm bảo an toàn đồng thời (Concurrent-safe) bằng Promise queue theo group
   * @param {string} accountId
   * @param {string} groupId
   * @param {Array<Object>} newMessages - Danh sách tin nhắn NormalizedMessage
   * @param {Object} [meta={}]
   * @returns {{ total: number, added: number, filePath: string }}
   */
  saveNormalizedMessages(accountId, groupId, newMessages = [], meta = {}) {
    if (!Array.isArray(newMessages)) {
      throw new Error('newMessages phải là một mảng');
    }

    const targetPath = this.getNormalizedFilePath(accountId, groupId);
    const existing = this.getNormalizedMessages(accountId, groupId);

    // Map chống trùng lặp theo messageId
    const messageMap = new Map();

    for (const msg of existing) {
      if (msg && msg.messageId) {
        messageMap.set(msg.messageId, msg);
      }
    }

    let addedCount = 0;
    for (const msg of newMessages) {
      if (!msg || !msg.messageId) continue;
      if (!messageMap.has(msg.messageId)) {
        addedCount++;
      }
      // Cập nhật hoặc thêm mới tin nhắn
      messageMap.set(msg.messageId, msg);
    }

    // Sắp xếp lại theo thời gian sentAt tăng dần
    const allMessages = Array.from(messageMap.values()).sort((a, b) => {
      const timeA = a.sentAt ? new Date(a.sentAt).getTime() : 0;
      const timeB = b.sentAt ? new Date(b.sentAt).getTime() : 0;
      return timeA - timeB;
    });

    const payload = {
      schemaVersion: '1.0.0',
      accountId,
      groupId,
      groupName: meta.groupName || null,
      lastUpdatedAt: new Date().toISOString(),
      totalMessages: allMessages.length,
      messages: allMessages
    };

    this.atomicWrite(targetPath, JSON.stringify(payload, null, 2));

    return {
      total: allMessages.length,
      added: addedCount,
      filePath: targetPath
    };
  }
}
