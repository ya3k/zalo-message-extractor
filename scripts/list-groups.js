import path from 'node:path';
import { createAccountConfig } from '../src/config/account-config.js';
import { ZaloWorker } from '../src/worker/zalo-worker.js';
import { exportToJson } from '../src/export-json.js';

async function main() {
  const accountConfig = createAccountConfig();
  console.log('=== [1/2] KHỞI ĐỘNG CLIENT ZALO CHO TÀI KHOẢN ===');
  console.log(`- Account ID: ${accountConfig.accountId}`);

  const worker = new ZaloWorker(accountConfig);
  await worker.start();

  console.log('\n=== [2/2] TRUY XUẤT DANH SÁCH NHÓM CHAT ===');
  const groups = await worker.getGroups();

  // 1. Lưu danh sách nhóm tóm tắt vào output/groups.json
  const summaryPath = path.join(accountConfig.storage.outputDir, 'groups.json');
  exportToJson(summaryPath, {
    accountId: accountConfig.accountId,
    fetchedAt: new Date().toISOString(),
    totalGroups: groups.length,
    groups
  });
  console.log(`[Export] Đã lưu danh sách nhóm tổng hợp tại: ${summaryPath}`);

  // 2. Hiển thị danh sách nhóm và trạng thái ủy quyền
  console.log(`\nTổng số nhóm tìm thấy: ${groups.length}`);
  if (groups.length === 0) {
    console.log('Không tìm thấy nhóm chat nào trên tài khoản này.');
  } else {
    console.log('\nDanh sách nhóm chat (sử dụng ID để điền vào ALLOWED_GROUP_IDS trong .env):');
    groups.forEach((g, index) => {
      const authBadge = g.isAllowed ? '[ĐƯỢC PHÉP TRUY CẬP]' : '[CHƯA CẤU HÌNH]';
      console.log(`  [${index + 1}] ID: ${g.id} | Tên: ${g.name} (${g.memberCount} thành viên) ${authBadge}`);
    });
  }

  console.log('\nHoàn tất kiểm tra danh sách nhóm.');
}

main().catch((err) => {
  console.error('\n[Lỗi]', err.message);
  process.exit(1);
});
