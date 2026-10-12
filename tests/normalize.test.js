import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMessage,
  normalizeMessages,
  normalizeTimestamp,
  normalizeContent,
  buildExportPayload
} from '../src/normalize.js';

describe('Unit Tests: Normalize Messages', () => {
  describe('normalizeTimestamp', () => {
    test('tra ve null khi timestamp rong hoac null/undefined', () => {
      assert.equal(normalizeTimestamp(null), null);
      assert.equal(normalizeTimestamp(undefined), null);
      assert.equal(normalizeTimestamp(''), null);
    });

    test('tra ve null khi timestamp khong hop le hoac <= 0', () => {
      assert.equal(normalizeTimestamp('invalid'), null);
      assert.equal(normalizeTimestamp(-100), null);
      assert.equal(normalizeTimestamp(0), null);
      assert.equal(normalizeTimestamp(NaN), null);
    });

    test('giu nguyen timestamp neu da la milliseconds (13 chu so)', () => {
      const ms = 1712345678000;
      assert.equal(normalizeTimestamp(ms), ms);
      assert.equal(normalizeTimestamp(String(ms)), ms);
    });

    test('tu dong chuyen doi sang milliseconds neu la unix timestamp giay (10 chu so)', () => {
      const sec = 1712345678;
      assert.equal(normalizeTimestamp(sec), sec * 1000);
      assert.equal(normalizeTimestamp(String(sec)), sec * 1000);
    });
  });

  describe('normalizeContent', () => {
    test('tra ve null neu noi dung la null hoac undefined', () => {
      assert.equal(normalizeContent(null), null);
      assert.equal(normalizeContent(undefined), null);
    });

    test('giu nguyen noi dung neu la chuoi text', () => {
      assert.equal(normalizeContent('Xin chao!'), 'Xin chao!');
    });

    test('giu nguyen doi tuong structured content/attachment khong bia dat', () => {
      const attachment = { type: 'image', url: 'https://example.com/img.png' };
      assert.deepEqual(normalizeContent(attachment), attachment);
    });
  });

  describe('normalizeMessage - Single Item', () => {
    test('chuan hoa day du cac truong tu raw message hop le', () => {
      const raw = {
        msgId: 'msg-12345',
        idTo: 'group-999',
        uidFrom: 'user-001',
        dName: 'Nguyen Van A',
        content: 'Noi dung test',
        ts: '1712345678000',
        msgType: 'chat.message'
      };

      const result = normalizeMessage(raw);
      assert.deepEqual(result, {
        id: 'msg-12345',
        groupId: 'group-999',
        senderId: 'user-001',
        senderName: 'Nguyen Van A',
        content: 'Noi dung test',
        timestamp: 1712345678000,
        type: 'chat.message'
      });
    });

    test('ho tro GroupMessage wrapper voi thuoc tinh .data', () => {
      const wrapped = {
        type: 1,
        threadId: 'group-888',
        data: {
          msgId: 'msg-wrapped-1',
          uidFrom: 'user-002',
          dName: 'Tran Van B',
          content: 'Tin nhan tu wrapper',
          ts: 1712345678000,
          msgType: 'chat.message'
        }
      };

      const result = normalizeMessage(wrapped);
      assert.equal(result.id, 'msg-wrapped-1');
      assert.equal(result.groupId, 'group-888');
      assert.equal(result.senderId, 'user-002');
      assert.equal(result.senderName, 'Tran Van B');
      assert.equal(result.content, 'Tin nhan tu wrapper');
    });

    test('khong bia dat du lieu cho cac truong bi thieu (tra ve null)', () => {
      const emptyRaw = {};
      const result = normalizeMessage(emptyRaw, 'fallback-group-id');

      assert.deepEqual(result, {
        id: null,
        groupId: 'fallback-group-id',
        senderId: null,
        senderName: null,
        content: null,
        timestamp: null,
        type: null
      });
    });

    test('tra ve null khi truyen vao null hoac undefined', () => {
      assert.equal(normalizeMessage(null), null);
      assert.equal(normalizeMessage(undefined), null);
    });
  });

  describe('normalizeMessages - Danh sach & Deduplication', () => {
    test('tra ve mang rong khi input rong hoac khong hop le', () => {
      assert.deepEqual(normalizeMessages([]), []);
      assert.deepEqual(normalizeMessages(null), []);
      assert.deepEqual(normalizeMessages(undefined), []);
    });

    test('loai bo tin nhan trung lap ve message ID', () => {
      const messages = [
        { msgId: '101', uidFrom: 'u1', content: 'Tin nhan 1', ts: '1712345678000' },
        { msgId: '102', uidFrom: 'u2', content: 'Tin nhan 2', ts: '1712345678000' },
        { msgId: '101', uidFrom: 'u1', content: 'Tin nhan 1 bi lap lai', ts: '1712345678000' }, // Trung id 101
        { msgId: '103', uidFrom: 'u3', content: 'Tin nhan 3', ts: '1712345678000' }
      ];

      const result = normalizeMessages(messages);
      assert.equal(result.length, 3);
      assert.deepEqual(result.map(m => m.id), ['101', '102', '103']);
    });

    test('sap xep tin nhan theo thoi gian tang dan (asc - cu den moi)', () => {
      const messages = [
        { msgId: '3', content: 'Tin 3', ts: '1712345690000' },
        { msgId: '1', content: 'Tin 1', ts: '1712345670000' },
        { msgId: '2', content: 'Tin 2', ts: '1712345680000' }
      ];

      const result = normalizeMessages(messages, { sortOrder: 'asc' });
      assert.deepEqual(result.map(m => m.id), ['1', '2', '3']);
    });

    test('sap xep tin nhan theo thoi gian giam dan (desc - moi den cu)', () => {
      const messages = [
        { msgId: '1', content: 'Tin 1', ts: '1712345670000' },
        { msgId: '3', content: 'Tin 3', ts: '1712345690000' },
        { msgId: '2', content: 'Tin 2', ts: '1712345680000' }
      ];

      const result = normalizeMessages(messages, { sortOrder: 'desc' });
      assert.deepEqual(result.map(m => m.id), ['3', '2', '1']);
    });
  });

  describe('buildExportPayload', () => {
    test('tao payload dung format voi day du metadata', () => {
      const messages = [
        {
          id: '1',
          groupId: 'g1',
          senderId: 'u1',
          senderName: 'User 1',
          content: 'Hello',
          timestamp: 1712345678000,
          type: 'chat.message'
        }
      ];

      const payload = buildExportPayload(messages, {
        groupId: 'g1',
        groupName: 'Nhom du an'
      });

      assert.equal(payload.schemaVersion, '1.0.0');
      assert.ok(payload.fetchedAt);
      assert.equal(payload.group.id, 'g1');
      assert.equal(payload.group.name, 'Nhom du an');
      assert.equal(payload.totalMessages, 1);
      assert.deepEqual(payload.messages, messages);
    });
  });
});
