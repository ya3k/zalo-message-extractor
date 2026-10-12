import {
  SCHEMA_VERSION,
  MessageSource,
  AttachmentType,
  DownloadStatus,
  InternalMessageType
} from './message-types.js';

/**
 * Kiểm tra và chuẩn hóa timestamp từ Zalo thành ISO 8601 string
 * Không tự tạo timestamp nếu nguồn không cung cấp hoặc không hợp lệ.
 *
 * @param {string|number|null|undefined} rawTs
 * @returns {string|null} - Chuỗi ISO 8601 hoặc null
 */
export function parseSentAt(rawTs) {
  if (rawTs === null || rawTs === undefined || rawTs === '') {
    return null;
  }

  const num = typeof rawTs === 'number' ? rawTs : Number(rawTs);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }

  // Zalo thường dùng milliseconds (13 chữ số). Nếu là seconds (10 chữ số), nhân 1000.
  const ms = num < 100000000000 ? num * 1000 : num;

  try {
    const date = new Date(ms);
    if (isNaN(date.getTime())) {
      return null;
    }
    return date.toISOString();
  } catch {
    return null;
  }
}

/**
 * Suy đoán MIME type từ phần mở rộng file hoặc loại attachment
 * @param {string|null} fileName
 * @param {string} attachmentType
 * @returns {string|null}
 */
export function inferMimeType(fileName, attachmentType) {
  if (fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      case 'mp4':
        return 'video/mp4';
      case 'mp3':
        return 'audio/mpeg';
      case 'aac':
        return 'audio/aac';
      case 'pdf':
        return 'application/pdf';
      case 'docx':
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      case 'xlsx':
        return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      case 'zip':
        return 'application/zip';
    }
  }

  switch (attachmentType) {
    case AttachmentType.IMAGE:
      return 'image/jpeg';
    case AttachmentType.VIDEO:
      return 'video/mp4';
    case AttachmentType.AUDIO:
      return 'audio/mpeg';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Trích xuất các attachments từ dữ liệu thô của tin nhắn
 * @param {Object} rawData
 * @param {string} messageId
 * @returns {Array<Object>}
 */
export function extractAttachments(rawData, messageId) {
  const attachments = [];
  const msgType = rawData.msgType || '';
  let content = rawData.content;

  // Nếu content là JSON string, thử parse an toàn
  if (typeof content === 'string' && (content.startsWith('{') || content.startsWith('['))) {
    try {
      content = JSON.parse(content);
    } catch {
      // Giữ nguyên chuỗi nếu không parse được
    }
  }

  // 1. Tin nhắn ảnh (chat.photo)
  if (msgType === 'chat.photo' || msgType === 32) {
    const photoData = typeof content === 'object' && content !== null ? content : {};
    const downloadUrl =
      photoData.hdUrl ||
      photoData.normalUrl ||
      photoData.rawUrl ||
      photoData.oriUrl ||
      photoData.href ||
      photoData.thumb ||
      null;

    const attachmentId = String(photoData.photoId || photoData.id || `${messageId}_att_0`);
    const sizeBytes = photoData.hdSize ? Number(photoData.hdSize) : photoData.totalSize ? Number(photoData.totalSize) : null;
    const fileName = photoData.fileName || `photo_${attachmentId}.jpg`;

    attachments.push({
      attachmentId,
      type: AttachmentType.IMAGE,
      fileName,
      mimeType: inferMimeType(fileName, AttachmentType.IMAGE),
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
      storageKey: null,
      checksum: null,
      downloadStatus: downloadUrl ? DownloadStatus.PENDING : DownloadStatus.UNSUPPORTED,
      _downloadUrl: downloadUrl // Trường nội bộ phục vụ tải, sẽ được làm sạch trước khi lưu bền vững
    });
  }

  // 2. Tin nhắn chia sẻ file (share.file)
  else if (msgType === 'share.file' || msgType === 46) {
    const fileData = typeof content === 'object' && content !== null ? content : {};
    const downloadUrl = fileData.fileUrl || fileData.url || fileData.href || null;
    const attachmentId = String(fileData.fileId || fileData.id || `${messageId}_file_0`);
    const fileName = fileData.fileName || fileData.title || `file_${attachmentId}`;
    const sizeBytes = fileData.totalSize ? Number(fileData.totalSize) : fileData.size ? Number(fileData.size) : null;
    const checksum = fileData.checksum || null;

    attachments.push({
      attachmentId,
      type: AttachmentType.FILE,
      fileName,
      mimeType: inferMimeType(fileName, AttachmentType.FILE),
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
      storageKey: null,
      checksum,
      downloadStatus: downloadUrl ? DownloadStatus.PENDING : DownloadStatus.UNSUPPORTED,
      _downloadUrl: downloadUrl
    });
  }

  // 3. Tin nhắn video (chat.video.msg)
  else if (msgType === 'chat.video.msg' || msgType === 44) {
    const videoData = typeof content === 'object' && content !== null ? content : {};
    const downloadUrl = videoData.videoUrl || videoData.fileUrl || videoData.href || null;
    const attachmentId = String(videoData.videoId || videoData.fileId || `${messageId}_video_0`);
    const fileName = videoData.fileName || `video_${attachmentId}.mp4`;
    const sizeBytes = videoData.totalSize ? Number(videoData.totalSize) : null;

    attachments.push({
      attachmentId,
      type: AttachmentType.VIDEO,
      fileName,
      mimeType: inferMimeType(fileName, AttachmentType.VIDEO),
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
      storageKey: null,
      checksum: null,
      downloadStatus: downloadUrl ? DownloadStatus.PENDING : DownloadStatus.UNSUPPORTED,
      _downloadUrl: downloadUrl
    });
  }

  // 4. Tin nhắn voice (chat.voice)
  else if (msgType === 'chat.voice' || msgType === 31) {
    const voiceData = typeof content === 'object' && content !== null ? content : {};
    const downloadUrl = voiceData.voiceUrl || voiceData.fileUrl || null;
    const attachmentId = String(voiceData.voiceId || `${messageId}_voice_0`);
    const fileName = `voice_${attachmentId}.aac`;

    attachments.push({
      attachmentId,
      type: AttachmentType.AUDIO,
      fileName,
      mimeType: inferMimeType(fileName, AttachmentType.AUDIO),
      sizeBytes: null,
      storageKey: null,
      checksum: null,
      downloadStatus: downloadUrl ? DownloadStatus.PENDING : DownloadStatus.UNSUPPORTED,
      _downloadUrl: downloadUrl
    });
  }

  // 5. Tin nhắn sticker (chat.sticker)
  else if (msgType === 'chat.sticker' || msgType === 36) {
    const stickerData = typeof content === 'object' && content !== null ? content : {};
    const attachmentId = String(stickerData.id || stickerData.stickerId || `${messageId}_sticker_0`);

    attachments.push({
      attachmentId,
      type: AttachmentType.STICKER,
      fileName: null,
      mimeType: 'image/webp',
      sizeBytes: null,
      storageKey: null,
      checksum: null,
      downloadStatus: DownloadStatus.UNSUPPORTED,
      _downloadUrl: null
    });
  }

  // 6. Tin nhắn liên kết (chat.link)
  else if (msgType === 'chat.link' || msgType === 38) {
    const linkData = typeof content === 'object' && content !== null ? content : {};
    attachments.push({
      attachmentId: `${messageId}_link_0`,
      type: AttachmentType.LINK,
      fileName: null,
      mimeType: 'text/html',
      sizeBytes: null,
      storageKey: null,
      checksum: null,
      downloadStatus: DownloadStatus.UNSUPPORTED,
      _downloadUrl: linkData.href || null
    });
  }

  return attachments;
}

/**
 * Xác định messageType nội bộ từ msgType của Zalo
 * @param {string|number} rawMsgType
 * @returns {string}
 */
export function mapInternalMessageType(rawMsgType) {
  if (rawMsgType === 'webchat' || rawMsgType === 1) return InternalMessageType.TEXT;
  if (rawMsgType === 'chat.photo' || rawMsgType === 32) return InternalMessageType.IMAGE;
  if (rawMsgType === 'share.file' || rawMsgType === 46) return InternalMessageType.FILE;
  if (rawMsgType === 'chat.video.msg' || rawMsgType === 44) return InternalMessageType.VIDEO;
  if (rawMsgType === 'chat.voice' || rawMsgType === 31) return InternalMessageType.AUDIO;
  if (rawMsgType === 'chat.sticker' || rawMsgType === 36) return InternalMessageType.STICKER;
  if (rawMsgType === 'chat.link' || rawMsgType === 38) return InternalMessageType.LINK;
  return InternalMessageType.OTHER;
}

/**
 * Trích xuất nội dung văn bản hoặc biểu diễn chuỗi an toàn
 * @param {any} rawContent
 * @param {string} msgType
 * @returns {string|Object|null}
 */
export function extractContent(rawContent, msgType) {
  if (rawContent === null || rawContent === undefined) {
    return null;
  }

  if (typeof rawContent === 'string') {
    return rawContent;
  }

  if (typeof rawContent === 'object') {
    // Nếu là object mô tả text/caption (ví dụ params.desc)
    if (rawContent.params && typeof rawContent.params === 'object' && rawContent.params.desc) {
      return rawContent.params.desc;
    }
    if (rawContent.title || rawContent.description) {
      return rawContent.title || rawContent.description;
    }
    return rawContent;
  }

  return String(rawContent);
}

/**
 * Zalo Adapter: Lớp chống phụ thuộc (Anti-corruption layer)
 * Ánh xạ dữ liệu phản hồi từ zca-js sang schema NormalizedMessage nội bộ.
 */
export class ZaloAdapter {
  /**
   * @param {Object} options
   * @param {string} options.accountId - Định danh tài khoản nội bộ
   */
  constructor(options = {}) {
    if (!options.accountId) {
      throw new Error('ZaloAdapter yêu cầu tham số accountId');
    }
    this.accountId = options.accountId;
  }

  /**
   * Ánh xạ một tin nhắn thô duy nhất sang NormalizedMessage
   * @param {Object} rawItem - Đối tượng message thô từ zca-js (GroupMessage hoặc plain object)
   * @param {Object} context - Ngữ cảnh bổ sung
   * @param {string} [context.groupId] - ID nhóm nếu tin nhắn không mang sẵn
   * @param {string} [context.observedAt] - Thời điểm quan sát (mặc định Date.now())
   * @returns {Object|null}
   */
  normalizeMessage(rawItem, context = {}) {
    if (!rawItem || typeof rawItem !== 'object') {
      return null;
    }

    // zca-js có thể bọc dữ liệu trong class GroupMessage với thuộc tính .data
    const data = rawItem.data && typeof rawItem.data === 'object' ? rawItem.data : rawItem;

    // 1. messageId: Chỉ lấy từ nguồn, KHÔNG tự bịa đặt
    const rawId = data.msgId ?? data.actionId ?? data.cliMsgId ?? null;
    if (rawId === null || rawId === undefined || String(rawId).trim() === '') {
      return null; // Bỏ qua nếu tin nhắn không có bất kỳ định danh nào từ Zalo
    }
    const messageId = String(rawId);

    // 2. groupId: Chỉ lấy từ nguồn hoặc context được xác minh
    const rawGroupId = rawItem.threadId ?? data.idTo ?? context.groupId ?? null;
    const groupId = rawGroupId !== null && rawGroupId !== undefined ? String(rawGroupId) : null;

    // 3. senderId: Chỉ lấy từ nguồn, KHÔNG tự bịa đặt
    const rawSenderId = data.uidFrom ?? data.userId ?? null;
    const senderId = rawSenderId !== null && rawSenderId !== undefined ? String(rawSenderId) : null;

    // 4. senderName: Tên hiển thị người gửi
    const senderName = data.dName || data.senderName || null;

    // 5. msgType & internal messageType
    const rawMsgType = data.msgType || (typeof rawItem.type === 'string' ? rawItem.type : null) || 'unknown';
    const messageType = mapInternalMessageType(rawMsgType);

    // 6. Content
    const content = extractContent(data.content, rawMsgType);

    // 7. sentAt & observedAt
    const sentAt = parseSentAt(data.ts);
    const observedAt = context.observedAt || new Date().toISOString();

    // 8. Attachments
    const attachments = extractAttachments(data, messageId);

    // 9. rawMetadata: Bảo toàn metadata cần thiết mà không nhúng binary lớn
    const rawMetadata = {
      cliMsgId: data.cliMsgId ?? null,
      rawMsgType: String(rawMsgType),
      status: data.status ?? null,
      cmd: data.cmd ?? null,
      ttl: data.ttl ?? null,
      isSelf: Boolean(rawItem.isSelf)
    };

    return {
      schemaVersion: SCHEMA_VERSION,
      source: MessageSource.ZALO,
      accountId: this.accountId,
      groupId,
      messageId,
      senderId,
      senderName,
      content,
      messageType,
      sentAt,
      observedAt,
      attachments,
      rawMetadata
    };
  }

  /**
   * Ánh xạ danh sách tin nhắn, loại bỏ bản ghi không hợp lệ hoặc trùng lặp
   * @param {Array<Object>} rawMessages
   * @param {Object} context
   * @param {string} [context.groupId]
   * @param {'asc'|'desc'|null} [context.sortOrder='asc']
   * @returns {Array<Object>}
   */
  normalizeMessages(rawMessages, context = {}) {
    if (!Array.isArray(rawMessages)) {
      return [];
    }

    const { sortOrder = 'asc', groupId = null } = context;
    const observedAt = new Date().toISOString();
    const result = [];
    const seenIds = new Set();

    for (const rawItem of rawMessages) {
      const normalized = this.normalizeMessage(rawItem, { groupId, observedAt });
      if (!normalized) continue;

      if (normalized.messageId) {
        if (seenIds.has(normalized.messageId)) {
          continue; // Khử trùng lặp theo messageId
        }
        seenIds.add(normalized.messageId);
      }

      result.push(normalized);
    }

    // Sắp xếp theo thời gian sentAt
    if (sortOrder) {
      result.sort((a, b) => {
        const timeA = a.sentAt ? new Date(a.sentAt).getTime() : 0;
        const timeB = b.sentAt ? new Date(b.sentAt).getTime() : 0;
        return sortOrder === 'desc' ? timeB - timeA : timeA - timeB;
      });
    }

    return result;
  }

  /**
   * Ánh xạ thông tin nhóm từ zca-js
   * @param {Object} rawGroupInfo
   * @returns {Object}
   */
  normalizeGroup(rawGroupInfo) {
    if (!rawGroupInfo) return null;
    return {
      id: String(rawGroupInfo.id || rawGroupInfo.grid || ''),
      name: rawGroupInfo.name || `Group-${rawGroupInfo.id || ''}`,
      memberCount: Number(rawGroupInfo.memberCount || rawGroupInfo.totalMember || 0)
    };
  }
}
