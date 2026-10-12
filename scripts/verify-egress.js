import { createAccountConfig } from '../src/config/account-config.js';
import { verifyEgressIp } from '../src/client/egress-verifier.js';

async function main() {
  const accountConfig = createAccountConfig();
  console.log('=== KIỂM TRA ĐỊA CHỈ IP EGRESS ===');
  console.log(`- Tài khoản: ${accountConfig.accountId}`);
  console.log(`- Proxy cấu hình: ${accountConfig.egress.proxyUrl ? 'Có' : 'Không (kết nối trực tiếp)'}`);
  console.log(`- IP kỳ vọng: ${accountConfig.egress.fixedIp || 'Không cấu hình'}`);

  const result = await verifyEgressIp(accountConfig.egress);

  console.log('\n--- KẾT QUẢ KIỂM TRA ---');
  console.log(`- Trạng thái kiểm tra: ${result.verified ? 'THÀNH CÔNG' : 'THẤT BẠI'}`);
  console.log(`- IP Egress đo được: ${result.currentIp || 'Không xác định'}`);
  console.log(`- Khớp với IP kỳ vọng: ${result.matchesExpected ? 'ĐẠT (Khớp)' : 'CẢNH BÁO (Không khớp)'}`);
  console.log(`- Chi tiết: ${result.details}`);

  if (accountConfig.egress.fixedIp && !result.matchesExpected) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n[Lỗi]', err.message);
  process.exit(1);
});
