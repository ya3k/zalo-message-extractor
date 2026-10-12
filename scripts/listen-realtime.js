import { createAccountConfig } from '../src/config/account-config.js';
import { ZaloWorker } from '../src/worker/zalo-worker.js';

async function main() {
  const accountConfig = createAccountConfig();

  console.log('====================================================');
  console.log('   ZALO REALTIME INGESTION DAEMON (LISTENER 24/7)');
  console.log('====================================================');
  console.log(`- Tài khoản: ${accountConfig.accountId}`);
  console.log(`- Nhóm giám sát: ${accountConfig.allowedGroupIds.join(', ') || 'Chưa cấu hình (ALLOWED_GROUP_IDS rỗng)'}`);
  console.log(`- Tự động tải Media: ${accountConfig.sync.autoDownloadMedia ? 'BẬT' : 'TẮT'}`);
  console.log('----------------------------------------------------');

  if (accountConfig.allowedGroupIds.length === 0) {
    console.warn('[CẢNH BÁO] ALLOWED_GROUP_IDS đang trống. Daemon sẽ chỉ giám sát các nhóm được cho phép.');
    console.warn('Vui lòng cấu hình ALLOWED_GROUP_IDS trong .env để nhận tin nhắn.');
  }

  const worker = new ZaloWorker(accountConfig);
  await worker.start({ mode: 'listen' });

  // Bắt đầu lắng nghe thời gian thực
  await worker.startRealtimeListener();

  console.log('\n>>> Đang chờ tin nhắn mới từ Zalo... (Nhấn Ctrl + C để dừng dịch vụ)');

  // Xử lý dừng tiến trình an toàn khi nhận tín hiệu kết thúc (Graceful Shutdown)
  let isShuttingDown = false;
  const cleanup = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('\n[Daemon] Đang dừng dịch vụ lắng nghe an toàn...');
    try {
      await worker.shutdown(5000);
    } catch (err) {
      console.error('[Daemon] Lỗi khi shutdown:', err.message);
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((err) => {
  console.error('\n[Lỗi]', err.message);
  process.exit(1);
});
