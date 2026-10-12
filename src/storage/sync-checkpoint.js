import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Quản lý Checkpoint / Cursor đồng bộ theo từng cặp Account và Group
 */
export class SyncCheckpointStore {
  /**
   * @param {Object} options
   * @param {string} options.baseDir - Thư mục lưu trữ checkpoint files
   */
  constructor(options = {}) {
    this.baseDir = path.resolve(
      process.cwd(),
      options.baseDir || './storage/checkpoints'
    );

    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Tạo đường dẫn file checkpoint
   * @param {string} accountId
   * @param {string} groupId
   * @returns {string}
   */
  getCheckpointPath(accountId, groupId) {
    const safeAccount = String(accountId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeGroup = String(groupId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.baseDir, `${safeAccount}_${safeGroup}.json`);
  }

  /**
   * Đọc checkpoint hiện tại
   * @param {string} accountId
   * @param {string} groupId
   * @returns {Object|null}
   */
  getCheckpoint(accountId, groupId) {
    const filePath = this.getCheckpointPath(accountId, groupId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Cập nhật và ghi bền vững checkpoint (Atomic Write)
   * @param {string} accountId
   * @param {string} groupId
   * @param {Object} data
   * @returns {Object}
   */
  saveCheckpoint(accountId, groupId, data) {
    const current = this.getCheckpoint(accountId, groupId) || {};
    const updated = {
      ...current,
      ...data,
      accountId,
      groupId,
      updatedAt: new Date().toISOString()
    };

    const filePath = this.getCheckpointPath(accountId, groupId);
    const tmpPath = `${filePath}.${Date.now()}_${crypto.randomBytes(4).toString('hex')}.tmp`;

    fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);

    return updated;
  }
}
