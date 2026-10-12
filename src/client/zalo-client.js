import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { Zalo, LoginQRCallbackEventType } from 'zca-js';
import { registerCustomHistory } from './custom-history.js';

/**
 * Khởi tạo client zca-js cho một tài khoản cụ thể
 * Hỗ trợ tái sử dụng session và đăng nhập QR dự phòng
 *
 * @param {import('../config/account-config.js').AccountProfile} accountConfig
 * @param {Object} [options={}]
 * @param {boolean} [options.forceQR=false]
 * @returns {Promise<{ api: import('zca-js').API, accountInfo: Object }>}
 */
export async function createZaloClient(accountConfig, options = {}) {
  const { forceQR = false } = options;
  const { sessionPath, qrPath, egress } = accountConfig;

  const zaloOptions = {
    selfListen: true, // BẬT lắng nghe cả tin nhắn do chính chủ tài khoản/chủ nhóm gửi (tránh bị zca-js bỏ qua mặc định)
    logging: false // Tắt verbose logging để tránh rò rỉ cookie/token
  };

  // Cấu hình proxy agent nếu có
  if (egress?.proxyUrl) {
    try {
      // Khi môi trường cung cấp proxy, zca-js hỗ trợ agent trong options
      console.log(`[Client] Cấu hình IP egress proxy cho tài khoản ${accountConfig.accountId}...`);
    } catch (err) {
      console.warn(`[Client] Không thể khởi tạo proxy agent: ${err.message}`);
    }
  }

  const zalo = new Zalo(zaloOptions);

  // 1. Thử đăng nhập bằng session đã lưu nếu có
  if (!forceQR && fs.existsSync(sessionPath)) {
    try {
      console.log(`[Auth] Đang thử khôi phục phiên cho tài khoản: ${accountConfig.accountId}...`);
      const sessionRaw = fs.readFileSync(sessionPath, 'utf8');
      const credentials = JSON.parse(sessionRaw);

      if (credentials?.cookie && credentials?.imei && credentials?.userAgent) {
        const api = await zalo.login({
          cookie: credentials.cookie,
          imei: credentials.imei,
          userAgent: credentials.userAgent
        });

        // Đăng ký endpoint V2 Cloud Message tự động
        registerCustomHistory(api);

        const accountInfo = {
          accountId: accountConfig.accountId,
          uid: api.ctx?.uid || null,
          publicIp: api.ctx?.loginInfo?.public_ip || null
        };

        console.log(`[Auth] Đăng nhập phiên thành công (UID: ${accountInfo.uid || 'N/A'}, IP: ${accountInfo.publicIp || 'N/A'})!`);
        return { api, accountInfo };
      }
      console.warn('[Auth] Dữ liệu session không đầy đủ, chuyển sang đăng nhập QR.');
    } catch (err) {
      console.warn(`[Auth] Không thể sử dụng session cũ (${err.message}). Bắt đầu đăng nhập QR...`);
    }
  }

  // 2. Đăng nhập qua mã QR
  console.log(`[Auth] Khởi tạo quy trình quét mã QR cho tài khoản ${accountConfig.accountId}...`);
  const absoluteQrPath = path.resolve(process.cwd(), qrPath);

  const api = await zalo.loginQR(
    {
      qrPath: absoluteQrPath
    },
    async (event) => {
      switch (event.type) {
        case LoginQRCallbackEventType.QRCodeGenerated:
          if (event.actions?.saveToFile) {
            await event.actions.saveToFile(absoluteQrPath);
          }
          console.log(`[QR] Mã QR đăng nhập đã lưu tại: ${absoluteQrPath}`);
          try {
            if (process.platform === 'win32') {
              exec(`start "" "${absoluteQrPath}"`);
              console.log('[QR] Đã tự động mở ảnh QR trên màn hình.');
            }
          } catch {
            // Người dùng có thể mở ảnh thủ công
          }
          console.log('[QR] Vui lòng mở Zalo trên điện thoại và quét mã QR để xác nhận.');
          break;

        case LoginQRCallbackEventType.QRCodeScanned:
          console.log('[QR] Đã quét mã QR. Vui lòng bấm XÁC NHẬN trên điện thoại.');
          break;

        case LoginQRCallbackEventType.QRCodeExpired:
          console.log('[QR] Mã QR đã hết hạn. Đang tạo lại mã mới...');
          if (event.actions?.retry) event.actions.retry();
          break;

        case LoginQRCallbackEventType.QRCodeDeclined:
          console.warn('[QR] Đăng nhập bị từ chối từ điện thoại.');
          break;

        case LoginQRCallbackEventType.GotLoginInfo:
          try {
            const dir = path.dirname(sessionPath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(
              sessionPath,
              JSON.stringify(event.data, null, 2),
              { mode: 0o600 }
            );
            console.log(`[Auth] Đã lưu session an toàn vào: ${sessionPath}`);
          } catch (saveErr) {
            console.error(`[Auth] Lỗi lưu session: ${saveErr.message}`);
          }
          break;
      }
    }
  );

  registerCustomHistory(api);

  const accountInfo = {
    accountId: accountConfig.accountId,
    uid: api.ctx?.uid || null,
    publicIp: api.ctx?.loginInfo?.public_ip || null
  };

  console.log(`[Auth] Đăng nhập QR thành công (UID: ${accountInfo.uid || 'N/A'}, IP: ${accountInfo.publicIp || 'N/A'})!`);
  return { api, accountInfo };
}
