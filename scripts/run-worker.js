import { createAccountConfig } from '../src/config/account-config.js';
import { ZaloWorker } from '../src/worker/zalo-worker.js';

async function main() {
  const accountConfig = createAccountConfig();

  console.log('====================================================');
  console.log('   ZALO INGESTION WORKER — MVP SINGLE ACCOUNT');
  console.log('====================================================');
  console.log(`- Tài khoản: ${accountConfig.accountId}`);
  console.log(`- Nhóm được phép: ${accountConfig.allowedGroupIds.join(', ') || 'Chưa cấu hình (ALLOWED_GROUP_IDS rỗng)'}`);
  console.log(`- Tự động tải Media: ${accountConfig.sync.autoDownloadMedia ? 'BẬT' : 'TẮT'}`);
  console.log(`- Thư mục lưu trữ: ${accountConfig.storage.storageDir}`);
  console.log('----------------------------------------------------');

  if (accountConfig.allowedGroupIds.length === 0) {
    console.error('[CẢNH BÁO] Danh sách ALLOWED_GROUP_IDS đang trống!');
    console.error('Vui lòng chạy `npm run list-groups`, chọn ID các nhóm cần đọc và thêm vào .env.');
    process.exit(1);
  }

  const worker = new ZaloWorker(accountConfig);
  await worker.start({ mode: 'worker' });

  console.log('\n--- BẮT ĐẦU CHU KỲ ĐỒNG BỘ CÁC NHÓM ĐƯỢC PHÉP ---');
  const results = await worker.syncAllAllowedGroups();

  console.log('\n====================================================');
  console.log('   TỔNG KẾT KẾT QUẢ ĐỒNG BỘ');
  console.log('====================================================');
  results.forEach((res, i) => {
    if (res.status === 'success') {
      console.log(`[${i + 1}] Nhóm ${res.groupId}: THÀNH CÔNG (Lấy ${res.count} tin, thêm mới ${res.added} tin, tổng kho ${res.total} tin)`);
    } else if (res.status === 'skipped') {
      console.log(`[${i + 1}] Nhóm ${res.groupId}: BỎ QUA (Lý do: ${res.reason})`);
    } else {
      console.log(`[${i + 1}] Nhóm ${res.groupId}: LỖI (${res.error})`);
    }
  });

  // Hiển thị mẫu tin nhắn chuẩn hóa đã ẩn danh nếu có
  const firstSuccess = results.find((r) => r.status === 'success' && r.count > 0);
  if (firstSuccess) {
    const sampleMsgs = worker.messageStorage.getNormalizedMessages(accountConfig.accountId, firstSuccess.groupId);
    if (sampleMsgs.length > 0) {
      console.log('\n--- VÍ DỤ TIN NHẮN CHUẨN HÓA ĐÃ ẨN DANH ---');
      const sample = sampleMsgs[0];
      const anonymized = {
        schemaVersion: sample.schemaVersion,
        source: sample.source,
        accountId: sample.accountId,
        groupId: sample.groupId ? `${sample.groupId.slice(0, 4)}***` : null,
        messageId: sample.messageId ? `${sample.messageId.slice(0, 4)}***` : null,
        senderId: sample.senderId ? `${sample.senderId.slice(0, 4)}***` : null,
        senderName: sample.senderName ? `${sample.senderName.slice(0, 2)}***` : null,
        content: typeof sample.content === 'string' ? `${sample.content.slice(0, 15)}...` : sample.content,
        messageType: sample.messageType,
        sentAt: sample.sentAt,
        observedAt: sample.observedAt,
        attachments: sample.attachments,
        rawMetadata: sample.rawMetadata
      };
      console.log(JSON.stringify(anonymized, null, 2));
    }
  }

  worker.releaseProcessLock();
  console.log('\nHoàn tất chu kỳ vận hành Ingestion Worker.');
}

main().catch((err) => {
  console.error('\n[Lỗi nghiêm trọng]', err.message);
  process.exit(1);
});
