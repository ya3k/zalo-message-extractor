import test from 'node:test';
import assert from 'node:assert/strict';
import { ZaloAdapter, parseSentAt, inferMimeType } from '../../src/adapter/zalo-adapter.js';
import {
  SCHEMA_VERSION,
  MessageSource,
  AttachmentType,
  DownloadStatus,
  InternalMessageType
} from '../../src/adapter/message-types.js';

test('Unit Tests: ZaloAdapter', async (t) => {
  const adapter = new ZaloAdapter({ accountId: 'test_account_01' });

  await t.test('Khởi tạo adapter yêu cầu accountId', () => {
    assert.throws(() => new ZaloAdapter({}), /accountId/);
  });

  await t.test('parseSentAt: Xử lý timestamp hợp lệ và không hợp lệ', () => {
    // Milliseconds (13 chữ số)
    const msTs = 1710000000000;
    const isoMs = parseSentAt(msTs);
    assert.equal(isoMs, new Date(msTs).toISOString());

    // Seconds (10 chữ số)
    const secTs = 1710000000;
    const isoSec = parseSentAt(secTs);
    assert.equal(isoSec, new Date(secTs * 1000).toISOString());

    // Timestamp không hợp lệ hoặc thiếu -> trả về null, KHÔNG tự bịa đặt
    assert.equal(parseSentAt(null), null);
    assert.equal(parseSentAt(undefined), null);
    assert.equal(parseSentAt(''), null);
    assert.equal(parseSentAt(-1), null);
    assert.equal(parseSentAt(0), null);
    assert.equal(parseSentAt('invalid'), null);
  });

  await t.test('inferMimeType: Suy đoán đúng MIME type', () => {
    assert.equal(inferMimeType('photo.jpg', AttachmentType.IMAGE), 'image/jpeg');
    assert.equal(inferMimeType('report.pdf', AttachmentType.FILE), 'application/pdf');
    assert.equal(inferMimeType('data.xlsx', AttachmentType.FILE), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(inferMimeType(null, AttachmentType.IMAGE), 'image/jpeg');
    assert.equal(inferMimeType(null, AttachmentType.AUDIO), 'audio/mpeg');
  });

  await t.test('Mapping raw response sang NormalizedMessage chuẩn', () => {
    const rawMsg = {
      msgId: 'msg_1001',
      idTo: 'group_999',
      uidFrom: 'user_888',
      dName: 'Nguyen Van A',
      content: 'Xin chao day la tin nhan test',
      ts: 1710000000000,
      msgType: 'webchat'
    };

    const normalized = adapter.normalizeMessage(rawMsg);
    assert.ok(normalized);
    assert.equal(normalized.schemaVersion, SCHEMA_VERSION);
    assert.equal(normalized.source, MessageSource.ZALO);
    assert.equal(normalized.accountId, 'test_account_01');
    assert.equal(normalized.groupId, 'group_999');
    assert.equal(normalized.messageId, 'msg_1001');
    assert.equal(normalized.senderId, 'user_888');
    assert.equal(normalized.senderName, 'Nguyen Van A');
    assert.equal(normalized.content, 'Xin chao day la tin nhan test');
    assert.equal(normalized.messageType, InternalMessageType.TEXT);
    assert.equal(normalized.sentAt, new Date(1710000000000).toISOString());
    assert.ok(normalized.observedAt);
    assert.deepEqual(normalized.attachments, []);
    assert.equal(normalized.rawMetadata.rawMsgType, 'webchat');
  });

  await t.test('Message thiếu trường tùy chọn: Không tự bịa senderId, messageId hoặc timestamp', () => {
    // Trường hợp thiếu messageId -> Adapter bỏ qua bản ghi (trả về null)
    const rawNoId = {
      content: 'Tin nhắn không có ID',
      uidFrom: 'user_1'
    };
    assert.equal(adapter.normalizeMessage(rawNoId), null);

    // Trường hợp thiếu senderName, timestamp -> Giữ null
    const rawMissingOptional = {
      msgId: 'msg_1002',
      uidFrom: 'user_2',
      content: 'Tin nhắn thiếu senderName và ts'
    };

    const res = adapter.normalizeMessage(rawMissingOptional, { groupId: 'grp_1' });
    assert.ok(res);
    assert.equal(res.messageId, 'msg_1002');
    assert.equal(res.senderId, 'user_2');
    assert.equal(res.senderName, null);
    assert.equal(res.sentAt, null);
    assert.equal(res.groupId, 'grp_1');
  });

  await t.test('Tin nhắn phi văn bản: chat.photo kèm attachment', () => {
    const photoRaw = {
      msgId: 'msg_photo_01',
      uidFrom: 'user_photographer',
      ts: 1710000005000,
      msgType: 'chat.photo',
      content: {
        photoId: 'photo_555',
        normalUrl: 'https://chat-media.zalo.me/photos/test.jpg',
        hdUrl: 'https://chat-media.zalo.me/photos/test_hd.jpg',
        hdSize: 204800,
        fileName: 'image_receipt.jpg'
      }
    };

    const normalized = adapter.normalizeMessage(photoRaw, { groupId: 'grp_images' });
    assert.ok(normalized);
    assert.equal(normalized.messageType, InternalMessageType.IMAGE);
    assert.equal(normalized.attachments.length, 1);

    const att = normalized.attachments[0];
    assert.equal(att.attachmentId, 'photo_555');
    assert.equal(att.type, AttachmentType.IMAGE);
    assert.equal(att.mimeType, 'image/jpeg');
    assert.equal(att.sizeBytes, 204800);
    assert.equal(att.downloadStatus, DownloadStatus.PENDING);
    assert.equal(att._downloadUrl, 'https://chat-media.zalo.me/photos/test_hd.jpg');
    assert.equal(att.storageKey, null);
  });

  await t.test('Tin nhắn phi văn bản: share.file đính kèm', () => {
    const fileRaw = {
      msgId: 'msg_file_01',
      uidFrom: 'user_accountant',
      ts: 1710000010000,
      msgType: 'share.file',
      content: {
        fileId: 'file_777',
        fileUrl: 'https://chat-media.zalo.me/files/contract.pdf',
        fileName: 'hop_dong_khach_hang.pdf',
        totalSize: 1048576,
        checksum: 'abc123sha'
      }
    };

    const normalized = adapter.normalizeMessage(fileRaw, { groupId: 'grp_files' });
    assert.ok(normalized);
    assert.equal(normalized.messageType, InternalMessageType.FILE);
    assert.equal(normalized.attachments.length, 1);

    const att = normalized.attachments[0];
    assert.equal(att.attachmentId, 'file_777');
    assert.equal(att.type, AttachmentType.FILE);
    assert.equal(att.fileName, 'hop_dong_khach_hang.pdf');
    assert.equal(att.mimeType, 'application/pdf');
    assert.equal(att.sizeBytes, 1048576);
    assert.equal(att.checksum, 'abc123sha');
    assert.equal(att.downloadStatus, DownloadStatus.PENDING);
  });

  await t.test('Attachment thiếu URL: Đặt trạng thái unsupported', () => {
    const photoNoUrl = {
      msgId: 'msg_photo_no_url',
      uidFrom: 'user_1',
      msgType: 'chat.photo',
      content: {
        photoId: 'photo_no_url'
        // Không có URL tải
      }
    };

    const normalized = adapter.normalizeMessage(photoNoUrl);
    assert.ok(normalized);
    assert.equal(normalized.attachments.length, 1);
    assert.equal(normalized.attachments[0].downloadStatus, DownloadStatus.UNSUPPORTED);
  });

  await t.test('Tin nhắn sticker: Đặt messageType sticker và unsupported download', () => {
    const stickerRaw = {
      msgId: 'msg_sticker_01',
      uidFrom: 'user_1',
      msgType: 'chat.sticker',
      content: { id: 'stk_99', catId: 'cat_1' }
    };

    const normalized = adapter.normalizeMessage(stickerRaw);
    assert.ok(normalized);
    assert.equal(normalized.messageType, InternalMessageType.STICKER);
    assert.equal(normalized.attachments[0].type, AttachmentType.STICKER);
    assert.equal(normalized.attachments[0].downloadStatus, DownloadStatus.UNSUPPORTED);
  });

  await t.test('normalizeMessages: Khử trùng lặp và sắp xếp theo sentAt', () => {
    const rawList = [
      { msgId: 'm3', ts: 1710000030000, content: 'Tin 3' },
      { msgId: 'm1', ts: 1710000010000, content: 'Tin 1' },
      { msgId: 'm2', ts: 1710000020000, content: 'Tin 2' },
      { msgId: 'm1', ts: 1710000010000, content: 'Tin 1 Trùng' } // Trùng lặp
    ];

    const normalizedList = adapter.normalizeMessages(rawList, { sortOrder: 'asc' });
    assert.equal(normalizedList.length, 3);
    assert.equal(normalizedList[0].messageId, 'm1');
    assert.equal(normalizedList[1].messageId, 'm2');
    assert.equal(normalizedList[2].messageId, 'm3');
  });
});
