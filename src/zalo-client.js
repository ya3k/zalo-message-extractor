import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { Zalo, LoginQRCallbackEventType } from 'zca-js';
import { config } from './config.js';

/**
 * Khoi tao va lay instance API cua Zalo.
 * Uu tien tai su dung session da luu tai sessionPath.
 * Neu chua co hoac session khong hop le, se bat quy trinh dang nhap QR.
 *
 * @param {Object} options
 * @param {boolean} [options.forceQR=false] - Bat buoc dang nhap lai bang QR
 * @param {string} [options.qrPath='./qr.png'] - Duong dan file luu anh QR
 * @returns {Promise<import('zca-js').API>}
 */
export async function getZaloApi(options = {}) {
  const { forceQR = false, qrPath = './qr.png' } = options;
  const sessionPath = config.sessionPath;

  const zalo = new Zalo({
    logging: false // Khong bat verbose log cua zca-js de tranh lo thong tin nhay cam
  });

  // 1. Thu dang nhap bang session da luu neu ton tai va khong yeu cau forceQR
  if (!forceQR && fs.existsSync(sessionPath)) {
    try {
      console.log('[Auth] Phat hien session da luu, dang thu dang nhap...');
      const sessionRaw = fs.readFileSync(sessionPath, 'utf8');
      const credentials = JSON.parse(sessionRaw);

      if (credentials?.cookie && credentials?.imei && credentials?.userAgent) {
        const api = await zalo.login({
          cookie: credentials.cookie,
          imei: credentials.imei,
          userAgent: credentials.userAgent
        });
        console.log('[Auth] Dang nhap bang session thanh cong!');
        return api;
      }
      console.warn('[Auth] Du lieu session khong day du, chuyen sang dang nhap QR.');
    } catch (err) {
      console.warn(`[Auth] Dang nhap bang session that bai (${err.message}). Chuyen sang dang nhap QR...`);
    }
  }

  // 2. Dang nhap bang QR
  console.log('[Auth] Khoi tao quy trinh dang nhap qua ma QR...');
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
          console.log(`[QR] Ma QR da duoc luu tai: ${absoluteQrPath}`);
          try {
            if (process.platform === 'win32') {
              exec(`start "" "${absoluteQrPath}"`);
              console.log('[QR] Da tu dong mo anh QR tren man hinh Windows.');
            }
          } catch {
            // Neu khong the mo thi nguoi dung co the mo file thu cong
          }
          console.log('[QR] Vui long mo ung dung Zalo tren dien thoai va quet ma QR de xac thuc.');
          break;

        case LoginQRCallbackEventType.QRCodeScanned:
          console.log('[QR] Da quet ma QR thanh cong. Vui long bam XAC NHAN tren dien thoai.');
          break;

        case LoginQRCallbackEventType.QRCodeExpired:
          console.log('[QR] Ma QR da het han. Dang tao lai ma moi...');
          if (event.actions?.retry) event.actions.retry();
          break;

        case LoginQRCallbackEventType.QRCodeDeclined:
          console.warn('[QR] Dang nhap bi tu choi tu thiet bi.');
          break;

        case LoginQRCallbackEventType.GotLoginInfo:
          // Luu session de su dung cho cac lan chay sau ma khong can quet lai QR
          try {
            const dir = path.dirname(sessionPath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(
              sessionPath,
              JSON.stringify(event.data, null, 2),
              { mode: 0o600 } // Gioi han quyen chi user hien tai doc/ghi
            );
            console.log(`[Auth] Da luu session an toan vao: ${sessionPath}`);
          } catch (saveErr) {
            console.error(`[Auth] Khong the luu session: ${saveErr.message}`);
          }
          break;
      }
    }
  );

  console.log('[Auth] Dang nhap Zalo thanh cong!');
  return api;
}
