/**
 * Định nghĩa các kiểu dữ liệu và hằng số cho Normalized Message & Attachment
 */

export const SCHEMA_VERSION = '1.0.0';

export const MessageSource = {
  ZALO: 'zalo'
};

export const AttachmentType = {
  IMAGE: 'image',
  VIDEO: 'video',
  FILE: 'file',
  AUDIO: 'audio',
  STICKER: 'sticker',
  LINK: 'link',
  OTHER: 'other'
};

export const DownloadStatus = {
  PENDING: 'pending',
  DOWNLOADED: 'downloaded',
  FAILED: 'failed',
  UNSUPPORTED: 'unsupported'
};

export const InternalMessageType = {
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  FILE: 'file',
  AUDIO: 'audio',
  STICKER: 'sticker',
  LINK: 'link',
  SYSTEM: 'system',
  OTHER: 'other'
};
