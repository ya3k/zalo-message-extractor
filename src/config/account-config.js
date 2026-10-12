import path from 'node:path';
import './env.js';

/**
 * @typedef {Object} EgressConfig
 * @property {string|null} proxyUrl
 * @property {string|null} fixedIp
 * @property {boolean} verifyEgressIp
 */

/**
 * @typedef {Object} StorageConfig
 * @property {string} storageDir
 * @property {string} mediaDir
 * @property {string} outputDir
 */

/**
 * @typedef {Object} SyncConfig
 * @property {number} messageCount
 * @property {number} rateLimitDelayMs
 * @property {number} maxRetries
 * @property {boolean} autoDownloadMedia
 * @property {number} maxMediaSizeBytes
 */

/**
 * @typedef {Object} AccountProfile
 * @property {string} accountId - Định danh nội bộ của account (không nhạy cảm)
 * @property {string} sessionPath - Đường dẫn file lưu session
 * @property {string} qrPath - Đường dẫn file lưu ảnh QR
 * @property {string[]} allowedGroupIds - Danh sách group ID được phép đọc
 * @property {EgressConfig} egress - Cấu hình IP egress / Proxy
 * @property {StorageConfig} storage - Cấu hình thư mục lưu trữ
 * @property {SyncConfig} sync - Cấu hình chu kỳ đồng bộ và rate limit
 */

/**
 * Khởi tạo cấu hình tài khoản từ biến môi trường hoặc tham số truyền vào
 * @param {Partial<AccountProfile>} [overrides={}]
 * @returns {AccountProfile}
 */
export function createAccountConfig(overrides = {}) {
  const allowedGroupsEnv = process.env.ALLOWED_GROUP_IDS || process.env.GROUP_ID || '';
  const parsedAllowedGroups = allowedGroupsEnv
    ? allowedGroupsEnv
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    : [];

  const rawStorageDir = overrides.storage?.storageDir || process.env.STORAGE_DIR || './storage';
  const rawMediaDir = overrides.storage?.mediaDir || process.env.MEDIA_DIR || path.join(rawStorageDir, 'media');
  const rawOutputDir = overrides.storage?.outputDir || process.env.OUTPUT_DIR || './output';

  const config = {
    accountId: overrides.accountId || process.env.ACCOUNT_ID || 'acc_manager_01',
    sessionPath: path.resolve(
      process.cwd(),
      overrides.sessionPath || process.env.SESSION_PATH || './session.json'
    ),
    qrPath: path.resolve(
      process.cwd(),
      overrides.qrPath || process.env.QR_PATH || './qr.png'
    ),
    allowedGroupIds: overrides.allowedGroupIds || parsedAllowedGroups,
    egress: {
      proxyUrl: overrides.egress?.proxyUrl || process.env.EGRESS_PROXY_URL || null,
      fixedIp: overrides.egress?.fixedIp || process.env.EXPECTED_EGRESS_IP || null,
      verifyEgressIp:
        overrides.egress?.verifyEgressIp ??
        (process.env.VERIFY_EGRESS_IP === 'true' || process.env.VERIFY_EGRESS_IP === '1')
    },
    storage: {
      storageDir: path.resolve(process.cwd(), rawStorageDir),
      mediaDir: path.resolve(process.cwd(), rawMediaDir),
      outputDir: path.resolve(process.cwd(), rawOutputDir)
    },
    sync: {
      messageCount:
        overrides.sync?.messageCount ||
        parseInt(process.env.MESSAGE_COUNT || '20', 10),
      rateLimitDelayMs:
        overrides.sync?.rateLimitDelayMs ||
        parseInt(process.env.RATE_LIMIT_DELAY_MS || '1500', 10),
      maxRetries:
        overrides.sync?.maxRetries ||
        parseInt(process.env.MAX_RETRIES || '3', 10),
      autoDownloadMedia:
        overrides.sync?.autoDownloadMedia ??
        (process.env.AUTO_DOWNLOAD_MEDIA !== 'false'),
      mediaConcurrency:
        overrides.sync?.mediaConcurrency ||
        parseInt(process.env.MEDIA_CONCURRENCY || '3', 10),
      maxMediaSizeBytes:
        overrides.sync?.maxMediaSizeBytes ||
        parseInt(process.env.MAX_MEDIA_SIZE_BYTES || String(25 * 1024 * 1024), 10)
    }
  };

  return config;
}
