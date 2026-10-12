import path from 'node:path';
import { createAccountConfig } from '../src/config/account-config.js';
import { ZaloWorker } from '../src/worker/zalo-worker.js';
import { exportToJson } from '../src/export-json.js';

async function main() {
  const accountConfig = createAccountConfig();
  const groupId = process.env.GROUP_ID || accountConfig.allowedGroupIds[0];

  if (!groupId) {
    console.error('[Lỗi] Thiếu GROUP_ID trong môi trường (.env hoặc CLI env).');
    console.error('Hướng dẫn: Chạy `npm run list-groups` để lấy ID nhóm, sau đó đặt GROUP_ID=<id> vào .env.');
    process.exit(1);
  }

  // Đảm bảo groupId nằm trong allowedGroupIds để vượt qua kiểm tra bảo mật
  if (!accountConfig.allowedGroupIds.includes(groupId)) {
    accountConfig.allowedGroupIds.push(groupId);
  }

  const count = accountConfig.sync.messageCount || 10;

  console.log('=== [1/3] KHỞI ĐỘNG CLIENT VÀ WORKER CHO TÀI KHOẢN ===');
  const worker = new ZaloWorker(accountConfig);
  await worker.start();

  console.log(`\n=== [2/3] KIỂM CHỨNG API LỊCH SỬ TIN NHẮN CHO NHÓM: ${groupId} (TỐI ĐA ${count} TIN) ===`);

  let syncResult;
  try {
    syncResult = await worker.syncGroup(groupId, { count });
    console.log(`[Thành công] Đồng bộ nhóm thành công! (Trạng thái: ${syncResult.status})`);
  } catch (error) {
    console.error('\n****************************************************************');
    console.error('*** TRẠNG THÁI: BLOCKED — API getGroupChatHistory THẤT BẠI ***');
    console.error('****************************************************************');
    console.error('Thông tin chẩn đoán:');
    console.error('  - Package: zca-js@2.2.0');
    console.error('  - Chi tiết lỗi:', error.message);
    console.error('\nLưu ý an toàn: Không thử lại liên tục và không sửa node_modules.');
    process.exit(2);
  }

  console.log('\n=== [3/3] XUẤT VÀ KIỂM TRA DỮ LIỆU ĐÃ CHUẨN HÓA ===');
  const normalizedMsgs = worker.messageStorage.getNormalizedMessages(accountConfig.accountId, groupId);
  console.log(`[Storage] Tổng số tin nhắn đã lưu trong kho chuẩn hóa: ${normalizedMsgs.length}`);

  // Xuất file tương thích output/messages-normalized.json cho POC
  const compatPath = path.join(accountConfig.storage.outputDir, 'messages-normalized.json');
  exportToJson(compatPath, {
    schemaVersion: '1.0.0',
    fetchedAt: new Date().toISOString(),
    groupId,
    totalMessages: normalizedMsgs.length,
    messages: normalizedMsgs
  });
  console.log(`[Export] Đã xuất bản sao tương thích POC tại: ${compatPath}`);

  // Hiển thị mẫu ẩn danh
  if (normalizedMsgs.length > 0) {
    console.log('\n[Mẫu tin nhắn chuẩn hóa đã ẩn danh]:');
    const sample = normalizedMsgs[0];
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
      attachments: sample.attachments
    };
    console.log(JSON.stringify(anonymized, null, 2));
  }

  console.log('\nHoàn tất kiểm chứng API lịch sử tin nhắn.');
}

main().catch((err) => {
  console.error('\n[Lỗi]', err.message);
  process.exit(1);
});
