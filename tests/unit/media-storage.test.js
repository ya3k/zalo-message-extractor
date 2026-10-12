import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FileSystemMediaStorage } from '../../src/storage/media-storage.js';
import { DownloadStatus, AttachmentType } from '../../src/adapter/message-types.js';

test('Unit Tests: FileSystemMediaStorage', async (t) => {
  const testBaseDir = path.resolve(process.cwd(), './storage/test_media');
  const storage = new FileSystemMediaStorage({
    baseDir: testBaseDir,
    maxSizeBytes: 1024 * 1024 // 1MB limit for tests
  });

  t.after(() => {
    // Dọn dẹp thư mục test sau khi chạy
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  await t.test('storeBuffer: Lưu trữ buffer trực tiếp với checksum và storageKey ổn định', async () => {
    const content = Buffer.from('Noi dung file test dinh kem media');
    const expectedChecksum = crypto.createHash('sha256').update(content).digest('hex');

    const result = await storage.storeBuffer(content, 'test_image.jpg', {
      accountId: 'acc_01',
      groupId: 'grp_01',
      attachmentId: 'att_123'
    });

    assert.ok(result.storageKey);
    assert.equal(result.checksum, expectedChecksum);
    assert.equal(result.sizeBytes, content.length);

    // Kiểm tra file thực tế đã được lưu bền vững trên đĩa
    const fullPath = path.join(testBaseDir, result.storageKey);
    assert.ok(fs.existsSync(fullPath));
    const savedContent = fs.readFileSync(fullPath);
    assert.deepEqual(savedContent, content);

    // Kiểm tra method exists
    const exists = await storage.exists(result.storageKey);
    assert.equal(exists, true);
  });

  await t.test('storeBuffer: Từ chối file vượt quá maxSizeBytes', async () => {
    const hugeBuffer = Buffer.alloc(1024 * 1024 + 10); // > 1MB
    await assert.rejects(
      async () => {
        await storage.storeBuffer(hugeBuffer, 'huge.bin');
      },
      /vượt quá giới hạn/
    );
  });

  await t.test('downloadAndStore: Xử lý khi attachment không có URL tải', async () => {
    const att = {
      attachmentId: 'att_nourl',
      type: AttachmentType.STICKER,
      downloadStatus: DownloadStatus.UNSUPPORTED
    };

    const res = await storage.downloadAndStore(att, { accountId: 'acc_1', groupId: 'grp_1' });
    assert.equal(res.downloadStatus, DownloadStatus.UNSUPPORTED);
    assert.equal(res.storageKey, undefined);
  });

  await t.test('downloadAndStore: Xử lý khi tải thất bại (URL không tồn tại / 404)', async () => {
    const att = {
      attachmentId: 'att_fail',
      fileName: 'broken.jpg',
      type: AttachmentType.IMAGE,
      downloadStatus: DownloadStatus.PENDING,
      _downloadUrl: 'https://127.0.0.1:59999/non-existent-endpoint' // Endpoint không thể kết nối
    };

    const res = await storage.downloadAndStore(att, { accountId: 'acc_1', groupId: 'grp_1' });
    // Trạng thái phải là FAILED, KHÔNG lưu như thể đã thành công
    assert.equal(res.downloadStatus, DownloadStatus.FAILED);
    assert.ok(res.downloadError);
    assert.equal(res.storageKey, undefined);
    // Đảm bảo _downloadUrl đã được loại bỏ để không lộ URL trong metadata
    assert.equal(res._downloadUrl, undefined);
  });

  await t.test('Làm sạch tên file để tránh Path Traversal', () => {
    assert.equal(storage.sanitizeFileName('../../../etc/passwd'), 'passwd');
    assert.equal(storage.sanitizeFileName('photo@#$%.png'), 'photo____.png');
    assert.equal(storage.sanitizeFileName(null), 'file.bin');
  });
});
